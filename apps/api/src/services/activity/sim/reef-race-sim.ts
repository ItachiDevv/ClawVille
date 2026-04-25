/**
 * Q2 Activity Portals — Reef Race server-authoritative simulation
 * (chunk #5).
 *
 * Per backend §4.5 + 3d-spec §2.1:
 *   - 30Hz fixed-tick (race kinematics tolerate lower rate; halves
 *     bandwidth vs Bumper's 60Hz)
 *   - Bespoke oval, ~6000wu perimeter, 3 laps default
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
} from './reef-race-config';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Sim tick rate (Hz). 30Hz per backend §3.4 + task spec. */
export const REEF_SIM_HZ = REEF_TICK_HZ;
const REEF_TICK_MS = 1000 / REEF_SIM_HZ;

/** Snapshot broadcast rate (Hz). 5Hz delta per task spec. */
const REEF_SNAPSHOT_HZ = 5;
const REEF_TICKS_PER_SNAPSHOT = Math.round(REEF_SIM_HZ / REEF_SNAPSHOT_HZ);

/** Keyframe broadcast cadence (1Hz per task spec). */
const REEF_TICKS_PER_KEYFRAME = REEF_SIM_HZ;

/** Quantization factors — same as Bumper for consistent client decoding. */
const POS_QUANT = 100;
const ROT_QUANT = 1000;

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
  petId: string;
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
  /** Per-pet inventory, slot-indexed (length = REEF_MAX_POWER_UP_SLOTS) */
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
  /** Finish order (petIds in placement 1..n order). DNF bodies appended at race end. */
  finishOrder: string[];
  /** Bot controllers (mirror Bumper's pattern). */
  botControllers: Map<string, BotController>;
  botSeqs: Map<string, number>;
}

