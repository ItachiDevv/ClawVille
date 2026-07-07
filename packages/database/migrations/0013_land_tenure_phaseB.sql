-- 0013_land_tenure_phaseB.sql
-- Land tenure Phase B (2026-07-07) — deposit-escrow starters + hold-to-keep c/b/a/founder.
--
-- IDEMPOTENT + ADDITIVE ONLY: enum values, nullable columns, one defaulted
-- boolean, one index swap, one CHECK. NO row rewrites (the grandfather DML
-- lives in apps/api/scripts/migrate-land-tenure-phaseB.ts), NO drops of data.
--
-- ⚠ APPLY MODE: run statement-by-statement in AUTOCOMMIT (plain `psql -f`, or
-- the phaseB script's per-statement client). Do NOT wrap in BEGIN/--single-
-- transaction: `ALTER TYPE ... ADD VALUE` values cannot be USED inside the same
-- transaction that added them, and the partial index below references the new
-- 'deposit'/'hold' values — single-transaction application fails with
-- "unsafe use of new value". (Same rule as migrate-land-tenure.ts's DDL.)

-- ── enum values (each its own autocommit statement — see header) ────────────
ALTER TYPE land_tenure ADD VALUE IF NOT EXISTS 'deposit';
ALTER TYPE land_tenure ADD VALUE IF NOT EXISTS 'hold';
ALTER TYPE land_transaction_kind ADD VALUE IF NOT EXISTS 'land_deposit_escrow';
ALTER TYPE land_transaction_kind ADD VALUE IF NOT EXISTS 'land_deposit_topup';
ALTER TYPE land_transaction_kind ADD VALUE IF NOT EXISTS 'land_deposit_refund';
ALTER TYPE land_transaction_kind ADD VALUE IF NOT EXISTS 'hold_claim';

-- ── new enum type (duplicate-safe) ───────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE land_hold_subject AS ENUM ('user', 'agent');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── land_parcels Phase-B columns (all additive) ──────────────────────────────
-- deposit_ct            B1: the ORIGINAL claim deposit (immutable; top-ups grow
--                       the remainder, not this).
-- deposit_remaining_ct  B1: live escrow remainder. INVARIANT: Σ draws + refund
--                       + forfeit == claim + Σ top-ups; never negative (CHECK
--                       below). The CT counted here exists in NO avatar balance
--                       while escrowed — this column is its sole record.
-- hold_threshold_ct     B2: stamped CLV threshold (CLV uiAmount, NOT atomic —
--                       the `_ct` suffix is the land-column convention only).
-- hold_subject          B2: whose CLV backs the hold ('user' linked wallet /
--                       'agent' custodial avatars.wallet_address).
-- grandfathered         TRUE = legacy buy-outright row migrated to 'hold';
--                       pays upkeep, never CLV-checked, excluded from sums.
ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS deposit_ct integer;
ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS deposit_remaining_ct integer;
ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS hold_threshold_ct integer;
ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS hold_subject land_hold_subject;
ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS grandfathered boolean NOT NULL DEFAULT false;

-- ── escrow-conservation DB backstop (named CHECK, duplicate-safe) ────────────
DO $$ BEGIN
  ALTER TABLE land_parcels ADD CONSTRAINT land_parcels_deposit_remaining_nonneg
    CHECK (deposit_remaining_ct IS NULL OR deposit_remaining_ct >= 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── sweep index swap: rented-only → rented+deposit+hold ─────────────────────
-- The new partial index references enum values added ABOVE, so this statement
-- MUST run in a later autocommit statement than the ALTER TYPEs (see header).
DROP INDEX IF EXISTS land_parcels_rent_sweep_idx;
CREATE INDEX IF NOT EXISTS land_parcels_tenure_sweep_idx
  ON land_parcels (rent_paid_through)
  WHERE tenure IN ('rented', 'deposit', 'hold');
