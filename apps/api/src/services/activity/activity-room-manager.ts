/**
 * Q2 Activity Portals — room manager singleton.
 *
 * ─── Single-pod constraint (backend §1.7) ──────────────────────────────────
 * The activity system lives entirely on the Hono API pod as in-memory
 * state. Coolify currently runs 1 replica of the API app on 1 Hetzner
 * VPS. Adding a second pod REQUIRES sticky-routing or shared Redis
 * pub/sub. Multi-pod scaling is a deliberate Q3 concern. Every place
 * this assumption is encoded is called out with a `// SINGLE-POD:`
 * marker for the future extraction work.
 *
 * Pattern mirrors `agent-orchestrator.ts`:
 *   - Module-level singleton (`activityRoomManager`)
 *   - Long-lived `Map` of in-flight rooms
 *   - Periodic sweeper (`roomSweeper`) at 15s intervals
 *
 * DB write points (backend §1.3):
 *   1. PENDING → COUNTDOWN — insert `activity_rooms` + participants
 *   2. LIVE    → RESULTS   — update `ended_at`, insert `activity_results`,
 *                            flush replay log (replay flush deferred to
 *                            chunk #3 — log doesn't exist yet)
 *   3. RESULTS → GC        — `status='completed'`
 *
 * No per-tick DB writes during LIVE — would kill the pool at 50Hz × 8 × 50.
 *
 * Chunk #2 caveats (TODOs scattered for later chunks):
 *   - Replay log flush is a `// TODO chunk #3` — log lives in the WS hub
 *   - Reward issuance is a `// TODO chunk #7` — pipeline owns crediting
 *   - Match.found broadcast routes through a registered `MatchFoundDelivery`
 *     callback so chunk #3's WS hub can drop in without circular import
 */

import { eq, inArray } from 'drizzle-orm';
import {
  db,
  activityRooms,
  activityRoomParticipants,
} from '@clawville/database';
import type { Room, RoomState, RoomDbStatus, RoomParticipant, MatchFoundDeliveryFn, RoomBroadcastFn } from './types';
import { logEvent } from '../event-logger';
import { alertError } from '../alert-error';
import type { ServerFrame } from '@clawville/shared';
import { v4 as uuidv4 } from 'uuid';

// ─── Constants (backend §1.5, §1.6) ────────────────────────────────────────

/** Per-activity ceiling on concurrent rooms (backend §1.5) */
export const MAX_ROOMS_PER_ACTIVITY = 50;

/** Hard pod-wide ceiling on concurrent rooms (backend §1.5) */
export const MAX_ROOMS_TOTAL = 200;

/** PENDING rooms with 0 players older than this are killed (backend §1.6) */
const PENDING_EMPTY_TTL_MS = 90_000;

/** LIVE rooms with no live WS for > this duration are killed (backend §1.6) */
const LIVE_NO_WS_TTL_MS = 30_000;

/** RESULTS rooms older than this are GC'd regardless of viewers (backend §1.6) */
const RESULTS_RETENTION_MS = 120_000;

/** Sweep cadence — every 15s (backend §1.6) */
const SWEEPER_INTERVAL_MS = 15_000;

/** Countdown duration before sim starts (backend §1.2) */
const COUNTDOWN_DURATION_MS = 5_000;

/** Crockford base32 alphabet (no I, L, O, U) — short-code character set */
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Short-code length — 6 chars × 32 = 32^6 ≈ 1B unique codes */
const SHORT_CODE_LENGTH = 6;

/** How many times to retry short-code generation on collision */
const SHORT_CODE_RETRY = 16;

/** Allowed FSM transitions — guard against typos in code paths */
const VALID_TRANSITIONS: Record<RoomState, ReadonlySet<RoomState>> = {
  pending: new Set<RoomState>(['countdown', 'aborted']),
  countdown: new Set<RoomState>(['live', 'aborted']),
  live: new Set<RoomState>(['results', 'aborted_crash']),
  results: new Set<RoomState>(['gc']),
  gc: new Set<RoomState>(),
  aborted: new Set<RoomState>(),
  aborted_crash: new Set<RoomState>(),
};

// ─── Module-level singleton state ──────────────────────────────────────────

class ActivityRoomManager {
  /** SINGLE-POD: in-memory room map. Hoist to Redis for multi-pod. */
  private rooms = new Map<string, Room>();

  /** SINGLE-POD: short-code → roomId index for collision-free generation. */
  private shortCodeIndex = new Map<string, string>();

  /** SINGLE-POD: petId → roomId index for "my active room" lookups. */
  private playerToRoom = new Map<string, string>();

