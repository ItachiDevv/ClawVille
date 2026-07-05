-- Poker MTT: enforce UNIQUE placement per tournament (Codex gate, 2026-07-04).
--
-- WHY: nothing in the schema forbade two entrants in the same tournament sharing a
-- `placement`. A duplicate placement MINTS or mispays CT at settle — the payout loop
-- credits per entrant while the conservation math (fold-remainder-into-1st) is keyed
-- on the SET of placements, so a duplicated placement is paid twice but counted once,
-- inflating the fold-into-1st remainder (e.g. placements [1,1,2] / pool 300 /
-- curve 50-30-20 -> 210 + 210 + 90 = 510 paid = 210 CT minted). `settleTournament`
-- now also asserts the full permutation crash-loud, but this index is the primary,
-- DB-level defense that prevents the malformed state from ever being written.
--
-- PARTIAL: only non-NULL placements are constrained — still-alive / unseated entrants
-- (placement NULL) are exempt, so many entrants can coexist mid-tournament.
--
-- Fully idempotent + PURELY ADDITIVE (CREATE UNIQUE INDEX IF NOT EXISTS) — safe to
-- re-run. Apply with the bespoke env-var script, NEVER `db:push` (which force-drops):
--   POKER_PLACEMENT_UNIQUE_DATABASE_URL="postgres://…" \
--     bun packages/database/scripts/apply-poker-placement-unique.ts
--
-- CAUTION: if a target DB already carries duplicate placements from the pre-fix code,
-- this CREATE will fail loudly (unique violation on existing data) — that is the point;
-- it surfaces pre-existing corruption for an operator to reconcile before the index
-- lands. In practice placements are assigned by the dense, cursor-decrementing
-- computeBustPlacements, so duplicates should not exist.

CREATE UNIQUE INDEX IF NOT EXISTS poker_entrants_tournament_placement_unique
  ON poker_tournament_entrants (tournament_id, placement)
  WHERE placement IS NOT NULL;
