-- Land gamification P6: the tutorial claim's authority moves from the USER to the
-- AVATAR, and the claim row gains a second reward rail. Idempotent DDL;
-- migrate-ci applies the file atomically.
--
-- WHY: the 26-quest / 1,585 vCLAW tutorial corpus was human-only — claim and
-- read were cookie-gated and the row was keyed on `user_id`. A connected or
-- user-hosted agent could not claim a single one, which is a Rule E5 parity
-- defect on a LIVE money surface. Every admitted claimer now resolves through
-- `requireAuthOrAgentSession` to a bound avatar, so the AVATAR is the natural
-- idempotency subject.
--
-- COLLISION-FREEDOM: `avatars.user_id` is UNIQUE, so every claim row belonging
-- to user U carries the same `avatar_id`. The existing
-- UNIQUE (user_id, quest_id) therefore ALREADY implies
-- UNIQUE (avatar_id, quest_id) — swapping the index can create no conflict on
-- existing data. The preflight below proves that on the live table rather than
-- trusting the argument, and refuses the whole migration if it does not hold.
--
-- `user_id` becomes nullable so the avatar is the authority, NOT so unbound
-- actors can claim: every admitted claimer still resolves to a real user.

DO $$
DECLARE
  dup_pairs   integer;
  unrailed    integer;
BEGIN
  SELECT count(*) INTO dup_pairs FROM (
    SELECT avatar_id, quest_id
    FROM tutorial_quest_claims
    GROUP BY avatar_id, quest_id
    HAVING count(*) > 1
  ) d;
  IF dup_pairs > 0 THEN
    RAISE EXCEPTION
      'tutorial claim avatar authority refused: % duplicate (avatar_id, quest_id) pair(s) — the new unique index would be unsatisfiable',
      dup_pairs;
  END IF;

  -- Every pre-existing row must land on exactly one rail once
  -- `materials_credited` defaults to 0, or the single-rail CHECK below would be
  -- violated by data this migration did not create. Refuse loudly instead.
  SELECT count(*) INTO unrailed
  FROM tutorial_quest_claims
  WHERE tokens_credited <= 0;
  IF unrailed > 0 THEN
    RAISE EXCEPTION
      'tutorial claim avatar authority refused: % existing claim row(s) credited 0 vCLAW and would violate the single-rail CHECK',
      unrailed;
  END IF;
END $$;

ALTER TABLE "tutorial_quest_claims"
  ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "tutorial_quest_claims"
  ADD COLUMN IF NOT EXISTS "materials_credited" integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_tutorial_quest_claim_avatar_quest"
  ON "tutorial_quest_claims" ("avatar_id", "quest_id");

-- Dropped only AFTER the replacement exists, so the table is never briefly
-- unprotected against a concurrent double-claim.
DROP INDEX IF EXISTS "uniq_tutorial_quest_claim_user_quest";

ALTER TABLE "tutorial_quest_claims"
  DROP CONSTRAINT IF EXISTS "tutorial_claim_reward_nonneg";
ALTER TABLE "tutorial_quest_claims"
  ADD CONSTRAINT "tutorial_claim_reward_nonneg"
  CHECK ("tokens_credited" >= 0 AND "materials_credited" >= 0);

-- Exactly one rail per claim. A quest pays vCLAW or materials, never both and
-- never neither, so a settlement bug cannot silently write a rewardless row.
ALTER TABLE "tutorial_quest_claims"
  DROP CONSTRAINT IF EXISTS "tutorial_claim_single_rail";
ALTER TABLE "tutorial_quest_claims"
  ADD CONSTRAINT "tutorial_claim_single_rail"
  CHECK (("tokens_credited" > 0) <> ("materials_credited" > 0));
