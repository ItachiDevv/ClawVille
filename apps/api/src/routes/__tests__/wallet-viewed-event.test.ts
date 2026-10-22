/**
 * `wallet.viewed` emitter on GET /api/wallet/balances (2026-10-22 quests
 * wire). The `wallet-aware` tutorial quest reads this event. It must log ONCE
 * per avatar (human or agent-bound), and a recording failure must never change
 * the balances response.
 */

const HEX32 = '0'.repeat(64);
if (!process.env.FINGERPRINT_SECRET) process.env.FINGERPRINT_SECRET = HEX32;
const databaseUrlWasSet = !!process.env.DATABASE_URL;
if (!databaseUrlWasSet) process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import * as realDatabase from '@clawville/database';
import * as realAuth from '../../middleware/auth';
import * as realAgentAuth from '../../middleware/require-auth-or-agent';
import * as realEventLogger from '../../services/event-logger';
import * as realExecutor from '../../services/wallet-withdraw-executor';
import * as realNonGuest from '../../middleware/require-non-guest';
import * as realHouseBinding from '../../services/autonomous-cove-agent-binding';

type Middleware = (c: any, next: () => Promise<void>) => unknown;
let intercept = true;
afterAll(() => {
  intercept = false;
});

const realSessionMiddleware = realAuth.sessionMiddleware as Middleware;
const realRequireIdentity = realAgentAuth.requireAuthOrAgentSession as Middleware;
const realLogReturningId = realEventLogger.logEventReturningId;
const realGetBalances = realExecutor.getCustodialWalletBalances;

type Identity =
  | { kind: 'user'; userId: string; avatarId: string; agentId: null }
  | {
      kind: 'agent';
      userId: string;
      avatarId: string;
      agentId: string;
      sessionId: string;
      ledgerCapable: boolean;
    };
const human = (avatarId: string): Identity => ({
  kind: 'user',
  userId: `user-${avatarId}`,
  avatarId,
  agentId: null,
});
/** null = the auth middleware refuses the request. */
let currentIdentity: Identity | null = human('unset');
const guestUserIds = new Set<string>();
const houseAgentIds = new Set<string>();

// A tiny stand-in for the events table: avatarIds that already have a row.
const viewedInDb = new Set<string>();
let dbFails = false;
let dbChecks = 0;
let walletExists = true;

const fakeDb = {
  ...(realDatabase as unknown as { db: Record<string, unknown> }).db,
  execute: async (query: unknown) => {
    dbChecks += 1;
    if (dbFails) throw new Error('db down');
    const params = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
    const avatarId = params.find((p) => typeof p === 'string' && viewedInDb.has(p));
    return avatarId ? [{ one: 1 }] : [];
  },
};
const DELEGATE_DB = (realDatabase as unknown as { db: Record<string, unknown> }).db;
mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: new Proxy(fakeDb, {
    get: (t, p, r) => (intercept ? Reflect.get(t, p, r) : Reflect.get(DELEGATE_DB, p, DELEGATE_DB)),
  }),
}));

const passthrough: Middleware = async (_c, next) => next();
const injectIdentity: Middleware = async (c, next) => {
  if (!currentIdentity) return c.json({ error: 'unauthorized' }, 401);
  c.set('identity', currentIdentity);
  // The global fingerprint middleware's tags: the REST row must keep them.
  c.set('fpHash', 'fp-1');
  c.set('ipPrefixHash', 'ip-1');
  await next();
};
const guarded = (fake: Middleware, real: Middleware): Middleware =>
  (c, next) => (intercept ? fake(c, next) : real(c, next));

mock.module('../../middleware/auth', () => ({
  ...realAuth,
  sessionMiddleware: guarded(passthrough, realSessionMiddleware),
}));
mock.module('../../middleware/require-auth-or-agent', () => ({
  ...realAgentAuth,
  requireAuthOrAgentSession: guarded(injectIdentity, realRequireIdentity),
}));

// The route now calls services/wallet-view-record.ts, which logs via
// logEventReturningId with the route's anti-farm tags.
type LoggedEvent = Parameters<typeof realLogReturningId>[0];
const logged: LoggedEvent[] = [];
let loggerMode: 'ok' | 'throw' | 'null' = 'ok';
mock.module('../../services/event-logger', () => ({
  ...realEventLogger,
  logEventReturningId: (...args: Parameters<typeof realLogReturningId>) => {
    if (!intercept) return realLogReturningId(...args);
    if (loggerMode === 'throw') throw new Error('logger exploded');
    if (loggerMode === 'null') return Promise.resolve(null);
    logged.push(args[0]);
    if (args[0].avatarId) viewedInDb.add(args[0].avatarId);
    return Promise.resolve(BigInt(logged.length));
  },
}));

const realIsGuestUser = realNonGuest.isGuestUser;
mock.module('../../middleware/require-non-guest', () => ({
  ...realNonGuest,
  isGuestUser: (userId: string) =>
    intercept ? Promise.resolve(guestUserIds.has(userId)) : realIsGuestUser(userId),
}));
const realIsHouseAgentId = realHouseBinding.isHouseAgentId;
mock.module('../../services/autonomous-cove-agent-binding', () => ({
  ...realHouseBinding,
  isHouseAgentId: (agentId: string) =>
    intercept ? Promise.resolve(houseAgentIds.has(agentId)) : realIsHouseAgentId(agentId),
}));

const BALANCES = {
  ok: true as const,
  walletAddress: 'Wallet1111111111111111111111111111111111111',
  balances: { SOL: { atomic: '0', ui: '0' } },
};
mock.module('../../services/wallet-withdraw-executor', () => ({
  ...realExecutor,
  getCustodialWalletBalances: (...args: Parameters<typeof realGetBalances>) => {
    if (!intercept) return realGetBalances(...args);
    return Promise.resolve(walletExists ? BALANCES : { ok: false, code: 'wallet_missing' });
  },
}));

