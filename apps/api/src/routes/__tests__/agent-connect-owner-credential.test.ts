import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { NPC_IDS } from '@clawville/shared';

// Security 2026-09-30: POST /api/agent/connect with a known agentId and no
// owner credential used to rotate an OWNED row's bearer hash and move its body,
// which evicted the owner's live session. These tests pin the refusal (409
// owner_credential_required) BEFORE any UPDATE or body registration, the
// `user_id IS NULL` CAS on the credentialless refresh, and the unchanged paths.

process.env.FINGERPRINT_SECRET ??= '41'.repeat(32);

const OWNER_ID = '51111111-1111-4111-8111-111111111111';
const AVATAR_ID = '52222222-2222-4222-8222-222222222222';
const BOT_ID = '53333333-3333-4333-8333-333333333333';

let botRow: Record<string, unknown> | null = null;
let updateReturns: (call: number) => unknown[] = () => [];
let updateCalls: Array<{ table: unknown; values: Record<string, unknown>; where: unknown }> = [];
let insertCalls = 0;
let identityResolutions = 0;
let ticketMints = 0;
let loggedEvents = 0;

const realDatabase = await import('@clawville/database');
// Copies taken BEFORE the mocks, restored in afterAll, so a single-process run
// does not leak this file's stubs into later test files.
const restoreModules: Array<[string, Record<string, unknown>]> = [['@clawville/database', { ...realDatabase }]];
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

const avatarRow = {
  id: AVATAR_ID,
  userId: OWNER_ID,
  name: 'Owner Avatar 511111',
  isActive: true,
  clawTokens: 100,
  characterConfig: { knowledge: [] },
};

