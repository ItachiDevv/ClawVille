/**
 * Phase 6.7.0 — Cove cross-game history + per-event verifier.
 * Phase 6.7.5 — guest history support. Read paths no longer require auth;
 * unauthenticated callers are scoped by `guest_fp_hash` (the salted server-side
 * hash from `fingerprintMiddleware`). Authenticated callers are scoped by
 * `user_id` exactly as before. Claim endpoint `POST /claim` (Lucia-authed)
 * migrates a guest's rows to their new user on signup.
 *
 * Mount: `app.route('/api/cove/history', coveHistoryRouter)` from index.ts.
 *
 * Surfaces:
 *
 *   GET  /                 (open — guest or user) — paginated event list
 *   GET  /:eventId         (open — guest or user) — single event
 *   GET  /:eventId/verify  (open — guest or user, owner or admin) — replay
 *   POST /claim            (Lucia auth required) — migrate guest rows → user
 *
 * Owner-only scoping per plan §0 decision #4: a row's subject (user_id OR
 * guest_fp_hash) MUST match the requester's subject; ADMIN_USER_IDS bypass
 * on /:eventId + /verify for dispute support. There is no public feed.
 *
 * Adversarial note (plan §6 adversarial #2): an authed user can technically
 * claim another browser's guest rows if they obtain that browser's raw
 * `X-CV-Fingerprint` value (stored same-origin in localStorage as `cv-fp`).
 * This is the same risk surface as session hijack. Server enforces the
 * salted hash; the raw fp never leaves the requesting browser unless the
 * attacker has same-origin JS access.
 *
 * Verifier dispatch (plan §0 #5 — server is fallback for disputes; the
 * canonical surface is client-side WebCrypto):
 *
 *   - 'slots'    → engine port `runSpin` replay + sha256(serverSeed) hash check
 *   - 'blackjack'→ `replayShoeUpToHand` (shared-shoe no-replacement replay)
 *   - 'holdem'   → `playHoldemHand` (per-hand fresh-deck replay from the table's
 *                  recorded human actions + buttonSeat + startingStack)
 *   - 'baccarat' → `replayShoeUpToCoup` (shared-shoe no-replacement replay from the
 *                  shoe's recorded per-coup bet/stake; target coup = event.nonce)
 *
 * Cursor pagination per plan §3 — base64 of `${createdAt.toISOString()}|${id}`.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'crypto';
import { z } from 'zod';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  db,
  coveGameEvents,
  slotSessions,
  type CoveGameEvent,
} from '@clawville/database';
import { requireAuth, sessionMiddleware } from '../middleware/auth';
import { runSpin, type MachineSlug, type SpinResult } from '../services/slot-engine';
import {
  replayShoeUpToHand,
  serializeHandResult,
  type HandScript,
} from '../services/blackjack-engine';
import {
  playHand as playHoldemHand,
  serializeHoldemHand,
  type HoldemActionRecord,
} from '../services/holdem-engine';
import {
  replayShoeUpToCoup,
  serializeCoupResult,
  type BaccaratBet,
} from '../services/baccarat-engine';
import {
  blackjackOutcomesMatch,
  holdemOutcomesMatch,
  baccaratOutcomesMatch,
} from '../services/cove-verify-compat';
import { blackjackHands, holdemHands, baccaratCoups } from '@clawville/database';
import type { AppContext, AuthenticatedContext } from '../types';
import type { Context } from 'hono';

export const coveHistoryRouter = new Hono<AppContext>();
coveHistoryRouter.use('*', sessionMiddleware);

// ─── Constants ────────────────────────────────────────────────────────────

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

const GAME_TYPES = ['slots', 'blackjack', 'holdem', 'baccarat'] as const;
type GameType = (typeof GAME_TYPES)[number];

const ADMIN_IDS = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ─── Subject resolution ───────────────────────────────────────────────────
//
// Every read path resolves the caller's "subject" — either a logged-in user
// (scope by user_id) or a guest (scope by guest_fp_hash). fingerprintMiddleware
// guarantees fpHash is non-empty on every request, so the guest path always
// has a non-null scope key.

type Subject =
  | { kind: 'user'; id: string }
  | { kind: 'guest'; fp: string };

function resolveSubject(c: Context<AppContext>): Subject {
  const user = c.get('user');
  if (user) return { kind: 'user', id: user.id };
  const fp = c.get('fpHash');
  // fingerprintMiddleware guarantees this; defensive throw keeps the type
  // narrowed and surfaces a misconfiguration loudly rather than silently
  // letting NULL-keyed rows through.
  if (!fp) {
    throw new HTTPException(500, { message: 'fp_hash_missing_from_context' });
  }
  return { kind: 'guest', fp };
}

// ─── Schemas ──────────────────────────────────────────────────────────────

const historyQuerySchema = z
  .object({
    game: z.enum(GAME_TYPES).optional(),
    outcome: z.enum(['win', 'loss']).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(HISTORY_MAX_LIMIT)
      .default(HISTORY_DEFAULT_LIMIT),
    cursor: z.string().optional(),
  })
  .strict();

// ─── Cursor helpers ───────────────────────────────────────────────────────

interface DecodedCursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): DecodedCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new HTTPException(400, { message: 'invalid_cursor_encoding' });
  }
  const pipe = decoded.indexOf('|');
  if (pipe < 0) {
    throw new HTTPException(400, { message: 'invalid_cursor_format' });
  }
  const iso = decoded.slice(0, pipe);
  const id = decoded.slice(pipe + 1);
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) {
    throw new HTTPException(400, { message: 'invalid_cursor_timestamp' });
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new HTTPException(400, { message: 'invalid_cursor_id' });
  }
  return { createdAt, id };
}

// ─── Row serializer ───────────────────────────────────────────────────────

function serializeEvent(row: CoveGameEvent) {
  return {
    id: row.id,
    userId: row.userId,
    gameType: row.gameType,
    sessionId: row.sessionId,
    shoeId: row.shoeId,
    betAmount: row.betAmount.toString(),
    payout: row.payout.toString(),
    outcomeJson: row.outcomeJson,
    serverSeedHash: row.serverSeedHash,
    revealedServerSeed: row.revealedServerSeed,
    clientSeed: row.clientSeed,
    nonce: row.nonce,
    txSignature: row.txSignature,
    engineVersion: row.engineVersion,
    createdAt: row.createdAt.toISOString(),
  };
}

// ─── Owner check ──────────────────────────────────────────────────────────

function eventBelongsToSubject(event: CoveGameEvent, subject: Subject): boolean {
  if (subject.kind === 'user') {
    return event.userId === subject.id;
  }
  return event.guestFpHash === subject.fp;
}

// ─── GET / ─────────────────────────────────────────────────────────────────

coveHistoryRouter.get('/', async (c) => {
  const queryParsed = historyQuerySchema.safeParse({
    game: c.req.query('game'),
    outcome: c.req.query('outcome'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!queryParsed.success) {
    throw new HTTPException(400, {
      message: 'invalid_query: ' + queryParsed.error.message,
    });
  }
  const { game, outcome, limit, cursor } = queryParsed.data;
  const subject = resolveSubject(c);

  // Scope filter — user_id for authed callers, guest_fp_hash for guests.
  // Each branch uses its own partial index so a guest read never falls back
  // to a seq-scan over the user-rows portion of the table.
  const subjectFilter =
    subject.kind === 'user'
      ? eq(coveGameEvents.userId, subject.id)
      : eq(coveGameEvents.guestFpHash, subject.fp);

  const filters = [subjectFilter];
  if (game) filters.push(eq(coveGameEvents.gameType, game));
  if (outcome === 'win') {
    filters.push(sql`(${coveGameEvents.payout}::numeric > ${coveGameEvents.betAmount}::numeric)`);
  } else if (outcome === 'loss') {
    filters.push(sql`(${coveGameEvents.payout}::numeric <= ${coveGameEvents.betAmount}::numeric)`);
  }
  if (cursor) {
    const dec = decodeCursor(cursor);
    const tupleLess = or(
      lt(coveGameEvents.createdAt, dec.createdAt),
      and(eq(coveGameEvents.createdAt, dec.createdAt), lt(coveGameEvents.id, dec.id)),
    );
    if (tupleLess) filters.push(tupleLess);
  }

  const rows = await db
    .select()
    .from(coveGameEvents)
    .where(and(...filters))
    .orderBy(desc(coveGameEvents.createdAt), desc(coveGameEvents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return c.json(
    {
      events: page.map(serializeEvent),
      nextCursor,
      subject: subject.kind,
    },
    200,
  );
});

// ─── GET /:eventId ────────────────────────────────────────────────────────

coveHistoryRouter.get('/:eventId', async (c) => {
  const eventId = c.req.param('eventId');
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) {
    throw new HTTPException(400, { message: 'invalid_event_id' });
  }
  const subject = resolveSubject(c);

  const event = await db.query.coveGameEvents.findFirst({
    where: eq(coveGameEvents.id, eventId),
  });
  if (!event) {
    throw new HTTPException(404, { message: 'event_not_found' });
  }
  const isOwner = eventBelongsToSubject(event, subject);
  const isAdmin = subject.kind === 'user' && ADMIN_IDS.includes(subject.id);
  if (!isOwner && !isAdmin) {
    throw new HTTPException(403, { message: 'event_not_owned' });
  }
  return c.json(serializeEvent(event), 200);
});

// ─── GET /:eventId/verify ─────────────────────────────────────────────────

coveHistoryRouter.get('/:eventId/verify', async (c) => {
  const eventId = c.req.param('eventId');
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) {
    throw new HTTPException(400, { message: 'invalid_event_id' });
  }
  const subject = resolveSubject(c);

  const event = await db.query.coveGameEvents.findFirst({
    where: eq(coveGameEvents.id, eventId),
  });
  if (!event) {
    throw new HTTPException(404, { message: 'event_not_found' });
  }

  const isOwner = eventBelongsToSubject(event, subject);
  const isAdmin = subject.kind === 'user' && ADMIN_IDS.includes(subject.id);
  if (!isOwner && !isAdmin) {
    throw new HTTPException(403, { message: 'event_not_owned' });
  }

  if (!event.revealedServerSeed) {
    return c.json(
      {
        verified: null,
        reason: 'shoe-not-yet-closed',
        expected: null,
        stored: event.outcomeJson,
        hashMatches: null,
      },
      200,
    );
  }

  const computedHash = createHash('sha256').update(event.revealedServerSeed, 'utf8').digest('hex');
  const hashMatches = computedHash === event.serverSeedHash;

  if (event.gameType === 'slots') {
    let expected: SpinResult;
    try {
      const slotSpinCursor = await resolveSlotSpinCursor(event.sessionId, event.nonce);
      expected = runSpin({
        paytableId: extractSlotPaytableId(event),
        serverSeed: event.revealedServerSeed,
        clientSeed: event.clientSeed,
        nonce: event.nonce,
        cursor: slotSpinCursor,
        predict: BigInt(event.betAmount.toString()),
      });
    } catch (err) {
      return c.json(
        {
          verified: false,
          reason: `engine_replay_failed: ${(err as Error).message}`,
          expected: null,
          stored: event.outcomeJson,
          hashMatches,
        },
        200,
      );
    }

    const expectedSerialized = {
      reels: expected.reels,
      winningLines: expected.winningLines.map((l) => ({
        ...l,
        winAmount: l.winAmount.toString(),
      })),
      winAmount: expected.winAmount.toString(),
    };
    const stored = event.outcomeJson as {
      reels: SpinResult['reels'];
      winningLines: Array<{ winAmount: string }>;
      winAmount: string;
    };
    const reelsMatch = JSON.stringify(expectedSerialized.reels) === JSON.stringify(stored.reels);
    const winAmountMatches = expectedSerialized.winAmount === stored.winAmount;
    const linesMatch =
      JSON.stringify(expectedSerialized.winningLines) === JSON.stringify(stored.winningLines);
    const verified = hashMatches && reelsMatch && winAmountMatches && linesMatch;

    return c.json(
      {
        verified,
        expected: expectedSerialized,
        stored,
        hashMatches,
      },
      200,
    );
  }

  if (event.gameType === 'blackjack') {
    // Blackjack draws are no-replacement against a shared shoe, so replaying a
    // single hand requires the shoe state at the start of that hand. We
    // reconstruct it by loading every settled hand's recorded script for the
    // shoe (sessionId === shoeId) and replaying from nonce 0 via
    // `replayShoeUpToHand`. The target hand is `event.nonce` (= handIndex).
    let expectedSerialized: ReturnType<typeof serializeHandResult>;
    try {
      const handRows = await db
        .select()
        .from(blackjackHands)
        .where(
          and(eq(blackjackHands.shoeId, event.sessionId), eq(blackjackHands.status, 'settled')),
        )
        .orderBy(blackjackHands.handIndex);

      const scripts: Array<{ bet: bigint; script: HandScript }> = [];
      for (let n = 0; n <= event.nonce; n++) {
        const row = handRows.find((h) => h.handIndex === n);
        if (!row) {
          throw new Error(`blackjack_hand_missing_for_replay: shoeId=${event.sessionId} handIndex=${n}`);
        }
        const s = row.script as HandScript;
        scripts.push({
          bet: BigInt(row.bet),
          script: { hands: s.hands, didSplit: s.didSplit, tookInsurance: row.tookInsurance },
        });
      }

      const replayed = replayShoeUpToHand({
        serverSeed: event.revealedServerSeed,
        clientSeed: event.clientSeed,
        targetNonce: event.nonce,
        scripts,
      });
      const targetRow = handRows.find((h) => h.handIndex === event.nonce)!;
      expectedSerialized = serializeHandResult(replayed, {
        cursorBefore: targetRow.cursorBefore,
        dealtBefore: targetRow.dealtBefore,
        nonce: event.nonce,
      });
    } catch (err) {
      return c.json(
        {
          verified: false,
          reason: `engine_replay_failed: ${(err as Error).message}`,
          expected: null,
          stored: event.outcomeJson,
          hashMatches,
        },
        200,
      );
    }

    const stored = event.outcomeJson as Record<string, unknown>;
    // Compare the engine-derived outcome to the stored one. cursorBefore/
    // dealtBefore are persisted-only metadata (not re-derived by a single-hand
    // replay). `blackjackOutcomesMatch` also tolerates a PRE-RAKE stored row
    // (no rake/rakedPayout/rakedNet keys) by comparing only the gross fields the
    // stored row carries — otherwise every fair pre-fix net-win would falsely
    // report verified:false (economy-fix back-compat, 2026-05-29).
    const verified =
      hashMatches &&
      blackjackOutcomesMatch(
        expectedSerialized as unknown as Record<string, unknown>,
        stored,
      );

    return c.json(
      {
        verified,
        expected: expectedSerialized,
        stored,
        hashMatches,
      },
      200,
    );
  }

  if (event.gameType === 'holdem') {
    // Hold'em hands each shuffle a FRESH 52-card deck from (serverSeed,
    // clientSeed, nonce=handIndex, cursor=0) — NO shared shoe, so replaying a
    // single hand needs only the seed + the hand row's buttonSeat +
    // startingStack + recorded human actions. The target hand is event.nonce
    // (= handIndex) within event.sessionId (= tableId).
    let expectedSerialized: ReturnType<typeof serializeHoldemHand>;
    try {
      const handRow = (
        await db
          .select()
          .from(holdemHands)
          .where(and(eq(holdemHands.tableId, event.sessionId), eq(holdemHands.handIndex, event.nonce)))
          .limit(1)
      )[0];
      if (!handRow) {
        throw new Error(
          `holdem_hand_missing_for_replay: tableId=${event.sessionId} handIndex=${event.nonce}`,
        );
      }
      const actions = (handRow.actions as HoldemActionRecord[]) ?? [];
      const replayed = playHoldemHand({
        serverSeed: event.revealedServerSeed,
        clientSeed: event.clientSeed,
        nonce: event.nonce,
        buttonSeat: handRow.buttonSeat,
        humanStartingStack: BigInt(handRow.startingStack),
        botStartingStack: 100n,
        humanActions: actions,
      });
      expectedSerialized = serializeHoldemHand(replayed);
    } catch (err) {
      return c.json(
        {
          verified: false,
          reason: `engine_replay_failed: ${(err as Error).message}`,
          expected: null,
          stored: event.outcomeJson,
          hashMatches,
        },
        200,
      );
    }

    const stored = event.outcomeJson as Record<string, unknown>;
    // `holdemOutcomesMatch` tolerates a PRE-RAKE stored row (no rake/
    // humanRakedPayout/humanRakedNet keys) by comparing only the gross fields
    // the stored row carries — otherwise every fair pre-fix hand (even a rake=0
    // fold) would falsely report verified:false (economy-fix back-compat,
    // 2026-05-29). A post-fix row keeps all keys and compares strictly.
    const verified =
      hashMatches &&
      holdemOutcomesMatch(
        expectedSerialized as unknown as Record<string, unknown>,
        stored,
      );

    return c.json(
      {
        verified,
        expected: expectedSerialized,
        stored,
        hashMatches,
      },
      200,
    );
  }

  if (event.gameType === 'baccarat') {
    // Baccarat draws are no-replacement against a shared 8-deck shoe, so replaying
    // a single coup requires the shoe state at the start of that coup. We
    // reconstruct it by loading every settled coup's recorded (bet, stake) for the
    // shoe (sessionId === shoeId) and replaying from nonce 0 via
    // `replayShoeUpToCoup`. The target coup is `event.nonce` (= coupIndex).
    let expectedSerialized: ReturnType<typeof serializeCoupResult>;
    try {
      const coupRows = await db
        .select()
        .from(baccaratCoups)
        .where(
          and(eq(baccaratCoups.shoeId, event.sessionId), eq(baccaratCoups.status, 'settled')),
        )
        .orderBy(baccaratCoups.coupIndex);

      const coups: Array<{ bet: BaccaratBet; stake: bigint }> = [];
      for (let n = 0; n <= event.nonce; n++) {
        const row = coupRows.find((coup) => coup.coupIndex === n);
        if (!row) {
          throw new Error(
            `baccarat_coup_missing_for_replay: shoeId=${event.sessionId} coupIndex=${n}`,
          );
        }
        coups.push({ bet: row.bet as BaccaratBet, stake: BigInt(row.stake) });
      }

      const replayed = replayShoeUpToCoup({
        serverSeed: event.revealedServerSeed,
        clientSeed: event.clientSeed,
        targetNonce: event.nonce,
        coups,
      });
      const targetRow = coupRows.find((coup) => coup.coupIndex === event.nonce)!;
      expectedSerialized = serializeCoupResult(replayed, {
        cursorBefore: targetRow.cursorBefore,
        dealtBefore: targetRow.dealtBefore,
        nonce: event.nonce,
      });
    } catch (err) {
      return c.json(
        {
          verified: false,
          reason: `engine_replay_failed: ${(err as Error).message}`,
          expected: null,
          stored: event.outcomeJson,
          hashMatches,
        },
        200,
      );
    }

    const stored = event.outcomeJson as Record<string, unknown>;
    // Compare the engine-derived outcome to the stored one. cursorBefore/
    // dealtBefore are persisted-only metadata (excluded). `baccaratOutcomesMatch`
    // compares every non-monetary field strictly, but accepts the stored
    // payout/net/commission if they match EITHER the NEW commission-rounding
    // formula (the replayed `expected`) OR the OLD formula recomputed from the
    // coup's own bet/stake/winner — so a fair PRE-FIX banker win (which stored
    // different payout/commission values) isn't falsely reported verified:false
    // (economy-fix back-compat, 2026-05-29).
    const verified =
      hashMatches &&
      baccaratOutcomesMatch(
        expectedSerialized as unknown as Record<string, unknown>,
        stored,
      );

    return c.json(
      {
        verified,
        expected: expectedSerialized,
        stored,
        hashMatches,
      },
      200,
    );
  }

  return c.json(
    {
      verified: null,
      reason: 'engine-not-yet-shipped',
      expected: null,
      stored: event.outcomeJson,
      hashMatches,
    },
    200,
  );
});

// ─── POST /claim ──────────────────────────────────────────────────────────
//
// Phase 6.7.5 — on signup, migrate the caller's guest-stamped history rows
// to their new user_id. Idempotent: a second call for the same fp finds
// no remaining `WHERE guest_fp_hash = $fp AND user_id IS NULL` rows.
//
// Wraps both updates in a single transaction so the verifier's
// `slot_spins` lookup (via cove_history /verify → resolveSlotSpinCursor →
// slot_sessions parent) stays consistent — parent + child rows are claimed
// atomically. No CT or wallet writes here (per plan §0 #6 — demo balances
// don't convert).
//
// Rate limit: protected by the global Hono rate-limit middleware mount in
// index.ts; the claim is harmless for unrelated users (UPDATE filtered by
// fp_hash) and idempotent for the same fp, so per-route throttle isn't
// strictly required.

coveHistoryRouter.post('/claim', requireAuth, async (c) => {
  const authedCtx = c as unknown as Context<AuthenticatedContext>;
  const user = authedCtx.get('user');
  const fp = c.get('fpHash');
  if (!fp) {
    throw new HTTPException(500, { message: 'fp_hash_missing_from_context' });
  }

  const result = await db.transaction(async (tx) => {
    const claimedEvents = await tx
      .update(coveGameEvents)
      .set({
        userId: user.id,
        // Null the guest_fp_hash to honor the schema check constraint
        // `(user_id IS NOT NULL) <> (guest_fp_hash IS NOT NULL)`.
        guestFpHash: null,
      })
      .where(and(eq(coveGameEvents.guestFpHash, fp), isNull(coveGameEvents.userId)))
      .returning({ id: coveGameEvents.id });

    const claimedSessions = await tx
      .update(slotSessions)
      .set({
        userId: user.id,
        guestFpHash: null,
      })
      .where(and(eq(slotSessions.guestFpHash, fp), isNull(slotSessions.userId)))
      .returning({ id: slotSessions.id });

    return {
      claimed: claimedEvents.length,
      eventIds: claimedEvents.map((r) => r.id),
      sessionsClaimed: claimedSessions.length,
    };
  });

  return c.json(result, 200);
});

// ─── Helpers (slots verifier) ────────────────────────────────────────────

async function resolveSlotSpinCursor(sessionId: string, nonce: number): Promise<number> {
  const rows = await db.execute<{ cursor_before: number | string }>(
    sql`SELECT cursor_before FROM slot_spins
        WHERE session_id = ${sessionId} AND nonce = ${nonce}
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`source_spin_not_found: sessionId=${sessionId} nonce=${nonce}`);
  }
  return typeof row.cursor_before === 'string' ? Number(row.cursor_before) : row.cursor_before;
}

function extractSlotPaytableId(event: CoveGameEvent): MachineSlug {
  const oj = event.outcomeJson as { paytableId?: string } | null;
  const slug = oj?.paytableId;
  if (slug === 'classic-3x5' || slug === 'classic-3x5-bonus') return slug;
  throw new Error(
    `slots_paytableId_missing_on_event: extend impl-schema writer or backfill to include outcomeJson.paytableId`,
  );
}

export default coveHistoryRouter;
