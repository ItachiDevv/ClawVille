/**
 * Multiplayer Phase 1 — `/api/world/*` route surface.
 *
 *  POST /api/world/join             — assign a room (auto-fill or honored
 *                                     ?room=CODE deeplink). Returns
 *                                     { roomId, players, npcs (filtered) }.
 *  POST /api/world/leave            — drop the caller's session from its
 *                                     current room and schedule NPC restore.
 *  POST /api/world/position         — fire-and-forget 5 Hz position update.
 *                                     Server-side rate-limited to 10 Hz/session.
 *  GET  /api/world/:roomId/stream   — SSE snapshot stream for the room.
 *  GET  /api/world/rooms            — admin-only roster of live rooms.
 *
 * Auth model — every endpoint goes through sessionMiddleware, then derives
 * a stable sessionId with precedence: Lucia user > connected/hosted agent
 * session (X-Clawville-Agent-Session) > guest fingerprint. Agents join AS
 * THEMSELVES (bound avatar, counted toward the room cap, swap-eligible) so
 * Rule E5 human/agent parity holds on the multiplayer surface. The raw
 * sessionId NEVER leaves the server (only a non-reversible publicId is
 * broadcast; see room-registry derivePublicId). The SSE stream is gated on
 * room membership so a third party can't subscribe to a room they are not in.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, avatars } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/admin-only';
import {
  AGENT_SESSION_HEADER,
  validateLiveAgentSession,
} from '../middleware/require-auth-or-agent';
import { npcSimulation } from '../services/npc-simulation';
import { roomRegistry, ROOM_MAX_PLAYERS } from '../services/room-registry';
import { signRoomTicket, resolveRecoveryRoomId } from '../services/room-ticket';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import type { Context } from 'hono';
import type { AppContext } from '../types';

/** Town-center default (matches avatars.position_x/y defaults of 2560,2560). */
const TOWN_CENTER_X = 2560;
const TOWN_CENTER_Y = 2560;

export const worldRoutes = new Hono<AppContext>();

worldRoutes.use('*', sessionMiddleware);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PresenceKind = 'human' | 'guest' | 'agent';

interface ResolvedPresence {
  /** Raw internal session key. NEVER returned to the client. */
  sessionId: string;
  kind: PresenceKind;
  /**
   * The userId whose avatar this presence plays AS. Non-null for humans and
   * for agents bound to an avatar; null for guests and for agents not yet
   * bound to an avatar (they still get a guest-style presence so they can
   * walk around, but earn nothing persistent until they have an avatar).
   */
  userId: string | null;
}

/**
 * Resolve a stable per-session presence with precedence:
 *   1. Lucia user      → sessionId = Lucia session id, kind 'human'.
 *   2. Agent session   → X-Clawville-Agent-Session header validated via the
 *                        single fail-closed liveness gate. sessionId is an
 *                        `a:<agentId>` handle (the raw agentId is NOT leaked;
 *                        derivePublicId hashes it like everyone else), kind
 *                        'agent', userId = the bound human's userId so the
 *                        agent joins AS its avatar (Rule E5 parity).
 *   3. Guest           → fingerprint hash prefixed `g:`, kind 'guest'.
 *
 * Async because the agent path hits the DB (validateLiveAgentSession).
 */
async function resolvePresence(c: Context<AppContext>): Promise<ResolvedPresence> {
  const session = c.get('session');
  if (session?.id) {
    const user = c.get('user');
    return { sessionId: session.id, kind: 'human', userId: user?.id ?? null };
  }

  // Agent-session path: honor the SAME header every other economy/activity
  // surface uses. An EXPIRED / unknown session fails closed (returns null)
  // and falls through to the guest path rather than throwing.
  const agentSessionId = c.req.header(AGENT_SESSION_HEADER);
  if (agentSessionId) {
    const live = await validateLiveAgentSession(agentSessionId);
    if (live) {
      return {
        sessionId: `a:${live.config.agentId}`,
        kind: 'agent',
        userId: live.bot.userId ?? null,
      };
    }
  }

  const fp = c.get('fpHash');
  if (fp) return { sessionId: `g:${fp}`, kind: 'guest', userId: null };
  throw new HTTPException(500, { message: 'No session or fingerprint available' });
}

