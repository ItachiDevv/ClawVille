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
 *     human's `userId`. The user's active avatar is the activity participant.
 *
 * Throws 401 if neither path resolves. Throws 403 if the agent session
 * is bound to a user with no active avatar (degraded — agents can connect
 * before avatar creation, but they can't queue for a match without one).
 *
 * The header name matches the existing agent-gateway convention
 * (lower-cased Hono header read normalizes case). NOT a new pattern —
 * just a NEW dual-validator layered on top of the existing single-source
 * middlewares.
 */

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { eq, and } from 'drizzle-orm';
import { db, avatars, openclawBots } from '@clawville/database';
import { npcSimulation } from '../services/npc-simulation';
import { sha256Hex } from '../services/session-digest';
import type { AppContext } from '../types';

/**
 * Discriminated identity union populated on `c.var.identity`.
 */
export type ActivityIdentity =
  | {
      kind: 'user';
      userId: string;
      avatarId: string;
      /** Agent id is null for human-direct identity (no agent in the loop) */
      agentId: null;
    }
  | {
      kind: 'agent';
      userId: string;
      avatarId: string;
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

/**
 * Canonical agent-session bearer header name. Exported so non-activity
 * surfaces (e.g. the multiplayer world routes) can honor the SAME header
 * without re-declaring the literal and drifting out of sync.
 */
export const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';

/** The live `openclaw_bots` row + in-memory config for a validated session. */
export interface LiveAgentSession {
  config: NonNullable<ReturnType<typeof npcSimulation.getOpenClawBotConfig>>;
  bot: NonNullable<Awaited<ReturnType<typeof db.query.openclawBots.findFirst>>>;
}

/**
 * THE single fail-closed agent-session liveness gate (Codex auth-lens hardening
 * round 3, 2026-06-03). Every path that trusts an `X-Clawville-Agent-Session`
 * bearer — the cove ledger resolver, the gateway perception/move/chat/visit
 * routes, the Milady → Lucia cookie exchange — MUST route through this one
 * function so they can never drift apart again (the round-1 TTL fix only patched
 * the cove resolver; the gateway `resolveSession` + the milady exchange still
 * trusted bare Map membership, so an EXPIRED session kept earning real CT and
 * could mint a full Lucia cookie).
 *
 * Returns the live `{config, bot}` ONLY when:
 *   1. the session id is in the in-memory map (`isValidAgentSession`),
 *   2. its `openclaw_bots` row exists, and
 *   3. `session_expires_at` is populated AND strictly in the future.
 *
 * A NULL `session_expires_at` is treated as EXPIRED (fail-closed) — every live
 * session carries a 24h sliding TTL, so a missing one means a never-refreshed /
 * pre-column row; we refuse rather than trust it. On any expiry the stale
 * in-memory body is unregistered so the next call short-circuits at step 1, and
 * we return null. The DB row is the source of truth for liveness; Map membership
 * alone is NEVER sufficient for a bearer-trusting path.
 *
 * Restart survival (2026-06-11): the in-memory Map is rebuilt empty on every API
 * deploy, so a still-live bearer map-misses at step 1 right after a restart. On
 * that miss we attempt a restore FROM THE SURVIVING ROW (hash the incoming
 * bearer → find by `session_key_hash` → re-validate the SAME fail-closed TTL →
 * rebuild the in-memory session/client). The restore obeys the identical
 * TTL/ledger rules below, so it can never resurrect an expired row or grant
 * liveness this gate would refuse — see `openclaw-session-restore.ts`. The
 * restore re-registers under the incoming id, so the re-fetch below sees it as a
 * normal live session.
 */
export async function validateLiveAgentSession(
  sessionId: string,
): Promise<LiveAgentSession | null> {
  if (!npcSimulation.isValidAgentSession(sessionId)) {
    // Map-miss — maybe the API restarted and dropped the in-memory session.
    // Try to rebuild it from the surviving DB row (fail-closed: returns null on
    // missing/expired row or an identity type that can't be rebuilt from the
    // row). Dynamic import to avoid a static import cycle
    // (restore → npc-simulation → ... → this middleware).
    const { restoreAgentSessionFromRow } = await import(
      '../services/openclaw-session-restore'
    );
    return restoreAgentSessionFromRow(sessionId);
  }

  const config = npcSimulation.getOpenClawBotConfig(sessionId);
  if (!config) return null;

  const bot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.agentId, config.agentId),
  });
  if (!bot) return null;

  const expiresAt = bot.sessionExpiresAt;
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    npcSimulation.unregisterOpenClaw(sessionId);
    return null;
  }

  // Live-rotation invalidation (Codex round-2 R2-2, 2026-06-12). The in-memory
  // Map proves only that THIS process once registered this bearer — it does NOT
  // prove the bearer is still the CURRENT live session for the row. When /connect
  // or the partner register/patch ROTATES the session it writes a NEW
  // `session_key_hash` (the hash of the new bearer) onto the SAME agentId row, but
  // the OLD bearer stays in this Map until the next restart, so it kept passing
  // the TTL gate (the row's sliding expiry is refreshed by the rotation) and kept
  // spending real CT against `boundUserId`. The restore-design (b453fb18) hashed
  // the bearer to gate RESTORE but never re-checked it on a live Map hit. We now
  // require a PRESENT Map-hit bearer hash to match the row's CURRENT hash: a
  // rotated-away bearer has `sha256Hex(sessionId) !== bot.sessionKeyHash` (the
  // rotation ALWAYS wrote a non-null new hash), so we tear down the stale
  // in-memory body (same fail-closed shape as expiry) and return null.
  //
  // Null-hash carve-out (Codex round-2 fixer pass, 2026-06-12): we reject ONLY
  // when the stored hash is PRESENT and mismatches — NOT when it is null. The
  // partner register/patch path (partner-hatcher.ts) calls `registerOpenClaw`
  // (Map-live) BEFORE persisting `session_key_hash`, and that persist is
  // EXPLICITLY non-fatal (try/catch, comment "won't survive a restart"). A strict
  // `!== ` would turn that documented-non-fatal failure FATAL — a freshly-minted
  // partner session whose hash hasn't landed yet (the 910→928 window) or whose
  // non-fatal persist threw would be killed on its first real-CT call, and the
  // register→persist window could tear down a just-spawned body mid-sim. A null
  // hash is NEVER a rotation-stale bearer: a null-hash Map entry can only have
  // been registered by THIS process (the Map empties on restart, and every
  // restart-restore matches the row by `sessionKeyHash === sha256Hex(incoming)`,
  // so a restored entry always has a non-null hash). So null = a not-yet-
  // persisted / non-fatal-persist-failed freshly-minted session — fall through to
  // the TTL gate rather than lock it out. The rotation attack is fully covered by
  // `present && mismatch` because rotation always writes the new bearer's hash.
  if (bot.sessionKeyHash && bot.sessionKeyHash !== sha256Hex(sessionId)) {
    npcSimulation.unregisterOpenClaw(sessionId);
    return null;
  }

  return { config, bot };
}

