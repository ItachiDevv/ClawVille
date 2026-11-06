-- 0093_spend_policy_require_approval.sql
-- MCP hub step 2, spend rules follow-up (founder go 2026-11-06): "Ask me
-- before each payment".
--
-- user_spend_policies.require_approval: when true, every Studios image request
-- whose actor is the agent (MCP tool, REST with the agent session, hosted
-- [ACTION:] verb), in both modes, waits for the human. Written only by
-- services/spend-policy.ts applySpendPolicyChange from a human session.
-- Turning it on tightens (no signature); turning it off needs the linked-wallet
-- signature, like a cap raise.
--
-- vendor_call_requests gains what a waiting request needs: the prompt and model
-- to run at approve, expires_at (created_at + 15 minutes), who decided and
-- when, and our own failure code for the status read. Status set:
--   awaiting_approval  waits for the human; nothing is called, signed or paid
--   pending            running (also: approved, now running)
--   done | failed      finished
--   declined           the human declined; nothing was called or paid
--   expired            nobody answered in 15 minutes; nothing was called or paid
-- The status CHECK is dropped and re-added with the wider set (old code writes
-- only pending/done/failed, so it stays valid before and after the flip).
--
-- Additive and idempotent; safe for the CI migration runner to re-check.

ALTER TABLE "user_spend_policies" ADD COLUMN IF NOT EXISTS "require_approval" boolean DEFAULT false NOT NULL;

ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "prompt" text;
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "model" varchar(64);
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone;
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "decided_by_user_id" uuid;
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "failure_code" varchar(48);
-- Account mode: SHA-256 (hex) of the saved Studios key when the request was
-- queued (never the key). A key replaced before approve refuses the approve.
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "credential_sha256" varchar(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendor_call_requests_decided_by_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "vendor_call_requests" ADD CONSTRAINT "vendor_call_requests_decided_by_user_id_users_id_fk"
      FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE set null;
  END IF;
END $$;

-- 'awaiting_approval' is 17 characters: widen status from varchar(16) to
-- varchar(24). Widening a varchar is a catalog-only change (no table rewrite)
-- and a no-op when the column is already 24.
ALTER TABLE "vendor_call_requests" ALTER COLUMN "status" TYPE varchar(24);

ALTER TABLE "vendor_call_requests" DROP CONSTRAINT IF EXISTS "vendor_call_requests_status_check";
ALTER TABLE "vendor_call_requests" ADD CONSTRAINT "vendor_call_requests_status_check"
  CHECK ("status" IN ('awaiting_approval', 'pending', 'done', 'failed', 'declined', 'expired'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendor_call_requests_awaiting_fields_check'
  ) THEN
    ALTER TABLE "vendor_call_requests" ADD CONSTRAINT "vendor_call_requests_awaiting_fields_check"
      CHECK ("status" <> 'awaiting_approval' OR ("prompt" IS NOT NULL AND "expires_at" IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "vendor_call_requests_awaiting_idx"
  ON "vendor_call_requests" ("avatar_id", "expires_at") WHERE "status" = 'awaiting_approval';
