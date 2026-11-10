/**
 * /api/agent-ai (MCP hub step 4, own AI part A): who may read and who may
 * write, zod refusals, the wallet signature for a daily-limit raise, the
 * OpenClaw-gateway refusal, no-store on every answer, and the UsePod register
 * and link that need the linked wallet's signature (never an agent session,
 * never a magic_link session alone).
 *
 * The REAL `middleware/auth.ts`, `require-human-session.ts` and
 * `require-non-guest.ts` run here. Lucia's session store, the agent-session
 * resolver, the database and the own-AI service are fakes. No process env is
 * set (CI money lane rule).
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import * as realDatabase from '@clawville/database';
import * as realAgentAuth from '../../middleware/require-auth-or-agent';
import * as realOwnAi from '../../services/own-ai';
import * as realDeposit from '../../services/usepod-deposit';

type Middleware = (c: any, next: () => Promise<void>) => unknown;
const AGENT_HEADER = realAgentAuth.AGENT_SESSION_HEADER;

type FakeSession = { userId: string; createdVia: string | null };
const sessions = new Map<string, FakeSession>();
const guests = new Set<string>();
const activeAvatarByUser = new Map<string, string>();
const platformAgentByAvatar = new Map<string, string>();
const gatewayAgents = new Set<string>();
const agentAvatarBySession = new Map<string, { userId: string; avatarId: string }>();
const linkedWallets = new Map<string, string>();
let lastFindUserId: string | null = null;

// bun's mock.module is process-wide and patches live bindings. The CI money
// lane runs many files in one process, so copy the real exports now and put
// them back after this file (else own-ai.test.ts gets this file's fakes).
const realDepositCopy = { ...realDeposit };
const deposits: realDeposit.DepositInput[] = [];
let depositApproval = false;
let depositChallengeCalls = 0;
let ledgerCapable = true;
const realOwnAiCopy = { ...realOwnAi };
const realDatabaseCopy = { ...realDatabase };
const realAgentAuthCopy = { ...realAgentAuth };
afterAll(() => {
  mock.module('../../services/own-ai', () => realOwnAiCopy);
  mock.module('../../services/usepod-deposit', () => realDepositCopy);
  mock.module('@clawville/database', () => realDatabaseCopy);
  mock.module('../../middleware/require-auth-or-agent', () => realAgentAuthCopy);
});

mock.module('../../services/usepod-deposit', () => ({
  ...realDepositCopy,
  createUsepodDepositChallenge: async () => {
    depositChallengeCalls++;
    return { ok: true, nonce: 'n'.repeat(44), expiresAt: new Date().toISOString(), messageToSign: 'ClawVille usepod-deposit' };
  },
  depositUsepod: async (input: realDeposit.DepositInput) => {
    deposits.push(input);
    if (depositApproval && (input.actor === 'agent' || !input.signature)) return { ok: false, code: 'approval_required' };
    return { ok: true, ledgerId: 'ledger-1', status: 'paid', txSignature: 'tx-1', usdCents: input.amountCents, creditStatus: 'unknown', balance: null };
  },
}));

mock.module('../../lib/auth', () => ({
  resolveSessionCookieDomain: () => undefined,
  lucia: {
    readSessionCookie: (cookie: string) => /auth_session=([^;]+)/.exec(cookie)?.[1] ?? null,
    validateSession: async (id: string) => {
      const s = sessions.get(id);
      if (!s) return { session: null, user: null };
      return {
        session: { id, userId: s.userId, fresh: false, expiresAt: new Date(Date.now() + 60_000), createdVia: s.createdVia },
        user: { id: s.userId },
      };
    },
    createSessionCookie: () => ({ serialize: () => 'auth_session=x' }),
    createBlankSessionCookie: () => ({ serialize: () => 'auth_session=' }),
  },
}));
mock.module('../../middleware/require-auth-or-agent', () => ({
  ...realAgentAuth,
  requireAuthOrAgentSession: (async (c, next) => {
    const user = c.get('user') as { id: string } | null;
    if (user) {
      c.set('identity', { kind: 'user', userId: user.id, avatarId: activeAvatarByUser.get(user.id) ?? null, agentId: null });
      return next();
    }
    const session = agentAvatarBySession.get(c.req.header(AGENT_HEADER) ?? '');
    if (!session) throw new HTTPException(401, { message: 'Invalid or expired agent session' });
    c.set('identity', { kind: 'agent', ...session, agentId: 'agent-1', sessionId: 's', ledgerCapable });
    return next();
  }) as Middleware,
}));
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: {
    query: {
      users: {
        findFirst: async () => ({
          isGuest: lastFindUserId !== null && guests.has(lastFindUserId),
          linkedWalletPubkey: lastFindUserId ? linkedWallets.get(lastFindUserId) ?? null : null,
        }),
      },
      avatars: {
        findFirst: async () => {
          const id = lastFindUserId ? activeAvatarByUser.get(lastFindUserId) : undefined;
          return id ? { id, platformAgentId: platformAgentByAvatar.get(id) ?? null } : undefined;
        },
      },
      platformAgents: {
        findFirst: async () => {
          const avatarId = lastFindUserId ? activeAvatarByUser.get(lastFindUserId) : undefined;
          const agentId = avatarId ? platformAgentByAvatar.get(avatarId) : undefined;
          if (!agentId) return undefined;
          return gatewayAgents.has(agentId)
            ? { type: 'openclaw-bot', customization: { gateway: { gatewayUrl: 'https://gw.example' } } }
            : { type: 'avatar-agent', customization: {} };
        },
      },
    },
  },
}));

// ── Fake own-AI service ─────────────────────────────────────────────────────
type Status = {
  source: string; provider: string | null; model: string | null; speedSeconds: number; dailyLimitCents: number | null;
  keyLast4: string | null; usepodRegistered: boolean;
  today: { calls: number; inputTokens: number; outputTokens: number; estimatedCents: number };
  activeNow: 'own' | 'clawville'; fallbackReason: null; fallbackAt: null; updatedAt: string | null;
};
const stored = new Map<string, Status>();
const storedKeys = new Map<string, { provider: string; apiKey: string }>();
const saves: Array<{ avatarId: string; userId: string; input: Record<string, unknown> }> = [];
const keyTests: Array<{ provider: string; key: string; model: string }> = [];
const modelCalls: Array<{ provider: string; key: string }> = [];
const cleared: string[] = [];
let keyTestResult: { ok: true } | { ok: false; code: string } = { ok: true };
const meteredTests: Array<{ avatarId: string; requestLimitCents: number | null }> = [];
let testReservationFits = true;
let testGate: Promise<void> | null = null;
let modelsThrow: boolean | 'own' = false;
const usepodLinks = new Map<string, string>();
let registerCalls = 0;

function defaultStatus(): Status {
  return {
    source: 'clawville', provider: null, model: null, speedSeconds: 25, dailyLimitCents: null, keyLast4: null,
    usepodRegistered: false, today: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCents: 0 },
    activeNow: 'clawville', fallbackReason: null, fallbackAt: null, updatedAt: null,
  };
}

// Spread the real module: bun's mock is process-wide, and other files in the
// same run (agent-orchestrator) import exports this test does not fake.
async function fakeSave(avatarId: string, userId: string, input: Record<string, unknown>): Promise<Status> {
  saves.push({ avatarId, userId, input });
  const next: Status = {
    ...defaultStatus(),
    source: input.source as string,
    provider: (input.provider as string) ?? null,
    model: (input.model as string) ?? null,
    speedSeconds: (input.speedSeconds as number) ?? 25,
    dailyLimitCents: (input.dailyLimitCents as number) ?? null,
    keyLast4: typeof input.key === 'string' ? input.key.slice(-4) : stored.get(avatarId)?.keyLast4 ?? null,
    activeNow: input.source === 'clawville' ? 'clawville' : 'own',
  };
  stored.set(avatarId, next);
  return next;
}
let saveImpl: typeof fakeSave = fakeSave;

mock.module('../../services/own-ai', () => ({
  ...realOwnAi,
  readOwnAiStatus: async (avatarId: string) => stored.get(avatarId) ?? defaultStatus(),
  saveOwnAiSettings: (avatarId: string, userId: string, input: Record<string, unknown>) => saveImpl(avatarId, userId, input),
  clearOwnAi: async (avatarId: string) => {
    cleared.push(avatarId);
    stored.delete(avatarId);
  },
  // The route reads the stored secret through loadStoredOwnAiKey (works while
  // the source is still 'clawville' or a sticky fallback is stored).
  loadStoredOwnAiKey: async (avatarId: string, provider: string) => {
    const key = storedKeys.get(avatarId);
    return key && key.provider === provider ? key.apiKey : null;
  },
  // The route runs the METERED test (reserve -> test -> settle/release); the
  // reservation itself is covered in own-ai.test.ts.
  runMeteredOwnAiKeyTest: async (avatarId: string, provider: string, key: string, model: string, requestLimitCents: number | null) => {
    meteredTests.push({ avatarId, requestLimitCents });
    if (!testReservationFits) return { ok: false, code: 'daily_limit_reached' };
    if (testGate) await testGate;
    keyTests.push({ provider, key, model });
    return keyTestResult;
  },
  listProviderModels: async (provider: string, key: string) => {
    modelCalls.push({ provider, key });
    if (modelsThrow === 'own') throw new realOwnAi.OwnAiError('key_rejected');
    if (modelsThrow) throw new Error(`401 invalid key ${key}`);
    return ['gpt-4.1', 'gpt-5.1'];
  },
  registerUsepodToken: async () => {
    registerCalls++;
    return {
    dashboardUrl: 'https://usepod.ai/dashboard/00000000-0000-4000-8000-000000000000',
    depositCode: 'DEP123',
    contractAddress: 'Contract111',
    };
  },
  readUsepodDashboardLink: async (avatarId: string) => usepodLinks.get(avatarId) ?? null,
  readUsepodBalance: async (avatarId: string) => (usepodLinks.has(avatarId) ? { usdcMicro: 1_500_000, isActive: true } : null),
}));

const { agentAiRoutes, resetAgentAiRateLimits } = await import('../agent-ai');
const { _resetSpendProofNoncesForTest } = await import('../../services/spend-policy-proof');
const app = new Hono();
app.route('/api/agent-ai', agentAiRoutes);
app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  throw err;
});

const OPENAI_KEY = `sk-${'a'.repeat(40)}`;
const OPENAI_KEY_2 = `sk-${'b'.repeat(40)}`;
const SAVE = { source: 'own_key', provider: 'openai', model: 'gpt-4.1', speedSeconds: 15, dailyLimitCents: 200, key: OPENAI_KEY };

function call(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, opts: { cookie?: string; agent?: string; body?: unknown } = {}) {
  lastFindUserId = opts.cookie ? sessions.get(opts.cookie)?.userId ?? null : null;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = `auth_session=${opts.cookie}`;
  if (opts.agent) headers[AGENT_HEADER] = opts.agent;
  return app.request(`/api/agent-ai${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
}

function storeOwnKey(avatarId: string, dailyLimitCents: number): void {
  stored.set(avatarId, {
    ...defaultStatus(), source: 'own_key', provider: 'openai', model: 'gpt-4.1', speedSeconds: 15,
    dailyLimitCents, keyLast4: OPENAI_KEY.slice(-4), activeNow: 'own',
  });
  storedKeys.set(avatarId, { provider: 'openai', apiKey: OPENAI_KEY });
}

function linkWallet(userId: string): nacl.SignKeyPair {
  const wallet = nacl.sign.keyPair();
  linkedWallets.set(userId, bs58.encode(wallet.publicKey));
  return wallet;
}

/** Fetch the UsePod challenge as this session and sign it with `wallet`. */
async function signUsepod(action: 'register' | 'link', cookie: string, wallet: nacl.SignKeyPair): Promise<{ nonce: string; signature: string }> {
  const res = await call('POST', `/usepod/${action}/challenge`, { cookie });
  expect(res.status).toBe(200);
  expectNoStore(res);
  const challenge = await res.json() as { nonce: string; messageToSign: string };
  return {
    nonce: challenge.nonce,
    signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.messageToSign), wallet.secretKey)),
  };
}

