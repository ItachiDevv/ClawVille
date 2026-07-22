/**
 * Q2 Activity Portals — REST surface (chunk #2).
 *
 * Owns 10 of the 17 routes from the Q2 plan; the WebSocket upgrade
 * (chunk #3), result/leaderboard fetches (chunk #7), and replay
 * download (chunk #5) are stubbed as 501s with explicit comments
 * pointing at their target chunk.
 *
 * Mount point: `app.route('/api/activities', activitiesV2Routes)` in
 * `apps/api/src/index.ts`.
 *
 * Auth model:
 *   - Public routes (`GET /` + `GET /:id`) — no auth, rate-limited
 *     60/min/IP. Same pattern as `/api/leaderboard/agents`.
 *   - Identity-required routes — `requireAuthOrAgentSession` middleware
 *     resolves Lucia OR `X-Clawville-Agent-Session` and populates
 *     `c.var.identity`.
 *
 * Naming note: `activityRoutes` is already exported by
 * `apps/api/src/routes/activity.ts` (a singular, avatar activity-log
 * surface). The router exported here is `activitiesV2Routes` to avoid
 * the name collision, mounted at `/api/activities` (the OLDER
 * `activityRoutes` is mounted at `/api/avatars`).
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  db,
  activityResults,
  activityRooms,
  avatars,
} from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { lucia } from '../lib/auth';
import { requireAuthOrAgentSession } from '../middleware/require-auth-or-agent';
import type { ActivityAuthContext } from '../middleware/require-auth-or-agent';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import {
  activityRoomManager,
  RoomCapacityError,
} from '../services/activity/activity-room-manager';
import {
  activityQueueService,
  MAX_PARTY_SIZE,
} from '../services/activity/activity-queue';
import {
  activityWsHub,
  type HubWs,
} from '../services/activity/activity-ws-hub';
import { bumperShellsSim } from '../services/activity/sim/bumper-shells-sim';
import { reefRaceSim } from '../services/activity/sim/reef-race-sim';
import { reefRaceSplineSim } from '../services/activity/sim/reef-race-spline-sim';
import { REEF_RACE_USE_SPLINE } from '../services/activity/sim/reef-race-config';

/**
 * REST-route sim dispatcher — mirrors the one in index.ts so the
 * GET /rooms/:roomId state-snapshot endpoint uses the correct sim
 * when REEF_RACE_USE_SPLINE=true (v2 spline build). Fix: 2026-04-29 QA S2.
 */
const reefRaceImpl = REEF_RACE_USE_SPLINE
  ? (reefRaceSplineSim as unknown as typeof reefRaceSim)
  : reefRaceSim;
import {
  getLeaderboardSnapshot,
  getLeaderboardForAvatar,
  VALID_WINDOWS,
  type ActivityLeaderboardWindow,
} from '../services/activity/activity-leaderboard-service';
import { getSeasonsCatalog } from '../services/activity/activity-season-service';
import {
  ACTIVITY_REGISTRY,
  ACTIVITY_IDS,
  getActivityDefinition,
} from '@clawville/shared';
import type { AppContext } from '../types';
import { getBunWebSocketHelper } from '../lib/bun-ws-adapter';

// ─── Local types ───────────────────────────────────────────────────────────

type DualContext = AppContext & ActivityAuthContext;

export const activitiesV2Routes = new Hono<DualContext>();

// Public-route rate limiter — same budget as /api/leaderboard/agents.
const publicReadLimiter = createRateLimiter({
  maxPerWindow: 60,
  windowMs: 60_000,
});

// Apply sessionMiddleware to every route on this router so identity
// middleware downstream can read `c.get('user')`. sessionMiddleware sets
// user=null if no cookie — does NOT throw.
activitiesV2Routes.use('*', sessionMiddleware);

// ─── Validation schemas ────────────────────────────────────────────────────

const ACTIVITY_ID_VALUES = ACTIVITY_IDS as unknown as [string, ...string[]];
const activityIdSchema = z.enum(ACTIVITY_ID_VALUES);

const queueBodySchema = z.object({
  /** Pass `partyId` to enqueue an entire party atomically (leader only). */
  partyId: z.string().uuid().nullable().optional(),
  /** Opt out of bot backfill — useful for future ranked queue variants. */
  allowBotBackfill: z.boolean().optional(),
  /** Filter to agent-only matchmaking (?matchType=agent-only). */
  agentOnly: z.boolean().optional(),
});

