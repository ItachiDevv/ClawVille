/**
 * Phase 6.1 — slice 3: ClawTokens fun-money cove-slots backend wire.
 * Phase 6.7.5 (2026-05-28) — guest plays. `/session/open` + `/spin` accept
 * unauthenticated callers. Guest sessions seed a 100-fun-CT in-session
 * demo balance (`slot_sessions.starting_balance`); win/loss moves only
 * the session balance — no `avatars.clawTokens` read/write. Guest plays
 * do NOT count toward `/dash` daily caps because `cove_game_events` is a
 * player-facing history table, not a leaderboard event source. Per-fp
 * rate limit (10 sessions/hour) on `/session/open` is the only abuse gate.
 *
 * Mount: `app.route('/api/cove/slots', coveSlotsRouter)` from index.ts.
 *
 * Surfaces:
 *
 *   POST /session/open              (auth optional) — open commit-reveal session
 *   POST /spin                      (auth optional) — execute one spin (idempotent)
 *   POST /session/close             (user or agent) — close + reveal serverSeed
 *   GET  /session/:id               (user or agent) — owner-only session detail
 *   GET  /session/:id/spins         (user or agent) — owner-only paginated spins
 *   GET  /paytables/:id             (public)     — paytable + reel strips for verifier
 *   POST /verify                    (public)     — pure-compute replay endpoint
 *
 * ClawTokens path is fully wired. SOL/USDC `/session/open` returns 501 with
 * a friendly "coming in 6.2" message — the column tolerates them so future
 * custody hookup is a route change, not a schema change.
 *
 * Money model (slice 3, ClawTokens only):
 *   - /session/open does NOT debit. It records startingBalance for UI display.
 *     It DOES pre-check that the avatar can afford at least one predict,
 *     returning 400 `insufficient_clawtokens` early so we don't open a
 *     fund-less session.
 *   - /spin direct-debits predict, credits winAmount. Atomic within a single
 *     transaction (debit + counters + spin insert + win credit all-or-nothing).
 *   - /session/close has no refund. Player's balance equals real-time
 *     avatar.clawTokens — there is nothing in escrow to give back because
 *     ClawTokens path never reserved anything at open time.
 * Phase 6.2 will add SOL/USDC buy-in semantics with on-chain escrow; the
 * `escrowAmount` column is reserved for that path and stays at '0' here.
 *
 * Phase 6.1.5 — bonus paytable (`classic-3x5-bonus`) adds free-spin state:
 *   - /spin reads `session.mode` + `freeSpinsRemaining` to decide whether
 *     THIS spin is a FREE spin (no debit, line wins doubled, wild multipliers
 *     doubled).
 *   - Engine result's `freeSpinsAwarded` bumps `freeSpinsRemaining` (capped at
 *     `FREE_SPIN_RULES.CAP_REMAINING`) and flips mode to 'free-spin' on
 *     trigger. When the counter hits 0 after a free spin, mode flips back
 *     to 'base'.
 *   - Free spins NEVER count toward `totalStaked` (they are free — the
 *     money-safety invariant depends on this).
 *
 * Design choices:
 *
 *  1) BigInt JSON: every response that carries bigint (winAmount, predict,
 *     escrow, totals, scatterPayout) goes through `serializeSpinResult` /
 *     explicit `.toString()` so Hono's `c.json` never sees a bigint. No
 *     `BigInt.prototype.toJSON` monkey-patch — global side effects bite
 *     event-logger sanitization and third-party deps.
 *
 *  2) Idempotency: every POST /spin requires an `Idempotency-Key` header.
 *     On the hot path we SELECT first inside a transaction. A cached row
 *     short-circuits BEFORE we call `runSpin`, BEFORE we debit, BEFORE
 *     we touch the session counters — pure replay. We ALSO assert the
 *     cached spin's `predict` matches the new request's `predict` before
 *     serving the cache (Stripe-style); a mismatched replay returns 409
 *     so a leaked key can't be replayed at a different stake when slice
 *     4+ relaxes the per-session fixed-predict constraint. The partial
 *     unique index (sessionId, idempotencyKey) is the race-safe backstop.
 *
 *  3) Spin atomicity: the spin's debit + spin row insert + session
 *     update + winnings credit all run inside one DB transaction. If any
 *     step throws, the WHOLE transaction rolls back — the user never
 *     ends up "charged but no spin recorded."
 *
 *  4) Rate limit: 60 spins/min/user (NOT per-IP — shared NATs would
 *     cripple players otherwise; user-id scoping needs auth which we
 *     already have on this route). In-memory token bucket lives in this
 *     module, scoped by `user.id`.
 *
 *  5) Auth: every owner-only route asserts `session.userId === user.id`
 *     before reading or mutating; foreign-user sessions get 403.
 *
 *  6) 501 path: SOL/USDC return a typed friendly response, NOT an
 *     HTTPException 500 stack trace.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  db,
  avatars,
  slotSessions,
  slotSpins,
  coveGameEvents,
  type SlotSession,
} from '@clawville/database';
import {
  BONUS_REEL_STRIPS,
  BONUS_SYMBOLS,
  CLASSIC_LINES,
  CLASSIC_REEL_STRIPS,
  CLASSIC_SYMBOLS,
  CLASSIC_PAYTABLE,
  CLASSIC_BONUS_PAYTABLE,
  FREE_SPIN_RULES,
  COVE_SLOTS_BET_STEP,
  COVE_SLOTS_MAX_BET,
  COVE_SLOTS_MIN_BET,
} from '@clawville/shared';
import { sessionMiddleware } from '../middleware/auth';
import { resolveAgentSession } from '../middleware/require-auth-or-agent';
import { isGuestUser } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import {
  CLIENT_SEED_MAX_LENGTH,
  createServerSeed,
} from '../services/provable-rng';
import {
  type MachineSlug,
  type SpinResult,
  runSpin,
} from '../services/slot-engine';
import {
  creditClawTokens,
  debitClawTokens,
  InsufficientTokensError,
} from '../services/claw-token-ledger';
import { logEventFromContext, logEventFromContextReturningId } from '../services/event-logger';
import { publishCoveSettlement } from '../services/agent-settlement-publish';
import {
  serializeSpinResult,
  serializeWildMultiplier,
  serializeWinningLine,
  type CloseSessionResponse,
  type OpenSessionResponse,
  type PaytableResponse,
  type SerializedWildMultiplier,
  type SpinResponse,
} from './cove-slots.types';
import type { AppContext } from '../types';

export const coveSlotsRouter = new Hono<AppContext>();
coveSlotsRouter.use('*', sessionMiddleware);

// ─── Constants ────────────────────────────────────────────────────────────

const SUPPORTED_PAYTABLES = ['classic-3x5', 'classic-3x5-bonus'] as const satisfies readonly MachineSlug[];
const SUPPORTED_CURRENCIES = ['clawtokens', 'sol', 'usdc'] as const;

/** Max length on the `Idempotency-Key` header (matches Stripe convention). */
const IDEMPOTENCY_KEY_MAX_LEN = 64;

const AUTONOMOUS_COVE_HEADER = 'X-Clawville-Internal-Autonomous-Cove';
const AUTONOMOUS_COVE_ACTION_HEADER = 'X-Clawville-Internal-Autonomous-Cove-Action';
const autonomousCoveToken = randomBytes(32).toString('hex');
const DEFAULT_AGENT_COVE_PLAY_DAILY_WAGER_VCLAW = 1_000;

/** Environment-backed hard ceiling for autonomous cove wagering per avatar/UTC day. */
export function resolveAgentCovePlayDailyWagerVclaw(): number {
  const raw = process.env.AGENT_COVE_PLAY_DAILY_WAGER_VCLAW?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_AGENT_COVE_PLAY_DAILY_WAGER_VCLAW;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= COVE_SLOTS_MIN_BET
    ? parsed
    : DEFAULT_AGENT_COVE_PLAY_DAILY_WAGER_VCLAW;
}

/** Default + max page size on /session/:id/spins. */
const SPIN_HISTORY_DEFAULT_LIMIT = 50;
const SPIN_HISTORY_MAX_LIMIT = 200;

// ─── Subject-scoped spin rate limiter (60/min/subject) ────────────────────
//
// Keyed by subjectKey (`u:${userId}` for a human OR the agent bound to its
// avatar, `g:${fpHash}` for a guest) — so an agent and the human it plays as
// share one bucket and can't dodge the limit by toggling cookie vs agent
// header. Subject-bound scoping also defeats the shared-NAT collateral damage
// of IP limiters. Bounded growth: one entry per active subject, swept lazily.

interface SpinRateBucket {
  count: number;
  resetAt: number;
}
const SPIN_RATE_LIMIT = 60;
const SPIN_RATE_WINDOW_MS = 60_000;
const spinRateBuckets = new Map<string, SpinRateBucket>();

function checkSpinRate(key: string): void {
  const now = Date.now();
  // Cheap periodic GC: every ~500 misses sweep expired entries.
  if (spinRateBuckets.size > 5_000) {
    for (const [k, v] of spinRateBuckets) {
      if (now > v.resetAt) spinRateBuckets.delete(k);
    }
  }
  const entry = spinRateBuckets.get(key);
  if (!entry || now > entry.resetAt) {
    spinRateBuckets.set(key, { count: 1, resetAt: now + SPIN_RATE_WINDOW_MS });
    return;
  }
  entry.count++;
  if (entry.count > SPIN_RATE_LIMIT) {
    throw new HTTPException(429, {
      message: `cove_slots_rate_limit: max ${SPIN_RATE_LIMIT} spins/min`,
    });
  }
}

/** Test-only — exported for unit tests to reset between assertions. */
export function __resetSpinRateLimit(): void {
  spinRateBuckets.clear();
}

// ─── Guest session-open rate limit (10/hour/fp_hash) ──────────────────────
//
// Phase 6.7.5 — guests can't be scoped by user_id, so we key on the salted
// fp_hash (the only stable cross-request identifier we have for unauth
// callers). Single-process / in-memory: this is best-effort, not a hard
// ceiling — if api is horizontally scaled (it isn't today) each replica
// has its own bucket. Acceptable for fun-money guest demo; tighten when
// guest real-money lands.

interface GuestOpenBucket {
  count: number;
  resetAt: number;
}
const GUEST_SESSION_OPEN_LIMIT = 10;
const GUEST_SESSION_OPEN_WINDOW_MS = 60 * 60 * 1_000; // 1 hour
const guestSessionOpenBuckets = new Map<string, GuestOpenBucket>();