interface ReefSnapshot {
  tick: number;
  bodies: Array<{
    petId: string;
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
    | ((roomId: string, petId: string) => void)
    | null = null;

  setBroadcastFn(fn: SimBroadcastFn): void {
    this.broadcastFn = fn;
  }

  setEndedFn(fn: (roomId: string) => void): void {
    this.endedFn = fn;
  }

  setIntegrityForfeitFn(fn: (roomId: string, petId: string) => void): void {
    this.integrityForfeitFn = fn;
  }

  /**
   * Initialise a sim for a freshly-LIVE room. Caller (room manager)
   * ensures the room is in LIVE state when calling.
   */
  startRoom(
    roomId: string,
    activityId: string,
    participantPetIds: string[],
    opts?: {
      seed?: number;
      isBot?: (petId: string) => boolean;
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
       * Phase 1 (audit C4) — per-pet launch verdict computed by the room
       * manager's `computeLaunchVerdicts(room)` BEFORE startRoom. The sim
       * seeds the corresponding `activeBoosts` entry on each body so the
       * very first applyIntentForTick respects the boost/stall.
       */
      launchBoosts?: Map<string, 'boost' | 'stall'>;
    },
  ): ReefRoomState {
    if (this.rooms.has(roomId)) {
      // Idempotent — defensive against double-LIVE transitions.
      return this.rooms.get(roomId)!;
    }
    const seed = opts?.seed ?? this.deriveSeedFromRoomId(roomId);
    // Audit S10 — prefer the room manager's startedAt so launch-verdict
    // expirations stay aligned with the sim's tick clock.
    const startedAt = opts?.startedAt ?? Date.now();
    const checkpoints = buildReefCheckpoints();

    const botControllers = new Map<string, BotController>();
    if (opts?.bots) {
      for (const ctrl of opts.bots) {
        if (!participantPetIds.includes(ctrl.petId)) {
          console.warn(
            `[reef-race-sim] bot controller for ${ctrl.petId} is not a participant — skipping`,
          );
          continue;
        }
        botControllers.set(ctrl.petId, ctrl);
      }
    }

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
    };

    // Stagger spawn positions on the start straight (just before
    // checkpoint 0). Outer rows further back so faster overtakes
    // emerge naturally.
    const startCp = checkpoints[0];
    // Place bodies behind the start line by `i * spacing` along -tangent.
    const SPACING = 70;
    const ROW_OFFSET = 90;
    participantPetIds.forEach((petId, i) => {
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
      const verdict = opts?.launchBoosts?.get(petId) ?? null;
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

      state.bodies.set(petId, {
        petId,
        x,
        y,
        vx: 0,
        vy: 0,
        rot,
        alive: true,
        finishedAt: null,
        dnf: false,
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
        isBot: opts?.isBot?.(petId) ?? botControllers.has(petId),
        forfeited: false,
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
      for (const [petId, ctrl] of state.botControllers) {
        if (!ctrl.onSpawn) continue;
        try {
          ctrl.onSpawn({ ...view, selfPetId: petId });
        } catch (err) {
          console.error(`[reef-race-sim] bot onSpawn threw for ${petId}:`, err);
        }
      }
    }

    // Emit match_started + initial pickup spawn events.
    this.broadcastFn(roomId, { type: 'event.match_started', startedAt });
    // Phase 1 — broadcast per-pet launch verdict so future per-player VFX
    // (boost flash, stall stutter) can hook in without re-deriving.
    if (opts?.launchBoosts) {
      for (const [petId, kind] of opts.launchBoosts) {
        this.broadcastFn(roomId, { type: 'event.launch', petId, kind });
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
    petId: string,
    seq: number,
    dt: number,
    rawInput: InputBounds,
  ): { ok: boolean; forfeit: boolean; flagsAdded: number } {
    const state = this.rooms.get(roomId);
    if (!state) return { ok: false, forfeit: false, flagsAdded: 0 };
    const body = state.bodies.get(petId);
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
      petId,
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
    petId: string,
    reason: 'integrity' | 'timeout' | 'voluntary',
  ): void {
    const state = this.rooms.get(roomId);
    if (!state) return;
    const body = state.bodies.get(petId);
    if (!body || body.finishedAt !== null) return;
    body.forfeited = true;
    body.dnf = true;
    body.alive = false;
    this.broadcastFn(state.roomId, {
      type: 'event.player_left',
      petId,
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
   */
  computeResults(
    roomId: string,
  ): Array<{ petId: string; placement: number; score: number; scoreMs: number | null }> {
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
        // Tiebreak by petId for stability.
        return a.petId.localeCompare(b.petId);
      });

    const out: Array<{ petId: string; placement: number; score: number; scoreMs: number | null }> = [];
    let placement = 1;
    for (const f of finishers) {
      out.push({
        petId: f.petId,
        placement: placement++,
        // Score: -finishMs so higher-is-better sorts correctly with the
        // generic placement-by-score logic in the reward pipeline.
        score: -f.totalTimeMs,
        scoreMs: f.totalTimeMs,
      });
    }
    for (const d of dnfers) {
      out.push({
        petId: d.petId,
        placement: placement++,
        score: -REEF_HARD_TIMEOUT_MS - 1, // worse than any finish
        scoreMs: null,
      });
    }
    return out;
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

    // 0. Bot intent scheduling — runs BEFORE integration.
    if (state.botControllers.size > 0) {
      this.runBotControllers(state, dt, now);
    }

    // 1. Apply intents → integrate velocity.
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;
      this.applyIntentForTick(state, body, dt, now);
    }

    // 2. Velocity → position.
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited || body.finishedAt !== null) continue;
      this.integrateMotion(state, body, dt);
    }

    // 3. Tick active effects → expire them.
    for (const body of state.bodies.values()) {
      for (const [kind, expires] of body.activeEffects) {
        if (expires <= now) body.activeEffects.delete(kind);
      }
      // Phase 1 — sweep active boosts (drift / launch). When a drift-boost
      // expires we must zero `currentDriftBoostSparks` so the snapshot diff
      // stops broadcasting the spark tier.
      for (const [kind, entry] of body.activeBoosts) {
        if (entry.expiresAt <= now) {
          body.activeBoosts.delete(kind);
          if (kind === 'drift-boost') body.currentDriftBoostSparks = 0;
        }
      }
    }

    // 4. Body-body proximity (light push to prevent tunneling).
    this.resolveProximity(state);

    // 5. Power-up pickup collision.
    this.resolvePickups(state, now);

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
    //    Phase 1 kinematic flags (NEW):
    const launchBoosted = body.activeBoosts.has('launch-boost');
    const driftBoosted  = body.activeBoosts.has('drift-boost');
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
      speedMod = 0.5;
    } else {
      // Additive kinematic contribution from launch + drift:
      const driftMult =
        driftBoosted && body.currentDriftBoostSparks >= 1
          ? DRIFT_BOOST_MULTS[body.currentDriftBoostSparks - 1] ?? 0
          : 0;
      const kineticMult = (launchBoosted ? LAUNCH_BOOST_MULT : 0) + driftMult;
      // Pickup contribution (rr-turbo-bubble expressed as additive delta):
      const pickupMult = powerBoosted ? REEF_BOOST_MULT - 1.0 : 0; // = 0.4
      // Take MAX so simultaneous turbo-bubble + drift-3 doesn't stack
      // multiplicatively past the kinematic tolerance (audit C3 / S4).
      const bestMult = Math.max(kineticMult, pickupMult);
      speedMod = slicked ? 0.5 : 1.0 + bestMult;
    }

    const baseTopSpeed = REEF_MAX_SPEED * speedMod;

    // 6. Update body.rot. Drift bias is applied INSIDE the atan2 assignment,
    //    not as a per-tick accumulator (audit C1 fix). turnSign mirrors the
    //    intuition that turning right = body leans right (visual yaw < target),
    //    so we SUBTRACT the bias from the target rot.
    if (intent.dir && (intent.dir.x !== 0 || intent.dir.y !== 0)) {
      const baseRot = Math.atan2(intent.dir.x, intent.dir.y);
      if (body.drift.charging) {
        const turnSign = intent.dir.x > 0 ? -1 : 1;
        body.rot = baseRot + turnSign * DRIFT_ANGULAR_BIAS_RAD;
      } else {
        body.rot = baseRot;
      }
    }

    // 7. Tick the drift state machine AFTER step 6 — see §2.3 commentary
    //    in `.claude/plans/reef-race-phase1-detailed.md`. One tick of
    //    "lingering lean" on release avoids an abrupt visual snap-back.
    this.tickDriftState(state, body, now);

    // 8. targetVx/Vy from intent.dir * effectiveThrust * speedMod.
    let targetVx = 0;
    let targetVy = 0;
    if (intent.dir) {
      const mag = Math.hypot(intent.dir.x, intent.dir.y);
      if (mag > 0) {
        const nx = intent.dir.x / mag;
        const ny = intent.dir.y / mag;
        targetVx = nx * effectiveThrust * baseTopSpeed;
        targetVy = ny * effectiveThrust * baseTopSpeed;
      }
    }

    // 9. Integrate acceleration toward target.
    const dvx = targetVx - body.vx;
    const dvy = targetVy - body.vy;
    const dv = Math.hypot(dvx, dvy);
    const maxStep = REEF_MAX_ACCEL * dt;
    const scale = dv === 0 ? 0 : Math.min(1, maxStep / dv);
    body.vx += dvx * scale;
    body.vy += dvy * scale;
  }

  /**
   * Phase 1 — drift state machine. Runs as step 7 of `applyIntentForTick`.
   * Pure-state-mutation; never broadcasts more than one event.drift_boost
   * per release (audit-proofed via `lastDriftBit` edge detection).
   */
  private tickDriftState(state: ReefRoomState, body: ReefBody, now: number): void {
    const driftBit   = (body.intent.actionBits & ACTION_BIT_DRIFT) !== 0;
    const speed      = Math.hypot(body.vx, body.vy);
    const turning    = Math.abs(body.intent.dir?.x ?? 0) >= DRIFT_MIN_STEER;
    const fastEnough = speed >= DRIFT_MIN_SPEED_FOR_CHARGE;

    const justPressed  = driftBit && !body.drift.lastDriftBit;
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
            petId: body.petId,
            sparks: sparks as 1 | 2 | 3,
          });
        }
        body.drift.charging        = false;
        body.drift.sparkLevel      = 0;
        body.drift.chargeStartTick = 0;
      } else {
        // Still charging — advance the spark level.
        const elapsed = state.tick - body.drift.chargeStartTick;
        body.drift.sparkLevel =
          elapsed >= DRIFT_SPARK_TICK_3
            ? 3
            : elapsed >= DRIFT_SPARK_TICK_2
              ? 2
              : elapsed >= DRIFT_SPARK_TICK_1
                ? 1
                : 0;
      }
    } else if (justPressed && turning && fastEnough) {
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
    for (const [petId, ctrl] of state.botControllers) {
      const body = state.bodies.get(petId);
      if (
        !body ||
        !body.alive ||
        body.forfeited ||
        body.finishedAt !== null
      ) {
        continue;
      }
      sharedView.selfPetId = petId;
      sharedView.now = now;
      let intent;
      try {
        intent = ctrl.computeInput(sharedView, dt);
      } catch (err) {
        console.error(
          `[reef-race-sim] bot ${petId} computeInput threw:`,
          err,
        );
        continue;
      }
      const seq = (state.botSeqs.get(petId) ?? 0) + 1;
      state.botSeqs.set(petId, seq);
      this.applyInput(state.roomId, petId, seq, dt, {
        dir: intent.dir,
        thrust: intent.thrust,
        actionBits: intent.actionBits,
      });
    }
  }

  private buildBotRoomView(
    state: ReefRoomState,
    selfPetId: string,
  ): {
    selfPetId: string;
    bodies: Array<{
      petId: string;
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
    }>;
    arenaRadius: number;
    now: number;
    matchStartedAt: number;
    /** Next-checkpoint index for self — let bots steer toward it. */
    nextCheckpoint?: number;
    /** Centerline points for the 12 checkpoints — bots use these for steering. */
    checkpoints?: ReefCheckpointAabb[];
  } {
    const bodies = Array.from(state.bodies.values()).map((b) => ({
      petId: b.petId,
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
    }));
    const self = state.bodies.get(selfPetId);
    return {
      selfPetId,
      bodies,
      // Track has no "arena radius" — give the bot the longest oval axis
      // for any boundary heuristics it wants to compute. The Reef bot
      // primarily steers via centerline + checkpoints.
      arenaRadius: Math.max(REEF_TRACK_A, REEF_TRACK_B) + 200,
      now: Date.now(),
      matchStartedAt: state.startedAt,
      nextCheckpoint: self?.nextCheckpoint ?? 1,
      checkpoints: state.checkpoints,
    };
  }

  private integrateMotion(
    state: ReefRoomState,
    body: ReefBody,
    dt: number,
  ): void {
    const prev = { x: body.x, y: body.y };
    const prevV = { x: body.vx, y: body.vy };

    // Audit C3 — both call-sites use the named REEF_KINEMATIC_TOLERANCE so
    // a future refactor of integrateMotion can't silently revert to the
    // shared.ts DEFAULT_CLAMP_TOLERANCE (1.15) and start clipping legit
    // boosts.
    const velCheck = validateReefVelocityDelta(prevV, prevV, dt, REEF_KINEMATIC_TOLERANCE);
    if (!velCheck.ok) {
      body.vx = velCheck.value.x;
      body.vy = velCheck.value.y;
    }

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
      this.flag(state, body.petId, 'overspeed', posCheck.detail);
    }

    body.vx *= REEF_DRAG;
    body.vy *= REEF_DRAG;

    // Phase 1 (audit S5) — boost-gated hard velocity cap. Backstop only;
    // never clamps non-boosted bodies. Max legit speed at 1.68× = 840 wu/s;
    // cap at 1.85× = 925 wu/s gives 85 wu/s safety margin against a future
    // unforeseen stacking bug.
    const isBoostActive =
      body.activeBoosts.has('launch-boost') ||
      body.activeBoosts.has('drift-boost');
    if (isBoostActive) {
      const speed = Math.hypot(body.vx, body.vy);
      const hardCap = REEF_MAX_SPEED * 1.85;
      if (speed > hardCap) {
        body.vx = (body.vx / speed) * hardCap;
        body.vy = (body.vy / speed) * hardCap;
      }
    }
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
        const minDist = REEF_BODY_RADIUS * 2;
        if (dist === 0 || dist >= minDist) continue;
        // Light separation push only — no knockback in a race.
        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        a.x -= nx * overlap * 0.5;
        a.y -= ny * overlap * 0.5;
        b.x += nx * overlap * 0.5;
        b.y += ny * overlap * 0.5;
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
            body.inventory[slot] = {
              kind: pk.kind,
              charges: 1,
              cooldownUntil: 0,
            };
            pk.active = false;
            pk.collectedAt = now;
            pk.respawnAt = now + REEF_POWERUP_RESPAWN_MS;
            this.broadcastFn(state.roomId, {
              type: 'event.power_up_collected',
              spawnId: pk.spawnId,
              collectorPetId: body.petId,
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
            this.flag(state, body.petId, 'checkpoint_skip', verdict.detail);
          } else {
            const tripped = state.skipTracker.recordSkip(body.petId, now);
            if (tripped) {
              this.flag(state, body.petId, 'checkpoint_skip', verdict.detail);
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
            // pet must legitimately re-traverse from 1..11..0 again.
            this.flag(state, body.petId, 'underminlap', lapVerdict.detail);
            // Reset lap tracker so the next loop attempt times from now.
            body.lapStartedAt = now;
            // Roll the next-checkpoint pointer back to 1 since we
            // discarded the lap (we still consider checkpoint 0 a valid
            // start-line crossing for kinematic purposes).
            body.nextCheckpoint = 1;
            break;
          }

          body.lap += 1;
          body.lapSplitsMs.push(lapMs);
          body.lapStartedAt = now;
          this.broadcastFn(state.roomId, {
            type: 'event.lap_completed',
            petId: body.petId,
            lap: body.lap,
            splitMs: lapMs,
            totalMs: now - state.startedAt,
          });
          if (body.lap >= REEF_LAPS) {
            body.finishedAt = now;
            body.totalTimeMs = now - state.startedAt;
            state.finishOrder.push(body.petId);
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
      this.flag(state, body.petId, 'powerup_unowned', verdict.detail);
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
        body.activeEffects.set(kind, now + def.effectMs);
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
      if (target.petId === src.petId) continue;
      if (target.dnf || target.finishedAt !== null) continue;
      if (target.activeEffects.has('rr-bubble-shield')) continue;
      const dx = target.x - src.x;
      const dy = target.y - src.y;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const speed = Math.hypot(target.vx, target.vy);
      if (speed > 0) {
        const factor = 0.4 * (1 - dist / radius); // closer = bigger slow
        target.vx *= 1 - factor;
        target.vy *= 1 - factor;
      }
      this.broadcastFn(state.roomId, {
        type: 'event.hit',
        srcPetId: src.petId,
        dstPetId: target.petId,
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
      if (t.petId === src.petId) continue;
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
    const impulse = REEF_MAX_SPEED * 0.6;
    best.vx += nx * impulse;
    best.vy += ny * impulse;
    this.broadcastFn(state.roomId, {
      type: 'event.hit',
      srcPetId: src.petId,
      dstPetId: best.petId,
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
      petId: r.petId,
      placement: r.placement,
    }));
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
        petId: b.petId,
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
          petId: b.petId,
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
          petId: b.petId,
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
        const p = prev.bodies.find((q) => q.petId === b.petId);
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
          p.driftSparks !== b.driftSparks
        );
      })
      .map((b) => ({
        petId: b.petId,
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

  // ─── Anti-cheat hook ───────────────────────────────────────────────────

  private flag(
    state: ReefRoomState,
    petId: string,
    kind: ActivityAntiCheatFlagPayload['kind'],
    detail?: string,
  ): void {
    const reachedThreshold = state.flagCounter.bump(petId);
    void logEvent({
      eventType: ACTIVITY_EVENT_TYPES.ANTI_CHEAT_FLAG,
      petId,
      payload: {
        kind,
        activityId: state.activityId,
        roomId: state.roomId,
        detail: detail ? { detail } : undefined,
      } satisfies ActivityAntiCheatFlagPayload,
    });
    if (reachedThreshold) {
      const body = state.bodies.get(petId);
      if (body) {
        body.forfeited = true;
        body.dnf = true;
        body.alive = false;
        this.broadcastFn(state.roomId, {
          type: 'event.player_left',
          petId,
          reason: 'integrity',
        });
      }
      if (this.integrityForfeitFn) {
        try {
          this.integrityForfeitFn(state.roomId, petId);
        } catch (err) {
          console.error('[reef-race-sim] integrityForfeitFn threw:', err);
        }
      }
    }
    void FLAG_FORFEIT_THRESHOLD;
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

export const reefRaceSim = new ReefRaceSim();
