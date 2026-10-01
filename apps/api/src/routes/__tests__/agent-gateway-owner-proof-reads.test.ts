import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { getBooksForBuilding } from '@clawville/shared';

// connect-sec round 4 (C12): `resolveAgentSession` gives the row owner only to
// a session whose config `boundUserId` equals the row's current `userId` (C10).
// GET /api/agent/wallet and the session-authed skill reads below still read
// `bot.userId` for ANY live session, so a stray session (a live bearer that
// never proved this owner) read the owner's wallet, CT balance, owned skills
// and lessons, and used the owner's skill entitlement. Each route must now
// answer a stray as it answers an unbound session, and the real owner and a
// Hatcher partner session must still read their wallet.

process.env.FINGERPRINT_SECRET ??= '43'.repeat(32);

const OWNER_ID = '81111111-1111-4111-8111-111111111111';
const OTHER_ID = '82222222-2222-4222-8222-222222222222';
const AVATAR_ID = '83333333-3333-4333-8333-333333333333';
const BOT_ID = '84444444-4444-4444-8444-444444444444';
const BUILDING_ID = 'cron-automation';
const TOOL_NAME = 'cron_describe';
const OWNED_ENTRY = getBooksForBuilding(BUILDING_ID)[0]!.knowledgeEntries[0]!;

const OWNER_AVATAR = {
  id: AVATAR_ID,
  userId: OWNER_ID,
  name: 'Owner Avatar 811111',
  walletAddress: 'OwnerWa11et1111111111111111111111111111111',
  clawTokens: 4242,
  isActive: true,
  platformAgentId: null,
  characterConfig: { knowledge: [OWNED_ENTRY] },
};

let botRow: Record<string, unknown> | null = null;
let lessonReads = 0;
let blackjackReads = 0;
let toolRuns = 0;

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
        avatars: { findFirst: async () => ({ ...OWNER_AVATAR }) },
      };
    }
    if (property === 'update') {
      // The gateway TTL slide (`extendSessionTtl`); never reaches a real DB.
      return () => ({ set: () => ({ where: async () => [] }) });
    }
    if (property === 'select') {
      // GET .../skill.md reads the building_skills row.
      return () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ name: `clawville-${BUILDING_ID}`, content: '# owner skill body', generatorVersion: 'test' }],
          }),
        }),
      });
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});

mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const realEarned = await import('../../services/earned-skill-memory');
restoreModules.push(['../../services/earned-skill-memory', { ...realEarned }]);
mock.module('../../services/earned-skill-memory', () => ({
  ...realEarned,
  readEarnedSkillLessons: async () => {
    lessonReads++;
    return [{ lesson: 'owner lesson' }];
  },
}));

const realGameMemory = await import('../../services/game-skill-memory');
restoreModules.push(['../../services/game-skill-memory', { ...realGameMemory }]);
mock.module('../../services/game-skill-memory', () => ({
  ...realGameMemory,
  getBlackjackSkillContext: async () => {
    blackjackReads++;
    return { lessons: ['owner blackjack lesson'], record: { wins: 7, losses: 3 } };
  },
}));

const realDispatcher = await import('../../services/skill-tools-dispatcher');
restoreModules.push(['../../services/skill-tools-dispatcher', { ...realDispatcher }]);
mock.module('../../services/skill-tools-dispatcher', () => ({
  ...realDispatcher,
  runTool: async () => {
    toolRuns++;
    return { ok: true, output: 'ran as owner' };
  },
}));

const realEventLogger = await import('../../services/event-logger');
restoreModules.push(['../../services/event-logger', { ...realEventLogger }]);
mock.module('../../services/event-logger', () => ({
  ...realEventLogger,
  logEvent: async () => {},
  logEventFromContext: async () => {},
}));

const { agentGatewayRoutes } = await import('../agent-gateway');
const { npcSimulation } = await import('../../services/npc-simulation');
const { AgentSubstrateClient } = await import('../../services/agent-substrate-client');
const { buildAvatarSessionConfig } = await import('../../services/agent-session-config');
const { resolvePersistedConnectOwnerProof } = await import('../../services/agent-owner-binding');
const { resolveRestoredSessionAuthorization } = await import('../../services/agent-session-restore');
const { sha256Hex } = await import('../../services/session-digest');

type Registration = Parameters<typeof npcSimulation.registerAgentBot>[0];

const registered = new Set<string>();
let ipCounter = 0;

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
    name: 'Owner Proof Reads',
    species: null,
    color: null,
    stats: { hp: 100, attack: 10, defense: 8, speed: 6 },
    homeX: 2560,
    homeY: 2560,
    patrolRadius: 100,
    personality: 'owner proof reads test',
  } as Parameters<typeof buildAvatarSessionConfig>[0]);
}

/** Register ONE live session whose bearer hash is the row's current hash. */
function goLive(config: Registration, rowUserId: string | null): string {
  npcSimulation.registerAgentBot(config, new AgentSubstrateClient(config));
  registered.add(config.sessionId);
  botRow = {
    id: BOT_ID,
    agentId: config.agentId,
    identityType: 'custom',
    userId: rowUserId,
    sessionKeyHash: sha256Hex(config.sessionId),
    sessionExpiresAt: new Date(Date.now() + 60 * 60_000),
  };
  return config.sessionId;
}

