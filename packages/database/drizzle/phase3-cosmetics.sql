-- Q3 plan §4 — cosmetic engine schema (cosmetic_skus + cosmetic_variants + pet_skins).
-- Applied 2026-04-29 against prod Supabase (out-of-band from drizzle-kit
-- because the migrate folder is out of sync with prod state — repo uses
-- db:push, not migration files, per CLAUDE.md).

-- 1. cosmetic_skus — the catalog. One row per purchasable item.
CREATE TABLE IF NOT EXISTS "cosmetic_skus" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "category" text NOT NULL,
  "scope" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text,
  "rarity" text NOT NULL,
  "price_ct" integer NOT NULL,
  "exclusive_currency" text,
  "attribution" text,
  "attribution_url" text,
  "license_spdx" text,
  "available_from" timestamp with time zone,
  "available_until" timestamp with time zone,
  "supply_cap" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_cosmetic_skus_scope" ON "cosmetic_skus" USING btree ("scope");
CREATE INDEX IF NOT EXISTS "idx_cosmetic_skus_avail_until" ON "cosmetic_skus" USING btree ("available_until");

-- 2. cosmetic_variants — per-rig assets.
CREATE TABLE IF NOT EXISTS "cosmetic_variants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sku_id" uuid NOT NULL,
  "rig_type" text NOT NULL,
  "asset_url" text NOT NULL,
  "asset_meta" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "cosmetic_variants"
  ADD CONSTRAINT "cosmetic_variants_sku_id_cosmetic_skus_id_fk"
  FOREIGN KEY ("sku_id") REFERENCES "public"."cosmetic_skus"("id")
  ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cosmetic_variant_sku_rig"
  ON "cosmetic_variants" USING btree ("sku_id", "rig_type");

-- 3. pet_skins — ownership ledger.
CREATE TABLE IF NOT EXISTS "pet_skins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pet_id" uuid NOT NULL,
  "sku_id" uuid NOT NULL,
  "acquired_via" text NOT NULL,
  "ledger_id" uuid,
  "equipped" boolean DEFAULT false NOT NULL,
  "acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "equipped_at" timestamp with time zone
);

DO $$ BEGIN
  ALTER TABLE "pet_skins"
  ADD CONSTRAINT "pet_skins_pet_id_pets_id_fk"
  FOREIGN KEY ("pet_id") REFERENCES "public"."pets"("id")
  ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "pet_skins"
  ADD CONSTRAINT "pet_skins_sku_id_cosmetic_skus_id_fk"
  FOREIGN KEY ("sku_id") REFERENCES "public"."cosmetic_skus"("id")
  ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_pet_skin_pet_sku" ON "pet_skins" USING btree ("pet_id", "sku_id");
CREATE INDEX IF NOT EXISTS "idx_pet_skin_pet_equipped" ON "pet_skins" USING btree ("pet_id", "equipped");
