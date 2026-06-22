-- 0005_add_chibi_agent_category.sql
-- Chibi agent category (2026-06-21) — extend the `avatars_agent_category_valid`
-- CHECK to accept 'chibi'.
--
-- WHY: the two chibi VRMs (`eliza_chibi`, `milady_chibi`) were offered in the
-- WEB picker but were MISSING from the shared AGENT_CATEGORIES / AGENT_MODELS
-- tuple, so /create-agent silently dropped a chibi pick and defaulted the avatar
-- to a Milady. They are now first-class in @clawville/shared
-- (packages/shared/src/constants/agent-models.ts). The avatars route
-- (apps/api/src/routes/avatars.ts) validates `agentCategory` with
-- `z.enum(AGENT_CATEGORIES)` and writes it to `avatars.agent_category`, so the
-- DB CHECK must include 'chibi' or a chibi-avatar write hits a Postgres CHECK
-- violation. Mirrors the 'hatcher' add (migrations-manual/2026-06-01_add_hatcher_agent_category.sql).
--
-- IDEMPOTENT: a CHECK constraint has no `ADD ... IF NOT EXISTS`, so the pattern
-- is DROP-IF-EXISTS then ADD. The new predicate is a strict SUPERSET of the old
-- one, so dropping + recreating cannot reject any existing row (every prior value
-- is still allowed). Safe to re-run. NEVER author a DROP of data — this only
-- redefines a CHECK predicate.

ALTER TABLE IF EXISTS avatars
  DROP CONSTRAINT IF EXISTS avatars_agent_category_valid;

ALTER TABLE IF EXISTS avatars
  ADD CONSTRAINT avatars_agent_category_valid
  CHECK (agent_category IN ('openclaw','hermes','milady','other','hatcher','chibi'));
