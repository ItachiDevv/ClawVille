-- Phase 1 anti-farm + tutorial quest claims — Q3 plan §2.1, §2.6
-- Applied 2026-04-29 against prod Supabase (out-of-band from drizzle-kit
-- because the migrate folder is out of sync with prod state — repo uses
-- db:push, not migration files, per CLAUDE.md).

-- 1. Anti-farm fingerprint columns on events (nullable for back-compat)
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "fp_hash" text;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "ip_prefix_hash" text;

-- 2. Tutorial quest idempotency table
CREATE TABLE IF NOT EXISTS "tutorial_quest_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "avatar_id" uuid NOT NULL,
  "quest_id" text NOT NULL,
  "tokens_credited" integer NOT NULL,
  "ledger_id" uuid,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "tutorial_quest_claims"
  ADD CONSTRAINT "tutorial_quest_claims_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "tutorial_quest_claims"
  ADD CONSTRAINT "tutorial_quest_claims_pet_id_pets_id_fk"
  FOREIGN KEY ("avatar_id") REFERENCES "public"."avatars"("id")
  ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_tutorial_quest_claim_user_quest"
  ON "tutorial_quest_claims" USING btree ("user_id","quest_id");
