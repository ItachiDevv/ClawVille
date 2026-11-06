-- 0094_vendor_oauth.sql
-- MCP hub phase 3c, part 1 (2026-11-06): Studios sign-in (OAuth 2.1, PKCE).
--
-- vendor_oauth_states: one row per sign-in the human starts. The `state` sent
-- to the vendor is stored only as its SHA-256 hash; the PKCE verifier is
-- encrypted with keypair-vault encryptToken (AES-256-GCM). A row is single
-- use (used_at is set before the code exchange) and expires 10 minutes after
-- it is made. Bound to the human's user id and avatar.
--
-- user_vendor_credentials gains `kind`, so ONE avatar can hold a Studios API
-- key ('api_key', every existing row) AND a Studios sign-in ('oauth') at the
-- same time. The primary key becomes (avatar_id, vendor, kind). An 'oauth'
-- row holds the access token and the refresh token, each encrypted with the
-- same enc/iv/tag scheme; enc/iv/tag/last4 stay for 'api_key' rows only, so
-- they become nullable and a CHECK ties the required columns to the kind.
-- status 'broken' = the vendor refused the refresh token; the human must
-- sign in again.
--
-- Additive and idempotent: the CI bootstrap makes the final shape from the
-- Drizzle schema first, and then this file must be a no-op.

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
  CONSTRAINT "vendor_oauth_states_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "vendor_oauth_states_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE cascade,
  CONSTRAINT "vendor_oauth_states_ttl_check" CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX IF NOT EXISTS "vendor_oauth_states_state_hash_unique"
  ON "vendor_oauth_states" ("state_hash");
CREATE INDEX IF NOT EXISTS "vendor_oauth_states_user_created_idx"
  ON "vendor_oauth_states" ("user_id", "created_at");

ALTER TABLE "user_vendor_credentials" ADD COLUMN IF NOT EXISTS "kind" varchar(16) DEFAULT 'api_key' NOT NULL;
ALTER TABLE "user_vendor_credentials" ADD COLUMN IF NOT EXISTS "access_enc" text;
ALTER TABLE "user_vendor_credentials" ADD COLUMN IF NOT EXISTS "access_iv" text;
ALTER TABLE "user_vendor_credentials" ADD COLUMN IF NOT EXISTS "access_tag" text;
ALTER TABLE "user_vendor_credentials" ADD COLUMN IF NOT EXISTS "refresh_enc" text;
ALTER TABLE "user_vendor_credentials" ADD COLUMN IF NOT EXISTS "refresh_iv" text;
ALTER TABLE "user_vendor_credentials" ADD COLUMN IF NOT EXISTS "refresh_tag" text;
ALTER TABLE "user_vendor_credentials" ADD COLUMN IF NOT EXISTS "access_expires_at" timestamp with time zone;
ALTER TABLE "user_vendor_credentials" ADD COLUMN IF NOT EXISTS "scope" text;
ALTER TABLE "user_vendor_credentials" ADD COLUMN IF NOT EXISTS "status" varchar(16) DEFAULT 'active' NOT NULL;

ALTER TABLE "user_vendor_credentials" ALTER COLUMN "enc" DROP NOT NULL;
ALTER TABLE "user_vendor_credentials" ALTER COLUMN "iv" DROP NOT NULL;
ALTER TABLE "user_vendor_credentials" ALTER COLUMN "tag" DROP NOT NULL;
ALTER TABLE "user_vendor_credentials" ALTER COLUMN "last4" DROP NOT NULL;

-- Primary key (avatar_id, vendor) -> (avatar_id, vendor, kind). Every existing
-- row has kind 'api_key', so the old key values stay unique.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_vendor_credentials_pk'
      AND conrelid = '"user_vendor_credentials"'::regclass
      AND array_length(conkey, 1) = 2
  ) THEN
    ALTER TABLE "user_vendor_credentials" DROP CONSTRAINT "user_vendor_credentials_pk";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_vendor_credentials_pk'
      AND conrelid = '"user_vendor_credentials"'::regclass
  ) THEN
    ALTER TABLE "user_vendor_credentials"
      ADD CONSTRAINT "user_vendor_credentials_pk" PRIMARY KEY ("avatar_id", "vendor", "kind");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_vendor_credentials_kind_check') THEN
    ALTER TABLE "user_vendor_credentials" ADD CONSTRAINT "user_vendor_credentials_kind_check"
      CHECK ("kind" IN ('api_key', 'oauth'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_vendor_credentials_status_check') THEN
    ALTER TABLE "user_vendor_credentials" ADD CONSTRAINT "user_vendor_credentials_status_check"
      CHECK ("status" IN ('active', 'broken'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_vendor_credentials_shape_check') THEN
    ALTER TABLE "user_vendor_credentials" ADD CONSTRAINT "user_vendor_credentials_shape_check"
      CHECK (
        ("kind" = 'api_key'
          AND "enc" IS NOT NULL AND "iv" IS NOT NULL AND "tag" IS NOT NULL AND "last4" IS NOT NULL)
        OR ("kind" = 'oauth'
          AND "access_enc" IS NOT NULL AND "access_iv" IS NOT NULL AND "access_tag" IS NOT NULL
          AND "access_expires_at" IS NOT NULL
          AND (("refresh_enc" IS NULL AND "refresh_iv" IS NULL AND "refresh_tag" IS NULL)
            OR ("refresh_enc" IS NOT NULL AND "refresh_iv" IS NOT NULL AND "refresh_tag" IS NOT NULL)))
      );
  END IF;
END $$;
