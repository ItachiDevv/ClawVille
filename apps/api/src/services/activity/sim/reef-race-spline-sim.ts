/**
 * Reef Race v2 — spline-based sim. Replaces the ellipse sim when
 * REEF_RACE_USE_SPLINE=true.
 *
 * Public method shape mirrors `ReefRaceSim` in `./reef-race-sim.ts` so the
 * activity-ws-hub dispatcher can swap implementations behind the
 * `REEF_RACE_USE_SPLINE` flag with zero call-site churn (architecture doc §8).
 *
 * Architecture: .claude/plans/reef-race-v2-spline-architecture.md
 * Spec:         .claude/plans/reef-race-v2.md
 *
 * FEATURE_GATE: reef_race_spline_sim
 * Status: Phase 1 implementation — full sim, races complete end-to-end.
 * Metric to graduate: Phase 1 ship gate met (races complete end-to-end on
 *   the spline track per `.claude/plans/reef-race-v2.md` Phase 1).
 * Current reading: Phase 1 complete — wired into dispatcher pending env flip.
 * Review deadline: 2026-05-12
 * On deadline: If the spline sim hasn't graduated past skeleton by then,
 *   delete this file and reopen the v2 plan instead of carrying dead code.
 * Reference: `.claude/plans/reef-race-v2.md` "Phased Implementation"
 *
 * Coordinate convention:
 *   - XZ plane is the race surface (Y is altitude / heightOffset)
 *   - body.x / body.z are the flat-plane coords that feed closestPointOnSpline
 *   - Protocol position: { x: body.x, y: body.z }  (legacy y = scene Z)
 *   - body.rot = Math.atan2(tangent.x, tangent.z)  (Three.js Y-rotation, XZ)
 *
 * Drift mechanic is RETIRED. ACTION_BIT_DRIFT (bit 2) is REUSED as
 * ACTION_BIT_JUMP — same wire bit, new semantic. Jump state machine replaces
 * the drift state machine in every tick step.
 *
 * v2-specific additions to each body vs v1 ellipse:
 *   heightOffset  : number   — metres above track surface (0 = on ground)
 *   vyAxis        : number   — vertical velocity (wu/s, positive = up)
 *   airborneTicks : number   — ticks since last jump (0 = grounded)
 *   progress      : number   — arclength fraction 0..1 (replaces lap+nextCheckpoint)
 *   prevProgress  : number   — progress from previous tick (anti-cheat regression)
 *
 * Oval-specific mechanics NOT ported:
 *   - Apex zones and ribbons (track-geometry-specific to the ellipse)
 *   - Off-track reset (spline corridor wall clamp replaces it)
 *   - Lap counter + checkpoint AABB system (progress replaces)
 *   - Drift charge sparks and drift-boost (drift retired for jump)
 *   - Ghost frame capture (TODO Phase 2)
 *   - Streak counter (TODO Phase 2)
 */

import {
  validateInputBounds,
  type InputBounds,
} from '../anti-cheat/shared';
import type { ServerFrame } from '@clawville/shared';
import {
  logEvent,
  ACTIVITY_EVENT_TYPES,
  type ActivityAntiCheatFlagPayload,
} from '../../event-logger';
import type { BotController } from '../bots/bot-controller';
import {
  REEF_TICK_HZ,
  REEF_MAX_SPEED,
  REEF_MAX_ACCEL,
  // REEF_DRAG retired in the v2 surf model — replaced by directional
  // forwardDrag + lateralGrip in integrateSurfStep (still used by the ellipse
  // sim via reef-race-sim.ts).
  REEF_BODY_RADIUS,
  REEF_SOFT_TIMEOUT_MS,
  REEF_HARD_TIMEOUT_MS,
  REEF_MAX_POWER_UP_SLOTS,
  REEF_POWERUP_RESPAWN_MS,
  REEF_POWERUP_RADIUS,
  REEF_POWERUP_DEFS,
  getReefPowerUpDef,
  type ReefPowerUpKind,
  type ReefBoostKind,
  LAUNCH_BOOST_MULT,
  LAUNCH_BOOST_DURATION_MS,
  LAUNCH_STALL_DURATION_MS,
  LAUNCH_STALL_THRUST_CAP,
  ACTION_BIT_DRIFT,        // reused as ACTION_BIT_JUMP — same wire bit
  REEF_KINEMATIC_TOLERANCE,
  KINEMATIC_BOOST_CAP,
  NEGATIVE_KINETIC_FLOOR,
  SLIPSTREAM_MIN_DISTANCE,
  SLIPSTREAM_MAX_DISTANCE,
  SLIPSTREAM_HALF_WIDTH,
  SLIPSTREAM_MIN_VEL_ALIGNMENT,
  SLIPSTREAM_REQUIRED_TICKS,
  SLIPSTREAM_BOOST_MULT,
  SLIPSTREAM_GRACE_TICKS,
  SLIPSTREAM_REFRESH_TTL_MS,
  HAZARD_TICK_DURATION_MS,
  HAZARD_SLOW_MULT,
  getPlacementItemTable,
  buildBodyMultipliers,
  NEUTRAL_BODY_MULTIPLIERS,
  type BodyMultipliers,
  type AvatarRacingProfile,
  // v2 specific
  REEF_JUMP_IMPULSE_MANUAL,
  REEF_JUMP_IMPULSE_RAMP,
  REEF_GRAVITY,
  // SPEC 3 — ramps
  buildSplineRamps,
  type SplineRampPatch,
  // 2026-06-02 — slow-zone obstacle clusters (wide-course steering pressure)
  buildSplineObstacles,
  type SplineObstaclePatch,
  REEF_AIRBORNE_STEER_MULT,
  ACTION_BIT_POWERUP_0,
  ACTION_BIT_POWERUP_1,
  // v2 surf-carving kinematics (2026-06-01)
  REEF_TURN_RATE,
  REEF_TURN_SPEED_FALLOFF,
  REEF_FORWARD_DRAG,
  REEF_LATERAL_GRIP,
} from './reef-race-config';
import { integrateSurfStep, type SurfParams } from '@clawville/shared';
import { ReefSpline, type Vec2 } from './reef-race-spline';
import {
  REEF_RACE_DEFAULT_TRACK,
} from './reef-race-track-layout';
import { ReefFlagCounter } from '../anti-cheat/reef-race';
import type { PowerUpInventorySlot } from '../anti-cheat/reef-race';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Same wire bit as ACTION_BIT_DRIFT, new semantic for v2. */
const ACTION_BIT_JUMP = ACTION_BIT_DRIFT;

/** Sim tick rate inherited from config. */
const REEF_SIM_HZ = REEF_TICK_HZ;
const REEF_TICK_MS = 1000 / REEF_SIM_HZ;

/** Delta snapshot every 50ms (20Hz). Keyframe every 1s (1Hz). */
const REEF_SNAPSHOT_HZ = 20;
const REEF_TICKS_PER_SNAPSHOT = Math.round(REEF_SIM_HZ / REEF_SNAPSHOT_HZ);
const REEF_TICKS_PER_KEYFRAME = REEF_SIM_HZ;

/**
 * After crossing the finish line, the room waits this long for stragglers
 * before calling endRound. Gives trailing racers a window to finish.
 */
const REEF_FINISH_WAIT_MS = 30_000;

/** Wall tangential friction after clamp. */
const WALL_TANGENT_FRICTION = 0.98;

/**
 * v2 surf model (2026-06-01) — spread wall corrections over a few ticks
 * instead of one hard snap-back. Each tick the body is pushed inward by at
 * most this fraction of the overshoot (a spring), so brushing a wall while
 * carving feels like a scrub, not a yank. With ~1/3 per tick at 30Hz a deep
 * overshoot resolves in ~3-5 ticks (~0.1-0.17s).
 */
const WALL_CORRECTION_PER_TICK = 0.34;

/**
 * Hard cap on a single tick's inward positional correction (wu). Prevents a
 * teleport-grade overshoot (e.g. a cheat packet placing the body 5000wu out)
 * from snapping back in one frame; the body walks back in over several ticks.
 * Sized above one tick of travel at top speed (≈ 925/30 ≈ 31wu boosted) so a
 * legitimately fast body is corrected in one tick but a pathological overshoot
 * is spread.
 */
const WALL_MAX_CORRECTION_WU = 60;

/**
 * Fraction of the OUTWARD velocity component scrubbed per tick at a wall
 * (1.0 = fully killed in one tick = the old yank). 0.55 bleeds outward
 * momentum over ~2-3 ticks so the kart slides along the wall instead of
 * stopping dead — paired with WALL_TANGENT_FRICTION on the tangential part.
 */
const WALL_OUTWARD_SCRUB = 0.55;

/**
 * Cap on a single body's per-tick kart-vs-kart positional push (wu). Spreads a
 * deep overlap (e.g. two karts sharing a spawn cell) over several ticks.
 */
const PROXIMITY_MAX_PUSH_WU = 30;

/** Quantisation factors for snapshot encoding. */
const POS_QUANT = 10;
const ROT_QUANT = 1000;

// ─── Local progress anti-cheat stub ──────────────────────────────────────────
// Phase 2: the anti-cheat module will own this. Local stub for Phase 1.

