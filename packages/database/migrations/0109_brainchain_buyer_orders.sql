CREATE TABLE IF NOT EXISTS brainchain_buyer_payers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),avatar_id uuid NOT NULL REFERENCES avatars(id),chain_id integer NOT NULL CHECK(chain_id=84532),
 address varchar(42) NOT NULL CHECK(address ~ '^0x[0-9a-f]{40}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(chain_id,address)
);
CREATE TABLE IF NOT EXISTS brainchain_buyer_orders (
 id uuid PRIMARY KEY,avatar_id uuid NOT NULL REFERENCES avatars(id),user_id uuid NOT NULL CONSTRAINT brainchain_buyer_user_fk REFERENCES users(id),actor varchar(8) NOT NULL CHECK(actor IN ('human','agent')),
 idempotency_key varchar(64) NOT NULL,body jsonb NOT NULL,body_hash varchar(64) NOT NULL CHECK(body_hash ~ '^[0-9a-f]{64}$'),
 state varchar(24) NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','quoted','reserved','captured','sending','uncertain','payment_observed','refunded','canceled','reorg_suspended')),
 quote jsonb,quote_expires_at timestamptz,payer varchar(42),terms jsonb,payment_nonce varchar(66),valid_before timestamptz,reserved_at timestamptz,
 requires_human_approval boolean NOT NULL DEFAULT true,human_nonce varchar(64),human_approved_at timestamptz,human_approval_expires_at timestamptz,
 captured jsonb,capture_hash varchar(64),captured_at timestamptz,send_generation integer NOT NULL DEFAULT 0,lease_owner uuid,lease_until timestamptz,
 first_send_at timestamptz,last_send_at timestamptz,remote_order varchar(66) UNIQUE,remote_state varchar(32),task_id varchar(78),task_board varchar(42),
 payment_transaction varchar(66),payment_block_hash varchar(66),payment_block varchar(24),refund_transaction varchar(66),failure_code varchar(64),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(avatar_id,idempotency_key),UNIQUE(payer,payment_nonce),
 CHECK(payer IS NULL OR payer ~ '^0x[0-9a-f]{40}$'),CHECK(payment_nonce IS NULL OR payment_nonce ~ '^0x[0-9a-f]{64}$'),
 CHECK(send_generation>=0),CHECK((captured IS NULL AND capture_hash IS NULL AND captured_at IS NULL) OR (captured IS NOT NULL AND capture_hash IS NOT NULL AND capture_hash ~ '^[0-9a-f]{64}$' AND captured_at IS NOT NULL)),
 CHECK(state NOT IN ('reserved','captured','sending','uncertain','payment_observed','refunded','reorg_suspended') OR (reserved_at IS NOT NULL AND terms IS NOT NULL AND payer IS NOT NULL AND payment_nonce IS NOT NULL AND valid_before IS NOT NULL)),
 CHECK(state NOT IN ('captured','sending','uncertain','payment_observed','refunded','reorg_suspended') OR captured IS NOT NULL),
 CHECK(first_send_at IS NULL OR (captured IS NOT NULL AND send_generation>0)),
 CHECK(state<>'sending' OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL AND first_send_at IS NOT NULL)),
 CHECK(state<>'canceled' OR (terms IS NULL AND captured IS NULL AND first_send_at IS NULL))
);
CREATE TABLE IF NOT EXISTS brainchain_buyer_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES brainchain_buyer_orders(id),kind varchar(32) NOT NULL,evidence jsonb NOT NULL,
 transaction varchar(66),log_index integer,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(kind,transaction,log_index)
);
CREATE OR REPLACE FUNCTION brainchain_buyer_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.avatar_id,NEW.user_id,NEW.actor,NEW.idempotency_key,NEW.body,NEW.body_hash,NEW.created_at) IS DISTINCT FROM ROW(OLD.avatar_id,OLD.user_id,OLD.actor,OLD.idempotency_key,OLD.body,OLD.body_hash,OLD.created_at) THEN RAISE EXCEPTION 'Buyer owner and task are immutable'; END IF;
 IF OLD.terms IS NOT NULL AND ROW(NEW.terms,NEW.payer,NEW.quote,NEW.quote_expires_at,NEW.payment_nonce,NEW.valid_before,NEW.reserved_at) IS DISTINCT FROM ROW(OLD.terms,OLD.payer,OLD.quote,OLD.quote_expires_at,OLD.payment_nonce,OLD.valid_before,OLD.reserved_at) THEN RAISE EXCEPTION 'Buyer intent is immutable'; END IF;
 IF OLD.captured IS NOT NULL AND ROW(NEW.captured,NEW.capture_hash,NEW.captured_at) IS DISTINCT FROM ROW(OLD.captured,OLD.capture_hash,OLD.captured_at) THEN RAISE EXCEPTION 'Buyer capture is immutable'; END IF;
 IF OLD.remote_order IS NOT NULL AND NEW.remote_order IS DISTINCT FROM OLD.remote_order THEN RAISE EXCEPTION 'Buyer remote order is immutable'; END IF;
 IF OLD.task_id IS NOT NULL AND NEW.task_id IS DISTINCT FROM OLD.task_id THEN RAISE EXCEPTION 'Buyer task is immutable'; END IF;
 IF OLD.task_board IS NOT NULL AND NEW.task_board IS DISTINCT FROM OLD.task_board THEN RAISE EXCEPTION 'Buyer board is immutable'; END IF;
 IF OLD.first_send_at IS NOT NULL AND NEW.first_send_at IS DISTINCT FROM OLD.first_send_at THEN RAISE EXCEPTION 'Buyer send is immutable'; END IF;
 IF NEW.send_generation<OLD.send_generation OR NEW.send_generation>OLD.send_generation+1 THEN RAISE EXCEPTION 'Invalid buyer generation'; END IF;
 IF ((OLD.state='canceled') OR (OLD.state='refunded' AND NEW.state<>'reorg_suspended')) AND NEW.state IS DISTINCT FROM OLD.state THEN RAISE EXCEPTION 'Terminal buyer state'; END IF;
 IF NEW.state='refunded' AND NEW.refund_transaction IS NULL THEN RAISE EXCEPTION 'Refund evidence required'; END IF;
 RETURN NEW;
 END $$;
