-- 0043_sap_reputation_jobs.sql
-- Durable, at-most-once admission for house-signed SAP reputation writes.
-- ADDITIVE + IDEMPOTENT: no escrow, settlement, or money-ledger table changes.

CREATE TABLE IF NOT EXISTS "sap_reputation_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bounty_id" uuid NOT NULL REFERENCES "bounties"("id") ON DELETE CASCADE,
  "hunter_avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'waiting_identity',
  "attestation_tx_sig" text,
  "feedback_tx_sig" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "sap_reputation_jobs_status_valid"
    CHECK ("status" IN ('waiting_identity', 'writing', 'written', 'skipped', 'failed')),
  CONSTRAINT "sap_reputation_jobs_attempts_nonnegative" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "sap_reputation_jobs_bounty_id_unique"
  ON "sap_reputation_jobs" ("bounty_id");

CREATE INDEX IF NOT EXISTS "sap_reputation_jobs_hunter_status_updated_idx"
  ON "sap_reputation_jobs" ("hunter_avatar_id", "status", "updated_at");