const createPartyBodySchema = z.object({
  // No fields today; reserved for future invite-list / cosmetic options.
});

const partyIdParamSchema = z.string().uuid();

const partyShortCodeParamSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().length(6).regex(/^[0-9A-HJKMNP-TV-Z]{6}$/));

const kickBodySchema = z.object({
  avatarId: z.string().uuid(),
});

const roomIdParamSchema = z.string().uuid();

// ─── GET /api/activities (public) ──────────────────────────────────────────

activitiesV2Routes.get('/', async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!publicReadLimiter.check(ip)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  // Returns the registry + per-activity live counts. Coming-soon stubs
  // have queueLength/roomsActive=0 by design.
  const items = ACTIVITY_REGISTRY.map((a) => ({
    id: a.id,
    buildingId: a.buildingId,
    title: a.title,
    tagline: a.tagline,
    minPlayers: a.minPlayers,
    maxPlayers: a.maxPlayers,
    queueMinPlayers: a.queueMinPlayers,
    roundSeconds: a.roundSeconds,
    thumbnailUrl: a.thumbnailUrl,
    openclawSkill: a.openclawSkill,
    skillBuildingMatches: a.skillBuildingMatches,
    status: a.status,
    rewardConfig: a.rewardConfig ?? null,
    queueLength: activityQueueService.queueLength(a.id),
    roomsActive: activityRoomManager.listActiveRooms(a.id).length,
  }));
  return c.json({ activities: items });
});

// ─── Specific GET routes that MUST precede /:id ────────────────────────────
// Hono matches in registration order; without these here, GET /seasons would
// match the /:id parameter as id='seasons' and 404 with "activity not found".
// Same trap for /me/recent-results.

/**
 * `GET /api/activities/seasons` — public catalog. Auto-creates the first
 * season (`2026-Q2-S1`, 30 days) on first call so the route never returns
 * an empty `active`. 60s cached at the service layer.
 */
activitiesV2Routes.get('/seasons', async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!publicReadLimiter.check(ip)) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const { active, past } = await getSeasonsCatalog();
  return c.json({
    active,
    past,
  });
});

/**
 * `GET /api/activities/me/recent-results?limit=20` — auth'd; returns the
 * caller's avatar's recent match results. Sorted DESC by createdAt.
 */
activitiesV2Routes.get(
  '/me/recent-results',
  requireAuthOrAgentSession,
  async (c) => {
    const identity = c.get('identity');
    const rawLimit = parseInt(c.req.query('limit') || '20', 10);
    const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20));

    const rows = await db
      .select({
        id: activityResults.id,
        roomId: activityResults.roomId,
        activityId: activityResults.activityId,
        placement: activityResults.placement,
        score: activityResults.score,
        scoreMs: activityResults.scoreMs,
        tokensAwarded: activityResults.tokensAwarded,
        leaderboardPoints: activityResults.leaderboardPoints,
        isPersonalBest: activityResults.isPersonalBest,
        acknowledgedAt: activityResults.acknowledgedAt,
        createdAt: activityResults.createdAt,
      })
      .from(activityResults)
      .where(eq(activityResults.avatarId, identity.avatarId))
      .orderBy(desc(activityResults.createdAt))
      .limit(limit);

    const results = rows.map((r) => ({
      resultId: r.id,
      roomId: r.roomId,
      activityId: r.activityId,
      activityName:
        getActivityDefinition(r.activityId)?.title ?? r.activityId,
      placement: r.placement,
      score: r.score,
      scoreMs: r.scoreMs,
      tokensAwarded: r.tokensAwarded,
      leaderboardPoints: r.leaderboardPoints,
      isPersonalBest: r.isPersonalBest,
      acknowledged: r.acknowledgedAt != null,
      createdAt: r.createdAt,
    }));

    return c.json({ results });
  },
);

// ─── GET /api/activities/:id (public) ──────────────────────────────────────

activitiesV2Routes.get('/:id', async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!publicReadLimiter.check(ip)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const id = c.req.param('id');
  const def = getActivityDefinition(id);
  if (!def) throw new HTTPException(404, { message: 'Activity not found' });

  return c.json({
    activity: {
      ...def,
      queueLength: activityQueueService.queueLength(def.id),
      roomsActive: activityRoomManager.listActiveRooms(def.id).length,
    },
  });
});