DROP TRIGGER IF EXISTS brainchain_buyer_immutable_row ON brainchain_buyer_orders;
CREATE TRIGGER brainchain_buyer_immutable_row BEFORE UPDATE ON brainchain_buyer_orders FOR EACH ROW EXECUTE FUNCTION brainchain_buyer_immutable();
CREATE OR REPLACE FUNCTION brainchain_buyer_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Buyer evidence is append only'; END $$;
DROP TRIGGER IF EXISTS brainchain_buyer_events_immutable ON brainchain_buyer_events;
CREATE TRIGGER brainchain_buyer_events_immutable BEFORE UPDATE OR DELETE ON brainchain_buyer_events FOR EACH ROW EXECUTE FUNCTION brainchain_buyer_append_only();

ALTER TABLE brainchain_buyer_orders DROP CONSTRAINT IF EXISTS brainchain_buyer_capture_required;
ALTER TABLE brainchain_buyer_orders ADD CONSTRAINT brainchain_buyer_capture_required CHECK
 (captured IS NULL OR (capture_hash IS NOT NULL AND capture_hash ~ '^[0-9a-f]{64}$' AND captured_at IS NOT NULL));

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='brainchain_buyer_orders'::regclass AND conname='brainchain_buyer_user_fk') THEN
  ALTER TABLE brainchain_buyer_orders ADD CONSTRAINT brainchain_buyer_user_fk FOREIGN KEY(user_id) REFERENCES users(id);
 END IF;
END $$;
