/**
 * Q2 Activity Portals — server-side state types.
 *
 * Internal shapes used by the room manager + queue + (future) WS hub.
 * These do NOT overlap with the wire protocol types in
 * `@clawville/shared/activities/protocol.ts` — those are client-facing
 * frame schemas; these are in-memory bookkeeping.
 *
 * The shapes mirror what the spec calls out in backend §1.3 (state
 * model) + §2.2 (queue data model). Single source of truth is this file
 * — do not duplicate these shapes elsewhere.
 */

import type { ServerFrame } from '@clawville/shared';

// ─── Room lifecycle FSM ─────────────────────────────────────────────────────

/**
 * In-memory FSM states for a room. DB `activity_rooms.status` mirrors
 * a SUBSET of these — `pending` is in-memory-only because there is no
 * DB write until COUNTDOWN.
 *
 * Transitions (from backend §1.2):
 *
 *   pending      → countdown   (player count ≥ minFill OR queueTimeout fired)
 *   countdown    → live        (countdown hits 0)
 *   live         → results     (sim end condition)
 *   results      → gc          (after 2-min retention window)
 *
 *   pending      → aborted        (all players left before COUNTDOWN)
 *   countdown    → aborted        (player count drops below minFill - 1)
 *   live         → aborted_crash  (sim threw — no rewards)
 */
export type RoomState =
  | 'pending'
  | 'countdown'
  | 'live'
  | 'results'
  | 'gc'
  | 'aborted'
  | 'aborted_crash';

/**
 * DB-statuses are a STRICT SUBSET — `pending` and `gc` never persist.
 * Used by the manager when writing the FSM transition row.
 */
export type RoomDbStatus =
  | 'countdown'
  | 'live'
  | 'completed'
  | 'aborted'
  | 'aborted_crash';

/**
 * Subject type — distinguishes humans / user-agents / system bots in
 * the same room. Mirrors `activity_room_participants.subject_type`.
 */
export type SubjectType = 'human' | 'agent' | 'bot';

/**
 * Per-room participant snapshot. Held in the room's `participants` map.
 * Mutable: `connected`, `disconnectedAt`, `wsConnectionId` change as the
 * client connects / drops / reconnects.
 */
export interface RoomParticipant {
  avatarId: string;
  userId: string | null; // null for system bots
  agentId: string | null; // null for human-direct play and bots
  subjectType: SubjectType;
  partyId: string | null;
  joinedAt: number;
  /** Currently has a live WS to the room hub */
  connected: boolean;
  /** When the WS dropped (epoch ms) — used for the 10s reconnect grace */
  disconnectedAt: number | null;
  /** Hub-issued connection id (set when WS hub lights up — chunk #3) */
  wsConnectionId: string | null;
}

/**
 * In-memory room. Lives in `activityRoomManager.rooms`. Backed by a DB
 * row from PENDING→COUNTDOWN forward.
 *
 * Memory budget per spec §1.5: ~400 MB for 200 simultaneous rooms. This
 * shape keeps the static fields tight and pushes per-tick sim state
 * into a sibling `simState` field (chunk #3 attaches that).
 */
export interface Room {
  id: string; // uuid v4
  shortCode: string; // 6-char base32-crockford, unique per live room
  activityId: string;
  state: RoomState;
  /**
   * Map keyed by avatarId. Insertion order is preserved (matchmaker fill
   * order = lobby slot order in the UI).
   */
  participants: Map<string, RoomParticipant>;
  /** Server-side authoritative — set on countdown allocation */
  countdownStartedAt: number | null;
  /** Set on COUNTDOWN→LIVE */
  startedAt: number | null;
  /** Set on LIVE→RESULTS */
  endedAt: number | null;
  /** Wall-clock createdAt (matches DB row) */
  createdAt: number;
  /** Last-known activity touch — drives sweeper */
  lastTouchedAt: number;
  /** Has the matcher pulled a bot into this room? */
  hasBots: boolean;
  /** Are any participants `subject_type='agent'`? */
  hasAgents: boolean;
  /**
   * Activity-specific config snapshot taken at room creation. Avoids a
   * second DB lookup mid-sim. Min/max/preferred player counts surface
   * here.
   */
  activityConfig: {
    minPlayers: number;
    maxPlayers: number;
    preferredPlayers: number;
  };
}

// ─── Queue ──────────────────────────────────────────────────────────────────

/**
 * In-memory queue entry. Mirrors `activity_queue_entries` schema with
 * a tighter shape (timestamps as epoch ms, not Date).
 */
export interface QueueEntry {
  id: string; // uuid
  activityId: string;
  avatarId: string;
  userId: string | null;
  agentId: string | null;
  subjectType: 'human' | 'agent';
  partyId: string | null;
  queuedAt: number; // epoch ms
  /** WS connection id for delivering `match.found` (chunk #3) */
  wsConnectionId: string | null;
  /** False if the matcher has already matched this entry; idempotency guard */
  matched: boolean;
  /** True if user opted out of bot backfill via {allowBotBackfill: false} */
  allowBotBackfill: boolean;
  /** ?matchType=agent-only filter — defer surface to chunk #3 (agent-only queue) */
  agentOnly: boolean;
}

/**
 * In-memory party. Mirrors `activity_parties` + member rows with a
 * tighter shape; persistence happens through `activity-queue.ts`.
 */
export interface Party {
  id: string; // uuid
  shortCode: string;
  leaderAvatarId: string;
  members: Set<string>; // avatarIds
  createdAt: number;
  /** Set when disbanded (last member leaves OR 1h GC) */
  disbandedAt: number | null;
}

// ─── Aggregate status types (return shapes) ─────────────────────────────────

export interface QueueStatus {
  /** 1-indexed position in the queue (1 = next to match) — null if not queued */
  position: number | null;
  estimatedWaitSec: number;
  roomsActive: number;
  playersInQueue: number;
  /** True if the per-pod cap was hit; queue write was rejected with 503 */
  serverAtCapacity: boolean;
}

// ─── Hub callback types (chunk #3 wires the hub to these) ───────────────────

/**
 * Callback signature the WS hub registers with the room manager so the
 * manager can broadcast frames without a hard dep on the hub. Chunk #2
 * leaves the registration as a no-op default.
 */
export type RoomBroadcastFn = (roomId: string, frame: ServerFrame) => void;

/**
 * Callback signature for delivering `match.found` to a queue entry's
 * waiting WS. Same indirection pattern as the room broadcast — the hub
 * is the publisher, the queue is the producer.
 */
export type MatchFoundDeliveryFn = (
  wsConnectionId: string,
  payload: { roomId: string; shortCode: string; activityId: string; countdown: number },
) => void;

// ─── Re-exports for ergonomics ──────────────────────────────────────────────

export type { ServerFrame } from '@clawville/shared';
