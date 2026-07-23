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
  ReefPowerUpBoxVariant,
  ReefPowerUpKind,
  ReefPufferMineState,
  ReefWaveSweepState,
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
import { usePokerStore } from './poker';

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

export type ActivityPickup = BumperPickup & {
  variant?: ReefPowerUpBoxVariant;
};

function normalizePowerUpInventory(
  slots: readonly {
    kind: string | null;
    charges: number;
    cooldownUntil?: number;
  }[],
): PowerUpSlot[] {
  const inventory: PowerUpSlot[] = [];
  for (const slot of slots) {
    if (!slot.kind || slot.charges <= 0) continue;
    inventory.push({
      kind: slot.kind,
      charges: slot.charges,
      cooldownUntil: slot.cooldownUntil,
    });
  }
  return inventory;
}

function bankPowerUp(inventory: readonly PowerUpSlot[], kind: string): PowerUpSlot[] {
  const next = inventory.map((slot) => ({ ...slot }));
  if (next.length < 2) next.push({ kind, charges: 1 });
  return next;
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
  pickups: Map<string, ActivityPickup>;
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
  /** EWMA of local epoch minus server epoch, estimated from ping midpoints. */
  serverClockOffsetMs: number | null;
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
  /**
   * SPEC 1 — per-avatar modelKey map for Reef Race GLB dispatch.
   * Populated once on `snapshot.init`, never updated per-tick.
   * Empty map on non-reef-race rooms.
   */
  reefParticipantMeta: Record<string, { modelKey: string }>;

  // ── Reef Race Phase 2 — slipstream + apex + ribbon + hazard ────────────
  /**
   * Phase 2 — true while the self avatar is actively in another's slipstream.
   * Set on `event.slipstream`, cleared on `event.slipstream_end` (both
   * server-driven — no client-side timer needed, audit S4 fix).
   */
  slipstreamActive: boolean;
  /**
   * Phase 2 — last apex verdict for the self avatar. Replaced (not appended)
   * on each `event.apex_verdict` arrival; the toast subscribes to this
   * primitive object reference (a new object fires re-renders).
   * null until the first apex crossing.
   */
  lastApexVerdict: { kind: 'clean' | 'wide'; at: number } | null;
  /**
   * Phase 2 — wall-clock millis of the last `event.ribbon_collected`
   * received for the self avatar. 0 = never collected.
   */
  lastRibbonCollectedAt: number;
  /**
   * Phase 2 — wall-clock millis of the last `event.hazard_hit` received
   * for the self avatar. 0 = never hit.
   */
  lastHazardHitAt: number;

  /**
   * SPEC 3 — last `event.ramp_launch` received (any avatar, not just self).
   * `ReefRacePlayer` subscribes to drive extended nose-up tilt, particle
   * burst, and screen shake for the self avatar. null until first ramp launch.
   */
  lastRampLaunchEvent: {
    avatarId: string;
    rampId: string;
    launchVel: number;
    at: number;
  } | null;

  /**
   * v2 mechanics — last `event.boost_pad` received (any avatar, not just
   * self). Mirrors `lastRampLaunchEvent`'s pattern: `ReefRacePlayer`
   * subscribes to fire a particle burst at the triggering avatar's position;
   * the HUD toast filters to self-only. null until the first pad hit.
   */
  lastBoostPadEvent: { avatarId: string; padId: string; at: number } | null;
  /** R18b arm/landing event for render spin + self surge/HUD feedback. */
  lastTrickEvent: {
    avatarId: string;
    phase: 'armed' | 'landed';
    direction: 'left' | 'right';
    boostMult: number;
    durationMs: number;
    at: number;
  } | null;
  /** Self-only landed trick edge; cannot be overwritten by another racer. */
  lastSelfTrickLandingEvent: {
    avatarId: string;
    phase: 'landed';
    direction: 'left' | 'right';
    boostMult: number;
    durationMs: number;
    at: number;
  } | null;
  /** Last Reef Race countdown launch verdict (self-filtered by consumers). */
  lastLaunchEvent: { avatarId: string; kind: 'boost' | 'stall'; at: number } | null;
  /** Last self Reef Race wall-slam event. */
  lastWallSlamEvent: {
    avatarId: string;
    position: { x: number; y: number };
    power: number;
    at: number;
  } | null;
  /** R18c self obstacle contact; also feeds the existing wall-slam surge path. */
  lastObstacleHitEvent: {
    avatarId: string;
    obstacleId: string;
    kind: 'urchin' | 'driftwood' | 'creature';
    impact: 'spinout' | 'bump';
    durationMs: number;
    position: { x: number; y: number };
    at: number;
  } | null;
  /** Local epoch deadline used to suspend Reef self input/prediction on spinout. */
  selfObstacleControlLockedUntil: number;
  /** Last self Reef Race wipeout start. */
  lastWipeoutEvent: {
    avatarId: string;
    position: { x: number; y: number };
    respawnAtMs: number;
    at: number;
  } | null;
  /** R18d reconnect-safe dynamic puffer mines. */
  reefMines: Map<string, ReefPufferMineState>;
  /** Last authoritative item contact, retained for attacker + victim feedback. */
  lastItemHitEvent: {
    attackerAvatarId: string;
    victimAvatarId: string;
    itemKind: ReefPowerUpKind;
    position: { x: number; y: number };
    at: number;
  } | null;
  lastPowerUpCollectedEvent: {
    collectorAvatarId: string;
    kind?: ReefPowerUpKind;
    variant: ReefPowerUpBoxVariant;
    at: number;
  } | null;
  lastGambleDudEvent: { avatarId: string; durationMs: number; at: number } | null;
  lastCurrentSwapEvent: {
    phase: 'telegraph' | 'resolved' | 'dodged' | 'fizzled';
    attackerAvatarId: string;
    victimAvatarId: string;
    resolvesAtMs: number;
    position?: { x: number; y: number };
    at: number;
  } | null;
  lastWaveSweepEvent: {
    phase: 'telegraph' | 'active' | 'ended';
    waveId: string;
    sector: 1 | 2 | 3 | 4;
    startProgress: number;
    bandLengthWu: number;
    sweepSpeedWuPerSec: number;
    startsAtMs: number;
    endsAtMs: number;
    at: number;
  } | null;
  /** Reconnect/keyframe-safe active wave schedule. */
  activeWave: ReefWaveSweepState | null;
  lastFinalLapEvent: { avatarId: string; at: number } | null;

  // ── Reef Race Phase 3 — self avatar's racing class + level (HUD chip) ─────
  /**
   * Phase 3 — racing class derived from `avatars.archetype` for the SELF avatar,
   * populated once on `snapshot.init` from
   * `frame.room.reefRacingProfiles[selfAvatarId]`. `null` when room is not
   * Reef Race or the profile map is missing.
   */
  selfRacingClass: 'agility' | 'strength' | 'intelligence' | 'balanced' | null;
  /**
   * Phase 3 — `avatars.level` (1..50) for the SELF avatar, populated alongside
   * `selfRacingClass`. Defaults to 1 when missing.
   */
  selfLevel: number;

  // ── Reef Race Phase 4 — streak + match-end summary ─────────────────────
  /**
   * Phase 4 — current consecutive clean checkpoint crosses for the SELF
   * avatar. Driven by `EntityDelta.changed.streak` (per-tick mirror).
   * Subscribed by the HUD streak chip.
   */
  selfStreak: number;
  /**
   * Phase 4 — high-water mark of `selfStreak` across the current match.
   * Updated locally as `selfStreak` increments; surfaced on the match-end
   * modal even if the server's `streakBest` payload arrives slower.
   */
  selfBestStreakThisMatch: number;
  /**
   * Phase 4 — last `pbDelta` block from `event.match_ended`. Populated only
   * on Reef Race matches that improved the PB. Drives the modal's "NEW
   * PERSONAL BEST 12.34s (was 12.89s)" callout.
   */
  lastMatchPbDelta: { newMs: number; oldMs: number | null } | null;
  /**
   * Phase 4 — final `streakBest` from the match-end frame. May exceed
   * `selfBestStreakThisMatch` when the local mirror dropped a delta.
   */
  lastMatchStreakBest: number | null;
  /**
   * Phase 4 — daily-best-lap rank (1..100) for the just-set PB, sourced
   * from `event.match_ended.pbDelta.dailyRank`. C2 fix: this comes from
   * the awaited PB-write result, NOT the public 60s leaderboard cache.
   */
  lastMatchDailyRank: number | null;
  /**
   * Phase 4 — perfect-lap bonus credited (0 when not earned). Mirrors
   * `event.match_ended.rewardPreview.perfectLapBonus`.
   */
  lastMatchPerfectLapBonus: number | null;

  // ── Reef Race v2 (spline sim) — finish-line + wait overlay ─────────────
  /**
   * v2 — true once the LOCAL avatar has crossed the finish line for this match.
   * Set by `event.crossed_finish` when `avatarId === selfAvatarId`. Cleared on
   * `event.match_ended` and `snapshot.init`. Drives the wait-at-finish
   * overlay (`<WaitAtFinishOverlay>`), which only renders while the match
   * is still `live` AND the local avatar has finished.
   */
  selfFinished: boolean;
  /**
   * v2 — local avatar's final placement (1 = first), set by `event.crossed_finish`
   * when the avatarId matches self. null until self finishes.
   */
  selfPlacement: number | null;
  /**
   * v2 — local avatar's authoritative total race time in ms, set by
   * `event.crossed_finish` (server-stamped). null until self finishes.
   */
  selfTotalMs: number | null;
  /**
   * v2 — wait-at-finish countdown deadline (wall-clock ms timestamp). Computed
   * at receipt of `event.finish_wait_started` as `Date.now() + msRemaining`.
   * The overlay reads this and recomputes remaining-ms each render — no
   * setInterval, no cleanup bugs. null until first finisher triggers the
   * countdown.
   */
  finishWaitDeadlineAt: number | null;
  /**
   * v2 — running list of all racers who have crossed the finish line, in
   * placement order. Each `crossed_finish` event appends one row. Used by
   * the wait-at-finish overlay's "Finishers" list.
   */
  finishedRacers: Array<{ avatarId: string; placement: number; totalMs: number }>;

  // ── Writer API ──────────────────────────────────────────────────────────

  /** Single switchboard for `useActivityWs` to apply incoming server frames. */
  applyServerFrame: (frame: ServerFrame) => void;

  /** Imperative actions (used by hooks + page lifecycle). */
  reset: (roomId: string | null) => void;
  setSelfAvatarId: (avatarId: string | null) => void;
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

/** Map a server epoch timestamp onto the browser's monotonic performance clock. */
function snapshotAtPerformanceMs(
  serverTimeMs: number | undefined,
  localMinusServerMs: number | null,
): number | undefined {
  if (typeof serverTimeMs !== 'number' || localMinusServerMs === null) {
    return undefined;
  }
  const nowPerf = performance.now();
  const ageMs = Date.now() - (serverTimeMs + localMinusServerMs);
  // A small negative age can occur while the clock EWMA settles. Authority is
  // never from the future for interpolation purposes, so clamp it to arrival.
  return nowPerf - Math.max(0, ageMs);
}

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
function shortAvatarId(avatarId: string): string {
  return avatarId.length > 8 ? `…${avatarId.slice(-6)}` : avatarId;
}

/** Apply a single EntityDelta to a (mutable) entity map clone. */
function applyEntityDelta(
  map: Map<string, BumperShellEntity>,
  delta: EntityDelta,
  snapshotAtMs: number | undefined,
): void {
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
      snapshotAtMs,
      // Reef Race Phase 1 (audit S11) — initialise so a first-sighting
      // body that's already mid-drift doesn't drop the spark tier.
      driftSparks:
        typeof c.driftSparks === 'number'
          ? ((c.driftSparks as 0 | 1 | 2 | 3) ?? 0)
          : 0,
      // ── Reef Race v2 pass-through (2026-07-10 bug fix + boost-pad/mini-
      // turbo wiring) ──────────────────────────────────────────────────
      // BUG FIX: `height`/`progress`/`lap`/`totalLaps` are declared on
      // `EntityDelta.changed` and the v2 spline sim has been sending them
      // (`reef-race-spline-sim.ts` broadcastDelta) since the CLOSED-LOOP
      // lap rework, but this function never copied them onto the entity
      // map — so `LapCounter`/`ProgressBar`/`BestLapTile` (which read
      // `entity.lap`/`.progress` via `as any`) always saw `undefined`.
      // Same conditional-pass-through style as the fields above.
      ...(typeof c.height === 'number' ? { height: c.height } : {}),
      ...(typeof c.speedMod === 'number' ? { speedMod: c.speedMod } : {}),
      ...(typeof c.progress === 'number' ? { progress: c.progress } : {}),
      ...(typeof c.lap === 'number' ? { lap: c.lap } : {}),
      ...(typeof c.totalLaps === 'number' ? { totalLaps: c.totalLaps } : {}),
      // Boost state is forwarded for all avatars so visible riders can show FX.
      ...(typeof c.boosting === 'boolean' ? { boosting: c.boosting } : {}),
      ...(typeof c.wipedOut === 'boolean' ? { wipedOut: c.wipedOut } : {}),
      ...(typeof c.bubbledUntilMs === 'number' ? { bubbledUntilMs: c.bubbledUntilMs } : {}),
      ...(typeof c.remoraUntilMs === 'number' ? { remoraUntilMs: c.remoraUntilMs } : {}),
    });
    return;
  }
  map.set(delta.avatarId, {
    ...existing,
    snapshotAtMs,
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
    // ── Reef Race v2 pass-through (2026-07-10 bug fix + boost-pad/mini-
    // turbo wiring) — see the matching comment in the first-sighting
    // branch above.
    ...(typeof c.height === 'number' ? { height: c.height } : {}),
    ...(typeof c.speedMod === 'number' ? { speedMod: c.speedMod } : {}),
    ...(typeof c.progress === 'number' ? { progress: c.progress } : {}),
    ...(typeof c.lap === 'number' ? { lap: c.lap } : {}),
    ...(typeof c.totalLaps === 'number' ? { totalLaps: c.totalLaps } : {}),
    ...(typeof c.boosting === 'boolean' ? { boosting: c.boosting } : {}),
    ...(typeof c.wipedOut === 'boolean' ? { wipedOut: c.wipedOut } : {}),
    ...(typeof c.bubbledUntilMs === 'number' ? { bubbledUntilMs: c.bubbledUntilMs } : {}),
    ...(typeof c.remoraUntilMs === 'number' ? { remoraUntilMs: c.remoraUntilMs } : {}),
  });
}

