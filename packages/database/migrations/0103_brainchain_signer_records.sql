-- Internal testnet signer records only. No signer is activated by this migration.
CREATE UNIQUE INDEX IF NOT EXISTS brainchain_binding_signer_owner ON brainchain_worker_bindings(id,avatar_id,environment,chain_id,address);
CREATE TABLE IF NOT EXISTS "brainchain_signer_authorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"avatar_id" uuid NOT NULL,
	"environment" varchar(8) NOT NULL,
	"chain_id" integer NOT NULL,
	"signer_address" varchar(42) NOT NULL,
	"generation" integer NOT NULL,
	"purpose" varchar(24) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"max_atomic" numeric(78, 0) NOT NULL,
	"approved_by" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "brainchain_signer_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"avatar_id" uuid NOT NULL,
	"environment" varchar(8) NOT NULL,
	"chain_id" integer NOT NULL,
	"signer_address" varchar(42) NOT NULL,
	"authority_id" uuid NOT NULL,
	"gas_authority_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"kind" varchar(24) NOT NULL,
	"idempotency_key" varchar(96) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"intent" jsonb NOT NULL,
	"state" varchar(16) DEFAULT 'prepared' NOT NULL,
	"nonce" numeric(20, 0),
	"gas_limit" numeric(78, 0) NOT NULL,
	"max_fee_per_gas" numeric(78, 0) NOT NULL,
	"max_priority_fee_per_gas" numeric(78, 0) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"signed_payload_ref" varchar(64),
	"transaction_hash" varchar(66),
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "brainchain_signer_streams" (
	"binding_id" uuid PRIMARY KEY NOT NULL,
	"avatar_id" uuid NOT NULL,
	"environment" varchar(8) NOT NULL,
	"chain_id" integer NOT NULL,
	"signer_address" varchar(42) NOT NULL,
	"signer_ref" varchar(128) NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"next_nonce" numeric(20, 0) NOT NULL,
	"stopped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "brainchain_authority_owner_tuple" ON "brainchain_signer_authorities" USING btree ("id","binding_id","avatar_id","environment","chain_id","signer_address");
CREATE UNIQUE INDEX IF NOT EXISTS "brainchain_operation_idempotency" ON "brainchain_signer_operations" USING btree ("binding_id","kind","idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "brainchain_operation_intent_once" ON "brainchain_signer_operations" USING btree ("authority_id");
CREATE UNIQUE INDEX IF NOT EXISTS "brainchain_operation_gas_once" ON "brainchain_signer_operations" USING btree ("gas_authority_id");
CREATE UNIQUE INDEX IF NOT EXISTS "brainchain_operation_nonce" ON "brainchain_signer_operations" USING btree ("chain_id","signer_address","nonce");
CREATE UNIQUE INDEX IF NOT EXISTS "brainchain_operation_transaction_hash" ON "brainchain_signer_operations" USING btree ("chain_id","transaction_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "brainchain_stream_owner_tuple" ON "brainchain_signer_streams" USING btree ("binding_id","avatar_id","environment","chain_id","signer_address");
CREATE UNIQUE INDEX IF NOT EXISTS "brainchain_stream_key_reference" ON "brainchain_signer_streams" USING btree ("signer_ref");
DO $$ BEGIN
 ALTER TABLE "brainchain_signer_authorities" ADD CONSTRAINT "brainchain_authority_stream_owner" FOREIGN KEY ("binding_id","avatar_id","environment","chain_id","signer_address") REFERENCES "public"."brainchain_signer_streams"("binding_id","avatar_id","environment","chain_id","signer_address") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE OR REPLACE FUNCTION brainchain_immutable_signer_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='brainchain_signer_streams' THEN
  IF (to_jsonb(OLD)-ARRAY['generation','next_nonce','stopped']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['generation','next_nonce','stopped'])
    OR NEW.generation<OLD.generation OR NEW.next_nonce<OLD.next_nonce
  THEN RAISE EXCEPTION 'brainchain_stream_identity_or_fence_is_immutable'; END IF;
 ELSIF TG_TABLE_NAME='brainchain_signer_authorities' THEN
  IF (to_jsonb(OLD)-'revoked_at') IS DISTINCT FROM (to_jsonb(NEW)-'revoked_at') OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  THEN RAISE EXCEPTION 'brainchain_authority_is_immutable'; END IF;
 ELSE
  IF (to_jsonb(OLD)-ARRAY['state','nonce','signed_payload_ref','transaction_hash','accepted_at','updated_at'])
    IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','nonce','signed_payload_ref','transaction_hash','accepted_at','updated_at'])
    OR (OLD.nonce IS NOT NULL AND NEW.nonce IS DISTINCT FROM OLD.nonce)
    OR (OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at)
    OR (OLD.signed_payload_ref IS NOT NULL AND ROW(NEW.signed_payload_ref,NEW.transaction_hash) IS DISTINCT FROM ROW(OLD.signed_payload_ref,OLD.transaction_hash))
  THEN RAISE EXCEPTION 'brainchain_operation_intent_is_immutable'; END IF;
  IF NEW.state<>OLD.state AND NOT (
    (OLD.state='prepared' AND NEW.state IN ('reserved','rejected')) OR
    (OLD.state='reserved' AND NEW.state IN ('accepting','uncertain','rejected')) OR
    (OLD.state='accepting' AND NEW.state IN ('signed','uncertain')) OR
    (OLD.state='signed' AND NEW.state IN ('broadcast','confirmed','uncertain')) OR
    (OLD.state='broadcast' AND NEW.state IN ('confirmed','uncertain')) OR
    (OLD.state='uncertain' AND NEW.state IN ('broadcast','confirmed','signed')) OR
    (OLD.state='confirmed' AND NEW.state='uncertain'))
  THEN RAISE EXCEPTION 'brainchain_operation_transition_refused'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brainchain_immutable_signer_stream ON brainchain_signer_streams;
CREATE TRIGGER brainchain_immutable_signer_stream BEFORE UPDATE ON brainchain_signer_streams FOR EACH ROW EXECUTE FUNCTION brainchain_immutable_signer_record();
DROP TRIGGER IF EXISTS brainchain_immutable_signer_authority ON brainchain_signer_authorities;
CREATE TRIGGER brainchain_immutable_signer_authority BEFORE UPDATE ON brainchain_signer_authorities FOR EACH ROW EXECUTE FUNCTION brainchain_immutable_signer_record();
DROP TRIGGER IF EXISTS brainchain_immutable_signer_operation ON brainchain_signer_operations;
CREATE TRIGGER brainchain_immutable_signer_operation BEFORE UPDATE ON brainchain_signer_operations FOR EACH ROW EXECUTE FUNCTION brainchain_immutable_signer_record();
DO $$ BEGIN
 ALTER TABLE "brainchain_signer_operations" ADD CONSTRAINT "brainchain_operation_intent_owner" FOREIGN KEY ("authority_id","binding_id","avatar_id","environment","chain_id","signer_address") REFERENCES "public"."brainchain_signer_authorities"("id","binding_id","avatar_id","environment","chain_id","signer_address") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "brainchain_signer_operations" ADD CONSTRAINT "brainchain_operation_gas_owner" FOREIGN KEY ("gas_authority_id","binding_id","avatar_id","environment","chain_id","signer_address") REFERENCES "public"."brainchain_signer_authorities"("id","binding_id","avatar_id","environment","chain_id","signer_address") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "brainchain_signer_streams" ADD CONSTRAINT "brainchain_stream_binding_owner" FOREIGN KEY ("binding_id","avatar_id","environment","chain_id","signer_address") REFERENCES "public"."brainchain_worker_bindings"("id","avatar_id","environment","chain_id","address") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- Explicit CHECKs are mandatory: the installed Drizzle generator omits check() metadata.
ALTER TABLE brainchain_signer_streams DROP CONSTRAINT IF EXISTS brainchain_stream_values;
ALTER TABLE brainchain_signer_streams ADD CONSTRAINT brainchain_stream_values CHECK(environment='testnet' AND chain_id=274630 AND generation>0 AND next_nonce BETWEEN 0 AND 18446744073709551615 AND signer_ref ~ '^brainchain-testnet:[a-zA-Z0-9_-]{1,96}$');
ALTER TABLE brainchain_signer_authorities DROP CONSTRAINT IF EXISTS brainchain_authority_values;
ALTER TABLE brainchain_signer_authorities ADD CONSTRAINT brainchain_authority_values CHECK(generation>0 AND purpose IN ('gas','faucet','approve-stake','approve-bond','stake','apply','leave','withdraw') AND request_hash ~ '^[a-f0-9]{64}$' AND max_atomic BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935 AND expires_at>created_at AND expires_at<=created_at+interval '1 day');
ALTER TABLE brainchain_signer_operations DROP CONSTRAINT IF EXISTS brainchain_operation_values;
ALTER TABLE brainchain_signer_operations ADD CONSTRAINT brainchain_operation_values CHECK(generation>0 AND authority_id<>gas_authority_id AND kind IN ('faucet','approve-stake','approve-bond','stake','apply','leave','withdraw') AND request_hash ~ '^[a-f0-9]{64}$' AND idempotency_key ~ '^[a-zA-Z0-9_-]{1,96}$' AND state IN ('prepared','reserved','accepting','signed','broadcast','confirmed','uncertain','rejected') AND gas_limit>0 AND max_fee_per_gas>0 AND max_priority_fee_per_gas>=0 AND max_priority_fee_per_gas<=max_fee_per_gas AND (nonce IS NULL OR nonce BETWEEN 0 AND 18446744073709551615) AND expires_at>created_at);
ALTER TABLE brainchain_signer_operations DROP CONSTRAINT IF EXISTS brainchain_operation_capture;
ALTER TABLE brainchain_signer_operations ADD CONSTRAINT brainchain_operation_capture CHECK(
 ((state='prepared' AND nonce IS NULL) OR state='rejected' OR (state IN ('reserved','accepting','signed','broadcast','confirmed','uncertain') AND nonce IS NOT NULL))
 AND ((signed_payload_ref IS NULL AND transaction_hash IS NULL AND ((accepted_at IS NULL AND state IN ('prepared','reserved','rejected','uncertain')) OR (accepted_at IS NOT NULL AND state IN ('accepting','uncertain') AND accepted_at>=created_at AND accepted_at<=expires_at)))
 OR (signed_payload_ref IS NOT NULL AND transaction_hash IS NOT NULL AND accepted_at IS NOT NULL AND state IN ('signed','broadcast','confirmed','uncertain') AND accepted_at>=created_at AND accepted_at<=expires_at AND signed_payload_ref ~ '^[a-f0-9]{64}$' AND transaction_hash ~ '^0x[a-f0-9]{64}$')));
