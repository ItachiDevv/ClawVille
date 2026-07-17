/**
 * partner-storefront routing-integrity + gate-predicate tests (Phase D).
 *
 * LIGHT + DETERMINISTIC — no real Postgres, no network, no auth round-trip. We
 * prove the three things that DON'T need a DB:
 *
 *   (a) ROUTING INTEGRITY — the NEW `/api/partner/storefront` mount does NOT
 *       shadow the LIVE `/api/partner/hatcher/*` partner surface (they are
 *       distinct bases; a request to a hatcher path hits the hatcher router,
 *       proving the additive mount order is safe — the protected-surface rule).
 *   (b) UNSIGNED REGISTER → 401 — `POST /register` with NO partner signature is
 *       rejected before any DB touch (the ed25519 verify short-circuits on the
 *       missing headers).
 *   (c) ADMIN FLIP IS ADMIN-GATED → 401 — `POST /admin/fulfillment` with no
 *       admin credential is rejected (a partner key can NEVER flip the gate).
 *   (d) THE GATE PREDICATE — `isStorefrontFulfillmentGated` is true for every
 *       not-yet-enabled storefront (the exact predicate /quote + /settle 503 on).
 *
 * The FULL 503 `partner_fulfillment_gated` HTTP path (which needs a real
 * storefront row + a resolved buyer identity, i.e. a DB + agent session) is
 * exercised by the lead's mock-Hatcher harness on staging — see
 * apps/api/scripts/hatcher/run-mock-e2e.md. Here we assert the predicate directly
 * so the gate logic itself is regression-covered without a DB.
 */

// ---------------------------------------------------------------------------
// Env (crash-loud module-load requirements) BEFORE imports. The route pulls
// require-auth-or-agent → npc-simulation and friends, whose transitive chain
// crash-loads without these (mirrors partner-hatcher-p5-handler.test.ts).
// ALLOW_TEST_PARTNER_PUBKEY is deliberately UNSET so partner-signature.ts does
// not require a staging env.
// ---------------------------------------------------------------------------
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

import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { partnerStorefrontRoutes, isStorefrontFulfillmentGated } from '../partner-storefront';

// Route chain loaded — drop the module-init DATABASE_URL placeholder so later
// DB-gated suites in the shared bun process (quest race guards etc.) keep their
// skip-when-no-DB behavior instead of dialing a fake localhost URL.
if (!DB_URL_WAS_SET) delete process.env.DATABASE_URL;

/**
 * Build the MINIMAL app in the DOCUMENTED index.ts mount order: a stub
 * `/api/partner/hatcher` router first, then the real storefront router. The stub
 * returns a sentinel so we can prove a hatcher path resolves to the hatcher
 * router (not shadowed by the storefront mount).
 */
function buildApp() {
  const app = new Hono();
  const hatcherStub = new Hono();
  hatcherStub.post('/agents', (c) => c.json({ hit: 'hatcher-stub' }, 200));
  app.route('/api/partner/hatcher', hatcherStub);
  app.route('/api/partner/storefront', partnerStorefrontRoutes);
  return app;
}

describe('partner-storefront — routing integrity + gate', () => {
  it('(a) does NOT shadow the live /api/partner/hatcher surface', async () => {
    const app = buildApp();
    const res = await app.request('/api/partner/hatcher/agents', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hit: 'hatcher-stub' });
  });

  it('(b) POST /register with NO partner signature → 401 unauthorized (no DB touch)', async () => {
    const app = buildApp();
    const res = await app.request('/api/partner/storefront/register', {
      method: 'POST',
      body: JSON.stringify({ slug: 'acme-store', displayName: 'Acme', payoutPubkey: 'x'.repeat(43) }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { code?: string };
    expect(json.code).toBe('unauthorized');
  });

  it('(c) POST /admin/fulfillment with no admin credential → 401 (partner key can never flip the gate)', async () => {
    const app = buildApp();
    const res = await app.request('/api/partner/storefront/admin/fulfillment', {
      method: 'POST',
      body: JSON.stringify({ slug: 'acme-store', enabled: true }),
      headers: { 'content-type': 'application/json' },
    });
    // adminOnly throws HTTPException(401) before any handler / DB — Hono maps it.
    expect(res.status).toBe(401);
  });

  it('(d) the gate predicate is true for every not-yet-enabled storefront', () => {
    // Schema default: fulfillment_enabled=false, status='pending' → gated.
    expect(isStorefrontFulfillmentGated({ fulfillmentEnabled: false, status: 'pending' })).toBe(true);
    // Enabled but not active (suspended) → still gated.
    expect(isStorefrontFulfillmentGated({ fulfillmentEnabled: true, status: 'suspended' })).toBe(true);
    // Active but fulfillment not enabled → gated.
    expect(isStorefrontFulfillmentGated({ fulfillmentEnabled: false, status: 'active' })).toBe(true);
    // ONLY enabled AND active is un-gated (the admin-flip end state).
    expect(isStorefrontFulfillmentGated({ fulfillmentEnabled: true, status: 'active' })).toBe(false);
  });
});
