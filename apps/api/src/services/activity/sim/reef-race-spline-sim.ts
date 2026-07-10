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
  REEF_RACE_LAPS,
  REEF_MAX_SPEED,
  REEF_MAX_ACCEL,
  // REEF_DRAG retired in the v2 surf model — replaced by directional
  // forwardDrag + lateralGrip in integrateSurfStep (still used by the ellipse
  // sim via reef-race-sim.ts).
  REEF_BODY_RADIUS,
  REEF_RACE_LOOP_SOFT_TIMEOUT_MS,
  REEF_RACE_LOOP_HARD_TIMEOUT_MS,
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
  REEF_AIRBORNE_STEER_MULT,
  ACTION_BIT_POWERUP_0,
  ACTION_BIT_POWERUP_1,
  // v2 surf-carving kinematics (2026-06-01)
  REEF_TURN_RATE,
  REEF_TURN_SPEED_FALLOFF,
  REEF_FORWARD_DRAG,
  REEF_LATERAL_GRIP,
  // v2 mechanics — boost pads
  buildSplineBoostPads,
  type SplineBoostPad,
  BOOST_PAD_KICK,
  BOOST_PAD_BOOST_MULT,
  BOOST_PAD_DURATION_MS,
  // v2 mechanics — mini-turbo (surf-carve whip)
  MINI_TURBO_MIN_TURN_PER_TICK,
  MINI_TURBO_MIN_SPEED,
  MINI_TURBO_TIER1_MS,
  MINI_TURBO_TIER2_MS,
  MINI_TURBO_MAX_CHARGE_MS,
  MINI_TURBO_TIER1_MULT,
  MINI_TURBO_TIER2_MULT,
  MINI_TURBO_TIER1_DURATION_MS,
  MINI_TURBO_TIER2_DURATION_MS,
  MINI_TURBO_COOLDOWN_MS,
  // v2 mechanics — item fixes (ink-slick rival slow, whirlpool rival knock)
  INK_SLICK_RADIUS,
  WHIRLPOOL_RADIUS,
  WHIRLPOOL_PULL_IMPULSE,
  WHIRLPOOL_SLOW_MULT,
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

  // ── Race progress (CLOSED-LOOP lap model, 2026-06-22) ─────────────────────
  /**
   * WITHIN-LAP arclength fraction 0..1 of ONE loop. Wraps 1→0 at the seam each
   * lap. NOT the whole-race progress — combine with `lap` (see `totalProgress`).
   */
  progress: number;
  prevProgress: number;
  /**
   * Completed-lap count (0-based). 0 during lap 1; increments each time the
   * body crosses the start/finish seam in the forward direction. A body
   * FINISHES when `lap` reaches `REEF_RACE_LAPS` (i.e. it has crossed the seam
   * after completing the final lap). See `resolveProgress`.
   */
  lap: number;
  /**
   * True once the body has crossed the start/finish seam in the forward
   * direction for the FIRST time (the "start gun" cross). Bodies spawn BEHIND
   * the line (progress ≈ 1.0), so their first forward seam crossing is the
   * race start, NOT a completed lap — it sets this flag and leaves `lap` at 0.
   * Every forward seam crossing AFTER this increments `lap`.
   */
  startCrossed: boolean;
  /**
   * Server timestamp (ms) of the body's last start/finish line cross — set to
   * the match start at spawn, refreshed to `now` on the start-gun cross and on
   * each lap completion. Used to stamp `event.lap_completed.splitMs`.
   */
  lastLapAt: number;
  /**
   * False until the first `resolveProgress` sample seeds `progress`/`prevProgress`
   * from the body's actual spawn position (behind the line, t≈0.97-1.0). Without
   * this the first tick would read a spurious 0→0.97 jump as a seam crossing.
   */
  progressInitialized: boolean;
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

  // ── Power-up use (deferred to a post-integrate pass, v2 order-independence) ─
  /**
   * Slots (0/1) whose power-up ACTION bit was pressed this tick. Resolution is
   * deferred out of the per-body integrate loop into `resolvePowerUpUses` so all
   * rival-hazard reads see ONE consistent post-integrate world (Codex 4a).
   * Cleared each tick after resolution.
   */
  pendingPowerUpSlots: number[];

  // ── Mini-turbo (surf-carve whip, v2 mechanics) ───────────────────────────
  /** Accumulated sustained-carve time (ms). Charges while carving hard in one
   *  direction; discharges (fires) on release/flip. */
  miniTurboChargeMs: number;
  /** Tier the charge has reached (0 = none, 1, 2). Snapshot HUD reads this. */
  miniTurboLevel: 0 | 1 | 2;
  /** Sign of the current carve direction (+1 / -1 / 0). A flip resets charge. */
  miniTurboCarveSign: number;
  /**
   * Sim-time (ms) until which charging is SUPPRESSED after a mini-turbo fires
   * (anti-farm — blocks the rhythmic flick-carve reseed from producing
   * continuous boost). 0 = not on cooldown.
   */
  miniTurboCooldownUntil: number;

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
  /** Within-lap fraction 0..1 (wraps each lap). */
  progress: number;
  /** Completed-lap count (0-based). */
  lap: number;
  finishedAt: number | null;
  dnf: boolean;
  placement: number | null;
  /** Mini-turbo charge normalized 0..1 (against tier-2 full charge). */
  miniTurboCharge: number;
  /** Mini-turbo tier reached so far (0|1|2). */
  miniTurboLevel: 0 | 1 | 2;
  /** True while any positive boost is active (pad/mini-turbo/launch/slipstream). */
  boosting: boolean;
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

  /**
   * DETERMINISTIC sim clock (ms). Advances by exactly `REEF_TICK_MS` per tick,
   * seeded at `startedAt`. EVERY expiry/duration/cooldown in the sim reads this
   * (via the tick's `now`), NOT `Date.now()` — so identical input+tick sequences
   * produce identical trajectories regardless of event-loop stalls (Codex
   * finding 6). Genuine wall-clock reads (bot advisory `Date.now()`) are kept
   * separate. Seeded at `startedAt` so `startedAt`-relative expiries (launch
   * boost/stall) stay consistent with `now`.
   */
  simTimeMs: number;

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

  /** v2 mechanics — boost-pad trigger volumes (built once per room). */
  boostPads: SplineBoostPad[];
  /**
   * v2 mechanics — per-body per-pad "currently inside" latch set, so a boost pad
   * fires only on the ENTRY edge (outside→inside), never re-firing while a body
   * sits/coasts inside the volume (Codex finding 2).
   */
  boostPadInside: Map<string, Set<string>>;
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

