import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
import { requireAuthOrAgentSession, requireLedgerCapableIdentity, type ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { executeTrade } from '../services/trading-execution';
import { readAutonomousTradingTargets } from '../services/autonomous-trading-targets';
import { tradingSubjectKey } from '../services/trading-wallet-challenge';
import {
  createHouseTraderDeps,
  readHouseTraderSlots,
  type HouseTraderDeps,
} from '../services/house-traders';
import {
  CLAWPUMP_DASHBOARD_URL,
  TRADING_AGENT_TEMPLATES,
  TRADING_SYMBOL_TO_MINT,
  TRADING_TEMPLATE_MODEL,
  TRADING_TEMPLATE_SKILLS,
  TRADING_TEMPLATE_VERSION,
} from '@clawville/shared';

export const tradingFloorRoutes = new Hono<ActivityAuthContext>();
const limiter = createRateLimiter({ maxPerWindow: 10, windowMs: 60_000 });
/** Second bucket for `/trade`, keyed on the SUBJECT rather than the IP, so
 *  moving the IP bucket off the broken 'unknown' key cannot let one subject
 *  spread more than the old global 10/min across many addresses. */
const tradeSubjectLimiter = createRateLimiter({ maxPerWindow: 10, windowMs: 60_000 });
const templatesLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });
const houseTradersLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });

// ─── Public ClawPump trader templates ───────────────────────────────────────
//
// Mounted FIRST, BEFORE the shared `sessionMiddleware` below, exactly like the
// public `/api/leaderboard/agents` route. This ordering is LOAD BEARING, not
// style: `sessionMiddleware` appends a `Set-Cookie` whenever Lucia refreshes a
// fresh session or blanks an invalid one (middleware/auth.ts:17-25), and this
// response is `Cache-Control: public`. A shared cache in front of the origin
// could then store one visitor's session cookie and hand it to the next.
// Skipping the middleware means there is no cookie to leak.
//
// Static public copy with no subject data, so a human, a guest and a connected
// agent receive identical bytes. That is the strongest parity form a read
// surface has: there is no path to authenticate onto, so there is no path an
// agent can be locked out of. The body is read straight from the constants the
// Trading Floor tab renders, so the served template and the rendered template
// cannot disagree.
tradingFloorRoutes.get('/templates', async (c) => {
  // `getClientIp` reads request HEADERS, so it takes `c.req.raw.headers` (the
  // form 73 of the 77 call sites use). Passing the Hono context instead makes
  // every caller key on the literal 'unknown', which turns a per-IP limit into
  // one global bucket. See the note at the `/trade` limiter below.
  if (!templatesLimiter.check(getClientIp(c.req.raw.headers))) return c.json({ error: 'Too many template requests.', code: 'rate_limited' }, 429);
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    version: TRADING_TEMPLATE_VERSION,
    model: TRADING_TEMPLATE_MODEL,
    skills: TRADING_TEMPLATE_SKILLS,
    dashboardUrl: CLAWPUMP_DASHBOARD_URL,
    templates: TRADING_AGENT_TEMPLATES,
  });
});

// ─── Public house-trader watch surface (wave A2) ────────────────────────────
//
// Also mounted BEFORE `sessionMiddleware`, for the same load-bearing reason as
// `/templates` above: it is `Cache-Control: public`, and the middleware appends
// a `Set-Cookie` on a fresh or blanked session. NOTE, this deviates from the A2
// spec section 3 ("leave both public GETs after it, do NOT restructure the
// router"), which reasoned only about the no-cookie case; with a cookie present
// the middleware does emit `Set-Cookie`, so a shared cache could hand one
// visitor's session to the next. Read only: no pairing, no arming, no money.
export function createHouseTradersHandler(
  deps: HouseTraderDeps = createHouseTraderDeps(),
  cacheMs = 15_000,
) {
  // 15s in-process cache mirroring the public feed at exchange.ts:91.
  let cached: { expiresAt: number; body: unknown } | null = null;
  return async (c: Context<ActivityAuthContext>) => {
    if (!houseTradersLimiter.check(getClientIp(c.req.raw.headers))) {
      return c.json({ error: 'Too many house trader requests.', code: 'rate_limited' }, 429);
    }
    c.header('Cache-Control', 'public, max-age=15');
    if (cached && cached.expiresAt > Date.now()) return c.json(cached.body as any);
    const body = {
      generatedAt: new Date().toISOString(),
      slots: await readHouseTraderSlots(deps),
    };
    cached = { expiresAt: Date.now() + cacheMs, body };
    return c.json(body);
  };
}

