-- ============================================================================
-- 0004_spawn_preference.sql — per-avatar town/home spawn preference
-- ============================================================================
--
-- Town fast-travel (2026-06-19). Adds two columns to the pre-existing "avatars"
-- base table so a player (or a connected/hosted agent's bound avatar) can choose
-- to re-spawn at their owned HOME parcel instead of the town square:
--
--   * spawn_preference text NOT NULL DEFAULT 'town'  (domain {'town','home'})
--   * home_parcel_id   uuid  NULL    FK → land_parcels(id) ON DELETE SET NULL
--
-- Mirrors packages/database/src/schema/avatars.ts (spawnPreference / homeParcelId
-- + the avatars_spawn_preference_valid CHECK) and the shared Avatar type. The
-- FK + CHECK live HERE (not as a Drizzle `.references()`/inline check) because
-- land.ts already imports `avatars`, so a static reference the other way would
-- be a circular module import — see the column block-comment in avatars.ts.
--
-- PROPERTIES (CI deploy GATE — correctness is paramount, see migrate-ci.ts):
--   * IDEMPOTENT — ADD COLUMN IF NOT EXISTS; the FK and CHECK are each wrapped in
--     a DO $$ guard that no-ops when the constraint already exists (Postgres has
--     no ADD CONSTRAINT IF NOT EXISTS). Re-running this file is a no-op.
--   * SINGLE IMPLICIT TXN — postgres.js runs the whole file as one multi-
--     statement simple query (atomic). No ALTER TYPE ADD VALUE here, so the
--     in-txn restriction does not apply.
--   * NO DROP — never drops/renames anything. Touches ONLY the pre-existing
--     "avatars" base table and references the pre-existing "land_parcels"
--     (created by 0001_land_economy.sql, which sorts BEFORE this file). NEVER
--     references Eliza plugin-sql tables.
--   * FORWARD-ONLY — additive columns + constraints; no data backfill needed
--     (every existing row gets spawn_preference='town' via the column DEFAULT and
--     home_parcel_id NULL).
-- ============================================================================

-- 1. Additive columns (idempotent).
ALTER TABLE "avatars"
  ADD COLUMN IF NOT EXISTS "spawn_preference" text NOT NULL DEFAULT 'town';

ALTER TABLE "avatars"
  ADD COLUMN IF NOT EXISTS "home_parcel_id" uuid;

-- 2. CHECK constraint on the spawn_preference domain (idempotent — guarded).
--    Defense-in-depth against direct-SQL writers that bypass the API Zod enum.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'avatars_spawn_preference_valid'
  ) THEN
    ALTER TABLE "avatars"
      ADD CONSTRAINT "avatars_spawn_preference_valid"
      CHECK ("spawn_preference" IN ('town', 'home'));
  END IF;
END $$;

-- 3. FK home_parcel_id → land_parcels(id) ON DELETE SET NULL (idempotent — guarded).
--    ON DELETE SET NULL: retiring/deleting a parcel must NOT delete the avatar; it
--    silently reverts the avatar to no home (the read/spawn path treats a null
--    home_parcel_id as 'town'). land_parcels is created by 0001 (lexicographically
--    earlier), so it exists when this runs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'avatars_home_parcel_id_fkey'
  ) THEN
    ALTER TABLE "avatars"
      ADD CONSTRAINT "avatars_home_parcel_id_fkey"
      FOREIGN KEY ("home_parcel_id")
      REFERENCES "land_parcels" ("id")
      ON DELETE SET NULL;
  END IF;
END $$;
