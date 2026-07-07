-- 0011_redenominate_ct_x10.sql
-- Tokenomics Phase A / Slice A3 (2026-07-07) — ¢-peg redenomination.
--
-- Multiply ALL CT-denominated BALANCES ×10 so 1 vCLAW = $0.01 (was $0.10 at the
-- F2 rate). Purchasing power is IDENTICAL — a coin is now worth 1¢ and there are
-- 10× as many of them. Shipped in lockstep with CT_PER_USDC 10→100 (x402-payai.ts)
-- and the price re-bands (this + 0012). Prices that must KEEP purchasing power are
-- ×10'd here too; prices the re-band sets to new absolute values are EXCEPTED
-- (cosmetics → 0012; rent → left at its already-target band; c/b/a land → left,
-- deprecated for Phase B).
--
-- ── GUARDED: the ×10 runs EXACTLY ONCE ───────────────────────────────────────
-- migrate-ci already tracks applied files by checksum (won't re-run 0011). This
-- in-SQL marker is DEFENSE-IN-DEPTH against a MANUAL apply (psql / an apply-*.ts
-- script): a double ×10 would 100× every balance — catastrophic — so the DO block
-- no-ops if the marker row already exists. Money migration: it does NOT
-- to_regclass-guard the core tables — if avatars/grants/land are somehow absent it
-- FAILS LOUD (blocks the deploy) rather than doing a silent partial redenomination.
--
-- The whole file runs as ONE implicit transaction (migrate-ci simple-query), so
-- the ×10 + the DEFAULT flip + the marker commit atomically or not at all.

CREATE TABLE IF NOT EXISTS "tokenomics_migrations" (
  "id" text PRIMARY KEY,
  "applied_at" timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tokenomics_migrations WHERE id = 'redenominate_ct_x10') THEN
    RAISE NOTICE 'redenominate_ct_x10 already applied — skipping the x10 pass';
  ELSE
    -- 1) Avatar balances ×10 — all four columns in ONE UPDATE so the immediate
    --    avatars_vclaw_balance_sum CHECK sees a consistent row:
    --    10*claw = 10*soft + 10*bought + 10*earned  (holds because claw = sum).
    UPDATE avatars SET
      claw_tokens    = claw_tokens    * 10,
      soft_balance   = soft_balance   * 10,
      bought_balance = bought_balance * 10,
      earned_balance = earned_balance * 10;

    -- 2) Cosmetics-scoped signup-bonus grants ×10 (same era shift). The code
    --    constant SIGNUP_BONUS_COSMETIC_CT flips 50→500 in this same A3 commit, so
    --    pre-migration grants (50) → 500 AND post-migration grants mint 500 —
    --    every account lands at 500 units = $5.
    UPDATE cosmetic_bonus_grants SET
      amount_granted   = amount_granted   * 10,
      amount_remaining = amount_remaining * 10;

    -- 3) Land STARTER parcel prices ×10 (keep the $15 purchasing power; matches the
    --    re-banded LAND_TIER_LADDER starter 0→1500). C/B/A/founder price_ct are
    --    LEFT (founder: irrelevant — Phase B replaces buy-outright with CLV
    --    claim-locks); rent_ct_weekly is LEFT (already the founder's target band, so
    --    the re-band = no numeric change for rent). Guard price_ct IS NOT NULL
    --    (founder-tier rows carry NULL).
    UPDATE land_parcels SET price_ct = price_ct * 10
      WHERE tier = 'starter' AND price_ct IS NOT NULL;

    -- 4) New-account starting-balance DEFAULT ×10 (100→1000) so accounts created
    --    AFTER this migration start at the same $10 value as pre-migration accounts
    --    whose 100 was just ×10'd. Both columns together (the CHECK needs the two
    --    defaults to match: claw_tokens default 1000 = soft default 1000 + 0 + 0).
    ALTER TABLE avatars ALTER COLUMN claw_tokens SET DEFAULT 1000;
    ALTER TABLE avatars ALTER COLUMN soft_balance SET DEFAULT 1000;

    INSERT INTO tokenomics_migrations (id) VALUES ('redenominate_ct_x10');
    RAISE NOTICE 'redenominate_ct_x10 applied — balances/grants/starter-land x10, avatar defaults 1000';
  END IF;
END $$;