/**
 * Build a JoinAvatarMeta payload from the resolved presence. Humans AND
 * avatar-bound agents load their real avatar row (name/species/modelKey/
 * position) so they join AS THEMSELVES. Guests (and avatar-less agents) get
 * a Visitor archetype spawned at town center so they don't pop in at the
 * world origin (0,0) for ~200ms before their first position update.
 */
async function resolveAvatarMeta(presence: ResolvedPresence) {
  const { userId, kind } = presence;
  if (!userId) {
    return {
      userId: null,
      name: 'Visitor',
      species: 'milady_chibi',
      color: 0xcccccc,
      x: TOWN_CENTER_X,
      y: TOWN_CENTER_Y,
      kind,
    };
  }
  const row = await db
    .select({
      name: avatars.name,
      species: avatars.species,
      modelKey: avatars.modelKey,
      positionX: avatars.positionX,
      positionY: avatars.positionY,
    })
    .from(avatars)
    .where(eq(avatars.userId, userId))
    .limit(1);
  const a = row[0];
  if (!a) {
    return {
      userId,
      name: 'Visitor',
      species: 'milady_chibi',
      color: 0xcccccc,
      x: TOWN_CENTER_X,
      y: TOWN_CENTER_Y,
      kind,
    };
  }
  return {
    userId,
    name: a.name,
    // modelKey is the canonical visual key for the 3D pipeline; species
    // falls back when modelKey is unset (legacy rows).
    species: a.modelKey || a.species,
    color: 0xcccccc,
    x: a.positionX,
    y: a.positionY,
    kind,
  };
}

// Server-side per-session position-update throttle. The client SHOULD send
// at 5 Hz (matches NPC tick); 10 Hz is the upper bound we accept before
// silently dropping. Spec: "Cap server-side at 10 Hz/session".
const POSITION_MIN_INTERVAL_MS = 100;
const positionLastSeen = new Map<string, number>();

// B3 (punch list) — when RoomRegistry kicks stale sessions inside its
// tick GC, drop their throttle entries too so the Map can't grow
// unbounded across an attacker spamming /position with rotating
// fingerprints. RoomRegistry already enumerates the kicked sessionIds
// in `staleSessionsRemoved`; we just hook the tick result.
roomRegistry.subscribeTick((result) => {
  for (const sid of result.staleSessionsRemoved) {
    positionLastSeen.delete(sid);
  }
});

