-- Internal compute accounting. Root approval allocates an existing ledger envelope.
-- No recovery lease becomes execution authority through this migration.
CREATE TABLE IF NOT EXISTS brainchain_compute_budgets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL, provider varchar(12) NOT NULL,
 cap_micros bigint NOT NULL, allocated_micros bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT brainchain_compute_budget_values CHECK(provider IN ('openai','openrouter') AND cap_micros=10000000 AND allocated_micros BETWEEN 0 AND cap_micros),
 CONSTRAINT brainchain_compute_budget_owner UNIQUE(job_id,provider)
);
CREATE TABLE IF NOT EXISTS brainchain_compute_envelopes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), budget_id uuid NOT NULL REFERENCES brainchain_compute_budgets(id) ON DELETE RESTRICT,
 root_reservation_id varchar(128) NOT NULL UNIQUE, approval_ref varchar(128) NOT NULL,
 limit_micros bigint NOT NULL, reserved_micros bigint NOT NULL DEFAULT 0, uncertain_micros bigint NOT NULL DEFAULT 0, settled_micros bigint NOT NULL DEFAULT 0,
 state varchar(12) NOT NULL DEFAULT 'open', expires_at timestamptz NOT NULL, closed_at timestamptz, reconciliation_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT brainchain_compute_envelope_values CHECK(limit_micros>0 AND limit_micros<=10000000 AND reserved_micros>=0 AND uncertain_micros>=0 AND settled_micros>=0 AND reserved_micros+uncertain_micros+settled_micros<=limit_micros AND state IN ('open','closed') AND (state='open' OR (closed_at IS NOT NULL AND reconciliation_id IS NOT NULL AND reserved_micros=0 AND uncertain_micros=0)))
);
CREATE TABLE IF NOT EXISTS brainchain_compute_calls (
 id uuid PRIMARY KEY, reservation_id uuid NOT NULL UNIQUE, envelope_id uuid NOT NULL REFERENCES brainchain_compute_envelopes(id) ON DELETE RESTRICT,
 avatar_id uuid NOT NULL, task_id uuid NOT NULL REFERENCES brainchain_worker_tasks(id) ON DELETE RESTRICT,
 attempt_id uuid NOT NULL UNIQUE REFERENCES brainchain_task_attempts(id) ON DELETE RESTRICT, generation integer NOT NULL, lease_owner uuid NOT NULL,
 model varchar(128) NOT NULL, pricing_version varchar(96) NOT NULL, prompt_hash varchar(64) NOT NULL, prompt text NOT NULL,
 max_input_tokens integer NOT NULL, max_output_tokens integer NOT NULL, input_overhead_tokens integer NOT NULL, input_rate bigint NOT NULL, output_rate bigint NOT NULL, request_micros bigint NOT NULL,
 maximum_micros bigint NOT NULL, charged_micros bigint, capability_hash varchar(64) NOT NULL UNIQUE, deadline timestamptz NOT NULL,
 state varchar(12) NOT NULL DEFAULT 'reserved', dispatched_at timestamptz, output text, input_tokens integer, output_tokens integer,
 failure_code varchar(32), reconciliation_ref varchar(128), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT brainchain_compute_call_values CHECK(generation>0 AND prompt_hash ~ '^[a-f0-9]{64}$' AND capability_hash ~ '^[a-f0-9]{64}$' AND octet_length(prompt) BETWEEN 1 AND 32768 AND max_input_tokens BETWEEN octet_length(prompt) AND 131072 AND max_output_tokens BETWEEN 1 AND 8192 AND input_rate>=0 AND output_rate>=0 AND request_micros>=0 AND maximum_micros>0 AND maximum_micros<=10000000 AND (charged_micros IS NULL OR charged_micros BETWEEN 0 AND maximum_micros) AND state IN ('reserved','dispatched','uncertain','settled','canceled') AND (output IS NULL OR octet_length(output) BETWEEN 1 AND 32768)),
 CONSTRAINT brainchain_compute_call_lifecycle CHECK((state='reserved' AND dispatched_at IS NULL AND charged_micros IS NULL) OR (state='canceled' AND dispatched_at IS NULL AND charged_micros IS NOT NULL AND charged_micros=0) OR (state IN ('dispatched','uncertain') AND dispatched_at IS NOT NULL AND charged_micros IS NULL) OR (state='settled' AND dispatched_at IS NOT NULL AND charged_micros IS NOT NULL)),
 CONSTRAINT brainchain_compute_call_usage CHECK((input_tokens IS NULL OR input_tokens BETWEEN 0 AND max_input_tokens) AND (output_tokens IS NULL OR output_tokens BETWEEN 1 AND max_output_tokens) AND (output IS NULL OR (state='settled' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL)))
);
-- Idempotent correction for this unreleased migration's isolated local fixture.
ALTER TABLE brainchain_compute_calls ADD COLUMN IF NOT EXISTS input_overhead_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE brainchain_compute_calls DROP CONSTRAINT IF EXISTS brainchain_compute_call_framing;
ALTER TABLE brainchain_compute_calls ADD CONSTRAINT brainchain_compute_call_framing CHECK(input_overhead_tokens BETWEEN 0 AND 8192 AND max_input_tokens>=octet_length(prompt)+input_overhead_tokens);
ALTER TABLE brainchain_compute_calls DROP CONSTRAINT IF EXISTS brainchain_compute_call_lifecycle;
ALTER TABLE brainchain_compute_calls ADD CONSTRAINT brainchain_compute_call_lifecycle CHECK((state='reserved' AND dispatched_at IS NULL AND charged_micros IS NULL) OR (state='canceled' AND dispatched_at IS NULL AND charged_micros IS NOT NULL AND charged_micros=0) OR (state IN ('dispatched','uncertain') AND dispatched_at IS NOT NULL AND charged_micros IS NULL) OR (state='settled' AND dispatched_at IS NOT NULL AND charged_micros IS NOT NULL));
CREATE OR REPLACE FUNCTION brainchain_compute_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='brainchain_compute_budgets' THEN
  IF ROW(OLD.id,OLD.job_id,OLD.provider,OLD.cap_micros,OLD.created_at) IS DISTINCT FROM ROW(NEW.id,NEW.job_id,NEW.provider,NEW.cap_micros,NEW.created_at) THEN RAISE EXCEPTION 'brainchain_compute_budget_immutable'; END IF;
 ELSIF TG_TABLE_NAME='brainchain_compute_envelopes' THEN
  IF ROW(OLD.id,OLD.budget_id,OLD.root_reservation_id,OLD.approval_ref,OLD.limit_micros,OLD.expires_at,OLD.created_at) IS DISTINCT FROM ROW(NEW.id,NEW.budget_id,NEW.root_reservation_id,NEW.approval_ref,NEW.limit_micros,NEW.expires_at,NEW.created_at) OR OLD.state='closed' THEN RAISE EXCEPTION 'brainchain_compute_envelope_immutable'; END IF;
 ELSE
  IF ROW(OLD.id,OLD.reservation_id,OLD.envelope_id,OLD.avatar_id,OLD.task_id,OLD.attempt_id,OLD.generation,OLD.lease_owner,OLD.model,OLD.pricing_version,OLD.prompt_hash,OLD.prompt,OLD.max_input_tokens,OLD.max_output_tokens,OLD.input_rate,OLD.output_rate,OLD.request_micros,OLD.maximum_micros,OLD.capability_hash,OLD.deadline,OLD.created_at)
   IS DISTINCT FROM ROW(NEW.id,NEW.reservation_id,NEW.envelope_id,NEW.avatar_id,NEW.task_id,NEW.attempt_id,NEW.generation,NEW.lease_owner,NEW.model,NEW.pricing_version,NEW.prompt_hash,NEW.prompt,NEW.max_input_tokens,NEW.max_output_tokens,NEW.input_rate,NEW.output_rate,NEW.request_micros,NEW.maximum_micros,NEW.capability_hash,NEW.deadline,NEW.created_at)
   OR OLD.input_overhead_tokens IS DISTINCT FROM NEW.input_overhead_tokens
   OR (OLD.state IN ('settled','canceled')) OR (OLD.dispatched_at IS NOT NULL AND OLD.dispatched_at IS DISTINCT FROM NEW.dispatched_at)
   OR (OLD.state='reserved' AND NEW.state NOT IN ('reserved','dispatched','canceled')) OR (OLD.state IN ('dispatched','uncertain') AND NEW.state NOT IN ('uncertain','settled'))
  THEN RAISE EXCEPTION 'brainchain_compute_call_immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_compute_budget_immutable ON brainchain_compute_budgets;
