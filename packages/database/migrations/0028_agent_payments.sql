-- 0028_agent_payments.sql
-- General agent/human avatar-to-avatar USDC payment ledger through PayAI.
-- Additive and idempotent; safe for the CI migration runner to re-check.

DO $$ BEGIN
  CREATE TYPE "agent_payment_status" AS ENUM
    ('pending', 'settling', 'settled', 'failed', 'reconcile');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "agent_payment_recipient_kind" AS ENUM ('avatar', 'agent');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "agent_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sender_avatar_id" uuid NOT NULL,
  "recipient_avatar_id" uuid NOT NULL,
  "recipient_kind" "agent_payment_recipient_kind" NOT NULL,
  "recipient_ref" varchar(200) NOT NULL,
  "sender_wallet" varchar(64) NOT NULL,
  "recipient_wallet" varchar(64) NOT NULL,
  "usd_cents" integer NOT NULL,
  "usdc_atomic" numeric(20,0) NOT NULL,
  "status" "agent_payment_status" DEFAULT 'pending' NOT NULL,
  "idempotency_key" varchar(64) NOT NULL,
  "settling_id" uuid,
  "settling_started_at" timestamp with time zone,
  "tx_signature" text,
  "reconcile_tx_signature" text,
  "settle_payer" varchar(64),
  "network" varchar(100) NOT NULL,
  "earned_vclaw" integer DEFAULT 0 NOT NULL,
  "earned_usd_basis" numeric(20,6),
  "earned_ledger_id" uuid,
  "fulfilled_at" timestamp with time zone,
  "failure_reason" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_payments_sender_avatar_id_avatars_id_fk"
    FOREIGN KEY ("sender_avatar_id") REFERENCES "avatars"("id") ON DELETE restrict,
  CONSTRAINT "agent_payments_recipient_avatar_id_avatars_id_fk"
    FOREIGN KEY ("recipient_avatar_id") REFERENCES "avatars"("id") ON DELETE restrict,
  CONSTRAINT "agent_payments_earned_ledger_id_claw_token_transactions_id_fk"
    FOREIGN KEY ("earned_ledger_id") REFERENCES "claw_token_transactions"("id") ON DELETE restrict,
  CONSTRAINT "agent_payments_amount_positive" CHECK ("usd_cents" >= 1),
  CONSTRAINT "agent_payments_atomic_matches_cents" CHECK (
    "usdc_atomic" = "usd_cents" * 10000
  ),
  CONSTRAINT "agent_payments_earned_nonnegative" CHECK ("earned_vclaw" >= 0),
  CONSTRAINT "agent_payments_settled_complete" CHECK (
    "status" <> 'settled' OR (
      "tx_signature" IS NOT NULL AND "fulfilled_at" IS NOT NULL
      AND "earned_vclaw" > 0 AND "earned_ledger_id" IS NOT NULL
      AND "earned_usd_basis" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_payments_sender_idem_unique"
  ON "agent_payments" ("sender_avatar_id", "idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_payments_txsig_unique"
  ON "agent_payments" ("tx_signature") WHERE "tx_signature" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_payments_earned_ledger_unique"
  ON "agent_payments" ("earned_ledger_id") WHERE "earned_ledger_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "agent_payments_recipient_idx"
  ON "agent_payments" ("recipient_avatar_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_payments_status_idx"
  ON "agent_payments" ("status", "updated_at");
