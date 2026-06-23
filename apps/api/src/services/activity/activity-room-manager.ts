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
import { activityReplayLog } from './activity-replay-log';
import type { ActivityReplayParticipantsJson } from '@clawville/database';
import {
  issueRewardsForRoom,
  type SimResultRow,
  type IssuedResult,
} from './reward-pipeline';
import {
  LAUNCH_WINDOW_MS,
  LAUNCH_STALL_WINDOW_MS,
} from './sim/reef-race-config';

// ─── Constants (backend §1.5, §1.6) ────────────────────────────────────────

/** Per-activity ceiling on concurrent rooms (backend §1.5) */
export const MAX_ROOMS_PER_ACTIVITY = 50;

/** Hard pod-wide ceiling on concurrent rooms (backend §1.5) */
export const MAX_ROOMS_TOTAL = 200;

/** PENDING rooms with 0 players older than this are killed (backend §1.6) */
const PENDING_EMPTY_TTL_MS = 90_000;

/** LIVE rooms with no live WS for > this duration are killed (backend §1.6) */
const LIVE_NO_WS_TTL_MS = 30_000;

/**
 * Activities whose LIVE rooms LEGITIMATELY have 0 connected WS sockets for long
 * stretches and must NOT be crash-swept on the 30s `LIVE_NO_WS_TTL_MS`. A poker
 * tournament table is the canonical case: between hands (and during the window
 * after seating but before a human/agent opens its socket) the room can sit with
 * zero live connections for minutes while the TournamentManager's per-table hand
 * loop keeps running server-side. Crash-aborting such a room would strand the
 * tournament's CT escrow. The TournamentManager owns these rooms' lifecycle
 * (it transitions them → results on table-break / completion), so the sweeper
 * leaves them alone entirely; they are NOT abandoned because their owner drives
 * them to a terminal state. (Poker MTT P4.)
 */
const LIVE_NO_WS_SWEEP_EXEMPT_ACTIVITIES: ReadonlySet<string> = new Set<string>([
  'texas-holdem-mtt',
]);

/** RESULTS rooms older than this are GC'd regardless of viewers (backend §1.6) */
const RESULTS_RETENTION_MS = 120_000;

/** Sweep cadence — every 15s (backend §1.6) */
const SWEEPER_INTERVAL_MS = 15_000;

/** Countdown duration before sim starts (backend §1.2) */
const COUNTDOWN_DURATION_MS = 5_000;

/**
 * Minimum countdown remainder a connecting client must still have for the
 * 3-2-1 overlay to be worth showing. Below this, `ensureSyncedCountdown()`
 * re-anchors the window to the connect time so navigation latency can't burn
 * the countdown before the client can render it. 3s = a full "3…2…1…GO".
 */
const COUNTDOWN_MIN_SYNC_MS = 3_000;

/** Crockford base32 alphabet (no I, L, O, U) — short-code character set */
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Short-code length — 6 chars × 32 = 32^6 ≈ 1B unique codes */
const SHORT_CODE_LENGTH = 6;

/** How many times to retry short-code generation on collision */
const SHORT_CODE_RETRY = 16;

/**
 * Room states that DON'T block a player from re-queueing. The match is
 * either over (`results`), being torn down (`gc`), or never ran cleanly
 * (`aborted`/`aborted_crash`). Anything outside this set means a live
 * match is in flight for the player.
 */
const NON_BLOCKING_ROOM_STATES: ReadonlySet<RoomState> = new Set<RoomState>([
  'results',
  'gc',
  'aborted',
  'aborted_crash',
]);

/**
 * Deterministic LCG launch-verdict synthesis for bot participants.
 *
 * Why deterministic: replays + leaderboard reproducibility. The same
 * (roomId, avatarId) pair always yields the same verdict, so a re-run of
 * the recorded inputs produces the same race shape.
 *
 * Why 50/50 boost/stall: half the bots get the launch advantage, half
 * eat the early-press penalty. Reads as "imperfect timing", same overall
 * pace as a human-only field where humans land in the boost window
 * roughly half the time and miss into the stall window the other half.
 *
 * Hash: djb2 (`(h*33) ^ char`) over `roomId|avatarId` → 32-bit unsigned.
 * Verdict: low bit determines boost (0) vs stall (1). djb2 already
 * decorrelates input bytes well; the low-bit slice is enough for a
 * fair coin flip across the avatarId space.
 *
 * Exported for direct unit testing — the room-manager singleton is
 * harder to set up in tests, but the function is pure.
 */
