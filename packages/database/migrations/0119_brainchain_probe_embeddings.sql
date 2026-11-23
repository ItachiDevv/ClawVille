-- Dedicated probe allocation under the existing shared provider budget. Identity IDs are historical scalars.
CREATE TABLE IF NOT EXISTS brainchain_probe_markers (
 platform_agent_id uuid PRIMARY KEY, user_id uuid NOT NULL, avatar_id uuid NOT NULL, runtime_agent_id uuid NOT NULL,
 run_id uuid NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS brainchain_probe_runs (
 id uuid PRIMARY KEY, envelope_id uuid NOT NULL UNIQUE REFERENCES brainchain_compute_envelopes(id) ON DELETE RESTRICT,
 manifest jsonb NOT NULL, manifest_hash varchar(64) NOT NULL, platform_agent_id uuid NOT NULL UNIQUE REFERENCES brainchain_probe_markers(platform_agent_id) ON DELETE RESTRICT,
 max_calls integer NOT NULL, calls integer NOT NULL DEFAULT 0, max_starts integer NOT NULL, starts integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL, state varchar(12) NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,envelope_id),
 CONSTRAINT brainchain_probe_run_values CHECK(manifest_hash ~ '^[a-f0-9]{64}$' AND jsonb_typeof(manifest)='object' AND max_calls BETWEEN 1 AND 1000 AND calls BETWEEN 0 AND max_calls AND max_starts BETWEEN 1 AND 2 AND starts BETWEEN 0 AND max_starts AND state IN ('active','stopped') AND expires_at>created_at AND expires_at<=created_at+interval '8 minutes')
);
CREATE TABLE IF NOT EXISTS brainchain_probe_calls (
 id uuid PRIMARY KEY, run_id uuid NOT NULL, envelope_id uuid NOT NULL, request_id uuid NOT NULL,
 source varchar(16) NOT NULL, input_hash varchar(64) NOT NULL, input_bytes integer NOT NULL, maximum_micros bigint NOT NULL DEFAULT 200,
 deadline timestamptz NOT NULL, state varchar(12) NOT NULL DEFAULT 'reserved', dispatched_at timestamptz, charged_micros bigint,
 input_tokens integer, vector jsonb, reconciliation_ref varchar(128), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(run_id,envelope_id) REFERENCES brainchain_probe_runs(id,envelope_id) ON DELETE RESTRICT, UNIQUE(run_id,request_id),
 CONSTRAINT brainchain_probe_call_values CHECK(source IN ('protocol','brainchain','query','memory') AND input_hash ~ '^[a-f0-9]{64}$' AND input_bytes BETWEEN 1 AND 32768 AND maximum_micros=200 AND deadline>created_at AND (input_tokens IS NULL OR input_tokens BETWEEN 1 AND 8192) AND (vector IS NULL OR (jsonb_typeof(vector)='array' AND jsonb_array_length(vector)=1536 AND state='settled' AND input_tokens IS NOT NULL))),
 CONSTRAINT brainchain_probe_call_state CHECK((state='reserved' AND dispatched_at IS NULL AND charged_micros IS NULL) OR (state='canceled' AND dispatched_at IS NULL AND charged_micros IS NOT NULL AND charged_micros=0) OR (state IN ('dispatched','uncertain') AND dispatched_at IS NOT NULL AND charged_micros IS NULL) OR (state='settled' AND dispatched_at IS NOT NULL AND charged_micros IS NOT NULL AND charged_micros BETWEEN 0 AND maximum_micros))
);
CREATE OR REPLACE FUNCTION brainchain_probe_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'probe history cannot be deleted'; END IF;
 IF TG_TABLE_NAME='brainchain_probe_markers' THEN RAISE EXCEPTION 'probe marker immutable'; END IF;
 IF TG_TABLE_NAME='brainchain_probe_runs' THEN
  IF (to_jsonb(NEW)-ARRAY['calls','starts','state']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['calls','starts','state']) OR NEW.calls<OLD.calls OR NEW.starts<OLD.starts OR (OLD.state='stopped' AND NEW.state<>'stopped') THEN RAISE EXCEPTION 'probe run immutable'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','dispatched_at','charged_micros','input_tokens','vector','reconciliation_ref']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','dispatched_at','charged_micros','input_tokens','vector','reconciliation_ref']) OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at) OR NOT ((OLD.state='reserved' AND NEW.state IN ('reserved','dispatched','canceled')) OR (OLD.state='dispatched' AND NEW.state IN ('uncertain','settled')) OR (OLD.state='uncertain' AND NEW.state IN ('uncertain','settled')) OR (OLD.state IN ('settled','canceled') AND NEW IS NOT DISTINCT FROM OLD)) THEN RAISE EXCEPTION 'probe call immutable'; END IF;
 END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_probe_marker_immutable ON brainchain_probe_markers;