function progressIsMonotonic(curr: number, prev: number): boolean {
  // Allow up to 2% backward motion (floating-point noise / wall clamp).
  return curr >= prev - 0.02;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ReefBoostEntry {
  expiresAt: number;
  mult?: number;
}

interface SplineBodyIntent {
  /** Normalised direction vector in XZ plane (null = no steering). */
  dir: Vec2 | null;
  thrust: number;
  actionBits: number;
  seq: number;
  dt: number;
  consumedSeq: number;
}

/**
 * Per-kart simulation state for the spline track.
 * Keys differ from ellipse ReefBody:
 *   - x, z  instead of x, y   (flat-plane coords in XZ convention)
 *   - vx, vz instead of vx, vy
 *   - heightOffset / vyAxis / airborneTicks — vertical axis (v2 new)
 *   - progress / prevProgress — arclength fraction 0..1 (replaces lap/nextCheckpoint)
 *   - NO drift fields
 */
interface SplineBody {
  avatarId: string;

  // ── Flat-plane position / velocity (XZ) ────────────────────────────────
  x: number;
  z: number;
  vx: number;
  vz: number;
  rot: number;   // Three.js Y-rotation = Math.atan2(tangent.x, tangent.z)

  // ── Vertical axis (v2) ──────────────────────────────────────────────────
  heightOffset: number;  // metres above track surface (0 = grounded)
  vyAxis: number;        // vertical velocity (wu/s, +up)
  airborneTicks: number; // 0 = grounded, >0 = airborne

  // ── Race progress ───────────────────────────────────────────────────────
  /** Arclength fraction 0..1. 1.0 = finish line crossed. */
  progress: number;
  prevProgress: number;
  finishedAt: number | null;
  placement: number | null;
  totalTimeMs: number;

  // ── Lifecycle ────────────────────────────────────────────────────────────
  alive: boolean;
  dnf: boolean;
  forfeited: boolean;

  // ── Input intent ─────────────────────────────────────────────────────────
  intent: SplineBodyIntent;

  // ── Power-ups ────────────────────────────────────────────────────────────
  inventory: PowerUpInventorySlot[];
  activeEffects: Map<string, number>;      // kind → expiresAt
  activeBoosts: Map<ReefBoostKind, ReefBoostEntry>;

  // ── Slipstream ───────────────────────────────────────────────────────────
  slipstreamSourceAvatarId: string | null;
  slipstreamConsecutiveTicks: number;
  slipstreamGraceTicksLeft: number;

  // ── Phase 3 multipliers ───────────────────────────────────────────────────
  mults: BodyMultipliers;

  // ── Bot flag ─────────────────────────────────────────────────────────────
  isBot: boolean;
}

/** Snapshot of a single body for delta encoding. */
interface SplineBodySnap {
  avatarId: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  rot: number;
  height: number;
  progress: number;
  finishedAt: number | null;
  dnf: boolean;
  placement: number | null;
}

interface SplinePickup {
  spawnId: string;
  position: Vec2;  // XZ centerline position
  kind: ReefPowerUpKind;
  active: boolean;
  collectedAt: number | null;
  respawnAt: number;
}

interface SplineSnapshot {
  tick: number;
  bodies: SplineBodySnap[];
  pickups: Array<{
    spawnId: string;
    kind: ReefPowerUpKind;
    x: number;
    z: number;
    active: boolean;
  }>;
}

interface SplineRoomState {
  roomId: string;
  activityId: string;
  startedAt: number;
  softEndsAt: number;
  hardEndsAt: number;

  /** Spline object — built once per room from REEF_RACE_DEFAULT_TRACK. */
  spline: ReefSpline;

  tick: number;
  bodies: Map<string, SplineBody>;
  pickups: SplinePickup[];

  rngState: number;
  flagCounter: ReefFlagCounter;
  lastSnapshot: SplineSnapshot | null;
  intervalHandle: ReturnType<typeof setInterval> | null;
  ended: boolean;

  /** avatarIds in finish order. */
  finishOrder: string[];

  /**
   * Timestamp when the FIRST body finished. Used to start the
   * REEF_FINISH_WAIT_MS window that gives stragglers time to finish.
   */
  firstFinishedAt: number | null;

  /** Cached live placements, refreshed each tick. */
  lastPlacementMap: Map<string, number>;

  botControllers: Map<string, BotController>;
  botSeqs: Map<string, number>;

  /** SPEC 3 — ramp trigger volumes (built once per room). */
  ramps: SplineRampPatch[];
  /** SPEC 3 — per-body ramp cooldown map: avatarId → (rampId → expiresAt ms). */
  rampCooldowns: Map<string, Map<string, number>>;

  /**
   * 2026-06-02 — slow-zone obstacle clusters (built once per room). On the
   * wide course these create line-choice pressure: a body whose AABB overlaps
   * an obstacle eats a brief `hazard-slow` (-40%) speedMod. Static for the
   * room's lifetime; also surfaced to the client via `getStaticZones`.
   */
  obstacles: SplineObstaclePatch[];
}

type SimBroadcastFn = (roomId: string, frame: ServerFrame) => void;

// ─── Helper utilities ─────────────────────────────────────────────────────────

function emptyInventory(): PowerUpInventorySlot[] {
  const out: PowerUpInventorySlot[] = [];
  for (let i = 0; i < REEF_MAX_POWER_UP_SLOTS; i++) {
    out.push({ kind: null, charges: 0, cooldownUntil: 0 });
  }
  return out;
}

function deriveSeedFromRoomId(roomId: string): number {
  let h = 5381;
  for (let i = 0; i < roomId.length; i++) {
    h = ((h << 5) + h + roomId.charCodeAt(i)) >>> 0;
  }
  return h || 1;
}

function lcgNext(state: SplineRoomState): number {
  state.rngState = (state.rngState * 1664525 + 1013904223) >>> 0;
  return state.rngState;
}

function quant(v: number, factor: number): number {
  return Math.round(v * factor) / factor;
}

// ─── Main class ───────────────────────────────────────────────────────────────

/**
 * Spline-sim equivalent of `ReefRaceSim`. Fully implemented for Phase 1.
 * Public method surface mirrors the ellipse sim for zero dispatcher churn.
 */
export class ReefRaceSplineSim {
  private rooms = new Map<string, SplineRoomState>();
  private broadcastFn: SimBroadcastFn = () => {};
  private endedFn: ((roomId: string) => void) | null = null;
  private integrityForfeitFn:
    | ((roomId: string, avatarId: string) => void)
    | null = null;

  // ─── Public lifecycle API ─────────────────────────────────────────────────

  setBroadcastFn(fn: SimBroadcastFn): void {
    this.broadcastFn = fn;
  }

  setEndedFn(fn: (roomId: string) => void): void {
    this.endedFn = fn;
  }

  setIntegrityForfeitFn(fn: (roomId: string, avatarId: string) => void): void {
    this.integrityForfeitFn = fn;
  }

  startRoom(
    roomId: string,
    activityId: string,
    participantAvatarIds: string[],
    opts?: {
      seed?: number;
      isBot?: (avatarId: string) => boolean;
      bots?: BotController[];
      startedAt?: number;
      launchBoosts?: Map<string, 'boost' | 'stall'>;
      avatarProfiles?: Map<string, AvatarRacingProfile>;
    },
  ): SplineRoomState {
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId)!;
    }

    const seed = opts?.seed ?? deriveSeedFromRoomId(roomId);
    const startedAt = opts?.startedAt ?? Date.now();

    // Build the spline once — shared across all tick iterations.
    const spline = new ReefSpline(REEF_RACE_DEFAULT_TRACK);

    const botControllers = new Map<string, BotController>();
    if (opts?.bots) {
      for (const ctrl of opts.bots) {
        if (!participantAvatarIds.includes(ctrl.avatarId)) {
          console.warn(
            `[spline-sim] bot controller for ${ctrl.avatarId} not a participant — skipping`,
          );
          continue;
        }
        botControllers.set(ctrl.avatarId, ctrl);
      }
    }

    const state: SplineRoomState = {
      roomId,
      activityId,
      startedAt,
      softEndsAt: startedAt + REEF_SOFT_TIMEOUT_MS,
      hardEndsAt: startedAt + REEF_HARD_TIMEOUT_MS,
      spline,
      tick: 0,
      bodies: new Map(),
      pickups: [],
      rngState: seed >>> 0 || 1,
      flagCounter: new ReefFlagCounter(),
      lastSnapshot: null,
      intervalHandle: null,
      ended: false,
      finishOrder: [],
      firstFinishedAt: null,
      lastPlacementMap: new Map(),
      botControllers,
      botSeqs: new Map(),
      // SPEC 3 — ramp trigger volumes, built once per room.
      ramps: buildSplineRamps(),
      rampCooldowns: new Map(),
      // 2026-06-02 — slow-zone obstacle clusters, built once per room.
      obstacles: buildSplineObstacles(),
    };

    // ── Spawn bodies at the start line (t=0, z=0) ─────────────────────────
    // Lateral stagger: 2 columns, spaced 70wu apart along -Z (behind line),
    // 90wu left/right. Facing +Z (down-track) → rot = atan2(0, 1) = 0.
    // tangent at t=0 is (0, 1) in XZ → rot = atan2(0, 1) = 0.
    const startTangent = spline.tangentAt(0); // {x≈0, z≈1}
    const startNormal  = spline.normalAt(0);  // {x≈-1, z≈0} (left of +Z)

    const SPAWN_SPACING_Z = 70;
    const SPAWN_OFFSET_X  = 90;

    participantAvatarIds.forEach((avatarId, i) => {
      const row = Math.floor(i / 2);
      const col = i % 2 === 0 ? -1 : 1;   // left / right column

      // Place behind start line along -tangent, staggered laterally.
      const backZ = row * SPAWN_SPACING_Z + 30;
      const x = startTangent.x * (-backZ) + startNormal.x * col * SPAWN_OFFSET_X;
      const z = startTangent.z * (-backZ) + startNormal.z * col * SPAWN_OFFSET_X;

      // Face down-track (+Z direction).
      const rot = Math.atan2(startTangent.x, startTangent.z);

      const activeBoosts = new Map<ReefBoostKind, ReefBoostEntry>();
      const verdict = opts?.launchBoosts?.get(avatarId) ?? null;
      if (verdict === 'boost') {
        activeBoosts.set('launch-boost', {
          expiresAt: startedAt + LAUNCH_BOOST_DURATION_MS,
          mult: LAUNCH_BOOST_MULT,
        });
      } else if (verdict === 'stall') {
        activeBoosts.set('launch-stall', {
          expiresAt: startedAt + LAUNCH_STALL_DURATION_MS,
        });
      }

      const profile = opts?.avatarProfiles?.get(avatarId) ?? null;
      const mults = buildBodyMultipliers(profile);

      state.bodies.set(avatarId, {
        avatarId,
        x,
        z,
        vx: 0,
        vz: 0,
        rot,
        heightOffset: 0,
        vyAxis: 0,
        airborneTicks: 0,
        progress: 0,
        prevProgress: 0,
        finishedAt: null,
        placement: null,
        totalTimeMs: 0,
        alive: true,
        dnf: false,
        forfeited: false,
        intent: {
          dir: null,
          thrust: 0,
          actionBits: 0,
          seq: 0,
          dt: 0,
          consumedSeq: -1,
        },
        inventory: emptyInventory(),
        activeEffects: new Map(),
        activeBoosts,
        slipstreamSourceAvatarId: null,
        slipstreamConsecutiveTicks: 0,
        slipstreamGraceTicksLeft: 0,
        mults,
        isBot: opts?.isBot?.(avatarId) ?? botControllers.has(avatarId),
      });
    });

    // ── Pickup boxes along the spline ─────────────────────────────────────
    // Place REEF_POWERUP_BOX_COUNT boxes at evenly-spaced arc fractions,
    // alternating left/right of centerline for visual variety.
    const boxCount = 8; // Phase 1: fixed count, TODO: import REEF_POWERUP_BOX_COUNT
    for (let i = 0; i < boxCount; i++) {
      const t = (i + 0.5) / boxCount;
      const center = spline.centerlineAt(t);
      const normal  = spline.normalAt(t);
      const halfW   = spline.widthAt(t);
      const lateralSign = i % 2 === 0 ? 1 : -1;
      const offsetMag = Math.min(halfW * 0.5, 40);
      const rngState = state.rngState;
      void rngState; // rollPowerUpKind uses state.rngState internally via lcgNext
      state.pickups.push({
        spawnId: `${roomId.slice(0, 8)}-pk-${i}`,
        position: {
          x: center.x + normal.x * lateralSign * offsetMag,
          z: center.z + normal.z * lateralSign * offsetMag,
        },
        kind: this.rollPowerUpKind(state),
        active: true,
        collectedAt: null,
        respawnAt: 0,
      });
    }

    this.rooms.set(roomId, state);

    // ── Bot spawn hooks ───────────────────────────────────────────────────
    if (state.botControllers.size > 0) {
      const view = this.buildBotRoomView(state, '');
      for (const [avatarId, ctrl] of state.botControllers) {
        if (!ctrl.onSpawn) continue;
        try {
          ctrl.onSpawn({ ...view, selfAvatarId: avatarId });
        } catch (err) {
          console.error(`[spline-sim] bot onSpawn threw for ${avatarId}:`, err);
        }
      }
    }

    // ── Initial broadcast ─────────────────────────────────────────────────
    this.broadcastFn(roomId, { type: 'event.match_started', startedAt });
    if (opts?.launchBoosts) {
      for (const [avatarId, kind] of opts.launchBoosts) {
        this.broadcastFn(roomId, { type: 'event.launch', avatarId, kind });
      }
    }
    for (const pk of state.pickups) {
      this.broadcastFn(roomId, {
        type: 'event.power_up_spawned',
        spawnId: pk.spawnId,
        kind: pk.kind,
        position: { x: pk.position.x, y: pk.position.z },
      });
    }

    // ── Start tick loop ───────────────────────────────────────────────────
    state.intervalHandle = setInterval(() => {
      try {
        this.tickRoom(state);
      } catch (err) {
        console.error('[spline-sim] tick exception:', err);
        state.ended = true;
        if (state.intervalHandle) clearInterval(state.intervalHandle);
        state.intervalHandle = null;
      }
    }, REEF_TICK_MS);

    return state;
  }

  stopRoom(roomId: string): void {
    const state = this.rooms.get(roomId);
    if (!state) return;
    state.ended = true;
    if (state.intervalHandle) {
      clearInterval(state.intervalHandle);
      state.intervalHandle = null;
    }
    this.rooms.delete(roomId);
  }

  getStateSnapshot(roomId: string): SplineSnapshot | null {
    const state = this.rooms.get(roomId);
    if (!state) return null;
    return this.buildSnapshot(state);
  }

  applyInput(
    roomId: string,
    avatarId: string,
    seq: number,
    dt: number,
    rawInput: InputBounds,
  ): { ok: boolean; forfeit: boolean; flagsAdded: number } {
    const state = this.rooms.get(roomId);
    if (!state) return { ok: false, forfeit: false, flagsAdded: 0 };
    const body = state.bodies.get(avatarId);
    if (!body || !body.alive || body.forfeited || body.finishedAt !== null) {
      return { ok: false, forfeit: false, flagsAdded: 0 };
    }
    if (seq <= body.intent.consumedSeq) {
      return { ok: false, forfeit: false, flagsAdded: 0 };
    }

    const verdict = validateInputBounds(rawInput);
    const safe = verdict.value;
    const clampedDt = Math.max(0, Math.min(dt, (1 / REEF_SIM_HZ) * 5));

    // dir is Vec2 {x,z} in XZ convention. validateInputBounds returns {x,y};
    // we map y → z for the spline sim's XZ flat plane.
    const rawDir = safe.dir;
    body.intent = {
      dir: rawDir ? { x: rawDir.x, z: rawDir.y } : null,
      thrust: safe.thrust ?? 0,
      actionBits: safe.actionBits ?? 0,
      seq,
      dt: clampedDt,
      consumedSeq: body.intent.consumedSeq,
    };

    return { ok: true, forfeit: false, flagsAdded: 0 };
  }

  forfeit(
    roomId: string,
    avatarId: string,
    reason: 'integrity' | 'timeout' | 'voluntary',
  ): void {
    const state = this.rooms.get(roomId);
    if (!state) return;
    const body = state.bodies.get(avatarId);
    if (!body || body.finishedAt !== null) return;

    body.forfeited = true;
    body.dnf = true;
    body.alive = false;

    this.broadcastFn(state.roomId, {
      type: 'event.player_left',
      avatarId,
      reason,
    });

    const stillRacing = Array.from(state.bodies.values()).some(
      (b) => b.alive && !b.dnf && b.finishedAt === null,
    );
    const finishedCount = Array.from(state.bodies.values()).filter(
      (b) => b.finishedAt !== null,
    ).length;

    if (!stillRacing && finishedCount === 0) {
      this.endRound(state, 'all_forfeited');
    } else if (!stillRacing) {
      this.endRound(state, 'all_finished');
    }
  }

  computeResults(
    roomId: string,
  ): Array<{
    avatarId: string;
    placement: number;
    score: number;
    scoreMs: number | null;
  }> {
    const state = this.rooms.get(roomId);
    if (!state) return [];

    const finishers = Array.from(state.bodies.values())
      .filter((b) => b.finishedAt !== null && !b.dnf)
      .sort((a, b) => a.totalTimeMs - b.totalTimeMs);

    const dnfers = Array.from(state.bodies.values())
      .filter((b) => b.finishedAt === null || b.dnf)
      .sort((a, b) => {
        // Higher progress = better among DNFers.
        if (b.progress !== a.progress) return b.progress - a.progress;
        return a.avatarId.localeCompare(b.avatarId);
      });

    const out: Array<{
      avatarId: string;
      placement: number;
      score: number;
      scoreMs: number | null;
    }> = [];
    let placement = 1;

    for (const f of finishers) {
      out.push({
        avatarId: f.avatarId,
        placement: placement++,
        score: -f.totalTimeMs,
        scoreMs: f.totalTimeMs,
      });
    }
    for (const d of dnfers) {
      out.push({
        avatarId: d.avatarId,
        placement: placement++,
        score: -(REEF_HARD_TIMEOUT_MS + 1),
        scoreMs: null,
      });
    }
    return out;
  }

  getFlagCount(roomId: string, avatarId: string): number {
    const state = this.rooms.get(roomId);
    if (!state) return 0;
    return state.flagCounter.countFor(avatarId);
  }

  __resetForTest(): void {
    for (const state of this.rooms.values()) {
      if (state.intervalHandle) clearInterval(state.intervalHandle);
    }
    this.rooms.clear();
  }

  __tickOnceForTest(roomId: string): void {
    const state = this.rooms.get(roomId);
    if (!state) return;
    this.tickRoom(state);
  }

  __getState(roomId: string): SplineRoomState | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * 2026-06-02 — server-authoritative static zones for the client's
   * `RoomMeta.reefStaticZones` channel (the same surface the ellipse sim's
   * `getStaticZones` feeds; `ReefRaceHazards.tsx` reads `.hazards`). The spline
   * sim has NO ribbons / apex zones (those were oval-only mechanics), so those
   * arrays are empty; the obstacle clusters map onto `hazards` so the existing
   * urchin-field renderer draws them at their world XZ positions.
   *
   * Protocol convention (matches bodyToWireEntity + ReefRaceHazards): the
   * returned `center` is `{ x: sceneX, y: sceneZ }`. `radius` is the obstacle's
   * tangent-perpendicular half-width (the visible footprint of the slow zone).
   */
  getStaticZones(roomId: string): {
    // Protocol Vec2 ({x,y}) shape — IDENTICAL to the ellipse sim's
    // `getStaticZones` so the ws-hub's conditional union collapses to one type
    // and assigns cleanly to `RoomMeta.reefStaticZones`. (The spline's internal
    // Vec2 is {x,z}; we map z→y at the boundary, same as bodyToWireEntity.)
    ribbons: Array<{ id: string; a: { x: number; y: number }; b: { x: number; y: number } }>;
    apexZones: Array<{
      hairpinIndex: number;
      innerCenter: { x: number; y: number };
      outerCenter: { x: number; y: number };
    }>;
    hazards: Array<{ id: string; center: { x: number; y: number }; radius: number }>;
  } | null {
    const state = this.rooms.get(roomId);
    if (!state) return null;
    return {
      ribbons: [],
      apexZones: [],
      hazards: state.obstacles.map((obs) => {
        const pt   = state.spline.centerlineAt(obs.t);
        const tang = state.spline.tangentAt(obs.t);
        const nx = -tang.z;
        const nz =  tang.x;
        const cx = pt.x + nx * obs.lateralOffset;
        const cz = pt.z + nz * obs.lateralOffset;
        return {
          id: obs.id,
          // protocol y = scene Z (same map as bodyToWireEntity).
          center: { x: cx, y: cz },
          radius: obs.halfWidth,
        };
      }),
    };
  }

  // ─── Internal — tick loop ──────────────────────────────────────────────────

  private tickRoom(state: SplineRoomState): void {
    if (state.ended) return;

    state.tick += 1;
    const now = Date.now();
    const dt = 1 / REEF_SIM_HZ;

    // 0. Refresh placement cache once per tick.
    state.lastPlacementMap = this.computeLivePlacements(state);

    // 0a. Bot intent scheduling.
    if (state.botControllers.size > 0) {
      this.runBotControllers(state, dt, now);
    }

    // 1. Apply intents → integrate velocity + position + vertical axis.
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;
      this.applyIntentForTick(state, body, dt, now);
    }

    // 2. Wall clamp — project bodies back into the spline corridor.
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;
      this.enforceSplineWallClamp(state, body);
    }

    // 3. Expire activeEffects + activeBoosts.
    for (const body of state.bodies.values()) {
      for (const [kind, expires] of body.activeEffects) {
        if (expires <= now) body.activeEffects.delete(kind);
      }
      for (const [kind, entry] of body.activeBoosts) {
        if (entry.expiresAt <= now) {
          body.activeBoosts.delete(kind);
        }
      }
    }

    // 3a. Slipstream detection (after integration so distances are current).
    this.resolveSlipstream(state, now);

    // 4. Body-body proximity push.
    this.resolveProximity(state);

    // 4a. Wall clamp safety pass after proximity (no velocity reflection).
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;
      this.enforceSplineWallClamp(state, body, /*reflectVelocity*/ false);
    }

    // 5. Power-up pickup collision.
    this.resolvePickups(state, now);

    // 5d. Ramp launch triggers (SPEC 3).
    this.resolveRamps(state, now);

    // 5e. Slow-zone obstacle clusters (2026-06-02). Bodies whose AABB overlaps
    //     an obstacle on the inside racing line / chicane center eat a brief
    //     hazard-slow — the wide course's steering-via-design pressure.
    this.resolveObstacles(state, now);

    // 6. Pickup respawn cycle.
    this.tickPickups(state, now);

    // 7. Update race progress (arclength fraction) + finish-line detection.
    this.resolveProgress(state, now);

    // 8. Round-end conditions.
    if (this.shouldEndRound(state, now)) {
      this.applyTimeouts(state, now);
      const finishedCount = Array.from(state.bodies.values()).filter(
        (b) => b.finishedAt !== null,
      ).length;
      this.endRound(
        state,
        finishedCount > 0 ? 'all_finished' : 'time_expired',
      );
      return;
    }

    // 9. Snapshot broadcast cadence.
    if (state.tick % REEF_TICKS_PER_KEYFRAME === 0) {
      this.broadcastKeyframe(state);
    } else if (state.tick % REEF_TICKS_PER_SNAPSHOT === 0) {
      this.broadcastDelta(state);
    }
  }

  // ─── applyIntentForTick ────────────────────────────────────────────────────

  private applyIntentForTick(
    state: SplineRoomState,
    body: SplineBody,
    dt: number,
    now: number,
  ): void {
    // Capture velocity before mutation for the validator at the end.
    const prevVx = body.vx;
    const prevVz = body.vz;

    const intent = body.intent;

    // 1. Consume seq.
    if (intent.seq > intent.consumedSeq) {
      intent.consumedSeq = intent.seq;
    }

    // 2. Power-up actionBits (bits 0 + 1).
    const actionBits = intent.actionBits;
    if (actionBits & ACTION_BIT_POWERUP_0) this.tryUsePowerUp(state, body, 0, now);
    if (actionBits & ACTION_BIT_POWERUP_1) this.tryUsePowerUp(state, body, 1, now);

    // 3. Speed modifier (same four-stage model as ellipse sim).
    const slicked      = body.activeEffects.has('rr-ink-slick');
    const powerBoosted = body.activeEffects.has('rr-turbo-bubble');
    const stalled      = body.activeBoosts.has('launch-stall');

    const rawThrust       = Math.max(0, Math.min(1, intent.thrust));
    const effectiveThrust = stalled
      ? Math.min(rawThrust, LAUNCH_STALL_THRUST_CAP)
      : rawThrust;

    let speedMod: number;
    if (stalled) {
      speedMod = 0.5;
    } else {
      // Four-stage combination (mirrors ellipse sim §2.3 audit).
      const launchAdd = body.activeBoosts.has('launch-boost')
        ? (body.activeBoosts.get('launch-boost')!.mult ?? 0)
        : 0;
      const slipAdd = body.activeBoosts.has('slipstream-boost')
        ? SLIPSTREAM_BOOST_MULT
        : 0;
      // v2 has no drift-boost or ribbon-boost — those are oval-only
      const positiveKineticStack = Math.min(
        launchAdd + slipAdd,
        KINEMATIC_BOOST_CAP,
      );

      const pickupBoostAdd = powerBoosted ? 0.35 : 0; // rr-turbo-bubble

      const negativeKineticStack = Math.max(
        (body.activeBoosts.has('hazard-slow')
          ? (body.activeBoosts.get('hazard-slow')!.mult ?? 0) - 1
          : 0) +
          (body.activeBoosts.has('apex-penalty')
            ? (body.activeBoosts.get('apex-penalty')!.mult ?? 0) - 1
            : 0),
        NEGATIVE_KINETIC_FLOOR,
      );

      if (slicked) {
        speedMod = 0.30;
      } else {
        speedMod = 1.0 + positiveKineticStack + negativeKineticStack;
        if (pickupBoostAdd > 0) {
          speedMod = Math.max(speedMod, 1.0 + pickupBoostAdd);
        }
      }
    }

    // 4. Jump-trigger (heading + velocity integrate happen below via the
    //    shared surf-carving step).
    const dir = intent.dir;  // Vec2 {x,z} or null

    // v2: jump trigger replaces drift charge. Bit 2 = ACTION_BIT_JUMP.
    const jumpBit = (actionBits & ACTION_BIT_JUMP) !== 0;
    if (jumpBit && body.airborneTicks === 0 && body.heightOffset === 0) {
      body.vyAxis += REEF_JUMP_IMPULSE_MANUAL;
      body.airborneTicks = 1;
    }

    // 5+6+8. Surf-carving integrate — heading-rate + lateral-grip + carried
    // momentum, all in the PURE shared `integrateSurfStep` so the web client
    // can mirror it for prediction. Airborne reduces the heading TURN RATE
    // ONLY (no forward-speed penalty — jumps no longer slow the kart). The
    // Phase 3 agility "tighter turning" stat (turnRadiusMult < 1) maps to a
    // FASTER heading rate; accelMult scales forward acceleration as before.
    const airborne = body.airborneTicks > 0;
    const turnRadiusMult =
      Number.isFinite(body.mults.turnRadiusMult) && body.mults.turnRadiusMult > 0
        ? body.mults.turnRadiusMult
        : 1.0;
    const surfParams: SurfParams = {
      maxSpeed: REEF_MAX_SPEED,
      maxAccel: REEF_MAX_ACCEL,
      // Agility (turnRadiusMult < 1) → faster heading rate (= old "tighter
      // turning" buff). Bounded by /turnRadiusMult so 0.85 → +17.6% rate.
      turnRate: REEF_TURN_RATE / turnRadiusMult,
      turnSpeedFalloff: REEF_TURN_SPEED_FALLOFF,
      airborneSteerMult: REEF_AIRBORNE_STEER_MULT,
      forwardDrag: REEF_FORWARD_DRAG,
      lateralGrip: REEF_LATERAL_GRIP,
      speedMod,
      accelMult: body.mults.accelMult,
    };

    const prevX = body.x;
    const prevZ = body.z;

    const next = integrateSurfStep(
      { x: body.x, z: body.z, vx: body.vx, vz: body.vz, rot: body.rot },
      { dir: dir ?? null, thrust: effectiveThrust, airborne },
      surfParams,
      dt,
    );
    body.rot = next.rot;
    body.vx = next.vx;
    body.vz = next.vz;
    body.x = next.x;
    body.z = next.z;

    // 7. Velocity delta validator (Phase 3 anti-cheat backstop). Carving
    //    redirects momentum but never raises speed above the thrust+boost cap,
    //    so a legitimate hard turn at top speed (~43 wu/s vector change) plus
    //    one tick of lateral bleed (≤ ~50 wu/s) stays well under this ceiling.
    const deltaMag = Math.hypot(body.vx - prevVx, body.vz - prevVz);
    const maxLegitDelta =
      REEF_MAX_ACCEL * dt * REEF_KINEMATIC_TOLERANCE;
    if (deltaMag > maxLegitDelta) {
      // Clamp to the legitimate ceiling (preserve direction of the change).
      const excess = deltaMag - maxLegitDelta;
      const normX = (body.vx - prevVx) / deltaMag;
      const normZ = (body.vz - prevVz) / deltaMag;
      body.vx -= normX * excess;
      body.vz -= normZ * excess;
      // Re-integrate position from the clamped velocity so the position
      // validator below sees the corrected step.
      body.x = prevX + body.vx * dt;
      body.z = prevZ + body.vz * dt;
      this.flag(state, body.avatarId, 'overaccel',
        `delta=${deltaMag.toFixed(1)} max=${maxLegitDelta.toFixed(1)}`);
    }

    // Position delta validator.
    const posDelta = Math.hypot(body.x - prevX, body.z - prevZ);
    const maxPosDelta = REEF_MAX_SPEED * REEF_KINEMATIC_TOLERANCE * dt;
    if (posDelta > maxPosDelta) {
      // Scale back to max.
      const posScale = maxPosDelta / posDelta;
      body.x = prevX + (body.x - prevX) * posScale;
      body.z = prevZ + (body.z - prevZ) * posScale;
      this.flag(state, body.avatarId, 'overspeed',
        `pos_delta=${posDelta.toFixed(1)} max=${maxPosDelta.toFixed(1)}`);
    }

    // Hard velocity cap when positive boost is active (1.85× ceiling). The
    // surf model's forward drag keeps cruise near MAX_SPEED*speedMod; this is
    // the hard backstop on the boost stack.
    const isPositiveBoostActive =
      body.activeBoosts.has('launch-boost') ||
      body.activeBoosts.has('slipstream-boost');
    if (isPositiveBoostActive) {
      const speed = Math.hypot(body.vx, body.vz);
      const hardCap = REEF_MAX_SPEED * 1.85;
      if (speed > hardCap) {
        body.vx = (body.vx / speed) * hardCap;
        body.vz = (body.vz / speed) * hardCap;
      }
    }

    // 9. Vertical axis (gravity + jump).
    if (body.heightOffset > 0 || body.vyAxis !== 0) {
      body.vyAxis -= REEF_GRAVITY * dt;
      body.heightOffset = Math.max(0, body.heightOffset + body.vyAxis * dt);
      if (body.heightOffset === 0 && body.vyAxis < 0) {
        // Landed.
        body.vyAxis = 0;
        body.airborneTicks = 0;
      } else if (body.heightOffset > 0) {
        body.airborneTicks++;
      }
    }
  }

  // ─── Wall clamp ────────────────────────────────────────────────────────────

  /**
   * Project body back inside the spline corridor.
   * Architecture doc §3 algorithm:
   *   closest = closestPointOnSpline({x, z})
   *   if dist > halfW:
   *     push inward by overshoot
   *     kill outward velocity component
   *     apply tangential friction
   */
  private enforceSplineWallClamp(
    state: SplineRoomState,
    body: SplineBody,
    reflectVelocity = true,
  ): void {
    const closest = state.spline.closestPointOnSpline({ x: body.x, z: body.z });
    const halfW = state.spline.widthAt(closest.t);
    if (closest.distance <= halfW) return; // inside corridor, no-op

    // Compute inward push normal. normalAt(t) is 90° CCW of tangent = LEFT of
    // travel. If the body is on the LEFT side (side='L'), push RIGHT (inward)
    // = -normalAt. If on the RIGHT, push LEFT (inward) = +normalAt.
    const n = state.spline.normalAt(closest.t);
    const inwardX = closest.side === 'L' ? -n.x : n.x;
    const inwardZ = closest.side === 'L' ? -n.z : n.z;

    // Positional correction — spread over ticks (spring), capped per tick so a
    // teleport-grade overshoot can't snap back in one frame (no hard yank).
    //   - targetCorrection: distance to fully re-enter (1.2% inset to avoid an
    //     immediate re-clamp next tick).
    //   - springCorrection: gentle per-tick step, capped at WALL_MAX_CORRECTION_WU.
    //   - correction = min(target, spring): small brush walks back over a few
    //     ticks; a pathological overshoot is spread (never teleports back).
    // The body MAY still be slightly outside after a tick — the next tick's
    // clamp continues the spring. Progress isn't inflated by being lateral
    // (closestPointOnSpline maps to the same centerline t).
    const overshoot = closest.distance - halfW;
    const targetCorrection = overshoot * 1.012;
    const springCorrection = Math.min(
      overshoot * WALL_CORRECTION_PER_TICK + 0.5,
      WALL_MAX_CORRECTION_WU,
    );
    const correction = Math.min(targetCorrection, springCorrection);
    body.x += inwardX * correction;
    body.z += inwardZ * correction;

    if (!reflectVelocity) {
      // Safety pass — scrub outward velocity only (no tangential change).
      const vN = body.vx * (-inwardX) + body.vz * (-inwardZ);
      if (vN > 0) {
        body.vx += inwardX * vN * WALL_OUTWARD_SCRUB;
        body.vz += inwardZ * vN * WALL_OUTWARD_SCRUB;
      }
      return;
    }

    // Primary clamp: scrub the OUTWARD velocity component over a few ticks
    // (WALL_OUTWARD_SCRUB) + scuff the tangential speed (WALL_TANGENT_FRICTION)
    // so the kart slides along the wall instead of stopping dead.
    const outwardX = -inwardX;
    const outwardZ = -inwardZ;
    const vN = body.vx * outwardX + body.vz * outwardZ;
    if (vN > 0) {
      // Decompose into outward + tangential, scrub each independently.
      const vTx = body.vx - vN * outwardX;
      const vTz = body.vz - vN * outwardZ;
      const remainingOutward = vN * (1 - WALL_OUTWARD_SCRUB);
      body.vx = vTx * WALL_TANGENT_FRICTION + remainingOutward * outwardX;
      body.vz = vTz * WALL_TANGENT_FRICTION + remainingOutward * outwardZ;
    }
  }

  // ─── Progress + finish line ────────────────────────────────────────────────

  /**
   * Update body.progress from spline arclength fraction.
   * Detects finish line crossing (progress crosses 1.0).
   * Anti-cheat: flag progress regression beyond noise tolerance.
   */
  private resolveProgress(state: SplineRoomState, now: number): void {
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;

      const closest = state.spline.closestPointOnSpline({ x: body.x, z: body.z });
      const arcS = state.spline.arclengthFromT(closest.t);
      const total = state.spline.totalArcLength;
      const newProgress = total > 0 ? arcS / total : 0;

      // Anti-cheat regression check.
      if (!progressIsMonotonic(newProgress, body.prevProgress)) {
        this.flag(state, body.avatarId, 'checkpoint_skip',
          `progress_regression: ${newProgress.toFixed(4)} < ${body.prevProgress.toFixed(4)} - 0.02`);
      }

      body.prevProgress = body.progress;
      body.progress = newProgress;

      // Finish line: crossed from below 0.95 to ≥ 1.0, or prevProgress was
      // already high and body is within 1 body-radius of finish.
      // Use a 0.95 threshold on the pre-update value to avoid false triggers
      // from teleportation bugs — the body must have genuinely traversed the
      // course.
      const justCrossedFinish =
        body.prevProgress >= 0.95 && body.progress >= 1.0;

      if (justCrossedFinish) {
        body.finishedAt = now;
        body.totalTimeMs = now - state.startedAt;
        body.vx = 0;
        body.vz = 0;

        const finishPlacement = state.finishOrder.length + 1;
        state.finishOrder.push(body.avatarId);
        body.placement = finishPlacement;

        if (state.firstFinishedAt === null) {
          state.firstFinishedAt = now;
          // Broadcast finish-wait window start.
          this.broadcastFn(state.roomId, {
            type: 'event.finish_wait_started',
            firstFinishedAt: now,
            waitUntil: now + REEF_FINISH_WAIT_MS,
          } as unknown as ServerFrame);
        }

        this.broadcastFn(state.roomId, {
          type: 'event.crossed_finish',
          avatarId: body.avatarId,
          placement: finishPlacement,
          totalTimeMs: body.totalTimeMs,
        } as unknown as ServerFrame);
      }
    }
  }

  // ─── Slipstream ────────────────────────────────────────────────────────────

  /**
   * Slipstream detection — adapted from ellipse sim for XZ coords.
   * Uses body.x/body.z and body.vx/body.vz.
   */
  private resolveSlipstream(state: SplineRoomState, now: number): void {
    const bodies: SplineBody[] = [];
    for (const b of state.bodies.values()) {
      if (b.alive && !b.dnf && b.finishedAt === null && !b.forfeited) {
        bodies.push(b);
      }
    }
    for (const self of bodies) {
      let bestSrc: SplineBody | null = null;
      let bestDistSq = Infinity;
      for (const target of bodies) {
        if (target === self) continue;
        const dx = target.x - self.x;
        const dz = target.z - self.z;
        const distSq = dx * dx + dz * dz;
        const minSq = SLIPSTREAM_MIN_DISTANCE * SLIPSTREAM_MIN_DISTANCE;
        const maxSq = SLIPSTREAM_MAX_DISTANCE * SLIPSTREAM_MAX_DISTANCE;
        if (distSq < minSq || distSq > maxSq) continue;
        const tSpeed = Math.hypot(target.vx, target.vz);
        if (tSpeed < REEF_MAX_SPEED * 0.30) continue;
        const dot = (dx * target.vx + dz * target.vz) / tSpeed;
        if (dot <= 0) continue;
        const perpMag = Math.abs(dx * target.vz - dz * target.vx) / tSpeed;
        if (perpMag > SLIPSTREAM_HALF_WIDTH) continue;
        const sSpeed = Math.hypot(self.vx, self.vz);
        if (sSpeed < REEF_MAX_SPEED * 0.30) continue;
        const align =
          (self.vx * target.vx + self.vz * target.vz) / (sSpeed * tSpeed);
        if (align < SLIPSTREAM_MIN_VEL_ALIGNMENT) continue;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestSrc = target;
        }
      }

      if (bestSrc) {
        if (self.slipstreamSourceAvatarId === bestSrc.avatarId) {
          self.slipstreamConsecutiveTicks++;
        } else {
          self.slipstreamSourceAvatarId = bestSrc.avatarId;
          self.slipstreamConsecutiveTicks = 1;
        }
        self.slipstreamGraceTicksLeft = self.mults.slipstreamGraceTicks;
        if (self.slipstreamConsecutiveTicks >= SLIPSTREAM_REQUIRED_TICKS) {
          const wasActive = self.activeBoosts.has('slipstream-boost');
          self.activeBoosts.set('slipstream-boost', {
            expiresAt: now + SLIPSTREAM_REFRESH_TTL_MS,
            mult: SLIPSTREAM_BOOST_MULT,
          });
          if (!wasActive) {
            this.broadcastFn(state.roomId, {
              type: 'event.slipstream',
              srcAvatarId: bestSrc.avatarId,
              dstAvatarId: self.avatarId,
            });
          }
        }
      } else {
        if (self.slipstreamGraceTicksLeft > 0) {
          self.slipstreamGraceTicksLeft--;
          if (
            self.slipstreamGraceTicksLeft === 0 &&
            self.activeBoosts.has('slipstream-boost')
          ) {
            self.activeBoosts.delete('slipstream-boost');
            self.slipstreamSourceAvatarId = null;
            self.slipstreamConsecutiveTicks = 0;
            this.broadcastFn(state.roomId, {
              type: 'event.slipstream_end',
              dstAvatarId: self.avatarId,
            });
          }
        } else {
          self.slipstreamSourceAvatarId = null;
          self.slipstreamConsecutiveTicks = 0;
        }
      }
    }
  }

  // ─── Proximity push ────────────────────────────────────────────────────────

  private resolveProximity(state: SplineRoomState): void {
    const bodies = Array.from(state.bodies.values()).filter(
      (b) => b.alive && !b.dnf && b.finishedAt === null,
    );
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        const minDist = REEF_BODY_RADIUS * 1.6;
        if (dist === 0 || dist >= minDist) continue;
        const overlap = minDist - dist;
        const nx = dx / dist;
        const nz = dz / dist;
        // Spring push spread over ticks (0.42 each side), capped per body per
        // tick so a deep overlap (e.g. two karts on the same spawn cell)
        // resolves over a few frames instead of one hard pop-apart.
        const push = Math.min(overlap * 0.42, PROXIMITY_MAX_PUSH_WU);
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
        const relVx = b.vx - a.vx;
        const relVz = b.vz - a.vz;
        const closing = relVx * nx + relVz * nz;
        if (closing < 0) {
          // Remove only 35% of the closing component per tick — bodies scrub
          // momentum against each other over a few ticks, never a one-tick zero.
          const remove = closing * 0.35;
          a.vx += nx * remove;
          a.vz += nz * remove;
          b.vx -= nx * remove;
          b.vz -= nz * remove;
        }
      }
    }
  }

  // ─── Ramp launch triggers (SPEC 3) ────────────────────────────────────────

  /**
   * Check each grounded body against all ramp AABB volumes.
   * If a body is inside a ramp it hasn't cooled down on, inject
   * REEF_JUMP_IMPULSE_RAMP into vyAxis and broadcast event.ramp_launch.
   * Only one ramp can fire per body per tick (inner break).
   */
  private resolveRamps(state: SplineRoomState, now: number): void {
    for (const body of state.bodies.values()) {
      // Skip non-participants and already-airborne bodies.
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;
      if (body.airborneTicks !== 0 || body.heightOffset > 0) continue;

      // Lazy-init per-body cooldown map.
      let bodyRampCooldowns = state.rampCooldowns.get(body.avatarId);
      if (!bodyRampCooldowns) {
        bodyRampCooldowns = new Map<string, number>();
        state.rampCooldowns.set(body.avatarId, bodyRampCooldowns);
      }

      for (const ramp of state.ramps) {
        // Cooldown guard.
        const cooldownExpiry = bodyRampCooldowns.get(ramp.id) ?? 0;
        if (now < cooldownExpiry) continue;

        // Compute ramp centerline world position via spline.
        const pt   = state.spline.centerlineAt(ramp.t);   // {x, z}
        const tang = state.spline.tangentAt(ramp.t);       // {x, z} unit

        // Lateral offset: normal = 90° CCW of tangent.
        const nx = -tang.z;
        const nz =  tang.x;
        const cx = pt.x + nx * ramp.lateralOffset;
        const cz = pt.z + nz * ramp.lateralOffset;

        // Project body delta onto tangent/normal basis.
        const dx    = body.x - cx;
        const dz    = body.z - cz;
        const along = dx * tang.x + dz * tang.z;
        const perp  = dx * nx     + dz * nz;

        if (Math.abs(along) > ramp.halfLength) continue;
        if (Math.abs(perp)  > ramp.halfWidth)  continue;

        // Trigger ramp launch.
        body.vyAxis += ramp.launchImpulse;
        body.airborneTicks = 1;
        bodyRampCooldowns.set(ramp.id, now + ramp.cooldownMs);

        // Broadcast VFX event to client.
        this.broadcastFn(state.roomId, {
          type: 'event.ramp_launch',
          avatarId: body.avatarId,
          rampId: ramp.id,
          launchVel: ramp.launchImpulse,
        });

        // One ramp per body per tick — stop checking ramps for this body.
        break;
      }
    }
  }

  // ─── Slow-zone obstacle clusters (2026-06-02 wide-course rebuild) ──────────

  /**
   * Check each racing body against all obstacle AABB volumes (clone of
   * `resolveRamps`'s AABB-in-tangent-frame test). On overlap, set a
   * `hazard-slow` activeBoost — the SAME speedMod path the ellipse sim's
   * urchin patches used (the `hazard-slow` block in `applyIntentForTick` step
   * 3 + the HAZARD_* consts already exist). Re-applying every overlapping tick
   * keeps the slow alive while inside (HAZARD_TICK_DURATION_MS = 200 ms absorbs
   * tick jitter, so leaving the patch lets it expire cleanly).
   *
   * Unlike ramps there is NO per-body cooldown — the effect is a continuous
   * slow while overlapping, not a one-shot impulse. Airborne bodies are NOT
   * skipped (a kart jumping over a reef shouldn't be slowed, but the obstacle
   * is a ground hazard — we keep the parity with hazards staying ground-bound
   * by skipping airborne bodies, matching the "fits between apex marker and
   * centerline on the surface" intent).
   */
  private resolveObstacles(state: SplineRoomState, now: number): void {
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;
      // Airborne karts clear ground hazards.
      if (body.airborneTicks !== 0 || body.heightOffset > 0) continue;

      for (const obs of state.obstacles) {
        // Compute obstacle centerline world position via spline (same basis as
        // resolveRamps): normal = 90° CCW of tangent = LEFT of travel.
        const pt   = state.spline.centerlineAt(obs.t);
        const tang = state.spline.tangentAt(obs.t);
        const nx = -tang.z;
        const nz =  tang.x;
        const cx = pt.x + nx * obs.lateralOffset;
        const cz = pt.z + nz * obs.lateralOffset;

        // Project body delta onto tangent/normal basis (AABB-in-tangent-frame).
        const dx    = body.x - cx;
        const dz    = body.z - cz;
        const along = dx * tang.x + dz * tang.z;
        const perp  = dx * nx     + dz * nz;

        if (Math.abs(along) > obs.halfLength) continue;
        if (Math.abs(perp)  > obs.halfWidth)  continue;

        // Overlap → apply / refresh the hazard-slow speedMod. `mult` is stored
        // as `1 + HAZARD_SLOW_MULT` to match the ellipse sim's convention; the
        // applyIntentForTick hazard block reads `(mult ?? 0) - 1` back to the
        // additive negative (-0.40). Re-firing every tick extends the window.
        body.activeBoosts.set('hazard-slow', {
          expiresAt: now + HAZARD_TICK_DURATION_MS,
          mult: 1 + HAZARD_SLOW_MULT,
        });
        // One obstacle is enough to slow this tick — stop scanning for this body.
        break;
      }
    }
  }

  // ─── Power-up pickups ──────────────────────────────────────────────────────

  private resolvePickups(state: SplineRoomState, now: number): void {
    for (const pk of state.pickups) {
      if (!pk.active) continue;
      for (const body of state.bodies.values()) {
        if (!body.alive || body.dnf || body.finishedAt !== null) continue;
        const dx = body.x - pk.position.x;
        const dz = body.z - pk.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist <= REEF_BODY_RADIUS + REEF_POWERUP_RADIUS) {
          const slot = body.inventory.findIndex((s) => s.kind === null);
          if (slot >= 0) {
            const collectorPlacement =
              state.lastPlacementMap.get(body.avatarId) ?? null;
            const finalKind: ReefPowerUpKind =
              collectorPlacement !== null
                ? this.rollPowerUpKindForPlacement(state, collectorPlacement)
                : pk.kind;
            body.inventory[slot] = {
              kind: finalKind,
              charges: 1,
              cooldownUntil: 0,
            };
            pk.active = false;
            pk.collectedAt = now;
            pk.respawnAt = now + REEF_POWERUP_RESPAWN_MS;
            this.broadcastFn(state.roomId, {
              type: 'event.power_up_collected',
              spawnId: pk.spawnId,
              collectorAvatarId: body.avatarId,
              kind: finalKind,
            });
          }
          break;
        }
      }
    }
  }

  private tickPickups(state: SplineRoomState, now: number): void {
    for (const pk of state.pickups) {
      if (!pk.active && now >= pk.respawnAt) {
        pk.kind = this.rollPowerUpKind(state);
        pk.spawnId = `${state.roomId.slice(0, 8)}-pk-${state.tick}-${lcgNext(state).toString(36)}`;
        pk.active = true;
        pk.collectedAt = null;
        pk.respawnAt = 0;
        this.broadcastFn(state.roomId, {
          type: 'event.power_up_spawned',
          spawnId: pk.spawnId,
          kind: pk.kind,
          position: { x: pk.position.x, y: pk.position.z },
        });
      }
    }
  }

  // ─── Power-up use ──────────────────────────────────────────────────────────

  private tryUsePowerUp(
    state: SplineRoomState,
    body: SplineBody,
    slotIndex: number,
    now: number,
  ): void {
    const slot = body.inventory[slotIndex];
    if (!slot || slot.kind === null || slot.charges <= 0) return;
    if (slot.cooldownUntil > now) return;

    const kind = slot.kind as ReefPowerUpKind;
    const def = getReefPowerUpDef(kind);

    switch (kind) {
      case 'rr-turbo-bubble':
      case 'rr-bubble-shield':
      case 'rr-ink-slick':
      case 'rr-whirlpool':
        body.activeEffects.set(
          kind,
          now + def.effectMs * body.mults.powerUpDurationMult,
        );
        break;
      case 'rr-tide-wave':
        this.applyTideWave(state, body);
        break;
      case 'rr-seeker-jelly':
        this.applySeekerJelly(state, body);
        break;
    }

    slot.charges -= 1;
    if (slot.charges <= 0) {
      body.inventory[slotIndex] = { kind: null, charges: 0, cooldownUntil: 0 };
    } else {
      slot.cooldownUntil = now + def.cooldownMs;
    }
  }

  private applyTideWave(state: SplineRoomState, src: SplineBody): void {
    const radius = 250;
    for (const target of state.bodies.values()) {
      if (target.avatarId === src.avatarId) continue;
      if (target.dnf || target.finishedAt !== null) continue;
      if (target.activeEffects.has('rr-bubble-shield')) continue;
      const dx = target.x - src.x;
      const dz = target.z - src.z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius) continue;
      const speed = Math.hypot(target.vx, target.vz);
      if (speed > 0) {
        const factor =
          0.4 * (1 - dist / radius) * target.mults.knockbackResistMult;
        target.vx *= 1 - factor;
        target.vz *= 1 - factor;
      }
      this.broadcastFn(state.roomId, {
        type: 'event.hit',
        srcAvatarId: src.avatarId,
        dstAvatarId: target.avatarId,
        position: { x: target.x, y: target.z },
        power: 1 - dist / radius,
      });
    }
  }

  private applySeekerJelly(state: SplineRoomState, src: SplineBody): void {
    let best: SplineBody | null = null;
    let bestDist = Infinity;
    const sv = Math.hypot(src.vx, src.vz);
    for (const t of state.bodies.values()) {
      if (t.avatarId === src.avatarId) continue;
      if (t.dnf || t.finishedAt !== null) continue;
      if (t.activeEffects.has('rr-bubble-shield')) continue;
      const dx = t.x - src.x;
      const dz = t.z - src.z;
      if (sv > 0) {
        const dot = (dx * src.vx + dz * src.vz) / sv;
        if (dot < 0) continue;
      }
      const d = Math.hypot(dx, dz);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    if (!best) return;
    const dx = best.x - src.x;
    const dz = best.z - src.z;
    const mag = Math.max(Math.hypot(dx, dz), 1);
    const nx = dx / mag;
    const nz = dz / mag;
    const impulse = REEF_MAX_SPEED * 0.6 * best.mults.knockbackResistMult;
    best.vx += nx * impulse;
    best.vz += nz * impulse;
    this.broadcastFn(state.roomId, {
      type: 'event.hit',
      srcAvatarId: src.avatarId,
      dstAvatarId: best.avatarId,
      position: { x: best.x, y: best.z },
      power: 1,
    });
  }

  // ─── Round-end ─────────────────────────────────────────────────────────────

  private shouldEndRound(state: SplineRoomState, now: number): boolean {
    let racing = 0;
    let finishedOrDnf = 0;
    for (const b of state.bodies.values()) {
      if (b.finishedAt !== null || b.dnf) finishedOrDnf++;
      else racing++;
    }
    if (racing === 0 && state.bodies.size > 0) return true;
    if (now >= state.hardEndsAt) return true;
    // Wait-at-finish window: once first body finishes, give stragglers
    // REEF_FINISH_WAIT_MS before ending.
    if (
      state.firstFinishedAt !== null &&
      now >= state.firstFinishedAt + REEF_FINISH_WAIT_MS
    ) {
      return true;
    }
    if (now >= state.softEndsAt && finishedOrDnf > 0 && racing === 0) {
      return true;
    }
    return false;
  }

  private applyTimeouts(state: SplineRoomState, now: number): void {
    for (const body of state.bodies.values()) {
      if (body.finishedAt !== null || body.dnf) continue;
      if (now >= state.hardEndsAt || now >= state.softEndsAt) {
        body.dnf = true;
        body.alive = false;
      }
    }
  }

  private endRound(
    state: SplineRoomState,
    _reason: 'all_finished' | 'time_expired' | 'all_forfeited',
  ): void {
    if (state.ended) return;
    state.ended = true;
    if (state.intervalHandle) {
      clearInterval(state.intervalHandle);
      state.intervalHandle = null;
    }

    const results = this.computeResults(state.roomId);
    const winners = results.map((r) => ({
      avatarId: r.avatarId,
      placement: r.placement,
    }));

    if (state.activityId !== 'reef-race') {
      const previewPlacement = winners[0]?.placement ?? 0;
      this.broadcastFn(state.roomId, {
        type: 'event.match_ended',
        reason: 'complete',
        winners,
        rewardPreview: {
          placement: previewPlacement,
          tokens: 0,
          leaderboardPoints: 0,
        },
      });
    }

    if (this.endedFn) {
      try {
        this.endedFn(state.roomId);
      } catch (err) {
        console.error('[spline-sim] endedFn threw:', err);
      }
    }
  }

  // ─── Placement ─────────────────────────────────────────────────────────────

  /**
   * Live placements by race progress (arclength fraction).
   * Finishers sorted by totalTimeMs asc; racers by progress desc; DNF last.
   */
  private computeLivePlacements(state: SplineRoomState): Map<string, number> {
    const racing: Array<{
      avatarId: string;
      progress: number;
      finishedAt: number | null;
      dnf: boolean;
    }> = [];
    for (const b of state.bodies.values()) {
      if (b.dnf || b.forfeited) {
        racing.push({ avatarId: b.avatarId, progress: -Infinity, finishedAt: null, dnf: true });
      } else if (b.finishedAt !== null) {
        racing.push({ avatarId: b.avatarId, progress: Infinity, finishedAt: b.finishedAt, dnf: false });
      } else {
        racing.push({ avatarId: b.avatarId, progress: b.progress, finishedAt: null, dnf: false });
      }
    }
    racing.sort((a, b) => {
      if (a.finishedAt !== null && b.finishedAt !== null) {
        return a.finishedAt - b.finishedAt;
      }
      if (a.finishedAt !== null) return -1;
      if (b.finishedAt !== null) return 1;
      if (a.dnf && !b.dnf) return 1;
      if (!a.dnf && b.dnf) return -1;
      if (a.progress !== b.progress) return b.progress - a.progress;
      return a.avatarId < b.avatarId ? -1 : a.avatarId > b.avatarId ? 1 : 0;
    });
    const out = new Map<string, number>();
    racing.forEach((r, i) => out.set(r.avatarId, i + 1));
    return out;
  }

  // ─── Snapshot encoding ─────────────────────────────────────────────────────

  private buildSnapshot(state: SplineRoomState): SplineSnapshot {
    return {
      tick: state.tick,
      bodies: Array.from(state.bodies.values()).map((b) => ({
        avatarId: b.avatarId,
        x: quant(b.x, POS_QUANT),
        z: quant(b.z, POS_QUANT),
        vx: quant(b.vx, POS_QUANT),
        vz: quant(b.vz, POS_QUANT),
        rot: quant(b.rot, ROT_QUANT),
        height: quant(b.heightOffset, POS_QUANT),
        progress: quant(b.progress, 10000),
        finishedAt: b.finishedAt,
        dnf: b.dnf,
        placement: state.lastPlacementMap.get(b.avatarId) ?? null,
      })),
      pickups: state.pickups.map((pk) => ({
        spawnId: pk.spawnId,
        kind: pk.kind,
        x: quant(pk.position.x, POS_QUANT),
        z: quant(pk.position.z, POS_QUANT),
        active: pk.active,
      })),
    };
  }

  /**
   * Map spline body coords to the wire protocol.
   * Protocol convention (carried from ellipse sim): position.x = scene X,
   * position.y = scene Z (the spline's z field). This matches how the
   * ellipse sim mapped body.y → Three.js Z.
   */
  private bodyToWireEntity(
    b: SplineBodySnap,
    stateStr: 'racing' | 'finished' | 'dnf',
  ) {
    return {
      avatarId: b.avatarId,
      position: { x: b.x, y: b.z },
      velocity: { x: b.vx, y: b.vz },
      rotation: b.rot,
      state: stateStr,
    };
  }

  private broadcastKeyframe(state: SplineRoomState): void {
    const snap = this.buildSnapshot(state);
    state.lastSnapshot = snap;
    this.broadcastFn(state.roomId, {
      type: 'snapshot.keyframe',
      seq: snap.tick,
      world: {
        tick: snap.tick,
        entities: snap.bodies.map((b) =>
          this.bodyToWireEntity(
            b,
            b.dnf ? 'dnf' : b.finishedAt !== null ? 'finished' : 'racing',
          ),
        ),
        powerUps: snap.pickups
          .filter((p) => p.active)
          .map((p) => ({
            spawnId: p.spawnId,
            kind: p.kind,
            position: { x: p.x, y: p.z },
          })),
        scores: snap.bodies.map((b) => ({
          avatarId: b.avatarId,
          score: quant(b.progress, 10000),
        })),
      },
    });
  }

  private broadcastDelta(state: SplineRoomState): void {
    const snap = this.buildSnapshot(state);
    const prev = state.lastSnapshot;

    const entities = snap.bodies
      .filter((b) => {
        if (!prev) return true;
        const p = prev.bodies.find((q) => q.avatarId === b.avatarId);
        if (!p) return true;
        return (
          p.x !== b.x ||
          p.z !== b.z ||
          p.vx !== b.vx ||
          p.vz !== b.vz ||
          p.rot !== b.rot ||
          p.height !== b.height ||
          p.progress !== b.progress ||
          p.finishedAt !== b.finishedAt ||
          p.dnf !== b.dnf ||
          p.placement !== b.placement
        );
      })
      .map((b) => ({
        avatarId: b.avatarId,
        seq: snap.tick,
        changed: {
          x: b.x,
          y: b.z,      // protocol y = scene Z
          vx: b.vx,
          vy: b.vz,    // protocol vy = scene vZ
          rot: b.rot,
          height: b.height !== 0 ? b.height : undefined,
          progress: b.progress,
          state: b.dnf
            ? ('dnf' as const)
            : b.finishedAt !== null
              ? ('finished' as const)
              : ('racing' as const),
          placement: b.placement,
        },
      }));

    const pickups = snap.pickups
      .filter((p) => {
        if (!prev) return true;
        const q = prev.pickups.find((pp) => pp.spawnId === p.spawnId);
        return !q || q.active !== p.active;
      })
      .map((p) => ({
        spawnId: p.spawnId,
        kind: p.kind,
        position: { x: p.x, y: p.z },
      }));

    state.lastSnapshot = snap;
    this.broadcastFn(state.roomId, {
      type: 'snapshot.delta',
      baseSeq: prev?.tick ?? 0,
      seq: snap.tick,
      entities,
      powerUps: pickups,
    });
  }

  // ─── Anti-cheat ────────────────────────────────────────────────────────────

  private flag(
    state: SplineRoomState,
    avatarId: string,
    kind: ActivityAntiCheatFlagPayload['kind'],
    detail?: string,
  ): void {
    const PHYSICS_KINDS = new Set<typeof kind>([
      'overaccel',
      'overspeed',
      'checkpoint_skip',
      'underminlap',
    ]);
    const isPhysics = PHYSICS_KINDS.has(kind);
    const reachedThreshold = isPhysics ? false : state.flagCounter.bump(avatarId);

    void logEvent({
      eventType: ACTIVITY_EVENT_TYPES.ANTI_CHEAT_FLAG,
      avatarId,
      payload: {
        kind,
        activityId: state.activityId,
        roomId: state.roomId,
        detail: detail ? { detail } : undefined,
      } satisfies ActivityAntiCheatFlagPayload,
    });

    if (isPhysics) {
      console.warn(
        `[spline-sim anti-cheat] physics-flag (NOT forfeit) room=${state.roomId} avatar=${avatarId} kind=${kind}`,
      );
    }

    if (reachedThreshold) {
      const body = state.bodies.get(avatarId);
      if (body) {
        body.forfeited = true;
        body.dnf = true;
        body.alive = false;
        console.warn(
          `[spline-sim anti-cheat] integrity-forfeit room=${state.roomId} avatar=${avatarId}`,
        );
        this.broadcastFn(state.roomId, {
          type: 'event.player_left',
          avatarId,
          reason: 'integrity',
        });
      }
      if (this.integrityForfeitFn) {
        try {
          this.integrityForfeitFn(state.roomId, avatarId);
        } catch (err) {
          console.error('[spline-sim] integrityForfeitFn threw:', err);
        }
      }
    }
  }

  // ─── Bot support ───────────────────────────────────────────────────────────

  private runBotControllers(
    state: SplineRoomState,
    dt: number,
    now: number,
  ): void {
    if (state.botControllers.size === 0) return;
    const sharedView = this.buildBotRoomView(state, '');
    for (const [avatarId, ctrl] of state.botControllers) {
      const body = state.bodies.get(avatarId);
      if (!body || !body.alive || body.forfeited || body.finishedAt !== null) continue;
      sharedView.selfAvatarId = avatarId;
      sharedView.now = now;
      let intent;
      try {
        intent = ctrl.computeInput(sharedView, dt);
      } catch (err) {
        console.error(`[spline-sim] bot ${avatarId} computeInput threw:`, err);
        continue;
      }
      const seq = (state.botSeqs.get(avatarId) ?? 0) + 1;
      state.botSeqs.set(avatarId, seq);
      this.applyInput(state.roomId, avatarId, seq, dt, {
        dir: intent.dir,
        thrust: intent.thrust,
        actionBits: intent.actionBits,
      });
    }
  }

  private buildBotRoomView(
    state: SplineRoomState,
    selfAvatarId: string,
  ): {
    selfAvatarId: string;
    bodies: Array<{
      avatarId: string;
      x: number;
      y: number;
      vx: number;
      vy: number;
      rot: number;
      alive: boolean;
      inventory: Array<{ kind: ReefPowerUpKind | null; charges: number; cooldownUntil: number }>;
      lap: number;
      nextCheckpoint: number;
      currentPlacement: number | null;
      finishedAt: number | null;
      dnf: boolean;
    }>;
    arenaRadius: number;
    now: number;
    matchStartedAt: number;
  } {
    const placementMap = state.lastPlacementMap;
    const bodies = Array.from(state.bodies.values()).map((b) => ({
      avatarId: b.avatarId,
      x: b.x,
      y: b.z,   // bot view uses protocol (x,y) convention
      vx: b.vx,
      vy: b.vz,
      rot: b.rot,
      alive: b.alive && !b.dnf && b.finishedAt === null,
      inventory: b.inventory.map((slot) => ({
        kind: slot.kind as ReefPowerUpKind | null,
        charges: slot.charges,
        cooldownUntil: slot.cooldownUntil,
      })),
      // Bots running the v1 bot controller use lap/nextCheckpoint for
      // steering heuristics; fake these from progress for Phase 1.
      lap: Math.floor(b.progress),
      nextCheckpoint: Math.round(b.progress * 12) % 12,
      currentPlacement: placementMap.get(b.avatarId) ?? null,
      finishedAt: b.finishedAt,
      dnf: b.dnf,
    }));
    return {
      selfAvatarId,
      bodies,
      arenaRadius: 28000,  // approximate track length as "radius" for boundary heuristics (90s rebuild)
      now: Date.now(),
      matchStartedAt: state.startedAt,
    };
  }

  // ─── RNG + power-up roll ───────────────────────────────────────────────────

  private rollPowerUpKind(state: SplineRoomState): ReefPowerUpKind {
    const total = REEF_POWERUP_DEFS.reduce((s, d) => s + d.weight, 0);
    const roll = lcgNext(state) % total;
    let acc = 0;
    for (const def of REEF_POWERUP_DEFS) {
      acc += def.weight;
      if (roll < acc) return def.kind;
    }
    return REEF_POWERUP_DEFS[0].kind;
  }

  private rollPowerUpKindForPlacement(
    state: SplineRoomState,
    placement: number,
  ): ReefPowerUpKind {
    const table = getPlacementItemTable(placement);
    if (!table || table.length === 0) return this.rollPowerUpKind(state);
    const total = table.reduce((s, e) => s + e.weight, 0);
    if (total <= 0) return this.rollPowerUpKind(state);
    const roll = lcgNext(state) % total;
    let acc = 0;
    for (const entry of table) {
      acc += entry.weight;
      if (roll < acc) return entry.kind;
    }
    return table[0].kind;
  }
}

// ─── Silence unused imports (used via body.mults or reserved for later phases) ─

void NEUTRAL_BODY_MULTIPLIERS;
void SLIPSTREAM_GRACE_TICKS; // used via body.mults.slipstreamGraceTicks

/**
 * Singleton — matches the export pattern of `reefRaceSim` in
 * `./reef-race-sim.ts` so the dispatcher can swap by reference.
 */
export const reefRaceSplineSim = new ReefRaceSplineSim();
