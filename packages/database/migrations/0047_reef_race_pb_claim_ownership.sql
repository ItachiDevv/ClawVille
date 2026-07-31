-- Durable per-room Reef Race PB ownership. The current PB row is replaceable;
-- this history is not, so reward retries remain eligible after a faster room.
CREATE TABLE IF NOT EXISTS "reef_race_personal_best_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_room_id" uuid NOT NULL,
  "avatar_id" uuid NOT NULL,
  "activity_id" text DEFAULT 'reef-race' NOT NULL,
  "best_lap_ms" integer NOT NULL,
  "previous_best_lap_ms" integer,
  "daily_rank" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reef_race_pb_claim_room_fk"
    FOREIGN KEY ("source_room_id") REFERENCES "activity_rooms"("id"),
  CONSTRAINT "reef_race_pb_claim_avatar_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_reef_race_pb_claim_room_avatar"
  ON "reef_race_personal_best_claims" ("source_room_id", "avatar_id");

CREATE INDEX IF NOT EXISTS "idx_reef_race_pb_claim_avatar_created"
  ON "reef_race_personal_best_claims" ("avatar_id", "created_at" DESC);

-- Preserve ownership for PBs written before this migration. Historical prior
-- time/rank cannot be reconstructed reliably, so those audit fields stay null.
INSERT INTO "reef_race_personal_best_claims" (
  "source_room_id",
  "avatar_id",
  "activity_id",
  "best_lap_ms"
)
SELECT
  "source_room_id",
  "avatar_id",
  "activity_id",
  "best_lap_ms"
FROM "reef_race_personal_bests"
WHERE "source_room_id" IS NOT NULL
ON CONFLICT ("source_room_id", "avatar_id") DO NOTHING;
