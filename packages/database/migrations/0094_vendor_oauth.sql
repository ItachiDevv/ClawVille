-- 0094_vendor_oauth.sql
-- MCP hub phase 3c, part 1 (2026-11-06): Studios sign-in (OAuth 2.1, PKCE).
--
-- CREATE only: no existing table changes, so this file is safe to apply
-- before the code flip (user_vendor_credentials, the API keys, is untouched).
--
-- vendor_oauth_states: one row per sign-in the human starts. The `state` sent
-- to the vendor is stored only as its SHA-256 hash; the PKCE verifier is
-- encrypted with keypair-vault encryptToken (AES-256-GCM). Single use (used_at
-- is set before the code exchange), 10 minutes long, bound to the human's user
-- id and avatar. cancelled_at: the human removed the sign-in while this one
-- was open, so its tokens are never installed.
--
-- user_vendor_oauth_links: one linked sign-in per (avatar, vendor). The access
-- and refresh tokens are each encrypted with the same enc/iv/tag scheme.
-- status 'refreshing' + refresh_started_at is committed BEFORE a refresh
-- request, so a lost reply never leads to a second use of a rotated refresh
-- token; 'broken' = the human must sign in again. link_id is new on every
-- link; refresh_claim_id is new on every refresh claim, and a refresh result
-- is written only while both still match and status is 'refreshing'.
--
-- Idempotent: the CI bootstrap makes the final shape from the Drizzle schema
-- first (drizzle-kit 0.24 does not emit CHECKs), and then this file runs.

CREATE TABLE IF NOT EXISTS "vendor_oauth_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "avatar_id" uuid NOT NULL,
  "vendor" varchar(32) NOT NULL,
  "state_hash" varchar(64) NOT NULL,
  "verifier_enc" text NOT NULL,
  "verifier_iv" text NOT NULL,
  "verifier_tag" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  CONSTRAINT "vendor_oauth_states_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "vendor_oauth_states_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS "vendor_oauth_states_state_hash_unique"
  ON "vendor_oauth_states" ("state_hash");
CREATE INDEX IF NOT EXISTS "vendor_oauth_states_user_created_idx"
  ON "vendor_oauth_states" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "vendor_oauth_states_avatar_vendor_idx"
  ON "vendor_oauth_states" ("avatar_id", "vendor");

CREATE TABLE IF NOT EXISTS "user_vendor_oauth_links" (
  "avatar_id" uuid NOT NULL,
  "vendor" varchar(32) NOT NULL,
  "access_enc" text NOT NULL,
  "access_iv" text NOT NULL,
  "access_tag" text NOT NULL,
  "refresh_enc" text,
  "refresh_iv" text,
  "refresh_tag" text,
  "access_expires_at" timestamp with time zone NOT NULL,
  "scope" text NOT NULL,
  "status" varchar(16) DEFAULT 'active' NOT NULL,
  "refresh_started_at" timestamp with time zone,
  "link_id" uuid NOT NULL,
  "refresh_claim_id" uuid,
  "linked_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_vendor_oauth_links_pk" PRIMARY KEY ("avatar_id", "vendor"),
  CONSTRAINT "user_vendor_oauth_links_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE cascade,
  CONSTRAINT "user_vendor_oauth_links_linked_by_user_id_users_id_fk"
    FOREIGN KEY ("linked_by_user_id") REFERENCES "users"("id") ON DELETE set null
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_oauth_states_ttl_check') THEN
    ALTER TABLE "vendor_oauth_states" ADD CONSTRAINT "vendor_oauth_states_ttl_check"
      CHECK ("expires_at" > "created_at");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_vendor_oauth_links_status_check') THEN
    ALTER TABLE "user_vendor_oauth_links" ADD CONSTRAINT "user_vendor_oauth_links_status_check"
      CHECK ("status" IN ('active', 'refreshing', 'broken'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_vendor_oauth_links_refresh_check') THEN
    ALTER TABLE "user_vendor_oauth_links" ADD CONSTRAINT "user_vendor_oauth_links_refresh_check"
      CHECK (("refresh_enc" IS NULL AND "refresh_iv" IS NULL AND "refresh_tag" IS NULL)
        OR ("refresh_enc" IS NOT NULL AND "refresh_iv" IS NOT NULL AND "refresh_tag" IS NOT NULL));
  END IF;
END $$;
