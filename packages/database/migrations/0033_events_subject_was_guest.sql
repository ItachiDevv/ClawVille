-- 2026-07-15 — CI-discovered copy of the deploy-required guest event stamp.
--
-- PRE-DEPLOY SCHEMA COMPATIBILITY: this migration must complete before deploying
-- event-logger/leaderboard code that writes or reads events.subject_was_guest.
-- The original manual migration remains in migrations-manual/ as immutable
-- operational history. This file is deliberately DDL-ONLY: migrate-ci wraps
-- each file in one transaction, so mixing the historical backfill into this
-- file would retain ALTER TABLE's ACCESS EXCLUSIVE lock for the full UPDATE.

-- Adding a nullable column with no default is metadata-only once this brief lock
-- is acquired. Fail quickly instead of queueing application writes behind it.
SET lock_timeout = '3s';

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS subject_was_guest boolean;

RESET lock_timeout;
