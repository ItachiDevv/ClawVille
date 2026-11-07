/**
 * /api/ecosystem/market/:op and /trust/:wallet: who may call, which avatar the
 * read binds to, and the MCP tools. The service is a fake: no live vendor call.
 */
if (!process.env.FINGERPRINT_SECRET) process.env.FINGERPRINT_SECRET = '0'.repeat(64);
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as realAuth from '../../middleware/auth';
import * as realAgentAuth from '../../middleware/require-auth-or-agent';
import * as realGuard from '../../middleware/require-non-guest';
import * as realReads from '../../services/ecosystem-reads';

type Identity = { kind: 'user' | 'agent'; userId: string; avatarId: string; agentId: string | null; ledgerCapable?: boolean; guest?: boolean };
let identity: Identity | null = null;
let budgetExhausted = false;
const marketCalls: Array<{ avatarId: string; input: unknown }> = [];
const trustCalls: Array<{ avatarId: string; wallet: string }> = [];

mock.module('../../middleware/auth', () => ({
  ...realAuth,
  sessionMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module('../../middleware/require-auth-or-agent', () => ({
  ...realAgentAuth,
  requireAuthOrAgentSession: async (c: any, next: () => Promise<void>) => {
    if (!identity) throw new HTTPException(401, { message: 'Authentication required' });
    c.set('identity', identity);
    return next();
  },
}));
mock.module('../../middleware/require-non-guest', () => ({
  ...realGuard,
  requireNonGuestIdentity: async (c: any, next: () => Promise<void>) => {
    if (identity?.guest) return c.json({ code: 'guest_not_allowed' }, 403);
    return next();
  },
}));
const REFUSED = { ok: false, code: 'read_budget_exhausted', httpStatus: 429, message: 'used up' } as const;
mock.module('../../services/ecosystem-reads', () => ({
  ...realReads,
  readEcosystemMarket: async (avatarId: string, input: unknown) => {
    marketCalls.push({ avatarId, input });
    return budgetExhausted ? REFUSED : { ok: true, reply: { vendor: 'clawpump', op: 'macro', assets: [], cached: false, readsUsedToday: 1, readsPerDay: 300 } };
  },
  readEcosystemTrust: async (avatarId: string, wallet: string) => {
    trustCalls.push({ avatarId, wallet });
    return budgetExhausted ? REFUSED : { ok: true, reply: { vendor: 'said', wallet } };
  },
}));

const { ecosystemReadRoutes, resetEcosystemReadRateLimit } = await import('../ecosystem-reads');
const { runMcpTool, answerText } = await import('../../services/agent-mcp-tools');

const app = new Hono();
app.onError((err, c) => c.json({ error: err.message }, err instanceof HTTPException ? err.status : 500));
app.route('/api/ecosystem', ecosystemReadRoutes);

const WALLET = '3Q6QAbCWmqJfXthcXxsxpj2SXvDcmDsJJsevwMgC8BrU';
const AGENT: Identity = { kind: 'agent', userId: 'owner-1', avatarId: 'avatar-of-agent', agentId: 'agent-1', ledgerCapable: true };
const HUMAN: Identity = { kind: 'user', userId: 'user-1', avatarId: 'avatar-of-user', agentId: null };

beforeEach(() => {
  identity = null;
  budgetExhausted = false;
  marketCalls.length = 0;
  trustCalls.length = 0;
  resetEcosystemReadRateLimit();
});

describe('who may read', () => {
  it('a logged-out caller gets 401 and nothing is read', async () => {
    expect((await app.request('/api/ecosystem/market/macro')).status).toBe(401);
    expect((await app.request(`/api/ecosystem/trust/${WALLET}`)).status).toBe(401);
    expect(marketCalls).toHaveLength(0);
    expect(trustCalls).toHaveLength(0);
  });

  it('a guest gets 403 and nothing is read', async () => {
    identity = { ...HUMAN, guest: true };
    const res = await app.request('/api/ecosystem/market/macro');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('guest_not_allowed');
    expect(marketCalls).toHaveLength(0);
  });

  it('a human reads on the avatar of the human', async () => {
    identity = HUMAN;
    const res = await app.request('/api/ecosystem/market/price?mint=abc&limit=3&query=q');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(marketCalls).toEqual([{ avatarId: 'avatar-of-user', input: { op: 'price', mint: 'abc', query: 'q', limit: '3' } }]);
  });

  it('an agent session reads on the avatar of the agent, also without ledger capability', async () => {
    identity = { ...AGENT, ledgerCapable: false };
    expect((await app.request(`/api/ecosystem/trust/${WALLET}`)).status).toBe(200);
    expect(trustCalls).toEqual([{ avatarId: 'avatar-of-agent', wallet: WALLET }]);
  });
});

describe('answers', () => {
  it('an unknown op is 400 before the service', async () => {
    identity = HUMAN;
    const res = await app.request('/api/ecosystem/market/withdraw');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('unknown_op');
    expect(marketCalls).toHaveLength(0);
  });

  it('an exhausted budget is 429 read_budget_exhausted on both routes', async () => {
    identity = HUMAN;
    budgetExhausted = true;
    for (const path of ['/api/ecosystem/market/macro', `/api/ecosystem/trust/${WALLET}`]) {
      const res = await app.request(path);
      expect(res.status).toBe(429);
      expect(((await res.json()) as { code: string }).code).toBe('read_budget_exhausted');
    }
  });

  it('more than 60 reads in one minute per avatar is 429 rate_limited', async () => {
    identity = HUMAN;
    for (let i = 0; i < 60; i++) expect((await app.request('/api/ecosystem/market/macro')).status).toBe(200);
    const res = await app.request('/api/ecosystem/market/macro');
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe('rate_limited');
    identity = AGENT;
    expect((await app.request('/api/ecosystem/market/macro')).status).toBe(200);
  });
});

describe('MCP tools', () => {
  function runtime() {
    const seen: Array<{ method: string; path: string; headers?: Record<string, string> }> = [];
    const rt = {
      session: { sessionId: 'ag-live', agentId: 'agent-1' },
      call: async (call: { method: string; path: string; headers?: Record<string, string> }) => {
        seen.push(call);
        return { status: 200, ok: true, data: { fine: true } };
      },
      isAborted: () => false,
      sleep: async () => {},
      movePoll: { intervalMs: 1, maxMs: 1 },
    };
    return { rt, seen };
  }

  it('clawville_market builds the route with only its own fields', async () => {
    const { rt, seen } = runtime();
    await runMcpTool('clawville_market', { op: 'price', mint: 'abc', avatarId: 'someone-else' }, rt as never);
    await runMcpTool('clawville_market', { op: 'search', query: 'a b&c', limit: 3 }, rt as never);
    await runMcpTool('clawville_market', { op: 'macro' }, rt as never);
    expect(seen.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/ecosystem/market/price?mint=abc',
      'GET /api/ecosystem/market/search?query=a+b%26c&limit=3',
      'GET /api/ecosystem/market/macro',
    ]);
  });

  it('clawville_market refuses an unknown op; clawville_trust encodes the wallet', async () => {
    const { rt, seen } = runtime();
    const bad = JSON.parse(answerText(await runMcpTool('clawville_market', { op: 'withdraw' }, rt as never))) as { error: string };
    expect(bad.error).toBe('invalid_input');
    expect(seen).toHaveLength(0);
    await runMcpTool('clawville_trust', { wallet: 'a/../b' }, rt as never);
    expect(seen[0]!.path).toBe('/api/ecosystem/trust/a%2F..%2Fb');
  });

  it('with no session both tools answer not_connected before any call', async () => {
    const { rt, seen } = runtime();
    const body = JSON.parse(answerText(await runMcpTool('clawville_market', { op: 'macro' }, { ...rt, session: null } as never))) as { error: string };
    expect(body.error).toBe('not_connected');
    expect(seen).toHaveLength(0);
  });
});
