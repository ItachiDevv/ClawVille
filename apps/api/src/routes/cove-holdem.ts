/**
 * Phase 6.5.1 — Cove No-Limit Texas Hold'em AUTHORITATIVE route (replaces the
 * 6.5.0 display-only mock). 6-max: 1 human/agent seat (seat 0) + 5 house BOTS.
 *
 * Mount: `app.route('/api/cove/holdem', coveHoldemRouter)` from index.ts.
 *
 * Surfaces (mirror cove-blackjack.ts):
 *
 *   POST /session/open    (auth optional) — open a commit-reveal table session,
 *                                           buy in, commit serverSeedHash
 *   POST /hand/deal       (auth optional) — start the next hand: rotate button,
 *                                           post blinds, deal, run bots to the
 *                                           first human decision (or showdown)
 *   POST /action          (auth optional) — one human decision (fold|check|call|
 *                                           bet|raise); server runs bots to the
 *                                           next human turn or settles at showdown
 *   POST /session/close   (user or agent)  — close the session, reveal serverSeed,
 *                                           cash out the player's remaining stack
 *   GET  /session/current (user or agent)  — restore the open table
 *   GET  /session/:id     (user or agent)  — owner-only table detail (seed redacted)
 *
 * Model mirrors cove-blackjack.ts (the audited template), EXTENDED for agent parity
 * (Rule E5 — human↔agent parity on a money path, 2026-06-15):
 *   - getSubject(c): authed human (Lucia) OR a connected/hosted AGENT playing AS
 *     ITSELF (X-Clawville-Agent-Session header → its bound avatar's userId) OR a
 *     guest (100 demo CT). Human + agent are BOTH real-CT "ledger subjects" — an
 *     agent table is just a `userId` table, so the DB `userId XOR guestFpHash`
 *     check constraint still holds and the audited buy-in/settle/cash-out path is
 *     reused verbatim (the agent kind adds NO new money branch — see
 *     `isLedgerSubject`). Agents are NEVER routed to the guest/demo tier. Guests
 *     never touch the ClawTokens ledger.
 *   - SETTLEMENT vs LEADERBOARD (parity scope): for a ledger subject (human OR
 *     agent) this route does REAL CT buy-in + cash-out + per-hand stack settlement
 *     with full parity. It emits NO leaderboard-scoring event for ANY subject (the
 *     Cove writes no `activity.match.placed`); that is a SEPARATE pre-existing gap,
 *     not an agent-only one.
 *   - claw-token-ledger debit/credit is the ONLY balance write path, composed
 *     into the transaction via the passed `tx`.
 *   - STACK MODEL (poker, distinct from blackjack's per-hand stake): the human
 *     BUYS IN for `buyInStack` CT at session/open (authed: debited from
 *     avatar.clawTokens into the table's playerStack; guest: demo grant of 100).
 *     The playerStack column is the authoritative bankroll for every hand. At
 *     session/close the REMAINING playerStack is cashed out (authed: credited
 *     back; guest: discarded). No per-hand open-time debit — chips move within
 *     playerStack, and only the buy-in (open) + cash-out (close) cross the
 *     ledger boundary. This is the standard poker custody model and means an
 *     abandoned in-progress hand simply leaves the chips committed (the human
 *     already "paid" them at buy-in), so there is no free-peek exploit.
 *   - Each hand shuffles a FRESH 52-card deck from (serverSeed, clientSeed,
 *     nonce=handIndex, cursor=0) — NO shared shoe, NO cross-hand cursor drift.
 *     Replaying a hand needs only (seed, handIndex), so the verifier is simple.
 *   - One cove_game_events row PER HAND (gameType='holdem', sessionId=tableId,
 *     nonce=handIndex, serverSeedHash at open, revealedServerSeed NULL until
 *     session close).
 *   - Settle is idempotent: a hand's status flips in_progress→settled exactly
 *     once UNDER the table FOR UPDATE row lock; a re-POST replays the stored
 *     outcome — never a double-credit. An Idempotency-Key (per terminal action)
 *     is the race-safe backstop via the partial unique (tableId, idempotencyKey).
 *   - The engine recompute happens UNDER the table row lock with the
 *     authoritative startingStack + recorded actions so a stale pre-lock read can
 *     never commit a different outcome.
 *
 * Server is AUTHORITATIVE: the client NEVER sends cards or outcomes. It sends
 * ONLY the human's action (fold|check|call|bet|raise + amount). The engine
 * (holdem-engine.ts) runs all bot turns, deals every street, and resolves
 * showdown + side pots.
 *
 * Currency seam: `currency` defaults to 'clawtoken'. SOL/USDC return 501 until
 * the later tier wires custody — exactly like cove-blackjack. NO escrow here.
 *
 * Guest demo-CT farming — ACCEPTED RISK (identical posture to cove-blackjack):
 * a fingerprint-rotating guest gets a fresh 100 demo-CT table. Safe TODAY
 * because the guest path NEVER touches avatars.clawTokens or the ledger: the
 * demo stack lives entirely on the table row (playerStack), guest play feeds
 * nothing persistent. Blast radius is free unlimited demo play, not custody
 * loss. The SOL/USDC tier MUST add a durable per-subject grant ledger before
 * reusing this guest accounting.
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
  holdemTables,
  holdemHands,
  coveGameEvents,
  type HoldemTable,
  type HoldemHand,
} from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { resolveAgentSession } from '../middleware/require-auth-or-agent';
import { createServerSeed } from '../services/provable-rng';
import {
  playHand,
  serializeHoldemHand,
  computeHoldemRake,
  SMALL_BLIND,
  BIG_BLIND,
  SEATS,
  HUMAN_SEAT,
  HOLDEM_ENGINE_VERSION,
  type HoldemActionRecord,
  type HoldemActionType,
  type HoldemHandResult,
  type SerializedHoldemHand,
} from '../services/holdem-engine';
import {
  creditClawTokens,
  debitClawTokens,
  InsufficientTokensError,
} from '../services/claw-token-ledger';
import { logEventFromContext } from '../services/event-logger';
import type { AppContext } from '../types';

export const coveHoldemRouter = new Hono<AppContext>();
coveHoldemRouter.use('*', sessionMiddleware);

// ─── Constants ──────────────────────────────────────────────────────────────

/** Buy-in bounds (LOCKED rule): min 20 / max 500 CT. Default 100. */
export const HOLDEM_MIN_BUYIN = 20;
export const HOLDEM_MAX_BUYIN = 500;
export const HOLDEM_DEFAULT_BUYIN = 100;

/** Per-bot stack each hand (house seats, ephemeral). Default buy-in. */
const BOT_STACK = 100n;

/** Currency seam — ClawTokens live; SOL/USDC return 501 (later tier). */
const SUPPORTED_CURRENCIES = ['clawtoken', 'sol', 'usdc'] as const;

/** Max length on the Idempotency-Key header (Stripe convention; matches blackjack). */
const IDEMPOTENCY_KEY_MAX_LEN = 64;

/** Guest demo wallet (fun-money), mirrors cove-blackjack guest tier. */
const GUEST_STARTING_BALANCE = 100n;

// ─── Rate limits (mirror cove-blackjack) ─────────────────────────────────────

interface RateBucket {
  count: number;
  resetAt: number;
}

const ACTION_RATE_LIMIT = 120; // per-decision, chatty like blackjack
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
      message: `cove_holdem_rate_limit: max ${ACTION_RATE_LIMIT} actions/min`,
    });
  }
}

