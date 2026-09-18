-- 0067_sap_table_drop.sql
--
-- FINAL residual of the OOBE/SAP removal (founder order 2026-08-20). The code
-- layer was deleted on 2026-08-20 (`716c961c`, ~58K lines: services/sap*,
-- routes/sap.ts, bounty-escrow-link.ts, bounty-composition-worker.ts). The
-- physical tables and the legacy `bounties` columns were deliberately KEPT
-- declared at that time so `drizzle-kit push` could not silently destroy the
-- reconciliation evidence before a deliberate, reviewed drop. That soak is over.
--
-- Pre-drop state VERIFIED against the PROD database 2026-09-18:
--   sap_agent_identities        11 rows
--   sap_deposit_requests         0 rows
--   sap_escrow_approvals        35 rows
--   sap_escrow_settlements      36 rows
--   sap_escrow_withdrawals      20 rows
--   sap_reputation_jobs         14 rows
--   bounty_gas_cap_policies      0 rows
--   bounty_gas_sponsorships      0 rows
--   bounties rows carrying legacy SAP evidence: 21 (of 14,182 total)
--
-- Every one of those rows was ARCHIVED to JSON before this migration was
-- written. Nothing on-chain survives them: all 20 mainnet escrows plus the
-- house agent account were closed 2026-08-20, the staging-box mainnet leftovers
-- were closed 2026-09-07, and the recovered SOL was swept 2026-09-13. Both house
-- wallets read 0 SOL on mainnet (re-verified 2026-09-18).
--
-- SAFE TO DROP — no reader, no writer:
--   * No code path inserts, updates or deletes any `sap_*` or `bounty_gas_*`
--     row on `master`. The sole remaining readers were in
--     `routes/partner-covenant.ts`, removed in this same diff.
--   * The Covenant partner read surface is UNPROVISIONED on prod
--     (`COVENANT_ALLOWED_IPS` unset ⇒ fail-closed). Verified live 2026-09-18:
--     `GET /api/partner/covenant/bounties` returns 503.
--   * `bounties.covenant_verification_passed` and `bounties.verdict_required`
--     are LIVE (written by `services/bounty-tier1.ts`) and are NOT touched here.
--
-- Additive-safety note: this migration is destructive BY DESIGN and is the one
-- deliberate exception the 2026-08-20 removal reserved. It is idempotent — every
-- statement is `IF EXISTS`, so a re-apply is a no-op.
--
-- NO EXPLICIT TRANSACTION: `migrate-ci.ts` sends each *.sql file as a SINGLE
-- multi-statement simple query, which Postgres already wraps in ONE implicit
-- transaction. An explicit BEGIN inside that would warn and an explicit COMMIT
-- would end the runner's transaction early. No other migration uses BEGIN.

-- ── 1. Legacy composed-rail CHECK constraints on `bounties` ──────────────────
-- Dropped BEFORE their columns so the column drop cannot trip a dependency.
ALTER TABLE public.bounties
  DROP CONSTRAINT IF EXISTS bounties_composition_refund_claim_lease_pair;
ALTER TABLE public.bounties
  DROP CONSTRAINT IF EXISTS bounties_composition_refund_reconcile_has_signature;

-- ── 2. Legacy SAP / composed-rail columns on `bounties` ─────────────────────
-- Historical evidence only; no runtime reader or writer since 2026-08-20.
ALTER TABLE public.bounties DROP COLUMN IF EXISTS escrow_pda;
ALTER TABLE public.bounties DROP COLUMN IF EXISTS escrow_job_id;
ALTER TABLE public.bounties DROP COLUMN IF EXISTS payout_escrow_pda;
ALTER TABLE public.bounties DROP COLUMN IF EXISTS composition_state;
ALTER TABLE public.bounties DROP COLUMN IF EXISTS composition_refund_signature;
ALTER TABLE public.bounties DROP COLUMN IF EXISTS composition_refund_claim_id;
ALTER TABLE public.bounties DROP COLUMN IF EXISTS composition_refund_claimed_at;

-- ── 3. SAP tables ───────────────────────────────────────────────────────────
-- No FK points INTO these tables (their own FKs point OUT at `avatars`), so a
-- plain DROP is sufficient and CASCADE is deliberately NOT used: if an unknown
-- dependency exists, this migration must FAIL LOUDLY rather than widen silently.
DROP TABLE IF EXISTS public.sap_escrow_withdrawals;
DROP TABLE IF EXISTS public.sap_deposit_requests;
DROP TABLE IF EXISTS public.sap_escrow_approvals;
DROP TABLE IF EXISTS public.sap_escrow_settlements;
DROP TABLE IF EXISTS public.sap_reputation_jobs;
DROP TABLE IF EXISTS public.sap_agent_identities;

-- ── 4. SAP gas-sponsorship tables ───────────────────────────────────────────
-- Sole writer was `sap-gas-sponsor.ts`, deleted 2026-08-20. Both are empty.
DROP TABLE IF EXISTS public.bounty_gas_sponsorships;
DROP TABLE IF EXISTS public.bounty_gas_cap_policies;

-- ── 5. SAP-only enum type ───────────────────────────────────────────────────
-- Dropped last: a type cannot be removed while a column still uses it.
DROP TYPE IF EXISTS sap_escrow_settlement_status;
