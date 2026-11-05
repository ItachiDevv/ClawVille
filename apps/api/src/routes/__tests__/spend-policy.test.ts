/**
 * GET/PUT /api/wallet/spend-policy (MCP hub step 2, phase 1). The human owner
 * writes the rules; the avatar's agent may only read them.
 *
 * The REAL `middleware/auth.ts` and `middleware/require-non-guest.ts` run here.
 * Only Lucia's session store, the agent-session resolver and the database are
 * stubbed, so the human-only gates (agent header, session origin, guest) are
 * exercised as written.
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

type FakeSession = { userId: string; createdVia: string | null };
const sessions = new Map<string, FakeSession>();
const guests = new Set<string>();
const activeAvatarByUser = new Map<string, string>();
const agentAvatarBySession = new Map<string, { userId: string; avatarId: string }>();
const writes: Array<{ avatarId: string; userId: string; input: unknown }> = [];
let lastFindUserId: string | null = null;

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
    c.set('identity', { kind: 'agent', ...session, agentId: 'agent-1', sessionId: 's', ledgerCapable: true });
    return next();
  }) as Middleware,
}));
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: {
    query: {
      users: {
        findFirst: async () => ({ isGuest: lastFindUserId !== null && guests.has(lastFindUserId) }),
      },
      avatars: {
        findFirst: async () => {
          const id = lastFindUserId ? activeAvatarByUser.get(lastFindUserId) : undefined;
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

const { spendPolicyRoutes } = await import('../spend-policy');
const app = new Hono();
app.route('/api/wallet/spend-policy', spendPolicyRoutes);
app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  throw err;
});

const VALID = { dailyCapUsdCents: 200, perCallCapUsdCents: 25, allowedVendors: ['studios', 'studios'] };

function call(method: 'GET' | 'PUT', opts: { cookie?: string; agent?: string; body?: unknown }) {
  lastFindUserId = opts.cookie ? sessions.get(opts.cookie)?.userId ?? null : null;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = `auth_session=${opts.cookie}`;
  if (opts.agent) headers[AGENT_HEADER] = opts.agent;
  return app.request('/api/wallet/spend-policy', {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
}

beforeEach(() => {
  writes.length = 0;
  sessions.clear();
  guests.clear();
  activeAvatarByUser.clear();
  agentAvatarBySession.clear();
  activeAvatarByUser.set('user-new', 'avatar-new');
  activeAvatarByUser.set('user-set', 'avatar-set');
  activeAvatarByUser.set('user-guest', 'avatar-guest');
  guests.add('user-guest');
  sessions.set('pw-new', { userId: 'user-new', createdVia: 'password' });
  sessions.set('link-new', { userId: 'user-new', createdVia: 'magic_link' });
  sessions.set('created-new', { userId: 'user-new', createdVia: 'avatar_create' });
  sessions.set('exchanged-set', { userId: 'user-set', createdVia: 'agent_exchange' });
  sessions.set('legacy-new', { userId: 'user-new', createdVia: null });
  sessions.set('guest-session', { userId: 'user-guest', createdVia: 'guest' });
  sessions.set('guest-pw', { userId: 'user-guest', createdVia: 'password' });
  sessions.set('pw-noavatar', { userId: 'user-without-avatar', createdVia: 'password' });
  agentAvatarBySession.set('agent-session', { userId: 'user-set', avatarId: 'avatar-set' });
});

describe('GET /api/wallet/spend-policy', () => {
  it('reads unset caps as not configured for a new avatar', async () => {
    const res = await call('GET', { cookie: 'pw-new' });
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
    const res = await call('GET', { agent: 'agent-session' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dailyCapUsdCents: 500, perCallCapUsdCents: 50, configured: true });
  });
});

describe('PUT /api/wallet/spend-policy', () => {
  it('writes the rules for a human sign-in, for the human active avatar', async () => {
    for (const cookie of ['pw-new', 'link-new', 'created-new']) {
      const res = await call('PUT', { cookie, body: VALID });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ dailyCapUsdCents: 200, perCallCapUsdCents: 25, configured: true });
    }
    expect(writes).toHaveLength(3);
    expect(writes[0]).toEqual({
      avatarId: 'avatar-new',
      userId: 'user-new',
      input: { dailyCapUsdCents: 200, perCallCapUsdCents: 25, allowedVendors: ['studios'] },
    });
  });

  it('refuses an agent header alone, and an agent header next to a human cookie', async () => {
    for (const opts of [{ agent: 'agent-session' }, { agent: 'agent-session', cookie: 'pw-new' }]) {
      const res = await call('PUT', { ...opts, body: VALID });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'spend_policy_human_only', code: 'spend_policy_human_only' });
    }
    expect(writes).toHaveLength(0);
  });

  it('refuses a cookie that an agent got through the session exchange', async () => {
    const res = await call('PUT', { cookie: 'exchanged-set', body: VALID });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'spend_policy_human_only', code: 'spend_policy_human_only' });
    expect(writes).toHaveLength(0);
  });

  it('asks a pre-0089 or guest session to sign in again', async () => {
    for (const cookie of ['legacy-new', 'guest-session']) {
      const res = await call('PUT', { cookie, body: VALID });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'spend_policy_needs_human_login', code: 'spend_policy_needs_human_login' });
    }
    expect(writes).toHaveLength(0);
  });

  it('refuses a guest account even with a password session', async () => {
    const res = await call('PUT', { cookie: 'guest-pw', body: VALID });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'guest_not_allowed' });
    expect(writes).toHaveLength(0);
  });

  it('refuses no session, and an unknown session', async () => {
    expect((await call('PUT', { body: VALID })).status).toBe(401);
    expect((await call('PUT', { cookie: 'unknown', body: VALID })).status).toBe(401);
    expect(writes).toHaveLength(0);
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
      const res = await call('PUT', { cookie: 'pw-new', body });
      expect(res.status).toBe(400);
    }
    expect(writes).toHaveLength(0);
  });

  it('refuses a human with no active avatar', async () => {
    const res = await call('PUT', { cookie: 'pw-noavatar', body: VALID });
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});
