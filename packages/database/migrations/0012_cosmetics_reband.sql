-- 0012_cosmetics_reband.sql
-- Tokenomics Phase A / Slice A3 (2026-07-07) — cosmetics USD re-band by rarity.
--
-- The pre-A3 cosmetic prices (200–800 CT) were play-money-era and wrong in USD.
-- Re-band to the founder's $3–15 band by rarity (¢-peg units, $0.01/unit):
--   common 300 ($3) · rare 600 ($6) · epic 1200 ($12) · limited 1500 ($15).
-- Cosmetics are EXCEPTED from the 0011 ×10 (absolute new values, NOT a multiply),
-- so this is a plain idempotent SET — safe to re-run (no marker needed, unlike the
-- ×10 in 0011). The seed scripts (seed-milady/emote-cosmetics.ts) carry the SAME
-- rarity→price map so a fresh seed / re-seed agrees with this migration.
--
-- to_regclass GUARD: cosmetic_skus is NOT created by a numbered migration (it was
-- db:push'd), so on a hypothetical migrate-ci-only fresh DB the table may not exist
-- yet. Skipping the re-band there is harmless (the seed carries the values), so we
-- guard the UPDATE rather than fail — this is a SET (not a multiply), so a skip has
-- zero correctness risk.

DO $$
BEGIN
  IF to_regclass('public.cosmetic_skus') IS NULL THEN
    RAISE NOTICE 'cosmetic_skus absent — skipping the cosmetics re-band (fresh seed will carry the values)';
  ELSE
    UPDATE cosmetic_skus SET price_ct = CASE rarity
      WHEN 'common'  THEN 300
      WHEN 'rare'    THEN 600
      WHEN 'epic'    THEN 1200
      WHEN 'limited' THEN 1500
      ELSE price_ct  -- unknown rarity: leave untouched (never silently mis-price)
    END
    WHERE rarity IN ('common', 'rare', 'epic', 'limited');
    RAISE NOTICE 'cosmetics re-banded by rarity (common 300 / rare 600 / epic 1200 / limited 1500)';
  END IF;
END $$;
