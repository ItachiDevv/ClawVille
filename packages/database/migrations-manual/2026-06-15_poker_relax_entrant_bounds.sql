-- Poker MTT (P4) — relax poker_tournaments_entrant_bounds_check for MULTI-TABLE.
--
-- The constraint was authored for P3 (single table) and required
--   max_entrants <= seats_per_table
-- That clause is a single-table-only assumption. The P4 MTT engine seats
--   ceil(maxEntrants / seatsPerTable)
-- BALANCED tables, so max_entrants LEGITIMATELY exceeds seats_per_table (e.g. an
-- 18-entrant, 9-seat tournament = 2 tables). With the old CHECK in place, the new
-- createTournament() path (and any direct INSERT of a multi-table tournament)
-- 23514-fails on real Postgres even though the engine + tests support it.
--
-- New bounds enforce only the universally-true invariants: a ≥2 floor, max ≥ min,
-- and a sane 2..9-seat table. The runtime createTournament() additionally caps
-- max_entrants at an anti-fat-finger ceiling (MAX_ENTRANTS_CAP = 200).
--
-- Idempotent: DROP IF EXISTS then ADD. Safe to run multiple times. Apply via the
-- api container (psql against the Supabase DATABASE_URL) OR fold into the next
-- `bun run db:push` (drizzle push does NOT auto-replace a CHECK whose name is
-- unchanged but whose body changed, so this manual drop+add is required on any DB
-- already pushed under the P3 form).

ALTER TABLE IF EXISTS poker_tournaments
  DROP CONSTRAINT IF EXISTS poker_tournaments_entrant_bounds_check;

ALTER TABLE IF EXISTS poker_tournaments
  ADD CONSTRAINT poker_tournaments_entrant_bounds_check
  CHECK (
    min_entrants >= 2
    AND max_entrants >= min_entrants
    AND seats_per_table >= 2
    AND seats_per_table <= 9
  );
