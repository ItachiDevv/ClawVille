/**
 * Phase 6.4.1 — Cove blackjack AUTHORITATIVE route (replaces the 6.4.0 mock).
 *
 * Mount: `app.route('/api/cove/blackjack', coveBlackjackRouter)` from index.ts.
 *
 * Surfaces:
 *
 *   POST /session/open    (auth optional) — open a commit-reveal SHOE, commit serverSeedHash
 *   POST /hand/deal       (auth optional) — start a hand (insurance offered if dealer-Ace)
 *   POST /action          (auth optional) — hit / stand / double / split / surrender / insure
 *   POST /session/close   (user or agent) — close the shoe + reveal serverSeed
 *   GET  /session/current (user or agent) — restore the open shoe after refresh/reconnect
 *   GET  /session/:id      (user or agent) — owner-only shoe detail (serverSeed redacted while open)
 *
 * Model mirrors cove-slots.ts (the audited template), EXTENDED for agent parity:
 *   - getSubject(c): authed human (Lucia) OR a connected/hosted AGENT playing AS
 *     ITSELF (X-Clawville-Agent-Session header → its bound avatar's userId) OR a
 *     guest (100 demo CT). Human + agent are BOTH real-CT "ledger subjects" — an
 *     agent shoe is just a `userId` shoe, so the DB `userId XOR guestFpHash`
 *     check constraint still holds and the audited settle path is reused
 *     verbatim (the agent kind adds NO new money branch — see `isLedgerSubject`).
 *     Agents are NEVER routed to the guest/demo tier (Rule E5 parity fix). Guests
 *     never touch the ClawTokens ledger; demo balance lives on the shoe row
 *     (startingBalance + totalPayout - totalBet).
 *   - SETTLEMENT vs LEADERBOARD (parity scope, 2026-06-03): for a ledger subject
 *     (human OR agent) this route does REAL CT ledger settlement, and that part
 *     has full human/agent parity. It does NOT, however, emit any
 *     leaderboard-scoring event: cove blackjack writes NO `activity.match.placed`
 *     for ANY subject (human or agent). Leaderboard credit for cove blackjack is
 *     therefore a SEPARATE, PRE-EXISTING gap, not an agent-only gap. Adding it
 *     must be done for BOTH paths together in a dedicated change so parity is
 *     preserved (a human-only or agent-only scoring emit would be a fresh E5
 *     violation).
 *   - claw-token-ledger.debit/creditClawTokens is the ONLY balance write path,
 *     composed into the settle transaction via the passed `tx`.
 *   - One commit-reveal SHOE = one slot-session analogue. Reshuffle at 75%
 *     penetration is a NEW shoe (new seed pair): /hand/deal returns a 409
 *     `reshuffled` flag when `dealtCount >= RESHUFFLE_CARD_THRESHOLD` so the
 *     client opens a fresh shoe. The engine never reshuffles mid-shoe.
 *   - One cove_game_events row PER HAND (gameType='blackjack', sessionId=shoeId,
 *     nonce=handIndex, serverSeedHash at open, revealedServerSeed NULL until
 *     shoe close).
 *   - Settle is idempotent: a hand's status flips in_progress→settled exactly
 *     once UNDER the shoe FOR UPDATE row lock; a re-POST to a settled hand is a
 *     pure replay of the stored outcome — never a second credit. An
 *     Idempotency-Key (per terminal action) is the race-safe backstop via the
 *     partial unique index (shoeId, idempotencyKey).
 *   - The engine recompute happens UNDER the shoe row lock with the
 *     authoritative counters (cursorBefore / dealtBefore / handIndex) so a
 *     stale pre-lock read can never commit a different outcome.
 *
 * Server is AUTHORITATIVE: the client NEVER sends cards or outcomes. It sends
 * only its decision (hit/stand/...) + bet at deal time. The engine
 * (blackjack-engine.ts) re-derives every card from (serverSeed, clientSeed,
 * nonce=handIndex, cursor) — the same commit-reveal contract as slots.
 *
 * Currency seam: `currency` defaults to 'clawtoken'. SOL/USDC return 501 until
 * the later tier wires custody — exactly like cove-slots. NO escrow here.
 *
 * Guest demo-CT farming — ACCEPTED RISK (mirrors cove-slots' documented posture).
 * A guest who rotates the `X-CV-Fingerprint` header gets a new fp_hash → a new
 * subject → a fresh 100 demo-CT shoe, and the in-memory hourly open bucket
 * (keyed on fp_hash, per-process, reset on redeploy) never trips. This is
 * "best-effort, not a hard ceiling — acceptable for fun-money guest demo;
 * tighten when guest real-money lands." It is safe TODAY because the guest
 * path NEVER touches `avatars.clawTokens` or the ClawToken ledger: demo balance
 * lives entirely on the shoe row (startingBalance + totalPayout − totalBet),
 * `newDemo < 0n` is rejected at settle, and guest play feeds NOTHING persistent
 * (no leaderboard points, no CT that converts to real value). Blast radius is
 * free unlimited demo play, NOT custody loss. WHEN the SOL/USDC tier lands the
 * real-money path MUST NOT reuse this guest demo-balance accounting — it must
 * carry its own durable per-subject grant ledger before any real funds flow.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  avatars,
  blackjackShoes,
  blackjackHands,
  coveGameEvents,
  agentBots,
  type BlackjackShoe,
  type BlackjackHand,
} from '@clawville/database';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import { resolveAgentSession } from '../middleware/require-auth-or-agent';
import { isGuestUser } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import { npcSimulation } from '../services/npc-simulation';
import { createServerSeed } from '../services/provable-rng';
import {
  playHand,
  playHandWithState,
  serializeHandResult,
  computeBlackjackRake,
  buildShoe,
  RESHUFFLE_CARD_THRESHOLD,
  BLACKJACK_ENGINE_VERSION,
  type HandScript,
  type HandResult,
  type SerializedHandResult,
  type BlackjackActionType,
  type Card,
} from '../services/blackjack-engine';
import {
  creditClawTokens,
  debitClawTokens,
  InsufficientTokensError,
} from '../services/claw-token-ledger';
import { getHouseTreasuryAvatarId } from '../services/house-treasury-seeder';
import { logEventFromContext, logEventFromContextReturningId } from '../services/event-logger';
import { publishCoveSettlement } from '../services/agent-settlement-publish';
import { recordBlackjackSkillMemory } from '../services/game-skill-memory';
import type { AppContext } from '../types';

export const coveBlackjackRouter = new Hono<AppContext>();
coveBlackjackRouter.use('*', sessionMiddleware);

// ─── Constants ──────────────────────────────────────────────────────────────

/** Bet bounds (LOCKED rule): 5–500 CT. Engine only asserts bet > 0n. */
export const BLACKJACK_MIN_BET = 5;
export const BLACKJACK_MAX_BET = 500;

/** Currency seam — ClawTokens live; SOL/USDC return 501 (later tier). */
const SUPPORTED_CURRENCIES = ['clawtoken', 'sol', 'usdc'] as const;

/** Max length on the Idempotency-Key header (Stripe convention; matches slots). */
const IDEMPOTENCY_KEY_MAX_LEN = 64;

/** Guest demo wallet (fun-money), mirrors cove-slots guest tier. */
const GUEST_STARTING_BALANCE = 100n;

// ─── Rate limits (mirror cove-slots) ─────────────────────────────────────────

interface RateBucket {
  count: number;
  resetAt: number;
}

const ACTION_RATE_LIMIT = 120; // blackjack is chattier than slots (per-decision)
const ACTION_RATE_WINDOW_MS = 60_000;
const actionRateBuckets = new Map<string, RateBucket>();

function checkActionRate(key: string): void {
  const now = Date.now();
  if (actionRateBuckets.size > 5_000) {
    for (const [k, v] of actionRateBuckets) {
      if (now > v.resetAt) actionRateBuckets.delete(k);
    }
  }
  const entry = actionRateBuckets.get(key);
  if (!entry || now > entry.resetAt) {
    actionRateBuckets.set(key, { count: 1, resetAt: now + ACTION_RATE_WINDOW_MS });
    return;
  }
  entry.count++;
  if (entry.count > ACTION_RATE_LIMIT) {
    throw new HTTPException(429, {
      message: `cove_blackjack_rate_limit: max ${ACTION_RATE_LIMIT} actions/min`,
    });
  }
}

// Guest open-shoe throttle. NOTE (accepted risk — see the route header): this
// in-memory, per-process bucket keyed on fp_hash is best-effort, not a hard
// ceiling. A fingerprint-rotating guest defeats it. Acceptable because the
// guest path never touches real tokens (demo balance lives on the shoe row);
// the SOL/USDC tier must add a durable per-subject grant ledger before reuse.
const GUEST_SHOE_OPEN_LIMIT = 10;
const GUEST_SHOE_OPEN_WINDOW_MS = 60 * 60 * 1_000;
const guestShoeOpenBuckets = new Map<string, RateBucket>();

function checkGuestShoeOpenRate(fpHash: string): void {
  const now = Date.now();
  if (guestShoeOpenBuckets.size > 10_000) {
    for (const [k, v] of guestShoeOpenBuckets) {
      if (now > v.resetAt) guestShoeOpenBuckets.delete(k);
    }
  }
  const entry = guestShoeOpenBuckets.get(fpHash);
  if (!entry || now > entry.resetAt) {
    guestShoeOpenBuckets.set(fpHash, { count: 1, resetAt: now + GUEST_SHOE_OPEN_WINDOW_MS });
    return;
  }
  entry.count++;
  if (entry.count > GUEST_SHOE_OPEN_LIMIT) {
    throw new HTTPException(429, {
      message: `cove_blackjack_guest_shoe_rate_limit: max ${GUEST_SHOE_OPEN_LIMIT} guest shoes/hour. Sign up to keep playing.`,
    });
  }
}

/** Test-only resets. */
export function __resetBlackjackRateLimits(): void {
  actionRateBuckets.clear();
  guestShoeOpenBuckets.clear();
}

// ─── Subject resolution (user OR agent OR guest, never combined) ─────────────
//
// THREE subject kinds (Rule E5 — human↔agent parity):
//   - 'user'  — Lucia-authed human. Settles in REAL CT on `avatars.clawTokens`.
//   - 'agent' — a connected/hosted agent playing AS ITSELF via the agent gateway
//     session header. It resolves through `resolveAgentSession` → its BOUND
//     avatar's `userId`/`avatarId`, and settles in the SAME real-CT ledger path
//     as a human (debit/creditClawTokens). An agent is NEVER routed to the guest
//     demo tier — that XOR-with-guest gap was the E5 violation this fixes.
//   - 'guest' - anonymous fingerprint, demo-CT only (no ledger). NOTE: no
//     subject (guest, human, or agent) earns leaderboard credit here. Cove
//     blackjack emits no activity.match.placed at all; see the SETTLEMENT vs
//     LEADERBOARD note in the file header.
//
// Money parity rule: 'user' and 'agent' are both LEDGER subjects (they carry a
// real `userId`/`avatarId` and write the ClawToken ledger). Only the in-world
// provenance + earned-skill-memory binding differ. `isLedgerSubject()` collapses
// the two for every balance/owner branch so the audited settle path is reused
// verbatim — the agent kind adds NO new money code path.
//
// The agent-session header name matches the existing activity-portal convention
// (`require-auth-or-agent.ts`); Hono lower-cases header reads so case-insensitive.

const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';

type BjSubject =
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
function guestDemoSubject(c: { get(key: 'fpHash'): string }): BjSubject {
  const fpHash = c.get('fpHash');
  if (!fpHash) {
    throw new HTTPException(500, { message: 'fpHash_missing_for_guest_request' });
  }
  return { kind: 'guest', userId: null, avatarId: null, agentId: null, sessionId: null, guestFpHash: fpHash };
}

/**
 * Resolve the request subject. Precedence: Lucia human → agent session → guest.
 *
 * Async (was sync) because the agent branch does a DB lookup to map the opaque
 * session id → bound avatar/user. The human + guest branches stay synchronous in
 * effect (no await on those paths) so existing latency is unchanged.
 *
 * An agent session header that resolves to a bot WITHOUT a bound active avatar
 * is a 403 (it can perceive/chat but cannot stake real CT) — it does NOT fall
 * through to the guest tier, because that would silently route a connected agent
 * into demo play (the exact E5 violation). A logged-in human cookie ALWAYS wins
 * over an agent header on the same request (so a human can't be impersonated by
 * smuggling a session header into their own authed call).
 */
