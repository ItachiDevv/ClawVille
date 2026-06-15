/**
 * Phase 6.6.1 — Cove Baccarat (Punto Banco) AUTHORITATIVE route.
 *
 * Mount: `app.route('/api/cove/baccarat', coveBaccaratRouter)` from index.ts.
 *
 * Surfaces:
 *
 *   POST /session/open    (auth optional) — open a commit-reveal SHOE, commit serverSeedHash
 *   POST /coup            (auth optional) — place a PLAYER/BANKER/TIE bet, deal, resolve, settle
 *   POST /session/close   (user or agent) — close the shoe + reveal serverSeed
 *   GET  /session/current (user or agent) — restore the open shoe after refresh/reconnect
 *   GET  /session/:id      (user or agent) — owner-only shoe detail (serverSeed redacted while open)
 *
 * Model mirrors cove-blackjack.ts (the audited template), EXTENDED for agent parity
 * (Rule E5 — human↔agent parity on a money path, 2026-06-15):
 *   - getSubject(c): authed human (Lucia) OR a connected/hosted AGENT playing AS
 *     ITSELF (X-Clawville-Agent-Session header → its bound avatar's userId) OR a
 *     guest (100 demo CT). Human + agent are BOTH real-CT "ledger subjects" — an
 *     agent shoe is just a `userId` shoe, so the DB `userId XOR guestFpHash`
 *     check constraint still holds and the audited settle path is reused verbatim
 *     (the agent kind adds NO new money branch — see `isLedgerSubject`). Agents are
 *     NEVER routed to the guest/demo tier. Guests never touch the ClawTokens
 *     ledger; demo balance lives on the shoe row (startingBalance + totalPayout -
 *     totalBet).
 *   - SETTLEMENT vs LEADERBOARD (parity scope): for a ledger subject (human OR
 *     agent) this route does REAL CT ledger settlement with full parity. It emits
 *     NO leaderboard-scoring event for ANY subject (the Cove writes no
 *     `activity.match.placed`); that is a SEPARATE pre-existing gap, not an
 *     agent-only one, and must be added for both paths together if at all.
 *   - claw-token-ledger.debit/creditClawTokens is the ONLY balance write path,
 *     composed into the coup transaction via the passed `tx`.
 *   - One commit-reveal SHOE = one slot-session analogue. Reshuffle at ~75%
 *     penetration is a NEW shoe (new seed pair): /coup returns a 409
 *     `reshuffled` flag when `dealtCount >= RESHUFFLE_CARD_THRESHOLD` so the
 *     client opens a fresh shoe. The engine never reshuffles mid-coup.
 *   - One cove_game_events row PER COUP (gameType='baccarat', sessionId=shoeId,
 *     nonce=coupIndex, serverSeedHash at open, revealedServerSeed NULL until
 *     shoe close).
 *
 * ── Why baccarat is a ONE-SHOT settle (unlike blackjack's deal→action) ────────
 *
 * Punto Banco has NO player decisions: once the bet is placed the entire coup
 * (deal + fixed third-card tableau + winner) is determined. So /coup deals AND
 * settles in a SINGLE transaction under the shoe FOR UPDATE lock — there is no
 * in-progress decision window. The coup row is created already-settled. Settle is
 * idempotent: an Idempotency-Key (per coup) is the race-safe backstop via the
 * partial unique index (shoeId, idempotencyKey); a reused key replays the stored
 * outcome instead of dealing a second coup or double-crediting.
 *
 * The engine recompute happens UNDER the shoe row lock with the authoritative
 * counters (cursorBefore / dealtBefore / coupIndex) so a stale pre-lock read can
 * never commit a different outcome. The shoe is no-replacement: each coup
 * continues the cursor/dealt from the prior coups; for coupIndex > 0 we
 * reconstruct the remaining-shoe state by replaying prior settled coups
 * deterministically (O(prior coups)) and assert it matches the live counters.
 *
 * Server is AUTHORITATIVE: the client NEVER sends cards or outcomes. It sends
 * only its bet (player/banker/tie) + stake. The engine (baccarat-engine.ts)
 * re-derives every card from (serverSeed, clientSeed, nonce=coupIndex, cursor) —
 * the same commit-reveal contract as blackjack.
 *
 * Currency seam: `currency` defaults to 'clawtoken'. SOL/USDC return 501 until
 * the later tier wires custody — exactly like cove-blackjack/holdem. NO escrow.
 *
 * Guest demo-CT farming — ACCEPTED RISK (mirrors cove-blackjack's documented
 * posture). A guest who rotates `X-CV-Fingerprint` gets a fresh 100 demo-CT shoe;
 * the in-memory hourly open bucket (per-process, reset on redeploy) never trips.
 * Safe TODAY because the guest path NEVER touches `avatars.clawTokens` or the
 * ClawToken ledger: demo balance lives entirely on the shoe row and converts to
 * nothing persistent. The SOL/USDC tier MUST add a durable per-subject grant
 * ledger before reusing this accounting.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  avatars,
  baccaratShoes,
  baccaratCoups,
  coveGameEvents,
  type BaccaratShoe,
  type BaccaratCoup,
} from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { resolveAgentSession } from '../middleware/require-auth-or-agent';
import { createServerSeed } from '../services/provable-rng';
import {
  playCoup,
  playCoupWithState,
  buildShoe,
  serializeCoupResult,
  RESHUFFLE_CARD_THRESHOLD,
  BACCARAT_ENGINE_VERSION,
  type Card,
  type CoupResult,
  type SerializedCoupResult,
  type BaccaratBet,
} from '../services/baccarat-engine';
import {
  creditClawTokens,
  debitClawTokens,
  InsufficientTokensError,
} from '../services/claw-token-ledger';
import { logEventFromContext } from '../services/event-logger';
import type { AppContext } from '../types';

export const coveBaccaratRouter = new Hono<AppContext>();
coveBaccaratRouter.use('*', sessionMiddleware);

// ─── Constants ──────────────────────────────────────────────────────────────

/** Stake bounds (LOCKED rule): 5–500 CT. Engine only asserts stake > 0n. */
export const BACCARAT_MIN_BET = 5;
export const BACCARAT_MAX_BET = 500;

