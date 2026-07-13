/**
 * Q2 Activity Portals — Reef Race server-authoritative simulation
 * (chunk #5).
 *
 * Per backend §4.5 + 3d-spec §2.1:
 *   - 30Hz fixed-tick (race kinematics tolerate lower rate; halves
 *     bandwidth vs Bumper's 60Hz)
 *   - Bespoke oval, ~6000wu perimeter, 2 laps default
 *   - 12 checkpoints in fixed sequence (0=finish/start; 1..11 around)
 *   - Out-of-order checkpoint crossings silently ignored — kills
 *     teleport-to-finish exploits at the source
 *   - MIN_LAP_MS = 15s; faster laps discarded + flagged
 *   - 6-power-up catalog (turbo-bubble, ink-slick, bubble-shield,
 *     seeker-jelly, tide-wave, whirlpool) per master plan
 *   - Snapshot delta @ 5Hz (every 6 ticks); keyframe @ 1Hz
 *   - Soft round timeout 90s + 30s straggler grace; hard timeout 120s
 *   - Personal-best detection lives in chunk #7's reward pipeline; sim
 *     supplies authoritative `score_ms` finish times via
 *     `computeResults()`
 *   - All anti-cheat flags routed through `ReefFlagCounter` →
 *     auto-forfeit at 5 flags
 *
 * Determinism: pickup-box positions are fixed at boot (deterministic
 * per-room from the LCG seed), and the kind rolled on respawn uses the
 * same LCG. Two reruns of identical inputs produce identical sim
 * outputs.
 *
 * The sim DOES NOT own the WS hub or DB writes — the room manager does
 * the DB writes, the WS hub forwards the broadcasts. The sim publishes
 * frames via the registered `broadcast` callback set at boot.
 */

import {
  validateReefPositionDelta,
  validateReefVelocityDelta,
  validateReefPowerUpUse,
  validateLapTime,
  validateCheckpointSequence,
  ReefCheckpointSkipTracker,
  ReefFlagCounter,
  FLAG_FORFEIT_THRESHOLD,
  type PowerUpInventorySlot,
} from '../anti-cheat/reef-race';
import { validateInputBounds, type InputBounds } from '../anti-cheat/shared';
import type { Vec2, ServerFrame } from '@clawville/shared';
import {
  logEvent,
  ACTIVITY_EVENT_TYPES,
  type ActivityAntiCheatFlagPayload,
} from '../../event-logger';
import { activityReplayLog } from '../activity-replay-log';
import type { BotController } from '../bots/bot-controller';
import {
  REEF_LAPS,
  REEF_CHECKPOINT_COUNT,
  REEF_TICK_HZ,
  REEF_MAX_SPEED,
  REEF_MAX_ACCEL,
  REEF_BOOST_MULT,
  REEF_DRAG,
  REEF_BODY_RADIUS,
  REEF_TRACK_HALF_WIDTH,
  REEF_SOFT_TIMEOUT_MS,
  REEF_HARD_TIMEOUT_MS,
  REEF_MAX_POWER_UP_SLOTS,
  REEF_POWERUP_BOX_COUNT,
  REEF_POWERUP_RESPAWN_MS,
  REEF_POWERUP_RADIUS,
  REEF_TRACK_A,
  REEF_TRACK_B,
  REEF_POWERUP_DEFS,
  buildReefCheckpoints,
  isInsideCheckpoint,
  reefCenterlineAt,
  getReefPowerUpDef,
  type ReefCheckpointAabb,
  type ReefPowerUpKind,
  // Phase 1 — drift state machine + launch boost
  type ReefBoostKind,
  DRIFT_SPARK_TICK_1,
  DRIFT_SPARK_TICK_2,
  DRIFT_SPARK_TICK_3,
  DRIFT_BOOST_DURATION_MS,
  DRIFT_BOOST_MULTS,
  DRIFT_ANGULAR_BIAS_RAD,
  DRIFT_MIN_SPEED_FOR_CHARGE,
  DRIFT_MIN_STEER,
  LAUNCH_BOOST_MULT,
  LAUNCH_BOOST_DURATION_MS,
  LAUNCH_STALL_DURATION_MS,
  LAUNCH_STALL_THRUST_CAP,
  ACTION_BIT_DRIFT,
  REEF_KINEMATIC_TOLERANCE,
  // Phase 2 — kinematic effects
  KINEMATIC_BOOST_CAP,
  NEGATIVE_KINETIC_FLOOR,
  // Phase 2 — slipstream
  SLIPSTREAM_MIN_DISTANCE,
  SLIPSTREAM_MAX_DISTANCE,
  SLIPSTREAM_HALF_WIDTH,
  SLIPSTREAM_MIN_VEL_ALIGNMENT,
  SLIPSTREAM_REQUIRED_TICKS,
  SLIPSTREAM_BOOST_MULT,
  SLIPSTREAM_GRACE_TICKS,
  SLIPSTREAM_REFRESH_TTL_MS,
  // Phase 2 — apex
  APEX_INNER_RADIUS,
  APEX_OUTER_RADIUS,
  APEX_BONUS_MULT,
  APEX_PENALTY_MULT,
  APEX_DURATION_MS,
  // Phase 2 — ribbons
  RIBBON_HALF_WIDTH,
  RIBBON_BOOST_MULT,
  RIBBON_BOOST_DURATION_MS,
  RIBBON_COLLECTION_COOLDOWN_MS,
  buildReefBoostRibbons,
  type ReefBoostRibbon,
  // Phase 2 — hazards
  HAZARD_TICK_DURATION_MS,
  HAZARD_SLOW_MULT,
  buildReefHazardPatches,
  type ReefHazardPatch,
  // Phase 2 — apex zone builder
  buildReefApexZones,
  type ReefApexZone,
  // Phase 2 — placement-weighted item table
  getPlacementItemTable,
  // Phase 3 — stat-driven body multipliers
  buildBodyMultipliers,
  racingClassFromArchetype,
  type BodyMultipliers,
  type AvatarRacingProfile,
  type RacingClass,
  // Phase 4 — ghost capture cadence + streak constants
  GHOST_CAPTURE_HZ,
  MAX_GHOST_FRAMES_PER_LAP,
  APEX_HAIRPIN_CHECKPOINT_INDICES,
} from './reef-race-config';
import {
  STREAK_MILESTONES,
  streakMilestoneKind,
  type GhostFrame,
} from '@clawville/shared';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Sim tick rate (Hz). 30Hz per backend §3.4 + task spec. */
export const REEF_SIM_HZ = REEF_TICK_HZ;
const REEF_TICK_MS = 1000 / REEF_SIM_HZ;

/**
 * Snapshot broadcast rate (Hz). Bumped 5 → 10 (2026-04-26) → 20 (2026-04-28)
 * to halve the client-side interp segment length each time. At 30Hz sim
 * + 5.8 rad/s yaw, a 100ms (10Hz) bracket can cover ~33° of rotation that
 * the client linear-lerps over 100ms — a visible piecewise seam. 20Hz halves
 * the seam to ~16° / 50ms which is well below the perceptual jerk threshold
 * for kart-style steering. Bandwidth: 8 racers × ~50 bytes × 20Hz ≈ 8 KB/s
 * per client (comfortable). Halve client INTERP_DELAY_MS in lockstep (200 → 100).
 */
const REEF_SNAPSHOT_HZ = 20;
const REEF_TICKS_PER_SNAPSHOT = Math.round(REEF_SIM_HZ / REEF_SNAPSHOT_HZ);

/** Keyframe broadcast cadence (1Hz per task spec). */
const REEF_TICKS_PER_KEYFRAME = REEF_SIM_HZ;

/** Quantization factors — same as Bumper for consistent client decoding. */
const POS_QUANT = 100;
const ROT_QUANT = 1000;

// ─── Off-track reset (Mario Kart) ───────────────────────────────────────────
//
// When a body's perpendicular distance from the nearest centerline checkpoint
// exceeds OFF_TRACK_PERP_DISTANCE, the body is teleported back to the LAST
// SUCCESSFULLY-CROSSED checkpoint (or the start grid if no laps yet) and
// frozen for OFF_TRACK_RESPAWN_MS. The freeze IS the Mario Kart penalty —
// player lost time falling off + can't move during reset.
//
// Detection threshold = REEF_TRACK_HALF_WIDTH (150) * 2.5 = 375 wu. Allows the
// outer guardrail (≈ HALF_WIDTH + GUARDRAIL margin) without false-firing on a
// kart that's just hugging the wall. A kart in the deep void at ±1500 wu off
// the centerline tangent is unambiguously off the map.
//
// Edge cases:
//   - Body already finished: never reset (would un-finish the race).
//   - Body forfeited / dnf: never reset (terminal states).
//   - Body inside reset freeze: skip detection (would re-trigger every tick).
// REEF_TRACK_HALF_WIDTH = 150 (imported from reef-race-config below).
// Computed at first use in checkOffTrackReset to avoid a TDZ-style import order.
const OFF_TRACK_PERP_DISTANCE_MULT = 2.5;
const OFF_TRACK_RESPAWN_MS = 1500;

/**
 * Runtime outer-wall approximation for the oval track.
 *
 * The previous guardrail used the nearest checkpoint's tangent as a local
 * centerline approximation. That is unstable between checkpoints and is very
 * wrong near the oval interior: bodies at the center of the map looked
 * hundreds of units "past the wall", so the sim kept snapping/reflecting them
 * every tick. In production that shows up as pinned racers and bot spin-outs
 * after contact. Use an outer ellipse instead; checkpoint sequencing still
 * enforces actual race progress.
 */
const REEF_OUTER_WALL_SCALE =
  1 + REEF_TRACK_HALF_WIDTH / Math.min(REEF_TRACK_A, REEF_TRACK_B);
const REEF_OUTER_WALL_PROJECT_SCALE =
  1 + (REEF_TRACK_HALF_WIDTH * 0.95) / Math.min(REEF_TRACK_A, REEF_TRACK_B);
const REEF_OFF_TRACK_RESET_SCALE =
  1 +
  (REEF_TRACK_HALF_WIDTH * OFF_TRACK_PERP_DISTANCE_MULT) /
    Math.min(REEF_TRACK_A, REEF_TRACK_B);
const REEF_TURN_RATE_RAD_PER_SEC = 5.8;
const REEF_DRIFT_TURN_RATE_RAD_PER_SEC = 7.2;

function ellipseScaleAt(x: number, y: number): number {
  return Math.hypot(x / REEF_TRACK_A, y / REEF_TRACK_B);
}

function outerEllipseNormalAt(x: number, y: number): Vec2 {
  const nx = x / (REEF_TRACK_A * REEF_TRACK_A);
  const ny = y / (REEF_TRACK_B * REEF_TRACK_B);
  const mag = Math.hypot(nx, ny);
  if (mag <= 1e-6) return { x: 0, y: 1 };
  return { x: nx / mag, y: ny / mag };
}

function ellipseTangentAtPoint(x: number, y: number): Vec2 {
  const n = outerEllipseNormalAt(x, y);
  return { x: -n.y, y: n.x };
}

function normalizeAngle(rad: number): number {
  let out = rad;
  while (out <= -Math.PI) out += Math.PI * 2;
  while (out > Math.PI) out -= Math.PI * 2;
  return out;
}

function shortestAngleDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

// ─── Body / sim state ───────────────────────────────────────────────────────

/**
 * Phase 1 — entry in `ReefBody.activeBoosts`. SEPARATE from `activeEffects`
 * (pickup-only) so the strict `Map<ReefPowerUpKind, number>` typing is
 * inviolate (audit C2 fix).
 */
interface ReefBoostEntry {
  expiresAt: number;
  /** Additive speed multiplier (e.g. 0.38 for +38%). Absent for launch-stall. */
  mult?: number;
}

/**
 * Phase 1 — per-body drift state machine. Single field on `ReefBody`.
 * Transitions described in `tickDriftState()` below; spec in
 * `.claude/plans/reef-race-phase1-detailed.md` §2.
 */
interface ReefDriftState {
  charging: boolean;
  sparkLevel: 0 | 1 | 2 | 3;
  /** Sim tick at which charging began — used for spark-tier elapsed math. */
  chargeStartTick: number;
  /** Drift-bit value last tick (for press / release edge detection). */
  lastDriftBit: boolean;
}

interface ReefBody {
  avatarId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  alive: boolean;
  /** Server-stamped finish wall-clock; null until the race finishes for this body. */
  finishedAt: number | null;
  /** Did Did Not Finish — set at hard timeout when laps < REEF_LAPS. */
  dnf: boolean;
  /**
   * Mario Kart-style off-track reset. Wall-clock when the body's freeze ends
   * after being teleported to the last clean checkpoint. While `now < respawnAt`,
   * intent is ignored (body sits still on the track). Null when not respawning.
   */
  respawnAt: number | null;
  /** Number of laps fully completed (0..REEF_LAPS). */
  lap: number;
  /** Index of the next checkpoint we expect this body to cross. */
  nextCheckpoint: number;
  /** Wall-clock of last legitimate checkpoint crossing — for split timing. */
  lastCheckpointAt: number;
  /** Wall-clock when the current lap started (for split-time discard). */
  lapStartedAt: number;
  /** Total elapsed race time ms (set at finish). 0 while still racing. */
  totalTimeMs: number;
  /** Cumulative split times in ms, indexed by lap-1. */
  lapSplitsMs: number[];
  /**
   * Set of checkpoint indices the body is currently inside as of last
   * tick. Used to count crossings on TRANSITION (entered) only — not
   * once per tick the body happens to overlap. Prevents silent-reject
   * spam from a body parked inside a wrong checkpoint volume.
   */
  insideCheckpoints: Set<number>;
  /** Per-avatar inventory, slot-indexed (length = REEF_MAX_POWER_UP_SLOTS) */
  inventory: PowerUpInventorySlot[];
  /** Active effects (kind → expires ms) — POWER-UP PICKUPS ONLY (audit C2). */
  activeEffects: Map<ReefPowerUpKind, number>;
  /**
   * Phase 1 — drift + launch boost state (SEPARATE map; never aliased to
   * activeEffects). Absent entries = no active boost. Sweep on tick preamble.
   */
  activeBoosts: Map<ReefBoostKind, ReefBoostEntry>;
  /**
   * Phase 1 — spark tier of the currently-active drift boost (1..3); 0 when
   * no drift-boost is active. Mirrored into snapshot deltas so the HUD can
   * render the spark dot bar without subscribing to per-tick boost events.
   */
  currentDriftBoostSparks: 0 | 1 | 2 | 3;
  /** Phase 1 — drift state machine. */
  drift: ReefDriftState;
  /** Pending intent applied next tick — set from `applyInput` */
  intent: {
    dir: Vec2 | null;
    thrust: number;
    actionBits: number;
    seq: number;
    dt: number;
    consumedSeq: number;
  };
  /** Bot-controlled flag */
  isBot: boolean;
  /** Auto-forfeit (anti-cheat or DC timeout) */
  forfeited: boolean;