  /**
   * Hub-broadcast callback — registered by the WS hub at boot (chunk #3).
   * The manager calls this when the FSM ticks but doesn't import the hub
   * directly to avoid a cycle.
   */
  private broadcastFn: RoomBroadcastFn = () => {
    /* no-op until WS hub registers (chunk #3) */
  };

  /** Match-found delivery callback — registered by queue/WS hub. */
  private matchFoundFn: MatchFoundDeliveryFn = () => {
    /* no-op until WS hub registers (chunk #3) */
  };

  private sweeperHandle: ReturnType<typeof setInterval> | null = null;

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Allocate a new room from a list of matchmaker-selected participants.
   *
   * Inserts the DB row immediately at COUNTDOWN. Throws if concurrency
   * caps are hit so the queue can surface a 503 to the caller.
   *
   * `match.found` delivery is fanned out via the registered callback —
   * for chunk #2 this is a no-op until chunk #3 lights up the WS hub.
   */
  async createRoom(
    activityId: string,
    participants: Array<Omit<RoomParticipant, 'connected' | 'disconnectedAt' | 'wsConnectionId' | 'joinedAt'>>,
    activityConfig: Room['activityConfig'],
  ): Promise<Room> {
    if (this.rooms.size >= MAX_ROOMS_TOTAL) {
      throw new RoomCapacityError('pod_capacity', 'Pod-wide room cap hit');
    }
    const activityCount = Array.from(this.rooms.values()).filter(
      (r) => r.activityId === activityId && r.state !== 'gc' && r.state !== 'aborted' && r.state !== 'aborted_crash',
    ).length;
    if (activityCount >= MAX_ROOMS_PER_ACTIVITY) {
      throw new RoomCapacityError('activity_capacity', 'Per-activity room cap hit');
    }
    if (participants.length === 0) {
      throw new Error('createRoom requires at least one participant');
    }
    if (participants.length > activityConfig.maxPlayers) {
      throw new Error(
        `Too many participants (${participants.length}) for activity max ${activityConfig.maxPlayers}`,
      );
    }

    const roomId = uuidv4();
    const shortCode = this.generateShortCode();
    const now = Date.now();

    const participantsMap = new Map<string, RoomParticipant>();
    let hasBots = false;
    let hasAgents = false;
    for (const p of participants) {
      participantsMap.set(p.petId, {
        ...p,
        joinedAt: now,
        connected: false,
        disconnectedAt: null,
        wsConnectionId: null,
      });
      if (p.subjectType === 'bot') hasBots = true;
      if (p.subjectType === 'agent') hasAgents = true;
    }

    const room: Room = {
      id: roomId,
      shortCode,
      activityId,
      state: 'pending',
      participants: participantsMap,
      countdownStartedAt: null,
      startedAt: null,
      endedAt: null,
      createdAt: now,
      lastTouchedAt: now,
      hasBots,
      hasAgents,
      activityConfig,
    };

    this.rooms.set(roomId, room);
    this.shortCodeIndex.set(shortCode, roomId);
    for (const petId of participantsMap.keys()) {
      this.playerToRoom.set(petId, roomId);
    }

    // PENDING is a transient in-memory step; immediately transition to
    // COUNTDOWN so the DB row exists and clients can start the countdown UX.
    await this.transitionRoom(roomId, 'countdown');

    // Fan out match.found via the registered hub callback. The actual
    // WS message ships in chunk #3; for chunk #2 this is a no-op.
    for (const p of participantsMap.values()) {
      if (p.wsConnectionId) {
        this.matchFoundFn(p.wsConnectionId, {
          roomId,
          shortCode,
          activityId,
          countdown: COUNTDOWN_DURATION_MS / 1000,
        });
      }
    }

    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getRoomByShortCode(shortCode: string): Room | undefined {
    const id = this.shortCodeIndex.get(shortCode.toUpperCase());
    return id ? this.rooms.get(id) : undefined;
  }

  /**
   * All rooms for an activity that are NOT in a terminal state.
   * Used by `GET /api/activities` for live counts + cap enforcement.
   */
  listActiveRooms(activityId: string): Room[] {
    return Array.from(this.rooms.values()).filter(
      (r) =>
        r.activityId === activityId &&
        r.state !== 'gc' &&
        r.state !== 'aborted' &&
        r.state !== 'aborted_crash',
    );
  }

  /** Total active rooms across all activities (for capacity calc) */
  totalActiveRooms(): number {
    return Array.from(this.rooms.values()).filter(
      (r) => r.state !== 'gc' && r.state !== 'aborted' && r.state !== 'aborted_crash',
    ).length;
  }

  /**
   * Look up the room a pet is currently in (across all activities).
   * Used by /me endpoints + the queue Sybil checks.
   */
  getPlayerActiveRoom(petId: string): Room | undefined {
    const id = this.playerToRoom.get(petId);
    if (!id) return undefined;
    const room = this.rooms.get(id);
    if (!room || room.state === 'gc' || room.state === 'aborted' || room.state === 'aborted_crash') {
      this.playerToRoom.delete(petId);
      return undefined;
    }
    return room;
  }

  /**
   * Drive a room through its FSM. Validates the transition is allowed
   * before performing DB writes — invalid transitions throw and emit
   * a flag event so we catch typos in the route handlers.
   */
  async transitionRoom(roomId: string, toState: RoomState): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`transitionRoom: unknown room ${roomId}`);

