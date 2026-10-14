-- 0081_jev_decide_shadow.sql: Jev decide SHADOW ledger (founder-approved 2026-10-13, $1 total cap enforced in code).
-- Drizzle mirror: packages/database/src/schema/jev-shadow.ts. Writer: apps/api/src/services/jev-decide-shadow.ts.
-- SHADOW ONLY: no game path, money path or public payload reads this table. One row per shadow call (or cap refusal).
-- `usd` is the spend ledger: the writer inserts a 'reserved' row with an estimate under pg_advisory_xact_lock, then
-- updates it with the actual cost. The prompt text and the reply text are never stored.
-- Additive and idempotent: a new table and its index, no lock on any existing table, safe before the code flip.

CREATE TABLE IF NOT EXISTS "jev_decide_shadow" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "avatar_id" uuid,
  "is_house" boolean NOT NULL,
  "status" varchar(16) NOT NULL,
  "local_verb" varchar(48),
  "local_empty" boolean NOT NULL,
  "local_ms" integer,
  "jev_verb" varchar(48),
  "jev_top_prob" real,
  "jev_probs" jsonb,
  "jev_ms" integer,
  "input_tokens" integer,
  "usd" numeric(12, 8) NOT NULL DEFAULT 0,
  "error" text
);
CREATE INDEX IF NOT EXISTS "jev_decide_shadow_created_at_idx" ON "jev_decide_shadow" ("created_at");
