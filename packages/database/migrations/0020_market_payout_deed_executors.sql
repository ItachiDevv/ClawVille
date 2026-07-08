-- 0020_market_payout_deed_executors.sql
-- Tokenomics GoLive executors (2026-07-07) — market PAYOUT + DEED-TRANSFER
-- executor plumbing on `market_settlements`.
-- (DARK: both executors ship behind default-OFF flags — MARKET_PAYOUT_EXECUTE
-- and MARKET_DEED_TRANSFER_ENABLED — and NOTHING is wired into index.ts boot.)
--
-- WHY: the P2P marketplace fulfiller (0017) records the seller-payout + rake
-- INTENTS ('pending_review') and the deed-transfer intent (deed_transferred_at
-- RESERVED). The GoLive executors need durable executor state:
--   (a) DEED-TRANSFER trail (apps/api/src/services/market-deed-transfer-
--       executor.ts): deed_transfer_claim_id / deed_transfer_started_at (the
--       per-row atomic-claim audit; the cross-process mutex is FOR UPDATE
--       SKIP LOCKED + the deed_transferred_at IS NULL predicate, all ONE tx)
--       and deed_transfer_failure_reason (terminal 'deed_transfer_conflict'
--       family — the seller no longer owns the parcel / escrow present; the
--       executor NEVER forces a flip).
--   (b) PAYOUT trail (apps/api/src/services/market-payout-executor.ts):
--       payout_claim_id / payout_claimed_at (atomic claim pending_review→
--       'sending' BEFORE any decrypt/sign/send), payout_seller_tx_signature +
--       payout_rake_tx_signature (each CAPTURED in its OWN committed UPDATE
--       BEFORE the wire is touched — capture-before-send, partial-UNIQUE so
--       one on-chain send binds to exactly one settlement), payout_clv_atomic
--       (the seller's CLV atomic amount, exact-integer floor house-favorable),
--       payout_executed_rate (the C3 buy's realized USD/CLV rate the amounts
--       derive from), payout_executed_at ('paid' stamp), and
--       payout_failure_reason (reconcile/terminal machine reason).
-- The companion enum values ('sending', 'reconcile' on market_payout_status)
-- live ALONE in 0020a/0020b per the migrate-ci ALTER TYPE rule (one ADD VALUE
-- per file, no neighbors).
--
-- NOTHING in this migration is reachable at runtime until the Codex-gated
-- flags flip; all USD amounts remain decimals (never ClawToken amounts); this
-- migration never touches `avatars.clawTokens` or the CT ledger, and it never
-- ALTERs a land table (the deed executor writes land_parcels via its own SQL
-- at runtime — schema-wise land is untouched).
--
-- IDEMPOTENT + ADDITIVE ONLY: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS. A re-run where everything exists is a total no-op. NEVER a DROP.
--
-- CONSTRAINT/INDEX NAMING follows drizzle-kit's rendering convention (load-
-- bearing for drift-prevention, per 0001/0014/0017/0019): names reproduce the
-- explicit Drizzle schema names in packages/database/src/schema/market.ts.

-- ── (a) deed-transfer executor trail ─────────────────────────────────────────
ALTER TABLE "market_settlements" ADD COLUMN IF NOT EXISTS "deed_transfer_claim_id" uuid;
ALTER TABLE "market_settlements" ADD COLUMN IF NOT EXISTS "deed_transfer_started_at" timestamp with time zone;
ALTER TABLE "market_settlements" ADD COLUMN IF NOT EXISTS "deed_transfer_failure_reason" text;

-- ── (b) payout executor trail ────────────────────────────────────────────────
ALTER TABLE "market_settlements" ADD COLUMN IF NOT EXISTS "payout_claim_id" uuid;
ALTER TABLE "market_settlements" ADD COLUMN IF NOT EXISTS "payout_claimed_at" timestamp with time zone;
ALTER TABLE "market_settlements" ADD COLUMN IF NOT EXISTS "payout_seller_tx_signature" text;
ALTER TABLE "market_settlements" ADD COLUMN IF NOT EXISTS "payout_rake_tx_signature" text;
ALTER TABLE "market_settlements" ADD COLUMN IF NOT EXISTS "payout_clv_atomic" numeric;
ALTER TABLE "market_settlements" ADD COLUMN IF NOT EXISTS "payout_executed_rate" numeric(20, 12);
ALTER TABLE "market_settlements" ADD COLUMN IF NOT EXISTS "payout_executed_at" timestamp with time zone;
ALTER TABLE "market_settlements" ADD COLUMN IF NOT EXISTS "payout_failure_reason" text;

-- One on-chain CLV send binds to exactly one settlement (capture keys —
-- mirrors clv_swap_funding_sweep_sig_uniq / x402_checkouts_txsig_unique).
CREATE UNIQUE INDEX IF NOT EXISTS "market_settlements_payout_seller_sig_uniq"
  ON "market_settlements" ("payout_seller_tx_signature") WHERE payout_seller_tx_signature IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "market_settlements_payout_rake_sig_uniq"
  ON "market_settlements" ("payout_rake_tx_signature") WHERE payout_rake_tx_signature IS NOT NULL;

-- Deed-executor scan hot path: settlements whose deed is still pending
-- (transferred_at NULL, no terminal failure). Partial keeps the periodic scan
-- off the settled bulk.
CREATE INDEX IF NOT EXISTS "market_settlements_deed_pending_idx"
  ON "market_settlements" ("created_at")
  WHERE deed_transferred_at IS NULL AND deed_transfer_failure_reason IS NULL;
