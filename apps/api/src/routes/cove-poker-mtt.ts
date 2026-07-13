/**
 * Poker MTT (P3) — minimal registration + status route.
 *
 * Mount: `app.route('/api/cove/poker/mtt', covePokerMttRouter)` from index.ts.
 *
 * Surfaces (full lobby UI is a later phase — this is the backend seam):
 *   POST /:id/register        (user OR agent) — buy in (real CT debit), idempotent
 *   GET  /:id/connection      (user OR agent) — the seated subject's WS ticket
 *   GET  /:id                 (public)        — tournament status + standings
 *   POST /action              (user OR agent) — submit ONE betting action (P5;
 *     SOCKET-LESS path, SAME settlement as the WS hub; controlled-mode suppressed)
 *   GET  /:id/state-for-agent (user OR agent) — the subject's OWN poll view (P5;
 *     public table + own hole cards + legalActions + isYourTurn; no leak)
 *   GET  /:id/advice          (user OR agent) — ADVISOR MODE (P5; non-staking
 *     recommended action; allowed even when the avatar is human-controlled)
 *
 * ── HUMAN/AGENT PARITY (Rule E5 — built in from the START) ───────────────────
 * Registration is an ECONOMY WRITE (it debits real CT). The subject resolver
 * therefore mirrors cove-blackjack's agent-capable `getSubject`:
 *   - 'user'  — Lucia-authed human → its active avatar.
 *   - 'agent' — a connected/hosted agent playing AS ITSELF via the
 *     `X-Clawville-Agent-Session` header → its BOUND avatar (resolveAgentSession,
 *     ledgerCapable-gated). Settlement + placement + leaderboard credit bind to
 *     `identity.avatarId`/`agentId`, NOT a guest fallback.
 * There is deliberately NO guest tier here: a CT buy-in tournament has no demo
 * mode (a guest can't earn/lose real CT or hold a leaderboard placement). An
 * unauthenticated request is 401. This is parity by construction — both human
 * and agent reach the SAME write path with the SAME economic + leaderboard
 * consequences.
 *
 * PARITY note (for the commit body): human path POST /:id/register with a Lucia
 * cookie; agent path POST /:id/register with X-Clawville-Agent-Session; settlement
 * binds to the resolved avatarId (human's active avatar OR agent's bound avatar).
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, avatars } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { requireNonGuestUser } from '../middleware/require-non-guest';
import { fingerprintMiddleware } from '../middleware/fingerprint';
import { adminOnly } from '../middleware/admin-only';
import { resolveAgentSession } from '../middleware/require-auth-or-agent';
import { noStorePrivate } from '../middleware/no-store';
import {
  tournamentManager,
  TournamentError,
  type RegisterSubject,
  type CreateTournamentConfig,
} from '../services/poker/tournament-manager';
import { InsufficientTokensError } from '../services/claw-token-ledger';
import type { AppContext } from '../types';

export const covePokerMttRouter = new Hono<AppContext>();
// fingerprintMiddleware runs here (not only app-wide) so the AGENT-GATEWAY
// in-process sub-request path — which forwards `X-CV-Fingerprint` but bypasses the
// app-level middleware chain — still resolves a real (fpHash, ipPrefixHash). For a
// HUMAN hitting the mounted route the app-level fingerprintMiddleware already ran;
// re-running here is idempotent (it just recomputes + re-sets the same two context
// values). Capturing fp at REGISTRATION is required because the placement
// leaderboard event is emitted at SETTLE time, which has no request context.
covePokerMttRouter.use('*', fingerprintMiddleware);
covePokerMttRouter.use('*', sessionMiddleware);

const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';

/** Pull the salted anti-farm provenance fingerprintMiddleware set on context. */
function readProvenance(c: {
  get(key: string): unknown;
}): { fpHash: string | null; ipPrefixHash: string | null } {
  const fpHash = c.get('fpHash');
  const ipPrefixHash = c.get('ipPrefixHash');
  return {
    fpHash: typeof fpHash === 'string' ? fpHash : null,
    ipPrefixHash: typeof ipPrefixHash === 'string' ? ipPrefixHash : null,
  };
}

/**
 * Resolve the request subject for an economy write. Precedence: Lucia human →
 * agent session. NO guest tier (a CT tournament has no demo mode). Mirrors
 * cove-blackjack's agent-capable resolver minus the guest branch.
 *
 * Attaches the request's (fpHash, ipPrefixHash) — set by `fingerprintMiddleware`
 * from the browser-supplied OR agent-forwarded `X-CV-Fingerprint` — so the
 * registration persists anti-farm provenance that the TM later threads into the
 * placement leaderboard event (settle is request-decoupled, so it MUST be captured
 * here). Both human and agent get a real fp this way (Rule E5 parity).
 */
