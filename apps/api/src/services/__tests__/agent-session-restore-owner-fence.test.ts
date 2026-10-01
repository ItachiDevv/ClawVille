import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// Security 2026-10-01: session restore reads the row by bearer hash, then
// registers. If the row was read while UNOWNED and an owner bind landed in
// between (the bind evicts the agent's other sessions), restore must not bring
// the stray back. The owner fence (agent-owner-fence.ts) is the in-process check.

const AGENT_ID = 'restore-fence-agent';
let row: Record<string, unknown> | null = null;

const realDatabase = await import('@clawville/database');
const realDatabaseCopy = { ...realDatabase };
afterAll(() => {
  mock.module('@clawville/database', () => realDatabaseCopy);
});
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;
const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'query') {
      return {
        agentBots: { findFirst: async () => (row ? { ...row } : undefined) },
        avatars: { findFirst: async () => undefined },
      };
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});
mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const { restoreAgentSessionFromRow } = await import('../agent-session-restore');
const { markAgentOwnedNow, __resetAgentOwnerFenceForTests } = await import('../agent-owner-fence');
const { npcSimulation } = await import('../npc-simulation');

let registerCalls = 0;
const realRegister = npcSimulation.registerAgentBot.bind(npcSimulation);
npcSimulation.registerAgentBot = ((...args: Parameters<typeof realRegister>) => {
  registerCalls++;
  return realRegister(...args);
}) as typeof npcSimulation.registerAgentBot;
const registered = new Set<string>();

function unownedLiveRow(userId: string | null): Record<string, unknown> {
  return {
    id: '91111111-1111-4111-8111-111111111111',
    agentId: AGENT_ID,
    identityType: 'custom',
    userId,
    gatewayUrl: null,
    protocol: 'nanoclaw',
    mode: 'avatar',
    targetNpcId: null,
    name: 'Restore Fence',
    species: 'milady_official_1',
    color: null,
    knowledge: [],
    metadata: null,
    sessionExpiresAt: new Date(Date.now() + 60 * 60_000),
    sessionSweptAt: null,
    sessionKeyHash: 'unused-by-the-proxy',
  };
}

beforeEach(() => {
  __resetAgentOwnerFenceForTests();
  registerCalls = 0;
  row = null;
});

afterAll(() => {
  for (const sid of registered) npcSimulation.unregisterAgentBot(sid);
  delete (npcSimulation as unknown as Record<string, unknown>).registerAgentBot;
  __resetAgentOwnerFenceForTests();
});

describe('session restore honours the owner fence', () => {
  test('an unowned row restores when no owner bind landed', async () => {
    row = unownedLiveRow(null);
    const sid = 'ag-restore-fence-clean';
    const live = await restoreAgentSessionFromRow(sid);
    registered.add(sid);
    expect(live).not.toBeNull();
    expect(registerCalls).toBe(1);
  });

  test('an unowned row read before an owner bind is NOT restored after it', async () => {
    row = unownedLiveRow(null);
    markAgentOwnedNow(AGENT_ID);
    const sid = 'ag-restore-fence-stray';
    const live = await restoreAgentSessionFromRow(sid);
    expect(live).toBeNull();
    expect(registerCalls).toBe(0);
    expect(npcSimulation.isValidAgentSession(sid)).toBe(false);
  });

  test('an owned row still restores while the fence mark is set', async () => {
    row = unownedLiveRow('92222222-2222-4222-8222-222222222222');
    markAgentOwnedNow(AGENT_ID);
    const sid = 'ag-restore-fence-owner';
    const live = await restoreAgentSessionFromRow(sid);
    registered.add(sid);
    expect(live).not.toBeNull();
    expect(registerCalls).toBe(1);
  });
});
