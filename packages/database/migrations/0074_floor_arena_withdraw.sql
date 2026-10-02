-- 0074_floor_arena_withdraw.sql: Trading Arena wallet withdraw (P5, D34). Contract: ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md.
-- Drizzle mirror: packages/database/src/schema/floor-arena.ts. Value sets: packages/shared/src/constants/floor-arena.ts.
-- REAL MONEY: floor_arena_withdrawals records USDC and SOL that leave a player's ClawPump wallet. Additive and idempotent.
-- CHECKs live in the guarded DO block (drizzle-kit 0.24 emits none). The guard trigger exists only here (Drizzle has no triggers).
-- Widening floor_arena_events_type_valid with 'withdraw' is safe before the code flip: old code never writes that type.

CREATE TABLE IF NOT EXISTS "floor_arena_withdraw_addresses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" text NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "address" text NOT NULL,
  "proof_kind" text NOT NULL,
  "message" text,
  "signature" text,
  "challenge_nonce" text,
  "set_by" text NOT NULL,
  "set_by_agent_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "active_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "revoke_reason" text,
  CONSTRAINT "floor_arena_withdraw_addresses_agent_id_floor_arena_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "floor_arena_agents"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "floor_arena_withdraw_addresses_one_current_uq" ON "floor_arena_withdraw_addresses" ("agent_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "floor_arena_withdraw_addresses_nonce_uq" ON "floor_arena_withdraw_addresses" ("challenge_nonce") WHERE "challenge_nonce" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "floor_arena_withdraw_addresses_agent_created_idx" ON "floor_arena_withdraw_addresses" ("agent_id","created_at" DESC);

