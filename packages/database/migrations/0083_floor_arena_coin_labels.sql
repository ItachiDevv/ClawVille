-- 0083_floor_arena_coin_labels.sql: Trading Floor Arena COIN LABELS (research, job arena-pipeline T1, 2026-10-15).
-- Drizzle mirror: packages/database/src/schema/floor-arena-labels.ts.
-- Writer: apps/api/src/services/floor-arena/coin-labels.ts (leader-only loop). Reader: apps/api/scripts/floor-arena-label-report.ts.
-- RESEARCH ONLY: no trade path, money path or public payload reads this table. One row per mint episode of every coin the
-- shared floor sees from a tradeable source, traded or skipped, with price markouts for 24 h, a fate label and the
-- result of one fixed reference exit. Additive and idempotent: a new table and its indexes, no FK, no lock on any
-- existing table, safe before the code flip (the old code never reads or writes it).

CREATE TABLE IF NOT EXISTS "floor_arena_coin_labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mint" text NOT NULL,
  "episode_at" timestamptz NOT NULL,
  "anchor_at" timestamptz NOT NULL,
  "anchor_price_usd" double precision NOT NULL,
  "anchor_features" jsonb NOT NULL,
  "sources" text[] NOT NULL,
  "chain_status" jsonb,
  "path" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "mult_5m" double precision,
  "mult_15m" double precision,
  "mult_30m" double precision,
  "mult_60m" double precision,
  "max_mult_60m" double precision,
  "max_mult_60m_at" timestamptz,
  "min_mult_60m" double precision,
  "min_mult_60m_at" timestamptz,
  "mult_6h" double precision,
  "mult_24h" double precision,
  "max_mult_24h" double precision,
  "min_mult_24h" double precision,
  "fate_24h" text NOT NULL DEFAULT 'unknown',
  "common_exit_pnl_usd" double precision,
  "common_exit_reason" text,
  "own_samples" integer NOT NULL DEFAULT 0,
  "state" text NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "floor_arena_coin_labels_mint_episode_uniq" ON "floor_arena_coin_labels" ("mint", "episode_at");
CREATE INDEX IF NOT EXISTS "floor_arena_coin_labels_state_idx" ON "floor_arena_coin_labels" ("state");
CREATE INDEX IF NOT EXISTS "floor_arena_coin_labels_anchor_idx" ON "floor_arena_coin_labels" ("anchor_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_coin_labels_state_valid' AND conrelid = 'floor_arena_coin_labels'::regclass) THEN
    ALTER TABLE "floor_arena_coin_labels" ADD CONSTRAINT "floor_arena_coin_labels_state_valid" CHECK ("state" IN ('open','done'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'floor_arena_coin_labels_fate_valid' AND conrelid = 'floor_arena_coin_labels'::regclass) THEN
    ALTER TABLE "floor_arena_coin_labels" ADD CONSTRAINT "floor_arena_coin_labels_fate_valid"
      CHECK ("fate_24h" IN ('rug','runner','bleed','flat','unknown'));
  END IF;
END $$;
