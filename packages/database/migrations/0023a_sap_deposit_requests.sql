-- 0023a_sap_deposit_requests.sql
-- SAP V2 deposit idempotency (flip-gate fix R3, docs/sap-integration.md line 591).
--
-- `deposit_escrow_v2` is ADDITIVE — a duplicate client POST (double-click / 5xx
-- retry) would top up the depositor's OWN escrow twice. This durable table is the
-- route-level idempotency guard on POST /api/sap/escrow/v2/deposit.
--
-- KEY SHAPE (deliberate deviation from the doc's `(subject, escrowNonce,
-- requestId)`): a nonce alone does NOT identify an escrow (the V2 PDA is
-- agentPda+depositor+nonce, so one nonce can address two workers). We key on
-- UNIQUE (subject_avatar_id, request_id) and store (escrow_pda, amount) as the
-- request FINGERPRINT — a same-key/same-fingerprint replay returns the recorded
-- outcome, a same-key/different-fingerprint is key reuse (409).
--
-- LIVE-ONLY: dry-run skips this table entirely (it sends nothing on-chain, so a
-- dry-run claim must never block a later real request).
--
-- IDEMPOTENT + ADDITIVE ONLY: a brand-new table (CREATE TABLE IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS) with a CHECK constraint — NO enum ALTER, so this
-- file is single-transaction-safe for migrate-ci. A re-run is a total no-op.
-- NEVER a DROP. Names reproduce the Drizzle schema names in
-- packages/database/src/schema/sap-escrow.ts.

CREATE TABLE IF NOT EXISTS "sap_deposit_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "request_id" varchar(128) NOT NULL,
  "escrow_pda" varchar(64) NOT NULL,
  "amount" varchar(32) NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'in_flight',
  "signature" varchar(128),
  "outcome_accounts" jsonb,
  "failure_code" varchar(64),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "sap_deposit_requests_status_valid"
    CHECK ("status" IN ('in_flight', 'succeeded', 'broadcast_unknown'))
);

-- THE idempotency key — one logical deposit per (subject, requestId).
CREATE UNIQUE INDEX IF NOT EXISTS "sap_deposit_requests_subject_request_unique"
  ON "sap_deposit_requests" ("subject_avatar_id", "request_id");

-- Per-escrow audit / reconciliation scan.
CREATE INDEX IF NOT EXISTS "sap_deposit_requests_escrow_idx"
  ON "sap_deposit_requests" ("escrow_pda", "created_at");
