/**
 * Phase 6.1 — slice 3: ClawTokens fun-money casino-slots backend wire.
 *
 * Mount: `app.route('/api/casino/slots', casinoSlotsRouter)` from index.ts.
 *
 * Surfaces:
 *
 *   POST /session/open              (Lucia auth) — open commit-reveal session
 *   POST /spin                      (Lucia auth) — execute one spin (idempotent)
 *   POST /session/close             (Lucia auth) — close + reveal serverSeed
 *   GET  /session/:id               (Lucia auth) — owner-only session detail
 *   GET  /session/:id/spins         (Lucia auth) — owner-only paginated spins
 *   GET  /paytables/:id             (public)     — paytable + reel strips for verifier
 *   POST /verify                    (public)     — pure-compute replay endpoint
 *
 * ClawTokens path is fully wired. SOL/USDC `/session/open` returns 501 with
 * a friendly "coming in 6.2" message — the column tolerates them so future
 * custody hookup is a route change, not a schema change.
 *
 * Money model (slice 3, ClawTokens only):
 *   - /session/open does NOT debit. It records startingBalance for UI display.
 *     It DOES pre-check that the avatar can afford at least one bet, returning
 *     400 `insufficient_clawtokens` early so we don't open a fund-less session.
 *   - /spin direct-debits bet, credits winAmount. Atomic within a single
 *     transaction (debit + counters + spin insert + win credit all-or-nothing).
 *   - /session/close has no refund. Player's balance equals real-time
 *     avatar.clawTokens — there is nothing in escrow to give back because
 *     ClawTokens path never reserved anything at open time.
 * Phase 6.2 will add SOL/USDC buy-in semantics with on-chain escrow; the
 * `escrowAmount` column is reserved for that path and stays at '0' here.
 *
 * Design choices:
 *
 *  1) BigInt JSON: every response that carries bigint (winAmount, bet,
 *     escrow, totals) goes through `serializeSpinResult` / explicit
 *     `.toString()` so Hono's `c.json` never sees a bigint. No
 *     `BigInt.prototype.toJSON` monkey-patch — global side effects bite
 *     event-logger sanitization and third-party deps.
 *
 *  2) Idempotency: every POST /spin requires an `Idempotency-Key` header.
 *     On the hot path we SELECT first inside a transaction. A cached row
 *     short-circuits BEFORE we call `runSpin`, BEFORE we debit, BEFORE
 *     we touch the session counters — pure replay. We ALSO assert the
 *     cached spin's `bet` matches the new request's `bet` before serving
 *     the cache (Stripe-style); a mismatched replay returns 409 so a
 *     leaked key can't be replayed at a different stake when slice 4+
 *     relaxes the per-session fixed-bet constraint. The partial unique
 *     index (sessionId, idempotencyKey) is the race-safe backstop if two
 *     concurrent retries with the same key reach the INSERT.
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
  type SlotSession,
} from '@clawville/database';
import {
  BONUS_REEL_STRIPS,
  BONUS_SYMBOLS,
  CLASSIC_LINES,
  CLASSIC_REEL_STRIPS,
  CLASSIC_SYMBOLS,
  FREE_SPIN_RULES,
} from '@clawville/shared';
import { requireAuth, sessionMiddleware } from '../middleware/auth';
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
import { logEventFromContext } from '../services/event-logger';
import {
  serializeSpinResult,
  serializeWildMultiplier,
  serializeWinningLine,
  type CloseSessionResponse,
  type OpenSessionResponse,
  type PaytableResponse,
  type SerializedWildMultiplier,
  type SpinResponse,
} from './casino-slots.types';
import type { AppContext } from '../types';

export const casinoSlotsRouter = new Hono<AppContext>();
casinoSlotsRouter.use('*', sessionMiddleware);

// ─── Constants ────────────────────────────────────────────────────────────

const SUPPORTED_PAYTABLES = ['classic-3x5', 'classic-3x5-bonus'] as const satisfies readonly MachineSlug[];
const SUPPORTED_CURRENCIES = ['clawtokens', 'sol', 'usdc'] as const;

/** Max length on the `Idempotency-Key` header (matches Stripe convention). */
const IDEMPOTENCY_KEY_MAX_LEN = 64;