const GUEST_TABLE_OPEN_LIMIT = 10;
const GUEST_TABLE_OPEN_WINDOW_MS = 60 * 60 * 1_000;
const guestTableOpenBuckets = new Map<string, RateBucket>();

function checkGuestTableOpenRate(fpHash: string): void {
  const now = Date.now();
  if (guestTableOpenBuckets.size > 10_000) {
    for (const [k, v] of guestTableOpenBuckets) {
      if (now > v.resetAt) guestTableOpenBuckets.delete(k);
    }
  }
  const entry = guestTableOpenBuckets.get(fpHash);
  if (!entry || now > entry.resetAt) {
    guestTableOpenBuckets.set(fpHash, { count: 1, resetAt: now + GUEST_TABLE_OPEN_WINDOW_MS });
    return;
  }
  entry.count++;
  if (entry.count > GUEST_TABLE_OPEN_LIMIT) {
    throw new HTTPException(429, {
      message: `cove_holdem_guest_table_rate_limit: max ${GUEST_TABLE_OPEN_LIMIT} guest tables/hour. Sign up to keep playing.`,
    });
  }
}

/** Test-only resets. */
export function __resetHoldemRateLimits(): void {
  actionRateBuckets.clear();
  guestTableOpenBuckets.clear();
}

// ─── Subject resolution (user OR agent OR guest, never combined) ─────────────
//
// THREE subject kinds (Rule E5 — human↔agent parity), VERBATIM in semantics with
// cove-blackjack.ts's BjSubject / getSubject:
//   - 'user'  — Lucia-authed human. Settles in REAL CT on `avatars.clawTokens`.
//   - 'agent' — a connected/hosted agent playing AS ITSELF via the agent gateway
//     session header. Resolves through `resolveAgentSession` → its BOUND avatar's
//     `userId`/`avatarId`, and buys in / settles / cashes out in the SAME real-CT
//     ledger path as a human. An agent is NEVER routed to the guest demo tier —
//     that XOR-with-guest gap was the E5 violation this fixes.
//   - 'guest' - anonymous fingerprint, demo-CT only (no ledger).
//
// Money parity rule: 'user' and 'agent' are both LEDGER subjects (they carry a
// real `userId`/`avatarId` and write the ClawToken ledger). `isLedgerSubject()`
// collapses the two for every balance/owner branch so the audited buy-in/settle/
// cash-out path is reused verbatim — the agent kind adds NO new money code path.
//
// The agent-session header name matches the existing activity-portal convention
// (`require-auth-or-agent.ts`); Hono lower-cases header reads so case-insensitive.

const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';

type ThSubject =
  | { kind: 'user'; userId: string; avatarId: null; agentId: null; sessionId: null; guestFpHash: null }
  | { kind: 'agent'; userId: string; avatarId: string; agentId: string; sessionId: string; guestFpHash: null }
  | { kind: 'guest'; userId: null; avatarId: null; agentId: null; sessionId: null; guestFpHash: string };

/**
 * Resolve the request subject. Precedence: Lucia human → agent session → guest.
 *
 * Async (was sync) because the agent branch does a DB lookup to map the opaque
 * session id → bound avatar/user. An agent session that resolves to a bot WITHOUT
 * a ledger-capable, avatar-bound state is a 401/403 (it can perceive/chat but
 * cannot stake real CT) — it does NOT fall through to the guest tier (silently
 * demoting a connected agent to demo play is the exact E5 violation). A logged-in
 * human cookie ALWAYS wins over an agent header on the same request.
 */
