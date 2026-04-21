DO $$ BEGIN
 CREATE TYPE "public"."pet_avatar_type" AS ENUM('glb', 'vrm');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."pet_color" AS ENUM('green', 'red', 'blue', 'yellow');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."pet_gender" AS ENUM('male', 'female');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."pet_species" AS ENUM('cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."platform_agent_status" AS ENUM('pending', 'starting', 'running', 'paused', 'error', 'stopped');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."bazaar_rarity" AS ENUM('common', 'uncommon', 'rare', 'epic', 'legendary');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."bazaar_listing_status" AS ENUM('active', 'sold', 'cancelled', 'expired');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."dev_wallet_source" AS ENUM('user', 'agent', 'generated');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."launch_platform" AS ENUM('pumpfun', 'raydium');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."launch_status" AS ENUM('pending', 'confirming', 'live', 'graduated', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."vanity_keypair_status" AS ENUM('available', 'reserved', 'used');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."vanity_suffix" AS ENUM('CLAW', 'HRMS');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."claw_token_source" AS ENUM('api', 'simulation', 'quest', 'bounty', 'daily_login', 'admin', 'x402', 'system');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."treasury_purpose" AS ENUM('x402-merchant', 'fee-collector', 'escrow');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."auction_item_type" AS ENUM('skill', 'agent_config');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."auction_status" AS ENUM('active', 'ended', 'cancelled', 'resolved');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."quest_status" AS ENUM('draft', 'active', 'completed', 'archived');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."quest_submission_status" AS ENUM('accepted', 'in_progress', 'submitted', 'in_review', 'approved', 'rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."quest_tier" AS ENUM('side_quest', 'main_quest', 'legendary');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."bounty_attempt_status" AS ENUM('claimed', 'in_progress', 'submitted', 'approved', 'rejected', 'abandoned');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."bounty_difficulty" AS ENUM('beginner', 'intermediate', 'advanced', 'expert');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."bounty_reward_type" AS ENUM('token', 'skill', 'agent_config', 'knowledge_book', 'custom');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."bounty_status" AS ENUM('open', 'in_progress', 'completed', 'cancelled', 'expired');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."reputation_tier" AS ENUM('newcomer', 'apprentice', 'journeyman', 'expert', 'master');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."wallet_subject_type" AS ENUM('pet', 'agent', 'treasury');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255),
	"email_verified" boolean DEFAULT false,
	"password_hash" varchar(255),
	"name" varchar(255),
	"avatar_url" varchar(500),
	"identity_fingerprint" varchar(64),
	"identity_pubkey" varchar(44),
	"identity_encrypted_sk" text,
	"identity_iv" varchar(32),
	"identity_tag" varchar(32),
	"identity_dek_wrapped" text,
	"identity_encryption_version" integer DEFAULT 2 NOT NULL,
	"scape_principal_id" varchar(128),
	"scape_world_character_id" varchar(64),
	"linked_scape_principal_id" varchar(128),
	"linked_scape_world_character_id" varchar(64),
	"linked_scape_display_name" varchar(64),
	"linked_scape_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_identity_fingerprint_unique" UNIQUE("identity_fingerprint"),
	CONSTRAINT "users_identity_pubkey_unique" UNIQUE("identity_pubkey"),
	CONSTRAINT "users_scape_principal_id_unique" UNIQUE("scape_principal_id"),
	CONSTRAINT "users_scape_world_character_id_unique" UNIQUE("scape_world_character_id"),
	CONSTRAINT "users_linked_scape_principal_id_unique" UNIQUE("linked_scape_principal_id"),
	CONSTRAINT "users_linked_scape_world_character_id_unique" UNIQUE("linked_scape_world_character_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"species" "pet_species" NOT NULL,
	"color" "pet_color" NOT NULL,
	"gender" "pet_gender" NOT NULL,
	"archetype" varchar(50) NOT NULL,
	"personality" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"character_config" jsonb,
	"platform_agent_id" uuid,
	"claw_tokens" integer DEFAULT 100 NOT NULL,
	"position_x" integer DEFAULT 2560 NOT NULL,
	"position_y" integer DEFAULT 2560 NOT NULL,
	"last_active_at" timestamp,
	"login_streak" integer DEFAULT 0 NOT NULL,
	"last_login_date" varchar(10),
	"slot_index" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"equipped_skills" jsonb DEFAULT '[]'::jsonb,
	"level" integer DEFAULT 1 NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"total_xp" integer DEFAULT 0 NOT NULL,
	"avatar_type" "pet_avatar_type" DEFAULT 'glb' NOT NULL,
	"avatar_url" varchar(1024),
	"vrm_metadata" jsonb,
	"agent_category" varchar(16) DEFAULT 'openclaw' NOT NULL,
	"model_key" varchar(64) DEFAULT 'lobster' NOT NULL,
	"harness" varchar(16) DEFAULT 'milady' NOT NULL,
	"wallet_address" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pets_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "pets_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "map_locations" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text NOT NULL,
	"icon" varchar(10) NOT NULL,
	"position_x" integer NOT NULL,
	"position_y" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "location_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"location_id" varchar(50) NOT NULL,
	"agent_name" varchar(100) NOT NULL,
	"character_config" jsonb NOT NULL,
	"platform_agent_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_agent_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"level" varchar(20) NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"type" varchar(50) DEFAULT 'location-agent' NOT NULL,
	"status" "platform_agent_status" DEFAULT 'pending' NOT NULL,
	"customization" jsonb,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_heartbeat" timestamp,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pet_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pet_id" uuid NOT NULL,
	"item_id" varchar(50) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"acquired_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "openclaw_bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(200) NOT NULL,
	"identity_type" varchar(50) DEFAULT 'openclaw' NOT NULL,
	"gateway_url" varchar(500),
	"protocol" varchar(50) DEFAULT 'openai-compat' NOT NULL,
	"mode" varchar(20) NOT NULL,
	"target_npc_id" varchar(100),
	"name" varchar(100),
	"species" varchar(50),
	"color" integer,
	"knowledge" jsonb DEFAULT '[]'::jsonb,
	"metadata" jsonb,
	"wallet_address" varchar(64),
	"total_sessions" integer DEFAULT 0 NOT NULL,
	"total_messages" integer DEFAULT 0 NOT NULL,
	"user_id" uuid,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "openclaw_bots_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pet_id" uuid NOT NULL,
	"activity_type" varchar(50) NOT NULL,
	"description" text NOT NULL,
	"tokens_earned" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "npc_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" varchar(100) NOT NULL,
	"entity_type" varchar(20) NOT NULL,
	"target_entity_id" varchar(100),
	"content" text NOT NULL,
	"importance" integer DEFAULT 5 NOT NULL,
	"kind" varchar(30) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" varchar(50) NOT NULL,
	"url" text NOT NULL,
	"title" varchar(300) NOT NULL,
	"source" varchar(100) NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_hash" varchar(64),
	"scraped_at" timestamp DEFAULT now() NOT NULL,
	"scrape_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "published_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_pet_id" uuid,
	"author_claw_name" varchar(100),
	"author_claw_species" varchar(20),
	"location_id" varchar(50),
	"name" varchar(100) NOT NULL,
	"description" varchar(200) NOT NULL,
	"skill_md" text NOT NULL,
	"price" integer DEFAULT 0 NOT NULL,
	"upvote_count" integer DEFAULT 0 NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"rarity" "bazaar_rarity" DEFAULT 'common' NOT NULL,
	"category" varchar(50),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_upvotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"pet_id" uuid,
	"claw_session_id" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bazaar_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"price" integer NOT NULL,
	"status" "bazaar_listing_status" DEFAULT 'active' NOT NULL,
	"featured_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bazaar_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bazaar_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"price" integer NOT NULL,
	"platform_fee" integer NOT NULL,
	"seller_payout" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_launches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pet_id" uuid NOT NULL,
	"vanity_keypair_id" uuid NOT NULL,
	"mint_address" varchar(64) NOT NULL,
	"platform" "launch_platform" NOT NULL,
	"status" "launch_status" DEFAULT 'pending' NOT NULL,
	"dev_wallet_source" "dev_wallet_source" NOT NULL,
	"dev_wallet_address" varchar(64) NOT NULL,
	"encrypted_dev_wallet_key" text,
	"dev_wallet_iv" varchar(32),
	"dev_wallet_tag" varchar(32),
	"metadata" jsonb NOT NULL,
	"create_tx_signature" varchar(128),
	"pool_address" varchar(64),
	"graduated_pool_address" varchar(64),
	"graduated_at" timestamp,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "token_launches_mint_address_unique" UNIQUE("mint_address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vanity_keypairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suffix" "vanity_suffix" NOT NULL,
	"public_key" varchar(64) NOT NULL,
	"encrypted_secret_key" text NOT NULL,
	"encryption_iv" varchar(32) NOT NULL,
	"encryption_tag" varchar(32) NOT NULL,
	"status" "vanity_keypair_status" DEFAULT 'available' NOT NULL,
	"reserved_by" uuid,
	"reserved_at" timestamp,
	"used_at" timestamp,
	"token_mint" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vanity_keypairs_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claw_token_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pet_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" text NOT NULL,
	"source" "claw_token_source" NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treasury_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "treasury_purpose" NOT NULL,
	"public_key" varchar(64) NOT NULL,
	"encrypted_secret_key" text NOT NULL,
	"encryption_iv" varchar(32) NOT NULL,
	"encryption_tag" varchar(32) NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_wallets_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auction_agent_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auction_id" uuid NOT NULL,
	"pet_id" uuid NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auction_bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auction_id" uuid NOT NULL,
	"bidder_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"is_auto_bid" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auctions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"item_type" "auction_item_type" NOT NULL,
	"skill_id" uuid,
	"agent_config_snapshot" jsonb,
	"title" varchar(200) NOT NULL,
	"description" text,
	"starting_bid" integer NOT NULL,
	"current_bid" integer,
	"buy_now_price" integer,
	"current_bidder_id" uuid,
	"bid_count" integer DEFAULT 0 NOT NULL,
	"status" "auction_status" DEFAULT 'active' NOT NULL,
	"ends_at" timestamp NOT NULL,
	"original_ends_at" timestamp NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quest_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"pet_id" uuid NOT NULL,
	"quest_id" uuid NOT NULL,
	"tokens_awarded" integer NOT NULL,
	"skill_id" uuid,
	"title_awarded" varchar(100),
	"claimed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quest_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quest_id" uuid NOT NULL,
	"pet_id" uuid NOT NULL,
	"status" "quest_submission_status" DEFAULT 'accepted' NOT NULL,
	"pr_link" varchar(500),
	"submission_note" text,
	"review_note" text,
	"reviewed_by" uuid,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"submitted_at" timestamp,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"tier" "quest_tier" NOT NULL,
	"status" "quest_status" DEFAULT 'active' NOT NULL,
	"token_reward" integer NOT NULL,
	"skill_reward_id" uuid,
	"title_reward" varchar(100),
	"max_completions" integer DEFAULT 1,
	"current_completions" integer DEFAULT 0,
	"requirements" text,
	"verification_method" varchar(50) DEFAULT 'manual',
	"created_by" uuid,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pet_id" uuid,
	"name" varchar(100) NOT NULL,
	"description" text,
	"config_data" jsonb NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bounties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"requirements" text,
	"difficulty" "bounty_difficulty" DEFAULT 'intermediate' NOT NULL,
	"status" "bounty_status" DEFAULT 'open' NOT NULL,
	"token_reward" integer NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"current_attempts" integer DEFAULT 0 NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"expires_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bounty_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bounty_id" uuid NOT NULL,
	"hunter_id" uuid NOT NULL,
	"status" "bounty_attempt_status" DEFAULT 'claimed' NOT NULL,
	"pr_link" varchar(500),
	"submission_note" text,
	"review_note" text,
	"claimed_at" timestamp DEFAULT now() NOT NULL,
	"submitted_at" timestamp,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bounty_reputation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pet_id" uuid NOT NULL,
	"tier" "reputation_tier" DEFAULT 'newcomer' NOT NULL,
	"total_completed" integer DEFAULT 0 NOT NULL,
	"total_earned" integer DEFAULT 0 NOT NULL,
	"total_posted" integer DEFAULT 0 NOT NULL,
	"success_rate" integer DEFAULT 100 NOT NULL,
	"last_activity_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bounty_reputation_pet_id_unique" UNIQUE("pet_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bounty_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bounty_id" uuid NOT NULL,
	"reward_type" "bounty_reward_type" NOT NULL,
	"skill_id" uuid,
	"agent_config_id" uuid,
	"book_id" varchar(50),
	"custom_description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "building_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"building_id" varchar(64) NOT NULL,
	"name" varchar(64) NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"source_article_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generator_version" integer DEFAULT 1 NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "building_skills_building_id_unique" UNIQUE("building_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "wallet_subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"public_key" varchar(64) NOT NULL,
	"encrypted_secret_key" text NOT NULL,
	"encryption_iv" varchar(32) NOT NULL,
	"encryption_tag" varchar(32) NOT NULL,
	"encryption_version" integer DEFAULT 1 NOT NULL,
	"dek_wrapped" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_session_tickets" (
	"ticket" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"pet_id" uuid,
	"issued_to_agent_session" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"identity_type" varchar(16) NOT NULL,
	"identity_key" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"user_id" uuid,
	"agent_id" text,
	"pet_id" uuid,
	"building_id" text,
	"session_id" text,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_write_failures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"attempted_event_type" text,
	"attempted_row" jsonb,
	"error_message" text,
	"error_stack" text,
	"retried_at" timestamp with time zone,
	"retry_succeeded" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_account_links" (
	"code" varchar(32) PRIMARY KEY NOT NULL,
	"clawville_user_id" uuid NOT NULL,
	"remote_world" varchar(64) NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pets" ADD CONSTRAINT "pets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pets" ADD CONSTRAINT "pets_platform_agent_id_platform_agents_id_fk" FOREIGN KEY ("platform_agent_id") REFERENCES "public"."platform_agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "location_agents" ADD CONSTRAINT "location_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "location_agents" ADD CONSTRAINT "location_agents_location_id_map_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."map_locations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "location_agents" ADD CONSTRAINT "location_agents_platform_agent_id_platform_agents_id_fk" FOREIGN KEY ("platform_agent_id") REFERENCES "public"."platform_agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_agent_logs" ADD CONSTRAINT "platform_agent_logs_agent_id_platform_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."platform_agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_agents" ADD CONSTRAINT "platform_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pet_inventory" ADD CONSTRAINT "pet_inventory_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "openclaw_bots" ADD CONSTRAINT "openclaw_bots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "published_skills" ADD CONSTRAINT "published_skills_author_pet_id_pets_id_fk" FOREIGN KEY ("author_pet_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_upvotes" ADD CONSTRAINT "skill_upvotes_skill_id_published_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."published_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_upvotes" ADD CONSTRAINT "skill_upvotes_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bazaar_listings" ADD CONSTRAINT "bazaar_listings_skill_id_published_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."published_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bazaar_listings" ADD CONSTRAINT "bazaar_listings_seller_id_pets_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bazaar_reviews" ADD CONSTRAINT "bazaar_reviews_transaction_id_bazaar_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."bazaar_transactions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bazaar_reviews" ADD CONSTRAINT "bazaar_reviews_reviewer_id_pets_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bazaar_reviews" ADD CONSTRAINT "bazaar_reviews_skill_id_published_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."published_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bazaar_transactions" ADD CONSTRAINT "bazaar_transactions_listing_id_bazaar_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."bazaar_listings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bazaar_transactions" ADD CONSTRAINT "bazaar_transactions_buyer_id_pets_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bazaar_transactions" ADD CONSTRAINT "bazaar_transactions_seller_id_pets_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bazaar_transactions" ADD CONSTRAINT "bazaar_transactions_skill_id_published_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."published_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_launches" ADD CONSTRAINT "token_launches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_launches" ADD CONSTRAINT "token_launches_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_launches" ADD CONSTRAINT "token_launches_vanity_keypair_id_vanity_keypairs_id_fk" FOREIGN KEY ("vanity_keypair_id") REFERENCES "public"."vanity_keypairs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vanity_keypairs" ADD CONSTRAINT "vanity_keypairs_reserved_by_users_id_fk" FOREIGN KEY ("reserved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claw_token_transactions" ADD CONSTRAINT "claw_token_transactions_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auction_agent_configs" ADD CONSTRAINT "auction_agent_configs_auction_id_auctions_id_fk" FOREIGN KEY ("auction_id") REFERENCES "public"."auctions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auction_agent_configs" ADD CONSTRAINT "auction_agent_configs_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_auction_id_auctions_id_fk" FOREIGN KEY ("auction_id") REFERENCES "public"."auctions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_bidder_id_pets_id_fk" FOREIGN KEY ("bidder_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auctions" ADD CONSTRAINT "auctions_seller_id_pets_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auctions" ADD CONSTRAINT "auctions_skill_id_published_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."published_skills"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auctions" ADD CONSTRAINT "auctions_current_bidder_id_pets_id_fk" FOREIGN KEY ("current_bidder_id") REFERENCES "public"."pets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quest_rewards" ADD CONSTRAINT "quest_rewards_submission_id_quest_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."quest_submissions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quest_rewards" ADD CONSTRAINT "quest_rewards_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quest_rewards" ADD CONSTRAINT "quest_rewards_quest_id_quests_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quest_rewards" ADD CONSTRAINT "quest_rewards_skill_id_published_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."published_skills"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quest_submissions" ADD CONSTRAINT "quest_submissions_quest_id_quests_id_fk" FOREIGN KEY ("quest_id") REFERENCES "public"."quests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quest_submissions" ADD CONSTRAINT "quest_submissions_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quest_submissions" ADD CONSTRAINT "quest_submissions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quests" ADD CONSTRAINT "quests_skill_reward_id_published_skills_id_fk" FOREIGN KEY ("skill_reward_id") REFERENCES "public"."published_skills"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quests" ADD CONSTRAINT "quests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounties" ADD CONSTRAINT "bounties_creator_id_pets_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounty_attempts" ADD CONSTRAINT "bounty_attempts_bounty_id_bounties_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."bounties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounty_attempts" ADD CONSTRAINT "bounty_attempts_hunter_id_pets_id_fk" FOREIGN KEY ("hunter_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounty_reputation" ADD CONSTRAINT "bounty_reputation_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounty_rewards" ADD CONSTRAINT "bounty_rewards_bounty_id_bounties_id_fk" FOREIGN KEY ("bounty_id") REFERENCES "public"."bounties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounty_rewards" ADD CONSTRAINT "bounty_rewards_skill_id_published_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."published_skills"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounty_rewards" ADD CONSTRAINT "bounty_rewards_agent_config_id_agent_configs_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_configs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_session_tickets" ADD CONSTRAINT "agent_session_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_session_tickets" ADD CONSTRAINT "agent_session_tickets_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "events" ADD CONSTRAINT "events_pet_id_pets_id_fk" FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_account_links" ADD CONSTRAINT "pending_account_links_clawville_user_id_users_id_fk" FOREIGN KEY ("clawville_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_upvotes_skill_pet_unique" ON "skill_upvotes" USING btree ("skill_id","pet_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claw_token_tx_pet_idx" ON "claw_token_transactions" USING btree ("pet_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claw_token_tx_user_idx" ON "claw_token_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claw_token_tx_source_idx" ON "claw_token_transactions" USING btree ("source","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "treasury_purpose_idx" ON "treasury_wallets" USING btree ("purpose");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallets_subject_uniq" ON "wallets" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallets_subject_type_idx" ON "wallets" USING btree ("subject_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_session_tickets_expires_idx" ON "agent_session_tickets" USING btree ("expires_at") WHERE "agent_session_tickets"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_type_ts" ON "events" USING btree ("event_type","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_agent_ts" ON "events" USING btree ("agent_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_pet_ts" ON "events" USING btree ("pet_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_building_ts" ON "events" USING btree ("building_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_event_write_failures_ts" ON "event_write_failures" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_event_write_failures_unretried" ON "event_write_failures" USING btree ("ts" DESC NULLS LAST) WHERE retried_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pal_user" ON "pending_account_links" USING btree ("clawville_user_id","issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pal_active" ON "pending_account_links" USING btree ("expires_at") WHERE consumed_at IS NULL;