import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realAuth from '../../middleware/auth';
import * as realGuardrails from '../../services/trading-guardrails';
import * as realProvisioning from '../../services/trading-provisioning';

const originalGuardrails = { ...realGuardrails };
const originalProvisioning = { ...realProvisioning };

process.env.FINGERPRINT_SECRET ??= '44'.repeat(32);
process.env.ADMIN_USER_IDS = '11111111-1111-4111-8111-111111111111';
process.env.CORS_ORIGIN = 'https://staging.clawville.world';
process.env.NODE_ENV = 'test';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const AVATAR_ID = '33333333-3333-4333-8333-333333333333';
const WALLET = '11111111111111111111111111111111';
const CLAWPUMP_AGENT_ID = '0f600d73-05a0-4c2e-8215-ab2a770ba192';

type Middleware = (c: any, next: () => Promise<void>) => unknown;
let intercept = true;
const realSessionMiddleware = realAuth.sessionMiddleware as Middleware;
const fakeSessionMiddleware: Middleware = async (c, next) => {
  if (!intercept) return realSessionMiddleware(c, next);
  const userId = c.req.header('x-test-user');
  c.set('user', userId ? { id: userId } : null);
  c.set('session', userId ? { id: `session-${userId}`, userId } : null);
  await next();
};
mock.module('../../middleware/auth', () => ({
  ...realAuth,
  sessionMiddleware: fakeSessionMiddleware,
}));

class MockTradingProvisioningError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 500 | 503, message: string) {
    super(message);
  }
}

let provisionCalls: unknown[] = [];
let pairCalls: unknown[] = [];
let pairChallengeCalls: unknown[] = [];
let releaseCalls: string[] = [];
let provisionError: Error | null = null;
let pairError: Error | null = null;
let observedCalls: Record<string, unknown[]> = {};
let observedError: Error | null = null;

mock.module('../../services/trading-provisioning', () => ({
  TradingProvisioningError: MockTradingProvisioningError,
  listObservedClawPumpAgents: async () => {
    observedCalls.list!.push(null);
    if (observedError) throw observedError;
    return { agents: [{ clawpumpAgentId: CLAWPUMP_AGENT_ID, name: 'Genesis', status: 'active', walletPubkey: WALLET, pairedAvatarId: AVATAR_ID }] };
  },
  provisionObservedClawPumpAccount: async (input: unknown) => {
    observedCalls.provision!.push(input);
    if (observedError) throw observedError;
    return { ok: true, created: true, userId: ADMIN_ID, avatarId: AVATAR_ID, avatarName: 'Genesis', clawvilleAgentId: 'platform-agent', clawpumpAgentId: CLAWPUMP_AGENT_ID, walletPubkey: WALLET };
  },
  pairObservedClawPumpAgent: async (input: unknown) => {
    observedCalls.pair!.push(input);
    if (observedError) throw observedError;
    return { ok: true, replayed: false, subjectKind: 'agent', avatarId: AVATAR_ID, clawvilleAgentId: 'platform-agent', clawpumpAgentId: CLAWPUMP_AGENT_ID, walletPubkey: WALLET, objective: 'momentum-board', operatedByClawville: false, boundSlot: 123 };
  },
  unpairObservedClawPumpAgent: async (input: unknown) => {
    observedCalls.unpair!.push(input);
    if (observedError) throw observedError;
    return { ok: true, alreadyUnpaired: false, avatarId: AVATAR_ID, clawpumpAgentId: CLAWPUMP_AGENT_ID, walletPubkey: WALLET };
  },
  provisionFleetAccount: async (input: unknown) => {
    provisionCalls.push(input);
    if (provisionError) throw provisionError;
    return {
      ok: true,
      userId: ADMIN_ID,
      avatarId: AVATAR_ID,
      clawvilleAgentId: 'platform-agent',
      walletPubkey: WALLET,
      objective: 'momentum-board',
      armed: false,
      killed: true,
    };
  },
  issueFounderPairChallenge: async (input: unknown) => {
    pairChallengeCalls.push(input);
    return { nonce: 'wallet-proof-nonce-value-1234567890', expiresAt: new Date(Date.now() + 60_000).toISOString(), messageToSign: 'sign-me', walletPubkey: WALLET };
  },
  pairFounderAgent: async (input: unknown) => {
    pairCalls.push(input);
    if (pairError) throw pairError;
    return {
      ok: true,
      subjectKind: 'agent',
      avatarId: AVATAR_ID,
      clawvilleAgentId: 'platform-agent',
      clawpumpAgentId: 'genesis',
      walletPubkey: WALLET,
      objective: 'momentum-board',
      operatedByClawville: false,
    };
  },
}));

