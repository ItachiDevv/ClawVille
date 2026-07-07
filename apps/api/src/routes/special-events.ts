/**
 * Special Events (2026-06-16) — the GENERIC PARENT-layer route surface.
 *
 * Mount: `app.route('/api/events', specialEventsRouter)` from index.ts.
 *
 * `special_events` is the REUSABLE PARENT for any one-time event; a poker
 * tournament is a DEPENDENT subtable (the FK points UP:
 * poker_tournaments.special_event_id → special_events.id). These routes own the
 * event lifecycle; the dependent tournament is created + seated by the manager.
 *
 * Surfaces:
 *   POST /create        (admin)  — create an event (status 'draft')
 *   POST /:slug/open    (admin)  — open it for signups (draft → signup_open)
 *   POST /:slug/start   (admin)  — close signups + create/seat the dependent
 *                                   tournament (→ live)
 *   GET  /              (public) — list events
 *   GET  /:slug         (public) — event status + its linked tournament id (if live)
 *   POST /:slug/signup  (AGENT-CAPABLE) — gate-evaluated signup (human XOR agent)
 *
 * ── HUMAN/AGENT PARITY (Rule E5) ─────────────────────────────────────────────
 * Signup is an ECONOMY GATE (it can debit CT / require a verified SOL payment /
 * snapshot a token holding, and a confirmed signup becomes a real tournament
 * entrant earning real CT + a leaderboard placement). The subject resolver
 * therefore mirrors cove-poker-mtt's agent-capable resolver:
 *   - 'human' — Lucia-authed user → its active avatar.
 *   - 'agent' — a connected/hosted agent via `X-Clawville-Agent-Session` →
 *     its BOUND avatar (resolveAgentSession, ledgerCapable-gated).
 * NO guest tier (an economy gate has no demo mode) → an unauthenticated request
 * is 401. Parity by construction: both reach the SAME signup write path with the
 * SAME economic + leaderboard consequences.
 *
 * PARITY note (for the commit body): human path POST /:slug/signup with a Lucia
 * cookie; agent path POST /:slug/signup with X-Clawville-Agent-Session;
 * settlement (CT debit / SOL gate / hold snapshot) + the resulting tournament
 * entry bind to the resolved avatarId (human's active avatar OR agent's bound
 * avatar) — never a guest fallback.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, avatars } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { requireNonGuestUser } from '../middleware/require-non-guest';
import { fingerprintMiddleware } from '../middleware/fingerprint';
import { adminOnly } from '../middleware/admin-only';
import { resolveAgentSession } from '../middleware/require-auth-or-agent';
import {
  specialEventManager,
  SpecialEventError,
  type SignupSubject,
  type EntryChoice,
  type CreateEventConfig,
} from '../services/special-event-manager';
import { InsufficientTokensError } from '../services/claw-token-ledger';
import type { AppContext } from '../types';

export const specialEventsRouter = new Hono<AppContext>();
// fingerprintMiddleware runs here too so the agent-gateway in-process sub-request
// path (which forwards X-CV-Fingerprint but bypasses the app-level chain) still
// resolves; idempotent for a human (app-level middleware already ran).
specialEventsRouter.use('*', fingerprintMiddleware);
specialEventsRouter.use('*', sessionMiddleware);

const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';

/**
 * Resolve the request subject for a signup. Precedence: Lucia human → agent
 * session. NO guest tier (an economy gate has no demo mode). Mirrors
 * cove-poker-mtt's agent-capable resolver.
 */
async function resolveSignupSubject(c: {
  get(key: string): unknown;
  req: { header(name: string): string | undefined };
}): Promise<SignupSubject> {
  const user = c.get('user') as { id: string } | null;
  if (user) {
    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    });
    if (!avatar) {
      throw new HTTPException(403, {
        message: 'active_avatar_required: create an avatar before signing up for an event',
      });
    }
    return { kind: 'human', userId: user.id, avatarId: avatar.id, agentId: null };
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
        message: 'agent_session_has_no_active_avatar: connect an avatar before signing up',
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

const slugParamSchema = z.object({ slug: z.string().min(1).max(64) });

// ── Admin create-event schema (gate config validated) ─────────────────────────
const createEventSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'slug_must_be_lowercase_alnum_dash'),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    kind: z.string().trim().max(64).optional(),
    gateHoldMint: z.string().trim().min(32).max(44).optional(),
    gateHoldBps: z.number().int().min(1).max(10000).optional(),
    gateSolLamports: z.number().int().positive().optional(),
    gateCt: z.number().int().min(0).optional(),
    venueConfigJson: z.record(z.unknown()).optional(),
    prizeConfigJson: z.record(z.unknown()).optional(),
    maxParticipants: z.number().int().min(1).optional(),
    registrationOpensAt: z.string().datetime().optional(),
    registrationClosesAt: z.string().datetime().optional(),
    startsAt: z.string().datetime().optional(),
  })
  .refine((b) => (b.gateHoldMint == null) === (b.gateHoldBps == null), {
    message: 'hold_gate_requires_both_mint_and_bps',
    path: ['gateHoldMint'],
  });