function checkGuestSessionOpenRate(fpHash: string): void {
  const now = Date.now();
  if (guestSessionOpenBuckets.size > 10_000) {
    for (const [k, v] of guestSessionOpenBuckets) {
      if (now > v.resetAt) guestSessionOpenBuckets.delete(k);
    }
  }
  const entry = guestSessionOpenBuckets.get(fpHash);
  if (!entry || now > entry.resetAt) {
    guestSessionOpenBuckets.set(fpHash, {
      count: 1,
      resetAt: now + GUEST_SESSION_OPEN_WINDOW_MS,
    });
    return;
  }
  entry.count++;
  if (entry.count > GUEST_SESSION_OPEN_LIMIT) {
    throw new HTTPException(429, {
      message: `cove_slots_guest_session_rate_limit: max ${GUEST_SESSION_OPEN_LIMIT} guest sessions/hour. Sign up to keep playing.`,
    });
  }
}

/** Test-only — exported for unit tests to reset between assertions. */
export function __resetGuestSessionOpenRate(): void {
  guestSessionOpenBuckets.clear();
}

// ─── Subject resolution (user OR agent OR guest, never combined) ───────────
//
// THREE subject kinds (Rule E5 — human↔agent parity, 2026-06-15). Faithfully
// mirrors the AUDITED `cove-blackjack.ts` getSubject pattern so slots inherits
// the same real-CT settlement path for connected/hosted agents:
//   - 'user'  — Lucia-authed human. Settles in REAL CT on `avatars.clawTokens`.
//   - 'agent' — a connected/hosted agent playing AS ITSELF via the agent gateway
//     session header (`X-Clawville-Agent-Session`). It resolves through
//     `resolveAgentSession` → its BOUND avatar's `userId`/`avatarId`, and settles
//     in the SAME real-CT ledger path as a human (debit/creditClawTokens). An
//     agent is NEVER routed to the guest demo tier — that user-XOR-guest gap was
//     the E5 violation this fixes (slots previously resolved user|guest ONLY, so
//     a connected agent could not stake/settle real CT).
//   - 'guest' — anonymous fingerprint, demo-CT only (no ledger). The DB check
//     constraint (`cove_game_events_subject_check` / `slot_sessions_subject_check`)
//     enforces `userId XOR guestFpHash`. An agent subject carries the bound
//     avatar's `userId` (guestFpHash null), so the XOR still holds and the
//     audited money path is reused verbatim — the agent kind adds NO new money
//     branch (see `isLedgerSubject`).
//
// Money parity rule: 'user' and 'agent' are both LEDGER subjects (they carry a
// real `userId` and write the ClawToken ledger). `isLedgerSubject()` collapses
// the two for every balance/owner branch so no slots settle code is duplicated.
//
// The agent-session header name matches the existing activity-portal /
// require-auth-or-agent convention; Hono lower-cases header reads (case-insensitive).

const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';

type SlotSubject =
  | { kind: 'user'; userId: string; avatarId: null; agentId: null; sessionId: null; guestFpHash: null }
  | { kind: 'agent'; userId: string; avatarId: string; agentId: string; sessionId: string; guestFpHash: null }
  | { kind: 'guest'; userId: null; avatarId: null; agentId: null; sessionId: null; guestFpHash: string };

/**
 * The DEMO `kind:'guest'` subject (session/shoe demo balance, ZERO ledger),
 * keyed on the request fingerprint hash. Used by BOTH an anonymous visitor
 * AND a guest ACCOUNT (`is_guest` Lucia user) — the founder-ruling 2026-07-06
 * fully-demo guest economy. fpHash is always present (fingerprintMiddleware
 * throws at API boot if FINGERPRINT_SECRET is unset); the check is defense-in-depth.
 */
function guestDemoSubject(c: { get(key: 'fpHash'): string }): SlotSubject {
  const fpHash = c.get('fpHash');
  if (!fpHash) {
    throw new HTTPException(500, { message: 'fpHash_missing_for_guest_request' });
  }
  return { kind: 'guest', userId: null, avatarId: null, agentId: null, sessionId: null, guestFpHash: fpHash };
}

/**
 * Resolve the request subject. Precedence: Lucia human → agent session → guest
 * (verbatim semantics from `cove-blackjack.ts` getSubject).
 *
 * Async (was sync) because the agent branch does a DB lookup to map the opaque
 * session id → bound avatar/user. The human + guest branches stay synchronous in
 * effect (no await on those paths) so existing latency is unchanged.
 *
 * An agent session that is unknown/expired → 401; one that is not ledger-capable
 * → 403; one bound to a user WITHOUT an active avatar → 403. An agent NEVER falls
 * through to the guest tier (silently demoting a connected agent to demo play is
 * the exact E5 violation). A logged-in human cookie ALWAYS wins over an agent
 * header on the same request.
 */
async function getSubject(c: {
  get(key: 'user'): { id: string } | null;
  get(key: 'fpHash'): string;
  req: { header(name: string): string | undefined };
}): Promise<SlotSubject> {
  const user = c.get('user');
  if (user) {
    // Guest ACCOUNTS run the FULLY-DEMO economy (founder ruling 2026-07-06): an
    // `is_guest` Lucia user has an avatar + a 100-CT SOFT balance but must NEVER
    // bet/win/lose REAL CT in the Cove. Route them to the SAME demo `kind:'guest'`
    // subject an anonymous visitor gets — session/shoe demo balance, ZERO ledger.
    // NOT a 403: guests keep playing the Cove for fun on demo CT. Non-guest humans
    // fall through to the real-CT `kind:'user'` path below. A connected/hosted
    // agent resolves via the agent-session header (a guest is never an agent, E5),
    // so real-CT agent parity is untouched.
    if (await isGuestUser(user.id)) {
      return guestDemoSubject(c);
    }
    return { kind: 'user', userId: user.id, avatarId: null, agentId: null, sessionId: null, guestFpHash: null };
  }

  const agentSessionId = c.req.header(AGENT_SESSION_HEADER);
  if (agentSessionId) {
    const resolved = await resolveAgentSession(agentSessionId);
    if (!resolved) {
      throw new HTTPException(401, { message: 'invalid_or_expired_agent_session' });
    }
    // Ledger-capability gate (mirrors cove-blackjack). A session that did NOT
    // prove ownership of its bound avatar (an agentId-only reconnect, a legacy
    // /openclaw/register session) is `ledgerCapable === false`. It may
    // perceive/chat/move, but it must NOT spend the avatar's REAL ClawTokens here.
    // Reject 403 BEFORE the avatar-binding check — NOT a guest fall-through.
    if (!resolved.ledgerCapable) {
      throw new HTTPException(403, {
        message: 'agent_session_not_ledger_authorized',
      });
    }
    if (!resolved.userId || !resolved.avatarId) {
      // Known agent, but not bound to an active avatar — cannot stake real CT.
      // Surfaced as 403 (not a fall-through to guest) so a connected agent is
      // never silently demoted to demo play.
      throw new HTTPException(403, {
        message:
          'agent_session_has_no_active_avatar: connect an avatar before playing the Cove for real vCLAW',
      });
    }
    return {
      kind: 'agent',
      userId: resolved.userId,
      avatarId: resolved.avatarId,
      agentId: resolved.agentId,
      sessionId: agentSessionId,
      guestFpHash: null,
    };
  }

  return guestDemoSubject(c);
}

/**
 * The real-CT ledger userId for a subject, or null for a guest. 'user' and
 * 'agent' are BOTH ledger subjects — this collapses them so the money path is
 * written once.
 */
function ledgerUserId(subject: SlotSubject): string | null {
  return subject.kind === 'guest' ? null : subject.userId;
}

/** True iff the subject settles in real CT (human or agent). */
function isLedgerSubject(
  subject: SlotSubject,
): subject is Extract<SlotSubject, { kind: 'user' | 'agent' }> {
  return subject.kind !== 'guest';
}

/**
 * Rate-limit / spin-bucket key. 'user' and 'agent' rate-limit on userId — an
 * agent and its bound human share one avatar/wallet, so they SHOULD share one
 * spin-rate bucket (you can't dodge the limit by toggling between cookie + agent
 * header on one avatar). Guests key on fp_hash.
 */
function subjectKey(subject: SlotSubject): string {
  return subject.kind === 'guest' ? `g:${subject.guestFpHash}` : `u:${subject.userId}`;
}

/**
 * A real-CT session is keyed on `userId` (NOT on agent/guest). Both human and
 * agent subjects for the same bound avatar therefore see + own the SAME session —
 * an agent playing AS its avatar continues the human's session, never forks a
 * parallel one. Guests own by fingerprint.
 */
function ownerMatches(
  session: { userId: string | null; guestFpHash: string | null },
  subject: SlotSubject,
): boolean {
  return isLedgerSubject(subject)
    ? session.userId === subject.userId
    : session.guestFpHash === subject.guestFpHash;
}

// ─── Schemas ──────────────────────────────────────────────────────────────

const bigintPositiveString = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer string')
  .refine((s) => s.length <= 30, 'predict too large to be sane');

const openSchema = z
  .object({
    paytableId: z.enum(SUPPORTED_PAYTABLES),
    currency: z.enum(SUPPORTED_CURRENCIES),
    predict: bigintPositiveString,
  })
  .strict();

const spinSchema = z
  .object({
    sessionId: z.string().uuid(),
    predict: bigintPositiveString,
  })
  .strict();

const closeSchema = z
  .object({
    sessionId: z.string().uuid(),
  })
  .strict();

const verifySchema = z
  .object({
    paytableId: z.enum(SUPPORTED_PAYTABLES),
    serverSeed: z
      .string()
      .length(64)
      .regex(/^[0-9a-fA-F]{64}$/, 'serverSeed must be 64 hex chars'),
    clientSeed: z
      .string()
      .min(1)
      .max(CLIENT_SEED_MAX_LENGTH)
      .regex(/^[0-9a-fA-F]+$/, 'clientSeed must be hex'),
    nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    predict: bigintPositiveString,
  })
  .strict();

const spinsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SPIN_HISTORY_MAX_LIMIT)
      .default(SPIN_HISTORY_DEFAULT_LIMIT),
  })
  .strict();

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Build the response shape returned by `GET /session/:id`. We REDACT the
 * raw serverSeed while status='open' — exposing it before close would
 * defeat the entire commit-reveal scheme (player could pre-compute spin
 * outcomes from `(serverSeed, clientSeed, nonce, cursor)`).
 */
