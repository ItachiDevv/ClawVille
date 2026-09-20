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
  readHouseTraderSlotBindings,
  readHouseTraderWallets,
  slotPublishesRisk,
  type HouseTraderDeps,
  type HouseTraderSlotBinding,
  type PublicHouseTraderSlot,
} from '../services/house-traders';
import {
  bearerToken,
  decideStatusWrite,
  houseTraderStatusBodySchema,
  normaliseStatusTimestamp,
  readConfiguredStatusToken,
  readHouseTraderStatus,
  recordHouseTraderStatus,
  sanitiseStatusDetail,
  statusTokenMatches,
  toHouseTraderRisk,
} from '../services/house-trader-status';
import {
  CLAWPUMP_DASHBOARD_URL,
  TRADING_AGENT_TEMPLATES,
  TRADING_SYMBOL_TO_MINT,
  TRADING_TEMPLATE_MODEL,
  TRADING_TEMPLATE_SKILLS,
  TRADING_TEMPLATE_VERSION,
  type HouseTraderStatusResponse,
} from '@clawville/shared';

export const tradingFloorRoutes = new Hono<ActivityAuthContext>();
const limiter = createRateLimiter({ maxPerWindow: 10, windowMs: 60_000 });
/** Second bucket for `/trade`, keyed on the SUBJECT rather than the IP, so
 *  moving the IP bucket off the broken 'unknown' key cannot let one subject
 *  spread more than the old global 10/min across many addresses. */
const tradeSubjectLimiter = createRateLimiter({ maxPerWindow: 10, windowMs: 60_000 });
const templatesLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });
const houseTradersLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });
/** The runner posts on every state change plus a 60 s heartbeat, so two
 *  traders need about 2 per minute. 30 leaves room for a burst of changes and
 *  still bounds what a leaked token could do. */
const statusLimiter = createRateLimiter({ maxPerWindow: 30, windowMs: 60_000 });

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
  options: { now?: () => number } = {},
) {
  const now = options.now ?? (() => Date.now());
  // 15s in-process cache mirroring the public feed at exchange.ts:91. It holds
  // the BINDINGS, not the finished body, because the risk merge below must run
  // on every request.
  //
  // THIS 15 AND THE `max-age=5` BELOW ARE DELIBERATELY DIFFERENT. Do not "fix"
  // one to match the other. This one bounds how stale the SLOT data may be
  // (counts, tape, realised, all slow-moving). The header bounds how long a
  // shared cache may replay a whole response, `risk` included. Because the risk
  // merge runs per request outside this cache, a five second edge window serves
  // FRESH risk over fifteen-second-old slot data, which is exactly the intent.
  let cached: { expiresAt: number; generatedAt: string; bindings: HouseTraderSlotBinding[] } | null = null;
  return async (c: Context<ActivityAuthContext>) => {
    if (!houseTradersLimiter.check(getClientIp(c.req.raw.headers))) {
      return c.json({ error: 'Too many house trader requests.', code: 'rate_limited' }, 429);
    }
    if (!cached || cached.expiresAt <= now()) {
      const bindings = await readHouseTraderSlotBindings(deps);
      cached = { expiresAt: now() + cacheMs, generatedAt: new Date(now()).toISOString(), bindings };
    }
    // The RISK MERGE, deliberately OUTSIDE the cache.
    //
    // A reported pause is the one thing on this response that a reader needs
    // promptly, and it arrives out of band from a POST rather than from the
    // database read above. Folding it into the cached body would hold a pause
    // back for up to 15 s after the runner told us, and it would hold a
    // RECOVERY back just as long, which is the worse direction: a board still
    // reading "Paused by risk limit" after the trader resumed is a false
    // statement about a live trader. Merging per request costs one Map lookup
    // per slot.
    //
    // The wallet is used as the join key ONLY. It never reaches the body: two
    // tests assert no wallet string and no `wallet` key appears here.
    //
    // `slotPublishesRisk` is the pairing-wins rule: a `stopped` desk keeps its
    // link pubkey and its runner may still be heartbeating, but both human
    // surfaces show STOPPED and suppress the pause, so the wire must too.
    const merged: PublicHouseTraderSlot[] = cached.bindings.map(({ slot, walletPubkey }) => ({
      ...slot,
      risk: walletPubkey && slotPublishesRisk(slot.status)
        ? toHouseTraderRisk(readHouseTraderStatus(walletPubkey), now())
        : null,
    }));
    // Set ONLY after a successful read: a thrown read must reach the error
    // handler with no `public` cache header, or an edge could cache the 500.
    //
    // FIVE seconds, deliberately SHORTER than the 15 s in-process cache above,
    // and the two bound different things. The in-process cache bounds how stale
    // the SLOT data can be (counts, tape, realised), and 15 s of that is fine
    // because those move slowly. This header bounds how long a SHARED cache may
    // replay a whole response, `risk` included, and 15 s of that is not fine:
    // it would let an edge serve "Paused by risk limit" for 15 s after the
    // trader recovered, undoing the reason the merge sits outside the cache at
    // all, and it would let a report be served up to 15 s past its 150 s life.
    // Worst case now: a pause, or a recovery, is visible within one client poll
    // plus 5 s, and a served report is at most 155 s old.
    c.header('Cache-Control', 'public, max-age=5');
    return c.json({ generatedAt: cached.generatedAt, slots: merged });
  };
}