async function resolveRegisterSubject(c: {
  get(key: string): unknown;
  req: { header(name: string): string | undefined };
}): Promise<RegisterSubject> {
  const provenance = readProvenance(c);
  const user = c.get('user') as { id: string } | null;
  if (user) {
    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    });
    if (!avatar) {
      throw new HTTPException(403, {
        message: 'active_avatar_required: create an avatar before entering a tournament',
      });
    }
    return { kind: 'user', userId: user.id, avatarId: avatar.id, agentId: null, ...provenance };
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
        message:
          'agent_session_has_no_active_avatar: connect an avatar before entering a tournament',
      });
    }
    return {
      kind: 'agent',
      userId: resolved.userId,
      avatarId: resolved.avatarId,
      agentId: resolved.agentId,
      ...provenance,
    };
  }

  throw new HTTPException(401, {
    message: 'auth_required: Lucia cookie or X-Clawville-Agent-Session header',
  });
}

const idParamSchema = z.object({ id: z.string().uuid() });

// ── Socket-less agent action schema (P5) ──────────────────────────────────────
//
// A connected/hosted agent that never opened a WS plays its tournament hand over
// REST: it polls GET /:id/state-for-agent until `isYourTurn`, then POSTs ONE
// action here. The body is structurally identical to the WS `poker.action` frame
// (handNumber + actionSeq + a discriminated action) so the idempotency key and the
// sim contract match the socket path EXACTLY. Betting NEVER flows through the
// free-text [ACTION:] parser — only this authenticated, session-bound endpoint.
const pokerActionSchema = z.object({
  tournamentId: z.string().uuid(),
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

const stateForAgentQuerySchema = z.object({
  tournamentId: z.string().uuid(),
});

// ── Admin create-tournament schema (money config — every bound validated) ─────
//
// This is the CREATION path for a CT-buy-in tournament. Zod enforces the structural
// bounds here (positive buy-in, sane seat/entrant/stack ranges, well-formed payout
// curve); the TournamentManager re-validates defensively (the route is not the only
// caller). `payoutCurve` is OPTIONAL — omitting it uses DEFAULT_PAYOUT_CURVE (top-3
// 50/30/20). `blindScheduleId` is OPTIONAL — omitting it seeds/uses the idempotent
// default ladder.
const payoutCurveEntrySchema = z.object({
  placement: z.number().int().min(1),
  share: z.number().positive().finite(),
});

const createTournamentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  buyInCt: z.number().int().positive(),
  rakeBps: z.number().int().min(0).max(10000).default(0),
  minEntrants: z.number().int().min(2),
  maxEntrants: z.number().int().min(2).max(200),
  seatsPerTable: z.number().int().min(2).max(9).default(9),
  startingStack: z.number().int().positive(),
  payoutCurve: z.array(payoutCurveEntrySchema).min(1).optional(),
  registrationClosesAt: z.string().datetime().optional(),
  blindScheduleId: z.string().uuid().optional(),
})
  .refine((b) => b.maxEntrants >= b.minEntrants, {
    message: 'maxEntrants_must_be_gte_minEntrants',
    path: ['maxEntrants'],
  });