async function getSubject(c: {
  get(key: 'user'): { id: string } | null;
  get(key: 'fpHash'): string;
  req: { header(name: string): string | undefined };
}): Promise<ThSubject> {
  const user = c.get('user');
  if (user) {
    return { kind: 'user', userId: user.id, avatarId: null, agentId: null, sessionId: null, guestFpHash: null };
  }

  const agentSessionId = c.req.header(AGENT_SESSION_HEADER);
  if (agentSessionId) {
    const resolved = await resolveAgentSession(agentSessionId);
    if (!resolved) {
      throw new HTTPException(401, { message: 'invalid_or_expired_agent_session' });
    }
    // Ledger-capability gate (mirrors cove-blackjack). A session that did NOT
    // prove ownership of its bound avatar is `ledgerCapable === false`: it may
    // perceive/chat in-world but must NOT spend the avatar's REAL CT here. Reject
    // 403 BEFORE the avatar-binding check — NOT a guest fall-through.
    if (!resolved.ledgerCapable) {
      throw new HTTPException(403, { message: 'agent_session_not_ledger_authorized' });
    }
    if (!resolved.userId || !resolved.avatarId) {
      throw new HTTPException(403, {
        message:
          'agent_session_has_no_active_avatar: connect an avatar before playing the Cove for real ClawTokens',
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

  const fpHash = c.get('fpHash');
  if (!fpHash) {
    throw new HTTPException(500, { message: 'fpHash_missing_for_guest_request' });
  }
  return { kind: 'guest', userId: null, avatarId: null, agentId: null, sessionId: null, guestFpHash: fpHash };
}

/**
 * The real-CT ledger userId for a subject, or null for a guest. 'user' and
 * 'agent' are BOTH ledger subjects — this collapses them so the money path /
 * event userId is written once.
 */
function ledgerUserId(subject: ThSubject): string | null {
  return subject.kind === 'guest' ? null : subject.userId;
}

/** True iff the subject settles in real CT (human or agent). */
function isLedgerSubject(
  subject: ThSubject,
): subject is Extract<ThSubject, { kind: 'user' | 'agent' }> {
  return subject.kind !== 'guest';
}

function subjectKey(subject: ThSubject): string {
  if (subject.kind === 'guest') return `g:${subject.guestFpHash}`;
  // 'user' and 'agent' rate-limit on userId — an agent and its bound human share
  // one avatar/wallet, so they SHOULD share one action-rate bucket (you can't
  // dodge the limit by toggling between cookie + agent header on one avatar).
  return `u:${subject.userId}`;
}

/**
 * A real-CT table is keyed on `userId` (NOT on agent/guest). Both human and agent
 * subjects for the same bound avatar therefore see + own the SAME table — an agent
 * playing AS its avatar continues the human's session, never forks a parallel one.
 * Guests own by fingerprint.
 */
function ownerMatch(table: { userId: string | null; guestFpHash: string | null }, subject: ThSubject): boolean {
  return isLedgerSubject(subject)
    ? table.userId === subject.userId
    : table.guestFpHash === subject.guestFpHash;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const openSchema = z
  .object({
    currency: z.enum(SUPPORTED_CURRENCIES).default('clawtoken'),
    buyIn: z.number().int().min(HOLDEM_MIN_BUYIN).max(HOLDEM_MAX_BUYIN).default(HOLDEM_DEFAULT_BUYIN),
  })
  .strict();

const dealSchema = z
  .object({
    tableId: z.string().uuid(),
  })
  .strict();

const ACTION_TYPES = ['fold', 'check', 'call', 'bet', 'raise'] as const;

const actionSchema = z
  .object({
    handId: z.string().uuid(),
    action: z.enum(ACTION_TYPES),
    /** Required for bet/raise — TOTAL chips the human wants in front this street. */
    amount: z.number().int().positive().optional(),
  })
  .strict();

const closeSchema = z
  .object({
    tableId: z.string().uuid(),
  })
  .strict();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadTableOrThrow(tableId: string): Promise<HoldemTable> {
  const table = await db.query.holdemTables.findFirst({ where: eq(holdemTables.id, tableId) });
  if (!table) throw new HTTPException(404, { message: 'table_not_found' });
  return table;
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

/**
 * Public table shape. serverSeed REDACTED while status='open' (revealing it
 * would let the player pre-compute future hands' decks — defeats commit-reveal).
 */
function publicTable(row: HoldemTable) {
  return {
    id: row.id,
    userId: row.userId,
    currency: row.currency,
    serverSeedHash: row.serverSeedHash,
    clientSeed: row.clientSeed,
    handCounter: row.handCounter,
    buyInStack: row.buyInStack,
    playerStack: row.playerStack,
    startingBalance: row.startingBalance,
    totalBet: row.totalBet,
    totalPayout: row.totalPayout,
    status: row.status,
    handsPlayed: row.handsPlayed,
    createdAt: row.createdAt.toISOString(),
    lastHandAt: row.lastHandAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    serverSeed: row.status === 'open' ? null : row.serverSeed,
    smallBlind: SMALL_BLIND.toString(),
    bigBlind: BIG_BLIND.toString(),
    seats: SEATS,
  };
}

/** Convert a recorded jsonb actions list to typed engine action records. */
function loadActions(hand: HoldemHand): HoldemActionRecord[] {
  const raw = hand.actions as HoldemActionRecord[];
  if (!Array.isArray(raw)) return [];
  return raw;
}

/** Run the engine for a hand from its recorded actions + the table seed.
 * Exported for the route's pure in-progress-view regression tests. */
export function runEngine(
  table: { serverSeed: string; clientSeed: string },
  hand: { handIndex: number; buttonSeat: number; startingStack: string },
  actions: HoldemActionRecord[],
): HoldemHandResult {
  return playHand({
    serverSeed: table.serverSeed,
    clientSeed: table.clientSeed,
    nonce: hand.handIndex,
    buttonSeat: hand.buttonSeat,
    humanStartingStack: BigInt(hand.startingStack),
    botStartingStack: BOT_STACK,
    humanActions: actions,
  });
}

/**
 * Probe how many human decisions the engine consumes for a given action list,
 * and whether the hand is already terminal (no more human turns required).
 * We run the engine with a SENTINEL action appended; if the engine never asks
 * for it, the recorded actions were sufficient (the hand is done OR the human
 * isn't next). We distinguish "done" from "needs another human action" by
 * checking whether the human is still live AND it's still a betting hand.
 *
 * Rather than instrument the engine, we use a simpler authoritative check:
 *   - Append a 'fold' sentinel. If the engine THROWS "ran out of human actions"
 *     with ONLY the recorded actions, the human still has a turn → not terminal.
 *   - If it runs to completion with the recorded actions alone, it's terminal.
 *
 * This keeps the engine pure (no callback) and the route the sole orchestrator.
 */
function isHandTerminal(
  table: { serverSeed: string; clientSeed: string },
  hand: { handIndex: number; buttonSeat: number; startingStack: string },
  actions: HoldemActionRecord[],
): boolean {
  try {
    runEngine(table, hand, actions);
    return true; // engine completed without needing more human input
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('ran out of human actions')) {
      return false; // human still has a turn to act
    }
    // Any other error is a genuine illegal-script / engine bug — surface it.
    throw new HTTPException(400, { message: `holdem_engine_error: ${msg}` });
  }
}

/**
 * Compute the CURRENT visible state for an in-progress hand so the client can
 * keep acting. Runs the engine with a synthetic terminal action appended for
 * EACH not-yet-resolved street so the engine accepts the (mid-play) script for a
 * peek without changing the human's real committed chips beyond what they've
 * recorded. We append 'fold' as the synthetic — folding draws no cards and
 * resolves the human's seat, letting us read the dealt board + the human's
 * to-act context up to the point they actually reached.
 *
 * NOTE: this peek is for DISPLAY ONLY. It is never persisted. The authoritative
 * settle recomputes from the REAL recorded actions under the lock.
 */
export function peekState(
  table: { serverSeed: string; clientSeed: string },
  hand: { handIndex: number; buttonSeat: number; startingStack: string },
  actions: HoldemActionRecord[],
): {
  humanHole: HoldemHandResult['seats'][number]['holeCards'];
  board: HoldemHandResult['board'];
  toCall: string;
  currentBet: string;
  humanStack: string;
  humanCommitted: string;
} {
  // Reconstruct the live betting context by replaying the recorded actions and
  // stopping right where the human is next to act. We do this by running the
  // engine with a synthetic 'fold' appended and inspecting the resulting human
  // seat. CRITICAL FAIRNESS NOTE: appending the human's fold RESOLVES the entire
  // hand — the remaining bots play on to showdown, so the engine deals ALL FIVE
  // community cards and `peek.board` is the FULL board regardless of which street
  // the human is actually on. We MUST NOT return that full board: a preflop
  // decision would over-reveal the flop/turn/river, the flop would over-reveal
  // turn/river, etc. — letting a connected agent (or the human) see undealt cards
  // before betting (a critical money/fairness leak). So we truncate `peek.board`
  // to exactly the community cards visible at the human's CURRENT street:
  // preflop=0, flop=3, turn=4, river=5.
  //
  // humanHole, toCall, currentBet, and the human's committed/stack are all FINE
  // from the fold-peek — folding does not change the human's already-dealt hole
  // cards nor their committed-so-far on the current street, and we derive
  // toCall/currentBet from the action log (not from any future bot action).
  const peek = runEngine(table, hand, [...actions, { type: 'fold' }]);
  const human = peek.seats.find((s) => s.isHuman)!;
  // The human's CURRENT street = the street the synthetic fold landed on (the
  // last human entry in the action log). toCall/currentBet are recomputed from
  // that street's commitments; the visible board count is fixed by that street.
  const ctx = deriveToCall(peek, actions.length);
  const visibleBoardCount = visibleBoardCountForStreet(ctx.humanStreet);
  return {
    humanHole: human.holeCards,
    // Truncate to ONLY the cards dealt by the human's current street. Never the
    // full fold-peek board (which always contains all 5).
    board: peek.board.slice(0, visibleBoardCount),
    toCall: ctx.toCall.toString(),
    currentBet: ctx.currentBet.toString(),
    humanStack: (BigInt(hand.startingStack) - human.committed).toString(),
    humanCommitted: human.committed.toString(),
  };
}

/**
 * Number of community cards visible to a player who is currently to act on a
 * given street. Preflop no board is dealt yet; the flop reveals 3; the turn
 * reveals a 4th; the river reveals the 5th. A null street (no human action in
 * the log — should not happen on a real in-progress peek) reveals nothing.
 *
 * This is the truncation contract that prevents the in-progress response from
 * over-revealing undealt board cards (see peekState's fairness note).
 */
export function visibleBoardCountForStreet(
  street: HoldemHandResult['actionLog'][number]['street'] | null,
): number {
  switch (street) {
    case 'preflop': return 0;
    case 'flop': return 3;
    case 'turn': return 4;
    case 'river': return 5;
    case null: return 0;
    default: {
      const _exhaustive: never = street;
      void _exhaustive;
      return 0;
    }
  }
}

/**
 * From a fold-terminated peek's actionLog, derive the human's current toCall +
 * the street's current bet at the point the human is next to act. We scan the
 * action log for the LAST street that had activity before the synthetic fold,
 * take the max street commitment among non-human seats on that street and the
 * human's own street commitment.
 */
function deriveToCall(
  peek: HoldemHandResult,
  recordedHumanActions: number,
): {
  toCall: bigint;
  currentBet: bigint;
  /** The human's CURRENT street (street of the synthetic fold). Null only if the
   * human never appears in the log (defensive — should not happen on a peek). */
  humanStreet: HoldemHandResult['actionLog'][number]['street'] | null;
} {
  void recordedHumanActions;
  // The synthetic fold is the LAST human entry in the log. The street it was on
  // is the human's current street. Compute per-seat street commitment on that
  // street from the log (amount fields are cumulative street commitments).
  const log = peek.actionLog;
  // Find the synthetic human fold (last human entry).
  let humanStreet: HoldemHandResult['actionLog'][number]['street'] | null = null;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]!.isHuman) { humanStreet = log[i]!.street; break; }
  }
  if (!humanStreet) return { toCall: 0n, currentBet: 0n, humanStreet: null };

  // Per-seat latest street commitment on humanStreet.
  const bySeat = new Map<number, bigint>();
  for (const e of log) {
    if (e.street !== humanStreet) continue;
    bySeat.set(e.seat, BigInt(e.amount));
  }
  let currentBet = 0n;
  let humanCommit = 0n;
  for (const [seat, amt] of bySeat) {
    if (amt > currentBet) currentBet = amt;
    if (seat === HUMAN_SEAT) humanCommit = amt;
  }
  const toCall = currentBet > humanCommit ? currentBet - humanCommit : 0n;
  return { toCall, currentBet, humanStreet };
}

// ─── POST /session/open ───────────────────────────────────────────────────────

coveHoldemRouter.post('/session/open', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = openSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const input = parsed.data;
  const subject = await getSubject(c);

  // Currency seam — SOL/USDC custody is a later tier. Same 501 shape as blackjack.
  if (input.currency !== 'clawtoken') {
    return c.json(
      {
        error: 'CURRENCY_COMING_SOON',
        message: 'SOL/USDC custody for hold\'em is a later tier. Use currency="clawtoken" today.',
      },
      501,
    );
  }

  const buyInBig = BigInt(input.buyIn);

  // Resume an existing open table (idempotent open) — lock the row first.
  const resumed = await db.transaction(async (tx) => {
    const lockWhere =
      isLedgerSubject(subject)
        ? sql`user_id = ${subject.userId} AND status = 'open'`
        : sql`guest_fp_hash = ${subject.guestFpHash} AND status = 'open'`;
    const rows = await tx.execute<{ id: string }>(
      sql`SELECT id FROM holdem_tables WHERE ${lockWhere} FOR UPDATE`,
    );
    const id = rows[0]?.id;
    if (!id) return null;
    return (await tx.query.holdemTables.findFirst({ where: eq(holdemTables.id, id) })) ?? null;
  });

  if (resumed) {
    const walletBalance =
      isLedgerSubject(subject)
        ? (await loadAvatarForUser(subject.userId)).clawTokens
        : Number(GUEST_STARTING_BALANCE) - Number(BigInt(resumed.buyInStack));
    return c.json({ table: publicTable(resumed), walletBalance }, 200);
  }

  // Pre-flight + buy-in debit (ledger subject = human or agent). The buy-in is
  // debited NOW into the table's playerStack; cash-out at close credits the
  // remainder back.
  let avatar: { id: string; clawTokens: number } | null = null;
  let startingBalanceStr: string;
  if (isLedgerSubject(subject)) {
    avatar = await loadAvatarForUser(subject.userId);
    if (avatar.clawTokens < input.buyIn) {
      throw new HTTPException(400, {
        message: `insufficient_clawtokens: need ${input.buyIn}, have ${avatar.clawTokens}`,
      });
    }
    startingBalanceStr = avatar.clawTokens.toString();
  } else {
    checkGuestTableOpenRate(subject.guestFpHash);
    if (buyInBig > GUEST_STARTING_BALANCE) {
      throw new HTTPException(400, {
        message: `guest_buyin_exceeds_demo_grant: max ${GUEST_STARTING_BALANCE.toString()} demo CT. Sign up to buy in for more.`,
      });
    }
    startingBalanceStr = GUEST_STARTING_BALANCE.toString();
  }

  const { serverSeed, serverSeedHash } = createServerSeed();
  const clientSeed = randomBytes(8).toString('hex');

  let inserted: HoldemTable;
  try {
    inserted = await db.transaction(async (tx) => {
      // Debit the buy-in from the ledger subject's avatar into the table stack.
      if (isLedgerSubject(subject) && avatar) {
        try {
          await debitClawTokens(
            {
              avatarId: avatar.id,
              amount: input.buyIn,
              reason: 'cove_holdem_buyin',
              source: 'api',
              metadata: { kind: 'buyin', buyIn: input.buyIn },
            },
            tx,
          );
        } catch (err) {
          if (err instanceof InsufficientTokensError) {
            throw new HTTPException(400, {
              message: `insufficient_clawtokens: need ${input.buyIn}, have ${err.available}`,
            });
          }
          throw err;
        }
      }
      const [row] = await tx
        .insert(holdemTables)
        .values({
          userId: subject.userId,
          guestFpHash: subject.guestFpHash,
          currency: 'clawtoken',
          serverSeed,
          serverSeedHash,
          clientSeed,
          buyInStack: buyInBig.toString(),
          playerStack: buyInBig.toString(),
          startingBalance: startingBalanceStr,
          engineVersion: HOLDEM_ENGINE_VERSION,
        })
        .returning();
      if (!row) throw new HTTPException(500, { message: 'table_insert_failed' });
      return row;
    });
  } catch (err) {
    const pgCode = (err as { code?: string } | undefined)?.code;
    if (pgCode === '23505') {
      // Race against a concurrent open — re-read + serve (no double buy-in
      // because the partial unique index rejected the second insert; the first
      // open's buy-in is the only one that landed).
      const raceWhere =
        isLedgerSubject(subject)
          ? and(eq(holdemTables.userId, subject.userId), eq(holdemTables.status, 'open'))
          : and(eq(holdemTables.guestFpHash, subject.guestFpHash), eq(holdemTables.status, 'open'));
      const raceRow = (await db.select().from(holdemTables).where(raceWhere).limit(1))[0];
      if (raceRow) {
        const walletBalance =
          isLedgerSubject(subject)
            ? (await loadAvatarForUser(subject.userId)).clawTokens
            : Number(GUEST_STARTING_BALANCE) - Number(BigInt(raceRow.buyInStack));
        return c.json({ table: publicTable(raceRow), walletBalance }, 200);
      }
      throw new HTTPException(409, { message: 'table_already_open' });
    }
    throw err;
  }

  void logEventFromContext(c, {
    eventType: 'cove.holdem.table.opened',
    userId: ledgerUserId(subject),
    avatarId: avatar?.id ?? null,
    agentId: subject.kind === 'agent' ? subject.agentId : null,
    payload: {
      tableId: inserted.id,
      currency: 'clawtoken',
      buyIn: input.buyIn,
      isGuest: subject.kind === 'guest',
      isAgent: subject.kind === 'agent',
    },
  });

  const walletBalance =
    isLedgerSubject(subject)
      ? (avatar!.clawTokens - input.buyIn)
      : Number(GUEST_STARTING_BALANCE) - input.buyIn;

  return c.json({ table: publicTable(inserted), walletBalance }, 200);
});

// ─── POST /hand/deal ──────────────────────────────────────────────────────────
//
// Start a new hand on an open table. Rotates the button, posts blinds, deals a
// fresh deck, and runs bots forward to the first human decision (or settles
// immediately if the human is never required to act — e.g. everyone folds to the
// human's BB, or the human is already all-in from blinds). NO ledger writes here
// — chips move within the playerStack and only cross the ledger at buy-in/close.

coveHoldemRouter.post('/hand/deal', async (c) => {
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

  const table = await db.query.holdemTables.findFirst({ where: eq(holdemTables.id, input.tableId) });
  if (!table) throw new HTTPException(404, { message: 'table_not_found' });
  if (!ownerMatch(table, subject)) throw new HTTPException(403, { message: 'table_not_owned' });
  if (table.status !== 'open') {
    throw new HTTPException(409, { message: `table_not_open: status=${table.status}` });
  }

  const dealResult = await db.transaction(async (tx) => {
    const lockRows = await tx.execute<{
      hand_counter: number | string;
      player_stack: string;
      status: string;
    }>(
      sql`SELECT hand_counter, player_stack, status
          FROM holdem_tables WHERE id = ${table.id} FOR UPDATE`,
    );
    const lock = lockRows[0];
    if (!lock) throw new HTTPException(404, { message: 'table_not_found' });
    if (lock.status !== 'open') {
      throw new HTTPException(409, { message: `table_not_open: status=${lock.status}` });
    }

    // One live hand per table at a time (serialize — race-safe under the lock).
    const liveRows = await tx.execute<{ id: string }>(
      sql`SELECT id FROM holdem_hands
          WHERE table_id = ${table.id} AND status = 'in_progress' LIMIT 1`,
    );
    if (liveRows[0]) {
      throw new HTTPException(409, {
        message: 'hand_in_progress: finish the current hand before dealing another',
      });
    }

    const handIndex = Number(lock.hand_counter);
    const startingStack = BigInt(lock.player_stack);
    if (startingStack < BIG_BLIND) {
      throw new HTTPException(400, {
        message: `stack_too_low_to_play: have ${startingStack.toString()}, need ≥ ${BIG_BLIND.toString()}. Re-buy by closing + reopening.`,
      });
    }

    // Rotate the button by hand index (deterministic, recorded on the hand row).
    const buttonSeat = handIndex % SEATS;

    const handMeta = {
      handIndex,
      buttonSeat,
      startingStack: startingStack.toString(),
    };

    // Run with an empty action list. If the engine completes (human never
    // required to act), the hand is terminal at deal — settle immediately.
    const terminalAtDeal = isHandTerminal(
      { serverSeed: table.serverSeed, clientSeed: table.clientSeed },
      handMeta,
      [],
    );

    const [handRow] = await tx
      .insert(holdemHands)
      .values({
        tableId: table.id,
        handIndex,
        buttonSeat,
        startingStack: startingStack.toString(),
        actions: [] satisfies HoldemActionRecord[],
        status: 'in_progress',
      })
      .returning();
    if (!handRow) throw new HTTPException(500, { message: 'hand_insert_failed' });

    // Reserve the hand index on the table so the next deal is monotonic.
    await tx
      .update(holdemTables)
      .set({ handCounter: handIndex + 1, lastHandAt: new Date() })
      .where(eq(holdemTables.id, table.id));

    return { handRow, handMeta, terminalAtDeal };
  });

  if (dealResult.terminalAtDeal) {
    const settled = await settleHand(c, table.id, dealResult.handRow.id, subject, idempotencyKey);
    return c.json({ ...settled, dealtImmediately: true }, 200);
  }

  // Compute the visible state for the human's first decision.
  const peek = peekState(
    { serverSeed: table.serverSeed, clientSeed: table.clientSeed },
    dealResult.handMeta,
    [],
  );

  return c.json(
    {
      handId: dealResult.handRow.id,
      tableId: table.id,
      handIndex: dealResult.handMeta.handIndex,
      buttonSeat: dealResult.handMeta.buttonSeat,
      smallBlindSeat: (dealResult.handMeta.buttonSeat + 1) % SEATS,
      bigBlindSeat: (dealResult.handMeta.buttonSeat + 2) % SEATS,
      startingStack: dealResult.handMeta.startingStack,
      humanHole: peek.humanHole,
      board: peek.board,
      toCall: peek.toCall,
      currentBet: peek.currentBet,
      humanStack: peek.humanStack,
      humanCommitted: peek.humanCommitted,
      smallBlind: SMALL_BLIND.toString(),
      bigBlind: BIG_BLIND.toString(),
      status: 'in_progress',
    },
    200,
  );
});

// ─── POST /action ─────────────────────────────────────────────────────────────
//
// Record ONE human decision. Append it to the hand's action list under the hand
// FOR UPDATE lock (serializes concurrent /action calls), then ask the engine
// whether the hand is now terminal. If terminal → settle atomically. Otherwise
// return the new visible state for the human's next decision.

coveHoldemRouter.post('/action', async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key') ?? undefined;
  if (idempotencyKey && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN) {
    throw new HTTPException(400, {
      message: `idempotency_key_must_be_1_to_${IDEMPOTENCY_KEY_MAX_LEN}_chars`,
    });
  }
  const body = await c.req.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const input = parsed.data;
  if ((input.action === 'bet' || input.action === 'raise') && input.amount === undefined) {
    throw new HTTPException(400, { message: `${input.action}_requires_amount` });
  }
  const subject = await getSubject(c);
  checkActionRate(subjectKey(subject));

  const hand = await db.query.holdemHands.findFirst({ where: eq(holdemHands.id, input.handId) });
  if (!hand) throw new HTTPException(404, { message: 'hand_not_found' });

  const table = await db.query.holdemTables.findFirst({ where: eq(holdemTables.id, hand.tableId) });
  if (!table) throw new HTTPException(404, { message: 'table_not_found' });
  if (!ownerMatch(table, subject)) throw new HTTPException(403, { message: 'hand_not_owned' });

  // Idempotent: a re-POST to a settled hand replays the stored outcome.
  if (hand.status === 'settled') {
    return c.json(await buildSettledResponse(hand, table, subject), 200);
  }
  if (table.status !== 'open') {
    throw new HTTPException(409, { message: `table_not_open: status=${table.status}` });
  }

  const newRecord: HoldemActionRecord = {
    type: input.action as HoldemActionType,
    ...(input.amount !== undefined ? { amount: input.amount.toString() } : {}),
  };

  // ── Append the decision under the hand lock so concurrent /action serialize.
  const mutation = await db.transaction(async (tx) => {
    const lockRows = await tx.execute<{ status: string }>(
      sql`SELECT status FROM holdem_hands WHERE id = ${hand.id} FOR UPDATE`,
    );
    const lock = lockRows[0];
    if (!lock) throw new HTTPException(404, { message: 'hand_not_found' });
    if (lock.status === 'settled') {
      const fresh = await tx.query.holdemHands.findFirst({ where: eq(holdemHands.id, hand.id) });
      return { settledReplay: fresh ?? null, updatedHand: null };
    }
    if (lock.status !== 'in_progress') {
      throw new HTTPException(409, { message: 'hand_not_in_progress' });
    }

    const locked = await tx.query.holdemHands.findFirst({ where: eq(holdemHands.id, hand.id) });
    if (!locked) throw new HTTPException(404, { message: 'hand_not_found' });

    const priorActions = loadActions(locked);

    // Defensive: the human must currently be the one to act. If the recorded
    // actions ALONE already complete the hand, no further human action is legal.
    const meta = {
      handIndex: locked.handIndex,
      buttonSeat: locked.buttonSeat,
      startingStack: locked.startingStack,
    };
    if (isHandTerminal({ serverSeed: table.serverSeed, clientSeed: table.clientSeed }, meta, priorActions)) {
      throw new HTTPException(409, { message: 'not_human_turn: hand already resolved server-side' });
    }

    const nextActions = [...priorActions, newRecord];

    // Validate the new action is LEGAL by replaying — the engine throws on an
    // illegal decision (e.g. check while owing, raise below min). We catch and
    // surface a 400 rather than persisting an illegal script.
    try {
      runEngine({ serverSeed: table.serverSeed, clientSeed: table.clientSeed }, meta, [
        ...nextActions,
        // append a sentinel so the engine doesn't throw "ran out" while the
        // human still has later turns — if THIS action is illegal it throws
        // before reaching the sentinel.
        { type: 'fold' },
      ]);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('ran out of human actions')) {
        // The new action is legal; the engine simply needs more human input
        // beyond the sentinel — fine. (Sentinel fold resolves it for the probe.)
      } else {
        throw new HTTPException(400, { message: `illegal_action: ${msg}` });
      }
    }

    const persisted = await tx
      .update(holdemHands)
      .set({ actions: nextActions })
      .where(and(eq(holdemHands.id, hand.id), eq(holdemHands.status, 'in_progress')))
      .returning();
    if (!persisted[0]) throw new HTTPException(409, { message: 'hand_not_in_progress' });
    return { settledReplay: null, updatedHand: persisted[0] };
  });

  if (mutation.settledReplay) {
    return c.json(await buildSettledResponse(mutation.settledReplay, table, subject), 200);
  }
  const updatedHand = mutation.updatedHand!;
  const actions = loadActions(updatedHand);
  const meta = {
    handIndex: updatedHand.handIndex,
    buttonSeat: updatedHand.buttonSeat,
    startingStack: updatedHand.startingStack,
  };

  const terminal = isHandTerminal(
    { serverSeed: table.serverSeed, clientSeed: table.clientSeed },
    meta,
    actions,
  );

  if (!terminal) {
    const peek = peekState({ serverSeed: table.serverSeed, clientSeed: table.clientSeed }, meta, actions);
    return c.json(
      {
        handId: hand.id,
        status: 'in_progress',
        humanHole: peek.humanHole,
        board: peek.board,
        toCall: peek.toCall,
        currentBet: peek.currentBet,
        humanStack: peek.humanStack,
        humanCommitted: peek.humanCommitted,
      },
      200,
    );
  }

  const settled = await settleHand(c, table.id, hand.id, subject, idempotencyKey);
  return c.json(settled, 200);
});