tradingFloorRoutes.get('/house-traders', createHouseTradersHandler());

// ─── House-trader risk status feed (machine, 2026-09-20) ────────────────────
//
// Our OWN runner posts why it cannot open a position. The board then says
// "Paused by risk limit" instead of showing a quiet trader with no explanation.
// Founder decision 2026-09-20, after Genesis sat cap-blocked from 03:25Z with
// `halted` reading false and no surface saying anything.
//
// This is NOT a player action and NOT an economy write: it stores one ephemeral
// record per house wallet, settles nothing, and touches no ledger. It therefore
// has no `[ACTION:]` verb, and no agent and no partner can call it. The READ
// side is where parity lives: `GET /api/floor/house-traders` is public and
// unauthenticated, so a human, a guest and a connected agent all see the same
// `risk` block in the same bytes. PROTOCOL_VERSION still went 66 -> 67, because
// manual section 17b documents that field and hosted runtimes key their manual
// memory on the version.
//
// Mounted before `sessionMiddleware` for the same reason the two public GETs
// are: the runner presents a bearer token and no cookie, so there is no session
// to refresh and no `Set-Cookie` to emit.
export function createHouseTraderStatusHandler(
  deps: HouseTraderDeps = createHouseTraderDeps(),
  options: { now?: () => number; walletCacheMs?: number; missRefreshMs?: number } = {},
) {
  const now = options.now ?? (() => Date.now());
  const walletCacheMs = options.walletCacheMs ?? 60_000;
  const missRefreshMs = options.missRefreshMs ?? 5_000;
  let wallets: { loadedAtMs: number; set: Set<string> } | null = null;

  async function isHouseWallet(wallet: string): Promise<boolean> {
    const at = now();
    if (!wallets || at - wallets.loadedAtMs >= walletCacheMs) {
      wallets = { loadedAtMs: at, set: await readHouseTraderWallets(deps) };
    }
    if (wallets.set.has(wallet)) return true;
    // A MISS may only mean the cache is stale: pairing and unpairing happen in
    // the database with no deploy, so a freshly paired runner would otherwise
    // 404 for a whole window. Reload once, no more often than `missRefreshMs`,
    // which recovers in seconds while keeping a flood of unknown wallets from
    // turning into a flood of database reads.
    if (at - wallets.loadedAtMs < missRefreshMs) return false;
    wallets = { loadedAtMs: at, set: await readHouseTraderWallets(deps) };
    return wallets.set.has(wallet);
  }

  return async (c: Context<ActivityAuthContext>) => {
    if (!statusLimiter.check(getClientIp(c.req.raw.headers))) {
      return c.json({ error: 'rate_limited' }, 429);
    }
    // Read at request time, so setting the secret does not need a restart and
    // an unconfigured deployment refuses rather than accepting anything.
    const expected = readConfiguredStatusToken();
    if (!expected) return c.json({ error: 'not_configured' }, 503);
    const presented = bearerToken(c.req.header('Authorization'));
    // Compared with a constant-time digest compare. The token is never logged,
    // never echoed, and never named in an error body.
    if (!presented || !statusTokenMatches(presented, expected)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    // Same 415 convention the two operator middlewares use on a write. Matched
    // on the MEDIA TYPE only, so `application/json; charset=utf-8` (which is
    // what several HTTP clients send by default) still passes. Checked after
    // the bearer, so an unauthenticated caller learns nothing from it.
    const mediaType = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }
    // The global `jsonBodyGuard` (index.ts) already answers malformed JSON with
    // `400 {error:'invalid_json'}` before this handler runs, for any body whose
    // content-type is JSON. This catch is the belt for a bare-mounted handler
    // in a test and for any future path that skips the global guard; in
    // production the caller sees `invalid_json`, which the contract documents.
    let json: unknown;
    try { json = await c.req.json(); } catch { return c.json({ error: 'invalid_body' }, 400); }
    const parsed = houseTraderStatusBodySchema.safeParse(json);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const body = parsed.data;
    // TWO different answers on purpose. A string that is not a timestamp is a
    // malformed field like any other and reads as "fix your serialiser";
    // `stale_timestamp` is reserved for a well-formed time outside the window,
    // which reads as "fix your clock, or stop replaying".
    const at = normaliseStatusTimestamp(body.at, now());
    if (!at.ok) {
      return c.json({ error: at.code === 'unparseable' ? 'invalid_body' : 'stale_timestamp' }, 400);
    }
    // Only a CURRENT lineup slot's bound wallet may write. Without this, anyone
    // holding the token could post a state for an arbitrary pubkey and grow the
    // store without bound; with it, the store cannot exceed the lineup size.
    if (!(await isHouseWallet(body.wallet))) return c.json({ error: 'unknown_wallet' }, 404);
    // ORDERING, decided on the RUNNER'S clock and not on arrival. HTTP does not
    // promise order, so a delayed `canEnter: false` could otherwise overwrite
    // the newer `canEnter: true` behind it and pin a pause on a trader that has
    // already recovered. ONLY a strictly older report is dropped; an equal `at`
    // STORES and refreshes the receipt time, because `at` is the SEND time of
    // this post and a heartbeat is the runner telling us the state still holds.
    // `decideStatusWrite` carries the full reasoning, including why equal is
    // not a replay hole. An ignored report answers 200: the runner did nothing
    // wrong and must not retry.
    const decision = decideStatusWrite(at.atMs, readHouseTraderStatus(body.wallet), now());
    if (decision !== 'store') {
      const ignored: HouseTraderStatusResponse = { ok: true, ignored: decision };
      return c.json(ignored);
    }
    const receivedAtMs = now();
    // Sanitised on the way IN, so nothing unprintable is ever stored and the
    // read path cannot forget to clean it. A note carrying an address is
    // dropped WHOLE, and the 200 says so: a note that vanishes with no signal
    // is fails-safe but not fails-visible, and the runner author needs to know
    // their own text is being discarded.
    const detail = sanitiseStatusDetail(body.detail);
    const detailRedacted = body.detail !== undefined && detail === null;
    recordHouseTraderStatus({
      wallet: body.wallet,
      canEnter: body.canEnter,
      reason: body.reason,
      detail,
      dayLossUsd: body.dayLossUsd,
      dayLossCapUsd: body.dayLossCapUsd,
      roomNeededUsd: body.roomNeededUsd,
      at: at.at,
      atMs: at.atMs,
      receivedAtMs,
    });
    const stored: HouseTraderStatusResponse = {
      ok: true,
      wallet: body.wallet,
      receivedAt: new Date(receivedAtMs).toISOString(),
      // Present only when a note was sent and nothing survived, so an ordinary
      // post keeps its existing shape.
      ...(detailRedacted ? { detailRedacted: true as const } : {}),
    };
    return c.json(stored);
  };
}

// `noStorePrivate` rather than a hand-set header: it is the repo's cache
// invariant middleware and it sets the headers AFTER the handler, so no future
// edit inside the handler can leave a `public` header on a 401 or a 404 that an
// edge would then remember.
tradingFloorRoutes.post('/house-traders/status', noStorePrivate, createHouseTraderStatusHandler());

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
