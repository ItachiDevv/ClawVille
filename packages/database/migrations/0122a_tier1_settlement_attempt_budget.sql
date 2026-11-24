-- Tier-1 bounty settlement: widen the attempt budget from 5 to 30.
-- Five unspaced attempts were used up by the PayAI credit outage
-- (2026-10-10 to 10-25), which left two approved bounties unpaid and paging
-- every 24 h. The code now spaces attempts (5 min, doubling, at most 24 h), so
-- 30 attempts cover about 22 days of outage.
--
-- Widening only: every existing row (1..5) satisfies the new check. Safe to run
-- before the code flip (old code never goes past 5) and idempotent on re-run.
-- migrate-ci applies files in lexicographic order: 0122_ < 0122a.
ALTER TABLE "bounty_usdc_holds"
  DROP CONSTRAINT IF EXISTS "bounty_usdc_holds_settlement_attempt_bounded";

ALTER TABLE "bounty_usdc_holds"
  ADD CONSTRAINT "bounty_usdc_holds_settlement_attempt_bounded"
  CHECK ("settlement_attempt" BETWEEN 1 AND 30);
