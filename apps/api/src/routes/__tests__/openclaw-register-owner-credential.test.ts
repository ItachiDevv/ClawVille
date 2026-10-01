import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

// Security 2026-09-30: the legacy UNAUTHENTICATED POST /api/openclaw/register
// rewrote an OWNED openclaw_bots row (gateway, mode, TTL, bearer hash) and moved
// its body. It has no credential path, so any owned row is refused (409
// owner_credential_required); the refresh UPDATE carries a `user_id IS NULL` CAS,
// and the body registers directly after that write, before the platform-agent awaits.

process.env.FINGERPRINT_SECRET ??= '42'.repeat(32);

const OWNER_ID = '61111111-1111-4111-8111-111111111111';
const SYSTEM_USER_ID = '62222222-2222-4222-8222-222222222222';
const BOT_ID = '63333333-3333-4333-8333-333333333333';

let botRow: Record<string, unknown> | null = null;
let registerCallsAtFirstPlatformRead: number | null = null;
let updateReturns: () => unknown[] = () => [];
let botUpdateCalls: Array<{ values: Record<string, unknown>; where: unknown }> = [];
let botInsertCalls = 0;
let onBotInsert: () => void = () => {};

const realDatabase = await import('@clawville/database');
// Copies taken BEFORE the mocks, restored in afterAll, so a single-process run
// does not leak this file's stubs into later test files.
const restoreModules: Array<[string, Record<string, unknown>]> = [['@clawville/database', { ...realDatabase }]];
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'query') {
      return {
        agentBots: {
          findFirst: async () => (botRow ? { ...botRow } : undefined),
        },
        users: {
          findFirst: async () => ({ id: SYSTEM_USER_ID }),
        },
      };
    }
    if (property === 'select') {
      // The per-request platform-agent lookup (the system user id is cached
      // after the first call, so this select is the first await every time).
      return () => ({
        from: () => ({
          where: async () => {
            registerCallsAtFirstPlatformRead ??= registerCalls;
            return [];
          },
        }),
      });
    }
    if (property === 'insert') {
      return (table: unknown) => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            if (table === realDatabase.agentBots) {
              botInsertCalls++;
              onBotInsert();
            }
            return [{ ...values, id: table === realDatabase.agentBots ? BOT_ID : 'platform-agent-id' }];
          },
        }),
      });
    }
    if (property === 'update') {
      return (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (where: unknown) => {
            const rows = table === realDatabase.agentBots ? updateReturns() : [];
            if (table === realDatabase.agentBots) botUpdateCalls.push({ values, where });
            const result = Promise.resolve(rows) as unknown as Promise<unknown[]> & {
              returning: () => Promise<unknown[]>;
            };
            result.returning = async () => rows;
            return result;
          },
        }),
      });
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});

mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const { openclawRoutes } = await import('../openclaw');
const { npcSimulation } = await import('../../services/npc-simulation');
const { markAgentOwnedNow, __resetAgentOwnerFenceForTests } = await import('../../services/agent-owner-fence');

let registerCalls = 0;
const registeredSessions = new Set<string>();
const realRegister = npcSimulation.registerAgentBot.bind(npcSimulation);
npcSimulation.registerAgentBot = ((...args: Parameters<typeof realRegister>) => {
  registerCalls++;
  registeredSessions.add(args[0].sessionId);
  return realRegister(...args);
}) as typeof npcSimulation.registerAgentBot;

const dialect = new PgDialect();
let ipCounter = 0;

function row(agentId: string, userId: string | null): Record<string, unknown> {
  return {
    id: BOT_ID,
    agentId,
    identityType: 'openclaw',
    userId,
    gatewayUrl: 'https://owner.example/v1',
    protocol: 'openai-compat',
    mode: 'avatar',
    name: 'Owned Bot',
    species: 'milady_official_1',
    color: 0x112233,
    totalSessions: 2,
    knowledge: [],
    metadata: null,
  };
}