CREATE TRIGGER brainchain_probe_marker_immutable BEFORE UPDATE OR DELETE ON brainchain_probe_markers FOR EACH ROW EXECUTE FUNCTION brainchain_probe_immutable();
DROP TRIGGER IF EXISTS brainchain_probe_run_immutable ON brainchain_probe_runs;
CREATE TRIGGER brainchain_probe_run_immutable BEFORE UPDATE OR DELETE ON brainchain_probe_runs FOR EACH ROW EXECUTE FUNCTION brainchain_probe_immutable();
DROP TRIGGER IF EXISTS brainchain_probe_call_immutable ON brainchain_probe_calls;
CREATE TRIGGER brainchain_probe_call_immutable BEFORE UPDATE OR DELETE ON brainchain_probe_calls FOR EACH ROW EXECUTE FUNCTION brainchain_probe_immutable();

CREATE UNIQUE INDEX IF NOT EXISTS brainchain_probe_marker_run_owner ON brainchain_probe_markers(run_id,platform_agent_id);
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='brainchain_probe_marker_tuple') THEN ALTER TABLE brainchain_probe_runs ADD CONSTRAINT brainchain_probe_marker_tuple FOREIGN KEY(id,platform_agent_id) REFERENCES brainchain_probe_markers(run_id,platform_agent_id) ON DELETE RESTRICT; END IF; END $$;
CREATE OR REPLACE FUNCTION brainchain_probe_vector_valid(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN v IS NULL OR jsonb_typeof(v)<>'array' THEN false ELSE jsonb_array_length(v)=1536 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v) x WHERE jsonb_typeof(x)<>'number' OR CASE WHEN jsonb_typeof(x)='number' THEN abs(x::text::numeric)>1.7976931348623157e308 ELSE false END) END
$$;
ALTER TABLE brainchain_probe_calls DROP CONSTRAINT IF EXISTS brainchain_probe_call_evidence;
ALTER TABLE brainchain_probe_calls ADD CONSTRAINT brainchain_probe_call_evidence CHECK(
 (state IN ('reserved','dispatched','uncertain','canceled') AND input_tokens IS NULL AND vector IS NULL AND reconciliation_ref IS NULL)
 OR (state='settled' AND ((input_tokens IS NOT NULL AND vector IS NOT NULL AND brainchain_probe_vector_valid(vector) AND reconciliation_ref IS NULL AND charged_micros=ceil(input_tokens::numeric*20000/1000000)) OR (input_tokens IS NULL AND vector IS NULL AND reconciliation_ref IS NOT NULL AND length(reconciliation_ref) BETWEEN 1 AND 128 AND charged_micros=200)))
);
CREATE OR REPLACE FUNCTION brainchain_probe_scope_check() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE marker brainchain_probe_markers; BEGIN
 SELECT * INTO STRICT marker FROM brainchain_probe_markers WHERE platform_agent_id=NEW.platform_agent_id AND run_id=NEW.id;
 IF NEW.manifest->>'runId' IS DISTINCT FROM NEW.id::text OR NEW.manifest->>'envelopeId' IS DISTINCT FROM NEW.envelope_id::text OR NEW.manifest->>'platformAgentId' IS DISTINCT FROM marker.platform_agent_id::text OR NEW.manifest->>'userId' IS DISTINCT FROM marker.user_id::text OR NEW.manifest->>'avatarId' IS DISTINCT FROM marker.avatar_id::text OR NEW.manifest->>'runtimeAgentId' IS DISTINCT FROM marker.runtime_agent_id::text OR NEW.manifest->>'maxCalls' IS DISTINCT FROM NEW.max_calls::text OR NEW.manifest->>'maxStarts' IS DISTINCT FROM NEW.max_starts::text OR (NEW.manifest->>'expiresAtMs')::numeric IS DISTINCT FROM EXTRACT(EPOCH FROM NEW.expires_at)*1000 THEN RAISE EXCEPTION 'probe manifest ownership mismatch'; END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_probe_scope ON brainchain_probe_runs;
CREATE TRIGGER brainchain_probe_scope BEFORE INSERT ON brainchain_probe_runs FOR EACH ROW EXECUTE FUNCTION brainchain_probe_scope_check();
