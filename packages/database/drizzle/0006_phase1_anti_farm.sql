CREATE TABLE IF NOT EXISTS "reef_race_personal_bests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"avatar_id" uuid NOT NULL,
	"activity_id" text DEFAULT 'reef-race' NOT NULL,
	"best_lap_ms" integer NOT NULL,
	"best_lap_recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_room_id" uuid,
	"ghost_replay_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tutorial_quest_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"avatar_id" uuid NOT NULL,
	"quest_id" text NOT NULL,
	"tokens_credited" integer NOT NULL,
	"ledger_id" uuid,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "guest_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "avatar" ADD COLUMN "learning_focus" varchar(120);--> statement-breakpoint
ALTER TABLE "avatar" ADD COLUMN "is_guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "openclaw_bots" ADD COLUMN "session_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "openclaw_bots" ADD COLUMN "session_swept_at" timestamp;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "fp_hash" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "ip_prefix_hash" text;--> statement-breakpoint
ALTER TABLE "activity_results" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activity_results" ADD COLUMN "match_best_streak" integer;--> statement-breakpoint
ALTER TABLE "activity_results" ADD COLUMN "match_pb_daily_rank" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reef_race_personal_bests" ADD CONSTRAINT "reef_race_personal_bests_pet_id_pets_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatar"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reef_race_personal_bests" ADD CONSTRAINT "reef_race_personal_bests_source_room_id_activity_rooms_id_fk" FOREIGN KEY ("source_room_id") REFERENCES "public"."activity_rooms"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tutorial_quest_claims" ADD CONSTRAINT "tutorial_quest_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tutorial_quest_claims" ADD CONSTRAINT "tutorial_quest_claims_pet_id_pets_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatar"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_reef_race_pb_pet_activity" ON "reef_race_personal_bests" USING btree ("avatar_id","activity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reef_race_pb_recorded_lap" ON "reef_race_personal_bests" USING btree ("best_lap_recorded_at" DESC NULLS LAST,"best_lap_ms") WHERE activity_id = 'reef-race';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_tutorial_quest_claim_user_quest" ON "tutorial_quest_claims" USING btree ("user_id","quest_id");