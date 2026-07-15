-- 0032_supply_mint_idempotency.sql
-- Economy-integrity audit fixes (2026-07-15):
--   1. one durable building-chat reward per (avatar, building, UTC day), shared
--      by human, connected-agent, and autonomous-agent chat surfaces;
--   2. one activity result/reward claim per (room, avatar).
--
-- Additive + idempotent only. NEVER apply via drizzle-kit push.

CREATE TABLE IF NOT EXISTS "building_chat_reward_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "building_id" text NOT NULL,
  "reward_day" date NOT NULL,
  "ledger_id" uuid,
  "claimed_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS
  "building_chat_reward_claims_avatar_building_day_unique"
  ON "building_chat_reward_claims" ("avatar_id", "building_id", "reward_day");

-- Rolling-deploy compatibility guard. CI applies this migration before the new
-- application is deployed, so an old pod may still write an unconditional chat
-- reward after the historical backfill snapshot. Install the trigger BEFORE the
-- backfill: CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock, waiting for older
-- in-flight inserts to commit; subsequent old-code inserts populate the claim in
-- their own transaction. New code claims first, so its ledger insert reaches the
-- same ON CONFLICT no-op. Keep this guard until every environment has completed
-- the code cutover; a later additive migration may remove it after verification.
CREATE OR REPLACE FUNCTION "capture_building_chat_reward_claim"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim_building_id text;
  inserted_claim_id uuid;
  existing_claim_id uuid;
  existing_ledger_id uuid;
BEGIN
  IF NEW."reason" NOT IN ('location_chat', 'building_chat_teaching')
     OR NEW."amount" <= 0 THEN
    RETURN NEW;
  END IF;

  claim_building_id := COALESCE(
    NEW."metadata"->>'buildingId',
    NEW."metadata"->>'locationId'
  );
  IF claim_building_id IS NULL OR claim_building_id = '' THEN
    RETURN NEW;
  END IF;

  INSERT INTO "building_chat_reward_claims" (
    "avatar_id",
    "building_id",
    "reward_day",
    "ledger_id",
    "claimed_at"
  ) VALUES (
    NEW."avatar_id",
    claim_building_id,
    (NEW."created_at" AT TIME ZONE 'UTC')::date,
    NEW."id",
    NEW."created_at"
  )
  ON CONFLICT ("avatar_id", "building_id", "reward_day") DO NOTHING
  RETURNING "id" INTO inserted_claim_id;

  -- No prior claim: this is one legacy reward arriving during the migration-to-
  -- deploy window. Capturing NEW.id makes it the one accepted representative.
  IF inserted_claim_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- A conflicting uncommitted claim makes the INSERT above wait. Once it
  -- resolves, lock and inspect the winner. New application code deliberately
  -- inserts a NULL-ledger pre-claim before creditClawTokens; its own ledger insert
  -- is allowed and binds that claim here. Any non-NULL DIFFERENT ledger id means
  -- this is an old-pod duplicate: raise inside the AFTER trigger so PostgreSQL
  -- rolls back the ledger insert AND the preceding avatar balance update.
  SELECT "id", "ledger_id"
    INTO existing_claim_id, existing_ledger_id
  FROM "building_chat_reward_claims"
  WHERE "avatar_id" = NEW."avatar_id"
    AND "building_id" = claim_building_id
    AND "reward_day" = (NEW."created_at" AT TIME ZONE 'UTC')::date
  FOR UPDATE;

  IF existing_ledger_id IS NULL THEN
    UPDATE "building_chat_reward_claims"
    SET "ledger_id" = NEW."id"
    WHERE "id" = existing_claim_id
      AND "ledger_id" IS NULL;
    RETURN NEW;
  END IF;

  IF existing_ledger_id = NEW."id" THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23505',
    MESSAGE = 'duplicate building-chat reward rejected during rolling deploy',
    DETAIL = format(
      'avatar_id=%s building_id=%s reward_day=%s existing_ledger_id=%s attempted_ledger_id=%s',
      NEW."avatar_id",
      claim_building_id,
      (NEW."created_at" AT TIME ZONE 'UTC')::date,
      existing_ledger_id,
      NEW."id"
    );

END;
$$;

-- During migration-first rollout, an old pod can catch the duplicate-ledger
-- refusal installed below and still invoke its pre-fix awardXp path, producing XP and a
-- level-up mint without winning the daily chat claim. New xp-service marks its
-- atomic XP transaction explicitly; the trigger refuses XP metadata changes
-- from old deployed code before they can reach a level-up ledger credit.
CREATE OR REPLACE FUNCTION "guard_atomic_xp_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW."xp", NEW."level", NEW."total_xp")
       IS DISTINCT FROM (OLD."xp", OLD."level", OLD."total_xp")
     AND current_setting('clawville.xp_write_authorized', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'XP update rejected: atomic xp-service marker missing';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'guard_atomic_xp_update_before_update'
      AND tgrelid = 'avatars'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "guard_atomic_xp_update_before_update"
    BEFORE UPDATE OF "xp", "level", "total_xp" ON "avatars"
    FOR EACH ROW
    EXECUTE FUNCTION "guard_atomic_xp_update"();
  END IF;
END;
$$;

-- Install the ledger guard only AFTER the XP guard. Both become visible together
-- when this quick DDL migration commits; the backfill runs in 0032a after that
-- commit, so no old writer can slip between a snapshot and guard visibility.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'capture_building_chat_reward_claim_after_insert'
      AND tgrelid = 'claw_token_transactions'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "capture_building_chat_reward_claim_after_insert"
    AFTER INSERT ON "claw_token_transactions"
    FOR EACH ROW
    EXECUTE FUNCTION "capture_building_chat_reward_claim"();
  END IF;
END;
$$;