beforeEach(() => {
  deposits.length = 0;
  depositChallengeCalls = 0;
  depositApproval = false;
  ledgerCapable = true;
  sessions.clear();
  guests.clear();
  activeAvatarByUser.clear();
  platformAgentByAvatar.clear();
  gatewayAgents.clear();
  agentAvatarBySession.clear();
  linkedWallets.clear();
  stored.clear();
  storedKeys.clear();
  saves.length = 0;
  saveImpl = fakeSave;
  keyTests.length = 0;
  modelCalls.length = 0;
  cleared.length = 0;
  usepodLinks.clear();
  registerCalls = 0;
  keyTestResult = { ok: true };
  meteredTests.length = 0;
  testReservationFits = true;
  testGate = null;
  modelsThrow = false;
  resetAgentAiRateLimits();
  _resetSpendProofNoncesForTest();
  activeAvatarByUser.set('user-a', 'avatar-a');
  activeAvatarByUser.set('user-guest', 'avatar-guest');
  activeAvatarByUser.set('user-gw', 'avatar-gw');
  platformAgentByAvatar.set('avatar-a', 'agent-a');
  platformAgentByAvatar.set('avatar-gw', 'agent-gw');
  gatewayAgents.add('agent-gw');
  guests.add('user-guest');
  sessions.set('pw-a', { userId: 'user-a', createdVia: 'password' });
  sessions.set('magic-a', { userId: 'user-a', createdVia: 'magic_link' });
  sessions.set('exchanged-a', { userId: 'user-a', createdVia: 'agent_exchange' });
  sessions.set('legacy-a', { userId: 'user-a', createdVia: null });
  sessions.set('pw-guest', { userId: 'user-guest', createdVia: 'password' });
  sessions.set('pw-gw', { userId: 'user-gw', createdVia: 'password' });
  agentAvatarBySession.set('agent-session-a', { userId: 'user-a', avatarId: 'avatar-a' });
});