function publicSession(row: SlotSession) {
  const baseShape = {
    id: row.id,
    userId: row.userId,
    paytableId: row.paytableId as MachineSlug,
    currency: row.currency,
    serverSeedHash: row.serverSeedHash,
    clientSeed: row.clientSeed,
    nonceCounter: row.nonceCounter,
    cursorCounter: row.cursorCounter,
    startingBalance: row.startingBalance,
    currentBalance: row.currentBalance,
    escrowAmount: row.escrowAmount,
    totalStaked: row.totalStaked,
    totalWon: row.totalWon,
    status: row.status,
    mode: row.mode,
    freeSpinsRemaining: row.freeSpinsRemaining,
    spinCount: row.spinCount,
    createdAt: row.createdAt.toISOString(),
    lastSpinAt: row.lastSpinAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
  return {
    ...baseShape,
    // serverSeed only emitted once the session is no longer accepting spins.
    serverSeed: row.status === 'open' ? null : row.serverSeed,
  };
}

function buildPaytableResponse(paytableId: MachineSlug): PaytableResponse {
  switch (paytableId) {
    case 'classic-3x5':
      return {
        paytableId,
        symbols: CLASSIC_SYMBOLS,
        lines: CLASSIC_LINES,
        reelStrips: CLASSIC_REEL_STRIPS,
        rtp: CLASSIC_PAYTABLE.rtp,
      };
    case 'classic-3x5-bonus':
      return {
        paytableId,
        symbols: BONUS_SYMBOLS,
        lines: CLASSIC_LINES,
        reelStrips: BONUS_REEL_STRIPS,
        rtp: CLASSIC_BONUS_PAYTABLE.rtp,
      };
    default: {
      // Exhaustiveness check — TS catches missing arms at compile time.
      const _exhaustive: never = paytableId;
      throw new HTTPException(404, {
        message: `paytable_not_found: ${_exhaustive}`,
      });
    }
  }
}

async function loadAvatarForUser(userId: string): Promise<{
  id: string;
  clawTokens: number;
}> {
  const row = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
    columns: { id: true, clawTokens: true },
  });
  if (!row) {
    throw new HTTPException(400, { message: 'no_active_avatar_for_user' });
  }
  return row;
}

// ─── POST /session/open ───────────────────────────────────────────────────

coveSlotsRouter.post('/session/open', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = openSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'invalid_input: ' + parsed.error.message,
    });
  }
  const input = parsed.data;
  const subject = await getSubject(c);

  // 501 stub for SOL/USDC — Phase 6.2 custody not wired. Guests are also
  // gated to ClawTokens (no real-money guest play per plan §0).
  if (input.currency !== 'clawtokens') {
    return c.json(
      {
        error: 'CURRENCY_COMING_SOON',
        message:
          'SOL/USDC custody lands in Phase 6.2. Use currency="clawtokens" today.',
      },
      501,
    );
  }

  const predictBig = BigInt(input.predict);
  if (predictBig <= 0n) {
    throw new HTTPException(400, { message: 'predict_must_be_positive' });
  }
  // ClawTokens are stored as int4, so this must fit a JS number.
  if (predictBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HTTPException(400, { message: 'predict_exceeds_supported_range' });
  }
  const predictNumber = Number(predictBig);

  // ── Subject-conditioned pre-flight ─────────────────────────────────────
  //
  // Authed: load avatar, gate on clawTokens. UX-only pre-flight; the spin
  // txn re-checks under the row lock.
  // Guest: hardcoded 100-fun-CT demo balance per plan §0 #6. Rate-limit
  // per-fp here so a single fp can't open arbitrarily many sessions to
  // farm RNG seeds or DoS the DB.
  let avatar: { id: string; clawTokens: number } | null = null;
  let guestStartingBalance = 0n;
  if (isLedgerSubject(subject)) {
    avatar = await loadAvatarForUser(subject.userId);
    if (avatar.clawTokens < predictNumber) {
      throw new HTTPException(400, {
        message: `insufficient_clawtokens: need ${predictNumber}, have ${avatar.clawTokens}`,
      });
    }
  } else {
    // Guest-only rate limit — never throttle a ledger (human/agent) subject here.
    checkGuestSessionOpenRate(subject.guestFpHash);
    guestStartingBalance = 100n;
    if (predictBig > guestStartingBalance) {
      throw new HTTPException(400, {
        message: `insufficient_guest_demo_balance: need ${predictNumber}, have ${guestStartingBalance.toString()}. Sign up to play with more.`,
      });
    }
  }

  // Idempotent open: if an open session already exists for this user, return
  // it instead of 409 so a fresh tab / store-cleared client can adopt the
  // orphan and keep playing. SELECT … FOR UPDATE serializes us against any
  // concurrent /spin or /close on the same row — we never return data for a
  // session another request is mid-mutating.
  //
  // Paytable-match policy: if the existing session uses a DIFFERENT paytable,
  // we refuse with 409 instead of returning it (changing paytables mid-session
  // would drop the commit-reveal state); the player must close the prior
  // session first. Same paytable → idempotent 200.
  let resumed: SlotSession | null = null;
  try {
    resumed = await db.transaction(async (tx) => {
      // Phase 6.7.5 — subject-conditioned lookup. The partial unique indexes
      // `slot_sessions_user_open_unique` / `slot_sessions_guest_open_unique`
      // guarantee at most one open row matches.
      const lockWhere = isLedgerSubject(subject)
        ? sql`user_id = ${subject.userId} AND status = 'open'`
        : sql`guest_fp_hash = ${subject.guestFpHash} AND status = 'open'`;
      const lockRows = await tx.execute<{
        id: string;
        user_id: string | null;
        guest_fp_hash: string | null;
        paytable_id: string;
        currency: string;
        server_seed: string;
        server_seed_hash: string;
        client_seed: string;
        nonce_counter: number;
        cursor_counter: number;
        starting_balance: string;
        current_balance: string;
        escrow_amount: string;
        total_staked: string;
        total_won: string;
        status: string;
        mode: string;
        free_spins_remaining: number;
        spin_count: number;
        created_at: Date;
        last_spin_at: Date | null;
        closed_at: Date | null;
      }>(
        sql`SELECT id, user_id, guest_fp_hash, paytable_id, currency, server_seed, server_seed_hash,
                   client_seed, nonce_counter, cursor_counter, starting_balance,
                   current_balance, escrow_amount, total_staked, total_won, status,
                   mode, free_spins_remaining, spin_count, created_at, last_spin_at,
                   closed_at
            FROM slot_sessions
            WHERE ${lockWhere}
            FOR UPDATE`,
      );
      const lockRow = lockRows[0];
      if (!lockRow) return null;
      if (lockRow.paytable_id !== input.paytableId) {
        // Carry the existing session's id + paytable in the error payload so
        // the frontend can surface a "switch table" affordance without an
        // extra round-trip. The 409 message body is parsed by
        // describeCoveError; we include a machine-readable suffix so the
        // client can extract the id reliably.
        throw new HTTPException(409, {
          message: `session_already_open_different_paytable: open=${lockRow.paytable_id}, requested=${input.paytableId}, existingSessionId=${lockRow.id}`,
        });
      }
      // Drizzle tx.execute returns INT columns as strings (PG wire format).
      // Coerce explicitly so the values used in downstream comparisons +
      // engine inputs + event payloads are typed correctly.
      return {
        id:                  lockRow.id,
        userId:              lockRow.user_id,
        guestFpHash:         lockRow.guest_fp_hash,
        paytableId:          lockRow.paytable_id,
        currency:            lockRow.currency,
        serverSeed:          lockRow.server_seed,
        serverSeedHash:      lockRow.server_seed_hash,
        clientSeed:          lockRow.client_seed,
        nonceCounter:        Number(lockRow.nonce_counter),
        cursorCounter:       Number(lockRow.cursor_counter),
        startingBalance:     lockRow.starting_balance,
        currentBalance:      lockRow.current_balance,
        escrowAmount:        lockRow.escrow_amount,
        totalStaked:         lockRow.total_staked,
        totalWon:            lockRow.total_won,
        status:              lockRow.status,
        mode:                lockRow.mode,
        freeSpinsRemaining:  Number(lockRow.free_spins_remaining),
        spinCount:           Number(lockRow.spin_count),
        createdAt:           lockRow.created_at,
        lastSpinAt:          lockRow.last_spin_at,
        closedAt:            lockRow.closed_at,
      } as SlotSession;
    });
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    throw err;
  }

  if (resumed) {
    void logEventFromContext(c, {
      eventType: 'cove.slots.session.resumed',
      userId: ledgerUserId(subject),
      avatarId: avatar?.id ?? null,
      agentId: subject.kind === 'agent' ? subject.agentId : null,
      payload: {
        sessionId: resumed.id,
        paytableId: resumed.paytableId,
        currency: resumed.currency,
        nonceCounter: resumed.nonceCounter,
        spinCount: resumed.spinCount,
        isGuest: subject.kind === 'guest',
        isAgent: subject.kind === 'agent',
      },
    });
    const response: OpenSessionResponse = {
      sessionId: resumed.id,
      paytableId: resumed.paytableId as MachineSlug,
      currency: 'clawtokens',
      serverSeedHash: resumed.serverSeedHash,
      clientSeed: resumed.clientSeed,
      startingBalance: resumed.startingBalance,
      escrowAmount: resumed.escrowAmount,
      // predict echoes the client's request; the session's authoritative
      // per-spin stake stays in startingBalance (which the /spin handler
      // pins against). Mismatch is intentional UX — the client may have
      // sent a different chip value but will discover the session-pinned
      // predict via startingBalance and adopt it.
      predict: predictBig.toString(),
      // Drizzle raw SQL execute returns timestamps as strings (not Date
      // objects). Coerce defensively so both shapes work.
      createdAt:
        resumed.createdAt instanceof Date
          ? resumed.createdAt.toISOString()
          : new Date(resumed.createdAt as unknown as string).toISOString(),
      // Authed users see real clawTokens; guests see derived demo balance
      // (starting + totalWon - totalStaked, never negative by spin guard).
      walletBalance: avatar
        ? avatar.clawTokens
        : Number(
            BigInt(resumed.startingBalance) +
              BigInt(resumed.totalWon) -
              BigInt(resumed.totalStaked),
          ),
    };
    return c.json(response, 200);
  }

  const { serverSeed, serverSeedHash } = createServerSeed();
  // Slice 3: server-generated client seed. The column is non-null so a
  // future "bring your own seed" flow is purely a route-level change.
  const clientSeed = randomBytes(8).toString('hex');

  // No open-time debit — each spin direct-debits via /spin. startingBalance
  // is informational (UI display only). escrowAmount stays '0' because the
  // ClawTokens path doesn't reserve anything; Phase 6.2 SOL/USDC will use
  // the column for real on-chain escrow.
  //
  // We still wrap the INSERT in a transaction for symmetry / future use
  // (e.g. seeding a 'free spin' grant row alongside the session).
  let inserted: SlotSession;
  try {
    inserted = await db.transaction(async (tx) => {
      // Phase 6.7.5 — subject XOR (DB-enforced by check constraint). For
      // guests, startingBalance is the 100-fun-CT demo wallet (NOT the
      // per-spin predict snapshot used by the authed flow). The spin
      // handler reads startingBalance + totalWon - totalStaked to derive
      // the live demo balance and refuses spins that would go negative.
      const [row] = await tx
        .insert(slotSessions)
        .values({
          userId: subject.userId,
          guestFpHash: subject.guestFpHash,
          paytableId: input.paytableId,
          currency: input.currency,
          serverSeed,
          serverSeedHash,
          clientSeed,
          // Ledger subject (human OR agent): per-spin predict snapshot (existing
          // semantics — the /spin handler pins against this). Guest: demo wallet seed.
          startingBalance: isLedgerSubject(subject)
            ? predictBig.toString()
            : guestStartingBalance.toString(),
          // currentBalance: net session P&L (negative = down, positive = up).
          // Starts at 0 because no real money has moved at open time.
          // For guest demo, this stays = totalWon - totalStaked just like
          // authed — we never write avatars.clawTokens for guests.
          currentBalance: '0',
          // escrowAmount: reserved for Phase 6.2 SOL/USDC buy-in model.
          // ClawTokens path keeps it at '0' — no reservation, no refund.
          escrowAmount: '0',
          status: 'open',
          mode: 'base',
        })
        .returning();
      if (!row) {
        throw new HTTPException(500, { message: 'session_insert_failed' });
      }
      return row;
    });
  } catch (err) {
    // Race: between our SELECT FOR UPDATE above and the INSERT, another
    // request inserted the user's open session. Re-read it and serve
    // idempotently — same paytable → 200, different paytable → 409.
    const pgCode = (err as { code?: string } | undefined)?.code;
    if (pgCode === '23505') {
      // Same subject-conditioned WHERE as the FOR UPDATE block above; one
      // of the partial unique indexes tripped.
      const raceWhere = isLedgerSubject(subject)
        ? and(eq(slotSessions.userId, subject.userId), eq(slotSessions.status, 'open'))
        : and(eq(slotSessions.guestFpHash, subject.guestFpHash), eq(slotSessions.status, 'open'));
      const raceRows = await db
        .select()
        .from(slotSessions)
        .where(raceWhere)
        .limit(1);
      const raceRow = raceRows[0];
      if (raceRow) {
        if (raceRow.paytableId !== input.paytableId) {
          // Same machine-readable suffix shape as the SELECT FOR UPDATE path
          // (~line 419) so the frontend auto-close parser at
          // SlotScreenModal.tsx can recover from this rare race too.
          throw new HTTPException(409, {
            message: `session_already_open_different_paytable: open=${raceRow.paytableId}, requested=${input.paytableId}, existingSessionId=${raceRow.id}`,
          });
        }
        const response: OpenSessionResponse = {
          sessionId: raceRow.id,
          paytableId: raceRow.paytableId as MachineSlug,
          currency: 'clawtokens',
          serverSeedHash: raceRow.serverSeedHash,
          clientSeed: raceRow.clientSeed,
          startingBalance: raceRow.startingBalance,
          escrowAmount: raceRow.escrowAmount,
          predict: predictBig.toString(),
          createdAt: raceRow.createdAt.toISOString(),
          walletBalance: avatar
            ? avatar.clawTokens
            : Number(
                BigInt(raceRow.startingBalance) +
                  BigInt(raceRow.totalWon) -
                  BigInt(raceRow.totalStaked),
              ),
        };
        return c.json(response, 200);
      }
      // Vanishingly unlikely: 23505 fired but the row isn't there on
      // re-read (closed in between). Surface 409 so the client knows
      // to retry.
      throw new HTTPException(409, { message: 'session_already_open' });
    }
    throw err;
  }

  void logEventFromContext(c, {
    eventType: 'cove.slots.session.opened',
    userId: ledgerUserId(subject),
    avatarId: avatar?.id ?? null,
    agentId: subject.kind === 'agent' ? subject.agentId : null,
    payload: {
      sessionId: inserted.id,
      paytableId: input.paytableId,
      currency: input.currency,
      predict: predictBig.toString(),
      isGuest: subject.kind === 'guest',
      isAgent: subject.kind === 'agent',
    },
  });

  const response: OpenSessionResponse = {
    sessionId: inserted.id,
    paytableId: inserted.paytableId as MachineSlug,
    currency: 'clawtokens',
    serverSeedHash: inserted.serverSeedHash,
    clientSeed: inserted.clientSeed,
    startingBalance: inserted.startingBalance,
    escrowAmount: inserted.escrowAmount,
    predict: predictBig.toString(),
    createdAt: inserted.createdAt.toISOString(),
    walletBalance: avatar
      ? avatar.clawTokens
      // Fresh guest session: starting demo wallet, nothing won/staked yet.
      : Number(guestStartingBalance),
  };
  return c.json(response, 200);
});