CREATE TRIGGER brainchain_compute_budget_immutable BEFORE UPDATE ON brainchain_compute_budgets FOR EACH ROW EXECUTE FUNCTION brainchain_compute_immutable();
DROP TRIGGER IF EXISTS brainchain_compute_envelope_immutable ON brainchain_compute_envelopes;
CREATE TRIGGER brainchain_compute_envelope_immutable BEFORE UPDATE ON brainchain_compute_envelopes FOR EACH ROW EXECUTE FUNCTION brainchain_compute_immutable();
DROP TRIGGER IF EXISTS brainchain_compute_call_immutable ON brainchain_compute_calls;
CREATE TRIGGER brainchain_compute_call_immutable BEFORE UPDATE ON brainchain_compute_calls FOR EACH ROW EXECUTE FUNCTION brainchain_compute_immutable();
CREATE OR REPLACE FUNCTION brainchain_compute_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM brainchain_task_attempts a JOIN brainchain_worker_tasks t ON t.id=a.task_id
  WHERE a.id=NEW.attempt_id AND a.task_id=NEW.task_id AND a.avatar_id=NEW.avatar_id AND a.binding_id=t.binding_id
  AND a.avatar_id=t.avatar_id AND a.environment='testnet' AND a.chain_id=274630 AND t.environment='testnet' AND t.chain_id=274630
  AND a.generation=NEW.generation AND a.lease_owner=NEW.lease_owner AND a.purpose='execution')
 THEN RAISE EXCEPTION 'brainchain_compute_attempt_owner'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_compute_attempt_owner ON brainchain_compute_calls;
CREATE TRIGGER brainchain_compute_attempt_owner BEFORE INSERT ON brainchain_compute_calls FOR EACH ROW EXECUTE FUNCTION brainchain_compute_owner();
