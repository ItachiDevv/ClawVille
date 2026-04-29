-- Audit-fix 2026-04-29 — change cosmetic_variants.sku_id and avatar_skins.sku_id
-- foreign keys from CASCADE to RESTRICT. A SKU should never be hard-deleted
-- while owners or variants reference it; retire via `available_until` instead.

-- 1. cosmetic_variants.sku_id
ALTER TABLE "cosmetic_variants"
  DROP CONSTRAINT IF EXISTS "cosmetic_variants_sku_id_cosmetic_skus_id_fk";

ALTER TABLE "cosmetic_variants"
  ADD CONSTRAINT "cosmetic_variants_sku_id_cosmetic_skus_id_fk"
  FOREIGN KEY ("sku_id") REFERENCES "public"."cosmetic_skus"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- 2. avatar_skins.sku_id
ALTER TABLE "avatar_skins"
  DROP CONSTRAINT IF EXISTS "pet_skins_sku_id_cosmetic_skus_id_fk";

ALTER TABLE "avatar_skins"
  ADD CONSTRAINT "pet_skins_sku_id_cosmetic_skus_id_fk"
  FOREIGN KEY ("sku_id") REFERENCES "public"."cosmetic_skus"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
