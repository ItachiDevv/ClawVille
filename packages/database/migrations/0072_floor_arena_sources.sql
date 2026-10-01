-- 0072_floor_arena_sources.sql: Trading Floor Arena D25 (tradeable first sight) + house template reset.
-- Contract: docs/trading-floor-arena.md. Drizzle mirror: packages/database/src/schema/floor-arena.ts.
-- 0070 is already applied on staging (migrate-ci checksum), so it stays frozen and this file builds on it.
-- Numbered 0072 because 0071 belongs to chore/self-hosted-db (0071_special_event_start_guard.sql).
-- Additive and idempotent: in CI the Drizzle bootstrap already has both columns, so the ALTERs no-op there.

-- D25: when each discovery source first saw the mint, as {"<source id>": "<ISO time>"}. The engine starts a
-- first-sight clock at the first TRADEABLE sighting when entry.first_sight_sources = 'tradeable'.
ALTER TABLE "floor_discovery_mints" ADD COLUMN IF NOT EXISTS "source_first_seen" jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Rows that exist already know one sighting for sure: first_source at first_seen_at (UTC ISO, as the engine writes).
-- Only empty maps are filled, so a re-run, or a row the engine has already written, is left alone.
UPDATE "floor_discovery_mints"
SET "source_first_seen" = jsonb_build_object(
  "first_source", to_char("first_seen_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
WHERE "source_first_seen" = '{}'::jsonb;

-- The engine resets a HOUSE agent's params to its template when this is below FLOOR_ARENA_TEMPLATE_VERSION.
ALTER TABLE "floor_arena_agents" ADD COLUMN IF NOT EXISTS "template_version" integer NOT NULL DEFAULT 1;

-- entry.first_sight_sources is a REQUIRED param from FLOOR_ARENA_VERSION 2. Params stored before it get 'any',
-- the old behaviour (the clock started at the hub's first_seen_at). A re-run matches no rows.
UPDATE "floor_arena_agents"
SET "params" = jsonb_set("params", '{entry,first_sight_sources}', '"any"'::jsonb, true)
WHERE jsonb_typeof("params"->'entry') = 'object'
  AND NOT (("params"->'entry') ? 'first_sight_sources');
