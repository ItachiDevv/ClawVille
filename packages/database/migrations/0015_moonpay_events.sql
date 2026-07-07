-- 0015_moonpay_events.sql
-- Tokenomics C2 (2026-07-07) — MoonPay TEST-MODE card-rail webhook idempotency ledger.
--
-- WHY: the MoonPay webhook receiver (apps/api/src/routes/moonpay.ts) must be
-- idempotent BY THE DATABASE, never SELECT-then-act: `external_tx_id` (MoonPay's
-- own transaction id, `data.id`) is UNIQUE, so a replayed delivery conflicts on
-- the index and is answered 200-cached; a status progression (pending →
-- completed) lands via a guarded update (`WHERE processed_at IS NULL`) so the
-- terminal "checkout ready" marker is claimed EXACTLY ONCE. `client_ref` is OUR
-- reference (MoonPay's `externalTransactionId` widget param) — the seam the
-- checkout stage joins on. Amount columns are USD/USDC decimals — NEVER
-- ClawToken amounts; this table never touches `avatars.clawTokens` or the ledger.
-- NO custodial auto-sign anywhere on this rail (Codex-gated seam in the route).
--
-- IDEMPOTENT + ADDITIVE ONLY: one guarded CREATE TABLE (UNIQUE constraint
-- rides inside it) + one guarded CREATE INDEX. A re-run where both exist is a
-- total no-op. NEVER author a DROP of data.
--
-- CONSTRAINT/INDEX NAMING follows drizzle-kit's rendering convention (load-
-- bearing for drift-prevention, per 0001/0007/0008): the UNIQUE constraint name
-- matches drizzle's `<table>_<column>_unique`; the index name reproduces the
-- explicit Drizzle schema name in packages/database/src/schema/moonpay.ts.

CREATE TABLE IF NOT EXISTS "moonpay_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "external_tx_id" text NOT NULL,
  "event_type" text NOT NULL,
  "status" text,
  "client_ref" text,
  "wallet_address" text,
  "base_currency_amount" numeric(20, 6),
  "quote_currency_amount" numeric(20, 6),
  "currency_code" text,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "processed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "moonpay_events_external_tx_id_unique" UNIQUE ("external_tx_id")
);

CREATE INDEX IF NOT EXISTS "moonpay_events_client_ref_idx"
  ON "moonpay_events" ("client_ref");