/**
 * Whole-race progress = completed laps + within-lap fraction. The monotonic
 * ordering key for live placement (higher = further along the race). Closed-loop
 * lap model (2026-06-22): `lap` is the completed-lap count, `progress` the
 * within-lap fraction 0..1.
 */
function totalProgress(lap: number, progress: number): number {
  return lap + progress;
}

/**
 * Cached closed spline used ONLY to derive the static boost-pad/ramp render
 * zones (Codex finding 8) without needing a live room. Same track + `{ closed:
 * true }` as every room's spline, so the world positions match exactly.
 */
let _staticZoneSpline: ReefSpline | null = null;
function getStaticZoneSpline(): ReefSpline {
  if (!_staticZoneSpline) {
    _staticZoneSpline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });
  }
  return _staticZoneSpline;
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
    // CLOSED-LOOP (2026-06-22): the v3 track is a periodic ring; 1 lap = one
    // full loop. `{ closed: true }` makes the closing chord a real segment so
    // arclengthFromT spans the whole loop and the lap/finish math below is sound.
    const spline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });

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
      // Deterministic sim clock, seeded at startedAt (see field doc). Every tick
      // advances it by REEF_TICK_MS; all expiries read it, not Date.now().
      simTimeMs: startedAt,
      // CLOSED-LOOP: scale the race timeout by lap count (a 3-lap race is ~3×
      // one loop) so racers aren't DNF'd mid-race by the single-loop cap.
      softEndsAt: startedAt + REEF_RACE_LOOP_SOFT_TIMEOUT_MS,
      hardEndsAt: startedAt + REEF_RACE_LOOP_HARD_TIMEOUT_MS,
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
      // v2 mechanics — boost pads, built once per room.
      boostPads: buildSplineBoostPads(),
      boostPadInside: new Map(),
    };

    // ── Spawn bodies on the start/finish line (t=0) ───────────────────────
    // CLOSED-LOOP (2026-06-22): anchor the grid to the START CENTERLINE POSITION
    // `centerlineAt(0)`, NOT the world origin. (The old open-track code computed
    // the offsets from (0,0); since the new CP[0] is at (-1600,-4300), spawning
    // relative to origin dropped every kart ~3290 wu off-track in the island
    // centre. The fix anchors at the real start point.) Karts are placed BEHIND
    // the line along -tangent so their FIRST forward seam crossing is the start
    // gun (lap model: see resolveProgress). The v4 WATER-DOMINANT ring has a
    // WIDE start/finish straight (hw≈900), so the grid is a proper wide 2×4
    // starting grid: 2 columns 320 wu apart along the normal (well inside the
    // 900-wu corridor, like a real start line), 120 wu apart back along
    // -tangent. They face down-track (+tangent).
    const startCenter  = spline.centerlineAt(0); // start/finish line centre
    const startTangent = spline.tangentAt(0);    // direction of travel at the line
    const startNormal  = spline.normalAt(0);     // left of travel direction

    const SPAWN_SPACING_Z = 120; // back-stagger between rows (was 70 on the narrow track)
    const SPAWN_OFFSET_X  = 320; // lateral half-gap between the 2 columns (was 90; corridor hw≈900)

    participantAvatarIds.forEach((avatarId, i) => {
      const row = Math.floor(i / 2);
      const col = i % 2 === 0 ? -1 : 1;   // left / right column

      // Place behind the start line along -tangent, staggered laterally, anchored
      // at the start centerline so the whole grid sits ON the loop.
      const backZ = row * SPAWN_SPACING_Z + 40;
      const x =
        startCenter.x + startTangent.x * (-backZ) + startNormal.x * col * SPAWN_OFFSET_X;
      const z =
        startCenter.z + startTangent.z * (-backZ) + startNormal.z * col * SPAWN_OFFSET_X;

      // Face down-track (+tangent direction).
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
        lap: 0,
        startCrossed: false,
        lastLapAt: startedAt,
        progressInitialized: false,
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
        pendingPowerUpSlots: [],
        miniTurboChargeMs: 0,
        miniTurboLevel: 0,
        miniTurboCarveSign: 0,
        miniTurboCooldownUntil: 0,
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

  /**
   * v2 mechanics — server-authoritative boost-pad + ramp trigger zones in WORLD
   * coords for the client to render (sent once in snapshot.init). Positions use
   * the `{ x, y }` (y = scene-Z) wire convention; `rot` orients the quad
   * down-track. Returns null for an unknown room. The ws-hub calls this under
   * REEF_RACE_USE_SPLINE and drops it into `RoomMeta.reefSplineZones`.
   */
  getSplineStaticZones(): {
    boostPads: Array<{
      id: string;
      position: { x: number; y: number };
      halfLength: number;
      halfWidth: number;
      rot: number;
    }>;
    ramps: Array<{
      id: string;
      position: { x: number; y: number };
      halfLength: number;
      halfWidth: number;
      rot: number;
    }>;
  } {
    // ROOM-INDEPENDENT (Codex finding 8): boost pads + ramps are STATIC track
    // features, identical for every reef-race room. `snapshot.init` is sent
    // during COUNTDOWN — before the sim room exists — so this must NOT require a
    // live room, else the client permanently falls back to locally reconstructed
    // pads (placement-skew risk). It derives from the cached static spline + the
    // static pad/ramp builders.
    const spline = getStaticZoneSpline();
    const toWorld = (t: number, lateralOffset: number) => {
      const pt = spline.centerlineAt(t);
      const tang = spline.tangentAt(t);
      const nx = -tang.z;
      const nz = tang.x;
      return {
        x: pt.x + nx * lateralOffset,
        z: pt.z + nz * lateralOffset,
        rot: Math.atan2(tang.x, tang.z),
      };
    };
    return {
      boostPads: buildSplineBoostPads().map((p) => {
        const w = toWorld(p.t, p.lateralOffset);
        return {
          id: p.id,
          position: { x: w.x, y: w.z },
          halfLength: p.halfLength,
          halfWidth: p.halfWidth,
          rot: w.rot,
        };
      }),
      ramps: buildSplineRamps().map((r) => {
        const w = toWorld(r.t, r.lateralOffset);
        return {
          id: r.id,
          position: { x: w.x, y: w.z },
          halfLength: r.halfLength,
          halfWidth: r.halfWidth,
          rot: w.rot,
        };
      }),
    };
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
        // Higher whole-race progress (lap + within-lap fraction) = better among
        // DNFers — a lap-2 DNF outranks a lap-1 DNF.
        const pa = totalProgress(a.lap, a.progress);
        const pb = totalProgress(b.lap, b.progress);
        if (pb !== pa) return pb - pa;
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
        // DNF score floor — below any finisher's -totalTimeMs (finishers can't
        // exceed the loop hard timeout), so finishers always outrank DNFers.
        score: -(REEF_RACE_LOOP_HARD_TIMEOUT_MS + 1),
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

  // ─── Internal — tick loop ──────────────────────────────────────────────────

  private tickRoom(state: SplineRoomState): void {
    if (state.ended) return;

    state.tick += 1;
    // DETERMINISTIC sim clock (Codex finding 6): advance by exactly one fixed
    // tick and use it as `now` for EVERY expiry/duration/cooldown this tick. A
    // real-time event-loop stall no longer changes trajectories — the clock is
    // driven by tick count, not Date.now().
    state.simTimeMs += REEF_TICK_MS;
    const now = state.simTimeMs;
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

    // 4b. Resolve power-up USES (deferred from the integrate loop). Positions
    // are now final for this tick, so rival-hazard outcomes are order-
    // independent; shields resolve before offensive items (Codex finding 4a).
    this.resolvePowerUpUses(state, now);

    // 5. Power-up pickup collision.
    this.resolvePickups(state, now);

    // 5d. Ramp launch triggers (SPEC 3).
    this.resolveRamps(state, now);

    // 5e. Boost-pad triggers (v2 mechanics). Runs AFTER applyIntentForTick so
    // the pad's along-heading velocity kick is never measured by the intra-
    // tick velocity-delta validator; it is clamped to the 1.85× hard cap here.
    this.resolveBoostPads(state, now);

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

    // 2. Power-up actionBits (bits 0 + 1). RECORD the press; resolution is
    //    DEFERRED to the post-integrate `resolvePowerUpUses` pass so every
    //    rival-hazard read (ink/whirlpool/tide/seeker) sees ONE consistent
    //    post-integrate world (not a mid-integration mix), and shields resolve
    //    before offensive items — order-independent (Codex finding 4a).
    const actionBits = intent.actionBits;
    if (
      actionBits & ACTION_BIT_POWERUP_0 &&
      !body.pendingPowerUpSlots.includes(0)
    ) {
      body.pendingPowerUpSlots.push(0);
    }
    if (
      actionBits & ACTION_BIT_POWERUP_1 &&
      !body.pendingPowerUpSlots.includes(1)
    ) {
      body.pendingPowerUpSlots.push(1);
    }

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
      // v2 mechanics — boost pad + surf-carve mini-turbo. Both are timed
      // speedMod additives that DECAY. They fold into the SAME positive stack,
      // bounded by KINEMATIC_BOOST_CAP, so pad+mini-turbo+launch+slip can never
      // exceed the 1.85× ceiling (adversary chaining is capped here).
      const padAdd = body.activeBoosts.has('pad-boost')
        ? (body.activeBoosts.get('pad-boost')!.mult ?? 0)
        : 0;
      const miniTurboAdd = body.activeBoosts.has('mini-turbo-boost')
        ? (body.activeBoosts.get('mini-turbo-boost')!.mult ?? 0)
        : 0;
      // rr-turbo-bubble is ADDITIVE into the positive stack (Codex finding 4b).
      // The old `Math.max(speedMod, 1+pickupAdd)` DISCARDED any active negative
      // (a whirlpool-slowed victim on turbo kept full turbo speed). Folding it
      // in additively — and capping the whole stack by KINEMATIC_BOOST_CAP —
      // makes turbo COMBINE with a slow (turbo +0.35 + whirlpool −0.35 ⇒ 1.0×,
      // the documented "turbo buys back the hazard" model) while still bounding
      // the total ≤ 1.85×. v2 has no drift-boost or ribbon-boost (oval-only).
      const pickupBoostAdd = powerBoosted ? 0.35 : 0; // rr-turbo-bubble
      const positiveKineticStack = Math.min(
        launchAdd + slipAdd + padAdd + miniTurboAdd + pickupBoostAdd,
        KINEMATIC_BOOST_CAP,
      );

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
    const preRot = body.rot;

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
      body.activeBoosts.has('slipstream-boost') ||
      body.activeBoosts.has('pad-boost') ||
      body.activeBoosts.has('mini-turbo-boost');
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

    // 10. Mini-turbo (surf-carve whip) — update the charge meter from the
    //     heading change this tick. integrateSurfStep stays pure; the stateful
    //     charge lives on the body and is derived here per-tick (fixed 30Hz).
    this.updateMiniTurbo(state, body, preRot, effectiveThrust, dt, now);
  }

  // ─── Mini-turbo (surf-carve whip) ──────────────────────────────────────────

  /**
   * Charge/fire the mini-turbo from a SUSTAINED hard carve. Called once per tick
   * per body at the END of applyIntentForTick (after the surf integrate) so it
   * reads the actual heading change this tick.
   *
   * Charge builds while the body turns hard (|Δheading| ≥ threshold) in ONE
   * direction, fast enough, under thrust, and grounded. It DISCHARGES (fires a
   * short boost) the moment the carve breaks — the player straightens out, eases
   * off, slows, or flips steer direction (the Mario-Kart "release the drift"
   * beat, mapped onto surf carving since the drift button is retired for jump).
   *
   * Anti-cheat: the fire is a TIMED speedMod additive folded into the same
   * positive kinetic stack (KINEMATIC_BOOST_CAP) + the 1.85× hard cap, so it
   * cannot be chained into infinite speed. It never touches integrateSurfStep,
   * never compounds a per-tick multiplier, and never mutates velocity directly.
   */
  private updateMiniTurbo(
    state: SplineRoomState,
    body: SplineBody,
    preRot: number,
    effectiveThrust: number,
    dt: number,
    now: number,
  ): void {
    // Signed shortest heading change this tick.
    const d = body.rot - preRot;
    const carveTurn = Math.atan2(Math.sin(d), Math.cos(d));
    const speed = Math.hypot(body.vx, body.vz);
    const airborne = body.airborneTicks > 0 || body.heightOffset > 0;

    // Anti-farm: no charge builds during the post-fire cooldown (blocks the
    // flick-carve reseed farm from producing continuous boost).
    const onCooldown = now < body.miniTurboCooldownUntil;

    const carving =
      !onCooldown &&
      !airborne &&
      Math.abs(carveTurn) >= MINI_TURBO_MIN_TURN_PER_TICK &&
      speed >= MINI_TURBO_MIN_SPEED &&
      effectiveThrust > 0;

    if (carving) {
      const sign = carveTurn > 0 ? 1 : -1;
      if (body.miniTurboCarveSign !== 0 && sign !== body.miniTurboCarveSign) {
        // Steer flipped direction mid-charge — that's a counter-carve, not a
        // sustained hold. Discharge whatever was earned, then start fresh in
        // the new direction (this tick seeds the new charge).
        this.releaseMiniTurbo(state, body, now);
        body.miniTurboChargeMs = 0;
      }
      body.miniTurboCarveSign = sign;
      body.miniTurboChargeMs = Math.min(
        body.miniTurboChargeMs + dt * 1000,
        MINI_TURBO_MAX_CHARGE_MS,
      );
      body.miniTurboLevel =
        body.miniTurboChargeMs >= MINI_TURBO_TIER2_MS
          ? 2
          : body.miniTurboChargeMs >= MINI_TURBO_TIER1_MS
            ? 1
            : 0;
    } else {
      // Carve broke → release. releaseMiniTurbo no-ops if nothing was charged.
      this.releaseMiniTurbo(state, body, now);
      body.miniTurboChargeMs = 0;
      body.miniTurboLevel = 0;
      body.miniTurboCarveSign = 0;
    }
  }

  /**
   * Fire the mini-turbo if the current charge reached at least tier 1. Sets a
   * timed `mini-turbo-boost` speedMod and broadcasts `event.mini_turbo_fire`.
   * No-op when the charge never reached tier 1 (level 0).
   */
  private releaseMiniTurbo(
    state: SplineRoomState,
    body: SplineBody,
    now: number,
  ): void {
    const lvl = body.miniTurboLevel;
    if (lvl <= 0) return;
    const mult = lvl === 2 ? MINI_TURBO_TIER2_MULT : MINI_TURBO_TIER1_MULT;
    const dur =
      lvl === 2 ? MINI_TURBO_TIER2_DURATION_MS : MINI_TURBO_TIER1_DURATION_MS;
    // Overwrite (not stack): a fresh release replaces any lingering one so
    // duration/mult never compound beyond a single tier's values.
    body.activeBoosts.set('mini-turbo-boost', { expiresAt: now + dur, mult });
    // Anti-farm cooldown (sim-time): suppress recharging briefly so rhythmic
    // flick-carving can't hold a continuous boost.
    body.miniTurboCooldownUntil = now + MINI_TURBO_COOLDOWN_MS;
    this.broadcastFn(state.roomId, {
      type: 'event.mini_turbo_fire',
      avatarId: body.avatarId,
      level: lvl as 1 | 2,
    });
    // Level is reset by the caller after this returns.
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

  // ─── Progress + lap + finish line (CLOSED-LOOP, 2026-06-22) ─────────────────

  /**
   * Update body within-lap `progress` (arclength fraction of one loop) + `lap`
   * (completed-lap count) from the spline, detect forward seam crossings, and
   * finish a body when it completes lap `REEF_RACE_LAPS` and crosses the line.
   *
   * Lap model:
   *   - `progress` ∈ [0,1) is the within-lap fraction and WRAPS 1→0 at the seam.
   *   - A FORWARD SEAM CROSSING is `prevProgress` high (> SEAM_HI) and the new
   *     within-lap progress low (< SEAM_LO). On a 30k-wu loop a body moves
   *     ≤ ~17 wu/tick (≈ 0.0006 of the loop), so it can NEVER legitimately
   *     jump 0.8→0.2 except by wrapping the seam — the gap makes the test robust.
   *   - Bodies spawn BEHIND the line (progress ≈ 1.0). The FIRST forward seam
   *     crossing is the "start gun" (sets `startCrossed`, leaves `lap`=0 = on
   *     lap 1). Every crossing after that increments `lap`.
   *   - A body FINISHES the instant it would increment `lap` to `REEF_RACE_LAPS`
   *     — i.e. it crosses the start/finish seam after completing the final lap.
   *
   * Anti-cheat: a seam wrap is FORWARD progress, never a regression — the
   * regression check runs on the WRAP-ADJUSTED within-lap delta.
   */
  private resolveProgress(state: SplineRoomState, now: number): void {
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;

      const closest = state.spline.closestPointOnSpline({ x: body.x, z: body.z });
      const total = state.spline.totalArcLength;
      const arcS = state.spline.arclengthFromT(closest.t);
      const newProgress = total > 0 ? arcS / total : 0;

      // First sample: seed from the spawn projection (body sits behind the line,
      // progress ≈ 1.0) so the first tick is not read as a spurious wrap.
      if (!body.progressInitialized) {
        body.progress = newProgress;
        body.prevProgress = newProgress;
        body.progressInitialized = true;
        continue;
      }

      const prev = body.progress;

      // Seam crossings on the periodic loop. A single tick moves ≤ ~31 wu ≈
      // 0.00035 of the loop, so any within-lap jump > 0.5 is a seam WRAP, not
      // real motion — in EITHER direction.
      const SEAM_WRAP = 0.5;
      const rawDelta = newProgress - prev;
      const forwardWrap = rawDelta < -SEAM_WRAP;  // prev high, new low → FORWARD
      const backwardWrap = rawDelta > SEAM_WRAP;  // prev low, new high → BACKWARD

      // TRUE signed within-lap delta, wrap-adjusted in BOTH directions (Codex
      // round-3 BLOCKER 3). The old code only adjusted the FORWARD wrap, so a
      // reverse low→high seam cross read as ~+0.98 "forward progress" — letting a
      // body SHUTTLE across the start line to farm laps toward a FINISH (finish
      // order feeds `activity.match.placed` scoring). A backward wrap is now a
      // small NEGATIVE delta, and a backward seam cross UNDOES a lap below.
      const signedDelta = forwardWrap
        ? rawDelta + 1
        : backwardWrap
          ? rawDelta - 1
          : rawDelta;

      // Regression guard on the TRUE signed delta (small backward moves stay
      // within tolerance = legit knockback; a real teleport-back trips it).
      if (!progressIsMonotonic(prev + signedDelta, prev)) {
        this.flag(state, body.avatarId, 'checkpoint_skip',
          `progress_regression: delta=${signedDelta.toFixed(4)} (prev=${prev.toFixed(4)} new=${newProgress.toFixed(4)})`);
      }

      body.prevProgress = prev;
      body.progress = newProgress;

      if (backwardWrap) {
        // Crossed the start/finish seam BACKWARD — UNDO one lap so shuttling
        // across the line can never net a lap gain toward a finish. A legit
        // racer knocked back over the line just re-crosses forward (net zero).
        if (body.lap > 0) {
          body.lap -= 1;
          body.lastLapAt = now;
        } else if (body.startCrossed) {
          // Went back behind the start gun on lap 1 — re-arm the start crossing.
          body.startCrossed = false;
          body.lastLapAt = now;
        }
        continue;
      }

      if (!forwardWrap) continue;

      // ── Forward seam crossing handling ──────────────────────────────────
      if (!body.startCrossed) {
        // First crossing = the START GUN. Now genuinely on lap 1; lap stays 0.
        body.startCrossed = true;
        body.lastLapAt = now;
        continue;
      }

      // A genuine lap completion. Increment completed-lap count.
      const splitMs = now - body.lastLapAt;
      body.lastLapAt = now;
      body.lap += 1;

      if (body.lap >= REEF_RACE_LAPS) {
        // Completed the final lap and crossed the start/finish line → FINISH.
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
          lap: body.lap,
        } as unknown as ServerFrame);
      } else {
        // Mid-race lap completion — emit a lap event so the HUD ticks the counter.
        this.broadcastFn(state.roomId, {
          type: 'event.lap_completed',
          avatarId: body.avatarId,
          lap: body.lap,
          splitMs,
          totalMs: now - state.startedAt,
          totalLaps: REEF_RACE_LAPS,
        } as unknown as ServerFrame);
      }
    }
  }

  // ─── Segment-time anti-shortcut (NON-FORFEITING) ───────────────────────────

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

  // ─── Boost pads (v2 mechanics) ─────────────────────────────────────────────

  /**
   * Check each GROUNDED body against all boost-pad AABB volumes. Fires ONLY on
   * the entry edge (outside→inside) via a per-body per-pad latch — a body that
   * sits/coasts inside does not re-fire (Codex finding 2a) — injecting a capped
   * along-heading velocity kick + a short timed `pad-boost` speedMod, and
   * broadcasting `event.boost_pad`. Airborne bodies are ignored (floor pads have
   * no vertical reach — Codex finding 2b). Fires for bots too (position-based).
   */
  private resolveBoostPads(state: SplineRoomState, now: number): void {
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;

      // Floor pads have no vertical reach — an AIRBORNE body passing overhead
      // must NOT trigger them (Codex finding 2b; mirrors the ramp grounded gate).
      const grounded = body.airborneTicks === 0 && body.heightOffset === 0;

      let inside = state.boostPadInside.get(body.avatarId);
      if (!inside) {
        inside = new Set<string>();
        state.boostPadInside.set(body.avatarId, inside);
      }

      for (const pad of state.boostPads) {
        const pt = state.spline.centerlineAt(pad.t);
        const tang = state.spline.tangentAt(pad.t);
        const nx = -tang.z;
        const nz = tang.x;
        const cx = pt.x + nx * pad.lateralOffset;
        const cz = pt.z + nz * pad.lateralOffset;

        const dx = body.x - cx;
        const dz = body.z - cz;
        const along = dx * tang.x + dz * tang.z;
        const perp = dx * nx + dz * nz;
        const withinXZ =
          Math.abs(along) <= pad.halfLength && Math.abs(perp) <= pad.halfWidth;
        const wasInside = inside.has(pad.id);

        if (grounded && withinXZ && !wasInside) {
          // ENTRY EDGE (outside→inside, grounded) — fire exactly once. A body
          // that keeps sitting/coasting inside does NOT re-fire (Codex finding
          // 2a); it must leave (grounded exit clears the latch) and re-enter.
          inside.add(pad.id);
          this.applyBoostPad(body, now);
          this.broadcastFn(state.roomId, {
            type: 'event.boost_pad',
            avatarId: body.avatarId,
            padId: pad.id,
          });
        } else if (grounded && !withinXZ && wasInside) {
          // GROUNDED exit — clear the latch so a later real re-entry can fire.
          inside.delete(pad.id);
        }
        // Airborne: neither fire nor clear the latch (a jump over the pad is not
        // an exit — this prevents a bunny-hop-on-pad re-fire farm).
      }
    }
  }

  /**
   * Apply a boost-pad hit: an instant along-heading velocity kick (clamped to
   * the 1.85× hard cap) + a timed decaying `pad-boost` speedMod. Runs in the
   * post-integrate `resolveBoostPads` pass so the kick is not measured by the
   * per-tick velocity-delta validator; the hard-cap clamp keeps it inside the
   * boost ceiling.
   */
  private applyBoostPad(body: SplineBody, now: number): void {
    const hardCap = REEF_MAX_SPEED * 1.85;

    // Decompose velocity into the current heading frame, kick the along
    // component, recompose.
    const fwdX = Math.sin(body.rot);
    const fwdZ = Math.cos(body.rot);
    const perpX = Math.cos(body.rot);
    const perpZ = -Math.sin(body.rot);
    let vAlong = body.vx * fwdX + body.vz * fwdZ;
    const vPerp = body.vx * perpX + body.vz * perpZ;
    vAlong = Math.min(vAlong + BOOST_PAD_KICK, hardCap);
    body.vx = vAlong * fwdX + vPerp * perpX;
    body.vz = vAlong * fwdZ + vPerp * perpZ;

    // Belt-and-braces: clamp total speed (the retained perp could nudge it over).
    const sp = Math.hypot(body.vx, body.vz);
    if (sp > hardCap) {
      body.vx = (body.vx / sp) * hardCap;
      body.vz = (body.vz / sp) * hardCap;
    }

    // Timed decaying speedMod so cruise stays elevated then falls off.
    body.activeBoosts.set('pad-boost', {
      expiresAt: now + BOOST_PAD_DURATION_MS,
      mult: BOOST_PAD_BOOST_MULT,
    });
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

  /**
   * Resolve all power-up USES pressed this tick in a SINGLE post-integrate pass,
   * in two phases so the outcome is independent of body-map iteration order
   * (Codex finding 4a):
   *   Phase 1 — SELF buffs (turbo, shield). A shield used this tick is up BEFORE
   *             any offensive item resolves, regardless of who is earlier in the
   *             map (fixes the shield-vs-whirlpool race).
   *   Phase 2 — OFFENSIVE / rival-affecting (ink, whirlpool, tide, seeker). All
   *             positions are final (post-integrate), so every rival read sees
   *             one consistent world, not a mid-integration pre/post mix.
   * Pending slots are cleared after both phases.
   */
  private resolvePowerUpUses(state: SplineRoomState, now: number): void {
    const isSelfBuff = (k: ReefPowerUpKind | null | undefined) =>
      k === 'rr-turbo-bubble' || k === 'rr-bubble-shield';

    // Phase 1 — SELF buffs (turbo, shield). A shield used this tick is up BEFORE
    // any offensive item resolves, regardless of body-map order.
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;
      for (const slot of body.pendingPowerUpSlots) {
        if (isSelfBuff(body.inventory[slot]?.kind as ReefPowerUpKind | null)) {
          this.tryUsePowerUp(state, body, slot, now);
        }
      }
    }

    // Phase 2 — OFFENSIVE, AGGREGATED for order-independence + a single final
    // speed clamp per target (Codex round-3 BLOCKERS 1+2). The old per-body
    // immediate mutation made two effects on the same victim in one tick depend
    // on body-map order, AND seeker-jelly's impulse was unclamped (an aligned
    // seeker could push a victim to ~1225, contained only by a later whirlpool's
    // clamp by roster luck). Now every effect is COLLECTED from the immutable
    // post-integrate snapshot (positions unchanged this pass; velocities read
    // as-is), AGGREGATED per target (impulses sum, slows multiply — both
    // commutative), APPLIED once in a canonical order (impulse then slow), and
    // clamped ONCE to the 925 hard cap (caps every knockback incl. seeker).
    const impulseX = new Map<string, number>();
    const impulseZ = new Map<string, number>();
    const slowMul = new Map<string, number>();
    const affected = new Set<string>();
    const addImpulse = (id: string, dvx: number, dvz: number) => {
      impulseX.set(id, (impulseX.get(id) ?? 0) + dvx);
      impulseZ.set(id, (impulseZ.get(id) ?? 0) + dvz);
      affected.add(id);
    };
    const addSlow = (id: string, factor: number) => {
      slowMul.set(id, (slowMul.get(id) ?? 1) * (1 - factor));
      affected.add(id);
    };

    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) {
        body.pendingPowerUpSlots.length = 0;
        continue;
      }
      for (const slot of body.pendingPowerUpSlots) {
        const slotObj = body.inventory[slot];
        const kind = slotObj?.kind as ReefPowerUpKind | null;
        if (!slotObj || !kind || isSelfBuff(kind)) continue; // self-buffs: Phase 1
        if (slotObj.charges <= 0 || slotObj.cooldownUntil > now) continue;
        const def = getReefPowerUpDef(kind);
        switch (kind) {
          // Effect-only (no velocity) — already order-independent (max-expiry).
          case 'rr-ink-slick':
            this.applyInkSlick(state, body, now);
            break;
          case 'rr-tide-wave':
            this.collectTideWave(state, body, addSlow);
            break;
          case 'rr-seeker-jelly':
            this.collectSeekerJelly(state, body, addImpulse);
            break;
          case 'rr-whirlpool':
            this.collectWhirlpool(state, body, now, addImpulse);
            break;
        }
        this.consumeSlot(body, slot, def, now);
      }
      body.pendingPowerUpSlots.length = 0;
    }

    // Apply the aggregated velocity changes once per target, then one clamp.
    const cap = REEF_MAX_SPEED * 1.85;
    for (const id of affected) {
      const target = state.bodies.get(id);
      if (!target) continue;
      target.vx += impulseX.get(id) ?? 0;
      target.vz += impulseZ.get(id) ?? 0;
      const sm = slowMul.get(id);
      if (sm !== undefined) {
        target.vx *= sm;
        target.vz *= sm;
      }
      const sp = Math.hypot(target.vx, target.vz);
      if (sp > cap) {
        target.vx = (target.vx / sp) * cap;
        target.vz = (target.vz / sp) * cap;
      }
    }
  }

  /** Consume one charge of a power-up slot (+ set cooldown / clear the slot). */
  private consumeSlot(
    body: SplineBody,
    slotIndex: number,
    def: { cooldownMs: number },
    now: number,
  ): void {
    const slot = body.inventory[slotIndex];
    if (!slot) return;
    slot.charges -= 1;
    if (slot.charges <= 0) {
      body.inventory[slotIndex] = { kind: null, charges: 0, cooldownUntil: 0 };
    } else {
      slot.cooldownUntil = now + def.cooldownMs;
    }
  }

  /**
   * Resolve a SELF-BUFF power-up (turbo / shield) — Phase 1 only. Offensive
   * items are resolved in the aggregate Phase 2 of `resolvePowerUpUses`, NOT
   * here.
   */
  private tryUsePowerUp(
    state: SplineRoomState,
    body: SplineBody,
    slotIndex: number,
    now: number,
  ): void {
    void state;
    const slot = body.inventory[slotIndex];
    if (!slot || slot.kind === null || slot.charges <= 0) return;
    if (slot.cooldownUntil > now) return;

    const kind = slot.kind as ReefPowerUpKind;
    if (kind !== 'rr-turbo-bubble' && kind !== 'rr-bubble-shield') return;
    const def = getReefPowerUpDef(kind);
    body.activeEffects.set(
      kind,
      now + def.effectMs * body.mults.powerUpDurationMult,
    );
    this.consumeSlot(body, slotIndex, def, now);
  }

  /**
   * Tide-wave — a proximity SLOW. Accumulates a multiplicative slow factor per
   * rival (order-independent) via `addSlow` instead of mutating velocity
   * directly; the aggregate apply loop scales + clamps once. (Codex round-3.)
   */
  private collectTideWave(
    state: SplineRoomState,
    src: SplineBody,
    addSlow: (id: string, factor: number) => void,
  ): void {
    const radius = 250;
    for (const target of state.bodies.values()) {
      if (target.avatarId === src.avatarId) continue;
      if (!target.alive || target.dnf || target.finishedAt !== null) continue;
      if (target.activeEffects.has('rr-bubble-shield')) continue;
      const dx = target.x - src.x;
      const dz = target.z - src.z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius) continue;
      const factor =
        0.4 * (1 - dist / radius) * target.mults.knockbackResistMult;
      addSlow(target.avatarId, factor);
      this.broadcastFn(state.roomId, {
        type: 'event.hit',
        srcAvatarId: src.avatarId,
        dstAvatarId: target.avatarId,
        position: { x: target.x, y: target.z },
        power: 1 - dist / radius,
      });
    }
  }

  /**
   * Seeker-jelly — an impulse AWAY from the user on the closest in-front rival.
   * Accumulates the impulse via `addImpulse` (order-independent); the aggregate
   * apply loop sums + CLAMPS it to 925 (Codex round-3 BLOCKER 2 — the old direct
   * add had no clamp, so an aligned seeker could exceed the cap).
   */
  private collectSeekerJelly(
    state: SplineRoomState,
    src: SplineBody,
    addImpulse: (id: string, dvx: number, dvz: number) => void,
  ): void {
    let best: SplineBody | null = null;
    let bestDist = Infinity;
    const sv = Math.hypot(src.vx, src.vz);
    for (const t of state.bodies.values()) {
      if (t.avatarId === src.avatarId) continue;
      if (!t.alive || t.dnf || t.finishedAt !== null) continue;
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
    const impulse = REEF_MAX_SPEED * 0.6 * best.mults.knockbackResistMult;
    addImpulse(best.avatarId, (dx / mag) * impulse, (dz / mag) * impulse);
    this.broadcastFn(state.roomId, {
      type: 'event.hit',
      srcAvatarId: src.avatarId,
      dstAvatarId: best.avatarId,
      position: { x: best.x, y: best.z },
      power: 1,
    });
  }

  /**
   * rr-ink-slick (bug fix) — a defensive item that drops an ink slick BEHIND
   * the user. Rivals within `INK_SLICK_RADIUS` and behind the dropper's heading
   * (and not shielded) get the `rr-ink-slick` effect set on THEM; their own
   * applyIntentForTick then reads `slicked` and drops to the 0.30 speedMod. The
   * old code set the effect on `self`, slowing the USER — the exact inversion of
   * the HUD copy. Duration scales by the SOURCE's powerUpDurationMult (an
   * intelligence thrower's item lingers longer), never the victim's.
   */
  private applyInkSlick(
    state: SplineRoomState,
    src: SplineBody,
    now: number,
  ): void {
    const def = getReefPowerUpDef('rr-ink-slick');
    const dur = def.effectMs * src.mults.powerUpDurationMult;
    const fwdX = Math.sin(src.rot);
    const fwdZ = Math.cos(src.rot);
    for (const target of state.bodies.values()) {
      if (target.avatarId === src.avatarId) continue;
      if (!target.alive || target.dnf || target.finishedAt !== null) continue;
      if (target.activeEffects.has('rr-bubble-shield')) continue;
      const dx = target.x - src.x;
      const dz = target.z - src.z;
      const dist = Math.hypot(dx, dz);
      if (dist > INK_SLICK_RADIUS) continue;
      // A slick is dropped behind you — only catch rivals to the rear.
      if (dx * fwdX + dz * fwdZ >= 0) continue;
      // Never SHORTEN an already-active slick (Codex finding 4d): a later, weaker
      // (or same) slick must not cut short a longer one still ticking down.
      const existingExpiry = target.activeEffects.get('rr-ink-slick') ?? 0;
      target.activeEffects.set(
        'rr-ink-slick',
        Math.max(existingExpiry, now + dur),
      );
      this.broadcastFn(state.roomId, {
        type: 'event.hit',
        srcAvatarId: src.avatarId,
        dstAvatarId: target.avatarId,
        position: { x: target.x, y: target.z },
        power: 1 - dist / INK_SLICK_RADIUS,
      });
    }
  }

  /**
   * rr-whirlpool (bug fix) — the rarest (legendary) item, previously INERT (set
   * on `activeEffects` but read by nothing). Now a real AoE hazard: nearby
   * rivals (not shielded) are PULLED toward the whirlpool center (the user's
   * position) and briefly slowed. The pull respects `knockbackResistMult`; the
   * slow reuses the `hazard-slow` negative kinetic stack (stored as a
   * multiplier, converted to an additive `-1` in applyIntentForTick).
   */
  /**
   * Whirlpool — a PULL toward the user + a brief slow, on every nearby rival.
   * Accumulates the pull impulse via `addImpulse` (order-independent) and sets
   * the `hazard-slow` effect (constant duration → order-independent). The
   * victim's speed is CLAMPED once in the aggregate apply loop (Codex round-3:
   * the per-effect clamp moved to the single final clamp so it also bounds a
   * seeker+whirlpool combo on the same victim). The knockback bypasses the
   * per-tick delta validator, so the final clamp is what keeps it ≤ 925.
   */
  private collectWhirlpool(
    state: SplineRoomState,
    src: SplineBody,
    now: number,
    addImpulse: (id: string, dvx: number, dvz: number) => void,
  ): void {
    const def = getReefPowerUpDef('rr-whirlpool');
    for (const target of state.bodies.values()) {
      if (target.avatarId === src.avatarId) continue;
      if (!target.alive || target.dnf || target.finishedAt !== null) continue;
      if (target.activeEffects.has('rr-bubble-shield')) continue;
      // Vector points FROM the rival TOWARD the whirlpool center (pull inward).
      const dx = src.x - target.x;
      const dz = src.z - target.z;
      const dist = Math.hypot(dx, dz);
      if (dist > WHIRLPOOL_RADIUS) continue;
      const falloff = 1 - dist / WHIRLPOOL_RADIUS;
      const mag = Math.max(dist, 1);
      const pull =
        WHIRLPOOL_PULL_IMPULSE * falloff * target.mults.knockbackResistMult;
      addImpulse(target.avatarId, (dx / mag) * pull, (dz / mag) * pull);
      // Brief slow — stored as a multiplier; applyIntentForTick reads (mult - 1).
      target.activeBoosts.set('hazard-slow', {
        expiresAt: now + def.effectMs,
        mult: 1 + WHIRLPOOL_SLOW_MULT,
      });
      this.broadcastFn(state.roomId, {
        type: 'event.hit',
        srcAvatarId: src.avatarId,
        dstAvatarId: target.avatarId,
        position: { x: target.x, y: target.z },
        power: falloff,
      });
    }
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
        // CLOSED-LOOP: order by whole-race progress (lap + within-lap fraction),
        // NOT the within-lap fraction alone (a lap-2 leader at progress 0.1 is
        // AHEAD of a lap-1 racer at progress 0.9).
        racing.push({
          avatarId: b.avatarId,
          progress: totalProgress(b.lap, b.progress),
          finishedAt: null,
          dnf: false,
        });
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
        lap: b.lap,
        finishedAt: b.finishedAt,
        dnf: b.dnf,
        placement: state.lastPlacementMap.get(b.avatarId) ?? null,
        miniTurboCharge: quant(
          Math.min(1, b.miniTurboChargeMs / MINI_TURBO_TIER2_MS),
          100,
        ),
        miniTurboLevel: b.miniTurboLevel,
        boosting:
          b.activeBoosts.has('launch-boost') ||
          b.activeBoosts.has('slipstream-boost') ||
          b.activeBoosts.has('pad-boost') ||
          b.activeBoosts.has('mini-turbo-boost'),
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
      // v2 mechanics — carry the boost/meter fields on KEYFRAMES too (Codex
      // finding 7). The client replaces its entity map on every keyframe, so
      // omitting these blanked the HUD meter/trail once per second (and left a
      // mid-match reconnect with no authoritative boost state until the next
      // delta). The delta path already carries them; this keeps keyframes whole.
      height: b.height !== 0 ? b.height : undefined,
      miniTurboCharge: b.miniTurboCharge,
      miniTurboLevel: b.miniTurboLevel,
      boosting: b.boosting,
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
          // CLOSED-LOOP: score = whole-race progress (lap + within-lap fraction)
          // so a fresh keyframe orders laps correctly even before the next delta.
          score: quant(totalProgress(b.lap, b.progress), 10000),
          lap: b.lap,
          totalLaps: REEF_RACE_LAPS,
          position: b.placement ?? undefined,
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
          p.lap !== b.lap ||
          p.finishedAt !== b.finishedAt ||
          p.dnf !== b.dnf ||
          p.placement !== b.placement ||
          p.miniTurboCharge !== b.miniTurboCharge ||
          p.miniTurboLevel !== b.miniTurboLevel ||
          p.boosting !== b.boosting
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
          // Emit the NUMERIC height, INCLUDING 0 (Codex round-3 nit): the old
          // `!== 0 ? … : undefined` dropped height on landing, so the client
          // (which merges deltas) kept the stale airborne height until the next
          // keyframe. A body only appears in the delta when a field changed, so
          // this is just one extra number on that body's frame.
          height: b.height,
          progress: b.progress,
          // CLOSED-LOOP lap state — the render/HUD read these directly.
          lap: b.lap,
          totalLaps: REEF_RACE_LAPS,
          position: b.placement ?? undefined,
          state: b.dnf
            ? ('dnf' as const)
            : b.finishedAt !== null
              ? ('finished' as const)
              : ('racing' as const),
          placement: b.placement,
          // v2 mechanics — mini-turbo meter + boost FX flag for the HUD/render.
          miniTurboCharge: b.miniTurboCharge,
          miniTurboLevel: b.miniTurboLevel,
          boosting: b.boosting,
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
      // CLOSED-LOOP: real completed-lap count + a within-lap "checkpoint" proxy
      // (12 phantom checkpoints around one loop) for the v1 bot's steering
      // heuristics. `b.progress` is the within-lap fraction 0..1.
      lap: b.lap,
      nextCheckpoint: Math.round(b.progress * 12) % 12,
      currentPlacement: placementMap.get(b.avatarId) ?? null,
      finishedAt: b.finishedAt,
      dnf: b.dnf,
    }));
    return {
      selfAvatarId,
      bodies,
      arenaRadius: Math.round(state.spline.totalArcLength),  // loop arc length as "radius" boundary heuristic (closed-loop)
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
