-- Land gamification P4b: the material ledger foundation. Idempotent DDL; migrate-ci applies the file atomically.
--
-- Materials are the non-cashable, sink-only build currency the land loop earns
-- and spends. They are deliberately NOT vCLAW: there is one pooled balance per
-- avatar (founder ruling Q4), no provenance tags, no exit rail, and no
-- leaderboard weight. `salvage_claim_receipts` ships now even though the
-- salvage loop activates in a later slice, so the receipt contract is frozen
-- before any claim path can write to it.

CREATE TABLE IF NOT EXISTS "avatar_material_balances" (
  "avatar_id"  uuid PRIMARY KEY REFERENCES "avatars"("id") ON DELETE CASCADE,
  "quantity"   integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "avatar_material_balances"
  DROP CONSTRAINT IF EXISTS "avatar_material_nonneg";
ALTER TABLE "avatar_material_balances"
  ADD CONSTRAINT "avatar_material_nonneg" CHECK ("quantity" >= 0);

CREATE TABLE IF NOT EXISTS "salvage_claim_receipts" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "avatar_id"         uuid    NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "idempotency_key"   text    NOT NULL,
  -- STABLE canonical request fields ONLY. `claim_ordinal` is server-derived
  -- after the cooldown check, is unavailable at the receipt-lookup step, and
  -- changes after any later cooldown claim — so it is RECORDED, never COMPARED.
  "fingerprint"       text    NOT NULL,
  "node_id"           text    NOT NULL,
  "layout_version"    integer NOT NULL,
  "claim_ordinal"     integer NOT NULL,
  "materials_granted" integer NOT NULL,
  -- Display flavour only. There is ONE pooled balance (Q4); flavour never
  -- splits it into separate ledgers.
  "flavour"           text    NOT NULL,
  "response"          jsonb   NOT NULL,
  "created_at"        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "salvage_claim_receipts"
  DROP CONSTRAINT IF EXISTS "salvage_receipt_amount";
ALTER TABLE "salvage_claim_receipts"
  ADD CONSTRAINT "salvage_receipt_amount" CHECK ("materials_granted" BETWEEN 1 AND 3);

ALTER TABLE "salvage_claim_receipts"
  DROP CONSTRAINT IF EXISTS "salvage_receipt_flavour";
ALTER TABLE "salvage_claim_receipts"
  ADD CONSTRAINT "salvage_receipt_flavour"
  CHECK ("flavour" IN ('common', 'uncommon', 'rare'));

CREATE UNIQUE INDEX IF NOT EXISTS "salvage_receipt_uniq"
  ON "salvage_claim_receipts" ("avatar_id", "idempotency_key");

CREATE INDEX IF NOT EXISTS "salvage_receipt_history"
  ON "salvage_claim_receipts" ("avatar_id", "created_at" DESC);
