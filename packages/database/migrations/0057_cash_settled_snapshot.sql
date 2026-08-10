-- BA-1: cash Hold'em settled-hand snapshot.
-- Authored only in this pass; apply through the normal reviewed migration flow.

ALTER TABLE IF EXISTS "poker_cash_hands"
  ADD COLUMN IF NOT EXISTS "pot_result_json" jsonb;

ALTER TABLE IF EXISTS "poker_cash_hands"
  ADD COLUMN IF NOT EXISTS "seat_result_json" jsonb;

ALTER TABLE IF EXISTS "poker_cash_hands"
  ADD COLUMN IF NOT EXISTS "ended_at" text;