// ─── Settle (atomic, idempotent, engine recompute UNDER the table lock) ──────

interface SettledResponse {
  handId: string;
  tableId: string;
  handIndex: number;
  status: 'settled';
  outcome: SerializedHoldemHand;
  playerStack: string;
  walletBalance: number;
  betAmount: string;
  /** RAKED payout the player actually received (post-rake). */
  payout: string;
  /** RAKED net (post-rake). */
  net: string;
  /** House rake taken from the pot this hand (5% capped at 5 CT). */
  rake: string;
  idempotencyReplay: boolean;
}

/**
 * Map a (possibly pre-rake) stored `outcomeJson` to the RAKED figures the route
 * returns. A hand SETTLED BY PRE-RAKE CODE stored no `humanRakedPayout`,
 * `humanRakedNet`, or `rake` (those fields are optional in the serialized type
 * for exactly this back-compat reason). For such rows there was no rake, so the
 * raked payout/net IS the gross payout/net the player actually received, and the
 * rake was 0. Falling back to the GROSS fields keeps the idempotent settled
 * replay correct (same hand → the figures the player actually got). Mirrors
 * blackjack's `outcome.rake ?? '0'` + gross-derived posture in cove-blackjack.ts.
 */
export function rakedFiguresFromOutcome(outcome: SerializedHoldemHand): {
  payout: string;
  net: string;
  rake: string;
} {
  return {
    payout: outcome.humanRakedPayout ?? outcome.humanPayout,
    net: outcome.humanRakedNet ?? outcome.humanNet,
    rake: outcome.rake ?? '0',
  };
}

