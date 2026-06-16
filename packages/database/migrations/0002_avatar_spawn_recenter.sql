-- ============================================================================
-- 0002_avatar_spawn_recenter.sql — realign avatar spawn after Land Phase 0
-- ============================================================================
--
-- Land Phase 0 re-centered the world from a 5120-px map (center 2560) to an
-- 18432-px map (center 9216). The CLIENT spawn was migrated in lockstep
-- (apps/web tilemap-data.ts MAP_WIDTH=18432; stores/game.ts SPAWN_PX
-- = {9216, 9756}), but the avatars table still defaulted position_x/y to 2560
-- and held stale per-row positions on the OLD grid. On the new world, 2560,2560
-- is a corner-ward diagonal spot, so a logged-in player restored a wrong
-- position. This forward-only migration realigns the DB with the client.
--
-- PROPERTIES (CI deploy GATE — correctness is paramount, see migrate-ci.ts):
--   * IDEMPOTENT — ALTER ... SET DEFAULT is idempotent (re-applying sets the
--     same value). The data UPDATE is gated by the _clawville_migrations
--     tracking table so it runs EXACTLY ONCE per database; re-running this file
--     after it is recorded is a no-op (skipped by checksum match).
--   * SINGLE IMPLICIT TXN — postgres.js runs the whole file as one multi-
--     statement simple query, wrapped in one implicit transaction (atomic).
--     No ALTER TYPE ADD VALUE here, so the txn restriction does not apply.
--   * NO DROP — never drops/renames anything. Touches ONLY the pre-existing
--     "avatars" base table. NEVER references Eliza plugin-sql tables.
--   * MIRRORS @clawville/shared SPAWN_PX (9216, 9756) and the schema defaults in
--     packages/database/src/schema/avatars.ts — keep all three in sync.
--
-- Values: position_x = 9216 (= WORLD_PX_WIDTH / 2),
--         position_y = 9756 (= WORLD_PX_HEIGHT / 2 + 540, south of Nori).
-- ============================================================================

-- New rows spawn at the re-centered town center.
ALTER TABLE "avatars" ALTER COLUMN "position_x" SET DEFAULT 9216;
ALTER TABLE "avatars" ALTER COLUMN "position_y" SET DEFAULT 9756;

-- The re-center invalidates EVERY saved position: a coordinate on the old
-- 5120-px grid is meaningless on the new 18432-px grid (e.g. the old default
-- 2560,2560 is now a corner-ward diagonal, not town center). There is no safe
-- per-row remap (the old grid was a different size, not a sub-region of the new
-- one), so the correct behavior is to reset ALL avatars to the new spawn. This
-- runs once (tracking-table gated) and is the same outcome a fresh login would
-- produce now that the client guard clamps any out-of-bounds restore to spawn.
UPDATE "avatars"
SET "position_x" = 9216,
    "position_y" = 9756,
    "updated_at" = now();
