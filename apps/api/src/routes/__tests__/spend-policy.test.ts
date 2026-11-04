/**
 * GET/PUT /api/wallet/spend-policy (MCP hub step 2, phase 1). The human owner
 * writes the rules; the avatar's agent may only read them.
 */

const HEX32 = '0'.repeat(64);
if (!process.env.FINGERPRINT_SECRET) process.env.FINGERPRINT_SECRET = HEX32;
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as realDatabase from '@clawville/database';
import * as realAgentAuth from '../../middleware/require-auth-or-agent';
import * as realSpendPolicy from '../../services/spend-policy';

type Middleware = (c: any, next: () => Promise<void>) => unknown;
const AGENT_HEADER = realAgentAuth.AGENT_SESSION_HEADER;

const activeAvatarByUser = new Map<string, string>();
const agentAvatarBySession = new Map<string, { userId: string; avatarId: string }>();
const writes: Array<{ avatarId: string; userId: string; input: unknown }> = [];

mock.module('../../middleware/auth', () => ({
  sessionMiddleware: (async (c, next) => {
    const userId = c.req.header('x-test-user');
    if (userId) c.set('user', { id: userId });
    return next();
  }) as Middleware,
  requireAuth: (async (c, next) => {
    if (!c.get('user')) throw new HTTPException(401, { message: 'Authentication required' });
    return next();
  }) as Middleware,
}));
mock.module('../../middleware/require-non-guest', () => ({
  requireNonGuestUser: (async (_c, next) => next()) as Middleware,
}));
mock.module('../../middleware/require-auth-or-agent', () => ({
  ...realAgentAuth,
  requireAuthOrAgentSession: (async (c, next) => {
    const user = c.get('user') as { id: string } | undefined;
    if (user) {
      c.set('identity', { kind: 'user', userId: user.id, avatarId: activeAvatarByUser.get(user.id) ?? null, agentId: null });
      return next();
    }
    const session = agentAvatarBySession.get(c.req.header(AGENT_HEADER) ?? '');
    if (!session) throw new HTTPException(401, { message: 'Invalid or expired agent session' });
    c.set('identity', { kind: 'agent', ...session, agentId: 'agent-1', sessionId: 's', ledgerCapable: true });
    return next();
  }) as Middleware,
}));
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: {
    query: {
      avatars: {
        findFirst: async () => {
          const userId = currentUserId;
          const id = userId ? activeAvatarByUser.get(userId) : undefined;
          return id ? { id } : undefined;
        },
      },
    },
  },
}));
mock.module('../../services/spend-policy', () => ({
  ...realSpendPolicy,
  readSpendPolicy: async (avatarId: string) => realSpendPolicy.toSpendPolicyView(
    avatarId === 'avatar-set'
      ? { dailyCapUsdCents: 500, perCallCapUsdCents: 50, allowedVendors: ['studios'], updatedAt: '2026-11-04T00:00:00.000Z' }
      : null,
  ),
  writeSpendPolicy: async (avatarId: string, userId: string, input: realSpendPolicy.SpendPolicyInput) => {
    writes.push({ avatarId, userId, input });
    return realSpendPolicy.toSpendPolicyView({ ...input, updatedAt: '2026-11-04T01:00:00.000Z' });
  },
}));

let currentUserId: string | null = null;
const { spendPolicyRoutes } = await import('../spend-policy');
const app = new Hono();
app.route('/api/wallet/spend-policy', spendPolicyRoutes);
app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  throw err;
});

function call(method: 'GET' | 'PUT', headers: Record<string, string>, body?: unknown) {
  currentUserId = headers['x-test-user'] ?? null;
  return app.request('/api/wallet/spend-policy', {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  writes.length = 0;
  activeAvatarByUser.clear();
  agentAvatarBySession.clear();
  activeAvatarByUser.set('user-new', 'avatar-new');
  activeAvatarByUser.set('user-set', 'avatar-set');
  agentAvatarBySession.set('agent-session', { userId: 'user-set', avatarId: 'avatar-set' });
});

describe('spend policy routes', () => {
  it('reads unset caps as not configured for a new avatar', async () => {
    const res = await call('GET', { 'x-test-user': 'user-new' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dailyCapUsdCents: null,
      perCallCapUsdCents: null,
      allowedVendors: [],
      configured: false,
      updatedAt: null,
    });
  });

  it('lets the avatar agent read its rules', async () => {
    const res = await call('GET', { [AGENT_HEADER]: 'agent-session' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dailyCapUsdCents: 500, perCallCapUsdCents: 50, configured: true });
  });

  it('refuses an agent write with a clear human-only reason', async () => {
    const res = await call('PUT', { [AGENT_HEADER]: 'agent-session' }, {
      dailyCapUsdCents: 100000, perCallCapUsdCents: 100000, allowedVendors: ['studios'],
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'spend_policy_human_only' });
    expect(writes).toHaveLength(0);
  });

  it('refuses an unauthenticated write', async () => {
    const res = await call('PUT', {}, { dailyCapUsdCents: 1, perCallCapUsdCents: 1, allowedVendors: [] });
    expect(res.status).toBe(401);
    expect(writes).toHaveLength(0);
  });

  it('writes the human rules for the human active avatar', async () => {
    const res = await call('PUT', { 'x-test-user': 'user-new' }, {
      dailyCapUsdCents: 200, perCallCapUsdCents: 25, allowedVendors: ['studios', 'studios'],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dailyCapUsdCents: 200, perCallCapUsdCents: 25, configured: true });
    expect(writes).toEqual([{
      avatarId: 'avatar-new',
      userId: 'user-new',
      input: { dailyCapUsdCents: 200, perCallCapUsdCents: 25, allowedVendors: ['studios'] },
    }]);
  });

  it('rejects bad input without a write', async () => {
    for (const body of [
      { dailyCapUsdCents: 10, perCallCapUsdCents: 20, allowedVendors: [] },
      { dailyCapUsdCents: -1, perCallCapUsdCents: null, allowedVendors: [] },
      { dailyCapUsdCents: 1.5, perCallCapUsdCents: null, allowedVendors: [] },
      { dailyCapUsdCents: 100001, perCallCapUsdCents: null, allowedVendors: [] },
      { dailyCapUsdCents: 10, perCallCapUsdCents: 1, allowedVendors: ['unknown-vendor'] },
      { dailyCapUsdCents: 10, perCallCapUsdCents: 1, allowedVendors: [], extra: true },
      null,
    ]) {
      const res = await call('PUT', { 'x-test-user': 'user-new' }, body);
      expect(res.status).toBe(400);
    }
    expect(writes).toHaveLength(0);
  });

  it('refuses a human with no active avatar', async () => {
    const res = await call('PUT', { 'x-test-user': 'user-without-avatar' }, {
      dailyCapUsdCents: 1, perCallCapUsdCents: 1, allowedVendors: [],
    });
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});
