-- 0097_studios_request_fingerprint.sql
-- MCP hub phase 3c (2026-11-06): server-side dedupe of Studios requests.
--
-- vendor_call_requests.input_fingerprint: SHA-256 (hex) over the avatar, the
-- operation, the pay mode (row mode) and the canonical params (sorted keys,
-- prompt whitespace normalized). A NEW Idempotency-Key with the same
-- fingerprint as a request that still waits or runs (awaiting_approval,
-- pending, running), or that may have charged in the last 30 minutes
-- (ambiguous, or failed with outcome_unknown), inserts nothing and answers
-- 409 duplicate_request_in_flight with that request's id and status. Two tabs,
-- or a client that lost the reply and its key, can no longer pay twice.
--
-- Additive and idempotent (the CI runner may apply it twice). Old rows keep
-- NULL and never match. Old code does not write the column.

ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "input_fingerprint" varchar(64);

CREATE INDEX IF NOT EXISTS "vendor_call_requests_avatar_fingerprint_idx"
  ON "vendor_call_requests" ("avatar_id", "input_fingerprint");