mock.module('../../services/trading-guardrails', () => ({
  ...realGuardrails,
  releaseLegacyAdmittedDecision: async (decisionId: string) => {
    releaseCalls.push(decisionId);
    return 'released' as const;
  },
}));

const { adminTradingRoutes } = await import('../admin-trading');
const app = new Hono().route('/api/admin/trading', adminTradingRoutes);

function headers(userId = ADMIN_ID, origin = 'https://staging.clawville.world') {
  return {
    'Content-Type': 'application/json',
    Origin: origin,
    'x-test-user': userId,
  };
}

async function nonce(userId = ADMIN_ID): Promise<string> {
  const response = await app.request('/api/admin/trading/nonce', {
    headers: { Origin: 'https://staging.clawville.world', 'x-test-user': userId },
  });
  expect(response.status).toBe(200);
  const payload = await response.json() as { nonce: string };
  return payload.nonce;
}

async function post(path: string, body: unknown, confirmationNonce?: string, userId = ADMIN_ID, origin?: string) {
  return app.request(`/api/admin/trading${path}`, {
    method: 'POST',
    headers: {
      ...headers(userId, origin ?? 'https://staging.clawville.world'),
      ...(confirmationNonce ? { 'X-Money-Confirmation-Nonce': confirmationNonce } : {}),
    },
    body: JSON.stringify(body),
  });
}

const provisionBody = { objective: 'momentum-board', traderName: 'MomentumTrader' };
const observedProvisionBody = { clawpumpAgentId: CLAWPUMP_AGENT_ID };
const observedUnpairBody = { avatarId: AVATAR_ID, clawpumpAgentId: CLAWPUMP_AGENT_ID };
const observedPairBody = { ...observedUnpairBody, objective: 'momentum-board' };
const pairBody = {
  avatarId: AVATAR_ID,
  clawpumpAgentId: 'genesis',
  walletPubkey: WALLET,
  objective: 'momentum-board',
  nonce: 'wallet-proof-nonce-value-1234567890',
  signature: '1'.repeat(88),
};

beforeEach(() => {
  provisionCalls = [];
  pairCalls = [];
  pairChallengeCalls = [];
  releaseCalls = [];
  provisionError = null;
  pairError = null;
  observedCalls = { list: [], provision: [], pair: [], unpair: [] };
  observedError = null;
});

afterAll(() => {
  intercept = false;
  mock.module('../../services/trading-provisioning', () => originalProvisioning);
  mock.module('../../services/trading-guardrails', () => originalGuardrails);
});

