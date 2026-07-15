-- 0032_cosmetic_sold_count.sql
-- Make cosmetic supply caps enforceable under concurrent purchases.
-- ADDITIVE + IDEMPOTENT ONLY; applied by the CI migration gate, never db:push.

ALTER TABLE "cosmetic_skus"
  ADD COLUMN IF NOT EXISTS "sold_count" integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "idx_avatar_skins_sku_id"
  ON "avatar_skins" ("sku_id");

-- Database-bound inventory claim. AFTER INSERT means ON CONFLICT DO NOTHING
-- retries do not consume stock. The UPDATE row-lock serializes every writer on
-- its SKU, including old application pods that know nothing about sold_count.
-- Raising aborts the ownership insert and its surrounding money transaction.
CREATE OR REPLACE FUNCTION clawville_claim_cosmetic_supply()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE cosmetic_skus
  SET sold_count = sold_count + 1
  WHERE id = NEW.sku_id
    AND (supply_cap IS NULL OR sold_count < supply_cap);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cosmetic_sold_out'
      USING ERRCODE = '23514',
            CONSTRAINT = 'cosmetic_skus_supply_cap_enforced';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'avatar_skins_claim_supply_after_insert'
      AND tgrelid = 'avatar_skins'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER avatar_skins_claim_supply_after_insert
      AFTER INSERT ON avatar_skins
      FOR EACH ROW
      EXECUTE FUNCTION clawville_claim_cosmetic_supply();
  END IF;
END $$;

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

-- Operator preflight (must return zero rows before staging promotion):
-- SELECT s.id, s.slug, s.supply_cap, COUNT(a.id) AS ownership_count
-- FROM cosmetic_skus s
-- LEFT JOIN avatar_skins a ON a.sku_id = s.id
-- WHERE s.supply_cap IS NOT NULL
-- GROUP BY s.id, s.slug, s.supply_cap
-- HAVING COUNT(a.id) > s.supply_cap;

DO $$ BEGIN
  ALTER TABLE "cosmetic_skus"
    ADD CONSTRAINT "cosmetic_skus_sold_count_nonnegative"
    CHECK ("sold_count" >= 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;
