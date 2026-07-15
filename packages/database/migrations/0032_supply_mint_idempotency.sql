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

-- Preserve today's already-paid claims across the deploy boundary (and retain
-- older history for audit). Human rows used metadata.locationId; agent rows used
-- metadata.buildingId. The route/reason distinction intentionally collapses to
-- the shared economic key. Historical claims have no single authoritative
-- ledger_id when duplicates already exist, so that audit pointer remains NULL.
INSERT INTO "building_chat_reward_claims" (
  "avatar_id",
  "building_id",
  "reward_day",
  "claimed_at"
)
SELECT
  "avatar_id",
  COALESCE("metadata"->>'buildingId', "metadata"->>'locationId') AS "building_id",
  ("created_at" AT TIME ZONE 'UTC')::date AS "reward_day",
  MIN("created_at") AS "claimed_at"
FROM "claw_token_transactions"
WHERE "reason" IN ('location_chat', 'building_chat_teaching')
  AND "amount" > 0
  AND COALESCE("metadata"->>'buildingId', "metadata"->>'locationId') IS NOT NULL
  AND COALESCE("metadata"->>'buildingId', "metadata"->>'locationId') <> ''
GROUP BY
  "avatar_id",
  COALESCE("metadata"->>'buildingId', "metadata"->>'locationId'),
  ("created_at" AT TIME ZONE 'UTC')::date
ON CONFLICT ("avatar_id", "building_id", "reward_day") DO NOTHING;

-- Pre-existing duplicate pairs must be economically reconciled before this
-- index can be created; IF NOT EXISTS makes re-application idempotent but does
-- not hide dirty historical data.
CREATE UNIQUE INDEX IF NOT EXISTS "activity_results_room_avatar_unique"
  ON "activity_results" ("room_id", "avatar_id");
