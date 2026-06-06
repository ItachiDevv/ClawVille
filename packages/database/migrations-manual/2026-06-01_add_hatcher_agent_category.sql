-- Hatcher agent category (partner #2, 2026-06-01) — extend the
-- `avatars_agent_category_valid` CHECK to accept 'hatcher'.
--
-- WHY: `'hatcher'` was added to AGENT_CATEGORIES in @clawville/shared
-- (packages/shared/src/constants/agent-models.ts). The avatars route
-- (apps/api/src/routes/avatars.ts) validates `agentCategory` with
-- `z.enum(AGENT_CATEGORIES)` and writes it to `avatars.agent_category`,
-- so the DB CHECK must include the new value or any such write hits a
-- Postgres CHECK violation. Connected Hatcher agents themselves render via
-- `openclaw_bots.species` and do NOT write an avatars row — this CHECK is
-- the human-avatar / direct-API write path's defense-in-depth, kept in
-- lockstep with the shared tuple per the documented mirror invariant.
--
-- A CHECK constraint has no `ADD ... IF NOT EXISTS`, so the idempotent
-- pattern is DROP-IF-EXISTS then ADD. The new predicate is a strict
-- superset of the old one, so dropping + recreating cannot reject any
-- existing row (every prior value is still allowed).
--
-- Idempotent: safe to run multiple times. Drizzle's `db:push` would emit
-- this from the schema (packages/database/src/schema/avatars.ts), but
-- db:push is flaky on the `avatars` table (per
-- feedback_drizzle_kit_introspection_bug) — this script is the manual
-- fallback. Apply via the api container against the shared Supabase DB;
-- runs once for both Coolify boxes since they share one Supabase Postgres.
--
-- DO NOT RUN as part of the impl diff — the orchestrator applies it
-- manually against the shared DB.

ALTER TABLE IF EXISTS avatars
  DROP CONSTRAINT IF EXISTS avatars_agent_category_valid;

ALTER TABLE IF EXISTS avatars
  ADD CONSTRAINT avatars_agent_category_valid
  CHECK (agent_category IN ('openclaw','hermes','milady','other','hatcher'));
