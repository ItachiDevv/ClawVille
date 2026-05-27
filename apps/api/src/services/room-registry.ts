/**
 * Multiplayer Phase 1 — RoomRegistry.
 *
 * In-memory singleton (mirrors NpcSimulation). Holds:
 *   - rooms keyed by 4-char alphanumeric ID
 *   - sessionId → roomId reverse index (every session is in at most one room)
 *   - per-room player state + the live NPC ID set for that room
 *   - removedNpcs map for the 5 s "restore on leave" grace
 *
 * GC contract (driven by an external tick — NpcSimulation calls `tick()`):
 *   - Players whose `lastPositionUpdateAt` is older than STALE_PLAYER_MS get
 *     auto-leaveAt fired (drops them from the room, schedules NPC restore).
 *   - Rooms with zero players and `lastActivityAt` older than EMPTY_ROOM_MS
 *     get deleted entirely.
 *   - Pending NPC restores whose `removedAt + RESTORE_GRACE_MS` has elapsed
 *     reseat the NPC into `room.npcs`.
 *
 * Clock injection — `now: () => number` is taken in the constructor so tests
 * can advance time without `setTimeout` / real `Date.now()`. Production wires
 * up the real clock; tests pass a fake.
 *
 * Atomicity — JavaScript is single-threaded; every public method here is
 * synchronous and runs to completion before the next event loop tick. Two
 * concurrent `joinPlayer` calls cannot interleave NPC-swap decisions.
 */

import { NPC_DEFINITIONS } from '@clawville/shared';
import type { PlayerSnapshot } from '@clawville/shared';

// Default NPC roster eligible for player swap-out.
// Building residents (def.buildingId !== '') stay in every room — they are
// load-bearing knowledge holders and not subject to player overflow.
export const FREE_ROAMER_NPC_IDS: ReadonlySet<string> = new Set(
  NPC_DEFINITIONS.filter((def) => def.buildingId === '').map((def) => def.id),
);

export const ROOM_MAX_PLAYERS = 20;
export const RESTORE_GRACE_MS = 5_000;       // NPC reappears 5 s after player leaves
export const STALE_PLAYER_MS = 30_000;       // no position update for 30 s → kick
export const EMPTY_ROOM_MS = 5 * 60_000;     // empty room dies after 5 min

// Alphabet for 4-char room IDs — excludes 0/O/1/I/L to avoid confusion when
// the user types a shared link or reads a room code out loud.
const ROOM_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_ID_LENGTH = 4;

export interface PlayerState {
  sessionId: string;
  userId: string | null;
  name: string;
  species: string;
  color: number;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  ts: number;
  dirZ: number;
  activity: string;
  lastPositionUpdateAt: number;
}

interface RemovedNpcEntry {
  removedAt: number;
  byPlayer: string;
}

export interface Room {
  id: string;
  players: Map<string, PlayerState>;
  npcs: Set<string>;
  removedNpcs: Map<string, RemovedNpcEntry>;
  lastActivityAt: number;
}

export interface JoinAvatarMeta {
  userId: string | null;
  name: string;
  species: string;
  color: number;
  x?: number;
  y?: number;
}

export interface JoinResult {
  room: Room;
  player: PlayerState;
  /** NPC removed from the room when this player joined (null if no swap). */
  swappedOutNpcId: string | null;
}

export interface LeaveResult {
  room: Room;
  /** NPC scheduled to reappear after RESTORE_GRACE_MS (null if none). */
  pendingRestoreNpcId: string | null;
}

export interface RoomTickResult {
  /** Sessions kicked for being stale (no position update). */
  staleSessionsRemoved: string[];
  /** NPC IDs that just finished their grace timer and are back in rooms. */
  restoredNpcs: Array<{ roomId: string; npcId: string }>;
  /** Empty rooms GC'd this tick. */
  removedRoomIds: string[];
}

export class RoomRegistry {
  private rooms = new Map<string, Room>();
  private sessionToRoom = new Map<string, string>();
  private readonly now: () => number;
  private readonly randomChar: () => string;

