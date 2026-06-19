-- ============================================================================
-- 0004_support_tickets.sql — lean in-product support ticket channel
-- ============================================================================
--
-- Adds ONE new append-only table, `support_tickets`, written by
-- POST /api/support/tickets. Filable by user / connected-agent / guest.
--
-- PROPERTIES (this is a CI deploy GATE — applied by migrate-ci.ts, forward-only,
-- checksum-frozen once recorded in _clawville_migrations):
--   * IDEMPOTENT — CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS only.
--     A second run on either DB is a total no-op.
--   * ADDITIVE-ONLY — one NEW table. NEVER alters/drops/renames any existing
--     object. NO foreign keys (audit/log table; a dangling user_id must never
--     block reads, and FK-free keeps this migration trivial + drift-proof).
--   * No enum types — `subject_type`/`category`/`status` are plain text, range
--     enforced in the Zod schema at the route (app-level), so adding a category
--     later needs no migration.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subject_type" text NOT NULL,
  "user_id"      uuid,
  "avatar_id"    uuid,
  "agent_id"     text,
  "fp_hash"      text,
  "category"     text NOT NULL,
  "subject"      text,
  "message"      text NOT NULL,
  "context"      jsonb,
  "status"       text NOT NULL DEFAULT 'open',
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "support_tickets_created_at_idx" ON "support_tickets" ("created_at");
CREATE INDEX IF NOT EXISTS "support_tickets_user_id_idx"    ON "support_tickets" ("user_id");
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx"     ON "support_tickets" ("status");
