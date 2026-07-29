/**
 * Poker CASH GAMES (P1) — ring-table routes.
 *
 * Mount: `app.route('/api/cove/poker/cash', coveCashPokerRouter)` from index.ts.
 *
 * Surfaces:
 *   GET  /tables                 (public)        — open PUBLIC tables only (never private)
 *   POST /tables                 (user OR agent) — create a table (house tier OR private custom)
 *   POST /tables/join-by-code    (user OR agent) — resolve a private join code → sit down
 *   POST /tables/:id/sit         (user OR agent) — sit down with the table buy-in (CT debit)
 *   POST /tables/:id/leave       (user OR agent) — cash out current stack (CT credit), between hands
 *   POST /tables/:id/action      (user OR agent) — submit ONE betting action
 *   GET  /tables/:id/last-settled (user OR agent) — entitled terminal hand truth
 *   GET  /tables/:id/state-for-agent (user OR agent) — own view + hole cards (NO leak)
 *   GET  /tables/:id             (public)        — public table state (config + seats + live snapshot)
 *
 * ── HUMAN/AGENT PARITY (Rule E5 — built in from the START) ───────────────────
 * Sit/join/leave/action are ECONOMY writes (CT debit/credit). The subject
 * resolver mirrors cove-poker-mtt's `resolveRegisterSubject`:
 *   - 'user'  — Lucia-authed human → its active avatar.
 *   - 'agent' — a connected/hosted agent playing AS ITSELF via
 *     `X-Clawville-Agent-Session` → its BOUND avatar (resolveAgentSession,
 *     ledgerCapable-gated). Settlement binds to that avatarId, NOT a guest.
 * There is deliberately NO guest tier (a CT ring table has no demo mode). An
 * unauthenticated economy write is 401. Parity by construction — both human and
 * agent reach the SAME write path with the SAME economic consequences.
 *
 * PARITY note (for the commit body): human path POST /tables/:id/sit with a
 * Lucia cookie; agent path POST /tables/:id/sit with X-Clawville-Agent-Session;
 * settlement (sit debit / leave credit / per-hand chip deltas) binds to the
 * resolved avatarId (human's active avatar OR agent's bound avatar).
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, avatars, pokerCashHands } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { requireNonGuestUser } from '../middleware/require-non-guest';
import { fingerprintMiddleware } from '../middleware/fingerprint';
import { resolveAgentSession } from '../middleware/require-auth-or-agent';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { noStorePrivate } from '../middleware/no-store';
import { cashTableManager } from '../services/poker/cash-table-manager-singleton';
import {
  CashTableError,
  type CashSubject,
  type CreateCashTableConfig,
} from '../services/poker/cash-table-manager';
import { HOUSE_TIER_STAKES } from '../services/poker/cash-house-config';
import { InsufficientTokensError } from '../services/claw-token-ledger';
import type { AppContext } from '../types';
import { createLastSettledHandler } from './cove-cash-last-settled-handler';
import {
  COVE_TEST_FIXTURE_HEADER,
  assertFixtureResourceHeader,
  validateLinkedFixtureArmAccess,
} from '../services/cove-test-fixture';

export const coveCashPokerRouter = new Hono<AppContext>();
coveCashPokerRouter.use('*', fingerprintMiddleware);
coveCashPokerRouter.use('*', sessionMiddleware);

const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';

// Per-IP create limiter + per-creator concurrent-open cap (anti-spam).
const createLimiter = createRateLimiter({ maxPerWindow: 10, windowMs: 60_000 });
const MAX_CONCURRENT_OPEN_TABLES_PER_CREATOR = 3;

// ── Fixed house stake tiers (locked) ─────────────────────────────────────────
// SINGLE SOURCE OF TRUTH: `HOUSE_TIER_STAKES` in `cash-house-config.ts` — the SAME
// map the house auto-scaler reads, so the human-facing create path and the scaler's
// auto-create path can never drift on a tier's stakes.
const HOUSE_TIERS = HOUSE_TIER_STAKES;

/**
 * Resolve the request subject for an economy write. Precedence: Lucia human →
 * agent session. NO guest tier. Mirrors cove-poker-mtt's resolver.
 */
