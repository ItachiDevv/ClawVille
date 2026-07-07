-- 0008_clv_price_snapshots.sql
-- Tokenomics T0 — CLV price-oracle snapshot history (2026-07-07).
--
-- WHY: the READ-ONLY CLV price oracle
-- (apps/api/src/services/clv-price-oracle.ts) polls the on-chain USD price of
-- the ClawVille token (mint Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA,
-- Token-2022, 6 decimals, ~$0.00007 on a thin ~$22k LP) roughly every 60s —
-- Helius DAS `getAsset` price primary, DexScreener (keyless) fallback — and
-- writes ONE row per SUCCESSFUL fetch. These rows are the DURABLE history that
-- seeds the in-memory 30-minute TWAP window across process restarts and back
-- the admin read route `GET /api/oracle/clv?history=N`. `price_usd` is a USD
-- DECIMAL (numeric(20,12) = full precision for a sub-cent token), NEVER a
-- ClawToken amount — this feed never touches `avatars.clawTokens` or the ledger.
--
-- IDEMPOTENT: single guarded `CREATE TABLE IF NOT EXISTS` + a guarded
-- `CREATE INDEX IF NOT EXISTS` — a re-run where both already exist is a total
-- no-op. ADDITIVE-ONLY: one net-new table + one index; no enum changes; no FK
-- to any existing table. NEVER author a DROP of data.
--
-- CONSTRAINT/INDEX NAMING follows drizzle-kit's rendering convention (load-
-- bearing for drift-prevention, per 0001/0007): the explicit index name in the
-- Drizzle schema (`clv_price_snapshots_created_at_idx`) is reproduced verbatim.

CREATE TABLE IF NOT EXISTS "clv_price_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "price_usd" numeric(20, 12) NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "clv_price_snapshots_created_at_idx"
  ON "clv_price_snapshots" ("created_at");