const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'query') {
      return {
        avatars: {
          findFirst: async (args?: { columns?: Record<string, boolean> }) => {
            if (args?.columns?.characterConfig) return { characterConfig: { knowledge: [] } };
            return avatarRow;
          },
        },
        agentBots: {
          findFirst: async () => (botRow ? { ...botRow } : undefined),
        },
      };
    }
    if (property === 'insert') {
      return () => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            insertCalls++;
            return [{ ...values, id: BOT_ID }];
          },
        }),
      });
    }
    if (property === 'update') {
      return (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (where: unknown) => {
            updateCalls.push({ table, values, where });
            const rows = updateReturns(updateCalls.length);
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

const realIdentity = await import('../../services/identity-service');
restoreModules.push(['../../services/identity-service', { ...realIdentity }]);
mock.module('../../services/identity-service', () => ({
  ...realIdentity,
  resolvePublicOnboardingIdentity: async (identityType: string) => {
    identityResolutions++;
    return { user: { id: OWNER_ID }, identityType };
  },
  resolveOrCreateUserByIdentity: async () => {
    identityResolutions++;
    return { id: OWNER_ID, email: null, name: 'Owner', identityFingerprint: 'fingerprint', isNewUser: false };
  },
  generateIdentityKeypairForUser: async () => ({
    publicKey: 'identity-public-key',
    isFirstTime: false,
    needsHumanReauth: false,
  }),
}));

// Every mock spreads the real module so a later test file that imports another
// export (e.g. consumeTicket) never sees a partial module in a full-suite run.
// Round 4: the provisioning step awaits after the bind write; this hook
// observes what is still live at that point. Declared before the mock.
let onProvisionWallet: (() => void) | null = null;
const realWallet = await import('../../services/wallet-service');
restoreModules.push(['../../services/wallet-service', { ...realWallet }]);
mock.module('../../services/wallet-service', () => ({
  ...realWallet,
  ensureWalletWithFirstTimeSecret: async () => ({
    publicKey: 'avatar-wallet',
    firstTimeSecretKeyBase58: undefined,
  }),
  provisionAvatarWallet: async () => {
    onProvisionWallet?.();
    return {
      status: 'ready',
      branch: 'canonical-valid-mirror-equal',
      address: 'avatar-wallet',
      inserted: false,
    };
  },
  resolveAvatarSettlementAddress: async () => ({
    status: 'ready',
    address: 'avatar-wallet',
  }),
  avatarSettlementAddressFields: (resolution: { status: string; address?: string }) =>
    resolution.status === 'ready'
      ? { walletAddress: resolution.address, walletPending: false }
      : { walletPending: true },
}));

const realTicket = await import('../../services/session-ticket-service');
restoreModules.push(['../../services/session-ticket-service', { ...realTicket }]);
mock.module('../../services/session-ticket-service', () => ({
  ...realTicket,
  mintSessionTicket: async () => {
    ticketMints++;
    return {
      ticket: 'sess-owner-credential-test',
      url: 'https://staging.clawville.world/enter?t=sess-owner-credential-test',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      instruction: 'test handoff',
    };
  },
}));

const realCovenant = await import('../../services/covenant-action-recorder');
restoreModules.push(['../../services/covenant-action-recorder', { ...realCovenant }]);
mock.module('../../services/covenant-action-recorder', () => ({
  ...realCovenant,
  recordCovenantAction: async () => ({ id: 'genesis', deduped: false }),
}));

const realEventLogger = await import('../../services/event-logger');
restoreModules.push(['../../services/event-logger', { ...realEventLogger }]);
mock.module('../../services/event-logger', () => ({
  ...realEventLogger,
  logEvent: async () => { loggedEvents++; },
  logEventFromContext: async () => { loggedEvents++; },
}));

const { agentGatewayRoutes, pendingConnections } = await import('../agent-gateway');
const { npcSimulation } = await import('../../services/npc-simulation');
const { buildAvatarSessionConfig } = await import('../../services/agent-session-config');
const { AgentSubstrateClient } = await import('../../services/agent-substrate-client');
const { agentOwnerBoundSince, markAgentOwnedNow, ownerBindSnapshot, __resetAgentOwnerFenceForTests } = await import(
  '../../services/agent-owner-fence'
);
const { sha256Hex } = await import('../../services/session-digest');

// Count body registrations without changing what the real simulation does.
let registerCalls = 0;
const realRegister = npcSimulation.registerAgentBot.bind(npcSimulation);
npcSimulation.registerAgentBot = ((...args: Parameters<typeof realRegister>) => {
  registerCalls++;
  return realRegister(...args);
}) as typeof npcSimulation.registerAgentBot;

const registeredSessions = new Set<string>();
const dialect = new PgDialect();
let ipCounter = 0;

function boundRow(agentId: string, userId: string | null): Record<string, unknown> {
  return {
    id: BOT_ID,
    agentId,
    identityType: 'custom',
    userId,
    gatewayUrl: null,
    protocol: 'nanoclaw',
    mode: 'avatar',
    name: 'Owned Agent',
    species: 'milady_official_1',
    color: null,
    totalSessions: 3,
    knowledge: [],
    ack: null,
    metadata: null,
  };
}

async function connect(body: Record<string, unknown>) {
  const app = new Hono();
  app.route('/api/agent', agentGatewayRoutes);
  ipCounter++;
  const response = await app.request('/api/agent/connect', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cf-connecting-ip': `198.51.100.${(ipCounter % 250) + 1}`,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json() as Record<string, unknown>;
  if (typeof json.sessionId === 'string') registeredSessions.add(json.sessionId);
  return { status: response.status, json };
}

function whereSql(index: number): string {
  return dialect.sqlToQuery(updateCalls[index].where as Parameters<PgDialect['sqlToQuery']>[0]).sql;
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
  // The refusal never echoes the owner, the avatar, or a session.
  const text = JSON.stringify(result.json);
  expect(text).not.toContain(OWNER_ID);
  expect(text).not.toContain(AVATAR_ID);
  expect(result.json).not.toHaveProperty('userId');
  expect(result.json).not.toHaveProperty('sessionId');
}

beforeEach(() => {
  botRow = null;
  updateReturns = () => [];
  updateCalls = [];
  insertCalls = 0;
  identityResolutions = 0;
  ticketMints = 0;
  loggedEvents = 0;
  registerCalls = 0;
  onProvisionWallet = null;
  __resetAgentOwnerFenceForTests();
});

afterAll(() => {
  for (const sessionId of registeredSessions) npcSimulation.unregisterAgentBot(sessionId);
  delete (npcSimulation as unknown as Record<string, unknown>).registerAgentBot;
  for (const [path, real] of restoreModules) mock.module(path, () => real);
});

describe('POST /api/agent/connect owner credential rule', () => {
  test('owned row + bare agentId is refused before any UPDATE or body registration', async () => {
    botRow = boundRow('owned-bare-agent', OWNER_ID);
    const result = await connect({ agentId: 'owned-bare-agent', name: 'Intruder' });
    expectOwnerCredentialRefusal(result);
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toBe(0);
    expect(registerCalls).toBe(0);
    expect(ticketMints).toBe(0);
    expect(loggedEvents).toBe(0);
  });

  test('owned row + miladyAgentId only is refused', async () => {
    botRow = boundRow('milady:owned-milady-runtime', OWNER_ID);
    const result = await connect({ miladyAgentId: 'owned-milady-runtime' });
    expectOwnerCredentialRefusal(result);
    expect(updateCalls).toHaveLength(0);
    expect(registerCalls).toBe(0);
  });

  test('owned row + Milady identityKey (a public handle, not a credential) is refused', async () => {
    botRow = boundRow('owned-milady-handle', OWNER_ID);
    const result = await connect({
      agentId: 'owned-milady-handle',
      identityType: 'milady',
      identityKey: 'public-milady-handle',
    });
    expectOwnerCredentialRefusal(result);
    expect(identityResolutions).toBe(0);
    expect(updateCalls).toHaveLength(0);
    expect(registerCalls).toBe(0);
  });

  test('owned row + gatewayUrl/authToken without identityKey is refused', async () => {
    botRow = boundRow('owned-gateway-agent', OWNER_ID);
    const result = await connect({
      agentId: 'owned-gateway-agent',
      gatewayUrl: 'https://intruder.example/v1',
      authToken: 'intruder-gateway-token',
    });
    expectOwnerCredentialRefusal(result);
    expect(updateCalls).toHaveLength(0);
    expect(registerCalls).toBe(0);
  });

  test('owned row + override mode is refused and registers no NPC override', async () => {
    const targetNpcId = NPC_IDS[0];
    const overrideBefore = npcSimulation.getAgentBotClient(targetNpcId);
    botRow = boundRow('owned-override-agent', OWNER_ID);
    const result = await connect({
      agentId: 'owned-override-agent',
      mode: 'override',
      targetNpcId,
    });
    expectOwnerCredentialRefusal(result);
    expect(updateCalls).toHaveLength(0);
    expect(registerCalls).toBe(0);
    expect(npcSimulation.getAgentBotClient(targetNpcId)).toBe(overrideBefore);
  });

  test('a public token claim refused for lack of a credential releases the one-shot token', async () => {
    const token = `ct-owner-credential-${'a'.repeat(24)}`;
    pendingConnections.set(token, {
      token,
      avatarId: null,
      avatarName: null,
      userId: null,
      expiresAt: Date.now() + 60_000,
      connected: false,
      publicHandoff: {
        pollSecretHash: 'poll-secret-digest',
        fpHash: 'fp-owner-credential',
        ipPrefixHash: 'ip-owner-credential',
      },
    });
    try {
      botRow = boundRow('owned-token-claim-agent', OWNER_ID);
      const result = await connect({
        connectionToken: token,
        agentId: 'owned-token-claim-agent',
        identityType: 'milady',
        identityKey: 'public-milady-handle',
      });
      expectOwnerCredentialRefusal(result);
      expect(updateCalls).toHaveLength(0);
      expect(registerCalls).toBe(0);
      const pending = pendingConnections.get(token);
      expect(pending?.connected).toBe(false);
      expect(pending?.sessionId).toBeUndefined();
      expect(pending?.publicHandoff?.claimDeadline).toBeUndefined();
    } finally {
      pendingConnections.delete(token);
    }
  });

  test('unowned row + bare agentId still connects, and the refresh carries the CAS', async () => {
    botRow = boundRow('unowned-bare-agent', null);
    updateReturns = () => [{ userId: null }];
    const result = await connect({ agentId: 'unowned-bare-agent', name: 'Anonymous' });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ agentId: 'unowned-bare-agent', isReturning: true, totalSessions: 4 });
    expect(typeof result.json.sessionId).toBe('string');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].table).toBe(realDatabase.agentBots);
    expect(updateCalls[0].values).not.toHaveProperty('userId');
    expect(whereSql(0)).toBe('("openclaw_bots"."id" = $1 and "openclaw_bots"."user_id" is null)');
    expect(registerCalls).toBe(1);
  });

  test('a row bound after the snapshot read loses the CAS and is refused before registration', async () => {
    botRow = boundRow('raced-bare-agent', null);
    updateReturns = () => [];
    const result = await connect({ agentId: 'raced-bare-agent' });
    expectOwnerCredentialRefusal(result);
    expect(updateCalls).toHaveLength(1);
    expect(whereSql(0)).toContain('"openclaw_bots"."user_id" is null');
    expect(registerCalls).toBe(0);
  });

  test('owned row + identityKey that resolves to the same owner still connects', async () => {
    botRow = boundRow('owned-identity-agent', OWNER_ID);
    updateReturns = () => [{ userId: OWNER_ID }];
    const result = await connect({
      agentId: 'owned-identity-agent',
      identityType: 'custom',
      identityKey: 'owner-identity-secret',
    });
    expect(result.status).toBe(200);
    expect(result.json.code).toBeUndefined();
    expect(identityResolutions).toBeGreaterThan(0);
    expect(registerCalls).toBe(1);
    // Identity claim UPDATE, then the main refresh with the identity-owner CAS.
    expect(updateCalls).toHaveLength(2);
    expect(whereSql(1)).toBe('("openclaw_bots"."id" = $1 and "openclaw_bots"."user_id" = $2)');
  });

  test('the reserved partner identity-type 400 releases an authenticated token', async () => {
    const token = `ct-owner-credential-reserved-${'r'.repeat(16)}`;
    pendingConnections.set(token, {
      token,
      avatarId: AVATAR_ID,
      avatarName: 'Owner Avatar 511111',
      userId: OWNER_ID,
      expiresAt: Date.now() + 60_000,
      connected: false,
    });
    try {
      botRow = { ...boundRow('legacy-reserved-row', OWNER_ID), identityType: 'hatcher' };
      const result = await connect({ connectionToken: token, agentId: 'legacy-reserved-row' });
      expect(result.status).toBe(400);
      expect(result.json).toEqual({ error: 'Invalid request' });
      expect(pendingConnections.get(token)?.connected).toBe(false);
      expect(updateCalls).toHaveLength(0);
      expect(registerCalls).toBe(0);
    } finally {
      pendingConnections.delete(token);
    }
  });

  test('a lost CAS with a public token: 409, token released, no ticket, event or body', async () => {
    const token = `ct-owner-credential-cas-${'c'.repeat(20)}`;
    pendingConnections.set(token, {
      token,
      avatarId: null,
      avatarName: null,
      userId: null,
      expiresAt: Date.now() + 60_000,
      connected: false,
      publicHandoff: {
        pollSecretHash: 'poll-secret-digest',
        fpHash: 'fp-owner-credential',
        ipPrefixHash: 'ip-owner-credential',
      },
    });
    try {
      botRow = boundRow('raced-public-token-agent', null);
      updateReturns = () => [];
      const result = await connect({
        connectionToken: token,
        agentId: 'raced-public-token-agent',
        identityType: 'milady',
        identityKey: 'public-milady-handle',
      });
      expectOwnerCredentialRefusal(result);
      expect(updateCalls).toHaveLength(1);
      expect(whereSql(0)).toBe('("openclaw_bots"."id" = $1 and "openclaw_bots"."user_id" is null)');
      const pending = pendingConnections.get(token);
      expect(pending?.connected).toBe(false);
      expect(pending?.publicHandoff?.claimDeadline).toBeUndefined();
      expect(ticketMints).toBe(0);
      expect(loggedEvents).toBe(0);
      expect(registerCalls).toBe(0);
    } finally {
      pendingConnections.delete(token);
    }
  });

  test("a refused connect leaves the owner's live session and body in place", async () => {
    const agentId = 'owned-live-session-agent';
    const ownerSessionId = 'ag-owner-live-session-test';
    const config = buildAvatarSessionConfig({
      mode: 'avatar',
      agentId,
      sessionId: ownerSessionId,
      identityType: 'custom',
      storedProtocol: 'nanoclaw',
      ledgerCapable: true,
      boundUserId: OWNER_ID,
      name: 'Owner Live',
      species: null,
      color: null,
      stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
      homeX: 2560,
      homeY: 2560,
      patrolRadius: 100,
      personality: 'owner live session',
    });
    const ownerClient = new AgentSubstrateClient(config);
    realRegister(config, ownerClient);
    registeredSessions.add(ownerSessionId);
    const ownerBody = npcSimulation.getNpcIdForSession(ownerSessionId)!;
    expect(ownerBody).toBeTruthy();
    // getAgentBotClient reads the body's CURRENT owning session (npcOverrides).
    expect(npcSimulation.getAgentBotClient(ownerBody)).toBe(ownerClient);
    const bodyBefore = npcSimulation.getNpcById(ownerBody);
    expect(bodyBefore).toBeTruthy();

    botRow = boundRow(agentId, OWNER_ID);
    const result = await connect({ agentId, name: 'Intruder' });
    expectOwnerCredentialRefusal(result);
    expect(updateCalls).toHaveLength(0);
    expect(registerCalls).toBe(0);
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([ownerSessionId]);
    expect(npcSimulation.isValidAgentSession(ownerSessionId)).toBe(true);
    expect(npcSimulation.getAgentBotClient(ownerBody)).toBe(ownerClient);
    expect(npcSimulation.getNpcById(ownerBody)).toBe(bodyBefore);
  });
});