CREATE TABLE IF NOT EXISTS "floor_arena_withdraw_challenges" (
  "nonce" text PRIMARY KEY,
  "agent_id" text NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "address" text NOT NULL,
  "message" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "floor_arena_withdraw_challenges_agent_id_floor_arena_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "floor_arena_agents"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "floor_arena_withdraw_challenges_agent_idx" ON "floor_arena_withdraw_challenges" ("agent_id","created_at" DESC);
CREATE INDEX IF NOT EXISTS "floor_arena_withdraw_challenges_expires_idx" ON "floor_arena_withdraw_challenges" ("expires_at");

CREATE TABLE IF NOT EXISTS "floor_arena_withdrawals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" text NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "subject_kind" text NOT NULL,
  "subject_agent_id" text,
  "idempotency_key" text NOT NULL,
  "asset" text NOT NULL,
  "amount_mode" text NOT NULL,
  "requested_atomic" bigint,
  "amount_atomic" bigint,
  "source_clawpump_agent_id" text NOT NULL,
  "source_wallet" text NOT NULL,
  "destination" text NOT NULL,
  "address_id" uuid NOT NULL,
  "state" text NOT NULL DEFAULT 'requested',
  "error_code" text,
  "pre_balance_atomic" bigint,
  "pre_sol_lamports" bigint,
  "post_balance_atomic" bigint,
  "tx_signature" text,
  "recipient_account_created" boolean,
  "review_note" text,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "dispatched_at" timestamptz,
  "sent_at" timestamptz,
  "finalized_at" timestamptz,
  "last_checked_at" timestamptz,
  "check_count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "floor_arena_withdrawals_agent_id_floor_arena_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "floor_arena_agents"("id") ON DELETE CASCADE,
  CONSTRAINT "floor_arena_withdrawals_address_id_floor_arena_withdraw_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "floor_arena_withdraw_addresses"("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "floor_arena_withdrawals_agent_idem_uq" ON "floor_arena_withdrawals" ("agent_id","idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "floor_arena_withdrawals_one_open_uq" ON "floor_arena_withdrawals" ("agent_id") WHERE "state" IN ('requested','dispatching','sent','unknown');
CREATE UNIQUE INDEX IF NOT EXISTS "floor_arena_withdrawals_tx_uq" ON "floor_arena_withdrawals" ("tx_signature") WHERE "tx_signature" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "floor_arena_withdrawals_state_idx" ON "floor_arena_withdrawals" ("state","requested_at");
CREATE INDEX IF NOT EXISTS "floor_arena_withdrawals_agent_requested_idx" ON "floor_arena_withdrawals" ("agent_id","requested_at" DESC);
CREATE INDEX IF NOT EXISTS "floor_arena_withdrawals_dispatched_idx" ON "floor_arena_withdrawals" ("dispatched_at") WHERE "dispatched_at" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_withdraw_addresses_proof_valid' AND conrelid = 'floor_arena_withdraw_addresses'::regclass) THEN
    ALTER TABLE "floor_arena_withdraw_addresses" ADD CONSTRAINT "floor_arena_withdraw_addresses_proof_valid"
      CHECK (("proof_kind" = 'signed' AND "message" IS NOT NULL AND "signature" IS NOT NULL AND "challenge_nonce" IS NOT NULL)
          OR ("proof_kind" = 'linked_wallet' AND "message" IS NULL AND "signature" IS NULL AND "challenge_nonce" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_withdraw_addresses_set_by_valid' AND conrelid = 'floor_arena_withdraw_addresses'::regclass) THEN
    ALTER TABLE "floor_arena_withdraw_addresses" ADD CONSTRAINT "floor_arena_withdraw_addresses_set_by_valid"
      CHECK ("set_by" IN ('human','agent') AND (("set_by" = 'agent') = ("set_by_agent_id" IS NOT NULL)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_withdraw_addresses_revoke_valid' AND conrelid = 'floor_arena_withdraw_addresses'::regclass) THEN
    ALTER TABLE "floor_arena_withdraw_addresses" ADD CONSTRAINT "floor_arena_withdraw_addresses_revoke_valid"
      CHECK (("revoked_at" IS NULL AND "revoke_reason" IS NULL) OR ("revoked_at" IS NOT NULL AND "revoke_reason" IN ('owner','replaced','admin')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_withdraw_addresses_shape' AND conrelid = 'floor_arena_withdraw_addresses'::regclass) THEN
    ALTER TABLE "floor_arena_withdraw_addresses" ADD CONSTRAINT "floor_arena_withdraw_addresses_shape"
      CHECK ("address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND "active_at" >= "created_at");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_withdraw_challenges_expiry' AND conrelid = 'floor_arena_withdraw_challenges'::regclass) THEN
    ALTER TABLE "floor_arena_withdraw_challenges" ADD CONSTRAINT "floor_arena_withdraw_challenges_expiry" CHECK ("expires_at" > "created_at");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_withdrawals_subject_valid' AND conrelid = 'floor_arena_withdrawals'::regclass) THEN
    ALTER TABLE "floor_arena_withdrawals" ADD CONSTRAINT "floor_arena_withdrawals_subject_valid"
      CHECK ("subject_kind" IN ('human','agent') AND (("subject_kind" = 'agent') = ("subject_agent_id" IS NOT NULL)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_withdrawals_asset_valid' AND conrelid = 'floor_arena_withdrawals'::regclass) THEN
    ALTER TABLE "floor_arena_withdrawals" ADD CONSTRAINT "floor_arena_withdrawals_asset_valid" CHECK ("asset" IN ('USDC','SOL'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_withdrawals_amount_valid' AND conrelid = 'floor_arena_withdrawals'::regclass) THEN
    ALTER TABLE "floor_arena_withdrawals" ADD CONSTRAINT "floor_arena_withdrawals_amount_valid"
      CHECK ((("amount_mode" = 'exact' AND "requested_atomic" IS NOT NULL AND "requested_atomic" > 0) OR ("amount_mode" = 'max' AND "requested_atomic" IS NULL))
        AND ("amount_atomic" IS NULL OR "amount_atomic" > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_withdrawals_state_valid' AND conrelid = 'floor_arena_withdrawals'::regclass) THEN
    ALTER TABLE "floor_arena_withdrawals" ADD CONSTRAINT "floor_arena_withdrawals_state_valid"
      CHECK ("state" IN ('requested','dispatching','sent','confirmed','cancelled','refused','failed','unknown','failed_no_send','needs_review'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_withdrawals_dispatch_stamp' AND conrelid = 'floor_arena_withdrawals'::regclass) THEN
    ALTER TABLE "floor_arena_withdrawals" ADD CONSTRAINT "floor_arena_withdrawals_dispatch_stamp"
      CHECK ("state" IN ('requested','cancelled','refused') OR ("amount_atomic" IS NOT NULL AND "dispatched_at" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_withdrawals_sent_signature' AND conrelid = 'floor_arena_withdrawals'::regclass) THEN
    ALTER TABLE "floor_arena_withdrawals" ADD CONSTRAINT "floor_arena_withdrawals_sent_signature"
      CHECK ("state" NOT IN ('sent','confirmed') OR "tx_signature" IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_withdrawals_codes_shape' AND conrelid = 'floor_arena_withdrawals'::regclass) THEN
    ALTER TABLE "floor_arena_withdrawals" ADD CONSTRAINT "floor_arena_withdrawals_codes_shape"
      CHECK (("error_code" IS NULL OR "error_code" ~ '^[a-z0-9_.:-]{1,64}$') AND "idempotency_key" ~ '^[A-Za-z0-9_-]{8,64}$');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_events_type_valid' AND conrelid = 'floor_arena_events'::regclass
             AND pg_get_constraintdef(oid) NOT LIKE '%withdraw%') THEN
    ALTER TABLE "floor_arena_events" DROP CONSTRAINT "floor_arena_events_type_valid";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_events_type_valid' AND conrelid = 'floor_arena_events'::regclass) THEN
    ALTER TABLE "floor_arena_events" ADD CONSTRAINT "floor_arena_events_type_valid"
      CHECK ("type" IN ('scan','pass','skip','entry','exit','param_change','report','status','addon','withdraw'));
  END IF;
END $$;

-- I1/I2: forward-only states and immutable money fields, enforced in the database.
CREATE OR REPLACE FUNCTION "floor_arena_withdrawals_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."agent_id" IS DISTINCT FROM OLD."agent_id" OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
     OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key" OR NEW."asset" IS DISTINCT FROM OLD."asset"
     OR NEW."amount_mode" IS DISTINCT FROM OLD."amount_mode" OR NEW."requested_atomic" IS DISTINCT FROM OLD."requested_atomic"
     OR NEW."source_clawpump_agent_id" IS DISTINCT FROM OLD."source_clawpump_agent_id"
     OR NEW."source_wallet" IS DISTINCT FROM OLD."source_wallet" OR NEW."destination" IS DISTINCT FROM OLD."destination"
     OR NEW."address_id" IS DISTINCT FROM OLD."address_id" OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR (OLD."amount_atomic" IS NOT NULL AND NEW."amount_atomic" IS DISTINCT FROM OLD."amount_atomic")
     OR (OLD."dispatched_at" IS NOT NULL AND NEW."dispatched_at" IS DISTINCT FROM OLD."dispatched_at")
     OR (OLD."tx_signature" IS NOT NULL AND NEW."tx_signature" IS DISTINCT FROM OLD."tx_signature") THEN
    RAISE EXCEPTION 'floor_arena_withdrawals: immutable field changed' USING ERRCODE = '23514';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
       (OLD."state" = 'requested'   AND NEW."state" IN ('dispatching','cancelled','refused'))
    OR (OLD."state" = 'dispatching' AND NEW."state" IN ('sent','unknown','failed','failed_no_send','needs_review'))
    OR (OLD."state" = 'sent'        AND NEW."state" IN ('confirmed','failed','failed_no_send','needs_review'))
    OR (OLD."state" = 'unknown'     AND NEW."state" IN ('confirmed','failed','failed_no_send','needs_review'))) THEN
    RAISE EXCEPTION 'floor_arena_withdrawals: state % -> % is not allowed', OLD."state", NEW."state" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "floor_arena_withdrawals_guard" ON "floor_arena_withdrawals";
CREATE TRIGGER "floor_arena_withdrawals_guard" BEFORE UPDATE ON "floor_arena_withdrawals"
  FOR EACH ROW EXECUTE FUNCTION "floor_arena_withdrawals_guard"();
