-- 0122_floor_arena_periods.sql: Trading Floor Arena P&L periods (job arena-pnl-reset phase 2, founder 2026-11-12).
-- Contract: docs/trading-floor-arena.md §4. Drizzle mirror: packages/database/src/schema/floor-arena.ts.
-- A P&L reset inserts a period row and deletes nothing: the `period` window counts only positions opened at or after
-- the active period's starts_at (the row with the greatest starts_at <= now()); old trades stay under 'all'.
-- Positions still open at a reset are closed by the engine with exit_reason 'reset' (widened CHECK below).
-- No seed row: with no row there is no period and the `period` window counts every position.
-- Additive and idempotent. Safe before the code flip: the old code never reads the table and never writes 'reset'.
-- lock_timeout: re-adding the CHECK takes a short ACCESS EXCLUSIVE lock on floor_arena_positions (hot during engine
-- ticks). SET LOCAL bounds the wait to 5 s for this file's implicit transaction only; on a timeout the whole file rolls
-- back, the CI migrate job fails loud, and a rerun applies it (every statement is idempotent).
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "floor_arena_periods" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "reason" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "floor_arena_periods_starts_at_key" UNIQUE ("starts_at")
);

-- The value list equals FLOOR_ARENA_EXIT_REASONS in @clawville/shared (constants/floor-arena.ts), in order.
ALTER TABLE "floor_arena_positions" DROP CONSTRAINT IF EXISTS "floor_arena_positions_exit_reason_valid";
ALTER TABLE "floor_arena_positions" ADD CONSTRAINT "floor_arena_positions_exit_reason_valid"
  CHECK ("exit_reason" IS NULL OR "exit_reason" IN ('tp','stop','trail','time','manual','unresolved','reset'));
