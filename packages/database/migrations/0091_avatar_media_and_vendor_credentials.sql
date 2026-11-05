-- 0091_avatar_media_and_vendor_credentials.sql
-- MCP hub step 2, phase 2b (2026-11-05).
--
-- avatar_media: images that an avatar's paid tools made. Studios returns an
-- image either as base64 data (stored here as bytes, at most 8 MB) or as an
-- expiring https link (stored as external_url only; the API never fetches a
-- vendor-supplied URL). Served at GET /api/media/:id by its unguessable id.
-- The API keeps the newest 50 rows per avatar.
--
-- user_vendor_credentials: a human's own API key for a vendor (mode A: the
-- vendor bills the human's own account). The key is encrypted with
-- keypair-vault encryptToken (AES-256-GCM); only the last 4 characters are
-- ever shown. Written only from a human session.
-- Additive and idempotent; safe for the CI migration runner to re-check.

CREATE TABLE IF NOT EXISTS "avatar_media" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "avatar_id" uuid NOT NULL,
  "vendor" varchar(32) NOT NULL,
  "mode" varchar(16) NOT NULL,
  "actor" varchar(16) NOT NULL,
  "mime_type" varchar(32),
  "bytes" bytea,
  "external_url" text,
  "prompt" text NOT NULL,
  "ledger_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "avatar_media_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE cascade,
  CONSTRAINT "avatar_media_ledger_id_fk"
    FOREIGN KEY ("ledger_id") REFERENCES "vendor_spend_ledger"("id") ON DELETE set null,
  CONSTRAINT "avatar_media_mode_check" CHECK ("mode" IN ('wallet', 'account')),
  CONSTRAINT "avatar_media_actor_check" CHECK ("actor" IN ('human', 'agent')),
  CONSTRAINT "avatar_media_content_check" CHECK (
    ("bytes" IS NOT NULL AND "mime_type" IS NOT NULL AND octet_length("bytes") <= 8388608)
    OR ("bytes" IS NULL AND "external_url" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "avatar_media_avatar_created_idx"
  ON "avatar_media" ("avatar_id", "created_at");

CREATE TABLE IF NOT EXISTS "user_vendor_credentials" (
  "avatar_id" uuid NOT NULL,
  "vendor" varchar(32) NOT NULL,
  "enc" text NOT NULL,
  "iv" text NOT NULL,
  "tag" text NOT NULL,
  "last4" varchar(4) NOT NULL,
  "updated_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_vendor_credentials_pk" PRIMARY KEY ("avatar_id", "vendor"),
  CONSTRAINT "user_vendor_credentials_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE cascade,
  CONSTRAINT "user_vendor_credentials_updated_by_fk"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE set null
);
