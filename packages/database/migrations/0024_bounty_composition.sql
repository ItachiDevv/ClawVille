-- 0024_bounty_composition.sql
-- Bounty composition rail (SLICE 2a) — bind a `payment_rail='usdc'` bounty on the
-- COMPOSED rail (SAP V2 USDC vault → PayAI x402 payout) to its two-leg state.
-- ADDITIVE + IDEMPOTENT ONLY (ADD COLUMN IF NOT EXISTS). A re-run is a no-op;
-- single-transaction-safe for migrate-ci (no enum ALTER, no CHECK, no backfill).
-- Do NOT change existing columns. Every existing bounty (CT, or USDC on the legacy
-- single-leg vault-less path) keeps both new columns NULL.
--
--   payout_escrow_pda  — LEG 2 (house→hunter) V1 PayAI payout escrow PDA (base58),
--                        NULL until leg 2 opens. Distinct from `escrow_pda`, which
--                        is LEG 1's V2 vault PDA (creator→house).
--   composition_state  — the composed-rail lifecycle marker (NULL for any
--                        non-composed bounty). Documented value set (no enum by
--                        design): 'vault_held' | 'vault_settled' | 'awaiting_finalize'
--                        | 'paid' | 'reconcile_payout_failed'.
--
-- Names reproduce the Drizzle schema names in packages/database/src/schema/bounties.ts.

ALTER TABLE "bounties" ADD COLUMN IF NOT EXISTS "payout_escrow_pda" varchar(64);
ALTER TABLE "bounties" ADD COLUMN IF NOT EXISTS "composition_state" varchar(32);