// Security 2026-09-30 (round 2): an authenticated connection token from user B
// claimed with the public agentId of a row owned by user A used to rewrite
// user_id to B and evict A's sessions. A token now binds only an unowned row or
// a row its own user already owns.
describe('POST /api/agent/connect connection-token owner rule', () => {
  const OTHER_ID = '54444444-4444-4444-8444-444444444444';
  const OTHER_AVATAR_ID = '55555555-5555-4555-8555-555555555555';

  function registerLiveSession(agentId: string, sessionId: string, boundUserId: string | null) {
    const config = buildAvatarSessionConfig({
      mode: 'avatar',
      agentId,
      sessionId,
      identityType: 'custom',
      storedProtocol: 'nanoclaw',
      ledgerCapable: boundUserId !== null,
      boundUserId,
      name: 'Live Session',
      species: null,
      color: null,
      stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
      homeX: 2560,
      homeY: 2560,
      patrolRadius: 100,
      personality: 'live session',
    });
    realRegister(config, new AgentSubstrateClient(config));
    registeredSessions.add(sessionId);
  }

  function authenticatedToken(suffix: string, userId: string, avatarId: string): string {
    const token = `ct-owner-rule-${suffix}-${'t'.repeat(16)}`;
    pendingConnections.set(token, {
      token,
      avatarId,
      avatarName: 'Token Avatar',
      userId,
      expiresAt: Date.now() + 60_000,
      connected: false,
    });
    return token;
  }

  test('a token from another account is refused before any write, and the owner keeps its session', async () => {
    const agentId = 'owned-cross-account-agent';
    const ownerSessionId = 'ag-owner-cross-account-session';
    registerLiveSession(agentId, ownerSessionId, OWNER_ID);
    const ownerBody = npcSimulation.getNpcIdForSession(ownerSessionId)!;
    const bodyBefore = npcSimulation.getNpcById(ownerBody);
    const token = authenticatedToken('cross', OTHER_ID, OTHER_AVATAR_ID);
    try {
      botRow = boundRow(agentId, OWNER_ID);
      updateReturns = () => [{ userId: OTHER_ID }];
      const result = await connect({ connectionToken: token, agentId });
      expect(result.status).toBe(409);
      expect(result.json).toEqual({
        error: 'This agentId belongs to another account. Connect it from that account, or use its identityKey or the signed /api/agent/reconnect.',
        code: 'agent_owned_by_other_account',
      });
      const text = JSON.stringify(result.json);
      expect(text).not.toContain(OWNER_ID);
      expect(text).not.toContain(OTHER_ID);
      expect(result.json).not.toHaveProperty('sessionId');
      expect(updateCalls).toHaveLength(0);
      expect(insertCalls).toBe(0);
      expect(registerCalls).toBe(0);
      expect(ticketMints).toBe(0);
      expect(loggedEvents).toBe(0);
      expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([ownerSessionId]);
      expect(npcSimulation.getAgentBotConfig(ownerSessionId)?.boundUserId).toBe(OWNER_ID);
      expect(npcSimulation.getNpcById(ownerBody)).toBe(bodyBefore);
      const pending = pendingConnections.get(token);
      expect(pending?.connected).toBe(false);
      expect(pending?.sessionId).toBeUndefined();
    } finally {
      pendingConnections.delete(token);
    }
  });

  test("a token from the row's own owner still connects under the same-owner CAS", async () => {
    const agentId = 'owned-same-owner-token-agent';
    const token = authenticatedToken('same', OWNER_ID, AVATAR_ID);
    try {
      botRow = boundRow(agentId, OWNER_ID);
      updateReturns = () => [{ userId: OWNER_ID }];
      const result = await connect({ connectionToken: token, agentId });
      expect(result.status).toBe(200);
      expect(result.json.code).toBeUndefined();
      expect(typeof result.json.sessionId).toBe('string');
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].values.userId).toBe(OWNER_ID);
      const where = dialect.sqlToQuery(updateCalls[0].where as Parameters<PgDialect['sqlToQuery']>[0]);
      expect(where.sql).toBe('("openclaw_bots"."id" = $1 and "openclaw_bots"."user_id" = $2)');
      expect(where.params).toEqual([BOT_ID, OWNER_ID]);
      expect(registerCalls).toBe(1);
    } finally {
      pendingConnections.delete(token);
    }
  });

  test('a token on an unowned row binds it, marks the owner fence, then evicts the anonymous session', async () => {
    const agentId = 'unowned-token-bind-agent';
    const anonymousSessionId = 'ag-anonymous-before-token-bind';
    registerLiveSession(agentId, anonymousSessionId, null);
    const token = authenticatedToken('unowned', OTHER_ID, OTHER_AVATAR_ID);
    const fencedAtEviction: boolean[] = [];
    // Taken before the connect, so only a mark made by this connect counts.
    const fenceSnapshot = ownerBindSnapshot();
    const realUnregister = npcSimulation.unregisterAgentBot.bind(npcSimulation);
    npcSimulation.unregisterAgentBot = ((sid: string) => {
      fencedAtEviction.push(agentOwnerBoundSince(agentId, fenceSnapshot));
      return realUnregister(sid);
    }) as typeof npcSimulation.unregisterAgentBot;
    try {
      botRow = boundRow(agentId, null);
      updateReturns = () => [{ userId: OTHER_ID }];
      const result = await connect({ connectionToken: token, agentId });
      expect(result.status).toBe(200);
      expect(typeof result.json.sessionId).toBe('string');
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].values.userId).toBe(OTHER_ID);
      expect(whereSql(0)).toBe('("openclaw_bots"."id" = $1 and "openclaw_bots"."user_id" is null)');
      expect(registerCalls).toBe(1);
      expect(npcSimulation.isValidAgentSession(anonymousSessionId)).toBe(false);
      expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([result.json.sessionId as string]);
      // The fence was marked before the eviction scan (round 2b).
      expect(fencedAtEviction).toEqual([true]);
      expect(agentOwnerBoundSince(agentId, fenceSnapshot)).toBe(true);
    } finally {
      delete (npcSimulation as unknown as Record<string, unknown>).unregisterAgentBot;
      pendingConnections.delete(token);
    }
  });

  test('a token that loses the unowned-row CAS keeps the OWNER_BIND_CONFLICT path', async () => {
    const agentId = 'raced-token-bind-agent';
    const token = authenticatedToken('race', OTHER_ID, OTHER_AVATAR_ID);
    try {
      botRow = boundRow(agentId, null);
      updateReturns = () => [];
      const result = await connect({ connectionToken: token, agentId });
      expect(result.status).toBe(409);
      expect(result.json).toEqual({
        error: 'Owner binding changed during connect',
        code: 'OWNER_BIND_CONFLICT',
      });
      expect(updateCalls).toHaveLength(1);
      expect(whereSql(0)).toBe('("openclaw_bots"."id" = $1 and "openclaw_bots"."user_id" is null)');
      expect(registerCalls).toBe(0);
      expect(ticketMints).toBe(0);
      expect(pendingConnections.get(token)?.connected).toBe(false);
    } finally {
      pendingConnections.delete(token);
    }
  });
});

