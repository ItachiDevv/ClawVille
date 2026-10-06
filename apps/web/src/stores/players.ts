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
 * These fields (and x/y/dirZ/locomotion activity) are MUTATED IN PLACE on
 * position-only snapshots (see updateFromSnapshot): read them live, never
 * cache a copy keyed by object identity.
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
  /** ms between previous and current snapshot for this player, clamped [120, 320] (first sight 200). */
  tsDelta: number;
  /** Heading in radians (atan2(dx, dy)). */
  dirZ: number;
  species: string;
  color: number;
  activity: string;
  /** True for the viewer's own session — remote-render loop skips this entry. */
  isLocal: boolean;
}

/**
 * Cap on the "former selves" id set (2026-06-19). A long session that flaps
 * (repeated SSE reconnect / 409 rejoin) could otherwise accumulate ids
 * unbounded. 16 covers any realistic reconnect churn; older ids age out (their
 * server bodies are long GC'd, so they can never reappear in a snapshot anyway).
 */
const MAX_LOCAL_SESSION_IDS = 16;

interface PlayerStoreState {
  players: RemotePlayerState[];
  /** Latest presence id for the local viewer (set by use-world-stream after /api/world/join). */
  localSessionId: string | null;
  /**
   * EVERY presence id this client has been assigned this session ("former
   * selves"), capped at MAX_LOCAL_SESSION_IDS. A reconnect/identity transition
   * (e.g. guest→authed bootstrap flip) reseats us under a NEW publicId while the
   * server may still hold our PRIOR body for up to 30s; rendering it would show
   * a ghostly "Visitor" trailing us. `isLocal` filters against this whole set
   * (not just the latest id) so we never render any of our own bodies.
   */
  localSessionIds: Set<string>;
  /** Current room ID assigned by the server. */
  roomId: string | null;
  setLocalSessionId: (sessionId: string | null) => void;
  setRoomId: (roomId: string | null) => void;
  /**
   * Ingest a snapshot's `players[]` slice. Position-only changes mutate the
   * existing objects in place and do not notify subscribers; joins, leaves,
   * reorders and render-field changes replace the array (see the function).
   */
  updateFromSnapshot: (incoming: PlayerSnapshot[]) => void;
  clear: () => void;
  /**
   * Drop the remote bodies but KEEP who we are (localSessionId, the former-
   * selves set, roomId). For a downlink pause while the world session lives
   * on (activity routes, 2026-07-30). Using clear() there erased our own ids,
   * so on return our own body arrived as a remote player and trailed us by the
   * interpolation delay (founder R5, 2026-09-18).
   */
  clearRemote: () => void;
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

/**
 * Plain locomotion verbs. The renderer reads them only in its frame loop
 * (idle vs walk vs run clip), so a flip between two of them is NOT a
 * structural change. Every other verb (AT_COVE_ACTIVITY, AT_KELP_ACTIVITY,
 * AT_ACTIVITY, or an unknown one) can change the rendered name label, so a
 * change to or from it IS structural.
 */
const LOCOMOTION_ACTIVITIES: ReadonlySet<string> = new Set(['idle', 'walking', 'running']);

function activityStructurallyEqual(prev: string, next: string): boolean {
  return prev === next || (LOCOMOTION_ACTIVITIES.has(prev) && LOCOMOTION_ACTIVITIES.has(next));
}

/** Receipt-gap clamp, same rule and bounds as the NPC store (3dStructure §6z stage 3). */
const TS_DELTA_MIN_MS = 120;
const TS_DELTA_MAX_MS = 320;
const TS_DELTA_FIRST_MS = 200;

export const usePlayerStore = create<PlayerStoreState>((set, get) => ({
  players: [],
  localSessionId: null,
  localSessionIds: new Set<string>(),
  roomId: null,

  setLocalSessionId: (sessionId) => {
    const cur = get();
    if (cur.localSessionId === sessionId) return;
    // Accumulate "former selves" (every id we've been assigned this session).
    // A new id is added to the set (capped, oldest evicted); a null id (unmount)
    // just clears the latest pointer — clear() resets the set on teardown.
    let ids = cur.localSessionIds;
    if (sessionId != null && !ids.has(sessionId)) {
      ids = new Set(ids);
      ids.add(sessionId);
      while (ids.size > MAX_LOCAL_SESSION_IDS) {
        const oldest = ids.values().next().value;
        if (oldest === undefined) break;
        ids.delete(oldest);
      }
    }
    set({ localSessionId: sessionId, localSessionIds: ids });
    // Re-stamp isLocal on existing players against the UPDATED id set. Immutable:
    // replace only the entries whose isLocal flips (new object), keep the rest by
    // reference — consistent with updateFromSnapshot's identity contract so the
    // renderer's memo bails for untouched players.
    const players = cur.players;
    if (players.length === 0) return;
    let dirty = false;
    const restamped = players.map((p) => {
      const next = ids.has(p.id);
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
    const localSessionIds = state.localSessionIds;
    const prevPlayers = state.players;
    const prevMap = new Map(prevPlayers.map((p) => [p.id, p]));

    // MUTATE-IN-PLACE for position-only changes (web-load T3, 2026-10-06) —
    // the NPC store pattern (stores/npc.ts updateFromSnapshot).
    //
    // Why: the 2026-06-12 immutable update (Codex finding #5) gave every MOVED
    // player a new object, so `useShallow(s => s.players)` re-rendered
    // RemotePlayers at the 5 Hz stream rate per moving remote player; each such
    // SyncLane render of the R3F root discards every pending Suspense retry
    // lane in the scene (reconciler 0.31 retry lanes never expire).
    //
    // Now x/y/prevX/prevY/ts/tsDelta/dirZ and a locomotion-only activity flip
    // are written onto the EXISTING object. The `players` array and every
    // object keep their identity, and when nothing structural changed the
    // store is not even notified (no `set`). The renderer reads these fields
    // live every frame (remote-players.tsx RemotePlayerBody getters), which is
    // what keeps the Codex #5 freeze from coming back: nothing may cache a
    // COPY of them keyed by object identity.
    //
    // Structural changes still produce a new object and a new array: a join,
    // a leave, a reorder, or a change to a field the render uses (identity
    // fields in fieldsEqual, isLocal, or an activity change that can change
    // the name label, see activityStructurallyEqual).
    let structural = incoming.length !== prevPlayers.length;
    const next: RemotePlayerState[] = [];
    for (let i = 0; i < incoming.length; i += 1) {
      const snap = incoming[i];
      const prev = prevMap.get(snap.id);
      // Receipt gap, clamped [120, 320] ms like the NPC store: the renderer
      // plays each position segment over tsDelta, so raw gaps (coalesced
      // flushes near 0 ms, stalls of seconds) would modulate rendered speed.
      const tsDelta = prev
        ? Math.min(TS_DELTA_MAX_MS, Math.max(TS_DELTA_MIN_MS, now - prev.ts))
        : TS_DELTA_FIRST_MS;
      // isLocal against the WHOLE former-selves set so an orphaned prior body
      // (different publicId, same browser) is filtered out, not rendered as a
      // trailing "Visitor". See localSessionIds.
      const isLocal = localSessionIds.has(snap.id);

      if (
        prev &&
        fieldsEqual(prev, snap) &&
        prev.isLocal === isLocal &&
        activityStructurallyEqual(prev.activity, snap.activity)
      ) {
        // prevX/prevY carry the prior CURRENT position so the entity-interp
        // lerps from where the player was to where they are. A still player
        // gets prevX === x (no motion) and a fresh ts, so its next move
        // starts from a nominal tsDelta instead of a multi-second one.
        prev.prevX = prev.x;
        prev.prevY = prev.y;
        prev.x = snap.x;
        prev.y = snap.y;
        prev.ts = now;
        prev.tsDelta = tsDelta;
        prev.dirZ = snap.dirZ;
        prev.activity = snap.activity;
        next.push(prev);
        if (prevPlayers[i] !== prev) structural = true;
        continue;
      }

      // Structural change → a NEW object, so React re-renders the entry and
      // the body re-reads the render-time fields (name label, model, color).
      structural = true;
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

    if (structural) set({ players: next });
  },

  clear: () =>
    set({ players: [], roomId: null, localSessionId: null, localSessionIds: new Set<string>() }),

  clearRemote: () => {
    if (get().players.length === 0) return;
    set({ players: [] });
  },
}));