// B2 (punch list) — per-IP rate limit on POST /join. Caps anonymous
// room-mint spam at 3/min/IP; auth'd users hit the same limit but
// they're already individually accountable via the Lucia session.
const joinRateLimiter = createRateLimiter({
  maxPerWindow: 3,
  windowMs: 60_000,
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// B5 (punch list) — tighten the regex to the SAME alphabet RoomRegistry
// uses when minting IDs (excludes 0/O/1/I/L). Otherwise a deeplink with
// a confusable character would pass validation, get force-minted, and
// produce a permanent room ID that no future /join can collide with.
const ROOM_ID_REGEX = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/u;
const joinSchema = z.object({
  roomId: z
    .string()
    .regex(ROOM_ID_REGEX, 'roomId must be 4 chars from the safe alphabet')
    .optional(),
  // Sticky-room recovery (2026-06-12). An opaque signed ticket the client
  // received from a PRIOR /join. Replayed ONLY on a recovery rejoin (after a
  // 409 or an SSE reconnect) to re-land the session in the same room across a
  // deploy/restart. Bounded length so a malformed value can't bloat the body;
  // the real validation is the HMAC check in verifyRoomTicket. An
  // invalid/expired/mismatched ticket is silently ignored (fail-closed → normal
  // auto-fill), never an error.
  roomTicket: z.string().max(512).optional(),
});

const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  dirZ: z.number().finite(),
  activity: z.string().max(32).default('idle'),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

worldRoutes.post('/join', async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!joinRateLimiter.check(ip)) {
    throw new HTTPException(429, { message: 'Too many join attempts — try again in a minute' });
  }
  const presence = await resolvePresence(c);
  const body = (await c.req.json().catch(() => ({}))) as unknown;
  const parsed = joinSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: parsed.error.message });
  }
  const requestedRoomId = parsed.data.roomId;

  // Sticky-room recovery (2026-06-12). If the caller replayed a ticket from a
  // prior /join, `resolveRecoveryRoomId` is the single authoritative gate: it
  // verifies the ticket (authentic MAC + unexpired, fail-closed) AND requires
  // its SECRET-bound subject to equal the subject re-derived from THIS live
  // session's sessionId (deriveTicketSubject — bound to the raw sessionId, a
  // secret only the real session can present, NOT the wire-public publicId). A
  // ticket is thus bound to the exact session it was minted for, so a captured
  // ticket can't be replayed by a different session to pin an arbitrary room (B2
  // anti-spam holds on the recovery path too). Any failure → undefined and we
  // fall through to the normal requestedRoomId / auto-fill flow. The gate lives
  // in room-ticket.ts so it is unit-tested as the literal code, not a mirror.
  const recoveryRoomId = resolveRecoveryRoomId(parsed.data.roomTicket, presence.sessionId);

  const avatarMeta = await resolveAvatarMeta(presence);
  const { room, player, swappedOutNpcId } = roomRegistry.joinPlayer(presence.sessionId, avatarMeta, {
    requestedRoomId,
    // B2: only accountable callers (Lucia user OR validated agent session)
    // can mint never-before-seen invite codes. Guests with an unknown code
    // fall through to auto-fill inside the registry.
    isAuthenticated: presence.kind !== 'guest',
    recoveryRoomId,
  });

  // Mint a fresh recovery ticket for the room the session actually landed in,
  // bound to a SECRET commitment to this sessionId (deriveTicketSubject — never
  // the raw bearer, never the wire-public publicId). The client stores this and
  // replays it on its next recovery rejoin so a deploy/restart re-converges the
  // group. Re-issued every join so the 15-min TTL slides forward while the
  // session stays active.
  const roomTicket = signRoomTicket({ roomId: room.id, sessionId: presence.sessionId });

  return c.json({
    roomId: room.id,
    // Echo the SAME non-reversible publicId the client will see for itself in
    // every snapshot so it can resolve `isLocal`. The raw sessionId is never
    // returned (it is the Lucia bearer token for logged-in users).
    id: player.publicId,
    roomTicket,
    capacity: ROOM_MAX_PLAYERS,
    playerCount: room.players.size,
    swappedOutNpcId,
    players: roomRegistry.getPlayerSnapshots(room.id),
  });
});

worldRoutes.post('/leave', async (c) => {
  const { sessionId } = await resolvePresence(c);
  const result = roomRegistry.leavePlayer(sessionId);
  positionLastSeen.delete(sessionId);
  return c.json({
    ok: true,
    roomId: result?.room.id ?? null,
    pendingRestoreNpcId: result?.pendingRestoreNpcId ?? null,
  });
});

