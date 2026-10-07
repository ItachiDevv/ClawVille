-- 0080_floor_arena_recording.sql: Trading Floor Arena research recording (task AR-1, lead tradeLead3, 2026-10-07).
-- Contract: docs/trading-floor-arena.md §4 + §6 "Research recording". Drizzle mirror: packages/database/src/schema/floor-arena.ts.
-- DATA RECORDING ONLY: no reader in a trading decision, filter, exit, money path or public payload uses these columns
-- or tables. Additive and idempotent (in CI the Drizzle bootstrap already has them, so every statement no-ops there).
-- Safe before the code flip: the old code never reads or writes them, and its event prune still deletes as before.
-- lock_timeout: the ALTERs need a short ACCESS EXCLUSIVE lock on three hot arena tables. SET LOCAL bounds the wait to
-- 5 s for this file's implicit transaction only (migrate-ci runs a file as one multi-statement query); on a timeout the
-- whole file rolls back, the CI migrate job fails loud, and a rerun of the job applies it (every statement is idempotent).
SET LOCAL lock_timeout = '5s';

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
--    the first mark of the bucket and the last sell quote taken in it. Buckets and the 800-row cap per position are
--    in the engine (markPathSlot): hold 10 s for the first 30 min, 60 s to 6 h, 600 s to 24 h (620 rows at most);
--    tail 10 s for 30 min (180 rows at most). NO foreign key: an FK insert takes FOR KEY SHARE on the position row,
--    which conflicts with an exit booking's FOR UPDATE; the primary key (position_id first) is the lookup index.
CREATE TABLE IF NOT EXISTS "floor_arena_position_marks" (
  "position_id" uuid NOT NULL,
  "phase" text NOT NULL,
  "bucket_at" timestamptz NOT NULL,
  "mark_at" timestamptz,
  "mark_mult" double precision,
  "quote_at" timestamptz,
  "quote_mult" double precision,
  CONSTRAINT "floor_arena_position_marks_pkey" PRIMARY KEY ("position_id","phase","bucket_at")
);

-- 4. Pass and skip events older than 7 days move here instead of being deleted (the prune in events.ts).
--    Never read by a route: the public and owner decision streams read floor_arena_events only. NO foreign key
--    either: an FK insert would take FOR KEY SHARE on floor_arena_agents rows that the routes lock.
CREATE TABLE IF NOT EXISTS "floor_arena_events_archive" (
  "id" bigint PRIMARY KEY,
  "agent_id" text NOT NULL,
  "at" timestamptz NOT NULL,
  "type" text NOT NULL,
  "mint" text,
  "summary" text NOT NULL,
  "data" jsonb,
  "archived_at" timestamptz NOT NULL DEFAULT now()
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