// ── Agent-capable signup schema ───────────────────────────────────────────────
const signupSchema = z.object({
  entryMethod: z.enum(['free', 'hold', 'sol', 'ct']),
  walletType: z.enum(['external', 'custodial']).optional(),
  walletPubkey: z.string().trim().min(32).max(44).optional(),
  solTxSig: z.string().trim().min(32).max(128).optional(),
});

// ── POST /create (ADMIN) ──────────────────────────────────────────────────────
specialEventsRouter.post('/create', adminOnly, async (c) => {
  let body: z.infer<typeof createEventSchema>;
  try {
    body = createEventSchema.parse(await c.req.json());
  } catch (err) {
    throw new HTTPException(400, {
      message:
        err instanceof z.ZodError
          ? `invalid_create_body: ${err.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`
          : 'invalid_create_body',
    });
  }

  const config: CreateEventConfig = {
    slug: body.slug,
    name: body.name,
    description: body.description ?? null,
    kind: body.kind,
    gateHoldMint: body.gateHoldMint ?? null,
    gateHoldBps: body.gateHoldBps ?? null,
    gateSolLamports: body.gateSolLamports ?? null,
    gateCt: body.gateCt ?? null,
    venueConfigJson: body.venueConfigJson ?? null,
    prizeConfigJson: body.prizeConfigJson ?? null,
    maxParticipants: body.maxParticipants ?? null,
    registrationOpensAt: body.registrationOpensAt ? new Date(body.registrationOpensAt) : null,
    registrationClosesAt: body.registrationClosesAt ? new Date(body.registrationClosesAt) : null,
    startsAt: body.startsAt ? new Date(body.startsAt) : null,
  };

  const user = c.get('user');
  let createdByAvatarId: string | null = null;
  if (user) {
    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    });
    createdByAvatarId = avatar?.id ?? null;
  }

  try {
    const event = await specialEventManager.createEvent(config, createdByAvatarId);
    return c.json({ ok: true, event }, 201);
  } catch (err) {
    if (err instanceof SpecialEventError) {
      throw new HTTPException(err.httpStatus as 400, { message: err.message });
    }
    throw err;
  }
});

// ── POST /:slug/open (ADMIN) ──────────────────────────────────────────────────
specialEventsRouter.post('/:slug/open', adminOnly, async (c) => {
  const parsed = slugParamSchema.safeParse(c.req.param());
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_slug' });
  try {
    const event = await specialEventManager.openSignup(parsed.data.slug);
    return c.json({ ok: true, event });
  } catch (err) {
    if (err instanceof SpecialEventError) {
      throw new HTTPException(err.httpStatus as 400, { message: err.message });
    }
    throw err;
  }
});

// ── POST /:slug/start (ADMIN — close signups + create/seat the tournament) ─────
specialEventsRouter.post('/:slug/start', adminOnly, async (c) => {
  const parsed = slugParamSchema.safeParse(c.req.param());
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_slug' });
  try {
    const result = await specialEventManager.closeSignupAndStart(parsed.data.slug);
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof SpecialEventError) {
      throw new HTTPException(err.httpStatus as 400, { message: err.message });
    }
    throw err;
  }
});

// ── GET / (PUBLIC list) ───────────────────────────────────────────────────────
specialEventsRouter.get('/', async (c) => {
  const limit = Number(c.req.query('limit') ?? 50);
  const events = await specialEventManager.listEvents(Number.isFinite(limit) ? limit : 50);
  return c.json({ ok: true, events });
});

// ── GET /:slug (PUBLIC status + linked tournament id) ─────────────────────────
specialEventsRouter.get('/:slug', async (c) => {
  const parsed = slugParamSchema.safeParse(c.req.param());
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_slug' });
  const event = await specialEventManager.getEventBySlug(parsed.data.slug);
  if (!event) throw new HTTPException(404, { message: 'event_not_found' });

  // Surface the dependent tournament id (the FK points UP) so the lobby can deep
  // link to it once the event is live.
  const settle =
    event.status === 'live' || event.status === 'completed'
      ? await specialEventManager.settleEvent(parsed.data.slug)
      : null;

  return c.json({
    ok: true,
    event,
    tournamentId: settle?.tournamentId ?? null,
    results: settle?.results ?? [],
  });
});

// ── POST /:slug/signup (AGENT-CAPABLE) ────────────────────────────────────────
specialEventsRouter.post('/:slug/signup', requireNonGuestUser, async (c) => {
  const parsed = slugParamSchema.safeParse(c.req.param());
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_slug' });

  let body: z.infer<typeof signupSchema>;
  try {
    body = signupSchema.parse(await c.req.json());
  } catch {
    throw new HTTPException(400, { message: 'invalid_signup_body' });
  }

  const subject = await resolveSignupSubject(c);
  const choice: EntryChoice = {
    entryMethod: body.entryMethod,
    walletType: body.walletType,
    walletPubkey: body.walletPubkey,
    solTxSig: body.solTxSig,
  };

  try {
    const result = await specialEventManager.signup(parsed.data.slug, subject, choice);
    return c.json({ ok: true, ...result }, result.alreadySignedUp ? 200 : 201);
  } catch (err) {
    if (err instanceof SpecialEventError) {
      throw new HTTPException(err.httpStatus as 400, { message: err.message });
    }
    if (err instanceof InsufficientTokensError) {
      throw new HTTPException(402, { message: 'insufficient_clawtokens_for_entry' });
    }
    throw err;
  }
});
