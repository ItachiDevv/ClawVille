-- 0085_floor_arena_codex_entry.sql: Codex DECIDER SHADOW ledger for the Trading Floor arena paper bots (founder
-- 2026-10-15; Codex CLI on the founder's ChatGPT plan via the host sidecar infra/codex-decider, calls-per-hour cap in
-- code). Drizzle mirror: packages/database/src/schema/floor-arena-codex.ts.
-- Writer: apps/api/src/services/floor-arena/codex-entry.ts. Reader: apps/api/scripts/floor-arena-codex-report.ts.
-- SHADOW ONLY: no trade path, money path or public payload reads this table. One row per sidecar call (or hourly-cap
-- refusal) for a coin that reached the buy-quote step. No prompt text and no credential is stored.
-- Additive and idempotent: a new table and its indexes, no FK, no lock on any existing table, safe before the code flip.

CREATE TABLE IF NOT EXISTS "floor_arena_codex_entry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "agent_id" text NOT NULL,
  "mint" text NOT NULL,
  "decided_at" timestamptz NOT NULL,
  "status" varchar(16) NOT NULL,
  "model" text,
  "decision" varchar(8),
  "confidence" real,
  "exit_room" varchar(4),
  "rug_risk" varchar(8),
  "reasons" text[],
  "ms" integer,
  "error" text
);
CREATE INDEX IF NOT EXISTS "floor_arena_codex_entry_agent_mint_decided_idx"
  ON "floor_arena_codex_entry" ("agent_id", "mint", "decided_at");
CREATE INDEX IF NOT EXISTS "floor_arena_codex_entry_created_at_idx" ON "floor_arena_codex_entry" ("created_at");