// ─── POST /api/activities/:id/queue ────────────────────────────────────────

activitiesV2Routes.post('/:id/queue', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  const def = getActivityDefinition(id);
  if (!def) throw new HTTPException(404, { message: 'Activity not found' });
  if (def.status !== 'live') {
    throw new HTTPException(409, { message: 'Activity is not live yet' });
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = queueBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid request body' });
  }
  const bodyAgentOnly = parsed.data.agentOnly ?? false;
  // Query-param variant `?matchType=agent-only` per plan locked-decisions.
  const queryMatchType = c.req.query('matchType');
  const queryAgentOnly = queryMatchType === 'agent-only';
  const { partyId = null, allowBotBackfill = true } = parsed.data;
  const agentOnly = bodyAgentOnly || queryAgentOnly;

  const identity = c.get('identity');
  // Agent-only filter requires the caller's identity to BE an agent.
  // Humans can't queue for an agent-only room (that defeats the point).
  if (agentOnly && identity.kind !== 'agent') {
    throw new HTTPException(403, {
      message: 'agent-only matchmaking requires an agent session',
    });
  }

  // If a party is supplied, enforce leader-only enqueue (party joins
  // queue atomically as a unit).
  if (partyId) {
    const party = activityQueueService.getParty(partyId);
    if (!party) throw new HTTPException(404, { message: 'Party not found' });
    if (party.leaderAvatarId !== identity.avatarId) {
      throw new HTTPException(403, {
        message: 'Only the party leader can queue the party',
      });
    }
    if (party.members.size > def.maxPlayers) {
      throw new HTTPException(400, {
        message: `Party of ${party.members.size} exceeds activity max ${def.maxPlayers}`,
      });
    }

    // Enqueue every member. Each avatar's userId/agentId is unknown for
    // members beyond the leader — chunk #2 stubs them as the leader's
    // identity (server uses avatarId for all routing). Chunk #3 will add a
    // proper member-identity-resolution helper when WS auth lights up.
    const memberAvatarIds = Array.from(party.members);
    try {
      for (const memberAvatarId of memberAvatarIds) {
        await activityQueueService.enqueue({
          activityId: id,
          avatarId: memberAvatarId,
          userId: memberAvatarId === identity.avatarId ? identity.userId : null,
          agentId: memberAvatarId === identity.avatarId ? identity.agentId : null,
          subjectType: identity.kind === 'agent' ? 'agent' : 'human',
          partyId,
          allowBotBackfill,
          agentOnly,
        });
      }
    } catch (err) {
      handleQueueError(err);
    }

    return c.json({
      ok: true,
      queued: memberAvatarIds.length,
      activityId: id,
      partyId,
    });
  }

  // Solo enqueue.
  const existingEntry = activityQueueService.getQueuedEntry(identity.avatarId);
  if (existingEntry) {
    if (
      existingEntry.activityId === id &&
      existingEntry.agentOnly === agentOnly
    ) {
      return c.json({
        ok: true,
        queued: 1,
        activityId: id,
        entryId: existingEntry.id,
        alreadyQueued: true,
      });
    }
    throw new HTTPException(409, {
      message: `Avatar is already queued for ${existingEntry.activityId}`,
    });
  }

  const activeRoom = activityRoomManager.getPlayerActiveRoom(identity.avatarId);
  if (activeRoom) {
    if (activeRoom.activityId === id) {
      return c.json({
        ok: true,
        queued: 0,
        activityId: id,
        matchedRoomId: activeRoom.id,
        alreadyInRoom: true,
      });
    }
    throw new HTTPException(409, {
      message: `Avatar is already in an active ${activeRoom.activityId} room`,
    });
  }

  try {
    const entry = await activityQueueService.enqueue({
      activityId: id,
      avatarId: identity.avatarId,
      userId: identity.userId,
      agentId: identity.agentId,
      subjectType: identity.kind === 'agent' ? 'agent' : 'human',
      partyId: null,
      allowBotBackfill,
      agentOnly,
    });
    return c.json({
      ok: true,
      queued: 1,
      activityId: id,
      entryId: entry.id,
    });
  } catch (err) {
    return handleQueueError(err);
  }
});

