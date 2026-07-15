-- 2026-07-15 - historical guest-event stamp backfill.
--
-- Kept separate from 0033 so its transaction never retains the ALTER TABLE
-- ACCESS EXCLUSIVE lock. Existing event reads/writes continue while this UPDATE
-- runs; a bounded statement timeout fails the migration instead of allowing an
-- unexpectedly large historical scan to run indefinitely.
--
-- PRE-PROMOTION PREFLIGHT:
--   SELECT count(*) AS event_rows FROM events;
--   SELECT count(*) FROM events WHERE subject_was_guest IS NULL;
--   Inspect pg_stat_activity for long-running transactions before applying.

SET statement_timeout = '5min';

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

RESET statement_timeout;