    const allowed = VALID_TRANSITIONS[room.state];
    if (!allowed.has(toState)) {
      throw new Error(
        `Invalid transition ${room.state} → ${toState} for room ${roomId}`,
      );
    }

    const now = Date.now();
    const fromState = room.state;
    room.state = toState;
    room.lastTouchedAt = now;

    try {
      switch (toState) {
        case 'countdown':
          room.countdownStartedAt = now;
          await this.persistCountdownTransition(room);
          break;
        case 'live':
          room.startedAt = now;
          await this.persistLiveTransition(room);
          break;
        case 'results':
          room.endedAt = now;
          await this.persistResultsTransition(room);
          break;
        case 'gc':
          await this.persistGcTransition(room);
          this.evictRoom(room);
          break;
        case 'aborted':
          await this.persistAbortedTransition(room, 'aborted');
          this.evictRoom(room);
          break;
        case 'aborted_crash':
          await this.persistAbortedTransition(room, 'aborted_crash');
          this.evictRoom(room);
          break;
        case 'pending':
          // pending is the in-memory initial — never a target of transition
          break;
      }
    } catch (err) {
      // Persistence failed — roll back the in-memory state so we don't
      // serve a room that doesn't exist in the DB.
      room.state = fromState;
      console.error('[activity-room-manager] transition persistence failed:', err);
      throw err;
    }