// Security 2026-09-30 (round 2b): the in-process owner fence. A credentialless
// connect whose `user_id IS NULL` CAS committed while the row was unowned can
// resolve AFTER an owner bind evicted the agent's sessions; it must not
// register a stray body then.
describe('POST /api/agent/connect owner fence', () => {
  test('a credentialless CAS that resolves after an owner bind is refused before registration', async () => {
    const agentId = 'fenced-late-bare-agent';
    botRow = boundRow(agentId, null);
    // The CAS write wins (row unowned at write time), but an owner bind lands
    // and marks the fence before this request sees its UPDATE response.
    updateReturns = () => {
      markAgentOwnedNow(agentId);
      return [{ userId: null }];
    };
    const result = await connect({ agentId, name: 'Late Stray' });
    expectOwnerCredentialRefusal(result);
    expect(updateCalls).toHaveLength(1);
    expect(whereSql(0)).toBe('("openclaw_bots"."id" = $1 and "openclaw_bots"."user_id" is null)');
    expect(registerCalls).toBe(0);
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([]);
    expect(ticketMints).toBe(0);
    expect(loggedEvents).toBe(0);
  });

  test('the fence refusal releases a reserved public connection token', async () => {
    const agentId = 'fenced-late-public-token-agent';
    const token = `ct-owner-fence-public-${'f'.repeat(22)}`;
    pendingConnections.set(token, {
      token,
      avatarId: null,
      avatarName: null,
      userId: null,
      expiresAt: Date.now() + 60_000,
      connected: false,
      publicHandoff: {
        pollSecretHash: 'poll-secret-digest',
        fpHash: 'fp-owner-fence',
        ipPrefixHash: 'ip-owner-fence',
      },
    });
    try {
      botRow = boundRow(agentId, null);
      updateReturns = () => {
        markAgentOwnedNow(agentId);
        return [{ userId: null }];
      };
      // A Milady identityKey resolves no identity, so this claim is credentialless.
      const result = await connect({
        connectionToken: token,
        agentId,
        identityType: 'milady',
        identityKey: 'public-milady-handle',
      });
      expectOwnerCredentialRefusal(result);
      expect(registerCalls).toBe(0);
      expect(pendingConnections.get(token)?.connected).toBe(false);
      expect(pendingConnections.get(token)?.publicHandoff?.claimDeadline).toBeUndefined();
    } finally {
      pendingConnections.delete(token);
    }
  });

  test('a fence mark for another agentId does not refuse this connect', async () => {
    markAgentOwnedNow('some-other-agent');
    botRow = boundRow('unfenced-bare-agent', null);
    updateReturns = () => [{ userId: null }];
    const result = await connect({ agentId: 'unfenced-bare-agent' });
    expect(result.status).toBe(200);
    expect(registerCalls).toBe(1);
  });

  test('an identityKey connect is not refused by the fence (it carries an owner credential)', async () => {
    const agentId = 'fenced-identity-agent';
    markAgentOwnedNow(agentId);
    botRow = boundRow(agentId, OWNER_ID);
    updateReturns = () => [{ userId: OWNER_ID }];
    const result = await connect({
      agentId,
      identityType: 'custom',
      identityKey: 'owner-identity-secret',
    });
    expect(result.status).toBe(200);
    expect(registerCalls).toBe(1);
  });

  test('an identityKey bind of an unowned row marks the fence', async () => {
    const agentId = 'identity-bind-marks-fence';
    botRow = boundRow(agentId, null);
    updateReturns = () => [{ userId: OWNER_ID }];
    const fenceSnapshot = ownerBindSnapshot();
    const result = await connect({
      agentId,
      identityType: 'custom',
      identityKey: 'owner-identity-secret',
    });
    expect(result.status).toBe(200);
    expect(agentOwnerBoundSince(agentId, fenceSnapshot)).toBe(true);
  });

  test('an unowned credentialless refresh marks no fence', async () => {
    const agentId = 'credentialless-no-fence';
    botRow = boundRow(agentId, null);
    updateReturns = () => [{ userId: null }];
    const fenceSnapshot = ownerBindSnapshot();
    const result = await connect({ agentId });
    expect(result.status).toBe(200);
    expect(agentOwnerBoundSince(agentId, fenceSnapshot)).toBe(false);
  });
});

