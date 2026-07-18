-- §B.1 durable autonomy (2026-07-08). See
-- apps/api/src/services/agent-autonomy-activation.ts +
-- apps/api/src/services/agent-autonomy-reconcile.ts +
-- apps/api/src/services/agent-session-sweeper.ts +
-- packages/database/src/schema/claws.ts + ARCHITECTURE.md.
--
-- WHY: a browser-closed persisting Autonomous agent (D6, 24h TTL) was re-enrolled
-- into the autonomy driver ONLY by the CLIENT keepalive after an API restart. No
-- browser -> no keepalive -> every production deploy silently killed away-users'
-- agents until they returned. This column PERSISTS the enrollment intent so the
-- server-side reconcile (`agent-autonomy-reconcile.ts`, run on driver start +
-- periodically) can re-enroll every `autonomy_enrolled = true AND
-- session_expires_at > now()` hosted-avatar session with NO client involvement.
--
-- Lifecycle: SET true by activateAutonomyForOwner after a successful enroll;
-- SET false by deactivateAutonomyForOwner (explicit toggle + the logout route)
-- and atomically in the 24h TTL sweep's mark-swept UPDATE. Only ever true on a
-- hosted-avatar (is_house=false, milady identity) row.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — safe to run multiple times. Drizzle's
-- db:push would emit the column from the schema (claws.ts); this manual SQL is
-- the deterministic fallback. Apply via the api container against the DB.
--
-- DO NOT RUN as part of the impl diff — the orchestrator applies it manually
-- against the DB (db:push is --force / silently destructive on shared branches).

ALTER TABLE IF EXISTS openclaw_bots
  ADD COLUMN IF NOT EXISTS autonomy_enrolled boolean NOT NULL DEFAULT false;