async function resolveSubject(c: {
  get(key: string): unknown;
  req: { header(name: string): string | undefined };
}): Promise<CashSubject> {
  const user = c.get('user') as { id: string } | null;
  if (user) {
    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    });
    if (!avatar) {
      throw new HTTPException(403, {
        message: 'active_avatar_required: create an avatar before playing cash poker',
      });
    }
    return { kind: 'user', userId: user.id, avatarId: avatar.id, agentId: null };
  }

  const agentSessionId = c.req.header(AGENT_SESSION_HEADER);
  if (agentSessionId) {
    const resolved = await resolveAgentSession(agentSessionId);
    if (!resolved) {
      throw new HTTPException(401, { message: 'invalid_or_expired_agent_session' });
    }
    if (!resolved.ledgerCapable) {
      throw new HTTPException(403, { message: 'agent_session_not_ledger_authorized' });
    }
    if (!resolved.userId || !resolved.avatarId) {
      throw new HTTPException(403, {
        message: 'agent_session_has_no_active_avatar: connect an avatar before playing',
      });
    }
    return {
      kind: 'agent',
      userId: resolved.userId,
      avatarId: resolved.avatarId,
      agentId: resolved.agentId,
    };
  }

  throw new HTTPException(401, {
    message: 'auth_required: Lucia cookie or X-Clawville-Agent-Session header',
  });
}

/** Map a CashTableError / ledger error to a faithful HTTPException. */
function mapError(err: unknown): never {
  if (err instanceof HTTPException) throw err;
  if (err instanceof CashTableError) {
    throw new HTTPException(err.httpStatus as 400, { message: err.code });
  }
  if (err instanceof InsufficientTokensError) {
    throw new HTTPException(402, { message: 'insufficient_clawtokens_for_buyin' });
  }
  throw err;
}

const idParamSchema = z.object({ id: z.string().uuid() });

// ── Schemas ──────────────────────────────────────────────────────────────────

const createTableSchema = z.discriminatedUnion('source', [
  // PUBLIC tier table created BY A USER/AGENT: a FIXED tier; stakes are derived.
  // SCOPE LOCK (2026-06-22): the route ONLY ever mints `source='player-public'`.
  // `source='house'` is RESERVED for the house auto-scaler, which calls
  // `cashTableManager.createTable` DIRECTLY (never through this route). A house
  // table fills with house-bank-debited bots and is self-driven by the tick, so
  // letting a normal caller POST one would hand any user a house-bank-funded bot
  // table on demand (a house-bank exposure/drain vector). Dropping 'house' from
  // this enum is the hard gate: a user POST can never reach a house table.
  z.object({
    source: z.literal('player-public'),
    tierKey: z.enum(['low', 'mid', 'high']),
    maxSeats: z.number().int().min(2).max(8).default(8),
    seededAgentSlots: z.number().int().min(0).max(8).default(0),
  }),
  // Private table: custom stakes set by the host.
  z.object({
    source: z.literal('private'),
    buyInCt: z.number().int().positive(),
    smallBlindCt: z.number().int().positive(),
    bigBlindCt: z.number().int().positive(),
    maxSeats: z.number().int().min(2).max(8).default(8),
    seededAgentSlots: z.number().int().min(0).max(8).default(0),
  }),
]);

const joinByCodeSchema = z.object({ joinCode: z.string().trim().min(1).max(16) });

const sitSchema = z.object({ buyInCt: z.number().int().positive() });

const actionSchema = z.object({
  handNumber: z.number().int().nonnegative(),
  actionSeq: z.number().int().nonnegative(),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fold') }),
    z.object({ kind: z.literal('check') }),
    z.object({ kind: z.literal('call') }),
    z.object({ kind: z.literal('bet'), amount: z.number().int().positive() }),
    z.object({ kind: z.literal('raise'), amount: z.number().int().positive() }),
  ]),
});

// ── GET /tables (public — open public tables only) ───────────────────────────
coveCashPokerRouter.get('/tables', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
  const tables = await cashTableManager.listPublicTables(limit);
  return c.json({
    ok: true,
    tables: tables.map((t) => ({
      id: t.id,
      source: t.source,
      tierKey: t.tierKey,
      buyInCt: t.buyInCt,
      smallBlindCt: t.smallBlindCt,
      bigBlindCt: t.bigBlindCt,
      maxSeats: t.maxSeats,
      occupiedSeats: t.occupiedSeats,
      status: t.status,
    })),
  });
});

