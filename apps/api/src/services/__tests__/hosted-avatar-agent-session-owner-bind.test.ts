import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * connect-sec round 4 (2026-10-01, session lens minor 2):
 * `ensureHostedAvatarAgentSession` writes `userId` into the agent row. It must
 *   - refuse a row that a DIFFERENT account owns (read under the lock, and again
 *     as a compare-and-set on the UPDATE for a /connect bind that lands between);
 *   - on an unowned -> owned bind, mark the owner fence and evict the agent's
 *     other live sessions after the commit and BEFORE registerAgentBot, through
 *     the shared helper `fenceAndEvictOnOwnerBind` (agent-owner-bind-eviction.ts);
 *   - leave a same-owner re-mint unchanged (no fence mark, no eviction).
 *
 * DB-free: the database is a proxy over the real module with a scripted row.
 * The sim is the real npcSimulation. The eviction helper is mocked by its module
 * path; the mock does what the helper does (fence mark, then evict every live
 * session of the agent) and records the call order.
 */

const OWNER = '31111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '32222222-2222-4222-8222-222222222222';
const PLATFORM_AGENT_ID = '33333333-3333-4333-8333-333333333333';
const ROW_ID = '34444444-4444-4444-8444-444444444444';

let row: Record<string, unknown> | null = null;
/** Simulates a /connect owner bind that commits between the read and the UPDATE. */
let ownerBoundBeforeUpdate: string | null = null;
let order: string[] = [];
let fenceCalls: string[] = [];
let lastUpdateWhere: SQL | null = null;

const realDatabase = await import('@clawville/database');
const realDatabaseCopy = { ...realDatabase };
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

const tx = {
  execute: async () => undefined,
  query: {
    agentBots: { findFirst: async () => (row ? { ...row } : undefined) },
  },
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: (where: SQL) => ({
        returning: async () => {
          order.push('update');
          lastUpdateWhere = where;
          if (!row) return [];
          if (ownerBoundBeforeUpdate) row.userId = ownerBoundBeforeUpdate;
          // The predicate under test: id match AND (user_id IS NULL OR user_id = owner).
          if (row.userId !== null && row.userId !== values.userId) return [];
          Object.assign(row, values);
          return [{ id: row.id }];
        },
      }),
    }),
  }),
  insert: () => ({
    values: async (values: Record<string, unknown>) => {
      order.push('insert');
      row = { id: ROW_ID, ...values };
    },
  }),
};

const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'query') {
      return {
        avatars: {
          findFirst: async () => ({
            id: '35555555-5555-4555-8555-555555555555',
            userId: OWNER,
            name: 'Owner Bind Hosted',
            modelKey: 'milady_official_1',
            isGuest: false,
          }),
        },
        // Post-commit recheck of the committed bearer hash.
        agentBots: {
          findFirst: async () => (row ? { sessionKeyHash: row.sessionKeyHash } : undefined),
        },
      };
    }
    if (property === 'transaction') {
      return async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx);
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});
mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const { npcSimulation } = await import('../npc-simulation');
const { markAgentOwnedNow, ownerBindSnapshot, agentOwnerBoundSince, __resetAgentOwnerFenceForTests } =
  await import('../agent-owner-fence');

mock.module('../agent-owner-bind-eviction', () => ({
  fenceAndEvictOnOwnerBind: (agentId: string) => {
    order.push('fence');
    fenceCalls.push(agentId);
    markAgentOwnedNow(agentId);
    for (const stale of npcSimulation.findActiveSessionsByAgentIds([agentId])) {
      npcSimulation.unregisterAgentBot(stale);
    }
  },
}));

const { ensureHostedAvatarAgentSession, HostedAvatarAgentError, _resetHostedAvatarRegistry } =
  await import('../hosted-avatar-agent-session');
const { buildHostedAvatarAgentConfig } = await import('../hosted-avatar-agent-session-plan');
type SubstrateClient = import('../agent-substrate-client').AgentSubstrateClient;

const realRegister = npcSimulation.registerAgentBot.bind(npcSimulation);
npcSimulation.registerAgentBot = ((...args: Parameters<typeof realRegister>) => {
  order.push('register');
  return realRegister(...args);
}) as typeof npcSimulation.registerAgentBot;

const created = new Set<string>();

/** A live session of the agent that was issued while the row had no owner. */
function registerStray(sessionId: string): void {
  const base = buildHostedAvatarAgentConfig({
    agentId: PLATFORM_AGENT_ID,
    sessionId,
    ownerUserId: OWNER,
    modelKey: 'milady_official_1',
    name: 'Stray',
  });
  realRegister(
    { ...base, ledgerCapable: false, boundUserId: null } as typeof base,
    { getProtocol: () => 'nanoclaw' } as unknown as SubstrateClient,
  );
  created.add(sessionId);
}

