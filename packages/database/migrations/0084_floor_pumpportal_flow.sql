-- 0084_floor_pumpportal_flow.sql: Trading Floor Arena PUMPPORTAL FLOW facts (research data, job arena-pipeline T4,
-- 2026-10-15). Drizzle mirror: packages/database/src/schema/floor-arena-pumpportal.ts.
-- Writer: apps/api/src/services/floor-arena/pumpportal-feed.ts (leader-only, one websocket, flush every ~15 s).
-- DATA ONLY: no filter threshold reads this table. One row per watched pump.fun / PumpSwap mint: rolling 1m/5m/15m
-- trade flow (null while PumpPortal trade subscriptions are not available), creator activity, early buyers, the last
-- curve state. Rows older than 24 h are pruned by the writer. Additive and idempotent: a new table and its index, no
-- FK, no lock on any existing table, safe before the code flip (the old code never reads or writes it).

CREATE TABLE IF NOT EXISTS "floor_pumpportal_flow" (
  "mint" text PRIMARY KEY,
  "pool" text,
  "creator" text,
  "token_created_at" timestamptz,
  "first_seen_at" timestamptz NOT NULL,
  "trade_flow" boolean NOT NULL DEFAULT false,
  "w1m" jsonb,
  "w5m" jsonb,
  "w15m" jsonb,
  "creator_buy_sol" double precision,
  "creator_sell_sol" double precision,
  "creator_sold" boolean,
  "early_buyers" integer,
  "early_held_pct" double precision,
  "last_market_cap_sol" double precision,
  "last_v_sol" double precision,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "floor_pumpportal_flow_updated_at_idx" ON "floor_pumpportal_flow" ("updated_at");
