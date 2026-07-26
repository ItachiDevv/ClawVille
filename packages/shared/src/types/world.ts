/**
 * Multiplayer Phase 1 wire types — shared between API and web client.
 *
 * Snapshots are broadcast at ~5 Hz via `GET /api/world/:roomId/stream`.
 * Position updates flow the other direction via `POST /api/world/position`.
 *
 * Keep this surface JSON-serializable; do NOT add functions, dates, or
 * non-primitive shapes. The server emits `JSON.stringify(snapshot)` and the
 * client parses it with no runtime guard.
 */

/**
 * One player projected into the room snapshot. `isLocal` is set by the
 * client during snapshot ingestion (the server doesn't know which session
 * is "the local one"; it broadcasts every session in the room, keyed only
 * by the opaque `id` below, never the raw session token).
 */
export const AT_COVE_ACTIVITY = 'at-cove' as const;

export interface PlayerSnapshot {
  /**
   * Opaque per-session presence id. NON-reversible, derived server-side via
   * sha256(sessionId + FINGERPRINT_SECRET) sliced to 16 hex chars, so the raw
   * Lucia session token / guest fp hash / agent id NEVER goes over the wire.
   * Stable across reconnects for the same session. Used by the client purely
   * as a render/cache key and to resolve `isLocal` (compared against the
   * /join-returned id).
   */
  id: string;
  /** Authoritative user UUID if signed in, else null for guests. */
  userId: string | null;
  /**
   * Presence kind, set authoritatively at join time. 'human' = Lucia-authed
   * account, 'guest' = fingerprint-only visitor, 'agent' = connected/hosted
   * agent playing AS ITSELF (bound avatar, real CT + leaderboard credit). The
   * 3D layer reads this to show the connected-agent indicator dot.
   */
  kind: 'human' | 'guest' | 'agent';
  /** Display name (avatar.name or guest placeholder). */
  name: string;
  /** Game-pixel coordinates (same coord system as NpcRuntimeState.x/y). */
  x: number;
  y: number;
  /** Heading in radians (atan2(dx, dy) convention — matches VRM facing). */
  dirZ: number;
  /** Free-form activity verb (conventional: "idle", "walking", "running", or AT_COVE_ACTIVITY). */
  activity: string;
  /** Visual species key (e.g. "milady_official_1", "hermes_male"). */
  species: string;
  /** Display color (numeric hex; matches NpcRuntimeState.color). */
  color: number;
  /** Server-stamped publish time (ms epoch). */
  ts: number;
}

/**
 * Single SSE payload pushed by /api/world/:roomId/stream every 200 ms.
 *
 * `npcs` is the existing NPC roster filtered to the room's swap-eligible
 * subset. `players` is everyone currently in this room. The leaderboard /
 * activity / combat slices keep their existing global semantics.
 */
export interface RoomSnapshot {
  /** 4-char room ID this snapshot belongs to. */
  roomId: string;
  /** Players currently in this room (may include the local viewer). */
  players: PlayerSnapshot[];
}

/** Public phase names exposed by the owner-only Autonomous status endpoint. */
export type AutonomyDrivePhase = 'deciding' | 'walking' | 'arrived' | 'talking';

/**
 * One bounded, presentation-safe driver event. The server deliberately omits
 * raw model output, inference details, and every private agent/session id.
 */
export interface AutonomyStatusThought {
  at: number;
  type: 'decision' | 'arrival' | 'observation' | 'directive';
  text: string;
}

/**
 * Lucia-owner view of the in-memory Autonomous driver. `bodyId` is the public
 * snapshot id already sent to world clients; no agent bearer or platform id is
 * part of this contract.
 */
export type AutonomyStatusResponse =
  | { enrolled: false }
  | {
      enrolled: true;
      phase: AutonomyDrivePhase;
      targetBuildingId: string | null;
      targetLabel: string | null;
      bodyId: string;
      phaseSince: number;
      thoughts: AutonomyStatusThought[];
    };
