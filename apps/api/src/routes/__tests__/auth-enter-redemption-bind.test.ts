import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import type { AgentSubstrateClient } from '../../services/agent-substrate-client';
import type { AppContext } from '../../types';

// Security 2026-09-30 (round 2): GET /api/auth/enter must not hand the owner
// identity to a stray session. These tests drive the real route with a db
// proxy and the real simulation: the redeemed ticket's issuing session stays,
// a stray that displaced the agent is evicted, and login still succeeds when
// the bind fails. DB-free; Lucia's session create is stubbed on the instance.

let ticketRow: Record<string, unknown> | null = null;
let botBindReturns: (index: number) => unknown[] = () => [];
let botBindThrows = false;
let botUpdates = 0;
// The fail-closed burn awaits its UPDATE with RETURNING { id } (Codex r3: rowBurned comes from the row count).
let burnThrows = false;
let burnAttempts = 0;

const realDatabase = await import('@clawville/database');
// Copies taken BEFORE the mocks, restored in afterAll, so a single-process run
// does not leak this file's stubs into later test files.
const restoreModules: Array<[string, Record<string, unknown>]> = [['@clawville/database', { ...realDatabase }]];
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'update') {
      return (table: unknown) => ({
        set: () => ({
          where: () => ({
            returning: async (columns?: Record<string, unknown>) => {
              if (table === realDatabase.agentSessionTickets) return ticketRow ? [ticketRow] : [];
              // The fail-closed burn is the only agentBots UPDATE with RETURNING { id } alone.
              if (table === realDatabase.agentBots && Object.keys(columns ?? {}).join(',') === 'id') {
                burnAttempts++;
                if (burnThrows) throw new Error('burn write failed');
                return [{ id: 'burned-row' }];
              }
              if (table === realDatabase.agentBots) {
                botUpdates++;
                if (botBindThrows) throw new Error('bind write failed');
                return botBindReturns(botUpdates);
              }
              throw new Error('unexpected update target');
            },
            then: (resolve: (rows: unknown[]) => void, reject: (err: unknown) => void) => {
              if (table !== realDatabase.agentBots) return resolve([]);
              burnAttempts++;
              if (burnThrows) return reject(new Error('burn write failed'));
              return resolve([]);
            },
          }),
        }),
      });
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});

mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const realEventLogger = await import('../../services/event-logger');
restoreModules.push(['../../services/event-logger', { ...realEventLogger }]);
mock.module('../../services/event-logger', () => ({
  ...realEventLogger,
  logEvent: async () => {},
  logEventFromContext: async () => {},
}));

const { authRoutes } = await import('../auth');
const { lucia } = await import('../../lib/auth');
const { npcSimulation } = await import('../../services/npc-simulation');
const { buildAvatarSessionConfig } = await import('../../services/agent-session-config');
const { sessionDigest, sha256Hex } = await import('../../services/session-digest');
const { isAgentQuarantined, __resetAgentOwnerFenceForTests } = await import('../../services/agent-owner-fence');

const REDEEMER = '71111111-1111-4111-8111-111111111111';
const AVATAR_ID = '72222222-2222-4222-8222-222222222222';
const BOT_ID = '73333333-3333-4333-8333-333333333333';
const liveSessions = new Set<string>();

const app = new Hono<AppContext>();
app.route('/api/auth', authRoutes);

function register(agentId: string, sessionId: string) {
  const config = buildAvatarSessionConfig({
    mode: 'avatar',
    agentId,
    sessionId,
    identityType: 'custom',
    storedProtocol: 'nanoclaw',
    autonomyMode: 'self-managed',
    name: 'Enter Bind',
    species: 'milady_official_1',
    color: 0x123456,
    stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: '',
    ledgerCapable: false,
    boundUserId: null,
  });
  const client = { getProtocol: () => 'nanoclaw' } as unknown as AgentSubstrateClient;
  npcSimulation.registerAgentBot(config, client);
  liveSessions.add(sessionId);
  return config;
}

function ticketFor(agentId: string, issuedSessionId: string) {
  return {
    userId: REDEEMER,
    avatarId: AVATAR_ID,
    ticket: 'sess-enter-bind-test',
    identityType: 'custom',
    issuedToAgentId: agentId,
    issuedToAgentSession: sessionDigest(issuedSessionId),
  };
}

async function enter() {
  return app.request('/api/auth/enter?t=sess-enter-bind-test');
}

const luciaInstance = lucia as unknown as Record<string, unknown>;
beforeAll(() => {
  luciaInstance.createSession = async () => ({
    id: 'enter-bind-test-session',
    userId: REDEEMER,
    expiresAt: new Date(Date.now() + 60_000),
    fresh: true,
  });
});