function expectNoStore(res: Response): void {
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
}

describe('GET /api/agent-ai', () => {
  it('answers the human and the avatar agent with the same avatar status, no-store', async () => {
    storeOwnKey('avatar-a', 300);
    const human = await call('GET', '', { cookie: 'pw-a' });
    expect(human.status).toBe(200);
    expectNoStore(human);
    const humanBody = await human.json() as { ai: Status };
    expect(humanBody.ai.dailyLimitCents).toBe(300);
    expect(JSON.stringify(humanBody)).not.toContain(OPENAI_KEY);

    const agent = await call('GET', '', { agent: 'agent-session-a' });
    expect(agent.status).toBe(200);
    expectNoStore(agent);
    expect(await agent.json()).toEqual(humanBody);
  });

  it('refuses a logged-out caller (401) and a guest (403), still no-store', async () => {
    const out = await call('GET', '');
    expect(out.status).toBe(401);
    expectNoStore(out);
    const guest = await call('GET', '', { cookie: 'pw-guest' });
    expect(guest.status).toBe(403);
    expect((await guest.json() as { code: string }).code).toBe('guest_not_allowed');
  });
});

describe('human-only writes', () => {
  it('refuses an agent session on every write with 403 human_only, even with a human cookie', async () => {
    const writes: Array<[('PUT' | 'POST' | 'DELETE'), string, unknown]> = [
      ['PUT', '', SAVE],
      ['POST', '/challenge', SAVE],
      ['DELETE', '', undefined],
      ['POST', '/models', { provider: 'openai', key: OPENAI_KEY }],
      ['POST', '/usepod/register', undefined],
      ['POST', '/usepod/register/challenge', undefined],
      ['POST', '/usepod/link/challenge', undefined],
      ['POST', '/usepod/link', undefined],
    ];
    for (const [method, path, body] of writes) {
      const res = await call(method, path, { agent: 'agent-session-a', cookie: 'pw-a', body });
      expect(res.status).toBe(403);
      expectNoStore(res);
      expect((await res.json() as { code: string }).code).toBe('human_only');
    }
    expect(saves).toHaveLength(0);
    expect(cleared).toHaveLength(0);
    expect(modelCalls).toHaveLength(0);
  });

  it('refuses an agent-exchanged cookie (human_only) and a pre-0089 cookie (needs_human_login)', async () => {
    const exchanged = await call('PUT', '', { cookie: 'exchanged-a', body: SAVE });
    expect(exchanged.status).toBe(403);
    expect((await exchanged.json() as { code: string }).code).toBe('human_only');
    const legacy = await call('PUT', '', { cookie: 'legacy-a', body: SAVE });
    expect(legacy.status).toBe(403);
    expect((await legacy.json() as { code: string }).code).toBe('needs_human_login');
  });

  it('refuses a guest and a logged-out caller', async () => {
    const guest = await call('PUT', '', { cookie: 'pw-guest', body: SAVE });
    expect(guest.status).toBe(403);
    expect((await guest.json() as { code: string }).code).toBe('guest_not_allowed');
    const out = await call('PUT', '', { body: SAVE });
    expect(out.status).toBe(401);
    expect(saves).toHaveLength(0);
  });
});

