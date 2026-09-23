-- Staging already has this invariant from the manual escrow-linkage migration.
-- The 2026-09-22 production audit found no equivalent index and no duplicate
-- approved bounty IDs. Fail closed if new duplicates appear before promotion.
-- Never delete or reclassify historical attempts as part of this migration.
CREATE UNIQUE INDEX IF NOT EXISTS bounty_attempts_one_approved_per_bounty
  ON bounty_attempts (bounty_id)
  WHERE status = 'approved';