/** A live session from the unowned period: no proven owner, row now owned. */
function strayOnOwnedRow(tag: string): string {
  return goLive(
    avatarConfig({ agentId: `c12-stray-${tag}`, sessionId: `ag-c12-stray-${tag}`, ledgerCapable: false, boundUserId: null }),
    OWNER_ID,
  );
}

/** The real owner: a /connect identity-key claim of the persisted owner. */
function connectOwner(tag: string): string {
  const proof = resolvePersistedConnectOwnerProof({
    source: 'explicit-identity', candidateUserId: OWNER_ID, persistedUserId: OWNER_ID, avatarId: AVATAR_ID,
  });
  return goLive(avatarConfig({ agentId: `c12-owner-${tag}`, sessionId: `ag-c12-owner-${tag}`, ...proof }), OWNER_ID);
}

async function call(method: 'GET' | 'POST', path: string) {
  const app = new Hono();
  app.route('/api/agent', agentGatewayRoutes);
  ipCounter++;
  const response = await app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'cf-connecting-ip': `203.0.113.${(ipCounter % 250) + 1}`,
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  const text = await response.text();
  return { status: response.status, text };
}

function expectNoOwnerData(text: string) {
  expect(text).not.toContain(OWNER_ID);
  expect(text).not.toContain(AVATAR_ID);
  expect(text).not.toContain(OWNER_AVATAR.walletAddress);
  expect(text).not.toContain('4242');
  expect(text).not.toContain('owner lesson');
  expect(text).not.toContain('owner blackjack lesson');
  expect(text).not.toContain('owner skill body');
  expect(text).not.toContain('ran as owner');
}

beforeEach(() => {
  botRow = null;
  lessonReads = 0;
  blackjackReads = 0;
  toolRuns = 0;
});

afterEach(() => {
  for (const sessionId of registered) npcSimulation.unregisterAgentBot(sessionId);
  registered.clear();
});

afterAll(() => {
  for (const [path, real] of restoreModules) mock.module(path, () => real);
});

describe('GET /api/agent/wallet owner proof', () => {
  test('a stray session gets the unbound 404 and no owner wallet data', async () => {
    const sid = strayOnOwnedRow('wallet');
    const res = await call('GET', `/api/agent/wallet?sessionId=${sid}`);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toEqual({ error: 'Session is not bound to a user account' });
    expectNoOwnerData(res.text);
    // Not an eviction: the stray stays alive for perception, chat and movement.
    expect(npcSimulation.isValidAgentSession(sid)).toBe(true);
  });

  test('a non-ledger session bound to a different user gets the unbound 404', async () => {
    const sid = goLive(
      avatarConfig({ agentId: 'c12-other-wallet', sessionId: 'ag-c12-other-wallet', ledgerCapable: false, boundUserId: OTHER_ID }),
      OWNER_ID,
    );
    const res = await call('GET', `/api/agent/wallet?sessionId=${sid}`);
    expect(res.status).toBe(404);
    expectNoOwnerData(res.text);
  });

  test('the real owner (/connect identity claim) still reads the wallet', async () => {
    const sid = connectOwner('wallet');
    const res = await call('GET', `/api/agent/wallet?sessionId=${sid}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      avatarId: AVATAR_ID,
      avatarName: OWNER_AVATAR.name,
      wallet: { address: OWNER_AVATAR.walletAddress, chain: 'solana' },
      balances: { clawTokens: 4242, solLamports: null },
    });
  });

  test('the /enter keeper (bindAgentOwner stamped the redeemer) still reads the wallet', async () => {
    const config = avatarConfig({ agentId: 'c12-keeper', sessionId: 'ag-c12-keeper', ledgerCapable: false, boundUserId: null });
    const sid = goLive(config, OWNER_ID);
    expect(npcSimulation.bindAgentOwner('c12-keeper', OWNER_ID)).toBe(1);
    const res = await call('GET', `/api/agent/wallet?sessionId=${sid}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ avatarId: AVATAR_ID, balances: { clawTokens: 4242 } });
  });

  test('a Hatcher partner session (boundUserId = persisted row.userId) still reads the wallet', async () => {
    const sid = goLive(
      avatarConfig({
        agentId: 'hatcher:c12-partner', sessionId: 'oc-c12-partner', identityType: 'hatcher',
        storedProtocol: 'hatcher-proxy', protocolOverride: 'hatcher-proxy',
        ledgerCapable: true, boundUserId: OWNER_ID,
      }),
      OWNER_ID,
    );
    const res = await call('GET', `/api/agent/wallet?sessionId=${sid}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({
      avatarId: AVATAR_ID,
      wallet: { address: OWNER_AVATAR.walletAddress, chain: 'solana' },
      balances: { clawTokens: 4242 },
    });
  });

  test('a Hatcher session restored from the row still reads the wallet', async () => {
    const authorization = resolveRestoredSessionAuthorization('hatcher-proxy', OWNER_ID);
    const sid = goLive(
      avatarConfig({
        agentId: 'hatcher:c12-restored', sessionId: 'oc-c12-restored', identityType: 'hatcher',
        storedProtocol: 'hatcher-proxy', protocolOverride: 'hatcher-proxy', ...authorization,
      }),
      OWNER_ID,
    );
    const res = await call('GET', `/api/agent/wallet?sessionId=${sid}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ avatarId: AVATAR_ID, balances: { clawTokens: 4242 } });
  });

  test('unchanged: an anonymous session on an unowned row gets the unbound 404', async () => {
    const sid = goLive(
      avatarConfig({ agentId: 'c12-anon', sessionId: 'ag-c12-anon', ledgerCapable: false, boundUserId: null }),
      null,
    );
    const res = await call('GET', `/api/agent/wallet?sessionId=${sid}`);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toEqual({ error: 'Session is not bound to a user account' });
  });
});

