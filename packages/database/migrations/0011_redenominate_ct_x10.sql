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

    -- ── 5-8) REVIEW-FIX (orchestrator review, same day): value-preservation ────
    -- A redenomination must preserve value EVERYWHERE; re-bands change values
    -- DELIBERATELY (0012 / T3). The initial pass missed the columns below.

    -- 5) LEDGER HISTORY — claw_token_transactions is the auditable history and the
    --    DESIGNED replay source for Phase 5+ on-chain opening balances (schema
    --    comment). ×10'd balances with un-×10'd history breaks ledger replay and
    --    balance_after reconciliation forever. Signed amounts: ×10 preserves sign.
    --    usd_basis is DOLLARS — deliberately untouched. Core table: fails loud.
    UPDATE claw_token_transactions SET
      amount        = amount        * 10,
      balance_after = balance_after * 10;

    -- 6) Reward columns that must keep purchasing power (T3 re-bands them
    --    deliberately later). Core tables: fail loud.
    UPDATE quests   SET token_reward = token_reward * 10;
    UPDATE bounties SET token_reward = token_reward * 10;

    -- 7) Feature-vertical integer CT columns — to_regclass-guarded (db:push-era
    --    tables; staging has dropped some before): absent ⇒ NOTICE + skip.
    IF to_regclass('public.ct_topups') IS NOT NULL THEN
      UPDATE ct_topups SET amount_ct = amount_ct * 10;
    ELSE RAISE NOTICE '0011: ct_topups absent — skipped'; END IF;
    IF to_regclass('public.land_upgrades') IS NOT NULL THEN
      UPDATE land_upgrades SET cost_ct = cost_ct * 10;
    ELSE RAISE NOTICE '0011: land_upgrades absent — skipped'; END IF;
    IF to_regclass('public.land_transactions') IS NOT NULL THEN
      UPDATE land_transactions SET amount_ct = amount_ct * 10;
    ELSE RAISE NOTICE '0011: land_transactions absent — skipped'; END IF;
    IF to_regclass('public.service_listings') IS NOT NULL THEN
      UPDATE service_listings SET price_ct = price_ct * 10;
    ELSE RAISE NOTICE '0011: service_listings absent — skipped'; END IF;
    IF to_regclass('public.service_purchases') IS NOT NULL THEN
      UPDATE service_purchases SET price_ct = price_ct * 10;
    ELSE RAISE NOTICE '0011: service_purchases absent — skipped'; END IF;
    IF to_regclass('public.special_events') IS NOT NULL THEN
      UPDATE special_events SET gate_ct = gate_ct * 10 WHERE gate_ct IS NOT NULL;
    ELSE RAISE NOTICE '0011: special_events absent — skipped'; END IF;
    IF to_regclass('public.exchange_listings') IS NOT NULL THEN
      UPDATE exchange_listings SET price_ct = price_ct * 10;
    ELSE RAISE NOTICE '0011: exchange_listings absent — skipped'; END IF;
    IF to_regclass('public.exchange_orders') IS NOT NULL THEN
      UPDATE exchange_orders SET amount_ct = amount_ct * 10;
    ELSE RAISE NOTICE '0011: exchange_orders absent — skipped'; END IF;

    -- 8) Poker CT is STRINGIFIED BIGINT (text cols) — ×10 via ::bigint math.
    --    PLAY CHIPS (poker_tournaments.starting_stack, entrants.chip_stack) are
    --    NOT CT (schema: "play chips, NOT CT") — deliberately untouched.
    --    Guarded: poker tables have been db:push-dropped on staging before.
    IF to_regclass('public.poker_tournaments') IS NOT NULL THEN
      UPDATE poker_tournaments SET
        buy_in_ct     = (buy_in_ct::bigint     * 10)::text,
        prize_pool_ct = (prize_pool_ct::bigint * 10)::text,
        rake_taken_ct = CASE WHEN rake_taken_ct IS NULL THEN NULL
                             ELSE (rake_taken_ct::bigint * 10)::text END;
    ELSE RAISE NOTICE '0011: poker_tournaments absent — skipped'; END IF;
    IF to_regclass('public.poker_tournament_entrants') IS NOT NULL THEN
      UPDATE poker_tournament_entrants SET
        buy_in_paid_ct = (buy_in_paid_ct::bigint * 10)::text,
        refunded_ct    = (refunded_ct::bigint    * 10)::text;
    ELSE RAISE NOTICE '0011: poker_tournament_entrants absent — skipped'; END IF;
    IF to_regclass('public.poker_tournament_results') IS NOT NULL THEN
      UPDATE poker_tournament_results SET prize_ct = (prize_ct::bigint * 10)::text;
    ELSE RAISE NOTICE '0011: poker_tournament_results absent — skipped'; END IF;
    IF to_regclass('public.poker_cash_tables') IS NOT NULL THEN
      UPDATE poker_cash_tables SET
        buy_in_ct        = (buy_in_ct::bigint        * 10)::text,
        small_blind_ct   = (small_blind_ct::bigint   * 10)::text,
        big_blind_ct     = (big_blind_ct::bigint     * 10)::text,
        rake_cap_ct      = CASE WHEN rake_cap_ct IS NULL THEN NULL
                                ELSE (rake_cap_ct::bigint * 10)::text END,
        table_escrow_ct  = (table_escrow_ct::bigint  * 10)::text,
        rake_taken_ct    = (rake_taken_ct::bigint    * 10)::text;
    ELSE RAISE NOTICE '0011: poker_cash_tables absent — skipped'; END IF;
    IF to_regclass('public.poker_cash_seats') IS NOT NULL THEN
      UPDATE poker_cash_seats SET
        current_stack_ct    = (current_stack_ct::bigint    * 10)::text,
        total_bought_in_ct  = (total_bought_in_ct::bigint  * 10)::text,
        total_cashed_out_ct = (total_cashed_out_ct::bigint * 10)::text;
    ELSE RAISE NOTICE '0011: poker_cash_seats absent — skipped'; END IF;
    IF to_regclass('public.poker_cash_hands') IS NOT NULL THEN
      UPDATE poker_cash_hands SET
        pot_total_ct  = CASE WHEN pot_total_ct IS NULL THEN NULL
                             ELSE (pot_total_ct::bigint * 10)::text END,
        rake_taken_ct = (rake_taken_ct::bigint * 10)::text;
    ELSE RAISE NOTICE '0011: poker_cash_hands absent — skipped'; END IF;
    IF to_regclass('public.poker_cash_ledger_events') IS NOT NULL THEN
      UPDATE poker_cash_ledger_events SET amount_ct = (amount_ct::bigint * 10)::text;
    ELSE RAISE NOTICE '0011: poker_cash_ledger_events absent — skipped'; END IF;

    -- DELIBERATELY untouched (documented decisions, not misses): all
    -- usd_basis/numeric-dollar columns (DOLLARS), wager.* lamports (SOL rail),
    -- cosmetic_skus.price_ct (0012 re-band), land_parcels.rent_ct_weekly (already
    -- the founder's target band), land_parcels.price_ct c/b/a/founder (deprecated
    -- for Phase B claim-locks), poker play-chip columns (not CT).

    INSERT INTO tokenomics_migrations (id) VALUES ('redenominate_ct_x10');
    RAISE NOTICE 'redenominate_ct_x10 applied — balances/grants/starter-land/ledger-history/rewards/feature-tables/poker-CT x10, avatar defaults 1000';
  END IF;
END $$;
