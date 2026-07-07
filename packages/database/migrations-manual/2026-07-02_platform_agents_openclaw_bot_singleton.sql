-- Agent-metaverse P1 RELIABILITY R3 (2026-07-02). See
-- apps/api/src/services/house-agent-seeder.ts + apps/api/src/routes/openclaw.ts +
-- packages/database/src/schema/agents.ts + ARCHITECTURE.md.
--
-- WHY: both the house-agent seeder and the openclaw connect path locate "the"
-- platform_agents row for a given openclaw bot by scanning all openclaw-bot rows
-- for the userId and `.find()`-ing the first whose config->>'openclawBotId'
-- matches. Absent a unique constraint, two CONCURRENT boots (or a re-connect race)
-- could INSERT two platform_agents rows for the SAME openclawBotId, and the
-- arbitrary `.find()` would then bind a DIFFERENT runtime row each boot — a
-- nondeterministic, duplicable identity. This partial unique index makes at most
-- ONE openclaw-bot row per (user_id, type, config->>'openclawBotId') possible.
--
-- Predicate uses `IS NOT NULL` (NOT the jsonb `?` existence operator) so it is a
-- plain SQL expression and avoids the `?`→param-placeholder ambiguity some drivers
-- hit. Mirrors the existing `platform_agents_system_singleton` partial-index
-- precedent.
--
-- Idempotent: the dedupe DELETE is safe to re-run (a no-op once deduped) and the
-- index is CREATE UNIQUE INDEX IF NOT EXISTS. Drizzle's db:push would emit the
-- index from the schema (agents.ts); this manual SQL is the deterministic fallback
-- AND carries the pre-index dedupe db:push cannot do.
--
-- DO NOT RUN as part of the impl diff — the founder/orchestrator applies it
-- manually against the target DB (db:push is --force / silently destructive on
-- shared branches). Apply via:
--   AGENTS_DATABASE_URL="postgres://…" \
--     bun packages/database/scripts/apply-platform-agents-openclaw-bot-singleton.ts

-- (a) Dedupe FIRST — a CREATE UNIQUE INDEX throws if duplicates already exist.
--     Keep exactly ONE row per (user_id, config->>'openclawBotId') among
--     openclaw-bot rows: the earliest by created_at, tiebroken by id (robust to
--     created_at ties). Delete the rest. SAFE — platform_agent_logs.agent_id FK is
--     ON DELETE cascade and nothing else targets platform_agents.id, so no orphan.
DELETE FROM platform_agents pa
WHERE pa.type = 'openclaw-bot'
  AND (pa.config->>'openclawBotId') IS NOT NULL
  AND pa.id NOT IN (
    SELECT DISTINCT ON (user_id, (config->>'openclawBotId')) id
    FROM platform_agents
    WHERE type = 'openclaw-bot'
      AND (config->>'openclawBotId') IS NOT NULL
    ORDER BY user_id, (config->>'openclawBotId'), created_at ASC, id ASC
  );

-- (b) The partial unique index. Matches the drizzle schema name + columns.
CREATE UNIQUE INDEX IF NOT EXISTS platform_agents_openclaw_bot_singleton
  ON platform_agents (user_id, type, (config->>'openclawBotId'))
  WHERE type = 'openclaw-bot' AND (config->>'openclawBotId') IS NOT NULL;