async function getSubject(c: {
  get(key: 'user'): { id: string } | null;
  get(key: 'fpHash'): string;
  req: { header(name: string): string | undefined };
}): Promise<BjSubject> {
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
    // Ledger-capability gate (Codex auth-lens fix #2/#3, 2026-06-03). A session
    // that did NOT prove ownership of its bound avatar - an `agentId`-only
    // reconnect to an already-bound bot, or a legacy /openclaw/register session -
    // is `ledgerCapable === false`. It may perceive/chat/move in-world, but it
    // must NOT spend the avatar's REAL ClawTokens here. Reject with 403 BEFORE the
    // avatar-binding check - NOT a guest fall-through (silently demoting a
    // connected agent to demo play is the same E5 class of bug), NOT real-CT play.
    // A returning owner re-proves ownership via a fresh connect-token or the
    // signed-challenge reconnect to regain a ledger-capable session.
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
function ledgerUserId(subject: BjSubject): string | null {
  return subject.kind === 'guest' ? null : subject.userId;
}

/** True iff the subject settles in real CT (human or agent). */
function isLedgerSubject(
  subject: BjSubject,
): subject is Extract<BjSubject, { kind: 'user' | 'agent' }> {
  return subject.kind !== 'guest';
}

function subjectKey(subject: BjSubject): string {
  if (subject.kind === 'guest') return `g:${subject.guestFpHash}`;
  // 'user' and 'agent' rate-limit on userId — an agent and its bound human share
  // one avatar/wallet, so they SHOULD share one action-rate bucket (you can't
  // dodge the limit by toggling between cookie + agent header on one avatar).
  return `u:${subject.userId}`;
}

/**
 * A real-CT shoe is keyed on `userId` (NOT on agent/guest). Both human and agent
 * subjects for the same bound avatar therefore see + own the SAME shoe — exactly
 * right: an agent playing AS its avatar continues the human's session, never
 * forks a parallel one. Guests own by fingerprint.
 */
function ownerMatch(shoe: { userId: string | null; guestFpHash: string | null }, subject: BjSubject): boolean {
  return isLedgerSubject(subject)
    ? shoe.userId === subject.userId
    : shoe.guestFpHash === subject.guestFpHash;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const betSchema = z.number().int().min(BLACKJACK_MIN_BET).max(BLACKJACK_MAX_BET);

const openSchema = z
  .object({
    currency: z.enum(SUPPORTED_CURRENCIES).default('clawtoken'),
  })
  .strict();

const dealSchema = z
  .object({
    shoeId: z.string().uuid(),
    bet: betSchema,
    /** Insurance decided at deal time; only honored on a dealer-Ace upcard. */
    insurance: z.boolean().default(false),
    /**
     * OPTIONAL stale-agent-DEAL guard (Codex concurrency lens 2026-06-03,
     * BLOCKING #2) for the human-supervised Autonomous relay. The driver threads
     * the SHOE EPOCH it got from /agent/decide (`expectedHandsPlayed` =
     * shoe.handCounter at decision time). Under the shoe FOR UPDATE lock,
     * /hand/deal rejects (409 `stale_agent_deal`) if the shoe's handCounter has
     * advanced since (an intervening human deal already opened - and possibly
     * instantly natural-settled - a hand), so a stale in-flight agent 'deal'
     * cannot open an EXTRA unwanted hand. handCounter is the right epoch: it
     * strictly increments by exactly 1 at EVERY /hand/deal (open), independent of
     * whether the prior hand stayed in_progress or settled inline as a natural
     * (the `hand_in_progress` guard only catches the non-natural case). OMITTED on
     * every human manual deal, which keeps the unconditional legacy behavior.
     */
    expectedHandsPlayed: z.number().int().min(0).optional(),
  })
  .strict();

const ACTION_TYPES = ['hit', 'stand', 'double', 'split', 'surrender'] as const;

const actionSchema = z
  .object({
    handId: z.string().uuid(),
    action: z.enum(ACTION_TYPES),
    /** 0 = original/first hand; 1 = the second hand after a split. */
    handSlot: z.number().int().min(0).max(1).default(0),
    /**
     * OPTIONAL stale-decision guard for the human-supervised Autonomous relay.
     * The Autonomous driver threads the `handVersion` it got from /agent/decide
     * here; under the hand lock /action rejects (409) if the freshly-locked
     * hand's `handDecisionVersion` no longer matches — so a human tap beats a
     * stale in-flight agent decision server-side. OMITTED on every human manual
     * tap, which keeps the unconditional legacy behavior.
     */
    expectedHandVersion: z.number().int().optional(),
  })
  .strict();

const insureActionSchema = z
  .object({
    handId: z.string().uuid(),
    action: z.literal('insure'),
    /**
     * OPTIONAL stale-agent-decision guard for the human-supervised Autonomous
     * relay — parity with `actionSchema.expectedHandVersion`. The relay returns
     * `insure` with a live-hand `handVersion`; the driver threads it here, and
     * under the hand lock /action rejects (409 `stale_agent_decision`) if the
     * freshly-locked hand's `handDecisionVersion` no longer matches (a human
     * already acted). Without this, a stale agent insure decision could land on a
     * hand the human already advanced — or one that already settled — and the
     * settled-replay path would mis-handle it as an `{ tookInsurance }` ack.
     * OMITTED on every human manual insure tap, which keeps the unconditional
     * legacy behavior. MUST use the same version definition /action enforces.
     */
    expectedHandVersion: z.number().int().optional(),
  })
  .strict();

const closeSchema = z
  .object({
    shoeId: z.string().uuid(),
  })
  .strict();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadShoeOrThrow(shoeId: string): Promise<BlackjackShoe> {
  const shoe = await db.query.blackjackShoes.findFirst({ where: eq(blackjackShoes.id, shoeId) });
  if (!shoe) throw new HTTPException(404, { message: 'shoe_not_found' });
  return shoe;
}

async function loadAvatarForUser(userId: string): Promise<{ id: string; clawTokens: number }> {
  const row = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
    columns: { id: true, clawTokens: true },
  });
  if (!row) {
    throw new HTTPException(400, { message: 'no_active_avatar_for_user' });
  }
  return row;
}

/** Demo balance for a guest shoe: startingBalance + totalPayout - totalBet. */
function guestDemoBalance(shoe: {
  startingBalance: string;
  totalPayout: string;
  totalBet: string;
}): bigint {
  return BigInt(shoe.startingBalance) + BigInt(shoe.totalPayout) - BigInt(shoe.totalBet);
}

/**
 * Public shoe shape. serverSeed REDACTED while status='open' (revealing it
 * would let the player pre-compute future cards from the cursor — defeats
 * commit-reveal; identical reasoning to slots' publicSession).
 */
function publicShoe(row: BlackjackShoe) {
  return {
    id: row.id,
    userId: row.userId,
    currency: row.currency,
    serverSeedHash: row.serverSeedHash,
    clientSeed: row.clientSeed,
    handCounter: row.handCounter,
    cursorCounter: row.cursorCounter,
    dealtCount: row.dealtCount,
    startingBalance: row.startingBalance,
    currentBalance: row.currentBalance,
    totalBet: row.totalBet,
    totalPayout: row.totalPayout,
    status: row.status,
    handsPlayed: row.handsPlayed,
    createdAt: row.createdAt.toISOString(),
    lastHandAt: row.lastHandAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    serverSeed: row.status === 'open' ? null : row.serverSeed,
  };
}

/** A minimal shoe shape the engine-replay helpers need (seed + counters). */
interface ShoeSeedState {
  id: string;
  serverSeed: string;
  clientSeed: string;
}

/**
 * Drizzle's `tx.execute` returns ALL columns as strings (PG wire format). The
 * settle path reads the shoe via tx.execute for the FOR UPDATE lock, so we
 * normalize the integer/text columns it needs into a typed object.
 */
interface ShoeLockRow {
  id: string;
  server_seed: string;
  server_seed_hash: string;
  client_seed: string;
  cursor_counter: number | string;
  dealt_count: number | string;
  total_bet: string;
  total_payout: string;
  starting_balance: string;
  status: string;
  user_id: string | null;
  guest_fp_hash: string | null;
  // Index signature so the row type satisfies Drizzle's
  // `tx.execute<T extends Record<string, unknown>>` constraint.
  [key: string]: unknown;
}

/**
 * Reconstruct the exact remaining-shoe state at the START of `targetHandIndex`
 * by replaying every prior SETTLED hand's recorded script deterministically.
 * Returns the packed remaining list + cursor/dealt totals — an O(prior-hands)
 * single-hand replay (no per-hand shoe-array persistence needed).
 *
 * For hand 0 the engine builds a full shoe and remaining is undefined-equivalent.
 * The replay uses `playHandWithState` (the engine's clean state-threading API)
 * so the route never re-implements the deal/draw state machine.
 */
async function reconstructShoeState(
  shoe: ShoeSeedState,
  targetHandIndex: number,
  reader: { select: typeof db.select },
): Promise<{ remaining: Card[]; cursor: number; dealt: number }> {
  if (targetHandIndex === 0) {
    return { remaining: buildShoe(), cursor: 0, dealt: 0 };
  }
  const priorHands = await reader
    .select()
    .from(blackjackHands)
    .where(and(eq(blackjackHands.shoeId, shoe.id), eq(blackjackHands.status, 'settled')))
    .orderBy(blackjackHands.handIndex);

  let remaining = buildShoe();
  let cursor = 0;
  let dealt = 0;
  for (const h of priorHands) {
    if (h.handIndex >= targetHandIndex) break;
    const script = h.script as HandScript;
    const stepped = playHandWithState({
      serverSeed: shoe.serverSeed,
      clientSeed: shoe.clientSeed,
      nonce: h.handIndex,
      cursor,
      bet: BigInt(h.bet),
      script,
      dealtBefore: dealt,
      remainingShoe: dealt === 0 ? undefined : remaining,
    });
    remaining = stepped.remainingAfter;
    cursor = stepped.cursorAfter;
    dealt = stepped.dealtAfter;
  }
  return { remaining, cursor, dealt };
}

/** The player's recorded script + the persisted insurance flag, as one object. */
function loadScript(hand: BlackjackHand): HandScript {
  const s = hand.script as HandScript;
  return { hands: s.hands, didSplit: s.didSplit, tookInsurance: hand.tookInsurance };
}

/**
 * A monotonically-increasing integer that strictly increases by exactly 1 on
 * EVERY decision applied to an in-progress hand. Used by the human-supervised
 * Autonomous relay so a stale agent decision (decided against an earlier
 * snapshot) cannot land after a human has already changed the hand: the relay
 * stamps the version it decided at, and /action rejects an apply whose
 * `expectedHandVersion` no longer matches the freshly-locked hand.
 *
 * DEFINITION (must be identical wherever the version is computed):
 *   sum(hands[*].length) + (didSplit ? 1 : 0) + (tookInsurance ? 1 : 0)
 *
 * Why each term is needed for strict monotonicity vs `applyDecision`:
 *   - hit/stand/double/surrender push one entry → sum grows by 1.
 *   - split RESETS `hands` to [[], []] (sum stays 0) but flips didSplit
 *     false->true, so the +1 didSplit term carries the increment. A bare
 *     sum-of-lengths would NOT change across a split, leaving the exact
 *     human-tap-split-beats-agent race unguarded.
 *   - insurance appends no script entry but flips tookInsurance false->true
 *     (legal only before any main action), so the +1 tookInsurance term
 *     carries that increment too.
 * Every mutating /action path therefore advances this by exactly 1.
 */
function handDecisionVersion(script: HandScript): number {
  const decisionCount = script.hands.reduce((sum, sub) => sum + sub.length, 0);
  return decisionCount + (script.didSplit ? 1 : 0) + (script.tookInsurance ? 1 : 0);
}

/**
 * Append a single decision to the script. A 'split' converts the single-hand
 * script into a two-hand script. Throws on illegal transitions; the engine is
 * the authoritative re-validator at settle time.
 *
 * `splitAceSlots` lists the sub-hand slots that are split-ace hands. Standard
 * rule: split aces receive EXACTLY ONE card and may not hit/double/surrender —
 * the only legal decision is the (implicit) auto-stand, so ANY action targeting
 * such a slot is rejected here. This mirrors the engine's authoritative guard
 * in `runPlayerHandScript` (defense in depth — the route must not persist an
 * illegal script the engine will later throw on).
 */
function applyDecision(
  script: HandScript,
  action: BlackjackActionType,
  handSlot: number,
  splitAceSlots: ReadonlySet<number> = new Set(),
): HandScript {
  if (action === 'split') {
    if (script.didSplit) {
      throw new HTTPException(400, { message: 'already_split: only one split level supported' });
    }
    return { hands: [[], []], didSplit: true, tookInsurance: script.tookInsurance };
  }
  const hands = script.hands.map((h) => h.slice());
  const slot = script.didSplit ? Math.min(handSlot, 1) : 0;
  // Split aces are auto-terminal after their single card — no further decision
  // is legal on that sub-hand (hit/double/surrender all forbidden).
  if (splitAceSlots.has(slot)) {
    throw new HTTPException(400, {
      message: 'split_ace_one_card_only: split aces receive exactly one card and cannot be hit, doubled, or surrendered',
    });
  }
  const sub = hands[slot];
  if (!sub) {
    throw new HTTPException(400, { message: `invalid_hand_slot: ${handSlot}` });
  }
  const last = sub[sub.length - 1];
  if (last === 'stand' || last === 'double' || last === 'surrender') {
    throw new HTTPException(400, { message: 'sub_hand_already_terminal' });
  }
  sub.push(action);
  return { hands, didSplit: script.didSplit, tookInsurance: script.tookInsurance };
}

/**
 * Inspect the dealt sub-hand cards (via a dry-run peek) to find which slots are
 * split-ace hands. Only meaningful for a split script; returns an empty set
 * otherwise. Used to enforce the split-ace one-card rule in both
 * `applyDecision` (reject illegal actions) and `isHandTerminal` (auto-terminal).
 */
function splitAceSlotsFromPeek(script: HandScript, peek: HandResult): Set<number> {
  const out = new Set<number>();
  if (!script.didSplit) return out;
  for (let slot = 0; slot < peek.playerHands.length; slot++) {
    if (peek.playerHands[slot]?.cards[0]?.rank === 'A') out.add(slot);
  }
  return out;
}

/**
 * A "raw peek" script: present the accumulated mid-play script to the engine
 * WITHOUT appending anything. Every accumulated valid script is engine-acceptable
 * as-is: a trailing 'hit' (busting or not) is the LAST action of its sub-hand, so
 * no action FOLLOWS the bust and the engine's "action recorded after bust" guard
 * never fires; an empty sub-hand (no actions) and a terminal
 * stand/double/surrender are likewise accepted. We use this to read each
 * sub-hand's TRUE bust state before deciding whether a 'stand'-append peek is
 * even legal (it is NOT after a busting hit; that is the exact bug A6 caught).
 *
 * Pure transform (defensive copy only); identical dealt cards to the
 * stand-appended peek for any NON-busted hand, since 'stand' draws no card.
 */
function toRawPeekScript(script: HandScript): HandScript {
  return {
    hands: script.hands.map((sub) => sub.slice()),
    didSplit: script.didSplit,
    tookInsurance: script.tookInsurance,
  };
}

