/**
 * Phase 6.7.0 — Cove cross-game history + per-event verifier.
 *
 * Mount: `app.route('/api/cove/history', coveHistoryRouter)` from index.ts.
 *
 * Surfaces:
 *
 *   GET  /                 (Lucia auth, owner-scoped) — paginated event list
 *   GET  /:eventId/verify  (owner OR admin)           — replay engine + hash check
 *
 * Owner-only scoping per plan §0 decision #4: a session's `userId` MUST
 * match the requesting user; ADMIN_USER_IDS bypass on the verify endpoint
 * for dispute support. There is no public history feed.
 *
 * Verifier dispatch (plan §0 #5 — server is fallback for disputes; the
 * canonical surface is client-side WebCrypto):
 *
 *   - 'slots'    → engine port `runSpin` replay + sha256(serverSeed) hash check
 *   - 'blackjack' | 'holdem' | 'baccarat' → 'engine-not-yet-shipped' stub
 *
 * Cursor pagination per plan §3 — base64 of `${createdAt.toISOString()}|${id}`.
 * The (createdAt, id) tuple is stable under ties (uuid PK breaks the tie); we
 * order by (createdAt DESC, id DESC) and use the `(userId, createdAt DESC)`
 * index from impl-schema.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'crypto';
import { z } from 'zod';
import { and, desc, eq, gt, lte, lt, or, sql } from 'drizzle-orm';
import { db, coveGameEvents, type CoveGameEvent } from '@clawville/database';
import { requireAuth, sessionMiddleware } from '../middleware/auth';
import { runSpin, type MachineSlug, type SpinResult } from '../services/slot-engine';
import type { AppContext } from '../types';

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

// ─── Schemas ──────────────────────────────────────────────────────────────

const historyQuerySchema = z
  .object({
    game: z.enum(GAME_TYPES).optional(),
    // 'win' === payout > betAmount (strict net-positive)
    // 'loss' === payout <= betAmount (loss OR break-even/push; treats push
    // as not-a-win to align with HistoryRow.tsx isWin badge logic which
    // uses pnl >= 0n for the badge but the FILTER intent is "show winners
    // only" — break-even rows still get the badge but are excluded from
    // the win-filtered view by design; see combined-audit #3).
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
  // uuid v4 sanity — same shape used in cove-slots /session/:id.
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new HTTPException(400, { message: 'invalid_cursor_id' });
  }
  return { createdAt, id };
}

// ─── Row serializer ───────────────────────────────────────────────────────
//
// bigint columns (betAmount, payout) come back as strings from drizzle's
// `bigint({ mode: 'bigint' })` or as `bigint` from `{ mode: 'number' }` —
// either way we stringify so Hono's `c.json` never sees a raw bigint
// (same rule cove-slots' serializer follows — see file docstring there).

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
    // Only emit the revealed seed once the shoe/session has closed (the
    // column is null until then — plan §0 decision #2 hash-chain reveal).
    revealedServerSeed: row.revealedServerSeed,
    clientSeed: row.clientSeed,
    nonce: row.nonce,
    txSignature: row.txSignature,
    engineVersion: row.engineVersion,
    createdAt: row.createdAt.toISOString(),
  };
}

// ─── GET / ─────────────────────────────────────────────────────────────────

coveHistoryRouter.get('/', requireAuth, async (c) => {
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
  const user = c.get('user')!;

  // Build `WHERE userId = ? [AND gameType = ?] [AND payout > betAmount]
  //        [AND (createdAt, id) < cursor]`
  // ordered by (createdAt DESC, id DESC). The (createdAt, id) tuple
  // strict-less comparison is the standard keyset-pagination shape; we
  // express it as `createdAt < c.createdAt OR (createdAt = c.createdAt AND id < c.id)`
  // so existing btree indexes are used. Fetch limit+1 to determine whether
  // a `nextCursor` is needed without a second COUNT round-trip.
  const filters = [eq(coveGameEvents.userId, user.id)];
  if (game) filters.push(eq(coveGameEvents.gameType, game));
  if (outcome === 'win') {
    // TEXT-stringified bigint columns; cast to numeric so PG compares
    // numerically not lexicographically ('10' < '9' as text).
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
    },
    200,
  );
});

// ─── GET /:eventId ────────────────────────────────────────────────────────
//
// Single-event fetch. Owner OR admin (mirrors /verify's gate so support can
// resolve disputes without impersonation). UI uses this to render the event
// header on the /cove/verify/[eventId] page before dispatching to the
// per-game verifier component.

coveHistoryRouter.get('/:eventId', requireAuth, async (c) => {
  const eventId = c.req.param('eventId');
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) {
    throw new HTTPException(400, { message: 'invalid_event_id' });
  }
  const user = c.get('user')!;

  const event = await db.query.coveGameEvents.findFirst({
    where: eq(coveGameEvents.id, eventId),
  });
  if (!event) {
    throw new HTTPException(404, { message: 'event_not_found' });
  }
  const isOwner = event.userId === user.id;
  const isAdmin = ADMIN_IDS.includes(user.id);
  if (!isOwner && !isAdmin) {
    throw new HTTPException(403, { message: 'event_not_owned' });
  }
  return c.json(serializeEvent(event), 200);
});

// ─── GET /:eventId/verify ─────────────────────────────────────────────────

coveHistoryRouter.get('/:eventId/verify', requireAuth, async (c) => {
  const eventId = c.req.param('eventId');
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) {
    throw new HTTPException(400, { message: 'invalid_event_id' });
  }
  const user = c.get('user')!;

  const event = await db.query.coveGameEvents.findFirst({
    where: eq(coveGameEvents.id, eventId),
  });
  if (!event) {
    throw new HTTPException(404, { message: 'event_not_found' });
  }

  // Owner OR admin (per plan §0 #4). Verify endpoint is reachable by an
  // ADMIN_USER_IDS member for any user's event so support can resolve
  // disputes without impersonation. List endpoint stays strictly owner-only.
  const isOwner = event.userId === user.id;
  const isAdmin = ADMIN_IDS.includes(user.id);
  if (!isOwner && !isAdmin) {
    throw new HTTPException(403, { message: 'event_not_owned' });
  }

  // Pre-reveal events (revealedServerSeed null) can't replay deterministically;
  // surface a structured locked verdict instead of trying engine replay.
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

  // sha256(revealedServerSeed) must equal the committed hash. This is the
  // commit-reveal contract — if the server published a hash at open time
  // and then revealed a DIFFERENT seed at close, this comparison fails
  // and the entire shoe's outcomes are repudiated.
  const computedHash = createHash('sha256').update(event.revealedServerSeed, 'utf8').digest('hex');
  const hashMatches = computedHash === event.serverSeedHash;

  if (event.gameType === 'slots') {
    let expected: SpinResult;
    try {
      // Cursor: slot_spins persists `cursorBefore` (pre-spin byte cursor).
      // The cove_game_events row's outcomeJson includes the slot reels +
      // winning lines; cursorBefore is recoverable from the source slot_spins
      // row by sessionId+nonce. For now, since slots' cove_game_events
      // mirror is written from the same transaction (impl-schema's plan), the
      // event row carries enough to replay via runSpin(nonce, cursor=0) for
      // backfilled rows — but the source of truth for cursor is the slot_spins
      // row. Resolve cursorBefore from slot_spins by (sessionId, nonce).
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

    // Compare engine output to stored outcome. The stored shape was
    // serialized at write time (winAmount as string per cove-slots'
    // serializeWinningLine convention); we re-serialize the freshly-computed
    // engine output the same way so the deep-equal works.
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

  // Other game types — engines + their verifier ports ship in 6.7.1/6.7.2/6.7.3.
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

// ─── Helpers (slots verifier) ────────────────────────────────────────────

/**
 * The slot_spins row persists `cursorBefore` (byte cursor consumed at the
 * START of the spin's HMAC stream). We need that value to replay deterministically;
 * cove_game_events.nonce is recorded but cursorBefore is not (the event row
 * stores the outcome, not the engine cursor state — that's slot_spins' job).
 * Resolve via (sessionId, nonce) lookup which is unique within a session.
 */
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

