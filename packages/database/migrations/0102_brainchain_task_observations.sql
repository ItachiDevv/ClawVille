-- Read-only chain observations and recovery-only leases. No signing or model execution authority.
CREATE TABLE IF NOT EXISTS brainchain_worker_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), binding_id uuid NOT NULL, avatar_id uuid NOT NULL,
 environment varchar(8) NOT NULL, chain_id integer NOT NULL, board_address varchar(42) NOT NULL,
 task_id numeric(78,0) NOT NULL, manifest_hash varchar(64) NOT NULL,
 hire_block bigint NOT NULL, hire_block_hash varchar(66) NOT NULL, hire_tx_hash varchar(66) NOT NULL, hire_log_index integer NOT NULL,
 observed_block bigint NOT NULL, observed_block_hash varchar(66) NOT NULL,
 status integer NOT NULL, bounty_atomic numeric(39,0) NOT NULL, deadline_unix bigint NOT NULL,
 brief_hash varchar(66) NOT NULL, result_hash varchar(66) NOT NULL, canonical boolean NOT NULL DEFAULT true,
 lease_generation integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT brainchain_task_binding_owner FOREIGN KEY(binding_id,avatar_id,environment,chain_id)
  REFERENCES brainchain_worker_bindings(id,avatar_id,environment,chain_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_task_format CHECK(board_address ~ '^0x[0-9a-f]{40}$' AND manifest_hash ~ '^[0-9a-f]{64}$'
  AND hire_block_hash ~ '^0x[0-9a-f]{64}$' AND hire_tx_hash ~ '^0x[0-9a-f]{64}$' AND observed_block_hash ~ '^0x[0-9a-f]{64}$'
  AND brief_hash ~ '^0x[0-9a-f]{64}$' AND result_hash ~ '^0x[0-9a-f]{64}$'),
 CONSTRAINT brainchain_task_values CHECK(task_id BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND bounty_atomic BETWEEN 0 AND 340282366920938463463374607431768211455 AND hire_block>=0 AND observed_block>=hire_block
  AND hire_log_index>=0 AND deadline_unix>=0 AND status BETWEEN 1 AND 9 AND lease_generation>=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_task_identity ON brainchain_worker_tasks(chain_id,board_address,task_id);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_task_owner_tuple ON brainchain_worker_tasks(id,binding_id,avatar_id,environment,chain_id);
CREATE TABLE IF NOT EXISTS brainchain_task_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id uuid NOT NULL,binding_id uuid NOT NULL,avatar_id uuid NOT NULL,
 environment varchar(8) NOT NULL,chain_id integer NOT NULL,attempt_number integer NOT NULL,generation integer NOT NULL,
 purpose varchar(12) NOT NULL DEFAULT 'recovery',state varchar(16) NOT NULL DEFAULT 'inspecting',lease_owner uuid NOT NULL,
 lease_until timestamptz NOT NULL,output_hash varchar(64),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT brainchain_attempt_task_owner FOREIGN KEY(task_id,binding_id,avatar_id,environment,chain_id)
  REFERENCES brainchain_worker_tasks(id,binding_id,avatar_id,environment,chain_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_attempt_values CHECK(attempt_number>0 AND generation>0 AND purpose='recovery'
  AND state IN ('inspecting','reconciled','expired','suspended') AND lease_until>created_at
  AND (output_hash IS NULL OR output_hash ~ '^[0-9a-f]{64}$'))
);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_attempt_number ON brainchain_task_attempts(task_id,attempt_number);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_attempt_generation ON brainchain_task_attempts(task_id,generation);
CREATE TABLE IF NOT EXISTS brainchain_index_cursors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),binding_id uuid NOT NULL,avatar_id uuid NOT NULL,environment varchar(8) NOT NULL,
 chain_id integer NOT NULL,board_address varchar(42) NOT NULL,epoch integer NOT NULL DEFAULT 0,next_block bigint NOT NULL,checkpoint_block bigint,checkpoint_hash varchar(66),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT brainchain_cursor_binding_owner FOREIGN KEY(binding_id,avatar_id,environment,chain_id)
  REFERENCES brainchain_worker_bindings(id,avatar_id,environment,chain_id) ON DELETE RESTRICT,
 CONSTRAINT brainchain_cursor_values CHECK(epoch>=0 AND next_block>=0 AND board_address ~ '^0x[0-9a-f]{40}$'
  AND ((checkpoint_block IS NULL AND checkpoint_hash IS NULL) OR (checkpoint_block IS NOT NULL AND checkpoint_hash IS NOT NULL AND checkpoint_block>=0 AND checkpoint_hash ~ '^0x[0-9a-f]{64}$')))
);
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_cursor_binding_board ON brainchain_index_cursors(binding_id,board_address);

CREATE OR REPLACE FUNCTION brainchain_immutable_binding_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(OLD.id,OLD.avatar_id,OLD.environment,OLD.chain_id,OLD.address) IS DISTINCT FROM ROW(NEW.id,NEW.avatar_id,NEW.environment,NEW.chain_id,NEW.address)
 THEN RAISE EXCEPTION 'brainchain_binding_owner_is_immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_immutable_binding_owner ON brainchain_worker_bindings;
CREATE TRIGGER brainchain_immutable_binding_owner BEFORE UPDATE ON brainchain_worker_bindings FOR EACH ROW EXECUTE FUNCTION brainchain_immutable_binding_owner();
CREATE OR REPLACE FUNCTION brainchain_immutable_task_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(OLD.id,OLD.binding_id,OLD.avatar_id,OLD.environment,OLD.chain_id,OLD.board_address,OLD.task_id)
 IS DISTINCT FROM ROW(NEW.id,NEW.binding_id,NEW.avatar_id,NEW.environment,NEW.chain_id,NEW.board_address,NEW.task_id)
 THEN RAISE EXCEPTION 'brainchain_task_owner_is_immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_immutable_task_owner ON brainchain_worker_tasks;
CREATE TRIGGER brainchain_immutable_task_owner BEFORE UPDATE ON brainchain_worker_tasks FOR EACH ROW EXECUTE FUNCTION brainchain_immutable_task_owner();

-- Idempotent correction for pre-review local fixtures; this migration is not deployed.
ALTER TABLE brainchain_index_cursors ADD COLUMN IF NOT EXISTS epoch integer NOT NULL DEFAULT 0;
ALTER TABLE brainchain_index_cursors DROP CONSTRAINT IF EXISTS brainchain_cursor_values;
ALTER TABLE brainchain_index_cursors ADD CONSTRAINT brainchain_cursor_values CHECK(epoch>=0 AND next_block>=0 AND board_address ~ '^0x[0-9a-f]{40}$' AND ((checkpoint_block IS NULL AND checkpoint_hash IS NULL) OR (checkpoint_block IS NOT NULL AND checkpoint_hash IS NOT NULL AND checkpoint_block>=0 AND checkpoint_hash ~ '^0x[0-9a-f]{64}$')));
ALTER TABLE brainchain_worker_tasks DROP CONSTRAINT IF EXISTS brainchain_task_values;
ALTER TABLE brainchain_worker_tasks ADD CONSTRAINT brainchain_task_values CHECK(task_id BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND bounty_atomic BETWEEN 0 AND 340282366920938463463374607431768211455 AND hire_block>=0 AND observed_block>=hire_block AND hire_log_index>=0 AND deadline_unix>=0 AND status BETWEEN 1 AND 9 AND lease_generation>=0);
