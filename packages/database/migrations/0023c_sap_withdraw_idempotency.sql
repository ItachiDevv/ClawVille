-- 0023c_sap_withdraw_idempotency.sql
-- R4-B: withdraw idempotency (Codex #3) — mirror sap_deposit_requests on the V2
-- withdraw path so a double-click can't submit two real withdraws of the
-- depositor's own funds. ADDITIVE + IDEMPOTENT ONLY (ADD COLUMN IF NOT EXISTS,
-- DROP CONSTRAINT IF EXISTS + re-ADD same name, CREATE UNIQUE INDEX IF NOT EXISTS).
-- Single-transaction-safe for migrate-ci (no enum ALTER). A re-run is a no-op.
--
-- The funds ledger already subtracts ALL sap_escrow_withdrawals rows, so a
-- claim-first 'in_flight' row PESSIMISTICALLY holds the amount until the send
-- resolves — intentional (a concurrent settle sees the reduced remaining).
-- Names reproduce the Drizzle schema names in packages/database/src/schema/sap-escrow.ts.

ALTER TABLE "sap_escrow_withdrawals" ADD COLUMN IF NOT EXISTS "request_id" varchar(128);
ALTER TABLE "sap_escrow_withdrawals" ADD COLUMN IF NOT EXISTS "outcome_accounts" jsonb;
ALTER TABLE "sap_escrow_withdrawals" ADD COLUMN IF NOT EXISTS "failure_code" varchar(64);
ALTER TABLE "sap_escrow_withdrawals"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone NOT NULL DEFAULT now();

-- Widen the status CHECK to include 'in_flight' (claim-first). Drop-then-add keeps
-- the constraint name stable and is idempotent.
ALTER TABLE "sap_escrow_withdrawals" DROP CONSTRAINT IF EXISTS "sap_escrow_withdrawals_status_valid";
ALTER TABLE "sap_escrow_withdrawals" ADD CONSTRAINT "sap_escrow_withdrawals_status_valid"
  CHECK ("status" IN ('in_flight', 'succeeded', 'broadcast_unknown'));

-- THE idempotency claim lock — one logical withdraw per (subject, requestId).
-- Partial: pre-R4-B rows (and any un-idempotent path) carry NULL request_id.
CREATE UNIQUE INDEX IF NOT EXISTS "sap_escrow_withdrawals_subject_request_unique"
  ON "sap_escrow_withdrawals" ("subject_avatar_id", "request_id") WHERE request_id IS NOT NULL;
