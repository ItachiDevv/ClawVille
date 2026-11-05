-- 0090_vendor_spend_ledger.sql
-- MCP hub step 2, phase 2 (2026-11-05): one row per paid call that an avatar
-- makes to a third-party vendor (first vendor: Studios). The row is written
-- BEFORE the avatar wallet signs, so a crash after signing still leaves a
-- record. Daily sums for the user's spend rules come from this table under a
-- per-avatar advisory lock. An 'ambiguous' row (the payment may or may not have
-- settled) is never retried automatically.
-- Additive and idempotent; safe for the CI migration runner to re-check.

DO $$ BEGIN
  CREATE TYPE "vendor_spend_status" AS ENUM ('pending', 'paid', 'failed', 'ambiguous');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "vendor_spend_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "avatar_id" uuid NOT NULL,
  "vendor" varchar(32) NOT NULL,
  "tool" varchar(64) NOT NULL,
  -- Who started the call: the human in the web panel or the avatar's agent.
  "actor" varchar(16) NOT NULL,
  "status" "vendor_spend_status" DEFAULT 'pending' NOT NULL,
  -- The seller's quoted amount in USDC base units (6 decimals), and the same
  -- amount rounded UP to whole US cents for the cap sums.
  "usdc_atomic" numeric(20,0) NOT NULL,
  "usd_cents" integer NOT NULL,
  "pay_to" varchar(64) NOT NULL,
  "payer_wallet" varchar(64) NOT NULL,
  "network" varchar(100) NOT NULL,
  "idempotency_key" varchar(64) NOT NULL,
  -- Our wallet's own signature on the payment transaction, stored BEFORE the
  -- paid request is sent, so a reconcile can find the transaction on chain.
  "payer_signature" text,
  "tx_signature" text,
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vendor_spend_ledger_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE restrict,
  CONSTRAINT "vendor_spend_ledger_actor_check" CHECK ("actor" IN ('human', 'agent')),
  CONSTRAINT "vendor_spend_ledger_amount_check" CHECK ("usdc_atomic" > 0 AND "usd_cents" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "vendor_spend_ledger_avatar_idem_unique"
  ON "vendor_spend_ledger" ("avatar_id", "idempotency_key");

CREATE INDEX IF NOT EXISTS "vendor_spend_ledger_avatar_created_idx"
  ON "vendor_spend_ledger" ("avatar_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "vendor_spend_ledger_tx_signature_unique"
  ON "vendor_spend_ledger" ("tx_signature") WHERE "tx_signature" IS NOT NULL;