worldRoutes.post('/position', async (c) => {
  const presence = await resolvePresence(c);
  const { sessionId } = presence;
  const now = Date.now();
  const last = positionLastSeen.get(sessionId) ?? 0;
  if (now - last < POSITION_MIN_INTERVAL_MS) {
    // Silently accepted — the client is over-publishing; we drop the
    // update but don't error so it doesn't have to backoff on every
    // throttle event.
    return c.json({ ok: true, throttled: true });
  }
  positionLastSeen.set(sessionId, now);

  const body = await c.req.json().catch(() => ({}));
  const parsed = positionSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: parsed.error.message });
  }
  const player = roomRegistry.updatePosition(sessionId, parsed.data);
  if (!player) {
    // Session has no room yet — client must call /join first. 409 makes
    // the client error path explicit so it can re-join automatically.
    throw new HTTPException(409, { message: 'Session is not in a room — call /api/world/join first' });
  }
  // Controlled Hatcher launch: a logged-in human actively uploading position is
  // the live "owner is driving" signal. Refresh the suppression TTL for any
  // Hatcher proxy NPC bound to this user so its autonomous body stays hidden +
  // frozen while the owner drives their avatar. No-op for users with no bound
  // Hatcher agent (the openClawBots scan finds no match). Suppression lapses on
  // its own once these uploads stop (e.g. the owner switches to explore mode).
  if (presence.kind === 'human' && presence.userId) {
    npcSimulation.refreshHumanControlledOpenClawForUser(presence.userId);
  }
  return c.json({ ok: true });
});

worldRoutes.get('/:roomId/stream', async (c) => {
  const roomId = c.req.param('roomId');
  const isSolo = roomId.startsWith('solo-');
  // B5 — same safe-alphabet regex as the /join schema.
  if (!ROOM_ID_REGEX.test(roomId) && !isSolo) {
    throw new HTTPException(400, { message: 'Invalid room id' });
  }

  // SECURITY (membership gate): a multiplayer room snapshot carries every
  // member's live position. Without this check ANY caller could subscribe to
  // an arbitrary active room and harvest its roster. We require the caller to
  // actually be IN the room they ask to stream. The `solo-` alias has no
  // membership (it is a private single-viewer NPC stream from the npc-sse
  // shim) so it is exempt: there is no other session's data to leak.
  if (!isSolo) {
    const presence = await resolvePresence(c);
    const callerRoom = roomRegistry.getRoomForSession(presence.sessionId);
    if (!callerRoom || callerRoom.id !== roomId) {
      throw new HTTPException(403, {
        message: 'Not a member of this room (call /api/world/join first)',
      });
    }
  }

  return streamSSE(c, async (stream) => {
    const initial = npcSimulation.getRoomSnapshot(roomId);
    await stream.writeSSE({
      data: JSON.stringify(initial),
      event: 'snapshot',
    });

    const listener = async (snapshotJson: string) => {
      try {
        await stream.writeSSE({
          data: snapshotJson,
          event: 'snapshot',
        });
      } catch {
        npcSimulation.removeRoomListener(roomId, listener);
      }
    };

    npcSimulation.addRoomListener(roomId, listener);
    stream.onAbort(() => {
      npcSimulation.removeRoomListener(roomId, listener);
    });

    // SSE keepalive — see npc-sse.ts for the Cloudflare HTTP/2 idle-reset
    // reasoning. 30 s is well under the 100 s reset window.
    while (true) {
      await stream.sleep(30000);
      try {
        await stream.writeSSE({ data: '', event: 'keepalive' });
      } catch {
        npcSimulation.removeRoomListener(roomId, listener);
        return;
      }
    }
  });
});

worldRoutes.get('/rooms', adminOnly, (c) => {
  const rooms = roomRegistry.listRooms().map((r) => ({
    id: r.id,
    playerCount: r.players.size,
    npcCount: r.npcs.size,
    removedNpcCount: r.removedNpcs.size,
    lastActivityAt: r.lastActivityAt,
    sessions: Array.from(r.players.values()).map((p) => ({
      // SECURITY: never emit the raw sessionId (Lucia bearer token). The
      // non-reversible publicId is a stable handle for admin debugging.
      id: p.publicId,
      kind: p.kind,
      userId: p.userId,
      name: p.name,
      species: p.species,
      x: p.x,
      y: p.y,
    })),
  }));
  return c.json({ rooms, count: rooms.length });
});
