-- 0026 — Quest agent-parity race guards (Codex adversarial rounds 1+2, 2026-07-13).
--
-- Guard 1: ONE active (non-terminal) submission per (quest, avatar). Concurrent
-- accepts previously raced past the handler's read-then-insert existence check
-- and created parallel payable rows; the handler maps this index's 23505 back to
-- the normal "already have an active submission" 400.
--
-- Guard 2: at most ONE reward row per submission (defense-in-depth behind the
-- compare-and-set status transitions — a reopened-and-re-approved submission
-- must never credit twice).
--
-- Idempotent (IF NOT EXISTS); duplicate-precheck raises loudly instead of a
-- half-failed index build. Applied to STAGING out-of-band 2026-07-13 (guard 1);
-- this file is the CI-tracked source of truth for prod + fresh environments.

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

  SELECT count(*) INTO dup_count FROM (
    SELECT submission_id
    FROM quest_rewards
    GROUP BY submission_id
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'quest_rewards has % duplicate submission_id rows — resolve before creating quest_rewards_submission_unique', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS quest_submissions_active_unique
  ON quest_submissions (quest_id, avatar_id)
  WHERE status NOT IN ('approved', 'rejected');

CREATE UNIQUE INDEX IF NOT EXISTS quest_rewards_submission_unique
  ON quest_rewards (submission_id);
