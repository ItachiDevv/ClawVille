import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppContext } from '../../types';

// connect-sec round 4 (C12): `resolveWorldPresence` returned the row owner as
// the presence `userId` for ANY live agent session. A stray session (live, but
// it never proved this owner) then joined the world AS the owner: it loaded the
// owner's avatar meta and could displace the owner's body through the room
// identity dedup. Rule: the same owner proof as `resolveAgentSession` (C10).
// The presence check is inline (the 5 Hz /position path skips the resolver's
// avatar and user queries), so every case below also pins it against
// `resolveAgentSession` with the REAL middleware module.

process.env.FINGERPRINT_SECRET ??= '44'.repeat(32);

const OWNER_ID = '91111111-1111-4111-8111-111111111111';
const OTHER_ID = '92222222-2222-4222-8222-222222222222';
const AVATAR_ID = '93333333-3333-4333-8333-333333333333';

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

const { resolveAgentSession, AGENT_SESSION_HEADER } = await import('../../middleware/require-auth-or-agent');
const { resolveWorldPresence } = await import('../world-presence-identity');
const { npcSimulation } = await import('../npc-simulation');
const { AgentSubstrateClient } = await import('../agent-substrate-client');
const { buildAvatarSessionConfig } = await import('../agent-session-config');
const { resolvePersistedConnectOwnerProof } = await import('../agent-owner-binding');
const { resolveRestoredSessionAuthorization } = await import('../agent-session-restore');
const { buildHostedAvatarAgentConfig } = await import('../hosted-avatar-agent-session-plan');
const { sha256Hex } = await import('../session-digest');

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
    name: 'Presence Owner Proof',
    species: null,
    color: null,
    stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: 'presence owner proof test',
  } as Parameters<typeof buildAvatarSessionConfig>[0]);
}

function goLive(config: Registration, rowUserId: string | null): string {
  npcSimulation.registerAgentBot(config, new AgentSubstrateClient(config));
  registered.add(config.sessionId);
  botRow = {
    id: '94444444-4444-4444-8444-444444444444',
    agentId: config.agentId,
    userId: rowUserId,
    sessionKeyHash: sha256Hex(config.sessionId),
    sessionExpiresAt: new Date(Date.now() + 60 * 60_000),
  };
  return config.sessionId;
}

const app = new Hono<AppContext>();
app.get('/resolve', async (c) => c.json(await resolveWorldPresence(c)));

async function presenceFor(sessionId: string) {
  const response = await app.request('/resolve', { headers: { [AGENT_SESSION_HEADER]: sessionId } });
  expect(response.status).toBe(200);
  return (await response.json()) as { sessionId: string; kind: string; userId: string | null };
}

/** Presence must agree with the canonical resolver on who the owner is. */
async function expectPresence(sessionId: string, agentId: string, userId: string | null) {
  const presence = await presenceFor(sessionId);
  expect(presence).toEqual({ sessionId: `a:${agentId}`, kind: 'agent', userId });
  const resolved = await resolveAgentSession(sessionId);
  expect(resolved?.userId ?? null).toBe(presence.userId);
}

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

describe('world presence owner proof: a stray session has no owner identity', () => {
  test('a null boundUserId on an owned row joins as an agent with no userId', async () => {
    const sid = goLive(
      avatarConfig({ agentId: 'wp-stray-null', sessionId: 'ag-wp-stray-null', ledgerCapable: false, boundUserId: null }),
      OWNER_ID,
    );
    await expectPresence(sid, 'wp-stray-null', null);
    expect(npcSimulation.isValidAgentSession(sid)).toBe(true);
  });

  test('a non-ledger session bound to a different user joins with no userId', async () => {
    const sid = goLive(
      avatarConfig({ agentId: 'wp-stray-other', sessionId: 'ag-wp-stray-other', ledgerCapable: false, boundUserId: OTHER_ID }),
      OWNER_ID,
    );
    await expectPresence(sid, 'wp-stray-other', null);
  });

  test('unchanged: an anonymous session on an unowned row joins with no userId', async () => {
    const sid = goLive(
      avatarConfig({ agentId: 'wp-anon', sessionId: 'ag-wp-anon', ledgerCapable: false, boundUserId: null }),
      null,
    );
    await expectPresence(sid, 'wp-anon', null);
  });
});

describe('world presence owner proof: legit owner sessions keep the owner', () => {
  test('/connect identity claim', async () => {
    const proof = resolvePersistedConnectOwnerProof({
      source: 'explicit-identity', candidateUserId: OWNER_ID, persistedUserId: OWNER_ID, avatarId: AVATAR_ID,
    });
    const sid = goLive(avatarConfig({ agentId: 'wp-connect', sessionId: 'ag-wp-connect', ...proof }), OWNER_ID);
    await expectPresence(sid, 'wp-connect', OWNER_ID);
  });

  test('/enter keeper after bindAgentOwner stamps the redeemer', async () => {
    const sid = goLive(
      avatarConfig({ agentId: 'wp-keeper', sessionId: 'ag-wp-keeper', ledgerCapable: false, boundUserId: null }),
      OWNER_ID,
    );
    expect(npcSimulation.bindAgentOwner('wp-keeper', OWNER_ID)).toBe(1);
    await expectPresence(sid, 'wp-keeper', OWNER_ID);
  });

  test('Hatcher partner register (boundUserId = persisted row.userId)', async () => {
    const sid = goLive(
      avatarConfig({
        agentId: 'hatcher:wp-partner', sessionId: 'oc-wp-partner', identityType: 'hatcher',
        storedProtocol: 'hatcher-proxy', protocolOverride: 'hatcher-proxy',
        ledgerCapable: true, boundUserId: OWNER_ID,
      }),
      OWNER_ID,
    );
    await expectPresence(sid, 'hatcher:wp-partner', OWNER_ID);
  });

  test('Hatcher session restored from the row', async () => {
    const authorization = resolveRestoredSessionAuthorization('hatcher-proxy', OWNER_ID);
    const sid = goLive(
      avatarConfig({
        agentId: 'hatcher:wp-restored', sessionId: 'oc-wp-restored', identityType: 'hatcher',
        storedProtocol: 'hatcher-proxy', protocolOverride: 'hatcher-proxy', ...authorization,
      }),
      OWNER_ID,
    );
    await expectPresence(sid, 'hatcher:wp-restored', OWNER_ID);
  });

  test('hosted avatar agent', async () => {
    const config = buildHostedAvatarAgentConfig({
      agentId: 'wp-hosted', sessionId: 'ag-wp-hosted', ownerUserId: OWNER_ID, avatarId: AVATAR_ID,
      modelKey: 'milady_official_1', name: 'Hosted',
    });
    const sid = goLive(config, OWNER_ID);
    await expectPresence(sid, 'wp-hosted', OWNER_ID);
  });
});