describe('PUT /api/agent-ai', () => {
  it('saves a first own key with the login only, after one test call', async () => {
    const res = await call('PUT', '', { cookie: 'pw-a', body: SAVE });
    expect(res.status).toBe(200);
    expectNoStore(res);
    const body = await res.json() as { ai: Status };
    expect(body.ai.source).toBe('own_key');
    expect(JSON.stringify(body)).not.toContain(OPENAI_KEY);
    expect(keyTests).toEqual([{ provider: 'openai', key: OPENAI_KEY, model: 'gpt-4.1' }]);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ avatarId: 'avatar-a', userId: 'user-a' });
  });

  it('refuses bad input with 400 invalid_agent_ai and saves nothing', async () => {
    const bad: unknown[] = [
      { ...SAVE, speedSeconds: 5 },
      { ...SAVE, dailyLimitCents: 9 },
      { ...SAVE, dailyLimitCents: 50_001 },
      { ...SAVE, dailyLimitCents: undefined },
      { ...SAVE, model: undefined },
      { ...SAVE, provider: 'gemini' },
      { ...SAVE, source: 'house' },
      { ...SAVE, key: 'not-a-key' },
      { ...SAVE, provider: 'openrouter' }, // an OpenAI-shaped key for OpenRouter
      { ...SAVE, source: 'usepod' },
      { ...SAVE, baseUrl: 'https://evil.example' },
      { ...SAVE, model: 'bad model with spaces' },
      'not json object',
    ];
    for (const body of bad) {
      const res = await call('PUT', '', { cookie: 'pw-a', body });
      expect(res.status).toBe(400);
      expect((await res.json() as { code: string }).code).toBe('invalid_agent_ai');
    }
    expect(saves).toHaveLength(0);
    expect(keyTests).toHaveLength(0);
  });

  it('refuses a key the test call rejects with 400 key_test_failed and never echoes the key', async () => {
    keyTestResult = { ok: false, code: 'key_rejected' };
    const res = await call('PUT', '', { cookie: 'pw-a', body: SAVE });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(OPENAI_KEY);
    expect(JSON.parse(text)).toMatchObject({ code: 'key_test_failed', reason: 'key_rejected' });
    expect(saves).toHaveLength(0);
  });

  it('a model change with the stored key tests that key; no stored key -> 400 key_required', async () => {
    const missing = await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined } });
    expect(missing.status).toBe(400);
    expect((await missing.json() as { code: string }).code).toBe('key_required');

    storeOwnKey('avatar-a', 200);
    const res = await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, model: 'gpt-5.1' } });
    expect(res.status).toBe(200);
    expect(keyTests).toEqual([{ provider: 'openai', key: OPENAI_KEY, model: 'gpt-5.1' }]);
  });

  it('the test call is metered: the first save reserves against the requested limit; no room -> 429 daily_limit_reached, no call, no save', async () => {
    const first = await call('PUT', '', { cookie: 'pw-a', body: SAVE });
    expect(first.status).toBe(200);
    expect(meteredTests).toEqual([{ avatarId: 'avatar-a', requestLimitCents: 200 }]);

    storeOwnKey('avatar-a', 200);
    testReservationFits = false;
    keyTests.length = 0;
    saves.length = 0;
    const full =await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, model: 'gpt-5.1' } });
    expect(full.status).toBe(429);
    expect((await full.json() as { code: string }).code).toBe('daily_limit_reached');
    expect(keyTests).toHaveLength(0);
    expect(saves).toHaveLength(0);
  });

  it('PUTs that trigger a test call: 6 per 10 minutes per avatar, then 429 rate_limited; other saves are not counted', async () => {
    storeOwnKey('avatar-a', 200);
    const models = ['gpt-5.1', 'gpt-4.1'];
    for (let i = 0; i < 6; i++) {
      const res = await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, model: models[i % 2] } });
      expect(res.status).toBe(200);
    }
    const seventh = await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, model: 'gpt-5.1' } });
    expect(seventh.status).toBe(429);
    expect((await seventh.json() as { code: string }).code).toBe('rate_limited');
    expect(keyTests).toHaveLength(6);
    // A speed change runs no test, so it is not limited.
    const speed = await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, model: 'gpt-4.1', speedSeconds: 10 } });
    expect(speed.status).toBe(200);
  });

  it('one test call in flight per avatar: a concurrent second -> 409 test_in_progress', async () => {
    storeOwnKey('avatar-a', 200);
    let open!: () => void;
    testGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const firstP = call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, model: 'gpt-5.1' } });
    // Wait until the first request holds the test slot.
    for (let i = 0; i < 50 && meteredTests.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    expect(meteredTests).toHaveLength(1);
    const second = await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, model: 'gpt-4.1o' } });
    expect(second.status).toBe(409);
    expect((await second.json() as { code: string }).code).toBe('test_in_progress');
    open();
    expect((await firstP).status).toBe(200);
    // The slot frees after the test, also when the test failed.
    testGate = null;
    keyTestResult = { ok: false, code: 'key_rejected' };
    expect((await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, model: 'gpt-4.1' } })).status).toBe(400);
    keyTestResult = { ok: true };
    expect((await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, model: 'gpt-4.1' } })).status).toBe(200);
  });

  it('a speed or lower-limit change with the same key and model runs no test call and needs no signature', async () => {
    storeOwnKey('avatar-a', 200);
    const res = await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, speedSeconds: 10, dailyLimitCents: 100 } });
    expect(res.status).toBe(200);
    expect(keyTests).toHaveLength(0);
    expect(saves).toHaveLength(1);
    expect(saves[0].input.limitRaiseProven).toBe(false);
  });

  it('a client cannot send limitRaiseProven (strict body)', async () => {
    storeOwnKey('avatar-a', 200);
    const res = await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, dailyLimitCents: 500, limitRaiseProven: true } });
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('invalid_agent_ai');
    expect(saves).toHaveLength(0);
  });

  it('after a UsePod register (source still clawville) a save without a key tests the registered token', async () => {
    const token = '11111111-2222-4333-8444-555555555555';
    stored.set('avatar-a', { ...defaultStatus(), usepodRegistered: true });
    storedKeys.set('avatar-a', { provider: 'usepod', apiKey: token });
    const body = { source: 'usepod', provider: 'usepod', model: 'gpt-5.1', speedSeconds: 25, dailyLimitCents: 100 };
    const res = await call('PUT', '', { cookie: 'pw-a', body });
    expect(res.status).toBe(200);
    expect(keyTests).toEqual([{ provider: 'usepod', key: token, model: 'gpt-5.1' }]);
    expect(saves[0].input).not.toHaveProperty('key');

    // A pasted token next to the registered one: 400 usepod_token_registered, no test call.
    keyTests.length = 0;
    stored.set('avatar-a', { ...defaultStatus(), usepodRegistered: true });
    const pasted = await call('PUT', '', { cookie: 'pw-a', body: { ...body, key: '99999999-2222-4333-8444-555555555555' } });
    expect(pasted.status).toBe(400);
    expect((await pasted.json() as { code: string }).code).toBe('usepod_token_registered');
    expect(keyTests).toHaveLength(0);
  });

  it('maps a service OwnAiError by its own code and status', async () => {
    storeOwnKey('avatar-a', 200);
    const realSave = saveImpl;
    saveImpl = async () => { throw new realOwnAi.OwnAiError('raise_needs_signature'); };
    try {
      const res = await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, speedSeconds: 10 } });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'raise_needs_signature', error: 'raise_needs_signature' });
    } finally {
      saveImpl = realSave;
    }
  });

  it('refuses a raise without a linked wallet (wallet_link_required) and without a proof (raise_needs_signature)', async () => {
    storeOwnKey('avatar-a', 200);
    const noWallet = await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, dailyLimitCents: 500 } });
    expect(noWallet.status).toBe(403);
    expect((await noWallet.json() as { code: string }).code).toBe('wallet_link_required');

    linkedWallets.set('user-a', bs58.encode(nacl.sign.keyPair().publicKey));
    const noProof = await call('PUT', '', { cookie: 'pw-a', body: { ...SAVE, key: undefined, dailyLimitCents: 500 } });
    expect(noProof.status).toBe(403);
    expect(await noProof.json()).toMatchObject({ error: 'raise_needs_signature', code: 'raise_needs_signature' });
    expect(saves).toHaveLength(0);
  });

  it('saves a raise signed by the linked wallet, once; a proof for another limit or a replay is invalid_wallet_proof', async () => {
    storeOwnKey('avatar-a', 200);
    const wallet = nacl.sign.keyPair();
    linkedWallets.set('user-a', bs58.encode(wallet.publicKey));
    const values = { ...SAVE, dailyLimitCents: 500, key: OPENAI_KEY_2 };

    const challengeRes = await call('POST', '/challenge', { cookie: 'pw-a', body: values });
    expect(challengeRes.status).toBe(200);
    expectNoStore(challengeRes);
    const challengeText = await challengeRes.text();
    // The key the card sent is ignored: never echoed, never in the message.
    expect(challengeText).not.toContain(OPENAI_KEY_2);
    const challenge = JSON.parse(challengeText) as { nonce: string; messageToSign: string; walletPubkey: string };
    expect(challenge.walletPubkey).toBe(bs58.encode(wallet.publicKey));
    expect(challenge.messageToSign).toContain('ClawVille agent AI daily limit');
    expect(challenge.messageToSign).toContain('account: user-a');
    expect(challenge.messageToSign).toContain('avatar: avatar-a');
    expect(challenge.messageToSign).toContain('daily limit: $5.00');
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.messageToSign), wallet.secretKey));

    // Signed for $5.00 but asks for $6.00: refused (and the nonce is spent).
    const other = await call('PUT', '', {
      cookie: 'pw-a',
      body: { ...values, dailyLimitCents: 600, proof: { nonce: challenge.nonce, signature } },
    });
    expect(other.status).toBe(403);
    expect((await other.json() as { code: string }).code).toBe('invalid_wallet_proof');

    const second = JSON.parse(await (await call('POST', '/challenge', { cookie: 'pw-a', body: values })).text()) as { nonce: string; messageToSign: string };
    const signature2 = bs58.encode(nacl.sign.detached(new TextEncoder().encode(second.messageToSign), wallet.secretKey));
    const ok = await call('PUT', '', { cookie: 'pw-a', body: { ...values, proof: { nonce: second.nonce, signature: signature2 } } });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { ai: Status }).ai.dailyLimitCents).toBe(500);
    // The verified proof reaches the service (it re-checks the raise under its lock).
    expect(saves[0].input.limitRaiseProven).toBe(true);

    // The owner lowers it again; the spent proof cannot raise it a second time.
    storeOwnKey('avatar-a', 200);
    const replay = await call('PUT', '', { cookie: 'pw-a', body: { ...values, proof: { nonce: second.nonce, signature: signature2 } } });
    expect(replay.status).toBe(403);
    expect((await replay.json() as { code: string }).code).toBe('invalid_wallet_proof');
    expect(saves).toHaveLength(1);
  });

  it('refuses a signature from a wallet that is not the linked one', async () => {
    storeOwnKey('avatar-a', 200);
    linkedWallets.set('user-a', bs58.encode(nacl.sign.keyPair().publicKey));
    const values = { ...SAVE, key: undefined, dailyLimitCents: 500 };
    const challenge = await (await call('POST', '/challenge', { cookie: 'pw-a', body: values })).json() as { nonce: string; messageToSign: string };
    const stranger = nacl.sign.keyPair();
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.messageToSign), stranger.secretKey));
    const res = await call('PUT', '', { cookie: 'pw-a', body: { ...values, proof: { nonce: challenge.nonce, signature } } });
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe('invalid_wallet_proof');
  });

  it('challenge needs a linked wallet and a daily limit', async () => {
    const noWallet = await call('POST', '/challenge', { cookie: 'pw-a', body: SAVE });
    expect(noWallet.status).toBe(403);
    expect((await noWallet.json() as { code: string }).code).toBe('wallet_link_required');
    linkedWallets.set('user-a', bs58.encode(nacl.sign.keyPair().publicKey));
    const noLimit = await call('POST', '/challenge', { cookie: 'pw-a', body: { source: 'clawville' } });
    expect(noLimit.status).toBe(400);
  });

  it('refuses own AI with 409 openclaw_gateway_set when the agent has an OpenClaw gateway; clawville still saves', async () => {
    const res = await call('PUT', '', { cookie: 'pw-gw', body: SAVE });
    expect(res.status).toBe(409);
    expectNoStore(res);
    expect((await res.json() as { code: string }).code).toBe('openclaw_gateway_set');
    expect(keyTests).toHaveLength(0);
    const register = await call('POST', '/usepod/register', { cookie: 'pw-gw' });
    expect(register.status).toBe(409);
    expect(registerCalls).toBe(0);
    const back = await call('PUT', '', { cookie: 'pw-gw', body: { source: 'clawville' } });
    expect(back.status).toBe(200);
  });
});