/** Currency seam — ClawTokens live; SOL/USDC return 501 (later tier). */
const SUPPORTED_CURRENCIES = ['clawtoken', 'sol', 'usdc'] as const;

/** Max length on the Idempotency-Key header (Stripe convention; matches blackjack). */
const IDEMPOTENCY_KEY_MAX_LEN = 64;

/** Guest demo wallet (fun-money), mirrors cove-blackjack guest tier. */
const GUEST_STARTING_BALANCE = 100n;

// ─── Rate limits (mirror cove-blackjack) ──────────────────────────────────────

interface RateBucket {
  count: number;
  resetAt: number;
}

const COUP_RATE_LIMIT = 120;
const COUP_RATE_WINDOW_MS = 60_000;
const coupRateBuckets = new Map<string, RateBucket>();

function checkCoupRate(key: string): void {
  const now = Date.now();
  if (coupRateBuckets.size > 5_000) {
    for (const [k, v] of coupRateBuckets) {
      if (now > v.resetAt) coupRateBuckets.delete(k);
    }
  }
  const entry = coupRateBuckets.get(key);
  if (!entry || now > entry.resetAt) {
    coupRateBuckets.set(key, { count: 1, resetAt: now + COUP_RATE_WINDOW_MS });
    return;
  }
  entry.count++;
  if (entry.count > COUP_RATE_LIMIT) {
    throw new HTTPException(429, {
      message: `cove_baccarat_rate_limit: max ${COUP_RATE_LIMIT} coups/min`,
    });
  }
}

// Guest open-shoe throttle — best-effort, per-process; a fingerprint-rotating
// guest defeats it (accepted risk — see route header).
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
      message: `cove_baccarat_guest_shoe_rate_limit: max ${GUEST_SHOE_OPEN_LIMIT} guest shoes/hour. Sign up to keep playing.`,
    });
  }
}

/** Test-only resets. */
export function __resetBaccaratRateLimits(): void {
  coupRateBuckets.clear();
  guestShoeOpenBuckets.clear();
}

// ─── Subject resolution (user OR agent OR guest, never combined) ─────────────
//
// THREE subject kinds (Rule E5 — human↔agent parity), VERBATIM in semantics with
// cove-blackjack.ts's BjSubject / getSubject:
//   - 'user'  — Lucia-authed human. Settles in REAL CT on `avatars.clawTokens`.
//   - 'agent' — a connected/hosted agent playing AS ITSELF via the agent gateway
//     session header. Resolves through `resolveAgentSession` → its BOUND avatar's
//     `userId`/`avatarId`, and settles in the SAME real-CT ledger path as a human.
//     An agent is NEVER routed to the guest demo tier — that XOR-with-guest gap
//     was the E5 violation this fixes.
//   - 'guest' - anonymous fingerprint, demo-CT only (no ledger).
//
// Money parity rule: 'user' and 'agent' are both LEDGER subjects (they carry a
// real `userId`/`avatarId` and write the ClawToken ledger). `isLedgerSubject()`
// collapses the two for every balance/owner branch so the audited settle path is
// reused verbatim — the agent kind adds NO new money code path.
//
// The agent-session header name matches the existing activity-portal convention
// (`require-auth-or-agent.ts`); Hono lower-cases header reads so case-insensitive.

const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';

