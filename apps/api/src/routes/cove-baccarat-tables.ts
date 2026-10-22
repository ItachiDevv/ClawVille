/**
 * Cove Baccarat SHARED TABLES: HTTP surface (port of the June Slice 1 route,
 * d5ca47db2, with the defects of spec section 1.3 fixed).
 *
 * Spec: ~/.clawville-brain/plans/baccarat-shared-table-port-2026-10-22.md
 * sections 3.1-3.5. The money path (round clock, CAS deal, settle tx) lives in
 * `services/baccarat/baccarat-table-manager.ts`; this file only resolves the
 * subject, validates input with zod, and maps manager errors to HTTP codes.
 *
 * Mount: `app.route('/api/cove/baccarat/tables', coveBaccaratTableRouter)` in
 * index.ts, registered BEFORE the solo `/api/cove/baccarat` mount. Hono composes
 * matching handlers in registration order: with the solo router first, its
 * `use('*')` session middleware also runs on every table request (an extra
 * Lucia lookup). Routing resolves in either order on Hono 4.12 (the June note
 * that the solo `notFound` would 404 these paths does not hold); the route test
 * pins the order and the single middleware pass.
 *
 * Routes (external URL):
 *   GET    /api/cove/baccarat/tables              public lobby
 *   GET    /api/cove/baccarat/tables/:id          public state; soft subject fills `me`
 *   POST   /api/cove/baccarat/tables/:id/sit      human or agent
 *   POST   /api/cove/baccarat/tables/:id/leave    human or agent
 *   POST   /api/cove/baccarat/tables/:id/bet      human or agent (no vCLAW moves here)
 *   DELETE /api/cove/baccarat/tables/:id/bet      human or agent (cancel in the window)
 *
 * HUMAN/AGENT PARITY (Rule E5): every write resolves a Lucia human (active
 * avatar) OR an `X-Clawville-Agent-Session` agent (ledgerCapable + bound avatar,
 * then the PROTOCOL 85 TTL slide) to ONE avatar. The manager settles against
 * that avatarId with actorKind 'human' | 'agent'. There is NO guest tier on a
 * shared table: a guest ACCOUNT gets 403 `guest_not_allowed` from
 * `requireNonGuestUser` (defect D4: the old route let a guest bet its 100 SOFT
 * demo vCLAW as real), and a guest-owned agent is demoted by
 * `resolveAgentSession` (ledgerCapable false -> 403).
 *
 * PARITY note: human path: POST /api/cove/baccarat/tables/:id/sit|bet|leave with
 * the Lucia cookie; agent path: the same endpoints with X-Clawville-Agent-Session;
 * settlement binds to the resolved avatar (the Lucia user's active avatar, or
 * resolveAgentSession's bound avatar).
 *
 * Test fixtures: any request with `X-CV-Test-Fixture` gets 409
 * `fixture_not_supported_on_shared_tables` (BA-2). Table shoes never carry a
 * fixture run (DB check in migration 0087).
 */

import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, avatars } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { fingerprintMiddleware } from '../middleware/fingerprint';
import { resolveAgentSession, AGENT_SESSION_HEADER } from '../middleware/require-auth-or-agent';
import { isGuestUser, requireNonGuestUser } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import { slideAgentSessionTtl } from '../services/agent-session-ttl';
import { COVE_TEST_FIXTURE_HEADER } from '../services/cove-test-fixture';
import { InsufficientTokensError } from '../services/claw-token-ledger';
import { baccaratTableManager } from '../services/baccarat/baccarat-table-manager-singleton';
import {
  BACCARAT_TABLE_ERROR_STATUS,
  BACCARAT_TABLE_MAX_BET,
  BACCARAT_TABLE_MIN_BET,
  BaccaratTableError,
  type BaccaratTableErrorCode,
  type BaccaratTableSubject,
} from '../services/baccarat/baccarat-table-types';
import type { AppContext } from '../types';

export const coveBaccaratTableRouter = new Hono<AppContext>();

// BA-2 explicit refusal, before any DB work. "Any request" includes the GETs.
coveBaccaratTableRouter.use('*', async (c, next) => {
  if (c.req.header(COVE_TEST_FIXTURE_HEADER) !== undefined) {
    fail('fixture_not_supported_on_shared_tables');
  }
  return next();
});
coveBaccaratTableRouter.use('*', fingerprintMiddleware);
coveBaccaratTableRouter.use('*', sessionMiddleware);

// ── Input bounds ─────────────────────────────────────────────────────────────

