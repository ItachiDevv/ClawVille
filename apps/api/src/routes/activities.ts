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
 * `apps/api/src/routes/activity.ts` (a singular, pet activity-log
 * surface). The router exported here is `activitiesV2Routes` to avoid
 * the name collision, mounted at `/api/activities` (the OLDER
 * `activityRoutes` is mounted at `/api/pets`).
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { sessionMiddleware } from '../middleware/auth';
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
  ACTIVITY_REGISTRY,
  ACTIVITY_IDS,
  getActivityDefinition,
} from '@clawville/shared';
import type { AppContext } from '../types';

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
  .min(4)
  .max(10)
  .regex(/^[0-9A-Za-z]+$/);

const kickBodySchema = z.object({
  petId: z.string().uuid(),
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
  const { partyId = null, allowBotBackfill = true, agentOnly = false } = parsed.data;

  const identity = c.get('identity');

  // If a party is supplied, enforce leader-only enqueue (party joins
  // queue atomically as a unit).
  if (partyId) {
    const party = activityQueueService.getParty(partyId);
    if (!party) throw new HTTPException(404, { message: 'Party not found' });
    if (party.leaderPetId !== identity.petId) {
      throw new HTTPException(403, {
        message: 'Only the party leader can queue the party',
      });
    }
    if (party.members.size > def.maxPlayers) {
      throw new HTTPException(400, {
        message: `Party of ${party.members.size} exceeds activity max ${def.maxPlayers}`,
      });
    }

    // Enqueue every member. Each pet's userId/agentId is unknown for
    // members beyond the leader — chunk #2 stubs them as the leader's
    // identity (server uses petId for all routing). Chunk #3 will add a
    // proper member-identity-resolution helper when WS auth lights up.
    const memberPetIds = Array.from(party.members);
    try {
      for (const memberPetId of memberPetIds) {
        await activityQueueService.enqueue({
          activityId: id,
          petId: memberPetId,
          userId: memberPetId === identity.petId ? identity.userId : null,
          agentId: memberPetId === identity.petId ? identity.agentId : null,
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
      queued: memberPetIds.length,
      activityId: id,
      partyId,
    });
  }

  // Solo enqueue.
  try {
    const entry = await activityQueueService.enqueue({
      activityId: id,
      petId: identity.petId,
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

  // Idempotent — leaveQueue returns false if the pet wasn't in the queue.
  const removed = await activityQueueService.leaveQueue(identity.petId, 'voluntary');
  return c.json({ ok: true, removed });
});

// ─── GET /api/activities/:id/queue-status ──────────────────────────────────

activitiesV2Routes.get('/:id/queue-status', requireAuthOrAgentSession, async (c) => {
  const id = c.req.param('id');
  const def = getActivityDefinition(id);
  if (!def) throw new HTTPException(404, { message: 'Activity not found' });

  const identity = c.get('identity');
  const status = activityQueueService.getQueueStatus(id, identity.petId);
  return c.json(status);
});

// ─── Party routes ──────────────────────────────────────────────────────────

activitiesV2Routes.post('/party', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');

  const body = await c.req.json().catch(() => ({}));
  const parsed = createPartyBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'Invalid request body' });
  }

  // Reject if already in a party — server is the source of truth.
  const existing = activityQueueService.partyForPet(identity.petId);
  if (existing) {
    return c.json({
      ok: true,
      party: serializeParty(existing),
      alreadyInParty: true,
    });
  }

  const party = await activityQueueService.createParty(identity.petId);
  return c.json({ ok: true, party: serializeParty(party) });
});

activitiesV2Routes.post('/party/:shortCode/join', requireAuthOrAgentSession, async (c) => {
  const shortCodeParse = partyShortCodeParamSchema.safeParse(c.req.param('shortCode'));
  if (!shortCodeParse.success) {
    throw new HTTPException(400, { message: 'Invalid party short code' });
  }
  const identity = c.get('identity');

  try {
    const party = await activityQueueService.joinParty(shortCodeParse.data, identity.petId);
    return c.json({ ok: true, party: serializeParty(party) });
  } catch (err) {
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
    throw new HTTPException(400, { message: 'Body must include petId' });
  }

  const identity = c.get('identity');
  try {
    const party = await activityQueueService.kickMember(
      partyIdParse.data,
      identity.petId,
      bodyParse.data.petId,
    );
    return c.json({ ok: true, party: serializeParty(party) });
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
  await activityQueueService.leaveParty(partyIdParse.data, identity.petId);
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
    if (!room.participants.has(identity.petId)) {
      throw new HTTPException(403, { message: 'Not a participant in this room' });
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
          petId: p.petId,
          subjectType: p.subjectType,
          connected: p.connected,
        })),
      },
    });
  },
);

// ─── Stubs — chunks #3, #5, #7 ─────────────────────────────────────────────
//
// All of these compile and return 501 today so the route table reads true
// when chunk #2 ships. Each call site stubs to its owning chunk for clean
// PR-time grep + remove.

activitiesV2Routes.all('/:id/rooms/:roomId/ws', (c) => {
  // TODO chunk #3: WebSocket upgrade handler (Bun native via hono/bun).
  return c.json(
    { error: 'not_implemented', detail: 'WebSocket hub ships in chunk #3' },
    501,
  );
});

activitiesV2Routes.get('/:id/rooms/:roomId/results', (c) => {
  // TODO chunk #7: reward pipeline owns activity_results rows + this read.
  return c.json(
    { error: 'not_implemented', detail: 'Match results ship in chunk #7 (reward pipeline)' },
    501,
  );
});

activitiesV2Routes.get('/me/recent-results', (c) => {
  // TODO chunk #7
  return c.json(
    { error: 'not_implemented', detail: 'Recent results ship in chunk #7' },
    501,
  );
});

activitiesV2Routes.post('/results/:resultId/acknowledge', (c) => {
  // TODO chunk #7
  return c.json(
    { error: 'not_implemented', detail: 'Result acknowledgement ships in chunk #7' },
    501,
  );
});

activitiesV2Routes.get('/:id/leaderboard', (c) => {
  // TODO chunk #7: per-activity leaderboard with daily/weekly/all/season windows.
  return c.json(
    { error: 'not_implemented', detail: 'Per-activity leaderboard ships in chunk #7' },
    501,
  );
});

activitiesV2Routes.get('/:id/leaderboard/me', (c) => {
  // TODO chunk #7
  return c.json(
    { error: 'not_implemented', detail: 'Include-me leaderboard ships in chunk #7' },
    501,
  );
});

activitiesV2Routes.get('/:id/replays/:replayId', (c) => {
  // TODO chunk #5: replay log owns activity_replays.frames flush + read.
  return c.json(
    { error: 'not_implemented', detail: 'Replay download ships in chunk #5' },
    501,
  );
});

activitiesV2Routes.get('/seasons', (c) => {
  // TODO chunk #7: season catalog read against activity_seasons.
  return c.json(
    { error: 'not_implemented', detail: 'Season catalog ships in chunk #7' },
    501,
  );
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function serializeParty(party: ReturnType<typeof activityQueueService.getParty>): unknown {
  if (!party) return null;
  return {
    id: party.id,
    shortCode: party.shortCode,
    leaderPetId: party.leaderPetId,
    members: Array.from(party.members),
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
