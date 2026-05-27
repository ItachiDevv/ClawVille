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
 * a stable sessionId. Logged-in users use their Lucia session ID; guests
 * fall back to the fingerprint hash so a browser without an account still
 * has a stable identity across reconnects.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, avatars } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/admin-only';
import { npcSimulation, type SimulationSnapshot } from '../services/npc-simulation';
import { roomRegistry, ROOM_MAX_PLAYERS } from '../services/room-registry';
import type { Context } from 'hono';
import type { AppContext } from '../types';

export const worldRoutes = new Hono<AppContext>();

worldRoutes.use('*', sessionMiddleware);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a stable per-browser sessionId. Logged-in callers use their Lucia
 * session id. Guests use the global fingerprint hash (already computed by
 * fingerprintMiddleware in index.ts) prefixed `g:` so the two namespaces
 * never collide.
 */
function resolveSessionId(c: Context<AppContext>): string {
  const session = c.get('session');
  if (session?.id) return session.id;
  const fp = c.get('fpHash');
  if (fp) return `g:${fp}`;
  throw new HTTPException(500, { message: 'No session or fingerprint available' });
}

/**
 * Build a JoinAvatarMeta payload from the calling user. Falls back to a
 * guest archetype when no avatar exists.
 */
async function resolveAvatarMeta(userId: string | null) {
  if (!userId) {
    return {
      userId: null,
      name: 'Visitor',
      species: 'milady_chibi',
      color: 0xcccccc,
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
  };
}

// Server-side per-session position-update throttle. The client SHOULD send
// at 5 Hz (matches NPC tick); 10 Hz is the upper bound we accept before
// silently dropping. Spec: "Cap server-side at 10 Hz/session".
const POSITION_MIN_INTERVAL_MS = 100;
const positionLastSeen = new Map<string, number>();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const joinSchema = z.object({
  roomId: z
    .string()
    .regex(/^[A-Z0-9]{4}$/u, 'roomId must be 4 alphanumeric uppercase chars')
    .optional(),
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
  const sessionId = resolveSessionId(c);
  const user = c.get('user');
  const body = (await c.req.json().catch(() => ({}))) as unknown;
  const parsed = joinSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: parsed.error.message });
  }
  const requestedRoomId = parsed.data.roomId;

  const avatarMeta = await resolveAvatarMeta(user?.id ?? null);
  const { room, swappedOutNpcId } = roomRegistry.joinPlayer(
    sessionId,
    avatarMeta,
    requestedRoomId,
  );

  return c.json({
    roomId: room.id,
    sessionId,
    capacity: ROOM_MAX_PLAYERS,
    playerCount: room.players.size,
    swappedOutNpcId,
    players: roomRegistry.getPlayerSnapshots(room.id),
  });
});

worldRoutes.post('/leave', async (c) => {
  const sessionId = resolveSessionId(c);
  const result = roomRegistry.leavePlayer(sessionId);
  positionLastSeen.delete(sessionId);
  return c.json({
    ok: true,
    roomId: result?.room.id ?? null,
    pendingRestoreNpcId: result?.pendingRestoreNpcId ?? null,
  });
});

worldRoutes.post('/position', async (c) => {
  const sessionId = resolveSessionId(c);
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
  return c.json({ ok: true });
});

worldRoutes.get('/:roomId/stream', (c) => {
  const roomId = c.req.param('roomId');
  if (!/^[A-Z0-9]{4}$/u.test(roomId) && !roomId.startsWith('solo-')) {
    throw new HTTPException(400, { message: 'Invalid room id' });
  }

  return streamSSE(c, async (stream) => {
    const initial = npcSimulation.getRoomSnapshot(roomId);
    await stream.writeSSE({
      data: JSON.stringify(initial),
      event: 'snapshot',
    });

    const listener = async (snapshot: SimulationSnapshot) => {
      try {
        await stream.writeSSE({
          data: JSON.stringify(snapshot),
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
      sessionId: p.sessionId,
      userId: p.userId,
      name: p.name,
      species: p.species,
      x: p.x,
      y: p.y,
    })),
  }));
  return c.json({ rooms, count: rooms.length });
});
