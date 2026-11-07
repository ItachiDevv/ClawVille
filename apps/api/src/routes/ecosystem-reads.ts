/**
 * Market and trust reads through ClawVille (MCP hub, 2026-11-07, migration 0098).
 *
 *   GET /api/ecosystem/market/:op  op = price (?mint=), search (?query=&limit=),
 *       top_movers (?limit=), anomalies (?limit=), macro. ClawPump, on
 *       ClawVille's own key.
 *   GET /api/ecosystem/trust/:wallet  SAID free trust check.
 *   POST /api/ecosystem/trust/:wallet/screen  header `Idempotency-Key`. The paid
 *       SAID screen: the avatar wallet pays inside the human's spend rules
 *       (`services/vendors/said.ts`). No body. Not on the read budget.
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
 * agent session header (ledger-capable for the paid screen), and the MCP tools
 * `clawville_market`, `clawville_trust` and `clawville_trust_screen`. The budget and the paid screen bind
 * to the resolved avatar. A guest (or an agent of a guest) gets 403; a logged-out
 * caller gets 401. No hosted [ACTION:] verb: vendor text must not enter a decide
 * prompt.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { ECOSYSTEM_MARKET_OPS, type EcosystemMarketOp } from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import { noStorePrivate } from '../middleware/no-store';
import { createRateLimiter } from '../middleware/rate-limit';
import { requireAuthOrAgentSession, type ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { HUMAN_SESSION_ORIGINS } from '../middleware/require-human-session';
import type { SessionCreatedVia } from '../lib/auth';
import { screenSaidWallet } from '../services/vendors/said';
import { readEcosystemMarket, readEcosystemTrust, type EcosystemReadFailure } from '../services/ecosystem-reads';

export const ecosystemReadRoutes = new Hono<ActivityAuthContext>();

const readGate = [sessionMiddleware, noStorePrivate, requireAuthOrAgentSession, requireNonGuestIdentity] as const;

// A loop on cached replies costs no budget, so it is slowed down here.
const readRateLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });
// Each paid screen costs a quote and a ledger transaction, like a Studios call.
const screenRateLimiter = createRateLimiter({ maxPerWindow: 6, windowMs: 60_000 });
const idempotencyKeySchema = z.string().trim().regex(/^[A-Za-z0-9._:-]{8,64}$/);

/** Test-only: reset the per-avatar limiter between cases. */
export function resetEcosystemReadRateLimit(): void {
  readRateLimiter.reset();
  screenRateLimiter.reset();
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

ecosystemReadRoutes.post('/trust/:wallet/screen', ...readGate, async (c) => {
  const identity = c.get('identity');
  if (identity.kind === 'agent' && identity.ledgerCapable !== true) {
    return c.json({ error: 'agent_session_not_ledger_authorized', code: 'agent_session_not_ledger_authorized' }, 403);
  }
  const idempotencyKey = idempotencyKeySchema.safeParse(c.req.header('Idempotency-Key'));
  if (!idempotencyKey.success) {
    return c.json({
      error: 'idempotency_key_required',
      code: 'idempotency_key_required',
      message: 'Send an Idempotency-Key header: 8-64 letters, digits, dots, underscores, colons or hyphens.',
    }, 400);
  }
  if (!screenRateLimiter.check(identity.avatarId)) {
    return c.json({ error: 'rate_limited', code: 'rate_limited', message: 'Too many paid screens. Wait one minute.' }, 429);
  }
  // A cookie counts as the human only when a human sign-in made it (the same rule as Studios).
  const createdVia = (c.get('session') as { createdVia?: SessionCreatedVia | null } | null | undefined)?.createdVia ?? null;
  const humanPressed = identity.kind === 'user' && createdVia !== null && HUMAN_SESSION_ORIGINS.has(createdVia);
  const result = await screenSaidWallet({
    avatarId: identity.avatarId,
    actor: humanPressed ? 'human' : 'agent',
    wallet: c.req.param('wallet'),
    idempotencyKey: idempotencyKey.data,
  });
  if (result.ok) return c.json(result.reply);
  return c.json({
    error: result.code,
    code: result.code,
    message: result.message,
    ...(result.ledgerId ? { ledgerId: result.ledgerId } : {}),
  }, result.httpStatus);
});