  // ─── Phase 2 — slipstream ───────────────────────────────────────────────
  /** avatarId of the body whose wake this body is currently sitting in (null = none). */
  slipstreamSourceAvatarId: string | null;
  /** Consecutive ticks the body has been in the SAME source's wake. Reset on switch. */
  slipstreamConsecutiveTicks: number;
  /** Grace ticks remaining after leaving the wake before clearing source. */
  slipstreamGraceTicksLeft: number;

  // ─── Phase 2 — boost ribbons ────────────────────────────────────────────
  /** Set of "${lap}:${ribbonId}" entries already credited this lap. Cleared on lap-up. */
  ribbonsCollectedThisLap: Set<string>;
  /** Last collection time per ribbonId for cross-lap cooldown. */
  ribbonLastCollectedAt: Map<string, number>;

  // ─── Phase 2 — apex zones ───────────────────────────────────────────────
  /** Set of "${lap}:${hairpinIndex}" entries already verdict'd this lap. Cleared on lap-up. */
  apexCheckedThisLap: Set<string>;

  // ─── Phase 2 — hazard patches ───────────────────────────────────────────
  /** Set of "${lap}:${hazardId}" entries already broadcast this lap. Cleared on lap-up. */
  hazardsHitThisLap: Set<string>;

  // ─── Phase 3 — avatar-stat-driven multipliers (computed once at startRoom) ─
  /**
   * Avatar-stat-driven per-body multipliers. Read-only after init.
   *
   * Always a per-body CLONE (never the global NEUTRAL_BODY_MULTIPLIERS
   * reference) so a debug helper / future refactor cannot poison the
   * neutral baseline (audit N4). Builder always returns a fresh object.
   */
  mults: BodyMultipliers;

  /**
   * Pre-computed drift spark thresholds (in ticks), derived once at
   * startRoom from `mults.driftChargeMult`. Stored as a readonly 3-tuple
   * so the hot loop (`tickDriftState`) reads three integers instead of
   * dividing.
   *
   *   strength (mult=1.4): [9, 19, 32]   (vs neutral [12, 27, 45])
   *   neutral  (mult=1.0): [12, 27, 45]
   *
   * Math: Math.round(threshold / mult). JS Math.round uses round-half-up
   * for positive numbers (per ECMA-262 §21.3.2.28), so 12/1.4 = 8.571 → 9,
   * 27/1.4 = 19.286 → 19, 45/1.4 = 32.143 → 32. Capped via Math.max(1,...)
   * so an extreme mult cannot collapse the threshold to 0.
   */
  driftSparkTicks: readonly [number, number, number];

  // ─── Phase 4 — ghost replay capture (per-body) ──────────────────────────
  /**
   * Captured frames for the CURRENT lap-in-progress. FIFO ring up to
   * MAX_GHOST_FRAMES_PER_LAP. Cleared in BOTH lap-up branches (success
   * AND sub-MIN_LAP discard) to guarantee monotonic `t` in saved replay
   * (C1 fix). Re-anchored with a synthetic `t=0` frame on lap-up (S6 fix).
   */
  currentLapFrames: GhostFrame[];
  /**
   * Snapshot of `currentLapFrames` taken at the moment the BEST lap closed.
   * null until the first finished lap. Embedded into `SimResultRow.reefRace
   * .ghostReplayFrames` at `computeResults()` time (C3 fix — never read
   * via a live accessor that could race sim teardown).
   */
  bestLapFrames: GhostFrame[] | null;
  /** Best lap ms seen so far this match. null until the first finished lap. */
  bestLapMsSoFar: number | null;

  // ─── Phase 4 — streak counter (per-body) ────────────────────────────────
  /**
   * Current run of consecutive clean checkpoint crosses. Resets to 0 on
   * any dirty cross (wide hairpin verdict). Mirrored into snapshot deltas
   * so the HUD chip updates without a separate event subscription.
   */
  currentStreak: number;
  /** High-water mark of `currentStreak` across the entire match. */
  bestStreakThisMatch: number;
  /**
   * Last apex verdict per `(lap, hairpinIndex)`. Key = `${lap}-${cpIdx}`
   * to avoid cross-lap collision (S1 fix). Cleared at lap-up boundary
   * for belt-and-suspenders safety.
   */
  lastApexVerdictByHairpin: Map<string, 'clean' | 'wide'>;
}

interface ReefPickupBox {
  spawnId: string;
  /** Cycled when the slot respawns so the client tracks a new pickup. */
  position: Vec2;
  kind: ReefPowerUpKind;
  active: boolean;
  collectedAt: number | null;
  respawnAt: number;
}

interface ReefRoomState {
  roomId: string;
  activityId: string;
  startedAt: number;
  hardEndsAt: number;
  softEndsAt: number;
  tick: number;
  bodies: Map<string, ReefBody>;
  checkpoints: ReefCheckpointAabb[];
  pickups: ReefPickupBox[];
  /** LCG seed for deterministic pickup respawn rolls. */
  rngState: number;
  flagCounter: ReefFlagCounter;
  skipTracker: ReefCheckpointSkipTracker;
  lastSnapshot: ReefSnapshot | null;
  intervalHandle: ReturnType<typeof setInterval> | null;
  ended: boolean;
  /** Finish order (avatarIds in placement 1..n order). DNF bodies appended at race end. */
  finishOrder: string[];
  /** Bot controllers (mirror Bumper's pattern). */
  botControllers: Map<string, BotController>;
  botSeqs: Map<string, number>;

  // ─── Phase 2 — static zones (built once at startRoom) ──────────────────
  /** Phase 2 — boost ribbons. */
  ribbons: ReefBoostRibbon[];
  /** Phase 2 — apex zones (inner clean disc + outer wide disc per hairpin). */
  apexZones: ReefApexZone[];
  /** Phase 2 — hazard patches. */
  hazards: ReefHazardPatch[];
  /**
   * Phase 2 — placement cache. Refreshed at the TOP of every tickRoom (step
   * 0a) by `computeLivePlacements`. Read by:
   *   - resolvePickups (placement-aware item re-roll)
   *   - buildBotRoomView (per-body placement projection)
   *   - broadcastDelta (placement field on EntityDelta)
   * Audit S7 fix.
   */
  lastPlacementMap: Map<string, number>;

  /**
   * Phase 3 — per-avatar (class, level) cache, populated once at startRoom.
   * Read by `getRacingProfiles()` for the HUD via `RoomMeta.reefRacingProfiles`.
   * Stamped here (not derived from `body.mults`) so we keep the original
   * level integer (mults flatten 26-50 into a single accelMult value).
   */
  avatarClassCache: Map<string, { class: RacingClass; level: number }>;
}

interface ReefSnapshot {
  tick: number;
  bodies: Array<{
    avatarId: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    rot: number;
    lap: number;
    nextCheckpoint: number;
    finishedAt: number | null;
    dnf: boolean;
    /** Phase 1 — current drift charge tier (0..3). HUD-driven. */
    driftSparks: 0 | 1 | 2 | 3;
    /**
     * Phase 2 — live race placement (1-indexed). null when the placement
     * cache hasn't been populated yet (very first tick of a fresh room).
     */
    placement: number | null;
    /**
     * Phase 4 — current run of consecutive clean checkpoint crosses.
     * Mirrored into snapshot deltas so the HUD streak chip updates
     * between checkpoint crossings without a separate event channel.
     */
    streak: number;
  }>;
  pickups: Array<{
    spawnId: string;
    kind: ReefPowerUpKind;
    x: number;
    y: number;
    active: boolean;
  }>;
}

// ─── Sim singleton ──────────────────────────────────────────────────────────

type SimBroadcastFn = (roomId: string, frame: ServerFrame) => void;

class ReefRaceSim {
  private rooms = new Map<string, ReefRoomState>();
  private broadcastFn: SimBroadcastFn = () => {
    /* no-op until WS hub registers */
  };
  private endedFn: ((roomId: string) => void) | null = null;
  private integrityForfeitFn:
    | ((roomId: string, avatarId: string) => void)
    | null = null;

  setBroadcastFn(fn: SimBroadcastFn): void {
    this.broadcastFn = fn;
  }

  setEndedFn(fn: (roomId: string) => void): void {
    this.endedFn = fn;
  }

  setIntegrityForfeitFn(fn: (roomId: string, avatarId: string) => void): void {
    this.integrityForfeitFn = fn;
  }