// ─── POST /api/activities/:id/leave-queue ──────────────────────────────────

activitiesV2Routes.post('/:id/leave-queue', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  const def = getActivityDefinition(id);
  if (!def) throw new HTTPException(404, { message: 'Activity not found' });

  const identity = c.get('identity');

  // Idempotent — leaveQueue returns false if the avatar wasn't in the queue.
  const removed = await activityQueueService.leaveQueue(identity.avatarId, 'voluntary');
  return c.json({ ok: true, removed });
});

// ─── GET /api/activities/:id/queue-status ──────────────────────────────────

activitiesV2Routes.get('/:id/queue-status', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  const def = getActivityDefinition(id);
  if (!def) throw new HTTPException(404, { message: 'Activity not found' });

  const identity = c.get('identity');
  const status = activityQueueService.getQueueStatus(id, identity.avatarId);
  // Chunk #3 match.found delivery — option (b) polling. Clients can
  // pick up the room assignment through this field within one sweep
  // cycle (1s). TODO chunk #?: extend the queue endpoint with a
  // control-WS channel so match.found pushes instantly.
  const matchedRoomId = activityQueueService.getMatchedRoomId(identity.avatarId);
  const matchedRoom = matchedRoomId ? activityRoomManager.getRoom(matchedRoomId) : null;
  return c.json({
    ...status,
    matchedRoomId,
    matchedRoomShortCode: matchedRoom?.shortCode ?? null,
  });
});

// ─── Party routes ──────────────────────────────────────────────────────────

activitiesV2Routes.get('/party/me', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  const party = activityQueueService.partyForAvatar(identity.avatarId);
  return c.json({ ok: true, party: await serializeParty(party) });
});

activitiesV2Routes.post('/party', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');

  const body = await c.req.json().catch(() => ({}));
  const parsed = createPartyBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid request body' });
  }

  // Reject if already in a party — server is the source of truth.
  const existing = activityQueueService.partyForAvatar(identity.avatarId);
  if (existing) {
    return c.json({
      ok: true,
      party: await serializeParty(existing),
      alreadyInParty: true,
    });
  }

  const party = await activityQueueService.createParty(identity.avatarId);
  return c.json({ ok: true, party: await serializeParty(party) });
});

activitiesV2Routes.post('/party/:shortCode/join', requireAuthOrAgentSession, async (c) => {
  const shortCodeParse = partyShortCodeParamSchema.safeParse(c.req.param('shortCode'));
  if (!shortCodeParse.success) {
    throw new HTTPException(400, { message: 'Invalid party short code' });
  }
  const identity = c.get('identity');

  try {
    const party = await activityQueueService.joinParty(shortCodeParse.data, identity.avatarId);
    return c.json({ ok: true, party: await serializeParty(party) });
  } catch (err) {
    if (err instanceof Error && err.message === 'Party not found') {
      throw asHttpException(err, 404);
    }
    throw asHttpException(err, 409);
  }
});

activitiesV2Routes.post('/party/:partyId/kick', requireAuthOrAgentSession, async (c) => {
  const partyIdParse = partyIdParamSchema.safeParse(c.req.param('partyId'));
  if (!partyIdParse.success) {
    throw new HTTPException(400, { message: 'Invalid partyId' });
  }
  const body = await c.req.json().catch(() => ({}));
  const bodyParse = kickBodySchema.safeParse(body);
  if (!bodyParse.success) {
    throw new HTTPException(400, { message: 'Body must include avatarId' });
  }

  const identity = c.get('identity');
  try {
    const party = await activityQueueService.kickMember(
      partyIdParse.data,
      identity.avatarId,
      bodyParse.data.avatarId,
    );
    return c.json({ ok: true, party: await serializeParty(party) });
  } catch (err) {
    throw asHttpException(err, 403);
  }
});

activitiesV2Routes.post('/party/:partyId/leave', requireAuthOrAgentSession, async (c) => {
  const partyIdParse = partyIdParamSchema.safeParse(c.req.param('partyId'));
  if (!partyIdParse.success) {
    throw new HTTPException(400, { message: 'Invalid partyId' });
  }
  const identity = c.get('identity');
  await activityQueueService.leaveParty(partyIdParse.data, identity.avatarId);
  return c.json({ ok: true });
});