// connect-sec round 4 (2026-10-01, Codex C1 + C2).
// C1: an owner bind must rotate the bearer hash in the SAME guarded UPDATE that
// writes user_id, and evict the agent's earlier sessions before any further
// await. Before, the identity claim wrote user_id alone, so an old bearer from
// the unowned period still matched the row hash and resolved AS the new owner
// until the refresh UPDATE landed; eviction ran only after the provisioning
// awaits.
// C2: the fence is a bind sequence captured at request start, not a five-minute
// clock, so a stalled UPDATE response cannot outlive it.
describe('POST /api/agent/connect round 4: atomic bind + no-expiry fence', () => {
  const FIVE_MINUTES = 5 * 60_000;
  const OTHER_ID = '56666666-6666-4666-8666-666666666666';
  const OTHER_AVATAR_ID = '57777777-7777-4777-8777-777777777777';

  function registerAnonymousSession(agentId: string, sessionId: string) {
    const config = buildAvatarSessionConfig({
      mode: 'avatar',
      agentId,
      sessionId,
      identityType: 'custom',
      storedProtocol: 'nanoclaw',
      ledgerCapable: false,
      boundUserId: null,
      name: 'Unowned Period',
      species: null,
      color: null,
      stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
      homeX: 2560,
      homeY: 2560,
      patrolRadius: 100,
      personality: 'unowned period session',
    });
    realRegister(config, new AgentSubstrateClient(config));
    registeredSessions.add(sessionId);
  }

  test('C1: the identity claim writes user_id and the new bearer hash in one UPDATE, then evicts before the next write', async () => {
    const agentId = 'r4-identity-claim-agent';
    const anonymousSessionId = 'ag-r4-anonymous-before-identity-claim';
    registerAnonymousSession(agentId, anonymousSessionId);
    botRow = boundRow(agentId, null);
    const anonymousLiveAtWrite: boolean[] = [];
    updateReturns = () => {
      anonymousLiveAtWrite.push(npcSimulation.isValidAgentSession(anonymousSessionId));
      return [{ userId: OWNER_ID }];
    };
    const fenceSnapshot = ownerBindSnapshot();
    const result = await connect({
      agentId,
      identityType: 'custom',
      identityKey: 'owner-identity-secret',
    });
    expect(result.status).toBe(200);
    const sessionId = result.json.sessionId as string;
    expect(typeof sessionId).toBe('string');
    expect(updateCalls).toHaveLength(2);
    // One guarded UPDATE carries the owner AND the rotated hash.
    expect(updateCalls[0].values.userId).toBe(OWNER_ID);
    expect(updateCalls[0].values.sessionKeyHash).toBe(sha256Hex(sessionId));
    expect(whereSql(0)).toContain('IS NULL OR');
    // Live at the claim write; already evicted when the refresh write is issued.
    expect(anonymousLiveAtWrite).toEqual([true, false]);
    expect(npcSimulation.isValidAgentSession(anonymousSessionId)).toBe(false);
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([sessionId]);
    expect(agentOwnerBoundSince(agentId, fenceSnapshot)).toBe(true);
  });

  test('C1: an owned-token bind of an unowned row evicts before the provisioning awaits', async () => {
    const agentId = 'r4-token-bind-agent';
    const anonymousSessionId = 'ag-r4-anonymous-before-token-bind';
    registerAnonymousSession(agentId, anonymousSessionId);
    const token = `ct-r4-token-bind-${'k'.repeat(20)}`;
    pendingConnections.set(token, {
      token,
      avatarId: OTHER_AVATAR_ID,
      avatarName: 'Token Avatar',
      userId: OTHER_ID,
      expiresAt: Date.now() + 60_000,
      connected: false,
    });
    const anonymousLiveAtProvision: boolean[] = [];
    onProvisionWallet = () => {
      anonymousLiveAtProvision.push(npcSimulation.isValidAgentSession(anonymousSessionId));
    };
    try {
      botRow = boundRow(agentId, null);
      updateReturns = () => [{ userId: OTHER_ID }];
      const result = await connect({ connectionToken: token, agentId });
      expect(result.status).toBe(200);
      const sessionId = result.json.sessionId as string;
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].values.userId).toBe(OTHER_ID);
      expect(updateCalls[0].values.sessionKeyHash).toBe(sha256Hex(sessionId));
      expect(anonymousLiveAtProvision).toEqual([false]);
      expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([sessionId]);
    } finally {
      pendingConnections.delete(token);
    }
  });

  test('C2: a credentialless CAS that resolves after a five-minute-old owner bind mark is still refused', async () => {
    const agentId = 'r4-stalled-bare-agent';
    botRow = boundRow(agentId, null);
    // The CAS won while the row was unowned; an owner bind then marked the
    // fence, and this request saw its UPDATE response more than five minutes
    // after that mark.
    updateReturns = () => {
      markAgentOwnedNow(agentId, Date.now() - FIVE_MINUTES - 1_000);
      return [{ userId: null }];
    };
    const result = await connect({ agentId, name: 'Stalled Stray' });
    expectOwnerCredentialRefusal(result);
    expect(registerCalls).toBe(0);
    expect(npcSimulation.findActiveSessionsByAgentIds([agentId])).toEqual([]);
    expect(ticketMints).toBe(0);
  });

  test('C2: an owner bind marked before this request started does not refuse a connect to an unowned row', async () => {
    const agentId = 'r4-earlier-bind-agent';
    markAgentOwnedNow(agentId);
    botRow = boundRow(agentId, null);
    updateReturns = () => [{ userId: null }];
    const result = await connect({ agentId });
    expect(result.status).toBe(200);
    expect(registerCalls).toBe(1);
  });
});