  /**
   * Initialise a sim for a freshly-LIVE room. Caller (room manager)
   * ensures the room is in LIVE state when calling.
   */
  startRoom(
    roomId: string,
    activityId: string,
    participantAvatarIds: string[],
    opts?: {
      seed?: number;
      isBot?: (avatarId: string) => boolean;
      bots?: BotController[];
      /**
       * Phase 1 (audit S10) — when set, the sim uses this wall-clock as
       * `state.startedAt` instead of `Date.now()`. The room manager owns
       * the COUNTDOWN→LIVE transition timestamp; the sim must match so
       * launch verdicts (computed against `room.startedAt`) line up with
       * the boost/stall expirations the sim itself enforces.
       */
      startedAt?: number;
      /**
       * Phase 1 (audit C4) — per-avatar launch verdict computed by the room
       * manager's `computeLaunchVerdicts(room)` BEFORE startRoom. The sim
       * seeds the corresponding `activeBoosts` entry on each body so the
       * very first applyIntentForTick respects the boost/stall.
       */
      launchBoosts?: Map<string, 'boost' | 'stall'>;
      /**
       * Phase 3 — per-avatar racing profile (level + archetype) for body
       * multiplier construction. Missing avatarIds default to neutral (1.0).
       * Bots default to neutral via `avatar-profile-loader.ts`. When the opt
       * is omitted entirely, every body gets neutral mults (bit-identical
       * to pre-Phase-3 behavior).
       */
      avatarProfiles?: Map<string, AvatarRacingProfile>;
    },
  ): ReefRoomState {
    if (this.rooms.has(roomId)) {
      // Idempotent — defensive against double-LIVE transitions.
      return this.rooms.get(roomId)!;
    }
    const seed = opts?.seed ?? this.deriveSeedFromRoomId(roomId);
    // Audit S10 — prefer the room manager's startedAt so launch-verdict
    // expirations stay aligned with the sim's tick clock.
    // See reef-race-spline-sim.ts / docs/reef-race-reward-int-crash-2026-07-11.md:
    // `startedAt` drives hardEndsAt (timeout) AND totalTimeMs (-> the `integer`
    // activity_results.score). Normalize to an integer epoch; a non-numeric
    // value would break the timeout and crash reward issuance. Log any coercion.
    const rawStartedAt = opts?.startedAt;
    const coercedStartedAt = Math.round(Number(rawStartedAt));
    // Accept only a finite, positive epoch; non-finite (NaN/±Infinity) or
    // <=0 falls back to now (Codex #3). Fractional/Date/string inputs are
    // normalized to an integer ms epoch.
    const startedAt =
      Number.isFinite(coercedStartedAt) && coercedStartedAt > 0
        ? coercedStartedAt
        : Date.now();
    if (rawStartedAt != null && startedAt !== rawStartedAt) {
      console.error(
        `[reef-race-sim] coerced startedAt for room ${roomId}: ` +
          `${typeof rawStartedAt} ${String(rawStartedAt)} -> ${startedAt}`,
      );
    }
    const checkpoints = buildReefCheckpoints();

    const botControllers = new Map<string, BotController>();
    if (opts?.bots) {
      for (const ctrl of opts.bots) {
        if (!participantAvatarIds.includes(ctrl.avatarId)) {
          console.warn(
            `[reef-race-sim] bot controller for ${ctrl.avatarId} is not a participant — skipping`,
          );
          continue;
        }
        botControllers.set(ctrl.avatarId, ctrl);
      }
    }

    // Phase 2 — static zone allocation. Built ONCE per room, immutable
    // afterwards. Client receives via RoomMeta.reefStaticZones in snapshot.init.
    const ribbons = buildReefBoostRibbons();
    const apexZones = buildReefApexZones(checkpoints);
    const hazards = buildReefHazardPatches();

    const state: ReefRoomState = {
      roomId,
      activityId,
      startedAt,
      softEndsAt: startedAt + REEF_SOFT_TIMEOUT_MS,
      hardEndsAt: startedAt + REEF_HARD_TIMEOUT_MS,
      tick: 0,
      bodies: new Map(),
      checkpoints,
      pickups: [],
      rngState: seed >>> 0 || 1,
      flagCounter: new ReefFlagCounter(),
      skipTracker: new ReefCheckpointSkipTracker(),
      lastSnapshot: null,
      intervalHandle: null,
      ended: false,
      finishOrder: [],
      botControllers,
      botSeqs: new Map(),
      // Phase 2 — static zones + placement cache.
      ribbons,
      apexZones,
      hazards,
      lastPlacementMap: new Map<string, number>(),
      // Phase 3 — per-avatar (class, level) cache for HUD profile broadcast.
      avatarClassCache: new Map<string, { class: RacingClass; level: number }>(),
    };

    // Stagger spawn positions on the start straight (just before
    // checkpoint 0). Outer rows further back so faster overtakes
    // emerge naturally.
    const startCp = checkpoints[0];
    // Place bodies behind the start line by `i * spacing` along -tangent.
    const SPACING = 70;
    const ROW_OFFSET = 90;
    participantAvatarIds.forEach((avatarId, i) => {
      const row = Math.floor(i / 2);
      const col = i % 2 === 0 ? -1 : 1;
      const back = row * SPACING + 30;
      const sideX = startCp.normal.x * col * ROW_OFFSET;
      const sideY = startCp.normal.y * col * ROW_OFFSET;
      const x = startCp.center.x - startCp.tangent.x * back + sideX;
      const y = startCp.center.y - startCp.tangent.y * back + sideY;
      // Face the direction of travel — Three.js Y-rotation convention
      // (atan2(x, y) so the kart's native +Z forward rotates to align
      // with the (tangent.x, tangent.y) direction in scene-space).
      const rot = Math.atan2(startCp.tangent.x, startCp.tangent.y);
      const activeBoosts = new Map<ReefBoostKind, ReefBoostEntry>();
      // Phase 1 (audit C4) — seed launch verdict on first tick, BEFORE the
      // sim starts ticking. expirations are anchored to `startedAt` so the
      // boost duration is measured from the green light, not the call site.
      const verdict = opts?.launchBoosts?.get(avatarId) ?? null;
      if (verdict === 'boost') {
        activeBoosts.set('launch-boost', {
          expiresAt: startedAt + LAUNCH_BOOST_DURATION_MS,
          mult: LAUNCH_BOOST_MULT,
        });
      } else if (verdict === 'stall') {
        // No mult — stall caps THRUST (not speedMod) inside applyIntentForTick.
        activeBoosts.set('launch-stall', {
          expiresAt: startedAt + LAUNCH_STALL_DURATION_MS,
        });
      }

      // Phase 3 — avatar-stat-driven multipliers + pre-computed drift spark
      // thresholds. Builder always returns a fresh object (audit N4 — never
      // a shared NEUTRAL_BODY_MULTIPLIERS reference).
      const profile = opts?.avatarProfiles?.get(avatarId) ?? null;
      const mults = buildBodyMultipliers(profile);
      const driftSparkTicks: readonly [number, number, number] = [
        Math.max(1, Math.round(DRIFT_SPARK_TICK_1 / mults.driftChargeMult)),
        Math.max(1, Math.round(DRIFT_SPARK_TICK_2 / mults.driftChargeMult)),
        Math.max(1, Math.round(DRIFT_SPARK_TICK_3 / mults.driftChargeMult)),
      ];
      // Cache the resolved (class, level) for HUD broadcast — bots are
      // forced to balanced/L1 (Phase 3 §6 — neutral by design).
      const cachedClass: RacingClass = profile?.isBot
        ? 'balanced'
        : racingClassFromArchetype(profile?.archetype);
      const cachedLevel =
        profile?.isBot
          ? 1
          : Number.isFinite(profile?.level)
            ? Math.max(1, Math.floor(profile?.level ?? 1))
            : 1;
      state.avatarClassCache.set(avatarId, {
        class: cachedClass,
        level: cachedLevel,
      });

      state.bodies.set(avatarId, {
        avatarId,
        x,
        y,
        vx: 0,
        vy: 0,
        rot,
        alive: true,
        finishedAt: null,
        dnf: false,
        respawnAt: null,
        lap: 0,
        nextCheckpoint: 1, // we want to cross 1, then 2, ..., then 0 to complete a lap
        lastCheckpointAt: startedAt,
        lapStartedAt: startedAt,
        totalTimeMs: 0,
        lapSplitsMs: [],
        insideCheckpoints: new Set<number>(),
        inventory: emptyReefInventory(),
        activeEffects: new Map(),
        activeBoosts,
        currentDriftBoostSparks: 0,
        drift: { charging: false, sparkLevel: 0, chargeStartTick: 0, lastDriftBit: false },
        intent: {
          dir: null,
          thrust: 0,
          actionBits: 0,
          seq: 0,
          dt: 0,
          consumedSeq: -1,
        },
        isBot: opts?.isBot?.(avatarId) ?? botControllers.has(avatarId),
        forfeited: false,
        // Phase 2 per-body initial state.
        slipstreamSourceAvatarId: null,
        slipstreamConsecutiveTicks: 0,
        slipstreamGraceTicksLeft: 0,
        ribbonsCollectedThisLap: new Set<string>(),
        ribbonLastCollectedAt: new Map<string, number>(),
        apexCheckedThisLap: new Set<string>(),
        hazardsHitThisLap: new Set<string>(),
        // Phase 3 — stat-driven multipliers stamped once at room start.
        mults,
        driftSparkTicks,
        // Phase 4 — ghost capture + streak. Seed currentLapFrames with a
        // synthetic t=0 anchor (S6 fix) so the very first sample after
        // lapStartedAt isn't `t≈200ms` (one capture tick later).
        currentLapFrames: [{ t: 0, x, z: y, rot }],
        bestLapFrames: null,
        bestLapMsSoFar: null,
        currentStreak: 0,
        bestStreakThisMatch: 0,
        lastApexVerdictByHairpin: new Map<string, 'clean' | 'wide'>(),
      });
    });

    // Allocate fixed pickup-box positions around the centerline.
    for (let i = 0; i < REEF_POWERUP_BOX_COUNT; i++) {
      const t = (i + 0.5) / REEF_POWERUP_BOX_COUNT;
      const center = reefCenterlineAt(t);
      // Offset the box laterally by a small wobble to avoid centerline overlap.
      const lateralSign = i % 2 === 0 ? 1 : -1;
      const cp = checkpoints[Math.floor(t * REEF_CHECKPOINT_COUNT) % REEF_CHECKPOINT_COUNT];
      const offsetMag = 40;
      state.pickups.push({
        spawnId: `${roomId.slice(0, 8)}-pk-${i}`,
        position: {
          x: center.x + cp.normal.x * lateralSign * offsetMag,
          y: center.y + cp.normal.y * lateralSign * offsetMag,
        },
        kind: this.rollPowerUpKind(state),
        active: true,
        collectedAt: null,
        respawnAt: 0,
      });
    }

    this.rooms.set(roomId, state);

    // Bot lifecycle hooks — same pattern as Bumper.
    if (state.botControllers.size > 0) {
      const view = this.buildBotRoomView(state, '');
      for (const [avatarId, ctrl] of state.botControllers) {
        if (!ctrl.onSpawn) continue;
        try {
          ctrl.onSpawn({ ...view, selfAvatarId: avatarId });
        } catch (err) {
          console.error(`[reef-race-sim] bot onSpawn threw for ${avatarId}:`, err);
        }
      }
    }

    // Emit match_started + initial pickup spawn events.
    this.broadcastFn(roomId, { type: 'event.match_started', startedAt });
    // Phase 1 — broadcast per-avatar launch verdict so future per-player VFX
    // (boost flash, stall stutter) can hook in without re-deriving.
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
        position: pk.position,
      });
    }

    state.intervalHandle = setInterval(() => {
      try {
        this.tickRoom(state);
      } catch (err) {
        console.error('[reef-race-sim] tick exception:', err);
        state.ended = true;
        if (state.intervalHandle) clearInterval(state.intervalHandle);
        state.intervalHandle = null;
      }
    }, REEF_TICK_MS);

    return state;
  }

  /**
   * Halt + drop the sim for a room. Mirrors Bumper's stopRoom contract.
   */
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

  getStateSnapshot(roomId: string): ReefSnapshot | null {
    const state = this.rooms.get(roomId);
    if (!state) return null;
    return this.buildSnapshot(state);
  }

  /**
   * Apply a validated client input intent to a body. Returns a verdict
   * compatible with Bumper's `applyInput` for the WS hub dispatcher.
   */
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

    body.intent = {
      dir: safe.dir ? { x: safe.dir.x, y: safe.dir.y } : null,
      thrust: safe.thrust ?? 0,
      actionBits: safe.actionBits ?? 0,
      seq,
      dt: clampedDt,
      consumedSeq: body.intent.consumedSeq,
    };

    activityReplayLog.appendInputFrame(
      roomId,
      avatarId,
      seq,
      clampedDt,
      {
        dir: body.intent.dir ?? undefined,
        thrust: body.intent.thrust,
        actionBits: body.intent.actionBits,
      },
      state.startedAt,
    );

    return { ok: true, forfeit: false, flagsAdded: 0 };
  }

  /**
   * Forfeit a body — anti-cheat threshold OR DC timeout. Marks the body
   * DNF, emits the event, ends the round if no racers remain.
   */
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
      reason: reason === 'integrity' ? 'integrity' : reason === 'timeout' ? 'timeout' : 'voluntary',
    });
    // If no remaining alive racers, end the round.
    const stillRacing = Array.from(state.bodies.values()).some(
      (b) => b.alive && !b.dnf && b.finishedAt === null,
    );
    const finishedCount = Array.from(state.bodies.values()).filter(
      (b) => b.finishedAt !== null,
    ).length;
    if (!stillRacing && finishedCount === 0) {
      // Everyone DNF'd — end the round, no winners.
      this.endRound(state, 'all_forfeited');
    } else if (!stillRacing) {
      this.endRound(state, 'all_finished');
    }
  }

  /**
   * Result list for the room — placement-sorted. Called by the room
   * manager at LIVE→RESULTS to compute reward previews.
   *
   * Placements:
   *   1..n = finishers in finish order (lowest totalTimeMs first)
   *   n+1..end = DNFers, ordered by laps completed DESC then dnf
   *              wall-clock ascending (earlier-DNF places worse)
   *
   * Phase 4 (C3 fix) — for Reef Race rooms, embeds per-avatar best lap +
   * captured ghost frames + best-streak directly into the result row.
   * The reward pipeline reads from this embedded `reefRace` block, NEVER
   * via a live-state accessor — so sim teardown ordering doesn't race
   * the reward credit.
   */
  computeResults(
    roomId: string,
  ): Array<{
    avatarId: string;
    placement: number;
    score: number;
    scoreMs: number | null;
    reefRace?: ReefRaceSimResultRowExt;
  }> {
    const state = this.rooms.get(roomId);
    if (!state) return [];

    const finishers = Array.from(state.bodies.values())
      .filter((b) => b.finishedAt !== null && !b.dnf)
      .sort((a, b) => a.totalTimeMs - b.totalTimeMs);
    const dnfers = Array.from(state.bodies.values())
      .filter((b) => b.finishedAt === null || b.dnf)
      .sort((a, b) => {
        // Higher lap = better placement among DNFers.
        if (b.lap !== a.lap) return b.lap - a.lap;
        // Tiebreak by avatarId for stability.
        return a.avatarId.localeCompare(b.avatarId);
      });

    const isReefRace = state.activityId === 'reef-race';

    const out: Array<{
      avatarId: string;
      placement: number;
      score: number;
      scoreMs: number | null;
      reefRace?: ReefRaceSimResultRowExt;
    }> = [];
    let placement = 1;
    for (const f of finishers) {
      out.push({
        avatarId: f.avatarId,
        placement: placement++,
        // Score: -finishMs so higher-is-better sorts correctly with the
        // generic placement-by-score logic in the reward pipeline.
        score: -f.totalTimeMs,
        scoreMs: f.totalTimeMs,
        reefRace: isReefRace ? extractReefRaceBlock(f) : undefined,
      });
    }
    for (const d of dnfers) {
      out.push({
        avatarId: d.avatarId,
        placement: placement++,
        score: -REEF_HARD_TIMEOUT_MS - 1, // worse than any finish
        scoreMs: null,
        // DNFers may still have set a fast lap before forfeiting/timing
        // out — surface it. The reward pipeline only writes a PB if the
        // avatar has no anti-cheat flags AND bestLapMs is set.
        reefRace: isReefRace ? extractReefRaceBlock(d) : undefined,
      });
    }
    return out;
  }

  /**
   * Phase 4 — read-only flag-count accessor. Used by the reward pipeline
   * (anti-cheat skip-PB-on-flagged-match check, §4.4). Returns 0 when
   * the room or body is unknown.
   */
  getFlagCount(roomId: string, avatarId: string): number {
    const state = this.rooms.get(roomId);
    if (!state) return 0;
    return state.flagCounter.countFor(avatarId);
  }

  /** Test hook — wipe all in-memory state. */
  __resetForTest(): void {
    for (const state of this.rooms.values()) {
      if (state.intervalHandle) clearInterval(state.intervalHandle);
    }
    this.rooms.clear();
  }

  /** Deterministic single-tick driver — TEST ONLY. */
  __tickOnceForTest(roomId: string): void {
    const state = this.rooms.get(roomId);
    if (!state) return;
    this.tickRoom(state);
  }

  /** Read-only access for tests. */
  __getState(roomId: string): ReefRoomState | undefined {
    return this.rooms.get(roomId);
  }

  // ─── Internal — tick loop ──────────────────────────────────────────────

  private tickRoom(state: ReefRoomState): void {
    if (state.ended) return;

    state.tick += 1;
    const now = Date.now();
    const dt = 1 / REEF_SIM_HZ;

    // 0a. Phase 2 — refresh the placement cache once per tick. Read by:
    //     - resolvePickups (placement-aware item re-roll)
    //     - buildBotRoomView (per-body placement projection)
    //     - broadcastDelta (placement field on EntityDelta)
    //   Audit S7 fix.
    state.lastPlacementMap = this.computeLivePlacements(state);

    // 0. Bot intent scheduling — runs BEFORE integration.
    if (state.botControllers.size > 0) {
      this.runBotControllers(state, dt, now);
    }

    // 1. Apply intents → integrate velocity.
    //    Bodies inside off-track respawn freeze: skip intent + integration so
    //    they sit still on the centerline until respawnAt expires (Mario Kart
    //    "you fell, wait" penalty).
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;
      if (body.respawnAt !== null) {
        if (now < body.respawnAt) {
          body.vx = 0;
          body.vy = 0;
          continue;
        }
        body.respawnAt = null;
      }
      this.applyIntentForTick(state, body, dt, now);
    }

    // 2. Velocity → position.
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;
      if (body.respawnAt !== null) continue;
      this.integrateMotion(state, body, dt);
    }

    // 2a. Off-track detection. Runs AFTER integration so we catch the tick a
    //     body crosses the threshold, not the tick after. Teleports to the
    //     last cleanly-crossed checkpoint (or start grid for lap 0, cp 1)
    //     and arms the respawn freeze.
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;
      if (body.respawnAt !== null) continue;
      this.checkOffTrackReset(state, body, now);
    }

    // 3. Tick active effects → expire them.
    for (const body of state.bodies.values()) {
      for (const [kind, expires] of body.activeEffects) {
        if (expires <= now) body.activeEffects.delete(kind);
      }
      // Phase 1+2 — sweep active boosts (drift / launch / Phase 2 effects).
      // When a drift-boost expires we must zero `currentDriftBoostSparks` so
      // the snapshot diff stops broadcasting the spark tier.
      for (const [kind, entry] of body.activeBoosts) {
        if (entry.expiresAt <= now) {
          body.activeBoosts.delete(kind);
          if (kind === 'drift-boost') body.currentDriftBoostSparks = 0;
        }
      }
    }

    // 3a. Phase 2 — slipstream detection. Runs AFTER position integration so
    //     wake distance uses true positions, AFTER the activeBoosts sweep so
    //     the OWN boost doesn't get swept the same tick it's set.
    this.resolveSlipstream(state, now);

    // 4. Body-body proximity (light push to prevent tunneling).
    this.resolveProximity(state);

    // 4a. Wall clamp safety pass — proximity push can shove a parked body
    //     past REEF_TRACK_HALF_WIDTH. Without this pass the position broadcast
    //     in step 6 alternates between (wall + push) and (wall) every snapshot
    //     interval, which the user sees as a kart "spamming back and forth in
    //     the fence" with no input. reflectVelocity=false so the safety pass
    //     does NOT bounce the kart back into the colliding bot — it just
    //     parks it at the wall and zeros outward speed.
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;
      if (body.respawnAt !== null) continue;
      this.enforceWallClamp(state, body, /*reflectVelocity*/ false);
    }

    // 5. Power-up pickup collision.
    this.resolvePickups(state, now);

    // 5a. Phase 2 — boost ribbons. AFTER pickups (those resolve at body radius
    //     too), BEFORE checkpoints (so lap-up cleanup CAN'T retroactively wipe
    //     an entry just collected on the same tick — see §2.11).
    this.resolveBoostRibbons(state, now);

    // 5b. Phase 2 — apex verdicts. Same window — between pickups and
    //     checkpoints. Pure positional check.
    this.resolveApex(state, now);

    // 5c. Phase 2 — hazard patches. Edge-triggered event broadcast,
    //     per-tick activeBoosts refresh.
    this.resolveHazards(state, now);

    // 6. Pickup respawn cycle.
    this.tickPickups(state, now);

    // 7. Checkpoint detection.
    this.resolveCheckpoints(state, now);

    // 8. Round-end conditions.
    if (this.shouldEndRound(state, now)) {
      // Fold the soft-timeout "DNF the laggers" pass before ending.
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

    // 8a. Phase 4 — capture per-body ghost frames at GHOST_CAPTURE_HZ.
    //     5 Hz × 8 bodies = 40 alloc/sec — within per-frame budget. The
    //     synthetic t=0 anchor frame is written at lap-up (see
    //     resolveCheckpoints — both success AND discard branches), so the
    //     very first sample on a fresh lap lands at the next capture tick
    //     not at t=0 (the anchor already covers that).
    const ghostStrideTicks = Math.max(
      1,
      Math.round(REEF_SIM_HZ / GHOST_CAPTURE_HZ),
    );
    if (state.tick % ghostStrideTicks === 0) {
      for (const body of state.bodies.values()) {
        if (!body.alive || body.dnf || body.finishedAt !== null) continue;
        if (body.currentLapFrames.length >= MAX_GHOST_FRAMES_PER_LAP) {
          // FIFO drop oldest — only happens on absurdly long laps (>50 sec).
          // The legitimate fastest lap never approaches the cap.
          body.currentLapFrames.shift();
        }
        body.currentLapFrames.push({
          t: now - body.lapStartedAt, // lap-relative ms
          x: body.x,
          z: body.y, // sim-Y → Three.js-Z
          rot: body.rot,
        });
      }
    }

    // 9. Snapshot broadcast cadence.
    if (state.tick % REEF_TICKS_PER_KEYFRAME === 0) {
      this.broadcastKeyframe(state);
    } else if (state.tick % REEF_TICKS_PER_SNAPSHOT === 0) {
      this.broadcastDelta(state);
    }
  }

  private applyIntentForTick(
    state: ReefRoomState,
    body: ReefBody,
    dt: number,
    now: number,
  ): void {
    // Phase 3 (audit C-IMPL-1) — capture velocity BEFORE any mutation so the
    // velocity-delta validator at the end of this method sees a real
    // before/after pair. The previous implementation captured both prev/curr
    // inside `integrateMotion` AFTER applyIntentForTick had already mutated
    // body.vx/body.vy in the prior tick-loop pass — making the comparison
    // vacuous (dv = 0, validator always ok). Capturing here is the cleanest
    // fix: single function ownership, no per-body cache, and the validator
    // call sits adjacent to the only acceleration mutation site.
    const prevVelocityBeforeIntent = { x: body.vx, y: body.vy };

    const intent = body.intent;
    // 1. Consume seq.
    if (intent.seq > intent.consumedSeq) {
      intent.consumedSeq = intent.seq;
    }
    // 2. Power-up actionBits 0b01 / 0b10 (existing).
    const actionBits = intent.actionBits;
    if (actionBits & 0b01) this.tryUsePowerUp(state, body, 0, now);
    if (actionBits & 0b10) this.tryUsePowerUp(state, body, 1, now);

    // 3. NOTE: activeEffects + activeBoosts expiry sweep runs in
    //    `tickRoom` step 3 — which is AFTER this function (step 1). A
    //    boost that expires mid-frame therefore stays active for the
    //    rest of THIS tick (~33ms at 30Hz) and is removed on the next.
    //    Behaviour: drift-boost lasts ~1233ms instead of 1200ms, stall
    //    ~1033ms, launch ~2033ms. Within the 33ms-tick tolerance and
    //    matches the pre-Phase-1 `activeEffects` sweep timing.

    // 4. Compute speedMod from activeEffects + activeBoosts (audit C2/S4/S5).
    //    Pickup-only flags (existing):
    const slicked      = body.activeEffects.has('rr-ink-slick');
    const powerBoosted = body.activeEffects.has('rr-turbo-bubble');
    //    Phase 1 kinematic flags:
    const stalled       = body.activeBoosts.has('launch-stall');

    // 5. effectiveThrust — stall caps thrust at 30% (audit M2 — measured
    //    from race start, not press time, so an early-press penalty cuts
    //    into the FIRST second of racing.)
    const rawThrust       = Math.max(0, Math.min(1, intent.thrust));
    const effectiveThrust = stalled
      ? Math.min(rawThrust, LAUNCH_STALL_THRUST_CAP)
      : rawThrust;

    let speedMod: number;
    if (stalled) {
      // Stall suppresses all speed mods AND caps thrust above. 0.5 mirrors
      // the ink-slick visual feel — half-cap so the lag is unmistakable.
      // Phase 2 audit G4 — apex-penalty / hazard-slow are SKIPPED inside the
      // stall short-circuit; stall is a single-source override, not a stack.
      speedMod = 0.5;
    } else {
      // ─── Phase 2 v2 — four-stage combination model ────────────────────
      //
      // 1. POSITIVE kinematic stack — ADDITIVE, capped at KINEMATIC_BOOST_CAP.
      //    Sources: launch (+0.30), drift (+0.12/0.24/0.38), slipstream
      //    (+0.20), ribbon (+0.30), apex-bonus (+0.05).
      const launchAdd = body.activeBoosts.has('launch-boost')
        ? LAUNCH_BOOST_MULT
        : 0;
      const driftAdd =
        body.activeBoosts.has('drift-boost') && body.currentDriftBoostSparks >= 1
          ? DRIFT_BOOST_MULTS[body.currentDriftBoostSparks - 1] ?? 0
          : 0;
      const slipstreamAdd = body.activeBoosts.get('slipstream-boost')?.mult ?? 0;
      const ribbonAdd     = body.activeBoosts.get('ribbon-boost')?.mult     ?? 0;
      const apexBonusAdd  = body.activeBoosts.get('apex-bonus')?.mult       ?? 0;

      const positiveStackRaw =
        launchAdd + driftAdd + slipstreamAdd + ribbonAdd + apexBonusAdd;
      const positiveStack = Math.min(positiveStackRaw, KINEMATIC_BOOST_CAP);

      // 2. PICKUP turbo competes for the POSITIVE slot only. Phase 1 invariant:
      //    turbo-bubble does NOT additively stack with drift; it replaces it
      //    (taking the larger). v2 extends this to the FULL positive stack:
      //    pickup vs (capped positive stack) is taken via MAX.
      const pickupAdd = powerBoosted ? REEF_BOOST_MULT - 1.0 : 0; // 0.40
      const effectivePositive = Math.max(positiveStack, pickupAdd);

      // 3. NEGATIVE kinematic stack — ADDITIVE, floored, ALWAYS APPLIED.
      //    Negatives DO NOT compete with positives via Math.max — they are
      //    summed independently and ALWAYS subtract. Audit C4/C5 fix:
      //    in v1 the Math.max(kineticMult, pickupMult) silently erased
      //    hazard-slow whenever any positive boost was active.
      const apexPenSub = body.activeBoosts.get('apex-penalty')?.mult ?? 0;
      const hazardSub  = body.activeBoosts.get('hazard-slow')?.mult  ?? 0;
      const negativeStackRaw = apexPenSub + hazardSub;
      const negativeStack = Math.max(negativeStackRaw, NEGATIVE_KINETIC_FLOOR);

      // 4. Combine + apply ink-slick override + absolute floor.
      //    Three clamps in the chain (in order):
      //      1. positiveStack ≤ KINEMATIC_BOOST_CAP    (cap on positives)
      //      2. negativeStack ≥ NEGATIVE_KINETIC_FLOOR (floor on negatives)
      //      3. speedMod      ≥ 0.5                    (absolute floor)
      //    Plus: ink-slick continues to OVERRIDE everything to 0.5.
      const kineticDelta = effectivePositive + negativeStack;
      speedMod = slicked ? 0.5 : Math.max(0.5, 1.0 + kineticDelta);
    }

    const baseTopSpeed = REEF_MAX_SPEED * speedMod;

    // 6. Update body.rot. Drift bias is applied to the desired heading, then
    //    the body rotates toward it at a bounded yaw rate. Snapping directly
    //    to atan2(intent) made network snapshots look like step-by-step turns.
    if (intent.dir && (intent.dir.x !== 0 || intent.dir.y !== 0)) {
      const baseRot = Math.atan2(intent.dir.x, intent.dir.y);
      let desiredRot = baseRot;
      if (body.drift.charging) {
        // Outward drift lean — always preserves at least 50% of the input
        // turn, so the kart still visibly heads the way the player steers.
        // Two prior bugs avoided here:
        //   (a) Constant 15° subtraction flipped the sign on gentle input
        //       (|dir.x| in [DRIFT_MIN_STEER..tan(15°)] ≈ [0.12..0.27]).
        //   (b) Hard clamp at |baseRot| made gentle inputs read as
        //       "kart freezes pointing straight ahead" — no visible lean,
        //       no apparent turn — so users reported "drift doesn't work".
        // Bias is at most 15°, AND at most half of |baseRot|. Result:
        // desiredRot keeps the same sign as baseRot and at least 50% of
        // its magnitude. Loosens the turn (sliding feel) without ever
        // freezing or reversing the heading.
        const turnSign = intent.dir.x > 0 ? -1 : 1;
        const biasMag = Math.min(DRIFT_ANGULAR_BIAS_RAD, Math.abs(baseRot) * 0.5);
        desiredRot = baseRot + turnSign * biasMag;
      }
      const turnRate = body.drift.charging
        ? REEF_DRIFT_TURN_RATE_RAD_PER_SEC
        : REEF_TURN_RATE_RAD_PER_SEC;
      const maxTurn = turnRate * dt;
      const delta = shortestAngleDelta(body.rot, desiredRot);
      body.rot = normalizeAngle(
        body.rot + Math.max(-maxTurn, Math.min(maxTurn, delta)),
      );
    }

    // 7. Tick the drift state machine AFTER step 6 — see §2.3 commentary
    //    in `.claude/plans/reef-race-phase1-detailed.md`. One tick of
    //    "lingering lean" on release avoids an abrupt visual snap-back.
    this.tickDriftState(state, body, now);

    // 8. targetVx/Vy from intent.dir * effectiveThrust * speedMod.
    //
    // Wall-slide fix: if the body is currently AT or NEAR the outer wall, the
    // outward component of intent (the part pointing AWAY from track centerline)
    // is zeroed before integration. Without this the player who steers into a
    // curve gets pinned to the wall — server keeps adding outward thrust each
    // tick, wall bumper deflects, but the kart can't slide along the wall.
    //
    // Threshold: 95% of HALF_WIDTH so a kart approaching the wall gets the
    // lateral assist before slamming. Below this distance the player's intent
    // is honored unchanged — they can still steer toward / away from the wall.
    let targetVx = 0;
    let targetVy = 0;
    if (intent.dir) {
      const mag = Math.hypot(intent.dir.x, intent.dir.y);
      if (mag > 0) {
        let nx = intent.dir.x / mag;
        let ny = intent.dir.y / mag;
        // Wall-slide projection: only strip the component pushing past the
        // OUTER guardrail. Do not project infield/center positions; mechanics
        // tests and close-contact recovery rely on ordinary acceleration there.
        const wallScale = ellipseScaleAt(body.x, body.y);
        if (wallScale > REEF_OUTER_WALL_PROJECT_SCALE) {
          const normal = outerEllipseNormalAt(body.x, body.y);
          if (normal.x !== 0 || normal.y !== 0) {
            // Outward component of intent direction.
            const intentOut = nx * normal.x + ny * normal.y;
            if (intentOut > 0) {
              // Strip the outward component — keep only the tangent slide.
              nx = nx - normal.x * intentOut;
              ny = ny - normal.y * intentOut;
              const slideMag = Math.hypot(nx, ny);
              if (slideMag > 0) {
                nx = nx / slideMag;
                ny = ny / slideMag;
              } else {
                // Pure outward intent (e.g. player facing wall head-on with no
                // forward thrust) — fall back to track tangent so kart still
                // makes progress along the racing line instead of stopping.
                const tangent = ellipseTangentAtPoint(body.x, body.y);
                nx = tangent.x;
                ny = tangent.y;
              }
            }
          }
        }
        targetVx = nx * effectiveThrust * baseTopSpeed;
        targetVy = ny * effectiveThrust * baseTopSpeed;
      }
    }

    // 9. Integrate acceleration toward target. Phase 3 — agility tightens
    //    the turn by GREATER acceleration during direction-change ticks
    //    (cosTheta < 0.97 ≈ angle > 14°). Audit S1: the turn bonus REPLACES
    //    accelMult via Math.max — does NOT compound — so the worst-case
    //    per-tick gain is max(1.25, 1.176) = 1.25× (not 1.47×). That keeps
    //    the worst-case position step under the 2.1 validator tolerance
    //    (see §5 of `.claude/plans/reef-race-phase3-detailed.md` for math).
    const dvx = targetVx - body.vx;
    const dvy = targetVy - body.vy;
    const dv = Math.hypot(dvx, dvy);
    let maxStep = REEF_MAX_ACCEL * dt * body.mults.accelMult;
    if (intent.dir && body.mults.turnRadiusMult < 1.0) {
      const speed = Math.hypot(body.vx, body.vy);
      if (speed > REEF_MAX_SPEED * 0.10) {
        // intent.dir is normalized at applyInput time (validateInputBounds);
        // dirMag fallback guards against a future regression where it isn't.
        const dirMag = Math.hypot(intent.dir.x, intent.dir.y) || 1;
        const cosTheta =
          (body.vx * intent.dir.x + body.vy * intent.dir.y) / (speed * dirMag);
        if (cosTheta < 0.97) {
          // S1 fix: REPLACE accelMult with the larger of (accelMult,
          // 1/turnRadiusMult), don't compound.
          const turnBonus = 1 / body.mults.turnRadiusMult;
          maxStep =
            REEF_MAX_ACCEL * dt * Math.max(body.mults.accelMult, turnBonus);
        }
      }
    }
    const scale = dv === 0 ? 0 : Math.min(1, maxStep / dv);
    body.vx += dvx * scale;
    body.vy += dvy * scale;

    // Phase 3 (audit C-IMPL-1) — REAL velocity-delta validator. Compares
    // velocity captured BEFORE any mutation in this method against velocity
    // AFTER the acceleration step. The legitimate per-tick delta is bounded
    // by REEF_MAX_ACCEL × dt × max(accelMult, 1/turnRadiusMult) ≈ 83 wu/s
    // (worst case at level-50 agility / strength); the validator allows
    // REEF_MAX_ACCEL × dt × REEF_KINEMATIC_TOLERANCE ≈ 140 wu/s — leaving
    // 56 wu/s of headroom to catch synthetic per-tick velocity tampering.
    // Secondary speed cap (REEF_MAX_SPEED × tolerance = 1050 wu/s) catches
    // sustained over-speed even if the per-tick delta stays under threshold.
    const velCheck = validateReefVelocityDelta(
      prevVelocityBeforeIntent,
      { x: body.vx, y: body.vy },
      dt,
      REEF_KINEMATIC_TOLERANCE,
    );
    if (!velCheck.ok) {
      body.vx = velCheck.value.x;
      body.vy = velCheck.value.y;
      // validateReefVelocityDelta returns flagKind ∈ {'overaccel','overspeed'}.
      // Narrow to the ActivityAntiCheatFlagPayload['kind'] union (which excludes
      // 'input_bounds'/'input_rate') so the route through this.flag() typechecks
      // — defensive default to 'overaccel' if a future validator extension
      // returns something unexpected.
      const kind: 'overaccel' | 'overspeed' =
        velCheck.flagKind === 'overspeed' ? 'overspeed' : 'overaccel';
      this.flag(state, body.avatarId, kind, velCheck.detail);
    }
  }

  /**
   * Phase 1 — drift state machine. Runs as step 7 of `applyIntentForTick`.
   * Pure-state-mutation; never broadcasts more than one event.drift_boost
   * per release (audit-proofed via `lastDriftBit` edge detection).
   *
   * Note: master's PR #62 added a separate `body.rot = atan2(intent.dir.x,
   * intent.dir.y)` block here ("Three.js Y-rotation convention"). Phase 1
   * subsumed that into step 6 of `applyIntentForTick` (line 814-826) so the
   * drift angular bias can be applied INSIDE the same atan2 assignment
   * (audit C1). Re-applying it here would clobber the drift lean — dropped.
   */
  private tickDriftState(state: ReefRoomState, body: ReefBody, now: number): void {
    const driftBit   = (body.intent.actionBits & ACTION_BIT_DRIFT) !== 0;
    const speed      = Math.hypot(body.vx, body.vy);
    const turning    = Math.abs(body.intent.dir?.x ?? 0) >= DRIFT_MIN_STEER;
    const fastEnough = speed >= DRIFT_MIN_SPEED_FOR_CHARGE;

    const justReleased = !driftBit && body.drift.lastDriftBit;

    if (body.drift.charging) {
      // Cancel paths: drift-bit released OR speed dropped below threshold
      // (only legitimate speed reducer in Phase 1 is rr-ink-slick — see
      // audit C6, collisions don't modify velocity).
      const shouldCancel = !driftBit || !fastEnough;

      if (shouldCancel) {
        if (justReleased && body.drift.sparkLevel >= 1) {
          // Fire drift boost — speedMod-only (audit S4: NO velocity impulse).
          const sparks = body.drift.sparkLevel;
          const mult   = DRIFT_BOOST_MULTS[sparks - 1];
          body.activeBoosts.set('drift-boost', {
            expiresAt: now + DRIFT_BOOST_DURATION_MS,
            mult,
          });
          body.currentDriftBoostSparks = sparks;
          this.broadcastFn(state.roomId, {
            type: 'event.drift_boost',
            avatarId: body.avatarId,
            sparks: sparks as 1 | 2 | 3,
          });
        }
        body.drift.charging        = false;
        body.drift.sparkLevel      = 0;
        body.drift.chargeStartTick = 0;
      } else {
        // Still charging — advance the spark level. Phase 3: thresholds
        // pre-divided by `mults.driftChargeMult` at startRoom and stamped on
        // `body.driftSparkTicks`. Strength (1.4×) → [9, 19, 32]; neutral
        // (1.0×) → [12, 27, 45] (bit-identical to pre-Phase-3).
        const elapsed = state.tick - body.drift.chargeStartTick;
        const [t1, t2, t3] = body.driftSparkTicks;
        body.drift.sparkLevel =
          elapsed >= t3 ? 3 : elapsed >= t2 ? 2 : elapsed >= t1 ? 1 : 0;
      }
    } else if (driftBit && turning && fastEnough) {
      // Start when all conditions become true, not only on the exact Shift
      // edge. Real players often hold Shift just before turning into a bend.
      body.drift.charging        = true;
      body.drift.sparkLevel      = 0;
      body.drift.chargeStartTick = state.tick;
    }

    body.drift.lastDriftBit = driftBit;
  }

  private runBotControllers(
    state: ReefRoomState,
    dt: number,
    now: number,
  ): void {
    if (state.botControllers.size === 0) return;
    const sharedView = this.buildBotRoomView(state, '');
    for (const [avatarId, ctrl] of state.botControllers) {
      const body = state.bodies.get(avatarId);
      if (
        !body ||
        !body.alive ||
        body.forfeited ||
        body.finishedAt !== null
      ) {
        continue;
      }
      sharedView.selfAvatarId = avatarId;
      sharedView.now = now;
      // `buildBotRoomView(state, '')` is shared for allocation reasons, but
      // nextCheckpoint is self-specific. Without stamping it here every bot
      // kept targeting checkpoint 1 forever, then circled/spun after contact
      // once its real checkpoint had advanced.
      sharedView.nextCheckpoint = body.nextCheckpoint;
      let intent;
      try {
        intent = ctrl.computeInput(sharedView, dt);
      } catch (err) {
        console.error(
          `[reef-race-sim] bot ${avatarId} computeInput threw:`,
          err,
        );
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
    state: ReefRoomState,
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
      inventory: Array<{
        kind: ReefPowerUpKind | null;
        charges: number;
        cooldownUntil: number;
      }>;
      // Phase 2 (audit C1) — per-body race-progress projection so the bot
      // can compute drafting / placement-fire heuristics without re-deriving
      // the same data on every tick.
      lap: number;
      nextCheckpoint: number;
      currentPlacement: number | null;
      finishedAt: number | null;
      dnf: boolean;
    }>;
    arenaRadius: number;
    now: number;
    matchStartedAt: number;
    /** Next-checkpoint index for self — let bots steer toward it. */
    nextCheckpoint?: number;
    /** Centerline points for the 12 checkpoints — bots use these for steering. */
    checkpoints?: ReefCheckpointAabb[];
    /**
     * Phase 2 (impl-audit S6, M4) — server-authoritative static zones so the
     * bot can ribbon-steer and hazard-avoid against ACTUAL geometry, not the
     * old `APEX_INSIDE_OFFSET * 0.73` approximation. Same shape as
     * `getStaticZones` / `RoomMeta.reefStaticZones`. Read-only references —
     * the bot must never mutate.
     */
    ribbons?: ReadonlyArray<{ id: string; a: Vec2; b: Vec2 }>;
    hazards?: ReadonlyArray<{ id: string; center: Vec2; radius: number }>;
  } {
    const placementMap = state.lastPlacementMap;
    const bodies = Array.from(state.bodies.values()).map((b) => ({
      avatarId: b.avatarId,
      x: b.x,
      y: b.y,
      vx: b.vx,
      vy: b.vy,
      rot: b.rot,
      alive: b.alive && !b.dnf && b.finishedAt === null,
      inventory: b.inventory.map((slot) => ({
        kind: slot.kind as ReefPowerUpKind | null,
        charges: slot.charges,
        cooldownUntil: slot.cooldownUntil,
      })),
      lap: b.lap,
      nextCheckpoint: b.nextCheckpoint,
      currentPlacement: placementMap.get(b.avatarId) ?? null,
      finishedAt: b.finishedAt,
      dnf: b.dnf,
    }));
    const self = state.bodies.get(selfAvatarId);
    return {
      selfAvatarId,
      bodies,
      // Track has no "arena radius" — give the bot the longest oval axis
      // for any boundary heuristics it wants to compute. The Reef bot
      // primarily steers via centerline + checkpoints.
      arenaRadius: Math.max(REEF_TRACK_A, REEF_TRACK_B) + 200,
      now: Date.now(),
      matchStartedAt: state.startedAt,
      nextCheckpoint: self?.nextCheckpoint ?? 1,
      checkpoints: state.checkpoints,
      // Phase 2 (impl-audit S6, M4) — read-only references. Bot must NOT
      // mutate. These let the bot opportunistically steer through ribbons
      // and dodge actual hazards rather than approximating from APEX offsets.
      ribbons: state.ribbons,
      hazards: state.hazards,
    };
  }

  private integrateMotion(
    state: ReefRoomState,
    body: ReefBody,
    dt: number,
  ): void {
    const prev = { x: body.x, y: body.y };

    // Audit C3 — both call-sites use the named REEF_KINEMATIC_TOLERANCE so
    // a future refactor of integrateMotion can't silently revert to the
    // shared.ts DEFAULT_CLAMP_TOLERANCE (1.15) and start clipping legit
    // boosts.
    //
    // Phase 3 (audit C-IMPL-1) — the velocity-delta validator that USED to
    // live here was a no-op: by the time integrateMotion ran,
    // applyIntentForTick had already mutated body.vx/vy in the prior
    // tick-loop pass, so prevV and currV were byte-equal and dv = 0. The
    // validator now lives at the END of applyIntentForTick where it has a
    // real before/after pair to compare. integrateMotion is left with the
    // position-delta validator only — the secondary cheat-detection backstop
    // for any post-integration drift.
    body.x += body.vx * dt;
    body.y += body.vy * dt;

    const posCheck = validateReefPositionDelta(
      prev,
      { x: body.x, y: body.y },
      dt,
      REEF_KINEMATIC_TOLERANCE,
    );
    if (!posCheck.ok) {
      body.x = posCheck.value.x;
      body.y = posCheck.value.y;
      this.flag(state, body.avatarId, 'overspeed', posCheck.detail);
    }

    body.vx *= REEF_DRAG;
    body.vy *= REEF_DRAG;

    // Phase 1 (audit S5) — boost-gated hard velocity cap. Backstop only;
    // never clamps non-boosted bodies. Max legit speed at 1.85× = 925 wu/s.
    //
    // Phase 2 — gate widens to include ALL positive kinematic effects so the
    // cap covers the new combined-boost ceiling produced by the §2.3 cap math.
    // The cap value stays at 1.85× because KINEMATIC_BOOST_CAP = 0.85 makes
    // 1.85× the new theoretical ceiling — no headroom needed beyond the
    // existing margin.
    const isPositiveBoostActive =
      body.activeBoosts.has('launch-boost') ||
      body.activeBoosts.has('drift-boost') ||
      body.activeBoosts.has('slipstream-boost') ||
      body.activeBoosts.has('ribbon-boost') ||
      body.activeBoosts.has('apex-bonus');
    if (isPositiveBoostActive) {
      const speed = Math.hypot(body.vx, body.vy);
      const hardCap = REEF_MAX_SPEED * 1.85;
      if (speed > hardCap) {
        body.vx = (body.vx / speed) * hardCap;
        body.vy = (body.vy / speed) * hardCap;
      }
    }

    // ─── Wall bumpers (primary clamp post-velocity) ──────────────────────
    // Catches outward overshoot from this tick's velocity step. A SECOND
    // pass runs at end-of-tick after resolveProximity to catch any push that
    // shoves a parked kart past the wall — without that pass the kart and
    // the bot proximity push fight every tick (visible "spamming back and
    // forth in the fence" with no input).
    this.enforceWallClamp(state, body, /*reflectVelocity*/ true);
  }

  /**
   * Soft-clamp `body` to the OUTER oval guardrail. The prior implementation
   * used nearest-checkpoint tangent distance, which over-corrected interior
   * positions and caused racers/bots to pinball or spin after contact.
   * Checkpoint order still prevents finish-line exploits; this clamp is only
   * the physical outer fence.
   */
  private enforceWallClamp(
    state: ReefRoomState,
    body: ReefBody,
    reflectVelocity: boolean,
  ): void {
    if (state.checkpoints.length === 0) return;
    const scale = ellipseScaleAt(body.x, body.y);
    if (scale <= REEF_OUTER_WALL_SCALE || scale <= 0) return;

    // Nudge slightly inside the rail after correction. Sitting exactly on the
    // mathematical boundary makes the next tick re-hit the clamp immediately,
    // which reads as "stuck on the fence" when the player is trying to recover.
    const WALL_RECOVERY_INSET_SCALE = 0.012;
    const clampScale =
      Math.max(0, REEF_OUTER_WALL_SCALE - WALL_RECOVERY_INSET_SCALE) / scale;
    body.x *= clampScale;
    body.y *= clampScale;

    const normal = outerEllipseNormalAt(body.x, body.y);
    const vN = body.vx * normal.x + body.vy * normal.y;
    if (reflectVelocity) {
      // Primary clamp: kill outward velocity but keep tangential speed. A
      // bounce felt bad in Reef Race because racers pinballed into the rail
      // and lost the ability to steer out; sliding preserves recovery control.
      if (vN > 0) {
        const WALL_TANGENT_FRICTION = 0.98;
        const vTx = body.vx - vN * normal.x;
        const vTy = body.vy - vN * normal.y;
        body.vx = vTx * WALL_TANGENT_FRICTION;
        body.vy = vTy * WALL_TANGENT_FRICTION;

        const intent = body.intent.dir;
        if (intent && body.intent.thrust > 0.15) {
          const tangent = ellipseTangentAtPoint(body.x, body.y);
          const intentAlongTangent = intent.x * tangent.x + intent.y * tangent.y;
          if (Math.abs(intentAlongTangent) > 0.2) {
            const sign = intentAlongTangent < 0 ? -1 : 1;
            const slideX = tangent.x * sign;
            const slideY = tangent.y * sign;
            const currentSlide = body.vx * slideX + body.vy * slideY;
            const minSlideSpeed = REEF_MAX_SPEED * 0.25;
            if (currentSlide < minSlideSpeed) {
              const add = minSlideSpeed - Math.max(0, currentSlide);
              body.vx += slideX * add;
              body.vy += slideY * add;
            }
          }
        }
      }
    } else {
      // Safety pass after proximity: just kill outward velocity. No bounce —
      // a parked kart shoved by a bot must NOT recoil into the bot pile.
      if (vN > 0) {
        body.vx -= vN * normal.x;
        body.vy -= vN * normal.y;
      }
    }
  }

  /**
   * Off-track reset (Mario Kart style). If a body leaves the outer oval by
   * more than OFF_TRACK_PERP_DISTANCE,
   * teleport it to the last successfully-crossed checkpoint and freeze for
   * OFF_TRACK_RESPAWN_MS. The freeze ITSELF is the time penalty.
   *
   * "Last successful checkpoint" = `(body.nextCheckpoint - 1 + N) % N`.
   * For the very first lap before crossing CP1, that's CP0 (start/finish line)
   * which sits at the start grid — correct fallback.
   *
   * Velocity zero'd on teleport so the body doesn't carry over the off-track
   * speed back into the racing line.
   */
  private checkOffTrackReset(
    state: ReefRoomState,
    body: ReefBody,
    now: number,
  ): void {
    if (ellipseScaleAt(body.x, body.y) <= REEF_OFF_TRACK_RESET_SCALE) return;

    // Teleport to the last cleanly-crossed checkpoint center.
    const N = state.checkpoints.length;
    const lastCleanIdx = (body.nextCheckpoint - 1 + N) % N;
    const target = state.checkpoints[lastCleanIdx];
    body.x = target.center.x;
    body.y = target.center.y;
    body.vx = 0;
    body.vy = 0;
    body.rot = Math.atan2(target.tangent.x, target.tangent.y);
    body.respawnAt = now + OFF_TRACK_RESPAWN_MS;
  }

  private resolveProximity(state: ReefRoomState): void {
    const bodies = Array.from(state.bodies.values()).filter(
      (b) => b.alive && !b.dnf && b.finishedAt === null,
    );
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        // Softer than the visual radius: hard 2x-radius separation made bots
        // and players shove each other into rails, then the wall clamp fought
        // that push every tick. This keeps contact readable without pinning.
        const minDist = REEF_BODY_RADIUS * 1.6;
        if (dist === 0 || dist >= minDist) continue;
        // Light separation push only — no knockback in a race.
        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        const push = overlap * 0.42;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;

        // Remove only closing velocity along the contact normal. Without this
        // the next tick immediately recreates the overlap and racers look stuck.
        const relVx = b.vx - a.vx;
        const relVy = b.vy - a.vy;
        const closing = relVx * nx + relVy * ny;
        if (closing < 0) {
          const remove = closing * 0.35;
          a.vx += nx * remove;
          a.vy += ny * remove;
          b.vx -= nx * remove;
          b.vy -= ny * remove;
        }
      }
    }
  }

  private resolvePickups(state: ReefRoomState, now: number): void {
    for (const pk of state.pickups) {
      if (!pk.active) continue;
      for (const body of state.bodies.values()) {
        if (!body.alive || body.dnf || body.finishedAt !== null) continue;
        const dx = body.x - pk.position.x;
        const dy = body.y - pk.position.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= REEF_BODY_RADIUS + REEF_POWERUP_RADIUS) {
          const slot = body.inventory.findIndex((s) => s.kind === null);
          if (slot >= 0) {
            // Phase 2 — placement-aware re-roll at COLLECT time. The SPAWN
            // roll (in tickPickups) keeps the world mesh stable; the COLLECT
            // roll uses the collector's live placement to deliver Mario-Kart-
            // style rubber-band items. Falls through to spawn-time kind if
            // placement is unknown (very first tick of a fresh room).
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
            // Phase 2 — broadcast the FINAL kind (the placement-rolled kind)
            // so the HUD authoritatively swaps the inventory slot. Audit C2
            // fix: makes the wire event the source of truth for inventory.
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

  private tickPickups(state: ReefRoomState, now: number): void {
    for (const pk of state.pickups) {
      if (!pk.active && now >= pk.respawnAt) {
        pk.kind = this.rollPowerUpKind(state);
        pk.spawnId = `${state.roomId.slice(0, 8)}-pk-${state.tick}-${this.lcgNext(state).toString(36)}`;
        pk.active = true;
        pk.collectedAt = null;
        pk.respawnAt = 0;
        this.broadcastFn(state.roomId, {
          type: 'event.power_up_spawned',
          spawnId: pk.spawnId,
          kind: pk.kind,
          position: pk.position,
        });
      }
    }
  }

  private resolveCheckpoints(state: ReefRoomState, now: number): void {
    for (const body of state.bodies.values()) {
      if (!body.alive || body.dnf || body.finishedAt !== null) continue;

      // Compute the set of checkpoints the body is inside THIS tick.
      // Cheap (12 AABB tests × 8 bodies = 96/tick at 30Hz). We only
      // count crossings on TRANSITIONS (entered this tick, not last) so
      // a body parked inside a wrong checkpoint doesn't spam silent
      // rejects → trip the skip-pattern flag → integrity-forfeit.
      const insideThisTick = new Set<number>();
      for (let i = 0; i < state.checkpoints.length; i++) {
        if (isInsideCheckpoint(body, state.checkpoints[i])) {
          insideThisTick.add(i);
        }
      }

      // Iterate ENTRIES (in `insideThisTick` but not in `body.insideCheckpoints`)
      // and resolve them. Order matters — a body that teleported into
      // multiple AABBs in one tick should resolve ascending so the
      // expected next-checkpoint fires first if it's in the set.
      const newlyEntered: number[] = [];
      for (const i of insideThisTick) {
        if (!body.insideCheckpoints.has(i)) newlyEntered.push(i);
      }
      newlyEntered.sort((a, b) => a - b);

      for (const i of newlyEntered) {
        const verdict = validateCheckpointSequence(i, body.nextCheckpoint);
        if (!verdict.ok) {
          if (verdict.flagged) {
            this.flag(state, body.avatarId, 'checkpoint_skip', verdict.detail);
          } else {
            const tripped = state.skipTracker.recordSkip(body.avatarId, now);
            if (tripped) {
              this.flag(state, body.avatarId, 'checkpoint_skip', verdict.detail);
            }
          }
          continue;
        }

        // Legit crossing — advance the pointer. Special case: when the
        // pointer wraps from 11 → 0 we have a complete lap.
        const wasCheckpoint = body.nextCheckpoint;
        const justCompletedLap = wasCheckpoint === 0;
        body.lastCheckpointAt = now;
        body.nextCheckpoint = (wasCheckpoint + 1) % REEF_CHECKPOINT_COUNT;

        // Phase 4 — streak update. Runs BEFORE lap-up branching so a
        // hairpin cleared on lap N still credits the streak before the
        // verdict map gets cleared at lap-up boundary (S1 fix).
        this.applyStreakUpdate(state, body, wasCheckpoint);

        if (justCompletedLap) {
          // Crossed the start/finish line as the expected next-checkpoint
          // → that means the previous checkpoint we crossed was 11 and we
          // just expected 0. So the lap that started at `lapStartedAt`
          // ends now.
          const lapMs = now - body.lapStartedAt;
          const lapVerdict = validateLapTime(lapMs);
          if (!lapVerdict.ok) {
            // Discard the lap + flag. Body's lap counter does NOT advance
            // and we DO NOT advance the checkpoint pointer past 1 — the
            // avatar must legitimately re-traverse from 1..11..0 again.
            this.flag(state, body.avatarId, 'underminlap', lapVerdict.detail);
            // Reset lap tracker so the next loop attempt times from now.
            body.lapStartedAt = now;
            // Roll the next-checkpoint pointer back to 1 since we
            // discarded the lap (we still consider checkpoint 0 a valid
            // start-line crossing for kinematic purposes).
            body.nextCheckpoint = 1;
            // Phase 4 (C1 fix) — clear ghost frame buffer in the DISCARD
            // branch too. Without this, stale frames from this aborted
            // attempt mix with the next attempt's frames at t≈14000ms,
            // breaking findGhostFrames' linear scan with non-monotonic t.
            body.currentLapFrames.length = 0;
            // Re-anchor with synthetic t=0 frame (S6 fix).
            body.currentLapFrames.push({
              t: 0,
              x: body.x,
              z: body.y,
              rot: body.rot,
            });
            // Phase 4 (S1 fix) — clear apex verdict map at lap boundary
            // even on discard so a stale `${lap}-${cp}` entry can never
            // leak into the next attempt.
            body.lastApexVerdictByHairpin.clear();
            break;
          }

          body.lap += 1;
          body.lapSplitsMs.push(lapMs);
          body.lapStartedAt = now;

          // Phase 4 — if this lap is the best so far, snapshot the captured
          // frames BEFORE clearing currentLapFrames. The snapshot is a
          // shallow clone (slice()) — currentLapFrames mutates in place
          // next, the snapshot must persist into bestLapFrames.
          const isBestLapSoFar =
            body.bestLapMsSoFar === null || lapMs < body.bestLapMsSoFar;
          if (isBestLapSoFar) {
            body.bestLapMsSoFar = lapMs;
            body.bestLapFrames = body.currentLapFrames.slice();
          }
          // Phase 4 (C1 fix) — clear ghost frame buffer in the SUCCESS
          // branch. Re-anchor with a synthetic t=0 frame (S6 fix) so the
          // first captured frame on the new lap doesn't land at t≈200ms.
          body.currentLapFrames.length = 0;
          body.currentLapFrames.push({
            t: 0,
            x: body.x,
            z: body.y,
            rot: body.rot,
          });

          // Phase 2 — clear per-lap dedupe sets after the lap counter
          // increments. The Phase 2 resolvers (ribbons / apex / hazards) ran
          // in step 5a-5c using the PRE-INCREMENT lap as the dedupe key, so
          // anything just collected on the lap-up tick is preserved in
          // activeBoosts even though the dedupe entry is cleared here.
          body.ribbonsCollectedThisLap.clear();
          body.apexCheckedThisLap.clear();
          body.hazardsHitThisLap.clear();
          // Phase 4 (S1 fix) — clear apex verdict map at lap boundary so
          // the next lap's hairpin reads a fresh verdict, not a stale
          // entry keyed by the previous lap.
          body.lastApexVerdictByHairpin.clear();

          this.broadcastFn(state.roomId, {
            type: 'event.lap_completed',
            avatarId: body.avatarId,
            lap: body.lap,
            splitMs: lapMs,
            totalMs: now - state.startedAt,
          });
          if (body.lap >= REEF_LAPS) {
            body.finishedAt = now;
            // Round defensively — score/score_ms are `integer` columns.
            body.totalTimeMs = Math.round(now - state.startedAt);
            state.finishOrder.push(body.avatarId);
            // Freeze the body — no more input applies.
            body.vx = 0;
            body.vy = 0;
          }
        }
        break; // one legit-crossing per tick per body
      }

      // Cache the inside-set for next tick's transition diff. Done AFTER
      // the loop so we don't double-count entries during this same tick.
      body.insideCheckpoints = insideThisTick;
    }
  }

  private tryUsePowerUp(
    state: ReefRoomState,
    body: ReefBody,
    slotIndex: number,
    now: number,
  ): void {
    const verdict = validateReefPowerUpUse(slotIndex, body.inventory, now);
    if (verdict.flagged) {
      this.flag(state, body.avatarId, 'powerup_unowned', verdict.detail);
      return;
    }
    if (!verdict.ok || !verdict.value) return;
    const slot = verdict.value;
    const kind = slot.kind as ReefPowerUpKind;
    const def = getReefPowerUpDef(kind);

    switch (kind) {
      case 'rr-turbo-bubble':
      case 'rr-bubble-shield':
      case 'rr-ink-slick':
      case 'rr-whirlpool':
        // Phase 3 — intelligence pickups last 20% longer (effectMs scaled).
        // Neutral mult=1.0 → identical to legacy. The REEF_BOOST_MULT speed
        // multiplier on turbo-bubble is unchanged; only DURATION extends.
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

  private applyTideWave(state: ReefRoomState, src: ReefBody): void {
    // Push all opponents within radius backward along their velocity vector.
    const radius = 250;
    for (const target of state.bodies.values()) {
      if (target.avatarId === src.avatarId) continue;
      if (target.dnf || target.finishedAt !== null) continue;
      if (target.activeEffects.has('rr-bubble-shield')) continue;
      const dx = target.x - src.x;
      const dy = target.y - src.y;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const speed = Math.hypot(target.vx, target.vy);
      if (speed > 0) {
        // Phase 3 — strength takes 60% of normal knockback (40% reduction).
        // Neutral mult=1.0 keeps the legacy 0.4 × distFalloff behavior.
        const factor =
          0.4 * (1 - dist / radius) * target.mults.knockbackResistMult;
        target.vx *= 1 - factor;
        target.vy *= 1 - factor;
      }
      this.broadcastFn(state.roomId, {
        type: 'event.hit',
        srcAvatarId: src.avatarId,
        dstAvatarId: target.avatarId,
        position: { x: target.x, y: target.y },
        power: 1 - dist / radius,
      });
    }
  }

  private applySeekerJelly(state: ReefRoomState, src: ReefBody): void {
    // Find nearest opponent ahead (positive dot with src velocity).
    let best: ReefBody | null = null;
    let bestDist = Infinity;
    const sv = Math.hypot(src.vx, src.vy);
    for (const t of state.bodies.values()) {
      if (t.avatarId === src.avatarId) continue;
      if (t.dnf || t.finishedAt !== null) continue;
      if (t.activeEffects.has('rr-bubble-shield')) continue;
      const dx = t.x - src.x;
      const dy = t.y - src.y;
      if (sv > 0) {
        const dot = (dx * src.vx + dy * src.vy) / sv;
        if (dot < 0) continue; // behind
      }
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    if (!best) return;
    // Knock the target slightly off line.
    const dx = best.x - src.x;
    const dy = best.y - src.y;
    const mag = Math.max(Math.hypot(dx, dy), 1);
    const nx = dx / mag;
    const ny = dy / mag;
    // Phase 3 — strength target takes 60% of the 300 wu/s impulse (180 wu/s).
    // Neutral mult=1.0 → unchanged 300 wu/s. (audit S3 explicit patch)
    const impulse = REEF_MAX_SPEED * 0.6 * best.mults.knockbackResistMult;
    best.vx += nx * impulse;
    best.vy += ny * impulse;
    this.broadcastFn(state.roomId, {
      type: 'event.hit',
      srcAvatarId: src.avatarId,
      dstAvatarId: best.avatarId,
      position: { x: best.x, y: best.y },
      power: 1,
    });
  }

  private shouldEndRound(state: ReefRoomState, now: number): boolean {
    // All bodies finished or DNF'd?
    let racing = 0;
    let finishedOrDnf = 0;
    for (const b of state.bodies.values()) {
      if (b.finishedAt !== null || b.dnf) finishedOrDnf++;
      else racing++;
    }
    if (racing === 0 && state.bodies.size > 0) return true;
    // Hard timeout reached?
    if (now >= state.hardEndsAt) return true;
    // Soft timeout AND at least one finisher → don't wait the full grace
    // for laggers if there are no still-racing-on-pace bodies.
    if (now >= state.softEndsAt && finishedOrDnf > 0 && racing === 0) {
      return true;
    }
    return false;
  }

  private applyTimeouts(state: ReefRoomState, now: number): void {
    for (const body of state.bodies.values()) {
      if (body.finishedAt !== null || body.dnf) continue;
      if (now >= state.hardEndsAt || now >= state.softEndsAt) {
        body.dnf = true;
        body.alive = false;
      }
    }
  }

  private endRound(
    state: ReefRoomState,
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

    // Phase 4 (S-IMPL-1 fix 2026-04-25) — Reef Race rooms ALWAYS go through
    // `reward-pipeline.ts → emitPerRecipientMatchEnd` which broadcasts the
    // authoritative `event.match_ended` (with real tokens / pbDelta /
    // streakBest / perfectLapBonus) per recipient. Emitting this preview
    // frame first would fire the client modal with `tokens: 0` for ~50–
    // 500ms before the authoritative numbers replace it (UX flash).
    // Skip the preview here; the pipeline owns the broadcast.
    //
    // For activities WITHOUT a per-recipient pipeline emit (none today
    // beside reef-race, but future activities could opt in similarly),
    // the preview broadcast still runs so the client gets at least one
    // match-end frame.
    if (state.activityId !== 'reef-race') {
      const previewPlacement = winners[0]?.placement ?? 0;
      this.broadcastFn(state.roomId, {
        type: 'event.match_ended',
        reason: 'complete',
        winners,
        rewardPreview: {
          placement: previewPlacement,
          // Authoritative crediting lives in chunk #7's reward pipeline.
          tokens: 0,
          leaderboardPoints: 0,
        },
      });
    }

    if (this.endedFn) {
      try {
        this.endedFn(state.roomId);
      } catch (err) {
        console.error('[reef-race-sim] endedFn callback threw:', err);
      }
    }
  }

  // ─── Snapshot encoding ─────────────────────────────────────────────────

  private buildSnapshot(state: ReefRoomState): ReefSnapshot {
    return {
      tick: state.tick,
      bodies: Array.from(state.bodies.values()).map((b) => ({
        avatarId: b.avatarId,
        x: this.quant(b.x, POS_QUANT),
        y: this.quant(b.y, POS_QUANT),
        vx: this.quant(b.vx, POS_QUANT),
        vy: this.quant(b.vy, POS_QUANT),
        rot: this.quant(b.rot, ROT_QUANT),
        lap: b.lap,
        nextCheckpoint: b.nextCheckpoint,
        finishedAt: b.finishedAt,
        dnf: b.dnf,
        driftSparks: b.drift.sparkLevel,
        // Phase 2 — live placement piped through the snapshot delta so the
        // HUD's placement tile updates between checkpoint crossings.
        placement: state.lastPlacementMap.get(b.avatarId) ?? null,
        // Phase 4 — current streak count for the HUD chip.
        streak: b.currentStreak,
      })),
      pickups: state.pickups.map((pk) => ({
        spawnId: pk.spawnId,
        kind: pk.kind,
        x: this.quant(pk.position.x, POS_QUANT),
        y: this.quant(pk.position.y, POS_QUANT),
        active: pk.active,
      })),
    };
  }

  private quant(value: number, factor: number): number {
    return Math.round(value * factor) / factor;
  }

  private broadcastKeyframe(state: ReefRoomState): void {
    const snap = this.buildSnapshot(state);
    state.lastSnapshot = snap;
    this.broadcastFn(state.roomId, {
      type: 'snapshot.keyframe',
      seq: snap.tick,
      world: {
        tick: snap.tick,
        entities: snap.bodies.map((b) => ({
          avatarId: b.avatarId,
          position: { x: b.x, y: b.y },
          velocity: { x: b.vx, y: b.vy },
          rotation: b.rot,
          state: b.dnf
            ? 'dnf'
            : b.finishedAt !== null
              ? 'finished'
              : 'racing',
        })),
        powerUps: snap.pickups
          .filter((p) => p.active)
          .map((p) => ({
            spawnId: p.spawnId,
            kind: p.kind,
            position: { x: p.x, y: p.y },
          })),
        scores: snap.bodies.map((b) => ({
          avatarId: b.avatarId,
          score: b.lap,
        })),
      },
    });
  }

  private broadcastDelta(state: ReefRoomState): void {
    const snap = this.buildSnapshot(state);
    const prev = state.lastSnapshot;
    const entities = snap.bodies
      .filter((b) => {
        if (!prev) return true;
        const p = prev.bodies.find((q) => q.avatarId === b.avatarId);
        if (!p) return true;
        return (
          p.x !== b.x ||
          p.y !== b.y ||
          p.vx !== b.vx ||
          p.vy !== b.vy ||
          p.rot !== b.rot ||
          p.lap !== b.lap ||
          p.nextCheckpoint !== b.nextCheckpoint ||
          p.finishedAt !== b.finishedAt ||
          p.dnf !== b.dnf ||
          // Phase 1 (audit S1+S7) — spark-only changes MUST broadcast so the
          // HUD can update its dot bar between positional ticks.
          p.driftSparks !== b.driftSparks ||
          // Phase 2 — placement-only changes MUST broadcast so the HUD's
          // placement tile updates between checkpoint crossings (positional
          // fields may not change on the same tick the placement does).
          p.placement !== b.placement ||
          // Phase 4 — streak-only changes MUST broadcast so the HUD chip
          // resets visibly on a dirty cross even when position barely
          // moved between ticks.
          p.streak !== b.streak
        );
      })
      .map((b) => ({
        avatarId: b.avatarId,
        seq: snap.tick,
        changed: {
          x: b.x,
          y: b.y,
          vx: b.vx,
          vy: b.vy,
          rot: b.rot,
          lap: b.lap,
          nextCheckpoint: b.nextCheckpoint,
          state: b.dnf
            ? 'dnf'
            : b.finishedAt !== null
              ? 'finished'
              : 'racing',
          // Phase 1 — surface drift charge tier per body. Old clients hit
          // EntityDelta.changed's `[k: string]: unknown` catch-all → no-op.
          driftSparks: b.driftSparks,
          // Phase 2 — surface live placement so the HUD's placement tile
          // updates between checkpoint crossings.
          placement: b.placement,
          // Phase 4 — surface live streak so the HUD chip stays in sync
          // between checkpoint crossings.
          streak: b.streak,
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
        position: { x: p.x, y: p.y },
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

  // ─── Phase 4 — streak counter ──────────────────────────────────────────

  /**
   * Update `body.currentStreak` + `bestStreakThisMatch` on a legitimate
   * checkpoint cross. Hairpin checkpoints (cps 3 + 9) require the most-
   * recent apex verdict for THIS lap (S1 fix — keyed by `${lap}-${cpIdx}`)
   * to be `'clean'`; non-hairpin crosses are auto-clean. Edge-broadcasts
   * `event.streak_milestone` on milestone hits (5/10/16/20/24).
   *
   * Reset to 0 on dirty cross. The HUD chip subscribes to the per-tick
   * `streak` field on EntityDelta — the milestone event is glow-only.
   */
  private applyStreakUpdate(
    state: ReefRoomState,
    body: ReefBody,
    cpIdx: number,
  ): void {
    const isHairpin =
      cpIdx === APEX_HAIRPIN_CHECKPOINT_INDICES[0] ||
      cpIdx === APEX_HAIRPIN_CHECKPOINT_INDICES[1];
    let clean: boolean;
    if (!isHairpin) {
      clean = true;
    } else {
      // S1 FIX — verdict map is keyed by (lap, cpIdx). A hairpin cross
      // with no apex verdict for this lap counts as dirty (the body
      // crossed the cp without ever entering the inner OR outer apex
      // disc — likely cut a corner outside both rings).
      const key = `${body.lap}-${cpIdx}`;
      clean = body.lastApexVerdictByHairpin.get(key) === 'clean';
    }
    if (clean) {
      body.currentStreak += 1;
      if (body.currentStreak > body.bestStreakThisMatch) {
        body.bestStreakThisMatch = body.currentStreak;
      }
      // Edge-trigger: only broadcast on milestone hits to avoid 24×8
      // event spam per match. Per-tick streak count rides EntityDelta.
      if ((STREAK_MILESTONES as readonly number[]).includes(body.currentStreak)) {
        this.broadcastFn(state.roomId, {
          type: 'event.streak_milestone',
          avatarId: body.avatarId,
          streak: body.currentStreak,
          kind: streakMilestoneKind(body.currentStreak),
        });
      }
    } else {
      body.currentStreak = 0;
    }
  }

  // ─── Anti-cheat hook ───────────────────────────────────────────────────

  private flag(
    state: ReefRoomState,
    avatarId: string,
    kind: ActivityAntiCheatFlagPayload['kind'],
    detail?: string,
  ): void {
    // Physics-displacement kinds are server-clamped already (validator clamps
    // velocity to safe values before tagging). Auto-forfeit on these is
    // redundant AND harmful — honest players who get flung off-track by a
    // bumper bug start crossing checkpoints out of order, accumulate skips,
    // and silently DQ. We still LOG these so prod stays auditable, but they
    // don't count toward the 5-flag forfeit ceiling. Reserve forfeit for
    // genuinely-malicious kinds (powerup_unowned = client claimed an item
    // they don't have, input_bounds/input_rate = malformed payload).
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
      // Lightweight visibility — quietly note the false-positive trigger.
      console.warn(
        `[reef-race anti-cheat] physics-flag (NOT counted toward forfeit) room=${state.roomId} avatar=${avatarId} kind=${kind} detail=${detail ?? '-'}`,
      );
    }
    if (reachedThreshold) {
      const body = state.bodies.get(avatarId);
      if (body) {
        body.forfeited = true;
        body.dnf = true;
        body.alive = false;
        // Visibility: anti-cheat forfeits were silent before, leaving honest
        // players staring at a frozen kart with no feedback. Log every time
        // so we can audit how often the validator false-positives in prod.
        console.warn(
          `[reef-race anti-cheat] integrity-forfeit room=${state.roomId} avatar=${avatarId} kind=${kind} detail=${detail ?? '-'} flagCount=${state.flagCounter.countFor(avatarId)}`,
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
          console.error('[reef-race-sim] integrityForfeitFn threw:', err);
        }
      }
    }
    void FLAG_FORFEIT_THRESHOLD;
  }

  // ─── Phase 2 — placement cache + per-mechanic resolvers ────────────────

  /**
   * Live placement computed from race progress = lap*REEF_CHECKPOINT_COUNT +
   * (cpDone) for racing bodies. Higher progress = better placement (1 = leader).
   * Finished bodies retain finish placement (sorted by finishedAt asc). DNFers
   * appended last with deterministic avatarId tie-break.
   *
   * Returns a Map<avatarId, placement> with placements 1..N. Pure function of
   * state — safe to call from any tick step. Cost: O(N log N) on N <= 8.
   */
  private computeLivePlacements(state: ReefRoomState): Map<string, number> {
    const racing: Array<{
      avatarId: string;
      progress: number;
      finishedAt: number | null;
      dnf: boolean;
    }> = [];
    for (const b of state.bodies.values()) {
      if (b.dnf || b.forfeited) {
        racing.push({
          avatarId: b.avatarId,
          progress: -Infinity,
          finishedAt: null,
          dnf: true,
        });
        continue;
      }
      if (b.finishedAt !== null) {
        racing.push({
          avatarId: b.avatarId,
          progress: Infinity,
          finishedAt: b.finishedAt,
          dnf: false,
        });
        continue;
      }
      // Race progress: full laps + completed checkpoints in the current lap.
      // nextCheckpoint=1 means we just crossed 0 → 0 fully done; nextCheckpoint=11
      // means we've crossed 1..10 = 10 done. Wrap: nextCheckpoint=0 means we've
      // crossed 1..11 and are about to cross 0 → 11 done (+ lap-start).
      const cpDone =
        b.nextCheckpoint === 0 ? REEF_CHECKPOINT_COUNT - 1 : b.nextCheckpoint - 1;

      // Fractional along-segment progress (0..1) from the previous crossed
      // checkpoint to the next one. Without this, every kart with the same
      // `cpDone` ties on integer progress and is broken by avatarId — meaning a
      // kart STUCK at the start grid (cpDone=0) ranks 1st over moving karts
      // simply because its avatarId sorts earliest. Adding the fractional term
      // makes a stuck-at-start kart genuinely lose to one that's driven any
      // distance toward CP1.
      const N = state.checkpoints.length;
      let frac = 0;
      if (N > 0) {
        const prevIdx = (b.nextCheckpoint - 1 + N) % N;
        const nextIdx = b.nextCheckpoint % N;
        const prevCp  = state.checkpoints[prevIdx];
        const nextCp  = state.checkpoints[nextIdx];
        const segDx = nextCp.center.x - prevCp.center.x;
        const segDy = nextCp.center.y - prevCp.center.y;
        const segLenSq = segDx * segDx + segDy * segDy;
        if (segLenSq > 0) {
          const bodyDx = b.x - prevCp.center.x;
          const bodyDy = b.y - prevCp.center.y;
          const t = (bodyDx * segDx + bodyDy * segDy) / segLenSq;
          frac = Math.max(0, Math.min(0.999, t));
        }
      }

      racing.push({
        avatarId: b.avatarId,
        progress: b.lap * REEF_CHECKPOINT_COUNT + cpDone + frac,
        finishedAt: null,
        dnf: false,
      });
    }
    // Sort: finishers first by finishedAt asc, then racers by progress desc,
    // then DNF. Tie-break by avatarId ASCENDING for determinism.
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

  /**
   * Slipstream (drafting) detection. Pair-wise loop on alive racing bodies.
   * Sets / refreshes `slipstream-boost` activeBoost entry once a body has
   * stayed in the same source's wake for SLIPSTREAM_REQUIRED_TICKS. Edge-
   * triggers `event.slipstream` on rising edge and `event.slipstream_end`
   * when grace expires.
   */
  private resolveSlipstream(state: ReefRoomState, now: number): void {
    const bodies: ReefBody[] = [];
    for (const b of state.bodies.values()) {
      if (b.alive && !b.dnf && b.finishedAt === null && !b.forfeited) {
        bodies.push(b);
      }
    }
    // Per-body inner loop — O(N²) on N≤8 = 64 checks/tick. Cheap.
    for (const self of bodies) {
      let bestSrc: ReefBody | null = null;
      let bestDistSq = Infinity;
      for (const target of bodies) {
        if (target === self) continue;
        const dx = target.x - self.x;
        const dy = target.y - self.y;
        const distSq = dx * dx + dy * dy;
        const minSq = SLIPSTREAM_MIN_DISTANCE * SLIPSTREAM_MIN_DISTANCE;
        const maxSq = SLIPSTREAM_MAX_DISTANCE * SLIPSTREAM_MAX_DISTANCE;
        if (distSq < minSq || distSq > maxSq) continue;
        // Target's velocity must be non-trivial (a parked / stalled car
        // can't make wake).
        const tSpeed = Math.hypot(target.vx, target.vy);
        if (tSpeed < REEF_MAX_SPEED * 0.30) continue;
        // Self must be BEHIND the target (dot(self→target, target.vel) > 0).
        const dot = (dx * target.vx + dy * target.vy) / tSpeed;
        if (dot <= 0) continue;
        // Lateral offset must be within wake half-width (perp to target vel).
        const perpMag = Math.abs(dx * target.vy - dy * target.vx) / tSpeed;
        if (perpMag > SLIPSTREAM_HALF_WIDTH) continue;
        // Self velocity must be non-trivial AND aligned with target's.
        const sSpeed = Math.hypot(self.vx, self.vy);
        if (sSpeed < REEF_MAX_SPEED * 0.30) continue;
        const align =
          (self.vx * target.vx + self.vy * target.vy) / (sSpeed * tSpeed);
        if (align < SLIPSTREAM_MIN_VEL_ALIGNMENT) continue;
        // Prefer the closest valid target (avoid bouncing between two leaders).
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestSrc = target;
        }
      }
      if (bestSrc) {
        // Continue / start charging.
        if (self.slipstreamSourceAvatarId === bestSrc.avatarId) {
          self.slipstreamConsecutiveTicks++;
        } else {
          self.slipstreamSourceAvatarId = bestSrc.avatarId;
          self.slipstreamConsecutiveTicks = 1;
        }
        // Phase 3 — agility extends post-leave grace from 6 ticks (200ms)
        // to 24 ticks (800ms). Neutral classes use the legacy 6 via
        // body.mults.slipstreamGraceTicks. SLIPSTREAM_REQUIRED_TICKS (the
        // hold-to-arm time) is unchanged for everyone (audit C3).
        self.slipstreamGraceTicksLeft = self.mults.slipstreamGraceTicks;
        // Threshold reached → set / refresh boost.
        if (self.slipstreamConsecutiveTicks >= SLIPSTREAM_REQUIRED_TICKS) {
          const wasActive = self.activeBoosts.has('slipstream-boost');
          self.activeBoosts.set('slipstream-boost', {
            expiresAt: now + SLIPSTREAM_REFRESH_TTL_MS,
            mult: SLIPSTREAM_BOOST_MULT,
          });
          // Edge-trigger: only broadcast on RISING edge of `wasActive`.
          // SLIPSTREAM_REFRESH_TTL_MS = 250ms is comfortably greater than
          // one tick (33ms), so the boost won't expire-then-set mid-tick.
          if (!wasActive) {
            this.broadcastFn(state.roomId, {
              type: 'event.slipstream',
              srcAvatarId: bestSrc.avatarId,
              dstAvatarId: self.avatarId,
            });
          }
        }
      } else {
        // Out of wake — apply grace, then clear AND broadcast end event.
        if (self.slipstreamGraceTicksLeft > 0) {
          self.slipstreamGraceTicksLeft--;
          if (
            self.slipstreamGraceTicksLeft === 0 &&
            self.activeBoosts.has('slipstream-boost')
          ) {
            // Edge-trigger: emit `event.slipstream_end` exactly when grace
            // runs out and the boost is about to be allowed to expire.
            self.activeBoosts.delete('slipstream-boost');
            self.slipstreamSourceAvatarId = null;
            self.slipstreamConsecutiveTicks = 0;
            this.broadcastFn(state.roomId, {
              type: 'event.slipstream_end',
              dstAvatarId: self.avatarId,
            });
          }
        } else {
          // Already cleared in a prior tick; ensure source/counter reset.
          self.slipstreamSourceAvatarId = null;
          self.slipstreamConsecutiveTicks = 0;
        }
      }
    }
  }

  /**
   * Boost-ribbon detection. Crossing a ribbon segment with body radius
   * overlap fires +30% / 2s. Per-lap dedupe keyed on (lap, ribbonId);
   * cross-lap cooldown via `ribbonLastCollectedAt` map.
   */
  private resolveBoostRibbons(state: ReefRoomState, now: number): void {
    if (state.ribbons.length === 0) return; // future-proof
    for (const body of state.bodies.values()) {
      if (
        !body.alive ||
        body.dnf ||
        body.finishedAt !== null ||
        body.forfeited
      ) {
        continue;
      }
      for (const ribbon of state.ribbons) {
        // Skip if already collected this lap (key includes PRE-INCREMENT lap).
        const key = `${body.lap}:${ribbon.id}`;
        if (body.ribbonsCollectedThisLap.has(key)) continue;
        // Per-ribbon cooldown — prevents oscillating across the line.
        const lastCollect = body.ribbonLastCollectedAt.get(ribbon.id) ?? 0;
        if (now - lastCollect < RIBBON_COLLECTION_COOLDOWN_MS) continue;
        // Segment-distance test: project body onto ribbon.a→ribbon.b.
        // Phase 3 — intelligence widens the perpendicular detect band by
        // 30% (RIBBON_HALF_WIDTH × 1.3 = 45.5 wu vs neutral 35 wu).
        if (
          !isOnRibbon(
            body,
            ribbon,
            RIBBON_HALF_WIDTH * body.mults.ribbonDetectMult,
          )
        ) {
          continue;
        }
        // Collected.
        body.ribbonsCollectedThisLap.add(key);
        body.ribbonLastCollectedAt.set(ribbon.id, now);
        body.activeBoosts.set('ribbon-boost', {
          expiresAt: now + RIBBON_BOOST_DURATION_MS,
          mult: RIBBON_BOOST_MULT,
        });
        this.broadcastFn(state.roomId, {
          type: 'event.ribbon_collected',
          avatarId: body.avatarId,
          ribbonId: ribbon.id,
        });
        break; // one ribbon per body per tick
      }
    }
  }

  /**
   * Apex verdict — inner zone = 'clean' (+5% / 1.5s), outer zone = 'wide'
   * (-5% / 1.5s). Fired AT MOST ONCE per (avatarId, lap, hairpinIndex). Cleared
   * on lap-up via `apexCheckedThisLap` clear in resolveCheckpoints.
   */
  private resolveApex(state: ReefRoomState, now: number): void {
    if (state.apexZones.length === 0) return;
    for (const body of state.bodies.values()) {
      if (
        !body.alive ||
        body.dnf ||
        body.finishedAt !== null ||
        body.forfeited
      ) {
        continue;
      }
      for (const zone of state.apexZones) {
        const key = `${body.lap}:${zone.hairpinIndex}`;
        if (body.apexCheckedThisLap.has(key)) continue;
        const dxIn = body.x - zone.innerCenter.x;
        const dyIn = body.y - zone.innerCenter.y;
        const dxOut = body.x - zone.outerCenter.x;
        const dyOut = body.y - zone.outerCenter.y;
        // Phase 4 (S1 fix) — verdicts also stamped onto the per-(lap, cp)
        // map so the streak resolver in resolveCheckpoints can read the
        // verdict for THIS lap's hairpin without colliding with stale
        // entries from a previous lap.
        const verdictKey = `${body.lap}-${zone.hairpinIndex}`;
        if (dxIn * dxIn + dyIn * dyIn <= APEX_INNER_RADIUS * APEX_INNER_RADIUS) {
          body.apexCheckedThisLap.add(key);
          body.lastApexVerdictByHairpin.set(verdictKey, 'clean');
          body.activeBoosts.set('apex-bonus', {
            expiresAt: now + APEX_DURATION_MS,
            mult: APEX_BONUS_MULT,
          });
          this.broadcastFn(state.roomId, {
            type: 'event.apex_verdict',
            avatarId: body.avatarId,
            hairpinIndex: zone.hairpinIndex,
            kind: 'clean',
          });
        } else if (
          dxOut * dxOut + dyOut * dyOut <=
          APEX_OUTER_RADIUS * APEX_OUTER_RADIUS
        ) {
          body.apexCheckedThisLap.add(key);
          body.lastApexVerdictByHairpin.set(verdictKey, 'wide');
          body.activeBoosts.set('apex-penalty', {
            expiresAt: now + APEX_DURATION_MS,
            mult: APEX_PENALTY_MULT, // negative
          });
          this.broadcastFn(state.roomId, {
            type: 'event.apex_verdict',
            avatarId: body.avatarId,
            hairpinIndex: zone.hairpinIndex,
            kind: 'wide',
          });
        }
      }
    }
  }

  /**
   * Hazard patches — sea-urchin field clipping the inside-line of each
   * hairpin. Refreshes `hazard-slow` activeBoost every tick of overlap;
   * edge-triggers `event.hazard_hit` AT MOST ONCE per (avatarId, lap, hazardId).
   * Shields do NOT block hazards (terrain, not attacks).
   */
  private resolveHazards(state: ReefRoomState, now: number): void {
    if (state.hazards.length === 0) return;
    for (const body of state.bodies.values()) {
      if (
        !body.alive ||
        body.dnf ||
        body.finishedAt !== null ||
        body.forfeited
      ) {
        continue;
      }
      let hit: ReefHazardPatch | null = null;
      for (const hazard of state.hazards) {
        const dx = body.x - hazard.center.x;
        const dy = body.y - hazard.center.y;
        if (dx * dx + dy * dy <= hazard.radius * hazard.radius) {
          hit = hazard;
          break;
        }
      }
      if (hit) {
        body.activeBoosts.set('hazard-slow', {
          expiresAt: now + HAZARD_TICK_DURATION_MS,
          mult: HAZARD_SLOW_MULT,
        });
        // Edge-trigger event broadcast — once per (avatarId, hazardId) per lap.
        const key = `${body.lap}:${hit.id}`;
        if (!body.hazardsHitThisLap.has(key)) {
          body.hazardsHitThisLap.add(key);
          this.broadcastFn(state.roomId, {
            type: 'event.hazard_hit',
            avatarId: body.avatarId,
            hazardId: hit.id,
          });
        }
      }
      // No clear-on-leave — speedMod sweep in step 3 handles expiry naturally
      // because `expiresAt` is now+200ms; if the body's still inside next tick
      // the entry refreshes.
    }
  }

  /**
   * Phase 2 — placement-aware power-up roll. Walks the placement bucket from
   * `getPlacementItemTable(placement)`; falls through to `rollPowerUpKind`
   * (legacy global table) if the bucket is null/undefined.
   */
  private rollPowerUpKindForPlacement(
    state: ReefRoomState,
    placement: number,
  ): ReefPowerUpKind {
    const table = getPlacementItemTable(placement);
    if (!table || table.length === 0) {
      return this.rollPowerUpKind(state);
    }
    const total = table.reduce((s, e) => s + e.weight, 0);
    if (total <= 0) return this.rollPowerUpKind(state);
    const roll = this.lcgNext(state) % total;
    let acc = 0;
    for (const entry of table) {
      acc += entry.weight;
      if (roll < acc) return entry.kind;
    }
    return table[0].kind; // unreachable
  }

  /**
   * Phase 3 — accessor for `RoomMeta.reefRacingProfiles`. Emits per-avatar
   * racing class + level so the HUD's archetype tile can show the player
   * WHY they have the multipliers they have (S5 fix: room-wide one-shot
   * map, client filters by self avatarId; ~50 bytes × ≤8 avatars = ≤400 bytes).
   *
   * Bots are included with `class: 'balanced', level: 1` (they're always
   * neutral by design — Phase 3 §6).
   */
  getRacingProfiles(roomId: string): Record<
    string,
    { class: RacingClass; level: number }
  > | null {
    const state = this.rooms.get(roomId);
    if (!state) return null;
    const out: Record<string, { class: RacingClass; level: number }> = {};
    for (const body of state.bodies.values()) {
      const cached = state.avatarClassCache.get(body.avatarId);
      out[body.avatarId] = cached ?? { class: 'balanced', level: 1 };
    }
    return out;
  }

  /**
   * Phase 2 — accessor for `RoomMeta.reefStaticZones`. Emits the server-
   * authoritative ribbon / apex / hazard positions so the client builds
   * visual meshes from the same source-of-truth (audit N3).
   */
  getStaticZones(roomId: string): {
    ribbons: Array<{ id: string; a: Vec2; b: Vec2 }>;
    apexZones: Array<{
      hairpinIndex: number;
      innerCenter: Vec2;
      outerCenter: Vec2;
    }>;
    hazards: Array<{ id: string; center: Vec2; radius: number }>;
  } | null {
    const state = this.rooms.get(roomId);
    if (!state) return null;
    return {
      ribbons: state.ribbons.map((r) => ({ id: r.id, a: r.a, b: r.b })),
      apexZones: state.apexZones.map((z) => ({
        hairpinIndex: z.hairpinIndex,
        innerCenter: z.innerCenter,
        outerCenter: z.outerCenter,
      })),
      hazards: state.hazards.map((h) => ({
        id: h.id,
        center: h.center,
        radius: h.radius,
      })),
    };
  }

  // ─── Spawn / RNG ───────────────────────────────────────────────────────

  private rollPowerUpKind(state: ReefRoomState): ReefPowerUpKind {
    const total = REEF_POWERUP_DEFS.reduce((s, d) => s + d.weight, 0);
    const roll = this.lcgNext(state) % total;
    let acc = 0;
    for (const def of REEF_POWERUP_DEFS) {
      acc += def.weight;
      if (roll < acc) return def.kind;
    }
    return REEF_POWERUP_DEFS[0].kind; // unreachable
  }

  private lcgNext(state: ReefRoomState): number {
    state.rngState = (state.rngState * 1664525 + 1013904223) >>> 0;
    return state.rngState;
  }

  private deriveSeedFromRoomId(roomId: string): number {
    let h = 5381;
    for (let i = 0; i < roomId.length; i++) {
      h = ((h << 5) + h + roomId.charCodeAt(i)) >>> 0;
    }
    return h || 1;
  }
}

function emptyReefInventory(): PowerUpInventorySlot[] {
  const out: PowerUpInventorySlot[] = [];
  for (let i = 0; i < REEF_MAX_POWER_UP_SLOTS; i++) {
    out.push({ kind: null, charges: 0, cooldownUntil: 0 });
  }
  return out;
}

/**
 * Phase 2 — segment-distance test: project the body onto the ribbon
 * a→b segment. The body is "on" the ribbon when:
 *   - parametric t lies in [0, 1] (body is between the segment endpoints)
 *   - perpendicular distance ≤ RIBBON_HALF_WIDTH
 *
 * Pure number math, no allocations.
 */
function isOnRibbon(
  body: { x: number; y: number },
  ribbon: ReefBoostRibbon,
  halfWidth: number = RIBBON_HALF_WIDTH,
): boolean {
  const ax = ribbon.a.x;
  const ay = ribbon.a.y;
  const bx = ribbon.b.x;
  const by = ribbon.b.y;
  const sx = bx - ax;
  const sy = by - ay;
  const segLenSq = sx * sx + sy * sy;
  if (segLenSq <= 0) return false;
  const dx = body.x - ax;
  const dy = body.y - ay;
  // Parametric t along the segment.
  const t = (dx * sx + dy * sy) / segLenSq;
  if (t < 0 || t > 1) return false;
  // Perpendicular distance to the segment.
  const projX = ax + sx * t;
  const projY = ay + sy * t;
  const ex = body.x - projX;
  const ey = body.y - projY;
  const perpSq = ex * ex + ey * ey;
  return perpSq <= halfWidth * halfWidth;
}

/**
 * Phase 4 (C3 fix) — per-avatar Reef Race extension on `SimResultRow`.
 * Embedded inline by `computeResults()` BEFORE `state.bodies` teardown so
 * the reward pipeline's perfect-lap-bonus + PB-write logic operates on
 * a plain JS object — no live-state accessor, no race window with
 * `endRound()`.
 */
export interface ReefRaceSimResultRowExt {
  /**
   * Best single-lap time this match in ms. null when no clean lap was
   * ever completed (immediate DNF / forfeit before any lap-up).
   */
  bestLapMs: number | null;
  /**
   * Captured ghost-replay frames for the best lap. null when no clean lap
   * was ever completed. Lap-relative `t`. Empty array possible on a
   * legitimate but extremely short capture window.
   */
  ghostReplayFrames: GhostFrame[] | null;
  /** High-water `currentStreak` across the entire match. */
  bestStreakThisMatch: number;
  /** Final `currentStreak` value at match-end (informational). */
  currentStreakAtMatchEnd: number;
}

function extractReefRaceBlock(body: ReefBody): ReefRaceSimResultRowExt {
  return {
    bestLapMs: body.bestLapMsSoFar,
    ghostReplayFrames: body.bestLapFrames,
    bestStreakThisMatch: body.bestStreakThisMatch,
    currentStreakAtMatchEnd: body.currentStreak,
  };
}

export const reefRaceSim = new ReefRaceSim();
