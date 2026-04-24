/**
 * Q2 Activity Portals — Bumper Shells server-authoritative simulation
 * (chunk #3).
 *
 * Per backend §4.4 + 3d-spec §1:
 *   - 60Hz fixed-tick physics
 *   - Circular arena, radius 500wu, no walls (boundary = elimination)
 *   - O(n²) circle-circle collision (8 bodies max → 28 pair checks/tick)
 *   - Knockback on collision when closing velocity > threshold
 *   - 6-power-up catalog (bs-speed-boost / shell-shield / sticky-bomb /
 *     knockback-aura / ghost / tractor-beam) per the LOCKED Q2 plan
 *   - Snapshot deltas at 15Hz (every 4 ticks) with 1Hz keyframes
 *   - 90s round timer; ends on last-shell-standing or timeout
 *   - All anti-cheat flags routed through `BumperFlagCounter` →
 *     auto-forfeit at 5 flags
 *
 * Determinism: spawn positions use a per-room seeded LCG so two reruns
 * of the same recorded inputs produce identical sim outputs (required
 * for the bot-controller baselines + post-hoc audit).
 *
 * The sim DOES NOT own the WS hub or DB writes — those live in
 * `activity-ws-hub.ts` and `activity-room-manager.ts`. The sim publishes
 * frames via the registered `broadcast` callback set at boot.
 *
 * TODOs for later chunks:
 *   - Reward preview computation in `event.match_ended`: currently
 *     a placeholder; chunk #7 owns the actual ledger crediting + the
 *     authoritative preview from `activity_results`.
 *   - Bot controller body wiring (chunk #10) — the sim accepts bot
 *     avatarIds today but a bot's "input" needs a controller that pushes
 *     intents into `applyInput`.
 */

import {
  MAX_SPEED,
  MAX_ACCEL,
  MAX_POWER_UP_SLOTS,
  KNOCKBACK_VELOCITY_THRESHOLD,
  validatePositionDelta,
  validateVelocityDelta,
  validatePowerUpUse,
  BumperFlagCounter,
  FLAG_FORFEIT_THRESHOLD,
  type PowerUpInventorySlot,
} from '../anti-cheat/bumper-shells';
import { validateInputBounds, type InputBounds } from '../anti-cheat/shared';
import type { Vec2, ServerFrame } from '@clawville/shared';
import {
  logEvent,
  ACTIVITY_EVENT_TYPES,
  type ActivityAntiCheatFlagPayload,
} from '../../event-logger';
import { activityReplayLog } from '../activity-replay-log';
import type { BotController } from '../bots/bot-controller';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Sim tick rate (Hz). 60Hz physics per backend §3.4. */
export const BUMPER_TICK_HZ = 60;
const BUMPER_TICK_MS = 1000 / BUMPER_TICK_HZ;

/** Snapshot broadcast rate (Hz). 15Hz delta per backend §3.4. */
const BUMPER_SNAPSHOT_HZ = 15;
const BUMPER_TICKS_PER_SNAPSHOT = Math.round(BUMPER_TICK_HZ / BUMPER_SNAPSHOT_HZ);

/** Keyframe broadcast cadence (1Hz per backend §3.4) */
const BUMPER_TICKS_PER_KEYFRAME = BUMPER_TICK_HZ;

/** Round duration in seconds (Q2 plan locked = 90s) */
export const BUMPER_ROUND_SECONDS = 90;

/** Arena radius in world units (3d-spec §1) */
export const BUMPER_ARENA_RADIUS = 500;

/** Body radius for circle-circle collision (matches lobster scale) */
const BUMPER_BODY_RADIUS = 18;

/** Power-up pickup contact radius (3d-spec → 1.5wu in scene units; sim uses raw 1.5×scale) */
const BUMPER_POWERUP_RADIUS = 22;

/** Number of power-up spawn slots active at once (3 nodes per plan) */
const BUMPER_POWERUP_SPAWNS = 3;

/** Power-up respawn cooldown (8s per plan) */
const BUMPER_POWERUP_RESPAWN_MS = 8_000;

/** Body mass (uniform — knockback scales with closing-velocity, not mass) */
const BUMPER_BODY_MASS = 1;

/** Quantization factor — positions to 1/100 wu (backend §3.5) */
const POS_QUANT = 100;
/** Quantization factor — rotations to 1/1000 rad (backend §3.5) */
const ROT_QUANT = 1000;

// ─── Power-up catalog (LOCKED — Q2 plan §"Bumper Shells → Power-up catalog") ─

export type BumperPowerUpKind =
  | 'bs-speed-boost'
  | 'bs-shell-shield'
  | 'bs-sticky-bomb'
  | 'bs-knockback-aura'
  | 'bs-ghost'
  | 'bs-tractor-beam';

interface PowerUpDef {
  kind: BumperPowerUpKind;
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary';
  /** Effect duration ms — 0 means instant */
  effectMs: number;
  /** Cooldown ms after activation */
  cooldownMs: number;
  /** Base spawn weight before placement adjustment */
  weight: number;
}

const BUMPER_POWERUP_DEFS: readonly PowerUpDef[] = [
  // 55% common / 25% uncommon / 15% rare / 5% legendary baseline
  { kind: 'bs-speed-boost', rarity: 'common', effectMs: 3_000, cooldownMs: 0, weight: 55 },
  { kind: 'bs-shell-shield', rarity: 'uncommon', effectMs: 0, cooldownMs: 0, weight: 12 },
  { kind: 'bs-sticky-bomb', rarity: 'uncommon', effectMs: 8_000, cooldownMs: 0, weight: 13 },
  { kind: 'bs-knockback-aura', rarity: 'rare', effectMs: 0, cooldownMs: 6_000, weight: 8 },
  { kind: 'bs-ghost', rarity: 'rare', effectMs: 2_000, cooldownMs: 5_000, weight: 7 },
  { kind: 'bs-tractor-beam', rarity: 'legendary', effectMs: 0, cooldownMs: 0, weight: 5 },
];