/**
 * Build the dry-run "peek" script, bust-aware (the A6 fix).
 *
 * For each sub-hand:
 *   1. a terminal last action (stand / double / surrender): keep as-is.
 *   2. a 'hit' that ALREADY BUSTED (slot in `bustedSlots`): keep RAW. Appending
 *      a 'stand' after a busting hit makes the engine throw
 *      'action recorded after bust' (it treats the stand as an action recorded
 *      after the bust). A busted hand is terminal and draws no further card, so
 *      the raw script already yields the correct busted cards.
 *   3. any OTHER non-terminal sub-hand (a still-live trailing 'hit', or an empty
 *      not-yet-acted sub-hand): append a 'stand'. Standing draws no card, so the
 *      dealt cards + totals are preserved EXACTLY as the pre-fix behavior for
 *      every non-busted hand.
 *
 * `bustedSlots` is computed by `dryRunHand` from a prior RAW-script engine run
 * (which never throws). Passing an empty set reproduces the pre-fix peek for any
 * hand with no busted sub-hand.
 */
function toPeekScript(script: HandScript, bustedSlots: ReadonlySet<number> = new Set()): HandScript {
  return {
    hands: script.hands.map((sub, slot) => {
      const last = sub[sub.length - 1];
      if (last === 'stand' || last === 'double' || last === 'surrender') return sub.slice();
      // A busting trailing 'hit' is terminal: never append a 'stand' after it
      // (that is what threw the uncaught 500 on every bust-via-hit). Leave raw.
      if (last === 'hit' && bustedSlots.has(slot)) return sub.slice();
      return [...sub, 'stand'];
    }),
    didSplit: script.didSplit,
    tookInsurance: script.tookInsurance,
  };
}

/**
 * Dry-run the engine against the CORRECT shoe state to inspect current cards /
 * bust without committing. Returns the full engine result for a peek script.
 *
 * Two-step, bust-aware (the A6 fix): first run the RAW accumulated script (which
 * the engine always accepts, since no 'stand' is appended so no action follows
 * any busting hit) to read each sub-hand's bust state, then build the bust-aware
 * peek (NO trailing 'stand' on a busted hit-ending sub-hand) and run THAT for the
 * returned result. For any non-busted hand the bust-aware peek is identical to
 * the pre-fix stand-appended peek, so cards/totals/outcomes are unchanged.
 */
async function dryRunHand(
  shoe: ShoeSeedState,
  hand: BlackjackHand,
  script: HandScript,
  reader: { select: typeof db.select },
): Promise<HandResult> {
  const state = await reconstructShoeState(shoe, hand.handIndex, reader);
  const remainingShoe = hand.dealtBefore === 0 ? undefined : state.remaining;
  const base = {
    serverSeed: shoe.serverSeed,
    clientSeed: shoe.clientSeed,
    nonce: hand.handIndex,
    cursor: hand.cursorBefore,
    bet: BigInt(hand.bet),
    dealtBefore: hand.dealtBefore,
    remainingShoe,
  };
  // Step 1: raw run to learn which sub-hands busted (never throws, because no
  // action follows a trailing busting hit).
  const raw = playHand({ ...base, script: toRawPeekScript(script) });
  const bustedSlots = new Set<number>();
  for (let slot = 0; slot < raw.playerHands.length; slot++) {
    if (raw.playerHands[slot]?.isBust) bustedSlots.add(slot);
  }
  // Step 2: bust-aware peek (stand appended only to NON-busted, still-mid-play
  // sub-hands). For a hand with no busted sub-hand this equals the pre-fix peek.
  return playHand({ ...base, script: toPeekScript(script, bustedSlots) });
}

/**
 * Single source of truth for "is THIS sub-hand done?" — the server-authoritative
 * per-sub-hand terminal rule. A sub-hand is RESOLVED when:
 *   • it is a split ace (auto-stand on its single dealt card; no legal action), OR
 *   • its last accumulated action is stand / double / surrender (terminal), OR
 *   • it has busted (peek.playerHands[slot].isBust).
 * A still-live trailing 'hit' (not bust) or an empty not-yet-acted sub-hand is NOT
 * resolved. This is what `isHandTerminal` aggregates over sub-hands AND what the
 * in-progress projections serialize as `isResolved` per sub-hand, so the client
 * can tell a stood-21 / doubled-no-bust / surrendered / split-ace sub-hand apart
 * from a still-actionable one (those are byte-identical on cards/total/isBust).
 *
 * `peek` is the SAME bust-aware dry-run already computed by the caller — no new
 * engine run, no hidden-state reveal (only the already-visible bust flag + the
 * accumulated script are read).
 */
function subHandResolved(script: HandScript, peek: HandResult, slot: number): boolean {
  // Split aces are auto-terminal once they hold their single dealt card —
  // no decision is required (or legal) on them. Empty set for non-split.
  if (splitAceSlotsFromPeek(script, peek).has(slot)) return true;
  const actions = script.hands[slot] ?? [];
  const last = actions[actions.length - 1];
  if (last === 'stand' || last === 'double' || last === 'surrender') return true;
  return peek.playerHands[slot]?.isBust ?? false;
}

/**
 * Decide whether the accumulated script terminates the hand:
 *   • surrender / double on a sub-hand → terminal for that sub-hand;
 *   • stand on the last sub-hand → terminal;
 *   • a hit is terminal only if it BUSTS the last live sub-hand.
 * For split hands, BOTH sub-hands must be resolved before the hand settles.
 * Sub-hand resolution is delegated to `subHandResolved` (single source of truth,
 * shared with the in-progress `isResolved` projections).
 */
async function isHandTerminal(
  shoe: ShoeSeedState,
  hand: BlackjackHand,
  script: HandScript,
  reader: { select: typeof db.select },
): Promise<boolean> {
  // Single dry-run gives us bust state for every sub-hand at once.
  const peek = await dryRunHand(shoe, hand, script, reader);

  if (!script.didSplit) {
    return subHandResolved(script, peek, 0);
  }

  // Split: both sub-hands must be resolved.
  return subHandResolved(script, peek, 0) && subHandResolved(script, peek, 1);
}

// ─── POST /session/open ───────────────────────────────────────────────────────

coveBlackjackRouter.post('/session/open', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = openSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const input = parsed.data;
  const subject = await getSubject(c);

  // Currency seam — SOL/USDC custody is a later tier. Same 501 shape as slots.
  if (input.currency !== 'clawtoken') {
    return c.json(
      {
        error: 'CURRENCY_COMING_SOON',
        message: 'SOL/USDC custody for blackjack is a later tier. Use currency="clawtoken" today.',
      },
      501,
    );
  }

  // Pre-flight balance gate (UX only; settle re-checks under the lock).
  let avatar: { id: string; clawTokens: number } | null = null;
  let guestStartingBalance = 0n;
  if (isLedgerSubject(subject)) {
    avatar = await loadAvatarForUser(subject.userId);
    if (avatar.clawTokens < BLACKJACK_MIN_BET) {
      throw new HTTPException(400, {
        message: `insufficient_clawtokens: need ${BLACKJACK_MIN_BET}, have ${avatar.clawTokens}`,
      });
    }
  } else {
    checkGuestShoeOpenRate(subject.guestFpHash);
    guestStartingBalance = GUEST_STARTING_BALANCE;
  }

  // Idempotent open: resume the subject's existing open shoe. Lock the row so
  // we never return data another request is mid-mutating (mirrors cove-slots).
  //
  // GUEST ORPHAN AUTO-RECOVERY (finding #2): a guest's shoe is keyed by
  // guest_fp_hash, but EVERY guest recovery endpoint (/session/current,
  // /hand/current, /session/close) 403s a guest, and this resume path
  // idempotently returns the SAME open shoe — so a guest whose in_progress hand
  // was abandoned (page closed mid-hand) is locked out forever: /hand/deal 409s
  // `hand_in_progress` on the stuck hand and they have no way to clear it.
  // Recovery is GUEST-ONLY and runs UNDER the shoe lock: void the orphan hand
  // (demo stake forfeit — the documented abandoned-hand outcome, guests are demo
  // CT), close the orphan shoe (so the partial unique open-shoe index frees up),
  // and fall through to open a FRESH shoe (closing + opening fresh, never
  // reusing the orphan's counters, avoids shoe-counter drift). AUTHED users are
  // NEVER auto-aborted — their client restores + finishes the live hand (#122).
  const resumed = await db.transaction(async (tx) => {
    const lockWhere =
      isLedgerSubject(subject)
        ? sql`user_id = ${subject.userId} AND status = 'open'`
        : sql`guest_fp_hash = ${subject.guestFpHash} AND status = 'open'`;
    const rows = await tx.execute<{ id: string }>(
      sql`SELECT id FROM blackjack_shoes WHERE ${lockWhere} FOR UPDATE`,
    );
    const id = rows[0]?.id;
    if (!id) return { kind: 'fresh' as const };

    // GUEST ONLY: if the locked open shoe carries an in_progress hand, it is an
    // orphan — void it + close the shoe under THIS lock, then signal fall-through
    // to a fresh open. Gated strictly on guest (NOT isLedgerSubject); authed
    // shoes are always resumed verbatim below.
    if (!isLedgerSubject(subject)) {
      const orphanHandRows = await tx.execute<{ id: string }>(
        sql`SELECT id FROM blackjack_hands
            WHERE shoe_id = ${id} AND status = 'in_progress' LIMIT 1`,
      );
      const orphanHandId = orphanHandRows[0]?.id;
      if (orphanHandId) {
        // Void the orphan hand (demo stake forfeit). status='in_progress' guard
        // makes this idempotent vs a concurrent settle that won the race — if it
        // already flipped, our update touches 0 rows and we still close the shoe.
        await tx
          .update(blackjackHands)
          .set({
            status: 'settled',
            outcomeJson: { voided: true, reason: 'guest_orphan_auto_recover' },
            payout: '0',
            net: '0',
            settledAt: new Date(),
          })
          .where(
            and(eq(blackjackHands.id, orphanHandId), eq(blackjackHands.status, 'in_progress')),
          );
        // Close the orphan shoe so the guest's partial unique open-shoe index is
        // freed for the fresh shoe inserted below (avoids a 23505 on re-open).
        await tx
          .update(blackjackShoes)
          .set({ status: 'closed', closedAt: new Date() })
          .where(eq(blackjackShoes.id, id));
        return { kind: 'recovered' as const, orphanShoeId: id, orphanHandId };
      }
      // Guest open shoe with NO live hand → resumable as-is (not an orphan).
    }

    const shoe =
      (await tx.query.blackjackShoes.findFirst({ where: eq(blackjackShoes.id, id) })) ?? null;
    return shoe
      ? { kind: 'resume' as const, shoe }
      : { kind: 'fresh' as const };
  });

  if (resumed.kind === 'recovered') {
    void logEventFromContext(c, {
      eventType: 'cove.blackjack.guest_orphan_recovered',
      userId: null,
      avatarId: null,
      agentId: null,
      payload: {
        orphanShoeId: resumed.orphanShoeId,
        orphanHandId: resumed.orphanHandId,
        reason: 'guest_orphan_auto_recover',
      },
    });
    // fall through to fresh-shoe open below
  } else if (resumed.kind === 'resume') {
    return c.json(
      {
        shoe: publicShoe(resumed.shoe),
        walletBalance: avatar ? avatar.clawTokens : Number(guestDemoBalance(resumed.shoe)),
      },
      200,
    );
  }

  const { serverSeed, serverSeedHash } = createServerSeed();
  const clientSeed = randomBytes(8).toString('hex');

  let inserted: BlackjackShoe;
  try {
    inserted = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(blackjackShoes)
        .values({
          userId: subject.userId,
          guestFpHash: subject.guestFpHash,
          currency: 'clawtoken',
          serverSeed,
          serverSeedHash,
          clientSeed,
          startingBalance: isLedgerSubject(subject) ? '0' : guestStartingBalance.toString(),
          engineVersion: BLACKJACK_ENGINE_VERSION,
        })
        .returning();
      if (!row) throw new HTTPException(500, { message: 'shoe_insert_failed' });
      return row;
    });
  } catch (err) {
    // Race against a concurrent open on the same subject — re-read + serve.
    const pgCode = (err as { code?: string } | undefined)?.code;
    if (pgCode === '23505') {
      const raceWhere =
        isLedgerSubject(subject)
          ? and(eq(blackjackShoes.userId, subject.userId), eq(blackjackShoes.status, 'open'))
          : and(eq(blackjackShoes.guestFpHash, subject.guestFpHash), eq(blackjackShoes.status, 'open'));
      const raceRow = (await db.select().from(blackjackShoes).where(raceWhere).limit(1))[0];
      if (raceRow) {
        return c.json(
          {
            shoe: publicShoe(raceRow),
            walletBalance: avatar ? avatar.clawTokens : Number(guestDemoBalance(raceRow)),
          },
          200,
        );
      }
      throw new HTTPException(409, { message: 'shoe_already_open' });
    }
    throw err;
  }

  void logEventFromContext(c, {
    eventType: 'cove.blackjack.shoe.opened',
    userId: ledgerUserId(subject),
    avatarId: avatar?.id ?? null,
    agentId: subject.kind === 'agent' ? subject.agentId : null,
    payload: {
      shoeId: inserted.id,
      currency: 'clawtoken',
      isGuest: subject.kind === 'guest',
      isAgent: subject.kind === 'agent',
    },
  });

  return c.json(
    {
      shoe: publicShoe(inserted),
      walletBalance: avatar ? avatar.clawTokens : Number(guestStartingBalance),
    },
    200,
  );
});

// ─── POST /hand/deal ──────────────────────────────────────────────────────────
//
// Start a new hand on an open shoe. Validates the bet (5–500), refuses a new
// deal once penetration crosses 75% (client opens a fresh shoe — new seed
// pair), and inserts an in_progress hand row from authoritative counters under
// the shoe lock. NO debit happens here — debit + credit settle atomically at
// hand end (mirrors the slots no-open-time-debit money model). Naturals
// (player or dealer blackjack) settle immediately in one round-trip.

