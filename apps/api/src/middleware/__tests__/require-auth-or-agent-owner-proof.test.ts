import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

// connect-sec round 4 (C10): `resolveAgentSession` returned the ROW owner and
// the owner's avatar for ANY live session, also one whose config never proved
// that owner (`boundUserId` null or different). Rule: the owner and avatar go
// only to a session with `config.boundUserId === row.userId`. Each legit owner
// session kind below is built with its production helper and must still
// resolve as the owner; a stray session resolves as non-owner (and stays alive).

process.env.FINGERPRINT_SECRET ??= '42'.repeat(32);

const OWNER_ID = '71111111-1111-4111-8111-111111111111';
const OTHER_ID = '72222222-2222-4222-8222-222222222222';
const AVATAR_ID = '73333333-3333-4333-8333-333333333333';

let botRow: Record<string, unknown> | null = null;

const realDatabase = await import('@clawville/database');
// Copies taken BEFORE the mocks, restored in afterAll, so a single-process run
// does not leak this file's stubs into later test files.
const restoreModules: Array<[string, Record<string, unknown>]> = [['@clawville/database', { ...realDatabase }]];
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'query') {
      return {
        agentBots: { findFirst: async () => (botRow ? { ...botRow } : undefined) },
        users: { findFirst: async () => ({ isGuest: false }) },
        avatars: { findFirst: async () => ({ id: AVATAR_ID }) },
      };
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});

mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const { resolveAgentSession, requireAuthOrAgentSession, AGENT_SESSION_HEADER } = await import('../require-auth-or-agent');
const { npcSimulation } = await import('../../services/npc-simulation');
const { AgentSubstrateClient } = await import('../../services/agent-substrate-client');
const { buildAvatarSessionConfig } = await import('../../services/agent-session-config');
const { resolvePersistedConnectOwnerProof } = await import('../../services/agent-owner-binding');
const { resolveRestoredSessionAuthorization } = await import('../../services/agent-session-restore');
const { planReconnectSession } = await import('../../services/agent-reconnect-session');
const { buildHostedAvatarAgentConfig } = await import('../../services/hosted-avatar-agent-session-plan');
const { sha256Hex } = await import('../../services/session-digest');

type Registration = Parameters<typeof npcSimulation.registerAgentBot>[0];

const registered = new Set<string>();

function avatarConfig(input: {
  agentId: string;
  sessionId: string;
  ledgerCapable: boolean;
  boundUserId: string | null;
  identityType?: string;
  storedProtocol?: string;
  protocolOverride?: 'hatcher-proxy';
}): Registration {
  return buildAvatarSessionConfig({
    mode: 'avatar',
    agentId: input.agentId,
    sessionId: input.sessionId,
    identityType: (input.identityType ?? 'custom') as never,
    storedProtocol: input.storedProtocol ?? 'nanoclaw',
    ...(input.protocolOverride ? { protocolOverride: input.protocolOverride, autonomyMode: 'server-managed' as const } : {}),
    ledgerCapable: input.ledgerCapable,
    boundUserId: input.boundUserId,
    avatarId: AVATAR_ID,
    name: 'Owner Proof',
    species: null,
    color: null,
    stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: 'owner proof test',
  } as Parameters<typeof buildAvatarSessionConfig>[0]);
}

/** Register a live session whose bearer hash is the row's current hash. */
function goLive(config: Registration, rowUserId: string | null) {
  npcSimulation.registerAgentBot(config, new AgentSubstrateClient(config));
  registered.add(config.sessionId);
  botRow = {
    id: '74444444-4444-4444-8444-444444444444',
    agentId: config.agentId,
    userId: rowUserId,
    sessionKeyHash: sha256Hex(config.sessionId),
    sessionExpiresAt: new Date(Date.now() + 60 * 60_000),
  };
}

const OWNER_RESOLUTION = { userId: OWNER_ID, avatarId: AVATAR_ID };
const NON_OWNER = { userId: null, avatarId: null, ledgerCapable: false };

beforeEach(() => {
  botRow = null;
});

afterEach(() => {
  for (const sessionId of registered) npcSimulation.unregisterAgentBot(sessionId);
  registered.clear();
});