const BUMPER_POWERUP_KINDS = BUMPER_POWERUP_DEFS.map((d) => d.kind);

function getPowerUpDef(kind: BumperPowerUpKind): PowerUpDef {
  const def = BUMPER_POWERUP_DEFS.find((d) => d.kind === kind);
  if (!def) throw new Error(`Unknown power-up kind ${kind}`);
  return def;
}

// ─── Body / sim state ───────────────────────────────────────────────────────

interface BumperBody {
  avatarId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  hp: number;
  alive: boolean;
  /** Eliminated via boundary cross — preserved for placement order */
  eliminatedAt: number | null;
  /** Per-avatar inventory, slot-indexed (length = MAX_POWER_UP_SLOTS) */
  inventory: PowerUpInventorySlot[];
  /** Active effects (kind → expires ms) */
  activeEffects: Map<BumperPowerUpKind, number>;
  /** Pending intent applied next tick — set from `applyInput` */
  intent: {
    dir: Vec2 | null;
    thrust: number;
    actionBits: number;
    seq: number;
    dt: number;
    consumedSeq: number;
  };
  /** Bot-controlled flag (chunk #10 toggles this when bot backfill ships) */
  isBot: boolean;
  /** Auto-forfeit (anti-cheat or DC timeout) */
  forfeited: boolean;
}

interface BumperSpawn {
  spawnId: string;
  kind: BumperPowerUpKind;
  position: Vec2;
  /** Time when this slot last spawned a pickup; 0 means active right now */
  collectedAt: number | null;
  /** When the slot will respawn (collectedAt + RESPAWN_MS); 0 if active */
  respawnAt: number;
  /** Instance-unique id; rotated on respawn so client tracks new pickup */
  active: boolean;
}

interface BumperStickyBomb {
  bombId: string;
  ownerPetId: string;
  position: Vec2;
  expiresAt: number;
}

interface BumperRoomState {
  roomId: string;
  activityId: string;
  startedAt: number;
  endsAt: number;
  tick: number;
  bodies: Map<string, BumperBody>;
  spawns: BumperSpawn[];
  bombs: BumperStickyBomb[];
  /** LCG seed (mutable) for deterministic spawn rolls */
  rngState: number;
  flagCounter: BumperFlagCounter;
  /** Last broadcast snapshot, for delta computation */
  lastSnapshot: BumperSnapshot | null;
  intervalHandle: ReturnType<typeof setInterval> | null;
  /** Set when the FSM has transitioned away from LIVE → no more ticks */
  ended: boolean;
  /**
   * Eliminated avatarIds in elimination order — placement is computed by
   * "alive at end" first, then this list reversed (last-eliminated = 4th,
   * first-eliminated = 8th).
   */
  eliminationOrder: string[];
  /**
   * Bot controllers keyed by avatarId. Populated from the `bots` arg to
   * `startRoom`. Each controller is invoked once per tick BEFORE
   * `applyIntentForTick`, and its output is fed through the same
   * `applyInput()` pipeline humans use (anti-cheat-clamped).
   */
  botControllers: Map<string, BotController>;
  /**
   * Per-tick monotonic input seq for bots. Bots have no client to track
   * `seq`, so we synthesize it server-side. Keyed by avatarId.
   */
  botSeqs: Map<string, number>;
}

interface BumperSnapshot {
  tick: number;
  bodies: Array<{ avatarId: string; x: number; y: number; vx: number; vy: number; rot: number; alive: boolean }>;
  spawns: Array<{ spawnId: string; kind: BumperPowerUpKind; x: number; y: number; active: boolean }>;
}

// ─── Sim singleton ──────────────────────────────────────────────────────────

/**
 * Callback registered by the WS hub so the sim can broadcast frames
 * without a circular import. Same pattern as room manager.
 */
type SimBroadcastFn = (roomId: string, frame: ServerFrame) => void;

class BumperShellsSim {
  private rooms = new Map<string, BumperRoomState>();
  private broadcastFn: SimBroadcastFn = () => {
    /* no-op until WS hub registers */
  };