/**
 * Resolve a Lucia session cookie OR an agent-session id to a complete
 * identity. Used by the activity WS hub (chunk #3), which has no Hono
 * context and therefore can't run the middleware below.
 *
 * Same contract as the middleware:
 *   - Lucia cookie → user-kind identity, avatar must be active
 *   - Agent session id → agent-kind identity, avatar must be active
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
      const avatar = await db.query.avatars.findFirst({
        where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
      });
      if (!avatar) return null;
      return {
        kind: 'user',
        userId: user.id,
        avatarId: avatar.id,
        agentId: null,
      };
    }
  } catch {
    // Lucia validation throws on malformed tokens — fall through to agent path.
  }

  // Try agent-session path.
  const resolved = await resolveAgentSession(token);
  if (!resolved || !resolved.userId || !resolved.avatarId) return null;
  return {
    kind: 'agent',
    userId: resolved.userId,
    avatarId: resolved.avatarId,
    agentId: resolved.agentId,
    sessionId: token,
  };
}

/**
 * Resolve an agent session id to `{userId, avatarId, agentId, ledgerCapable}`
 * by looking through the npc-simulation registry → openclaw_bots row → user's
 * active avatar.
 *
 * Returns `null` if the session is unknown, EXPIRED, OR if the bound user has
 * no active avatar (the avatar gap is surfaced as a 403 separately at the call
 * site via the null `avatarId`).
 *
 * TTL enforcement (Codex auth-lens fix #4, 2026-06-03): the in-memory bot map
 * outlives the DB TTL — the sweeper marks `openclaw_bots.session_expires_at`
 * but never unregisters the in-memory entry, so a session that was reaped from
 * the DB still satisfied `isValidAgentSession` (Map membership) and kept
 * spending real CT in the cove. We now hard-gate on
 * `openclaw_bots.session_expires_at > now`: an expired row returns `null` AND
 * unregisters the stale map entry so it can never be resolved again. The cove
 * must never grant real-CT play on map membership alone.
 *
 * `ledgerCapable` (auth-lens fix #2/#3): forwarded verbatim from the in-memory
 * session config (set at registration time when ownership was proven). Defaults
 * to FALSE when the config omits it so any path that forgets to set it fails
 * closed at the cove gate.
 */