function agentRow(userId: string | null): Record<string, unknown> {
  return {
    id: ROW_ID,
    agentId: PLATFORM_AGENT_ID,
    identityType: 'milady',
    userId,
    sessionKeyHash: 'old-hash',
  };
}

beforeEach(() => {
  __resetAgentOwnerFenceForTests();
  _resetHostedAvatarRegistry();
  row = null;
  ownerBoundBeforeUpdate = null;
  order = [];
  fenceCalls = [];
  lastUpdateWhere = null;
});

afterEach(() => {
  for (const sid of npcSimulation.findActiveSessionsByAgentIds([PLATFORM_AGENT_ID])) {
    npcSimulation.unregisterAgentBot(sid);
  }
  for (const sid of created) npcSimulation.unregisterAgentBot(sid);
  created.clear();
});

afterAll(() => {
  delete (npcSimulation as unknown as Record<string, unknown>).registerAgentBot;
  _resetHostedAvatarRegistry();
  __resetAgentOwnerFenceForTests();
  mock.module('@clawville/database', () => realDatabaseCopy);
});

describe('hosted avatar-agent mint: owner check, fence and eviction', () => {
  test('a row with a DIFFERENT owner is refused: no UPDATE, no fence, no body', async () => {
    row = agentRow(OTHER_OWNER);
    registerStray('oc-other-owner-session');
    const snapshot = ownerBindSnapshot();

    await expect(ensureHostedAvatarAgentSession(PLATFORM_AGENT_ID)).rejects.toBeInstanceOf(
      HostedAvatarAgentError,
    );
    expect(order).toEqual([]);
    expect(fenceCalls).toEqual([]);
    expect(row?.userId).toBe(OTHER_OWNER);
    expect(agentOwnerBoundSince(PLATFORM_AGENT_ID, snapshot)).toBe(false);
    // The other owner's live session is not touched.
    expect(npcSimulation.isValidAgentSession('oc-other-owner-session')).toBe(true);
  });

  test('an owner bind that lands between the read and the UPDATE is refused (owner compare-and-set)', async () => {
    row = agentRow(null);
    ownerBoundBeforeUpdate = OTHER_OWNER;

    await expect(ensureHostedAvatarAgentSession(PLATFORM_AGENT_ID)).rejects.toThrow(
      /owner changed during the mint/,
    );
    expect(order).toEqual(['update']);
    expect(fenceCalls).toEqual([]);
    expect(row?.userId).toBe(OTHER_OWNER);
    // The UPDATE predicate carries the owner compare-and-set.
    const rendered = new PgDialect().sqlToQuery(lastUpdateWhere!).sql;
    expect(rendered).toContain('"user_id" is null');
    expect(rendered).toContain('"user_id" = $');
  });

  test('an UNOWNED row: fence marked and strays evicted after the commit, before registerAgentBot', async () => {
    row = agentRow(null);
    registerStray('oc-stray-unowned');
    const snapshot = ownerBindSnapshot();

    const session = await ensureHostedAvatarAgentSession(PLATFORM_AGENT_ID);

    expect(session).not.toBeNull();
    expect(session!.reused).toBe(false);
    expect(order).toEqual(['update', 'fence', 'register']);
    expect(fenceCalls).toEqual([PLATFORM_AGENT_ID]);
    expect(agentOwnerBoundSince(PLATFORM_AGENT_ID, snapshot)).toBe(true);
    expect(npcSimulation.isValidAgentSession('oc-stray-unowned')).toBe(false);
    expect(npcSimulation.isValidAgentSession(session!.bearer)).toBe(true);
    expect(npcSimulation.findActiveSessionsByAgentIds([PLATFORM_AGENT_ID])).toEqual([session!.bearer]);
    expect(row?.userId).toBe(OWNER);
  });

  test('NO row yet (insert): treated as unowned -> owned, fence marked and strays evicted', async () => {
    row = null;
    registerStray('oc-stray-no-row');

    const session = await ensureHostedAvatarAgentSession(PLATFORM_AGENT_ID);

    expect(order).toEqual(['insert', 'fence', 'register']);
    expect(fenceCalls).toEqual([PLATFORM_AGENT_ID]);
    expect(npcSimulation.isValidAgentSession('oc-stray-no-row')).toBe(false);
    expect(npcSimulation.isValidAgentSession(session!.bearer)).toBe(true);
  });

  test('the SAME owner: unchanged (UPDATE, no fence mark, no eviction call)', async () => {
    row = agentRow(OWNER);
    const snapshot = ownerBindSnapshot();

    const session = await ensureHostedAvatarAgentSession(PLATFORM_AGENT_ID);

    expect(session).not.toBeNull();
    expect(session!.reused).toBe(false);
    expect(order).toEqual(['update', 'register']);
    expect(fenceCalls).toEqual([]);
    expect(agentOwnerBoundSince(PLATFORM_AGENT_ID, snapshot)).toBe(false);
    expect(row?.userId).toBe(OWNER);
    expect(row?.sessionKeyHash).not.toBe('old-hash');
  });
});
