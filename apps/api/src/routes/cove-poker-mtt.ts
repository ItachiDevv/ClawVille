/**
 * Poker MTT (P3) — minimal registration + status route.
 *
 * Mount: `app.route('/api/cove/poker/mtt', covePokerMttRouter)` from index.ts.
 *
 * Surfaces (full lobby UI is a later phase — this is the backend seam):
 *   POST /:id/register   (user OR agent) — buy in (real CT debit), idempotent
 *   GET  /:id            (public)        — tournament status + standings
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
import { resolveAgentSession } from '../middleware/require-auth-or-agent';
import {
  tournamentManager,
  TournamentError,
  type RegisterSubject,
} from '../services/poker/tournament-manager';
import { InsufficientTokensError } from '../services/claw-token-ledger';
import type { AppContext } from '../types';

export const covePokerMttRouter = new Hono<AppContext>();
covePokerMttRouter.use('*', sessionMiddleware);

const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';

/**
 * Resolve the request subject for an economy write. Precedence: Lucia human →
 * agent session. NO guest tier (a CT tournament has no demo mode). Mirrors
 * cove-blackjack's agent-capable resolver minus the guest branch.
 */
async function resolveRegisterSubject(c: {
  get(key: 'user'): { id: string } | null;
  req: { header(name: string): string | undefined };
}): Promise<RegisterSubject> {
  const user = c.get('user');
  if (user) {
    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    });
    if (!avatar) {
      throw new HTTPException(403, {
        message: 'active_avatar_required: create an avatar before entering a tournament',
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
        message:
          'agent_session_has_no_active_avatar: connect an avatar before entering a tournament',
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

const idParamSchema = z.object({ id: z.string().uuid() });

// ── POST /:id/register ────────────────────────────────────────────────────────

covePokerMttRouter.post('/:id/register', async (c) => {
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
covePokerMttRouter.get('/:id/connection', async (c) => {
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
