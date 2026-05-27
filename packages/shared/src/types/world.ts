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
 * is "the local one" — it broadcasts every session in the room).
 */
export interface PlayerSnapshot {
  /** Stable per-browser-session ID (Lucia session ID or guest fp hash). */
  sessionId: string;
  /** Authoritative user UUID if signed in, else null for guests. */
  userId: string | null;
  /** Display name (avatar.name or guest placeholder). */
  name: string;
  /** Game-pixel coordinates (same coord system as NpcRuntimeState.x/y). */
  x: number;
  y: number;
  /** Heading in radians (atan2(dx, dy) convention — matches VRM facing). */
  dirZ: number;
  /** Free-form activity verb ("idle" | "walking" | "running" | …). */
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
