/**
 * Security M3 (2026-09-30) — special-event money commands need a NAMED admin.
 *
 * `/create` sets the seed prize pool and `/start` funds it from the house
 * treasury; `/open` and `/settle` move the event lifecycle. `adminOnly` alone also
 * accepts the static shared `cv_dash` cookie, so ALL admin mutations (cancel too,
 * 2026-10-03: it credits refunds) now also
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
const SIGNUP_ID = '33333333-3333-4333-8333-333333333333';
const GOOD_SIG = '5'.repeat(88);
const REUSED_SIG = '4'.repeat(88);
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
let cancelCalls: string[] = [];
let solListCalls: string[] = [];
let paidCalls: Array<{ slug: string; signupId: string; txSignature: string; adminUserId: string | null }> = [];
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
    cancelEvent: async (slug: string) => {
      cancelCalls.push(slug);
      if (slug === 'already-live') {
        throw new realManagerModule.SpecialEventError('event_already_started', 409);
      }
      return {
        alreadyCancelled: false,
        status: 'cancelled',
        refundedSignups: 1,
        refundedCt: 50,
        solRefundsOwed: [],
      };
    },
    listSolRefunds: async (slug: string) => {
      solListCalls.push(slug);
      return { eventId: 'e-1', eventStatus: 'cancelled', owed: [], refunded: [], owedLamports: '0' };
    },
    markSolRefundPaid: async (
      slug: string,
      signupId: string,
      txSignature: string,
      adminUserId: string | null,
    ) => {
      paidCalls.push({ slug, signupId, txSignature, adminUserId });
      if (txSignature === REUSED_SIG) {
        throw new realManagerModule.SpecialEventError('refund_tx_reused', 409);
      }
      return { signupId, status: 'refunded', refundTxSig: txSignature };
    },
  },
}));

const { specialEventsRouter, createEventSchema } = await import('../special-events');
const { DASH_COOKIE_NAME, expectedDashCookie } = await import('../../middleware/admin-only');
const app = new Hono().route('/api/events', specialEventsRouter);

function post(
  path: string,
  opts: { user?: string; dash?: boolean; body?: unknown; method?: 'GET' | 'POST' } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.user) headers['x-test-user'] = opts.user;
  if (opts.dash) headers.Cookie = `${DASH_COOKIE_NAME}=${expectedDashCookie()}`;
  const method = opts.method ?? 'POST';
  return app.request(`/api/events${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
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
  cancelCalls = [];
  solListCalls = [];
  paidCalls = [];
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
    ['/launch-champ/cancel', {}] as const,
    [`/launch-champ/sol-refunds/${SIGNUP_ID}/paid`, { txSignature: GOOD_SIG }] as const,
  ];
  const allCalls = () => [
    ...startCalls,
    ...openCalls,
    ...settleCalls,
    ...cancelCalls,
    ...solListCalls,
    ...paidCalls,
  ];

  test.each(mutations)('%s refuses the shared cv_dash cookie without a named admin session', async (path, body) => {
    expect(expectedDashCookie()).not.toBeNull();
    const res = await post(path, { dash: true, body });
    expect(res.status).toBe(403);
    expect(await errorMessage(res)).toContain('named_admin_required');
    // The cookie plus a NON-admin Lucia user is still not a named admin.
    const withUser = await post(path, { dash: true, user: OTHER_ID, body });
    expect(withUser.status).toBe(403);
    expect(allCalls()).toHaveLength(0);
  });

  test.each(mutations)('%s refuses no auth (401) and a non-admin user (403)', async (path, body) => {
    expect((await post(path, { body })).status).toBe(401);
    expect((await post(path, { user: OTHER_ID, body })).status).toBe(403);
    expect(allCalls()).toHaveLength(0);
  });

  test('GET /:slug/sol-refunds needs the same named admin (401 / 403 / cv_dash 403)', async () => {
    const path = '/launch-champ/sol-refunds';
    expect((await post(path, { method: 'GET' })).status).toBe(401);
    expect((await post(path, { method: 'GET', user: OTHER_ID })).status).toBe(403);
    expect((await post(path, { method: 'GET', dash: true })).status).toBe(403);
    expect(allCalls()).toHaveLength(0);
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

describe('special events — POST /:slug/cancel (security pass gap, 2026-10-03)', () => {
  test('a named admin cancels and gets the refund summary', async () => {
    const res = await post('/launch-champ/cancel', { user: ADMIN_ID });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: 'cancelled', refundedSignups: 1, refundedCt: 50 });
    expect(cancelCalls).toEqual(['launch-champ']);
  });

  test('a manager refusal maps to its HTTP status and error code', async () => {
    const res = await post('/already-live/cancel', { user: ADMIN_ID });
    expect(res.status).toBe(409);
    expect(await errorMessage(res)).toContain('event_already_started');
  });
});

describe('special events — SOL refund routes (Codex r1, 2026-10-03)', () => {
  test('a named admin lists SOL refunds', async () => {
    const res = await post('/launch-champ/sol-refunds', { method: 'GET', user: ADMIN_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, owed: [], refunded: [], owedLamports: '0' });
    expect(solListCalls).toEqual(['launch-champ']);
  });

  test('a named admin records a payout; the admin user id is passed through', async () => {
    const res = await post(`/launch-champ/sol-refunds/${SIGNUP_ID}/paid`, {
      user: ADMIN_ID,
      body: { txSignature: GOOD_SIG },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, refund: { status: 'refunded', refundTxSig: GOOD_SIG } });
    expect(paidCalls).toEqual([
      { slug: 'launch-champ', signupId: SIGNUP_ID, txSignature: GOOD_SIG, adminUserId: ADMIN_ID },
    ]);
  });

  test('a bad signature or signup id is a 400 before the manager runs', async () => {
    for (const body of [{}, { txSignature: 'short' }, { txSignature: '0'.repeat(88) }]) {
      const res = await post(`/launch-champ/sol-refunds/${SIGNUP_ID}/paid`, { user: ADMIN_ID, body });
      expect(res.status).toBe(400);
    }
    const badId = await post('/launch-champ/sol-refunds/not-a-uuid/paid', {
      user: ADMIN_ID,
      body: { txSignature: GOOD_SIG },
    });
    expect(badId.status).toBe(400);
    expect(paidCalls).toHaveLength(0);
  });

  test('a manager refusal maps to its HTTP status and code', async () => {
    const res = await post(`/launch-champ/sol-refunds/${SIGNUP_ID}/paid`, {
      user: ADMIN_ID,
      body: { txSignature: REUSED_SIG },
    });
    expect(res.status).toBe(409);
    expect(await errorMessage(res)).toContain('refund_tx_reused');
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