// ── POST /tables (create) ────────────────────────────────────────────────────
coveCashPokerRouter.post('/tables', requireNonGuestUser, async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!createLimiter.check(ip)) {
    throw new HTTPException(429, { message: 'rate_limited' });
  }

  let body: z.infer<typeof createTableSchema>;
  try {
    body = createTableSchema.parse(await c.req.json());
  } catch (err) {
    throw new HTTPException(400, {
      message:
        err instanceof z.ZodError
          ? `invalid_create_body: ${err.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`
          : 'invalid_create_body',
    });
  }

  const subject = await resolveSubject(c);

  // Per-creator concurrent-open cap — counts ALL open tables by this creator
  // (public AND private), so private tables can't bypass the cap. Single COUNT
  // query, not a full public-only list + N+1 active-seats fetch.
  const openByCreator = await cashTableManager.countOpenTablesByCreator(subject.avatarId);
  if (openByCreator >= MAX_CONCURRENT_OPEN_TABLES_PER_CREATOR) {
    throw new HTTPException(409, { message: 'too_many_open_tables' });
  }

  let config: CreateCashTableConfig;
  if (body.source === 'private') {
    config = {
      source: 'private',
      visibility: 'private',
      tierKey: null,
      buyInCt: body.buyInCt,
      smallBlindCt: body.smallBlindCt,
      bigBlindCt: body.bigBlindCt,
      maxSeats: body.maxSeats,
      seededAgentSlots: body.seededAgentSlots,
    };
  } else {
    const tier = HOUSE_TIERS[body.tierKey]!;
    config = {
      source: body.source,
      visibility: 'public',
      tierKey: body.tierKey,
      buyInCt: tier.buyInCt,
      smallBlindCt: tier.smallBlindCt,
      bigBlindCt: tier.bigBlindCt,
      maxSeats: body.maxSeats,
      seededAgentSlots: body.seededAgentSlots,
    };
  }

  try {
    const table = await cashTableManager.createTable(config, subject);
    return c.json(
      {
        ok: true,
        table: {
          id: table.id,
          source: table.source,
          visibility: table.visibility,
          tierKey: table.tierKey,
          buyInCt: table.buyInCt,
          smallBlindCt: table.smallBlindCt,
          bigBlindCt: table.bigBlindCt,
          maxSeats: table.maxSeats,
          joinCode: table.joinCode, // null for public; shown once to a private host
        },
      },
      201,
    );
  } catch (err) {
    mapError(err);
  }
});

// ── POST /tables/join-by-code ────────────────────────────────────────────────
coveCashPokerRouter.post('/tables/join-by-code', requireNonGuestUser, async (c) => {
  let body: z.infer<typeof joinByCodeSchema>;
  try {
    body = joinByCodeSchema.parse(await c.req.json());
  } catch {
    throw new HTTPException(400, { message: 'invalid_join_body' });
  }
  const subject = await resolveSubject(c);
  try {
    const res = await cashTableManager.joinByCode(body.joinCode, subject);
    return c.json({ ok: true, ...res }, res.alreadySeated ? 200 : 201);
  } catch (err) {
    mapError(err);
  }
});

// ── POST /tables/:id/sit ─────────────────────────────────────────────────────
coveCashPokerRouter.post('/tables/:id/sit', requireNonGuestUser, async (c) => {
  const parsed = idParamSchema.safeParse(c.req.param());
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_table_id' });
  let body: z.infer<typeof sitSchema>;
  try {
    body = sitSchema.parse(await c.req.json());
  } catch {
    throw new HTTPException(400, { message: 'invalid_sit_body' });
  }
  const subject = await resolveSubject(c);
  const fixtureHeader = c.req.header(COVE_TEST_FIXTURE_HEADER);
  try {
    const res = await cashTableManager.sitDown(
      parsed.data.id,
      subject,
      body.buyInCt,
      false,
      fixtureHeader
        ? { header: fixtureHeader, ownerAvatarId: subject.avatarId }
        : undefined,
    );
    return c.json({ ok: true, ...res }, res.alreadySeated ? 200 : 201);
  } catch (err) {
    mapError(err);
  }
});

// ── POST /tables/:id/leave ───────────────────────────────────────────────────
coveCashPokerRouter.post('/tables/:id/leave', requireNonGuestUser, async (c) => {
  const parsed = idParamSchema.safeParse(c.req.param());
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_table_id' });
  const subject = await resolveSubject(c);
  try {
    const res = await cashTableManager.leaveTable(parsed.data.id, subject);
    // queued:true → a mid-hand stand-up was accepted (cashed out at the next
    // between-hands boundary). 202 distinguishes it from an immediate cash-out.
    return c.json({ ok: true, ...res }, res.queued ? 202 : 200);
  } catch (err) {
    mapError(err);
  }
});