/** Hydrate from a full WorldState (snapshot.init / snapshot.keyframe). */
function hydrateFromWorld(world: WorldState, snapshotAtMs: number | undefined): {
  entities: Map<string, BumperShellEntity>;
  pickups: Map<string, ActivityPickup>;
  reefMines: Map<string, ReefPufferMineState>;
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
      snapshotAtMs,
      // Reef Race v2 — carry boost/meter state from keyframes + snapshot.init so
      // the 1 Hz keyframe (and a mid-match reconnect) doesn't blank the HUD
      // meter/trail until the next delta (Codex finding 7). The delta path
      // (applyEntityDelta) already carries these.
      ...(typeof e.height === 'number' ? { height: e.height } : {}),
      ...(typeof e.speedMod === 'number' ? { speedMod: e.speedMod } : {}),
      ...(typeof e.boosting === 'boolean' ? { boosting: e.boosting } : {}),
      ...(typeof e.wipedOut === 'boolean' ? { wipedOut: e.wipedOut } : {}),
      ...(typeof e.bubbledUntilMs === 'number' ? { bubbledUntilMs: e.bubbledUntilMs } : {}),
      ...(typeof e.remoraUntilMs === 'number' ? { remoraUntilMs: e.remoraUntilMs } : {}),
    });
  }
  const pickups = new Map<string, ActivityPickup>();
  for (const p of world.powerUps) {
    pickups.set(p.spawnId, {
      spawnId: p.spawnId,
      kind: normalizePickupKind(p.kind),
      x: p.position.x,
      y: p.position.y,
      variant: p.variant,
    });
  }
  const reefMines = new Map<string, ReefPufferMineState>();
  for (const mine of world.reefMines ?? []) {
    if (mine.active) reefMines.set(mine.mineId, mine);
  }
  const scores = new Map<string, ActivityScoreEntry>();
  for (const s of world.scores) {
    scores.set(s.avatarId, {
      avatarId: s.avatarId,
      displayName: shortAvatarId(s.avatarId),
      score: s.score,
    });
  }
  let alive = 0;
  entities.forEach((e) => {
    if (e.alive) alive++;
  });
  return { entities, pickups, reefMines, scores, alive };
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
  | 'serverClockOffsetMs'
  | 'chatLog'
  | 'reefRace'
  | 'slipstreamActive'
  | 'lastApexVerdict'
  | 'lastRibbonCollectedAt'
  | 'lastHazardHitAt'
  | 'lastRampLaunchEvent'
  | 'lastBoostPadEvent'
  | 'lastTrickEvent'
  | 'lastSelfTrickLandingEvent'
  | 'lastLaunchEvent'
  | 'lastWallSlamEvent'
  | 'lastObstacleHitEvent'
  | 'selfObstacleControlLockedUntil'
  | 'lastWipeoutEvent'
  | 'reefMines'
  | 'lastItemHitEvent'
  | 'lastPowerUpCollectedEvent'
  | 'lastGambleDudEvent'
  | 'lastCurrentSwapEvent'
  | 'lastWaveSweepEvent'
  | 'activeWave'
  | 'lastFinalLapEvent'
  | 'selfRacingClass'
  | 'selfLevel'
  | 'selfStreak'
  | 'selfBestStreakThisMatch'
  | 'lastMatchPbDelta'
  | 'lastMatchStreakBest'
  | 'lastMatchDailyRank'
  | 'lastMatchPerfectLapBonus'
  | 'selfFinished'
  | 'selfPlacement'
  | 'selfTotalMs'
  | 'finishWaitDeadlineAt'
  | 'finishedRacers'
  | 'reefParticipantMeta'
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
    serverClockOffsetMs: null,
    chatLog: [],
    reefRace: { laps: new Map(), selfBestGhostPath: null },
    // Phase 2 — Reef Race slipstream / apex / ribbon / hazard
    slipstreamActive: false,
    lastApexVerdict: null,
    lastRibbonCollectedAt: 0,
    lastHazardHitAt: 0,
    lastRampLaunchEvent: null,
    lastBoostPadEvent: null,
    lastTrickEvent: null,
    lastSelfTrickLandingEvent: null,
    lastLaunchEvent: null,
    lastWallSlamEvent: null,
    lastObstacleHitEvent: null,
    selfObstacleControlLockedUntil: 0,
    lastWipeoutEvent: null,
    reefMines: new Map(),
    lastItemHitEvent: null,
    lastPowerUpCollectedEvent: null,
    lastGambleDudEvent: null,
    lastCurrentSwapEvent: null,
    lastWaveSweepEvent: null,
    activeWave: null,
    lastFinalLapEvent: null,
    // Phase 3 — Reef Race self-avatar build summary (populated on snapshot.init)
    selfRacingClass: null,
    selfLevel: 1,
    // Phase 4 — streak counter + match-end summary
    selfStreak: 0,
    selfBestStreakThisMatch: 0,
    lastMatchPbDelta: null,
    lastMatchStreakBest: null,
    lastMatchDailyRank: null,
    lastMatchPerfectLapBonus: null,
    // Reef Race v2 — finish-line + wait-at-finish overlay state
    selfFinished: false,
    selfPlacement: null,
    selfTotalMs: null,
    finishWaitDeadlineAt: null,
    finishedRacers: [],
    // SPEC 1 — per-avatar GLB species metadata
    reefParticipantMeta: {},
  };
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useActivityStore = create<ActivityState>()(
  subscribeWithSelector((set, get) => ({
    selfAvatarId: null,
    roomId: null,
    connectionStatus: 'idle',
    ...emptyState(),

    setSelfAvatarId: (avatarId) => set({ selfAvatarId: avatarId }),
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
          const snapshotAtMs = snapshotAtPerformanceMs(
            frame.serverTimeMs,
            state.serverClockOffsetMs,
          );
          const hydrated = hydrateFromWorld(frame.world, snapshotAtMs);
          // Phase 3 — pluck self avatar's racing profile from the room map
          // (S5 wire format). Falls back to (null, 1) so non-Reef rooms
          // and missing profiles render the chip as neutral / hidden.
          const selfAvatarId = state.selfAvatarId;
          const selfEntityInventory = selfAvatarId
            ? frame.world.entities.find((entity) => entity.avatarId === selfAvatarId)?.inventory
            : undefined;
          const profileMap = frame.room.reefRacingProfiles;
          const myProfile =
            selfAvatarId && profileMap ? profileMap[selfAvatarId] : undefined;
          // Phase 4 — populate the self avatar's PB ghost path from the
          // snapshot.init payload (per-recipient, server already gated
          // on identity). Empty/null when the avatar has no PB row yet.
          const selfGhost =
            frame.room.selfBestLapGhost &&
            Array.isArray(frame.room.selfBestLapGhost) &&
            frame.room.selfBestLapGhost.length > 1
              ? frame.room.selfBestLapGhost
              : null;
          const nextReef = selfGhost
            ? { laps: state.reefRace.laps, selfBestGhostPath: selfGhost }
            : state.reefRace;
          // SPEC 1 — inject species from reefParticipantMeta into entity objects.
          // Runs once per snapshot.init, not per-tick. Cost: 1 Map clone + ≤8 iters.
          const participantMeta = frame.room.reefParticipantMeta ?? {};
          let finalEntities = hydrated.entities;
          if (Object.keys(participantMeta).length > 0) {
            const injected = new Map(hydrated.entities);
            injected.forEach((e, avatarId) => {
              const meta = participantMeta[avatarId];
              if (meta) {
                injected.set(avatarId, { ...e, species: meta.modelKey });
              }
            });
            finalEntities = injected;
          }
          set({
            room: frame.room,
            entities: finalEntities,
            pickups: hydrated.pickups,
            reefMines: hydrated.reefMines,
            activeWave: frame.world.activeWave ?? null,
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
            selfRacingClass: myProfile?.class ?? null,
            selfLevel: myProfile?.level ?? 1,
            ...(selfEntityInventory
              ? { powerUpInventory: normalizePowerUpInventory(selfEntityInventory) }
              : {}),
            reefRace: nextReef,
            reefParticipantMeta: participantMeta,
            // v2 — clear finish-line state on a fresh room hydration so a
            // mid-match reconnect or a snapshot.keyframe-style re-init doesn't
            // resurrect last match's "FINISHED — 1st!" overlay.
            selfFinished: false,
            selfPlacement: null,
            selfTotalMs: null,
            finishWaitDeadlineAt: null,
            finishedRacers: [],
          });
          break;
        }

        // ── Snapshot delta (15 Hz hot path) ─────────────────────────────
        case 'snapshot.delta': {
          const snapshotAtMs = snapshotAtPerformanceMs(
            frame.serverTimeMs,
            state.serverClockOffsetMs,
          );
          const entities = new Map(state.entities);
          // Phase 1 (audit S2) — track drift sparks for the self avatar
          // alongside the per-entity application loop. applyEntityDelta has
          // no access to selfAvatarId, so the caller hoists the bookkeeping.
          let nextDriftSparks: 0 | 1 | 2 | 3 = state.driftSparks;
          // Phase 2 — same pattern for live placement on the SELF avatar. The
          // server's per-tick `placement` field on EntityDelta is more
          // reliable than the ScoreDelta-derived placement (which today uses
          // `score: b.lap`, an undercount of progress). Score-derived
          // placement stays as a fallback if a delta omits the field.
          let nextPlacement: number | null = state.placement;
          // Phase 4 — same pattern for the streak counter. Hoisted so the
          // HUD streak chip ticks even on per-checkpoint updates with no
          // positional change. `applyEntityDelta` has no selfAvatarId access.
          let nextStreak: number = state.selfStreak;
          let nextBestStreak: number = state.selfBestStreakThisMatch;
          let nextPowerUpInventory = state.powerUpInventory;
          let receivedSelfInventory = false;
          for (const d of frame.entities) {
            applyEntityDelta(entities, d, snapshotAtMs);
            if (state.selfAvatarId && d.avatarId === state.selfAvatarId) {
              if (d.changed.inventory) {
                nextPowerUpInventory = normalizePowerUpInventory(d.changed.inventory);
                receivedSelfInventory = true;
              }
              if (typeof d.changed.driftSparks === 'number') {
                nextDriftSparks = d.changed.driftSparks as 0 | 1 | 2 | 3;
              }
              if (typeof d.changed.placement === 'number') {
                nextPlacement = d.changed.placement;
              }
              if (typeof d.changed.streak === 'number') {
                nextStreak = d.changed.streak;
                if (nextStreak > nextBestStreak) nextBestStreak = nextStreak;
              }
            }
          }

          let pickups = state.pickups;
          if (frame.powerUps.length > 0) pickups = new Map(state.pickups);
          for (const p of frame.powerUps) {
            if (p.collectorAvatarId) {
              pickups.delete(p.spawnId);
              if (
                !receivedSelfInventory &&
                p.collectorAvatarId === state.selfAvatarId &&
                p.variant !== 'double' &&
                typeof p.kind === 'string'
              ) {
                nextPowerUpInventory = bankPowerUp(nextPowerUpInventory, p.kind);
              }
            } else if (p.position) {
              pickups.set(p.spawnId, {
                spawnId: p.spawnId,
                kind: normalizePickupKind(p.kind),
                x: p.position.x,
                y: p.position.y,
                variant: p.variant,
              });
            }
            // PowerUpDelta.inventory targets the SELF — server only sends
            // the local avatar's inventory (or omits when unchanged).
            if (p.inventory && state.selfAvatarId) {
              nextPowerUpInventory = normalizePowerUpInventory(p.inventory);
              receivedSelfInventory = true;
            }
          }

          let reefMines = state.reefMines;
          if (frame.reefMines && frame.reefMines.length > 0) {
            reefMines = new Map(state.reefMines);
            for (const mine of frame.reefMines) {
              if (mine.active) reefMines.set(mine.mineId, mine);
              else reefMines.delete(mine.mineId);
            }
          }
          const activeWave = frame.activeWave === undefined
            ? state.activeWave
            : frame.activeWave;

          // Score deltas — recompute placements + self placement.
          let scores = state.scores;
          // Start placement from the EntityDelta-hoisted value (Phase 2 — server
          // authoritative). Score-derived placement is a fallback below.
          let placement = nextPlacement;
          if (frame.scores && frame.scores.length > 0) {
            scores = new Map(state.scores);
            for (const s of frame.scores) {
              const existing = scores.get(s.avatarId);
              scores.set(s.avatarId, {
                avatarId: s.avatarId,
                displayName: existing?.displayName ?? shortAvatarId(s.avatarId),
                score: s.score,
                placement: s.placement ?? existing?.placement,
              });
            }
            if (state.selfAvatarId) {
              const self = scores.get(state.selfAvatarId);
              // Only fall back to score-derived placement if the entity-delta
              // hoist didn't produce one (i.e. the server-authoritative
              // placement is missing on this delta).
              if (placement === state.placement) {
                placement = self?.placement ?? placement;
              }
            }
          }

          let alive = 0;
          entities.forEach((e) => {
            if (e.alive) alive++;
          });

          set({
            entities,
            pickups,
            reefMines,
            activeWave,
            scores,
            alive,
            placement,
            driftSparks: nextDriftSparks,
            selfStreak: nextStreak,
            selfBestStreakThisMatch: nextBestStreak,
            powerUpInventory: nextPowerUpInventory,
          });
          break;
        }

        // ── Periodic full state refresh ─────────────────────────────────
        case 'snapshot.keyframe': {
          const snapshotAtMs = snapshotAtPerformanceMs(
            frame.serverTimeMs,
            state.serverClockOffsetMs,
          );
          const hydrated = hydrateFromWorld(frame.world, snapshotAtMs);
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
          // SPEC 1 — re-inject species from reefParticipantMeta on reconnect.
          // keyframe doesn't resend reefParticipantMeta (it's init-only); use
          // stored state.reefParticipantMeta as the fallback source.
          const keyframeMeta = state.reefParticipantMeta;
          let keyframeEntities = hydrated.entities;
          if (Object.keys(keyframeMeta).length > 0) {
            const injected = new Map(hydrated.entities);
            injected.forEach((e, avatarId) => {
              const meta = keyframeMeta[avatarId];
              if (meta) {
                injected.set(avatarId, { ...e, species: meta.modelKey });
              }
            });
            keyframeEntities = injected;
          }
          const selfEntityInventory = state.selfAvatarId
            ? frame.world.entities.find((entity) => entity.avatarId === state.selfAvatarId)
                ?.inventory
            : undefined;
          set({
            entities: keyframeEntities,
            pickups: hydrated.pickups,
            reefMines: hydrated.reefMines,
            activeWave: frame.world.activeWave ?? null,
            scores: merged,
            alive: hydrated.alive,
            total: Math.max(state.total, hydrated.entities.size),
            ...(selfEntityInventory
              ? { powerUpInventory: normalizePowerUpInventory(selfEntityInventory) }
              : {}),
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

        case 'event.match_ended': {
          // Phase 4 — pull PB delta + streak best + daily rank from the
          // per-recipient match-end frame. The server's WS hub has
          // already gated `pbDelta.newGhostFrames` to only the PB-setter,
          // so we trust the payload as-is. When the PB-setter is the SELF
          // avatar AND the match brought new ghost frames, swap in the new
          // path so the next match (without WS reconnect) shows the
          // freshly-set ghost.
          const reward = frame.rewardPreview;
          const reefRaceNext =
            reward?.pbDelta?.newGhostFrames &&
            reward.pbDelta.newGhostFrames.length > 1
              ? {
                  laps: state.reefRace.laps,
                  selfBestGhostPath: reward.pbDelta.newGhostFrames,
                }
              : state.reefRace;
          set({
            matchPhase: 'ended',
            matchEndReason: frame.reason,
            winners: frame.winners,
            rewardPreview: reward,
            reefRace: reefRaceNext,
            lastMatchPbDelta: reward?.pbDelta
              ? { newMs: reward.pbDelta.newMs, oldMs: reward.pbDelta.oldMs }
              : null,
            lastMatchStreakBest:
              typeof reward?.streakBest === 'number'
                ? reward.streakBest
                : null,
            lastMatchDailyRank:
              typeof reward?.pbDelta?.dailyRank === 'number'
                ? reward.pbDelta.dailyRank
                : null,
            lastMatchPerfectLapBonus:
              typeof reward?.perfectLapBonus === 'number'
                ? reward.perfectLapBonus
                : null,
            // v2 — clear the wait-at-finish overlay state. The overlay's
            // render gate (matchPhase === 'live') already hides it, but
            // wiping these so the next match starts with a clean slate
            // even if `reset(roomId)` isn't called between matches.
            selfFinished: false,
            selfPlacement: null,
            selfTotalMs: null,
            finishWaitDeadlineAt: null,
            finishedRacers: [],
          });
          break;
        }

        case 'event.player_joined': {
          // Stamp the displayName into the score row so the mini-leaderboard
          // shows real names instead of avatarId tails.
          const scores = new Map(state.scores);
          const existing = scores.get(frame.avatarId);
          scores.set(frame.avatarId, {
            avatarId: frame.avatarId,
            displayName: frame.displayName || shortAvatarId(frame.avatarId),
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
          //
          // Surface integrity-forfeits to the local player. Without this, an
          // anti-cheat false-positive used to look like "kart randomly froze"
          // with zero feedback. A console.warn is the lightest visible signal
          // that doesn't add new HUD machinery; future work can add a toast.
          if (frame.reason === 'integrity' && state.selfAvatarId === frame.avatarId) {
            // eslint-disable-next-line no-console
            console.warn(
              '[reef-race] You were disqualified by anti-cheat (integrity-forfeit). The server stopped accepting your inputs. Please refresh + report if you were playing normally.',
            );
          }
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
          const at = Date.now();
          const itemHit = frame.itemKind
            ? {
                attackerAvatarId: frame.attackerAvatarId ?? frame.srcAvatarId,
                victimAvatarId: frame.dstAvatarId,
                itemKind: frame.itemKind,
                position: frame.position,
                at,
              }
            : null;
          set({
            events: { ...state.events, hits },
            ...(itemHit ? { lastItemHitEvent: itemHit } : {}),
            ...(itemHit && frame.dstAvatarId === state.selfAvatarId &&
              (frame.itemKind === 'rr-tide-wave' || frame.itemKind === 'rr-whirlpool')
              ? {
                  lastWallSlamEvent: {
                    avatarId: frame.dstAvatarId,
                    position: frame.position,
                    power: frame.itemKind === 'rr-whirlpool' ? 0.92 : 0.78,
                    at,
                  },
                }
              : {}),
          });
          break;
        }

        case 'event.power_up_spawned': {
          const pickups = new Map(state.pickups);
          pickups.set(frame.spawnId, {
            spawnId: frame.spawnId,
            kind: normalizePickupKind(frame.kind),
            x: frame.position.x,
            y: frame.position.y,
            variant: frame.variant,
          });
          set({ pickups });
          break;
        }

        case 'event.power_up_collected': {
          const pickups = new Map(state.pickups);
          pickups.delete(frame.spawnId);
          // Phase 2 — write the placement-aware collected kind into self's
          // inventory slot immediately (audit C2 fix). `frame.kind` is only
          // present on Phase 2 servers; Phase 1 servers omit the field so
          // we guard with `typeof` before writing.
          if (
            state.selfAvatarId &&
            frame.collectorAvatarId === state.selfAvatarId &&
            frame.variant !== 'double' &&
            typeof frame.kind === 'string'
          ) {
            set({
              pickups,
              powerUpInventory: bankPowerUp(state.powerUpInventory, frame.kind),
              lastPowerUpCollectedEvent: {
                collectorAvatarId: frame.collectorAvatarId,
                kind: frame.kind,
                variant: frame.variant ?? 'standard',
                at: Date.now(),
              },
            });
          } else {
            set({
              pickups,
              lastPowerUpCollectedEvent: {
                collectorAvatarId: frame.collectorAvatarId,
                kind: frame.kind,
                variant: frame.variant ?? 'standard',
                at: Date.now(),
              },
            });
          }
          break;
        }

        case 'event.gamble_dud':
          set({
            lastGambleDudEvent: {
              avatarId: frame.avatarId,
              durationMs: frame.durationMs,
              at: Date.now(),
            },
          });
          break;

        case 'event.puffer_mine': {
          const reefMines = new Map(state.reefMines);
          if (frame.phase === 'placed' || frame.phase === 'armed') {
            reefMines.set(frame.mineId, {
              mineId: frame.mineId,
              ownerAvatarId: frame.ownerAvatarId,
              position: frame.position,
              armedAtMs: frame.armedAtMs,
              expiresAtMs: frame.expiresAtMs,
              active: true,
            });
          } else {
            reefMines.delete(frame.mineId);
          }
          set({ reefMines });
          break;
        }

        case 'event.current_swap':
          set({
            lastCurrentSwapEvent: {
              phase: frame.phase,
              attackerAvatarId: frame.attackerAvatarId,
              victimAvatarId: frame.victimAvatarId,
              resolvesAtMs: frame.resolvesAtMs,
              position: frame.position,
              at: Date.now(),
            },
          });
          break;

        case 'event.wave_sweep':
          set({
            lastWaveSweepEvent: { ...frame, at: Date.now() },
            activeWave: frame.phase === 'ended'
              ? null
              : {
                  waveId: frame.waveId,
                  phase: frame.phase,
                  sector: frame.sector,
                  startProgress: frame.startProgress,
                  bandLengthWu: frame.bandLengthWu,
                  sweepSpeedWuPerSec: frame.sweepSpeedWuPerSec,
                  startsAtMs: frame.startsAtMs,
                  endsAtMs: frame.endsAtMs,
                },
          });
          break;

        case 'event.final_lap':
          set({ lastFinalLapEvent: { avatarId: frame.avatarId, at: Date.now() } });
          break;

        // ── Reef Race Phase 2 events ────────────────────────────────────

        case 'event.slipstream': {
          // Only update HUD state for the self avatar.
          if (state.selfAvatarId && frame.dstAvatarId === state.selfAvatarId) {
            // impl-audit M2: dropped `lastSlipstreamEventAt` — was set but
            // never read. Server-driven event.slipstream_end clears the badge
            // (audit S4 flow) so a wall-clock fallback is unneeded.
            set({ slipstreamActive: true });
          }
          break;
        }

        case 'event.slipstream_end': {
          if (state.selfAvatarId && frame.dstAvatarId === state.selfAvatarId) {
            set({ slipstreamActive: false });
          }
          break;
        }

        case 'event.apex_verdict': {
          if (state.selfAvatarId && frame.avatarId === state.selfAvatarId) {
            // New object reference on every event triggers React re-render in toast.
            set({ lastApexVerdict: { kind: frame.kind, at: Date.now() } });
          }
          break;
        }

        case 'event.ribbon_collected': {
          if (state.selfAvatarId && frame.avatarId === state.selfAvatarId) {
            set({ lastRibbonCollectedAt: Date.now() });
          }
          break;
        }

        case 'event.hazard_hit': {
          if (state.selfAvatarId && frame.avatarId === state.selfAvatarId) {
            set({ lastHazardHitAt: Date.now() });
          }
          break;
        }

        // SPEC 3 — ramp launch. Stored for ALL avatars so ReefRacePlayer can
        // apply extended tilt to other visible riders, and so the self-avatar
        // handler can fire particles + screen shake.
        case 'event.ramp_launch': {
          set({
            lastRampLaunchEvent: {
              avatarId: frame.avatarId,
              rampId: frame.rampId,
              launchVel: frame.launchVel,
              at: Date.now(),
            },
          });
          break;
        }

        // v2 mechanics — stored for ALL avatars (mirrors event.ramp_launch)
        // so ReefRacePlayer can burst-FX any visible rider's pad hit, not
        // just self. The HUD toast (reef-race-event-toasts.tsx) filters to
        // self-only itself.
        case 'event.boost_pad': {
          set({ lastBoostPadEvent: { avatarId: frame.avatarId, padId: frame.padId, at: Date.now() } });
          break;
        }

        case 'event.trick': {
          const trickEvent = {
            avatarId: frame.avatarId,
            phase: frame.phase,
            direction: frame.direction,
            boostMult: frame.boostMult,
            durationMs: frame.durationMs,
            at: Date.now(),
          };
          if (frame.phase === 'landed' && frame.avatarId === state.selfAvatarId) {
            set({
              lastTrickEvent: trickEvent,
              lastSelfTrickLandingEvent: { ...trickEvent, phase: 'landed' },
            });
          } else {
            set({ lastTrickEvent: trickEvent });
          }
          break;
        }

        case 'event.wall_slam': {
          if (state.selfAvatarId && frame.avatarId === state.selfAvatarId) {
            set({
              lastWallSlamEvent: {
                avatarId: frame.avatarId,
                position: frame.position,
                power: frame.power,
                at: Date.now(),
              },
            });
          }
          break;
        }

        case 'event.obstacle_hit': {
          if (state.selfAvatarId && frame.avatarId === state.selfAvatarId) {
            const at = Date.now();
            set({
              lastObstacleHitEvent: {
                avatarId: frame.avatarId,
                obstacleId: frame.obstacleId,
                kind: frame.kind,
                impact: frame.impact,
                durationMs: frame.durationMs,
                position: frame.position,
                at,
              },
              selfObstacleControlLockedUntil:
                frame.impact === 'spinout' ? at + frame.durationMs : 0,
              // Reuse the proven wall-SLAM surge/camera treatment. A bump is
              // intentionally milder than an urchin/creature spinout.
              lastWallSlamEvent: {
                avatarId: frame.avatarId,
                position: frame.position,
                power: frame.impact === 'spinout' ? .72 : .38,
                at,
              },
            });
          }
          break;
        }

        case 'event.wipeout': {
          if (state.selfAvatarId && frame.avatarId === state.selfAvatarId) {
            set({
              lastWipeoutEvent: {
                avatarId: frame.avatarId,
                position: frame.position,
                respawnAtMs: frame.respawnAtMs,
                at: Date.now(),
              },
            });
          }
          break;
        }

        // Retired wire variant retained in the shared union for old-server tolerance.
        case 'event.mini_turbo_fire':
          break;

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

        case 'pong': {
          // NTP-style clock-offset sample: midpoint(client send, client receive)
          // minus server receive/send time. Unlike arrival-serverTime, this
          // removes the symmetric network leg instead of folding one-way lag
          // into the clock mapping used by reconciliation.
          const receivedAt = Date.now();
          const midpoint = frame.sentAt + (receivedAt - frame.sentAt) * 0.5;
          const sample = midpoint - frame.serverTime;
          const nextOffset =
            state.serverClockOffsetMs === null
              ? sample
              : state.serverClockOffsetMs + (sample - state.serverClockOffsetMs) * 0.1;
          set({ serverClockOffsetMs: nextOffset });
          break;
        }

        case 'error':
          set({ errorBanner: { code: frame.code, message: frame.message } });
          break;

        // Reef Race Phase 1 — drift-boost release fanout. Phase 1 HUD reads
        // `driftSparks` (already 0 by the time this event lands), so this
        // is a no-op here today. Future scene VFX will hook in.
        case 'event.drift_boost':
          break;

        // Reef Race Phase 1 — per-avatar launch verdict broadcast at LIVE.
        // Phase 1 launch glow ring remains countdown-driven. Retaining the
        // verdict edge lets local presentation distinguish boost from stall.
        case 'event.launch':
          set({
            lastLaunchEvent: {
              avatarId: frame.avatarId,
              kind: frame.kind,
              at: Date.now(),
            },
          });
          break;

        // Reef Race Phase 4 — streak milestone glow trigger. The per-tick
        // streak count rides EntityDelta.changed.streak (handled in
        // snapshot.delta above); this event is the edge-trigger for a
        // burst (HUD glow + future audio sting) at 5/10/20/30/36.
        // Updates `selfStreak` defensively in case a delta was dropped.
        case 'event.streak_milestone': {
          if (state.selfAvatarId && frame.avatarId === state.selfAvatarId) {
            const updates: Partial<ActivityState> = {
              selfStreak: frame.streak,
            };
            if (frame.streak > state.selfBestStreakThisMatch) {
              updates.selfBestStreakThisMatch = frame.streak;
            }
            set(updates);
          }
          break;
        }

        // ── Reef Race v2 (spline sim) — finish-line events ───────────────
        //
        // Wave 2 HUD: thickens the Wave 1.b stub branches into real handlers
        // for the wait-at-finish overlay. These events never fire on the
        // live ellipse sim — the spline sim emits them when a body crosses
        // the finish gate (`event.crossed_finish`) and when the per-match
        // wait timer starts (`event.finish_wait_started`). Drives:
        //   - <ProgressBar> stops growing once self has finished (entity.progress
        //     no longer ticks server-side after crossing)
        //   - <WaitAtFinishOverlay> renders FINISHED — Nth + countdown + finishers
        //   - finishedRacers list grows on each crossing across all racers
        //
        // See `.claude/plans/reef-race-v2.md` "End condition" + protocol notes.

        case 'event.crossed_finish': {
          // Append to the running finishers list, dedup by avatarId so a
          // duplicate broadcast (e.g. WS reconnect echo) doesn't double-count.
          const finishedRacers = state.finishedRacers.some(
            (r) => r.avatarId === frame.avatarId,
          )
            ? state.finishedRacers
            : [
                ...state.finishedRacers,
                {
                  avatarId: frame.avatarId,
                  placement: frame.placement,
                  totalMs: frame.totalMs,
                },
              ];

          // SELF crossed — flip the local-finished flag + stamp final time.
          if (state.selfAvatarId && frame.avatarId === state.selfAvatarId) {
            set({
              finishedRacers,
              selfFinished: true,
              selfPlacement: frame.placement,
              selfTotalMs: frame.totalMs,
            });
          } else {
            set({ finishedRacers });
          }
          break;
        }

        case 'event.finish_wait_started': {
          // Convert msRemaining → wall-clock deadline so render-time recompute
          // doesn't need a setInterval (avoids React effect cleanup bugs and
          // a tab-throttled timer drifting away from server truth).
          set({
            finishWaitDeadlineAt: Date.now() + Math.max(0, frame.msRemaining),
          });
          break;
        }

        // ── Texas Hold'em (`poker.*`) — delegate to the poker store ───────
        //
        // P1.2b: the poker table lives in a SEPARATE lightweight store
        // (`./poker.ts`) so this store's bumper/reef scene-contract surface
        // stays narrow. We route every namespaced poker frame there. The
        // explicit case list (rather than a `frame.type.startsWith('poker.')`
        // guard) keeps the exhaustiveness sentinel below honest — a new
        // poker.* variant fails typecheck in BOTH stores until handled.
        case 'poker.table_state':
        case 'poker.street_dealt':
        case 'poker.action_applied':
        case 'poker.showdown':
        case 'poker.hand_ended':
        case 'poker.hole_cards':
        case 'poker.your_turn':
        // Multi-table MTT (P4) rebalance frames — also poker-store-owned.
        case 'poker.moved':
        case 'poker.table_rebalanced': {
          usePokerStore.getState().applyServerFrame(frame);
          break;
        }

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
