/**
 * LEDGER GATE on the activity queue/party, MoonPay widget, and partner
 * storefront routes (security A12/A13/A14, 2026-09-30).
 *
 * A non-ledger agent session (a restored public session, a guest-owned
 * session, any session that has not proved ownership of its bound avatar)
 * still resolves to the OWNER's avatar through requireAuthOrAgentSession.
 * These routes act for that avatar: a queued match credits real CT and
 * leaderboard points, queue-status hands out the matched room's WS short code,
 * party/me hands out the party invite code, the MoonPay widget signs a funding
 * URL for the owner's custodial wallet, and the storefront settles USDC from
 * the buyer. Each one now chains the REAL requireLedgerCapableIdentity.
 *
 * Proven per route:
 *   - non-ledger agent ⇒ 403 agent_session_not_ledger_authorized, handler never runs;
 *   - ledger-capable agent ⇒ passes the gate (the handler's own validation answers);
 *   - human (Lucia) ⇒ passes the gate unchanged.
 *
 * LIGHT + DETERMINISTIC — no Postgres. requireAuthOrAgentSession is a
 * passthrough injecting the per-test identity and requireNonGuestIdentity a
 * passthrough (it would read users.is_guest); both are leak-guarded and
 * delegate to the real middleware once this file is done. Pass-through cases
 * use inputs the handler rejects before any database or facilitator call.
 */

const HEX32 = '0'.repeat(64);
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
ensureEnv('FINGERPRINT_SECRET', HEX32);
const DB_URL_WAS_SET = !!process.env.DATABASE_URL;
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import * as realAoaMw from '../../middleware/require-auth-or-agent';
import * as realNgMw from '../../middleware/require-non-guest';

// ── LEAK GUARD (bun mock.module is process-global) ─────────────────────────
let intercept = true;
afterAll(() => {
  intercept = false;
});
type Mw = (c: any, next: any) => unknown;
const REAL_requireAoa = realAoaMw.requireAuthOrAgentSession as Mw;
const REAL_requireNonGuestIdentity = realNgMw.requireNonGuestIdentity as Mw;
const REAL_requireNonGuestUser = realNgMw.requireNonGuestUser as Mw;
const guard = (mockFn: Mw, realFn: Mw): Mw => (c, next) => (intercept ? mockFn(c, next) : realFn(c, next));

const LEDGER_AGENT = {
  kind: 'agent' as const,
  userId: 'user-1',
  avatarId: 'avatar-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  ledgerCapable: true,
};
const NON_LEDGER_AGENT = { ...LEDGER_AGENT, ledgerCapable: false };
const HUMAN = { kind: 'user' as const, userId: 'user-1', avatarId: 'avatar-1', agentId: null };
let identity: Record<string, unknown> = LEDGER_AGENT;

const passIdentity: Mw = async (c, next) => {
  (c as { set: (k: string, v: unknown) => void }).set('identity', identity);
  await next();
};
const passthrough: Mw = async (_c, next) => {
  await next();
};
mock.module('../../middleware/require-auth-or-agent', () => ({
  ...realAoaMw,
  requireAuthOrAgentSession: guard(passIdentity, REAL_requireAoa),
}));
mock.module('../../middleware/require-non-guest', () => ({
  ...realNgMw,
  requireNonGuestIdentity: guard(passthrough, REAL_requireNonGuestIdentity),
  requireNonGuestUser: guard(passthrough, REAL_requireNonGuestUser),
}));

const { activitiesV2Routes } = await import('../activities');
const { moonpayRoutes } = await import('../moonpay');
const { partnerStorefrontRoutes } = await import('../partner-storefront');
if (!DB_URL_WAS_SET) delete process.env.DATABASE_URL;

const app = new Hono();
app.route('/api/activities', activitiesV2Routes);
app.route('/api/moonpay', moonpayRoutes);
app.route('/api/partner/storefront', partnerStorefrontRoutes);

beforeEach(() => {
  identity = LEDGER_AGENT;
});

type Probe = {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  body?: string;
  /** The handler's own answer once the gate lets the caller through. */
  passStatus: number;
};

const NON_UUID = 'not-a-uuid';
const PROBES: Probe[] = [
  // A12 — activity queue + party. Unknown activity ids and malformed params are
  // answered by the handlers before any queue or database work.
  { name: 'POST /api/activities/:id/queue', method: 'POST', path: '/api/activities/no-such-activity/queue', body: '{}', passStatus: 404 },
  { name: 'POST /api/activities/:id/leave-queue', method: 'POST', path: '/api/activities/no-such-activity/leave-queue', passStatus: 404 },
  { name: 'GET /api/activities/:id/queue-status', method: 'GET', path: '/api/activities/no-such-activity/queue-status', passStatus: 404 },
  { name: 'GET /api/activities/party/me', method: 'GET', path: '/api/activities/party/me', passStatus: 200 },
  { name: 'POST /api/activities/party', method: 'POST', path: '/api/activities/party', body: '[]', passStatus: 400 },
  { name: 'POST /api/activities/party/:shortCode/join', method: 'POST', path: '/api/activities/party/BAD/join', passStatus: 400 },
  { name: 'POST /api/activities/party/:partyId/kick', method: 'POST', path: `/api/activities/party/${NON_UUID}/kick`, body: '{}', passStatus: 400 },
  { name: 'POST /api/activities/party/:partyId/leave', method: 'POST', path: `/api/activities/party/${NON_UUID}/leave`, passStatus: 400 },
  // A13 — MoonPay widget URL: malformed JSON is rejected before the wallet lookup.
  { name: 'POST /api/moonpay/widget-url', method: 'POST', path: '/api/moonpay/widget-url', body: '{not json', passStatus: 400 },
  // A14 — partner storefront: invalid body / missing Idempotency-Key are
  // rejected before the storefront lookup or any facilitator call.
  { name: 'POST /api/partner/storefront/quote', method: 'POST', path: '/api/partner/storefront/quote', body: '{}', passStatus: 400 },
  { name: 'POST /api/partner/storefront/settle', method: 'POST', path: '/api/partner/storefront/settle', body: '{}', passStatus: 400 },
];

async function send(probe: Probe) {
  return app.request(probe.path, {
    method: probe.method,
    headers: probe.body === undefined ? {} : { 'content-type': 'application/json' },
    body: probe.body,
  });
}

describe('value-route ledger gate (security A12/A13/A14)', () => {
  for (const probe of PROBES) {
    describe(probe.name, () => {
      it('non-ledger agent session ⇒ 403 agent_session_not_ledger_authorized', async () => {
        identity = NON_LEDGER_AGENT;
        const res = await send(probe);
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('agent_session_not_ledger_authorized');
      });

      it('ledger-capable agent session passes the gate', async () => {
        identity = LEDGER_AGENT;
        const res = await send(probe);
        expect(res.status).toBe(probe.passStatus);
        expect(await res.text()).not.toContain('agent_session_not_ledger_authorized');
      });

      it('human session passes the gate unchanged', async () => {
        identity = HUMAN;
        const res = await send(probe);
        expect(res.status).toBe(probe.passStatus);
        expect(await res.text()).not.toContain('agent_session_not_ledger_authorized');
      });
    });
  }

  it('GET /api/activities/party/me returns the caller party to a ledger-capable agent', async () => {
    identity = LEDGER_AGENT;
    const res = await app.request('/api/activities/party/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, party: null });
  });
});
