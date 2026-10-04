import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Pins the SQL of the shared durable-history query (security pass 2026-10-04,
// Codex BLOCKING on protocol 83, round 3 BLOCKING: event history is
// owner-only). Replay, the SSE catch-up and the autonomy driver wake-seed all
// read through it, so ONE statement must:
//   (1) join the agent's openclaw_bots row and require its CURRENT user_id to be
//       the proven owner (a stale proof reads nothing; no TOCTOU),
//   (2) keep only events with ts >= openclaw_bots.owner_since (the current
//       owner's period, migration 0079_agent_owner_since.sql),
//   (3) require owner attribution for EVERY type: events.user_id = owner. A
//       NULL-attributed row is never admitted (no IS NULL branch, no OR),
// and still select only the four SAFE columns. `.toSQL()` renders without a
// connection; the same SQL runs on PostgreSQL in agent-owner-since.db.test.ts.

// `||=`, not `??=`: the isolated runner passes DATABASE_URL='' (empty string).
const priorDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL ||= 'postgres://unit:unit@127.0.0.1:1/unit_no_connect';

const { buildDurableAgentEventsQuery } = await import('../agent-event-query');
const { AGENT_STREAM_EVENT_TYPES } = await import('../agent-stream-config');

const SCOPE = { agentId: 'scope-agent', ownerUserId: '96666666-6666-4666-8666-666666666666' };

// Warm the lazy db singleton, then restore DATABASE_URL at once: CI runs many
// files in ONE bun process, and a leaked fake URL makes later DB-gated suites
// stop skipping and fail on 127.0.0.1:1.
buildDurableAgentEventsQuery(SCOPE, 0n, 1, 'asc').toSQL();
if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = priorDatabaseUrl;

function render(order: 'asc' | 'desc') {
  const { sql, params } = buildDurableAgentEventsQuery(SCOPE, 41n, 25, order).toSQL();
  return { sql: sql.replace(/\s+/g, ' '), params };
}

/** `$n, $n+1, ...` placeholders for a list of `count` params starting at `first`. */
function placeholders(first: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `$${first + i}`).join(', ');
}

describe('durable history query: owner-period scope in ONE statement', () => {
  for (const order of ['asc', 'desc'] as const) {
    test(`${order}: owner re-check, owner_since period and user attribution clauses are all present`, () => {
      const { sql, params } = render(order);
      expect(sql).toContain('from "events" inner join "openclaw_bots" on "openclaw_bots"."agent_id" = "events"."agent_id"');
      expect(sql).toContain('"events"."agent_id" = $1');
      expect(sql).toContain('"openclaw_bots"."user_id" = $2');
      expect(sql).toContain('"events"."ts" >= "openclaw_bots"."owner_since"');
      expect(sql).toContain('"events"."id" > $');
      expect(sql).toContain(`order by "events"."id" ${order}`);
      expect(params[0]).toBe(SCOPE.agentId);
      expect(params[1]).toBe(SCOPE.ownerUserId);
      expect(params).toContain(25);
    });

    test(`${order}: every row must be owner-attributed; NULL attribution is never admitted`, () => {
      const { sql, params } = render(order);
      // The attribution clause is a plain AND-ed equality on the owner column.
      expect(sql).toContain(
        '"events"."ts" >= "openclaw_bots"."owner_since" and "events"."user_id" = "openclaw_bots"."user_id" and "events"."event_type" in (',
      );
      // No NULL branch and no OR anywhere in the statement (fail closed).
      expect(sql).not.toContain('is null');
      expect(sql).not.toMatch(/\bor\b/);
      // Exactly ONE event_type list, and it binds exactly the whitelist.
      expect(sql.split('"events"."event_type" in (').length - 1).toBe(1);
      expect(sql).toContain(`"events"."event_type" in (${placeholders(3, AGENT_STREAM_EVENT_TYPES.length)})`);
      const whitelist = params.slice(2, 2 + AGENT_STREAM_EVENT_TYPES.length);
      expect([...whitelist].sort()).toEqual([...AGENT_STREAM_EVENT_TYPES].sort());
    });

    test(`${order}: SAFE COLUMNS ONLY (no bot or user columns leave the query)`, () => {
      const { sql } = render(order);
      const selectList = sql.slice('select '.length, sql.indexOf(' from '));
      expect(selectList).toBe('"events"."id", "events"."event_type", "events"."ts", "events"."payload"');
    });
  }
});

describe('replay whitelist', () => {
  test('pinned list, no duplicates', () => {
    expect([...AGENT_STREAM_EVENT_TYPES].sort()).toEqual([
      'agent.chat.turn',
      'agent.directive.set',
      'agent.knowledge_added',
      'building.visited',
      'cove.baccarat.coup.settled',
      'cove.blackjack.hand.settled',
      'cove.holdem.hand.settled',
      'cove.slots.spin.executed',
      'land.service.sold',
    ]);
    expect(new Set(AGENT_STREAM_EVENT_TYPES).size).toBe(AGENT_STREAM_EVENT_TYPES.length);
  });
});

describe('migration 0079_agent_owner_since.sql: bounded lock wait', () => {
  const migration = readFileSync(
    join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'database', 'migrations', '0079_agent_owner_since.sql'),
    'utf8',
  );
  const sqlOnly = migration.replace(/--[^\n]*/g, '');

  test('the first statement sets a transaction-local lock_timeout (migrate-ci runs the file as one implicit transaction)', () => {
    expect(sqlOnly.trim().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(sqlOnly.split('lock_timeout').length - 1).toBe(1);
  });

  test('the DDL is unchanged: idempotent column, trigger function and trigger', () => {
    expect(sqlOnly).toContain('ADD COLUMN IF NOT EXISTS "owner_since" timestamptz NOT NULL DEFAULT now();');
    expect(sqlOnly).toContain('CREATE OR REPLACE FUNCTION "clawville_openclaw_bots_owner_since"()');
    expect(sqlOnly).toContain('DROP TRIGGER IF EXISTS "openclaw_bots_owner_since" ON "openclaw_bots";');
    expect(sqlOnly).toContain('BEFORE INSERT OR UPDATE OF "user_id", "owner_since" ON "openclaw_bots"');
    expect(sqlOnly.indexOf('lock_timeout')).toBeLessThan(sqlOnly.indexOf('ALTER TABLE'));
  });
});