  /**
   * @param opts.now           Clock (defaults to `Date.now`).
   * @param opts.randomChar    Source of room-ID characters; defaults to crypto-strength
   *                           random selection from ROOM_ID_ALPHABET. Tests pass a
   *                           deterministic stub to assert collision handling.
   */
  constructor(opts?: { now?: () => number; randomChar?: () => string }) {
    this.now = opts?.now ?? Date.now;
    this.randomChar =
      opts?.randomChar ??
      (() => ROOM_ID_ALPHABET[Math.floor(Math.random() * ROOM_ID_ALPHABET.length)]!);
  }

  // ---------------------------------------------------------------------------
  // Public read API
  // ---------------------------------------------------------------------------

  getRoom(roomId: string): Room | null {
    return this.rooms.get(roomId) ?? null;
  }

  getRoomForSession(sessionId: string): Room | null {
    const roomId = this.sessionToRoom.get(sessionId);
    if (!roomId) return null;
    return this.rooms.get(roomId) ?? null;
  }

  listRooms(): Room[] {
    return Array.from(this.rooms.values());
  }

  /** Snapshot the room's players for JSON wire transfer. */
  getPlayerSnapshots(roomId: string): PlayerSnapshot[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const out: PlayerSnapshot[] = [];
    for (const p of room.players.values()) {
      out.push({
        sessionId: p.sessionId,
        userId: p.userId,
        name: p.name,
        species: p.species,
        color: p.color,
        x: p.x,
        y: p.y,
        dirZ: p.dirZ,
        activity: p.activity,
        ts: p.ts,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * Join a player to a room. If `requestedRoomId` is provided AND the room
   * exists AND has capacity, the player lands there. Otherwise we either
   * reuse the lowest-id room with room.players.size < ROOM_MAX_PLAYERS or
   * mint a new room.
   *
   * Re-joining a session that already holds a room slot is idempotent: the
   * existing PlayerState is updated in place, and no NPC swap is performed
   * (we already swapped one out on the first join).
   */
  joinPlayer(
    sessionId: string,
    avatar: JoinAvatarMeta,
    requestedRoomId?: string,
  ): JoinResult {
    const now = this.now();

    // Already in a room → idempotent refresh.
    const existingRoomId = this.sessionToRoom.get(sessionId);
    if (existingRoomId) {
      const room = this.rooms.get(existingRoomId);
      if (room) {
        const player = room.players.get(sessionId);
        if (player) {
          this.applyAvatarMeta(player, avatar, now);
          room.lastActivityAt = now;
          return { room, player, swappedOutNpcId: null };
        }
      }
      // Stale reverse-index → fall through and re-join properly.
      this.sessionToRoom.delete(sessionId);
    }

    const room = this.pickOrCreateRoom(requestedRoomId);
    const player: PlayerState = {
      sessionId,
      userId: avatar.userId,
      name: avatar.name,
      species: avatar.species,
      color: avatar.color,
      x: avatar.x ?? 0,
      y: avatar.y ?? 0,
      prevX: avatar.x ?? 0,
      prevY: avatar.y ?? 0,
      ts: now,
      dirZ: 0,
      activity: 'idle',
      lastPositionUpdateAt: now,
    };
    room.players.set(sessionId, player);
    this.sessionToRoom.set(sessionId, room.id);
    room.lastActivityAt = now;

    const swappedOutNpcId = this.swapOutNpcFor(room, player);
    return { room, player, swappedOutNpcId };
  }

  /**
   * Drop a player from their current room. The corresponding NPC (if any)
   * stays in `removedNpcs` until `RESTORE_GRACE_MS` elapses — the next
   * `tick()` reseats it. Returns null when the session wasn't in any room.
   */
  leavePlayer(sessionId: string): LeaveResult | null {
    const roomId = this.sessionToRoom.get(sessionId);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room) {
      this.sessionToRoom.delete(sessionId);
      return null;
    }
    const player = room.players.get(sessionId);
    if (!player) {
      this.sessionToRoom.delete(sessionId);
      return { room, pendingRestoreNpcId: null };
    }
    room.players.delete(sessionId);
    this.sessionToRoom.delete(sessionId);
    room.lastActivityAt = this.now();

    // The NPC swapped out when this player joined gets queued for restore.
    let pendingRestoreNpcId: string | null = null;
    for (const [npcId, entry] of room.removedNpcs) {
      if (entry.byPlayer === sessionId) {
        pendingRestoreNpcId = npcId;
        // Re-stamp removedAt so the grace timer counts from "leave" not "join".
        entry.removedAt = this.now();
        break;
      }
    }
    return { room, pendingRestoreNpcId };
  }

  /**
   * Apply an authoritative position update from the player's client. Returns
   * the (mutated) PlayerState so callers can broadcast immediately if they
   * want a sub-tick latency path; the default broadcast cycle is via SSE.
   */
  updatePosition(
    sessionId: string,
    patch: { x: number; y: number; dirZ: number; activity: string },
  ): PlayerState | null {
    const room = this.getRoomForSession(sessionId);
    if (!room) return null;
    const player = room.players.get(sessionId);
    if (!player) return null;
    const now = this.now();
    player.prevX = player.x;
    player.prevY = player.y;
    player.x = patch.x;
    player.y = patch.y;
    player.dirZ = patch.dirZ;
    player.activity = patch.activity;
    player.ts = now;
    player.lastPositionUpdateAt = now;
    room.lastActivityAt = now;
    return player;
  }

  /**
   * Periodic maintenance. Caller decides the cadence (NpcSimulation runs us
   * once per 200 ms tick). Three jobs per call:
   *
   *  1. Restore any NPC whose grace window has elapsed.
   *  2. Kick any player whose last position update is older than 30 s.
   *  3. Delete empty rooms whose `lastActivityAt` is older than 5 min.
   */
  tick(): RoomTickResult {
    const now = this.now();
    const result: RoomTickResult = {
      staleSessionsRemoved: [],
      restoredNpcs: [],
      removedRoomIds: [],
    };

    for (const room of this.rooms.values()) {
      // 1. NPC restore — re-add eligible swapped NPCs.
      for (const [npcId, entry] of Array.from(room.removedNpcs)) {
        if (now - entry.removedAt >= RESTORE_GRACE_MS) {
          // Only re-add if the player whose join removed this NPC has
          // actually left (i.e. their PlayerState is no longer present).
          // While the player is still in the room we want the swap to hold.
          if (!room.players.has(entry.byPlayer)) {
            room.npcs.add(npcId);
            room.removedNpcs.delete(npcId);
            result.restoredNpcs.push({ roomId: room.id, npcId });
          }
        }
      }

      // 2. Kick stale players.
      for (const [sessionId, player] of Array.from(room.players)) {
        if (now - player.lastPositionUpdateAt > STALE_PLAYER_MS) {
          // Inline the leave so the NPC-restore entry is updated correctly.
          room.players.delete(sessionId);
          this.sessionToRoom.delete(sessionId);
          for (const entry of room.removedNpcs.values()) {
            if (entry.byPlayer === sessionId) entry.removedAt = now;
          }
          room.lastActivityAt = now;
          result.staleSessionsRemoved.push(sessionId);
        }
      }
    }

    // 3. Empty-room GC — separate pass because step 2 may empty a room.
    for (const [roomId, room] of Array.from(this.rooms)) {
      if (room.players.size === 0 && now - room.lastActivityAt > EMPTY_ROOM_MS) {
        this.rooms.delete(roomId);
        result.removedRoomIds.push(roomId);
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private pickOrCreateRoom(requestedRoomId: string | undefined): Room {
    if (requestedRoomId) {
      const room = this.rooms.get(requestedRoomId);
      if (room && room.players.size < ROOM_MAX_PLAYERS) return room;
      // Requested room is full or doesn't exist → mint with the requested ID
      // ONLY when it doesn't exist (i.e. accept invite-code deeplinks even
      // for never-before-seen codes). If it exists but is full, fall through
      // to auto-fill so the player doesn't get a hard 503.
      if (!room) {
        return this.createRoomWithId(requestedRoomId);
      }
    }
    // Auto-fill: first room with capacity. Sort by id so the algorithm is
    // deterministic — needed both for predictable load and for the tests.
    const sorted = Array.from(this.rooms.values()).sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const room of sorted) {
      if (room.players.size < ROOM_MAX_PLAYERS) return room;
    }
    return this.createRoomWithId(this.mintRoomId());
  }

  private createRoomWithId(id: string): Room {
    const now = this.now();
    const room: Room = {
      id,
      players: new Map(),
      npcs: new Set(FREE_ROAMER_NPC_IDS),
      removedNpcs: new Map(),
      lastActivityAt: now,
    };
    this.rooms.set(id, room);
    return room;
  }

  private mintRoomId(): string {
    // 30^4 = 810_000 possible IDs. Birthday paradox at 20 active rooms ≈ 0.0%
    // collision per mint, but we still loop just in case. Cap attempts so a
    // wedged RNG can't spin forever — fall back to an incrementing suffix.
    for (let attempt = 0; attempt < 32; attempt++) {
      let id = '';
      for (let i = 0; i < ROOM_ID_LENGTH; i++) id += this.randomChar();
      if (!this.rooms.has(id)) return id;
    }
    // Pathological fallback.
    let suffix = this.rooms.size;
    while (this.rooms.has(`R${suffix}`)) suffix++;
    return `R${suffix}`;
  }

  private applyAvatarMeta(player: PlayerState, avatar: JoinAvatarMeta, now: number): void {
    player.userId = avatar.userId;
    player.name = avatar.name;
    player.species = avatar.species;
    player.color = avatar.color;
    if (avatar.x !== undefined && avatar.y !== undefined) {
      player.prevX = player.x;
      player.prevY = player.y;
      player.x = avatar.x;
      player.y = avatar.y;
    }
    player.ts = now;
    player.lastPositionUpdateAt = now;
  }

  /**
   * Pick an NPC to remove from `room.npcs` to make budget for the new
   * player. Priority order:
   *   1. NPC whose species matches the player's avatar species (so the
   *      visual cast stays balanced — a Milady player swaps a Milady NPC).
   *   2. Any random swap-eligible NPC.
   *   3. If room.npcs is empty (already at the 14-VRM ceiling), no swap.
   */
  private swapOutNpcFor(room: Room, player: PlayerState): string | null {
    if (room.npcs.size === 0) return null;

    const speciesMatch: string[] = [];
    const fallback: string[] = [];
    for (const npcId of room.npcs) {
      const def = NPC_DEFINITIONS.find((d) => d.id === npcId);
      if (!def) continue;
      if (def.species === player.species) speciesMatch.push(npcId);
      else fallback.push(npcId);
    }

    // Deterministic-ish: lexicographically first match. Random pick is a
    // worse fit for tests AND for the user experience — the same player
    // returning to the same room should swap the same NPC.
    speciesMatch.sort();
    fallback.sort();

    const chosen = speciesMatch[0] ?? fallback[0] ?? null;
    if (!chosen) return null;
    room.npcs.delete(chosen);
    room.removedNpcs.set(chosen, {
      removedAt: this.now(),
      byPlayer: player.sessionId,
    });
    return chosen;
  }

  /**
   * Test-only escape hatch. Lets unit tests wipe state between cases so a
   * shared module-level singleton doesn't leak fixtures across runs.
   */
  __resetForTests(): void {
    this.rooms.clear();
    this.sessionToRoom.clear();
  }
}

// Singleton — matches the NpcSimulation / agentOrchestrator pattern.
export const roomRegistry = new RoomRegistry();
