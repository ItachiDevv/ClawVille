-- 2026-07-15 — CI-discovered copy of the deploy-required guest event stamp.
--
-- PRE-DEPLOY SCHEMA COMPATIBILITY: this migration must complete before deploying
-- event-logger/leaderboard code that writes or reads events.subject_was_guest.
-- The original manual migration remains in migrations-manual/ as immutable
-- operational history. Every statement here is safe when that migration was
-- already applied: the DDL is IF NOT EXISTS and the backfill touches NULLs only.

-- Adding a nullable column with no default is metadata-only once this brief lock
-- is acquired. Fail quickly instead of queueing application writes behind it.
SET lock_timeout = '3s';

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS subject_was_guest boolean;

RESET lock_timeout;

-- Freeze all reconstructable historical guest subjects. Resolve every supported
-- subject identity because user_id/avatar_id may later be deleted and a bot may
-- later be rebound; future writes stamp the event-time value in event-logger.
UPDATE events e
SET subject_was_guest = true
WHERE e.subject_was_guest IS NULL
  AND (
    EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = e.user_id
        AND u.is_guest
    )
    OR EXISTS (
      SELECT 1
      FROM avatars a
      JOIN users au ON au.id = a.user_id
      WHERE a.id = e.avatar_id
        AND au.is_guest
    )
    OR EXISTS (
      SELECT 1
      FROM openclaw_bots ob
      JOIN users gu ON gu.id = ob.user_id
      WHERE ob.agent_id = e.agent_id
        AND gu.is_guest
    )
  );
