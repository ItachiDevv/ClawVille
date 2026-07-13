-- Quest agent parity hardening (Codex adversarial review 2026-07-13, HIGH #2):
-- ONE active (non-terminal) submission per (quest, avatar). Concurrent accepts
-- previously raced past the handler's existence check and created parallel
-- payable rows; this index makes the race lose with a 23505 the handler maps
-- back to the normal "already have an active submission" 400.
--
-- Apply with an EXPLICIT :5432 DATABASE_URL (staging first, prod BEFORE the
-- staging→master merge). NEVER db:push. Idempotent; duplicate-safe: the
-- pre-check DO block raises with the offending rows if duplicates exist so the
-- index create never half-fails silently.

SET lock_timeout = '5s';

DO $$
DECLARE dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT quest_id, avatar_id
    FROM quest_submissions
    WHERE status NOT IN ('approved', 'rejected')
    GROUP BY quest_id, avatar_id
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'quest_submissions has % duplicate active (quest_id, avatar_id) pairs — resolve before creating quest_submissions_active_unique', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS quest_submissions_active_unique
  ON quest_submissions (quest_id, avatar_id)
  WHERE status NOT IN ('approved', 'rejected');
