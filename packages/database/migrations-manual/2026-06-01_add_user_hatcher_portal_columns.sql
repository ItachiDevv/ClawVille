-- Hatcher portal (partner #2, 2026-06-01) — 6 columns on `users`, a direct
-- mirror of the scape_* / linked_scape_* block added in Phase 5.1.
--
--   hatcher_principal_id          UNIQUE — auto-provision cache (CV → Hatcher)
--   hatcher_world_character_id    UNIQUE — auto-provision cache
--   linked_hatcher_principal_id   UNIQUE — account-link (accept-hatcher-link)
--   linked_hatcher_world_character_id UNIQUE — account-link
--   linked_hatcher_display_name          — account-link (no uniqueness)
--   linked_hatcher_at                    — account-link timestamp
--
-- Types/lengths/constraints exactly match the scape columns in
-- packages/database/src/schema/users.ts.
--
-- Idempotent: safe to run multiple times (ADD COLUMN IF NOT EXISTS +
-- CREATE UNIQUE INDEX IF NOT EXISTS). Drizzle's `db:push` creates these
-- from the schema on a fresh table; this script is the fallback for the
-- shared Supabase `users` table where db:push is flaky on this table
-- (per feedback_drizzle_kit_introspection_bug). Apply via the api
-- container against the shared Supabase DB. Runs once for both Coolify
-- boxes since they share one Supabase Postgres.
--
-- DO NOT RUN as part of the impl diff — the orchestrator applies it
-- manually against the shared DB.

ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS hatcher_principal_id varchar(128),
  ADD COLUMN IF NOT EXISTS hatcher_world_character_id varchar(64),
  ADD COLUMN IF NOT EXISTS linked_hatcher_principal_id varchar(128),
  ADD COLUMN IF NOT EXISTS linked_hatcher_world_character_id varchar(64),
  ADD COLUMN IF NOT EXISTS linked_hatcher_display_name varchar(64),
  ADD COLUMN IF NOT EXISTS linked_hatcher_at timestamptz;

-- UNIQUE constraints on the four ID columns, mirroring the `.unique()`
-- on the scape columns. Drizzle emits these as unique indexes named
-- `users_<column>_unique`; we match that naming so a later db:push
-- introspection sees them as already-present rather than re-creating.
CREATE UNIQUE INDEX IF NOT EXISTS users_hatcher_principal_id_unique
  ON users (hatcher_principal_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_hatcher_world_character_id_unique
  ON users (hatcher_world_character_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_linked_hatcher_principal_id_unique
  ON users (linked_hatcher_principal_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_linked_hatcher_world_character_id_unique
  ON users (linked_hatcher_world_character_id);
