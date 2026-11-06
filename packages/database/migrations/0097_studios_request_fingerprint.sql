-- 0097_studios_request_fingerprint.sql
-- MCP hub phase 3c (2026-11-06): server-side dedupe of Studios requests.
--
-- vendor_call_requests.input_fingerprint: SHA-256 (hex) over the avatar, the
-- operation and the canonical vendor body after defaults (an omitted default
-- and the explicit default give the same body; prompt whitespace collapsed).
-- The pay mode is NOT part of it: an unclear wallet request also blocks the
-- same input in key or sign-in mode. A NEW Idempotency-Key with the same
-- fingerprint as a request that still waits or runs (awaiting_approval,
-- pending, running; any age), or that may have charged and ENDED in the last
-- 30 minutes (ambiguous, or failed with a may-have-charged code), inserts
-- nothing and answers 409 duplicate_request_in_flight with that request's id
-- and status. Two tabs, or a client that lost the reply and its key, can no
-- longer pay twice.
--
-- vendor_call_requests.finished_at: when the row became terminal (done,
-- failed, ambiguous, declined, expired). The trigger below sets it for every
-- writer, so the 30-minute window starts at the uncertain outcome, not at
-- creation (a recast that times out after 30 minutes still blocks for 30 more).
--
-- Additive and idempotent (the CI runner may apply it twice). Old rows keep a
-- NULL fingerprint and never match (known limit for the first 30 minutes after
-- the deploy). Old code does not write either column; the trigger fills
-- finished_at for old code too.

ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "input_fingerprint" varchar(64);
ALTER TABLE "vendor_call_requests" ADD COLUMN IF NOT EXISTS "finished_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "vendor_call_requests_avatar_fingerprint_idx"
  ON "vendor_call_requests" ("avatar_id", "input_fingerprint");

CREATE OR REPLACE FUNCTION "vendor_call_requests_set_finished_at"() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('done', 'failed', 'ambiguous', 'declined', 'expired') THEN
    -- Entering a terminal status stamps the time; an update that keeps the
    -- same status keeps the stored time.
    IF TG_OP = 'INSERT' THEN
      NEW.finished_at := coalesce(NEW.finished_at, now());
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
      NEW.finished_at := now();
    END IF;
  ELSE
    NEW.finished_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "vendor_call_requests_finished_at" ON "vendor_call_requests";
CREATE TRIGGER "vendor_call_requests_finished_at"
  BEFORE INSERT OR UPDATE ON "vendor_call_requests"
  FOR EACH ROW EXECUTE FUNCTION "vendor_call_requests_set_finished_at"();