type BacSubject =
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
}): Promise<BacSubject> {
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
function ledgerUserId(subject: BacSubject): string | null {
  return subject.kind === 'guest' ? null : subject.userId;
}

/** True iff the subject settles in real CT (human or agent). */
function isLedgerSubject(
  subject: BacSubject,
): subject is Extract<BacSubject, { kind: 'user' | 'agent' }> {
  return subject.kind !== 'guest';
}

function subjectKey(subject: BacSubject): string {
  if (subject.kind === 'guest') return `g:${subject.guestFpHash}`;
  // 'user' and 'agent' rate-limit on userId — an agent and its bound human share
  // one avatar/wallet, so they SHOULD share one coup-rate bucket (you can't dodge
  // the limit by toggling between cookie + agent header on one avatar).
  return `u:${subject.userId}`;
}

/**
 * A real-CT shoe is keyed on `userId` (NOT on agent/guest). Both human and agent
 * subjects for the same bound avatar therefore see + own the SAME shoe — an agent
 * playing AS its avatar continues the human's session, never forks a parallel one.
 * Guests own by fingerprint.
 */
function ownerMatch(
  shoe: { userId: string | null; guestFpHash: string | null },
  subject: BacSubject,
): boolean {
  return isLedgerSubject(subject)
    ? shoe.userId === subject.userId
    : shoe.guestFpHash === subject.guestFpHash;
}

// ─── Schemas ───────────────────────────────────────────────────────────────

const stakeSchema = z.number().int().min(BACCARAT_MIN_BET).max(BACCARAT_MAX_BET);

const BET_TYPES = ['player', 'banker', 'tie'] as const;

const openSchema = z
  .object({
    currency: z.enum(SUPPORTED_CURRENCIES).default('clawtoken'),
  })
  .strict();

const coupSchema = z
  .object({
    shoeId: z.string().uuid(),
    bet: z.enum(BET_TYPES),
    stake: stakeSchema,
  })
  .strict();

const closeSchema = z
  .object({
    shoeId: z.string().uuid(),
  })
  .strict();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadShoeOrThrow(shoeId: string): Promise<BaccaratShoe> {
  const shoe = await db.query.baccaratShoes.findFirst({ where: eq(baccaratShoes.id, shoeId) });
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
 * Public shoe shape. serverSeed REDACTED while status='open' (revealing it would
 * let the player pre-compute future cards from the cursor — defeats
 * commit-reveal; identical reasoning to blackjack's publicShoe).
 */
function publicShoe(row: BaccaratShoe) {
  return {
    id: row.id,
    userId: row.userId,
    currency: row.currency,
    serverSeedHash: row.serverSeedHash,
    clientSeed: row.clientSeed,
    coupCounter: row.coupCounter,
    cursorCounter: row.cursorCounter,
    dealtCount: row.dealtCount,
    startingBalance: row.startingBalance,
    currentBalance: row.currentBalance,
    totalBet: row.totalBet,
    totalPayout: row.totalPayout,
    status: row.status,
    coupsPlayed: row.coupsPlayed,
    createdAt: row.createdAt.toISOString(),
    lastCoupAt: row.lastCoupAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    serverSeed: row.status === 'open' ? null : row.serverSeed,
  };
}

/**
 * Reconstruct the exact remaining-shoe state at the START of `targetCoupIndex` by
 * replaying every prior SETTLED coup's recorded (bet, stake) deterministically.
 * Returns the packed remaining list + cursor/dealt totals — an O(prior-coups)
 * single-coup replay (no per-coup shoe-array persistence needed). Mirrors
 * blackjack's reconstructShoeState. Exported for the cross-game verifier's reuse.
 */
export async function reconstructShoeState(
  shoe: { serverSeed: string; clientSeed: string },
  shoeId: string,
  targetCoupIndex: number,
  reader: { select: typeof db.select },
): Promise<{ remaining: Card[]; cursor: number; dealt: number }> {
  if (targetCoupIndex === 0) {
    return { remaining: buildShoe(), cursor: 0, dealt: 0 };
  }
  const priorCoups = await reader
    .select()
    .from(baccaratCoups)
    .where(and(eq(baccaratCoups.shoeId, shoeId), eq(baccaratCoups.status, 'settled')))
    .orderBy(baccaratCoups.coupIndex);

  let remaining = buildShoe();
  let cursor = 0;
  let dealt = 0;
  for (const coup of priorCoups) {
    if (coup.coupIndex >= targetCoupIndex) break;
    const stepped = playCoupWithState({
      serverSeed: shoe.serverSeed,
      clientSeed: shoe.clientSeed,
      nonce: coup.coupIndex,
      cursor,
      bet: coup.bet as BaccaratBet,
      stake: BigInt(coup.stake),
      dealtBefore: dealt,
      remainingShoe: dealt === 0 ? undefined : remaining,
    });
    remaining = stepped.remainingAfter;
    cursor = stepped.cursorAfter;
    dealt = stepped.dealtAfter;
  }
  return { remaining, cursor, dealt };
}

// ─── POST /session/open ───────────────────────────────────────────────────────

coveBaccaratRouter.post('/session/open', async (c) => {
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
        message: 'SOL/USDC custody for baccarat is a later tier. Use currency="clawtoken" today.',
      },
      501,
    );
  }

  // Pre-flight balance gate (UX only; coup re-checks under the lock).
  let avatar: { id: string; clawTokens: number } | null = null;
  let guestStartingBalance = 0n;
  if (isLedgerSubject(subject)) {
    avatar = await loadAvatarForUser(subject.userId);
    if (avatar.clawTokens < BACCARAT_MIN_BET) {
      throw new HTTPException(400, {
        message: `insufficient_clawtokens: need ${BACCARAT_MIN_BET}, have ${avatar.clawTokens}`,
      });
    }
  } else {
    checkGuestShoeOpenRate(subject.guestFpHash);
    guestStartingBalance = GUEST_STARTING_BALANCE;
  }

  // Idempotent open: resume the subject's existing open shoe. Lock the row so we
  // never return data another request is mid-mutating (mirrors blackjack).
  const resumed = await db.transaction(async (tx) => {
    const lockWhere =
      isLedgerSubject(subject)
        ? sql`user_id = ${subject.userId} AND status = 'open'`
        : sql`guest_fp_hash = ${subject.guestFpHash} AND status = 'open'`;
    const rows = await tx.execute<{ id: string }>(
      sql`SELECT id FROM baccarat_shoes WHERE ${lockWhere} FOR UPDATE`,
    );
    const id = rows[0]?.id;
    if (!id) return null;
    return (await tx.query.baccaratShoes.findFirst({ where: eq(baccaratShoes.id, id) })) ?? null;
  });

  if (resumed) {
    return c.json(
      {
        shoe: publicShoe(resumed),
        walletBalance: avatar ? avatar.clawTokens : Number(guestDemoBalance(resumed)),
      },
      200,
    );
  }

  const { serverSeed, serverSeedHash } = createServerSeed();
  const clientSeed = randomBytes(8).toString('hex');

  let inserted: BaccaratShoe;
  try {
    inserted = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(baccaratShoes)
        .values({
          userId: subject.userId,
          guestFpHash: subject.guestFpHash,
          currency: 'clawtoken',
          serverSeed,
          serverSeedHash,
          clientSeed,
          startingBalance: isLedgerSubject(subject) ? '0' : guestStartingBalance.toString(),
          engineVersion: BACCARAT_ENGINE_VERSION,
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
          ? and(eq(baccaratShoes.userId, subject.userId), eq(baccaratShoes.status, 'open'))
          : and(eq(baccaratShoes.guestFpHash, subject.guestFpHash), eq(baccaratShoes.status, 'open'));
      const raceRow = (await db.select().from(baccaratShoes).where(raceWhere).limit(1))[0];
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
    eventType: 'cove.baccarat.shoe.opened',
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

// ─── POST /coup ────────────────────────────────────────────────────────────────
//
// Place a PLAYER/BANKER/TIE bet on an open shoe, deal the coup, resolve it via the
// fixed Punto Banco tableau, and settle — ALL atomically in ONE transaction under
// the shoe FOR UPDATE lock. There is no in-progress window (no player decisions).
// Refuses a new coup once penetration crosses 75% (client opens a fresh shoe).
// Idempotent via the Idempotency-Key.

interface CoupResponse {
  coupId: string;
  shoeId: string;
  coupIndex: number;
  status: 'settled';
  outcome: SerializedCoupResult;
  balance: number;
  totalBet: string;
  totalPayout: string;
  net: string;
  dealtCount: number;
  reshuffleSuggested: boolean;
  idempotencyReplay: boolean;
}

/**
 * Raised from inside the coup transaction when a reused Idempotency-Key hits the
 * (shoeId, idempotencyKey) unique index (pgCode 23505). Caught by the handler to
 * abort the (now-rolled-back) transaction and replay the already-settled
 * colliding row from a fresh read — a clean idempotent replay instead of a 500.
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

coveBaccaratRouter.post('/coup', async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key') ?? undefined;
  if (idempotencyKey && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN) {
    throw new HTTPException(400, {
      message: `idempotency_key_must_be_1_to_${IDEMPOTENCY_KEY_MAX_LEN}_chars`,
    });
  }
  const body = await c.req.json().catch(() => null);
  const parsed = coupSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const input = parsed.data;
  const subject = await getSubject(c);
  checkCoupRate(subjectKey(subject));

  const shoe = await db.query.baccaratShoes.findFirst({
    where: eq(baccaratShoes.id, input.shoeId),
  });
  if (!shoe) throw new HTTPException(404, { message: 'shoe_not_found' });
  if (!ownerMatch(shoe, subject)) throw new HTTPException(403, { message: 'shoe_not_owned' });
  if (shoe.status !== 'open') {
    throw new HTTPException(409, { message: `shoe_not_open: status=${shoe.status}` });
  }

  // 75% penetration gate — refuse a NEW coup once the shoe crossed threshold; the
  // client opens a fresh shoe (new commit-reveal seed pair). Mid-coup reshuffle is
  // never allowed (would break replay determinism).
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

  const stakeBig = BigInt(input.stake);
  const bet = input.bet as BaccaratBet;

  // Pre-flight affordability (UX). Authoritative re-check happens under the lock.
  let avatar: { id: string; clawTokens: number } | null = null;
  if (isLedgerSubject(subject)) {
    avatar = await loadAvatarForUser(subject.userId);
    if (avatar.clawTokens < input.stake) {
      throw new HTTPException(400, {
        message: `insufficient_clawtokens: need ${input.stake}, have ${avatar.clawTokens}`,
      });
    }
  } else {
    const demo = guestDemoBalance(shoe);
    if (demo < stakeBig) {
      throw new HTTPException(400, {
        message: `insufficient_guest_demo_balance: need ${input.stake}, have ${demo.toString()}. Sign up to play with more.`,
      });
    }
  }

  let txResult: { coup: BaccaratCoup; replay: boolean; balanceAfter: number | undefined };
  try {
    txResult = await coupTransaction();
  } catch (err) {
    if (err instanceof IdempotencyReplayError) {
      // The coup tx was rolled back by the key collision. Re-read the already-
      // settled colliding row in a fresh query and replay it.
      const replayed = await db.query.baccaratCoups.findFirst({
        where: and(
          eq(baccaratCoups.shoeId, err.shoeId),
          eq(baccaratCoups.idempotencyKey, err.idempotencyKey),
        ),
      });
      if (replayed && replayed.status === 'settled') {
        const freshShoe = await loadShoeOrThrow(input.shoeId);
        return c.json(await buildCoupResponse(replayed, freshShoe, subject), 200);
      }
      throw new HTTPException(409, { message: 'idempotency_key_in_flight: retry shortly' });
    }
    throw err;
  }

  async function coupTransaction(): Promise<{
    coup: BaccaratCoup;
    replay: boolean;
    balanceAfter: number | undefined;
  }> {
    return db.transaction(async (tx) => {
      // Lock the SHOE — serializes this coup against concurrent coups/closes and
      // gives authoritative counters for the engine recompute.
      const shoeRows = await tx.execute<{
        id: string;
        server_seed: string;
        server_seed_hash: string;
        client_seed: string;
        coup_counter: number | string;
        cursor_counter: number | string;
        dealt_count: number | string;
        total_bet: string;
        total_payout: string;
        starting_balance: string;
        status: string;
        [key: string]: unknown;
      }>(
        sql`SELECT id, server_seed, server_seed_hash, client_seed, coup_counter,
                   cursor_counter, dealt_count, total_bet, total_payout,
                   starting_balance, status
            FROM baccarat_shoes WHERE id = ${input.shoeId} FOR UPDATE`,
      );
      const shoeLock = shoeRows[0];
      if (!shoeLock) throw new HTTPException(404, { message: 'shoe_not_found' });
      if (shoeLock.status !== 'open') {
        throw new HTTPException(409, { message: `shoe_not_open: status=${shoeLock.status}` });
      }

      // Idempotency-Key pre-check: if THIS key already settled a coup for this
      // shoe, replay that row instead of dealing again. Catches a client retry
      // that reuses the key before the unique index would 23505 the write below.
      if (idempotencyKey) {
        const priorByKey = await tx.query.baccaratCoups.findFirst({
          where: and(
            eq(baccaratCoups.shoeId, input.shoeId),
            eq(baccaratCoups.idempotencyKey, idempotencyKey),
          ),
        });
        if (priorByKey && priorByKey.status === 'settled') {
          return { coup: priorByKey, replay: true as const, balanceAfter: undefined };
        }
      }

      const coupIndex = Number(shoeLock.coup_counter);
      const cursorBefore = Number(shoeLock.cursor_counter);
      const dealtBefore = Number(shoeLock.dealt_count);
      if (dealtBefore >= RESHUFFLE_CARD_THRESHOLD) {
        throw new HTTPException(409, {
          message: 'shoe_penetration_exceeded: open a new shoe (75% reached)',
        });
      }

      // ── Engine recompute UNDER the lock — authoritative outcome ──────────────
      let r: CoupResult;
      try {
        if (coupIndex === 0) {
          r = playCoup({
            serverSeed: shoeLock.server_seed,
            clientSeed: shoeLock.client_seed,
            nonce: 0,
            cursor: 0,
            bet,
            stake: stakeBig,
          });
        } else {
          const state = await reconstructShoeState(
            { serverSeed: shoeLock.server_seed, clientSeed: shoeLock.client_seed },
            input.shoeId,
            coupIndex,
            tx,
          );
          // Assert reconstructed counters match the live shoe counters — a drift
          // would mean a divergent (potentially fresh-shoe) deal. Fail loudly.
          if (state.cursor !== cursorBefore || state.dealt !== dealtBefore) {
            throw new HTTPException(500, {
              message:
                `shoe_counter_drift: reconstructed cursor=${state.cursor}/dealt=${state.dealt} ` +
                `!= shoe cursor=${cursorBefore}/dealt=${dealtBefore}`,
            });
          }
          r = playCoup({
            serverSeed: shoeLock.server_seed,
            clientSeed: shoeLock.client_seed,
            nonce: coupIndex,
            cursor: cursorBefore,
            bet,
            stake: stakeBig,
            dealtBefore,
            remainingShoe: state.remaining,
          });
        }
      } catch (err) {
        if (err instanceof HTTPException) throw err;
        throw new HTTPException(400, {
          message: `baccarat_engine_error: ${(err as Error).message}`,
        });
      }

      // Money safety: refuse payout/stake exceeding JS-number range.
      if (r.payout > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new HTTPException(500, { message: 'payout_exceeds_supported_range' });
      }
      if (r.stake > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new HTTPException(400, { message: 'bet_exceeds_supported_range' });
      }

      // ── Ledger debit/credit (authed) OR demo accounting (guest) ──────────────
      // Atomic: debit the stake, credit the gross payout, both in THIS tx. A push
      // (tie + P/B bet) returns the stake as payout, net 0. A win credits
      // stake+winnings. A loss credits 0 (stake stays debited).
      let balanceAfter: number;
      if (isLedgerSubject(subject) && avatar) {
        const stakeNumber = Number(r.stake);
        try {
          const debit = await debitClawTokens(
            {
              avatarId: avatar.id,
              amount: stakeNumber,
              reason: 'cove_baccarat_stake',
              source: 'api',
              metadata: { shoeId: input.shoeId, coupIndex, bet },
            },
            tx,
          );
          balanceAfter = debit.balanceAfter;
        } catch (err) {
          if (err instanceof InsufficientTokensError) {
            throw new HTTPException(400, {
              message: `insufficient_clawtokens: need ${stakeNumber}, have ${err.available}`,
            });
          }
          throw err;
        }
        const payoutNumber = Number(r.payout);
        if (payoutNumber > 0) {
          const credit = await creditClawTokens(
            {
              avatarId: avatar.id,
              amount: payoutNumber,
              reason: 'cove_baccarat_payout',
              source: 'api',
              metadata: { shoeId: input.shoeId, coupIndex, bet, winner: r.winner },
            },
            tx,
          );
          balanceAfter = credit.balanceAfter;
        }
      } else {
        // Guest demo accounting — no ledger writes. Balance = starting +
        // total_payout - total_bet, with this coup's stake + payout folded in.
        const newTotalBetGuest = BigInt(shoeLock.total_bet) + r.stake;
        const newTotalPayoutGuest = BigInt(shoeLock.total_payout) + r.payout;
        const newDemo =
          BigInt(shoeLock.starting_balance) + newTotalPayoutGuest - newTotalBetGuest;
        if (newDemo < 0n) {
          throw new HTTPException(400, { message: 'insufficient_guest_demo_balance_at_coup' });
        }
        balanceAfter = Number(newDemo);
      }

      // ── Persist the settled coup row ─────────────────────────────────────────
      const serialized = serializeCoupResult(r, { cursorBefore, dealtBefore, nonce: coupIndex });
      let settledCoup: BaccaratCoup | undefined;
      try {
        const [row] = await tx
          .insert(baccaratCoups)
          .values({
            shoeId: input.shoeId,
            coupIndex,
            cursorBefore,
            cursorAfter: r.cursorAfter,
            dealtBefore,
            dealtAfter: r.dealtAfter,
            bet,
            stake: r.stake.toString(),
            status: 'settled',
            outcomeJson: serialized,
            payout: r.payout.toString(),
            net: r.net.toString(),
            idempotencyKey: idempotencyKey ?? null,
            settledAt: new Date(),
          })
          .returning();
        settledCoup = row;
      } catch (err) {
        const pgCode = (err as { code?: string } | undefined)?.code;
        if (pgCode === '23505') {
          // A unique-index collision: either the (shoeId, coupIndex) reservation
          // (a concurrent coup beat us — should be impossible under the shoe lock
          // but defensive) OR a reused (shoeId, idempotencyKey). Both abort the
          // whole tx (rolling back the ledger writes). Surface a clean replay.
          if (idempotencyKey) {
            throw new IdempotencyReplayError(input.shoeId, idempotencyKey);
          }
          throw new HTTPException(409, { message: 'coup_conflict: retry' });
        }
        throw err;
      }
      if (!settledCoup) throw new HTTPException(500, { message: 'coup_insert_failed' });

      // ── One cove_game_events row PER COUP ────────────────────────────────────
      // serverSeedHash committed at open; revealedServerSeed NULL until shoe close
      // (commit-reveal). nonce = coupIndex; sessionId = shoeId.
      await tx.insert(coveGameEvents).values({
        userId: subject.userId,
        guestFpHash: subject.guestFpHash,
        gameType: 'baccarat',
        sessionId: input.shoeId,
        shoeId: input.shoeId,
        betAmount: r.stake.toString(),
        payout: r.payout.toString(),
        outcomeJson: serialized,
        serverSeedHash: shoeLock.server_seed_hash,
        revealedServerSeed: null,
        clientSeed: shoeLock.client_seed,
        nonce: coupIndex,
        txSignature: null,
        engineVersion: `baccarat-engine-${BACCARAT_ENGINE_VERSION}`,
      });

      // ── Advance shoe counters ────────────────────────────────────────────────
      const newTotalBet = (BigInt(shoeLock.total_bet) + r.stake).toString();
      const newTotalPayout = (BigInt(shoeLock.total_payout) + r.payout).toString();
      const newCurrentBalance = (BigInt(newTotalPayout) - BigInt(newTotalBet)).toString();
      await tx
        .update(baccaratShoes)
        .set({
          coupCounter: coupIndex + 1,
          cursorCounter: r.cursorAfter,
          dealtCount: r.dealtAfter,
          totalBet: newTotalBet,
          totalPayout: newTotalPayout,
          currentBalance: newCurrentBalance,
          coupsPlayed: sql`${baccaratShoes.coupsPlayed} + 1`,
          lastCoupAt: new Date(),
        })
        .where(eq(baccaratShoes.id, input.shoeId));

      return { coup: settledCoup, replay: false as const, balanceAfter };
    });
  }

  const coup = txResult.coup;
  const outcome = coup.outcomeJson as SerializedCoupResult;
  const dealtCount = coup.dealtAfter ?? 0;

  // Compute the response balance.
  let balance: number;
  if (txResult.replay || txResult.balanceAfter === undefined) {
    if (isLedgerSubject(subject)) {
      balance = (await loadAvatarForUser(subject.userId)).clawTokens;
    } else {
      const fresh = await db.query.baccaratShoes.findFirst({
        where: eq(baccaratShoes.id, input.shoeId),
      });
      balance = fresh ? Number(guestDemoBalance(fresh)) : 0;
    }
  } else {
    balance = txResult.balanceAfter;
  }

  void logEventFromContext(c, {
    eventType: 'cove.baccarat.coup.settled',
    userId: ledgerUserId(subject),
    avatarId: avatar?.id ?? null,
    agentId: subject.kind === 'agent' ? subject.agentId : null,
    payload: {
      shoeId: input.shoeId,
      coupId: coup.id,
      coupIndex: coup.coupIndex,
      bet: coup.bet,
      stake: coup.stake,
      payout: coup.payout,
      net: coup.net,
      winner: outcome.winner,
      isGuest: subject.kind === 'guest',
      isAgent: subject.kind === 'agent',
      replay: txResult.replay,
    },
  });

  return c.json(
    {
      coupId: coup.id,
      shoeId: input.shoeId,
      coupIndex: coup.coupIndex,
      status: 'settled',
      outcome,
      balance,
      totalBet: outcome.stake,
      totalPayout: outcome.payout,
      net: outcome.net,
      dealtCount,
      reshuffleSuggested: dealtCount >= RESHUFFLE_CARD_THRESHOLD,
      idempotencyReplay: txResult.replay,
    } satisfies CoupResponse,
    200,
  );
});

/** Build a coup response from a stored row (idempotent replay path). */
async function buildCoupResponse(
  coup: BaccaratCoup,
  shoe: BaccaratShoe,
  subject: BacSubject,
): Promise<CoupResponse> {
  const outcome = coup.outcomeJson as SerializedCoupResult;
  const dealtCount = coup.dealtAfter ?? shoe.dealtCount;
  const balance =
    isLedgerSubject(subject)
      ? (await loadAvatarForUser(subject.userId)).clawTokens
      : Number(guestDemoBalance(shoe));
  return {
    coupId: coup.id,
    shoeId: shoe.id,
    coupIndex: coup.coupIndex,
    status: 'settled',
    outcome,
    balance,
    totalBet: outcome.stake,
    totalPayout: outcome.payout,
    net: outcome.net,
    dealtCount,
    reshuffleSuggested: dealtCount >= RESHUFFLE_CARD_THRESHOLD,
    idempotencyReplay: true,
  };
}

// ─── POST /session/close ──────────────────────────────────────────────────────
//
// Close the shoe + reveal serverSeed on every cove_game_events row for the shoe
// (commit-reveal contract — mirrors blackjack /session/close).
//
// Subject-resolved (NOT requireAuth) so a connected AGENT can close its own shoe
// and reveal the seed — without this the agent could never satisfy the fairness
// promise and its shoe would wedge open forever at 75% penetration. Ledger
// subjects only (human or agent): a guest demo shoe has no persistent fairness
// contract to honor and the prior Lucia-only gate already excluded guests, so we
// keep that exclusion (403) rather than widening it. ownerMatch binds to the
// resolved userId, so an agent can never close another user's shoe.

coveBaccaratRouter.post('/session/close', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = closeSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_input: ' + parsed.error.message });
  }
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_cannot_close_shoe: sign in or connect an agent' });
  }

  const shoe = await db.query.baccaratShoes.findFirst({
    where: eq(baccaratShoes.id, parsed.data.shoeId),
  });
  if (!shoe) throw new HTTPException(404, { message: 'shoe_not_found' });
  if (!ownerMatch(shoe, subject)) throw new HTTPException(403, { message: 'shoe_not_owned' });
  if (shoe.status !== 'open') {
    throw new HTTPException(409, { message: `shoe_not_open: status=${shoe.status}` });
  }

  const closed = await db.transaction(async (tx) => {
    const lockRows = await tx.execute<{ status: string }>(
      sql`SELECT status FROM baccarat_shoes WHERE id = ${shoe.id} FOR UPDATE`,
    );
    const lock = lockRows[0];
    if (!lock) throw new HTTPException(404, { message: 'shoe_not_found' });
    if (lock.status !== 'open') {
      throw new HTTPException(409, { message: `shoe_not_open: status=${lock.status}` });
    }

    const [closedShoe] = await tx
      .update(baccaratShoes)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(baccaratShoes.id, shoe.id))
      .returning();
    if (!closedShoe) throw new HTTPException(500, { message: 'shoe_close_failed' });

    // Reveal the serverSeed on every baccarat event for this shoe.
    await tx
      .update(coveGameEvents)
      .set({ revealedServerSeed: closedShoe.serverSeed })
      .where(and(eq(coveGameEvents.sessionId, shoe.id), eq(coveGameEvents.gameType, 'baccarat')));

    return closedShoe;
  });

  void logEventFromContext(c, {
    eventType: 'cove.baccarat.shoe.closed',
    userId: subject.userId,
    agentId: subject.kind === 'agent' ? subject.agentId : null,
    payload: {
      shoeId: closed.id,
      coupsPlayed: closed.coupsPlayed,
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
      coupsPlayed: closed.coupsPlayed,
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

coveBaccaratRouter.get('/session/current', async (c) => {
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_has_no_persistent_shoe: sign in or connect an agent' });
  }
  const row = await db.query.baccaratShoes.findFirst({
    where: and(eq(baccaratShoes.userId, subject.userId), eq(baccaratShoes.status, 'open')),
  });
  if (!row) throw new HTTPException(404, { message: 'no_open_shoe' });
  const avatar = await loadAvatarForUser(subject.userId);
  return c.json({ shoe: publicShoe(row), walletBalance: avatar.clawTokens }, 200);
});

// ─── GET /session/:id ─────────────────────────────────────────────────────────
//
// Owner-only shoe detail (serverSeed redacted while open). Subject-resolved so an
// agent can inspect its own shoe; ownerMatch binds to the resolved userId, so an
// agent can never read another user's shoe by id.

coveBaccaratRouter.get('/session/:id', async (c) => {
  const shoeId = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(shoeId)) {
    throw new HTTPException(400, { message: 'invalid_shoe_id' });
  }
  const subject = await getSubject(c);
  if (!isLedgerSubject(subject)) {
    throw new HTTPException(403, { message: 'guest_cannot_inspect_shoe: sign in or connect an agent' });
  }
  const row = await db.query.baccaratShoes.findFirst({ where: eq(baccaratShoes.id, shoeId) });
  if (!row) throw new HTTPException(404, { message: 'shoe_not_found' });
  if (!ownerMatch(row, subject)) throw new HTTPException(403, { message: 'shoe_not_owned' });
  return c.json({ shoe: publicShoe(row) }, 200);
});

export default coveBaccaratRouter;