class IdempotencyReplayError extends Error {
  constructor(
    public readonly tableId: string,
    public readonly idempotencyKey: string,
  ) {
    super(`idempotency_key_replay: tableId=${tableId}`);
    this.name = 'IdempotencyReplayError';
  }
}

/**
 * Settle a hand. The engine recompute + the playerStack advance + the
 * cove_game_events insert run in ONE transaction with a FOR UPDATE lock on the
 * table row. Idempotent: the hand status flips in_progress→settled exactly once;
 * a re-entry on a settled hand replays.
 *
 * MONEY MODEL: chips moved WITHIN the playerStack (no per-hand ledger write).
 * The hand's RAKED net (humanRakedPayout - humanBet) is applied to playerStack:
 *   newPlayerStack = startingStack - humanBet + humanRakedPayout
 * The ledger is only touched at buy-in (open) + cash-out (close).
 *
 * RAKE (economy fix 2026-05-29; `.claude/plans/cove-casino-economy.md` §1/§2):
 * the house takes a 5%-of-pot rake capped at 5 CT at settle, removed BEFORE the
 * human is credited (`computeHoldemRake`). The raked CT is simply NOT credited
 * back to the playerStack → a net CT burn that makes the vs-bots table
 * house-positive (no faucet). The rake is part of the settled `outcomeJson` and
 * `holdem_hands.payout/net` (raked figures), computed ONCE under the table FOR
 * UPDATE lock; a settled-replay reads the stored raked figures and NEVER re-rakes.
 */