afterAll(() => {
  for (const [path, real] of restoreModules) mock.module(path, () => real);
});

describe('resolveAgentSession owner proof: legit owner sessions keep the owner', () => {
  test('/connect identityKey claim (persisted owner = proven owner)', async () => {
    const proof = resolvePersistedConnectOwnerProof({
      source: 'explicit-identity', candidateUserId: OWNER_ID, persistedUserId: OWNER_ID, avatarId: AVATAR_ID,
    });
    const config = avatarConfig({ agentId: 'op-identity', sessionId: 'ag-op-identity', ...proof });
    goLive(config, OWNER_ID);
    expect(await resolveAgentSession(config.sessionId)).toEqual({
      ...OWNER_RESOLUTION, agentId: 'op-identity', ledgerCapable: true,
    });
  });

  test('/connect connection token of the same owner', async () => {
    const proof = resolvePersistedConnectOwnerProof({
      source: 'connection-token', candidateUserId: OWNER_ID, persistedUserId: OWNER_ID, avatarId: AVATAR_ID,
    });
    const config = avatarConfig({ agentId: 'op-token', sessionId: 'ag-op-token', ...proof });
    goLive(config, OWNER_ID);
    expect(await resolveAgentSession(config.sessionId)).toEqual({
      ...OWNER_RESOLUTION, agentId: 'op-token', ledgerCapable: true,
    });
  });

  test('/enter redemption keeper after bindAgentOwner stamps the redeemer', async () => {
    const config = avatarConfig({
      agentId: 'op-keeper', sessionId: 'ag-op-keeper', ledgerCapable: false, boundUserId: null,
    });
    goLive(config, OWNER_ID);
    expect(npcSimulation.bindAgentOwner('op-keeper', OWNER_ID)).toBe(1);
    expect(await resolveAgentSession(config.sessionId)).toEqual({
      ...OWNER_RESOLUTION, agentId: 'op-keeper', ledgerCapable: false,
    });
  });

  test('signed /reconnect (planReconnectSession)', async () => {
    const plan = planReconnectSession({
      bot: {
        agentId: 'op-reconnect', identityType: 'custom', protocol: 'nanoclaw', gatewayUrl: null,
        userId: OWNER_ID, mode: 'avatar', name: 'Reconnect', species: null, color: null,
        targetNpcId: null, metadata: null,
      },
      provenUserId: OWNER_ID,
      sessionId: 'ag-op-reconnect',
      avatarId: AVATAR_ID,
    });
    if (!plan.mint) throw new Error('reconnect plan did not mint');
    goLive(plan.config, OWNER_ID);
    expect(await resolveAgentSession('ag-op-reconnect')).toEqual({
      ...OWNER_RESOLUTION, agentId: 'op-reconnect', ledgerCapable: true,
    });
  });

  test('Hatcher partner register (boundUserId = persisted row.userId)', async () => {
    const config = avatarConfig({
      agentId: 'hatcher:op-partner', sessionId: 'oc-op-partner', identityType: 'hatcher',
      storedProtocol: 'hatcher-proxy', protocolOverride: 'hatcher-proxy',
      ledgerCapable: true, boundUserId: OWNER_ID,
    });
    goLive(config, OWNER_ID);
    expect(await resolveAgentSession(config.sessionId)).toEqual({
      ...OWNER_RESOLUTION, agentId: 'hatcher:op-partner', ledgerCapable: true,
    });
  });

  test('Hatcher session restored from the row', async () => {
    const authorization = resolveRestoredSessionAuthorization('hatcher-proxy', OWNER_ID);
    const config = avatarConfig({
      agentId: 'hatcher:op-restored', sessionId: 'oc-op-hatcher-restored', identityType: 'hatcher',
      storedProtocol: 'hatcher-proxy', protocolOverride: 'hatcher-proxy', ...authorization,
    });
    goLive(config, OWNER_ID);
    expect(await resolveAgentSession(config.sessionId)).toEqual({
      ...OWNER_RESOLUTION, agentId: 'hatcher:op-restored', ledgerCapable: true,
    });
  });

  test('hosted avatar agent (buildHostedAvatarAgentConfig)', async () => {
    const config = buildHostedAvatarAgentConfig({
      agentId: 'op-hosted', sessionId: 'ag-op-hosted', ownerUserId: OWNER_ID, avatarId: AVATAR_ID,
      modelKey: 'milady_official_1', name: 'Hosted',
    });
    goLive(config, OWNER_ID);
    expect(await resolveAgentSession(config.sessionId)).toEqual({
      ...OWNER_RESOLUTION, agentId: 'op-hosted', ledgerCapable: true,
    });
  });

  test('public session restored from the row (non-ledger, still the owner)', async () => {
    const authorization = resolveRestoredSessionAuthorization('nanoclaw', OWNER_ID);
    const config = avatarConfig({ agentId: 'op-restored', sessionId: 'ag-op-restored', ...authorization });
    goLive(config, OWNER_ID);
    expect(await resolveAgentSession(config.sessionId)).toEqual({
      ...OWNER_RESOLUTION, agentId: 'op-restored', ledgerCapable: false,
    });
  });
});

