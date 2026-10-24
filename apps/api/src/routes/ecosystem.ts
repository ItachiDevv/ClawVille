/**
 * Public ecosystem MCP catalog (MCP ecosystem hub step 1, 2026-10-23).
 *
 *   GET /api/ecosystem/catalog  ->  { protocolVersion, entries }
 *
 * Read-only, no auth, no DB. `entries` are the `available` rows of the
 * reviewed `ECOSYSTEM_CATALOG` constant (`@clawville/shared`), resolved for
 * this API base. The same rows render the protocol `ecosystem` page. This route
 * never fetches or relays any third-party server.
 */

import { Hono } from 'hono';
import { servedEcosystemCatalog } from '@clawville/shared';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { PROTOCOL_VERSION, resolveApiBase } from '../services/skill-protocol';
import type { AppContext } from '../types';

export const ecosystemRoutes = new Hono<AppContext>();

// Public endpoint: same 60 req/min/IP budget and 429 body as the public
// leaderboard reads, on its own bucket.
const ecosystemCatalogLimiter = createRateLimiter({
  maxPerWindow: 60,
  windowMs: 60_000,
});

/** Test hook: clear the per-IP bucket. */
export function resetEcosystemCatalogRateLimit(): void {
  ecosystemCatalogLimiter.reset();
}

ecosystemRoutes.get('/catalog', (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!ecosystemCatalogLimiter.check(ip)) {
    return c.json(
      { error: 'rate_limited', message: 'Too many requests. Try again shortly.' },
      429,
    );
  }

  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    protocolVersion: PROTOCOL_VERSION,
    entries: servedEcosystemCatalog(resolveApiBase()),
  });
});
