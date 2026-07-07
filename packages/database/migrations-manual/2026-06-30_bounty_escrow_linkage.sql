-- Bounty ↔ SAP USDC escrow linkage + verdict fields (ADDITIVE, IDEMPOTENT).
-- Phase 1 of the all-three agent-bounty path-to-live (see
-- .claude/plans/agent-economy-path-to-live.md §5 Phase 1).
--
-- Adds one enum + eight columns to the EXISTING `bounties` table. ALL are
-- NULL/default for every existing CT bounty and for the whole live CT board — a
-- classic `payment_rail='ct'` bounty is byte-for-byte unchanged in behavior. Only
-- a `payment_rail='usdc'` bounty populates the escrow/verdict columns, and that
-- rail is triple-gated OFF (SAP_ENABLED / SAP_ESCROW_ENABLED /
-- SAP_USDC_ESCROW_ENABLED all default false) + SAP_DRY_RUN=true by default, so NO
-- real money moves until a deliberate founder flip.
--
-- Source of truth: packages/database/src/schema/bounties.ts.
--
-- ⚠️ APPLY BY HAND — NOT `bun run db:push`. `db:push` is `drizzle-kit push --force`
-- (silent destructive: it drops any table NOT in the pushing branch's schema, no
-- prompt — it dropped the poker-MTT tables from staging on 2026-06-16). Apply this
-- file directly via `packages/database/scripts/apply-bounty-escrow-linkage.ts`
-- (takes an EXPLICIT $TOKENOMICS_DATABASE_URL — nothing auto-loads it, so the
-- target DB is a deliberate choice, never a silent prod hit) or psql:
--   psql "$TOKENOMICS_DATABASE_URL" -f 2026-06-30_bounty_escrow_linkage.sql
--
-- Fully idempotent — safe to run repeatedly: CREATE TYPE guarded + ADD COLUMN IF
-- NOT EXISTS. It NEVER drops or rewrites a column, so it can never touch live data.

-- ── (1) payment-rail enum (idempotent CREATE) ────────────────────────────────
DO $$
BEGIN
  CREATE TYPE bounty_payment_rail AS ENUM ('ct', 'usdc');
EXCEPTION
  WHEN duplicate_object THEN null;
END
$$;

-- ── (2) additive columns on the existing bounties table ──────────────────────
ALTER TABLE IF EXISTS bounties
  ADD COLUMN IF NOT EXISTS acceptance_criteria text,
  ADD COLUMN IF NOT EXISTS payment_rail bounty_payment_rail NOT NULL DEFAULT 'ct',
  ADD COLUMN IF NOT EXISTS escrow_pda varchar(64),
  ADD COLUMN IF NOT EXISTS escrow_job_id varchar(128),
  ADD COLUMN IF NOT EXISTS covenant_audit_root_hex varchar(64),
  ADD COLUMN IF NOT EXISTS covenant_verification_passed boolean,
  ADD COLUMN IF NOT EXISTS covenant_verdict_id varchar(128),
  ADD COLUMN IF NOT EXISTS verdict_required boolean NOT NULL DEFAULT false;

-- Partial index: fast lookup of a bounty by its bound escrow (escrow, job). Only
-- USDC bounties have a non-null escrow_pda, so the partial index stays tiny.
CREATE INDEX IF NOT EXISTS bounties_escrow_pda_job_idx
  ON bounties (escrow_pda, escrow_job_id)
  WHERE escrow_pda IS NOT NULL;

-- ── SEV-1 belt-and-suspenders: at most ONE 'approved' attempt per bounty ──────
-- The real fix for the CT double-pay faucet is the ATOMIC APPROVAL CLAIM in the
-- review route (UPDATE ... WHERE id=? AND status='submitted' RETURNING). This
-- PARTIAL UNIQUE INDEX is a DB-level backstop: even if the code path ever
-- regresses, Postgres refuses a second 'approved' row for the same bounty_id, so
-- the hunter can never be paid twice.
--
-- Guarded in a DO block: if this migration runs against a DB that already carries
-- historical duplicate-approved rows (from the pre-fix TOCTOU), a bare CREATE
-- UNIQUE INDEX would ABORT the whole additive migration. We instead attempt it and
-- downgrade a unique-violation to a loud NOTICE — the additive columns above still
-- land, and an operator reconciles the pre-existing duplicates before re-running
-- (at which point the index creates cleanly). IF NOT EXISTS makes re-runs a no-op.
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS bounty_attempts_one_approved_per_bounty
    ON bounty_attempts (bounty_id)
    WHERE status = 'approved';
EXCEPTION
  WHEN unique_violation THEN
    RAISE WARNING '[bounty-escrow] bounty_attempts_one_approved_per_bounty NOT created: '
      'pre-existing duplicate approved attempts exist. Reconcile them (keep one '
      'approved per bounty_id), then re-run this migration to install the guard.';
END
$$;
