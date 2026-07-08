-- 0020a_market_payout_status_sending.sql
-- Tokenomics GoLive executors (2026-07-07) — the 'sending' claim state for
-- market_settlements.payout_status (companion to 0020_market_payout_deed_executors.sql).
--
-- ALONE IN ITS OWN FILE, ONE STATEMENT, per the migrate-ci FUTURE-AUTHOR rule
-- (same as 0019a): `ALTER TYPE … ADD VALUE` cannot run inside a transaction
-- block on older PG, and migrate-ci runs each *.sql file as ONE implicit
-- transaction — so EACH enum add gets its own standalone file (the sibling
-- 'reconcile' value lives in 0020b). Idempotent via IF NOT EXISTS. NEVER a DROP.
--
-- The value is only ever written by the (dark, MARKET_PAYOUT_EXECUTE-gated)
-- payout executor's atomic claim: UPDATE market_settlements SET
-- payout_status='sending', payout_claim_id, payout_claimed_at WHERE id=$1
-- AND payout_status='pending_review' AND deed_transferred_at IS NOT NULL.

ALTER TYPE market_payout_status ADD VALUE IF NOT EXISTS 'sending';
