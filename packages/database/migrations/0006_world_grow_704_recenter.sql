-- ============================================================================
-- 0006_world_grow_704_recenter.sql - shift avatar spawn after the 576->704 grow
-- ============================================================================
--
-- Land-builder-economics (2026-06-24) grew the world from an 18432-px map
-- (576x576 tiles, center 9216) to a 22528-px map (704x704 tiles, center 11264)
-- to add the new OUTER c-tier parcel ring. This is a UNIFORM RECENTER: the world
-- stays centered, so the center moved by +2048 px (+64 tiles) on each axis and
-- EVERY game-pixel coordinate shifts by the SAME +2048, while every origin-
-- relative WORLD-space position stays INVARIANT.
--
-- The CLIENT + SERVER + schema were migrated in lockstep:
--   apps/web tilemap-data.ts         MAP_COLS/ROWS 576->704 (MAP_WIDTH 22528)
--   packages/shared world-dimensions WORLD_PX_* 22528, SPAWN_PX {11264, 11804}
--   packages/database avatars.ts     position_x/y defaults 11264 / 11804
--
-- Unlike migration 0002 (which RESET all rows because the 5120->18432 change was a
-- world *resize*, not a centered shift, so old coords were meaningless on the new
-- grid), THIS migration is a pure +2048 PER-ROW SHIFT. The old 576-tile grid is a
-- centered sub-region of the new 704-tile grid, so an old position p maps exactly
-- to p+2048 and the player stays standing exactly where they were in-world.
--
-- PROPERTIES (CI deploy GATE - correctness is paramount, see migrate-ci.ts):
--   * IDEMPOTENT (default): ALTER ... SET DEFAULT re-applies to the same value.
--   * SELF-IDEMPOTENT (data): the +2048 UPDATE is NOT naturally self-idempotent, so
--     it is guarded by a dedicated SENTINEL table written in the SAME statement
--     block. The shift runs ONLY IF the sentinel is empty, then inserts the
--     sentinel. This does NOT rely on the _clawville_migrations tracking insert
--     (which migrate-ci.ts writes in a SEPARATE statement AFTER the file's implicit
--     txn commits - a crash in that window would otherwise re-apply +2048 = a
--     catastrophic +4096). With the sentinel, a re-run finds the sentinel present
--     and skips the shift, so the data delta can NEVER double-apply.
--   * SINGLE IMPLICIT TXN: migrate-ci.ts runs the whole file as one multi-statement
--     simple query (postgres.js prepare:false) which Postgres wraps in ONE implicit
--     transaction (verified in migrate-ci.ts header). So the sentinel INSERT and the
--     UPDATE inside the DO block commit ATOMICALLY together - no BEGIN/COMMIT needed.
--     No ALTER TYPE ADD VALUE here, so the in-txn restriction does not apply.
--   * NO DROP: never drops or renames anything. Touches ONLY the pre-existing
--     "avatars" base table + its own sentinel table. NEVER references Eliza
--     plugin-sql tables.
--   * MIRRORS @clawville/shared SPAWN_PX (11264, 11804) and the schema defaults in
--     packages/database/src/schema/avatars.ts - keep all three in sync.
--
-- Values: position_x = 11264 (= WORLD_PX_WIDTH / 2),
--         position_y = 11804 (= WORLD_PX_HEIGHT / 2 + 540, south of Nori).
-- Delta:  +2048 px (= +64 tiles x 32) on each axis (new_center - old_center).
-- ============================================================================

-- New rows spawn at the re-centered town center (704-world). Idempotent.
ALTER TABLE "avatars" ALTER COLUMN "position_x" SET DEFAULT 11264;
ALTER TABLE "avatars" ALTER COLUMN "position_y" SET DEFAULT 11804;

-- Dedicated sentinel: marks that the one-time +2048 row shift has been applied to
-- THIS database. Created idempotently; its emptiness is the run-once guard below.
CREATE TABLE IF NOT EXISTS "_clawville_world_grow_704_recenter" (
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Shift EVERY existing row by the uniform recenter delta (+2048 px on each axis)
-- so each player keeps the exact in-world spot they last stood on. The old grid is
-- a centered sub-region of the new one, so this is a lossless remap (no reset).
-- GUARDED by the sentinel: runs EXACTLY ONCE per database, independent of the
-- _clawville_migrations tracking insert (which happens in a separate statement).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_clawville_world_grow_704_recenter") THEN
    UPDATE "avatars"
    SET "position_x" = "position_x" + 2048,
        "position_y" = "position_y" + 2048,
        "updated_at" = now();
    INSERT INTO "_clawville_world_grow_704_recenter" DEFAULT VALUES;
  END IF;
END $$;
