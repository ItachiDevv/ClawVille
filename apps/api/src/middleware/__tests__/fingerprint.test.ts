/**
 * Cove prod hotfix (2026-06-21) — fingerprint middleware stability tests.
 *
 * Regression guard for the "won 20 CT, no history" + "session not found" cove
 * bugs whose dominant browser-player mechanism was an UNSTABLE guest fpHash:
 *
 *   - Before the fix, the tier-2 fallback keyed on the RAW FULL client IP
 *     (`ua:<UA>:ip:<full ip>`), so a residential guest whose egress IP churned
 *     (DHCP renew / mobile-CGNAT / VPN toggle) got a DIFFERENT fpHash between
 *     writing a cove spin event and later reading history — orphaning the row.
 *
 *   - The fix keys tier-2 on the /24 IP PREFIX (`ua:<UA>:ip:<prefix>`) so a
 *     single dynamic-IP guest stays in ONE bucket across IP churn within their
 *     ISP block. The browser clients ALSO now send `X-CV-Fingerprint` (tier-1,
 *     fully IP-independent) — these tests pin both tiers.
 *
 * FINGERPRINT_SECRET is required at module load (the middleware throws without
 * it), so we set a deterministic one before importing.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import type { AppContext } from '../../types';
import type { MiddlewareHandler } from 'hono';

// FINGERPRINT_SECRET must be set BEFORE the middleware module is evaluated
// (it throws at module load without it). Static `import` is hoisted above any
// top-level `process.env =` statement, so we set the env here and DYNAMICALLY
// import the middleware inside beforeAll instead.
process.env.FINGERPRINT_SECRET =
  process.env.FINGERPRINT_SECRET ?? 'a'.repeat(64);

let fingerprintMiddleware: MiddlewareHandler<AppContext>;

/**
 * Build a tiny app that runs the real fingerprintMiddleware and echoes the
 * resolved fpHash so a test can assert stability across header permutations.
 */
function buildApp() {
  const app = new Hono<AppContext>();
  app.use('*', fingerprintMiddleware);
  app.get('/echo', (c) =>
    c.json({ fpHash: c.get('fpHash'), ipPrefixHash: c.get('ipPrefixHash') }),
  );
  return app;
}

async function fpFor(
  app: ReturnType<typeof buildApp>,
  headers: Record<string, string>,
): Promise<string> {
  const res = await app.request('/echo', { headers });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { fpHash: string };
  return body.fpHash;
}

describe('fingerprintMiddleware — guest fpHash stability (cove hotfix 2026-06-21)', () => {
  let app: ReturnType<typeof buildApp>;
  beforeAll(async () => {
    ({ fingerprintMiddleware } = await import('../fingerprint'));
    app = buildApp();
  });

  const UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Safari/537.36';

  it('tier-2 fallback is STABLE across IP changes within the same /24 (the fix)', async () => {
    // Same UA, no X-CV-Fingerprint, two different IPs in the SAME /24 block —
    // the exact dynamic-IP-guest scenario. Must hash to the SAME bucket.
    const a = await fpFor(app, { 'User-Agent': UA, 'cf-connecting-ip': '203.0.113.7' });
    const b = await fpFor(app, { 'User-Agent': UA, 'cf-connecting-ip': '203.0.113.222' });
    expect(a).toBe(b);
  });

  it('tier-2 fallback STILL separates different /24 blocks', async () => {
    // A different ISP block (different /24) must still produce a different
    // bucket — the fix widens collisions only WITHIN a /24, not across blocks.
    const a = await fpFor(app, { 'User-Agent': UA, 'cf-connecting-ip': '203.0.113.7' });
    const c = await fpFor(app, { 'User-Agent': UA, 'cf-connecting-ip': '198.51.100.7' });
    expect(a).not.toBe(c);
  });

  it('tier-1 (X-CV-Fingerprint) is FULLY IP-independent', async () => {
    // When the browser sends the stable fingerprint, the resolved fpHash must
    // not depend on the IP at all — this is what the cove slots/history clients
    // now rely on so a guest spin event and a later history read key identically.
    const fp = 'stable-browser-visitor-id-abc123';
    const a = await fpFor(app, {
      'User-Agent': UA,
      'X-CV-Fingerprint': fp,
      'cf-connecting-ip': '203.0.113.7',
    });
    const b = await fpFor(app, {
      'User-Agent': 'a-totally-different-ua',
      'X-CV-Fingerprint': fp,
      'cf-connecting-ip': '198.51.100.250',
    });
    expect(a).toBe(b);
  });

  it('tier-1 differs from tier-2 for the same caller (header presence matters)', async () => {
    // Sanity: a request WITH the fingerprint header hashes differently than the
    // same request WITHOUT it (so the header is actually consulted).
    const withFp = await fpFor(app, {
      'User-Agent': UA,
      'X-CV-Fingerprint': 'stable-browser-visitor-id-abc123',
      'cf-connecting-ip': '203.0.113.7',
    });
    const withoutFp = await fpFor(app, { 'User-Agent': UA, 'cf-connecting-ip': '203.0.113.7' });
    expect(withFp).not.toBe(withoutFp);
  });
});
