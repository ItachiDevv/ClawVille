/**
 * Hatcher launch-exchange — owner-side entry into ClawVille (2026-06-11).
 *
 * THE FLOW: Hatcher's dashboard sends an owner to
 * `https://<clawville>/game#hatcher_agent=<agentId>&hatcher_launch=<launchToken>`
 * (URL FRAGMENT, not query — Codex #3: a query-string token leaks to CDN/access
 * logs + early-asset Referer headers; a fragment is never sent to the server).
 * The launch lands ALREADY authenticated (Hatcher calls our portal
 * `mint-for-hatcher` first, per our integration reply), so the owner arrives
 * with a live Lucia session. The web `/game` page reads the two params and POSTs
 * them here. We verify the agent is a real Hatcher registration, then perform a
 * SIGNED server-to-server exchange with Hatcher to redeem the grant, and return
 * the agent's in-world body position so the camera can focus on it (spectate /
 * `autonomous` mode for v1).
 *
 * Mounted by `index.ts` at `/api/partner/hatcher`, so the full path is
 * `POST /api/partner/hatcher/launch/exchange`.
 *
 * SECURITY INVARIANTS (adversary checklist — `.claude/plans/hatcher-launch-exchange.md`):
 *   1. The URL params are attacker-controlled. Hatcher's 2xx is the authorization
 *      signal, never the params alone.
 *   2. NEVER transmit the raw Lucia session id to Hatcher. We send
 *      `clawvilleSessionId = sha256Hex(sessionId)` — opaque, stable per session,
 *      non-bearer (cannot be replayed as the cookie). `clawvillePlayerId` is the
 *      real Lucia user id, proven by the portal-composed login.
 *   3. `launchToken` is NEVER logged (treated like the magic-link tickets). The
 *      audit row stores only `sha256Hex(launchToken)`.
 *   4. Local agent check FIRST: an unknown `hatcher:<agentId>` returns 404 with
 *      NO outbound call and NO signature minted — so this endpoint can never be
 *      used as a signed-request oracle for arbitrary launch tokens.
 *   5. Outbound call uses the existing SSRF-safe pattern: https-only fixed host,
 *      `redirect: 'manual'` (a 3xx is a hard fail, never followed), 10s
 *      AbortController timeout. We POST the EXACT signed canonical bytes.
 *   6. We never echo Hatcher's raw response body to the client — only `ok` plus a
 *      small internal error enum and (on rejection) their HTTP status.
 *   7. Per-IP rate limit (~10/min) — this endpoint is hit ~once per launch.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, openclawBots } from '@clawville/database';
import type { HatcherLaunchExchangeResponse } from '@clawville/shared';
import type { AppContext } from '../types';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { sessionMiddleware } from '../middleware/auth';
import { signPayload } from '../services/service-issuer';
import { validateHatcherProxyUrl } from '../services/hatcher-config';
// Canonical hex-sha256 helper — reused (NOT redefined) so the launch flow
// hashes identically to the rest of the codebase. Hashes UTF-8 bytes of the
// input string (the session id / launch token are plain strings, not hex).
import { sha256Hex } from '../services/provable-rng';
import { npcSimulation } from '../services/npc-simulation';
import { logEvent } from '../services/event-logger';

export const partnerHatcherLaunchRoutes = new Hono<AppContext>();

// Every route on this router needs the Lucia session resolved (sets c.get('user')
// / c.get('session')). We use sessionMiddleware (not requireAuth) so we can emit
// the specific `launch_requires_session` error code instead of the generic
// HTTPException 401 thrown by requireAuth.
partnerHatcherLaunchRoutes.use('*', sessionMiddleware);

/**
 * Same `hatcher:` storage namespace as `partner-hatcher.ts`. A launch param's
 * raw agentId is namespaced before the local lookup so the launch flow can only
 * ever resolve a Hatcher-owned row (never an openclaw/milady/custom agent that
 * happened to pick the same raw id via `/api/agent/connect`).
 */