// ─── POST /spin ────────────────────────────────────────────────────────────

coveSlotsRouter.post('/spin', async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey) {
    throw new HTTPException(400, {
      message: 'missing_idempotency_key_header',
    });
  }
  if (idempotencyKey.length === 0 || idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN) {
    throw new HTTPException(400, {
      message: `idempotency_key_must_be_1_to_${IDEMPOTENCY_KEY_MAX_LEN}_chars`,
    });
  }

  const body = await c.req.json().catch(() => null);
  const parsed = spinSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'invalid_input: ' + parsed.error.message,
    });
  }
  const input = parsed.data;
  const subject = await getSubject(c);

  const isInternalAutonomousPlay = c.req.header(AUTONOMOUS_COVE_HEADER) === autonomousCoveToken;
  const autonomousActionId = isInternalAutonomousPlay
    ? c.req.header(AUTONOMOUS_COVE_ACTION_HEADER)
    : undefined;
  if (isInternalAutonomousPlay && (
    subject.kind !== 'agent'
    || !autonomousActionId
    || !z.string().uuid().safeParse(autonomousActionId).success
  )) {
    throw new HTTPException(403, { message: 'invalid_internal_autonomous_cove_context' });
  }

  // Rate limit keyed on user/agent (by userId) OR fp_hash (guest); we want guests
  // bounded too (a guest fp shouldn't be able to spin > 60/min). Same 60/min
  // ceiling either way. An agent and its bound human share the userId bucket.
  checkSpinRate(subjectKey(subject));

  const session = await db.query.slotSessions.findFirst({
    where: eq(slotSessions.id, input.sessionId),
  });
  if (!session) {
    throw new HTTPException(404, { message: 'session_not_found' });
  }
  // Subject-conditioned owner check — a ledger subject (human/agent) owns by
  // userId, a guest by fp_hash. A real-CT session is keyed on userId so an agent
  // and its bound human see + own the SAME session (never a parallel fork).
  if (!ownerMatches(session, subject)) {
    throw new HTTPException(403, { message: 'session_not_owned' });
  }

  // ─── Idempotency fast-path ─────────────────────────────────────────
  //
  // The cache MUST be checked BEFORE the session-status / predict
  // validation. A spin that landed and committed (cached row exists)
  // can have its session closed afterwards — auto-close path,
  // /session/close, expiry. A client replay of the same Idempotency-Key
  // after that window must STILL return the cached row, NOT 409
  // session_not_open. Otherwise an honest client retry races the close
  // and the player loses visibility into their own spin result.
  //
  // (Phase 6.1.10 audit finding — moved up from after the status check
  // where it used to live.)
  //
  // Stripe-style guard: a key replayed with DIFFERENT predict args is
  // a misuse (or an exploitation attempt) — return 409 instead of
  // serving the cached result at the new stake.
  const cached = await db.query.slotSpins.findFirst({
    where: and(
      eq(slotSpins.sessionId, session.id),
      eq(slotSpins.idempotencyKey, idempotencyKey),
    ),
  });
  if (cached) {
    if (cached.predict !== input.predict) {
      throw new HTTPException(409, {
        message: `idempotency_key_reused_with_different_args: cached predict=${cached.predict}, new predict=${input.predict}. Use a fresh Idempotency-Key.`,
      });
    }
    // Re-load the session so the response reflects post-cached-spin state.
    const fresh = await db.query.slotSessions.findFirst({
      where: eq(slotSessions.id, session.id),
    });
    // Ledger subject (human/agent): real avatar balance. Guest: demo balance
    // derived from session counters (starting + totalWon - totalStaked).
    const balanceForResponse = isLedgerSubject(subject)
      ? (await loadAvatarForUser(subject.userId)).clawTokens
      : Number(
          BigInt(fresh?.startingBalance ?? session.startingBalance) +
            BigInt(fresh?.totalWon ?? session.totalWon) -
            BigInt(fresh?.totalStaked ?? session.totalStaked),
        );
    // winningLines was stored as the already-SERIALIZED shape (winAmount
    // as string) by the spin txn below, so we pass it through verbatim.
    // Cast through `unknown` because jsonb's typing on the way out is
    // structurally `unknown` and we own the writer's shape.
    const response: SpinResponse = {
      spinId: cached.id,
      reels: cached.reels as SpinResult['reels'],
      winningLines: cached.winningLines as SpinResponse['winningLines'],
      winAmount: cached.winAmount,
      // Phase 6.1.5 — `freeSpinsAwarded` is the value that was emitted
      // for this exact spin (not 0 unconditionally). The exact value
      // is lost on cache (slotSpins schema doesn't persist it), but the
      // SESSION state was already updated when the original spin landed
      // — that's what matters for client UI. We derive a best-effort
      // value: a non-zero `scatterPayout` implies a 3+ scatter trigger
      // fired, so award was BASE (10) or RETRIGGER (5) depending on
      // whether the spin itself was a free spin.
      freeSpinsAwarded: BigInt(cached.scatterPayout) > 0n
        ? (cached.isFreeSpin ? FREE_SPIN_RULES.AWARD_RETRIGGER : FREE_SPIN_RULES.AWARD_BASE)
        : 0,
      isFreeSpin: cached.isFreeSpin,
      wildMultipliers: cached.wildMultipliers as SerializedWildMultiplier[],
      scatterPayout: cached.scatterPayout,
      cursorAfter: cached.cursorAfter,
      predict: cached.predict,
      balance: balanceForResponse,
      escrowRemaining: fresh?.escrowAmount ?? session.escrowAmount,
      totalStaked: fresh?.totalStaked ?? session.totalStaked,
      totalWon: fresh?.totalWon ?? session.totalWon,
      spinCount: fresh?.spinCount ?? session.spinCount,
      mode: (fresh?.mode ?? session.mode) as 'base' | 'free-spin',
      freeSpinsRemaining: fresh?.freeSpinsRemaining ?? session.freeSpinsRemaining,
      idempotencyReplay: true,
    };
    return c.json(response, 200);
  }

  // Cache miss — proceed with a fresh spin. Status + predict validation
  // moved AFTER the cache lookup (audit finding 6.1.10):
  if (session.status !== 'open') {
    throw new HTTPException(409, {
      message: `session_not_open: status=${session.status}`,
    });
  }
  // Predict-pin policy differs by subject:
  //   • Ledger sessions (human OR agent) store the per-spin predict in
  //     `startingBalance` at open time (existing semantics); every spin must
  //     match it exactly.
  //   • Guest sessions store a 100-fun-CT demo wallet in `startingBalance`;
  //     each spin's predict can be any positive bigint that fits in the
  //     remaining demo balance (UX gate; the spin-time balance check
  //     inside the txn is authoritative).
  if (isLedgerSubject(subject) && input.predict !== session.startingBalance) {
    throw new HTTPException(400, {
      message: `predict_must_equal_session_reserved_predict (expected ${session.startingBalance}, got ${input.predict})`,
    });
  }
  const predictBig = BigInt(input.predict);
  if (predictBig <= 0n) {
    throw new HTTPException(400, { message: 'predict_must_be_positive' });
  }
  if (predictBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HTTPException(400, { message: 'predict_exceeds_supported_range' });
  }
  const predictNumber = Number(predictBig);

  // Ledger subject (human/agent): load avatar for the ClawTokens ledger.
  // Guest: avatar=null, demo wallet accounting lives entirely in slot_sessions row.
  const avatar = isLedgerSubject(subject)
    ? await loadAvatarForUser(subject.userId)
    : null;

  // Phase 6.1.5 — derive free-spin mode from the session row read above.
  // Defensive: only the bonus paytable can ever set mode='free-spin', so
  // a classic-3x5 session with mode='free-spin' AND freeSpinsRemaining>0
  // is treated as base (engine ignores freeSpinMode for non-bonus paytables
  // anyway — no wild draws, no scatter — but skipping the debit on classic
  // would be a money bug). We belt-and-suspenders this here.
  const isBonusPaytable = session.paytableId === 'classic-3x5-bonus';
  let isFreeSpinSpin =
    isBonusPaytable && session.mode === 'free-spin' && session.freeSpinsRemaining > 0;

  // Run the engine OUTSIDE the transaction — `runSpin` is pure and bounded
  // (no I/O). Doing it before the txn keeps the row lock window tight and
  // avoids holding a DB write transaction during HMAC work.
  let spinResult: SpinResult;
  try {
    spinResult = runSpin({
      paytableId: session.paytableId as MachineSlug,
      serverSeed: session.serverSeed,
      clientSeed: session.clientSeed,
      nonce: session.nonceCounter,
      cursor: session.cursorCounter,
      predict: predictBig,
      freeSpinMode: isFreeSpinSpin,
    });
  } catch (err) {
    throw new HTTPException(400, {
      message: `spin_engine_error: ${(err as Error).message}`,
    });
  }
  let winAmountBig = spinResult.winAmount;

  // ─── Atomic spin write ──────────────────────────────────────────────
  // 1. Debit `predict` from user (skip on a free spin — FS spins consume
  //    no predict, only credit any winAmount).
  // 2. Update session counters / cursor / mode / free-spin remaining.
  // 3. INSERT spin row (idempotency key trips here on race).
  // 4. Credit `winAmount` to user.
  //
  // The whole thing is one transaction. A duplicate-idempotency-key
  // INSERT will throw 23505 and roll back the debit + counter update —
  // the cached row from the WINNING concurrent request is what the
  // retry sees on its next call.

  let spinRowId: string;
  let finalSession: SlotSession;
  let balanceAfter: number;
  try {
    const result = await db.transaction(async (tx) => {
      // Re-fetch the session FOR UPDATE so we don't lose to a concurrent
      // /spin that mutates nonceCounter / cursorCounter / status. The
      // engine call above used a pre-lock snapshot; if status flipped to
      // 'closed' between our read and the txn, abort cleanly.
      const lockRows = await tx.execute<{
        nonce_counter: number;
        cursor_counter: number;
        status: string;
        mode: string;
        free_spins_remaining: number;
        escrow_amount: string;
        total_staked: string;
        total_won: string;
        spin_count: number;
      }>(
        sql`SELECT nonce_counter, cursor_counter, status, mode, free_spins_remaining,
                   escrow_amount, total_staked, total_won, spin_count
            FROM slot_sessions
            WHERE id = ${session.id}
            FOR UPDATE`,
      );
      const lockRow = lockRows[0];
      if (!lockRow) {
        throw new HTTPException(404, { message: 'session_not_found' });
      }
      if (lockRow.status !== 'open') {
        throw new HTTPException(409, {
          message: `session_not_open: status=${lockRow.status}`,
        });
      }
      // Drizzle's `tx.execute` returns ALL column values as strings (PG
      // wire-format), regardless of the type assertion above. Coerce the
      // integer columns explicitly so equality checks against
      // `session.*` (which `findFirst` returns as numbers) don't trip
      // on string-vs-number mismatch.
      const lockNonceCounter        = Number(lockRow.nonce_counter);
      const lockCursorCounter       = Number(lockRow.cursor_counter);
      const lockFreeSpinsRemaining  = Number(lockRow.free_spins_remaining);

      // Engine was called on a pre-lock snapshot. If the session's
      // counters or mode have moved (concurrent spin won the race,
      // OR the row has stale state from a partial earlier txn /
      // resumed orphan), recompute the spin under the row lock with
      // the authoritative locked values. We hold FOR UPDATE so no
      // further drift is possible — the recomputed spinResult is
      // guaranteed consistent with what we'll commit.
      const lockIsFreeSpinSpin =
        isBonusPaytable && lockRow.mode === 'free-spin' && lockFreeSpinsRemaining > 0;
      if (
        lockNonceCounter !== session.nonceCounter ||
        lockCursorCounter !== session.cursorCounter ||
        lockIsFreeSpinSpin !== isFreeSpinSpin
      ) {
        try {
          spinResult = runSpin({
            paytableId: session.paytableId as MachineSlug,
            serverSeed:  session.serverSeed,
            clientSeed:  session.clientSeed,
            nonce:       lockNonceCounter,
            cursor:      lockCursorCounter,
            predict:     predictBig,
            freeSpinMode: lockIsFreeSpinSpin,
          });
        } catch (err) {
          throw new HTTPException(500, {
            message: `engine_recompute_failed_under_lock: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        winAmountBig    = spinResult.winAmount;
        isFreeSpinSpin  = lockIsFreeSpinSpin;
        // Mutate the session snapshot so downstream INSERT/UPDATE
        // references (session.nonceCounter, session.cursorCounter,
        // session.mode, session.freeSpinsRemaining) use locked values.
        (session as { nonceCounter: number }).nonceCounter         = lockNonceCounter;
        (session as { cursorCounter: number }).cursorCounter       = lockCursorCounter;
        (session as { mode: string }).mode                         = lockRow.mode;
        (session as { freeSpinsRemaining: number }).freeSpinsRemaining = lockFreeSpinsRemaining;
      }

      // Autonomous wagering is admitted under the SAME transaction as the
      // actual slots debit and spin/history writes. The advisory lock makes the
      // UTC-day aggregate race-safe across API processes. Accounting reads the
      // canonical ledger debit rows by avatar (not cove history betAmount), so
      // free spins consume zero cap and provenance-split debits sum exactly.
      if (autonomousActionId && avatar && !isFreeSpinSpin) {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`agent-cove-play-daily:${avatar.id}`}, 0)
          )
        `);
        const usageRows = await tx.execute<{ used_vclaw: string }>(
          autonomousCoveDailyUsageQuery(avatar.id),
        );
        const usedToday = parseAutonomousCoveDailyUsage(usageRows);
        const capMessage = autonomousCoveDailyCapMessage(usedToday, predictNumber);
        if (capMessage) {
          throw new HTTPException(429, {
            message: capMessage,
          });
        }
      }

      // Phase 6.1.5 — debit only on BASE spins. Free spins consume no
      // predict (FREE in name and in money), but still credit any win.
      // Phase 6.7.5 — for GUEST sessions, debit/credit never touch the
      // ClawTokens ledger; the demo balance lives entirely on the
      // slot_sessions row (startingBalance + totalWon - totalStaked).
      let debitBalance: number;
      if (!isLedgerSubject(subject) || !avatar) {
        // Guest demo balance check under the row lock. Refuse if this
        // spin's predict would push the demo wallet negative. Free spins
        // bypass the check (no debit).
        if (!isFreeSpinSpin) {
          const demoBalanceBefore =
            BigInt(session.startingBalance) +
            BigInt(lockRow.total_won) -
            BigInt(lockRow.total_staked);
          if (demoBalanceBefore < predictBig) {
            throw new HTTPException(400, {
              message: `insufficient_guest_demo_balance: need ${predictNumber}, have ${demoBalanceBefore.toString()}. Sign up to play with more.`,
            });
          }
        }
        // No ClawTokens row; just compute what we'll report. Update the
        // running demo balance to reflect post-debit / pre-credit state.
        debitBalance = isFreeSpinSpin
          ? Number(
              BigInt(session.startingBalance) +
                BigInt(lockRow.total_won) -
                BigInt(lockRow.total_staked),
            )
          : Number(
              BigInt(session.startingBalance) +
                BigInt(lockRow.total_won) -
                BigInt(lockRow.total_staked) -
                predictBig,
            );
      } else if (isFreeSpinSpin) {
        // Re-read balance so the response reflects current truth without
        // a debit. The credit path below mutates this if winAmount > 0.
        const balRows = await tx.execute<{ claw_tokens: number }>(
          sql`SELECT claw_tokens FROM avatars WHERE id = ${avatar.id}`,
        );
        debitBalance = balRows[0]?.claw_tokens ?? avatar.clawTokens;
      } else {
        // Debit predict from user (ledger row + balance update).
        try {
          const debit = await debitClawTokens(
            {
              avatarId: avatar.id,
              amount: predictNumber,
              reason: 'cove_slots_spin',
              source: 'api',
              metadata: {
                sessionId: session.id,
                paytableId: session.paytableId,
                nonce: session.nonceCounter,
                ...(autonomousActionId
                  ? {
                      autonomousCove: true,
                      autonomousGame: 'slots',
                      autonomousActionId,
                    }
                  : {}),
              },
              actorKind: subject.kind === 'user' ? 'human' : 'agent',
            },
            tx,
          );
          debitBalance = debit.balanceAfter;
        } catch (err) {
          if (err instanceof InsufficientTokensError) {
            throw new HTTPException(400, {
              message: `insufficient_clawtokens_for_spin: need ${predictNumber}, have ${err.available}`,
            });
          }
          throw err;
        }
      }

      // INSERT spin row — duplicate (sessionId, idempotencyKey) trips
      // the unique index and rolls back the debit above.
      const winAmountStr = winAmountBig.toString();
      const winningLinesJson = spinResult.winningLines.map(serializeWinningLine);
      const wildMultipliersJson = spinResult.wildMultipliers.map(serializeWildMultiplier);
      const [spinRow] = await tx
        .insert(slotSpins)
        .values({
          sessionId: session.id,
          nonce: session.nonceCounter,
          cursorBefore: session.cursorCounter,
          cursorAfter: spinResult.cursorAfter,
          predict: predictBig.toString(),
          isFreeSpin: spinResult.isFreeSpin,
          reels: spinResult.reels,
          winningLines: winningLinesJson,
          winAmount: winAmountStr,
          wildMultipliers: wildMultipliersJson,
          scatterPayout: spinResult.scatterPayout.toString(),
          idempotencyKey,
        })
        .returning();
      if (!spinRow) {
        throw new HTTPException(500, { message: 'spin_insert_failed' });
      }

      // Phase 6.7.0 — same-transaction write to the cross-game history
      // table. cove_game_events is a parallel write to slot_spins (NOT a
      // replacement) so the existing slot-spin replay flow keeps working
      // and a revert of 6.7.0 leaves slot_spins untouched (plan §6 revert
      // policy). revealedServerSeed stays null until /session/close flips
      // session.status — that's the commit-reveal contract (plan §0 #2).
      // engineVersion mirrors slot_spins.paytableVersion so the verifier
      // can pin against the correct historical engine on replay.
      await tx.insert(coveGameEvents).values({
        // Phase 6.7.5 — subject XOR; DB check constraint enforces.
        userId: subject.userId,
        guestFpHash: subject.guestFpHash,
        gameType: 'slots',
        sessionId: session.id,
        shoeId: session.id, // slots: one session == one shoe
        // betAmount + payout are TEXT-stringified bigints in the schema
        // (matches slot_spins.win_amount / slot_sessions.starting_balance).
        betAmount: predictBig.toString(),
        payout: winAmountStr,
        outcomeJson: {
          // Discriminator for the cross-game outcomeJson union (plan §9 risk
          // "outcomeJson schema drift"). Browser verifier's `isSlotsOutcome`
          // guard branches on `kind === 'slots'` as its first check. Backfill
          // emits the same field — live + backfilled rows share one schema.
          kind: 'slots',
          // paytableId is captured here so the cross-game verifier (which
          // doesn't know about slot_sessions) can route to the right paytable
          // version. See cove-history.ts extractSlotPaytableId().
          paytableId: session.paytableId,
          reels: spinResult.reels,
          winningLines: winningLinesJson,
          winAmount: winAmountStr,
          isFreeSpin: spinResult.isFreeSpin,
          wildMultipliers: wildMultipliersJson,
          scatterPayout: spinResult.scatterPayout.toString(),
          // Engine-replay inputs embedded for the BROWSER verifier (canonical
          // surface per plan §0 #5). Without these the client-side
          // `isSlotsOutcome` guard rejects the row and the verifier shows
          // an error instead of replaying. Server-side /verify can read
          // cursorBefore from slot_spins as a fallback; embedding here lets
          // the browser run without a second round-trip and matches the
          // engine-version pin pattern (plan §9 #engine drift).
          cursorBefore: session.cursorCounter,
          cursorAfter: spinResult.cursorAfter,
          predict: predictBig.toString(),
          nonce: session.nonceCounter,
          paytableVersion: spinRow.paytableVersion,
          ...(autonomousActionId
            ? { autonomous: true, autonomousActionId }
            : {}),
        },
        serverSeedHash: session.serverSeedHash,
        revealedServerSeed: null,
        clientSeed: session.clientSeed,
        nonce: session.nonceCounter,
        txSignature: null,
        engineVersion: `slot-engine-${spinRow.paytableVersion ?? 'v2'}`,
      });

      // Update session counters.
      const newNonce = session.nonceCounter + 1;
      const newCursor = spinResult.cursorAfter;
      // Phase 6.1.5 — totalStaked counts only DEBITED predicts. Free
      // spins do not add to totalStaked (they are free); RTP analysis
      // and Money-safety invariant depend on this.
      const newTotalStaked = isFreeSpinSpin
        ? lockRow.total_staked
        : (BigInt(lockRow.total_staked) + predictBig).toString();
      const newTotalWon = (BigInt(lockRow.total_won) + winAmountBig).toString();
      // escrowAmount stays '0' on the ClawTokens path — no reservation was
      // made at open time, so there's nothing to drain. Phase 6.2 SOL/USDC
      // will pre-fund the column and decrement here.
      const oldEscrow = BigInt(lockRow.escrow_amount);
      const newEscrow = !isFreeSpinSpin && oldEscrow > predictBig
        ? (oldEscrow - predictBig).toString()
        : (isFreeSpinSpin ? lockRow.escrow_amount : '0');
      const newSpinCount = lockRow.spin_count + 1;
      // currentBalance is net session P&L (signed). On a free spin we
      // don't subtract the predict — only the winAmount counts up.
      const debitDelta = isFreeSpinSpin ? 0n : predictBig;
      const newCurrentBalance = (
        BigInt(lockRow.total_won) +
        winAmountBig -
        (BigInt(lockRow.total_staked) + debitDelta)
      ).toString();

      // Phase 6.1.5 — mode + free_spins_remaining state machine.
      //   • If this spin was a FREE spin, decrement the remaining counter.
      //   • If this spin awarded free spins (scatters >= 3), add them
      //     (capped at CAP_REMAINING) and flip mode to 'free-spin'.
      //   • When remaining hits 0 after a free spin, flip back to 'base'.
      let newMode = lockRow.mode;
      let newFreeSpinsRemaining = lockRow.free_spins_remaining;
      if (isFreeSpinSpin) {
        newFreeSpinsRemaining = Math.max(0, newFreeSpinsRemaining - 1);
      }
      if (spinResult.freeSpinsAwarded > 0) {
        newFreeSpinsRemaining = Math.min(
          FREE_SPIN_RULES.CAP_REMAINING,
          newFreeSpinsRemaining + spinResult.freeSpinsAwarded,
        );
        newMode = 'free-spin';
      }
      if (newFreeSpinsRemaining <= 0) {
        newMode = 'base';
        newFreeSpinsRemaining = 0;
      }

      const [updated] = await tx
        .update(slotSessions)
        .set({
          nonceCounter: newNonce,
          cursorCounter: newCursor,
          totalStaked: newTotalStaked,
          totalWon: newTotalWon,
          escrowAmount: newEscrow,
          currentBalance: newCurrentBalance,
          spinCount: newSpinCount,
          mode: newMode,
          freeSpinsRemaining: newFreeSpinsRemaining,
          lastSpinAt: new Date(),
        })
        .where(eq(slotSessions.id, session.id))
        .returning();
      if (!updated) {
        throw new HTTPException(500, { message: 'session_update_failed' });
      }

      // Credit winnings (if any). Phase 6.7.5: guest sessions skip the
      // ClawTokens ledger entirely — winAmount flows through the demo
      // balance via `totalWon` (already incremented above on `updated`).
      let creditBalance = debitBalance;
      if (winAmountBig > 0n) {
        if (winAmountBig > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new HTTPException(500, {
            message: 'win_amount_exceeds_int4_range',
          });
        }
        if (isLedgerSubject(subject) && avatar) {
          const credit = await creditClawTokens(
            {
              avatarId: avatar.id,
              amount: Number(winAmountBig),
              reason: 'cove_slots_win',
              source: 'api',
              metadata: {
                sessionId: session.id,
                spinId: spinRow.id,
                nonce: session.nonceCounter,
              },
              actorKind: subject.kind === 'user' ? 'human' : 'agent',
            },
            tx,
          );
          creditBalance = credit.balanceAfter;
        } else {
          // Guest: bump the running demo balance by the win amount.
          creditBalance = debitBalance + Number(winAmountBig);
        }
      }

      return {
        spinId: spinRow.id,
        session: updated,
        balanceAfter: creditBalance,
      };
    });
    spinRowId = result.spinId;
    finalSession = result.session;
    balanceAfter = result.balanceAfter;
  } catch (err) {
    // Race winner already inserted the same (sessionId, idempotencyKey)
    // — fall back to the cached path and return its result. Without
    // this, the loser bubbles a 500 to the client.
    const pgCode = (err as { code?: string } | undefined)?.code;
    if (pgCode === '23505') {
      const cachedRetry = await db.query.slotSpins.findFirst({
        where: and(
          eq(slotSpins.sessionId, session.id),
          eq(slotSpins.idempotencyKey, idempotencyKey),
        ),
      });
      if (cachedRetry) {
        // Same Stripe-style guard as the fast-path: a concurrent retry
        // that won the race MUST still have used the same predict, otherwise
        // the second caller is replaying at a different stake. Fail closed.
        if (cachedRetry.predict !== input.predict) {
          throw new HTTPException(409, {
            message: `idempotency_key_reused_with_different_args: cached predict=${cachedRetry.predict}, new predict=${input.predict}. Use a fresh Idempotency-Key.`,
          });
        }
        const fresh = await db.query.slotSessions.findFirst({
          where: eq(slotSessions.id, session.id),
        });
        const balanceAfter = isLedgerSubject(subject)
          ? (await loadAvatarForUser(subject.userId)).clawTokens
          : Number(
              BigInt(fresh?.startingBalance ?? session.startingBalance) +
                BigInt(fresh?.totalWon ?? session.totalWon) -
                BigInt(fresh?.totalStaked ?? session.totalStaked),
            );
        const response: SpinResponse = {
          spinId: cachedRetry.id,
          reels: cachedRetry.reels as SpinResult['reels'],
          // Stored already-serialized — pass through.
          winningLines: cachedRetry.winningLines as SpinResponse['winningLines'],
          winAmount: cachedRetry.winAmount,
          freeSpinsAwarded: BigInt(cachedRetry.scatterPayout) > 0n
            ? (cachedRetry.isFreeSpin
              ? FREE_SPIN_RULES.AWARD_RETRIGGER
              : FREE_SPIN_RULES.AWARD_BASE)
            : 0,
          isFreeSpin: cachedRetry.isFreeSpin,
          wildMultipliers: cachedRetry.wildMultipliers as SerializedWildMultiplier[],
          scatterPayout: cachedRetry.scatterPayout,
          cursorAfter: cachedRetry.cursorAfter,
          predict: cachedRetry.predict,
          balance: balanceAfter,
          escrowRemaining: fresh?.escrowAmount ?? session.escrowAmount,
          totalStaked: fresh?.totalStaked ?? session.totalStaked,
          totalWon: fresh?.totalWon ?? session.totalWon,
          spinCount: fresh?.spinCount ?? session.spinCount,
          mode: (fresh?.mode ?? session.mode) as 'base' | 'free-spin',
          freeSpinsRemaining: fresh?.freeSpinsRemaining ?? session.freeSpinsRemaining,
          idempotencyReplay: true,
        };
        return c.json(response, 200);
      }
    }
    throw err;
  }

  // Durable settle row (UNCHANGED shape) — capture events.id for the D7 slice-1
  // live settlement-confirm cursor. Write is byte-identical to before.
  const settleLogP = logEventFromContextReturningId(c, {
    eventType: 'cove.slots.spin.executed',
    userId: ledgerUserId(subject),
    avatarId: avatar?.id ?? null,
    agentId: subject.kind === 'agent' ? subject.agentId : null,
    payload: {
      sessionId: session.id,
      spinId: spinRowId,
      predict: predictBig.toString(),
      winAmount: winAmountBig.toString(),
      nonce: session.nonceCounter,
      isGuest: subject.kind === 'guest',
      isAgent: subject.kind === 'agent',
    },
  });
  // D7 slice-1 (DELIVERY-ONLY; money-lens review): live settlement-confirm to an
  // ONLINE agent. Durability is the row above; fire-and-forget, never affects
  // settlement. This is the FRESH-spin executor — idempotent replays return
  // early upstream (idempotency fast-path) and never reach here, so no replay
  // gate is needed. The LIVE frame below carries only spin facts (no session
  // id). NOTE: the durable row above — and thus the /events/replay + SSE
  // catch-up path — DOES include `sessionId: session.id`; that is the slot-GAME
  // session UUID, NOT the X-Clawville-Agent-Session bearer, so replaying it
  // leaks no credential (the write-side sanitizer would redact a real bearer).
  if (subject.kind === 'agent') {
    publishCoveSettlement({
      agentId: subject.agentId,
      game: 'slots',
      eventIdPromise: settleLogP,
      payload: {
        spinId: spinRowId,
        predict: predictBig.toString(),
        winAmount: winAmountBig.toString(),
      },
    });
  } else {
    void settleLogP;
  }

  const serialized = serializeSpinResult(spinResult);
  const response: SpinResponse = {
    spinId: spinRowId,
    ...serialized,
    predict: predictBig.toString(),
    balance: balanceAfter,
    escrowRemaining: finalSession.escrowAmount,
    totalStaked: finalSession.totalStaked,
    totalWon: finalSession.totalWon,
    spinCount: finalSession.spinCount,
    mode: finalSession.mode as 'base' | 'free-spin',
    freeSpinsRemaining: finalSession.freeSpinsRemaining,
    idempotencyReplay: false,
  };
  return c.json(response, 200);
});