  setBroadcastFn(fn: SimBroadcastFn): void {
    this.broadcastFn = fn;
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
      isBot?: (avatarId: string) => boolean;
      /**
       * Bot controllers to install for this room. Their avatarIds MUST be
       * a subset of `participantPetIds`. The sim ticks each one before
       * applying intents so bots feed the same `applyInput()` validators
       * as humans. Chunk #10.
       */
      bots?: BotController[];
    },
  ): BumperRoomState {
    if (this.rooms.has(roomId)) {
      // Idempotent — second call returns existing state. Defensive
      // against double-LIVE transitions.
      return this.rooms.get(roomId)!;
    }
    const seed = opts?.seed ?? this.deriveSeedFromRoomId(roomId);
    const startedAt = Date.now();
    const botControllers = new Map<string, BotController>();
    if (opts?.bots) {
      for (const ctrl of opts.bots) {
        if (!participantPetIds.includes(ctrl.avatarId)) {
          console.warn(
            `[bumper-shells-sim] bot controller for ${ctrl.avatarId} is not a participant — skipping`,
          );
          continue;
        }
        botControllers.set(ctrl.avatarId, ctrl);
      }
    }
    const state: BumperRoomState = {
      roomId,
      activityId,
      startedAt,
      endsAt: startedAt + BUMPER_ROUND_SECONDS * 1000,
      tick: 0,
      bodies: new Map(),
      spawns: [],
      bombs: [],
      rngState: seed >>> 0 || 1, // LCG can't have a 0 seed
      flagCounter: new BumperFlagCounter(),
      lastSnapshot: null,
      intervalHandle: null,
      ended: false,
      eliminationOrder: [],
      botControllers,
      botSeqs: new Map(),
    };

    // Place bodies on a circle around origin so spawn isn't biased.
    const radius = BUMPER_ARENA_RADIUS * 0.5;
    const angleStep = (Math.PI * 2) / Math.max(participantPetIds.length, 1);
    participantPetIds.forEach((avatarId, i) => {
      const angle = i * angleStep;
      state.bodies.set(avatarId, {
        avatarId,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        rot: angle + Math.PI, // face inward
        hp: 1,
        alive: true,
        eliminatedAt: null,
        inventory: emptyInventory(),
        activeEffects: new Map(),
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
      });
    });

    // Seed power-up spawn slots — all start ACTIVE so the first tick has
    // pickups on the map.
    for (let i = 0; i < BUMPER_POWERUP_SPAWNS; i++) {
      state.spawns.push(this.allocSpawn(state));
    }

    this.rooms.set(roomId, state);

    // Bot lifecycle hooks — fire onSpawn with an initial room view so
    // controllers can stash any per-room state. Errors are swallowed so
    // a buggy bot doesn't crash the room boot.
    if (state.botControllers.size > 0) {
      const view = this.buildBotRoomView(state, '');
      for (const [avatarId, ctrl] of state.botControllers) {
        if (!ctrl.onSpawn) continue;
        try {
          ctrl.onSpawn({ ...view, selfAvatarId: avatarId });
        } catch (err) {
          console.error(`[bumper-shells-sim] bot onSpawn threw for ${avatarId}:`, err);
        }
      }
    }

    // Emit match_started — also broadcast each initial spawn position.
    this.broadcastFn(roomId, { type: 'event.match_started', startedAt });
    for (const spawn of state.spawns) {
      this.broadcastFn(roomId, {
        type: 'event.power_up_spawned',
        spawnId: spawn.spawnId,
        kind: spawn.kind,
        position: spawn.position,
      });
    }

    console.log(
      `[bumper-shells-sim] startRoom ${roomId} — ${participantPetIds.length} participants (${botControllers.size} bots) — tick=${BUMPER_TICK_MS.toFixed(2)}ms`,
    );

    // Boot the tick loop. Drift-correcting via Date.now() inside the
    // handler instead of a high-resolution accumulator — ample at 60Hz
    // for the round length we care about.
    state.intervalHandle = setInterval(() => {
      try {
        this.tickRoom(state);
        // One-shot diagnostic: log first tick so we can confirm the sim
        // is actually advancing. Subsequent ticks are silent (60Hz =
        // log spam). Remove once stable in prod.
        if (state.tick === 1) {
          console.log(
            `[bumper-shells-sim] room ${roomId} first tick complete — ${state.bodies.size} bodies, ${state.botControllers.size} bots active`,
          );
        }
      } catch (err) {
        console.error('[bumper-shells-sim] tick exception:', err);
        // Mark ended so the WS hub stops trying to broadcast — chunk #2's
        // FSM owns the aborted_crash transition so we just stop ticking.
        state.ended = true;
        if (state.intervalHandle) clearInterval(state.intervalHandle);
        state.intervalHandle = null;
      }
    }, BUMPER_TICK_MS);

    return state;
  }

  /**
   * Halt + drop the sim for a room. Called by the room manager on
   * LIVE→RESULTS or LIVE→ABORTED_CRASH. Does NOT trigger the
   * `event.match_ended` broadcast — caller decides whether the round
   * ended cleanly or crashed.
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

  /** Snapshot accessor for the REST `/state` route */
  getStateSnapshot(roomId: string): BumperSnapshot | null {
    const state = this.rooms.get(roomId);
    if (!state) return null;
    return this.buildSnapshot(state);
  }

  /**
   * Apply a validated client input intent to a body. Returns the verdict
   * count of any flags raised — caller (WS hub) checks `forfeit` to
   * decide whether to close the connection with code 4003.
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
    if (!body || !body.alive || body.forfeited) {
      return { ok: false, forfeit: false, flagsAdded: 0 };
    }
    // Idempotency — drop replayed sequence numbers.
    if (seq <= body.intent.consumedSeq) {
      return { ok: false, forfeit: false, flagsAdded: 0 };
    }

    // Bound-check the input. Bound violations DO NOT flag (input bounds
    // are a client-bug, not cheating); only physics deltas at the body
    // level flag.
    const verdict = validateInputBounds(rawInput);
    const safe = verdict.value;

    // Clamp dt to a sane range — clients sometimes report ridiculous
    // dt across reconnects. Cap to 5 ticks worth of dt.
    const clampedDt = Math.max(0, Math.min(dt, (1 / BUMPER_TICK_HZ) * 5));

    body.intent = {
      dir: safe.dir ? { x: safe.dir.x, y: safe.dir.y } : null,
      thrust: safe.thrust ?? 0,
      actionBits: safe.actionBits ?? 0,
      seq,
      dt: clampedDt,
      consumedSeq: body.intent.consumedSeq,
    };

    // Append the (server-clamped) input to the replay log.
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
   * eliminated, broadcasts the event, transitions room if last alive.
   */
  forfeit(roomId: string, avatarId: string, reason: 'integrity' | 'timeout' | 'voluntary'): void {
    const state = this.rooms.get(roomId);
    if (!state) return;
    const body = state.bodies.get(avatarId);
    if (!body || !body.alive) return;
    body.forfeited = true;
    this.eliminate(state, body, undefined, reason);
  }

  /**
   * Result list for the room — placement-sorted. Called by the room
   * manager at LIVE→RESULTS to compute reward previews.
   */
  computeResults(roomId: string): Array<{ avatarId: string; placement: number; score: number; alive: boolean }> {
    const state = this.rooms.get(roomId);
    if (!state) return [];

    // Survivors first (alive at round end), placement 1..k by tick of
    // entry (deterministic). Then eliminated in REVERSE elimination
    // order (last eliminated = lowest survivor placement + 1).
    const survivors = Array.from(state.bodies.values()).filter((b) => b.alive);
    survivors.sort((a, b) => a.avatarId.localeCompare(b.avatarId));
    const eliminatedReverse = [...state.eliminationOrder].reverse();
    const out: Array<{ avatarId: string; placement: number; score: number; alive: boolean }> = [];
    let placement = 1;
    for (const b of survivors) {
      out.push({ avatarId: b.avatarId, placement: placement++, score: 0, alive: true });
    }
    for (const avatarId of eliminatedReverse) {
      out.push({ avatarId, placement: placement++, score: 0, alive: false });
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
  __getState(roomId: string): BumperRoomState | undefined {
    return this.rooms.get(roomId);
  }

  // ─── Internal — tick loop ──────────────────────────────────────────────

  private tickRoom(state: BumperRoomState): void {
    if (state.ended) return;

    state.tick += 1;
    const now = Date.now();
    const dt = 1 / BUMPER_TICK_HZ;

    // 0. Bot intent scheduling — runs BEFORE the integration pass so
    //    bots feed the same applyInput pipeline humans use. Errors per
    //    bot are isolated; a thrown controller doesn't break the tick.
    if (state.botControllers.size > 0) {
      this.runBotControllers(state, dt, now);
    }

    // 1. Apply intents — inputs were already bound-checked at apply time.
    //    Here we INTEGRATE them into velocity + position with anti-cheat.
    for (const body of state.bodies.values()) {
      if (!body.alive || body.forfeited) continue;
      this.applyIntentForTick(state, body, dt, now);
    }

    // 2. Velocity → position (with overspeed clamp + boundary check).
    for (const body of state.bodies.values()) {
      if (!body.alive) continue;
      this.integrateMotion(state, body, dt);
    }

    // 3. Tick active effects → expire them.
    for (const body of state.bodies.values()) {
      if (!body.alive) continue;
      for (const [kind, expires] of body.activeEffects) {
        if (expires <= now) body.activeEffects.delete(kind);
      }
    }

    // 4. Body-body collision pass (O(n²) — 28 pairs at 8 players).
    this.resolveCollisions(state, now);

    // 5. Power-up pickup collision.
    this.resolvePickups(state, now);

    // 6. Sticky-bomb proximity detection.
    this.resolveStickyBombs(state, now);

    // 7. Spawn-respawn cycle.
    this.tickSpawns(state, now);

    // 8. Boundary elimination.
    for (const body of state.bodies.values()) {
      if (!body.alive) continue;
      const distFromOrigin = Math.hypot(body.x, body.y);
      if (distFromOrigin > BUMPER_ARENA_RADIUS) {
        this.eliminate(state, body, undefined, 'boundary');
      }
    }

    // 9. Round-end check.
    const aliveCount = Array.from(state.bodies.values()).filter((b) => b.alive).length;
    if (aliveCount <= 1 || now >= state.endsAt) {
      this.endRound(state, aliveCount <= 1 ? 'last_standing' : 'time_expired');
      return;
    }

    // 10. Snapshot broadcast cadence.
    if (state.tick % BUMPER_TICKS_PER_KEYFRAME === 0) {
      this.broadcastKeyframe(state);
    } else if (state.tick % BUMPER_TICKS_PER_SNAPSHOT === 0) {
      this.broadcastDelta(state);
    }
  }

  // ─── Tick steps ──────────────────────────────────────────────────────

  private applyIntentForTick(state: BumperRoomState, body: BumperBody, dt: number, now: number): void {
    const intent = body.intent;
    if (intent.seq > intent.consumedSeq) {
      intent.consumedSeq = intent.seq;
    }
    // Decode actionBits: bit 0 = use slot 0, bit 1 = use slot 1.
    const actionBits = intent.actionBits;
    if (actionBits & 0b01) this.tryUsePowerUp(state, body, 0, now);
    if (actionBits & 0b10) this.tryUsePowerUp(state, body, 1, now);

    // Build target velocity from dir + thrust.
    const speedMod = body.activeEffects.has('bs-speed-boost') ? 1.4 : 1.0;
    const baseTopSpeed = MAX_SPEED * speedMod;
    let targetVx = 0;
    let targetVy = 0;
    if (intent.dir) {
      const mag = Math.hypot(intent.dir.x, intent.dir.y);
      if (mag > 0) {
        const nx = intent.dir.x / mag;
        const ny = intent.dir.y / mag;
        const t = Math.max(0, Math.min(1, intent.thrust));
        targetVx = nx * t * baseTopSpeed;
        targetVy = ny * t * baseTopSpeed;
      }
    }
    // Lerp toward target velocity bounded by MAX_ACCEL.
    const dvx = targetVx - body.vx;
    const dvy = targetVy - body.vy;
    const dv = Math.hypot(dvx, dvy);
    const maxStep = MAX_ACCEL * dt;
    const scale = dv === 0 ? 0 : Math.min(1, maxStep / dv);
    body.vx += dvx * scale;
    body.vy += dvy * scale;

    // Update facing if there's any direction input.
    if (intent.dir && (intent.dir.x !== 0 || intent.dir.y !== 0)) {
      body.rot = Math.atan2(intent.dir.y, intent.dir.x);
    }
  }

  /**
   * Bot scheduler — invokes each registered controller's `computeInput`
   * once per tick and feeds the result through the SAME `applyInput()`
   * path human inputs use. Controllers see a trimmed `BotRoomView` (no
   * WS handles, no DB refs).
   *
   * Per-tick allocation: one BotRoomView shared across all bots in the
   * room (selfAvatarId is overwritten per-bot before pass-through). Cheap
   * relative to the 60Hz physics step.
   */
  private runBotControllers(state: BumperRoomState, dt: number, now: number): void {
    if (state.botControllers.size === 0) return;
    const sharedView = this.buildBotRoomView(state, '');
    for (const [avatarId, ctrl] of state.botControllers) {
      const body = state.bodies.get(avatarId);
      if (!body || !body.alive || body.forfeited) continue;
      sharedView.selfAvatarId = avatarId;
      sharedView.now = now;
      let intent;
      try {
        intent = ctrl.computeInput(sharedView, dt);
      } catch (err) {
        console.error(`[bumper-shells-sim] bot ${avatarId} computeInput threw:`, err);
        continue;
      }
      const seq = (state.botSeqs.get(avatarId) ?? 0) + 1;
      state.botSeqs.set(avatarId, seq);
      // Feed through applyInput so bots get the same anti-cheat clamps,
      // dt validation, and replay-log capture as humans. Bots have no
      // network latency so dt = 1 tick.
      this.applyInput(state.roomId, avatarId, seq, dt, {
        dir: intent.dir,
        thrust: intent.thrust,
        actionBits: intent.actionBits,
      });
    }
  }

  /**
   * Build a snapshot of room state safe to pass to bot controllers.
   * Inventory + body fields only — no WS, no DB, no mutation handles.
   */
  private buildBotRoomView(state: BumperRoomState, selfAvatarId: string): {
    selfAvatarId: string;
    bodies: Array<{
      avatarId: string;
      x: number;
      y: number;
      vx: number;
      vy: number;
      rot: number;
      alive: boolean;
      inventory: Array<{ kind: BumperPowerUpKind | null; charges: number; cooldownUntil: number }>;
    }>;
    arenaRadius: number;
    now: number;
  } {
    const bodies = Array.from(state.bodies.values()).map((b) => ({
      avatarId: b.avatarId,
      x: b.x,
      y: b.y,
      vx: b.vx,
      vy: b.vy,
      rot: b.rot,
      alive: b.alive,
      inventory: b.inventory.map((slot) => ({
        kind: slot.kind as BumperPowerUpKind | null,
        charges: slot.charges,
        cooldownUntil: slot.cooldownUntil,
      })),
    }));
    return {
      selfAvatarId,
      bodies,
      arenaRadius: BUMPER_ARENA_RADIUS,
      now: Date.now(),
    };
  }

  private integrateMotion(state: BumperRoomState, body: BumperBody, dt: number): void {
    const prev = { x: body.x, y: body.y };
    const prevV = { x: body.vx, y: body.vy };

    // Anti-cheat speed clamp on velocity (defensive — already clamped
    // in applyIntent + collision response, but a knockback-aura might
    // momentarily push higher).
    const velCheck = validateVelocityDelta(prevV, prevV, dt, 1.5);
    if (!velCheck.ok) {
      // Defensive only — we already applied the intent. Just zero a
      // runaway accumulator.
      body.vx = velCheck.value.x;
      body.vy = velCheck.value.y;
    }

    body.x += body.vx * dt;
    body.y += body.vy * dt;

    // Position-delta sanity check (rare, only fires on bug-injected state).
    const posCheck = validatePositionDelta(prev, { x: body.x, y: body.y }, dt, 1.5);
    if (!posCheck.ok) {
      body.x = posCheck.value.x;
      body.y = posCheck.value.y;
      this.flag(state, body.avatarId, 'overspeed', posCheck.detail);
    }

    // Apply mild drag so a coast comes to rest.
    const drag = 0.92;
    body.vx *= drag;
    body.vy *= drag;
  }

  private resolveCollisions(state: BumperRoomState, now: number): void {
    const bodies = Array.from(state.bodies.values()).filter((b) => b.alive && !b.activeEffects.has('bs-ghost'));
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const minDist = BUMPER_BODY_RADIUS * 2;
        if (dist === 0 || dist >= minDist) continue;

        // Separation: push each body half the overlap.
        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        a.x -= nx * overlap * 0.5;
        a.y -= ny * overlap * 0.5;
        b.x += nx * overlap * 0.5;
        b.y += ny * overlap * 0.5;

        // Closing velocity along the collision normal.
        const dvx = a.vx - b.vx;
        const dvy = a.vy - b.vy;
        const closing = dvx * nx + dvy * ny;
        if (Math.abs(closing) < KNOCKBACK_VELOCITY_THRESHOLD) {
          // Below threshold — graze, no event.
          continue;
        }
        // Knockback impulse: scale closing speed by 1.0 baseline; +20%
        // if either body has speed-boost active (per power-up def).
        const aBoost = a.activeEffects.has('bs-speed-boost') ? 1.2 : 1.0;
        const bBoost = b.activeEffects.has('bs-speed-boost') ? 1.2 : 1.0;
        const impulseMag = Math.abs(closing) * 0.5; // half because mirrored

        // Shield absorbs first incoming hit then is consumed.
        const aHasShield = a.activeEffects.has('bs-shell-shield');
        const bHasShield = b.activeEffects.has('bs-shell-shield');

        if (!aHasShield) {
          a.vx -= nx * impulseMag * bBoost / BUMPER_BODY_MASS;
          a.vy -= ny * impulseMag * bBoost / BUMPER_BODY_MASS;
        } else {
          a.activeEffects.delete('bs-shell-shield');
        }
        if (!bHasShield) {
          b.vx += nx * impulseMag * aBoost / BUMPER_BODY_MASS;
          b.vy += ny * impulseMag * aBoost / BUMPER_BODY_MASS;
        } else {
          b.activeEffects.delete('bs-shell-shield');
        }

        // Broadcast event.hit — non-authoritative VFX hint.
        const power = Math.min(1, impulseMag / MAX_SPEED);
        this.broadcastFn(state.roomId, {
          type: 'event.hit',
          srcAvatarId: a.vx * a.vx + a.vy * a.vy > b.vx * b.vx + b.vy * b.vy ? a.avatarId : b.avatarId,
          dstAvatarId: a.vx * a.vx + a.vy * a.vy > b.vx * b.vx + b.vy * b.vy ? b.avatarId : a.avatarId,
          position: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          power,
        });
        // Mark the body as having taken a recent hit — used for elimination credit later.
        // (Kept simple in chunk #3; chunk #7 owns the kill-credit graph for leaderboard.)
        void now;
      }
    }
  }

  private resolvePickups(state: BumperRoomState, now: number): void {
    for (const spawn of state.spawns) {
      if (!spawn.active) continue;
      for (const body of state.bodies.values()) {
        if (!body.alive) continue;
        const dx = body.x - spawn.position.x;
        const dy = body.y - spawn.position.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= BUMPER_BODY_RADIUS + BUMPER_POWERUP_RADIUS) {
          // Place into first empty slot. If both full, drop silently
          // (no flag — this is the "inventory full" UX).
          const slot = body.inventory.findIndex((s) => s.kind === null);
          if (slot >= 0) {
            const def = getPowerUpDef(spawn.kind);
            body.inventory[slot] = {
              kind: spawn.kind,
              charges: 1,
              cooldownUntil: 0,
            };
            void def; // reserved for cooldown tweaks later
            spawn.active = false;
            spawn.collectedAt = now;
            spawn.respawnAt = now + BUMPER_POWERUP_RESPAWN_MS;
            this.broadcastFn(state.roomId, {
              type: 'event.power_up_collected',
              spawnId: spawn.spawnId,
              collectorAvatarId: body.avatarId,
            });
          }
          break; // one body per spawn per tick
        }
      }
    }
  }

  private resolveStickyBombs(state: BumperRoomState, now: number): void {
    state.bombs = state.bombs.filter((bomb) => {
      if (bomb.expiresAt <= now) return false;
      // Check collision with any non-owner body.
      for (const body of state.bodies.values()) {
        if (!body.alive || body.avatarId === bomb.ownerPetId) continue;
        if (body.activeEffects.has('bs-ghost')) continue;
        const dx = body.x - bomb.position.x;
        const dy = body.y - bomb.position.y;
        if (Math.hypot(dx, dy) <= BUMPER_BODY_RADIUS + BUMPER_POWERUP_RADIUS) {
          // 2× knockback away from bomb position.
          const mag = Math.hypot(dx, dy);
          if (mag > 0) {
            const nx = dx / mag;
            const ny = dy / mag;
            const impulse = MAX_SPEED * 0.8;
            body.vx += nx * impulse;
            body.vy += ny * impulse;
          }
          this.broadcastFn(state.roomId, {
            type: 'event.hit',
            srcAvatarId: bomb.ownerPetId,
            dstAvatarId: body.avatarId,
            position: bomb.position,
            power: 1,
          });
          return false; // bomb consumed
        }
      }
      return true;
    });
  }

  private tickSpawns(state: BumperRoomState, now: number): void {
    for (let i = 0; i < state.spawns.length; i++) {
      const spawn = state.spawns[i];
      if (!spawn.active && now >= spawn.respawnAt) {
        // Replace the slot with a fresh roll.
        const next = this.allocSpawn(state);
        state.spawns[i] = next;
        this.broadcastFn(state.roomId, {
          type: 'event.power_up_spawned',
          spawnId: next.spawnId,
          kind: next.kind,
          position: next.position,
        });
      }
    }
  }

  private tryUsePowerUp(state: BumperRoomState, body: BumperBody, slotIndex: number, now: number): void {
    const verdict = validatePowerUpUse(slotIndex, body.inventory, now);
    if (verdict.flagged) {
      this.flag(state, body.avatarId, 'powerup_unowned', verdict.detail);
      return;
    }
    if (!verdict.ok || !verdict.value) return;
    const slot = verdict.value;
    const kind = slot.kind as BumperPowerUpKind;
    const def = getPowerUpDef(kind);

    // Apply effect.
    switch (kind) {
      case 'bs-speed-boost':
      case 'bs-shell-shield':
      case 'bs-ghost':
        body.activeEffects.set(kind, now + def.effectMs);
        break;
      case 'bs-knockback-aura':
        this.applyKnockbackAura(state, body, now);
        break;
      case 'bs-sticky-bomb':
        state.bombs.push({
          bombId: this.uniqueId(state),
          ownerPetId: body.avatarId,
          position: { x: body.x, y: body.y },
          expiresAt: now + def.effectMs,
        });
        break;
      case 'bs-tractor-beam':
        this.applyTractorBeam(state, body);
        break;
    }

    // Consume charge + apply cooldown.
    slot.charges -= 1;
    if (slot.charges <= 0) {
      body.inventory[slotIndex] = { kind: null, charges: 0, cooldownUntil: 0 };
    } else {
      slot.cooldownUntil = now + def.cooldownMs;
    }
  }

  private applyKnockbackAura(state: BumperRoomState, src: BumperBody, now: number): void {
    const radius = 200; // ~2.5wu in scene units; sim uses raw 200wu
    for (const target of state.bodies.values()) {
      if (target.avatarId === src.avatarId || !target.alive) continue;
      if (target.activeEffects.has('bs-ghost')) continue;
      const dx = target.x - src.x;
      const dy = target.y - src.y;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const mag = Math.max(dist, 1);
      const nx = dx / mag;
      const ny = dy / mag;
      const impulse = MAX_SPEED * (1 - dist / radius);
      target.vx += nx * impulse;
      target.vy += ny * impulse;
      this.broadcastFn(state.roomId, {
        type: 'event.hit',
        srcAvatarId: src.avatarId,
        dstAvatarId: target.avatarId,
        position: { x: target.x, y: target.y },
        power: impulse / MAX_SPEED,
      });
    }
    void now;
  }

  private applyTractorBeam(state: BumperRoomState, src: BumperBody): void {
    // Find nearest non-ghost target.
    let best: BumperBody | null = null;
    let bestDist = Infinity;
    for (const t of state.bodies.values()) {
      if (t.avatarId === src.avatarId || !t.alive || t.activeEffects.has('bs-ghost')) continue;
      const d = Math.hypot(t.x - src.x, t.y - src.y);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    if (!best) return;
    // Pull toward nearest arena edge (along the radial of `best.position`).
    const mag = Math.max(Math.hypot(best.x, best.y), 1);
    const nx = best.x / mag;
    const ny = best.y / mag;
    const drag = 320; // 4wu in scene; sim raw 320wu instant impulse
    best.vx += nx * drag;
    best.vy += ny * drag;
    this.broadcastFn(state.roomId, {
      type: 'event.hit',
      srcAvatarId: src.avatarId,
      dstAvatarId: best.avatarId,
      position: { x: best.x, y: best.y },
      power: 1,
    });
  }

  private eliminate(
    state: BumperRoomState,
    body: BumperBody,
    by: string | undefined,
    reason: 'boundary' | 'integrity' | 'timeout' | 'voluntary',
  ): void {
    if (!body.alive) return;
    body.alive = false;
    body.eliminatedAt = Date.now();
    state.eliminationOrder.push(body.avatarId);
    this.broadcastFn(state.roomId, {
      type: 'event.eliminated',
      avatarId: body.avatarId,
      ...(by ? { by } : {}),
    });
    void reason; // chunk #7 reads reason for the leaderboard kill-credit graph
  }

  private endRound(state: BumperRoomState, _reason: 'last_standing' | 'time_expired'): void {
    if (state.ended) return;
    state.ended = true;
    if (state.intervalHandle) {
      clearInterval(state.intervalHandle);
      state.intervalHandle = null;
    }

    // Compute placement for `event.match_ended`. Reward preview is a
    // floor-only stub; chunk #7 reads `activities.reward_config` and
    // produces the authoritative preview sourced from the row it just
    // wrote to `activity_results`.
    const results = this.computeResults(state.roomId);
    const winners = results.map((r) => ({ avatarId: r.avatarId, placement: r.placement }));

    const previewPlacement = winners[0]?.placement ?? 0;
    this.broadcastFn(state.roomId, {
      type: 'event.match_ended',
      reason: 'complete',
      winners,
      rewardPreview: {
        placement: previewPlacement,
        tokens: 0, // chunk #7 owns reward crediting
        leaderboardPoints: 0,
      },
    });

    // The room manager picks up `endRound` via its own LIVE→RESULTS
    // transition trigger — chunk #3 wires `simEndedFn` for that
    // dispatch. Until that wires through (this same chunk), the manager
    // also independently watches the sim state for ended=true via a
    // 250ms poll OR the WS hub forwards a "match-end" signal — we use
    // the explicit registered callback below.
    if (this.endedFn) {
      try {
        this.endedFn(state.roomId);
      } catch (err) {
        console.error('[bumper-shells-sim] endedFn callback threw:', err);
      }
    }
  }

  private endedFn: ((roomId: string) => void) | null = null;
  /**
   * Register a one-shot callback the sim invokes when a room transitions
   * to "ended" — the room manager subscribes here at boot to drive the
   * LIVE→RESULTS FSM transition.
   */
  setEndedFn(fn: (roomId: string) => void): void {
    this.endedFn = fn;
  }

  // ─── Snapshot encoding ─────────────────────────────────────────────────

  private buildSnapshot(state: BumperRoomState): BumperSnapshot {
    return {
      tick: state.tick,
      bodies: Array.from(state.bodies.values()).map((b) => ({
        avatarId: b.avatarId,
        x: this.quant(b.x, POS_QUANT),
        y: this.quant(b.y, POS_QUANT),
        vx: this.quant(b.vx, POS_QUANT),
        vy: this.quant(b.vy, POS_QUANT),
        rot: this.quant(b.rot, ROT_QUANT),
        alive: b.alive,
      })),
      spawns: state.spawns.map((s) => ({
        spawnId: s.spawnId,
        kind: s.kind,
        x: this.quant(s.position.x, POS_QUANT),
        y: this.quant(s.position.y, POS_QUANT),
        active: s.active,
      })),
    };
  }

  private quant(value: number, factor: number): number {
    return Math.round(value * factor) / factor;
  }

  private broadcastKeyframe(state: BumperRoomState): void {
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
          state: b.alive ? 'alive' : 'eliminated',
        })),
        powerUps: snap.spawns
          .filter((s) => s.active)
          .map((s) => ({
            spawnId: s.spawnId,
            kind: s.kind,
            position: { x: s.x, y: s.y },
          })),
        scores: [],
      },
    });
  }

  private broadcastDelta(state: BumperRoomState): void {
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
          p.alive !== b.alive
        );
      })
      .map((b) => ({
        avatarId: b.avatarId,
        seq: snap.tick,
        changed: { x: b.x, y: b.y, vx: b.vx, vy: b.vy, rot: b.rot, state: b.alive ? 'alive' : 'eliminated' },
      }));
    const powerUps = snap.spawns
      .filter((s) => {
        if (!prev) return true;
        const p = prev.spawns.find((q) => q.spawnId === s.spawnId);
        return !p || p.active !== s.active;
      })
      .map((s) => ({
        spawnId: s.spawnId,
        kind: s.kind,
        position: { x: s.x, y: s.y },
      }));
    state.lastSnapshot = snap;
    this.broadcastFn(state.roomId, {
      type: 'snapshot.delta',
      baseSeq: prev?.tick ?? 0,
      seq: snap.tick,
      entities,
      powerUps,
    });
  }

  // ─── Anti-cheat hook ───────────────────────────────────────────────────

  private flag(
    state: BumperRoomState,
    avatarId: string,
    kind: ActivityAntiCheatFlagPayload['kind'],
    detail?: string,
  ): void {
    const reachedThreshold = state.flagCounter.bump(avatarId);
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
    if (reachedThreshold) {
      const body = state.bodies.get(avatarId);
      if (body) {
        body.forfeited = true;
        this.eliminate(state, body, undefined, 'integrity');
      }
      // Hub closes the WS with code 4003 — see hub for the dispatch.
      if (this.integrityForfeitFn) {
        try {
          this.integrityForfeitFn(state.roomId, avatarId);
        } catch (err) {
          console.error('[bumper-shells-sim] integrityForfeitFn threw:', err);
        }
      }
    }
    void FLAG_FORFEIT_THRESHOLD;
  }

  private integrityForfeitFn: ((roomId: string, avatarId: string) => void) | null = null;
  setIntegrityForfeitFn(fn: (roomId: string, avatarId: string) => void): void {
    this.integrityForfeitFn = fn;
  }

  // ─── Spawn alloc + RNG ─────────────────────────────────────────────────

  private allocSpawn(state: BumperRoomState): BumperSpawn {
    const kind = this.rollPowerUpKind(state);
    // Random position inside the inner 70% of the arena to keep pickups
    // off the danger ring.
    const r = (this.lcgNext(state) % 1000) / 1000 * (BUMPER_ARENA_RADIUS * 0.7);
    const angle = (this.lcgNext(state) % 1000) / 1000 * Math.PI * 2;
    return {
      spawnId: this.uniqueId(state),
      kind,
      position: { x: Math.cos(angle) * r, y: Math.sin(angle) * r },
      collectedAt: null,
      respawnAt: 0,
      active: true,
    };
  }

  private rollPowerUpKind(state: BumperRoomState): BumperPowerUpKind {
    // Total weight from the catalog defs.
    const total = BUMPER_POWERUP_DEFS.reduce((s, d) => s + d.weight, 0);
    const roll = (this.lcgNext(state) % total);
    let acc = 0;
    for (const def of BUMPER_POWERUP_DEFS) {
      acc += def.weight;
      if (roll < acc) return def.kind;
    }
    return BUMPER_POWERUP_KINDS[0]; // unreachable
  }

  private lcgNext(state: BumperRoomState): number {
    // Numerical Recipes LCG — adequate for spawn positions, not crypto.
    state.rngState = (state.rngState * 1664525 + 1013904223) >>> 0;
    return state.rngState;
  }

  private uniqueId(state: BumperRoomState): string {
    return `${state.roomId.slice(0, 8)}-${state.tick}-${this.lcgNext(state).toString(36)}`;
  }

  private deriveSeedFromRoomId(roomId: string): number {
    let h = 5381;
    for (let i = 0; i < roomId.length; i++) {
      h = ((h << 5) + h + roomId.charCodeAt(i)) >>> 0;
    }
    return h || 1;
  }
}

function emptyInventory(): PowerUpInventorySlot[] {
  const out: PowerUpInventorySlot[] = [];
  for (let i = 0; i < MAX_POWER_UP_SLOTS; i++) {
    out.push({ kind: null, charges: 0, cooldownUntil: 0 });
  }
  return out;
}

export const bumperShellsSim = new BumperShellsSim();