// ─── GET /api/activities/:id/rooms/:roomId/state ───────────────────────────
//
// REST snapshot fallback for clients that lost the WS — returns the
// current authoritative state without going through the upgrade. Use is
// rare in practice; the WS keyframe stream is the primary recovery
// mechanism. Participant-gated.

activitiesV2Routes.get(
  '/:id/rooms/:roomId/state',
  requireAuthOrAgentSession,
  async (c) => {
    const id = c.req.param('id');
    const roomIdRaw = c.req.param('roomId');
    const roomIdParse = roomIdParamSchema.safeParse(roomIdRaw);
    if (!roomIdParse.success) {
      throw new HTTPException(400, { message: 'Invalid roomId' });
    }
    const room = activityRoomManager.getRoom(roomIdParse.data);
    if (!room) throw new HTTPException(404, { message: 'Room not found' });
    if (room.activityId !== id) {
      throw new HTTPException(404, { message: 'Room not in activity' });
    }

    const identity = c.get('identity');
    if (!room.participants.has(identity.avatarId)) {
      throw new HTTPException(403, { message: 'Not a participant in this room' });
    }

    // Include sim entities when the room is LIVE so reconnecting
    // clients can reconcile without waiting for the next keyframe.
    let simSnapshot: ReturnType<typeof bumperShellsSim.getStateSnapshot>
      | ReturnType<typeof reefRaceSim.getStateSnapshot>
      | null = null;
    if (room.state === 'live') {
      if (room.activityId === 'bumper-shells') {
        simSnapshot = bumperShellsSim.getStateSnapshot(room.id);
      } else if (room.activityId === 'reef-race') {
        simSnapshot = reefRaceImpl.getStateSnapshot(room.id);
      }
    }

    return c.json({
      room: {
        id: room.id,
        shortCode: room.shortCode,
        activityId: room.activityId,
        state: room.state,
        startedAt: room.startedAt,
        endedAt: room.endedAt,
        countdownStartedAt: room.countdownStartedAt,
        participantCount: room.participants.size,
        participants: Array.from(room.participants.values()).map((p) => ({
          avatarId: p.avatarId,
          subjectType: p.subjectType,
          connected: p.connected,
        })),
        sim: simSnapshot,
      },
    });
  },
);

// ─── Stubs — chunks #3, #5, #7 ─────────────────────────────────────────────
//
// All of these compile and return 501 today so the route table reads true
// when chunk #2 ships. Each call site stubs to its owning chunk for clean
// PR-time grep + remove.

// ─── WS /api/activities/:id/rooms/:roomId/ws (chunk #3) ────────────────────
//
// Bun-native upgrade handler. Per backend §3.2:
//   - Validate :id, :roomId BEFORE upgrade so rejected requests never
//     hand a socket to Bun.
//   - First client frame MUST be `auth` — the hub handles that; we just
//     stash the roomId in ws.data.
//   - Every frame post-upgrade routes through wsHub.handleMessage which
//     Zod-validates the schema.

const { upgradeWebSocket } = getBunWebSocketHelper();

/**
 * Per-WS adapter map — Hono's WSContext carries `raw` (Bun
 * ServerWebSocket) but `raw.data` is already owned by Hono for its own
 * event dispatch. We therefore maintain our own WeakMap keyed by the
 * raw WS to stash per-connection state, and expose a `HubWsTransport`
 * wrapper the hub can call.
 */
const hubAdapters = new WeakMap<object, HubWs>();

function getOrMakeAdapter(
  wsContext: {
    send: (source: string) => void;
    close: (code: number, reason: string) => void;
    raw: unknown;
  },
  roomId: string,
  preauthLuciaSessionId: string | null,
): HubWs {
  const keyObj = (wsContext.raw as object) ?? (wsContext as object);
  let existing = hubAdapters.get(keyObj);
  if (existing) return existing;
  const transport: HubWs = {
    send: (frame: string) => wsContext.send(frame),
    close: (code: number, reason: string) => wsContext.close(code, reason),
    getBufferedAmount: () => {
      const raw = wsContext.raw as { getBufferedAmount?: () => number } | null;
      return raw?.getBufferedAmount?.() ?? 0;
    },
    data: activityWsHub.makeConnectionData(roomId, preauthLuciaSessionId),
  };
  hubAdapters.set(keyObj, transport);
  return transport;
}