export async function resolveAgentSession(
  sessionId: string,
): Promise<{
  userId: string | null;
  avatarId: string | null;
  agentId: string;
  ledgerCapable: boolean;
} | null> {
  // Single fail-closed liveness gate (shared with the gateway routes + Milady
  // exchange so the TTL check can never drift). Validates Map membership + the
  // DB `session_expires_at > now` (NULL = expired) and unregisters a stale body.
  const live = await validateLiveAgentSession(sessionId);
  if (!live) return null;
  const { config, bot } = live;

  const userId = bot.userId ?? null;

  // Ledger-capability with rebind re-validation (Codex auth-lens hardening
  // round 2, 2026-06-03 — the stale-session theft vector). `config.ledgerCapable`
  // is frozen at registration, but the bound `userId` on the live row can change
  // underneath it: an attacker registers a ledger-capable session while an
  // agentId is unbound (or theirs), then a later owned-token connect rebinds that
  // same agentId's row to a VICTIM. The frozen flag would otherwise authorize the
  // attacker's stale session to spend the victim's real CT. We re-validate here:
  // the session is ledger-capable ONLY if it proved ownership of the SAME user
  // the row is bound to right now (`config.boundUserId === userId`, both non-null).
  // A mismatch means the row was rebound after this session was issued, so we
  // tear down the stale session (so it can never resolve again) and treat it as
  // non-ledger. This is the resolve-time backstop to the eviction-on-rebind in
  // /connect + /register; either one alone closes the vector, both together is
  // belt-and-suspenders on a real-money path.
  let ledgerCapable = config.ledgerCapable === true;
  if (ledgerCapable) {
    const boundUserId = config.boundUserId ?? null;
    if (!boundUserId || boundUserId !== userId) {
      ledgerCapable = false;
      // Only unregister when the row was rebound to a DIFFERENT real user — that
      // is the theft signal. A first-contact/anonymous session (boundUserId null,
      // userId still null) is legitimately non-ledger but must stay alive so the
      // agent can keep perceiving/chatting; don't evict it.
      if (boundUserId && userId && boundUserId !== userId) {
        npcSimulation.unregisterOpenClaw(sessionId);
        return null;
      }
    }
  }

  // Anonymous / unbound openclaw bots can chat but cannot queue — they
  // have no `userId` to anchor a Sybil cap on. Surface as a separate
  // 403 outside this helper so the caller can write an exact error code.
  if (!userId) {
    return { userId: null, avatarId: null, agentId: config.agentId, ledgerCapable };
  }

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
  });

  return {
    userId,
    avatarId: avatar?.id ?? null,
    agentId: config.agentId,
    ledgerCapable,
  };
}

export const requireAuthOrAgentSession = createMiddleware<ActivityAuthContext>(
  async (c, next) => {
    // Lucia user path takes precedence — sessionMiddleware ran upstream
    // and already populated `c.get('user')` if the cookie is valid.
    const user = c.get('user');
    if (user) {
      const avatar = await db.query.avatars.findFirst({
        where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
      });
      if (!avatar) {
        throw new HTTPException(403, {
          message:
            'Active avatar required — create an avatar before queuing for an activity',
        });
      }
      c.set('identity', {
        kind: 'user',
        userId: user.id,
        avatarId: avatar.id,
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
    if (!resolved.userId || !resolved.avatarId) {
      throw new HTTPException(403, {
        message:
          'Agent session is not bound to an active avatar — cannot queue for an activity',
      });
    }

    c.set('identity', {
      kind: 'agent',
      userId: resolved.userId,
      avatarId: resolved.avatarId,
      agentId: resolved.agentId,
      sessionId,
    });
    return next();
  },
);
