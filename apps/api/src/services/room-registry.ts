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

import { createHash } from 'crypto';
import { NPC_DEFINITIONS } from '@clawville/shared';
import type { PlayerSnapshot } from '@clawville/shared';

/**
 * Salt for the non-reversible presence id. FINGERPRINT_SECRET is hard-required
 * at boot (apps/api/src/middleware/fingerprint.ts throws at module load if it
 * is missing or shorter than 32 chars), so by the time any room is joined the
 * value is guaranteed present and validated. We read it once at module load.
 * The fallback string is only ever exercised in unit tests that import this
 * module without the env wired up (the derived ids stay internally
 * consistent there, which is all the tests need).
 */
const PRESENCE_ID_SALT = process.env.FINGERPRINT_SECRET || 'test-only-presence-salt';

/**
 * Derive the opaque per-session presence id broadcast on the wire. The raw
 * `sessionId` (a Lucia session-cookie bearer token for logged-in users, a
 * guest fp hash for visitors, or an `a:<agentId>` handle for agents) is NEVER
 * emitted; only this sha256(sessionId + SALT) hex sliced to 16 chars is. 16 hex
 * chars = 64 bits of address space; collision risk across a room of <=20
 * players is negligible while remaining stable across reconnects.
 */
function derivePublicId(sessionId: string): string {
  return createHash('sha256').update(sessionId + PRESENCE_ID_SALT).digest('hex').slice(0, 16);
}

// Default NPC roster eligible for player swap-out.
// Building residents (def.buildingId !== '') stay in every room — they are
// load-bearing knowledge holders and not subject to player overflow.
export const FREE_ROAMER_NPC_IDS: ReadonlySet<string> = new Set(
  NPC_DEFINITIONS.filter((def) => def.buildingId === '').map((def) => def.id),
);

/**
 * Hard cap — the absolute ceiling on a room's player count. No join path
 * (auto-fill or invite code) ever seats player number 21. This is the VRM /
 * draw-call safety limit for the shared world scene.
 */
export const ROOM_MAX_PLAYERS = 20;

/**
 * Soft cap — the loose target auto-fill aims for. Auto-fill (a player with no
 * invite code) only ever lands in a room with fewer than this many players, and
 * mints a fresh room once every existing room has reached it. The 12-to-20 band
 * (soft cap up to hard cap) is RESERVED HEADROOM for friends joining a specific
 * room via an invite code (`requestedRoomId`): invite joins are honored all the
 * way up to ROOM_MAX_PLAYERS, so a full friend group can pile into one room even
 * after auto-fill has stopped seeding it. Keeping auto-fill under the soft cap
 * keeps rooms cozy (no lone spawns scattered across many half-empty rooms) while
 * still guaranteeing invited friends a seat next to the people who invited them.
 */
export const ROOM_SOFT_CAP_PLAYERS = 12;

export const RESTORE_GRACE_MS = 5_000;       // NPC reappears 5 s after player leaves
export const STALE_PLAYER_MS = 30_000;       // no position update for 30 s → kick
export const EMPTY_ROOM_MS = 5 * 60_000;     // empty room dies after 5 min

// Alphabet for 4-char room IDs — excludes 0/O/1/I/L to avoid confusion when
// the user types a shared link or reads a room code out loud.
const ROOM_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_ID_LENGTH = 4;

export interface PlayerState {
  /** Raw internal session key (Lucia token / guest fp / agent handle). NEVER emitted. */
  sessionId: string;
  /** Non-reversible wire id derived from sessionId. The ONLY presence id that leaves the server. */
  publicId: string;
  /** Presence kind set at join: human (Lucia) / guest (fp) / agent (bound avatar). */
  kind: 'human' | 'guest' | 'agent';
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
  /**
   * Presence kind. Defaults to 'guest' when omitted (legacy callers / tests).
   * Set to 'human' for a Lucia-authed user and 'agent' for a connected/hosted
   * agent joining as its bound avatar.
   */
  kind?: 'human' | 'guest' | 'agent';
}

export interface JoinOptions {
  /**
   * Optional 4-char invite code from the deeplink. Honored only when the
   * room exists with capacity. When the room does NOT exist, the code is
   * only minted for authenticated callers (`isAuthenticated: true`); guests
   * fall through to auto-fill so an anonymous attacker can't pin ID-space
   * by replaying random 4-char codes (B2 — punch list).
   */
  requestedRoomId?: string;
  /** True when the caller has a Lucia session; false for fingerprint guests. */
  isAuthenticated?: boolean;
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
   * Tick-result subscribers — invoked synchronously inside `tick()` AFTER
   * the GC passes complete. Lets world.ts drop entries from its
   * positionLastSeen throttle map without having to inspect every
   * `/position` POST (B3 — punch list).
   */
  private tickSubscribers = new Set<(result: RoomTickResult) => void>();

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

