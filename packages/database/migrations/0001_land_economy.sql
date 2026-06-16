-- ============================================================================
-- 0001_land_economy.sql — Land Economy Phase 0 (the FIRST GATED migration)
-- ============================================================================
--
-- Brings PROD's schema to PARITY with the proven STAGING land schema (which was
-- itself built by `drizzle-kit generate` from packages/database/src/schema/land.ts):
-- 9 enums + 8 additive tables + their indexes / FKs / unique constraints.
--
-- PROPERTIES (this is a CI deploy GATE — correctness is paramount):
--   * IDEMPOTENT — every statement is guarded (enum: DO/EXCEPTION duplicate_object;
--     table: CREATE TABLE IF NOT EXISTS; index: CREATE [UNIQUE] INDEX IF NOT EXISTS).
--     Running it on STAGING where these objects already exist is a TOTAL NO-OP;
--     running it on PROD where they are absent does the real CREATE.
--   * ADDITIVE-ONLY — NEW enums + NEW tables only. NEVER alters/drops/renames any
--     pre-existing object. References ONLY the already-present base tables
--     "avatars"("id") + "users"("id") as FK targets. NEVER touches Eliza tables.
--   * FK-DEPENDENCY ORDER — parent-before-child so inline FKs always resolve:
--       land_parcels -> land_structures -> land_upgrades -> land_transactions
--       -> service_listings -> service_purchases -> partner_storefronts -> ct_topups
--
-- CONSTRAINT NAMING — load-bearing for drift-prevention. drizzle-kit renders a
-- column .unique() as CONSTRAINT "<table>_<col>_unique" and a .references() as
-- CONSTRAINT "<table>_<col>_<reftable>_<refcol>_fk". An UNNAMED inline UNIQUE /
-- REFERENCES makes Postgres auto-name "<table>_<col>_key" / "<table>_<col>_fkey",
-- which would NOT match drizzle's expectation and make `drizzle-kit push` churn
-- DROP/ADD on every run = drift forever. Every UNIQUE + FK below is therefore
-- explicitly NAMED to drizzle's convention. All names were VERIFIED byte-for-byte
-- against the live drizzle-built STAGING DB via an isolated scratch-schema diff
-- (2026-06-16): applying this file fresh reproduces staging's schema EXACTLY.
--
-- NOTE — two CHECK constraints intentionally OMITTED. land.ts declares
-- `land_structure_level_range` (level BETWEEN 1 AND 5) and
-- `service_listings_price_non_negative` (price_ct >= 0), but drizzle-kit 0.24.x
-- does NOT emit CHECK constraints, so the proven STAGING schema does not have
-- them either. To keep this a pure PARITY migration (prod-fresh == staging-now,
-- zero divergence), they are omitted here. Both bounds are already enforced in
-- app code (server-clamped level; server-authoritative price). If we later want
-- the DB-level guards, add them to BOTH dbs via a dedicated forward migration
-- (0002_land_check_constraints.sql) — not by editing this immutable file.
--
-- Physical base-table names verified against the live DB: "avatars" (plural) +
-- "users".
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUMS (9) — CREATE TYPE has no IF NOT EXISTS, so guard each with the
-- duplicate_object idempotency pattern.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "land_tier" AS ENUM ('starter', 'c', 'b', 'a', 'founder');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "land_parcel_status" AS ENUM ('available', 'owned', 'reserved', 'retired');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "land_structure_type" AS ENUM ('home', 'shop');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "land_transaction_kind" AS ENUM (
    'parcel_purchase',
    'structure_placement',
    'structure_upgrade',
    'service_sale',
    'parcel_resale',
    'rent_payment',
    'property_tax',
    'upkeep',
    'service_rake'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "service_listing_kind" AS ENUM ('peer', 'partner');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "service_listing_status" AS ENUM ('active', 'paused', 'delisted');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "partner_storefront_status" AS ENUM ('pending', 'active', 'suspended');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ct_topup_rail" AS ENUM ('x402', 'stripe', 'clv');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ct_topup_status" AS ENUM ('pending', 'settled', 'failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. land_parcels — fixed concentric supply (DB-authoritative ownership)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "land_parcels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parcel_code" varchar(32) NOT NULL,
  "tier" "land_tier" NOT NULL,
  "status" "land_parcel_status" NOT NULL DEFAULT 'available',
  "grid_x" integer NOT NULL,
  "grid_y" integer NOT NULL,
  "price_ct" integer,
  "owner_avatar_id" uuid CONSTRAINT "land_parcels_owner_avatar_id_avatars_id_fk" REFERENCES "avatars"("id") ON DELETE SET NULL,
  "acquired_at" timestamp with time zone,
  "nft_mint_address" varchar(64),
  "nft_owner_pubkey" varchar(64),
  "nft_minted_at" timestamp with time zone,
  "last_tax_paid_at" timestamp with time zone,
  "upkeep_due_at" timestamp with time zone,
  "rake_bps" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "land_parcels_parcel_code_unique" UNIQUE ("parcel_code")
);

CREATE INDEX IF NOT EXISTS "land_parcels_tier_status_idx"
  ON "land_parcels" ("tier", "status");
CREATE INDEX IF NOT EXISTS "land_parcels_owner_idx"
  ON "land_parcels" ("owner_avatar_id");
CREATE UNIQUE INDEX IF NOT EXISTS "land_parcels_grid_unique"
  ON "land_parcels" ("grid_x", "grid_y");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. land_structures — placed home/shop (one per parcel in v1)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "land_structures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parcel_id" uuid NOT NULL CONSTRAINT "land_structures_parcel_id_land_parcels_id_fk" REFERENCES "land_parcels"("id") ON DELETE CASCADE,
  "owner_avatar_id" uuid NOT NULL CONSTRAINT "land_structures_owner_avatar_id_avatars_id_fk" REFERENCES "avatars"("id") ON DELETE CASCADE,
  "structure_type" "land_structure_type" NOT NULL,
  "catalog_key" varchar(64) NOT NULL,
  "level" integer NOT NULL DEFAULT 1,
  "decay_level" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "land_structures_parcel_id_unique" UNIQUE ("parcel_id")
);

