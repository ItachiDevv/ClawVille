/**
 * Q2 Activity Portals — dual-identity middleware.
 *
 * Resolves the caller as EITHER a Lucia-authed human OR a Phase 5.1
 * agent session, populating `c.var.identity` with a discriminated union
 * shape so downstream handlers can branch without re-running auth logic.
 *
 *   - Lucia path: standard cookie. `c.get('user')` already populated by
 *     `sessionMiddleware` (which MUST run before this middleware).
 *   - Agent path: `X-Clawville-Agent-Session: <sessionId>` header. The
 *     session is registered by `agent-gateway.ts` at /api/agent/connect
 *     time, mapped to its `openclaw_bots` row, which carries the bound
 *     human's `userId`. The user's active pet is the activity participant.
 *
 * Throws 401 if neither path resolves. Throws 403 if the agent session
 * is bound to a user with no active pet (degraded — agents can connect
 * before pet creation, but they can't queue for a match without one).
 *
 * The header name matches the existing agent-gateway convention
 * (lower-cased Hono header read normalizes case). NOT a new pattern —
 * just a NEW dual-validator layered on top of the existing single-source
 * middlewares.
 */

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { db, pets, openclawBots } from '@clawville/database';
import { npcSimulation } from '../services/npc-simulation';
import type { AppContext } from '../types';

/**
 * Discriminated identity union populated on `c.var.identity`.
 */
export type ActivityIdentity =
  | {
      kind: 'user';
      userId: string;
      petId: string;
      /** Agent id is null for human-direct identity (no agent in the loop) */
      agentId: null;
    }
  | {
      kind: 'agent';
      userId: string;
      petId: string;
      agentId: string;
      /** The agent-session id used in the request header */
      sessionId: string;
    };

/**
 * AppContext extension with `identity` set on success.
 */
export interface ActivityAuthContext {
  Variables: AppContext['Variables'] & {
    identity: ActivityIdentity;
  };
}

const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';

/**
 * Resolve a Lucia session cookie OR an agent-session id to a complete
 * identity. Used by the activity WS hub (chunk #3), which has no Hono
 * context and therefore can't run the middleware below.
 *
 * Same contract as the middleware:
 *   - Lucia cookie → user-kind identity, pet must be active
 *   - Agent session id → agent-kind identity, pet must be active
 *
 * Returns null on auth failure (caller responsible for closing the WS
 * with 4001 — the helper doesn't throw HTTPException).
 */
export async function resolveActivityIdentity(input: {
  /** Either Lucia session id (raw, NOT cookie header) or agent session id */
  sessionToken: string;
}): Promise<ActivityIdentity | null> {
  const token = input.sessionToken;
  if (!token) return null;

  // Try Lucia first — sessionToken contract from `auth` frame is the raw
  // session id, not the cookie header.
  try {
    const { lucia } = await import('../lib/auth');
    const { session, user } = await lucia.validateSession(token);
    if (session && user) {
      const pet = await db.query.pets.findFirst({
        where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
      });
      if (!pet) return null;
      return {
        kind: 'user',
        userId: user.id,
        petId: pet.id,
        agentId: null,
      };
    }
  } catch {
    // Lucia validation throws on malformed tokens — fall through to agent path.
  }

  // Try agent-session path.
  const resolved = await resolveAgentSession(token);
  if (!resolved || !resolved.userId || !resolved.petId) return null;
  return {
    kind: 'agent',
    userId: resolved.userId,
    petId: resolved.petId,
    agentId: resolved.agentId,
    sessionId: token,
  };
}

/**
 * Resolve an agent session id to `{userId, petId, agentId}` by looking
 * through the npc-simulation registry → openclaw_bots row → user's pet.
 *
 * Returns `null` if the session is unknown OR if the bound user has no
 * active pet (the latter is a 403, surfaced separately at the call site).
 */
export async function resolveAgentSession(
  sessionId: string,
): Promise<{
  userId: string | null;
  petId: string | null;
  agentId: string;
} | null> {
  if (!npcSimulation.isValidAgentSession(sessionId)) return null;

  const config = npcSimulation.getOpenClawBotConfig(sessionId);
  if (!config) return null;

  const bot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, config.agentId),
  });
  if (!bot) return null;

  const userId = bot.userId ?? null;

  // Anonymous / unbound openclaw bots can chat but cannot queue — they
  // have no `userId` to anchor a Sybil cap on. Surface as a separate
  // 403 outside this helper so the caller can write an exact error code.
  if (!userId) {
    return { userId: null, petId: null, agentId: config.agentId };
  }

  const pet = await db.query.pets.findFirst({
    where: and(eq(pets.userId, userId), eq(pets.isActive, true)),
  });

  return {
    userId,
    petId: pet?.id ?? null,
    agentId: config.agentId,
  };
}

export const requireAuthOrAgentSession = createMiddleware<ActivityAuthContext>(
  async (c, next) => {
    // Lucia user path takes precedence — sessionMiddleware ran upstream
    // and already populated `c.get('user')` if the cookie is valid.
    const user = c.get('user');
    if (user) {
      const pet = await db.query.pets.findFirst({
        where: and(eq(pets.userId, user.id), eq(pets.isActive, true)),
      });
      if (!pet) {
        throw new HTTPException(403, {
          message:
            'Active pet required — create a pet before queuing for an activity',
        });
      }
      c.set('identity', {
        kind: 'user',
        userId: user.id,
        petId: pet.id,
        agentId: null,
      });
      return next();
    }

    // Agent-session path — header carries an opaque session id minted at
    // /api/agent/connect (Phase 5.1).
    const sessionId = c.req.header(AGENT_SESSION_HEADER);
    if (!sessionId) {
      throw new HTTPException(401, {
        message:
          'Authentication required — Lucia cookie or X-Clawville-Agent-Session header',
      });
    }

    const resolved = await resolveAgentSession(sessionId);
    if (!resolved) {
      throw new HTTPException(401, {
        message: 'Invalid or expired agent session',
      });
    }
    if (!resolved.userId || !resolved.petId) {
      throw new HTTPException(403, {
        message:
          'Agent session is not bound to an active pet — cannot queue for an activity',
      });
    }

    c.set('identity', {
      kind: 'agent',
      userId: resolved.userId,
      petId: resolved.petId,
      agentId: resolved.agentId,
      sessionId,
    });
    return next();
  },
);
