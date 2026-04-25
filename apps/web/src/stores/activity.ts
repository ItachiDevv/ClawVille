/**
 * Activity store — Q2 Activity Portals (chunk #4 wiring).
 *
 * Single zustand store that mirrors the server-authoritative match state
 * for the active activity room. Written by `useActivityWs` (translates
 * `ServerFrame` deltas), read by:
 *
 *   - `apps/web/src/lib/three/activities/bumper-shells/BumperShellsScene.tsx`
 *     (3da-owned, imports `useActivityStore`)
 *   - `apps/web/src/components/game/bumper-shells-hud.tsx` (HUD composition)
 *
 * ─── Coordination contract with 3da's scene ──────────────────────────────────
 *
 * 3da's `bumper-shells-types.ts` declares the EXACT store shape the scene
 * subscribes to. The contract (copied verbatim from that file's comment) is:
 *
 *   interface ActivityStateForScene {
 *     selfAvatarId: string | null;
 *     entities: Map<string, {
 *       avatarId: string;
 *       x: number;       // wu (world units, sim-space)
 *       y: number;       // wu (z in 3D)
 *       rot: number;     // radians
 *       vx: number;
 *       vy: number;
 *       alive: boolean;
 *       color?: string;  // hex tint for shell
 *       species?: string;
 *     }>;
 *     pickups: Map<string, {
 *       spawnId: string;
 *       kind: 'speed' | 'shield' | 'sticky-bomb' | 'whirlpool' | 'ghost' | 'tractor';
 *       x: number;
 *       y: number;
 *     }>;
 *     events: {
 *       hits: Array<{ at: number; x: number; y: number; power: number }>;
 *       eliminations: Array<{ at: number; avatarId: string }>;
 *     };
 *     matchPhase: 'pregame-countdown' | 'live' | 'ended';
 *     countdownSecondsRemaining: number;
 *     roundEndsAt: number | null;
 *   }
 *
 * High-frequency fields (entities, pickups) are held in a `Map` so the
 * scene's `useFrame` loop can do O(1) lookups by avatarId without rebuilding
 * an index every tick. We allocate a NEW Map on each mutation so zustand's
 * shallow equality fires re-renders correctly (immer is not in repo deps).
 *
 * ─── Extra client-only fields (HUD-only, scene ignores) ──────────────────────
 *
 *   ping, connectionStatus, placement, alive, total, scores, powerUpInventory,
 *   matchEndReason, winners, rewardPreview, room, errorBanner
 *
 * These are written by the WS hook from `event.*` / `pong` / `snapshot.delta`
 * frames and consumed only by the HUD components — keeping the scene's
 * subscription surface narrow.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  ServerFrame,
  EntityDelta,
  PowerUpDelta,
  RewardPreview,
  RoomMeta,
  WorldState,
} from '@clawville/shared';
import type {
  BumperShellEntity,
  BumperPickup,
  BumperPickupKind,
  BumperHitEvent,
  BumperEliminationEvent,
  BumperMatchPhase,
} from '@/lib/three/activities/bumper-shells/bumper-shells-types';
import type { GhostFrame, RaceEntityLap } from '@/lib/three/activities/reef-race/reef-race-types';

// ─── Reef Race lap/ghost slice ────────────────────────────────────────────────

export interface ReefRaceState {
  /** Lap completion records per avatarId. */
  laps: Map<string, RaceEntityLap[]>;
  /** Own personal-best ghost path (GhostFrame[] at 10Hz). null until a lap is complete. */
  selfBestGhostPath: GhostFrame[] | null;
}

const EMPTY_REEF_RACE: ReefRaceState = {
  laps: new Map(),
  selfBestGhostPath: null,
};

// ─── Connection status ──────────────────────────────────────────────────────

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

// ─── Score row (HUD-side mirror of ScoreDelta) ──────────────────────────────

export interface ActivityScoreEntry {
  avatarId: string;
  /** Display name resolved from `event.player_joined` when available, else avatarId tail */
  displayName: string;
  score: number;
  placement?: number;
}