const HATCHER_AGENT_PREFIX = 'hatcher:';
function namespaceHatcherAgentId(rawAgentId: string): string {
  return rawAgentId.startsWith(HATCHER_AGENT_PREFIX)
    ? rawAgentId
    : `${HATCHER_AGENT_PREFIX}${rawAgentId}`;
}

/** Fixed, non-overridable exchange endpoint. `api.hatcher.host` is in the SSRF
 *  allowlist defaults, but we hard-code the full URL here (not a per-agent
 *  proxyBaseUrl) so the launch redemption target can never be partner-steered. */
const HATCHER_EXCHANGE_URL =
  'https://api.hatcher.host/integrations/clawville/launch/exchange';

/** 10s outbound timeout — same budget as the cognition proxy in openclaw-client. */
const EXCHANGE_TIMEOUT_MS = 10_000;

/** Game-coord world center (MAP is 22528x22528; half = 11264 — see
 *  world-colliders-data.ts MAP_HALF, npc-simulation.ts MAP_WIDTH/2). The no-body,
 *  no-home camera-focus fallback: a sensible "look at the town" default rather
 *  than an off-center patch. Updated 2026-06-24 for the 576->704 world grow: this
 *  fallback had drifted two world grows behind and was aiming at a far corner of
 *  the live 22528 world; it now tracks the live world center. */
const WORLD_CENTER_X = 11264;
const WORLD_CENTER_Y = 11264;

// Per-IP limiter. ~once per launch in normal use; 10/min/IP absorbs a retry
// burst while denying a brute-force loop. Own bucket so it can't starve (or be
// starved by) the register/patch/delete limiter in partner-hatcher.ts.
const launchExchangeRateLimiter = createRateLimiter({
  maxPerWindow: 10,
  windowMs: 60_000,
});

const exchangeSchema = z.object({
  // Length-capped + charset-bound. The raw partner id is opaque to us; we only
  // need it sane enough to namespace + send verbatim to Hatcher. Matches the
  // register schema's 200-char ceiling on agentId.
  agentId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\w.:@-]+$/, 'agentId has invalid characters'),
  // The launch grant token. Opaque bearer minted by Hatcher; we never inspect
  // it, only forward it over the signed channel. Generously capped to tolerate
  // a JWT-style token without allowing an unbounded body.
  launchToken: z.string().min(1).max(4096),
}).strict();

/**
 * Resolve the agent's current in-world body position for the camera focus.
 * Preference order: (1) the agent's LIVE body pose (registered into
 * npc-simulation under the NAMESPACED id at register time — find its live
 * session(s) and read the pose); (2) the agent's PERSISTED home coordinates
 * (metadata.homeX/Y, the partner-set spawn); (3) the game-coord WORLD CENTER
 * (11264,11264) as a last resort so the camera looks at the town, never an
 * off-center patch. Every branch returns an in-bounds, sensible target.
 */
function resolveAgentPosition(
  namespacedAgentId: string,
  row: typeof openclawBots.$inferSelect,
): { x: number; y: number } {
  try {
    const sessions = npcSimulation.findActiveSessionsByAgentIds([namespacedAgentId]);
    for (const sid of sessions) {
      const pos = npcSimulation.getOpenClawAvatarPosition(sid);
      if (pos) return pos;
    }
  } catch {
    // Fall through to the persisted-home / world-center fallback below.
  }
  const homeX = typeof row.metadata?.homeX === 'number' ? row.metadata.homeX : WORLD_CENTER_X;
  const homeY = typeof row.metadata?.homeY === 'number' ? row.metadata.homeY : WORLD_CENTER_Y;
  return { x: homeX, y: homeY };
}

