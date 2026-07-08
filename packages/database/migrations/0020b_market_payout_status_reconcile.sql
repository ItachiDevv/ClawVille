-- 0020b_market_payout_status_reconcile.sql
-- Tokenomics GoLive executors (2026-07-07) — the terminal 'reconcile' state for
-- market_settlements.payout_status (companion to 0020/0020a).
--
-- ALONE IN ITS OWN FILE, ONE STATEMENT, per the migrate-ci FUTURE-AUTHOR rule
-- (one ALTER TYPE … ADD VALUE per file — see 0019a/0020a). Idempotent via
-- IF NOT EXISTS. NEVER a DROP.
--
-- SEMANTICS: 'reconcile' is the TERMINAL, OPERATOR-RESOLUTION state of the
-- (dark) payout executor — NEVER auto-retried. `payout_failure_reason` says
-- whether money moved:
--   - *ambiguous* reasons (seller_send_ambiguous, rake_send_ambiguous, …):
--     a send was attempted and threw — money-state UNKNOWN; the captured
--     signature is the chain-poll anchor (x402 settle_ambiguous discipline).
--   - *definitive* reasons (seller_tx_failed_on_chain, conservation_violated,
--     payout_destination_mismatch, guest_seller_refused, …): the state is
--     KNOWN but requires a human decision; the captured-signature columns are
--     the audit trail. A retry can never fix these, so they are terminal too.

ALTER TYPE market_payout_status ADD VALUE IF NOT EXISTS 'reconcile';
