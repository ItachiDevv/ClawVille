-- 2026-05-18 — Exchange peer marketplace (needs + one_shot/repeatable offers).
-- Hand-written because drizzle-kit 0.24 has a BigInt serialization bug
-- on the events table that blocks `drizzle-kit push`. Idempotent — each
-- statement guards with IF NOT EXISTS so re-running is safe.
--
-- See packages/database/src/schema/exchange.ts for the authoritative
-- Drizzle definitions + escrow flow documentation.

-- ─── Enums ───────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "exchange_listing_type" AS ENUM ('need', 'offer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "exchange_offer_mode" AS ENUM ('one_shot', 'repeatable');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "exchange_listing_status" AS ENUM ('open', 'paused', 'closed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "exchange_order_state" AS ENUM ('open', 'submitted', 'completed', 'disputed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── exchange_listings ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "exchange_listings" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "creator_id"   UUID NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "listing_type" "exchange_listing_type" NOT NULL,
  "offer_mode"   "exchange_offer_mode",
  "title"        VARCHAR(200) NOT NULL,
  "description"  TEXT NOT NULL,
  "category"     VARCHAR(50),
  "price_ct"     INTEGER NOT NULL,
  "capacity"     INTEGER,
  "status"       "exchange_listing_status" NOT NULL DEFAULT 'open',
  "tags"         JSONB DEFAULT '[]'::jsonb,
  "expires_at"   TIMESTAMP WITH TIME ZONE,
  "created_at"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updated_at"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_exchange_listings_type_status_created"
  ON "exchange_listings" ("listing_type", "status", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_exchange_listings_creator"
  ON "exchange_listings" ("creator_id", "created_at" DESC);

-- ─── exchange_orders ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "exchange_orders" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "listing_id"    UUID NOT NULL REFERENCES "exchange_listings"("id") ON DELETE CASCADE,
  "buyer_id"      UUID NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "amount_ct"     INTEGER NOT NULL,
  "state"         "exchange_order_state" NOT NULL DEFAULT 'open',
  "delivery_url"  VARCHAR(500),
  "delivery_note" TEXT,
  "review_note"   TEXT,
  "created_at"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "submitted_at"  TIMESTAMP WITH TIME ZONE,
  "completed_at"  TIMESTAMP WITH TIME ZONE,
  "cancelled_at"  TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS "idx_exchange_orders_listing"
  ON "exchange_orders" ("listing_id");

CREATE INDEX IF NOT EXISTS "idx_exchange_orders_buyer"
  ON "exchange_orders" ("buyer_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_exchange_orders_state"
  ON "exchange_orders" ("state", "created_at" DESC);