const listTournamentsQuerySchema = z.object({
  includeRunning: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// ── POST /create (ADMIN-ONLY — the tournament creation path) ──────────────────
//
// ADMIN GATE: a tournament is a money config (CT buy-in → real prize pool). Only an
// operator may stand one up. The `adminOnly` middleware (ADMIN_USER_IDS allowlist OR
// the shared dash cookie) runs AFTER the router-wide `sessionMiddleware`, so
// `c.get('user')` is populated for the allowlist check. A non-admin Lucia user → 403;
// an unauthenticated caller with no dash cookie → 401. Body is FULLY Zod-validated
// (positive buy-in, sane seat/entrant/stack bounds, well-formed payout curve); the TM
// re-validates defensively. NOT a parity surface — creation is an operator action, not
// a gameplay action, so no agent path (agents PLAY tournaments, they don't create them).
covePokerMttRouter.post('/create', adminOnly, async (c) => {
  let body: z.infer<typeof createTournamentSchema>;
  try {
    body = createTournamentSchema.parse(await c.req.json());
  } catch (err) {
    throw new HTTPException(400, {
      message:
        err instanceof z.ZodError
          ? `invalid_create_body: ${err.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`
          : 'invalid_create_body',
    });
  }

  const config: CreateTournamentConfig = {
    name: body.name,
    buyInCt: body.buyInCt,
    rakeBps: body.rakeBps,
    minEntrants: body.minEntrants,
    maxEntrants: body.maxEntrants,
    seatsPerTable: body.seatsPerTable,
    startingStack: body.startingStack,
    payoutCurve: body.payoutCurve,
    registrationClosesAt: body.registrationClosesAt
      ? new Date(body.registrationClosesAt)
      : null,
    blindScheduleId: body.blindScheduleId,
  };

  // The creator's avatar (if the admin has one) — audit only, no parity implication.
  const user = c.get('user');
  let createdByAvatarId: string | null = null;
  if (user) {
    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    });
    createdByAvatarId = avatar?.id ?? null;
  }

  try {
    const tournament = await tournamentManager.createTournament(config, createdByAvatarId);
    return c.json({ ok: true, tournament }, 201);
  } catch (err) {
    if (err instanceof TournamentError) {
      throw new HTTPException(err.httpStatus as 400, { message: err.message });
    }
    throw err;
  }
});

// ── GET / (PUBLIC — discovery list for the cove lobby/list UI) ────────────────
//
// No auth: a public list of joinable tournaments (registering, + running when
// `?includeRunning=true`). Returns each tournament's config + the CURRENT non-refunded
// entrant count, live table count, and a compact blind summary so a list UI can render
// the lobby. Read-only.
covePokerMttRouter.get('/', async (c) => {
  const parsed = listTournamentsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_list_query' });
  }
  const tournaments = await tournamentManager.listTournaments({
    includeRunning: parsed.data.includeRunning ?? false,
    limit: parsed.data.limit,
  });
  return c.json({ ok: true, tournaments });
});

// ── POST /:id/register ────────────────────────────────────────────────────────

covePokerMttRouter.post('/:id/register', requireNonGuestUser, async (c) => {
  const parsed = idParamSchema.safeParse(c.req.param());
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_tournament_id' });
  }
  const tournamentId = parsed.data.id;
  const subject = await resolveRegisterSubject(c);

  try {
    const result = await tournamentManager.registerEntrant(subject, tournamentId);
    // Cap-hit auto-seat: when THIS registration filled the last seat, seat the
    // field IMMEDIATELY (force skips the registration-window check) instead of
    // waiting for the window-close sweep. Fire-and-forget — startTrigger is
    // idempotent under its row lock, so a concurrent sweep can't double-seat, and
    // a seating failure must NOT fail the (already-committed) registration; the
    // sweeper remains the backstop. Settlement/refund both flow from startTrigger.
    if (result.capReached) {
      void tournamentManager.startTrigger(tournamentId, { force: true }).catch((err) => {
        console.error(
          `[cove-poker-mtt] cap-hit auto-start failed for tournament ${tournamentId}:`,
          err,
        );
      });
    }
    return c.json(
      {
        ok: true,
        entrantId: result.entrantId,
        prizePoolCt: result.prizePoolCt,
        alreadyRegistered: result.alreadyRegistered,
      },
      result.alreadyRegistered ? 200 : 201,
    );
  } catch (err) {
    if (err instanceof TournamentError) {
      throw new HTTPException(err.httpStatus as 400, { message: err.message });
    }
    if (err instanceof InsufficientTokensError) {
      throw new HTTPException(402, {
        message: 'insufficient_clawtokens_for_buyin',
      });
    }
    throw err;
  }
});

// ── GET /:id/connection (P3.5 — the seated subject's WS connection ticket) ─────
//
// HUMAN/AGENT PARITY (Rule E5): the SAME subject resolver as registration (human
// cookie XOR agent session → the resolved/bound avatar). A registered+seated
// subject gets its OWN `{ roomId, shortCode, seatIndex, activityId }` so it can
// open the WS via the existing `useActivityWs` path (client work is a LATER
// phase; this endpoint just exposes the data). 404 when the caller is not a live
// seat at a running table (not seated yet / busted / no live WS room).
//
// PARITY note: human path GET /:id/connection with a Lucia cookie; agent path
// GET /:id/connection with X-Clawville-Agent-Session; the seat binds to the
// resolved avatarId (human's active avatar OR agent's bound avatar), so an agent
// learns ITS OWN seat — never another subject's.
covePokerMttRouter.get('/:id/connection', noStorePrivate, async (c) => {
  const parsed = idParamSchema.safeParse(c.req.param());
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_tournament_id' });
  }
  const tournamentId = parsed.data.id;
  const subject = await resolveRegisterSubject(c);

  const conn = tournamentManager.getConnectionForSubject(
    tournamentId,
    subject.avatarId,
  );
  if (!conn) {
    // Either the tournament isn't running with a live WS room, or this subject is
    // not a live seat at it (not seated / busted). Distinct from a 404 tournament
    // — use 409 so the client can poll until seating completes.
    throw new HTTPException(409, {
      message: 'not_seated_or_no_live_table',
    });
  }

  return c.json({
    ok: true,
    roomId: conn.roomId,
    shortCode: conn.shortCode,
    seatIndex: conn.seatIndex,
    activityId: conn.activityId,
  });
});

