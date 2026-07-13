-- 0025_bounty_rail_ct_to_vclaw.sql
-- Bounty micro-denomination (2026-07-12): rename the legacy in-game rail label
-- to `vclaw`. The reward amount remains an integer count of vCLAW, where
-- 1 vCLAW = $0.01; no balance or reward rows are rescaled by this migration.
--
-- GUARDED + IDEMPOTENT: migrate-ci already checksum-tracks this file. The marker
-- is defense-in-depth for a manual application, while the enum-state checks also
-- let a partially/manual-renamed database converge safely. Impossible states fail
-- loud rather than silently leaving the application and database out of parity.
-- PostgreSQL enum label rename is transactional and rewrites the label in place,
-- so existing rows preserve their enum identity and atomically read as `vclaw`.

CREATE TABLE IF NOT EXISTS "tokenomics_migrations" (
  "id" text PRIMARY KEY,
  "applied_at" timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  has_legacy_label boolean;
  has_vclaw_label boolean;
BEGIN
  IF EXISTS (
    SELECT 1 FROM tokenomics_migrations
    WHERE id = 'bounty_rail_ct_to_vclaw'
  ) THEN
    RAISE NOTICE 'bounty_rail_ct_to_vclaw already applied — skipping';
  ELSE
    IF to_regclass('public.bounties') IS NULL THEN
      RAISE EXCEPTION '0025: required table public.bounties is missing';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bounty_payment_rail') THEN
      RAISE EXCEPTION '0025: required enum bounty_payment_rail is missing';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'bounty_payment_rail' AND e.enumlabel = 'ct'
    ) INTO has_legacy_label;

    SELECT EXISTS (
      SELECT 1
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'bounty_payment_rail' AND e.enumlabel = 'vclaw'
    ) INTO has_vclaw_label;

    IF has_legacy_label AND NOT has_vclaw_label THEN
      ALTER TYPE bounty_payment_rail RENAME VALUE 'ct' TO 'vclaw';
    ELSIF NOT has_legacy_label AND has_vclaw_label THEN
      RAISE NOTICE '0025: enum label already renamed — converging default/rows';
    ELSE
      RAISE EXCEPTION
        '0025: invalid bounty_payment_rail labels (legacy=%, vclaw=%)',
        has_legacy_label, has_vclaw_label;
    END IF;

    ALTER TABLE bounties
      ALTER COLUMN payment_rail SET DEFAULT 'vclaw'::bounty_payment_rail;

    -- The enum rename above already converts every legacy row in place. Keep the
    -- frozen-spec UPDATE explicitly: it is an idempotent no-op after the rename.
    UPDATE bounties
      SET payment_rail = 'vclaw'::bounty_payment_rail
      WHERE payment_rail::text = 'ct';

    INSERT INTO tokenomics_migrations (id)
      VALUES ('bounty_rail_ct_to_vclaw');
    RAISE NOTICE 'bounty_rail_ct_to_vclaw applied';
  END IF;
END $$;