/**
 * Slot paytableId is not stored on cove_game_events directly (the table is
 * game-agnostic by design — plan §0 #1). Recover it from the parent
 * slot_sessions row via sessionId. If the lookup fails (deleted parent),
 * the engine replay would also fail; surface a typed error rather than
 * silently defaulting.
 */
function extractSlotPaytableId(event: CoveGameEvent): MachineSlug {
  // outcomeJson is the engine output shape; paytable lives on slot_sessions.
  // We do the lookup synchronously via a side-channel cached read — but
  // since the verify route is async we accept the cost. For the first cut
  // we read from outcomeJson if the writer included it; the schema/integration
  // contract (this file + impl-schema's writer) is the place to enforce that.
  const oj = event.outcomeJson as { paytableId?: string } | null;
  const slug = oj?.paytableId;
  if (slug === 'classic-3x5' || slug === 'classic-3x5-bonus') return slug;
  // Default fallback for slot rows written before the writer started embedding
  // paytableId (none today — this writer ships in the same diff — but the
  // backfill script may produce rows without it). Throwing here surfaces
  // the data-quality gap loud rather than silently picking the wrong table.
  throw new Error(
    `slots_paytableId_missing_on_event: extend impl-schema writer or backfill to include outcomeJson.paytableId`,
  );
}

export default coveHistoryRouter;