// Security 2026-09-30 (round 2b): an explicit identityKey shares the
// fingerprint namespace with the server-derived gateway-inferred key, so the
// derived shapes are reserved on every public route that resolves one.
describe('reserved derived identityKey on public routes', () => {
  const RESERVED_KEYS: Array<[string, string]> = [
    ['legacy gateway#8-char shape', 'https://gateway.example/v1#sk-proj-'],
    ['legacy shape, short tail, upper-case scheme', 'HTTP://Gateway.Example#abc'],
    ['legacy shape, leading space', ' http://gw.example#sk-proj-'],
    ['legacy shape, space before #', 'http://gw.example #sk-proj-'],
    ['legacy shape, space in path', 'http://gw.example/a b#sk-proj-'],
    ['current derived key', `gateway-inferred:v2:https://gateway.example/v1#${'a'.repeat(64)}`],
    ['any gateway-inferred prefix', 'gateway-inferred:anything'],
  ];
  const RESERVED_BODY = { error: 'Invalid request', code: 'identity_key_reserved' };

  function slug(label: string): string {
    return label.replace(/[^a-z]/gi, '').slice(0, 16);
  }

  async function post(path: string, body: Record<string, unknown>) {
    const app = new Hono();
    app.route('/api/agent', agentGatewayRoutes);
    ipCounter++;
    const response = await app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-connecting-ip': `192.0.2.${(ipCounter % 250) + 1}`,
      },
      body: JSON.stringify(body),
    });
    const json = await response.json() as Record<string, unknown>;
    if (typeof json.sessionId === 'string') registeredSessions.add(json.sessionId);
    return { status: response.status, json };
  }

  function registerLiveSession(agentId: string, sessionId: string) {
    const config = buildAvatarSessionConfig({
      mode: 'avatar',
      agentId,
      sessionId,
      identityType: 'openclaw',
      storedProtocol: 'nanoclaw',
      ledgerCapable: false,
      boundUserId: null,
      name: 'Control Link',
      species: null,
      color: null,
      stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
      homeX: 2560,
      homeY: 2560,
      patrolRadius: 100,
      personality: 'control link session',
    });
    realRegister(config, new AgentSubstrateClient(config));
    registeredSessions.add(sessionId);
  }

  /** A live unowned session whose row passes `validateLiveAgentSession`. */
  function liveUnownedSession(agentId: string, sessionId: string) {
    registerLiveSession(agentId, sessionId);
    botRow = {
      ...boundRow(agentId, null),
      sessionExpiresAt: new Date(Date.now() + 60_000),
      sessionKeyHash: sha256Hex(sessionId),
    };
  }

  /** A public token whose `connected` writes are recorded (reservation proof). */
  function recordingPublicToken(suffix: string) {
    const token = `ct-reserved-key-${suffix}-${'k'.repeat(12)}`;
    const writes: boolean[] = [];
    let connected = false;
    const pending = {
      token,
      avatarId: null,
      avatarName: null,
      userId: null,
      expiresAt: Date.now() + 60_000,
      get connected() { return connected; },
      set connected(value: boolean) { writes.push(value); connected = value; },
      publicHandoff: {
        pollSecretHash: 'poll-secret-digest',
        fpHash: 'fp-reserved-key',
        ipPrefixHash: 'ip-reserved-key',
      },
    };
    pendingConnections.set(token, pending as unknown as Parameters<typeof pendingConnections.set>[1]);
    return { token, writes };
  }

  for (const [label, key] of RESERVED_KEYS) {
    test(`/connect refuses ${label} before the token reservation`, async () => {
      const { token, writes } = recordingPublicToken(slug(label));
      try {
        botRow = boundRow('reserved-key-connect-agent', null);
        updateReturns = () => [{ userId: OWNER_ID }];
        const result = await post('/api/agent/connect', {
          connectionToken: token,
          agentId: 'reserved-key-connect-agent',
          identityType: 'openclaw',
          identityKey: key,
        });
        expect(result.status).toBe(400);
        expect(result.json).toEqual(RESERVED_BODY);
        expect(JSON.stringify(result.json)).not.toContain(key);
        // The one-shot token was never reserved, so it was never burned.
        expect(writes).toEqual([]);
        expect(pendingConnections.get(token)?.connected).toBe(false);
        expect(identityResolutions).toBe(0);
        expect(updateCalls).toHaveLength(0);
        expect(insertCalls).toBe(0);
        expect(registerCalls).toBe(0);
        expect(ticketMints).toBe(0);
      } finally {
        pendingConnections.delete(token);
      }
    });

    test(`/connect without a token refuses ${label}`, async () => {
      botRow = boundRow('reserved-key-bare-agent', null);
      updateReturns = () => [{ userId: OWNER_ID }];
      const result = await post('/api/agent/connect', {
        agentId: 'reserved-key-bare-agent',
        identityType: 'custom',
        identityKey: key,
      });
      expect(result.status).toBe(400);
      expect(result.json).toEqual(RESERVED_BODY);
      expect(identityResolutions).toBe(0);
      expect(updateCalls).toHaveLength(0);
      expect(registerCalls).toBe(0);
    });

    test(`/join refuses ${label} before identity resolution`, async () => {
      const result = await post('/api/agent/join', { identityType: 'openclaw', identityKey: key });
      expect(result.status).toBe(400);
      expect(result.json).toEqual(RESERVED_BODY);
      expect(identityResolutions).toBe(0);
      expect(ticketMints).toBe(0);
    });

    test(`/:sessionId/control-link refuses ${label} before identity resolution`, async () => {
      const sessionId = `ag-reserved-key-control-${slug(label)}`;
      liveUnownedSession(`reserved-key-control-${slug(label)}`, sessionId);
      const result = await post(`/api/agent/${sessionId}/control-link`, {
        identityType: 'openclaw',
        identityKey: key,
      });
      expect(result.status).toBe(400);
      expect(result.json).toEqual(RESERVED_BODY);
      expect(identityResolutions).toBe(0);
      expect(ticketMints).toBe(0);
    });
  }

  test('a normal random identityKey still works on /connect, /join and /control-link', async () => {
    const key = 'f3b9c1d2-normal-random-identity-key-7a6e';
    botRow = boundRow('normal-key-connect-agent', null);
    updateReturns = () => [{ userId: OWNER_ID }];
    const connected = await post('/api/agent/connect', {
      agentId: 'normal-key-connect-agent',
      identityType: 'openclaw',
      identityKey: key,
    });
    expect(connected.status).toBe(200);
    expect(connected.json.code).toBeUndefined();
    expect(identityResolutions).toBeGreaterThan(0);

    identityResolutions = 0;
    const joined = await post('/api/agent/join', { identityType: 'openclaw', identityKey: key });
    expect(joined.json.code).not.toBe('identity_key_reserved');
    expect(joined.status).toBe(200);
    expect(identityResolutions).toBe(1);

    identityResolutions = 0;
    const sessionId = 'ag-normal-key-control-session';
    liveUnownedSession('normal-key-control-agent', sessionId);
    const linked = await post(`/api/agent/${sessionId}/control-link`, { identityType: 'openclaw', identityKey: key });
    expect(linked.status).toBe(200);
    expect(typeof linked.json.url).toBe('string');
    expect(identityResolutions).toBe(1);
  });
});
