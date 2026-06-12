-- Agent-session restart survival (2026-06-11). See
-- apps/api/src/services/openclaw-session-restore.ts + ARCHITECTURE.md.
--
-- WHY: a connected agent's live session lives ONLY in npc-simulation's
-- in-memory Map (the `ag-`/`oc-`/`hat-` bearer is NEVER persisted). Every API
-- deploy/restart rebuilds that Map empty, so `validateLiveAgentSession`
-- map-missed and returned 404 "session not found or expired" to the agent's
-- owner mid-chat — every restart silently killed every connected agent. The
-- openclaw_bots ROW survives a restart (keyed by agent_id, with a sliding 24h
-- session_expires_at TTL); this column lets the restore path re-bind the SAME
-- live bearer to the surviving row.
--
--   session_key_hash : sha256Hex(sessionId) — the FULL 64-hex one-way hash of
--                      the live agent-session bearer. We store the HASH, NEVER
--                      the raw id: the raw id is the real-CT bearer credential,
--                      so a DB dump must not yield a spendable token. On a
--                      Map-miss the restore path hashes the INCOMING bearer and
--                      finds the row by this column (equality), proving the
--                      caller holds the live id without that id touching disk.
--                      Rewritten on every connect/register/patch (new sessionId
--                      per connect ⇒ new hash). NULL for legacy pre-column rows
--                      (un-restorable; the agent reconnects — prior behaviour).
--
-- The partial index makes the Map-miss lookup an index probe (one per chat call
-- that map-missed, i.e. only right after a restart) and skips the many NULL
-- legacy/expired rows. It is UNIQUE (partial, on non-null) as defense-in-depth:
-- a hash is sha256 of a ~192-bit random bearer, so two rows sharing one is
-- cryptographically infeasible WITHOUT a bug (e.g. a reused sessionId). UNIQUE
-- makes such a collision a loud write error instead of letting the restore
-- `findFirst` silently mis-resolve one agent's bearer onto a DIFFERENT agent's
-- row. Every legitimate write overwrites a row's OWN hash (connect/register
-- upsert keyed by agent_id; hatcher writes keyed by id), so no two distinct rows
-- ever legitimately carry the same hash.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS —
-- safe to run multiple times. Drizzle's db:push would emit the column from the
-- schema (packages/database/src/schema/claws.ts); this manual SQL is the
-- deterministic fallback. Apply via the api container against the shared
-- Supabase DB; runs once for both Coolify boxes since they share one Supabase
-- Postgres.
--
-- DO NOT RUN as part of the impl diff — the orchestrator applies it manually
-- against the shared DB.

ALTER TABLE IF EXISTS openclaw_bots
  ADD COLUMN IF NOT EXISTS session_key_hash varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS openclaw_bots_session_key_hash_idx
  ON openclaw_bots (session_key_hash)
  WHERE session_key_hash IS NOT NULL;
