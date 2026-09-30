-- 0070_special_event_start_guard.sql — security pass 2026-09-30 (M3, M4, H2).
--
-- ADDITIVE + IDEMPOTENT. Adds three columns, three unique indexes, and (re)states
-- one CHECK predicate. It drops no table, column, index, or data. The file runs
-- as one implicit transaction, so a failure applies nothing.
--
-- RUN THE READ-ONLY PRE-CHECK FIRST (it is in the M3/M4 report and in
-- ARCHITECTURE.md §8): a duplicate (special_event_id), (tournament_id, placement)
-- or (avatar_id, item_id) row makes the CREATE UNIQUE INDEX fail, and that blocks
-- the deploy gate.

-- 1. M3 — the house-treasury-funded share of a tournament's prize pool.
--    TournamentManager.createTournament debits the house treasury for a prepaid
--    seed in the same transaction as the INSERT and records the amount here. Both
--    cancel paths credit this amount back to the treasury in the cancel
--    transaction. Existing rows get '0': their seed was minted, not debited, so a
--    later cancel must return nothing to the treasury for them.
ALTER TABLE "poker_tournaments"
  ADD COLUMN IF NOT EXISTS "seed_prize_pool_ct" text NOT NULL DEFAULT '0';

-- 2. M4 — at most ONE non-cancelled tournament per special event. Concurrent
--    POST /api/events/:slug/start calls could each create a tournament (and each
--    fund a seed pool). The manager now claims the start in its row-locked prep
--    transaction; this index is the database backstop. Cancelled tournaments are
--    excluded: a cancel refunds its seed to the treasury in the same transaction,
--    and the manager then reopens signups so an operator can retry the start.
CREATE UNIQUE INDEX IF NOT EXISTS "poker_tournaments_special_event_active_unique"
  ON "poker_tournaments" USING btree ("special_event_id")
  WHERE special_event_id IS NOT NULL AND status <> 'cancelled';

-- 3. H2 — one result row per (tournament, placement). Placements are distinct by
--    construction (computeBustPlacements); a duplicate would pay one placement's
--    prize twice, so settlement now fails closed instead.
CREATE UNIQUE INDEX IF NOT EXISTS "poker_results_tournament_placement_unique"
  ON "poker_tournament_results" USING btree ("tournament_id", "placement");

-- 4. M4 — the in-flight start's claim. The claim sets status 'starting' plus a
--    token + time; every write of that start CASes on the token, and every exit
--    from 'starting' clears both. A claim older than the manager's stale window
--    belongs to a crashed start and is reconciled by the next start call or the
--    settlement worker tick (special-event-manager.ts reconcileStartingEvent).
ALTER TABLE "special_events" ADD COLUMN IF NOT EXISTS "start_claim_id" uuid;
ALTER TABLE "special_events" ADD COLUMN IF NOT EXISTS "start_claimed_at" timestamptz;

-- 5. M4 — special_events.status gains the transient 'starting' state. The CHECK
--    is (re)stated unconditionally: 0003 created it on an empty database, the
--    2026-09-30 read-only check found it on staging and prod (with 0 rows), and
--    the CI replay lacks it (ARCHITECTURE.md §12 "CI schema fidelity"). A CHECK
--    has no ADD ... IF NOT EXISTS, so the idempotent form is DROP IF EXISTS + ADD
--    (0005 precedent). The new predicate is a strict superset of the old one, so
--    no row the old CHECK allowed can fail it.
ALTER TABLE "special_events" DROP CONSTRAINT IF EXISTS "special_events_status_check";
ALTER TABLE "special_events" ADD CONSTRAINT "special_events_status_check"
  CHECK (status = ANY (ARRAY['draft'::text, 'signup_open'::text, 'starting'::text, 'live'::text, 'completed'::text, 'cancelled'::text]));

-- 6. M10 (Codex round 2) — one inventory row per (avatar, item).
--    grantInventoryItem is an INSERT ... ON CONFLICT (avatar_id, item_id) DO UPDATE
--    upsert on this index, so two concurrent first grants end as ONE row. The
--    2026-09-30 read-only check found 0 duplicate groups on staging and prod.
--    Like 0069, this fails closed if a duplicate appears before promotion and
--    never merges or deletes rows itself.
CREATE UNIQUE INDEX IF NOT EXISTS "avatar_inventory_avatar_item_unique"
  ON "avatar_inventory" USING btree ("avatar_id", "item_id");