tradingFloorRoutes.get('/house-traders', createHouseTradersHandler());

tradingFloorRoutes.use('*', sessionMiddleware);

const bodySchema = z.object({
  inputMint: z.string().min(1).max(44),
  outputMint: z.string().min(1).max(44),
  amountUsd: z.number().min(1).max(25),
  reason: z.string().trim().min(1).max(240).refine((value) => !/[,=()[\]]/.test(value)),
}).strict();

function mint(value: string): string | null {
  const key = value.replace(/^\$/, '').toUpperCase();
  if (Object.hasOwn(TRADING_SYMBOL_TO_MINT, key)) return TRADING_SYMBOL_TO_MINT[key as keyof typeof TRADING_SYMBOL_TO_MINT];
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : null;
}

tradingFloorRoutes.post('/trade', requireAuthOrAgentSession, requireNonGuestIdentity, requireLedgerCapableIdentity, noStorePrivate, async (c) => {
  // Abuse control only; trade admission (cooldown, daily notional, reserves)
  // is untouched. TWO buckets, both must pass. `getClientIp` reads request
  // HEADERS: passing the Hono context made `.get()` read context VARIABLES, so
  // every caller keyed on the literal 'unknown' and this was ONE global 10/min
  // bucket for the whole internet, i.e. one caller could lock everyone out.
  // Per-IP alone would be LOOSER than that for a single actor, so the
  // per-subject bucket keeps the old ceiling for any one subject.
  if (!limiter.check(getClientIp(c.req.raw.headers))) return c.json({ error: 'Too many trade requests.', code: 'rate_limited' }, 429);
  const identityForLimit = c.get('identity');
  const subjectKey = tradingSubjectKey({
    kind: identityForLimit.kind === 'agent' ? 'agent' : 'avatar',
    userId: identityForLimit.userId,
    avatarId: identityForLimit.avatarId,
    agentId: identityForLimit.agentId,
  });
  if (!tradeSubjectLimiter.check(subjectKey)) return c.json({ error: 'Too many trade requests.', code: 'rate_limited' }, 429);
  let json: unknown;
  try { json = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON.', code: 'invalid_body' }, 400); }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return c.json({ error: 'Invalid trade request.', code: 'invalid_body' }, 400);
  const inputMint = mint(parsed.data.inputMint);
  const outputMint = mint(parsed.data.outputMint);
  if (!inputMint || !outputMint) return c.json({ kind: 'refused', decisionId: null, code: 'mint_not_whitelisted', detail: 'A mint is invalid.', signature: null });
  const identity = c.get('identity');
  const micros = BigInt(Math.round(parsed.data.amountUsd * 1_000_000));
  const result = await executeTrade({
    avatarId: identity.avatarId,
    inputMint,
    outputMint,
    amountUsdMicros: micros,
    reason: parsed.data.reason,
    origin: identity.kind === 'agent' ? 'agent-tool' : 'human-rest',
    sessionId: identity.kind === 'agent' ? c.req.header('x-clawville-agent-session') ?? null : null,
    agentId: identity.agentId,
    directiveId: null,
    directiveOrdinal: null,
  });
  return c.json(result);
});

tradingFloorRoutes.get('/state', requireAuthOrAgentSession, requireNonGuestIdentity, requireLedgerCapableIdentity, noStorePrivate, async (c) => {
  return c.json(await readAutonomousTradingTargets({ avatarId: c.get('identity').avatarId }));
});