describe('DELETE, models, UsePod', () => {
  it('DELETE goes back to ClawVille AI and answers { ai }', async () => {
    storeOwnKey('avatar-a', 200);
    const res = await call('DELETE', '', { cookie: 'pw-a' });
    expect(res.status).toBe(200);
    expectNoStore(res);
    expect(cleared).toEqual(['avatar-a']);
    expect((await res.json() as { ai: Status }).ai.source).toBe('clawville');
  });

  it('models: pasted key or stored key, recommended for that provider, 10 per minute per avatar', async () => {
    const res = await call('POST', '/models', { cookie: 'pw-a', body: { provider: 'openai', key: OPENAI_KEY } });
    expect(res.status).toBe(200);
    const body = await res.json() as { models: string[]; recommended: Array<{ provider: string }> };
    expect(body.models).toEqual(['gpt-4.1', 'gpt-5.1']);
    expect(body.recommended.length).toBeGreaterThan(0);
    expect(body.recommended.every((m) => m.provider === 'openai')).toBe(true);

    const missing = await call('POST', '/models', { cookie: 'pw-a', body: { provider: 'anthropic' } });
    expect(missing.status).toBe(400);
    expect((await missing.json() as { code: string }).code).toBe('key_required');

    storeOwnKey('avatar-a', 200);
    for (let i = 0; i < 8; i++) {
      expect((await call('POST', '/models', { cookie: 'pw-a', body: { provider: 'openai' } })).status).toBe(200);
    }
    expect(modelCalls.at(-1)).toEqual({ provider: 'openai', key: OPENAI_KEY });
    const limited = await call('POST', '/models', { cookie: 'pw-a', body: { provider: 'openai' } });
    expect(limited.status).toBe(429);
    expect((await limited.json() as { code: string }).code).toBe('rate_limited');
  });

  it('models: a provider failure is 502 models_unavailable without the provider text', async () => {
    modelsThrow = true;
    const res = await call('POST', '/models', { cookie: 'pw-a', body: { provider: 'openai', key: OPENAI_KEY } });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(OPENAI_KEY);
    expect(JSON.parse(text).code).toBe('models_unavailable');

    // A service OwnAiError keeps its safe code and suggested status.
    modelsThrow = 'own';
    const rejected = await call('POST', '/models', { cookie: 'pw-a', body: { provider: 'openai', key: OPENAI_KEY } });
    expect(rejected.status).toBe(400);
    const rejectedText = await rejected.text();
    expect(rejectedText).not.toContain(OPENAI_KEY);
    expect(JSON.parse(rejectedText).code).toBe('key_rejected');
  });

  it('models: refuses a key of the wrong shape and an unknown provider', async () => {
    expect((await call('POST', '/models', { cookie: 'pw-a', body: { provider: 'openai', key: 'nope' } })).status).toBe(400);
    expect((await call('POST', '/models', { cookie: 'pw-a', body: { provider: 'custom', key: OPENAI_KEY } })).status).toBe(400);
  });

  it('usepod register: linked wallet + signature first, then once per hour per avatar', async () => {
    const wallet = linkWallet('user-a');
    const ok = await call('POST', '/usepod/register', { cookie: 'pw-a', body: { proof: await signUsepod('register', 'pw-a', wallet) } });
    expect(ok.status).toBe(200);
    expectNoStore(ok);
    const body = await ok.json() as { dashboardUrl: string; depositCode: string; contractAddress: string; ai: Status };
    expect(body.depositCode).toBe('DEP123');
    expect(body.dashboardUrl).toContain('usepod.ai/dashboard/');
    expect(body.ai).toBeDefined();
    expect(registerCalls).toBe(1);
    const again = await call('POST', '/usepod/register', { cookie: 'pw-a', body: { proof: await signUsepod('register', 'pw-a', wallet) } });
    expect(again.status).toBe(429);
    expect(registerCalls).toBe(1);
  });

  it('usepod register: a magic_link session without a wallet or a proof never gets the token; no limiter slot, no UsePod call', async () => {
    const noWallet = await call('POST', '/usepod/register', { cookie: 'magic-a' });
    expect(noWallet.status).toBe(403);
    const noWalletText = await noWallet.text();
    expect(noWalletText).not.toContain('usepod.ai/dashboard');
    expect(JSON.parse(noWalletText).code).toBe('wallet_link_required');
    expect(JSON.parse(noWalletText).message).toContain('own UsePod account');

    const wallet = linkWallet('user-a');
    const noProof = await call('POST', '/usepod/register', { cookie: 'magic-a' });
    expect(noProof.status).toBe(403);
    expect((await noProof.json() as { code: string }).code).toBe('usepod_needs_signature');

    const stranger = nacl.sign.keyPair();
    const badSig = await call('POST', '/usepod/register', { cookie: 'magic-a', body: { proof: await signUsepod('register', 'magic-a', stranger) } });
    expect(badSig.status).toBe(403);
    expect((await badSig.json() as { code: string }).code).toBe('invalid_wallet_proof');
    expect(registerCalls).toBe(0);

    // The refusals burned no hourly slot: the signed request still registers.
    const ok = await call('POST', '/usepod/register', { cookie: 'magic-a', body: { proof: await signUsepod('register', 'magic-a', wallet) } });
    expect(ok.status).toBe(200);
    expect(registerCalls).toBe(1);
  });

  it('usepod link: POST with the linked wallet signature only; GET is gone; agent session -> 403 human_only', async () => {
    const wallet = linkWallet('user-a');
    const none = await call('POST', '/usepod/link', { cookie: 'pw-a', body: { proof: await signUsepod('link', 'pw-a', wallet) } });
    expect(none.status).toBe(404);
    usepodLinks.set('avatar-a', 'https://usepod.ai/dashboard/00000000-0000-4000-8000-000000000000');

    const oldGet = await call('GET', '/usepod/link', { cookie: 'pw-a' });
    expect([404, 405]).toContain(oldGet.status);
    expect(await oldGet.text()).not.toContain('usepod.ai/dashboard');

    const agent = await call('POST', '/usepod/link', { agent: 'agent-session-a', body: { proof: { nonce: 'n'.repeat(44), signature: 's'.repeat(88) } } });
    expect(agent.status).toBe(403);
    expectNoStore(agent);
    const agentText = await agent.text();
    expect(agentText).not.toContain('usepod.ai/dashboard');
    expect(JSON.parse(agentText).code).toBe('human_only');

    const magicNoProof = await call('POST', '/usepod/link', { cookie: 'magic-a' });
    expect(magicNoProof.status).toBe(403);
    const magicText = await magicNoProof.text();
    expect(magicText).not.toContain('usepod.ai/dashboard');
    expect(JSON.parse(magicText).code).toBe('usepod_needs_signature');

    const human = await call('POST', '/usepod/link', { cookie: 'magic-a', body: { proof: await signUsepod('link', 'magic-a', wallet) } });
    expect(human.status).toBe(200);
    expectNoStore(human);
    expect((await human.json() as { dashboardUrl: string }).dashboardUrl).toContain('usepod.ai/dashboard/');
  });

  it('usepod without a linked wallet: 403 wallet_link_required on both challenges and the link', async () => {
    usepodLinks.set('avatar-a', 'https://usepod.ai/dashboard/00000000-0000-4000-8000-000000000000');
    for (const path of ['/usepod/link/challenge', '/usepod/register/challenge', '/usepod/link']) {
      const res = await call('POST', path, { cookie: 'pw-a' });
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain('usepod.ai/dashboard');
      expect(JSON.parse(text).code).toBe('wallet_link_required');
    }
  });

  it('usepod proofs never cross purposes: limit, register and link signatures are not interchangeable', async () => {
    usepodLinks.set('avatar-a', 'https://usepod.ai/dashboard/00000000-0000-4000-8000-000000000000');
    const wallet = linkWallet('user-a');

    // A daily-limit signature on the link route.
    const limit = await (await call('POST', '/challenge', { cookie: 'pw-a', body: { ...SAVE, key: undefined } })).json() as { nonce: string; messageToSign: string };
    const limitSig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(limit.messageToSign), wallet.secretKey));
    const limitOnLink = await call('POST', '/usepod/link', { cookie: 'pw-a', body: { proof: { nonce: limit.nonce, signature: limitSig } } });
    expect(limitOnLink.status).toBe(403);
    expect((await limitOnLink.json() as { code: string }).code).toBe('invalid_wallet_proof');

    // A link signature on the register route.
    const linkOnRegister = await call('POST', '/usepod/register', { cookie: 'pw-a', body: { proof: await signUsepod('link', 'pw-a', wallet) } });
    expect(linkOnRegister.status).toBe(403);
    expect((await linkOnRegister.json() as { code: string }).code).toBe('invalid_wallet_proof');
    expect(registerCalls).toBe(0);

    // A register signature on the link route.
    const registerOnLink = await call('POST', '/usepod/link', { cookie: 'pw-a', body: { proof: await signUsepod('register', 'pw-a', wallet) } });
    expect(registerOnLink.status).toBe(403);
    expect((await registerOnLink.json() as { code: string }).code).toBe('invalid_wallet_proof');

    // A link proof is single use.
    const once = await signUsepod('link', 'pw-a', wallet);
    expect((await call('POST', '/usepod/link', { cookie: 'pw-a', body: { proof: once } })).status).toBe(200);
    const replay = await call('POST', '/usepod/link', { cookie: 'pw-a', body: { proof: once } });
    expect(replay.status).toBe(403);
    expect((await replay.json() as { code: string }).code).toBe('invalid_wallet_proof');
  });

  it('usepod challenge messages name the purpose, the account, the avatar and the nonce', async () => {
    linkWallet('user-a');
    const register = await (await call('POST', '/usepod/register/challenge', { cookie: 'pw-a' })).json() as { nonce: string; messageToSign: string };
    expect(register.messageToSign.split('\n')).toEqual(['ClawVille UsePod register', 'account: user-a', 'avatar: avatar-a', `nonce: ${register.nonce}`]);
    const link = await (await call('POST', '/usepod/link/challenge', { cookie: 'pw-a' })).json() as { nonce: string; messageToSign: string };
    expect(link.messageToSign.split('\n')[0]).toBe('ClawVille UsePod link');
  });

  it('usepod balance: human or agent of the avatar', async () => {
    usepodLinks.set('avatar-a', 'https://usepod.ai/dashboard/x');
    const agent = await call('GET', '/usepod/balance', { agent: 'agent-session-a' });
    expect(agent.status).toBe(200);
    expectNoStore(agent);
    expect(await agent.json()).toEqual({ usdcMicro: 1_500_000, isActive: true });
    const human = await call('GET', '/usepod/balance', { cookie: 'pw-a' });
    expect(human.status).toBe(200);
  });
});


