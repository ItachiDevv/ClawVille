-- 0091_avatar_media_and_vendor_credentials.sql
-- MCP hub step 2, phase 2b (2026-11-05).
--
-- avatar_media: images that an avatar's paid tools made. Studios returns the
-- image as base64 data; it is stored here as checked png/jpeg/webp bytes (at
-- most 8 MB). A reply with only a link is refused (image_missing); the API
-- never stores or follows a vendor-supplied URL. Served at GET /api/media/:id
-- by its unguessable id. The API keeps the newest 50 rows per avatar.
--
-- user_vendor_credentials: a human's own API key for a vendor (mode A: the
-- vendor bills the human's own account). The key is encrypted with
-- keypair-vault encryptToken (AES-256-GCM); only the last 4 characters are
-- ever shown. Saved or removed only from a human session with a signature
-- from the human's linked wallet.
--
-- vendor_call_requests: one row per image request in either mode, inserted
-- BEFORE the vendor is called. UNIQUE (avatar, vendor, idempotency key) stops
-- a retry from billing twice (mode A has no spend-ledger row), and the rows
-- give the per-avatar daily limits that survive an API restart.
--
-- vendor_spend_ledger gains reconcile_attempts / reconcile_next_at so the
-- reconcile worker backs off a row it cannot resolve instead of selecting it
-- again every pass, and signed_at (set with payer_signature, before sending)
-- so the reconcile landing window starts at the signature, not at admission.
-- Additive and idempotent; safe for the CI migration runner to re-check.

CREATE TABLE IF NOT EXISTS "avatar_media" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "avatar_id" uuid NOT NULL,
  "vendor" varchar(32) NOT NULL,
  "mode" varchar(16) NOT NULL,
  "actor" varchar(16) NOT NULL,
  "mime_type" varchar(32) NOT NULL,
  "bytes" bytea NOT NULL,
  "prompt" text NOT NULL,
  "ledger_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "avatar_media_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE cascade,
  CONSTRAINT "avatar_media_ledger_id_fk"
    FOREIGN KEY ("ledger_id") REFERENCES "vendor_spend_ledger"("id") ON DELETE set null,
  CONSTRAINT "avatar_media_mode_check" CHECK ("mode" IN ('wallet', 'account')),
  CONSTRAINT "avatar_media_actor_check" CHECK ("actor" IN ('human', 'agent')),
  CONSTRAINT "avatar_media_mime_check" CHECK ("mime_type" IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT "avatar_media_size_check" CHECK (octet_length("bytes") BETWEEN 1 AND 8388608)
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

CREATE TABLE IF NOT EXISTS "vendor_call_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "avatar_id" uuid NOT NULL,
  "vendor" varchar(32) NOT NULL,
  "actor" varchar(16) NOT NULL,
  "surface" varchar(16) NOT NULL,
  "mode" varchar(16) NOT NULL,
  "status" varchar(16) DEFAULT 'pending' NOT NULL,
  "idempotency_key" varchar(64) NOT NULL,
  "media_id" uuid,
  "ledger_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vendor_call_requests_avatar_id_avatars_id_fk"
    FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE cascade,
  CONSTRAINT "vendor_call_requests_media_id_fk"
    FOREIGN KEY ("media_id") REFERENCES "avatar_media"("id") ON DELETE set null,
  CONSTRAINT "vendor_call_requests_ledger_id_fk"
    FOREIGN KEY ("ledger_id") REFERENCES "vendor_spend_ledger"("id") ON DELETE set null,
  CONSTRAINT "vendor_call_requests_actor_check" CHECK ("actor" IN ('human', 'agent')),
  CONSTRAINT "vendor_call_requests_surface_check" CHECK ("surface" IN ('api', 'hosted')),
  CONSTRAINT "vendor_call_requests_mode_check" CHECK ("mode" IN ('wallet', 'account')),
  CONSTRAINT "vendor_call_requests_status_check" CHECK ("status" IN ('pending', 'done', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "vendor_call_requests_avatar_vendor_idem_unique"
  ON "vendor_call_requests" ("avatar_id", "vendor", "idempotency_key");
CREATE INDEX IF NOT EXISTS "vendor_call_requests_avatar_created_idx"
  ON "vendor_call_requests" ("avatar_id", "created_at");

ALTER TABLE "vendor_spend_ledger" ADD COLUMN IF NOT EXISTS "reconcile_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "vendor_spend_ledger" ADD COLUMN IF NOT EXISTS "reconcile_next_at" timestamp with time zone;
ALTER TABLE "vendor_spend_ledger" ADD COLUMN IF NOT EXISTS "signed_at" timestamp with time zone;