async function settleHand(
  c: Context<AppContext>,
  tableId: string,
  handId: string,
  subject: ThSubject,
  idempotencyKey: string | undefined,
): Promise<SettledResponse> {
  let txResult: { hand: HoldemHand; table: HoldemTable; replay: boolean };
  try {
    txResult = await settleTransaction();
  } catch (err) {
    if (err instanceof IdempotencyReplayError) {
      const replayed = await db.query.holdemHands.findFirst({
        where: and(
          eq(holdemHands.tableId, err.tableId),
          eq(holdemHands.idempotencyKey, err.idempotencyKey),
        ),
      });
      if (replayed && replayed.status === 'settled') {
        return buildSettledResponse(replayed, await loadTableOrThrow(tableId), subject);
      }
      throw new HTTPException(409, { message: 'idempotency_key_in_flight: retry shortly' });
    }
    throw err;
  }

  async function settleTransaction(): Promise<{ hand: HoldemHand; table: HoldemTable; replay: boolean }> {
    return db.transaction(async (tx) => {
      const tableRows = await tx.execute<{
        id: string;
        server_seed: string;
        server_seed_hash: string;
        client_seed: string;
        player_stack: string;
        total_bet: string;
        total_payout: string;
        status: string;
        [key: string]: unknown;
      }>(
        sql`SELECT id, server_seed, server_seed_hash, client_seed, player_stack,
                   total_bet, total_payout, status
            FROM holdem_tables WHERE id = ${tableId} FOR UPDATE`,
      );
      const tableLock = tableRows[0];
      if (!tableLock) throw new HTTPException(404, { message: 'table_not_found' });

      const hand = await tx.query.holdemHands.findFirst({ where: eq(holdemHands.id, handId) });
      if (!hand) throw new HTTPException(404, { message: 'hand_not_found' });

      // Idempotency: already settled → pure replay.
      if (hand.status === 'settled') {
        const fullTable = await tx.query.holdemTables.findFirst({ where: eq(holdemTables.id, tableId) });
        return { hand, table: fullTable!, replay: true };
      }

      // Idempotency-Key pre-check: a reused key that already settled a row →
      // replay that row instead of re-settling.
      if (idempotencyKey) {
        const priorByKey = await tx.query.holdemHands.findFirst({
          where: and(eq(holdemHands.tableId, tableId), eq(holdemHands.idempotencyKey, idempotencyKey)),
        });
        if (priorByKey && priorByKey.status === 'settled') {
          const fullTable = await tx.query.holdemTables.findFirst({ where: eq(holdemTables.id, tableId) });
          return { hand: priorByKey, table: fullTable!, replay: true };
        }
      }

      if (tableLock.status !== 'open') {
        throw new HTTPException(409, { message: `table_not_open: status=${tableLock.status}` });
      }

      const actions = loadActions(hand);
      let r: HoldemHandResult;
      try {
        r = playHand({
          serverSeed: tableLock.server_seed,
          clientSeed: tableLock.client_seed,
          nonce: hand.handIndex,
          buttonSeat: hand.buttonSeat,
          humanStartingStack: BigInt(hand.startingStack),
          botStartingStack: BOT_STACK,
          humanActions: actions,
        });
      } catch (err) {
        throw new HTTPException(400, { message: `holdem_engine_error: ${(err as Error).message}` });
      }

      // ── Rake the pot (economy fix 2026-05-29) ──────────────────────────────
      // Take 5% of the pot capped at 5 CT BEFORE crediting the human, computed
      // deterministically from the resolved hand. The raked CT is not credited
      // back → net burn → house-positive. Applied exactly once here under the
      // table lock; the figures are stored so a settled-replay never re-rakes.
      const raked = computeHoldemRake(r);

      // Money safety: refuse payout/stack exceeding JS-number range (defensive;
      // stacks are ≤ 500 CT today so this never trips legitimately).
      if (r.humanPayout > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new HTTPException(500, { message: 'payout_exceeds_supported_range' });
      }
      if (r.humanBet > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new HTTPException(400, { message: 'bet_exceeds_supported_range' });
      }

      // Apply the RAKED net to the playerStack. The human committed humanBet
      // during the hand (already "behind" in playerStack accounting) and is
      // credited the post-rake payout (humanRakedPayout = humanPayout - rakeShare).
      const startingStack = BigInt(hand.startingStack);
      const endingStack = startingStack - r.humanBet + raked.humanRakedPayout; // = starting + rakedNet
      if (endingStack < 0n) {
        // Impossible — the engine never lets a seat commit more than its stack,
        // and the rake only ever REDUCES a positive payout.
        throw new HTTPException(500, {
          message: `holdem_stack_underflow: starting=${startingStack} bet=${r.humanBet} rakedPayout=${raked.humanRakedPayout}`,
        });
      }

      const serialized = serializeHoldemHand(r);

      // Persist the settled hand row (idempotency-key collision → replay signal).
      let settledHand: HoldemHand | undefined;
      try {
        const updated = await tx
          .update(holdemHands)
          .set({
            status: 'settled',
            // outcomeJson carries the GROSS engine figures + the rake + raked
            // figures (serializeHoldemHand). The flat payout/net columns store
            // the RAKED (credited) figures — what actually moved on the stack.
            outcomeJson: serialized,
            betAmount: r.humanBet.toString(),
            payout: raked.humanRakedPayout.toString(),
            net: raked.humanRakedNet.toString(),
            endingStack: endingStack.toString(),
            idempotencyKey: idempotencyKey ?? null,
            settledAt: new Date(),
          })
          .where(and(eq(holdemHands.id, handId), eq(holdemHands.status, 'in_progress')))
          .returning();
        settledHand = updated[0];
      } catch (err) {
        const pgCode = (err as { code?: string } | undefined)?.code;
        if (pgCode === '23505' && idempotencyKey) {
          throw new IdempotencyReplayError(tableId, idempotencyKey);
        }
        throw err;
      }
      if (!settledHand) {
        const fresh = await tx.query.holdemHands.findFirst({ where: eq(holdemHands.id, handId) });
        if (fresh?.status === 'settled') {
          const fullTable = await tx.query.holdemTables.findFirst({ where: eq(holdemTables.id, tableId) });
          return { hand: fresh, table: fullTable!, replay: true };
        }
        throw new HTTPException(500, { message: 'hand_settle_failed' });
      }

      // One cove_game_events row PER HAND. serverSeedHash committed at open;
      // revealedServerSeed NULL until session close (commit-reveal). nonce =
      // handIndex; sessionId = shoeId = tableId.
      await tx.insert(coveGameEvents).values({
        userId: subject.userId,
        guestFpHash: subject.guestFpHash,
        gameType: 'holdem',
        sessionId: tableId,
        shoeId: tableId,
        betAmount: r.humanBet.toString(),
        // payout is the RAKED (credited) figure so the cross-game economy
        // monitor's burn = bet - payout includes the rake. outcomeJson keeps the
        // gross award + the explicit `rake` field for the per-hand breakdown.
        payout: raked.humanRakedPayout.toString(),
        outcomeJson: serialized,
        serverSeedHash: tableLock.server_seed_hash,
        revealedServerSeed: null,
        clientSeed: tableLock.client_seed,
        nonce: hand.handIndex,
        txSignature: null,
        engineVersion: `holdem-engine-${HOLDEM_ENGINE_VERSION}`,
      });

      // Advance the table's playerStack + session aggregates. totalPayout uses
      // the RAKED payout so the session P&L reflects the rake the player paid.
      const newTotalBet = (BigInt(tableLock.total_bet) + r.humanBet).toString();
      const newTotalPayout = (BigInt(tableLock.total_payout) + raked.humanRakedPayout).toString();
      const [updatedTable] = await tx
        .update(holdemTables)
        .set({
          playerStack: endingStack.toString(),
          totalBet: newTotalBet,
          totalPayout: newTotalPayout,
          handsPlayed: sql`${holdemTables.handsPlayed} + 1`,
          lastHandAt: new Date(),
        })
        .where(eq(holdemTables.id, tableId))
        .returning();
      if (!updatedTable) throw new HTTPException(500, { message: 'table_update_failed' });

      return { hand: settledHand, table: updatedTable, replay: false };
    });
  }

  const hand = txResult.hand;
  const table = txResult.table;
  const outcome = hand.outcomeJson as SerializedHoldemHand;

  // Wallet balance: ledger subject (human/agent) = live avatar.clawTokens (chips
  // are in playerStack, not yet cashed out); guest = demo grant minus chips
  // currently in the stack.
  const walletBalance =
    isLedgerSubject(subject)
      ? (await loadAvatarForUser(subject.userId)).clawTokens
      : Number(GUEST_STARTING_BALANCE) - Number(BigInt(table.playerStack));

  void logEventFromContext(c, {
    eventType: 'cove.holdem.hand.settled',
    userId: ledgerUserId(subject),
    agentId: subject.kind === 'agent' ? subject.agentId : null,
    payload: {
      tableId,
      handId: hand.id,
      handIndex: hand.handIndex,
      betAmount: hand.betAmount,
      payout: hand.payout,
      net: hand.net,
      isGuest: subject.kind === 'guest',
      isAgent: subject.kind === 'agent',
      replay: txResult.replay,
    },
  });

  return {
    handId: hand.id,
    tableId,
    handIndex: hand.handIndex,
    status: 'settled',
    outcome,
    playerStack: table.playerStack,
    walletBalance,
    betAmount: outcome.humanBet,
    // RAKED figures — what the player actually received this hand. Back-compat
    // fallback to GROSS for pre-rake rows lives in `rakedFiguresFromOutcome`.
    ...rakedFiguresFromOutcome(outcome),
    idempotencyReplay: txResult.replay,
  };
}

