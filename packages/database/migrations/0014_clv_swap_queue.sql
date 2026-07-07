-- 0014_clv_swap_queue.sql
-- Tokenomics C3 (2026-07-07) — CLV buy-queue seam + the 'clv-swap' treasury purpose.
--
-- WHY: every spine that owes the market a CLV buy (checkout USDC splits,
-- marketplace fee routing, …) records INTENT via `clv_buy_queue` (one row per
-- owed buy, written by apps/api/src/services/clv-swap-executor.ts
-- enqueueClvBuy(), composable into the caller's settle transaction). The row is
-- a RECORD only — enqueueing does NO CT-ledger write and NO on-chain action.
-- The executor is DRY-RUN ONLY (CLV_SWAP_EXECUTE=true refuses to boot; live
-- execution is a Codex-review-gated seam). `amount_usdc`/`quoted_price` are USD
-- decimals — NEVER ClawToken amounts; this migration never touches
-- `avatars.clawTokens` or the ledger.
--
-- IDEMPOTENT + ADDITIVE ONLY: one guarded CREATE TYPE, one enum value add, one
-- CREATE TABLE IF NOT EXISTS, one CREATE INDEX IF NOT EXISTS. A re-run where
-- everything exists is a total no-op. NEVER author a DROP of data.
--
-- ⚠ APPLY MODE: run statement-by-statement in AUTOCOMMIT (plain `psql -f`, or a
-- per-statement client). `ALTER TYPE ... ADD VALUE` cannot run inside a
-- transaction block on older PG (and a value can't be USED in the txn that
-- added it) — same rule as 0013. Nothing below uses 'clv-swap' after adding it,
-- but keep the apply mode uniform.
--
-- CONSTRAINT/INDEX NAMING follows drizzle-kit's rendering convention (load-
-- bearing for drift-prevention, per 0001/0007/0008): names reproduce the
-- explicit Drizzle schema names in packages/database/src/schema/swap.ts.

-- ── new enum type (duplicate-safe) ───────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE clv_buy_status AS ENUM ('planned', 'executed', 'skipped');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── treasury purpose value (own autocommit statement — see header) ──────────
ALTER TYPE treasury_purpose ADD VALUE IF NOT EXISTS 'clv-swap';

-- ── the buy-queue table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "clv_buy_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "amount_usdc" numeric(20, 6) NOT NULL,
  "quoted_price" numeric(20, 12),
  "max_slippage" numeric(6, 4),
  "status" clv_buy_status NOT NULL DEFAULT 'planned',
  "reason" text NOT NULL,
  "source_ref" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "clv_buy_queue_status_created_idx"
  ON "clv_buy_queue" ("status", "created_at");