coveBlackjackRouter.post('/hand/deal', async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key') ?? undefined;
  if (idempotencyKey && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN) {
    throw new HTTPException(400, {
      message: `idempotency_key_must_be_1_to_${IDEMPOTENCY_KEY_MAX_LEN}_chars`,
    });
  }
  const body = await c.req.json().catch(() => null);
  const parsed = dealSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const input = parsed.data;
  const subject = await getSubject(c);
  checkActionRate(subjectKey(subject));

  const shoe = await db.query.blackjackShoes.findFirst({
    where: eq(blackjackShoes.id, input.shoeId),
  });
  if (!shoe) throw new HTTPException(404, { message: 'shoe_not_found' });
  if (!ownerMatch(shoe, subject)) throw new HTTPException(403, { message: 'shoe_not_owned' });
  if (shoe.status !== 'open') {
    throw new HTTPException(409, { message: `shoe_not_open: status=${shoe.status}` });
  }

  // 75% penetration gate — refuse a NEW deal once the shoe crossed threshold;
  // the client opens a fresh shoe (new commit-reveal seed pair). Mid-hand
  // reshuffle is never allowed (would break replay determinism).
  if (shoe.dealtCount >= RESHUFFLE_CARD_THRESHOLD) {
    return c.json(
      {
        reshuffled: true,
        message: 'shoe_penetration_exceeded: open a new shoe (75% reached)',
        dealtCount: shoe.dealtCount,
        threshold: RESHUFFLE_CARD_THRESHOLD,
      },
      409,
    );
  }

  const betBig = BigInt(input.bet);

  // Pre-flight affordability (UX). Authoritative re-check happens at settle.
  let avatar: { id: string; clawTokens: number } | null = null;
  if (isLedgerSubject(subject)) {
    avatar = await loadAvatarForUser(subject.userId);
    if (avatar.clawTokens < input.bet) {
      throw new HTTPException(400, {
        message: `insufficient_clawtokens: need ${input.bet}, have ${avatar.clawTokens}`,
      });
    }
  } else {
    const demo = guestDemoBalance(shoe);
    if (demo < betBig) {
      throw new HTTPException(400, {
        message: `insufficient_guest_demo_balance: need ${input.bet}, have ${demo.toString()}. Sign up to play with more.`,
      });
    }
  }

  // Insert the in_progress hand under the shoe lock so handIndex/cursorBefore/
  // dealtBefore come from authoritative counters. The empty script means "no
  // decisions yet"; the dealer upcard tells the client whether insurance is
  // offered.
  //
  // SERIALIZATION (audit finding #4): a shoe may have AT MOST ONE in_progress
  // hand at a time. We reject a new deal while a prior hand is unsettled. This
  // guarantees the shoe's cursor_counter/dealt_count are fully up to date
  // (advanced by the prior hand's settle) before this hand captures
  // cursorBefore/dealtBefore — so each hand row records its TRUE starting
  // cursor/dealt and the sequential /verify replay matches byte-for-byte.
  //
  // STAKE COMMIT AT DEAL (audit finding #3): the base bet (and any deal-time
  // insurance) is debited NOW, under the lock, and recorded in stakedAmount.
  // An abandoned in_progress hand therefore irrevocably costs its stake —
  // closing the free hand-peek exploit. At settle we credit the gross payout
  // and debit only the incremental double/split delta (totalBet - stakedAmount).
  const dealResult = await db.transaction(async (tx) => {
    const lockRows = await tx.execute<{
      hand_counter: number | string;
      cursor_counter: number | string;
      dealt_count: number | string;
      status: string;
    }>(
      sql`SELECT hand_counter, cursor_counter, dealt_count, status
          FROM blackjack_shoes WHERE id = ${shoe.id} FOR UPDATE`,
    );
    const lock = lockRows[0];
    if (!lock) throw new HTTPException(404, { message: 'shoe_not_found' });
    if (lock.status !== 'open') {
      throw new HTTPException(409, { message: `shoe_not_open: status=${lock.status}` });
    }

    // Stale-agent-DEAL guard (Codex concurrency lens, BLOCKING #2). When the
    // Autonomous driver supplies `expectedHandsPlayed` (the shoe's handCounter at
    // /agent/decide time), reject if the shoe has dealt a hand since - i.e. an
    // intervening human deal already opened (and possibly natural-settled) a hand.
    // The `hand_in_progress` check below catches the case where that human hand is
    // STILL live, but a hand that settled instantly as a natural leaves NO live
    // hand to block on, so the stale agent 'deal' would otherwise open an EXTRA
    // hand the human never asked for. handCounter strictly increments by 1 at each
    // deal (open), so comparing it under the lock is the precise epoch check.
    // OMITTED on human manual deals → unconditional legacy behavior preserved.
    if (input.expectedHandsPlayed !== undefined &&
        Number(lock.hand_counter) !== input.expectedHandsPlayed) {
      throw new HTTPException(409, {
        message: 'stale_agent_deal: a hand was dealt since the agent decided',
      });
    }

    // Reject a new deal while any hand for this shoe is still in_progress —
    // one live hand per shoe (finding #4). Locked under the shoe row so it is
    // race-safe against a concurrent /hand/deal on the same shoe.
    const liveRows = await tx.execute<{ id: string }>(
      sql`SELECT id FROM blackjack_hands
          WHERE shoe_id = ${shoe.id} AND status = 'in_progress' LIMIT 1`,
    );
    if (liveRows[0]) {
      throw new HTTPException(409, {
        message: 'hand_in_progress: finish the current hand before dealing another',
      });
    }

    const handIndex = Number(lock.hand_counter);
    const cursorBefore = Number(lock.cursor_counter);
    const dealtBefore = Number(lock.dealt_count);
    if (dealtBefore >= RESHUFFLE_CARD_THRESHOLD) {
      throw new HTTPException(409, {
        message: 'shoe_penetration_exceeded: open a new shoe (75% reached)',
      });
    }

    // Reconstruct mid-shoe remaining state (O(prior hands)) to derive the
    // dealer upcard + detect a natural that settles immediately. Because hands
    // are serialized, the reconstructed cursor/dealt MUST equal the shoe's live
    // counters — assert it so a counter-drift bug fails loudly, never silently
    // dealing from a fresh shoe (the old finding #4 corruption mode).
    const state = await reconstructShoeState(shoe, handIndex, tx);
    if (state.cursor !== cursorBefore || state.dealt !== dealtBefore) {
      throw new HTTPException(500, {
        message:
          `shoe_counter_drift: reconstructed cursor=${state.cursor}/dealt=${state.dealt} ` +
          `!= shoe cursor=${cursorBefore}/dealt=${dealtBefore}`,
      });
    }

    // Decisionless stand-only peek to read the opening 4 cards.
    const peek = playHand({
      serverSeed: shoe.serverSeed,
      clientSeed: shoe.clientSeed,
      nonce: handIndex,
      cursor: cursorBefore,
      bet: betBig,
      script: { hands: [['stand']], didSplit: false, tookInsurance: false },
      dealtBefore,
      remainingShoe: dealtBefore === 0 ? undefined : state.remaining,
    });
    const dealerUpcard = peek.dealer.cards[0]!;
    const playerOpening = peek.playerHands[0]!.cards.slice(0, 2);
    const insuranceOffered = dealerUpcard.rank === 'A';
    const playerNatural = peek.playerHands[0]!.isBlackjack;
    const dealerNatural = peek.dealer.isBlackjack;
    const tookInsurance = input.insurance && insuranceOffered;

    // ── Commit the base stake (+ deal-time insurance) NOW (finding #3) ──────
    // insurance stake = floor(bet/2), mirroring the engine's settleNaturals /
    // insurance math. Debited up front; refunded as part of the gross payout at
    // settle (engine totalPayout already includes the insurance return).
    const insuranceStake = tookInsurance ? betBig / 2n : 0n;
    const stakeNow = betBig + insuranceStake;
    let balanceAfterDeal: number | undefined;
    if (isLedgerSubject(subject)) {
      const dealAvatar = avatar ?? (await loadAvatarForUser(subject.userId));
      const stakeNumber = Number(stakeNow);
      try {
        const debit = await debitClawTokens(
          {
            avatarId: dealAvatar.id,
            amount: stakeNumber,
            reason: 'cove_blackjack_stake',
            source: 'api',
            metadata: { shoeId: shoe.id, handIndex, kind: 'deal' },
            actorKind: subject.kind === 'user' ? 'human' : 'agent',
          },
          tx,
        );
        balanceAfterDeal = debit.balanceAfter;
      } catch (err) {
        if (err instanceof InsufficientTokensError) {
          throw new HTTPException(400, {
            message: `insufficient_clawtokens: need ${stakeNumber}, have ${err.available}`,
          });
        }
        throw err;
      }
    } else {
      // Guest demo accounting — fold the stake into the shoe's running balance
      // immediately (no ledger). totalBet advances now; totalPayout advances at
      // settle. Reject if it would overdraw the demo wallet.
      const newDemo =
        BigInt(shoe.startingBalance) +
        BigInt(shoe.totalPayout) -
        (BigInt(shoe.totalBet) + stakeNow);
      if (newDemo < 0n) {
        throw new HTTPException(400, {
          message: 'insufficient_guest_demo_balance_at_deal',
        });
      }
      balanceAfterDeal = Number(newDemo);
    }

    const [handRow] = await tx
      .insert(blackjackHands)
      .values({
        shoeId: shoe.id,
        handIndex,
        cursorBefore,
        dealtBefore,
        bet: betBig.toString(),
        stakedAmount: stakeNow.toString(),
        script: { hands: [[]], didSplit: false, tookInsurance: false } satisfies HandScript,
        tookInsurance,
        status: 'in_progress',
      })
      .returning();
    if (!handRow) throw new HTTPException(500, { message: 'hand_insert_failed' });

    // Advance shoe state at DEAL time:
    //   - handCounter: so the unique (shoeId, handIndex) is reserved;
    //   - totalBet: the committed stake (finding #3 — irrevocable on abandon);
    //   - cursor/dealt are NOT advanced here (they advance to the FINAL
    //     post-hand position at settle; serialization guarantees no other hand
    //     deals before this one settles, so the cursor cannot be stranded).
    const newTotalBet = (BigInt(shoe.totalBet) + stakeNow).toString();
    await tx
      .update(blackjackShoes)
      .set({
        handCounter: handIndex + 1,
        totalBet: newTotalBet,
        currentBalance: (BigInt(shoe.totalPayout) - BigInt(newTotalBet)).toString(),
        lastHandAt: new Date(),
      })
      .where(eq(blackjackShoes.id, shoe.id));

    return {
      handRow,
      dealerUpcard,
      playerOpening,
      insuranceOffered,
      playerNatural,
      dealerNatural,
      balanceAfterDeal,
    };
  });

  // Natural (player or dealer BJ) → settle immediately (no player decisions).
  if (dealResult.playerNatural || dealResult.dealerNatural) {
    const settled = await settleHand(c, shoe.id, dealResult.handRow.id, subject, idempotencyKey);
    return c.json({ ...settled, dealtImmediately: true }, 200);
  }

  return c.json(
    {
      handId: dealResult.handRow.id,
      shoeId: shoe.id,
      handIndex: dealResult.handRow.handIndex,
      bet: dealResult.handRow.bet,
      playerHand: dealResult.playerOpening,
      dealerUpcard: dealResult.dealerUpcard,
      insuranceOffered: dealResult.insuranceOffered,
      tookInsurance: dealResult.handRow.tookInsurance,
      // Balance AFTER the deal-time stake commit (finding #3) so the client
      // reflects the staked CT immediately, not only at settle.
      balance: dealResult.balanceAfterDeal,
      status: 'in_progress',
    },
    200,
  );
});

// ─── POST /action ─────────────────────────────────────────────────────────────
//
// Record ONE player decision. When the decision makes the hand terminal it
// settles atomically (engine recompute under the shoe lock). 'insure' is a
// distinct shape (no handSlot).