// ── POST /action (P5 — socket-less agent/human betting action) ────────────────
//
// HUMAN/AGENT PARITY (Rule E5): the SAME subject resolver as registration (human
// cookie XOR agent session → the resolved/bound avatar). A connected/hosted agent
// playing AS ITSELF, or a human, submits ONE action for its OWN seat. The actor's
// avatarId comes from the AUTHED identity — the caller never names a seat, so it
// can only ever act AS ITSELF (no cross-seat action). Routes to
// `tournamentManager.applyAgentAction` → `pokerMttSim.applyAction`, the EXACT
// settlement path the WS hub uses (idempotencyKey `<handNumber>:<actionSeq>:<avatarId>`).
//
// CONTROLLED MODE: when the avatar is human-CONTROLLED, an `actor:'agent'`
// (autonomous) bet is suppressed (`409 human_controlled`) — the human at the
// wheel owns the decision; the agent should use POST-less advisor reads instead.
// We derive `actor` from the resolved subject kind: a Lucia human is the driver
// ('human', never suppressed); an agent session is autonomous ('agent', suppressed
// when its avatar is controlled).
//
// PARITY note: human path POST /action with a Lucia cookie; agent path POST
// /action with X-Clawville-Agent-Session; the bet binds to the resolved avatarId
// (human's active avatar OR agent's bound avatar) → real chips → real CT at settle.
covePokerMttRouter.post('/action', requireNonGuestUser, async (c) => {
  let parsed: z.infer<typeof pokerActionSchema>;
  try {
    parsed = pokerActionSchema.parse(await c.req.json());
  } catch {
    throw new HTTPException(400, { message: 'invalid_action_body' });
  }
  const subject = await resolveRegisterSubject(c);

  const idempotencyKey = `${parsed.handNumber}:${parsed.actionSeq}:${subject.avatarId}`;
  const result = tournamentManager.applyAgentAction({
    tournamentId: parsed.tournamentId,
    avatarId: subject.avatarId,
    action: parsed.action,
    idempotencyKey,
    actor: subject.kind === 'user' ? 'human' : 'agent',
  });

  if (!result.ok) {
    const reason = result.reason ?? 'illegal_action';
    // Map sim rejection reasons to faithful HTTP statuses. 409 for state conflicts
    // (not your turn / no live table / hand over / suppressed); 422 for an illegal
    // bet shape the sim refused.
    const status409 = new Set([
      'no_live_table',
      'human_controlled',
      'not_your_turn',
      'hand_over',
      'not_seated',
      'no_such_table',
    ]);
    throw new HTTPException((status409.has(reason) ? 409 : 422) as 409, { message: reason });
  }

  return c.json({
    ok: true,
    advancedStreet: result.advancedStreet ?? false,
    handComplete: result.handComplete ?? false,
    nextToActAvatarId: result.nextToActAvatarId ?? null,
  });
});

// ── GET /:id/state-for-agent (P5 — the socket-less agent poll view) ───────────
//
// HUMAN/AGENT PARITY (Rule E5): the SAME subject resolver. Returns the requesting
// subject's OWN view — the public table snapshot (NEVER any other seat's cards),
// its own hole cards, legal actions, whether it is its turn, and the action
// deadline — so a socket-less agent can poll until `isYourTurn` then act. The sim
// enforces the hidden-state redaction (a hole-card leak into the public snapshot
// is a compile error); this endpoint adds NO new disclosure.
//
// 409 (not 404) when the subject is not a live seat at a running hand, so a client
// can poll through seating without distinguishing it from a missing tournament.
covePokerMttRouter.get('/:id/state-for-agent', noStorePrivate, async (c) => {
  const parsed = idParamSchema.safeParse(c.req.param());
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_tournament_id' });
  }
  const tournamentId = parsed.data.id;
  const subject = await resolveRegisterSubject(c);

  const view = tournamentManager.getSeatViewForAgent(tournamentId, subject.avatarId);
  if (!view) {
    throw new HTTPException(409, { message: 'not_seated_or_no_live_hand' });
  }
  return c.json({ ok: true, view });
});

