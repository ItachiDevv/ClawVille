-- 0018_ct_topups_durable_settle.sql
-- Tokenomics C — ct-topup on-ramp hardening (Codex money-path review fast-follow).
--
-- WHY: the ct_topups on-ramp shared the pre-hardening residual the x402_checkouts
-- review fixed — the settled tx signature was persisted ONLY inside the credit
-- transaction, so a post-settle failure rolled the row back to 'pending' and a
-- retry re-settled real USDC. This migration adds the SETTLING-side durability
-- that makes the on-ramp a resumable, cross-process settle machine (the
-- settled-side guards — the tx_signature partial-UNIQUE + the (avatar_id,
-- idempotency_key) UNIQUE from 0001 — are UNCHANGED and remain the double-credit
-- backstops):
--   * status += 'settling' (a DB-backed claim taken BEFORE the facilitator so
--     only one process ever calls verify→settle) and 'reconcile' (a stale claim
--     with money-state unknown — never auto-retried);
--   * settling_id / settling_started_at — the claim token + its age (stale
--     detection → reconcile);
--   * CHECK ct_topups_settled_has_signature: a settled row ALWAYS carries the
--     tx signature (the money proof can never be absent on a credited top-up).
--
-- IDEMPOTENT + ADDITIVE ONLY: ALTER TYPE ... ADD VALUE IF NOT EXISTS (autocommit-
-- only — own statements, cannot run inside a txn block), ADD COLUMN IF NOT EXISTS,
-- a duplicate-safe ADD CONSTRAINT. A re-run where everything exists is a total
-- no-op. NEVER author a DROP of data.
--
-- APPLY MODE: run statement-by-statement in AUTOCOMMIT (plain `psql -f`, or a
-- per-statement client) — same rule as 0013/0014/0016. Apply by hand/CI; NEVER
-- db:push (which would diff the whole schema and can silently DROP).

-- ── the two new settle states (duplicate-safe, own autocommit statements) ────
ALTER TYPE ct_topup_status ADD VALUE IF NOT EXISTS 'settling';
ALTER TYPE ct_topup_status ADD VALUE IF NOT EXISTS 'reconcile';

-- ── the claim columns ────────────────────────────────────────────────────────
ALTER TABLE "ct_topups" ADD COLUMN IF NOT EXISTS "settling_id" uuid;
ALTER TABLE "ct_topups" ADD COLUMN IF NOT EXISTS "settling_started_at" timestamp with time zone;

-- ── the settled-has-signature invariant (duplicate-safe) ─────────────────────
DO $$ BEGIN
  ALTER TABLE "ct_topups" ADD CONSTRAINT "ct_topups_settled_has_signature"
    CHECK ("status" <> 'settled' OR "tx_signature" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN null; END $$;