// ── POST /tables/:id/action ──────────────────────────────────────────────────
coveCashPokerRouter.post('/tables/:id/action', requireNonGuestUser, async (c) => {
  const parsed = idParamSchema.safeParse(c.req.param());
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_table_id' });
  let body: z.infer<typeof actionSchema>;
  try {
    body = actionSchema.parse(await c.req.json());
  } catch {
    throw new HTTPException(400, { message: 'invalid_action_body' });
  }
  const subject = await resolveSubject(c);
  const fixtureHeader = c.req.header(COVE_TEST_FIXTURE_HEADER);
  const hand = await db.query.pokerCashHands.findFirst({
    where: and(
      eq(pokerCashHands.tableId, parsed.data.id),
      eq(pokerCashHands.handNumber, body.handNumber),
    ),
  });
  if (fixtureHeader && !hand?.fixtureRunId) {
    throw new HTTPException(409, { message: 'fixture_resource_mismatch' });
  }
  assertFixtureResourceHeader(hand?.fixtureRunId, fixtureHeader);
  if (hand?.fixtureRunId) {
    const fixture = await validateLinkedFixtureArmAccess({
      header: fixtureHeader,
      ownerAvatarId: subject.avatarId,
      arm: 'holdem-cash',
      fixtureRunId: hand.fixtureRunId,
    });
    if (fixture?.runId !== hand.fixtureRunId) {
      throw new HTTPException(401, { message: 'invalid_test_fixture' });
    }
  }
  try {
    const result = await cashTableManager.submitAction({
      tableId: parsed.data.id,
      subject,
      handNumber: body.handNumber,
      actionSeq: body.actionSeq,
      action: body.action,
    });
    if (!result.ok) {
      const reason = result.reason ?? 'illegal_action';
      const status409 = new Set([
        'no_such_table',
        'not_your_turn',
        'hand_over',
        'not_seated',
        'stale_hand_number',
      ]);
      throw new HTTPException((status409.has(reason) ? 409 : 422) as 409, { message: reason });
    }
    return c.json({
      ok: true,
      advancedStreet: result.advancedStreet ?? false,
      handComplete: result.handComplete ?? false,
      nextToActAvatarId: result.nextToActAvatarId ?? null,
    });
  } catch (err) {
    mapError(err);
  }
});

// ── GET /tables/:id/last-settled (historical participant only) ─────────────
const lastSettledHandler = createLastSettledHandler({
  resolveRequestSubject: (c) => resolveSubject(c),
  getLastSettledHand: (...args) => cashTableManager.getLastSettledHand(...args),
});

coveCashPokerRouter.get(
  '/tables/:id/last-settled',
  requireNonGuestUser,
  lastSettledHandler,
);

// ── GET /tables/:id/state-for-agent (own view + hole cards; no leak) ──────────
coveCashPokerRouter.get('/tables/:id/state-for-agent', noStorePrivate, async (c) => {
  const parsed = idParamSchema.safeParse(c.req.param());
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_table_id' });
  const subject = await resolveSubject(c);
  const view = cashTableManager.getSeatViewForAgent(parsed.data.id, subject.avatarId);
  if (!view) throw new HTTPException(409, { message: 'not_seated_or_no_live_hand' });
  return c.json({ ok: true, view });
});

// ── GET /tables/:id (public table state) ─────────────────────────────────────
coveCashPokerRouter.get('/tables/:id', async (c) => {
  const parsed = idParamSchema.safeParse(c.req.param());
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_table_id' });
  const state = await cashTableManager.getTableState(parsed.data.id);
  if (!state) throw new HTTPException(404, { message: 'table_not_found' });
  // PUBLIC: never expose join codes here (private tables are join-code-gated).
  return c.json({
    ok: true,
    table: {
      id: state.table.id,
      source: state.table.source,
      visibility: state.table.visibility,
      tierKey: state.table.tierKey,
      buyInCt: state.table.buyInCt,
      smallBlindCt: state.table.smallBlindCt,
      bigBlindCt: state.table.bigBlindCt,
      maxSeats: state.table.maxSeats,
      status: state.table.status,
    },
    seats: state.seats,
    live: state.live, // public snapshot — NO hole cards (compile-enforced)
  });
});
