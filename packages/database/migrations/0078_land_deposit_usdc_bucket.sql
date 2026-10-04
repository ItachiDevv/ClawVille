-- 0078_land_deposit_usdc_bucket.sql — security pass 2026-10-04 (M8, Codex review).
--
-- ADDITIVE + IDEMPOTENT. Adds one column and two named CHECKs to land_parcels.
-- It drops, renames or rewrites no existing column, index, constraint or row
-- value, and it backfills nothing. The file runs as one implicit transaction,
-- so a failure applies nothing. NEVER apply via drizzle-kit push.
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
-- refunds the rest. The split never reads land_transactions.
--
-- NO BACKFILL (Codex round 2, 2026-10-04). A backfill from old
-- land_deposit_prepay_usdc rows is wrong in both directions: it cannot know
-- which part of an old prepay a later rent draw consumed (100 vCLAW + 100 USDC
-- in escrow, a 100 draw takes the USDC, a backfill then marks the remaining
-- 100 vCLAW as USDC-funded and release forfeits vCLAW), and a rerun refills a
-- bucket that a valid draw emptied. Instead every existing row starts at 0,
-- and the rent-prepay fulfiller stamps each NEW land_deposit_prepay_usdc row
-- with metadata usdcBucketed = true. A release whose current tenancy has a
-- prepay row WITHOUT that marker (a pre-bucket row: split unprovable) refuses
-- with 409 usdc_prepay_unproven, and an operator settles it.
-- Measured 2026-10-04: prod has 0 land_deposit_prepay_usdc rows, staging 3
-- (test data). The USDC prepay path is dark, so no new unmarked row can appear
-- before this ships.
--
-- EXISTING ROWS: the column arrives as 0 on every row, so both CHECKs hold for
-- every existing row: "0 >= 0", and the second CHECK's first arm is
-- "deposit_usdc_funded_ct = 0". A rerun changes nothing: the column and both
-- constraints are guarded by IF NOT EXISTS / pg_constraint lookups.
--
-- LOCKS + VALIDATION (Codex round 3 hygiene). migrate-ci.ts sends the whole
-- file as ONE simple-query message (postgres.js unsafe() with no parameters),
-- which PostgreSQL runs as one implicit transaction, so SET LOCAL bounds every
-- lock wait in this file to 5 s and ends with the file. A timeout fails the
-- file, rolls it back whole, and the CI migrate job fails; a rerun is safe.
-- Each CHECK is added NOT VALID (no table scan under the ADD) and then
-- VALIDATEd (scans land_parcels: about 56-74 rows on each box). Inside this one
-- transaction the ADD COLUMN lock is held to the end anyway, so the lock
-- timeout is the real bound; at this table size the scan is short. Each step has
-- its own pg_constraint guard: the ADD runs only when the constraint is
-- missing, the VALIDATE only while it is not yet validated. After the file
-- both constraints are validated, and a rerun changes nothing.

SET LOCAL lock_timeout = '5s';

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
      CHECK ("deposit_usdc_funded_ct" >= 0) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'land_parcels_deposit_usdc_funded_nonneg'
      AND conrelid = 'land_parcels'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE "land_parcels"
      VALIDATE CONSTRAINT "land_parcels_deposit_usdc_funded_nonneg";
  END IF;
END $$;

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
      ) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'land_parcels_deposit_usdc_funded_within_remaining'
      AND conrelid = 'land_parcels'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE "land_parcels"
      VALIDATE CONSTRAINT "land_parcels_deposit_usdc_funded_within_remaining";
  END IF;
END $$;