coveBlackjackRouter.post('/action', async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key') ?? undefined;
  if (idempotencyKey && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN) {
    throw new HTTPException(400, {
      message: `idempotency_key_must_be_1_to_${IDEMPOTENCY_KEY_MAX_LEN}_chars`,
    });
  }
  const body = await c.req.json().catch(() => null);

  const insureParsed = insureActionSchema.safeParse(body);
  const parsed = actionSchema.safeParse(body);
  if (!insureParsed.success && !parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }

  const subject = await getSubject(c);
  checkActionRate(subjectKey(subject));

  const handId = insureParsed.success ? insureParsed.data.handId : parsed.data!.handId;

  const hand = await db.query.blackjackHands.findFirst({ where: eq(blackjackHands.id, handId) });
  if (!hand) throw new HTTPException(404, { message: 'hand_not_found' });

  const shoe = await db.query.blackjackShoes.findFirst({ where: eq(blackjackShoes.id, hand.shoeId) });
  if (!shoe) throw new HTTPException(404, { message: 'shoe_not_found' });
  if (!ownerMatch(shoe, subject)) throw new HTTPException(403, { message: 'hand_not_owned' });

  // Idempotent: a re-POST to a settled hand replays the stored outcome.
  if (hand.status === 'settled') {
    return c.json(await buildSettledResponse(hand, shoe, subject), 200);
  }
  if (shoe.status !== 'open') {
    throw new HTTPException(409, { message: `shoe_not_open: status=${shoe.status}` });
  }

  const seedState: ShoeSeedState = {
    id: shoe.id,
    serverSeed: shoe.serverSeed,
    clientSeed: shoe.clientSeed,
  };

  // ── 'insure' — record insurance BEFORE any main-hand action ──────────────
  //
  // ALL pre-settle mutations run UNDER the hand FOR UPDATE lock so concurrent
  // /action calls serialize (last-writer-wins is a settlement-integrity bug —
  // a hand could otherwise settle on a script the player did not author).
  //
  // Money-leak guards (LOCKED rule: "insurance offered only on a dealer Ace,
  // resolved BEFORE the main hand"):
  //   1. Reject unless the dealer upcard is an Ace (peek under the lock) — the
  //      engine silently drops insurance on a non-Ace board, so without this
  //      the route would persist a false flag + lie to the client.
  //   2. Reject unless the main hand has had ZERO decisions and no split — a
  //      player must not be able to HIT, see a weak board, then back-fill
  //      insurance and collect 2:1 they were never entitled to mid-hand.
  if (insureParsed.success) {
    // Optional stale-agent-decision precondition (relay-supplied; see
    // insureActionSchema). Threaded into the locked transaction below; OMITTED on
    // human manual insure so the legacy unconditional path is unchanged.
    const insureExpectedVersion = insureParsed.data.expectedHandVersion;
    const result = await db.transaction(async (tx) => {
      // Lock the hand row so the read-check-write is atomic vs other /action.
      const lockRows = await tx.execute<{ status: string }>(
        sql`SELECT status FROM blackjack_hands WHERE id = ${hand.id} FOR UPDATE`,
      );
      const lock = lockRows[0];
      if (!lock) throw new HTTPException(404, { message: 'hand_not_found' });
      if (lock.status === 'settled') {
        const fresh = await tx.query.blackjackHands.findFirst({ where: eq(blackjackHands.id, hand.id) });
        return { settledReplay: fresh ?? null };
      }
      if (lock.status !== 'in_progress') {
        throw new HTTPException(409, { message: 'hand_not_in_progress' });
      }

      // Re-read the locked hand to evaluate ordering against the authoritative
      // (not the stale pre-lock) script.
      const locked = await tx.query.blackjackHands.findFirst({ where: eq(blackjackHands.id, hand.id) });
      if (!locked) throw new HTTPException(404, { message: 'hand_not_found' });
      const lockedScript = loadScript(locked);

      // Stale-agent-decision guard (parity with the main /action path). When the
      // Autonomous driver supplies `expectedHandVersion`, the agent decided
      // `insure` against a SNAPSHOT of this hand; if the freshly-locked hand has
      // advanced since (a human tapped, or insurance was already taken — both
      // bump handDecisionVersion), reject so the human's tap beats the stale
      // in-flight agent insure. Computed UNDER the lock against the authoritative
      // (not pre-lock) script so it is race-safe. OMITTED on human manual insure
      // taps, preserving the unconditional legacy behavior exactly. The version
      // definition MUST match the one stamped by /agent/decide.
      if (insureExpectedVersion !== undefined &&
          handDecisionVersion(lockedScript) !== insureExpectedVersion) {
        throw new HTTPException(409, {
          message: 'stale_agent_decision: hand changed since the agent decided',
        });
      }

      // Guard 2 — insurance is a before-first-action decision only.
      if (lockedScript.didSplit || lockedScript.hands.some((sub) => sub.length > 0)) {
        throw new HTTPException(400, {
          message: 'insurance_only_before_first_action',
        });
      }
      if (lockedScript.tookInsurance) {
        // Idempotent re-insure — already recorded, nothing to change.
        return { settledReplay: null };
      }

      // Guard 1 — dealer upcard must be an Ace (peek the opening deal).
      const peek = await dryRunHand(seedState, locked, lockedScript, tx);
      if (peek.dealer.cards[0]?.rank !== 'A') {
        throw new HTTPException(400, {
          message: 'insurance_not_offered: dealer upcard is not an Ace',
        });
      }

      // ── Commit the insurance stake NOW (finding #3 consistency) ───────────
      // Insurance is staked the moment it is taken — bump stakedAmount + the
      // shoe totalBet so an abandoned hand still costs the insurance bet, and
      // settle only credits the gross (which includes the insurance return).
      // Lock the shoe row to make the totalBet read-modify-write race-safe.
      const insBet = BigInt(locked.bet) / 2n;
      if (insBet > 0n) {
        const shoeLockRows = await tx.execute<{
          total_bet: string;
          total_payout: string;
          starting_balance: string;
          status: string;
        }>(
          sql`SELECT total_bet, total_payout, starting_balance, status
              FROM blackjack_shoes WHERE id = ${shoe.id} FOR UPDATE`,
        );
        const shoeLock = shoeLockRows[0];
        if (!shoeLock) throw new HTTPException(404, { message: 'shoe_not_found' });
        if (shoeLock.status !== 'open') {
          throw new HTTPException(409, { message: `shoe_not_open: status=${shoeLock.status}` });
        }

        if (isLedgerSubject(subject)) {
          const insAvatar = await loadAvatarForUser(subject.userId);
          try {
            await debitClawTokens(
              {
                avatarId: insAvatar.id,
                amount: Number(insBet),
                reason: 'cove_blackjack_insurance',
                source: 'api',
                metadata: { shoeId: shoe.id, handId: hand.id, handIndex: locked.handIndex },
                actorKind: subject.kind === 'user' ? 'human' : 'agent',
              },
              tx,
            );
          } catch (err) {
            if (err instanceof InsufficientTokensError) {
              throw new HTTPException(400, {
                message: `insufficient_clawtokens_for_insurance: need ${Number(insBet)}, have ${err.available}`,
              });
            }
            throw err;
          }
        } else {
          const newDemo =
            BigInt(shoeLock.starting_balance) +
            BigInt(shoeLock.total_payout) -
            (BigInt(shoeLock.total_bet) + insBet);
          if (newDemo < 0n) {
            throw new HTTPException(400, {
              message: 'insufficient_guest_demo_balance_for_insurance',
            });
          }
        }

        const newTotalBet = (BigInt(shoeLock.total_bet) + insBet).toString();
        await tx
          .update(blackjackShoes)
          .set({
            totalBet: newTotalBet,
            currentBalance: (BigInt(shoeLock.total_payout) - BigInt(newTotalBet)).toString(),
          })
          .where(eq(blackjackShoes.id, shoe.id));
      }

      const updated = await tx
        .update(blackjackHands)
        .set({
          tookInsurance: true,
          stakedAmount: (BigInt(locked.stakedAmount) + insBet).toString(),
        })
        .where(and(eq(blackjackHands.id, hand.id), eq(blackjackHands.status, 'in_progress')))
        .returning();
      if (!updated[0]) throw new HTTPException(409, { message: 'hand_not_in_progress' });
      return { settledReplay: null };
    });

    if (result.settledReplay) {
      return c.json(await buildSettledResponse(result.settledReplay, shoe, subject), 200);
    }
    return c.json({ handId: hand.id, tookInsurance: true, status: 'in_progress' }, 200);
  }

  const action = parsed.data!.action as BlackjackActionType;
  const handSlot = parsed.data!.handSlot;
  // Optional stale-agent-decision precondition (relay-supplied; see actionSchema).
  const expectedHandVersion = parsed.data!.expectedHandVersion;

  // ── Main-hand decision — read-modify-write the script UNDER the hand lock ──
  // so two concurrent /action calls serialize instead of last-writer-wins
  // (which could otherwise settle a hand on a script the player never made).
  // The terminal check is evaluated against the locked script too.
  const mutation = await db.transaction(async (tx) => {
    const lockRows = await tx.execute<{ status: string }>(
      sql`SELECT status FROM blackjack_hands WHERE id = ${hand.id} FOR UPDATE`,
    );
    const lock = lockRows[0];
    if (!lock) throw new HTTPException(404, { message: 'hand_not_found' });
    if (lock.status === 'settled') {
      const fresh = await tx.query.blackjackHands.findFirst({ where: eq(blackjackHands.id, hand.id) });
      return { settledReplay: fresh ?? null, updatedHand: null, newScript: null };
    }
    if (lock.status !== 'in_progress') {
      throw new HTTPException(409, { message: 'hand_not_in_progress' });
    }

    // Re-read the LOCKED hand and apply the decision to its authoritative
    // script — never to the stale pre-lock read.
    const locked = await tx.query.blackjackHands.findFirst({ where: eq(blackjackHands.id, hand.id) });
    if (!locked) throw new HTTPException(404, { message: 'hand_not_found' });
    const lockedScript = loadScript(locked);
    // Stale-agent-decision guard (human-supervised Autonomous relay). When the
    // driver supplies `expectedHandVersion`, the agent decided against a SNAPSHOT
    // of this hand; if the freshly-locked hand has advanced since (e.g. a human
    // already tapped an action), reject so the human's tap beats the stale
    // in-flight agent apply. Computed UNDER the lock against the authoritative
    // (not pre-lock) script so it is race-safe. OMITTED on human manual taps,
    // which preserves the unconditional legacy behavior exactly. The version
    // definition here MUST match the one stamped by /agent/decide.
    if (expectedHandVersion !== undefined &&
        handDecisionVersion(lockedScript) !== expectedHandVersion) {
      throw new HTTPException(409, {
        message: 'stale_agent_decision: hand changed since the agent decided',
      });
    }
    // For a split hand, peek the dealt sub-hand cards to identify split-ace
    // slots so `applyDecision` can reject the forbidden hit/double on them
    // (split aces get exactly one card). Non-split hands can't be split aces.
    const aceSlots = lockedScript.didSplit
      ? splitAceSlotsFromPeek(lockedScript, await dryRunHand(seedState, locked, lockedScript, tx))
      : new Set<number>();
    const nextScript = applyDecision(lockedScript, action, handSlot, aceSlots);

    const persisted = await tx
      .update(blackjackHands)
      .set({ script: nextScript })
      .where(and(eq(blackjackHands.id, hand.id), eq(blackjackHands.status, 'in_progress')))
      .returning();
    if (!persisted[0]) throw new HTTPException(409, { message: 'hand_not_in_progress' });
    return { settledReplay: null, updatedHand: persisted[0], newScript: nextScript };
  });

  // Lost the race to a concurrent settle → replay the stored outcome.
  if (mutation.settledReplay) {
    return c.json(await buildSettledResponse(mutation.settledReplay, shoe, subject), 200);
  }
  const updatedHand = mutation.updatedHand!;
  const newScript = mutation.newScript!;

  const terminal = await isHandTerminal(seedState, updatedHand, newScript, db);

  if (!terminal) {
    // Surface current visible state so the client can keep acting.
    const peek = await dryRunHand(seedState, updatedHand, newScript, db);
    return c.json(
      {
        handId: hand.id,
        status: 'in_progress',
        // `isResolved` = server-authoritative per-sub-hand terminal flag (same
        // source of truth as /hand/current). The client routes its active focus
        // off it (a stood/doubled/surrendered/split-ace sub-hand is resolved even
        // with isBust=false) — it cannot be derived from cards/total/isBust.
        // Derived from the SAME peek/newScript already computed; no hidden reveal.
        playerHands: peek.playerHands.map((h, slot) => ({
          cards: h.cards,
          total: h.total,
          isSoft: h.isSoft,
          isBust: h.isBust,
          isResolved: subHandResolved(newScript, peek, slot),
        })),
        // NIT #1: coalesce to null to match /hand/current's one-shape parity
        // (peek.dealer.cards[0] can be undefined on a malformed peek).
        dealerUpcard: peek.dealer.cards[0] ?? null,
        didSplit: newScript.didSplit,
      },
      200,
    );
  }

  const settled = await settleHand(c, shoe.id, hand.id, subject, idempotencyKey);
  return c.json(settled, 200);
});

// ─── Settle (atomic, idempotent, engine recompute UNDER the shoe lock) ───────

interface SettledResponse {
  handId: string;
  shoeId: string;
  handIndex: number;
  status: 'settled';
  outcome: SerializedHandResult;
  balance: number;
  totalBet: string;
  /** GROSS payout before the net-winnings rake (stringified bigint). */
  totalPayout: string;
  /** GROSS net before the rake (stringified bigint). */
  net: string;
  /** House rake on net winnings this hand = floor(max(0, net)*5/100). 0 on loss/push. */
  rake: string;
  dealtCount: number;
  reshuffleSuggested: boolean;
  idempotencyReplay: boolean;
}

/**
 * Raised from inside the settle transaction when a reused Idempotency-Key hits
 * the (shoeId, idempotencyKey) unique index (pgCode 23505). Caught by
 * `settleHand` to abort the (now-rolled-back) transaction and replay the
 * already-settled colliding row from a fresh read — a clean idempotent replay
 * instead of a 500 + critical alert.
 */
class IdempotencyReplayError extends Error {
  constructor(
    public readonly shoeId: string,
    public readonly idempotencyKey: string,
  ) {
    super(`idempotency_key_replay: shoeId=${shoeId}`);
    this.name = 'IdempotencyReplayError';
  }
}

/**
 * Settle a hand. ALL balance mutations + the cove_game_events insert + the
 * shoe counter advance run in ONE transaction with the engine recompute UNDER
 * the shoe FOR UPDATE row lock. Idempotent: the hand status flips
 * in_progress→settled exactly once; a re-entry on a settled hand replays.
 */