describe('UsePod deposit routes', () => {
  const body = { amountCents: 50, idempotencyKey: 'deposit-1' };
  it('binds human and agent deposits to their resolved avatar without returning token material', async () => {
    for (const auth of [{ cookie: 'pw-a' }, { agent: 'agent-session-a' }]) {
      const res = await call('POST', '/usepod/deposit', { ...auth, body });
      expect(res.status).toBe(200);
      expectNoStore(res);
      expect(await res.json()).toEqual({ ok: true, ledgerId: 'ledger-1', status: 'paid', txSignature: 'tx-1', usdCents: 50, creditStatus: 'unknown', balance: null });
    }
    expect(deposits.map((item) => [item.avatarId, item.actor])).toEqual([['avatar-a', 'human'], ['avatar-a', 'agent']]);
  });
  it('refuses agent deposits with approval on and human deposits without a signature', async () => {
    depositApproval = true;
    for (const auth of [{ cookie: 'magic-a' }, { agent: 'agent-session-a' }]) {
      const res = await call('POST', '/usepod/deposit', { ...auth, body });
      expect(res.status).toBe(403);
      expectNoStore(res);
      expect((await res.json() as { code: string }).code).toBe('approval_required');
    }
    const signed = await call('POST', '/usepod/deposit', { cookie: 'magic-a', body: { ...body, nonce: 'n'.repeat(44), signature: 's'.repeat(88) } });
    expect(signed.status).toBe(200);
    expect(deposits.at(-1)?.nonce).toBe('n'.repeat(44));
  });
  it('requires a linked human wallet for a challenge and refuses agents', async () => {
    const agent = await call('POST', '/usepod/deposit/challenge', { agent: 'agent-session-a', body });
    expect(agent.status).toBe(403);
    expectNoStore(agent);
    const missing = await call('POST', '/usepod/deposit/challenge', { cookie: 'pw-a', body });
    expect(missing.status).toBe(403);
    linkWallet('user-a');
    const human = await call('POST', '/usepod/deposit/challenge', { cookie: 'pw-a', body });
    expect(human.status).toBe(200);
    expectNoStore(human);
    expect((await human.json() as { walletPubkey: string }).walletPubkey).toBe(linkedWallets.get('user-a')!);
  });
  it('refuses unproven agents, guests, exchanged sessions and malformed bodies before the service', async () => {
    ledgerCapable = false;
    expect((await call('POST', '/usepod/deposit', { agent: 'agent-session-a', body })).status).toBe(403);
    for (const cookie of ['pw-guest', 'exchanged-a', 'legacy-a']) {
      const res = await call('POST', '/usepod/deposit', { cookie, body });
      expect(res.status).toBe(403);
      expectNoStore(res);
    }
    expect((await call('POST', '/usepod/deposit', { cookie: 'pw-a', body: { ...body, amountCents: 5001 } })).status).toBe(400);
    expect((await call('POST', '/usepod/deposit', { cookie: 'pw-a', agent: 'agent-session-a', body })).status).toBe(403);
    expect(deposits).toHaveLength(0);
  });
});