/** Build a settled-hand response from a stored row (idempotent replay path). */
async function buildSettledResponse(
  hand: HoldemHand,
  table: HoldemTable,
  subject: ThSubject,
): Promise<SettledResponse> {
  const outcome = hand.outcomeJson as SerializedHoldemHand;
  const walletBalance =
    isLedgerSubject(subject)
      ? (await loadAvatarForUser(subject.userId)).clawTokens
      : Number(GUEST_STARTING_BALANCE) - Number(BigInt(table.playerStack));
  return {
    handId: hand.id,
    tableId: table.id,
    handIndex: hand.handIndex,
    status: 'settled',
    outcome,
    playerStack: table.playerStack,
    walletBalance,
    betAmount: outcome.humanBet,
    // RAKED figures — what the player actually received (stored row replay).
    // Back-compat fallback to GROSS for pre-rake rows lives in the shared helper.
    ...rakedFiguresFromOutcome(outcome),
    idempotencyReplay: true,
  };
}

// ─── POST /session/close ──────────────────────────────────────────────────────
//
// Close the table + reveal serverSeed on every cove_game_events row for the
// session, AND cash out the player's remaining playerStack (ledger subject:
// credit the bound avatar; guest: discard).
//
// Subject-resolved (NOT requireAuth) so a connected AGENT can close its own table
// and cash its remaining stack back to its bound avatar — without this an agent's
// buy-in could never be recovered and its table would wedge open. Ledger subjects
// only (human or agent): a guest demo table has no real stack to cash out and the
// prior Lucia-only gate already excluded guests, so we keep that exclusion (403).
// ownerMatch binds the table to the resolved userId, so an agent can never close
// another user's table.

