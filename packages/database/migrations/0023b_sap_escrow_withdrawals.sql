-- 0023b_sap_escrow_withdrawals.sql
-- SAP V2 withdraw gate-ledger leg (flip-gate fix, docs/sap-integration.md line 623).
--
-- POST /api/sap/escrow/v2/withdraw moves USDC vault->depositor ON-CHAIN but
-- historically booked NOTHING into the gate's settlements ledger, so
-- `escrowFundsLedger.remaining` OVERSTATED the vault after an out-of-band
-- withdraw. This ESCROW-SCOPED (not job-scoped) table records each successful /
-- broadcast-unknown withdraw so the funds ledger subtracts it.
--
-- Separate table on purpose: it never collides with a caller-supplied job_id,
-- never overloads the sap_escrow_settlement_status enum, and leaves the
-- settle_unknown quarantine + every V1 path untouched (a V1 escrow has no rows
-- here). Paired with the live-vault clamp inside the settle claim (same doc
-- line 623), the ledger stays truthful even when the clamp RPC read falls back.
--
-- What the ledger subtracts: `succeeded` (definitely left) + `broadcast_unknown`
-- (MAY have left — subtracted PESSIMISTICALLY, fail-closed). A pre-broadcast
-- failure books nothing. LIVE only (dry-run moves nothing, writes no row).
--
-- IDEMPOTENT + ADDITIVE ONLY: brand-new table, CHECK constraint, no enum ALTER —
-- single-transaction-safe for migrate-ci. A re-run is a no-op. NEVER a DROP.
-- Names reproduce the Drizzle schema names in
-- packages/database/src/schema/sap-escrow.ts.

CREATE TABLE IF NOT EXISTS "sap_escrow_withdrawals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "escrow_pda" varchar(64) NOT NULL,
  "subject_avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "escrow_nonce" varchar(32),
  "amount" varchar(32) NOT NULL,
  "status" varchar(24) NOT NULL,
  "signature" varchar(128),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "sap_escrow_withdrawals_status_valid"
    CHECK ("status" IN ('succeeded', 'broadcast_unknown'))
);

-- "all withdrawals for this escrow" — the funds-ledger subtraction scan.
CREATE INDEX IF NOT EXISTS "sap_escrow_withdrawals_escrow_idx"
  ON "sap_escrow_withdrawals" ("escrow_pda", "created_at");
