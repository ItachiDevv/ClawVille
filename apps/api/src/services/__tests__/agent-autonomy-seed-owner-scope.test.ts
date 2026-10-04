import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// Autonomy driver wake-seed owner scope (security pass 2026-10-04, Codex
// BLOCKING on protocol 83). The driver seeds the agent's next decision prompt
// from the durable history (`queryDurableAgentEventsNewest`). It must read with
// the owner-period scope: the row owner the entry was enrolled under
// (`houseUserId`: the owner for a user agent, the house user for a house agent).
// The query re-checks that owner and returns only that owner's period, so the
// agent a NEW owner talks to is never seeded with the PRIOR owner's directives,
// and a stale entry whose row moved to another owner reads nothing and does not
// move the cursor.
//
// The query mock mirrors the three SQL clauses (owner re-check, ts >=
// owner_since, user attribution) over an in-memory table; the real SQL is pinned
// by agent-event-query-scope.test.ts and run on Postgres by
// agent-owner-since.db.test.ts.

const AGENT = 'seed-scope-agent';
const PRIOR = '97777777-7777-4777-8777-777777777777';
const OWNER = '98888888-8888-4888-8888-888888888888';
const HOUSE_USER = '99999999-9999-4999-8999-999999999999';
const MOVE_AT = new Date('2026-10-04T12:00:00Z');

interface Row {
  id: bigint;
  eventType: string;
  ts: Date;
  payload: Record<string, unknown>;
  userId: string | null;
}

/** The openclaw_bots row as the query sees it at read time. */
let row: { agentId: string; userId: string | null; ownerSince: Date } = { agentId: AGENT, userId: OWNER, ownerSince: MOVE_AT };
let table: Row[] = [];
let scopes: Array<{ agentId: string; ownerUserId: string }> = [];
let cursorWrites: Array<{ platformAgentId: string; cursor: bigint }> = [];

const ROWS: Row[] = [
  { id: 1n, eventType: 'agent.directive.set', ts: new Date('2026-10-04T11:00:00Z'), payload: { buildingId: 'prior-directive' }, userId: PRIOR },
  { id: 2n, eventType: 'cove.blackjack.hand.settled', ts: new Date('2026-10-04T11:30:00Z'), payload: { net: 77 }, userId: PRIOR },
  { id: 3n, eventType: 'building.visited', ts: new Date('2026-10-04T11:40:00Z'), payload: { buildingId: 'prior-visit' }, userId: null },
  // Late prior-owner row: landed inside the new period, still the prior owner's.
  { id: 4n, eventType: 'agent.directive.set', ts: new Date('2026-10-04T12:00:01Z'), payload: { buildingId: 'prior-late' }, userId: PRIOR },
  { id: 5n, eventType: 'agent.directive.set', ts: new Date('2026-10-04T12:05:00Z'), payload: { buildingId: 'owner-directive' }, userId: OWNER },
  { id: 6n, eventType: 'building.visited', ts: new Date('2026-10-04T12:10:00Z'), payload: { buildingId: 'owner-visit' }, userId: null },
];

const realQuery = await import('../agent-event-query');
const realState = await import('../agent-autonomy-state');
const restore: Array<[string, Record<string, unknown>]> = [
  ['../agent-event-query', { ...realQuery }],
  ['../agent-autonomy-state', { ...realState }],
];

mock.module('../agent-event-query', () => ({
  ...realQuery,
  queryDurableAgentEventsNewest: async (
    scope: { agentId: string; ownerUserId: string },
    afterId: bigint,
    limit: number,
  ) => {
    scopes.push({ ...scope });
    if (row.agentId !== scope.agentId || row.userId !== scope.ownerUserId) return [];
    return table
      .filter((r) => r.id > afterId)
      .filter((r) => r.ts.getTime() >= row.ownerSince.getTime())
      .filter((r) => r.userId === null || r.userId === row.userId)
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map(({ id, eventType, ts, payload }) => ({ id, eventType, ts, payload }));
  },
}));

mock.module('../agent-autonomy-state', () => ({
  ...realState,
  getAutonomyCursor: async () => 0n,
  setAutonomyCursor: async (platformAgentId: string, cursor: bigint) => {
    cursorWrites.push({ platformAgentId, cursor });
  },
}));