/** Seat indexes the DB check admits (`seat_index < 8`); the manager refuses an
 * index at or above the table's `max_seats` (6 for house tables). */
const SEAT_INDEX_MAX = 7;
/** Idempotency-Key header bounds (Stripe convention; matches the solo route). */
const IDEMPOTENCY_KEY_MAX_LEN = 64;
const LOBBY_LIMIT_MAX = 50;

const idParamSchema = z.object({ id: z.string().uuid() });
const lobbyQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(LOBBY_LIMIT_MAX).optional() })
  .strict();
const sitSchema = z
  .object({ seatIndex: z.number().int().min(0).max(SEAT_INDEX_MAX).optional() })
  .strict();
const leaveSchema = z.object({}).strict();
const betSchema = z
  .object({
    /** The round this bet applies to (the table's `roundSeq` now). Not the coup
     * index: that resets to 0 at every shoe roll (defect D8). */
    roundSeq: z.number().int().nonnegative(),
    bet: z.enum(['player', 'banker', 'tie']),
    // Global bounds across all tiers (low 5..50, mid 20..200, high 50..500);
    // the manager enforces the table's own tier (400 `stake_out_of_bounds`).
    stake: z.number().int().min(BACCARAT_TABLE_MIN_BET).max(BACCARAT_TABLE_MAX_BET),
  })
  .strict();

// ── Per-subject bet rate limit ───────────────────────────────────────────────
// 120 bet writes (place or cancel) per minute per ledger subject. The key is the
// owner userId, so a human and the agent bound to the same avatar share ONE
// bucket (toggling cookie vs agent header cannot dodge it). Per process, reset
// on redeploy, like the solo route's coup bucket.
const BET_RATE_LIMIT = 120;
const BET_RATE_WINDOW_MS = 60_000;
const betRateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkBetRate(subject: BaccaratTableSubject): void {
  const key = `u:${subject.userId}`;
  const now = Date.now();
  if (betRateBuckets.size > 5_000) {
    for (const [k, v] of betRateBuckets) {
      if (now > v.resetAt) betRateBuckets.delete(k);
    }
  }
  const entry = betRateBuckets.get(key);
  if (!entry || now > entry.resetAt) {
    betRateBuckets.set(key, { count: 1, resetAt: now + BET_RATE_WINDOW_MS });
    return;
  }
  entry.count++;
  if (entry.count > BET_RATE_LIMIT) {
    fail('cove_baccarat_table_rate_limit');
  }
}

/** Test-only reset. */
export function __resetBaccaratTableRateLimits(): void {
  betRateBuckets.clear();
}

// ── Subject resolution ───────────────────────────────────────────────────────

type SubjectContext = {
  get(key: 'user'): { id: string } | null;
  req: { header(name: string): string | undefined };
};

async function activeAvatarId(userId: string): Promise<string | null> {
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
    columns: { id: true },
  });
  return avatar?.id ?? null;
}

/**
 * Strict resolver for a write (spec 3.2). Runs AFTER `requireNonGuestUser`, so a
 * Lucia user here is never a guest account. Lucia wins over an agent header.
 */
async function resolveSubject(c: SubjectContext): Promise<BaccaratTableSubject> {
  const user = c.get('user');
  if (user) {
    const avatarId = await activeAvatarId(user.id);
    if (!avatarId) {
      fail('active_avatar_required');
    }
    return { kind: 'user', userId: user.id, avatarId, agentId: null };
  }

  const agentSessionId = c.req.header(AGENT_SESSION_HEADER);
  if (agentSessionId) {
    const resolved = await resolveAgentSession(agentSessionId);
    if (!resolved) {
      fail('invalid_or_expired_agent_session');
    }
    // A session that did not prove avatar ownership (this also covers a
    // guest-owned agent) must not stake the avatar's real vCLAW. 403, never a
    // demotion to a demo tier.
    if (!resolved.ledgerCapable) {
      fail('agent_session_not_ledger_authorized');
    }
    if (!resolved.userId || !resolved.avatarId) {
      fail('agent_session_has_no_active_avatar');
    }
    // PROTOCOL 85: the bound session passed every gate; slide its 24 h TTL
    // (fire-and-forget, throttled, never throws).
    slideAgentSessionTtl(resolved.agentId, agentSessionId);
    return {
      kind: 'agent',
      userId: resolved.userId,
      avatarId: resolved.avatarId,
      agentId: resolved.agentId,
    };
  }

  fail('auth_required');
}

