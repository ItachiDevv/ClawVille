-- 0017_market_p2p.sql
-- Tokenomics C — marketplace stage (C4, 2026-07-07): P2P marketplace v1.
--
-- WHY: peer sellers list a thing they own (v1: land deeds ONLY — earned_bundle
-- is a reserved kind refused until EARNED provenance exists); buyers settle
-- through the GENERIC x402 USDC checkout (0016) via the `marketplace_purchase`
-- fulfiller. SETTLEMENT IS FLAG-GATED OFF (`MARKETPLACE_SETTLE_ENABLED`) and
-- every on-chain CLV movement (seller payout, 4.44% treasury rake, deed
-- transfer) is a QUEUED, Codex-review-gated INTENT — nothing signs or sends.
--
--   * `market_listings`   — the listing rows. State machine documented in
--     packages/database/src/schema/market.ts (active → pending_settlement →
--     settled | cancelled | expired). Partial-UNIQUE (item_kind, item_ref)
--     WHERE live = the double-list guard.
--   * `market_deed_locks` — MARKET-OWNED parcel transferability lock (PK
--     parcel_id = one live lock per parcel). Chosen over an ALTER on
--     `land_parcels` so land.ts/schema/land.ts stay untouched AND a db:push
--     from a stale branch can never silently drop a live land column.
--     INSERTed with the listing, DELETEd on cancel, HELD through 'settled'
--     until the (Codex+land-gated) deed-transfer executor completes.
--   * `market_settlements` — one row per settled checkout (checkout_id UNIQUE
--     = the exactly-once settlement key, on top of 0016's per-signature
--     guard): buyer USDC (checkout + tx sig + usd basis), the C3 swap-queue
--     row funded (clv_buy_queue_id), the 4.44% rake INTENT and the seller's
--     95.56% payout INTENT (payout_status 'pending_review' — the ONLY value
--     v1 writes). ¢-peg: usd_cents×444 and usd_cents×9556 are EXACT integer
--     µUSD, so the `market_settlements_conservation` CHECK
--     (rake + payout = basis) holds with zero rounding.
--
-- LEDGER-ONLY: nothing in this migration (or the code writing these tables)
-- touches `avatars.clawTokens` or the CT ledger. price_vclaw is the ¢-peg
-- QUOTE unit; the buyer pays real USDC underneath.
--
-- IDEMPOTENT + ADDITIVE ONLY: guarded CREATE TYPEs, CREATE TABLE IF NOT
-- EXISTS, CREATE INDEX IF NOT EXISTS. A re-run where everything exists is a
-- total no-op. NEVER author a DROP of data. No ALTER TYPE ... ADD VALUE is
-- needed (all-new types), but keep the per-statement AUTOCOMMIT apply mode
-- uniform with 0013/0014/0016 (plain `psql -f` / per-statement client).
--
-- FK ORDER: avatars/users/land_parcels are base tables; x402_checkouts is
-- 0016; clv_buy_queue is 0014 — all exist before this file applies.
--
-- CONSTRAINT/INDEX NAMING follows drizzle-kit's rendering convention (load-
-- bearing for drift-prevention, per 0001/0007/0014/0016): names reproduce the
-- explicit Drizzle schema names in packages/database/src/schema/market.ts.

-- ── new enum types (duplicate-safe) ──────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE market_item_kind AS ENUM ('land_deed', 'earned_bundle');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE market_listing_status AS ENUM (
    'active', 'pending_settlement', 'settled', 'cancelled', 'expired'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE market_payout_status AS ENUM (
    'pending_review', 'approved', 'rejected', 'paid'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── market_listings ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "market_listings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seller_avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "seller_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "item_kind" market_item_kind NOT NULL,
  "item_ref" varchar(128) NOT NULL,
  "price_vclaw" integer NOT NULL,
  "status" market_listing_status NOT NULL DEFAULT 'active',
  "escrow_state" varchar(32),
  "seller_wallet_pubkey" varchar(64) NOT NULL,
  "buyer_avatar_id" uuid REFERENCES "avatars"("id") ON DELETE SET NULL,
  "settlement_checkout_id" uuid REFERENCES "x402_checkouts"("id") ON DELETE SET NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "market_listings_price_vclaw_positive" CHECK ("price_vclaw" > 0)
);

CREATE INDEX IF NOT EXISTS "market_listings_status_created_idx"
  ON "market_listings" ("status", "created_at");

CREATE INDEX IF NOT EXISTS "market_listings_seller_idx"
  ON "market_listings" ("seller_avatar_id", "created_at");

-- Double-list guard: one LIVE listing per item (settled/cancelled/expired
-- rows don't block a relist).
CREATE UNIQUE INDEX IF NOT EXISTS "market_listings_live_item_unique"
  ON "market_listings" ("item_kind", "item_ref")
  WHERE status IN ('active', 'pending_settlement');

-- ── market_deed_locks (market-owned; land tables untouched) ──────────────────
CREATE TABLE IF NOT EXISTS "market_deed_locks" (
  "parcel_id" uuid PRIMARY KEY REFERENCES "land_parcels"("id") ON DELETE CASCADE,
  "listing_id" uuid NOT NULL REFERENCES "market_listings"("id") ON DELETE CASCADE,
  "locked_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "market_deed_locks_listing_idx"
  ON "market_deed_locks" ("listing_id");

-- ── market_settlements (the intent ledger — exactly-once per checkout) ───────
CREATE TABLE IF NOT EXISTS "market_settlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "listing_id" uuid NOT NULL REFERENCES "market_listings"("id") ON DELETE CASCADE,
  "checkout_id" uuid NOT NULL REFERENCES "x402_checkouts"("id") ON DELETE CASCADE,
  "tx_signature" text NOT NULL,
  "buyer_avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "seller_avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "price_vclaw" integer NOT NULL,
  "usd_cents" integer NOT NULL,
  "usd_basis" numeric(20,6) NOT NULL,
  "clv_buy_queue_id" uuid NOT NULL REFERENCES "clv_buy_queue"("id"),
  "rake_bps" integer NOT NULL,
  "rake_usd" numeric(20,6) NOT NULL,
  "seller_payout_usd" numeric(20,6) NOT NULL,
  "payout_status" market_payout_status NOT NULL DEFAULT 'pending_review',
  "seller_payout_pubkey" varchar(64),
  "deed_transferred_at" timestamp with time zone,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "market_settlements_price_vclaw_positive" CHECK ("price_vclaw" > 0),
  CONSTRAINT "market_settlements_usd_cents_positive" CHECK ("usd_cents" > 0),
  CONSTRAINT "market_settlements_rake_bps_range" CHECK ("rake_bps" >= 0 AND "rake_bps" <= 10000),
  -- CONSERVATION: the rake + payout intents split the settled dollars EXACTLY.
  CONSTRAINT "market_settlements_conservation" CHECK ("rake_usd" + "seller_payout_usd" = "usd_basis")
);

CREATE UNIQUE INDEX IF NOT EXISTS "market_settlements_checkout_unique"
  ON "market_settlements" ("checkout_id");

CREATE INDEX IF NOT EXISTS "market_settlements_listing_idx"
  ON "market_settlements" ("listing_id");

CREATE INDEX IF NOT EXISTS "market_settlements_payout_review_idx"
  ON "market_settlements" ("payout_status", "created_at");