activitiesV2Routes.get(
  '/:id/rooms/:roomId/ws',
  upgradeWebSocket((c) => {
    const activityId = c.req.param('id') ?? '';
    const roomId = c.req.param('roomId') ?? '';

    if (!activityId || !getActivityDefinition(activityId)) {
      throw new HTTPException(404, { message: 'Activity not found' });
    }
    const room = activityRoomManager.getRoom(roomId);
    if (!room) {
      throw new HTTPException(404, { message: 'Room not found' });
    }
    if (room.activityId !== activityId) {
      throw new HTTPException(404, { message: 'Room not in activity' });
    }

    // Snapshot the Lucia session id from the upgrade request's Cookie
    // header. The handshake auth-frame sends a literal `'cookie'`
    // placeholder when the browser cookie is the auth source (the WS
    // upgrade attaches it automatically), and the hub swaps in this
    // resolved session id. Headless agent callers will leave this null
    // and pass their own session id in the auth frame instead. Captured
    // in this closure so each per-connection `onMessage` call sees the
    // same value (Hono's `c` is request-scoped, so the cookie reading
    // must happen here, not inside the message handler).
    const luciaCookieSessionId =
      lucia.readSessionCookie(c.req.header('Cookie') ?? '') ?? null;

    return {
      async onMessage(evt, ws) {
        const adapter = getOrMakeAdapter(
          {
            send: (src: string) => ws.send(src),
            close: (code: number, reason: string) => ws.close(code, reason),
            raw: ws.raw ?? ws,
          },
          roomId,
          luciaCookieSessionId,
        );
        const raw: string | ArrayBuffer | Uint8Array =
          typeof evt.data === 'string'
            ? evt.data
            : evt.data instanceof ArrayBuffer
              ? evt.data
              : new Uint8Array(evt.data as ArrayBufferLike);
        await activityWsHub.handleMessage(adapter, raw);
      },
      onClose(_evt, ws) {
        const keyObj = (ws.raw as object | undefined) ?? (ws as unknown as object);
        const adapter = hubAdapters.get(keyObj);
        if (adapter) {
          activityWsHub.unregisterConnection(adapter);
          hubAdapters.delete(keyObj);
        }
      },
      onError(_evt, ws) {
        const keyObj = (ws.raw as object | undefined) ?? (ws as unknown as object);
        const adapter = hubAdapters.get(keyObj);
        if (adapter) {
          activityWsHub.unregisterConnection(adapter);
          hubAdapters.delete(keyObj);
        }
      },
    };
  }),
);

// ─── Chunk #7 — reward pipeline + per-activity leaderboards ────────────────
// (Specific GET routes /seasons and /me/recent-results were hoisted above
// /:id at the top of this file — Hono matches in registration order.)

/**
 * `GET /api/activities/:id/rooms/:roomId/results` — auth'd; returns the
 * full result roster for a room. Caller must have been a participant OR
 * an admin (admin gating left for the dashboard surface — chunk #7
 * scope = participant-only).
 */