afterAll(() => {
  delete luciaInstance.createSession;
  for (const [path, real] of restoreModules) mock.module(path, () => real);
});

beforeEach(() => {
  ticketRow = null;
  botBindReturns = () => [];
  botBindThrows = false;
  botUpdates = 0;
  burnThrows = false;
  burnAttempts = 0;
});

afterEach(() => {
  for (const sid of liveSessions) npcSimulation.unregisterAgentBot(sid);
  liveSessions.clear();
});

describe('GET /api/auth/enter bind-at-redemption', () => {
  test('a first bind keeps the issuing session the row still names and evicts a stray', async () => {
    const agentId = 'enter-bind-keeper-stray';
    const keeperSid = 'ag-enter-keeper-1';
    const straySid = 'ag-enter-stray-1';
    const keeper = register(agentId, keeperSid);
    const stray = register(agentId, straySid);
    ticketRow = ticketFor(agentId, keeperSid);
    // The UPDATE returns the row hash: the CASE kept the keeper's hash.
    botBindReturns = (index) => (index === 1 ? [{ id: BOT_ID, sessionKeyHash: sha256Hex(keeperSid) }] : []);

    const response = await enter();

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(/\/game$/);
    expect(response.headers.get('set-cookie')).toContain('enter-bind-test-session');
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([keeperSid]);
    expect(keeper.boundUserId).toBe(REDEEMER);
    expect(stray.boundUserId).toBeNull();
    expect(botUpdates).toBe(1);
  });

  test('a first bind whose row hash a later connect rotated away evicts every session; login still succeeds', async () => {
    const agentId = 'enter-bind-rotated';
    const keeperSid = 'ag-enter-rotated-keeper';
    const straySid = 'ag-enter-rotated-stray';
    const keeper = register(agentId, keeperSid);
    const stray = register(agentId, straySid);
    ticketRow = ticketFor(agentId, keeperSid);
    // The CASE burned the hash: the row named the stray, not the ticket's session.
    botBindReturns = (index) => (index === 1 ? [{ id: BOT_ID, sessionKeyHash: 'f'.repeat(64) }] : []);

    const response = await enter();

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(/\/game$/);
    expect(response.headers.get('set-cookie')).toContain('enter-bind-test-session');
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([]);
    expect(keeper.boundUserId).toBeNull();
    expect(stray.boundUserId).toBeNull();
    expect(botUpdates).toBe(1);
  });

  test('a bind failure is non-fatal: login still redirects with a cookie', async () => {
    const agentId = 'enter-bind-failure';
    const sid = 'ag-enter-failure-1';
    register(agentId, sid);
    ticketRow = ticketFor(agentId, sid);
    botBindThrows = true;

    const response = await enter();

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(/\/game$/);
    expect(response.headers.get('set-cookie')).toContain('enter-bind-test-session');
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([sid]);
  });

  test('Codex r2: an unproven eviction and a throwing burn UPDATE quarantine the agent; login still succeeds', async () => {
    const agentId = 'enter-bind-burn-throw';
    const keeperSid = 'ag-enter-burn-keeper';
    const straySid = 'ag-enter-burn-stray';
    const keeper = register(agentId, keeperSid);
    register(agentId, straySid);
    ticketRow = ticketFor(agentId, keeperSid);
    botBindReturns = (index) => (index === 1 ? [{ id: BOT_ID, sessionKeyHash: sha256Hex(keeperSid) }] : []);
    burnThrows = true;
    const realUnregister = npcSimulation.unregisterAgentBot.bind(npcSimulation);
    const unregisterSpy = spyOn(npcSimulation, 'unregisterAgentBot').mockImplementation((sid: string) => {
      if (sid === straySid) throw new Error('simulated eviction fault');
      return realUnregister(sid);
    });
    const errors: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    let response: Response;
    try {
      response = await enter();
    } finally {
      unregisterSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(/\/game$/);
    expect(response.headers.get('set-cookie')).toContain('enter-bind-test-session');
    expect(burnAttempts).toBe(1);
    expect(isAgentQuarantined(agentId)).toBe(true);
    expect(npcSimulation.getAgentBotClientBySession(straySid)).toBeNull();
    expect(npcSimulation.getAgentBotClientBySession(keeperSid)).toBeNull();
    expect(keeper.boundUserId).toBeNull();
    expect(errors.some((line) => line.includes('[AuthEnter] SECURITY') && line.includes('NOT burned'))).toBe(true);
    __resetAgentOwnerFenceForTests();
  });

  test('an invalid ticket redirects to the expired-link page with no bind', async () => {
    ticketRow = null;
    const response = await enter();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=expired-link');
    expect(botUpdates).toBe(0);
  });
});