coveHoldemRouter.post('/session/close', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = closeSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_cannot_close_table: sign in or connect an agent' });
  }

  const table = await db.query.holdemTables.findFirst({
    where: eq(holdemTables.id, parsed.data.tableId),
  });
  if (!table) throw new HTTPException(404, { message: 'table_not_found' });
  if (!ownerMatch(table, subject)) throw new HTTPException(403, { message: 'table_not_owned' });
  if (table.status !== 'open') {
    throw new HTTPException(409, { message: `table_not_open: status=${table.status}` });
  }

  const avatar = await loadAvatarForUser(subject.userId);

  const closed = await db.transaction(async (tx) => {
    const lockRows = await tx.execute<{ status: string; player_stack: string }>(
      sql`SELECT status, player_stack FROM holdem_tables WHERE id = ${table.id} FOR UPDATE`,
    );
    const lock = lockRows[0];
    if (!lock) throw new HTTPException(404, { message: 'table_not_found' });
    if (lock.status !== 'open') {
      throw new HTTPException(409, { message: `table_not_open: status=${lock.status}` });
    }

    // Refuse closing with an in-progress hand — revealing the seed while the
    // player can still derive the deck would be unfair.
    const liveHand = await tx.query.holdemHands.findFirst({
      where: and(eq(holdemHands.tableId, table.id), eq(holdemHands.status, 'in_progress')),
    });
    if (liveHand) {
      throw new HTTPException(409, {
        message: 'table_has_in_progress_hand: finish the current hand before closing',
      });
    }

    // Cash out the remaining stack back to the avatar (ledger subject — human
    // or agent, resolved + owner-checked above).
    const cashOut = BigInt(lock.player_stack);
    let cashOutBalance = avatar.clawTokens;
    if (cashOut > 0n) {
      if (cashOut > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new HTTPException(500, { message: 'cashout_exceeds_supported_range' });
      }
      const credit = await creditClawTokens(
        {
          avatarId: avatar.id,
          amount: Number(cashOut),
          reason: 'cove_holdem_cashout',
          source: 'api',
          metadata: { tableId: table.id, kind: 'cashout' },
        },
        tx,
      );
      cashOutBalance = credit.balanceAfter;
    }

    const [closedTable] = await tx
      .update(holdemTables)
      .set({ status: 'closed', playerStack: '0', closedAt: new Date() })
      .where(eq(holdemTables.id, table.id))
      .returning();
    if (!closedTable) throw new HTTPException(500, { message: 'table_close_failed' });

    // Reveal the serverSeed on every holdem event for this session.
    await tx
      .update(coveGameEvents)
      .set({ revealedServerSeed: closedTable.serverSeed })
      .where(and(eq(coveGameEvents.sessionId, table.id), eq(coveGameEvents.gameType, 'holdem')));

    return { closedTable, cashOut: cashOut.toString(), cashOutBalance };
  });

  void logEventFromContext(c, {
    eventType: 'cove.holdem.table.closed',
    userId: subject.userId,
    avatarId: avatar.id,
    agentId: subject.kind === 'agent' ? subject.agentId : null,
    payload: {
      tableId: closed.closedTable.id,
      handsPlayed: closed.closedTable.handsPlayed,
      totalBet: closed.closedTable.totalBet,
      totalPayout: closed.closedTable.totalPayout,
      cashOut: closed.cashOut,
      isAgent: subject.kind === 'agent',
    },
  });

  return c.json(
    {
      tableId: closed.closedTable.id,
      status: 'closed',
      serverSeed: closed.closedTable.serverSeed,
      serverSeedHash: closed.closedTable.serverSeedHash,
      clientSeed: closed.closedTable.clientSeed,
      handsPlayed: closed.closedTable.handsPlayed,
      totalBet: closed.closedTable.totalBet,
      totalPayout: closed.closedTable.totalPayout,
      cashOut: closed.cashOut,
      walletBalance: closed.cashOutBalance,
      closedAt: (closed.closedTable.closedAt ?? new Date()).toISOString(),
    },
    200,
  );
});

// ─── GET /session/current ─────────────────────────────────────────────────────
//
// Subject-resolved (ledger subjects only) so a connected agent can restore its
// open table after a reconnect, exactly like a human after a page refresh. An
// agent + its bound human share one userId-keyed table, so both see the same row.

coveHoldemRouter.get('/session/current', async (c) => {
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_has_no_persistent_table: sign in or connect an agent' });
  }
  const row = await db.query.holdemTables.findFirst({
    where: and(eq(holdemTables.userId, subject.userId), eq(holdemTables.status, 'open')),
  });
  if (!row) throw new HTTPException(404, { message: 'no_open_table' });
  const avatar = await loadAvatarForUser(subject.userId);
  return c.json({ table: publicTable(row), walletBalance: avatar.clawTokens }, 200);
});

// ─── GET /session/:id ─────────────────────────────────────────────────────────
//
// Owner-only table detail (serverSeed redacted while open). Subject-resolved so an
// agent can inspect its own table; ownerMatch binds to the resolved userId, so an
// agent can never read another user's table by id.

coveHoldemRouter.get('/session/:id', async (c) => {
  const tableId = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(tableId)) {
    throw new HTTPException(400, { message: 'invalid_table_id' });
  }
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_cannot_inspect_table: sign in or connect an agent' });
  }
  const row = await db.query.holdemTables.findFirst({ where: eq(holdemTables.id, tableId) });
  if (!row) throw new HTTPException(404, { message: 'table_not_found' });
  if (!ownerMatch(row, subject)) throw new HTTPException(403, { message: 'table_not_owned' });
  return c.json({ table: publicTable(row) }, 200);
});

export default coveHoldemRouter;