async function settleHand(
  c: Context<AppContext>,
  shoeId: string,
  handId: string,
  subject: BjSubject,
  idempotencyKey: string | undefined,
): Promise<SettledResponse> {
  const avatar = isLedgerSubject(subject) ? await loadAvatarForUser(subject.userId) : null;

  let txResult: { hand: BlackjackHand; replay: boolean; balanceAfter: number | undefined };
  try {
    txResult = await settleTransaction();
  } catch (err) {
    if (err instanceof IdempotencyReplayError) {
      // The settle tx was rolled back by the key collision. Re-read the
      // already-settled colliding row in a fresh query and replay it.
      const replayed = await db.query.blackjackHands.findFirst({
        where: and(
          eq(blackjackHands.shoeId, err.shoeId),
          eq(blackjackHands.idempotencyKey, err.idempotencyKey),
        ),
      });
      if (replayed && replayed.status === 'settled') {
        return buildSettledResponse(replayed, await loadShoeOrThrow(shoeId), subject);
      }
      // Collision but no settled row found (extremely unlikely) — surface 409
      // rather than a misleading replay.
      throw new HTTPException(409, { message: 'idempotency_key_in_flight: retry shortly' });
    }
    throw err;
  }

  async function settleTransaction(): Promise<{
    hand: BlackjackHand;
    replay: boolean;
    balanceAfter: number | undefined;
  }> {
  return db.transaction(async (tx) => {
    // Lock the SHOE — serializes settle against concurrent deals/settles and
    // gives authoritative counters for the engine recompute.
    const shoeRows = await tx.execute<ShoeLockRow>(
      sql`SELECT id, server_seed, server_seed_hash, client_seed, cursor_counter,
                 dealt_count, total_bet, total_payout, starting_balance, status,
                 user_id, guest_fp_hash
          FROM blackjack_shoes WHERE id = ${shoeId} FOR UPDATE`,
    );
    const shoeLock = shoeRows[0];
    if (!shoeLock) throw new HTTPException(404, { message: 'shoe_not_found' });

    // Defense-in-depth (Codex review 2026-06-03, BLOCKING #1): re-assert ownership
    // UNDER the lock. Callers pre-validate ownerMatch, but a money-settling fn must
    // never trust callers — a future no-pre-check call path would otherwise settle a
    // different avatar's ledger. Valid flows never trip this (shoe.user_id===subject.userId).
    if (!ownerMatch({ userId: shoeLock.user_id, guestFpHash: shoeLock.guest_fp_hash }, subject)) {
      throw new HTTPException(403, { message: 'settle_subject_mismatch' });
    }

    // Bind the hand to the LOCKED shoe (Codex money lens 2026-06-03, BLOCKING #1):
    // load by BOTH (id, shoeId), never by handId alone. A caller who owns shoe A
    // could otherwise pass {shoeId: A, handId: <victim hand on shoe B>}: the
    // ownerMatch check above (and the under-lock re-assert) only validates shoe A,
    // so a bare handId load would settle the VICTIM'S hand outcome to A's balance.
    // Pinning the load to the locked shoeId means a foreign handId resolves to no
    // row → 409, completing Fix A's "a money-settling fn never trusts callers"
    // goal. Valid flows always pass a (handId, shoeId) pair from the same shoe.
    const hand = await tx.query.blackjackHands.findFirst({
      where: and(eq(blackjackHands.id, handId), eq(blackjackHands.shoeId, shoeId)),
    });
    if (!hand) throw new HTTPException(409, { message: 'hand_shoe_mismatch' });

    // Idempotency: already settled → pure replay of the stored outcome.
    if (hand.status === 'settled') {
      return { hand, replay: true as const, balanceAfter: undefined as number | undefined };
    }

    // Idempotency-Key pre-check (slots contract): if THIS key already settled a
    // row for this shoe, replay that row instead of re-settling. Catches a
    // client retry that reuses the key against a different (already-settled)
    // hand before the unique index would 23505 the write below.
    if (idempotencyKey) {
      const priorByKey = await tx.query.blackjackHands.findFirst({
        where: and(
          eq(blackjackHands.shoeId, shoeId),
          eq(blackjackHands.idempotencyKey, idempotencyKey),
        ),
      });
      if (priorByKey && priorByKey.status === 'settled') {
        return { hand: priorByKey, replay: true as const, balanceAfter: undefined as number | undefined };
      }
    }

    if (shoeLock.status !== 'open') {
      throw new HTTPException(409, { message: `shoe_not_open: status=${shoeLock.status}` });
    }

    const handIndex = hand.handIndex;
    const betBig = BigInt(hand.bet);
    const stakedAmount = BigInt(hand.stakedAmount);
    const script = loadScript(hand);

    const seedState: ShoeSeedState = {
      id: shoeLock.id,
      serverSeed: shoeLock.server_seed,
      clientSeed: shoeLock.client_seed,
    };

    // Reconstruct the authoritative remaining-shoe for this hand index. The
    // cursor/dealt come from the sequential reconstruction — NOT from the
    // (potentially stale) stored values — so the settle outcome is the same
    // one the /verify replay produces (audit finding #4). With hands serialized
    // at deal time the stored values should already match; assert it so any
    // drift fails loudly instead of silently dealing a divergent hand.
    const state = await reconstructShoeState(seedState, handIndex, tx);
    const cursorBefore = state.cursor;
    const dealtBefore = state.dealt;
    if (hand.cursorBefore !== cursorBefore || hand.dealtBefore !== dealtBefore) {
      throw new HTTPException(500, {
        message:
          `shoe_counter_drift_at_settle: stored cursor=${hand.cursorBefore}/dealt=${hand.dealtBefore} ` +
          `!= reconstructed cursor=${cursorBefore}/dealt=${dealtBefore}`,
      });
    }

    // Engine recompute UNDER the lock — authoritative outcome. Pass the
    // reconstructed cursor/dealt/remaining (handIndex 0 builds a fresh shoe).
    let r: HandResult;
    try {
      r = playHand({
        serverSeed: shoeLock.server_seed,
        clientSeed: shoeLock.client_seed,
        nonce: handIndex,
        cursor: cursorBefore,
        bet: betBig,
        script,
        dealtBefore,
        remainingShoe: handIndex === 0 ? undefined : state.remaining,
      });
    } catch (err) {
      throw new HTTPException(400, { message: `blackjack_engine_error: ${(err as Error).message}` });
    }

    // Money safety: refuse payout/stake exceeding int4 / JS-number range.
    if (r.totalPayout > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new HTTPException(500, { message: 'payout_exceeds_supported_range' });
    }
    if (r.totalBet > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new HTTPException(400, { message: 'bet_exceeds_supported_range' });
    }

    // ── Rake the NET WINNINGS (economy fix 2026-05-29) ─────────────────────
    // Blackjack is a skill game (countable) → a skilled agent goes +EV. A small
    // rake on the player's NET WINNINGS (winners only) keeps the house whole
    // without changing the strategy surface. rake = floor(max(0, payout-bet)*5/100);
    // a push or loss is NOT raked. The credited payout is reduced by the rake →
    // net CT burn. Computed once here under the shoe lock; the stored
    // outcomeJson carries `rake`/`rakedPayout` so a settled-replay never re-rakes.
    const raked = computeBlackjackRake(r);

    // ── Ledger debit/credit (authed) OR demo accounting (guest) ────────────
    //
    // The base stake (+ deal-time insurance) was ALREADY committed at /hand/deal
    // (finding #3). At settle we:
    //   - debit only the INCREMENTAL stake delta `r.totalBet - stakedAmount`
    //     (the extra stake a double or each split sub-hand adds);
    //   - credit the RAKED payout `raked.rakedPayout` (gross payout minus the
    //     net-winnings rake; includes the returned base stake on wins/pushes +
    //     any insurance return).
    // `r.totalBet` MUST be >= stakedAmount (engine can only ADD stake via
    // double/split; it never reduces below the opening bet + insurance).
    const incrementalBet = r.totalBet - stakedAmount;
    if (incrementalBet < 0n) {
      // Defensive: a negative delta would mean stakedAmount exceeded the engine
      // total — impossible unless a row was tampered with. Fail loudly.
      throw new HTTPException(500, {
        message: `blackjack_stake_underflow: totalBet=${r.totalBet} < staked=${stakedAmount}`,
      });
    }
    let balanceAfter: number;
    if (isLedgerSubject(subject) && avatar) {
      // Default to the live balance; only debit/credit when there is a delta.
      const balRows = await tx.execute<{ claw_tokens: number }>(
        sql`SELECT claw_tokens FROM avatars WHERE id = ${avatar.id}`,
      );
      balanceAfter = Number(balRows[0]?.claw_tokens ?? avatar.clawTokens);

      const incrementalNumber = Number(incrementalBet);
      if (incrementalNumber > 0) {
        try {
          const debit = await debitClawTokens(
            {
              avatarId: avatar.id,
              amount: incrementalNumber,
              reason: 'cove_blackjack_stake_delta',
              source: 'api',
              metadata: { shoeId, handId, handIndex, kind: 'double_split_delta' },
              actorKind: subject.kind === 'user' ? 'human' : 'agent',
            },
            tx,
          );
          balanceAfter = debit.balanceAfter;
        } catch (err) {
          if (err instanceof InsufficientTokensError) {
            throw new HTTPException(400, {
              message: `insufficient_clawtokens_for_hand: need ${incrementalNumber}, have ${err.available}`,
            });
          }
          throw err;
        }
      }
      // Credit the RAKED payout (gross minus the net-winnings rake). The raked
      // CT is never credited → the house keeps it.
      const payoutNumber = Number(raked.rakedPayout);
      if (payoutNumber > 0) {
        const credit = await creditClawTokens(
          {
            avatarId: avatar.id,
            amount: payoutNumber,
            reason: 'cove_blackjack_payout',
            source: 'api',
            metadata: { shoeId, handId, handIndex, rake: raked.rake.toString() },
            actorKind: subject.kind === 'user' ? 'human' : 'agent',
          },
          tx,
        );
        balanceAfter = credit.balanceAfter;
      }
      // ── T0 fee routing (2026-07-07): materialize the rake as house revenue ──
      // The rake was previously a silent reduced-mint burn (withheld from the
      // player's credit and never landing anywhere). Route it to the named
      // house-treasury subject IN THIS SAME settle tx — first-settle branch
      // only (the settled/idempotency replays return before this point, so a
      // replay can never re-credit), ledger-subject branch only (guest demo
      // rake stays demo — crediting it would MINT real CT from demo chips).
      // PLAYER-SIDE UNCHANGED: the player still receives exactly
      // `raked.rakedPayout` above. rake ≤ totalPayout ≤ MAX_SAFE (checked).
      const rakeNumber = Number(raked.rake);
      if (Number.isInteger(rakeNumber) && rakeNumber > 0) {
        const treasuryId = await getHouseTreasuryAvatarId();
        if (treasuryId) {
          await creditClawTokens(
            {
              avatarId: treasuryId,
              amount: rakeNumber,
              reason: 'house_fee_blackjack_rake',
              source: 'system',
              metadata: { shoeId, handId, handIndex },
              actorKind: 'system',
            },
            tx,
          );
        } else {
          console.error(
            `[cove-blackjack] house treasury unavailable — rake ${rakeNumber} CT burned (pre-T0 behavior) for hand ${handId}`,
          );
        }
      }
    } else {
      // Guest demo accounting — no ledger writes. The base stake already folded
      // into shoeLock.total_bet at deal; here we add only the incremental stake
      // delta + the RAKED payout. Balance = starting + total_payout - total_bet.
      const newTotalBetGuest = BigInt(shoeLock.total_bet) + incrementalBet;
      const newTotalPayoutGuest = BigInt(shoeLock.total_payout) + raked.rakedPayout;
      const newDemo =
        BigInt(shoeLock.starting_balance) + newTotalPayoutGuest - newTotalBetGuest;
      if (newDemo < 0n) {
        throw new HTTPException(400, { message: 'insufficient_guest_demo_balance_at_settle' });
      }
      balanceAfter = Number(newDemo);
    }

    // ── Persist the settled hand row ───────────────────────────────────────
    // A unique (shoeId, idempotencyKey) collision (23505) here means a client
    // reused one Idempotency-Key across two terminal actions. The violation
    // aborts the WHOLE settle transaction (Postgres marks it failed) — so the
    // ledger debit/credit done earlier in THIS tx is rolled back too: no
    // double-credit, no partial write. We convert it to an IdempotencyReplay
    // signal and replay the colliding (already-settled) row in a fresh read
    // OUTSIDE the aborted tx, instead of letting it surface as an uncaught 500
    // + critical Telegram alert.
    const serialized = serializeHandResult(r, { cursorBefore, dealtBefore, nonce: handIndex });
    let settledHand: BlackjackHand | undefined;
    try {
      const updated = await tx
        .update(blackjackHands)
        .set({
          status: 'settled',
          cursorAfter: r.cursorAfter,
          dealtAfter: r.dealtAfter,
          // outcomeJson carries the GROSS figures + rake + raked figures
          // (serializeHandResult). The flat payout/net columns store the RAKED
          // (credited) figures — what actually moved on the balance.
          outcomeJson: serialized,
          payout: raked.rakedPayout.toString(),
          net: raked.rakedNet.toString(),
          idempotencyKey: idempotencyKey ?? null,
          settledAt: new Date(),
        })
        .where(and(eq(blackjackHands.id, handId), eq(blackjackHands.status, 'in_progress')))
        .returning();
      settledHand = updated[0];
    } catch (err) {
      const pgCode = (err as { code?: string } | undefined)?.code;
      if (pgCode === '23505' && idempotencyKey) {
        // Reused Idempotency-Key collided with an already-settled row for this
        // shoe. Surface a clean replay, not a 500. Re-read OUTSIDE this aborted
        // tx (the transaction is now in a failed state).
        throw new IdempotencyReplayError(shoeId, idempotencyKey);
      }
      throw err;
    }
    if (!settledHand) {
      // Concurrent settle won — re-read + replay.
      const fresh = await tx.query.blackjackHands.findFirst({ where: eq(blackjackHands.id, handId) });
      if (fresh?.status === 'settled') {
        return { hand: fresh, replay: true as const, balanceAfter: undefined as number | undefined };
      }
      throw new HTTPException(500, { message: 'hand_settle_failed' });
    }

    // ── One cove_game_events row PER HAND ──────────────────────────────────
    // serverSeedHash committed at open; revealedServerSeed NULL until shoe
    // close (commit-reveal). nonce = handIndex; sessionId = shoeId.
    await tx.insert(coveGameEvents).values({
      userId: subject.userId,
      guestFpHash: subject.guestFpHash,
      gameType: 'blackjack',
      sessionId: shoeId,
      shoeId,
      betAmount: r.totalBet.toString(),
      // RAKED payout so the cross-game economy monitor's burn = bet - payout
      // includes the rake; outcomeJson keeps the gross figures + explicit `rake`.
      payout: raked.rakedPayout.toString(),
      outcomeJson: serialized,
      serverSeedHash: shoeLock.server_seed_hash,
      revealedServerSeed: null,
      clientSeed: shoeLock.client_seed,
      nonce: handIndex,
      txSignature: null,
      engineVersion: `blackjack-engine-${BLACKJACK_ENGINE_VERSION}`,
    });

    // ── Advance shoe counters (cursor + dealt reflect committed cards) ─────
    // total_bet already includes the base stake (committed at deal); add only
    // the incremental double/split delta here so it isn't double-counted.
    const newTotalBet = (BigInt(shoeLock.total_bet) + incrementalBet).toString();
    // totalPayout uses the RAKED payout so session P&L reflects the rake kept.
    const newTotalPayout = (BigInt(shoeLock.total_payout) + raked.rakedPayout).toString();
    const newCurrentBalance = (BigInt(newTotalPayout) - BigInt(newTotalBet)).toString();
    await tx
      .update(blackjackShoes)
      .set({
        cursorCounter: r.cursorAfter,
        dealtCount: r.dealtAfter,
        totalBet: newTotalBet,
        totalPayout: newTotalPayout,
        currentBalance: newCurrentBalance,
        handsPlayed: sql`${blackjackShoes.handsPlayed} + 1`,
        lastHandAt: new Date(),
      })
      .where(eq(blackjackShoes.id, shoeId));

    return { hand: settledHand, replay: false as const, balanceAfter };
  });
  }

  const hand = txResult.hand;
  const outcome = hand.outcomeJson as SerializedHandResult;
  const dealtCount = hand.dealtAfter ?? 0;

  // Compute the response balance.
  let balance: number;
  if (txResult.replay || txResult.balanceAfter === undefined) {
    if (isLedgerSubject(subject)) {
      balance = (await loadAvatarForUser(subject.userId)).clawTokens;
    } else {
      const shoe = await db.query.blackjackShoes.findFirst({ where: eq(blackjackShoes.id, shoeId) });
      balance = shoe ? Number(guestDemoBalance(shoe)) : 0;
    }
  } else {
    balance = txResult.balanceAfter;
  }

  // Durable settle row (UNCHANGED shape) — now capturing the events.id so the
  // D7 slice-1 live settlement-confirm can cite it as the SSE cursor. The write
  // is byte-identical to before; only the return value is used.
  const settleLogP = logEventFromContextReturningId(c, {
    eventType: 'cove.blackjack.hand.settled',
    userId: ledgerUserId(subject),
    avatarId: avatar?.id ?? null,
    agentId: subject.kind === 'agent' ? subject.agentId : null,
    payload: {
      shoeId,
      handId: hand.id,
      handIndex: hand.handIndex,
      bet: hand.bet,
      payout: hand.payout,
      net: hand.net,
      isGuest: subject.kind === 'guest',
      isAgent: subject.kind === 'agent',
      replay: txResult.replay,
    },
  });
  // D7 slice-1 (DELIVERY-ONLY; money-lens review): live settlement-confirm to an
  // ONLINE agent. Durability is the row above; this is fire-and-forget and can
  // NEVER affect settlement (no ledger/control change). Fresh settles only — a
  // concurrent-settle replay already delivered its confirm on the first pass.
  if (subject.kind === 'agent' && !txResult.replay) {
    publishCoveSettlement({
      agentId: subject.agentId,
      game: 'blackjack',
      eventIdPromise: settleLogP,
      payload: {
        handId: hand.id,
        shoeId,
        handIndex: hand.handIndex,
        bet: hand.bet,
        payout: hand.payout,
        net: hand.net,
      },
    });
  } else {
    void settleLogP;
  }

  // ── Learn-through-play (Rule E5 / msg 6) ───────────────────────────────────
  // On a FRESH settle (never on an idempotent replay — that would double-write
  // the same lesson) write the agent's earned-skill memory: the hand it just
  // played, the dealer board, its decisions, and the outcome. This is per-agent
  // ElizaOS/avatar memory (subtype 'game-skill', distinct from world/protocol
  // knowledge), so accumulated play makes a connected/hosted agent measurably
  // better at the game over time. Best-effort + non-fatal — a memory write must
  // NEVER roll back a settled-CT outcome. Only AGENT subjects accrue earned
  // skill (a human's UI play is not an agent's learnable memory stream).
  if (subject.kind === 'agent' && !txResult.replay && hand.status === 'settled') {
    void recordBlackjackSkillMemory({
      avatarId: subject.avatarId,
      agentId: subject.agentId,
      shoeId,
      hand,
      outcome,
    }).catch((err) => {
      console.error('[cove-blackjack] skill-memory write failed (non-fatal):', err);
    });
  }

  return {
    handId: hand.id,
    shoeId,
    handIndex: hand.handIndex,
    status: 'settled',
    outcome,
    balance,
    totalBet: outcome.totalBet,
    totalPayout: outcome.totalPayout,
    net: outcome.net,
    rake: outcome.rake ?? '0',
    dealtCount,
    reshuffleSuggested: dealtCount >= RESHUFFLE_CARD_THRESHOLD,
    idempotencyReplay: txResult.replay,
  };
}