activitiesV2Routes.get(
  '/:id/rooms/:roomId/results',
  requireAuthOrAgentSession,
  async (c) => {
    const id = c.req.param('id');
    const roomIdRaw = c.req.param('roomId');
    const roomIdParse = roomIdParamSchema.safeParse(roomIdRaw);
    if (!roomIdParse.success) {
      throw new HTTPException(400, { message: 'Invalid roomId' });
    }
    const identity = c.get('identity');
    const roomId = roomIdParse.data;

    // Participant gate: prefer the in-memory map (covers the RESULTS
    // retention window); fall back to DB query for already-GC'd rooms.
    const memRoom = activityRoomManager.getRoom(roomId);
    let isParticipant = false;
    if (memRoom) {
      isParticipant = memRoom.participants.has(identity.avatarId);
    } else {
      const [own] = await db
        .select({ id: activityResults.id })
        .from(activityResults)
        .where(
          and(
            eq(activityResults.roomId, roomId),
            eq(activityResults.avatarId, identity.avatarId),
          ),
        )
        .limit(1);
      isParticipant = !!own;
    }
    if (!isParticipant) {
      throw new HTTPException(403, {
        message: 'Not a participant in this room',
      });
    }

    const [roomRow] = await db
      .select()
      .from(activityRooms)
      .where(eq(activityRooms.id, roomId))
      .limit(1);
    if (!roomRow) throw new HTTPException(404, { message: 'Room not found' });
    if (roomRow.activityId !== id) {
      throw new HTTPException(404, { message: 'Room not in activity' });
    }

    const resultRows = await db
      .select({
        id: activityResults.id,
        avatarId: activityResults.avatarId,
        agentId: activityResults.agentId,
        subjectType: activityResults.subjectType,
        placement: activityResults.placement,
        score: activityResults.score,
        scoreMs: activityResults.scoreMs,
        tokensAwarded: activityResults.tokensAwarded,
        leaderboardPoints: activityResults.leaderboardPoints,
        isPersonalBest: activityResults.isPersonalBest,
        createdAt: activityResults.createdAt,
        // Phase 4 — Reef Race surfaces. Null on Bumper Shells rows.
        matchBestStreak: activityResults.matchBestStreak,
        matchPbDailyRank: activityResults.matchPbDailyRank,
      })
      .from(activityResults)
      .where(eq(activityResults.roomId, roomId))
      .orderBy(activityResults.placement);

    // Join avatar display names so the UI doesn't have to round-trip per row.
    const avatarIds = resultRows.map((r) => r.avatarId);
    const namesById = new Map<string, string>();
    if (avatarIds.length > 0) {
      const avatarRows = await db
        .select({ id: avatars.id, name: avatars.name })
        .from(avatars)
        .where(avatarInList(avatarIds));
      for (const p of avatarRows) namesById.set(p.id, p.name);
    }

    return c.json({
      room: {
        id: roomRow.id,
        activityId: roomRow.activityId,
        shortCode: roomRow.shortCode,
        status: roomRow.status,
        startedAt: roomRow.startedAt,
        endedAt: roomRow.endedAt,
      },
      results: resultRows.map((r) => ({
        resultId: r.id,
        avatarId: r.avatarId,
        agentId: r.agentId,
        displayName: namesById.get(r.avatarId) ?? r.avatarId.slice(0, 8),
        subjectType: r.subjectType,
        placement: r.placement,
        score: r.score,
        scoreMs: r.scoreMs,
        tokensAwarded: r.tokensAwarded,
        leaderboardPoints: r.leaderboardPoints,
        isPersonalBest: r.isPersonalBest,
        createdAt: r.createdAt,
        // Phase 4 — Reef Race per-row extensions. Null on Bumper Shells.
        matchBestStreak: r.matchBestStreak,
        matchPbDailyRank: r.matchPbDailyRank,
      })),
    });
  },
);

/**
 * `POST /api/activities/results/:resultId/acknowledge` — caller marks
 * their own result row as seen. Idempotent — second call is a no-op.
 */
activitiesV2Routes.post(
  '/results/:resultId/acknowledge',
  requireAuthOrAgentSession,
  async (c) => {
    const resultIdParse = z.string().uuid().safeParse(c.req.param('resultId'));
    if (!resultIdParse.success) {
      throw new HTTPException(400, { message: 'Invalid resultId' });
    }
    const identity = c.get('identity');

    const [row] = await db
      .select({
        id: activityResults.id,
        avatarId: activityResults.avatarId,
        acknowledgedAt: activityResults.acknowledgedAt,
      })
      .from(activityResults)
      .where(eq(activityResults.id, resultIdParse.data))
      .limit(1);
    if (!row) throw new HTTPException(404, { message: 'Result not found' });
    if (row.avatarId !== identity.avatarId) {
      throw new HTTPException(403, { message: 'Not your result' });
    }
    if (row.acknowledgedAt) {
      return c.json({ ok: true, alreadyAcknowledged: true });
    }

    await db
      .update(activityResults)
      .set({ acknowledgedAt: new Date() })
      .where(eq(activityResults.id, row.id));

    return c.json({ ok: true });
  },
);

/**
 * `GET /api/activities/:id/leaderboard?window=...&limit=&offset=` — public.
 * 60s cached, rate-limited 60/min/IP, bots excluded.
 */