// ─── Power-up inventory slot (mirrors PowerUpDelta.inventory[]) ─────────────

export interface PowerUpSlot {
  kind: string;
  charges: number;
  cooldownUntil?: number;
}

// ─── Match-end winners (mirrors event.match_ended.winners) ──────────────────

export interface MatchWinner {
  avatarId: string;
  placement: number;
}

// ─── Chat / emote messages (chunk #11 spectator channel) ────────────────────

/**
 * Chat or emote message captured from a server `chat` frame. Chunk #11
 * keeps these in a small ring buffer so the spectator overlay can render
 * a transcript even though the server doesn't yet fan out a separate
 * spectator channel — local-self echo only at this chunk.
 */
export interface ActivityChatMessage {
  /** Wall-clock millis the message landed locally. */
  at: number;
  /** Sender avatar id (server fills this in). */
  avatarId: string;
  /** Either chat text or rendered emote glyph + label. */
  text: string;
  /** When true, message belongs to the spectator-only channel. */
  spectator: boolean;
  /** Set when this row originated from an `emote` (cheer/taunt). */
  emoteId?: string;
}

// ─── Store interface ────────────────────────────────────────────────────────

export interface ActivityState {
  // ── Scene contract (READ by 3da's BumperShellsScene) ────────────────────
  selfAvatarId: string | null;
  entities: Map<string, BumperShellEntity>;
  pickups: Map<string, BumperPickup>;
  events: {
    hits: BumperHitEvent[];
    eliminations: BumperEliminationEvent[];
  };
  matchPhase: BumperMatchPhase;
  countdownSecondsRemaining: number;
  roundEndsAt: number | null;
  /**
   * Reef Race Phase 1 — current drift charge tier of the SELF avatar (0..3).
   * Subscribed by `<DriftSparksBar>` (see `reef-race-drift-sparks.tsx`).
   * Written by the snapshot.delta caller (NOT inside `applyEntityDelta` —
   * that helper has no access to selfAvatarId; audit S2 fix).
   */
  driftSparks: 0 | 1 | 2 | 3;

  // ── HUD-only mirror state ───────────────────────────────────────────────
  /** Active room id this store snapshot belongs to (used by `reset` guard). */
  roomId: string | null;
  /** Room meta from `snapshot.init`. */
  room: RoomMeta | null;
  /** Last RTT ping in ms, computed from pong roundtrip. */
  ping: number;
  connectionStatus: ConnectionStatus;
  /** Self avatar's current placement (1-indexed). null until score deltas arrive. */
  placement: number | null;
  /** Live count of `entity.alive === true`. */
  alive: number;
  /** Total participants (room.participantCount snapshot). */
  total: number;
  /** Live score table, sorted by score descending in selectors. */
  scores: Map<string, ActivityScoreEntry>;
  /** Self avatar's power-up slots from latest PowerUpDelta.inventory. */
  powerUpInventory: PowerUpSlot[];
  /** Set when `event.match_ended` arrives. */
  matchEndReason: 'complete' | 'forfeit' | 'aborted' | null;
  winners: MatchWinner[];
  rewardPreview: RewardPreview | null;
  /** Last server `error` frame (HUD displays inline if set). */
  errorBanner: { code: string; message: string } | null;
  /**
   * Chunk #11 — chat + emote ring buffer for the spectator overlay.
   * Stored client-side only at this chunk (server-side spectator-channel
   * fan-out is a future chunk). The HUD reads via `selectSpectatorChat`.
   */
  chatLog: ActivityChatMessage[];

  // ── Reef Race slice (additive — Bumper Shells consumers ignore this) ────
  /**
   * Reef Race lap/ghost state. Populated by `event.lap_completed` frames.
   * Undefined on Bumper Shells sessions — always access via `?.reefRace`.
   */
  reefRace: ReefRaceState;

  // ── Writer API ──────────────────────────────────────────────────────────

  /** Single switchboard for `useActivityWs` to apply incoming server frames. */
  applyServerFrame: (frame: ServerFrame) => void;