// ── GET /:id/advice (P5 — ADVISOR MODE; non-staking recommendation) ───────────
//
// HUMAN/AGENT PARITY (Rule E5 — advisor vs controlled split): the SAME subject
// resolver. Returns a RECOMMENDED action (engine `estimateStrength` heuristic)
// WITHOUT staking any CT or mutating any state — the caller chooses to follow or
// ignore it. This is the advisor-mode surface: a human driving a connected agent's
// avatar (controlled mode) can ask the agent for advice without the agent betting,
// and an autonomous agent can sanity-check its own decision. NEVER reveals another
// seat's cards (it reasons only from the requesting seat's own hole + the board).
//
// Allowed even when the avatar is human-controlled (advice never stakes).
covePokerMttRouter.get('/:id/advice', noStorePrivate, async (c) => {
  const parsed = idParamSchema.safeParse(c.req.param());
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_tournament_id' });
  }
  const tournamentId = parsed.data.id;
  const subject = await resolveRegisterSubject(c);

  const advice = tournamentManager.getActionAdvice(tournamentId, subject.avatarId);
  if (!advice) {
    throw new HTTPException(409, { message: 'not_seated_or_no_live_hand' });
  }
  return c.json({ ok: true, advice });
});

// ── GET /:id (status + standings) ─────────────────────────────────────────────

covePokerMttRouter.get('/:id', async (c) => {
  const parsed = idParamSchema.safeParse(c.req.param());
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_tournament_id' });
  }
  const tournamentId = parsed.data.id;

  const tRows = await db.execute<{
    id: string;
    name: string;
    status: string;
    buy_in_ct: string;
    rake_bps: number;
    min_entrants: number;
    max_entrants: number;
    seats_per_table: number;
    starting_stack: number;
    prize_pool_ct: string;
    rake_taken_ct: string | null;
    registration_closes_at: Date | string | null;
    started_at: Date | string | null;
    settled_at: Date | string | null;
  }>(
    sql`SELECT id, name, status, buy_in_ct, rake_bps, min_entrants, max_entrants,
               seats_per_table, starting_stack, prize_pool_ct, rake_taken_ct,
               registration_closes_at, started_at, settled_at
        FROM poker_tournaments WHERE id = ${tournamentId}`,
  );
  const t = tRows[0];
  if (!t) throw new HTTPException(404, { message: 'tournament_not_found' });

  const entrantRows = await db.execute<{
    avatar_id: string;
    agent_id: string | null;
    subject_type: string;
    status: string;
    chip_stack: number;
    seat_index: number | null;
    placement: number | null;
  }>(
    sql`SELECT avatar_id, agent_id, subject_type, status, chip_stack, seat_index, placement
        FROM poker_tournament_entrants
        WHERE tournament_id = ${tournamentId}
        ORDER BY placement ASC NULLS LAST, chip_stack DESC`,
  );

  const resultRows = await db.execute<{
    avatar_id: string;
    placement: number;
    prize_ct: string;
  }>(
    sql`SELECT avatar_id, placement, prize_ct
        FROM poker_tournament_results
        WHERE tournament_id = ${tournamentId}
        ORDER BY placement ASC`,
  );

  return c.json({
    tournament: {
      id: t.id,
      name: t.name,
      status: t.status,
      buyInCt: t.buy_in_ct,
      rakeBps: t.rake_bps,
      minEntrants: t.min_entrants,
      maxEntrants: t.max_entrants,
      seatsPerTable: t.seats_per_table,
      startingStack: t.starting_stack,
      prizePoolCt: t.prize_pool_ct,
      rakeTakenCt: t.rake_taken_ct,
      registrationClosesAt: t.registration_closes_at,
      startedAt: t.started_at,
      settledAt: t.settled_at,
    },
    entrants: entrantRows.map((e) => ({
      avatarId: e.avatar_id,
      agentId: e.agent_id,
      subjectType: e.subject_type,
      status: e.status,
      chipStack: e.chip_stack,
      seatIndex: e.seat_index,
      placement: e.placement,
    })),
    results: resultRows.map((r) => ({
      avatarId: r.avatar_id,
      placement: r.placement,
      prizeCt: r.prize_ct,
    })),
  });
});