describe('admin Trading Floor fleet provisioning and pairing', () => {
  test.each([
    ['/fleet/provision', provisionBody] as const,
    ['/pair', pairBody] as const,
    ['/clawpump/provision', observedProvisionBody] as const,
    ['/clawpump/pair', observedPairBody] as const,
    ['/clawpump/unpair', observedUnpairBody] as const,
  ])('%s rejects no session, non-admin, bad origin, and missing nonce', async (path, body) => {
    const noSession = await post(path, body, undefined, '');
    expect(noSession.status).toBe(401);

    const nonAdmin = await post(path, body, undefined, OTHER_ID);
    expect(nonAdmin.status).toBe(403);

    const badOrigin = await post(path, body, undefined, ADMIN_ID, 'https://evil.example');
    expect(badOrigin.status).toBe(403);

    const missingNonce = await post(path, body);
    expect(missingNonce.status).toBe(409);
    expect(provisionCalls).toHaveLength(0);
    expect(pairCalls).toHaveLength(0);
    expect(Object.values(observedCalls).flat()).toHaveLength(0);
  });

  test.each([
    ['/fleet/provision', provisionBody, 'provision'] as const,
    ['/pair', pairBody, 'pair'] as const,
    ['/clawpump/provision', observedProvisionBody, 'provision'] as const,
    ['/clawpump/pair', observedPairBody, 'pair'] as const,
    ['/clawpump/unpair', observedUnpairBody, 'unpair'] as const,
  ])('%s consumes a confirmation nonce once', async (path, body, target) => {
    const confirmationNonce = await nonce();
    expect((await post(path, body, confirmationNonce)).status).toBe(200);
    expect((await post(path, body, confirmationNonce)).status).toBe(409);
    const calls = path.startsWith('/clawpump/') ? observedCalls[target] : target === 'provision' ? provisionCalls : pairCalls;
    expect(calls).toEqual([path === '/fleet/provision'
      ? { ...provisionBody, leaderboardEligible: true, operatedByClawville: true }
      : body]);
  });

  test('lists owned ClawPump agents without a nonce and refuses non-admin access', async () => {
    const response = await app.request('/api/admin/trading/clawpump/agents', { headers: headers() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ agents: [{ clawpumpAgentId: CLAWPUMP_AGENT_ID, pairedAvatarId: AVATAR_ID }] });
    const denied = await app.request('/api/admin/trading/clawpump/agents', { headers: headers(OTHER_ID) });
    expect(denied.status).toBe(403);
    expect(observedCalls.list).toHaveLength(1);
  });

  test.each([
    { ...observedPairBody, walletPubkey: WALLET },
    { ...observedPairBody, clawpumpAgentId: 'genesis' },
  ])('rejects operator wallet input and non-UUID ClawPump identifiers', async (body) => {
    const response = await post('/clawpump/pair', body, await nonce());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_body' });
    expect(observedCalls.pair).toHaveLength(0);
  });

  test.each([
    ['/clawpump/provision', observedProvisionBody] as const,
    ['/clawpump/pair', observedPairBody] as const,
    ['/clawpump/unpair', observedUnpairBody] as const,
  ])('%s preserves service errors and status', async (path, body) => {
    observedError = new MockTradingProvisioningError('clawpump_not_configured', 503, 'ClawPump is not configured.');
    const response = await post(path, body, await nonce());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'ClawPump is not configured.', code: 'clawpump_not_configured' });
  });

  test('the ClawPump list preserves service errors and status', async () => {
    observedError = new MockTradingProvisioningError('clawpump_not_configured', 503, 'ClawPump is not configured.');
    const response = await app.request('/api/admin/trading/clawpump/agents', { headers: headers() });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'ClawPump is not configured.', code: 'clawpump_not_configured' });
  });

  test('provisions an unarmed and killed fleet link with safe defaults', async () => {
    const response = await post('/fleet/provision', provisionBody, await nonce());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      walletPubkey: WALLET,
      armed: false,
      killed: true,
    });
    expect(provisionCalls).toEqual([{
      objective: 'momentum-board',
      traderName: 'MomentumTrader',
      leaderboardEligible: true,
      operatedByClawville: true,
    }]);
  });

  test('rejects an operator-selected false fleet operation flag', async () => {
    const response = await post('/fleet/provision', { ...provisionBody, operatedByClawville: false }, await nonce());
    expect(response.status).toBe(400);
    expect(provisionCalls).toHaveLength(0);
  });

  test('issues a wallet ownership challenge for the paired avatar', async () => {
    const response = await post('/pair/challenge', { avatarId: AVATAR_ID, walletPubkey: WALLET }, await nonce());
    expect(response.status).toBe(200);
    expect(pairChallengeCalls).toEqual([{ avatarId: AVATAR_ID, walletPubkey: WALLET }]);
  });

  test('pairs genesis as an observed agent with no ClawVille operation flag', async () => {
    const response = await post('/pair', pairBody, await nonce());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      subjectKind: 'agent',
      clawpumpAgentId: 'genesis',
      operatedByClawville: false,
    });
    expect(pairCalls).toEqual([pairBody]);
  });

  test('releases only through the explicit operator route', async () => {
    const decisionId = '44444444-4444-4444-8444-444444444444';
    const response = await post('/release-admitted', { decisionId }, await nonce());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, releaseReason: 'operator_never_signed' });
    expect(releaseCalls).toEqual([decisionId]);
  });

  test.each([
    ['slot_occupied', 409, 'provision'] as const,
    ['leaderboard_eligible_non_fleet', 409, 'provision'] as const,
    ['no_bound_clawville_agent', 400, 'pair'] as const,
    ['already_linked', 409, 'pair'] as const,
  ])('returns stable %s failures', async (code, status, target) => {
    const error = new MockTradingProvisioningError(code, status, code);
    if (target === 'provision') provisionError = error;
    else pairError = error;
    const response = target === 'provision'
      ? await post('/fleet/provision', provisionBody, await nonce())
      : await post('/pair', pairBody, await nonce());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });

  test('returns the stable activation code after the service contains an ordinary activation throw', async () => {
    provisionError = new MockTradingProvisioningError(
      'autonomy_activation_failed',
      500,
      'Fleet autonomy activation failed.',
    );
    const response = await post('/fleet/provision', provisionBody, await nonce());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'autonomy_activation_failed' });
  });

  test('rejects malformed observed wallet input before the service', async () => {
    const response = await post('/pair', { ...pairBody, walletPubkey: 'not-base58!' }, await nonce());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_body' });
    expect(pairCalls).toHaveLength(0);
  });

  test('does not translate a database 23505 from the provisioning transaction', async () => {
    provisionError = Object.assign(new Error('unique violation'), { code: '23505' });
    const response = await post('/fleet/provision', provisionBody, await nonce());
    expect(response.status).toBe(500);
  });
});
