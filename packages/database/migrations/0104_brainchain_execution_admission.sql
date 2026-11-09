-- Internal single-attempt testnet authority. No scheduler or signer is enabled by this migration.
CREATE TABLE IF NOT EXISTS brainchain_execution_authorities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id uuid NOT NULL,binding_id uuid NOT NULL,avatar_id uuid NOT NULL,
 environment varchar(8) NOT NULL,chain_id integer NOT NULL,generation integer NOT NULL,
 brief_hash varchar(66) NOT NULL,input_hash varchar(64) NOT NULL,prompt_hash varchar(64) NOT NULL,
 approved_by varchar(128) NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT brainchain_execution_task_owner FOREIGN KEY(task_id,binding_id,avatar_id,environment,chain_id) REFERENCES brainchain_worker_tasks(id,binding_id,avatar_id,environment,chain_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_execution_values CHECK(environment='testnet' AND chain_id=274630 AND generation>0 AND brief_hash ~ '^0x[a-f0-9]{64}$'
 AND input_hash ~ '^[a-f0-9]{64}$' AND prompt_hash ~ '^[a-f0-9]{64}$' AND length(approved_by)>0 AND expires_at>created_at AND expires_at<=created_at+interval '10 minutes'
 AND (consumed_at IS NULL OR (consumed_at>=created_at AND consumed_at<expires_at)))
);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_execution_owner_tuple ON brainchain_execution_authorities(id,task_id,binding_id,avatar_id,environment,chain_id,generation,input_hash,prompt_hash);
ALTER TABLE brainchain_worker_bindings DROP CONSTRAINT IF EXISTS brainchain_binding_local_state;
ALTER TABLE brainchain_worker_bindings ADD CONSTRAINT brainchain_binding_local_state CHECK(requested_state IN ('paused','draining','running'));
ALTER TABLE brainchain_task_attempts ADD COLUMN IF NOT EXISTS authority_id uuid;
ALTER TABLE brainchain_task_attempts ADD COLUMN IF NOT EXISTS input_hash varchar(64);
ALTER TABLE brainchain_task_attempts ADD COLUMN IF NOT EXISTS prompt_hash varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_attempt_authority_once ON brainchain_task_attempts(authority_id);
ALTER TABLE brainchain_task_attempts DROP CONSTRAINT IF EXISTS brainchain_attempt_execution_owner;
ALTER TABLE brainchain_task_attempts ADD CONSTRAINT brainchain_attempt_execution_owner FOREIGN KEY(authority_id,task_id,binding_id,avatar_id,environment,chain_id,generation,input_hash,prompt_hash)
 REFERENCES brainchain_execution_authorities(id,task_id,binding_id,avatar_id,environment,chain_id,generation,input_hash,prompt_hash) ON DELETE RESTRICT;
ALTER TABLE brainchain_task_attempts DROP CONSTRAINT IF EXISTS brainchain_attempt_values;
ALTER TABLE brainchain_task_attempts ADD CONSTRAINT brainchain_attempt_values CHECK(attempt_number>0 AND generation>0
 AND ((purpose='recovery' AND state IN ('inspecting','reconciled','expired','suspended') AND authority_id IS NULL AND input_hash IS NULL AND prompt_hash IS NULL)
 OR (purpose='execution' AND state IN ('executing','executed','expired','suspended') AND authority_id IS NOT NULL AND input_hash IS NOT NULL AND prompt_hash IS NOT NULL))
 AND lease_until>created_at AND (output_hash IS NULL OR output_hash ~ '^[0-9a-f]{64}$'));
CREATE OR REPLACE FUNCTION brainchain_execution_authority_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)-'consumed_at'-'revoked_at') IS DISTINCT FROM (to_jsonb(NEW)-'consumed_at'-'revoked_at')
 OR (OLD.consumed_at IS NOT NULL AND OLD.consumed_at IS DISTINCT FROM NEW.consumed_at)
 OR (OLD.revoked_at IS NOT NULL AND OLD.revoked_at IS DISTINCT FROM NEW.revoked_at)
 THEN RAISE EXCEPTION 'brainchain_execution_authority_is_immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_execution_authority_immutable ON brainchain_execution_authorities;
CREATE TRIGGER brainchain_execution_authority_immutable BEFORE UPDATE ON brainchain_execution_authorities FOR EACH ROW EXECUTE FUNCTION brainchain_execution_authority_immutable();
CREATE OR REPLACE FUNCTION brainchain_attempt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(OLD)-'state'-'output_hash'-'updated_at') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'output_hash'-'updated_at')
 OR (OLD.output_hash IS NOT NULL AND OLD.output_hash IS DISTINCT FROM NEW.output_hash)
 OR (OLD.state IN ('executed','reconciled','expired','suspended') AND OLD.state IS DISTINCT FROM NEW.state AND NEW.state<>'suspended')
 THEN RAISE EXCEPTION 'brainchain_attempt_fence_is_immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_attempt_immutable ON brainchain_task_attempts;
CREATE TRIGGER brainchain_attempt_immutable BEFORE UPDATE ON brainchain_task_attempts FOR EACH ROW EXECUTE FUNCTION brainchain_attempt_immutable();