describe('UsePod request rate limits', () => {
  const body = { amountCents: 50, idempotencyKey: 'limited-deposit' };
  it('shares the deposit limiter between human and agent requests for the same avatar', async () => {
    for (let index = 0; index < 6; index++) {
      const auth = index % 2 ? { agent: 'agent-session-a' } : { cookie: 'pw-a' };
      expect((await call('POST', '/usepod/deposit', { ...auth, body })).status).toBe(200);
    }
    const limited = await call('POST', '/usepod/deposit', { agent: 'agent-session-a', body });
    expect(limited.status).toBe(429);
    expectNoStore(limited);
    expect((await limited.json() as { code: string }).code).toBe('rate_limited');
    expect(deposits).toHaveLength(6);
    resetAgentAiRateLimits();
    expect((await call('POST', '/usepod/deposit', { cookie: 'pw-a', body })).status).toBe(200);
  });
  it('limits deposit challenges independently before the challenge service', async () => {
    linkWallet('user-a');
    for (let index = 0; index < 6; index++) {
      expect((await call('POST', '/usepod/deposit/challenge', { cookie: 'pw-a', body })).status).toBe(200);
    }
    const limited = await call('POST', '/usepod/deposit/challenge', { cookie: 'pw-a', body });
    expect(limited.status).toBe(429);
    expectNoStore(limited);
    expect((await limited.json() as { code: string }).code).toBe('rate_limited');
    expect(depositChallengeCalls).toBe(6);
    expect((await call('POST', '/usepod/deposit', { cookie: 'pw-a', body })).status).toBe(200);
    resetAgentAiRateLimits();
    expect((await call('POST', '/usepod/deposit/challenge', { cookie: 'pw-a', body })).status).toBe(200);
  });
});