activitiesV2Routes.get('/:id/leaderboard', async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!publicReadLimiter.check(ip)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const id = c.req.param('id');
  if (!getActivityDefinition(id)) {
    throw new HTTPException(404, { message: 'Activity not found' });
  }
  const window = parseWindow(c.req.query('window'));
  const limit = clampInt(c.req.query('limit'), 100, 1, 100);
  const offset = clampInt(c.req.query('offset'), 0, 0, 10_000);

  const snapshot = await getLeaderboardSnapshot(id, window, limit, offset);
  c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  return c.json(snapshot);
});

/**
 * `GET /api/activities/:id/leaderboard/me?window=...&context=N` — auth'd.
 * Returns caller's row + N above + N below (default N=5).
 */
activitiesV2Routes.get(
  '/:id/leaderboard/me',
  requireAuthOrAgentSession,
  async (c) => {
    const id = c.req.param('id');
    if (!getActivityDefinition(id)) {
      throw new HTTPException(404, { message: 'Activity not found' });
    }
    const window = parseWindow(c.req.query('window'));
    const context = clampInt(c.req.query('context'), 5, 0, 25);
    const identity = c.get('identity');

    const result = await getLeaderboardForAvatar(id, window, identity.avatarId, context);
    return c.json({
      activityId: id,
      window,
      season: result.snapshot.season,
      generatedAt: result.snapshot.generatedAt,
      myRank: result.myRank,
      myEntry: result.myEntry,
      context: result.context,
    });
  },
);

activitiesV2Routes.get('/:id/replays/:replayId', (c) => {
  // TODO chunk #5: replay log owns activity_replays.frames flush + read.
  return c.json(
    { error: 'not_implemented', detail: 'Replay download ships in chunk #5' },
    501,
  );
});

// ─── Helpers ───────────────────────────────────────────────────────────────

async function serializeParty(
  party: ReturnType<typeof activityQueueService.getParty>,
) {
  if (!party) return null;
  const memberAvatarIds = Array.from(party.members);
  const namesById = new Map<string, string>();
  if (memberAvatarIds.length > 0) {
    const avatarRows = await db
      .select({ id: avatars.id, name: avatars.name })
      .from(avatars)
      .where(avatarInList(memberAvatarIds));
    for (const avatar of avatarRows) namesById.set(avatar.id, avatar.name);
  }

  return {
    id: party.id,
    shortCode: party.shortCode,
    leaderAvatarId: party.leaderAvatarId,
    members: memberAvatarIds.map((avatarId) => ({
      avatarId,
      displayName: namesById.get(avatarId) ?? avatarId.slice(0, 8),
    })),
    createdAt: party.createdAt,
    cap: MAX_PARTY_SIZE,
  };
}

/**
 * Translate a queue-service error into the right HTTP response. Capacity
 * errors map to 503 with `Retry-After: 10`; everything else is a 400-tier
 * client error.
 */
function handleQueueError(err: unknown): never {
  if (err instanceof RoomCapacityError) {
    throw new HTTPException(503, { message: err.message });
  }
  const codedErr = err as Error & { code?: string };
  if (codedErr.code === 'pod_capacity' || codedErr.code === 'activity_capacity') {
    throw new HTTPException(503, { message: codedErr.message });
  }
  if (err instanceof Error) {
    throw new HTTPException(400, { message: err.message });
  }
  throw new HTTPException(500, { message: 'Unknown queue error' });
}

function asHttpException(err: unknown, defaultStatus: 400 | 403 | 404 | 409): HTTPException {
  if (err instanceof HTTPException) return err;
  const message = err instanceof Error ? err.message : 'Request failed';
  return new HTTPException(defaultStatus, { message });
}

// ─── Chunk #7 helpers ──────────────────────────────────────────────────────

function parseWindow(raw: string | undefined): ActivityLeaderboardWindow {
  const v = (raw ?? 'all').toLowerCase();
  return (VALID_WINDOWS as readonly string[]).includes(v)
    ? (v as ActivityLeaderboardWindow)
    : 'all';
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function avatarInList(avatarIds: string[]): ReturnType<typeof sql> {
  if (avatarIds.length === 0) return sql`false`;
  return sql`${avatars.id} in (${sql.join(
    avatarIds.map((id) => sql`${id}`),
    sql.raw(', '),
  )})`;
}
