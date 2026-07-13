-- 0027 — One reward per (quest, avatar) (Codex adversarial round 3, 2026-07-13).
--
-- 0026's guards blocked concurrent duplicate ACTIVE submissions and duplicate
-- rewards per submission, but after an approval the same avatar could ACCEPT
-- the quest again (new submission id) and be paid again, consuming global
-- completion slots. The quest-board invariant is one payout per avatar per
-- quest (retry allowed only after rejection); this index is the DB layer of
-- that invariant behind the route/action accept checks.
--
-- Separate file from 0026 because 0026 is already checksum-recorded in
-- `_clawville_migrations` on staging — tracked migrations are immutable.

SET lock_timeout = '5s';

DO $$
DECLARE dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT quest_id, avatar_id
    FROM quest_rewards
    GROUP BY quest_id, avatar_id
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'quest_rewards has % duplicate (quest_id, avatar_id) pairs — resolve before creating quest_rewards_avatar_quest_unique', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS quest_rewards_avatar_quest_unique
  ON quest_rewards (quest_id, avatar_id);
