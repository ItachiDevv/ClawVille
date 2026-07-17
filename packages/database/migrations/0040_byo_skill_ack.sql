-- BYO skill-ingestion acknowledgement posture (informational only).
-- Existing rows start with no acknowledgements; all writes merge into this
-- object and never affect session, economy, or leaderboard authorization.
ALTER TABLE "openclaw_bots"
  ADD COLUMN IF NOT EXISTS "ack" jsonb NOT NULL DEFAULT '{}'::jsonb;