  /**
   * Register a side-effect callback for tick GC results. Used by world.ts
   * to purge `positionLastSeen` for kicked-stale sessions. Returns an
   * unsubscribe handle.
   */
  subscribeTick(fn: (result: RoomTickResult) => void): () => void {
    this.tickSubscribers.add(fn);
    return () => this.tickSubscribers.delete(fn);
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
      // SECURITY: emit the NON-reversible publicId only. The raw sessionId
      // (Lucia bearer token for logged-in users) must NEVER reach the wire
      // (it broadcasts to every SSE subscriber in the room). Likewise the
      // guest fp hash / agent id stay internal.
      out.push({
        id: p.publicId,
        kind: p.kind,
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
   * exists AND has capacity (< ROOM_MAX_PLAYERS), the player lands there —
   * invite joins fill the room all the way to the hard cap. Otherwise we
   * auto-fill: land the player in the FULLEST room still under the soft cap
   * (ROOM_SOFT_CAP_PLAYERS), or mint a fresh room when every room has reached
   * the soft cap. Auto-fill never seeds the 12-to-20 headroom band — that is
   * reserved for invite-code joins.
   *
   * Re-joining a session that already holds a room slot is idempotent: the
   * existing PlayerState is updated in place, and no NPC swap is performed
   * (we already swapped one out on the first join).
   */
  joinPlayer(
    sessionId: string,
    avatar: JoinAvatarMeta,
    optionsOrRoomId?: JoinOptions | string,
  ): JoinResult {
    // Backwards-compat: legacy callers passed `requestedRoomId` as a plain
    // string. Normalize to the options object so the test fixtures + the
    // route can keep their existing call sites.
    const options: JoinOptions =
      typeof optionsOrRoomId === 'string'
        ? { requestedRoomId: optionsOrRoomId, isAuthenticated: false }
        : optionsOrRoomId ?? {};
    const { requestedRoomId, isAuthenticated = false } = options;

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

    const room = this.pickOrCreateRoom(requestedRoomId, isAuthenticated);

    // B1 — cancel any pending NPC restore queued by this session's prior
    // leave. Without this, a player who rage-quits then rejoins within
    // RESTORE_GRACE_MS gets a SECOND NPC swapped out (the original NPC
    // restores 5 s later via tick(), but a fresh NPC has already been
    // pulled to make capacity for the rejoiner — net result: room
    // permanently lost an NPC slot every rage-rejoin cycle).
    const restored = this.cancelPendingRestoresFor(room, sessionId);

    const player: PlayerState = {
      sessionId,
      publicId: derivePublicId(sessionId),
      kind: avatar.kind ?? 'guest',
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
    // If the rejoin reseat already brought back the player's prior NPC and
    // the species-match path picked the SAME one again, that's the desired
    // behaviour (visual continuity). Either way, `restored` is informational
    // — the swap result is what callers act on.
    void restored;
    return { room, player, swappedOutNpcId };
  }

  /**
   * Sweep `room.removedNpcs` for entries queued by this sessionId and
   * reseat them. Returns the list of restored NPC IDs. Used by joinPlayer
   * to cancel a pending restore on fast rejoin (B1 — punch list).
   */
  private cancelPendingRestoresFor(room: Room, sessionId: string): string[] {
    const restored: string[] = [];
    for (const [npcId, entry] of Array.from(room.removedNpcs)) {
      if (entry.byPlayer === sessionId) {
        room.npcs.add(npcId);
        room.removedNpcs.delete(npcId);
        restored.push(npcId);
      }
    }
    return restored;
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

    // Fan out to subscribers (world.ts uses this to purge positionLastSeen).
    // Subscribers are best-effort; a throwing handler must not abort the
    // tick for other consumers or leak the exception up to NpcSimulation.
    if (this.tickSubscribers.size > 0) {
      for (const fn of this.tickSubscribers) {
        try { fn(result); } catch (err) {
          console.error('[RoomRegistry] tick subscriber threw:', err);
        }
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private pickOrCreateRoom(
    requestedRoomId: string | undefined,
    isAuthenticated: boolean,
  ): Room {
    if (requestedRoomId) {
      const room = this.rooms.get(requestedRoomId);
      if (room && room.players.size < ROOM_MAX_PLAYERS) return room;
      // Requested room is full or doesn't exist. Mint a fresh room with the
      // requested ID ONLY for authenticated callers — guests cannot pin
      // ID-space by replaying random 4-char codes (B2 — punch list). When a
      // guest sends an unknown code, we fall through to auto-fill so they
      // still get a playable room without the attacker-controlled mint.
      if (!room && isAuthenticated) {
        return this.createRoomWithId(requestedRoomId);
      }
    }
    // Auto-fill: pack into the FULLEST room still under the soft cap so rooms
    // stay cozy and players are not scattered into lone spawns across many
    // half-empty rooms. Among all rooms with players.size < ROOM_SOFT_CAP_PLAYERS
    // we pick the largest; ties break on lowest id for determinism (needed for
    // predictable load and for the tests). Rooms already in the 12-to-20
    // headroom band are skipped here — that band is invite-code-only. If no room
    // is under the soft cap, mint a fresh one.
    let best: Room | null = null;
    for (const room of this.rooms.values()) {
      if (room.players.size >= ROOM_SOFT_CAP_PLAYERS) continue;
      if (
        best === null ||
        room.players.size > best.players.size ||
        (room.players.size === best.players.size && room.id < best.id)
      ) {
        best = room;
      }
    }
    if (best) return best;
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
    if (avatar.kind) player.kind = avatar.kind;
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