/**
 * Soft resolver for the public table read (spec 3.2 step 4): the same steps, but
 * every failure (guest account, no avatar, bad or non-ledger agent session)
 * returns null. A public read never answers 4xx for a credential problem.
 */
async function resolveSubjectSoft(c: SubjectContext): Promise<BaccaratTableSubject | null> {
  const user = c.get('user');
  if (user) {
    if (await isGuestUser(user.id)) return null;
    const avatarId = await activeAvatarId(user.id);
    if (!avatarId) return null;
    return { kind: 'user', userId: user.id, avatarId, agentId: null };
  }
  const agentSessionId = c.req.header(AGENT_SESSION_HEADER);
  if (!agentSessionId) return null;
  const resolved = await resolveAgentSession(agentSessionId);
  if (!resolved || !resolved.ledgerCapable || !resolved.userId || !resolved.avatarId) {
    return null;
  }
  // A seated agent polls this route every 1-2 s; keep its session alive.
  slideAgentSessionTtl(resolved.agentId, agentSessionId);
  return {
    kind: 'agent',
    userId: resolved.userId,
    avatarId: resolved.avatarId,
    agentId: resolved.agentId,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Throw a route-level wire error. The status comes from the ONE status map,
 * `BACCARAT_TABLE_ERROR_STATUS` (baccarat-table-types.ts). The message is the
 * code, optionally followed by `: <detail>` (zod issues).
 */
function fail(code: BaccaratTableErrorCode, detail?: string): never {
  const status = BACCARAT_TABLE_ERROR_STATUS[code] as ContentfulStatusCode;
  throw new HTTPException(status, { message: detail ? `${code}: ${detail}` : code });
}

function parseTableId(c: Context<AppContext>): string {
  const parsed = idParamSchema.safeParse({ id: c.req.param('id') });
  if (!parsed.success) fail('invalid_table_id');
  return parsed.data.id;
}

/** Accept and ignore `Idempotency-Key` (spec 3.1): the bet UPSERT is idempotent
 * per (table, round, seat) and the settle anchor is structural. Only the length
 * is checked; an empty header is a 400 too. */
function checkIdempotencyKey(c: Context<AppContext>): void {
  const key = c.req.header('Idempotency-Key');
  if (key !== undefined && (key.length < 1 || key.length > IDEMPOTENCY_KEY_MAX_LEN)) {
    fail('idempotency_key_must_be_1_to_64_chars');
  }
}

/** Read an optional JSON body: an empty body is `{}` (agents POST `/leave` and
 * `/sit` with no body). Malformed JSON returns null, which every strict body
 * schema rejects, so the caller answers with its own 400 code. */
async function readOptionalJson(c: Context<AppContext>): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function zodIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(body)'} ${i.message}`).join('; ');
}

/** Detail fields a manager error may carry on the wire (spec 3.3): `tableId` on
 * `already_seated_elsewhere`, `nextBettingOpensAt` on `betting_closed`,
 * `roundSeq` on `stale_round`. Only these keys pass, and only as scalars. */
const ERROR_DETAIL_KEYS = ['tableId', 'nextBettingOpensAt', 'roundSeq'] as const;

function errorDetails(err: BaccaratTableError): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const details = err.details;
  if (!details) return out;
  for (const key of ERROR_DETAIL_KEYS) {
    const v = details[key];
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Map a manager / ledger error to the wire (spec 3.3). The body shape matches
 * `index.ts` `onError` (`{ error: <code>, code: <status> }`). An error with
 * detail fields is answered here with `c.json`, because `onError` drops every
 * field except the message.
 */
export function mapTableError(c: Context<AppContext>, err: unknown): Response {
  if (err instanceof HTTPException) throw err;
  if (err instanceof BaccaratTableError) {
    // An internal invariant code (shoe_counter_drift, conservation_violation, ...)
    // is a 5xx: rethrow it unchanged so `onError` raises the critical alert.
    if (err.httpStatus >= 500) throw err;
    const status = err.httpStatus as ContentfulStatusCode;
    const details = errorDetails(err);
    if (Object.keys(details).length > 0) {
      return c.json({ error: err.code, code: status, ...details }, status);
    }
    throw new HTTPException(status, { message: err.code });
  }
  if (err instanceof InsufficientTokensError) {
    fail('insufficient_clawtokens');
  }
  throw err;
}

// ── GET / (public lobby) ─────────────────────────────────────────────────────
coveBaccaratTableRouter.get('/', async (c) => {
  const parsed = lobbyQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    fail('invalid_lobby_query', zodIssues(parsed.error));
  }
  const tables = await baccaratTableManager.listPublicTables(parsed.data.limit ?? LOBBY_LIMIT_MAX);
  return c.json({ ok: true, serverNow: Date.now(), tables });
});

// ── GET /:id (public table state; `me` for a resolved subject) ──────────────
// The manager never puts the open shoe's serverSeed or the cards of an
// unsettled round in this payload (spec 2.8). `me` is personal, so no-store.
coveBaccaratTableRouter.get('/:id', noStorePrivate, async (c) => {
  const tableId = parseTableId(c);
  const subject = await resolveSubjectSoft(c);
  try {
    const table = await baccaratTableManager.getTableState(tableId, subject);
    if (!table) fail('table_not_found');
    return c.json({ ok: true, table });
  } catch (err) {
    return mapTableError(c, err);
  }
});

// ── POST /:id/sit ────────────────────────────────────────────────────────────
coveBaccaratTableRouter.post('/:id/sit', requireNonGuestUser, async (c) => {
  const tableId = parseTableId(c);
  checkIdempotencyKey(c);
  const parsed = sitSchema.safeParse(await readOptionalJson(c));
  if (!parsed.success) fail('invalid_sit_body');
  const subject = await resolveSubject(c);
  try {
    const res = await baccaratTableManager.sitDown(tableId, subject, {
      seatIndex: parsed.data.seatIndex,
    });
    return c.json(
      {
        ok: true,
        seatIndex: res.seatIndex,
        alreadySeated: res.alreadySeated,
        roundSeq: res.roundSeq,
        bettingClosesAt: res.bettingClosesAt,
      },
      res.alreadySeated ? 200 : 201,
    );
  } catch (err) {
    return mapTableError(c, err);
  }
});

// ── POST /:id/leave ──────────────────────────────────────────────────────────
// Inside the open window the pending bet is cancelled; after the window closed
// the locked bet still settles and comes back as `lockedBet` (defect D3).
coveBaccaratTableRouter.post('/:id/leave', requireNonGuestUser, async (c) => {
  const tableId = parseTableId(c);
  checkIdempotencyKey(c);
  const parsed = leaveSchema.safeParse(await readOptionalJson(c));
  if (!parsed.success) fail('invalid_leave_body');
  const subject = await resolveSubject(c);
  try {
    const res = await baccaratTableManager.leaveTable(tableId, subject);
    return c.json({ ok: true, left: true as const, lockedBet: res.lockedBet ?? null });
  } catch (err) {
    return mapTableError(c, err);
  }
});

// ── POST /:id/bet ────────────────────────────────────────────────────────────
// Records (or replaces) this seat's PENDING bet for `roundSeq`. No vCLAW moves
// here: the stake debit and the gross payout credit happen together in the
// settle tx when the window closes (spec 5.3).
coveBaccaratTableRouter.post('/:id/bet', requireNonGuestUser, async (c) => {
  const tableId = parseTableId(c);
  checkIdempotencyKey(c);
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    fail('invalid_bet_body', 'body must be JSON');
  }
  const parsed = betSchema.safeParse(raw);
  if (!parsed.success) {
    fail('invalid_bet_body', zodIssues(parsed.error));
  }
  const subject = await resolveSubject(c);
  checkBetRate(subject);
  try {
    const res = await baccaratTableManager.placeBet(tableId, subject, {
      roundSeq: parsed.data.roundSeq,
      bet: parsed.data.bet,
      stake: parsed.data.stake,
    });
    return c.json({
      ok: true,
      roundSeq: res.roundSeq,
      seatIndex: res.seatIndex,
      bet: res.bet,
      stake: res.stake,
      bettingClosesAt: res.bettingClosesAt,
    });
  } catch (err) {
    return mapTableError(c, err);
  }
});

// ── DELETE /:id/bet ──────────────────────────────────────────────────────────
// Cancel this seat's pending bet while the window is open (and any autonomous
// next-round bet). No ledger call: no vCLAW moved at bet time.
coveBaccaratTableRouter.delete('/:id/bet', requireNonGuestUser, async (c) => {
  const tableId = parseTableId(c);
  checkIdempotencyKey(c);
  const subject = await resolveSubject(c);
  checkBetRate(subject);
  try {
    const res = await baccaratTableManager.cancelBet(tableId, subject);
    return c.json({ ok: true, cancelled: res.cancelled });
  } catch (err) {
    return mapTableError(c, err);
  }
});

export default coveBaccaratTableRouter;
