-- Phase 6.1.10 RTP retune — verifier-replay support across paytable versions.
--
-- After commit 125b941 trimmed line payouts + scatter pays + free-spin award
-- to land both paytables at 94% RTP, replaying a pre-retune spin through the
-- current engine produces a winAmount MISMATCH (reels still match — only
-- payout multipliers changed). The verifier needs to know which payout table
-- to use for each row.
--
-- New rows: default 'v2' (post-retune, the current engine).
-- Existing rows: backfilled to 'v1' (pre-retune payouts).
--
-- Run order:
--   1. ALTER TABLE adds the column with DEFAULT 'v2' so NEW inserts get the
--      right version without code-path changes (the schema-defined default
--      handles them).
--   2. UPDATE backfills existing rows to 'v1' so their replays use the old
--      payouts they were recorded under.
--   3. SET NOT NULL — column is required from this point on.
--
-- Reversible: drop column to revert. The 'v1' backfill is data, not schema —
-- once rolled back you've lost which-version-this-row-was data.

ALTER TABLE slot_spins
  ADD COLUMN IF NOT EXISTS paytable_version TEXT NOT NULL DEFAULT 'v2';

-- Backfill: every row that EXISTS before this migration ran predates the
-- retune. Mark them as v1 so the verifier uses historical payouts.
UPDATE slot_spins
   SET paytable_version = 'v1'
 WHERE created_at < TIMESTAMP '2026-05-20 00:00:00+00';

-- Sanity: surface any rows that ended up NULL (should be impossible given the
-- NOT NULL DEFAULT, but assert it loudly if so).
DO $$
DECLARE
  null_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_count FROM slot_spins WHERE paytable_version IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION 'slot_spins.paytable_version migration left % NULL rows', null_count;
  END IF;
END $$;