// ---------------------------------------------------------------------------
// POST /api/partner/hatcher/launch/exchange — redeem an owner launch grant
// ---------------------------------------------------------------------------
partnerHatcherLaunchRoutes.post('/launch/exchange', async (c) => {
  // (7) Per-IP rate limit FIRST — cheapest gate, runs before any DB/crypto work.
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });
  if (!launchExchangeRateLimiter.check(ip)) {
    const body: HatcherLaunchExchangeResponse = { ok: false, error: 'rate_limited' };
    return c.json(body, 429);
  }

  // Strict Zod on the body (length + charset caps on both params).
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    const body: HatcherLaunchExchangeResponse = { ok: false, error: 'invalid_request' };
    return c.json(body, 400);
  }
  const parsed = exchangeSchema.safeParse(json);
  if (!parsed.success) {
    const body: HatcherLaunchExchangeResponse = { ok: false, error: 'invalid_request' };
    return c.json(body, 400);
  }
  const { agentId: rawAgentId, launchToken } = parsed.data;

  // (2) Require a Lucia session. No guest exchange in v1 — the launch lands
  // authenticated via the portal-composed `mint-for-hatcher` login. requireAuth
  // would throw a generic 401; we want the specific error code, so we read the
  // session resolved by sessionMiddleware ourselves.
  const user = c.get('user');
  const session = c.get('session');
  if (!user || !session) {
    const body: HatcherLaunchExchangeResponse = { ok: false, error: 'launch_requires_session' };
    return c.json(body, 401);
  }

  // (4) Local agent existence check BEFORE any outbound call or signature mint.
  // An unknown agent → 404, no signed-request oracle, no launch-token leak to a
  // signature. Namespacing means a Hatcher launch can only resolve a Hatcher row.
  const namespacedAgentId = namespaceHatcherAgentId(rawAgentId);
  const row = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, namespacedAgentId),
  });
  if (!row || row.identityType !== 'hatcher') {
    const body: HatcherLaunchExchangeResponse = { ok: false, error: 'agent_not_registered' };
    return c.json(body, 404);
  }
  // Controlled launch lands the owner IN CONTROL of the agent's bound avatar and
  // suppresses the autonomous proxy keyed on `boundUserId === session user`. That
  // suppression only fires if the launching Lucia session IS the agent's bound
  // user, so enforce it here rather than trusting the partner-supplied principal:
  //   - no bound user  → there is no avatar to drive (agent registered without an
  //     identityKey) → `agent_not_bound`.
  //   - bound to a DIFFERENT user → driving would leave the proxy as a second,
  //     auto-walking body → `agent_not_owned`. Fail loud, never silently dupe.
  if (!row.userId) {
    const body: HatcherLaunchExchangeResponse = { ok: false, error: 'agent_not_bound' };
    return c.json(body, 409);
  }
  if (row.userId !== user.id) {
    const body: HatcherLaunchExchangeResponse = { ok: false, error: 'agent_not_owned' };
    return c.json(body, 403);
  }

  // Build the exchange body. clawvilleSessionId is the NON-REVERSIBLE sha256 of
  // the Lucia session id — stable per session for correlation on Hatcher's side,
  // but never the bearer cookie itself (so a Hatcher-side log/leak can't replay
  // it as our session). clawvillePlayerId is the real user id (proven login).
  const exchangeBody = {
    agentId: rawAgentId,
    launchToken,
    clawvillePlayerId: user.id,
    clawvilleSessionId: sha256Hex(session.id),
    mode: 'controlled' as const,
  };

  // (5) Sign the canonical body. signPayload returns the EXACT bytes to transmit
  // (sorted-key canonical JSON) + the base58 ed25519 signature + our issuer
  // pubkey, so Hatcher hashes the same bytes it receives.
  let signed: ReturnType<typeof signPayload>;
  try {
    signed = signPayload(exchangeBody);
  } catch (err) {
    // Our signing key is missing/invalid — a SERVER config error, NOT an
    // upstream rejection. Distinct 503 `launch_issuer_unconfigured` (mirrors
    // portal.ts:730-733) so the web side surfaces "try again later", not
    // "relaunch from Hatcher". Fail closed; the launch token is never leaked.
    console.error('[Hatcher/launch] signing failed (issuer unconfigured) — failing closed:', err);
    const body: HatcherLaunchExchangeResponse = { ok: false, error: 'launch_issuer_unconfigured' };
    return c.json(body, 503);
  }

  // (5) Defense-in-depth: although HATCHER_EXCHANGE_URL is a hard-coded literal
  // (not partner-steerable), run it through the same SSRF guard the cognition
  // path uses so an accidental future edit to the constant — or an
  // HATCHER_PROXY_ALLOWED_HOSTS misconfig — cannot point the signed exchange at
  // a non-https / non-allowlisted / private host. Sync check is sufficient (the
  // host is a fixed literal, not a freshly-resolved partner hostname); the
  // `redirect:'manual'` below still backstops a rebind between resolve + connect.
  const exchangeUrlCheck = validateHatcherProxyUrl(HATCHER_EXCHANGE_URL);
  if (!exchangeUrlCheck.ok) {
    console.error(
      `[Hatcher/launch] fixed exchange URL failed SSRF guard (${exchangeUrlCheck.reason}) — failing closed`,
    );
    const body: HatcherLaunchExchangeResponse = { ok: false, error: 'exchange_rejected', status: 0 };
    return c.json(body, 502);
  }

  // (5) Outbound exchange — SSRF-safe: fixed https host, manual redirect (a 3xx
  // is a hard fail, never followed — defeats an allowlisted-host rebind/redirect
  // bounce that would forward our signature + the launch token to an internal
  // address), bounded by a 10s AbortController timeout. We POST to the validated
  // full path (validateHatcherProxyUrl preserves the path on the normalized URL).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  let upstreamStatus = 0;
  let upstreamOk = false;
  try {
    const res = await fetch(exchangeUrlCheck.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'X-Clawville-Issuer-Pubkey': signed.pubkey,
        'X-Clawville-Signature': signed.signature,
      },
      body: signed.body,
      signal: controller.signal,
    });
    upstreamStatus = res.status;
    // A redirect (manual mode surfaces 3xx, or status 0 / opaqueredirect on some
    // runtimes) is a hard fail — never follow it.
    const isRedirect =
      res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
    // (1) Treat ANY 2xx as success — Hatcher's response schema is unknown (v1).
    // We do NOT parse their body; success is the status class alone, and we
    // never echo their body to our client.
    upstreamOk = !isRedirect && res.status >= 200 && res.status < 300;
  } catch (err) {
    // Network / timeout / abort — treated as an upstream rejection. Log the
    // error message but NEVER the launch token.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Hatcher/launch] exchange call failed for agent ${namespacedAgentId}: ${msg}`);
    upstreamOk = false;
  } finally {
    clearTimeout(timeout);
  }

  // (3) Audit row — token HASH only, never the raw token. Outcome + actor logged.
  void logEvent({
    eventType: 'hatcher.launch.exchanged',
    userId: user.id,
    agentId: namespacedAgentId,
    payload: {
      via: 'launch-exchange',
      launchTokenHash: sha256Hex(launchToken),
      outcome: upstreamOk ? 'accepted' : 'rejected',
      upstreamStatus,
    },
  });

  if (!upstreamOk) {
    // (6) Never echo Hatcher's body — only our enum + their HTTP status.
    const body: HatcherLaunchExchangeResponse = {
      ok: false,
      error: 'exchange_rejected',
      status: upstreamStatus,
    };
    return c.json(body, 502);
  }

  // Success — return the agent's public identity + in-world position. Echo the
  // RAW partner id (strip the `hatcher:` storage namespace).
  const position = resolveAgentPosition(namespacedAgentId, row);
  // Controlled mode: the owner is about to drive the agent's avatar in 'player'
  // mode. Prime the server-side suppression of the agent's autonomous proxy NPC
  // immediately (keyed on the namespaced agentId) so it can't auto-walk in the
  // window before the browser's first /api/world/position upload starts the 5 Hz
  // TTL refresh. The binding lets later uploads re-prime this same agent after
  // a transient stall, without hiding other Hatcher proxies bound to the owner.
  npcSimulation.bindHumanControlledOpenClawLaunch(user.id, namespacedAgentId);
  npcSimulation.markHumanControlledOpenClaw(namespacedAgentId);
  const body: HatcherLaunchExchangeResponse = {
    ok: true,
    agent: {
      agentId: rawAgentId,
      name: row.name ?? rawAgentId.slice(0, 24),
      x: position.x,
      y: position.y,
      mode: 'controlled',
    },
  };
  return c.json(body, 200);
});