const { walletWithdrawRoutes } = await import('../wallet-withdraw');
if (!databaseUrlWasSet) delete process.env.DATABASE_URL;

const app = new Hono().route('/api/wallet', walletWithdrawRoutes);
/** The recorder is fire-and-forget: let its microtasks drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const viewedFor = (avatarId: string) =>
  logged.filter((e) => e.eventType === 'wallet.viewed' && e.avatarId === avatarId);

beforeEach(() => {
  logged.length = 0;
  dbFails = false;
  dbChecks = 0;
  walletExists = true;
  loggerMode = 'ok';
});

// The recorder keeps a module-level Set, so every case uses its own avatarId.
describe('wallet.viewed emitter', () => {
  it('logs wallet.viewed once across two reads by a human', async () => {
    currentIdentity = human('avatar-two-reads');
    const first = await app.request('/api/wallet/balances');
    await settle();
    const second = await app.request('/api/wallet/balances');
    await settle();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(BALANCES);
    expect(viewedFor('avatar-two-reads')).toHaveLength(1);
    expect(viewedFor('avatar-two-reads')[0]?.payload).toEqual({ subjectKind: 'user' });
    expect(viewedFor('avatar-two-reads')[0]?.fpHash).toBe('fp-1');
    expect(viewedFor('avatar-two-reads')[0]?.ipPrefixHash).toBe('ip-1');
    // The second read is served by the in-process Set: no second DB check.
    expect(dbChecks).toBe(1);
  });

  it('logs against the agent session bound avatar', async () => {
    currentIdentity = {
      kind: 'agent',
      userId: 'owner-user',
      avatarId: 'agent-bound-avatar',
      agentId: 'oc-test-agent',
      sessionId: 'session-digest',
      ledgerCapable: true,
    };
    const res = await app.request('/api/wallet/balances');
    await settle();
    expect(res.status).toBe(200);
    const events = viewedFor('agent-bound-avatar');
    expect(events).toHaveLength(1);
    expect(events[0]?.userId).toBe('owner-user');
    expect(events[0]?.payload).toEqual({ subjectKind: 'agent' });
  });

  it('does not log again when the events table already has a row (restart, other pod)', async () => {
    viewedInDb.add('avatar-already-viewed');
    currentIdentity = human('avatar-already-viewed');
    const res = await app.request('/api/wallet/balances');
    await settle();
    expect(res.status).toBe(200);
    expect(dbChecks).toBe(1);
    expect(viewedFor('avatar-already-viewed')).toHaveLength(0);
  });

  it('never fails the read when the logger throws, and retries on a later read', async () => {
    currentIdentity = human('avatar-logger-throws');
    loggerMode = 'throw';
    const res = await app.request('/api/wallet/balances');
    await settle();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BALANCES);
    expect(viewedFor('avatar-logger-throws')).toHaveLength(0);

    loggerMode = 'ok';
    await app.request('/api/wallet/balances');
    await settle();
    expect(viewedFor('avatar-logger-throws')).toHaveLength(1);
  });

  it('never fails the read when the existence check throws', async () => {
    currentIdentity = human('avatar-db-down');
    dbFails = true;
    const res = await app.request('/api/wallet/balances');
    await settle();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BALANCES);
    expect(viewedFor('avatar-db-down')).toHaveLength(0);
  });

  it('retries when the insert fell back to the failure table', async () => {
    currentIdentity = human('avatar-insert-null');
    loggerMode = 'null';
    await app.request('/api/wallet/balances');
    await settle();
    loggerMode = 'ok';
    await app.request('/api/wallet/balances');
    await settle();
    expect(viewedFor('avatar-insert-null')).toHaveLength(1);
    expect(dbChecks).toBe(2);
  });

  it('logs once for an avatar with no custodial wallet (the wallet_missing 404)', async () => {
    currentIdentity = human('avatar-no-wallet');
    walletExists = false;
    const first = await app.request('/api/wallet/balances');
    await settle();
    const second = await app.request('/api/wallet/balances');
    await settle();
    expect(first.status).toBe(404);
    expect(await first.json()).toEqual({ error: 'wallet_missing', code: 'wallet_missing' });
    expect(second.status).toBe(404);
    expect(viewedFor('avatar-no-wallet')).toHaveLength(1);
  });

  it('never logs for a guest', async () => {
    currentIdentity = human('avatar-guest');
    guestUserIds.add('user-avatar-guest');
    const res = await app.request('/api/wallet/balances');
    await settle();
    expect(res.status).toBe(200);
    expect(dbChecks).toBe(0);
    expect(viewedFor('avatar-guest')).toHaveLength(0);
  });

  it('never logs for a server-owned house agent', async () => {
    houseAgentIds.add('house-dealer');
    currentIdentity = {
      kind: 'agent',
      userId: 'house-owner',
      avatarId: 'avatar-house',
      agentId: 'house-dealer',
      sessionId: 'session-digest',
      ledgerCapable: true,
    };
    const res = await app.request('/api/wallet/balances');
    await settle();
    expect(res.status).toBe(200);
    expect(dbChecks).toBe(0);
    expect(viewedFor('avatar-house')).toHaveLength(0);
  });

  it('never logs when authentication fails', async () => {
    currentIdentity = null;
    const res = await app.request('/api/wallet/balances');
    await settle();
    expect(res.status).toBe(401);
    expect(dbChecks).toBe(0);
    expect(logged).toHaveLength(0);
  });
});