// ─── POST /session/close ──────────────────────────────────────────────────
//
// Subject-resolved (NOT requireAuth) so a connected AGENT can close its own
// session and reveal the seed — without this the agent could never satisfy the
// commit-reveal fairness promise and its session would wedge open forever.
// Ledger subjects only (human or agent): a guest demo session has no persistent
// fairness contract to honor and the prior Lucia-only gate already excluded
// guests here, so we keep that exclusion (403) rather than widening it.
// Ownership is enforced via ownerMatches (userId for a ledger subject), so an
// agent can only ever close its own bound avatar's session.

export class AutonomousCoveSlotsError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'AutonomousCoveSlotsError';
  }
}

type ResolvedAutonomousCoveAgent = NonNullable<Awaited<ReturnType<typeof resolveAgentSession>>>;

export interface AutonomousCoveSlotsDependencies {
  resolveAgent: (sessionId: string) => Promise<ResolvedAutonomousCoveAgent | null>;
  findOpenSession: (userId: string) => Promise<SlotSession | undefined>;
  readDailyWagerUsed: (avatarId: string) => Promise<number>;
  request: (path: string, init: RequestInit) => Promise<Response>;
}

function autonomousCoveUtcDayStart(now = new Date()): Date {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  return dayStart;
}

function autonomousCoveDailyUsageQuery(avatarId: string, now = new Date()) {
  const dayStart = autonomousCoveUtcDayStart(now);
  return sql`
    SELECT COALESCE(SUM(-amount), 0)::text AS used_vclaw
    FROM claw_token_transactions
    WHERE avatar_id = ${avatarId}
      AND amount < 0
      AND created_at >= ${dayStart.toISOString()}::timestamptz
      AND metadata ->> 'autonomousCove' = 'true'
  `;
}

