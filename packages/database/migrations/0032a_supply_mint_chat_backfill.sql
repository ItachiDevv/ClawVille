-- 0032a_supply_mint_chat_backfill.sql
-- Runs only after 0032 committed both rolling-deploy guards. Human rows used
-- metadata.locationId; agent rows used metadata.buildingId. Pick the earliest
-- ledger row deterministically as the audit representative. If 0032 committed
-- but this file previously failed, re-application upgrades only a NULL claim.

INSERT INTO "building_chat_reward_claims" (
  "avatar_id",
  "building_id",
  "reward_day",
  "ledger_id",
  "claimed_at"
)
SELECT
  "avatar_id",
  "building_id",
  "reward_day",
  "ledger_id",
  "claimed_at"
FROM (
  SELECT DISTINCT ON ("avatar_id", "building_id", "reward_day")
    "avatar_id",
    "building_id",
    "reward_day",
    "ledger_id",
    "claimed_at"
  FROM (
    SELECT
      "avatar_id",
      COALESCE("metadata"->>'buildingId', "metadata"->>'locationId') AS "building_id",
      ("created_at" AT TIME ZONE 'UTC')::date AS "reward_day",
      "id" AS "ledger_id",
      "created_at" AS "claimed_at"
    FROM "claw_token_transactions"
    WHERE "reason" IN ('location_chat', 'building_chat_teaching')
      AND "amount" > 0
      AND COALESCE("metadata"->>'buildingId', "metadata"->>'locationId') IS NOT NULL
      AND COALESCE("metadata"->>'buildingId', "metadata"->>'locationId') <> ''
  ) AS "eligible_rewards"
  ORDER BY
    "avatar_id",
    "building_id",
    "reward_day",
    "claimed_at" ASC,
    "ledger_id" ASC
) AS "representative_rewards"
ON CONFLICT ("avatar_id", "building_id", "reward_day") DO UPDATE
SET
  "ledger_id" = EXCLUDED."ledger_id",
  "claimed_at" = LEAST(
    "building_chat_reward_claims"."claimed_at",
    EXCLUDED."claimed_at"
  )
WHERE "building_chat_reward_claims"."ledger_id" IS NULL;
