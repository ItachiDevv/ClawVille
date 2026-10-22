/**
 * `cosmetic.equipped` emitter (2026-10-22 quests wire). The `style-statement`
 * and `inventory-in-action` tutorial quests read this event, so an equip must
 * log it ONCE against the caller's bound avatar for a human AND for an agent
 * session, and an unequip must never log it.
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

type Middleware = (c: any, next: () => Promise<void>) => unknown;
let intercept = true;
afterAll(() => {
  intercept = false;
});

const realSessionMiddleware = realAuth.sessionMiddleware as Middleware;
const realRequireIdentity = realAgentAuth.requireAuthOrAgentSession as Middleware;
const realRequireLedger = realAgentAuth.requireLedgerCapableIdentity as Middleware;
const realLogEvent = realEventLogger.logEvent;

const humanIdentity = {
  kind: 'user' as const,
  userId: 'human-user',
  avatarId: 'human-avatar',
  agentId: null,
};
const agentIdentity = {
  kind: 'agent' as const,
  userId: 'owner-user',
  avatarId: 'agent-bound-avatar',
  agentId: 'oc-test-agent',
  sessionId: 'session-digest',
  ledgerCapable: true,
};
let currentIdentity: typeof humanIdentity | typeof agentIdentity = humanIdentity;
let ownsSku = true;

const fakeDb = {
  ...(realDatabase as unknown as { db: Record<string, unknown> }).db,
  update: () => ({
    set: (values: { equipped: boolean }) => ({
      where: () => ({
        returning: async () => (ownsSku ? [{ id: 'skin-1', equipped: values.equipped }] : []),
      }),
    }),
  }),
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
  requireLedgerCapableIdentity: guarded(passthrough, realRequireLedger),
}));

// The route now calls services/cosmetic-actions.ts, which logs via logEvent.
type LoggedEvent = Parameters<typeof realLogEvent>[0];
const logged: LoggedEvent[] = [];
mock.module('../../services/event-logger', () => ({
  ...realEventLogger,
  logEvent: (...args: Parameters<typeof realLogEvent>) => {
    if (!intercept) return realLogEvent(...args);
    logged.push(args[0]);
    return Promise.resolve();
  },
}));

const { cosmeticsRoutes } = await import('../cosmetics');
if (!databaseUrlWasSet) delete process.env.DATABASE_URL;

const app = new Hono().route('/api/cosmetics', cosmeticsRoutes);
const SKU_ID = 'a1a1a1a1-0000-4000-8000-000000000001';

beforeEach(() => {
  logged.length = 0;
  ownsSku = true;
  currentIdentity = humanIdentity;
});

const equippedEvents = () => logged.filter((e) => e.eventType === 'cosmetic.equipped');

describe('cosmetic.equipped emitter', () => {
  it('logs one cosmetic.equipped against a human avatar', async () => {
    const res = await app.request(`/api/cosmetics/${SKU_ID}/equip`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(equippedEvents()).toHaveLength(1);
    const [event] = equippedEvents();
    expect(event?.userId).toBe('human-user');
    expect(event?.avatarId).toBe('human-avatar');
    expect(event?.payload).toMatchObject({ skuId: SKU_ID, subjectKind: 'user' });
    // REST rows keep the request's anti-farm tags (what logEventFromContext did).
    expect(event?.fpHash).toBe('fp-1');
    expect(event?.ipPrefixHash).toBe('ip-1');
  });

  it('logs one cosmetic.equipped against the agent session bound avatar', async () => {
    currentIdentity = agentIdentity;
    const res = await app.request(`/api/cosmetics/${SKU_ID}/equip`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(equippedEvents()).toHaveLength(1);
    const [event] = equippedEvents();
    expect(event?.userId).toBe('owner-user');
    expect(event?.avatarId).toBe('agent-bound-avatar');
    expect(event?.payload).toMatchObject({ skuId: SKU_ID, subjectKind: 'agent' });
  });

  it('never logs cosmetic.equipped on an unequip', async () => {
    const res = await app.request(`/api/cosmetics/${SKU_ID}/unequip`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(equippedEvents()).toHaveLength(0);
    expect(logged.map((e) => e.eventType)).toEqual(['cosmetic.unequipped']);
  });

  it('logs nothing when the avatar does not own the SKU', async () => {
    ownsSku = false;
    const res = await app.request(`/api/cosmetics/${SKU_ID}/equip`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'not_owned',
      message: 'You do not own this cosmetic.',
    });
    expect(logged).toHaveLength(0);
  });

  it('answers 400 for a malformed skuId and logs nothing', async () => {
    const res = await app.request('/api/cosmetics/not-a-uuid/equip', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(logged).toHaveLength(0);
  });
});