async function register(agentId: string) {
  const app = new Hono();
  app.route('/api/openclaw', openclawRoutes);
  ipCounter++;
  const response = await app.request('/api/openclaw/register?skipPing=1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cf-connecting-ip': `203.0.113.${(ipCounter % 250) + 1}`,
    },
    body: JSON.stringify({
      mode: 'avatar',
      gatewayUrl: 'https://intruder.example/v1',
      authToken: '',
      agentId,
      sessionKey: 'legacy-session-key',
      name: 'Legacy Bot',
      species: 'milady_official_1',
      color: 0x445566,
      stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
      personality: 'legacy register test',
      homeX: 2560,
      homeY: 2560,
      patrolRadius: 100,
    }),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

function expectOwnerCredentialRefusal(result: { status: number; json: Record<string, unknown> }) {
  expect(result.status).toBe(409);
  expect(result.json).toEqual({
    error:
      'This agentId already has an owner. Reconnect with an owner credential: your identityKey on /api/agent/connect '
      + '(every agent type except Milady), a new magic-link connection token from the owning account, or the signed '
      + '/api/agent/reconnect with your saved identity.secretKey. A Milady agent has no identityKey: use the signed '
      + '/api/agent/reconnect, or ask the owner for a new magic link.',
    code: 'owner_credential_required',
  });
  expect(JSON.stringify(result.json)).not.toContain(OWNER_ID);
  expect(result.json).not.toHaveProperty('sessionId');
}

beforeEach(() => {
  botRow = null;
  registerCallsAtFirstPlatformRead = null;
  updateReturns = () => [];
  botUpdateCalls = [];
  botInsertCalls = 0;
  onBotInsert = () => {};
  registerCalls = 0;
  __resetAgentOwnerFenceForTests();
});

afterAll(() => {
  for (const sessionId of registeredSessions) npcSimulation.unregisterAgentBot(sessionId);
  delete (npcSimulation as unknown as Record<string, unknown>).registerAgentBot;
  for (const [path, real] of restoreModules) mock.module(path, () => real);
});

describe('POST /api/openclaw/register owner credential rule', () => {
  test('an owned row is refused before any UPDATE or body registration', async () => {
    botRow = row('legacy-owned-bot', OWNER_ID);
    const result = await register('legacy-owned-bot');
    expectOwnerCredentialRefusal(result);
    expect(botUpdateCalls).toHaveLength(0);
    expect(botInsertCalls).toBe(0);
    expect(registerCalls).toBe(0);
  });

  test('an unowned row still registers, and the refresh carries the CAS', async () => {
    botRow = row('legacy-unowned-bot', null);
    updateReturns = () => [{ id: BOT_ID }];
    const result = await register('legacy-unowned-bot');
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      botId: BOT_ID,
      agentId: 'legacy-unowned-bot',
      isReturning: true,
      totalSessions: 3,
    });
    expect(botUpdateCalls).toHaveLength(1);
    expect(botUpdateCalls[0].values).not.toHaveProperty('userId');
    expect(dialect.sqlToQuery(botUpdateCalls[0].where as Parameters<PgDialect['sqlToQuery']>[0]).sql)
      .toBe('("openclaw_bots"."id" = $1 and "openclaw_bots"."user_id" is null)');
    expect(registerCalls).toBe(1);
  });

  test('a row bound after the snapshot read loses the CAS and is refused', async () => {
    botRow = row('legacy-raced-bot', null);
    updateReturns = () => [];
    const result = await register('legacy-raced-bot');
    expectOwnerCredentialRefusal(result);
    expect(botUpdateCalls).toHaveLength(1);
    expect(registerCalls).toBe(0);
  });

  test('the body registers directly after the CAS write, before any platform-agent await', async () => {
    botRow = row('legacy-ordered-bot', null);
    updateReturns = () => [{ id: BOT_ID }];
    const result = await register('legacy-ordered-bot');
    expect(result.status).toBe(200);
    expect(registerCalls).toBe(1);
    // The first platform-agent DB read (system user lookup) happens AFTER the
    // body registered, so no owner bind can land between the CAS and the body.
    expect(registerCallsAtFirstPlatformRead).toBe(1);
  });

  // Round 2b: the CAS write commits while the row is unowned, but an owner
  // bind lands (and marks the in-process owner fence) before this request
  // sees its UPDATE response. The late register must not take the body.
  test('a CAS that resolves after an owner bind is refused by the owner fence', async () => {
    botRow = row('legacy-fenced-bot', null);
    updateReturns = () => {
      markAgentOwnedNow('legacy-fenced-bot');
      return [{ id: BOT_ID }];
    };
    const result = await register('legacy-fenced-bot');
    expectOwnerCredentialRefusal(result);
    expect(botUpdateCalls).toHaveLength(1);
    expect(registerCalls).toBe(0);
    expect(npcSimulation.findActiveSessionsByAgentIds(['legacy-fenced-bot'])).toEqual([]);
  });

  test('a new-row register is refused when an owner bind lands while the INSERT is in flight', async () => {
    onBotInsert = () => markAgentOwnedNow('legacy-fenced-new-bot');
    const result = await register('legacy-fenced-new-bot');
    expectOwnerCredentialRefusal(result);
    expect(botInsertCalls).toBe(1);
    expect(registerCalls).toBe(0);
  });

  // connect-sec round 4 (C10, Codex C2): the fence is a bind sequence taken at
  // handler start, not a five-minute clock. A register whose UPDATE response
  // arrives more than five minutes after the owner-bind mark is still refused.
  test('a CAS that resolves more than five minutes after the owner-bind mark is still refused', async () => {
    const FIVE_MINUTES = 5 * 60_000;
    botRow = row('legacy-stalled-bot', null);
    updateReturns = () => {
      markAgentOwnedNow('legacy-stalled-bot', Date.now() - FIVE_MINUTES - 1_000);
      return [{ id: BOT_ID }];
    };
    const result = await register('legacy-stalled-bot');
    expectOwnerCredentialRefusal(result);
    expect(botUpdateCalls).toHaveLength(1);
    expect(registerCalls).toBe(0);
    expect(npcSimulation.findActiveSessionsByAgentIds(['legacy-stalled-bot'])).toEqual([]);
  });

  test('an owner bind marked before this register started does not refuse an unowned row', async () => {
    markAgentOwnedNow('legacy-earlier-bind-bot');
    botRow = row('legacy-earlier-bind-bot', null);
    updateReturns = () => [{ id: BOT_ID }];
    const result = await register('legacy-earlier-bind-bot');
    expect(result.status).toBe(200);
    expect(registerCalls).toBe(1);
  });

  test('a fence mark for another agentId does not refuse this register', async () => {
    markAgentOwnedNow('some-other-bot');
    botRow = row('legacy-unfenced-bot', null);
    updateReturns = () => [{ id: BOT_ID }];
    const result = await register('legacy-unfenced-bot');
    expect(result.status).toBe(200);
    expect(registerCalls).toBe(1);
  });
});
