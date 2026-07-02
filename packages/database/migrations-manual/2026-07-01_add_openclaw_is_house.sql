-- Agent-metaverse P1 (2026-07-01). See
-- apps/api/src/services/house-agent-seeder.ts + agent-autonomy-driver.ts +
-- packages/database/src/schema/claws.ts + ARCHITECTURE.md.
--
-- WHY: P1 activates ONE ClawVille-hosted autonomous "house" agent — the first
-- member of the eventual fleet (CLAUDE.md private-repo `clawville-agents`). It
-- runs a local ElizaOS runtime (gpt-4o-mini) and drives its in-world body via
-- the perceive->decide->act loop. This column MARKS its openclaw_bots row as a
-- hosted fixture (vs an external/partner-connected agent) so the server can:
--   (a) enumerate/identify house rows (seeder + autonomy driver), and
--   (b) EXEMPT the house body from the idle-despawn sweeper
--       (agent-body-idle-sweeper.ts) — a hosted fixture must survive like a
--       system agent, never idle-reaped; its session TTL is NULL (never expires),
--       so the 24h session sweeper skips it too.
--
-- INTERNAL-ONLY: is_house is NEVER serialized onto any public snapshot / /rooms
-- roster / wire field — a house agent must be indistinguishable from any other
-- agent to outsiders (CLAUDE.md "undetectable is_house flag"). It lives on the
-- DB row + a server-side RunningAgent signal only.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to run multiple times. Drizzle's
-- db:push would emit the column from the schema (claws.ts); this manual SQL is
-- the deterministic fallback. Apply via the api container against the shared
-- Supabase DB.
--
-- DO NOT RUN as part of the impl diff — the orchestrator applies it manually
-- against the DB (db:push is --force / silently destructive on shared branches).

ALTER TABLE IF EXISTS openclaw_bots
  ADD COLUMN IF NOT EXISTS is_house boolean NOT NULL DEFAULT false;