describe('session-authed skill reads owner proof', () => {
  test('GET /:sessionId/owned-skills: a stray sees no owned skills; the owner sees them', async () => {
    const stray = strayOnOwnedRow('owned');
    const refused = await call('GET', `/api/agent/${stray}/owned-skills`);
    expect(refused.status).toBe(200);
    expect(JSON.parse(refused.text)).toEqual({ ownedSkills: [] });

    const owner = connectOwner('owned');
    const admitted = await call('GET', `/api/agent/${owner}/owned-skills`);
    expect(admitted.status).toBe(200);
    expect((JSON.parse(admitted.text) as { ownedSkills: Array<{ buildingId: string }> }).ownedSkills)
      .toContainEqual(expect.objectContaining({ buildingId: BUILDING_ID }));
  });

  test('GET /:sessionId/skills/:buildingId/tools.json: a stray gets the not-linked 404', async () => {
    const stray = strayOnOwnedRow('tools-json');
    const res = await call('GET', `/api/agent/${stray}/skills/${BUILDING_ID}/tools.json`);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toEqual({ error: 'Agent not linked to a user' });
  });

  test('GET /:sessionId/skills/:buildingId/skill-memory: a stray gets the not-linked 404 and no lessons', async () => {
    const stray = strayOnOwnedRow('skill-memory');
    const res = await call('GET', `/api/agent/${stray}/skills/${BUILDING_ID}/skill-memory`);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toEqual({ error: 'Agent not linked to a user' });
    expect(lessonReads).toBe(0);
    expectNoOwnerData(res.text);
  });

  test('POST /:sessionId/skills/:buildingId/tools/:toolName: a stray cannot use the owner entitlement', async () => {
    const stray = strayOnOwnedRow('tool-run');
    const res = await call('POST', `/api/agent/${stray}/skills/${BUILDING_ID}/tools/${TOOL_NAME}`);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toEqual({ error: 'Agent not linked to a user' });
    expect(toolRuns).toBe(0);
  });

  test('GET /:sessionId/skills/:buildingId/skill.md: a stray gets the not-linked 404 and no body', async () => {
    const stray = strayOnOwnedRow('skill-md');
    const res = await call('GET', `/api/agent/${stray}/skills/${BUILDING_ID}/skill.md`);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toEqual({ error: 'Agent not linked to a user' });
    expectNoOwnerData(res.text);
  });

  test('GET /:sessionId/cove/blackjack/skill-memory: a stray gets the not-linked 404 and no record', async () => {
    const stray = strayOnOwnedRow('bj-memory');
    const res = await call('GET', `/api/agent/${stray}/cove/blackjack/skill-memory`);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toEqual({ error: 'Agent not linked to a user' });
    expect(blackjackReads).toBe(0);
    expectNoOwnerData(res.text);
  });

  test('the real owner still reads tools.json, skill-memory, skill.md and blackjack memory and runs a tool', async () => {
    const owner = connectOwner('reads');
    const toolsJson = await call('GET', `/api/agent/${owner}/skills/${BUILDING_ID}/tools.json`);
    expect(toolsJson.status).toBe(200);
    expect(toolsJson.text).toContain(TOOL_NAME);
    const memory = await call('GET', `/api/agent/${owner}/skills/${BUILDING_ID}/skill-memory`);
    expect(memory.status).toBe(200);
    expect(lessonReads).toBe(1);
    const skillMd = await call('GET', `/api/agent/${owner}/skills/${BUILDING_ID}/skill.md`);
    expect(skillMd.status).toBe(200);
    expect(skillMd.text).toContain('owner skill body');
    const bj = await call('GET', `/api/agent/${owner}/cove/blackjack/skill-memory`);
    expect(bj.status).toBe(200);
    expect(blackjackReads).toBe(1);
    const tool = await call('POST', `/api/agent/${owner}/skills/${BUILDING_ID}/tools/${TOOL_NAME}`);
    expect(tool.status).toBe(200);
    expect(toolRuns).toBe(1);
  });
});
