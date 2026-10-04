import { describe, expect, test } from 'bun:test';

// Pins the SQL of the shared durable-history query (security pass 2026-10-04,
// Codex BLOCKING on protocol 83). Replay, the SSE catch-up and the autonomy
// driver wake-seed all read through it, so ONE statement must:
//   (1) join the agent's openclaw_bots row and require its CURRENT user_id to be
//       the proven owner (a stale proof reads nothing; no TOCTOU),
//   (2) keep only events with ts >= openclaw_bots.owner_since (the current
//       owner's period, migration 0079_agent_owner_since.sql),
//   (3) drop rows attributed to another user (user_id IS NULL OR = owner),
// and still select only the four SAFE columns. `.toSQL()` renders without a
// connection; the same SQL runs on PostgreSQL in agent-owner-since.db.test.ts.

// `||=`, not `??=`: the isolated runner passes DATABASE_URL='' (empty string).
process.env.DATABASE_URL ||= 'postgres://unit:unit@127.0.0.1:1/unit_no_connect';

const { buildDurableAgentEventsQuery } = await import('../agent-event-query');
const { AGENT_STREAM_EVENT_TYPES } = await import('../agent-stream-config');

const SCOPE = { agentId: 'scope-agent', ownerUserId: '96666666-6666-4666-8666-666666666666' };

function render(order: 'asc' | 'desc') {
  const { sql, params } = buildDurableAgentEventsQuery(SCOPE, 41n, 25, order).toSQL();
  return { sql: sql.replace(/\s+/g, ' '), params };
}

describe('durable history query: owner-period scope in ONE statement', () => {
  for (const order of ['asc', 'desc'] as const) {
    test(`${order}: owner re-check, owner_since period and user attribution clauses are all present`, () => {
      const { sql, params } = render(order);
      expect(sql).toContain('from "events" inner join "openclaw_bots" on "openclaw_bots"."agent_id" = "events"."agent_id"');
      expect(sql).toContain('"events"."agent_id" = $1');
      expect(sql).toContain('"openclaw_bots"."user_id" = $2');
      expect(sql).toContain('"events"."ts" >= "openclaw_bots"."owner_since"');
      expect(sql).toContain('("events"."user_id" is null or "events"."user_id" = "openclaw_bots"."user_id")');
      expect(sql).toContain('"events"."event_type" in (');
      expect(sql).toContain('"events"."id" > $');
      expect(sql).toContain(`order by "events"."id" ${order}`);
      expect(params[0]).toBe(SCOPE.agentId);
      expect(params[1]).toBe(SCOPE.ownerUserId);
      expect(params).toContain(25);
      for (const eventType of AGENT_STREAM_EVENT_TYPES) expect(params).toContain(eventType);
    });

    test(`${order}: SAFE COLUMNS ONLY (no bot or user columns leave the query)`, () => {
      const { sql } = render(order);
      const selectList = sql.slice('select '.length, sql.indexOf(' from '));
      expect(selectList).toBe('"events"."id", "events"."event_type", "events"."ts", "events"."payload"');
    });
  }
});
