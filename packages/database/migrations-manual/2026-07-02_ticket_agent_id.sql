-- Magic-link onboarding (2026-07-02) — ticket → agent linkage for the
-- deferred bind-at-redemption claim event.
--
-- `agent_session_tickets.issued_to_agent_id` records the PUBLIC
-- `openclaw_bots.agent_id` the ticket was minted FOR (nullable — non-agent
-- flows leave it null). `GET /api/auth/enter` reads it on successful consume
-- and binds `openclaw_bots.user_id` to the redeeming user (guarded: never
-- clobbers a DIFFERENT existing owner). It is a public handle, not a bearer,
-- so it is stored raw (unlike issued_to_agent_session, which is digested).
--
-- PURELY ADDITIVE + IDEMPOTENT: one nullable text column on the EXISTING
-- table; re-running is a no-op. NOT applied via `db:push` (that is
-- `drizzle-kit push --force`, silently destructive from a partial-schema
-- branch) — apply with the deterministic script:
--   AGENTS_DATABASE_URL="postgres://…" bun packages/database/scripts/apply-ticket-agent-id.ts

ALTER TABLE agent_session_tickets
  ADD COLUMN IF NOT EXISTS issued_to_agent_id text;
