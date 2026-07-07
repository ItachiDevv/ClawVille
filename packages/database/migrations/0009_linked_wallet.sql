-- 0009_linked_wallet.sql
-- Tokenomics Phase A / Slice A1 (2026-07-07) — persistent SELF-CUSTODY wallet link.
--
-- Adds the pubkey POINTER of a wallet the user proves they control by signing a
-- server-issued challenge (routes/wallet-link.ts). Its CLV ($CLAWVILLE) balance
-- backs the hold-tier / seller-license / land hold-to-keep checks. The CLV never
-- leaves the wallet — we only READ the balance (non-custodial), so this is a
-- pointer, never a custody column.
--
-- Idempotent + additive-only (migrate-ci discipline — NEVER db:push). No DROP,
-- no data mutation. The partial UNIQUE index allows unlimited NULLs (accounts
-- that never link a wallet) while guaranteeing one on-chain wallet backs at most
-- one account.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "linked_wallet_pubkey" varchar(44);

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "linked_wallet_at" timestamptz;

-- Partial UNIQUE (WHERE NOT NULL) — one wallet = at most one account, but any
-- number of accounts may have NO linked wallet. Authored as an explicit index
-- (not a table constraint) so it stays partial; the Drizzle column is declared
-- WITHOUT `.unique()` to match (this SQL is authoritative — migrate-ci applies
-- exactly this, never drizzle-kit push).
CREATE UNIQUE INDEX IF NOT EXISTS "users_linked_wallet_pubkey_unique"
  ON "users" ("linked_wallet_pubkey")
  WHERE "linked_wallet_pubkey" IS NOT NULL;
