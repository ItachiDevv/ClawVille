-- Land P2 tenure core. Idempotent DDL; migrate-ci applies the file atomically.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "land_hold_wallet_pubkey" varchar(44);
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "land_hold_wallet_declared_at" timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS "users_land_hold_wallet_pubkey_unique"
  ON "users" ("land_hold_wallet_pubkey")
  WHERE "land_hold_wallet_pubkey" IS NOT NULL;

ALTER TABLE "land_parcels"
  ADD COLUMN IF NOT EXISTS "tenure_terms_version" smallint;

-- Existing tenancies remain in place with their existing money/state terms.
UPDATE "land_parcels"
SET "tenure_terms_version" = 1
WHERE "tenure" IS NOT NULL AND "tenure_terms_version" IS NULL;

ALTER TABLE "land_parcels"
  DROP CONSTRAINT IF EXISTS "land_parcels_tenure_terms_version_valid";
ALTER TABLE "land_parcels"
  ADD CONSTRAINT "land_parcels_tenure_terms_version_valid"
  CHECK (
    ("tenure" IS NULL AND "tenure_terms_version" IS NULL)
    OR (
      "tenure" IS NOT NULL
      AND "tenure_terms_version" IS NOT NULL
      AND "tenure_terms_version" IN (1, 2)
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'land_parcels_tenure_escrow_shape'
      AND conrelid = 'land_parcels'::regclass
  ) THEN
    ALTER TABLE "land_parcels"
      ADD CONSTRAINT "land_parcels_tenure_escrow_shape"
      CHECK (
        "tenure_terms_version" <> 2
        OR "tenure" <> 'deposit'
        OR (
          "deposit_remaining_ct" IS NOT NULL
          AND "deposit_remaining_ct" >= 0
          AND "rent_ct_weekly" IS NOT NULL
          AND "rent_ct_weekly" > 0
        )
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "land_tenure_settlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "avatar_id" uuid NOT NULL REFERENCES "avatars"("id") ON DELETE CASCADE,
  "operation" varchar(32) NOT NULL,
  "idempotency_key" varchar(64),
  "fingerprint" text NOT NULL,
  "response" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "land_tenure_settlements_avatar_idem_unique"
  ON "land_tenure_settlements" ("avatar_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "land_tenure_settlements_release_parcel_created_idx"
  ON "land_tenure_settlements"
  (("response" -> 'parcel' ->> 'parcelCode'), "created_at" DESC, "id" DESC)
  WHERE "operation" = 'tenure_release';