/** Default + max page size on /session/:id/spins. */
const SPIN_HISTORY_DEFAULT_LIMIT = 50;
const SPIN_HISTORY_MAX_LIMIT = 200;

// ─── User-scoped spin rate limiter (60/min/user) ──────────────────────────
//
// Auth-bound scoping defeats the shared-NAT collateral damage of IP
// limiters. Bounded growth: at most one entry per logged-in user, swept
// lazily on insert.

interface SpinRateBucket {
  count: number;
  resetAt: number;
}
const SPIN_RATE_LIMIT = 60;
const SPIN_RATE_WINDOW_MS = 60_000;
const spinRateBuckets = new Map<string, SpinRateBucket>();

function checkSpinRate(userId: string): void {
  const now = Date.now();
  // Cheap periodic GC: every ~500 misses sweep expired entries.
  if (spinRateBuckets.size > 5_000) {
    for (const [k, v] of spinRateBuckets) {
      if (now > v.resetAt) spinRateBuckets.delete(k);
    }
  }
  const entry = spinRateBuckets.get(userId);
  if (!entry || now > entry.resetAt) {
    spinRateBuckets.set(userId, { count: 1, resetAt: now + SPIN_RATE_WINDOW_MS });
    return;
  }
  entry.count++;
  if (entry.count > SPIN_RATE_LIMIT) {
    throw new HTTPException(429, {
      message: `casino_slots_rate_limit: max ${SPIN_RATE_LIMIT} spins/min`,
    });
  }
}

/** Test-only — exported for unit tests to reset between assertions. */
export function __resetSpinRateLimit(): void {
  spinRateBuckets.clear();
}

// ─── Schemas ──────────────────────────────────────────────────────────────

const bigintPositiveString = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer string')
  .refine((s) => s.length <= 30, 'bet too large to be sane');

const openSchema = z
  .object({
    paytableId: z.enum(SUPPORTED_PAYTABLES),
    currency: z.enum(SUPPORTED_CURRENCIES),
    bet: bigintPositiveString,
  })
  .strict();

