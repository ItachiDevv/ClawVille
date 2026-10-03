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
 *   POST /create        (NAMED admin) — create an event (status 'draft')
 *   POST /:slug/open    (NAMED admin) — open it for signups (draft → signup_open)
 *   POST /:slug/start   (NAMED admin) — close signups + create/seat the dependent
 *                                   tournament (signup_open → starting → live)
 *   POST /:slug/settle  (NAMED admin) — explicitly record event completion
 *   POST /:slug/cancel  (NAMED admin) — cancel before play (draft / signup_open,
 *                                   after the start recovery) + refund signups
 *   GET  /:slug/sol-refunds (NAMED admin) — SOL refunds owed + paid (cancelled event)
 *   POST /:slug/sol-refunds/:signupId/paid (NAMED admin) — record an operator SOL
 *                                   payout after on-chain verification
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
import { createMiddleware } from 'hono/factory';
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
  SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT,
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
 * Named-admin gate for EVERY special-event admin mutation (security M3,
 * 2026-09-30): /create, /:slug/open, /:slug/start, /:slug/settle, and
 * /:slug/cancel (2026-10-03: it credits refunds), and the SOL refund routes
 * /:slug/sol-refunds + /:slug/sol-refunds/:signupId/paid. `adminOnly`
 * also accepts the static shared `cv_dash` cookie, which is not tied to a user and
 * never rotates. /create sets the seed prize pool, /start pays it from the house
 * treasury, and /open + /settle move the event lifecycle, so all four also require
 * a Lucia session whose user id is in ADMIN_USER_IDS — the same rule as
 * tokenomics-earn `requireNamedAdmin`. Signup is a player route (unchanged).
 */
const requireNamedAdmin = createMiddleware<AppContext>(async (c, next) => {
  const user = c.get('user');
  const ids = (process.env.ADMIN_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!user || !ids.includes(user.id)) {
    throw new HTTPException(403, { message: 'named_admin_required' });
  }
  await next();
});

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
// The seed prize pool is paid from the house treasury at start (M3), so it is
// bounded here (integer or digit string, 0..SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT).
// Other prize keys pass through; the TournamentManager validates them at start.
const prizeConfigSchema = z
  .object({
    seedPrizePoolCt: z
      .union([z.number(), z.string().trim().regex(/^\d{1,16}$/).transform(Number)])
      .pipe(z.number().int().min(0).max(SPECIAL_EVENT_SEED_PRIZE_POOL_MAX_CT))
      .optional(),
  })
  .passthrough();

export const createEventSchema = z
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
    prizeConfigJson: prizeConfigSchema.optional(),
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
specialEventsRouter.post('/create', adminOnly, requireNamedAdmin, async (c) => {
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

// ── POST /:slug/open (NAMED ADMIN) ────────────────────────────────────────────
specialEventsRouter.post('/:slug/open', adminOnly, requireNamedAdmin, async (c) => {
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

// ── POST /:slug/start (NAMED ADMIN — close signups + create/seat the tournament) ─
specialEventsRouter.post('/:slug/start', adminOnly, requireNamedAdmin, async (c) => {
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

// Explicit command: public GET status routes must remain read-only.
specialEventsRouter.post('/:slug/settle', adminOnly, requireNamedAdmin, async (c) => {
  const parsed = slugParamSchema.safeParse(c.req.param());
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_slug' });
  try {
    const result = await specialEventManager.settleEvent(parsed.data.slug);
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof SpecialEventError) {
      throw new HTTPException(err.httpStatus as 400, { message: err.message });
    }
    throw err;
  }
});

// ── POST /:slug/cancel (NAMED ADMIN — cancel before play + refund signups) ─────
// Refunds every vCLAW entry to the signup's avatar (human or agent, same path)
// and records every SOL entry as an owed refund (durable row; `solRefundsOwed`
// in the response) for an operator transfer. A retry moves no CT. Refused (409)
// once play started or the event settled.
specialEventsRouter.post('/:slug/cancel', adminOnly, requireNamedAdmin, async (c) => {
  const parsed = slugParamSchema.safeParse(c.req.param());
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_slug' });
  try {
    const result = await specialEventManager.cancelEvent(parsed.data.slug);
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof SpecialEventError) {
      throw new HTTPException(err.httpStatus as 400, { message: err.message });
    }
    throw err;
  }
});

// ── SOL refunds of a cancelled event (NAMED ADMIN, Codex r1 2026-10-03) ───────
// A SOL entry goes back by an operator transfer from the treasury. The cancel
// records each one as 'owed' (special_event_sol_refunds, destination = the
// sender proven by the entry transfer). These routes list them and record a
// payout after the API verifies it on chain (finalized, ≥ owed lamports to the
// recorded destination, signature never used before).
const solRefundParamSchema = z.object({
  slug: z.string().min(1).max(64),
  signupId: z.string().uuid(),
});
const solRefundPaidSchema = z.object({
  // A base58 Solana transaction signature (64 bytes → 64..88 chars).
  txSignature: z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
});

specialEventsRouter.get('/:slug/sol-refunds', adminOnly, requireNamedAdmin, async (c) => {
  const parsed = slugParamSchema.safeParse(c.req.param());
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_slug' });
  try {
    const result = await specialEventManager.listSolRefunds(parsed.data.slug);
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof SpecialEventError) {
      throw new HTTPException(err.httpStatus as 400, { message: err.message });
    }
    throw err;
  }
});

specialEventsRouter.post('/:slug/sol-refunds/:signupId/paid', adminOnly, requireNamedAdmin, async (c) => {
  const params = solRefundParamSchema.safeParse(c.req.param());
  if (!params.success) throw new HTTPException(400, { message: 'invalid_params' });
  const body = solRefundPaidSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new HTTPException(400, { message: 'invalid_tx_signature' });
  try {
    const refund = await specialEventManager.markSolRefundPaid(
      params.data.slug,
      params.data.signupId,
      body.data.txSignature,
      c.get('user')?.id ?? null,
    );
    return c.json({ ok: true, refund });
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
  const snapshot = await specialEventManager.getEventSettlementSnapshot(parsed.data.slug);
  if (!snapshot) throw new HTTPException(404, { message: 'event_not_found' });

  return c.json({
    ok: true,
    event: snapshot.event,
    tournamentId: snapshot.tournamentId,
    results: snapshot.results,
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