function parseAutonomousCoveDailyUsage(rows: Array<{ used_vclaw: string }>): number {
  const usedToday = Number(rows[0]?.used_vclaw ?? '0');
  if (!Number.isSafeInteger(usedToday) || usedToday < 0) {
    throw new Error('autonomous cove daily wager usage is outside safe integer range');
  }
  return usedToday;
}

function autonomousCoveDailyCapMessage(usedToday: number, requested: number): string | null {
  const dailyCap = resolveAgentCovePlayDailyWagerVclaw();
  return usedToday > dailyCap - requested
    ? `agent_cove_daily_wager_cap_exceeded: cap=${dailyCap}, used=${usedToday}, requested=${requested}`
    : null;
}

async function readAutonomousCoveDailyWagerUsed(avatarId: string): Promise<number> {
  const rows = await db.execute<{ used_vclaw: string }>(autonomousCoveDailyUsageQuery(avatarId));
  return parseAutonomousCoveDailyUsage(rows);
}

const DEFAULT_AUTONOMOUS_COVE_SLOTS_DEPS: AutonomousCoveSlotsDependencies = {
  resolveAgent: resolveAgentSession,
  findOpenSession: async (userId) => db.query.slotSessions.findFirst({
    where: and(eq(slotSessions.userId, userId), eq(slotSessions.status, 'open')),
  }),
  readDailyWagerUsed: readAutonomousCoveDailyWagerUsed,
  request: async (path, init) => coveSlotsRouter.request(path, init),
};

