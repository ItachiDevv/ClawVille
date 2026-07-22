import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

process.env.FINGERPRINT_SECRET ??= '31'.repeat(32);
process.env.CORS_ORIGIN = 'https://staging.clawville.world';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const AVATAR_ID = '22222222-2222-4222-8222-222222222222';
const BOT_ID = '33333333-3333-4333-8333-333333333333';

let avatarExists = false;
let insertedBot: Record<string, unknown> | null = null;
let existingBotOwner: string | null = null;
let ticketMintHook: (() => Promise<void>) | null = null;

const realDatabase = await import('@clawville/database');
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

const avatarRow = {
  id: AVATAR_ID,
  userId: USER_ID,
  name: 'Front Door 111111',
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
            return avatarExists ? avatarRow : undefined;
          },
        },
        agentBots: {
          findFirst: async () => existingBotOwner == null ? undefined : {
            id: BOT_ID,
            agentId: 'frontdoor-owned-agent',
            identityType: 'custom',
            userId: existingBotOwner,
            gatewayUrl: null,
            protocol: 'nanoclaw',
            mode: 'avatar',
            name: 'Existing Owner Agent',
            species: 'milady_official_1',
            color: null,
            totalSessions: 1,
            knowledge: [],
            ack: null,
            metadata: null,
          },
        },
      };
    }
    if (property === 'transaction') {
      return async (callback: (tx: unknown) => Promise<unknown>) => callback({
        insert: (table: unknown) => ({
          values: (values: Record<string, unknown>) => ({
            returning: async () => {
              if (table !== realDatabase.avatars) throw new Error('unexpected transaction insert');
              avatarExists = true;
              return [{ ...avatarRow, ...values, id: AVATAR_ID, clawTokens: 100 }];
            },
          }),
        }),
      });
    }
    if (property === 'insert') {
      return (table: unknown) => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            if (table !== realDatabase.agentBots) throw new Error('unexpected direct insert');
            insertedBot = values;
            return [{ ...values, id: BOT_ID }];
          },
        }),
      });
    }
    if (property === 'update') {
      return () => ({
        set: () => ({
          where: () => {
            const result = Promise.resolve([]) as unknown as Promise<unknown[]> & {
              returning: () => Promise<unknown[]>;
            };
            result.returning = async () => [];
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
mock.module('../../services/identity-service', () => ({
  ...realIdentity,
  resolvePublicOnboardingIdentity: async (identityType: string) => ({
    user: { id: USER_ID },
    identityType,
  }),
  generateIdentityKeypairForUser: async () => ({
    publicKey: 'identity-public-key',
    isFirstTime: false,
    needsHumanReauth: false,
  }),
}));

mock.module('../../services/wallet-service', () => ({
  ensureWallet: async () => ({ publicKey: 'agent-wallet' }),
  ensureWalletWithFirstTimeSecret: async () => ({
    publicKey: 'avatar-wallet',
    firstTimeSecretKeyBase58: undefined,
  }),
}));

mock.module('../../services/session-ticket-service', () => ({
  mintSessionTicket: async () => {
    if (ticketMintHook) await ticketMintHook();
    return {
      ticket: 'sess-frontdoor-test',
      url: 'https://staging.clawville.world/enter?t=sess-frontdoor-test',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      instruction: 'test handoff',
    };
  },
}));

mock.module('../../services/covenant-action-recorder', () => ({
  recordCovenantAction: async () => ({ id: 'genesis', deduped: false }),
}));

const realEventLogger = await import('../../services/event-logger');
mock.module('../../services/event-logger', () => ({
  ...realEventLogger,
  logEvent: async () => undefined,
  logEventFromContext: async () => undefined,
}));

const {
  agentGatewayRoutes,
  pendingConnections,
  publicConnectTokenSchema,
  publicConnectStatusSchema,
  publicConnectStatusParamSchema,
  resetPublicConnectTokenStateForTests,
} = await import('../agent-gateway');
const { npcSimulation } = await import('../../services/npc-simulation');

function buildApp() {
  const app = new Hono<{
    Variables: { fpHash: string; ipPrefixHash: string };
  }>();
  app.use('*', async (c, next) => {
    c.set('fpHash', c.req.header('x-test-fp') ?? 'fp-browser-a');
    c.set('ipPrefixHash', 'ip-prefix-a');
    await next();
  });
  app.route('/api/agent', agentGatewayRoutes);
  return app;
}

async function mint(app = buildApp(), ip = '203.0.113.8') {
  const response = await app.request('/api/agent/connect-token/public', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cf-connecting-ip': ip,
      'x-test-fp': 'fp-browser-a',
    },
    body: JSON.stringify({ learningFocus: '  Solana signing  ' }),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

beforeEach(() => {
  resetPublicConnectTokenStateForTests();
  avatarExists = false;
  insertedBot = null;
  existingBotOwner = null;
  ticketMintHook = null;
});

afterAll(() => {
  for (const pending of pendingConnections.values()) {
    if (pending.sessionId) npcSimulation.unregisterAgentBot(pending.sessionId);
  }
  resetPublicConnectTokenStateForTests();
});

describe('logged-out front-door agent connect', () => {
  test('strict Zod schemas reject unknown or malformed public inputs', () => {
    expect(publicConnectTokenSchema.safeParse({ extra: true }).success).toBe(false);
    expect(publicConnectTokenSchema.safeParse({ learningFocus: 'x'.repeat(121) }).success).toBe(false);
    expect(publicConnectStatusSchema.safeParse({ pollSecret: 'short' }).success).toBe(false);
    expect(publicConnectStatusSchema.safeParse({ pollSecret: 'x'.repeat(40), extra: true }).success).toBe(false);
    expect(publicConnectStatusParamSchema.safeParse({ token: 'not-a-connect-token' }).success).toBe(false);
    expect(publicConnectStatusParamSchema.safeParse({ token: `ct-${'a'.repeat(32)}` }).success).toBe(true);
  });

  test('rejects a malformed public status token before pending lookup', async () => {
    const response = await buildApp().request('/api/agent/connect-status/public/not-a-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollSecret: `cp-${'x'.repeat(32)}` }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Invalid request' });
  });

  test('mints without Lucia, remains unbound, and stores only poll-secret digest', async () => {
    const app = buildApp();
    const { response, body } = await mint(app);
    expect(response.status).toBe(200);
    expect(body.connectUrl).toMatch(
      /^https:\/\/api-staging\.clawville\.world\/api\/skills\/connect\?token=ct-/,
    );
    expect(body.instruction).toBe(`Read this URL and follow the instructions: ${body.connectUrl}`);
    expect(body.pollSecret).toMatch(/^cp-/);

    const pending = pendingConnections.get(String(body.token));
    expect(pending).toMatchObject({
      userId: null,
      avatarId: null,
      avatarName: null,
      learningFocus: 'Solana signing',
      connected: false,
      publicHandoff: {
        fpHash: 'fp-browser-a',
        ipPrefixHash: 'ip-prefix-a',
      },
    });
    expect(pending?.publicHandoff?.pollSecretHash).not.toBe(body.pollSecret);

    const skillResponse = await app.request(
      `/api/agent/connect-skill?token=${String(body.token)}`,
    );
    expect(skillResponse.status).toBe(200);
    expect(skillResponse.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    const skill = await skillResponse.text();
    expect(skill).toContain('https://api-staging.clawville.world/api/agent/connect');
    expect(skill).not.toContain('https://api.clawville.world/api/agent/connect');
    expect(skill).toContain('## What ClawVille is: the world you are entering');
  });

  test('hard-limits public mint to five requests per minute per trusted IP', async () => {
    const app = buildApp();
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await mint(app)).response.status).toBe(200);
    }
    const limited = await mint(app);
    expect(limited.response.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited' });
  });

  test('caps slow public minting at twenty-five requests per IP each day', async () => {
    const app = buildApp();
    const realDateNow = Date.now;
    let now = 2_000_000_000_000;
    Date.now = () => now;
    try {
      for (let batch = 0; batch < 5; batch++) {
        for (let attempt = 0; attempt < 5; attempt++) {
          expect((await mint(app, '203.0.113.25')).response.status).toBe(200);
        }
        now += 61_000;
      }
      const limited = await mint(app, '203.0.113.25');
      expect(limited.response.status).toBe(429);
      expect(limited.body).toMatchObject({ code: 'rate_limited' });
    } finally {
      Date.now = realDateNow;
    }
  });

  test('does not reserve an unbound public token when identityKey is missing', async () => {
    const app = buildApp();
    const minted = await mint(app);
    const token = String(minted.body.token);
    const response = await app.request('/api/agent/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.4' },
      body: JSON.stringify({ connectionToken: token, agentId: 'frontdoor-no-key' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request' });
    expect(pendingConnections.get(token)?.connected).toBe(false);
  });

  test('preserves a different existing owner and issues no public handoff', async () => {
    const app = buildApp();
    const minted = await mint(app);
    const token = String(minted.body.token);
    const pollSecret = String(minted.body.pollSecret);
    const priorOwner = '44444444-4444-4444-8444-444444444444';
    existingBotOwner = priorOwner;

    const response = await app.request('/api/agent/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.44' },
      body: JSON.stringify({
        connectionToken: token,
        agentId: 'frontdoor-owned-agent',
        identityType: 'custom',
        identityKey: 'different-claimant-identity-secret',
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Connection token claim conflicted' });
    expect(existingBotOwner).toBe(priorOwner);
    expect(insertedBot).toBeNull();
    expect(pendingConnections.get(token)).toMatchObject({
      connected: false,
      userId: USER_ID,
      avatarId: AVATAR_ID,
    });
    expect(pendingConnections.get(token)?.publicHandoff?.enterUrl).toBeUndefined();

    const poll = await app.request(`/api/agent/connect-status/public/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-fp': 'fp-browser-a' },
      body: JSON.stringify({ pollSecret }),
    });
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({ connected: false, enterUrl: null });
  });

  test('preserves an in-progress claim across the original token expiry', async () => {
    const app = buildApp();
    const realDateNow = Date.now;
    const mintedAt = 2_100_000_000_000;
    let now = mintedAt;
    Date.now = () => now;
    let releaseTicket!: () => void;
    let signalTicketStarted!: () => void;
    const ticketStarted = new Promise<void>((resolve) => {
      signalTicketStarted = resolve;
    });
    const ticketRelease = new Promise<void>((resolve) => {
      releaseTicket = resolve;
    });
    ticketMintHook = async () => {
      signalTicketStarted();
      await ticketRelease;
    };

    let connectedSessionId: string | null = null;
    try {
      const minted = await mint(app, '203.0.113.88');
      const token = String(minted.body.token);
      const pollSecret = String(minted.body.pollSecret);
      now = mintedAt + 5 * 60_000 - 1;

      const connectPromise = app.request('/api/agent/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.88' },
        body: JSON.stringify({
          connectionToken: token,
          agentId: 'frontdoor-expiry-race-agent',
          identityType: 'custom',
          identityKey: 'expiry-race-identity-secret',
        }),
      });
      await ticketStarted;

      // Cross the original five-minute cutoff, then trigger both public poll
      // and cleanup via another mint. The reserved claim's bounded deadline
      // must keep the same pending object alive.
      now += 2_000;
      const legacyPoll = await app.request(`/api/agent/connect-status/${token}`);
      expect(legacyPoll.status).toBe(404);
      expect(pendingConnections.has(token)).toBe(true);

      const duplicateClaim = await app.request('/api/agent/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.89' },
        body: JSON.stringify({
          connectionToken: token,
          agentId: 'frontdoor-expiry-race-agent-duplicate',
          identityType: 'custom',
          identityKey: 'duplicate-expiry-race-secret',
        }),
      });
      expect(duplicateClaim.status).toBe(409);
      expect(pendingConnections.has(token)).toBe(true);

      const waiting = await app.request(`/api/agent/connect-status/public/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-fp': 'fp-browser-a' },
        body: JSON.stringify({ pollSecret }),
      });
      expect(waiting.status).toBe(200);
      expect(await waiting.json()).toMatchObject({ connected: false, enterUrl: null });
      expect((await mint(app, '203.0.113.89')).response.status).toBe(200);
      expect(pendingConnections.has(token)).toBe(true);

      releaseTicket();
      const connected = await connectPromise;
      expect(connected.status).toBe(200);
      const connectedBody = await connected.json() as { sessionId: string };
      connectedSessionId = connectedBody.sessionId;

      const handoff = await app.request(`/api/agent/connect-status/public/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-fp': 'fp-browser-a' },
        body: JSON.stringify({ pollSecret }),
      });
      expect(handoff.status).toBe(200);
      expect(await handoff.json()).toMatchObject({
        connected: true,
        enterUrl: 'https://staging.clawville.world/enter?t=sess-frontdoor-test',
      });
    } finally {
      releaseTicket();
      ticketMintHook = null;
      Date.now = realDateNow;
      if (connectedSessionId) npcSimulation.unregisterAgentBot(connectedSessionId);
    }
  });

  test('claims into a real user/avatar and returns one fingerprint-bound enterUrl only', async () => {
    const app = buildApp();
    const minted = await mint(app);
    const token = String(minted.body.token);
    const pollSecret = String(minted.body.pollSecret);

    const connectResponse = await app.request('/api/agent/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.5' },
      body: JSON.stringify({
        connectionToken: token,
        agentId: 'frontdoor-real-agent',
        identityType: 'custom',
        identityKey: 'existing-agent-identity-secret',
        name: 'Front Door',
      }),
    });
    expect(connectResponse.status).toBe(200);
    const connectBody = await connectResponse.json() as { sessionId: string };
    expect(insertedBot?.userId).toBe(USER_ID);
    expect(pendingConnections.get(token)).toMatchObject({
      userId: USER_ID,
      avatarId: AVATAR_ID,
      avatarName: expect.any(String),
      connected: true,
      publicHandoff: {
        enterUrl: 'https://staging.clawville.world/enter?t=sess-frontdoor-test',
      },
    });

    const wrongFingerprint = await app.request(`/api/agent/connect-status/public/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-fp': 'fp-attacker' },
      body: JSON.stringify({ pollSecret }),
    });
    expect(wrongFingerprint.status).toBe(404);
    expect(JSON.stringify(await wrongFingerprint.json())).not.toContain('enter?t=');

    const wrongSecret = await app.request(`/api/agent/connect-status/public/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-fp': 'fp-browser-a' },
      body: JSON.stringify({ pollSecret: `cp-${'x'.repeat(32)}` }),
    });
    expect(wrongSecret.status).toBe(404);

    const handoff = await app.request(`/api/agent/connect-status/public/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-fp': 'fp-browser-a' },
      body: JSON.stringify({ pollSecret }),
    });
    expect(handoff.status).toBe(200);
    const handoffBody = await handoff.json() as Record<string, unknown>;
    expect(handoffBody).toMatchObject({
      connected: true,
      enterUrl: 'https://staging.clawville.world/enter?t=sess-frontdoor-test',
    });
    expect(handoffBody.sessionId).toBeUndefined();
    expect(handoffBody.agentId).toBeUndefined();
    expect(pendingConnections.has(token)).toBe(false);

    const replay = await app.request(`/api/agent/connect-status/public/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-fp': 'fp-browser-a' },
      body: JSON.stringify({ pollSecret }),
    });
    expect(replay.status).toBe(404);
    npcSimulation.unregisterAgentBot(connectBody.sessionId);
  });
});
