-- 0079_agent_owner_since.sql — security pass 2026-10-04 (Codex BLOCKING on protocol 83).
--
-- ADDITIVE + IDEMPOTENT. Adds one column, one trigger function and one trigger
-- to "openclaw_bots". It drops or rewrites no existing column, index or row
-- value. The file runs as one implicit transaction, so a failure applies
-- nothing. NEVER apply via drizzle-kit push.
--
-- WHY: the agent's durable event history (GET /api/agent/:sessionId/events/replay,
-- the SSE Last-Event-ID catch-up, and the autonomy driver's wake-seed) is
-- owner-private: it carries the owner's directive text (agent.directive.set),
-- cove settlements and store sales. Protocol 83 gated it on owner proof, but the
-- query filtered only by agent_id, so after an ownership change the NEW owner
-- read the PRIOR owner's events. "owner_since" marks the start of the current
-- owner's period; apps/api/src/services/agent-event-query.ts returns only events
-- with ts >= owner_since, in the same statement that re-checks the proven owner.
--
-- WHO SETS IT: this trigger, and only this trigger. About 40 application write
-- sites touch openclaw_bots (connect, identity claim, redemption bind, Hatcher
-- register/patch, hosted provisioning, house seeder, trading provisioning, ...)
-- and the users FK is ON DELETE SET NULL, so an application-side stamp would
-- miss paths. The trigger fires on every INSERT and on every UPDATE whose SET
-- list names user_id or owner_since (an ON DELETE SET NULL referential action
-- is such an UPDATE):
--   * INSERT                                   -> owner_since = clock_timestamp()
--   * UPDATE, user_id IS DISTINCT FROM old one -> owner_since = clock_timestamp()
--     (owner -> other owner, NULL -> owner, owner -> NULL)
--   * UPDATE, user_id unchanged                -> owner_since = OLD.owner_since
--     (an application write to owner_since is ignored)
-- clock_timestamp(), not now(): now() is the transaction START, so a long
-- ownership-change transaction would date the new period before its own UPDATE
-- and widen the window in which a late prior-owner event row lands inside it.
--
-- BACKFILL: every existing row gets the migration time (ADD COLUMN ... DEFAULT
-- now() fills existing rows with this transaction's now()). There is no
-- ownership audit log: user_id is rewritten in place by many paths, the FK
-- cascade nulls it silently, a deleted owner's events keep user_id NULL, and
-- most agent event rows carry no user_id at all. So no existing row can be
-- PROVEN to have had one owner, and any earlier value could expose a prior
-- owner's directives. The cost is one-time: events written before this
-- migration are hidden from replay, SSE catch-up and the wake-seed. Hiding
-- history is acceptable; leaking it is not.
--
-- LOCKS (Codex round 3 hygiene): ADD COLUMN with a non-volatile default
-- (now() is stable) is a metadata-only change, and the trigger drop + create
-- needs a brief lock on "openclaw_bots". Each step still waits for its table
-- lock behind live traffic, and a queued lock request blocks every later
-- reader of the table. migrate-ci.ts sends the whole file as ONE simple-query message
-- (postgres.js unsafe() with no parameters), which PostgreSQL runs as one
-- implicit transaction, so SET LOCAL bounds every lock wait in this file to 5 s
-- and ends with the file. A timeout fails the file, rolls it back whole, and
-- the CI migrate job fails; a rerun is safe (every step is idempotent).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "openclaw_bots"
  ADD COLUMN IF NOT EXISTS "owner_since" timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION "clawville_openclaw_bots_owner_since"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."owner_since" := clock_timestamp();
  ELSIF NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
    NEW."owner_since" := clock_timestamp();
  ELSE
    NEW."owner_since" := OLD."owner_since";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "openclaw_bots_owner_since" ON "openclaw_bots";
CREATE TRIGGER "openclaw_bots_owner_since"
  BEFORE INSERT OR UPDATE OF "user_id", "owner_since" ON "openclaw_bots"
  FOR EACH ROW EXECUTE FUNCTION "clawville_openclaw_bots_owner_since"();
