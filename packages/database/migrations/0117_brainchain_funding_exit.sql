-- Testnet source transactions only. Destination attribution never releases these reservations.
CREATE TABLE IF NOT EXISTS brainchain_funding_operations (
 id uuid PRIMARY KEY, avatar_id uuid NOT NULL REFERENCES avatars(id), user_id uuid NOT NULL REFERENCES users(id),
 worker_id uuid NOT NULL REFERENCES brainchain_worker_bindings(id), actor varchar(8) NOT NULL CHECK(actor IN ('human','agent')),
 idempotency_key varchar(64) NOT NULL, draft jsonb NOT NULL, artifact jsonb NOT NULL,
 artifact_hash varchar(64) NOT NULL CHECK(artifact_hash ~ '^[0-9a-f]{64}$'),
 source_chain integer NOT NULL CHECK(source_chain IN (46630,274630)), source_address varchar(42) NOT NULL CHECK(source_address ~ '^0x[0-9a-f]{40}$'),
 source_nonce bigint NOT NULL CHECK(source_nonce>=0 AND source_nonce<=9007199254740991),
 state varchar(24) NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','captured','sending','uncertain','source_observed','reorg_suspended')),
 approval_nonce varchar(64), approval_wallet varchar(44), approval_wallet_version bigint,
 approval_expires_at timestamptz, approved_at timestamptz, exposed_at timestamptz,
 captured jsonb, capture_hash varchar(64), source_transaction varchar(66),
 lease_owner uuid, lease_until timestamptz, first_send_at timestamptz,
 source_evidence jsonb, desk_report jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT brainchain_funding_idempotency UNIQUE(avatar_id,idempotency_key),
 CONSTRAINT brainchain_funding_source_nonce UNIQUE(source_chain,source_address,source_nonce),
 CONSTRAINT brainchain_funding_transaction UNIQUE(source_chain,source_transaction),
 CONSTRAINT brainchain_funding_capture_tuple CHECK((captured IS NULL AND capture_hash IS NULL AND source_transaction IS NULL) OR
  (captured IS NOT NULL AND capture_hash IS NOT NULL AND source_transaction IS NOT NULL AND jsonb_typeof(captured)='object' AND capture_hash ~ '^[0-9a-f]{64}$' AND source_transaction ~ '^0x[0-9a-f]{64}$')),
 CONSTRAINT brainchain_funding_capture_state CHECK(state='reserved' OR captured IS NOT NULL),
 CONSTRAINT brainchain_funding_lease_tuple CHECK((lease_owner IS NULL AND lease_until IS NULL) OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
 CONSTRAINT brainchain_funding_approval_tuple CHECK(approved_at IS NULL OR (approval_nonce IS NOT NULL AND approval_wallet IS NOT NULL AND approval_wallet_version IS NOT NULL AND approval_expires_at IS NOT NULL)),
 CONSTRAINT brainchain_funding_approval_version CHECK(approval_wallet_version IS NULL OR (approval_wallet_version>=0 AND approval_wallet_version<=9007199254740991)),
 CONSTRAINT brainchain_funding_artifact_shape CHECK(jsonb_typeof(artifact)='object' AND octet_length(artifact::text)<=8192 AND jsonb_typeof(draft)='object' AND octet_length(draft::text)<=4096)
);
CREATE INDEX IF NOT EXISTS brainchain_funding_owner ON brainchain_funding_operations(avatar_id,created_at DESC);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='brainchain_funding_approval_version' AND conrelid='brainchain_funding_operations'::regclass) THEN
  ALTER TABLE brainchain_funding_operations ADD CONSTRAINT brainchain_funding_approval_version CHECK(approval_wallet_version IS NULL OR (approval_wallet_version>=0 AND approval_wallet_version<=9007199254740991));
 END IF;
END $$;
CREATE OR REPLACE FUNCTION brainchain_funding_owner_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM avatars a JOIN users u ON u.id=a.user_id JOIN brainchain_worker_bindings b ON b.avatar_id=a.id
  WHERE a.id=NEW.avatar_id AND u.id=NEW.user_id AND a.is_guest=false AND u.is_guest=false AND b.id=NEW.worker_id
   AND b.environment='testnet' AND b.chain_id=274630 AND b.address=NEW.source_address)
 OR NEW.artifact->>'operationId' IS DISTINCT FROM NEW.id::text OR NEW.artifact->>'workerId' IS DISTINCT FROM NEW.worker_id::text
 OR NEW.artifact->>'source' IS DISTINCT FROM NEW.source_address OR NEW.artifact->>'destination' IS DISTINCT FROM NEW.source_address
 OR NEW.artifact->>'chainId' IS DISTINCT FROM NEW.source_chain::text OR NEW.artifact->>'nonce' IS DISTINCT FROM NEW.source_nonce::text
 THEN RAISE EXCEPTION 'funding owner tuple mismatch'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_funding_owner_trigger ON brainchain_funding_operations;
CREATE TRIGGER brainchain_funding_owner_trigger BEFORE INSERT ON brainchain_funding_operations FOR EACH ROW EXECUTE FUNCTION brainchain_funding_owner_check();
CREATE OR REPLACE FUNCTION brainchain_funding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'funding reservation cannot be deleted'; END IF;
 IF ROW(NEW.id,NEW.avatar_id,NEW.user_id,NEW.worker_id,NEW.actor,NEW.idempotency_key,NEW.draft,NEW.artifact,NEW.artifact_hash,NEW.source_chain,NEW.source_address,NEW.source_nonce,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.avatar_id,OLD.user_id,OLD.worker_id,OLD.actor,OLD.idempotency_key,OLD.draft,OLD.artifact,OLD.artifact_hash,OLD.source_chain,OLD.source_address,OLD.source_nonce,OLD.created_at)
 THEN RAISE EXCEPTION 'funding intent is immutable'; END IF;
 IF OLD.captured IS NOT NULL AND ROW(NEW.captured,NEW.capture_hash,NEW.source_transaction) IS DISTINCT FROM ROW(OLD.captured,OLD.capture_hash,OLD.source_transaction)
 THEN RAISE EXCEPTION 'funding capture is immutable'; END IF;
 IF OLD.exposed_at IS NOT NULL AND NEW.exposed_at IS DISTINCT FROM OLD.exposed_at THEN RAISE EXCEPTION 'funding exposure is immutable'; END IF;
 IF OLD.first_send_at IS NOT NULL AND NEW.first_send_at IS DISTINCT FROM OLD.first_send_at THEN RAISE EXCEPTION 'funding dispatch is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_funding_immutable_trigger ON brainchain_funding_operations;
CREATE TRIGGER brainchain_funding_immutable_trigger BEFORE UPDATE OR DELETE ON brainchain_funding_operations FOR EACH ROW EXECUTE FUNCTION brainchain_funding_immutable();