async function readInternalCoveResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = {};
  try { payload = text ? JSON.parse(text) : {}; }
  catch { payload = { message: text }; }
  if (!response.ok) {
    const detail = payload as { message?: string; error?: string };
    const message = detail.message ?? detail.error ?? `cove_slots_http_${response.status}`;
    const code = message.startsWith('agent_cove_daily_wager_cap_exceeded')
      ? 'daily_cap_exceeded'
      : message.split(':', 1)[0] || 'cove_play_failed';
    throw new AutonomousCoveSlotsError(code, response.status, message);
  }
  return payload as T;
}

/** In-process adapter around the audited human/agent slots route core. */
export async function playAutonomousCoveSlots(input: {
  agentSessionId: string;
  actionId: string;
  wager: number;
}, dependencyOverrides: Partial<AutonomousCoveSlotsDependencies> = {}): Promise<SpinResponse> {
  const dependencies = { ...DEFAULT_AUTONOMOUS_COVE_SLOTS_DEPS, ...dependencyOverrides };
  if (
    !Number.isSafeInteger(input.wager)
    || input.wager < COVE_SLOTS_MIN_BET
    || input.wager > COVE_SLOTS_MAX_BET
    || input.wager % COVE_SLOTS_BET_STEP !== 0
  ) {
    throw new AutonomousCoveSlotsError('invalid_wager', 400, 'invalid_wager');
  }
  const resolved = await dependencies.resolveAgent(input.agentSessionId);
  if (!resolved) throw new AutonomousCoveSlotsError('invalid_or_expired_agent_session', 401, 'invalid_or_expired_agent_session');
  if (!resolved.ledgerCapable) throw new AutonomousCoveSlotsError('agent_session_not_ledger_authorized', 403, 'agent_session_not_ledger_authorized');
  if (!resolved.userId || !resolved.avatarId) throw new AutonomousCoveSlotsError('agent_session_has_no_active_avatar', 403, 'agent_session_has_no_active_avatar');
  if (!z.string().uuid().safeParse(input.actionId).success) {
    throw new AutonomousCoveSlotsError('invalid_action_id', 400, 'invalid_action_id');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [AGENT_SESSION_HEADER]: input.agentSessionId,
  };
  const existing = await dependencies.findOpenSession(resolved.userId);

  // Read-only fail-closed preflight BEFORE close/open can mutate the existing
  // session. The advisory-locked check in /spin remains authoritative against
  // races. A matching free-spin session has no debit and therefore consumes no
  // daily wager capacity; a mismatched session will be replaced by a base spin.
  const nextSpinConsumesWager = !(
    existing
    && existing.startingBalance === String(input.wager)
    && existing.mode === 'free-spin'
    && existing.freeSpinsRemaining > 0
  );
  if (nextSpinConsumesWager) {
    const usedToday = await dependencies.readDailyWagerUsed(resolved.avatarId);
    const capMessage = autonomousCoveDailyCapMessage(usedToday, input.wager);
    if (capMessage) {
      throw new AutonomousCoveSlotsError('daily_cap_exceeded', 429, capMessage);
    }
  }
  if (existing && existing.startingBalance !== String(input.wager)) {
    const closed = await dependencies.request('/session/close', {
      method: 'POST', headers, body: JSON.stringify({ sessionId: existing.id }),
    });
    await readInternalCoveResponse<CloseSessionResponse>(closed);
  }

  const opened = await dependencies.request('/session/open', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      paytableId: existing?.startingBalance === String(input.wager)
        ? existing.paytableId
        : 'classic-3x5',
      currency: 'clawtokens',
      predict: String(input.wager),
    }),
  });
  const open = await readInternalCoveResponse<OpenSessionResponse>(opened);
  if (open.startingBalance !== String(input.wager)) {
    throw new AutonomousCoveSlotsError('session_wager_mismatch', 409,
      `session_wager_mismatch: expected=${input.wager}, actual=${open.startingBalance}`);
  }

  const spun = await dependencies.request('/spin', {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': `auto:${input.actionId}`,
      [AUTONOMOUS_COVE_HEADER]: autonomousCoveToken,
      [AUTONOMOUS_COVE_ACTION_HEADER]: input.actionId,
    },
    body: JSON.stringify({ sessionId: open.sessionId, predict: String(input.wager) }),
  });
  return readInternalCoveResponse<SpinResponse>(spun);
}

