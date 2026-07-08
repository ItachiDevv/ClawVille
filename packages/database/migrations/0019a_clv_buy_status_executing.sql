-- 0019a_clv_buy_status_executing.sql
-- Tokenomics GoLive executors (2026-07-07) — the 'executing' claim state for
-- clv_buy_queue (companion to 0019_clv_swap_executor.sql).
--
-- ALONE IN ITS OWN FILE, ONE STATEMENT, per the migrate-ci FUTURE-AUTHOR rule:
-- `ALTER TYPE … ADD VALUE` cannot run inside a transaction block on older PG
-- (and the value cannot be USED in the txn that added it), and migrate-ci runs
-- each *.sql file as ONE implicit transaction — so the enum add gets its own
-- standalone file. Idempotent via IF NOT EXISTS. NEVER a DROP.
--
-- The value is only ever written by the (dark, Codex-gated) live executor's
-- atomic claim: UPDATE clv_buy_queue SET status='executing', claim_id, …
-- WHERE id=$1 AND status='planned'.

ALTER TYPE clv_buy_status ADD VALUE IF NOT EXISTS 'executing';
