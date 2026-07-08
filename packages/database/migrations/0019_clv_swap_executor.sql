-- 0019_clv_swap_executor.sql
-- Tokenomics GoLive executors (2026-07-07) — CLV swap executor live-path plumbing
-- (DARK: everything ships behind the intact CLV_SWAP_EXECUTE module-load throw).
--
-- WHY: the live CLV swap path (apps/api/src/services/clv-swap-live.ts +
-- clv-swap-custody.ts) needs
--   (a) enqueue IDEMPOTENCY — a settle replay must return the EXISTING queueId
--       instead of double-recording an owed buy: partial UNIQUE on
--       clv_buy_queue(reason, source_ref) WHERE source_ref IS NOT NULL, driven
--       by enqueueClvBuy's INSERT … ON CONFLICT upsert;
--   (b) the ATOMIC-CLAIM + execution-audit columns on clv_buy_queue
--       (claim_id/claimed_at BEFORE any decrypt/sign/send; executed_at/
--       executed_price on completion; tx_signatures = per-clip fills captured
--       BEFORE each send; skipped_reason for operator skips);
--   (c) clv_swap_funding — the exactly-once DB trail for the merchant→swap-
--       wallet USDC funding sweep (amounts tied to SETTLED x402_checkouts
--       only; source_ref UNIQUE = the double-sweep guard; sweep_tx_signature
--       captured-before-send + partial-UNIQUE).
-- The companion enum value ('executing') lives ALONE in
-- 0019a_clv_buy_status_executing.sql per the migrate-ci ALTER TYPE rule.
-- NOTHING in this migration is reachable at runtime until the Codex-gated
-- CLV_SWAP_EXECUTE seam opens; all amounts are USD decimals — NEVER ClawToken
-- amounts; this migration never touches `avatars.clawTokens` or the ledger.
--
-- IDEMPOTENT + ADDITIVE ONLY: CREATE UNIQUE INDEX IF NOT EXISTS, ADD COLUMN
-- IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS. A
-- re-run where everything exists is a total no-op. NEVER author a DROP.
--
-- ⚠ DUPLICATE-DATA NOTE (deliberate fail-loud): if clv_buy_queue somehow
-- already holds duplicate (reason, source_ref) rows, the UNIQUE index build
-- FAILS and migrate-ci blocks the deploy. That is intentional — duplicate
-- owed-buy rows are a money discrepancy an operator must resolve BY HAND
-- (we never auto-delete money-intent rows in a migration).
--
-- CONSTRAINT/INDEX NAMING follows drizzle-kit's rendering convention (load-
-- bearing for drift-prevention, per 0001/0014/0016): names reproduce the
-- explicit Drizzle schema names in packages/database/src/schema/swap.ts.

-- ── (a) enqueue idempotency — one owed buy per (reason, source event) ────────
CREATE UNIQUE INDEX IF NOT EXISTS "clv_buy_queue_reason_source_ref_uniq"
  ON "clv_buy_queue" ("reason", "source_ref") WHERE source_ref IS NOT NULL;

-- ── (b) atomic-claim + execution-audit columns ───────────────────────────────
ALTER TABLE "clv_buy_queue" ADD COLUMN IF NOT EXISTS "claim_id" uuid;
ALTER TABLE "clv_buy_queue" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;
ALTER TABLE "clv_buy_queue" ADD COLUMN IF NOT EXISTS "executed_at" timestamp with time zone;
ALTER TABLE "clv_buy_queue" ADD COLUMN IF NOT EXISTS "executed_price" numeric(20, 12);
ALTER TABLE "clv_buy_queue" ADD COLUMN IF NOT EXISTS "tx_signatures" jsonb;
ALTER TABLE "clv_buy_queue" ADD COLUMN IF NOT EXISTS "skipped_reason" text;

-- ── (c) the funding-sweep trail ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "clv_swap_funding" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_ref" text NOT NULL CONSTRAINT "clv_swap_funding_source_ref_unique" UNIQUE,
  "checkout_id" uuid,
  "amount_usdc" numeric(20, 6) NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "sweep_tx_signature" text,
  "claim_id" uuid,
  "claimed_at" timestamp with time zone,
  "swept_at" timestamp with time zone,
  "failure_reason" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "clv_swap_funding_status_created_idx"
  ON "clv_swap_funding" ("status", "created_at");

-- One on-chain sweep tx binds to exactly one funding row (capture key —
-- mirrors x402_checkouts_txsig_unique).
CREATE UNIQUE INDEX IF NOT EXISTS "clv_swap_funding_sweep_sig_uniq"
  ON "clv_swap_funding" ("sweep_tx_signature") WHERE sweep_tx_signature IS NOT NULL;