describe('resolveAgentSession owner proof: a stray session is not the owner', () => {
  test('a session with a null boundUserId on an owned row resolves as non-owner and stays alive', async () => {
    const config = avatarConfig({
      agentId: 'op-stray-null', sessionId: 'ag-op-stray-null', ledgerCapable: false, boundUserId: null,
    });
    goLive(config, OWNER_ID);
    expect(await resolveAgentSession(config.sessionId)).toEqual({ ...NON_OWNER, agentId: 'op-stray-null' });
    expect(npcSimulation.isValidAgentSession(config.sessionId)).toBe(true);
  });

  test('a non-ledger session bound to a different user resolves as non-owner', async () => {
    const config = avatarConfig({
      agentId: 'op-stray-other', sessionId: 'ag-op-stray-other', ledgerCapable: false, boundUserId: OTHER_ID,
    });
    goLive(config, OWNER_ID);
    expect(await resolveAgentSession(config.sessionId)).toEqual({ ...NON_OWNER, agentId: 'op-stray-other' });
  });

  test('requireAuthOrAgentSession refuses a stray with 403 and admits the proven owner', async () => {
    const app = new Hono();
    app.get('/probe', requireAuthOrAgentSession, (c) => c.json(c.get('identity' as never)));

    const stray = avatarConfig({
      agentId: 'op-mw-stray', sessionId: 'ag-op-mw-stray', ledgerCapable: false, boundUserId: null,
    });
    goLive(stray, OWNER_ID);
    const refused = await app.request('/probe', { headers: { [AGENT_SESSION_HEADER]: stray.sessionId } });
    expect(refused.status).toBe(403);

    const proof = resolvePersistedConnectOwnerProof({
      source: 'explicit-identity', candidateUserId: OWNER_ID, persistedUserId: OWNER_ID, avatarId: AVATAR_ID,
    });
    const owner = avatarConfig({ agentId: 'op-mw-owner', sessionId: 'ag-op-mw-owner', ...proof });
    goLive(owner, OWNER_ID);
    const admitted = await app.request('/probe', { headers: { [AGENT_SESSION_HEADER]: owner.sessionId } });
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toMatchObject({
      kind: 'agent', userId: OWNER_ID, avatarId: AVATAR_ID, agentId: 'op-mw-owner', ledgerCapable: true,
    });
  });

  test('unchanged: an anonymous session on an unowned row stays non-owner and alive', async () => {
    const config = avatarConfig({
      agentId: 'op-anonymous', sessionId: 'ag-op-anonymous', ledgerCapable: false, boundUserId: null,
    });
    goLive(config, null);
    expect(await resolveAgentSession(config.sessionId)).toEqual({ ...NON_OWNER, agentId: 'op-anonymous' });
    expect(npcSimulation.isValidAgentSession(config.sessionId)).toBe(true);
  });

  test('unchanged: a ledger session whose row moved to another owner is torn down', async () => {
    const config = avatarConfig({
      agentId: 'op-rebound', sessionId: 'ag-op-rebound', ledgerCapable: true, boundUserId: OTHER_ID,
    });
    goLive(config, OWNER_ID);
    expect(await resolveAgentSession(config.sessionId)).toBeNull();
    expect(npcSimulation.isValidAgentSession(config.sessionId)).toBe(false);
  });
});