/** Build a settled-hand response from a stored row (idempotent replay path). */
async function buildSettledResponse(
  hand: BlackjackHand,
  shoe: BlackjackShoe,
  subject: BjSubject,
): Promise<SettledResponse> {
  const outcome = hand.outcomeJson as SerializedHandResult;
  const dealtCount = hand.dealtAfter ?? shoe.dealtCount;
  const balance =
    isLedgerSubject(subject)
      ? (await loadAvatarForUser(subject.userId)).clawTokens
      : Number(guestDemoBalance(shoe));
  return {
    handId: hand.id,
    shoeId: shoe.id,
    handIndex: hand.handIndex,
    status: 'settled',
    outcome,
    balance,
    totalBet: outcome.totalBet,
    totalPayout: outcome.totalPayout,
    net: outcome.net,
    rake: outcome.rake ?? '0',
    dealtCount,
    reshuffleSuggested: dealtCount >= RESHUFFLE_CARD_THRESHOLD,
    idempotencyReplay: true,
  };
}

// ─── POST /session/close ──────────────────────────────────────────────────────
//
// Close the shoe + reveal serverSeed on every cove_game_events row for the
// shoe (commit-reveal contract — mirrors slots /session/close).
//
// Subject-resolved (NOT requireAuth) so a connected AGENT can close its own shoe
// and reveal the seed — without this the agent could never satisfy the §7
// fairness promise and its shoe would wedge open forever at 75% penetration.
// Ledger subjects only (human or agent): a guest demo shoe has no persistent
// fairness contract to honor and the prior Lucia-only gate already excluded
// guests here, so we keep that exclusion (403) rather than widening it.

coveBlackjackRouter.post('/session/close', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = closeSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_cannot_close_shoe: sign in or connect an agent' });
  }

  const shoe = await db.query.blackjackShoes.findFirst({
    where: eq(blackjackShoes.id, parsed.data.shoeId),
  });
  if (!shoe) throw new HTTPException(404, { message: 'shoe_not_found' });
  if (!ownerMatch(shoe, subject)) throw new HTTPException(403, { message: 'shoe_not_owned' });
  if (shoe.status !== 'open') {
    throw new HTTPException(409, { message: `shoe_not_open: status=${shoe.status}` });
  }

  const closed = await db.transaction(async (tx) => {
    const lockRows = await tx.execute<{ status: string }>(
      sql`SELECT status FROM blackjack_shoes WHERE id = ${shoe.id} FOR UPDATE`,
    );
    const lock = lockRows[0];
    if (!lock) throw new HTTPException(404, { message: 'shoe_not_found' });
    if (lock.status !== 'open') {
      throw new HTTPException(409, { message: `shoe_not_open: status=${lock.status}` });
    }

    // Refuse closing with an in-progress hand — revealing the seed while the
    // player can still derive future cards from the cursor would be unfair.
    const liveHand = await tx.query.blackjackHands.findFirst({
      where: and(eq(blackjackHands.shoeId, shoe.id), eq(blackjackHands.status, 'in_progress')),
    });
    if (liveHand) {
      throw new HTTPException(409, {
        message: 'shoe_has_in_progress_hand: finish the current hand before closing',
      });
    }

    const [closedShoe] = await tx
      .update(blackjackShoes)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(blackjackShoes.id, shoe.id))
      .returning();
    if (!closedShoe) throw new HTTPException(500, { message: 'shoe_close_failed' });

    // Reveal the serverSeed on every blackjack event for this shoe.
    await tx
      .update(coveGameEvents)
      .set({ revealedServerSeed: closedShoe.serverSeed })
      .where(and(eq(coveGameEvents.sessionId, shoe.id), eq(coveGameEvents.gameType, 'blackjack')));

    return closedShoe;
  });

  void logEventFromContext(c, {
    eventType: 'cove.blackjack.shoe.closed',
    userId: subject.userId,
    agentId: subject.kind === 'agent' ? subject.agentId : null,
    payload: {
      shoeId: closed.id,
      handsPlayed: closed.handsPlayed,
      totalBet: closed.totalBet,
      totalPayout: closed.totalPayout,
      isAgent: subject.kind === 'agent',
    },
  });

  return c.json(
    {
      shoeId: closed.id,
      status: 'closed',
      serverSeed: closed.serverSeed,
      serverSeedHash: closed.serverSeedHash,
      clientSeed: closed.clientSeed,
      handsPlayed: closed.handsPlayed,
      totalBet: closed.totalBet,
      totalPayout: closed.totalPayout,
      closedAt: (closed.closedAt ?? new Date()).toISOString(),
    },
    200,
  );
});

// ─── GET /session/current ─────────────────────────────────────────────────────
//
// Subject-resolved (ledger subjects only) so a connected agent can restore its
// open shoe after a reconnect, exactly like a human after a page refresh. An
// agent + its bound human share one userId-keyed shoe, so both see the same row.

coveBlackjackRouter.get('/session/current', noStorePrivate, async (c) => {
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_has_no_persistent_shoe: sign in or connect an agent' });
  }
  const row = await db.query.blackjackShoes.findFirst({
    where: and(eq(blackjackShoes.userId, subject.userId), eq(blackjackShoes.status, 'open')),
  });
  if (!row) throw new HTTPException(404, { message: 'no_open_shoe' });
  const avatar = await loadAvatarForUser(subject.userId);
  return c.json({ shoe: publicShoe(row), walletBalance: avatar.clawTokens }, 200);
});

// ─── GET /hand/current ────────────────────────────────────────────────────────
//
// Return the AUTHORITATIVE in-progress hand's VISIBLE view for the subject's open
// shoe (read-only; NO mutation, NO money, NO ledger). The Autonomous driver calls
// this after a 409 stale_agent_decision / stale_agent_deal to RESTORE the real
// server hand instead of stranding on a cleared local view (Codex cove lens
// BLOCKING, 2026-06-03): on a stale 409 the modal must re-derive the live hand
// from the server - if one exists it keeps playing it; if the hand truly settled
// (none in_progress) the client clears. Works for ALL staleness sources (same-tab
// human takeover, deal-epoch race, external races), not just same-tab takeover.
//
// HIDDEN STATE: same discipline as /agent/decide - a stand-only peek reads ONLY
// the player's own cards + the dealer UPCARD (peek.dealer.cards[0]); never the
// hole card, the undealt shoe, or the seed. Server stays authoritative.
//
// `{ hand: null }` (200) when no in_progress hand exists - that IS the signal to
// the client to clear its local hand (the prior hand settled). A missing/foreign
// shoe is 404/403 via ownerMatch, exactly like /session/:id.

coveBlackjackRouter.get('/hand/current', noStorePrivate, async (c) => {
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_has_no_persistent_shoe: sign in or connect an agent' });
  }
  const shoe = await db.query.blackjackShoes.findFirst({
    where: and(eq(blackjackShoes.userId, subject.userId), eq(blackjackShoes.status, 'open')),
  });
  if (!shoe) throw new HTTPException(404, { message: 'no_open_shoe' });

  const liveHand = await db.query.blackjackHands.findFirst({
    where: and(eq(blackjackHands.shoeId, shoe.id), eq(blackjackHands.status, 'in_progress')),
  });
  // No live hand → the prior hand settled. Tell the client to clear (null).
  if (!liveHand) {
    return c.json({ hand: null, shoeId: shoe.id }, 200);
  }

  const seedState: ShoeSeedState = {
    id: shoe.id,
    serverSeed: shoe.serverSeed,
    clientSeed: shoe.clientSeed,
  };
  const script = loadScript(liveHand);
  let peek: HandResult;
  try {
    peek = await dryRunHand(seedState, liveHand, script, db);
  } catch (err) {
    // A peek failure is a server-state problem, not a client one - surface 500
    // rather than a misleading "no hand" (which would wrongly clear the client).
    throw new HTTPException(500, { message: `hand_peek_failed: ${(err as Error).message}` });
  }

  // Insurance is offered only on a dealer-Ace upcard, before any main action.
  const dealerUpcard = peek.dealer.cards[0] ?? null;
  const noDecisionsYet = !script.didSplit && script.hands.every((h) => h.length === 0);
  const insuranceOffered = dealerUpcard?.rank === 'A' && noDecisionsYet;

  return c.json(
    {
      handId: liveHand.id,
      shoeId: shoe.id,
      handIndex: liveHand.handIndex,
      status: 'in_progress' as const,
      // Same visible shape /action's non-terminal response returns (upcard only).
      // `isResolved` is the server-authoritative per-sub-hand terminal flag — the
      // client CANNOT derive it from cards/total/isBust (a stood-21 and a live-21
      // are byte-identical on the wire), so the server MUST send it. Derived from
      // the SAME peek/script already computed; reveals no hidden state.
      playerHands: peek.playerHands.map((h, slot) => ({
        cards: h.cards,
        total: h.total,
        isSoft: h.isSoft,
        isBust: h.isBust,
        isResolved: subHandResolved(script, peek, slot),
      })),
      dealerUpcard,
      didSplit: script.didSplit,
      insuranceOffered,
      tookInsurance: liveHand.tookInsurance,
      bet: liveHand.bet,
    },
    200,
  );
});

// ─── GET /session/:id ─────────────────────────────────────────────────────────
//
// Owner-only shoe detail (serverSeed redacted while open). Subject-resolved so an
// agent can inspect its own shoe; ownerMatch binds to the resolved userId, so an
// agent can never read another user's shoe by id.

