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
    // Immutable: replace only the entries whose isLocal flips (new object), keep
    // the rest by reference — consistent with updateFromSnapshot's identity
    // contract so the renderer's memo bails for untouched players.
    const players = get().players;
    if (players.length === 0) return;
    let dirty = false;
    const restamped = players.map((p) => {
      const next = p.id === sessionId;
      if (p.isLocal === next) return p;
      dirty = true;
      return { ...p, isLocal: next };
    });
    if (dirty) set({ players: restamped });
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

    // IMMUTABLE update (2026-06-12, Codex finding #5). Unlike the NPC store —
    // which MUTATES position on the previous object so its 18-NPC subtree never
    // re-renders — remote players go through an adapter copy in
    // remote-players.tsx (`adaptPlayer` is memoized by `player` identity). If we
    // mutate the player object in place its identity never changes, so the
    // adapter's `useMemo([player])` never recomputes and the entry's
    // `npcRef.current` keeps the snapshot position taken at MOUNT — the remote
    // mesh mounts once then FREEZES (the D3a Suspense-outside-memo fix cured the
    // load deadlock but not this steady-state freeze). Replacing each MOVED
    // player with a fresh object flips its identity, so:
    //   - useShallow(s => s.players) sees changed contents → parent re-renders
    //   - the memo'd RemotePlayerEntry sees a new `player` ref → recomputes the
    //     adapter → refreshes npcRef.current with the latest prevX/x/ts/tsDelta
    //   - the mesh's entity-interp lerps prevX→x over tsDelta exactly as designed
    // Unchanged players keep their reference, so memo still bails for them — only
    // the players who actually moved pay reconciliation, at the 5 Hz snapshot
    // rate over the small co-present-session set. This is the correct React
    // pattern and the freeze cannot recur.
    const next: RemotePlayerState[] = [];
    for (const snap of incoming) {
      const prev = prevMap.get(snap.id);
      // tsDelta measured from arrival times; floor at 16 ms to avoid
      // divide-by-near-zero if two snapshots land in the same wall-clock tick.
      const tsDelta = prev ? Math.max(16, now - prev.ts) : 200;
      const isLocal = localSessionId != null && snap.id === localSessionId;

      // Skip allocation when NOTHING changed for this player (no movement, no
      // identity change, same local flag) — keep the previous reference so memo
      // bails and a perfectly still remote player costs zero reconciliation.
      if (
        prev &&
        fieldsEqual(prev, snap) &&
        prev.x === snap.x &&
        prev.y === snap.y &&
        prev.dirZ === snap.dirZ &&
        prev.activity === snap.activity &&
        prev.isLocal === isLocal
      ) {
        next.push(prev);
        continue;
      }

      // Anything changed (position, heading, activity, identity, or local flag)
      // → emit a NEW object so the renderer re-derives and the mesh sees fresh
      // interpolation endpoints. prevX/prevY carry the prior CURRENT position so
      // the entity-interp lerps from where the player was to where they are.
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
