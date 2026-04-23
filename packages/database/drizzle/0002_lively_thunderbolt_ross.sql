CREATE TABLE IF NOT EXISTS "activities" (
	"id" text PRIMARY KEY NOT NULL,
	"building_id" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"min_players" integer NOT NULL,
	"max_players" integer NOT NULL,
	"preferred_players" integer NOT NULL,
	"reward_config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" text NOT NULL,
	"short_code" varchar(10) NOT NULL,
	"status" text NOT NULL,
	"player_count" integer NOT NULL,
	"has_bots" boolean DEFAULT false NOT NULL,
	"has_agents" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_rooms_short_code_unique" UNIQUE("short_code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_room_participants" (
	"room_id" uuid NOT NULL,
	"avatar_id" uuid NOT NULL,
	"agent_id" text,
	"subject_type" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "activity_room_participants_room_id_pet_id_pk" PRIMARY KEY("room_id","avatar_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"activity_id" text NOT NULL,
	"avatar_id" uuid NOT NULL,
	"agent_id" text,
	"subject_type" text NOT NULL,
	"placement" integer NOT NULL,
	"score" integer NOT NULL,
	"score_ms" integer,
	"tokens_awarded" integer DEFAULT 0 NOT NULL,
	"leaderboard_points" integer DEFAULT 0 NOT NULL,
	"is_personal_best" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_queue_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" text NOT NULL,
	"avatar_id" uuid NOT NULL,
	"agent_id" text,
	"subject_type" text NOT NULL,
	"party_id" uuid,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"matched_room_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_code" varchar(10) NOT NULL,
	"leader_pet_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disbanded_at" timestamp with time zone,
	CONSTRAINT "activity_parties_short_code_unique" UNIQUE("short_code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_party_members" (
	"party_id" uuid NOT NULL,
	"avatar_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "activity_party_members_party_id_pet_id_pk" PRIMARY KEY("party_id","avatar_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_replays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"activity_id" text NOT NULL,
	"frames" jsonb NOT NULL,
	"participants" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_replays_room_id_unique" UNIQUE("room_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"activity_ids" text[] NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_seasons_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "avatars" ADD COLUMN "flags" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_rooms" ADD CONSTRAINT "activity_rooms_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_room_participants" ADD CONSTRAINT "activity_room_participants_room_id_activity_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."activity_rooms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_room_participants" ADD CONSTRAINT "activity_room_participants_pet_id_pets_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatars"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_results" ADD CONSTRAINT "activity_results_room_id_activity_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."activity_rooms"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_results" ADD CONSTRAINT "activity_results_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_results" ADD CONSTRAINT "activity_results_pet_id_pets_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatars"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_queue_entries" ADD CONSTRAINT "activity_queue_entries_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_queue_entries" ADD CONSTRAINT "activity_queue_entries_pet_id_pets_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatars"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_queue_entries" ADD CONSTRAINT "activity_queue_entries_matched_room_id_activity_rooms_id_fk" FOREIGN KEY ("matched_room_id") REFERENCES "public"."activity_rooms"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_parties" ADD CONSTRAINT "activity_parties_leader_pet_id_pets_id_fk" FOREIGN KEY ("leader_pet_id") REFERENCES "public"."avatars"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_party_members" ADD CONSTRAINT "activity_party_members_party_id_activity_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."activity_parties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_party_members" ADD CONSTRAINT "activity_party_members_pet_id_pets_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."avatars"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_replays" ADD CONSTRAINT "activity_replays_room_id_activity_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."activity_rooms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_replays" ADD CONSTRAINT "activity_replays_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_rooms_activity_created" ON "activity_rooms" USING btree ("activity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_rooms_active_status" ON "activity_rooms" USING btree ("status") WHERE status IN ('countdown','live');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_arp_pet_joined" ON "activity_room_participants" USING btree ("avatar_id","joined_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_results_activity_placement" ON "activity_results" USING btree ("activity_id","placement","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_results_pet_created" ON "activity_results" USING btree ("avatar_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_results_fast_time" ON "activity_results" USING btree ("activity_id","score_ms") WHERE score_ms IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_queue_active" ON "activity_queue_entries" USING btree ("activity_id","queued_at") WHERE left_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_queue_pet" ON "activity_queue_entries" USING btree ("avatar_id","queued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_replays_activity_created" ON "activity_replays" USING btree ("activity_id","created_at" DESC NULLS LAST);