CREATE INDEX IF NOT EXISTS "land_structures_owner_idx"
  ON "land_structures" ("owner_avatar_id");
CREATE INDEX IF NOT EXISTS "land_structures_type_idx"
  ON "land_structures" ("structure_type");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. land_upgrades — append-only audit of each Lv->Lv upgrade
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "land_upgrades" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "structure_id" uuid NOT NULL CONSTRAINT "land_upgrades_structure_id_land_structures_id_fk" REFERENCES "land_structures"("id") ON DELETE CASCADE,
  "from_level" integer NOT NULL,
  "to_level" integer NOT NULL,
  "cost_ct" integer NOT NULL,
  "by_avatar_id" uuid NOT NULL CONSTRAINT "land_upgrades_by_avatar_id_avatars_id_fk" REFERENCES "avatars"("id") ON DELETE CASCADE,
  "ledger_tx_id" uuid,
  "idempotency_key" varchar(64),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "land_upgrades_structure_idx"
  ON "land_upgrades" ("structure_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "land_upgrades_idem_unique"
  ON "land_upgrades" ("idempotency_key")
  WHERE idempotency_key IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. land_transactions — land-domain audit spine (parcel/structure moves)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "land_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" "land_transaction_kind" NOT NULL,
  "parcel_id" uuid CONSTRAINT "land_transactions_parcel_id_land_parcels_id_fk" REFERENCES "land_parcels"("id") ON DELETE SET NULL,
  "structure_id" uuid CONSTRAINT "land_transactions_structure_id_land_structures_id_fk" REFERENCES "land_structures"("id") ON DELETE SET NULL,
  "avatar_id" uuid CONSTRAINT "land_transactions_avatar_id_avatars_id_fk" REFERENCES "avatars"("id") ON DELETE SET NULL,
  "amount_ct" integer NOT NULL,
  "debit_ledger_tx_id" uuid,
  "credit_ledger_tx_id" uuid,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "land_tx_parcel_idx"
  ON "land_transactions" ("parcel_id", "created_at");
CREATE INDEX IF NOT EXISTS "land_tx_avatar_idx"
  ON "land_transactions" ("avatar_id", "created_at");
CREATE INDEX IF NOT EXISTS "land_tx_kind_idx"
  ON "land_transactions" ("kind", "created_at");

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. service_listings — owner shop services (payments naming, §6.C1)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "service_listings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "structure_id" uuid NOT NULL CONSTRAINT "service_listings_structure_id_land_structures_id_fk" REFERENCES "land_structures"("id") ON DELETE CASCADE,
  "owner_avatar_id" uuid NOT NULL CONSTRAINT "service_listings_owner_avatar_id_avatars_id_fk" REFERENCES "avatars"("id") ON DELETE CASCADE,
  "kind" "service_listing_kind" NOT NULL DEFAULT 'peer',
  "title" varchar(120) NOT NULL,
  "description" text,
  "price_ct" integer NOT NULL,
  "status" "service_listing_status" NOT NULL DEFAULT 'active',
  "platform_fee_bps" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "service_listings_structure_idx"
  ON "service_listings" ("structure_id");
CREATE INDEX IF NOT EXISTS "service_listings_owner_idx"
  ON "service_listings" ("owner_avatar_id");
CREATE INDEX IF NOT EXISTS "service_listings_status_idx"
  ON "service_listings" ("status");

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. service_purchases — per-purchase row (one per settled service buy)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "service_purchases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "listing_id" uuid NOT NULL CONSTRAINT "service_purchases_listing_id_service_listings_id_fk" REFERENCES "service_listings"("id") ON DELETE CASCADE,
  "buyer_avatar_id" uuid NOT NULL CONSTRAINT "service_purchases_buyer_avatar_id_avatars_id_fk" REFERENCES "avatars"("id") ON DELETE CASCADE,
  "seller_avatar_id" uuid NOT NULL CONSTRAINT "service_purchases_seller_avatar_id_avatars_id_fk" REFERENCES "avatars"("id") ON DELETE CASCADE,
  "price_ct" integer NOT NULL,
  "land_transaction_id" uuid CONSTRAINT "service_purchases_land_transaction_id_land_transactions_id_fk" REFERENCES "land_transactions"("id") ON DELETE SET NULL,
  "idempotency_key" varchar(64),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "service_purchases_listing_idx"
  ON "service_purchases" ("listing_id", "created_at");
CREATE INDEX IF NOT EXISTS "service_purchases_buyer_idx"
  ON "service_purchases" ("buyer_avatar_id", "created_at");
CREATE INDEX IF NOT EXISTS "service_purchases_seller_idx"
  ON "service_purchases" ("seller_avatar_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "service_purchases_idem_unique"
  ON "service_purchases" ("idempotency_key")
  WHERE idempotency_key IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. partner_storefronts — vetted-partner tier (INERT in v1, payments shape §6.C1)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "partner_storefronts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_id" varchar(64) NOT NULL,
  "slug" varchar(64) NOT NULL,
  "display_name" varchar(120) NOT NULL,
  "parcel_id" uuid CONSTRAINT "partner_storefronts_parcel_id_land_parcels_id_fk" REFERENCES "land_parcels"("id") ON DELETE SET NULL,
  "payout_pubkey" varchar(64) NOT NULL,
  "status" "partner_storefront_status" NOT NULL DEFAULT 'pending',
  "platform_fee_bps" integer NOT NULL DEFAULT 0,
  "fulfillment_enabled" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "partner_storefronts_slug_unique" UNIQUE ("slug")
);

CREATE INDEX IF NOT EXISTS "partner_storefronts_partner_idx"
  ON "partner_storefronts" ("partner_id");

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. ct_topups — the SINGLE buy-CT surface (§6.C2)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ct_topups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "avatar_id" uuid NOT NULL CONSTRAINT "ct_topups_avatar_id_avatars_id_fk" REFERENCES "avatars"("id") ON DELETE CASCADE,
  "user_id" uuid CONSTRAINT "ct_topups_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE SET NULL,
  "rail" "ct_topup_rail" NOT NULL,
  "amount_ct" integer NOT NULL,
  "tx_signature" text,
  "usd_basis_at_receipt" numeric,
  "status" "ct_topup_status" NOT NULL DEFAULT 'pending',
  "idempotency_key" varchar(64),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ct_topups_avatar_idx"
  ON "ct_topups" ("avatar_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "ct_topups_txsig_unique"
  ON "ct_topups" ("tx_signature")
  WHERE tx_signature IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ct_topups_idem_unique"
  ON "ct_topups" ("avatar_id", "idempotency_key")
  WHERE idempotency_key IS NOT NULL;
