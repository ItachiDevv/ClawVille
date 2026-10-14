-- 0082_floor_arena_jev_entry.sql: Jev ENTRY SHADOW ledger for the Trading Floor arena paper bots (founder 2026-10-14,
-- $1 total cap enforced in code). Drizzle mirror: packages/database/src/schema/floor-arena-jev.ts.
-- Writer: apps/api/src/services/floor-arena/jev-entry.ts. Reader: apps/api/scripts/floor-arena-jev-report.ts.
-- SHADOW ONLY: no trade path, money path or public payload reads this table. One row per Jev call (or cap refusal)
-- for a coin that reached the buy-quote step. `usd` is the spend ledger: the writer inserts a 'reserved' row with an
-- upper-bound estimate under pg_advisory_xact_lock, then updates it with the actual cost. No prompt text is stored.
-- Additive and idempotent: a new table and its indexes, no FK, no lock on any existing table, safe before the code flip.

CREATE TABLE IF NOT EXISTS "floor_arena_jev_entry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "agent_id" text NOT NULL,
  "mint" text NOT NULL,
  "decided_at" timestamptz NOT NULL,
  "status" varchar(16) NOT NULL,
  "model" text,
  "state_hash" text,
  "answers" jsonb,
  "hits_tp" real,
  "dumps" real,
  "exit_room" smallint,
  "demand" smallint,
  "momentum" text,
  "holder_risk" smallint,
  "verdict" varchar(8),
  "veto_reasons" text[],
  "jev_ms" integer,
  "input_tokens" integer,
  "usd" numeric(12, 8) NOT NULL DEFAULT 0,
  "error" text
);
CREATE INDEX IF NOT EXISTS "floor_arena_jev_entry_agent_mint_decided_idx"
  ON "floor_arena_jev_entry" ("agent_id", "mint", "decided_at");
CREATE INDEX IF NOT EXISTS "floor_arena_jev_entry_created_at_idx" ON "floor_arena_jev_entry" ("created_at");
