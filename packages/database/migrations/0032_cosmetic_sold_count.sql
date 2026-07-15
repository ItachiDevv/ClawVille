-- 0032_cosmetic_sold_count.sql
-- Make cosmetic supply caps enforceable under concurrent purchases.
-- ADDITIVE + IDEMPOTENT ONLY; applied by the CI migration gate, never db:push.

ALTER TABLE "cosmetic_skus"
  ADD COLUMN IF NOT EXISTS "sold_count" integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "idx_avatar_skins_sku_id"
  ON "avatar_skins" ("sku_id");

-- Existing ownership predates sold_count. GREATEST makes this backfill safe to
-- re-run without reducing a count advanced by purchases after the first run.
UPDATE "cosmetic_skus" AS sku
SET "sold_count" = GREATEST(sku."sold_count", owned."ownership_count")
FROM (
  SELECT "sku_id", COUNT(*)::integer AS "ownership_count"
  FROM "avatar_skins"
  GROUP BY "sku_id"
) AS owned
WHERE sku."id" = owned."sku_id"
  AND sku."sold_count" < owned."ownership_count";

DO $$ BEGIN
  ALTER TABLE "cosmetic_skus"
    ADD CONSTRAINT "cosmetic_skus_sold_count_nonnegative"
    CHECK ("sold_count" >= 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;
