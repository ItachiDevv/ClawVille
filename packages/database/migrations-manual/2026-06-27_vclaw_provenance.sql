-- vCLAW PROVENANCE LEDGER — Tokenomics F1 (ADDITIVE, IDEMPOTENT).
--
-- Adds the provenance machinery to the EXISTING ClawToken ledger (plan §3):
--   * 3 per-tag balance columns on `avatars` (soft/bought/earned) — the one
--     visible `claw_tokens` total is split by cashability; HARD INVARIANT
--     `claw_tokens = soft_balance + bought_balance + earned_balance`.
--   * `claw_token_provenance` enum (soft|bought|earned) + 4 columns on
--     `claw_token_transactions` (provenance, usd_basis, fp_hash, ip_prefix_hash).
--   * Backfill: existing `claw_tokens` migrates ENTIRELY into `soft_balance`
--     (legacy CT was never paid for ⇒ honored as SOFT). bought/earned = 0.
--   * The sum CHECK constraint, added LAST (after the backfill) so it never
--     rejects a pre-backfill row whose tags are still 0 while claw_tokens != 0.
--
-- NOTHING becomes cashable here — F1 is ledger-only tagging (gate 1 prerequisite).
--
-- ⚠️ APPLY BY HAND — NOT `bun run db:push`. `db:push` is `drizzle-kit push --force`
-- (silent destructive: it drops any table NOT in the pushing branch's schema, no
-- prompt — it dropped the poker-MTT tables from staging on 2026-06-16). Apply this
-- file directly, e.g. via `packages/database/scripts/apply-vclaw-provenance.ts`
-- (takes an EXPLICIT $TOKENOMICS_DATABASE_URL) or psql:
--   psql "$TOKENOMICS_DATABASE_URL" -f 2026-06-27_vclaw_provenance.sql
--
-- Fully idempotent — safe to run repeatedly. The backfill guard
-- (`WHERE soft_balance + bought_balance + earned_balance <> claw_tokens`) means a
-- re-run NEVER double-moves an already-split balance.

-- ── (1) Create the provenance enum (idempotent) ──────────────────────────────
DO $$
BEGIN
  CREATE TYPE claw_token_provenance AS ENUM ('soft', 'bought', 'earned');
EXCEPTION
  WHEN duplicate_object THEN null;
END
$$;

-- ── (2) Add columns (idempotent) ─────────────────────────────────────────────
-- avatars: 3 per-tag balances. Default 0; the backfill below moves the existing
-- total into soft_balance for already-populated rows.
-- ADD with DEFAULT 0 so EXISTING rows fill to 0 (the backfill UPDATE below then
-- corrects them via the <>claw_tokens guard). The future-insert default is set to
-- 100 immediately after, so the two stages are distinct: existing rows = 0 (then
-- corrected), future bare INSERTs = 100 (to mirror claw_tokens's own default 100).
ALTER TABLE avatars
  ADD COLUMN IF NOT EXISTS soft_balance   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bought_balance integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS earned_balance integer NOT NULL DEFAULT 0;

-- soft_balance future-insert DEFAULT must MIRROR claw_tokens's DEFAULT (100), or a
-- bare INSERT that omits both columns produces `claw_tokens(100) <> soft(0)` and the
-- non-deferrable sum CHECK (added below) rejects it — taking down guest signup,
-- create-agent, agent-setup, Hatcher provision, and the web avatars route. SET
-- DEFAULT is always idempotent (safe to re-run). bought/earned stay DEFAULT 0.
ALTER TABLE avatars
  ALTER COLUMN soft_balance SET DEFAULT 100;

-- claw_token_transactions: provenance tag + usd basis + anti-abuse fp/ip hashes.
-- All nullable (historical rows have no provenance; usd_basis only on bought/earned).
ALTER TABLE claw_token_transactions
  ADD COLUMN IF NOT EXISTS provenance     claw_token_provenance,
  ADD COLUMN IF NOT EXISTS usd_basis      numeric(20, 6),
  ADD COLUMN IF NOT EXISTS fp_hash        text,
  ADD COLUMN IF NOT EXISTS ip_prefix_hash text;

-- Provenance audit index (scan all earned mints / all bought receipts).
CREATE INDEX IF NOT EXISTS claw_token_tx_provenance_idx
  ON claw_token_transactions (provenance, created_at);

-- ── (3) Backfill: legacy claw_tokens → soft_balance (idempotent guard) ────────
-- Only touches rows NOT yet split (tags don't already sum to the total). A row
-- the migration already processed sums correctly and is skipped, so re-running
-- can NEVER double-move a balance. New rows (default 0/0/0 with claw_tokens=100
-- from the column default) ARE processed: their soft_balance becomes 100.
UPDATE avatars
SET soft_balance   = claw_tokens,
    bought_balance = 0,
    earned_balance = 0
-- (`<>` is NULL-safe here ONLY because all three tag columns are NOT NULL. If a
-- nullable fourth tag is ever added, switch to `IS DISTINCT FROM` or this guard
-- silently skips NULL-tag rows and the CHECK below later rejects them.)
WHERE soft_balance + bought_balance + earned_balance <> claw_tokens;

-- ── (4) Sum CHECK constraint, added AFTER backfill (idempotent drop+add) ──────
-- Defense-in-depth: the ledger maintains the sum atomically; this CHECK rejects
-- any direct-SQL write that breaks it. Added last so it never rejects a row the
-- backfill above hadn't reconciled. A CHECK has no `ADD ... IF NOT EXISTS`, so
-- the idempotent pattern is DROP-IF-EXISTS then ADD (mirrors migration 0005).
ALTER TABLE avatars
  DROP CONSTRAINT IF EXISTS avatars_vclaw_balance_sum;

ALTER TABLE avatars
  ADD CONSTRAINT avatars_vclaw_balance_sum
  CHECK (claw_tokens = soft_balance + bought_balance + earned_balance);
