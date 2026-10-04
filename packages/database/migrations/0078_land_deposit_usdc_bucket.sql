-- 0078_land_deposit_usdc_bucket.sql — security pass 2026-10-04 (M8, Codex review).
--
-- ADDITIVE + IDEMPOTENT. Adds one column and two named CHECKs to land_parcels,
-- and backfills the column for live deposit tenancies. It drops, renames or
-- rewrites no existing column, index, constraint or row value other than the
-- new column. The file runs as one implicit transaction, so a failure applies
-- nothing. NEVER apply via drizzle-kit push.
--
-- WHY: founder decision M8 (2026-10-04): USDC rent prepay is NON-REFUNDABLE.
-- On a voluntary release the USDC-funded part of the deposit escrow is
-- forfeited with no ledger credit; only the vCLAW-funded part refunds. The
-- first implementation found the USDC part by replaying land_transactions in
-- created_at order. Codex blocked it: now() is the transaction START time, so
-- a prepay can sort before a rent draw that committed first, and a missing or
-- odd audit row still produced a vCLAW refund.
--
-- NEW MODEL: land_parcels.deposit_usdc_funded_ct is a running balance of the
-- USDC-funded part of deposit_remaining_ct. Code changes it only in the SAME
-- UPDATE that changes deposit_remaining_ct, under the parcel row lock:
--   USDC prepay fulfil   both columns += amount
--   sweeper rent draw    deposit_usdc_funded_ct -= LEAST(draw, deposit_usdc_funded_ct)
--   tenure claim         deposit_usdc_funded_ct = 0 (new tenancy)
--   release/lapse/deed   deposit_usdc_funded_ct = 0 (escrow closed)
-- Release forfeits LEAST(deposit_usdc_funded_ct, deposit_remaining_ct) and
-- refunds the rest. Nothing reads land_transactions to decide the split.
--
-- BACKFILL (conservative: it may forfeit more, never less). For each live
-- deposit tenancy: LEAST(deposit_remaining_ct, SUM(amount_ct) of the
-- land_deposit_prepay_usdc rows of the CURRENT tenancy). A row belongs to the
-- current tenancy when its metadata.tenancyAcquiredAt equals the parcel's
-- acquired_at (1 ms tolerance: the stamp is a JavaScript ISO string with
-- millisecond precision, acquired_at has microseconds), or, for a row with no
-- parseable stamp, when created_at >= acquired_at. Draws used USDC first, so
-- the true bucket is <= SUM(prepays), and the result is >= the true bucket.
-- Measured 2026-10-04: prod 0 land_deposit_prepay_usdc rows (no-op), staging
-- 3 (test data). Only rows where the new column is still 0 change, and the
-- migration runner applies a file once, so a rerun cannot double count.

ALTER TABLE "land_parcels"
  ADD COLUMN IF NOT EXISTS "deposit_usdc_funded_ct" integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'land_parcels_deposit_usdc_funded_nonneg'
      AND conrelid = 'land_parcels'::regclass
  ) THEN
    ALTER TABLE "land_parcels"
      ADD CONSTRAINT "land_parcels_deposit_usdc_funded_nonneg"
      CHECK ("deposit_usdc_funded_ct" >= 0);
  END IF;
END $$;

UPDATE "land_parcels" AS p
   SET "deposit_usdc_funded_ct" = LEAST(p."deposit_remaining_ct"::bigint, s.usdc_ct)::integer
  FROM (
    SELECT t."parcel_id", SUM(t."amount_ct")::bigint AS usdc_ct
      FROM "land_transactions" t
      JOIN "land_parcels" lp ON lp."id" = t."parcel_id"
     WHERE t."kind" = 'land_deposit_prepay_usdc'
       AND lp."tenure" = 'deposit'
       AND lp."acquired_at" IS NOT NULL
       AND (
         CASE
           WHEN (t."metadata" ->> 'tenancyAcquiredAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
             THEN (t."metadata" ->> 'tenancyAcquiredAt')::timestamptz
                    BETWEEN lp."acquired_at" - interval '1 millisecond'
                        AND lp."acquired_at" + interval '1 millisecond'
           ELSE t."created_at" >= lp."acquired_at"
         END
       )
     GROUP BY t."parcel_id"
  ) AS s
 WHERE p."id" = s."parcel_id"
   AND p."tenure" = 'deposit'
   AND p."deposit_remaining_ct" IS NOT NULL
   AND p."deposit_usdc_funded_ct" = 0
   AND s.usdc_ct > 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'land_parcels_deposit_usdc_funded_within_remaining'
      AND conrelid = 'land_parcels'::regclass
  ) THEN
    ALTER TABLE "land_parcels"
      ADD CONSTRAINT "land_parcels_deposit_usdc_funded_within_remaining"
      CHECK (
        "deposit_usdc_funded_ct" = 0
        OR (
          "deposit_remaining_ct" IS NOT NULL
          AND "deposit_usdc_funded_ct" <= "deposit_remaining_ct"
        )
      );
  END IF;
END $$;