export function synthesizeBotLaunchVerdict(
  roomId: string,
  avatarId: string,
): 'boost' | 'stall' {
  const key = `${roomId}|${avatarId}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = (((h << 5) + h) ^ key.charCodeAt(i)) >>> 0;
  }
  return (h & 1) === 0 ? 'boost' : 'stall';
}

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

  /** SINGLE-POD: avatarId → roomId index for "my active room" lookups. */
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

  /**
   * LIVE-transition hook registered by the sim dispatcher. Called after
   * the DB update so the sim sees an authoritative `startedAt`. Avoids a
   * hard import of the sim from the manager.
   *
   * Phase 3 (audit C2) — signature widened to `Promise<void> | void` so
   * the matchmaker can `await loadRacingProfiles(...)` BEFORE invoking
   * `reefRaceSim.startRoom(...)`. Existing sync callers (bumper-shells,
   * arena) keep returning `void` and `await`-ing `void` is a no-op.
   */
  private liveTransitionFn: ((room: Room) => Promise<void> | void) | null =
    null;

  /**
   * Per-room countdown timers. Set when a room transitions into COUNTDOWN
   * and cleared when it transitions out (LIVE / ABORTED). Each timer
   * fires `transitionRoom(roomId, 'live')` after `COUNTDOWN_DURATION_MS`
   * — without this, the FSM would sit in COUNTDOWN forever (no other
   * code path moves rooms to LIVE in production; chunk #3 added the
   * COUNTDOWN state machine but never wired the timer that exits it).
   * Discovered 2026-04-24 when the first guests actually queued matches.
   */
  private countdownTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  /**
   * Eviction hook registered by chunk #10's bot pool wiring so reserved
   * bot avatarIds are returned to the pool when a room ends (any path —
   * RESULTS→GC, ABORTED, ABORTED_CRASH). Chunk #10.
   */
  private evictionFn: ((room: Room) => void) | null = null;

  /**
   * Abort-notification hook (Poker MTT P4). Fired with `(roomId, activityId)`
   * whenever a room transitions to `aborted` / `aborted_crash` — so an owner that
   * holds money/state behind the room (the TournamentManager, which escrows CT
   * for a tournament table) can recover (settle/refund) instead of stranding it.
   * Best-effort: the receiver's errors are swallowed (must never break a sweep).
   * Most activities don't register one (it stays a no-op).
   */
  private abortNotifyFn: ((roomId: string, activityId: string) => void) | null =
    null;

  /**
   * Per-activity sim → placement-list resolver. Registered at boot from
   * `apps/api/src/index.ts` so the room manager can reach the sim's
   * `computeResults()` without importing the sim directly (avoids the
   * circular-dep + lets future activities plug their own resolvers in).
   *
   * Returns an empty array when the activity has no registered resolver
   * (e.g. a sim wasn't started for this room — defensive). The reward
   * pipeline treats an empty list as "nothing to credit".
   */
  private computeResultsFn: ((room: Room) => SimResultRow[]) | null = null;

  /**
   * Latest issued-rewards snapshot per room. Populated immediately after
   * `issueRewardsForRoom` succeeds inside `persistResultsTransition`. The
   * REST `/results` route reads from here while the room is still in the
   * RESULTS retention window, then falls back to a DB query once the
   * room GCs.
   */
  private lastResults = new Map<string, IssuedResult[]>();

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
      participantsMap.set(p.avatarId, {
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
      // Reef Race Phase 1 — populated lazily by recordPreLaunchInput() when
      // the first thrust=1.0 frame arrives during COUNTDOWN. Cleared by
      // computeLaunchVerdicts() at the LIVE transition (or by abort cleanup).
      preLaunchBuffer: null,
    };

    this.rooms.set(roomId, room);
    this.shortCodeIndex.set(shortCode, roomId);
    for (const avatarId of participantsMap.keys()) {
      this.playerToRoom.set(avatarId, roomId);
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
   * Look up the room an avatar is currently in (across all activities).
   * Used by /me endpoints + the queue Sybil checks.
   */
  getPlayerActiveRoom(avatarId: string): Room | undefined {
    const id = this.playerToRoom.get(avatarId);
    if (!id) return undefined;
    const room = this.rooms.get(id);
    // A room is no longer "active" the moment it leaves the play loop.
    // `results` is included in the not-blocking set: the match is over,
    // the player has seen the results modal, and they should be able
    // to re-queue immediately without waiting for the GC sweep. Without
    // this, a player who closes the tab right after the results screen
    // gets stuck in queue jail until the next sweeper run + GC tick.
    if (!room || NON_BLOCKING_ROOM_STATES.has(room.state)) {
      this.playerToRoom.delete(avatarId);
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

    // Any transition out of COUNTDOWN must cancel the pending auto-live
    // timer — otherwise an aborted-during-countdown room would still
    // try to flip itself to LIVE after the participant fled.
    if (fromState === 'countdown' && toState !== 'countdown') {
      const pending = this.countdownTimers.get(roomId);
      if (pending) {
        clearTimeout(pending);
        this.countdownTimers.delete(roomId);
      }
    }

    try {
      switch (toState) {
        case 'countdown':
          room.countdownStartedAt = now;
          await this.persistCountdownTransition(room);
          // Schedule the COUNTDOWN→LIVE auto-transition. Chunk #3 added
          // every other piece of this FSM but missed the timer that
          // actually advances state, so before this fix every match sat
          // in COUNTDOWN forever. The timer is room-scoped + cleared on
          // any transition out of countdown (above) and on evictRoom().
          console.log(
            `[activity-room-manager] room ${roomId} → COUNTDOWN (will auto-advance to LIVE in ${COUNTDOWN_DURATION_MS}ms; ${room.participants.size} participants, hasBots=${room.hasBots})`,
          );
          {
            const timer = setTimeout(() => {
              this.countdownTimers.delete(roomId);
              const r = this.rooms.get(roomId);
              if (!r || r.state !== 'countdown') return; // already aborted/transitioned
              console.log(
                `[activity-room-manager] room ${roomId} countdown timer fired → transitioning to LIVE (connectedCount=${this.connectedCount(r)})`,
              );
              this.transitionRoom(roomId, 'live').catch((err) => {
                console.error(
                  `[activity-room-manager] auto countdown→live failed for ${roomId}:`,
                  err,
                );
              });
            }, COUNTDOWN_DURATION_MS);
            this.countdownTimers.set(roomId, timer);
          }
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
   * Re-anchor a soon-to-expire COUNTDOWN so a freshly-connected client always
   * gets a full synced 3-2-1 before the sim starts.
   *
   * WHY: `createRoom()` flips PENDING→COUNTDOWN immediately and arms the
   * COUNTDOWN→LIVE timer at room-creation time — but the player still has to
   * navigate the browser to the room page and open a WebSocket, which on a
   * cold load easily burns 4-5s. By the time `registerConnection()` runs the
   * original window is gone: the `event.countdown` sent on connect computes
   * `remaining=0` (overlay is gated on `>0`) or the room already auto-advanced
   * to LIVE — so the HUD jumps straight to RACE 0% with no countdown. This
   * manifested in solo-vs-bots playtests as "no 3-2-1". The bug is
   * sim-agnostic (the sim doesn't own the countdown and only starts at LIVE);
   * both the ellipse and CLOSED-LOOP spline sims race the same window — spline
   * only looked worse because its match flow surfaced it.
   *
   * FIX: when a player connects while the room is still in COUNTDOWN and the
   * remaining window is below `COUNTDOWN_MIN_SYNC_MS`, restart the
   * COUNTDOWN→LIVE timer anchored to NOW so everyone gets a clean, synced
   * countdown. Idempotent + conservative: no-op unless the room is in
   * COUNTDOWN with a short remainder, never shortens a healthy window, never
   * touches LIVE/RESULTS rooms, and the existing COUNTDOWN→LIVE auto-advance
   * (and its cancel-on-transition guard) are reused verbatim. Reversible by
   * deleting this method + its single ws-hub call site.
   *
   * Returns the (possibly refreshed) `countdownStartedAt` so the caller can
   * emit an accurate `event.countdown` in the same connect turn.
   */
  ensureSyncedCountdown(roomId: string): number | null {
    const room = this.rooms.get(roomId);
    if (!room || room.state !== 'countdown') return null;

    const now = Date.now();
    const anchoredAt = room.countdownStartedAt ?? room.createdAt;
    const remaining = COUNTDOWN_DURATION_MS - (now - anchoredAt);

    // Healthy window — leave it untouched so multiple connects in the same
    // match don't keep pushing the start time out.
    if (remaining >= COUNTDOWN_MIN_SYNC_MS) {
      return room.countdownStartedAt;
    }

    // Re-anchor to now and rearm the auto-advance timer for a fresh window.
    room.countdownStartedAt = now;
    room.lastTouchedAt = now;

    const existing = this.countdownTimers.get(roomId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.countdownTimers.delete(roomId);
      const r = this.rooms.get(roomId);
      if (!r || r.state !== 'countdown') return; // aborted / already live
      this.transitionRoom(roomId, 'live').catch((err) => {
        console.error(
          `[activity-room-manager] re-anchored countdown→live failed for ${roomId}:`,
          err,
        );
      });
    }, COUNTDOWN_DURATION_MS);
    this.countdownTimers.set(roomId, timer);

    console.log(
      `[activity-room-manager] room ${roomId} countdown re-anchored on connect (was ${Math.max(0, Math.round(remaining))}ms remaining → full ${COUNTDOWN_DURATION_MS}ms)`,
    );

    return room.countdownStartedAt;
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
    // LIVE rooms with no WS connections must use `aborted_crash` (the
    // FSM does not allow live → aborted; only live → aborted_crash).
    // Tracked separately so the dispatch loop below picks the right
    // target state per room.
    const toAbortCrash: Room[] = [];
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
          // Grace period — the client has to navigate from the lobby
          // page to /activity/.../<roomId> and open a WebSocket. On
          // mobile that easily takes 1-3 seconds. The original
          // unguarded check raced the client and aborted rooms before
          // the user could connect (manifested as "Match Starting…"
          // sticking forever after the client finally connected to a
          // room that was already aborted server-side).
          if (
            this.connectedCount(room) === 0 &&
            now - (room.countdownStartedAt ?? room.createdAt) > 10_000
          ) {
            toAbort.push(room);
          }
          break;
        }
        case 'live': {
          // Long-lived poker tables legitimately have 0 sockets between hands /
          // before players connect — their owner (the TournamentManager) drives
          // them to a terminal state, so the sweeper must NOT crash-abort them
          // (would strand the tournament's CT escrow). See the exempt set above.
          if (LIVE_NO_WS_SWEEP_EXEMPT_ACTIVITIES.has(room.activityId)) {
            break;
          }
          if (
            this.connectedCount(room) === 0 &&
            now - room.lastTouchedAt > LIVE_NO_WS_TTL_MS
          ) {
            toAbortCrash.push(room);
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
            reason: 'pending_empty',
            playerCount: room.participants.size,
          },
        });
      } catch (err) {
        console.error('[activity-room-manager] sweeper abort failed:', err);
      }
    }
    for (const room of toAbortCrash) {
      try {
        await this.transitionRoom(room.id, 'aborted_crash');
        await logEvent({
          eventType: 'activity.match.swept',
          payload: {
            activityId: room.activityId,
            roomId: room.id,
            reason: 'live_no_ws',
            playerCount: room.participants.size,
          },
        });
      } catch (err) {
        console.error('[activity-room-manager] sweeper abort_crash failed:', err);
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

  // ─── Reef Race Phase 1 — pre-launch capture + verdicts ──────────────────

  /**
   * Called by the WS hub when a Reef Race client sends `thrust >= 1.0`
   * during COUNTDOWN. Stores only the LAST qualifying input per player —
   * timing of the final full-throttle press is what determines the verdict.
   *
   * Idempotent and safe to call from non-reef-race rooms (no-op if state
   * isn't 'countdown' or thrust < 1.0).
   */
  recordPreLaunchInput(
    roomId: string,
    avatarId: string,
    timestamp: number,
    thrust: number,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room || room.state !== 'countdown') return;
    if (thrust < 1.0) return;
    if (!room.preLaunchBuffer) room.preLaunchBuffer = new Map();
    room.preLaunchBuffer.set(avatarId, { timestamp, thrust });
  }

  /**
   * Called by the sim dispatcher in apps/api/src/index.ts AFTER
   * `room.startedAt` is set by `persistLiveTransition` and BEFORE
   * `reefRaceSim.startRoom` is invoked. Returns a per-avatar verdict map.
   * Clears `room.preLaunchBuffer` on completion.
   *
   * Human verdict windows (audit C4 + S10 fix — uses room manager's startedAt):
   *   |offset| ≤ LAUNCH_WINDOW_MS                           → 'boost'
   *   offset ∈ [-(WINDOW + STALL_WINDOW), -WINDOW)          → 'stall'
   *   offset > +LAUNCH_WINDOW_MS or further early           → no verdict
   *
   * Bot verdict synthesis (Phase 1.1 fix — audit I1):
   *   Bots produce input through `runBotControllers` inside the sim's
   *   tickRoom, which only fires post-LIVE. So bot LAUNCH presses NEVER
   *   reach `recordPreLaunchInput` (hub-only, COUNTDOWN-only). Without
   *   synthesis the bot's launch path is dead code and bots always start
   *   without a verdict — a quiet handicap relative to humans who get
   *   either boost or stall.
   *
   *   For every bot participant NOT already in the buffer, we synthesize
   *   a verdict via a deterministic LCG keyed on `roomId + avatarId`:
   *     low bit = 0 → 'boost'
   *     low bit = 1 → 'stall'
   *   Half get the launch advantage, half eat the penalty. Reads as
   *   "imperfect timing", same statistical shape as human variance.
   *   Determinism keyed on roomId+avatarId means replays reproduce.
   */
  computeLaunchVerdicts(room: Room): Map<string, 'boost' | 'stall'> {
    const verdicts = new Map<string, 'boost' | 'stall'>();
    if (!room.startedAt) {
      // Always release the buffer — even when empty — so a stale Map
      // doesn't survive into the LIVE phase if startedAt was never set.
      room.preLaunchBuffer = null;
      return verdicts;
    }

    // 1. Resolve human verdicts from the captured buffer.
    if (room.preLaunchBuffer) {
      for (const [avatarId, entry] of room.preLaunchBuffer) {
        const offset = entry.timestamp - room.startedAt;
        if (Math.abs(offset) <= LAUNCH_WINDOW_MS) {
          verdicts.set(avatarId, 'boost');
        } else if (
          offset < -LAUNCH_WINDOW_MS &&
          offset >= -(LAUNCH_WINDOW_MS + LAUNCH_STALL_WINDOW_MS)
        ) {
          verdicts.set(avatarId, 'stall');
        }
        // else: outside both windows → no verdict (normal start)
      }
    }

    // 2. Synthesize bot verdicts (audit I1 fix). Bots that already have
    //    a verdict from the buffer (impossible today — bots never write
    //    to the buffer — but kept defensive in case a future bot harness
    //    hits the WS hub) are skipped.
    for (const participant of room.participants.values()) {
      if (participant.subjectType !== 'bot') continue;
      if (verdicts.has(participant.avatarId)) continue;
      const verdict = synthesizeBotLaunchVerdict(room.id, participant.avatarId);
      verdicts.set(participant.avatarId, verdict);
    }

    room.preLaunchBuffer = null;
    return verdicts;
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

  /**
   * Register the sim LIVE-transition hook. Called once per room after
   * the COUNTDOWN→LIVE FSM transition persists, with the mutable Room
   * so the sim can pull participant avatarIds without a second lookup.
   */
  setLiveTransitionFn(fn: (room: Room) => Promise<void> | void): void {
    this.liveTransitionFn = fn;
  }

  /**
   * Register a callback fired immediately before a room is evicted from
   * memory (any terminal path). The receiver is responsible for cleaning
   * up auxiliary state — e.g. returning bot reservations to the pool.
   * Errors thrown here are logged but never rolled back; eviction must
   * still proceed so the room map doesn't leak.
   */
  setEvictionFn(fn: (room: Room) => void): void {
    this.evictionFn = fn;
  }

  /**
   * Register the abort-notification hook (Poker MTT P4). Called when any room
   * aborts so an owner holding escrow behind the room (the TournamentManager) can
   * recover. Idempotent registration (last writer wins). See `abortNotifyFn`.
   */
  setAbortNotifyFn(fn: (roomId: string, activityId: string) => void): void {
    this.abortNotifyFn = fn;
  }

  /**
   * Register the sim's placement resolver. Called at boot from index.ts
   * with a function that dispatches on `room.activityId` to the right
   * sim's `computeResults()`. Until registered, RESULTS transitions
   * skip reward issuance (logged as a warning so the gap surfaces).
   */
  setComputeResultsFn(fn: (room: Room) => SimResultRow[]): void {
    this.computeResultsFn = fn;
  }

  /** Read-back of the latest issued result list for a room (chunk #7). */
  getLastResults(roomId: string): IssuedResult[] | undefined {
    return this.lastResults.get(roomId);
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
    this.lastResults.clear();
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
      avatarId: p.avatarId,
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
    // Invoke the sim-start hook AFTER the DB row is live so the sim
    // never runs against a countdown row. Registered by the sim
    // dispatcher in `apps/api/src/index.ts` at boot.
    console.log(
      `[activity-room-manager] room ${room.id} → LIVE — invoking liveTransitionFn (registered=${!!this.liveTransitionFn}, activityId=${room.activityId}, participantCount=${room.participants.size})`,
    );
    if (this.liveTransitionFn) {
      try {
        // Phase 3 (audit C2) — await the hook so Reef Race can pre-load
        // racing profiles BEFORE startRoom (~1-2 ms blocking on the
        // Drizzle pool, well below the 33 ms tick budget). Sync callers
        // (bumper-shells, arena) await `void` — no-op.
        await this.liveTransitionFn(room);
      } catch (err) {
        console.error('[activity-room-manager] liveTransitionFn threw:', err);
      }
    } else {
      console.error(
        `[activity-room-manager] CRITICAL: room ${room.id} reached LIVE but no liveTransitionFn registered — sim will never start`,
      );
    }
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

    // Flush the replay log ring buffer to activity_replays. Swallow
    // errors so the FSM transition doesn't roll back — the replay
    // buffer is preserved in-memory on flush failure so a later retry
    // can pick it up (chunk #7 hooks in during result settlement).
    try {
      const participantsSnapshot: ActivityReplayParticipantsJson = {};
      for (const p of room.participants.values()) {
        participantsSnapshot[p.avatarId] = {
          subjectType: p.subjectType,
        };
      }
      await activityReplayLog.flushToDb(
        room.id,
        room.activityId,
        participantsSnapshot,
      );
    } catch (err) {
      console.error('[activity-room-manager] replay flush failed:', err);
      void alertError({
        severity: 'warning',
        source: 'activity-room-manager',
        message: `Replay flush failed for room ${room.id}`,
        context: { activityId: room.activityId, error: String(err) },
      });
    }

    // Chunk #7 — reward issuance pipeline. The sim resolver yields the
    // placement list (one entry per participant including bots); the
    // reward pipeline writes `activity_results` rows + credits non-bot
    // tokens + emits `activity.match.placed` events, all in one composed
    // DB transaction. Bot filtering (subjectType==='bot' → tokens=0,
    // leaderboardPoints=0, no creditClawTokens) lives inside the
    // pipeline per the chunk #10 carve-out.
    //
    // Throws are caught here (not bubbled) so a reward-issue failure
    // doesn't roll back the FSM transition. The room still completes;
    // the failure surfaces via alertError + a warning log so we can
    // manually compensate. Per backend §5.1 — rewards must be best-effort
    // at the FSM boundary because the sim already broadcast the round
    // outcome to clients before the manager observed it.
    let issued: IssuedResult[] = [];
    if (this.computeResultsFn) {
      try {
        const simResults = this.computeResultsFn(room);
        if (simResults.length === 0) {
          console.warn(
            `[activity-room-manager] no sim results for room ${room.id} — skipping reward issuance`,
          );
        } else {
          issued = await issueRewardsForRoom({ room, simResults });
          this.lastResults.set(room.id, issued);
        }
      } catch (err) {
        console.error(
          '[activity-room-manager] reward issuance failed:',
          err,
        );
        void alertError({
          severity: 'critical',
          source: 'activity-room-manager',
          message: `Reward issuance failed for room ${room.id}`,
          context: { activityId: room.activityId, error: String(err) },
        });
      }
    } else {
      console.warn(
        '[activity-room-manager] no computeResultsFn registered — rewards not issued',
      );
    }

    void logEvent({
      eventType: 'activity.match.ended',
      payload: {
        activityId: room.activityId,
        roomId: room.id,
        durationMs: (room.endedAt ?? Date.now()) - (room.startedAt ?? room.createdAt),
        // `complete` is the default — sim end conditions other than
        // 'complete' (forfeit / aborted) currently route through the
        // ABORTED FSM transitions, not RESULTS.
        reason: 'complete',
      },
    });
    // Re-export the issued count for callers that want the broadcast
    // payload (chunk #7 — no current consumer; lastResults map serves
    // the REST /results route + future WS rewardPreview enrichment).
    void issued;
  }

  private async persistGcTransition(room: Room): Promise<void> {
    await db
      .update(activityRooms)
      .set({ status: 'completed' satisfies RoomDbStatus })
      .where(eq(activityRooms.id, room.id));
    // Drop the replay buffer + cached replay id — chunk #7 consumes the
    // id during the RESULTS window, so by the time we GC it's safe to
    // release.
    activityReplayLog.dropRoom(room.id);
  }

  private async persistAbortedTransition(
    room: Room,
    status: 'aborted' | 'aborted_crash',
  ): Promise<void> {
    // Reef Race Phase 1 (audit S6) — discard any collected pre-launch
    // inputs so an abort path can never deliver stale launch verdicts to
    // a future incarnation of the room. Covers BOTH 'aborted' (countdown
    // → aborted) and 'aborted_crash' (live → aborted_crash) paths.
    room.preLaunchBuffer = null;

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

    // Notify any owner holding escrow/state behind this room (Poker MTT P4) so it
    // can recover (settle/refund) — covers BOTH abort paths. Best-effort: a
    // throwing receiver must NEVER break the abort persistence / sweep.
    if (this.abortNotifyFn) {
      try {
        this.abortNotifyFn(room.id, room.activityId);
      } catch (err) {
        console.error(
          '[activity-room-manager] abortNotifyFn threw (swallowed):',
          err,
        );
      }
    }
  }

  private evictRoom(room: Room): void {
    // Fire the eviction hook BEFORE clearing maps so receivers can still
    // read participant info if they want to. Errors don't block eviction.
    if (this.evictionFn) {
      try {
        this.evictionFn(room);
      } catch (err) {
        console.error('[activity-room-manager] evictionFn threw:', err);
      }
    }
    // Defense in depth — a room being evicted while still mid-countdown
    // (e.g. ABORTED during the 5s window) would otherwise leave its
    // setTimeout dangling. The transitionRoom guard above handles the
    // happy path; this catches eviction paths that bypass it.
    const pendingTimer = this.countdownTimers.get(room.id);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.countdownTimers.delete(room.id);
    }
    this.rooms.delete(room.id);
    this.shortCodeIndex.delete(room.shortCode);
    // Chunk #7 — release the in-memory result snapshot. The DB row is
    // the long-term source of truth; this map is only populated for the
    // RESULTS retention window so the REST `/results` route can return
    // breakdown metadata without a join. After GC, the route falls back
    // to the DB.
    this.lastResults.delete(room.id);
    for (const avatarId of room.participants.keys()) {
      // Only clear the index if it still points at this room — concurrent
      // requeue can have already updated it.
      if (this.playerToRoom.get(avatarId) === room.id) {
        this.playerToRoom.delete(avatarId);
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