    // Broadcast an FSM-state event for hub-attached clients (chunk #3).
    // The hub callback handles missing connections silently.
    this.broadcastFn(roomId, this.fsmEventFrame(room, toState));
  }

  /**
   * Sweeper — invoked every 15s by the interval registered on first
   * use. Pure cleanup; never throws (errors logged + metric-emitted so
   * a bad row doesn't kill the cron loop).
   *
   * Public so tests can drive ticks directly.
   */
  async roomSweeper(): Promise<void> {
    const now = Date.now();
    const toAbort: Room[] = [];
    const toGc: Room[] = [];

    for (const room of this.rooms.values()) {
      switch (room.state) {
        case 'pending': {
          if (
            now - room.createdAt > PENDING_EMPTY_TTL_MS &&
            this.connectedCount(room) === 0
          ) {
            toAbort.push(room);
          }
          break;
        }
        case 'countdown': {
          if (this.connectedCount(room) === 0) {
            toAbort.push(room);
          }
          break;
        }
        case 'live': {
          if (
            this.connectedCount(room) === 0 &&
            now - room.lastTouchedAt > LIVE_NO_WS_TTL_MS
          ) {
            toAbort.push(room);
          }
          break;
        }
        case 'results': {
          if (now - (room.endedAt ?? room.lastTouchedAt) > RESULTS_RETENTION_MS) {
            toGc.push(room);
          }
          break;
        }
        // gc / aborted / aborted_crash: already evicted from this.rooms,
        // but defensively cover stragglers.
        case 'gc':
        case 'aborted':
        case 'aborted_crash': {
          this.evictRoom(room);
          break;
        }
      }
    }

    for (const room of toAbort) {
      try {
        await this.transitionRoom(room.id, 'aborted');
        await logEvent({
          eventType: 'activity.match.swept',
          payload: {
            activityId: room.activityId,
            roomId: room.id,
            reason: room.state === 'live' ? 'live_no_ws' : 'pending_empty',
            playerCount: room.participants.size,
          },
        });
      } catch (err) {
        console.error('[activity-room-manager] sweeper abort failed:', err);
      }
    }
    for (const room of toGc) {
      try {
        await this.transitionRoom(room.id, 'gc');
      } catch (err) {
        console.error('[activity-room-manager] sweeper GC failed:', err);
      }
    }
  }

  /**
   * Register the WS hub broadcast callback. Called once at API boot
   * by chunk #3 — until then the manager runs against the no-op default.
   */
  setBroadcastFn(fn: RoomBroadcastFn): void {
    this.broadcastFn = fn;
  }

  /** Register the queue-side match-found delivery callback. */
  setMatchFoundFn(fn: MatchFoundDeliveryFn): void {
    this.matchFoundFn = fn;
  }

  /** Boot-time: start the sweeper interval. Safe to call repeatedly. */
  startSweeper(): void {
    if (this.sweeperHandle) return;
    this.sweeperHandle = setInterval(() => {
      void this.roomSweeper();
    }, SWEEPER_INTERVAL_MS);
  }

  /** Shutdown hook (graceful SIGTERM). */
  stopSweeper(): void {
    if (this.sweeperHandle) {
      clearInterval(this.sweeperHandle);
      this.sweeperHandle = null;
    }
  }

  /**
   * Boot-time recovery — mark any orphaned LIVE/COUNTDOWN rows from a
   * previous (crashed) pod as `aborted_crash`. Backend §12.1.
   *
   * Awaits a single bulk UPDATE so it doesn't block startup beyond the
   * one round-trip. Safe to call once at module load.
   */
  async recoverOrphanedRooms(): Promise<void> {
    try {
      // Every COUNTDOWN/LIVE row at boot time is necessarily orphaned —
      // we have no in-memory state, so any "live" row in the DB came from
      // a prior pod that crashed before transitioning to RESULTS.
      const orphaned = await db
        .select({ id: activityRooms.id, activityId: activityRooms.activityId })
        .from(activityRooms)
        .where(inArray(activityRooms.status, ['countdown', 'live']));
      if (orphaned.length === 0) return;

      await db
        .update(activityRooms)
        .set({ status: 'aborted_crash', endedAt: new Date() })
        .where(
          inArray(
            activityRooms.id,
            orphaned.map((r) => r.id),
          ),
        );

      for (const row of orphaned) {
        void logEvent({
          eventType: 'activity.match.aborted_crash',
          payload: {
            activityId: row.activityId,
            roomId: row.id,
            recoveredAt: new Date().toISOString(),
            reason: 'pod_restart_orphan',
          },
        });
      }

      void alertError({
        severity: 'warning',
        source: 'activity-room-manager',
        message: `Recovered ${orphaned.length} orphaned activity rooms on boot — marked as aborted_crash`,
        context: { count: orphaned.length },
      });
    } catch (err) {
      console.error('[activity-room-manager] orphan recovery failed:', err);
    }
  }

  /** Test hook — clear all in-memory state. */
  __resetForTest(): void {
    this.rooms.clear();
    this.shortCodeIndex.clear();
    this.playerToRoom.clear();
  }

  // ─── Persistence helpers ────────────────────────────────────────────────

  private async persistCountdownTransition(room: Room): Promise<void> {
    await db.insert(activityRooms).values({
      id: room.id,
      activityId: room.activityId,
      shortCode: room.shortCode,
      status: 'countdown' satisfies RoomDbStatus,
      playerCount: room.participants.size,
      hasBots: room.hasBots,
      hasAgents: room.hasAgents,
      createdAt: new Date(room.createdAt),
    });

    const participantRows = Array.from(room.participants.values()).map((p) => ({
      roomId: room.id,
      petId: p.petId,
      agentId: p.agentId,
      subjectType: p.subjectType,
      joinedAt: new Date(p.joinedAt),
    }));
    await db.insert(activityRoomParticipants).values(participantRows);
  }

  private async persistLiveTransition(room: Room): Promise<void> {
    await db
      .update(activityRooms)
      .set({
        status: 'live' satisfies RoomDbStatus,
        startedAt: new Date(room.startedAt!),
      })
      .where(eq(activityRooms.id, room.id));
    void logEvent({
      eventType: 'activity.match.started',
      payload: {
        activityId: room.activityId,
        roomId: room.id,
        participantCount: room.participants.size,
        hasBots: room.hasBots,
        hasAgents: room.hasAgents,
      },
    });
  }

  private async persistResultsTransition(room: Room): Promise<void> {
    await db
      .update(activityRooms)
      .set({
        // We don't flip to 'completed' yet — RESULTS→GC owns that. The
        // ended_at lights up so leaderboard windows can include this match.
        endedAt: new Date(room.endedAt!),
      })
      .where(eq(activityRooms.id, room.id));

    // TODO chunk #3: flush replay log (input frame ring buffer) into
    // activity_replays.frames here. The buffer is owned by the WS hub,
    // so the manager doesn't see it from this side of the cycle.
    //
    // TODO chunk #7: derive placements + write activity_results rows +
    // credit ClawTokens via the existing ledger helper + emit one
    // `activity.match.placed` event per participant. That whole settlement
    // block is the reward pipeline's chunk.

    void logEvent({
      eventType: 'activity.match.ended',
      payload: {
        activityId: room.activityId,
        roomId: room.id,
        durationMs: (room.endedAt ?? Date.now()) - (room.startedAt ?? room.createdAt),
        // `complete` is the default — chunk #7 derives the actual reason.
        reason: 'complete',
      },
    });
  }

  private async persistGcTransition(room: Room): Promise<void> {
    await db
      .update(activityRooms)
      .set({ status: 'completed' satisfies RoomDbStatus })
      .where(eq(activityRooms.id, room.id));
  }

  private async persistAbortedTransition(
    room: Room,
    status: 'aborted' | 'aborted_crash',
  ): Promise<void> {
    // Only update the DB row if it was previously persisted (PENDING never
    // hits the DB; rooms aborted before COUNTDOWN have nothing to update).
    if (!room.startedAt && room.state === 'aborted' && room.countdownStartedAt === null) {
      // Should not happen — we only reach 'aborted' after countdown insert
      // happened. Defensive log only.
    }
    await db
      .update(activityRooms)
      .set({ status, endedAt: new Date() })
      .where(eq(activityRooms.id, room.id))
      .catch((err) => {
        // If the row was never persisted (pure-PENDING abort with no
        // intermediate countdown), the where clause matches zero rows
        // — that's fine, swallow.
        console.warn('[activity-room-manager] aborted DB update no-op:', err);
      });

    if (status === 'aborted_crash') {
      void alertError({
        severity: 'critical',
        source: 'activity-room-manager',
        message: `Activity room aborted_crash — ${room.activityId} ${room.id}`,
        context: {
          activityId: room.activityId,
          roomId: room.id,
          participantCount: room.participants.size,
        },
      });
    }
  }

  private evictRoom(room: Room): void {
    this.rooms.delete(room.id);
    this.shortCodeIndex.delete(room.shortCode);
    for (const petId of room.participants.keys()) {
      // Only clear the index if it still points at this room — concurrent
      // requeue can have already updated it.
      if (this.playerToRoom.get(petId) === room.id) {
        this.playerToRoom.delete(petId);
      }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Crockford base32 short-code generator with collision retry.
   * Uses crypto.getRandomValues for unbiased character selection.
   * Throws if every retry collides — caller surfaces a 503 to the queue.
   */
  private generateShortCode(): string {
    for (let attempt = 0; attempt < SHORT_CODE_RETRY; attempt++) {
      const bytes = new Uint8Array(SHORT_CODE_LENGTH);
      crypto.getRandomValues(bytes);
      let code = '';
      for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
        code += CROCKFORD_BASE32[bytes[i] % CROCKFORD_BASE32.length];
      }
      if (!this.shortCodeIndex.has(code)) return code;
    }
    throw new Error(
      `Short-code generation exhausted after ${SHORT_CODE_RETRY} retries`,
    );
  }

  /** Counted via participant.connected; tracked by WS hub on connect/drop. */
  private connectedCount(room: Room): number {
    let count = 0;
    for (const p of room.participants.values()) {
      if (p.connected) count++;
    }
    return count;
  }

  private fsmEventFrame(room: Room, toState: RoomState): ServerFrame {
    switch (toState) {
      case 'countdown':
        return {
          type: 'event.countdown',
          secondsRemaining: COUNTDOWN_DURATION_MS / 1000,
        };
      case 'live':
        return { type: 'event.match_started', startedAt: room.startedAt ?? Date.now() };
      case 'results':
        return {
          type: 'event.match_ended',
          reason: 'complete',
          winners: [],
          rewardPreview: { placement: 0, tokens: 0, leaderboardPoints: 0 },
        };
      default:
        return {
          type: 'error',
          code: 'fsm_state_no_frame',
          message: `No client frame for transition to ${toState}`,
        };
    }
  }
}

/**
 * Specific error type so callers can catch + 503 cleanly.
 */
export class RoomCapacityError extends Error {
  constructor(
    public readonly kind: 'pod_capacity' | 'activity_capacity',
    message: string,
  ) {
    super(message);
    this.name = 'RoomCapacityError';
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────

export const activityRoomManager = new ActivityRoomManager();