const spinSchema = z
  .object({
    sessionId: z.string().uuid(),
    bet: bigintPositiveString,
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
    bet: bigintPositiveString,
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
        rtp: 0.96,
      };
    case 'classic-3x5-bonus':
      return {
        paytableId,
        symbols: BONUS_SYMBOLS,
        lines: CLASSIC_LINES,
        reelStrips: BONUS_REEL_STRIPS,
        rtp: 0.98,
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

casinoSlotsRouter.post('/session/open', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = openSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'invalid_input: ' + parsed.error.message,
    });
  }
  const input = parsed.data;
  const user = c.get('user')!;

  // 501 stub for SOL/USDC — Phase 6.2 custody not wired.
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

  const betBig = BigInt(input.bet);
  if (betBig <= 0n) {
    throw new HTTPException(400, { message: 'bet_must_be_positive' });
  }
  // ClawTokens are stored as int4, so this must fit a JS number.
  if (betBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HTTPException(400, { message: 'bet_exceeds_supported_range' });
  }
  const betNumber = Number(betBig);

  // Pre-flight: refuse a second open session before we even hit the
  // INSERT. The partial unique index will catch races; this is the
  // fast/clean path so users get a friendly 409 with the offending id.
  const existing = await db
    .select({ id: slotSessions.id })
    .from(slotSessions)
    .where(and(eq(slotSessions.userId, user.id), eq(slotSessions.status, 'open')))
    .limit(1);
  if (existing.length > 0) {
    throw new HTTPException(409, {
      message: 'session_already_open',
    });
  }

  // Load avatar — required so a user without an active avatar gets a
  // clean 400 instead of a foreign-key surprise downstream, and so we can
  // pre-flight check their ClawTokens balance before opening the session.
  const avatar = await loadAvatarForUser(user.id);

  // Pre-flight balance check: can they afford their first spin? No
  // open-time debit happens here (slice-3 money model — see file docstring),
  // but we still gate at open time so we don't strand the player with an
  // unspendable session. A later spin will re-check inside its txn under
  // the row lock — that's the authoritative gate; this is UX.
  if (avatar.clawTokens < betNumber) {
    throw new HTTPException(400, {
      message: `insufficient_clawtokens: need ${betNumber}, have ${avatar.clawTokens}`,
    });
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
      const [row] = await tx
        .insert(slotSessions)
        .values({
          userId: user.id,
          paytableId: input.paytableId,
          currency: input.currency,
          serverSeed,
          serverSeedHash,
          clientSeed,
          // startingBalance: informational snapshot of the user's chosen
          // per-spin bet at open time. Used by the UI; not load-bearing.
          startingBalance: betBig.toString(),
          // currentBalance: net session P&L (negative = down, positive = up).
          // Starts at 0 because no real money has moved at open time.
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
    // Map race-condition unique-index violation to a clean 409 — Postgres
    // error code 23505 (unique_violation). Without this catch, the
    // generic onError handler would return 500 and alert Telegram.
    const pgCode = (err as { code?: string } | undefined)?.code;
    if (pgCode === '23505') {
      throw new HTTPException(409, { message: 'session_already_open' });
    }
    throw err;
  }

  void logEventFromContext(c, {
    eventType: 'casino.slots.session.opened',
    userId: user.id,
    avatarId: avatar.id,
    payload: {
      sessionId: inserted.id,
      paytableId: input.paytableId,
      currency: input.currency,
      bet: betBig.toString(),
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
    bet: betBig.toString(),
    createdAt: inserted.createdAt.toISOString(),
  };
  return c.json(response, 200);
});

// ─── POST /spin ────────────────────────────────────────────────────────────

casinoSlotsRouter.post('/spin', requireAuth, async (c) => {
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
  const user = c.get('user')!;

  // User-scoped rate limit (auth-bound, not IP-bound).
  checkSpinRate(user.id);

  const session = await db.query.slotSessions.findFirst({
    where: eq(slotSessions.id, input.sessionId),
  });
  if (!session) {
    throw new HTTPException(404, { message: 'session_not_found' });
  }
  if (session.userId !== user.id) {
    throw new HTTPException(403, { message: 'session_not_owned' });
  }
  if (session.status !== 'open') {
    throw new HTTPException(409, {
      message: `session_not_open: status=${session.status}`,
    });
  }

  // Slice 3 simplicity — bet per spin must equal session's reserved bet.
  // Later phases may relax this; the engine itself doesn't care.
  if (input.bet !== session.startingBalance) {
    throw new HTTPException(400, {
      message: `bet_must_equal_session_reserved_bet (expected ${session.startingBalance}, got ${input.bet})`,
    });
  }
  const betBig = BigInt(input.bet);
  if (betBig <= 0n) {
    throw new HTTPException(400, { message: 'bet_must_be_positive' });
  }
  if (betBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HTTPException(400, { message: 'bet_exceeds_supported_range' });
  }
  const betNumber = Number(betBig);

  // ─── Idempotency fast-path ─────────────────────────────────────────
  // If the same (sessionId, idempotencyKey) tuple already exists, return
  // the cached row verbatim — NEVER re-run RNG, NEVER re-debit.
  //
  // Stripe-style guard: a key replayed with DIFFERENT bet args is a
  // misuse (or an exploitation attempt) — return 409 instead of serving
  // the cached result at the new stake. Today's pre-cache check at
  // input.bet === session.startingBalance makes this coincidentally
  // unreachable, but slice 4+ will relax that and this guard becomes
  // load-bearing. Keep it in place now so the bug can't slip in later.
  const cached = await db.query.slotSpins.findFirst({
    where: and(
      eq(slotSpins.sessionId, session.id),
      eq(slotSpins.idempotencyKey, idempotencyKey),
    ),
  });
  if (cached) {
    if (cached.bet !== input.bet) {
      throw new HTTPException(409, {
        message: `idempotency_key_reused_with_different_args: cached bet=${cached.bet}, new bet=${input.bet}. Use a fresh Idempotency-Key.`,
      });
    }
    // Re-load the session so the response reflects post-cached-spin state.
    const fresh = await db.query.slotSessions.findFirst({
      where: eq(slotSessions.id, session.id),
    });
    const avatar = await loadAvatarForUser(user.id);
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
      // for this exact spin (not 0 unconditionally). The column lives
      // on slotSessions, not slotSpins, but the cached spin row's
      // jsonb `wildMultipliers` + `scatterPayout` carry everything we
      // need to reconstruct what the player saw. We recompute
      // `freeSpinsAwarded` from `scatterPayout > 0` heuristic for
      // backwards compatibility: classic-3x5 always has scatterPayout=0
      // so freeSpinsAwarded stays 0 there; bonus paytable with a
      // non-zero scatter payout implies a trigger fired (3+ scatters).
      // The exact award value (10 vs 5 retrigger) is lost on cache but
      // SESSION state (mode + remaining) was already updated when the
      // original spin landed — that's what matters.
      freeSpinsAwarded: BigInt(cached.scatterPayout) > 0n
        ? (cached.isFreeSpin ? FREE_SPIN_RULES.AWARD_RETRIGGER : FREE_SPIN_RULES.AWARD_BASE)
        : 0,
      isFreeSpin: cached.isFreeSpin,
      wildMultipliers: cached.wildMultipliers as SerializedWildMultiplier[],
      scatterPayout: cached.scatterPayout,
      cursorAfter: cached.cursorAfter,
      bet: cached.bet,
      balance: avatar.clawTokens,
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

  const avatar = await loadAvatarForUser(user.id);

  // Phase 6.1.5 — derive free-spin mode from the session row read above.
  // Defensive: only the bonus paytable can ever set mode='free-spin', so
  // a classic-3x5 session row with mode='free-spin' AND freeSpinsRemaining>0
  // is treated as base (engine ignores freeSpinMode for non-bonus paytables
  // anyway — no wild draws, no scatter — but skipping the debit on classic
  // would be a money bug). We belt-and-suspenders this here.
  const isBonusPaytable = session.paytableId === 'classic-3x5-bonus';
  const isFreeSpinSpin =
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
      bet: betBig,
      freeSpinMode: isFreeSpinSpin,
    });
  } catch (err) {
    throw new HTTPException(400, {
      message: `spin_engine_error: ${(err as Error).message}`,
    });
  }
  const winAmountBig = spinResult.winAmount;

  // ─── Atomic spin write ──────────────────────────────────────────────
  // 1. Debit `bet` from user (skip if the open's escrow still covers it
  //    — we instead burn the escrow on the first spin).
  // 2. Update session counters / cursor.
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
      // Engine was called on a pre-lock snapshot — if the session's
      // counters have moved (concurrent spin won the race), abort and
      // let the client retry with a fresh Idempotency-Key. The runSpin
      // result is now stale and unsafe to persist.
      if (
        lockRow.nonce_counter !== session.nonceCounter ||
        lockRow.cursor_counter !== session.cursorCounter
      ) {
        throw new HTTPException(409, {
          message: 'session_counter_changed_retry',
        });
      }
      // Phase 6.1.5 — guard against mode-changed-mid-flight too. The
      // engine call above used `isFreeSpinSpin` derived from `session.mode`
      // (pre-lock snapshot). If a concurrent path mutated the mode (e.g.
      // a previous spin in this session burned the last free spin and
      // flipped to 'base'), the runSpin result is no longer valid for
      // this row's mode — fail closed and let the client retry.
      const lockIsFreeSpinSpin =
        isBonusPaytable && lockRow.mode === 'free-spin' && lockRow.free_spins_remaining > 0;
      if (lockIsFreeSpinSpin !== isFreeSpinSpin) {
        throw new HTTPException(409, {
          message: 'session_mode_changed_retry',
        });
      }

      // Phase 6.1.5 — debit only on BASE spins. Free spins consume no
      // predict (FREE in name and in money), but still credit any win.
      let debitBalance: number;
      if (isFreeSpinSpin) {
        // Re-read balance so the response reflects current truth without
        // a debit. The credit path below mutates this if winAmount > 0.
        const balRows = await tx.execute<{ claw_tokens: number }>(
          sql`SELECT claw_tokens FROM avatars WHERE id = ${avatar.id}`,
        );
        debitBalance = balRows[0]?.claw_tokens ?? avatar.clawTokens;
      } else {
        // Debit bet from user (ledger row + balance update).
        try {
          const debit = await debitClawTokens(
            {
              avatarId: avatar.id,
              amount: betNumber,
              reason: 'casino_slots_spin',
              source: 'api',
              metadata: {
                sessionId: session.id,
                paytableId: session.paytableId,
                nonce: session.nonceCounter,
              },
            },
            tx,
          );
          debitBalance = debit.balanceAfter;
        } catch (err) {
          if (err instanceof InsufficientTokensError) {
            throw new HTTPException(400, {
              message: `insufficient_clawtokens_for_spin: need ${betNumber}, have ${err.available}`,
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
          bet: betBig.toString(),
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

      // Update session counters.
      const newNonce = session.nonceCounter + 1;
      const newCursor = spinResult.cursorAfter;
      // Phase 6.1.5 — totalStaked counts only DEBITED predicts. Free
      // spins do not add to totalStaked (they are free); RTP analysis
      // and Money-safety invariant depend on this.
      const newTotalStaked = isFreeSpinSpin
        ? lockRow.total_staked
        : (BigInt(lockRow.total_staked) + betBig).toString();
      const newTotalWon = (BigInt(lockRow.total_won) + winAmountBig).toString();
      // escrowAmount stays '0' on the ClawTokens path — no reservation was
      // made at open time, so there's nothing to drain. Phase 6.2 SOL/USDC
      // will pre-fund the column and decrement here.
      const oldEscrow = BigInt(lockRow.escrow_amount);
      const newEscrow = !isFreeSpinSpin && oldEscrow > betBig
        ? (oldEscrow - betBig).toString()
        : (isFreeSpinSpin ? lockRow.escrow_amount : '0');
      const newSpinCount = lockRow.spin_count + 1;
      // currentBalance is net session P&L (signed). On a free spin we
      // don't subtract the predict — only the winAmount counts up.
      const debitDelta = isFreeSpinSpin ? 0n : betBig;
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

      // Credit winnings (if any).
      let creditBalance = debitBalance;
      if (winAmountBig > 0n) {
        if (winAmountBig > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new HTTPException(500, {
            message: 'win_amount_exceeds_int4_range',
          });
        }
        const credit = await creditClawTokens(
          {
            avatarId: avatar.id,
            amount: Number(winAmountBig),
            reason: 'casino_slots_win',
            source: 'api',
            metadata: {
              sessionId: session.id,
              spinId: spinRow.id,
              nonce: session.nonceCounter,
            },
          },
          tx,
        );
        creditBalance = credit.balanceAfter;
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
        // that won the race MUST still have used the same bet, otherwise
        // the second caller is replaying at a different stake. Fail
        // closed.
        if (cachedRetry.bet !== input.bet) {
          throw new HTTPException(409, {
            message: `idempotency_key_reused_with_different_args: cached bet=${cachedRetry.bet}, new bet=${input.bet}. Use a fresh Idempotency-Key.`,
          });
        }
        const fresh = await db.query.slotSessions.findFirst({
          where: eq(slotSessions.id, session.id),
        });
        const avatarAfter = await loadAvatarForUser(user.id);
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
          bet: cachedRetry.bet,
          balance: avatarAfter.clawTokens,
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

  void logEventFromContext(c, {
    eventType: 'casino.slots.spin.executed',
    userId: user.id,
    avatarId: avatar.id,
    payload: {
      sessionId: session.id,
      spinId: spinRowId,
      bet: betBig.toString(),
      winAmount: winAmountBig.toString(),
      nonce: session.nonceCounter,
    },
  });

  const serialized = serializeSpinResult(spinResult);
  const response: SpinResponse = {
    spinId: spinRowId,
    ...serialized,
    bet: betBig.toString(),
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

casinoSlotsRouter.post('/session/close', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = closeSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'invalid_input: ' + parsed.error.message,
    });
  }
  const user = c.get('user')!;

  const session = await db.query.slotSessions.findFirst({
    where: eq(slotSessions.id, parsed.data.sessionId),
  });
  if (!session) {
    throw new HTTPException(404, { message: 'session_not_found' });
  }
  if (session.userId !== user.id) {
    throw new HTTPException(403, { message: 'session_not_owned' });
  }
  if (session.status !== 'open') {
    throw new HTTPException(409, {
      message: `session_not_open: status=${session.status}`,
    });
  }

  const avatar = await loadAvatarForUser(user.id);

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
    return { closedSession: closed, finalBalance: finalBal };
  });

  void logEventFromContext(c, {
    eventType: 'casino.slots.session.closed',
    userId: user.id,
    avatarId: avatar.id,
    payload: {
      sessionId: closedSession.id,
      paytableId: closedSession.paytableId,
      spinCount: closedSession.spinCount,
      totalStaked: closedSession.totalStaked,
      totalWon: closedSession.totalWon,
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

// ─── GET /session/:id ─────────────────────────────────────────────────────

casinoSlotsRouter.get('/session/:id', requireAuth, async (c) => {
  const sessionId = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    throw new HTTPException(400, { message: 'invalid_session_id' });
  }
  const user = c.get('user')!;
  const row = await db.query.slotSessions.findFirst({
    where: eq(slotSessions.id, sessionId),
  });
  if (!row) {
    throw new HTTPException(404, { message: 'session_not_found' });
  }
  if (row.userId !== user.id) {
    throw new HTTPException(403, { message: 'session_not_owned' });
  }
  return c.json({ session: publicSession(row) }, 200);
});

// ─── GET /session/:id/spins ───────────────────────────────────────────────

casinoSlotsRouter.get('/session/:id/spins', requireAuth, async (c) => {
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
  const user = c.get('user')!;
  const session = await db.query.slotSessions.findFirst({
    where: eq(slotSessions.id, sessionId),
    columns: { id: true, userId: true },
  });
  if (!session) {
    throw new HTTPException(404, { message: 'session_not_found' });
  }
  if (session.userId !== user.id) {
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
        bet: r.bet,
        isFreeSpin: r.isFreeSpin,
        reels: r.reels,
        winningLines: r.winningLines,
        winAmount: r.winAmount,
        wildMultipliers: r.wildMultipliers,
        scatterPayout: r.scatterPayout,
        idempotencyKey: r.idempotencyKey,
        createdAt: r.createdAt.toISOString(),
      })),
    },
    200,
  );
});

// ─── GET /paytables/:id (public) ──────────────────────────────────────────

casinoSlotsRouter.get('/paytables/:id', async (c) => {
  const id = c.req.param('id');
  if (id !== 'classic-3x5' && id !== 'classic-3x5-bonus') {
    throw new HTTPException(404, { message: 'paytable_not_found' });
  }
  const response = buildPaytableResponse(id);
  return c.json(response, 200);
});

// ─── POST /verify (public; pure compute) ──────────────────────────────────

casinoSlotsRouter.post('/verify', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: 'invalid_input: ' + parsed.error.message,
    });
  }
  const input = parsed.data;
  const betBig = BigInt(input.bet);
  if (betBig <= 0n) {
    throw new HTTPException(400, { message: 'bet_must_be_positive' });
  }

  let result: SpinResult;
  try {
    result = runSpin({
      paytableId: input.paytableId,
      serverSeed: input.serverSeed,
      clientSeed: input.clientSeed,
      nonce: input.nonce,
      cursor: input.cursor,
      bet: betBig,
    });
  } catch (err) {
    throw new HTTPException(400, {
      message: `verify_failed: ${(err as Error).message}`,
    });
  }

  return c.json(serializeSpinResult(result), 200);
});

export default casinoSlotsRouter;
