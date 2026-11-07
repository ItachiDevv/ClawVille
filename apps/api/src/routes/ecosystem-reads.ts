/**
 * Market and trust reads through ClawVille (MCP hub, 2026-11-07, migration 0098).
 *
 *   GET /api/ecosystem/market/:op  op = price (?mint=), search (?query=&limit=),
 *       top_movers (?limit=), anomalies (?limit=), macro. ClawPump, on
 *       ClawVille's own key.
 *   GET /api/ecosystem/trust/:wallet  SAID free trust check.
 *
 * Each answer has `cached`, `readsUsedToday` and `readsPerDay`. A vendor call
 * costs one unit of the avatar's daily budget (429 `read_budget_exhausted`
 * when it is used up); a reply from the shared cache costs none.
 *
 * Mounted next to the public `ecosystem.ts` on one prefix. Every route carries
 * its own middleware, so `/catalog` stays public, cacheable and DB-free.
 *
 * PARITY (Rule E5): human path = these routes with a Lucia session (wallet
 * panel, "Token and wallet check" card); agent path = the same routes with the
 * agent session header, and the MCP tools `clawville_market` and
 * `clawville_trust`. The budget binds to the resolved avatar. A guest (or an
 * agent of a guest) gets 403; a logged-out caller gets 401. No hosted [ACTION:]
 * verb: vendor text must not enter a decide prompt.
 */

import { Hono } from 'hono';
import { ECOSYSTEM_MARKET_OPS, type EcosystemMarketOp } from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import { noStorePrivate } from '../middleware/no-store';
import { createRateLimiter } from '../middleware/rate-limit';
import { requireAuthOrAgentSession, type ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { readEcosystemMarket, readEcosystemTrust, type EcosystemReadFailure } from '../services/ecosystem-reads';

export const ecosystemReadRoutes = new Hono<ActivityAuthContext>();

const readGate = [sessionMiddleware, noStorePrivate, requireAuthOrAgentSession, requireNonGuestIdentity] as const;

// A loop on cached replies costs no budget, so it is slowed down here.
const readRateLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });

/** Test-only: reset the per-avatar limiter between cases. */
export function resetEcosystemReadRateLimit(): void {
  readRateLimiter.reset();
}

const RATE_LIMITED = { error: 'rate_limited', code: 'rate_limited', message: 'Too many reads. Wait one minute.' } as const;

function refusal(failure: EcosystemReadFailure) {
  return { error: failure.code, code: failure.code, message: failure.message };
}

ecosystemReadRoutes.get('/market/:op', ...readGate, async (c) => {
  const op = c.req.param('op');
  if (!(ECOSYSTEM_MARKET_OPS as readonly string[]).includes(op)) {
    return c.json({ error: 'unknown_op', code: 'unknown_op', ops: ECOSYSTEM_MARKET_OPS }, 400);
  }
  const identity = c.get('identity');
  if (!readRateLimiter.check(identity.avatarId)) return c.json(RATE_LIMITED, 429);
  const result = await readEcosystemMarket(identity.avatarId, {
    op: op as EcosystemMarketOp,
    mint: c.req.query('mint'),
    query: c.req.query('query'),
    limit: c.req.query('limit'),
  });
  return result.ok ? c.json(result.reply) : c.json(refusal(result), result.httpStatus);
});

ecosystemReadRoutes.get('/trust/:wallet', ...readGate, async (c) => {
  const identity = c.get('identity');
  if (!readRateLimiter.check(identity.avatarId)) return c.json(RATE_LIMITED, 429);
  const result = await readEcosystemTrust(identity.avatarId, c.req.param('wallet'));
  return result.ok ? c.json(result.reply) : c.json(refusal(result), result.httpStatus);
});