  /** Imperative actions (used by hooks + page lifecycle). */
  reset: (roomId: string | null) => void;
  setSelfPetId: (avatarId: string | null) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setPing: (ms: number) => void;
  pushHit: (hit: BumperHitEvent) => void;
  pushElimination: (ev: BumperEliminationEvent) => void;
  clearError: () => void;
  /**
   * Chunk #11 — local-only chat append. Used by the HUD when the user
   * sends a spectator chat / emote so the transcript shows immediately
   * without waiting for the server echo (server may not echo at all
   * until the spectator channel ships).
   */
  pushChatLocal: (msg: Omit<ActivityChatMessage, 'at'> & { at?: number }) => void;
  /** Reef Race: record a lap completion from `event.lap_completed`. */
  pushLap: (avatarId: string, lap: number, splitMs: number, totalMs: number) => void;
  /** Reef Race: update the self-best ghost path (call after beating personal best). */
  setGhostPath: (path: GhostFrame[]) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Trim the events.* arrays so they don't grow unbounded across a long match. */
const HIT_RING_BUFFER = 64;
const ELIM_RING_BUFFER = 32;
/** Chat ring buffer size — covers a typical 90s round + spectator phase. */
const CHAT_RING_BUFFER = 64;

/** Map server `kind` strings (free-form for forward-compat) onto our enum. */
function normalizePickupKind(raw: string): BumperPickupKind {
  // Keep the strict union for the scene's discriminated rendering; unknown
  // kinds fall back to 'speed' so an out-of-band server change doesn't crash
  // the scene — it just renders the wrong icon, easy to spot.
  switch (raw) {
    case 'bs-speed-boost':
    case 'speed':
      return 'speed';
    case 'bs-shell-shield':
    case 'shield':
      return 'shield';
    case 'bs-sticky-bomb':
    case 'sticky-bomb':
      return 'sticky-bomb';
    case 'bs-knockback-aura':
    case 'whirlpool':
      return 'whirlpool';
    case 'bs-ghost':
    case 'ghost':
      return 'ghost';
    case 'bs-tractor-beam':
    case 'tractor':
      return 'tractor';
    default:
      return 'speed';
  }
}

/** Display name fallback when we don't have a `player_joined` event yet. */
function shortPetId(avatarId: string): string {
  return avatarId.length > 8 ? `…${avatarId.slice(-6)}` : avatarId;
}

/** Apply a single EntityDelta to a (mutable) entity map clone. */
function applyEntityDelta(map: Map<string, BumperShellEntity>, delta: EntityDelta): void {
  const existing = map.get(delta.avatarId);
  const c = delta.changed;
  if (!existing) {
    // First sighting — only insert if we have at least one positional field.
    map.set(delta.avatarId, {
      avatarId: delta.avatarId,
      x: typeof c.x === 'number' ? c.x : 0,
      y: typeof c.y === 'number' ? c.y : 0,
      rot: typeof c.rot === 'number' ? c.rot : 0,
      vx: typeof c.vx === 'number' ? c.vx : 0,
      vy: typeof c.vy === 'number' ? c.vy : 0,
      alive: c.state !== 'dead' && c.state !== 'eliminated',
      // Reef Race Phase 1 (audit S11) — initialise so a first-sighting
      // body that's already mid-drift doesn't drop the spark tier.
      driftSparks:
        typeof c.driftSparks === 'number'
          ? ((c.driftSparks as 0 | 1 | 2 | 3) ?? 0)
          : 0,
    });
    return;
  }
  map.set(delta.avatarId, {
    ...existing,
    ...(typeof c.x === 'number' ? { x: c.x } : {}),
    ...(typeof c.y === 'number' ? { y: c.y } : {}),
    ...(typeof c.rot === 'number' ? { rot: c.rot } : {}),
    ...(typeof c.vx === 'number' ? { vx: c.vx } : {}),
    ...(typeof c.vy === 'number' ? { vy: c.vy } : {}),
    ...(typeof c.state === 'string'
      ? { alive: c.state !== 'dead' && c.state !== 'eliminated' }
      : {}),
    ...(typeof c.driftSparks === 'number'
      ? { driftSparks: c.driftSparks as 0 | 1 | 2 | 3 }
      : {}),
  });
}

/** Hydrate from a full WorldState (snapshot.init / snapshot.keyframe). */
function hydrateFromWorld(world: WorldState): {
  entities: Map<string, BumperShellEntity>;
  pickups: Map<string, BumperPickup>;
  scores: Map<string, ActivityScoreEntry>;
  alive: number;
} {
  const entities = new Map<string, BumperShellEntity>();
  for (const e of world.entities) {
    entities.set(e.avatarId, {
      avatarId: e.avatarId,
      x: e.position.x,
      y: e.position.y,
      rot: e.rotation,
      vx: e.velocity.x,
      vy: e.velocity.y,
      alive: e.state !== 'dead' && e.state !== 'eliminated',
    });
  }
  const pickups = new Map<string, BumperPickup>();
  for (const p of world.powerUps) {
    pickups.set(p.spawnId, {
      spawnId: p.spawnId,
      kind: normalizePickupKind(p.kind),
      x: p.position.x,
      y: p.position.y,
    });
  }
  const scores = new Map<string, ActivityScoreEntry>();
  for (const s of world.scores) {
    scores.set(s.avatarId, {
      avatarId: s.avatarId,
      displayName: shortPetId(s.avatarId),
      score: s.score,
    });
  }
  let alive = 0;
  entities.forEach((e) => {
    if (e.alive) alive++;
  });
  return { entities, pickups, scores, alive };
}

// ─── Empty-state factory (shared by initial state + reset) ──────────────────

function emptyState(): Pick<
  ActivityState,
  | 'entities'
  | 'pickups'
  | 'events'
  | 'matchPhase'
  | 'countdownSecondsRemaining'
  | 'roundEndsAt'
  | 'driftSparks'
  | 'placement'
  | 'alive'
  | 'total'
  | 'scores'
  | 'powerUpInventory'
  | 'matchEndReason'
  | 'winners'
  | 'rewardPreview'
  | 'errorBanner'
  | 'room'
  | 'ping'
  | 'chatLog'
  | 'reefRace'
> {
  return {
    entities: new Map(),
    pickups: new Map(),
    events: { hits: [], eliminations: [] },
    matchPhase: 'pregame-countdown',
    countdownSecondsRemaining: 0,
    roundEndsAt: null,
    driftSparks: 0,
    placement: null,
    alive: 0,
    total: 0,
    scores: new Map(),
    powerUpInventory: [],
    matchEndReason: null,
    winners: [],
    rewardPreview: null,
    errorBanner: null,
    room: null,
    ping: 0,
    chatLog: [],
    reefRace: { laps: new Map(), selfBestGhostPath: null },
  };
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useActivityStore = create<ActivityState>()(
  subscribeWithSelector((set, get) => ({
    selfAvatarId: null,
    roomId: null,
    connectionStatus: 'idle',
    ...emptyState(),

    setSelfPetId: (avatarId) => set({ selfAvatarId: avatarId }),
    setConnectionStatus: (status) => set({ connectionStatus: status }),
    setPing: (ms) => set({ ping: ms }),
    clearError: () => set({ errorBanner: null }),

    pushLap: (avatarId, lap, splitMs, totalMs) => {
      const state = get();
      const laps  = new Map(state.reefRace.laps);
      const existing = laps.get(avatarId) ?? [];
      laps.set(avatarId, [
        ...existing,
        { avatarId, lap, splitMs, totalMs, recordedAt: Date.now() },
      ]);
      set({ reefRace: { ...state.reefRace, laps } });
    },

    setGhostPath: (path) => {
      const state = get();
      set({ reefRace: { ...state.reefRace, selfBestGhostPath: path } });
    },

    pushHit: (hit) => {
      const next = get().events.hits.slice(-HIT_RING_BUFFER + 1);
      next.push(hit);
      set({ events: { ...get().events, hits: next } });
    },

    pushElimination: (ev) => {
      const next = get().events.eliminations.slice(-ELIM_RING_BUFFER + 1);
      next.push(ev);
      set({ events: { ...get().events, eliminations: next } });
    },

    pushChatLocal: (msg) => {
      const next = get().chatLog.slice(-CHAT_RING_BUFFER + 1);
      next.push({
        at: msg.at ?? Date.now(),
        avatarId: msg.avatarId,
        text: msg.text,
        spectator: msg.spectator,
        emoteId: msg.emoteId,
      });
      set({ chatLog: next });
    },

    reset: (roomId) => {
      set({
        roomId,
        // Preserve selfAvatarId across resets — it's known before the WS opens.
        ...emptyState(),
      });
    },

    applyServerFrame: (frame) => {
      const state = get();

      switch (frame.type) {
        // ── Snapshot init ───────────────────────────────────────────────
        case 'snapshot.init': {
          const hydrated = hydrateFromWorld(frame.world);
          set({
            room: frame.room,
            entities: hydrated.entities,
            pickups: hydrated.pickups,
            scores: hydrated.scores,
            alive: hydrated.alive,
            total: hydrated.entities.size,
            matchPhase:
              frame.room.status === 'live'
                ? 'live'
                : frame.room.status === 'results'
                  ? 'ended'
                  : 'pregame-countdown',
            roundEndsAt: frame.room.endsAt ?? null,
            connectionStatus: 'connected',
            errorBanner: null,
          });
          break;
        }

        // ── Snapshot delta (15 Hz hot path) ─────────────────────────────
        case 'snapshot.delta': {
          const entities = new Map(state.entities);
          // Phase 1 (audit S2) — track drift sparks for the self avatar
          // alongside the per-entity application loop. applyEntityDelta has
          // no access to selfAvatarId, so the caller hoists the bookkeeping.
          let nextDriftSparks: 0 | 1 | 2 | 3 = state.driftSparks;
          for (const d of frame.entities) {
            applyEntityDelta(entities, d);
            if (
              state.selfAvatarId &&
              d.avatarId === state.selfAvatarId &&
              typeof d.changed.driftSparks === 'number'
            ) {
              nextDriftSparks = d.changed.driftSparks as 0 | 1 | 2 | 3;
            }
          }

          const pickups = new Map(state.pickups);
          for (const p of frame.powerUps) {
            if (p.collectorAvatarId) {
              // Collected — drop from world map.
              pickups.delete(p.spawnId);
            } else if (p.position) {
              pickups.set(p.spawnId, {
                spawnId: p.spawnId,
                kind: normalizePickupKind(p.kind),
                x: p.position.x,
                y: p.position.y,
              });
            }
            // PowerUpDelta.inventory targets the SELF — server only sends
            // the local avatar's inventory (or omits when unchanged).
            if (p.inventory && state.selfAvatarId) {
              set({
                powerUpInventory: p.inventory.map((slot) => ({
                  kind: slot.kind,
                  charges: slot.charges,
                  cooldownUntil: slot.cooldownUntil,
                })),
              });
            }
          }

          // Score deltas — recompute placements + self placement.
          let scores = state.scores;
          let placement = state.placement;
          if (frame.scores && frame.scores.length > 0) {
            scores = new Map(state.scores);
            for (const s of frame.scores) {
              const existing = scores.get(s.avatarId);
              scores.set(s.avatarId, {
                avatarId: s.avatarId,
                displayName: existing?.displayName ?? shortPetId(s.avatarId),
                score: s.score,
                placement: s.placement ?? existing?.placement,
              });
            }
            if (state.selfAvatarId) {
              const self = scores.get(state.selfAvatarId);
              placement = self?.placement ?? placement;
            }
          }

          let alive = 0;
          entities.forEach((e) => {
            if (e.alive) alive++;
          });

          set({
            entities,
            pickups,
            scores,
            alive,
            placement,
            driftSparks: nextDriftSparks,
          });
          break;
        }

        // ── Periodic full state refresh ─────────────────────────────────
        case 'snapshot.keyframe': {
          const hydrated = hydrateFromWorld(frame.world);
          // Preserve scores from prior deltas — keyframes don't always include
          // displayName context the WS hook may have built up via player_joined.
          const merged = new Map(state.scores);
          hydrated.scores.forEach((s, id) => {
            const existing = merged.get(id);
            merged.set(id, {
              avatarId: id,
              displayName: existing?.displayName ?? s.displayName,
              score: s.score,
              placement: existing?.placement,
            });
          });
          set({
            entities: hydrated.entities,
            pickups: hydrated.pickups,
            scores: merged,
            alive: hydrated.alive,
            total: Math.max(state.total, hydrated.entities.size),
          });
          break;
        }

        // ── Lifecycle events ────────────────────────────────────────────
        case 'event.countdown':
          set({
            matchPhase: 'pregame-countdown',
            countdownSecondsRemaining: Math.max(0, frame.secondsRemaining),
          });
          break;

        case 'event.match_started':
          set({
            matchPhase: 'live',
            countdownSecondsRemaining: 0,
            roundEndsAt: null, // server provides via snapshot.init endsAt
          });
          break;

        case 'event.match_ended':
          set({
            matchPhase: 'ended',
            matchEndReason: frame.reason,
            winners: frame.winners,
            rewardPreview: frame.rewardPreview,
          });
          break;

        case 'event.player_joined': {
          // Stamp the displayName into the score row so the mini-leaderboard
          // shows real names instead of avatarId tails.
          const scores = new Map(state.scores);
          const existing = scores.get(frame.avatarId);
          scores.set(frame.avatarId, {
            avatarId: frame.avatarId,
            displayName: frame.displayName || shortPetId(frame.avatarId),
            score: existing?.score ?? 0,
            placement: existing?.placement,
          });
          set({ scores, total: Math.max(state.total, state.entities.size + 1) });
          break;
        }

        case 'event.player_left': {
          // Don't drop from `entities` — the body may still be on the field
          // as a static/idle target per backend §3.6. The server's next delta
          // will mark `state: 'dead'` if appropriate.
          break;
        }

        case 'event.eliminated': {
          // Mark entity dead AND push an elimination event for the scene.
          const entities = new Map(state.entities);
          const e = entities.get(frame.avatarId);
          if (e && e.alive) {
            entities.set(frame.avatarId, { ...e, alive: false });
          }
          let alive = 0;
          entities.forEach((x) => {
            if (x.alive) alive++;
          });
          const elims = state.events.eliminations.slice(-ELIM_RING_BUFFER + 1);
          elims.push({ at: Date.now(), avatarId: frame.avatarId });
          set({
            entities,
            alive,
            events: { ...state.events, eliminations: elims },
          });
          break;
        }

        case 'event.hit': {
          // VFX-only event — append to the ring buffer; the scene's
          // HitEventProcessor reads via useFrame and triggers bursts.
          const hits = state.events.hits.slice(-HIT_RING_BUFFER + 1);
          hits.push({
            at: Date.now(),
            x: frame.position.x,
            y: frame.position.y,
            power: typeof frame.power === 'number' ? frame.power : 0.5,
            srcAvatarId: frame.srcAvatarId,
            dstAvatarId: frame.dstAvatarId,
          });
          set({ events: { ...state.events, hits } });
          break;
        }

        case 'event.power_up_spawned': {
          const pickups = new Map(state.pickups);
          pickups.set(frame.spawnId, {
            spawnId: frame.spawnId,
            kind: normalizePickupKind(frame.kind),
            x: frame.position.x,
            y: frame.position.y,
          });
          set({ pickups });
          break;
        }

        case 'event.power_up_collected': {
          const pickups = new Map(state.pickups);
          pickups.delete(frame.spawnId);
          set({ pickups });
          break;
        }

        // Reef Race-only event — recorded into the reefRace.laps slice.
        // Bumper Shells sessions never receive this frame type.
        case 'event.lap_completed': {
          const { avatarId, lap, splitMs, totalMs } = frame;
          const laps = new Map(state.reefRace.laps);
          const existing = laps.get(avatarId) ?? [];
          laps.set(avatarId, [
            ...existing,
            { avatarId, lap, splitMs, totalMs, recordedAt: Date.now() },
          ]);
          set({ reefRace: { ...state.reefRace, laps } });
          break;
        }

        // ── Chat / pong / error ─────────────────────────────────────────
        case 'chat': {
          // Chunk #11: append to ring buffer so the spectator overlay can
          // render a transcript. The active-player chat surface itself is
          // not rendered yet (chunk #8 polish), but spectators MUST see at
          // minimum their own outbound messages — captured here on echo.
          const next = state.chatLog.slice(-CHAT_RING_BUFFER + 1);
          next.push({
            at: Date.now(),
            avatarId: frame.avatarId,
            text: frame.text,
            spectator: Boolean(frame.spectator),
            emoteId: frame.emote?.emoteId,
          });
          set({ chatLog: next });
          break;
        }

        case 'pong':
          // Ping computation lives in `useActivityWs` because it tracks the
          // outgoing `sentAt` per-message. Frame is a no-op here.
          break;

        case 'error':
          set({ errorBanner: { code: frame.code, message: frame.message } });
          break;

        // Reef Race Phase 1 — drift-boost release fanout. Phase 1 HUD reads
        // `driftSparks` (already 0 by the time this event lands), so this
        // is a no-op here today. Future scene VFX will hook in.
        case 'event.drift_boost':
          break;

        // Reef Race Phase 1 — per-avatar launch verdict broadcast at LIVE.
        // Phase 1 launch glow ring is countdown-driven (local computation
        // from room.countdownStartedAt), so this is a no-op here today.
        case 'event.launch':
          break;

        default: {
          // Exhaustiveness sentinel — pull a `never` so a new ServerFrame
          // type without a branch fails typecheck.
          const _exhaustive: never = frame;
          void _exhaustive;
        }
      }
    },
  })),
);

// ─── HUD-side selectors ─────────────────────────────────────────────────────

/**
 * Build a sorted leaderboard array — top N + ALWAYS the self row. Used by
 * `<HudMiniLeaderboard>`. Returns a stable identity per (scores, selfId)
 * change so it can be used directly in a render path.
 */
export function selectLeaderboard(state: ActivityState, max = 5) {
  const arr: ActivityScoreEntry[] = [];
  state.scores.forEach((s) => arr.push(s));
  arr.sort((a, b) => b.score - a.score);
  const top = arr.slice(0, max);
  if (state.selfAvatarId && !top.find((r) => r.avatarId === state.selfAvatarId)) {
    const self = state.scores.get(state.selfAvatarId);
    if (self) top.push(self);
  }
  return top;
}

/**
 * Convenience selector — derived "is self alive" used to gate input + HUD
 * overlays. Returns true if we don't yet know (scene not initialized) so the
 * HUD doesn't flash an "eliminated" overlay before snapshot.init lands.
 */
export function selectSelfAlive(state: ActivityState): boolean {
  if (!state.selfAvatarId) return true;
  const e = state.entities.get(state.selfAvatarId);
  if (!e) return true;
  return e.alive;
}

/**
 * Chunk #11 — spectator-channel chat slice. Filters the chat ring buffer
 * to only spectator-tagged rows (chat + emote echoes from the spectator
 * overlay). Used by `<SpectatorChatPanel>`.
 */
export function selectSpectatorChat(state: ActivityState): ActivityChatMessage[] {
  return state.chatLog.filter((m) => m.spectator);
}

/**
 * Chunk #11 — list of currently-alive entities, used by the spectator
 * overlay's prev/next focus cycler. Stable order by avatarId so cycling
 * through is predictable across snapshot ticks.
 */
export function selectAliveEntities(state: ActivityState): BumperShellEntity[] {
  const out: BumperShellEntity[] = [];
  state.entities.forEach((e) => {
    if (e.alive) out.push(e);
  });
  out.sort((a, b) => (a.avatarId < b.avatarId ? -1 : a.avatarId > b.avatarId ? 1 : 0));
  return out;
}
