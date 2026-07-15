/**
 * Handler-level regression for the pre-existing authenticated guest cosmetic
 * path. Equip/unequip mutate ownership presentation only; they do not touch the
 * real-CT ledger, so an is_guest Lucia identity must keep receiving 200.
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
const realLogEvent = realEventLogger.logEventFromContext;
const guestIdentity = {
  kind: 'user' as const,
  userId: 'guest-user',
  avatarId: 'guest-avatar',
  ledgerCapable: true,
};

let equippedValue = false;
const fakeDb = {
  ...(realDatabase as unknown as { db: Record<string, unknown> }).db,
  query: {
    ...(realDatabase as unknown as { db: { query: Record<string, unknown> } }).db.query,
    users: { findFirst: async () => ({ isGuest: true }) },
  },
  update: () => ({
    set: (values: { equipped: boolean }) => ({
      where: () => ({
        returning: async () => {
          equippedValue = values.equipped;
          return [{ id: 'skin-1', equipped: values.equipped }];
        },
      }),
    }),
  }),
};
mock.module('@clawville/database', () => ({ ...realDatabase, db: fakeDb }));

const passthrough: Middleware = async (_c, next) => next();
const injectGuest: Middleware = async (c, next) => {
  c.set('identity', guestIdentity);
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
  requireAuthOrAgentSession: guarded(injectGuest, realRequireIdentity),
  requireLedgerCapableIdentity: guarded(passthrough, realRequireLedger),
}));
mock.module('../../services/event-logger', () => ({
  ...realEventLogger,
  logEventFromContext: (...args: Parameters<typeof realLogEvent>) =>
    intercept ? Promise.resolve() : realLogEvent(...args),
}));

const { cosmeticsRoutes } = await import('../cosmetics');
if (!databaseUrlWasSet) delete process.env.DATABASE_URL;

const app = new Hono().route('/api/cosmetics', cosmeticsRoutes);
const SKU_ID = 'a1a1a1a1-0000-4000-8000-000000000001';

beforeEach(() => {
  equippedValue = false;
});

describe('authenticated guest cosmetic equip handler', () => {
  it('equips a cosmetic owned by the guest avatar', async () => {
    const response = await app.request(`/api/cosmetics/${SKU_ID}/equip`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, equipped: true });
    expect(equippedValue).toBe(true);
  });

  it('unequips a cosmetic owned by the guest avatar', async () => {
    equippedValue = true;
    const response = await app.request(`/api/cosmetics/${SKU_ID}/unequip`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, equipped: false });
    expect(equippedValue).toBe(false);
  });
});