coveSlotsRouter.post('/session/close', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = closeSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'invalid_input: ' + parsed.error.message,
    });
  }
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_cannot_close_session: sign in or connect an agent' });
  }

  const session = await db.query.slotSessions.findFirst({
    where: eq(slotSessions.id, parsed.data.sessionId),
  });
  if (!session) {
    throw new HTTPException(404, { message: 'session_not_found' });
  }
  if (!ownerMatches(session, subject)) {
    throw new HTTPException(403, { message: 'session_not_owned' });
  }
  if (session.status !== 'open') {
    throw new HTTPException(409, {
      message: `session_not_open: status=${session.status}`,
    });
  }

  const avatar = await loadAvatarForUser(subject.userId);

  const { closedSession, finalBalance } = await db.transaction(async (tx) => {
    // Lock the session row so we don't race another /close (or a
    // /session/expire cron) toggling status under us.
    const lockRows = await tx.execute<{ status: string; escrow_amount: string }>(
      sql`SELECT status, escrow_amount FROM slot_sessions WHERE id = ${session.id} FOR UPDATE`,
    );
    const lockRow = lockRows[0];
    if (!lockRow) {
      throw new HTTPException(404, { message: 'session_not_found' });
    }
    if (lockRow.status !== 'open') {
      throw new HTTPException(409, {
        message: `session_not_open: status=${lockRow.status}`,
      });
    }

    // No refund on close. ClawTokens path never reserves anything at
    // open time (see file docstring — money model), so escrow is always
    // '0' here and finalBalance is the player's real-time avatar balance
    // (re-read inside the txn so racing spins from a different request
    // don't show a stale snapshot). The Phase 6.2 SOL/USDC path will add
    // an on-chain settlement step in a sibling code branch, not here.
    //
    // Defense-in-depth: if a bug ever lets escrow drift > 0 on the
    // ClawTokens currency, fail closed so we don't silently double-pay.
    const escrowBig = BigInt(lockRow.escrow_amount);
    if (escrowBig !== 0n) {
      throw new HTTPException(500, {
        message: `escrow_unexpected_nonzero_on_clawtokens_close: escrow=${lockRow.escrow_amount}`,
      });
    }
    const balRows = await tx.execute<{ claw_tokens: number }>(
      sql`SELECT claw_tokens FROM avatars WHERE id = ${avatar.id}`,
    );
    const finalBal = balRows[0]?.claw_tokens ?? avatar.clawTokens;

    const [closed] = await tx
      .update(slotSessions)
      .set({
        status: 'closed',
        escrowAmount: '0',
        closedAt: new Date(),
      })
      .where(eq(slotSessions.id, session.id))
      .returning();
    if (!closed) {
      throw new HTTPException(500, { message: 'session_close_failed' });
    }

    // Phase 6.7.0 — reveal the serverSeed on every cove_game_events row
    // for this session. The commit-reveal contract (plan §0 #2) requires
    // that once the shoe closes, the revealed preimage is published so
    // any third party can run sha256(revealedServerSeed) === serverSeedHash
    // and replay each spin deterministically. This UPDATE runs in the
    // same transaction as the session close so the two states never drift.
    await tx
      .update(coveGameEvents)
      .set({ revealedServerSeed: closed.serverSeed })
      .where(
        and(
          eq(coveGameEvents.sessionId, session.id),
          eq(coveGameEvents.gameType, 'slots'),
        ),
      );

    return { closedSession: closed, finalBalance: finalBal };
  });

  void logEventFromContext(c, {
    eventType: 'cove.slots.session.closed',
    userId: subject.userId,
    avatarId: avatar.id,
    agentId: subject.kind === 'agent' ? subject.agentId : null,
    payload: {
      sessionId: closedSession.id,
      paytableId: closedSession.paytableId,
      spinCount: closedSession.spinCount,
      totalStaked: closedSession.totalStaked,
      totalWon: closedSession.totalWon,
      isAgent: subject.kind === 'agent',
    },
  });

  const response: CloseSessionResponse = {
    sessionId: closedSession.id,
    status: 'closed',
    serverSeed: closedSession.serverSeed,
    serverSeedHash: closedSession.serverSeedHash,
    clientSeed: closedSession.clientSeed,
    totalStaked: closedSession.totalStaked,
    totalWon: closedSession.totalWon,
    spinCount: closedSession.spinCount,
    finalBalance,
    closedAt: (closedSession.closedAt ?? new Date()).toISOString(),
  };
  return c.json(response, 200);
});

// ─── GET /session/current ─────────────────────────────────────────────────
//
// Returns the user's currently-open session (status='open') if any, else 404.
// Used by the slot modal on mount to restore session state after a page
// refresh — the Zustand store wipes on reload but the server session is
// durable until /close. Without this endpoint, refresh-during-mid-spin would
// orphan the session and the next /open would race the idempotent path on
// the first SPIN click (cleaner UX to discover the open session eagerly).

// Subject-resolved (ledger subjects only) so a connected agent can restore its
// open session after a reconnect, exactly like a human after a page refresh. An
// agent + its bound human share one userId-keyed session, so both see the same row.
coveSlotsRouter.get('/session/current', noStorePrivate, async (c) => {
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_has_no_persistent_session: sign in or connect an agent' });
  }
  const row = await db.query.slotSessions.findFirst({
    where: and(
      eq(slotSessions.userId, subject.userId),
      eq(slotSessions.status, 'open'),
    ),
  });
  if (!row) {
    throw new HTTPException(404, { message: 'no_open_session' });
  }
  // Include the authoritative wallet balance so the client can snapshot
  // it as the PnL baseline without a second round-trip (mirrors the
  // `walletBalance` field on /session/open's response).
  const avatar = await loadAvatarForUser(subject.userId);
  return c.json({
    session: publicSession(row),
    walletBalance: avatar.clawTokens,
  }, 200);
});

// ─── GET /session/:id ─────────────────────────────────────────────────────

// Subject-resolved (ledger subjects only) so an agent can inspect its own
// session; ownerMatches binds to the resolved userId, so an agent can never read
// another user's session by id.
coveSlotsRouter.get('/session/:id', noStorePrivate, async (c) => {
  const sessionId = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    throw new HTTPException(400, { message: 'invalid_session_id' });
  }
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_cannot_inspect_session: sign in or connect an agent' });
  }
  const row = await db.query.slotSessions.findFirst({
    where: eq(slotSessions.id, sessionId),
  });
  if (!row) {
    throw new HTTPException(404, { message: 'session_not_found' });
  }
  if (!ownerMatches(row, subject)) {
    throw new HTTPException(403, { message: 'session_not_owned' });
  }
  return c.json({ session: publicSession(row) }, 200);
});

// ─── GET /session/:id/spins ───────────────────────────────────────────────

// Subject-resolved (ledger subjects only), owner-only — an agent can page its own
// session's spin history (read-only, no money). ownerMatches binds to the resolved
// userId so an agent can never read another user's spins.
coveSlotsRouter.get('/session/:id/spins', noStorePrivate, async (c) => {
  const sessionId = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    throw new HTTPException(400, { message: 'invalid_session_id' });
  }
  const queryParsed = spinsQuerySchema.safeParse({
    limit: c.req.query('limit'),
  });
  if (!queryParsed.success) {
    throw new HTTPException(400, {
      message: 'invalid_query: ' + queryParsed.error.message,
    });
  }
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_cannot_inspect_session: sign in or connect an agent' });
  }
  const session = await db.query.slotSessions.findFirst({
    where: eq(slotSessions.id, sessionId),
    columns: { id: true, userId: true, guestFpHash: true },
  });
  if (!session) {
    throw new HTTPException(404, { message: 'session_not_found' });
  }
  if (!ownerMatches(session, subject)) {
    throw new HTTPException(403, { message: 'session_not_owned' });
  }
  const rows = await db
    .select()
    .from(slotSpins)
    .where(eq(slotSpins.sessionId, sessionId))
    .orderBy(desc(slotSpins.createdAt))
    .limit(queryParsed.data.limit);

  return c.json(
    {
      spins: rows.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        nonce: r.nonce,
        cursorBefore: r.cursorBefore,
        cursorAfter: r.cursorAfter,
        predict: r.predict,
        isFreeSpin: r.isFreeSpin,
        reels: r.reels,
        winningLines: r.winningLines,
        winAmount: r.winAmount,
        wildMultipliers: r.wildMultipliers,
        scatterPayout: r.scatterPayout,
        idempotencyKey: r.idempotencyKey,
        paytableVersion: r.paytableVersion,
        createdAt: r.createdAt.toISOString(),
      })),
    },
    200,
  );
});

// ─── GET /paytables/:id (public) ──────────────────────────────────────────

coveSlotsRouter.get('/paytables/:id', async (c) => {
  const id = c.req.param('id');
  if (id !== 'classic-3x5' && id !== 'classic-3x5-bonus') {
    throw new HTTPException(404, { message: 'paytable_not_found' });
  }
  const response = buildPaytableResponse(id);
  return c.json(response, 200);
});

// ─── POST /verify (public; pure compute) ──────────────────────────────────

coveSlotsRouter.post('/verify', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'invalid_input: ' + parsed.error.message,
    });
  }
  const input = parsed.data;
  const predictBig = BigInt(input.predict);
  if (predictBig <= 0n) {
    throw new HTTPException(400, { message: 'predict_must_be_positive' });
  }

  let result: SpinResult;
  try {
    result = runSpin({
      paytableId: input.paytableId,
      serverSeed: input.serverSeed,
      clientSeed: input.clientSeed,
      nonce: input.nonce,
      cursor: input.cursor,
      predict: predictBig,
    });
  } catch (err) {
    throw new HTTPException(400, {
      message: `verify_failed: ${(err as Error).message}`,
    });
  }

  return c.json(serializeSpinResult(result), 200);
});

export default coveSlotsRouter;
