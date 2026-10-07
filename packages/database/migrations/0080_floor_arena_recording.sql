-- 0080_floor_arena_recording.sql: Trading Floor Arena research recording (task AR-1, lead tradeLead3, 2026-10-07).
-- Contract: docs/trading-floor-arena.md §4 + §6 "Research recording". Drizzle mirror: packages/database/src/schema/floor-arena.ts.
-- DATA RECORDING ONLY: no reader in a trading decision, filter, exit, money path or public payload uses these columns
-- or tables. Additive and idempotent (in CI the Drizzle bootstrap already has them, so every statement no-ops there).
-- Safe before the code flip: the old code never reads or writes them, and its event prune still deletes as before.

-- 1. First sight: the FIRST DexScreener snapshot of a discovery row (written once by the enrichment, never replaced
--    while the row lives). The engine copies it into floor_arena_positions.entry_features.firstSight at entry.
ALTER TABLE "floor_discovery_mints" ADD COLUMN IF NOT EXISTS "first_snapshot" jsonb;
ALTER TABLE "floor_discovery_mints" ADD COLUMN IF NOT EXISTS "first_snapshot_at" timestamptz;
ALTER TABLE "floor_arena_private_mints" ADD COLUMN IF NOT EXISTS "first_snapshot" jsonb;
ALTER TABLE "floor_arena_private_mints" ADD COLUMN IF NOT EXISTS "first_snapshot_at" timestamptz;

-- 2. Trough: the lowest fresh DexScreener mark multiple during the hold, and its snapshot time.
ALTER TABLE "floor_arena_positions" ADD COLUMN IF NOT EXISTS "trough_mult" numeric;
ALTER TABLE "floor_arena_positions" ADD COLUMN IF NOT EXISTS "trough_at" timestamptz;

-- 2 + 3. Mark path (phase 'hold') and post-exit tail (phase 'tail', 30 min after close). One row per time bucket:
--    the first mark of the bucket and the last sell quote taken in it. Bucket widths are in the engine
--    (markPathBucketAt): hold 10 s for the first 30 min, 60 s to 6 h, 300 s after; tail 10 s.
CREATE TABLE IF NOT EXISTS "floor_arena_position_marks" (
  "position_id" uuid NOT NULL,
  "phase" text NOT NULL,
  "bucket_at" timestamptz NOT NULL,
  "mark_at" timestamptz,
  "mark_mult" double precision,
  "quote_at" timestamptz,
  "quote_mult" double precision,
  CONSTRAINT "floor_arena_position_marks_pkey" PRIMARY KEY ("position_id","phase","bucket_at"),
  CONSTRAINT "floor_arena_position_marks_position_id_floor_arena_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "floor_arena_positions"("id") ON DELETE CASCADE
);

-- 4. Pass and skip events older than 7 days move here instead of being deleted (the prune in events.ts).
--    Never read by a route: the public and owner decision streams read floor_arena_events only.
CREATE TABLE IF NOT EXISTS "floor_arena_events_archive" (
  "id" bigint PRIMARY KEY,
  "agent_id" text NOT NULL,
  "at" timestamptz NOT NULL,
  "type" text NOT NULL,
  "mint" text,
  "summary" text NOT NULL,
  "data" jsonb,
  "archived_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "floor_arena_events_archive_agent_id_floor_arena_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "floor_arena_agents"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "floor_arena_events_archive_at_idx" ON "floor_arena_events_archive" ("at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_position_marks_phase_valid' AND conrelid = 'floor_arena_position_marks'::regclass) THEN
    ALTER TABLE "floor_arena_position_marks" ADD CONSTRAINT "floor_arena_position_marks_phase_valid" CHECK ("phase" IN ('hold','tail'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_position_marks_pairs' AND conrelid = 'floor_arena_position_marks'::regclass) THEN
    ALTER TABLE "floor_arena_position_marks" ADD CONSTRAINT "floor_arena_position_marks_pairs"
      CHECK ((("mark_at" IS NULL) = ("mark_mult" IS NULL)) AND (("quote_at" IS NULL) = ("quote_mult" IS NULL))
        AND ("mark_mult" IS NOT NULL OR "quote_mult" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_events_archive_type_valid' AND conrelid = 'floor_arena_events_archive'::regclass) THEN
    ALTER TABLE "floor_arena_events_archive" ADD CONSTRAINT "floor_arena_events_archive_type_valid" CHECK ("type" IN ('pass','skip'));
  END IF;
END $$;
