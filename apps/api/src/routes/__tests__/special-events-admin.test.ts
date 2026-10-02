/**
 * Security M3 (2026-09-30) — special-event money commands need a NAMED admin.
 *
 * `/create` sets the seed prize pool and `/start` funds it from the house
 * treasury; `/open` and `/settle` move the event lifecycle. `adminOnly` alone also
 * accepts the static shared `cv_dash` cookie, so ALL FOUR admin mutations now also
 * require a Lucia session whose user id is in ADMIN_USER_IDS (Codex follow-up:
 * every special-event mutation).
 * The seed bound on the create schema is asserted here too.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realAuth from '../../middleware/auth';
import * as realManagerModule from '../../services/special-event-manager';

process.env.FINGERPRINT_SECRET ??= '44'.repeat(32);
process.env.ADMIN_USER_IDS = '11111111-1111-4111-8111-111111111111';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

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

const originalManagerModule = { ...realManagerModule };
let startCalls: string[] = [];
let openCalls: string[] = [];
let settleCalls: string[] = [];
mock.module('../../services/special-event-manager', () => ({
  ...realManagerModule,
  specialEventManager: {
    closeSignupAndStart: async (slug: string) => {
      startCalls.push(slug);
      return { tournamentId: 't-1', seatedCount: 2, status: 'live' };
    },
    openSignup: async (slug: string) => {
      openCalls.push(slug);
      return { slug, status: 'signup_open' };
    },
    settleEvent: async (slug: string) => {
      settleCalls.push(slug);
      return { alreadySettled: false, tournamentId: null, results: [] };
    },
  },
}));

const { specialEventsRouter, createEventSchema } = await import('../special-events');
const { DASH_COOKIE_NAME, expectedDashCookie } = await import('../../middleware/admin-only');
const app = new Hono().route('/api/events', specialEventsRouter);

function post(path: string, opts: { user?: string; dash?: boolean; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.user) headers['x-test-user'] = opts.user;
  if (opts.dash) headers.Cookie = `${DASH_COOKIE_NAME}=${expectedDashCookie()}`;
  return app.request(`/api/events${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    return parsed.error ?? parsed.message ?? text;
  } catch {
    return text;
  }
}

beforeEach(() => {
  startCalls = [];
  openCalls = [];
  settleCalls = [];
});

afterAll(() => {
  intercept = false;
  mock.module('../../services/special-event-manager', () => originalManagerModule);
});

describe('special events — named admin on every admin mutation (security M3)', () => {
  const createBody = { slug: 'launch-champ', name: 'Launch Championship' };
  const mutations = [
    ['/create', createBody] as const,
    ['/launch-champ/open', {}] as const,
    ['/launch-champ/start', {}] as const,
    ['/launch-champ/settle', {}] as const,
  ];

  test.each(mutations)('%s refuses the shared cv_dash cookie without a named admin session', async (path, body) => {
    expect(expectedDashCookie()).not.toBeNull();
    const res = await post(path, { dash: true, body });
    expect(res.status).toBe(403);
    expect(await errorMessage(res)).toContain('named_admin_required');
    // The cookie plus a NON-admin Lucia user is still not a named admin.
    const withUser = await post(path, { dash: true, user: OTHER_ID, body });
    expect(withUser.status).toBe(403);
    expect([...startCalls, ...openCalls, ...settleCalls]).toHaveLength(0);
  });

  test.each(mutations)('%s refuses no auth (401) and a non-admin user (403)', async (path, body) => {
    expect((await post(path, { body })).status).toBe(401);
    expect((await post(path, { user: OTHER_ID, body })).status).toBe(403);
    expect([...startCalls, ...openCalls, ...settleCalls]).toHaveLength(0);
  });

  test('/open, /start and /settle run for a named admin session', async () => {
    expect((await post('/launch-champ/open', { user: ADMIN_ID })).status).toBe(200);
    expect((await post('/launch-champ/start', { user: ADMIN_ID })).status).toBe(200);
    expect((await post('/launch-champ/settle', { user: ADMIN_ID })).status).toBe(200);
    expect(openCalls).toEqual(['launch-champ']);
    expect(startCalls).toEqual(['launch-champ']);
    expect(settleCalls).toEqual(['launch-champ']);
  });
});

describe('special events — create schema bounds seedPrizePoolCt (security M3)', () => {
  const MAX = realManagerModule.SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT;
  const base = { slug: 'bounded', name: 'Bounded' };
  const parse = (prizeConfigJson: unknown) =>
    createEventSchema.safeParse({ ...base, prizeConfigJson });

  test('accepts 0, the max, and a digit string; keeps other prize keys', () => {
    expect(parse({ seedPrizePoolCt: 0 }).success).toBe(true);
    const atMax = parse({ seedPrizePoolCt: MAX, payoutCurve: [{ placement: 1, share: 1 }] });
    expect(atMax.success).toBe(true);
    if (atMax.success) {
      expect(atMax.data.prizeConfigJson?.seedPrizePoolCt).toBe(MAX);
      expect(atMax.data.prizeConfigJson?.payoutCurve).toEqual([{ placement: 1, share: 1 }]);
    }
    const asString = parse({ seedPrizePoolCt: '5000' });
    expect(asString.success && asString.data.prizeConfigJson?.seedPrizePoolCt).toBe(5000);
  });

  test('rejects above the max, negative, fractional, and non-numeric seeds', () => {
    expect(parse({ seedPrizePoolCt: MAX + 1 }).success).toBe(false);
    expect(parse({ seedPrizePoolCt: String(MAX + 1) }).success).toBe(false);
    expect(parse({ seedPrizePoolCt: -1 }).success).toBe(false);
    expect(parse({ seedPrizePoolCt: 1.5 }).success).toBe(false);
    expect(parse({ seedPrizePoolCt: '1e9' }).success).toBe(false);
    expect(parse({ seedPrizePoolCt: { amount: 1 } }).success).toBe(false);
  });
});
