import { create } from 'zustand';
import type { PlayerSnapshot } from '@clawville/shared';

/**
 * Remote-player runtime state — mirror of `NpcSpriteState` in `stores/npc.ts`,
 * adapted for multiplayer Phase 1. Each entry represents one connected browser
 * session in the same room as the local viewer.
 *
 * Entity-interpolation fields (`prevX/prevY/ts/tsDelta`) mirror the NPC store
 * pattern so the same lerp math in remote-players.tsx
 * smooths network jitter into perfectly visible motion. Render 1 server tick
 * BEHIND real-time — alpha = clamp((Date.now() - ts) / tsDelta, 0, 1).
 *
 * `isLocal` is set during snapshot ingestion (the server doesn't know which
 * session is the viewer's — it broadcasts every session in the room). The
 * local avatar is rendered by `player-avatar.tsx`; remote-players renderer
 * filters this entry out so we don't double-render the player.
 */
export interface RemotePlayerState {
  /**
   * Opaque per-session presence id from the wire (PlayerSnapshot.id). Used as
   * the render/VRM-instance cache key. NOT a
   * raw session token (the server only ever emits the hashed publicId).
   */
  id: string;
  /** Presence kind. Drives the connected-agent indicator dot in the 3D layer. */
  kind: 'human' | 'guest' | 'agent';
  userId: string | null;
  name: string;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  /** Wall-clock ms when this snapshot arrived. Drives entity interpolation. */
  ts: number;
  /** ms between previous and current snapshot for this player (default 200). */
  tsDelta: number;
  /** Heading in radians (atan2(dx, dy)). */
  dirZ: number;
  species: string;
  color: number;
  activity: string;
  /** True for the viewer's own session — remote-render loop skips this entry. */
  isLocal: boolean;
}

interface PlayerStoreState {
  players: RemotePlayerState[];
  /** Stable sessionId for the local viewer (set by use-world-stream after /api/world/join). */
  localSessionId: string | null;
  /** Current room ID assigned by the server. */
  roomId: string | null;
  setLocalSessionId: (sessionId: string | null) => void;
  setRoomId: (roomId: string | null) => void;
  /** Ingest a snapshot's `players[]` slice. Preserves prev fields for interp. */
  updateFromSnapshot: (incoming: PlayerSnapshot[]) => void;
  clear: () => void;
}

function fieldsEqual(a: RemotePlayerState, b: PlayerSnapshot): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.userId === b.userId &&
    a.name === b.name &&
    a.species === b.species &&
    a.color === b.color
  );
}

export const usePlayerStore = create<PlayerStoreState>((set, get) => ({
  players: [],
  localSessionId: null,
  roomId: null,

  setLocalSessionId: (sessionId) => {
    if (get().localSessionId === sessionId) return;
    set({ localSessionId: sessionId });
    // Re-stamp isLocal on existing players when the local presence id changes.
    const players = get().players;
    if (players.length === 0) return;
    let dirty = false;
    for (const p of players) {
      const next = p.id === sessionId;
      if (p.isLocal !== next) {
        p.isLocal = next;
        dirty = true;
      }
    }
    if (dirty) set({ players: [...players] });
  },

  setRoomId: (roomId) => {
    if (get().roomId === roomId) return;
    set({ roomId });
  },

  updateFromSnapshot: (incoming) => {
    const state = get();
    const now = Date.now();
    const localSessionId = state.localSessionId;
    const prevMap = new Map(state.players.map((p) => [p.id, p]));

    const next: RemotePlayerState[] = [];
    for (const snap of incoming) {
      const prev = prevMap.get(snap.id);
      // tsDelta measured from arrival times; floor at 16 ms to avoid
      // divide-by-near-zero if two snapshots land in the same wall-clock tick.
      const tsDelta = prev ? Math.max(16, now - prev.ts) : 200;
      const isLocal = localSessionId != null && snap.id === localSessionId;

      // Mutation pattern (same as NPC store): when identity-relevant fields
      // are unchanged, mutate position/ts on the previous object so React.memo
      // bailouts in the renderer hold across snapshots and only Reconciliation
      // is paid when a player joins, leaves, swaps species, or rename.
      if (prev && fieldsEqual(prev, snap)) {
        prev.prevX = prev.x;
        prev.prevY = prev.y;
        prev.x = snap.x;
        prev.y = snap.y;
        prev.ts = now;
        prev.tsDelta = tsDelta;
        prev.dirZ = snap.dirZ;
        prev.activity = snap.activity;
        prev.isLocal = isLocal;
        next.push(prev);
        continue;
      }

      next.push({
        id: snap.id,
        kind: snap.kind,
        userId: snap.userId,
        name: snap.name,
        x: snap.x,
        y: snap.y,
        prevX: prev?.x ?? snap.x,
        prevY: prev?.y ?? snap.y,
        ts: now,
        tsDelta,
        dirZ: snap.dirZ,
        species: snap.species,
        color: snap.color,
        activity: snap.activity,
        isLocal,
      });
    }

    set({ players: next });
  },

  clear: () => set({ players: [], roomId: null }),
}));
