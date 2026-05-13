-- Reef Race Phase 4 (2026-04-25)
-- Additive, non-destructive. Adds:
--   - reef_race_personal_bests   (new table — per-avatar PB lap + ghost replay)
--   - activity_results.match_best_streak     (int, nullable)
--   - activity_results.match_pb_daily_rank   (int, nullable)
-- All additive — no DROPs, no data rewrites. Safe to run live via
-- `bun run db:push` per CLAUDE.md "Database migrations".
CREATE TABLE IF NOT EXISTS "reef_race_personal_bests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "avatar_id" uuid NOT NULL,
  "activity_id" text NOT NULL DEFAULT 'reef-race',
  "best_lap_ms" integer NOT NULL,
  "best_lap_recorded_at" timestamp with time zone NOT NULL DEFAULT now(),
  "source_room_id" uuid,
  "ghost_replay_data" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "reef_race_personal_bests_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id"),
  CONSTRAINT "reef_race_personal_bests_source_room_id_activity_rooms_id_fk"
    FOREIGN KEY ("source_room_id") REFERENCES "activity_rooms"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_reef_race_pb_avatar_activity"
  ON "reef_race_personal_bests" ("avatar_id", "activity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reef_race_pb_recorded_lap"
  ON "reef_race_personal_bests" ("best_lap_recorded_at" DESC, "best_lap_ms" ASC)
  WHERE "activity_id" = 'reef-race';
--> statement-breakpoint
-- Phase 4 — best-streak surfaced on per-match results so /results endpoint
-- can return it without a JOIN. Nullable so legacy rows backfill as null.
-- S3 FIX — renamed best_streak → match_best_streak for clarity.
ALTER TABLE "activity_results"
  ADD COLUMN IF NOT EXISTS "match_best_streak" integer;
--> statement-breakpoint
COMMENT ON COLUMN "activity_results"."match_best_streak" IS
  'Reef Race only - best consecutive clean checkpoint crosses this match. Null for other activities.';
--> statement-breakpoint
-- C2 FIX — daily-best-lap rank for the just-set PB persisted on the per-match
-- row so /results endpoint can return it without a cache round-trip.
ALTER TABLE "activity_results"
  ADD COLUMN IF NOT EXISTS "match_pb_daily_rank" integer;
--> statement-breakpoint
COMMENT ON COLUMN "activity_results"."match_pb_daily_rank" IS
  'Reef Race only - daily-best-lap rank (1-100) earned by this match if it set a new PB. Null otherwise.';
