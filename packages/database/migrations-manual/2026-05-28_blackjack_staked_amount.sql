-- Phase 6.4.1 (audit finding #3) — commit blackjack stake at deal time.
-- Adds blackjack_hands.staked_amount: the cumulative stake already irrevocably
-- debited for a hand (base bet + any insurance) at /hand/deal, so an abandoned
-- in_progress hand still costs its stake (closes the free hand-peek exploit).
-- Settle credits the gross payout and debits only the double/split delta
-- (engine totalBet - staked_amount).
--
-- Idempotent: safe to run multiple times. Drizzle's `db:push` creates this
-- column on a fresh table from the schema; this script is the fallback for a
-- DB where blackjack_shoes/blackjack_hands were already pushed before this fix.
-- Apply via the api container per `feedback_drizzle_kit_introspection_bug`.

ALTER TABLE IF EXISTS blackjack_hands
  ADD COLUMN IF NOT EXISTS staked_amount text NOT NULL DEFAULT '0';