const { agentAutonomyDriver } = await import('../agent-autonomy-driver');

interface SeedEntry {
  cursorSeeded: boolean;
  recentEventSummary: string | null;
}
interface DriverInternals {
  userAgents: Map<string, SeedEntry>;
  houseAgents: Map<string, SeedEntry>;
  seedFromCursorOnce: (entry: SeedEntry) => Promise<void>;
}
const driver = agentAutonomyDriver as unknown as DriverInternals;

function enrollUser(ownerUserId: string): SeedEntry {
  agentAutonomyDriver.registerUserAgent({
    agentId: AGENT,
    bodyId: 'seed-scope-body',
    platformAgentId: 'seed-scope-platform',
    systemUserId: ownerUserId,
    houseUserId: ownerUserId,
    avatarId: 'seed-scope-avatar',
  });
  return driver.userAgents.get(AGENT)!;
}

beforeEach(() => {
  for (const id of agentAutonomyDriver.getUserAgentIds()) agentAutonomyDriver.unregisterUserAgent(id);
  for (const id of agentAutonomyDriver.getHouseAgentIds()) agentAutonomyDriver.unregisterHouseAgent(id);
  row = { agentId: AGENT, userId: OWNER, ownerSince: MOVE_AT };
  table = ROWS;
  scopes = [];
  cursorWrites = [];
});

afterAll(() => {
  for (const id of agentAutonomyDriver.getUserAgentIds()) agentAutonomyDriver.unregisterUserAgent(id);
  for (const id of agentAutonomyDriver.getHouseAgentIds()) agentAutonomyDriver.unregisterHouseAgent(id);
  for (const [path, real] of restore) mock.module(path, () => real);
});

describe('autonomy driver wake-seed reads only the current owner period', () => {
  test('the NEW owner agent is seeded with its own period only, never the prior owner directives', async () => {
    const entry = enrollUser(OWNER);
    expect(entry.cursorSeeded).toBe(false);
    await driver.seedFromCursorOnce(entry);
    expect(scopes).toEqual([{ agentId: AGENT, ownerUserId: OWNER }]);
    expect(entry.recentEventSummary).toBe('agent.directive.set(owner-directive); building.visited(owner-visit)');
    for (const prior of ['prior-directive', 'prior-visit', 'prior-late', 'net +77']) {
      expect(entry.recentEventSummary).not.toContain(prior);
    }
    // The cursor advances to the newest row of the owner's period.
    expect(cursorWrites).toEqual([{ platformAgentId: 'seed-scope-platform', cursor: 6n }]);
  });

  test('a stale entry enrolled under the PRIOR owner reads nothing and leaves the cursor alone', async () => {
    const entry = enrollUser(PRIOR);
    await driver.seedFromCursorOnce(entry);
    expect(scopes).toEqual([{ agentId: AGENT, ownerUserId: PRIOR }]);
    expect(entry.recentEventSummary).toBeNull();
    expect(cursorWrites).toEqual([]);
  });

  test('a house agent reads with its house user as the owner scope', async () => {
    row = { agentId: AGENT, userId: HOUSE_USER, ownerSince: new Date('2026-10-01T00:00:00Z') };
    table = [
      { id: 7n, eventType: 'building.visited', ts: new Date('2026-10-04T13:00:00Z'), payload: { buildingId: 'house-visit' }, userId: null },
    ];
    agentAutonomyDriver.registerHouseAgent({
      agentId: AGENT,
      bodyId: 'seed-scope-house-body',
      platformAgentId: 'seed-scope-house-platform',
      systemUserId: 'seed-scope-system',
      houseUserId: HOUSE_USER,
      avatarId: 'seed-scope-house-avatar',
    });
    const entry = driver.houseAgents.get(AGENT)!;
    await driver.seedFromCursorOnce(entry);
    expect(scopes).toEqual([{ agentId: AGENT, ownerUserId: HOUSE_USER }]);
    expect(entry.recentEventSummary).toBe('building.visited(house-visit)');
  });
});
