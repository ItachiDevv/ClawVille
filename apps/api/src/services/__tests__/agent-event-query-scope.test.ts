import { describe, expect, test } from 'bun:test';

// Pins the SQL of the shared durable-history query (security pass 2026-10-04,
// Codex BLOCKING on protocol 83, round 2 BLOCKING A). Replay, the SSE catch-up
// and the autonomy driver wake-seed all read through it, so ONE statement must:
//   (1) join the agent's openclaw_bots row and require its CURRENT user_id to be
//       the proven owner (a stale proof reads nothing; no TOCTOU),
//   (2) keep only events with ts >= openclaw_bots.owner_since (the current
//       owner's period, migration 0079_agent_owner_since.sql),
//   (3) require owner attribution: user_id = owner, or user_id IS NULL only for
//       a NON-private event type (an owner-private type never admits NULL),
// and still select only the four SAFE columns. `.toSQL()` renders without a
// connection; the same SQL runs on PostgreSQL in agent-owner-since.db.test.ts.

// `||=`, not `??=`: the isolated runner passes DATABASE_URL='' (empty string).
process.env.DATABASE_URL ||= 'postgres://unit:unit@127.0.0.1:1/unit_no_connect';

const { buildDurableAgentEventsQuery } = await import('../agent-event-query');
const {
  AGENT_STREAM_EVENT_TYPES,
  AGENT_STREAM_NON_PRIVATE_EVENT_TYPES,
  AGENT_STREAM_OWNER_PRIVATE_EVENT_TYPES,
} = await import('../agent-stream-config');

const SCOPE = { agentId: 'scope-agent', ownerUserId: '96666666-6666-4666-8666-666666666666' };

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
      expect(sql).toContain('"events"."event_type" in (');
      expect(sql).toContain('"events"."id" > $');
      expect(sql).toContain(`order by "events"."id" ${order}`);
      expect(params[0]).toBe(SCOPE.agentId);
      expect(params[1]).toBe(SCOPE.ownerUserId);
      expect(params).toContain(25);
      for (const eventType of AGENT_STREAM_EVENT_TYPES) expect(params).toContain(eventType);
    });

    test(`${order}: NULL attribution is admitted ONLY for the non-private types`, () => {
      const { sql, params } = render(order);
      const nonPrivate = AGENT_STREAM_NON_PRIVATE_EVENT_TYPES.length;
      // The attribution clause: owner-attributed, or NULL AND a non-private type.
      expect(sql).toContain(
        `("events"."user_id" = "openclaw_bots"."user_id" or ("events"."user_id" is null and "events"."event_type" in (${placeholders(3, nonPrivate)})))`,
      );
      // The old blanket "user_id is null or ..." form is gone.
      expect(sql).not.toContain('"events"."user_id" is null or');
      // The NULL-admitting list binds exactly the non-private types, and no
      // owner-private type.
      const nullList = params.slice(2, 2 + nonPrivate);
      expect([...nullList].sort()).toEqual([...AGENT_STREAM_NON_PRIVATE_EVENT_TYPES].sort());
      for (const privateType of AGENT_STREAM_OWNER_PRIVATE_EVENT_TYPES) expect(nullList).not.toContain(privateType);
      // The whitelist list (the next IN list) binds every replayable type.
      const whitelist = params.slice(2 + nonPrivate, 2 + nonPrivate + AGENT_STREAM_EVENT_TYPES.length);
      expect([...whitelist].sort()).toEqual([...AGENT_STREAM_EVENT_TYPES].sort());
      expect(sql).toContain(
        `"events"."event_type" in (${placeholders(3 + nonPrivate, AGENT_STREAM_EVENT_TYPES.length)})`,
      );
    });

    test(`${order}: SAFE COLUMNS ONLY (no bot or user columns leave the query)`, () => {
      const { sql } = render(order);
      const selectList = sql.slice('select '.length, sql.indexOf(' from '));
      expect(selectList).toBe('"events"."id", "events"."event_type", "events"."ts", "events"."payload"');
    });
  }
});

describe('replay whitelist classification (owner-private vs non-private)', () => {
  test('every replayable type is classified exactly once', () => {
    const privateSet = new Set<string>(AGENT_STREAM_OWNER_PRIVATE_EVENT_TYPES);
    const nonPrivateSet = new Set<string>(AGENT_STREAM_NON_PRIVATE_EVENT_TYPES);
    for (const t of privateSet) expect(nonPrivateSet.has(t)).toBe(false);
    expect([...AGENT_STREAM_EVENT_TYPES].sort() as string[]).toEqual([...privateSet, ...nonPrivateSet].sort());
    expect(new Set(AGENT_STREAM_EVENT_TYPES).size).toBe(AGENT_STREAM_EVENT_TYPES.length);
  });

  test('pinned classification: owner content is private, world facts are non-private', () => {
    expect([...AGENT_STREAM_OWNER_PRIVATE_EVENT_TYPES].sort()).toEqual([
      'agent.directive.set',
      'agent.knowledge_added',
      'cove.baccarat.coup.settled',
      'cove.blackjack.hand.settled',
      'cove.holdem.hand.settled',
      'cove.slots.spin.executed',
      'land.service.sold',
    ]);
    expect([...AGENT_STREAM_NON_PRIVATE_EVENT_TYPES].sort()).toEqual(['agent.chat.turn', 'building.visited']);
  });
});