coveBlackjackRouter.get('/session/:id', noStorePrivate, async (c) => {
  const shoeId = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(shoeId)) {
    throw new HTTPException(400, { message: 'invalid_shoe_id' });
  }
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_cannot_inspect_shoe: sign in or connect an agent' });
  }
  const row = await db.query.blackjackShoes.findFirst({ where: eq(blackjackShoes.id, shoeId) });
  if (!row) throw new HTTPException(404, { message: 'shoe_not_found' });
  if (!ownerMatch(row, subject)) throw new HTTPException(403, { message: 'shoe_not_owned' });
  return c.json({ shoe: publicShoe(row) }, 200);
});

// ─── POST /agent/decide — human-supervised Autonomous decision relay ──────────
//
// The [cards] msg3 / Rule E5 human-supervised Autonomous surface. A HUMAN at
// /game with a connected/hosted agent flips the BlackjackModal to Autonomous;
// the BROWSER (human Lucia cookie) asks THIS endpoint for the agent's next
// decision on the human's open table, then — after the 8s/15s human-input
// window enforced client-side — applies it through the EXISTING authed
// /hand/deal or /action path. This relay is a PURE DECISION ORACLE: it asks the
// human's bound agent runtime for a move and returns it. It NEVER deals, never
// settles, never writes the ledger — no duplicated engine/money logic (the
// settle stays on the one audited path the human's own clicks use).
//
// AUTH: requireAuth (Lucia). The human owns the table; we resolve THEIR bound
// connected agent and ask its runtime. This is deliberately NOT the agent-
// session-header surface (that's the agent-plays-from-its-own-runtime path).
//
// HIDDEN STATE: the prompt we send the agent carries ONLY the player's own
// cards + the dealer UPCARD + legal actions + bet bounds. We read peek.dealer
// .cards[0] exclusively — never cards[1] (hole) or the remaining shoe or the
// seed. Server stays authoritative; the agent sees exactly what a human sees.

const decideSchema = z
  .object({
    shoeId: z.string().uuid(),
    // handId + handSlot are ACCEPTED (the modal sends them as its current view)
    // but IGNORED for safety — the server derives the AUTHORITATIVE in-progress
    // hand + active slot from the shoe itself, so a client can't aim the agent
    // at a stale/foreign hand or a slot it doesn't actually own. `null` is
    // allowed (the modal sends handId:null at idle when no hand is live).
    handId: z.string().uuid().nullable().optional(),
    handSlot: z.number().int().min(0).max(1).optional(),
  })
  // NOT .strict() — tolerate extra client fields (the modal may add UI-only
  // keys over time) without 400ing the whole Autonomous request. We read only
  // shoeId; everything else is advisory and re-derived server-side.
  ;

/** The decision vocabulary the relay can return (mirrors the play actions + deal). */
const DECIDE_ACTIONS = ['deal', 'hit', 'stand', 'double', 'split', 'surrender', 'insure'] as const;
type DecideAction = (typeof DECIDE_ACTIONS)[number];

/**
 * Parse a free-text agent completion into ONE decision token. Accepts a bare
 * word, an [ACTION: name(...)] tag, or a token embedded in prose; for 'deal'
 * also extracts a bet amount (`bet 50`, `amount=50`, `deal 50`). Returns null
 * when nothing parseable is found (caller → 422 agent_undecided). First match
 * in priority order wins so "I'll stand, not hit" resolves deterministically to
 * the FIRST surface token.
 */
function parseAgentDecision(
  reply: string,
  legal: ReadonlySet<DecideAction>,
): { action: DecideAction; amount?: number } | null {
  if (!reply) return null;
  const lower = reply.toLowerCase();

  // Find the earliest-occurring legal action keyword in the text, matched at a
  // WORD BOUNDARY so "understand"/"within"/"doubled" don't false-trigger
  // stand/hit/double. 'insure' also matches "insurance" (\binsur...).
  let best: { action: DecideAction; index: number } | null = null;
  for (const action of DECIDE_ACTIONS) {
    if (!legal.has(action)) continue;
    const re = action === 'insure' ? /\binsur\w*/ : new RegExp(`\\b${action}\\w*`);
    const m = re.exec(lower);
    if (m && (best === null || m.index < best.index)) {
      best = { action, index: m.index };
    }
  }
  if (!best) return null;

  if (best.action === 'deal') {
    // Extract a bet amount near the deal token; default to BLACKJACK_MIN_BET.
    const m = lower.match(/(?:bet|amount|deal|stake)\D{0,8}(\d{1,6})/) ?? lower.match(/\b(\d{1,6})\b/);
    let amount = m ? parseInt(m[1]!, 10) : BLACKJACK_MIN_BET;
    if (!Number.isFinite(amount)) amount = BLACKJACK_MIN_BET;
    amount = Math.max(BLACKJACK_MIN_BET, Math.min(BLACKJACK_MAX_BET, Math.floor(amount)));
    return { action: 'deal', amount };
  }
  return { action: best.action };
}

/** Strip [ACTION:...] tags + collapse whitespace so the rationale is clean prose. */
function cleanRationale(reply: string): string {
  return reply
    .replace(/\[ACTION:[^\]]*\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 280);
}

coveBlackjackRouter.post('/agent/decide', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = decideSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const user = c.get('user')!;

  // The shoe must exist, be open, and belong to THIS human.
  const shoe = await db.query.blackjackShoes.findFirst({
    where: eq(blackjackShoes.id, parsed.data.shoeId),
  });
  if (!shoe) return c.json({ error: 'no_open_shoe' }, 404);
  if (shoe.userId !== user.id) return c.json({ error: 'shoe_not_owned' }, 403);
  if (shoe.status !== 'open') return c.json({ error: 'shoe_not_open' }, 409);

  // Resolve the human's bound connected agent + its LIVE session client. The
  // agent must be currently connected (a live npc-simulation session) for us to
  // synchronously ask it; otherwise there's nothing to relay → fall back.
  const bot = await db.query.agentBots.findFirst({
    where: eq(agentBots.userId, user.id),
    columns: { agentId: true },
  });
  if (!bot) return c.json({ error: 'no_connected_agent' }, 404);
  const liveSessions = npcSimulation.findActiveSessionsByAgentIds([bot.agentId]);
  const liveSessionId = liveSessions[0];
  if (!liveSessionId) return c.json({ error: 'no_connected_agent' }, 404);
  const client = npcSimulation.getAgentBotClientBySession(liveSessionId);
  if (!client) return c.json({ error: 'no_connected_agent' }, 404);
  // nanoclaw/self-managed agents pull world-state + decide client-side; they
  // can't be synchronously asked via gateway push (chat() returns ''), so the
  // human-supervised relay can't drive them. Honest 503 → driver shows notice.
  if (client.getProtocol() === 'nanoclaw') {
    return c.json({ error: 'agent_unavailable', reason: 'self_managed_agent' }, 503);
  }

  const seedState: ShoeSeedState = {
    id: shoe.id,
    serverSeed: shoe.serverSeed,
    clientSeed: shoe.clientSeed,
  };

  // Derive the AUTHORITATIVE in-progress hand from the shoe (ignore any
  // client-supplied handId). No in-progress hand → the decision is whether to
  // open the next hand (action 'deal').
  const liveHand = await db.query.blackjackHands.findFirst({
    where: and(eq(blackjackHands.shoeId, shoe.id), eq(blackjackHands.status, 'in_progress')),
  });

  // Build the VISIBLE hand-state prompt (player cards + dealer UPCARD + legal
  // actions + bet bounds). Strictly no hole card / undealt / seed.
  let promptState: string;
  const legal = new Set<DecideAction>();
  let targetHandId: string | null = null;
  let targetHandSlot: 0 | 1 = 0;
  // The decision version of the hand the agent is deciding for. Threaded back to
  // /action as `expectedHandVersion` so a human tap that advances the hand before
  // this (possibly in-flight) decision applies is rejected server-side. null when
  // no hand is live (the decision is a 'deal', which opens a fresh hand and has
  // no version to guard). MUST use the same definition /action enforces against.
  let targetHandVersion: number | null = null;

  if (!liveHand) {
    legal.add('deal');
    const demoNote =
      shoe.dealtCount >= RESHUFFLE_CARD_THRESHOLD
        ? ' The shoe has passed 75% penetration; a deal will require a fresh shoe.'
        : '';
    promptState =
      `You are playing blackjack at the ClawVille Cove with your own vCLAW. ` +
      `No hand is in progress.${demoNote} Decide your next move: deal a new hand ` +
      `(bet ${BLACKJACK_MIN_BET}-${BLACKJACK_MAX_BET} vCLAW) or stop. ` +
      `Reply with exactly one decision: "deal <bet>".`;
  } else {
    const script = loadScript(liveHand);
    let peek: HandResult;
    try {
      peek = await dryRunHand(seedState, liveHand, script, db);
    } catch (err) {
      return c.json({ error: 'agent_unavailable', reason: 'state_peek_failed' }, 503);
    }
    // UPCARD ONLY — never the hole card.
    const dealerUpcard = peek.dealer.cards[0];
    // Active sub-hand: for a split, the first non-terminal slot; else slot 0.
    const activeSlot = script.didSplit
      ? script.hands.findIndex((h) => {
          const last = h[h.length - 1];
          return last !== 'stand' && last !== 'double' && last !== 'surrender';
        })
      : 0;
    targetHandSlot = (activeSlot < 0 ? (script.didSplit ? 1 : 0) : activeSlot) as 0 | 1;
    const active = peek.playerHands[targetHandSlot] ?? peek.playerHands[0]!;
    targetHandId = liveHand.id;
    // Stamp the version the agent is deciding at (same definition /action
    // enforces). `script` already carries the authoritative tookInsurance via
    // loadScript, so the insurance term matches what /action recomputes.
    targetHandVersion = handDecisionVersion(script);

    // Legal actions for the active sub-hand.
    legal.add('hit');
    legal.add('stand');
    const isTwoCard = active.cards.length === 2;
    if (isTwoCard) legal.add('double');
    if (isTwoCard && !script.didSplit && active.cards[0]?.rank === active.cards[1]?.rank) {
      legal.add('split');
    }
    if (isTwoCard && !script.didSplit) legal.add('surrender');
    // Insurance: dealer-Ace upcard, before any main-hand action, not yet taken.
    const noDecisionsYet = !script.didSplit && script.hands.every((h) => h.length === 0);
    if (dealerUpcard?.rank === 'A' && noDecisionsYet && !script.tookInsurance) {
      legal.add('insure');
    }

    const playerStr = peek.playerHands
      .map((h, i) => `hand${i} [${h.cards.map((cd) => cd.rank).join(' ')}] total ${h.total}${h.isSoft ? ' (soft)' : ''}`)
      .join('; ');
    promptState =
      `You are playing blackjack at the ClawVille Cove with your own vCLAW. ` +
      `Your cards: ${playerStr}. Dealer shows: ${dealerUpcard?.rank ?? '?'} (the hole card is hidden). ` +
      `It is your turn on hand${targetHandSlot}. Legal actions: ${[...legal].join(', ')}. ` +
      `Reply with exactly one of those words as your decision.`;
  }

  // Ask the agent's runtime. chat() fails soft (returns '') on any error.
  let reply = '';
  try {
    reply = await client.chat([{ role: 'user', content: promptState }]);
  } catch (err) {
    console.error('[cove-blackjack] agent decide cognition error (fail soft):', err);
    return c.json({ error: 'agent_unavailable', reason: 'cognition_error' }, 503);
  }
  if (!reply || reply.trim().length === 0) {
    return c.json({ error: 'agent_unavailable', reason: 'empty_reply' }, 503);
  }

  const decision = parseAgentDecision(reply, legal);
  if (!decision) {
    return c.json({ error: 'agent_undecided', raw: reply.slice(0, 200) }, 422);
  }

  void logEventFromContext(c, {
    eventType: 'cove.blackjack.agent.decided',
    userId: user.id,
    agentId: bot.agentId,
    payload: {
      shoeId: shoe.id,
      handId: targetHandId,
      action: decision.action,
      amount: decision.amount ?? null,
      via: 'human-supervised-relay',
    },
  });

  return c.json(
    {
      action: decision.action,
      ...(decision.action === 'deal' ? { amount: decision.amount } : {}),
      handId: decision.action === 'deal' ? null : targetHandId,
      handSlot: targetHandSlot,
      // The decision version of the hand the agent decided for; the driver passes
      // it back to /action as `expectedHandVersion`. null for 'deal' (no hand to
      // guard) and for any decision made when no hand was live.
      handVersion: decision.action === 'deal' ? null : targetHandVersion,
      // Shoe EPOCH for a 'deal' decision (Codex concurrency lens, BLOCKING #2):
      // the shoe's handCounter snapshot at decision time. The driver threads it
      // back to /hand/deal as `expectedHandsPlayed`; under the shoe lock the deal
      // rejects (409 stale_agent_deal) if a hand was opened in the meantime - so a
      // stale agent 'deal' can't open an EXTRA hand after an intervening human
      // deal (even one that instantly natural-settled). null for non-deal verbs
      // (those are guarded by handVersion against the live hand instead).
      expectedHandsPlayed: decision.action === 'deal' ? shoe.handCounter : null,
      rationale: cleanRationale(reply),
      source: 'agent' as const,
    },
    200,
  );
});

/**
 * @internal TEST-ONLY seam. `settleHand` is the money-settling fn whose
 * defense-in-depth `hand_shoe_mismatch` guard (load the hand by BOTH (id,
 * shoeId), never handId alone) is unreachable through the public routes — every
 * live call site passes a matching (hand.shoeId, hand.id) pair. Exporting it lets
 * the regression suite drive a caller-owned shoeId + a foreign handId and assert
 * the 409, locking the Codex money-lens BLOCKING #1 fix. NOT a public API; the
 * router default export is the only runtime surface. Mirrors the existing
 * `__resetBlackjackRateLimits` test-only export convention.
 */
export const __settleHandForTest = settleHand;

export default coveBlackjackRouter;
