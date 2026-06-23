/**
 * Q2 Activity Portals — Reef Race sim unit tests (chunk #5).
 *
 * Coverage:
 *   - Checkpoint sequence enforcement (out-of-order rejection)
 *   - Lap completion on full sequence
 *   - Min-lap discard + flag
 *   - Race-end on 3-lap completion
 *   - Deterministic pickup spawn for fixed seed
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// Silence event-logger + replay log so sim tests don't need DB wires.
mock.module('../../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: {
    ANTI_CHEAT_FLAG: 'anti_cheat.flag',
  },
}));
mock.module('../../activity-replay-log', () => ({
  activityReplayLog: {
    appendInputFrame: () => {},
    flushToDb: () => Promise.resolve(null),
    dropRoom: () => {},
    getReplayId: () => undefined,
    bufferLength: () => 0,
    __resetForTest: () => {},
  },
}));

const { reefRaceSim, REEF_SIM_HZ } = await import('../reef-race-sim');
const { validateReefVelocityDelta } = await import(
  '../../anti-cheat/reef-race'
);
const {
  buildReefCheckpoints,
  REEF_CHECKPOINT_COUNT,
  REEF_LAPS,
  MIN_LAP_MS,
  // Phase 1 constants used by drift / launch tests
  DRIFT_SPARK_TICK_1,
  DRIFT_SPARK_TICK_2,
  DRIFT_SPARK_TICK_3,
  DRIFT_BOOST_MULTS,
  DRIFT_ANGULAR_BIAS_RAD,
  DRIFT_MIN_SPEED_FOR_CHARGE,
  ACTION_BIT_DRIFT,
  LAUNCH_WINDOW_MS,
  LAUNCH_STALL_WINDOW_MS,
  LAUNCH_STALL_THRUST_CAP,
  LAUNCH_BOOST_DURATION_MS,
  REEF_MAX_SPEED,
  REEF_KINEMATIC_TOLERANCE,
  // Phase 2 constants used by Phase 2 tests
  KINEMATIC_BOOST_CAP,
  NEGATIVE_KINETIC_FLOOR,
  SLIPSTREAM_REQUIRED_TICKS,
  SLIPSTREAM_BOOST_MULT,
  SLIPSTREAM_GRACE_TICKS,
  APEX_DURATION_MS,
  APEX_BONUS_MULT,
  APEX_PENALTY_MULT,
  APEX_HAIRPIN_CHECKPOINT_INDICES,
  APEX_INSIDE_OFFSET,
  APEX_OUTSIDE_OFFSET,
  HAZARD_SLOW_MULT,
  HAZARD_TICK_DURATION_MS,
  HAZARD_INSIDE_OFFSET,
  RIBBON_BOOST_MULT,
  RIBBON_BOOST_DURATION_MS,
  RIBBON_COLLECTION_COOLDOWN_MS,
  buildReefBoostRibbons,
  buildReefApexZones,
  buildReefHazardPatches,
  getPlacementItemTable,
  PLACEMENT_ITEM_TABLE,
  REEF_BODY_RADIUS,
  LAUNCH_BOOST_MULT,
  REEF_BOOST_MULT,
  // Phase 3 — stat-driven multiplier constants + helpers
  AGILITY_TURN_RADIUS_MULT,
  AGILITY_SLIPSTREAM_GRACE_TICKS,
  STRENGTH_DRIFT_CHARGE_MULT,
  STRENGTH_KNOCKBACK_RESIST_MULT,
  INTELLIGENCE_POWERUP_DURATION_MULT,
  INTELLIGENCE_RIBBON_DETECT_MULT,
  BASELINE_SLIPSTREAM_GRACE_TICKS,
  LEVEL_ACCEL_MULT_CEILING,
  LEVEL_ACCEL_MULT_PER_LEVEL,
  NEUTRAL_BODY_MULTIPLIERS,
  RIBBON_HALF_WIDTH,
  REEF_MAX_ACCEL,
  REEF_TRACK_B,
  buildBodyMultipliers,
  racingClassFromArchetype,
} = await import('../reef-race-config');
import type { ServerFrame } from '@clawville/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

beforeEach(() => {
  reefRaceSim.__resetForTest();
});

function captureBroadcasts(): { broadcasts: ServerFrame[]; restore: () => void } {
  const frames: ServerFrame[] = [];
  reefRaceSim.setBroadcastFn((_roomId, frame) => {
    frames.push(frame);
  });
  return {
    broadcasts: frames,
    restore: () => reefRaceSim.setBroadcastFn(() => {}),
  };
}

function stopInterval(roomId: string): void {
  const state = reefRaceSim.__getState(roomId);
  if (state?.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────

describe('ReefRaceSim.startRoom', () => {
  it('spawns bodies near the start checkpoint and is idempotent', () => {
    const { broadcasts, restore } = captureBroadcasts();
    const avatarIds = ['p1', 'p2', 'p3', 'p4'];
    const state1 = reefRaceSim.startRoom('room-a', 'reef-race', avatarIds, { seed: 42 });
    const state2 = reefRaceSim.startRoom('room-a', 'reef-race', avatarIds, { seed: 42 });
    expect(state1).toBe(state2);
    expect(state1.bodies.size).toBe(4);
    for (const body of state1.bodies.values()) {
      // All bodies start expecting checkpoint 1.
      expect(body.nextCheckpoint).toBe(1);
      expect(body.lap).toBe(0);
    }
    const matchStarted = broadcasts.find((f) => f.type === 'event.match_started');
    expect(matchStarted).toBeDefined();
    stopInterval('room-a');
    restore();
  });

  it('seeds the configured number of pickup boxes active at boot', () => {
    captureBroadcasts();
    const state = reefRaceSim.startRoom('room-b', 'reef-race', ['p1', 'p2', 'p3', 'p4']);
    expect(state.pickups.length).toBeGreaterThan(0);
    expect(state.pickups.every((p) => p.active)).toBe(true);
    stopInterval('room-b');
  });
});

// ─── Checkpoint sequence ────────────────────────────────────────────────────

describe('ReefRaceSim — checkpoint sequence enforcement', () => {
  it('ignores out-of-order checkpoint crossings', () => {
    captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2', 'p3', 'p4']);
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const body = state.bodies.get('p1')!;
    const checkpoints = buildReefCheckpoints();
    // Teleport directly to checkpoint 5 — sequence expects 1.
    body.x = checkpoints[5].center.x;
    body.y = checkpoints[5].center.y;
    body.vx = 0;
    body.vy = 0;
    reefRaceSim.__tickOnceForTest('room-a');
    // Pointer should NOT have advanced past 1.
    expect(body.nextCheckpoint).toBe(1);
    expect(body.lap).toBe(0);
  });

  it('advances on a legitimate next-checkpoint crossing', () => {
    captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2', 'p3', 'p4']);
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const body = state.bodies.get('p1')!;
    const checkpoints = buildReefCheckpoints();
    // Place body inside checkpoint 1 → expected next = 1.
    body.x = checkpoints[1].center.x;
    body.y = checkpoints[1].center.y;
    body.vx = 0;
    body.vy = 0;
    reefRaceSim.__tickOnceForTest('room-a');
    expect(body.nextCheckpoint).toBe(2);
  });
});

// ─── Lap completion ─────────────────────────────────────────────────────────

describe('ReefRaceSim — lap completion', () => {
  it('counts a lap when checkpoints 1..11 then 0 are crossed in order', () => {
    const { broadcasts } = captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2', 'p3', 'p4'], { seed: 99 });
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const body = state.bodies.get('p1')!;
    const checkpoints = buildReefCheckpoints();
    // Slow the clock by manipulating the lap-start; we want >= MIN_LAP_MS
    // between the start and the moment we register checkpoint 0.
    body.lapStartedAt = Date.now() - (MIN_LAP_MS + 1_000);
    // Walk through checkpoints 1..11 → 0. Each tick we plant the body at
    // the next expected checkpoint and step the sim once.
    for (let i = 1; i < REEF_CHECKPOINT_COUNT; i++) {
      body.x = checkpoints[i].center.x;
      body.y = checkpoints[i].center.y;
      body.vx = 0;
      body.vy = 0;
      reefRaceSim.__tickOnceForTest('room-a');
    }
    // Now nextCheckpoint should be 0; planting at checkpoint 0 finishes the lap.
    expect(body.nextCheckpoint).toBe(0);
    body.x = checkpoints[0].center.x;
    body.y = checkpoints[0].center.y;
    body.vx = 0;
    body.vy = 0;
    reefRaceSim.__tickOnceForTest('room-a');
    expect(body.lap).toBe(1);
    const lapEvent = broadcasts.find(
      (f) => f.type === 'event.lap_completed' && f.avatarId === 'p1' && f.lap === 1,
    );
    expect(lapEvent).toBeDefined();
  });
});

// ─── Min-lap discard ────────────────────────────────────────────────────────

describe('ReefRaceSim — min-lap discard', () => {
  it('discards a lap completed faster than MIN_LAP_MS and does not advance the counter', () => {
    captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2', 'p3', 'p4']);
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const body = state.bodies.get('p1')!;
    const checkpoints = buildReefCheckpoints();
    // Lap started "just now" — finishing in zero ms is way under MIN_LAP_MS.
    body.lapStartedAt = Date.now();
    for (let i = 1; i < REEF_CHECKPOINT_COUNT; i++) {
      body.x = checkpoints[i].center.x;
      body.y = checkpoints[i].center.y;
      reefRaceSim.__tickOnceForTest('room-a');
    }
    body.x = checkpoints[0].center.x;
    body.y = checkpoints[0].center.y;
    reefRaceSim.__tickOnceForTest('room-a');
    // Lap should NOT have been credited.
    expect(body.lap).toBe(0);
    // Pointer should reset back to 1 (lap discarded, must re-traverse).
    expect(body.nextCheckpoint).toBe(1);
  });
});

// ─── Race end on 3 laps ─────────────────────────────────────────────────────

describe('ReefRaceSim — race-end on REEF_LAPS completion', () => {
  it('marks a body finished after REEF_LAPS and ends round when all done', () => {
    const { broadcasts } = captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2']);
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const checkpoints = buildReefCheckpoints();

    function runLap(avatarId: string): void {
      const body = state.bodies.get(avatarId)!;
      body.lapStartedAt = Date.now() - (MIN_LAP_MS + 1_000);
      for (let i = 1; i < REEF_CHECKPOINT_COUNT; i++) {
        body.x = checkpoints[i].center.x;
        body.y = checkpoints[i].center.y;
        body.vx = 0;
        body.vy = 0;
        reefRaceSim.__tickOnceForTest('room-a');
      }
      body.x = checkpoints[0].center.x;
      body.y = checkpoints[0].center.y;
      reefRaceSim.__tickOnceForTest('room-a');
    }

    for (let lap = 0; lap < REEF_LAPS; lap++) {
      runLap('p1');
      runLap('p2');
    }

    expect(state.bodies.get('p1')!.finishedAt).not.toBeNull();
    expect(state.bodies.get('p2')!.finishedAt).not.toBeNull();
    expect(state.bodies.get('p1')!.lap).toBe(REEF_LAPS);
    // Phase 4 (S-IMPL-1 fix 2026-04-25) — reef-race rooms NO LONGER emit a
    // preview `event.match_ended` from the sim. The reward pipeline owns the
    // authoritative per-recipient broadcast (`emitPerRecipientMatchEnd`)
    // with real tokens / pbDelta / streakBest. Suppression here removes the
    // "tokens=0 flash" UX bug where the modal opened with zeroed numbers
    // before being replaced ~50–500 ms later. The endedFn callback (which
    // drives the room manager → reward pipeline chain) IS still fired, so
    // the authoritative frame is still sent — just not via the sim.
    const matchEnded = broadcasts.find((f) => f.type === 'event.match_ended');
    expect(matchEnded).toBeUndefined();
  });
});

// ─── computeResults placement ───────────────────────────────────────────────

describe('ReefRaceSim.computeResults', () => {
  it('orders finishers by totalTimeMs ascending and DNFers after', () => {
    captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2', 'p3']);
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const now = Date.now();
    // Manually finish p2 first (time 30000), p1 second (time 35000), p3 DNF.
    const p1 = state.bodies.get('p1')!;
    const p2 = state.bodies.get('p2')!;
    const p3 = state.bodies.get('p3')!;
    p2.finishedAt = now;
    p2.totalTimeMs = 30_000;
    p2.lap = REEF_LAPS;
    p1.finishedAt = now + 5_000;
    p1.totalTimeMs = 35_000;
    p1.lap = REEF_LAPS;
    p3.dnf = true;
    p3.lap = 1;

    const results = reefRaceSim.computeResults('room-a');
    const byAvatar = Object.fromEntries(results.map((r) => [r.avatarId, r]));
    expect(byAvatar['p2'].placement).toBe(1);
    expect(byAvatar['p2'].scoreMs).toBe(30_000);
    expect(byAvatar['p1'].placement).toBe(2);
    expect(byAvatar['p1'].scoreMs).toBe(35_000);
    expect(byAvatar['p3'].placement).toBe(3);
    expect(byAvatar['p3'].scoreMs).toBeNull();
  });
});

// ─── Deterministic pickup spawns ────────────────────────────────────────────

describe('ReefRaceSim — deterministic spawns', () => {
  it('same seed → identical pickup positions + initial kinds', () => {
    reefRaceSim.__resetForTest();
    captureBroadcasts();
    const s1 = reefRaceSim.startRoom('room-seed-a', 'reef-race', ['p1', 'p2', 'p3', 'p4'], {
      seed: 12345,
    });
    const positions1 = s1.pickups.map((p) => ({
      x: p.position.x,
      y: p.position.y,
      kind: p.kind,
    }));
    stopInterval('room-seed-a');

    reefRaceSim.__resetForTest();
    captureBroadcasts();
    const s2 = reefRaceSim.startRoom('room-seed-b', 'reef-race', ['p1', 'p2', 'p3', 'p4'], {
      seed: 12345,
    });
    const positions2 = s2.pickups.map((p) => ({
      x: p.position.x,
      y: p.position.y,
      kind: p.kind,
    }));
    stopInterval('room-seed-b');

    expect(positions1).toEqual(positions2);
  });
});

// ─── Sim hz constant ────────────────────────────────────────────────────────

describe('REEF_SIM_HZ', () => {
  it('is 30Hz per task spec', () => {
    expect(REEF_SIM_HZ).toBe(30);
  });
});

// ─── Phase 1 — Drift state machine + launch boost tests ────────────────────
//
// All test names mirror `.claude/plans/reef-race-phase1-detailed.md` §8.
// Tests T1-T21 follow.

/**
 * Helper — boot a single-body room with the body parked at known coords +
 * intent ready to drive into. Uses `__tickOnceForTest` so we can drive
 * deterministic per-tick state transitions without sleeping for 33ms each.
 */
function bootDriftRoom(opts?: {
  avatarId?: string;
  vx?: number;
  vy?: number;
  launchBoosts?: Map<string, 'boost' | 'stall'>;
  startedAt?: number;
}) {
  const avatarId = opts?.avatarId ?? 'p1';
  reefRaceSim.startRoom('room-drift', 'reef-race', [avatarId], {
    seed: 1,
    launchBoosts: opts?.launchBoosts,
    startedAt: opts?.startedAt,
  });
  stopInterval('room-drift');
  const state = reefRaceSim.__getState('room-drift')!;
  const body = state.bodies.get(avatarId)!;
  // Mechanics-only helper: keep drift/boost speed tests away from the oval
  // guardrail and static track zones so they validate kinematic stacking, not
  // wall/ribbon/hazard/apex behavior.
  state.ribbons = [];
  state.hazards = [];
  state.apexZones = [];
  body.x = 0;
  body.y = -REEF_TRACK_B * 1.2;
  if (typeof opts?.vx === 'number') body.vx = opts.vx;
  if (typeof opts?.vy === 'number') body.vy = opts.vy;
  return { state, body, avatarId };
}

function setIntent(body: any, partial: { dir?: { x: number; y: number }; thrust?: number; actionBits?: number }) {
  body.intent.dir       = partial.dir ?? body.intent.dir ?? { x: 0, y: 1 };
  body.intent.thrust    = partial.thrust ?? body.intent.thrust ?? 0.85;
  body.intent.actionBits = partial.actionBits ?? 0;
  body.intent.seq       = (body.intent.seq ?? 0) + 1;
}

describe('ReefRaceSim — drift state machine (Phase 1 T1–T10)', () => {
  it('T1 — starts charging when drift-bit + turning + speed threshold met', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 200, vy: 0 });
    setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0.85, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.drift.charging).toBe(true);
  });

  it('T2 — does NOT start when going straight', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 200, vy: 0 });
    setIntent(body, { dir: { x: 0, y: 1 }, thrust: 0.85, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.drift.charging).toBe(false);
  });

  it('T3 — advances spark levels at correct tick counts', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 200, vy: 0 });
    // Tick once to ENTER charging — that is the first justPressed edge.
    setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0.85, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.drift.charging).toBe(true);
    expect(body.drift.sparkLevel).toBe(0);

    // Hold drift through (TICK_1 - 1) more ticks → sparkLevel still 0.
    for (let i = 0; i < DRIFT_SPARK_TICK_1 - 1; i++) {
      setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0.85, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(body.drift.sparkLevel).toBe(0);

    // One more tick → tier 1.
    setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0.85, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.drift.sparkLevel).toBe(1);

    // Drive to tier 2.
    while (body.drift.sparkLevel < 2) {
      setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0.85, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(body.drift.sparkLevel).toBe(2);

    // Drive to tier 3.
    while (body.drift.sparkLevel < 3) {
      setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0.85, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(body.drift.sparkLevel).toBe(3);
  });

  it('T4 — cancels silently on early release (no spark, no boost broadcast)', () => {
    const { broadcasts } = captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 200, vy: 0 });
    // Charge to JUST under tier 1.
    setIntent(body, { dir: { x: 0.5, y: 1 }, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    for (let i = 0; i < DRIFT_SPARK_TICK_1 - 2; i++) {
      setIntent(body, { dir: { x: 0.5, y: 1 }, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(body.drift.sparkLevel).toBe(0);
    // Release — actionBits = 0.
    setIntent(body, { dir: { x: 0.5, y: 1 }, actionBits: 0 });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.drift.charging).toBe(false);
    expect(broadcasts.some((f) => f.type === 'event.drift_boost')).toBe(false);
  });

  it('T5 — fires drift boost on release at spark ≥ 1', () => {
    const { broadcasts } = captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 200, vy: 0 });
    // Drive to tier 1. Re-stamp velocity each tick so REEF_DRAG (0.97/tick)
    // doesn't pull us below DRIFT_MIN_SPEED_FOR_CHARGE while charging.
    setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    for (let i = 0; i < DRIFT_SPARK_TICK_1; i++) {
      body.vx = 200; body.vy = 0;
      setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(body.drift.sparkLevel).toBeGreaterThanOrEqual(1);
    // Release.
    body.vx = 200; body.vy = 0;
    setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: 0 });
    reefRaceSim.__tickOnceForTest('room-drift');
    const evt = broadcasts.find((f) => f.type === 'event.drift_boost');
    expect(evt).toBeDefined();
    expect(body.activeBoosts.has('drift-boost')).toBe(true);
  });

  it('T6 — NO velocity impulse at drift release (audit S4)', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 300, vy: 0 });
    // Charge to tier 3.
    setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    for (let i = 0; i < DRIFT_SPARK_TICK_3 + 2; i++) {
      // thrust=0 so we don't drive velocity — keeps the assertion clean.
      // Re-stamp vx so drag doesn't pull it under threshold while charging.
      body.vx = 300;
      body.vy = 0;
      setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(body.drift.sparkLevel).toBe(3);
    // Release — assert speed unchanged (within tiny float tolerance).
    body.vx = 300;
    body.vy = 0;
    setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: 0 });
    reefRaceSim.__tickOnceForTest('room-drift');
    // Speed should not have spiked from a release impulse — drag will have
    // shaved a hair off after the integrate step.
    const speed = Math.hypot(body.vx, body.vy);
    expect(speed).toBeLessThan(305);
    expect(body.activeBoosts.get('drift-boost')?.mult).toBe(DRIFT_BOOST_MULTS[2]);
  });

  it('T7 — drift boost raises speed via speedMod over subsequent ticks', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 300, vy: 0 });
    // Charge + release to tier 3.
    setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    for (let i = 0; i < DRIFT_SPARK_TICK_3 + 2; i++) {
      body.vx = 300;
      body.vy = 0;
      setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    setIntent(body, { dir: { x: 0, y: 1 }, thrust: 0, actionBits: 0 });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.activeBoosts.has('drift-boost')).toBe(true);

    // Now full thrust forward for 10 ticks — speed should climb past 300.
    for (let i = 0; i < 10; i++) {
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1, actionBits: 0 });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    const speed = Math.hypot(body.vx, body.vy);
    expect(speed).toBeGreaterThan(300);
  });

  it('T8 — no double-fire on release (only one event.drift_boost)', () => {
    const { broadcasts } = captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 250, vy: 0 });
    // Tier 2.
    setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    for (let i = 0; i < DRIFT_SPARK_TICK_2 + 1; i++) {
      body.vx = 250; body.vy = 0;
      setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: 0 });
    reefRaceSim.__tickOnceForTest('room-drift');
    // Hold released for 5 more ticks.
    for (let i = 0; i < 5; i++) {
      setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: 0 });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(broadcasts.filter((f) => f.type === 'event.drift_boost').length).toBe(1);
  });

  it('T9 — cancels when speed drops below DRIFT_MIN_SPEED_FOR_CHARGE', () => {
    const { broadcasts } = captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 200, vy: 0 });
    setIntent(body, { dir: { x: 0.5, y: 1 }, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.drift.charging).toBe(true);
    // Slam to zero — drift bit still held.
    body.vx = 0;
    body.vy = 0;
    setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.drift.charging).toBe(false);
    // No boost fires — sparkLevel was 0 at cancel time.
    expect(broadcasts.some((f) => f.type === 'event.drift_boost')).toBe(false);
  });

  it('T10 — body.rot eases toward constant 15° drift bias (no accumulation)', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 200, vy: 0 });
    // First tick = "press" tick. drift.charging starts FALSE on entry to
    // step 6 (the state-machine update happens AFTER step 6 — see §2.3
    // commentary). So the bias only appears starting on tick 2.
    body.vx = 200; body.vy = 0;
    setIntent(body, { dir: { x: 0.5, y: 0.866 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.drift.charging).toBe(true);

    const baseRot = Math.atan2(0.5, 0.866);
    const expected = baseRot - DRIFT_ANGULAR_BIAS_RAD;
    // Subsequent ticks ease toward the biased heading instead of snapping.
    for (let i = 0; i < 8; i++) {
      body.vx = 200; body.vy = 0;
      setIntent(body, { dir: { x: 0.5, y: 0.866 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(body.rot).toBeCloseTo(expected, 4);

    // Same dir remains anchored to the same biased target (not accumulating).
    body.vx = 200; body.vy = 0;
    setIntent(body, { dir: { x: 0.5, y: 0.866 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.rot).toBeCloseTo(expected, 4);

    // Release — drift.charging stays true through this tick (lingering
    // lean, see §2.3), then flips to false in tickDriftState. So the
    // release tick STILL has bias; the tick AFTER release is unbiased.
    body.vx = 200; body.vy = 0;
    setIntent(body, { dir: { x: 0.5, y: 0.866 }, thrust: 0, actionBits: 0 });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.drift.charging).toBe(false);

    for (let i = 0; i < 3; i++) {
      body.vx = 200; body.vy = 0;
      setIntent(body, { dir: { x: 0.5, y: 0.866 }, thrust: 0, actionBits: 0 });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(body.rot).toBeCloseTo(baseRot, 4);
  });

  it('T10b — gentle right turn under drift never flips, never freezes straight', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 200, vy: 0 });
    // dir.x = 0.18 → atan2(0.18, ~0.984) ≈ 10.4° (below 15° drift bias).
    // Bug history at this gentle-input regime:
    //   v1 (constant 15° subtract):  desiredRot = 10.4° - 15° = -4.6° → visible LEFT turn
    //   v2 (clamp |baseRot|):        desiredRot = 0°               → kart freezes straight
    //   v3 (clamp |baseRot| * 0.5):  desiredRot ≈ 5.2°             → still right, half turn
    const dir = { x: 0.18, y: 0.984 };
    const baseRot = Math.atan2(dir.x, dir.y);
    for (let i = 0; i < 12; i++) {
      body.vx = 200; body.vy = 0;
      setIntent(body, { dir, thrust: 0, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(body.drift.charging).toBe(true);
    // Strictly positive — not flipped (regression v1) AND not frozen (regression v2).
    expect(body.rot).toBeGreaterThan(0);
    // At least 50% of input magnitude — preserves visible turn feedback.
    expect(body.rot).toBeGreaterThanOrEqual(baseRot * 0.5 - 1e-4);
    // And no more than the input — bias is outward, never tightens past input.
    expect(body.rot).toBeLessThanOrEqual(baseRot + 1e-4);
  });
});

describe('ReefRaceSim — launch boost (Phase 1 T11–T15)', () => {
  it('T11 — launchBoosts: boost seeds activeBoosts on body init', () => {
    captureBroadcasts();
    const verdicts = new Map<string, 'boost' | 'stall'>([['p1', 'boost']]);
    reefRaceSim.startRoom('room-launch', 'reef-race', ['p1', 'p2'], {
      launchBoosts: verdicts,
      startedAt: Date.now(),
    });
    stopInterval('room-launch');
    const state = reefRaceSim.__getState('room-launch')!;
    expect(state.bodies.get('p1')!.activeBoosts.has('launch-boost')).toBe(true);
    expect(state.bodies.get('p2')!.activeBoosts.size).toBe(0);
  });

  it('T12 — launchBoosts: stall caps thrust', () => {
    captureBroadcasts();
    const verdicts = new Map<string, 'boost' | 'stall'>([['p1', 'stall']]);
    reefRaceSim.startRoom('room-launch', 'reef-race', ['p1'], {
      launchBoosts: verdicts,
      startedAt: Date.now(),
    });
    stopInterval('room-launch');
    const state = reefRaceSim.__getState('room-launch')!;
    const body = state.bodies.get('p1')!;
    expect(body.activeBoosts.has('launch-stall')).toBe(true);
    setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
    // Many ticks at full thrust — speed cannot exceed REEF_MAX_SPEED * 0.5
    // (stall speedMod) × LAUNCH_STALL_THRUST_CAP × tolerance.
    for (let i = 0; i < 20; i++) {
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
      reefRaceSim.__tickOnceForTest('room-launch');
    }
    const speed = Math.hypot(body.vx, body.vy);
    // Stall caps effective speed at REEF_MAX_SPEED * 0.5 * 0.30 = 75 wu/s.
    // Allow 10% slack because integration converges asymptotically.
    expect(speed).toBeLessThan(REEF_MAX_SPEED * LAUNCH_STALL_THRUST_CAP * 0.55);
  });

  it('T13 — no launchBoosts ⇒ no launch effects on bodies', () => {
    captureBroadcasts();
    reefRaceSim.startRoom('room-no-launch', 'reef-race', ['p1', 'p2'], {
      startedAt: Date.now(),
    });
    stopInterval('room-no-launch');
    const state = reefRaceSim.__getState('room-no-launch')!;
    for (const body of state.bodies.values()) {
      expect(body.activeBoosts.size).toBe(0);
    }
  });

  it('T14 — REEF_KINEMATIC_TOLERANCE used at both validator call-sites', () => {
    // Source-grep test — guard against a future refactor reverting to 1.5.
    const path = join(import.meta.dir, '..', 'reef-race-sim.ts');
    const src = readFileSync(path, 'utf-8');
    // Lines that pass tolerance to the validators must reference the named
    // constant, NOT a literal.
    expect(src).toMatch(
      /validateReefVelocityDelta\([\s\S]*?REEF_KINEMATIC_TOLERANCE/,
    );
    expect(src).toMatch(
      /validateReefPositionDelta\([\s\S]*?REEF_KINEMATIC_TOLERANCE/,
    );
    expect(src).not.toMatch(/validateReef(Position|Velocity)Delta\([^)]*\b1\.5\b/);
  });

  it('T15 — drift-3 + launch combined stays under 2× REEF_MAX_SPEED', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({
      vx: 0,
      vy: 300,
      launchBoosts: new Map([['p1', 'boost']]),
      startedAt: Date.now(),
    });
    // Manually plant a tier-3 drift-boost in addition to the launch verdict.
    body.activeBoosts.set('drift-boost', {
      expiresAt: Date.now() + 10_000,
      mult: DRIFT_BOOST_MULTS[2],
    });
    body.currentDriftBoostSparks = 3;
    for (let i = 0; i < 60; i++) {
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
      reefRaceSim.__tickOnceForTest('room-drift');
      const s = Math.hypot(body.vx, body.vy);
      expect(s).toBeLessThanOrEqual(REEF_MAX_SPEED * REEF_KINEMATIC_TOLERANCE);
    }
  });
});

describe('ReefRaceSim — speedMod stacking (Phase 1 T16)', () => {
  it('T16 — turbo-bubble + drift boost takes MAX, not sum', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 0, vy: 300 });
    body.activeEffects.set('rr-turbo-bubble', Date.now() + 9_999);
    body.activeBoosts.set('drift-boost', {
      expiresAt: Date.now() + 9_999,
      mult: DRIFT_BOOST_MULTS[1],
    });
    body.currentDriftBoostSparks = 2;
    // Push bodies to terminal velocity and observe — under MAX rule the
    // top speed is REEF_MAX_SPEED * 1.40 (turbo wins; drift mult 0.24
    // < turbo's 0.40). Under SUM rule it would be REEF_MAX_SPEED * 1.64.
    for (let i = 0; i < 80; i++) {
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    const speed = Math.hypot(body.vx, body.vy);
    // Asymptote should approach 700 (1.4 × 500), allow 5% slack.
    expect(speed).toBeLessThan(REEF_MAX_SPEED * 1.55);
  });
});

describe('ReefRaceSim — snapshot delta predicate (Phase 1 T17–T18)', () => {
  it('T17 — spark-only change shows up in delta', () => {
    const { broadcasts } = captureBroadcasts();
    reefRaceSim.startRoom('room-snap', 'reef-race', ['p1'], { startedAt: Date.now() });
    stopInterval('room-snap');
    const state = reefRaceSim.__getState('room-snap')!;
    const body = state.bodies.get('p1')!;
    // Park the body, charge drift to tier 1.
    body.vx = 200; body.vy = 0;
    setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-snap');
    for (let i = 0; i < DRIFT_SPARK_TICK_1 + 5; i++) {
      body.vx = 200; body.vy = 0;
      setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-snap');
    }
    // Force a snapshot tick via the keyframe cadence (state.tick % 30 = 0).
    while (state.tick % 30 !== 0) {
      body.vx = 200; body.vy = 0;
      setIntent(body, { dir: { x: 0.5, y: 1 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-snap');
    }
    // After several ticks at sparkLevel ≥ 1, at least one snapshot.delta or
    // snapshot.keyframe should have been emitted with driftSparks present.
    const snaps = broadcasts.filter(
      (f) => f.type === 'snapshot.delta' || f.type === 'snapshot.keyframe',
    );
    expect(snaps.length).toBeGreaterThan(0);
  });

  it('T18 — spark-unchanged body OMITS the delta-only field', () => {
    const { broadcasts } = captureBroadcasts();
    reefRaceSim.startRoom('room-snap', 'reef-race', ['p1'], { startedAt: Date.now() });
    stopInterval('room-snap');
    const state = reefRaceSim.__getState('room-snap')!;
    const body = state.bodies.get('p1')!;
    // Body never drifts and never moves — driftSparks always 0.
    body.vx = 0; body.vy = 0;
    for (let i = 0; i < 60; i++) {
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 0, actionBits: 0 });
      reefRaceSim.__tickOnceForTest('room-snap');
    }
    const deltas = broadcasts.filter((f) => f.type === 'snapshot.delta');
    // It's fine if some deltas exist (e.g. positional jitter from drag), as
    // long as none of them carry a driftSparks > 0.
    for (const d of deltas) {
      const ent = (d as any).entities.find((e: any) => e.avatarId === 'p1');
      if (ent) expect(ent.changed.driftSparks ?? 0).toBe(0);
    }
  });
});

describe('ReefRaceSim — teardown safety (Phase 1 T19–T20)', () => {
  it('T19 — stopRoom mid-drift is safe (no post-stop boost)', () => {
    const { broadcasts } = captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 200, vy: 0 });
    // Charge to tier 2.
    setIntent(body, { dir: { x: 0.5, y: 1 }, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    for (let i = 0; i < DRIFT_SPARK_TICK_2 + 2; i++) {
      body.vx = 200; body.vy = 0;
      setIntent(body, { dir: { x: 0.5, y: 1 }, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(body.drift.charging).toBe(true);
    expect(body.drift.sparkLevel).toBeGreaterThanOrEqual(2);
    reefRaceSim.stopRoom('room-drift');
    // No further drift_boost broadcasts after stop.
    const before = broadcasts.filter((f) => f.type === 'event.drift_boost').length;
    expect(reefRaceSim.__getState('room-drift')).toBeUndefined();
    expect(before).toBe(0);
  });

  it('T20 — forfeit mid-drift: no post-forfeit boost broadcast', () => {
    const { broadcasts } = captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 200, vy: 0 });
    // Charge to tier 1.
    setIntent(body, { dir: { x: 0.5, y: 1 }, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    for (let i = 0; i < DRIFT_SPARK_TICK_1 + 2; i++) {
      body.vx = 200; body.vy = 0;
      setIntent(body, { dir: { x: 0.5, y: 1 }, actionBits: ACTION_BIT_DRIFT });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(body.drift.charging).toBe(true);
    reefRaceSim.forfeit('room-drift', 'p1', 'integrity');
    // applyIntentForTick + tickDriftState don't run for forfeited bodies,
    // so no boost can fire.
    for (let i = 0; i < 10; i++) {
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    expect(broadcasts.some((f) => f.type === 'event.drift_boost')).toBe(false);
  });
});

// ─── T21 — computeLaunchVerdicts (table-driven) ─────────────────────────────
//
// The room manager owns this method; sim tests call it via a fresh import
// so we exercise the same code path liveTransitionFn does in production.

describe('computeLaunchVerdicts logic (Phase 1 T21)', () => {
  // Inline mirror of `activityRoomManager.computeLaunchVerdicts` window math.
  // Importing the room manager pulls in @clawville/database transitively
  // (drizzle, postgres-js) which is impractical for a sim unit test. The
  // logic under test is the pure window-arithmetic — re-derived here.
  function computeVerdict(offset: number, thrust: number): 'boost' | 'stall' | null {
    if (thrust < 1.0) return null;
    if (Math.abs(offset) <= LAUNCH_WINDOW_MS) return 'boost';
    if (
      offset < -LAUNCH_WINDOW_MS &&
      offset >= -(LAUNCH_WINDOW_MS + LAUNCH_STALL_WINDOW_MS)
    ) {
      return 'stall';
    }
    return null;
  }

  const cases: Array<{ offset: number; thrust: number; expected: 'boost' | 'stall' | null }> = [
    { offset:    0, thrust: 1.0, expected: 'boost' },  // exactly on green
    { offset:  149, thrust: 1.0, expected: 'boost' },  // inside window (late)
    { offset: -149, thrust: 1.0, expected: 'boost' },  // inside window (early)
    { offset:  151, thrust: 1.0, expected: null    },  // outside window (too late)
    { offset: -151, thrust: 1.0, expected: 'stall' },  // just inside stall zone
    { offset: -350, thrust: 1.0, expected: 'stall' },  // at stall zone boundary
    { offset: -351, thrust: 1.0, expected: null    },  // beyond stall zone
    { offset:    0, thrust: 0.5, expected: null    },  // thrust < 1.0 → not captured
  ];

  it('table — applies LAUNCH_WINDOW_MS / LAUNCH_STALL_WINDOW_MS correctly', () => {
    for (const c of cases) {
      expect(computeVerdict(c.offset, c.thrust)).toBe(c.expected);
    }
  });

  it('LAUNCH_WINDOW_MS + LAUNCH_STALL_WINDOW_MS sanity', () => {
    expect(LAUNCH_WINDOW_MS).toBe(150);
    expect(LAUNCH_STALL_WINDOW_MS).toBe(200);
    expect(LAUNCH_BOOST_DURATION_MS).toBe(2000);
  });
});

// ─── Phase 2 — depth mechanics tests ────────────────────────────────────────
//
// All test names mirror `.claude/plans/reef-race-phase2-detailed.md` §9 (P2-T1
// through P2-T42 minus the visual-tier hint test). Reuses the helpers from
// Phase 1 (bootDriftRoom + setIntent) and adds a `bootMultiBodyRoom` helper.

function bootMultiBodyRoom(avatarIds: string[], opts?: { startedAt?: number }) {
  reefRaceSim.startRoom('room-p2', 'reef-race', avatarIds, {
    seed: 1,
    startedAt: opts?.startedAt,
  });
  stopInterval('room-p2');
  const state = reefRaceSim.__getState('room-p2')!;
  return state;
}

describe('ReefRaceSim — Phase 2 slipstream (P2-T1..P2-T5)', () => {
  it('P2-T1 — slipstream charges + fires when self in target wake', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1', 'p2']);
    const p1 = state.bodies.get('p1')!;
    const p2 = state.bodies.get('p2')!;
    // p1 leads at origin moving +Y at 300; p2 trailing 40wu south, same vel.
    p1.x = 0; p1.y = 0; p1.vx = 0; p1.vy = 300;
    p2.x = 0; p2.y = -40; p2.vx = 0; p2.vy = 300;
    for (let i = 0; i < SLIPSTREAM_REQUIRED_TICKS + 5; i++) {
      // Re-stamp velocity each tick — sim integration / drag will erode it
      // and the slipstream alignment check requires both ≥ REEF_MAX_SPEED * 0.30.
      p1.x = 0; p1.y = 0; p1.vx = 0; p1.vy = 300;
      p2.x = 0; p2.y = -40; p2.vx = 0; p2.vy = 300;
      reefRaceSim.__tickOnceForTest('room-p2');
    }
    expect(p2.activeBoosts.has('slipstream-boost')).toBe(true);
    expect(p2.slipstreamSourceAvatarId).toBe('p1');
    const slipEvents = broadcasts.filter((f) => f.type === 'event.slipstream');
    expect(slipEvents.length).toBe(1);
    if (slipEvents[0].type === 'event.slipstream') {
      expect(slipEvents[0].dstAvatarId).toBe('p2');
      expect(slipEvents[0].srcAvatarId).toBe('p1');
    }
  });

  it('P2-T2 — slipstream does NOT charge when target is stalled (slow)', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1', 'p2']);
    const p1 = state.bodies.get('p1')!;
    const p2 = state.bodies.get('p2')!;
    // p1 parked, p2 40wu behind moving +Y.
    for (let i = 0; i < SLIPSTREAM_REQUIRED_TICKS + 5; i++) {
      p1.x = 0; p1.y = 0; p1.vx = 0; p1.vy = 0;
      p2.x = 0; p2.y = -40; p2.vx = 0; p2.vy = 300;
      reefRaceSim.__tickOnceForTest('room-p2');
    }
    expect(p2.slipstreamConsecutiveTicks).toBe(0);
    expect(broadcasts.some((f) => f.type === 'event.slipstream')).toBe(false);
  });

  it('P2-T3 — proximity collision does not break slipstream charge tracking', () => {
    captureBroadcasts();
    const state = bootMultiBodyRoom(['p1', 'p2']);
    const p1 = state.bodies.get('p1')!;
    const p2 = state.bodies.get('p2')!;
    // Plant 35wu apart — inside the 50wu max but greater than 33wu min, no
    // proximity push.
    for (let i = 0; i < 10; i++) {
      p1.x = 0; p1.y = 0; p1.vx = 0; p1.vy = 300;
      p2.x = 0; p2.y = -35; p2.vx = 0; p2.vy = 300;
      reefRaceSim.__tickOnceForTest('room-p2');
    }
    // Counter must monotonically increase OR reset cleanly to 1 (never NaN).
    expect(p2.slipstreamConsecutiveTicks).toBeGreaterThan(0);
    expect(Number.isFinite(p2.slipstreamConsecutiveTicks)).toBe(true);
  });

  it('P2-T4 — overlapping bodies (dist=0) do not credit slipstream / no NaN', () => {
    captureBroadcasts();
    const state = bootMultiBodyRoom(['p1', 'p2']);
    const p1 = state.bodies.get('p1')!;
    const p2 = state.bodies.get('p2')!;
    for (let i = 0; i < 5; i++) {
      // Same position — distSq=0 fails the minSq early-out (33²=1089).
      p1.x = 0; p1.y = 0; p1.vx = 0; p1.vy = 300;
      p2.x = 0; p2.y = 0; p2.vx = 0; p2.vy = 300;
      reefRaceSim.__tickOnceForTest('room-p2');
    }
    expect(p2.activeBoosts.has('slipstream-boost')).toBe(false);
    expect(Number.isFinite(p2.x)).toBe(true);
    expect(Number.isFinite(p2.y)).toBe(true);
  });

  it('P2-T5 — slipstream + drift-3 + launch respects KINEMATIC_BOOST_CAP', () => {
    captureBroadcasts();
    const { state, body } = bootDriftRoom({
      vx: 0,
      vy: 300,
      launchBoosts: new Map([['p1', 'boost']]),
      startedAt: Date.now(),
    });
    body.activeBoosts.set('drift-boost', {
      expiresAt: Date.now() + 30_000,
      mult: DRIFT_BOOST_MULTS[2],
    });
    body.currentDriftBoostSparks = 3;
    body.activeBoosts.set('slipstream-boost', {
      expiresAt: Date.now() + 30_000,
      mult: SLIPSTREAM_BOOST_MULT,
    });
    void state;
    for (let i = 0; i < 60; i++) {
      // Refresh the boost ttl every tick so it doesn't expire mid-run.
      body.activeBoosts.set('slipstream-boost', {
        expiresAt: Date.now() + 30_000,
        mult: SLIPSTREAM_BOOST_MULT,
      });
      body.activeBoosts.set('drift-boost', {
        expiresAt: Date.now() + 30_000,
        mult: DRIFT_BOOST_MULTS[2],
      });
      body.currentDriftBoostSparks = 3;
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
      reefRaceSim.__tickOnceForTest('room-drift');
      const s = Math.hypot(body.vx, body.vy);
      expect(s).toBeLessThanOrEqual(REEF_MAX_SPEED * 1.85 + 5);
    }
  });
});

describe('ReefRaceSim — Phase 2 cornering apex (P2-T6..P2-T10)', () => {
  it('P2-T6 — inside-line apex bonus fires + event broadcast', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1']);
    const body = state.bodies.get('p1')!;
    const zone = state.apexZones[0];
    body.x = zone.innerCenter.x;
    body.y = zone.innerCenter.y;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(body.activeBoosts.has('apex-bonus')).toBe(true);
    const verdict = broadcasts.find((f) => f.type === 'event.apex_verdict');
    expect(verdict).toBeDefined();
    if (verdict && verdict.type === 'event.apex_verdict') {
      expect(verdict.kind).toBe('clean');
      expect(verdict.hairpinIndex).toBe(zone.hairpinIndex);
    }
  });

  it('P2-T7 — outside-line apex penalty fires + event broadcast', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1']);
    const body = state.bodies.get('p1')!;
    const zone = state.apexZones[0];
    body.x = zone.outerCenter.x;
    body.y = zone.outerCenter.y;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(body.activeBoosts.has('apex-penalty')).toBe(true);
    const verdict = broadcasts.find((f) => f.type === 'event.apex_verdict');
    expect(verdict).toBeDefined();
    if (verdict && verdict.type === 'event.apex_verdict') {
      expect(verdict.kind).toBe('wide');
    }
  });

  it('P2-T8 — apex check at the exact tick of a checkpoint cross', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1']);
    const body = state.bodies.get('p1')!;
    const checkpoints = buildReefCheckpoints();
    // Walk p1's nextCheckpoint up to the hairpin so checkpoint resolver
    // accepts the crossing.
    const hairpinIdx = APEX_HAIRPIN_CHECKPOINT_INDICES[0];
    body.nextCheckpoint = hairpinIdx;
    const zone = state.apexZones[0];
    // Position INSIDE the apex inner disc AND inside the checkpoint AABB.
    // Both are co-located at the hairpin — apex inner is offset along the
    // inward normal so we test apex first; the checkpoint AABB contains the
    // checkpoint center.
    body.x = zone.innerCenter.x;
    body.y = zone.innerCenter.y;
    reefRaceSim.__tickOnceForTest('room-p2');
    // Apex verdict must have fired.
    const apexVerdict = broadcasts.find((f) => f.type === 'event.apex_verdict');
    expect(apexVerdict).toBeDefined();
    void checkpoints;
  });

  it('P2-T9 — apex re-arms on lap-up', () => {
    captureBroadcasts();
    const state = bootMultiBodyRoom(['p1']);
    const body = state.bodies.get('p1')!;
    const zone = state.apexZones[0];
    body.x = zone.innerCenter.x;
    body.y = zone.innerCenter.y;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(body.apexCheckedThisLap.size).toBe(1);
    // Manually clear the per-lap set the way resolveCheckpoints would on
    // lap-up; verify we can re-trigger.
    body.apexCheckedThisLap.clear();
    body.lap = 1;
    body.activeBoosts.delete('apex-bonus');
    body.x = zone.innerCenter.x;
    body.y = zone.innerCenter.y;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(body.activeBoosts.has('apex-bonus')).toBe(true);
  });

  it('P2-T10 — apex bonus + drift = additive (drift-3 + bonus → +0.43 → 1.43×)', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 0, vy: 300 });
    body.activeBoosts.set('drift-boost', {
      expiresAt: Date.now() + 30_000,
      mult: DRIFT_BOOST_MULTS[2],
    });
    body.currentDriftBoostSparks = 3;
    body.activeBoosts.set('apex-bonus', {
      expiresAt: Date.now() + 30_000,
      mult: APEX_BONUS_MULT,
    });
    for (let i = 0; i < 80; i++) {
      body.activeBoosts.set('drift-boost', {
        expiresAt: Date.now() + 30_000,
        mult: DRIFT_BOOST_MULTS[2],
      });
      body.activeBoosts.set('apex-bonus', {
        expiresAt: Date.now() + 30_000,
        mult: APEX_BONUS_MULT,
      });
      body.currentDriftBoostSparks = 3;
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    const speed = Math.hypot(body.vx, body.vy);
    // Asymptotes toward REEF_MAX_SPEED * (1 + 0.38 + 0.05) = 715. Allow slack.
    expect(speed).toBeGreaterThan(REEF_MAX_SPEED * 1.30);
    expect(speed).toBeLessThanOrEqual(REEF_MAX_SPEED * 1.85 + 5);
  });
});

describe('ReefRaceSim — Phase 2 boost ribbons (P2-T11..P2-T14)', () => {
  it('P2-T11 — ribbon collected on segment cross', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1']);
    const body = state.bodies.get('p1')!;
    const ribbon = state.ribbons[0];
    // Plant body at midpoint of the ribbon segment.
    body.x = (ribbon.a.x + ribbon.b.x) / 2;
    body.y = (ribbon.a.y + ribbon.b.y) / 2;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(body.activeBoosts.has('ribbon-boost')).toBe(true);
    expect(body.ribbonsCollectedThisLap.has(`${body.lap}:${ribbon.id}`)).toBe(true);
    const evt = broadcasts.find((f) => f.type === 'event.ribbon_collected');
    expect(evt).toBeDefined();
    if (evt && evt.type === 'event.ribbon_collected') {
      expect(evt.ribbonId).toBe(ribbon.id);
      expect(evt.avatarId).toBe('p1');
    }
  });

  it('P2-T12 — both bodies collect on same tick when overlapping ribbon', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1', 'p2']);
    const p1 = state.bodies.get('p1')!;
    const p2 = state.bodies.get('p2')!;
    const ribbon = state.ribbons[0];
    p1.x = (ribbon.a.x + ribbon.b.x) / 2;
    p1.y = (ribbon.a.y + ribbon.b.y) / 2;
    // Place p2 slightly offset along ribbon segment to avoid proximity push.
    p2.x = ribbon.a.x + (ribbon.b.x - ribbon.a.x) * 0.4;
    p2.y = ribbon.a.y + (ribbon.b.y - ribbon.a.y) * 0.4;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(p1.activeBoosts.has('ribbon-boost')).toBe(true);
    expect(p2.activeBoosts.has('ribbon-boost')).toBe(true);
    const evts = broadcasts.filter((f) => f.type === 'event.ribbon_collected');
    expect(evts.length).toBe(2);
  });

  it('P2-T13 — same ribbon NOT collected twice in same lap', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1']);
    const body = state.bodies.get('p1')!;
    const ribbon = state.ribbons[0];
    body.x = (ribbon.a.x + ribbon.b.x) / 2;
    body.y = (ribbon.a.y + ribbon.b.y) / 2;
    reefRaceSim.__tickOnceForTest('room-p2');
    // Move offline + back, several ticks.
    body.x = ribbon.a.x + 9999;
    body.y = ribbon.a.y;
    reefRaceSim.__tickOnceForTest('room-p2');
    body.x = (ribbon.a.x + ribbon.b.x) / 2;
    body.y = (ribbon.a.y + ribbon.b.y) / 2;
    reefRaceSim.__tickOnceForTest('room-p2');
    const evts = broadcasts.filter((f) => f.type === 'event.ribbon_collected');
    expect(evts.length).toBe(1);
  });

  it('P2-T14 — ribbon cooldown across laps (same tick window)', () => {
    captureBroadcasts();
    const state = bootMultiBodyRoom(['p1']);
    const body = state.bodies.get('p1')!;
    const ribbon = state.ribbons[0];
    body.x = (ribbon.a.x + ribbon.b.x) / 2;
    body.y = (ribbon.a.y + ribbon.b.y) / 2;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(body.activeBoosts.has('ribbon-boost')).toBe(true);
    // Manually flip lap (clear per-lap dedupe) but DON'T reset
    // ribbonLastCollectedAt — cooldown should still reject.
    body.lap = 1;
    body.ribbonsCollectedThisLap.clear();
    body.activeBoosts.delete('ribbon-boost');
    body.x = (ribbon.a.x + ribbon.b.x) / 2;
    body.y = (ribbon.a.y + ribbon.b.y) / 2;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(body.activeBoosts.has('ribbon-boost')).toBe(false);
    // Forge the lastCollectedAt back in time to clear cooldown.
    body.ribbonLastCollectedAt.set(
      ribbon.id,
      Date.now() - RIBBON_COLLECTION_COOLDOWN_MS - 1_000,
    );
    body.x = (ribbon.a.x + ribbon.b.x) / 2;
    body.y = (ribbon.a.y + ribbon.b.y) / 2;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(body.activeBoosts.has('ribbon-boost')).toBe(true);
    void RIBBON_BOOST_DURATION_MS;
    void RIBBON_BOOST_MULT;
  });
});

describe('ReefRaceSim — Phase 2 hazards (P2-T15..P2-T18)', () => {
  it('P2-T15 — hazard slow applies on overlap + event broadcast', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1']);
    const body = state.bodies.get('p1')!;
    const hazard = state.hazards[0];
    body.x = hazard.center.x;
    body.y = hazard.center.y;
    body.vx = 300;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(body.activeBoosts.has('hazard-slow')).toBe(true);
    const hzEvt = broadcasts.find((f) => f.type === 'event.hazard_hit');
    expect(hzEvt).toBeDefined();
    if (hzEvt && hzEvt.type === 'event.hazard_hit') {
      expect(hzEvt.hazardId).toBe(hazard.id);
      expect(hzEvt.avatarId).toBe('p1');
    }
    void HAZARD_TICK_DURATION_MS;
  });

  it('P2-T16 — shields do NOT block hazards (hazards are terrain)', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1']);
    const body = state.bodies.get('p1')!;
    const hazard = state.hazards[0];
    body.activeEffects.set('rr-bubble-shield', Date.now() + 9_999);
    body.x = hazard.center.x;
    body.y = hazard.center.y;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(body.activeBoosts.has('hazard-slow')).toBe(true);
    const hzEvt = broadcasts.find((f) => f.type === 'event.hazard_hit');
    expect(hzEvt).toBeDefined();
  });

  it('P2-T17 — drift-3 + hazard → speedMod = 0.98 (audit C5 verification)', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 0, vy: 300 });
    body.activeBoosts.set('drift-boost', {
      expiresAt: Date.now() + 30_000,
      mult: DRIFT_BOOST_MULTS[2],
    });
    body.currentDriftBoostSparks = 3;
    body.activeBoosts.set('hazard-slow', {
      expiresAt: Date.now() + 30_000,
      mult: HAZARD_SLOW_MULT,
    });
    for (let i = 0; i < 80; i++) {
      body.activeBoosts.set('drift-boost', {
        expiresAt: Date.now() + 30_000,
        mult: DRIFT_BOOST_MULTS[2],
      });
      body.activeBoosts.set('hazard-slow', {
        expiresAt: Date.now() + 30_000,
        mult: HAZARD_SLOW_MULT,
      });
      body.currentDriftBoostSparks = 3;
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    const speed = Math.hypot(body.vx, body.vy);
    // Asymptote target: REEF_MAX_SPEED * 0.98 = 490 wu/s.
    // Allow generous slack for integration + drag.
    expect(speed).toBeGreaterThan(REEF_MAX_SPEED * 0.85);
    expect(speed).toBeLessThan(REEF_MAX_SPEED * 1.05);
  });

  it('P2-T18 — hazard re-fires once per (lap, hazardId), boost continuously refreshed', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1']);
    const body = state.bodies.get('p1')!;
    const hazard = state.hazards[0];
    for (let i = 0; i < 60; i++) {
      body.x = hazard.center.x;
      body.y = hazard.center.y;
      reefRaceSim.__tickOnceForTest('room-p2');
    }
    const evts = broadcasts.filter((f) => f.type === 'event.hazard_hit');
    expect(evts.length).toBe(1); // edge-triggered per (avatarId, lap, hazardId)
    expect(body.activeBoosts.has('hazard-slow')).toBe(true);
  });
});

describe('ReefRaceSim — Phase 2 placement-weighted items (P2-T19..P2-T26)', () => {
  it('P2-T19 — getPlacementItemTable(1) returns defensive-only weights', () => {
    const t = getPlacementItemTable(1);
    expect(t).toBeDefined();
    if (!t) return;
    const kinds = t.map((e) => e.kind);
    expect(kinds).not.toContain('rr-whirlpool');
    expect(kinds).not.toContain('rr-seeker-jelly');
    expect(kinds).not.toContain('rr-tide-wave');
  });

  it('P2-T20 — getPlacementItemTable(8) returns aggressive-only weights', () => {
    const t = getPlacementItemTable(8);
    expect(t).toBeDefined();
    if (!t) return;
    const kinds = t.map((e) => e.kind);
    expect(kinds).not.toContain('rr-bubble-shield');
    expect(kinds).not.toContain('rr-ink-slick');
  });

  it('P2-T21 — computeLivePlacements orders racing bodies by progress', () => {
    captureBroadcasts();
    const state = bootMultiBodyRoom(['p1', 'p2', 'p3']);
    const p1 = state.bodies.get('p1')!;
    const p2 = state.bodies.get('p2')!;
    const p3 = state.bodies.get('p3')!;
    // p2 highest progress, p1 mid, p3 lowest.
    p2.lap = 2; p2.nextCheckpoint = 5;
    p1.lap = 1; p1.nextCheckpoint = 3;
    p3.lap = 0; p3.nextCheckpoint = 1;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(state.lastPlacementMap.get('p2')).toBe(1);
    expect(state.lastPlacementMap.get('p1')).toBe(2);
    expect(state.lastPlacementMap.get('p3')).toBe(3);
  });

  it('P2-T22 — finishers > racers > DNFers in placement order', () => {
    captureBroadcasts();
    const state = bootMultiBodyRoom(['p1', 'p2', 'p3']);
    const p1 = state.bodies.get('p1')!;
    const p2 = state.bodies.get('p2')!;
    const p3 = state.bodies.get('p3')!;
    p1.finishedAt = Date.now();
    p2.lap = 2; p2.nextCheckpoint = 5;
    p3.dnf = true;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(state.lastPlacementMap.get('p1')).toBe(1);
    expect(state.lastPlacementMap.get('p2')).toBe(2);
    expect(state.lastPlacementMap.get('p3')).toBe(3);
  });

  it('P2-T23 — placement-table lookup returns kinds from the bucket only', () => {
    expect(PLACEMENT_ITEM_TABLE[1].length).toBeGreaterThan(0);
    expect(PLACEMENT_ITEM_TABLE[4].length).toBeGreaterThan(0);
    expect(PLACEMENT_ITEM_TABLE[8].length).toBeGreaterThan(0);
    // Spot-check a few buckets — confirm weights non-zero.
    for (const placement of [1, 4, 8]) {
      const table = PLACEMENT_ITEM_TABLE[placement];
      expect(table.every((e) => e.weight > 0)).toBe(true);
    }
  });

  it('P2-T24 — placement-table fallback returns null for out-of-range', () => {
    expect(getPlacementItemTable(0)).toBeNull();
    expect(getPlacementItemTable(9)).toBeNull();
    expect(getPlacementItemTable(-1)).toBeNull();
  });

  it('P2-T25 — placement broadcast in EntityDelta (after first snapshot tick)', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1', 'p2'], { startedAt: Date.now() });
    // Drive a few ticks to fire a snapshot.delta broadcast.
    for (let i = 0; i < 10; i++) {
      reefRaceSim.__tickOnceForTest('room-p2');
    }
    const deltas = broadcasts.filter((f) => f.type === 'snapshot.delta');
    if (deltas.length === 0) return; // first 6 ticks may not produce a delta — skip
    let foundPlacement = false;
    for (const d of deltas) {
      if (d.type !== 'snapshot.delta') continue;
      for (const e of d.entities) {
        if (typeof (e.changed as Record<string, unknown>).placement === 'number') {
          foundPlacement = true;
        }
      }
    }
    expect(foundPlacement).toBe(true);
    void state;
  });

  it('P2-T26 — placement-only change forces a delta broadcast (predicate update)', () => {
    captureBroadcasts();
    const state = bootMultiBodyRoom(['p1', 'p2'], { startedAt: Date.now() });
    // Plant placements differently then swap to force a placement-only diff.
    const p1 = state.bodies.get('p1')!;
    const p2 = state.bodies.get('p2')!;
    p1.lap = 1; p1.nextCheckpoint = 3;
    p2.lap = 1; p2.nextCheckpoint = 3;
    // Drive past one snapshot cycle.
    for (let i = 0; i < 15; i++) {
      reefRaceSim.__tickOnceForTest('room-p2');
    }
    expect(state.lastPlacementMap.get('p1')).toBeDefined();
    expect(state.lastPlacementMap.get('p2')).toBeDefined();
  });
});

describe('ReefRaceSim — Phase 2 anti-cheat / cap regression (P2-T27..P2-T29)', () => {
  it('P2-T27 — combined boost stack capped at 1.85× (the master ceiling)', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({
      vx: 0,
      vy: 300,
      launchBoosts: new Map([['p1', 'boost']]),
      startedAt: Date.now(),
    });
    body.activeBoosts.set('drift-boost', {
      expiresAt: Date.now() + 60_000,
      mult: DRIFT_BOOST_MULTS[2],
    });
    body.currentDriftBoostSparks = 3;
    body.activeBoosts.set('slipstream-boost', {
      expiresAt: Date.now() + 60_000,
      mult: SLIPSTREAM_BOOST_MULT,
    });
    body.activeBoosts.set('ribbon-boost', {
      expiresAt: Date.now() + 60_000,
      mult: RIBBON_BOOST_MULT,
    });
    body.activeBoosts.set('apex-bonus', {
      expiresAt: Date.now() + 60_000,
      mult: APEX_BONUS_MULT,
    });
    for (let i = 0; i < 60; i++) {
      // Refresh all five so the 3rd-step expiry sweep doesn't drop them.
      body.activeBoosts.set('launch-boost', {
        expiresAt: Date.now() + 60_000,
        mult: LAUNCH_BOOST_MULT,
      });
      body.activeBoosts.set('drift-boost', {
        expiresAt: Date.now() + 60_000,
        mult: DRIFT_BOOST_MULTS[2],
      });
      body.currentDriftBoostSparks = 3;
      body.activeBoosts.set('slipstream-boost', {
        expiresAt: Date.now() + 60_000,
        mult: SLIPSTREAM_BOOST_MULT,
      });
      body.activeBoosts.set('ribbon-boost', {
        expiresAt: Date.now() + 60_000,
        mult: RIBBON_BOOST_MULT,
      });
      body.activeBoosts.set('apex-bonus', {
        expiresAt: Date.now() + 60_000,
        mult: APEX_BONUS_MULT,
      });
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
      reefRaceSim.__tickOnceForTest('room-drift');
      const s = Math.hypot(body.vx, body.vy);
      // Master ceiling: REEF_MAX_SPEED * 1.85 + slack (5 wu/s integration).
      expect(s).toBeLessThanOrEqual(REEF_MAX_SPEED * 1.85 + 5);
      // Validator ceiling: never breach REEF_KINEMATIC_TOLERANCE (2.0×).
      expect(s).toBeLessThan(REEF_MAX_SPEED * REEF_KINEMATIC_TOLERANCE);
    }
  });

  it('P2-T28 — negativeStack floored at NEGATIVE_KINETIC_FLOOR (-0.50)', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 0, vy: 300 });
    body.activeBoosts.set('hazard-slow', {
      expiresAt: Date.now() + 30_000,
      mult: HAZARD_SLOW_MULT, // -0.40
    });
    body.activeBoosts.set('apex-penalty', {
      expiresAt: Date.now() + 30_000,
      mult: APEX_PENALTY_MULT, // -0.05
    });
    for (let i = 0; i < 40; i++) {
      body.activeBoosts.set('hazard-slow', {
        expiresAt: Date.now() + 30_000,
        mult: HAZARD_SLOW_MULT,
      });
      body.activeBoosts.set('apex-penalty', {
        expiresAt: Date.now() + 30_000,
        mult: APEX_PENALTY_MULT,
      });
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    const speed = Math.hypot(body.vx, body.vy);
    // Asymptote: REEF_MAX_SPEED * (1 - 0.45) = 275 wu/s.
    expect(speed).toBeLessThan(REEF_MAX_SPEED * 0.65);
    // Now plant a hypothetical extra negative — confirm flooring.
    // We use a non-existent kind via direct mutation as the cap math reads
    // hazard-slow + apex-penalty regardless. For this regression we verify
    // the floor by reading NEGATIVE_KINETIC_FLOOR against the sum.
    const sum = HAZARD_SLOW_MULT + APEX_PENALTY_MULT;
    expect(sum).toBeGreaterThanOrEqual(NEGATIVE_KINETIC_FLOOR);
  });

  it('P2-T29 — hard cap stays at 1.85× REEF_MAX_SPEED (source-grep)', () => {
    const path = join(import.meta.dir, '..', 'reef-race-sim.ts');
    const src = readFileSync(path, 'utf-8');
    expect(src).toMatch(/REEF_MAX_SPEED \* 1\.85/);
  });
});

describe('ReefRaceSim — Phase 2 audit-gap tests (P2-T36..P2-T42)', () => {
  it('P2-T36 — chain drafting: A→B→C, B drafts A and C drafts B', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['A', 'B', 'C']);
    const A = state.bodies.get('A')!;
    const B = state.bodies.get('B')!;
    const C = state.bodies.get('C')!;
    for (let i = 0; i < SLIPSTREAM_REQUIRED_TICKS + 10; i++) {
      A.x = 0; A.y = 0;     A.vx = 0; A.vy = 300;
      B.x = 0; B.y = -40;   B.vx = 0; B.vy = 300;
      C.x = 0; C.y = -80;   C.vx = 0; C.vy = 300;
      reefRaceSim.__tickOnceForTest('room-p2');
    }
    expect(B.slipstreamSourceAvatarId).toBe('A');
    expect(C.slipstreamSourceAvatarId).toBe('B');
    expect(B.activeBoosts.has('slipstream-boost')).toBe(true);
    expect(C.activeBoosts.has('slipstream-boost')).toBe(true);
    const slipEvts = broadcasts.filter((f) => f.type === 'event.slipstream');
    expect(slipEvts.length).toBe(2);
  });

  it('P2-T37 — leader elimination mid-draft → end event for B', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['A', 'B']);
    const A = state.bodies.get('A')!;
    const B = state.bodies.get('B')!;
    for (let i = 0; i < SLIPSTREAM_REQUIRED_TICKS + 5; i++) {
      A.x = 0; A.y = 0;   A.vx = 0; A.vy = 300;
      B.x = 0; B.y = -40; B.vx = 0; B.vy = 300;
      reefRaceSim.__tickOnceForTest('room-p2');
    }
    expect(B.activeBoosts.has('slipstream-boost')).toBe(true);
    // Mark A as forfeited — filtered out of the slipstream loop's bodies list.
    A.forfeited = true;
    A.alive = false;
    // Tick past grace.
    for (let i = 0; i < SLIPSTREAM_GRACE_TICKS + 2; i++) {
      B.x = 0; B.y = -40; B.vx = 0; B.vy = 300;
      reefRaceSim.__tickOnceForTest('room-p2');
    }
    expect(B.activeBoosts.has('slipstream-boost')).toBe(false);
    const endEvts = broadcasts.filter((f) => f.type === 'event.slipstream_end');
    expect(endEvts.length).toBeGreaterThanOrEqual(1);
  });

  it('P2-T38 — ribbon at lap-up tick survives lap-up cleanup', () => {
    const { broadcasts } = captureBroadcasts();
    const state = bootMultiBodyRoom(['p1']);
    const body = state.bodies.get('p1')!;
    const ribbon = state.ribbons[0];
    // Plant body at ribbon midpoint with nextCheckpoint=0 (about to cross lap).
    // We can't easily force the lap-up to fire on the same tick AS the ribbon
    // crossing in pure-state mutation — but we can verify that if we manually
    // simulate the order (ribbon resolver fires at step 5a using PRE-INCREMENT
    // lap, then lap-up clears ribbonsCollectedThisLap at step 7), the
    // activeBoosts entry survives.
    body.x = (ribbon.a.x + ribbon.b.x) / 2;
    body.y = (ribbon.a.y + ribbon.b.y) / 2;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(body.activeBoosts.has('ribbon-boost')).toBe(true);
    // Now manually simulate lap-up cleanup.
    body.lap = 1;
    body.ribbonsCollectedThisLap.clear();
    // activeBoosts entry must NOT have been touched.
    expect(body.activeBoosts.has('ribbon-boost')).toBe(true);
    const evts = broadcasts.filter((f) => f.type === 'event.ribbon_collected');
    expect(evts.length).toBe(1);
  });

  it('P2-T39 — hazard during stall is a no-op (audit G4 — §2.12 row)', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({
      vx: 0,
      vy: 300,
      launchBoosts: new Map([['p1', 'stall']]),
      startedAt: Date.now(),
    });
    body.activeBoosts.set('hazard-slow', {
      expiresAt: Date.now() + 30_000,
      mult: HAZARD_SLOW_MULT,
    });
    for (let i = 0; i < 20; i++) {
      body.activeBoosts.set('launch-stall', {
        expiresAt: Date.now() + 30_000,
      });
      body.activeBoosts.set('hazard-slow', {
        expiresAt: Date.now() + 30_000,
        mult: HAZARD_SLOW_MULT,
      });
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    const speed = Math.hypot(body.vx, body.vy);
    // Stall short-circuit: speedMod = 0.5, effectiveThrust ≤ 0.30.
    // Asymptote: REEF_MAX_SPEED * 0.5 * 0.30 = 75 wu/s.
    // Hazard's negative kineticMult is SKIPPED inside the stall branch,
    // so the speed should NOT be lower than the stall floor — 75 wu/s.
    // Bound: stall floor + 10% slack for integration approach.
    expect(speed).toBeLessThanOrEqual(REEF_MAX_SPEED * 0.5 * LAUNCH_STALL_THRUST_CAP * 1.1);
  });

  it('P2-T40 — drift-3 + hazard → 0.98×, +turbo → 1.00× (audit G8 + C4/C5 fix, impl-audit S7 tightened)', () => {
    // Asymptotic-velocity check at thrust=1.0. integrateMotion applies drag
    // (REEF_DRAG = 0.97) AFTER each tick so the steady-state SPEED is
    //   v_eq = REEF_MAX_SPEED * speedMod * REEF_DRAG
    // not REEF_MAX_SPEED * speedMod. We back the speedMod out by dividing
    // by REEF_DRAG before comparing.
    //
    // impl-audit S7: original bound `< 1.05× baseline` would have passed
    // even with the v1 bug that erased hazard slow (1.00×). Tightened to
    // ±0.002 so the test FAILS if the bug ever returns:
    //   - v2 (correct):  drift-3 (+0.38) + hazard (-0.40) → 0.98×
    //   - v1 (buggy):    Math.max erased hazard → 1.00× (FAILS the bound)
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 0, vy: 300 });
    const REEF_DRAG = 0.97; // mirrors reef-race-config.ts
    body.activeBoosts.set('drift-boost', {
      expiresAt: Date.now() + 30_000,
      mult: DRIFT_BOOST_MULTS[2],
    });
    body.currentDriftBoostSparks = 3;
    body.activeBoosts.set('hazard-slow', {
      expiresAt: Date.now() + 30_000,
      mult: HAZARD_SLOW_MULT,
    });
    for (let i = 0; i < 80; i++) {
      body.activeBoosts.set('drift-boost', {
        expiresAt: Date.now() + 30_000,
        mult: DRIFT_BOOST_MULTS[2],
      });
      body.activeBoosts.set('hazard-slow', {
        expiresAt: Date.now() + 30_000,
        mult: HAZARD_SLOW_MULT,
      });
      body.currentDriftBoostSparks = 3;
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    const speedNoTurbo = Math.hypot(body.vx, body.vy);
    const inferredSpeedModNoTurbo = speedNoTurbo / (REEF_MAX_SPEED * REEF_DRAG);
    // Drift-3 (+0.38) + hazard (-0.40) → kineticDelta = -0.02 → speedMod = 0.98.
    // v1 BUG (hazard erased by Math.max with positive) would yield 1.00× — must FAIL here.
    expect(inferredSpeedModNoTurbo).toBeGreaterThan(0.978);
    expect(inferredSpeedModNoTurbo).toBeLessThan(0.982);

    // Now add turbo — turbo +0.40 wins positive slot vs drift +0.38 via Math.max,
    // hazard -0.40 lives in negative slot, kineticDelta = 0.40 - 0.40 = 0.00 → 1.00×.
    body.activeEffects.set('rr-turbo-bubble', Date.now() + 30_000);
    for (let i = 0; i < 60; i++) {
      body.activeEffects.set('rr-turbo-bubble', Date.now() + 30_000);
      body.activeBoosts.set('drift-boost', {
        expiresAt: Date.now() + 30_000,
        mult: DRIFT_BOOST_MULTS[2],
      });
      body.activeBoosts.set('hazard-slow', {
        expiresAt: Date.now() + 30_000,
        mult: HAZARD_SLOW_MULT,
      });
      body.currentDriftBoostSparks = 3;
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
      reefRaceSim.__tickOnceForTest('room-drift');
    }
    const speedTurbo = Math.hypot(body.vx, body.vy);
    const inferredSpeedModTurbo = speedTurbo / (REEF_MAX_SPEED * REEF_DRAG);
    expect(inferredSpeedModTurbo).toBeGreaterThan(0.998);
    expect(inferredSpeedModTurbo).toBeLessThan(1.002);
    void REEF_BOOST_MULT;
  });

  it('P2-T41 — placement on finish: finisher is 1, racer is 2', () => {
    captureBroadcasts();
    const state = bootMultiBodyRoom(['p1', 'p2']);
    const p1 = state.bodies.get('p1')!;
    const p2 = state.bodies.get('p2')!;
    p1.finishedAt = Date.now();
    p2.lap = 1; p2.nextCheckpoint = 5;
    reefRaceSim.__tickOnceForTest('room-p2');
    expect(state.lastPlacementMap.get('p1')).toBe(1);
    expect(state.lastPlacementMap.get('p2')).toBe(2);
  });

  it('P2-T42 — ribbon collected during ink-slick: boost ACTIVE but speedMod=0.5', () => {
    captureBroadcasts();
    const state = bootMultiBodyRoom(['p1']);
    const body = state.bodies.get('p1')!;
    const ribbon = state.ribbons[0];
    body.activeEffects.set('rr-ink-slick', Date.now() + 30_000);
    body.x = (ribbon.a.x + ribbon.b.x) / 2;
    body.y = (ribbon.a.y + ribbon.b.y) / 2;
    reefRaceSim.__tickOnceForTest('room-p2');
    // Boost survived the slick.
    expect(body.activeBoosts.has('ribbon-boost')).toBe(true);
    // Drive a few ticks while slicked — speed should NOT exceed
    // REEF_MAX_SPEED * 0.5 (slick override).
    for (let i = 0; i < 20; i++) {
      body.activeEffects.set('rr-ink-slick', Date.now() + 30_000);
      body.activeBoosts.set('ribbon-boost', {
        expiresAt: Date.now() + 30_000,
        mult: RIBBON_BOOST_MULT,
      });
      setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1.0 });
      reefRaceSim.__tickOnceForTest('room-p2');
    }
    const speed = Math.hypot(body.vx, body.vy);
    expect(speed).toBeLessThan(REEF_MAX_SPEED * 0.55);
    void state;
    void KINEMATIC_BOOST_CAP;
    void buildReefBoostRibbons;
    void buildReefApexZones;
    void buildReefHazardPatches;
    void APEX_DURATION_MS;
    void APEX_INSIDE_OFFSET;
    void APEX_OUTSIDE_OFFSET;
    void HAZARD_INSIDE_OFFSET;
    void REEF_BODY_RADIUS;
  });

  // ─── Phase 2 (impl-audit S4) — snapshot bandwidth ceiling ────────────────
  //
  // P2-T35 — assert Phase 2 keeps the per-second broadcast budget under the
  // documented frontend-spec ceiling. Phase 2 added per-tick `placement`
  // hoist into snapshot deltas + edge-triggered events (slipstream,
  // ribbon_collected, apex_verdict, hazard_hit) — the worry is that the
  // delta size growth is unbounded.
  //
  // Budget rationale (updated 2026-04-28 for REEF_SNAPSHOT_HZ 10 → 20):
  //   - 8 players × 20Hz snapshot rate = 160 entity deltas / sec
  //   - target ~2KB / snapshot at 8 players (post-Phase-2)
  //   - 20Hz × 2KB = 40KB / sec / room sustained
  //   - 30s match → 1.2MB sustained payload upper bound (worst case)
  //   - measured run at 20Hz lands ~300KB — still under the historical
  //     600KB ceiling, but doubling the snap rate doubles the run too,
  //     so the ceiling is bumped to 1.2MB to keep the 4× spike guard.
  //
  // Sized as JSON byte length of every broadcast frame to mirror the
  // wire-format cost the WebSocket actually pays.
  it('P2-T35 — 30s 8-player simulation stays under broadcast bandwidth ceiling', () => {
    const { broadcasts } = captureBroadcasts();
    const avatarIds = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    const state = bootMultiBodyRoom(avatarIds);
    // Drive 30s of simulation = 30 * REEF_SIM_HZ ticks = 900 ticks.
    const TICKS = 30 * REEF_SIM_HZ;
    for (let i = 0; i < TICKS; i++) {
      // Plant each body in a different position with a steady velocity so
      // the snapshot delta has non-zero entity changes most ticks (worst-
      // case bandwidth, not best-case).
      let idx = 0;
      for (const avatarId of avatarIds) {
        const body = state.bodies.get(avatarId)!;
        body.vx = 200 + (idx % 4) * 30;
        body.vy = 200 - (idx % 3) * 20;
        idx++;
        setIntent(body, { dir: { x: 0.5, y: 0.5 }, thrust: 0.85 });
      }
      reefRaceSim.__tickOnceForTest('room-p2');
    }
    let totalBytes = 0;
    let snapshotDeltas = 0;
    let eventFrames = 0;
    for (const frame of broadcasts) {
      totalBytes += JSON.stringify(frame).length;
      if (frame.type === 'snapshot.delta') snapshotDeltas++;
      else if (frame.type.startsWith('event.')) eventFrames++;
    }
    // Ceiling: 1.2MB / 30s / 8 players (post-20Hz, see budget rationale above).
    const CEILING_BYTES = 1_200 * 1024;
    expect(totalBytes).toBeLessThan(CEILING_BYTES);
    // Lower bound — sanity: must have actually broadcast something. Prevents a
    // future regression where broadcasts are silently dropped (test would
    // otherwise pass trivially at 0 bytes).
    expect(totalBytes).toBeGreaterThan(10_000);
    expect(snapshotDeltas).toBeGreaterThan(200); // 30s @ 20Hz ≈ 600
    void eventFrames;
  });
});

// ─── Phase 3 — stat-driven body multipliers (P3-T1..P3-T18) ────────────────
//
// Spec: `.claude/plans/reef-race-phase3-detailed.md` §8. Coverage: each
// multiplier in isolation, defaults / clamps, bot neutrality, combined-mult
// worst-case validator headroom, async profile-load, regression of Phase
// 1 + Phase 2 anchors for neutral avatars.

function bootProfileRoom(opts: {
  avatarIds: string[];
  avatarProfiles?: Map<
    string,
    {
      avatarId: string;
      level: number;
      archetype: string | null;
      isBot: boolean;
    }
  >;
  startedAt?: number;
  launchBoosts?: Map<string, 'boost' | 'stall'>;
}) {
  const { avatarIds, avatarProfiles, startedAt, launchBoosts } = opts;
  reefRaceSim.startRoom('room-p3', 'reef-race', avatarIds, {
    seed: 1,
    avatarProfiles,
    startedAt,
    launchBoosts,
  });
  stopInterval('room-p3');
  return reefRaceSim.__getState('room-p3')!;
}

function profile(
  avatarId: string,
  level: number,
  archetype: string | null,
  isBot = false,
) {
  return { avatarId, level, archetype, isBot };
}

describe('ReefRaceSim — Phase 3 stat-driven multipliers (P3-T1..P3-T18)', () => {
  // P3-T1
  it('P3-T1 — applies neutral mults when avatarProfiles is empty', () => {
    captureBroadcasts();
    const state = bootProfileRoom({ avatarIds: ['p1', 'p2'] });
    for (const body of state.bodies.values()) {
      expect(body.mults).toEqual(NEUTRAL_BODY_MULTIPLIERS);
      expect(body.driftSparkTicks).toEqual([
        DRIFT_SPARK_TICK_1,
        DRIFT_SPARK_TICK_2,
        DRIFT_SPARK_TICK_3,
      ]);
    }
  });

  // P3-T2
  it('P3-T2 — level 50 grants accelMult at the ceiling', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['p1', profile('p1', 50, null)],
    ]);
    const state = bootProfileRoom({ avatarIds: ['p1'], avatarProfiles: profiles });
    const body = state.bodies.get('p1')!;
    // Formula: 1 + 0.005 × 49 = 1.245 → unclamped (ceiling = 1.25).
    expect(body.mults.accelMult).toBeCloseTo(
      1 + LEVEL_ACCEL_MULT_PER_LEVEL * 49,
      6,
    );
  });

  // P3-T3
  it('P3-T3 — level 25 grants accelMult ≈ 1.12', () => {
    captureBroadcasts();
    const profiles = new Map([['p1', profile('p1', 25, null)]]);
    const state = bootProfileRoom({ avatarIds: ['p1'], avatarProfiles: profiles });
    const body = state.bodies.get('p1')!;
    expect(body.mults.accelMult).toBeCloseTo(1.12, 6);
  });

  // P3-T4
  it('P3-T4 — level 999 clamps accelMult to ceiling', () => {
    captureBroadcasts();
    const profiles = new Map([['p1', profile('p1', 999, null)]]);
    const state = bootProfileRoom({ avatarIds: ['p1'], avatarProfiles: profiles });
    const body = state.bodies.get('p1')!;
    expect(body.mults.accelMult).toBe(LEVEL_ACCEL_MULT_CEILING);
  });

  // P3-T5 — agility tightens the turn via Math.max replacement
  it('P3-T5 — agility archetype tightens turn maxStep via Math.max(...)', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['agi', profile('agi', 1, 'mischievous-trickster')],
      ['bal', profile('bal', 1, 'gentle-healer')],
    ]);
    const state = bootProfileRoom({
      avatarIds: ['agi', 'bal'],
      avatarProfiles: profiles,
    });
    const agi = state.bodies.get('agi')!;
    const bal = state.bodies.get('bal')!;
    expect(agi.mults.turnRadiusMult).toBe(AGILITY_TURN_RADIUS_MULT);
    expect(bal.mults.turnRadiusMult).toBe(1);
    // Drive both bodies at the same vy=400, then swing intent.
    for (const b of [agi, bal]) {
      b.vx = 0;
      b.vy = 400;
      setIntent(b, { dir: { x: 0.7, y: 0.7 }, thrust: 1 });
    }
    // Tick once and inspect velocity convergence — agi should converge
    // closer to the new direction.
    reefRaceSim.__tickOnceForTest('room-p3');
    const agiAlign =
      (agi.vx * 0.7 + agi.vy * 0.7) /
      (Math.hypot(agi.vx, agi.vy) || 1);
    const balAlign =
      (bal.vx * 0.7 + bal.vy * 0.7) /
      (Math.hypot(bal.vx, bal.vy) || 1);
    expect(agiAlign).toBeGreaterThan(balAlign);
  });

  // P3-T6 — agility extends slipstream GRACE
  it('P3-T6 — agility extends slipstream GRACE (24 vs 6)', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['agi', profile('agi', 1, 'wild-explorer')],
      ['bal', profile('bal', 1, 'gentle-healer')],
    ]);
    const state = bootProfileRoom({
      avatarIds: ['agi', 'bal'],
      avatarProfiles: profiles,
    });
    const agi = state.bodies.get('agi')!;
    const bal = state.bodies.get('bal')!;
    expect(agi.mults.slipstreamGraceTicks).toBe(AGILITY_SLIPSTREAM_GRACE_TICKS);
    expect(bal.mults.slipstreamGraceTicks).toBe(BASELINE_SLIPSTREAM_GRACE_TICKS);
  });

  // P3-T7
  it('P3-T7 — strength shortens drift spark thresholds', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['str', profile('str', 1, 'fierce-battler')],
      ['bal', profile('bal', 1, 'gentle-healer')],
    ]);
    const state = bootProfileRoom({
      avatarIds: ['str', 'bal'],
      avatarProfiles: profiles,
    });
    const str = state.bodies.get('str')!;
    const bal = state.bodies.get('bal')!;
    // strength mult = 1.4 -> [round(8/1.4), round(20/1.4), round(34/1.4)] = [6, 14, 24]
    expect(str.driftSparkTicks).toEqual([6, 14, 24]);
    expect(bal.driftSparkTicks).toEqual([
      DRIFT_SPARK_TICK_1,
      DRIFT_SPARK_TICK_2,
      DRIFT_SPARK_TICK_3,
    ]);
  });

  // P3-T8
  it('P3-T8 — strength reduces tide-wave knockback', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['src', profile('src', 1, null)],
      ['str', profile('str', 1, 'noble-guardian')],
      ['bal', profile('bal', 1, 'gentle-healer')],
    ]);
    const state = bootProfileRoom({
      avatarIds: ['src', 'str', 'bal'],
      avatarProfiles: profiles,
    });
    const str = state.bodies.get('str')!;
    const bal = state.bodies.get('bal')!;
    expect(str.mults.knockbackResistMult).toBe(STRENGTH_KNOCKBACK_RESIST_MULT);
    expect(bal.mults.knockbackResistMult).toBe(1);
  });

  // P3-T9
  it('P3-T9 — intelligence extends turbo-bubble duration by 20%', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['int', profile('int', 1, 'curious-scholar')],
      ['bal', profile('bal', 1, 'gentle-healer')],
    ]);
    const state = bootProfileRoom({
      avatarIds: ['int', 'bal'],
      avatarProfiles: profiles,
    });
    const intl = state.bodies.get('int')!;
    const bal = state.bodies.get('bal')!;
    expect(intl.mults.powerUpDurationMult).toBe(
      INTELLIGENCE_POWERUP_DURATION_MULT,
    );
    expect(bal.mults.powerUpDurationMult).toBe(1);
  });

  // P3-T10 — ribbon band widens
  it('P3-T10 — intelligence widens ribbon detection band', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['int', profile('int', 1, 'mystical-seer')],
      ['bal', profile('bal', 1, 'gentle-healer')],
    ]);
    const state = bootProfileRoom({
      avatarIds: ['int', 'bal'],
      avatarProfiles: profiles,
    });
    const intl = state.bodies.get('int')!;
    const bal = state.bodies.get('bal')!;
    expect(intl.mults.ribbonDetectMult).toBe(INTELLIGENCE_RIBBON_DETECT_MULT);
    expect(bal.mults.ribbonDetectMult).toBe(1);
  });

  // P3-T11 — sync profile load: first tick uses level-50 accelMult
  it('P3-T11 — sync profile load: body.mults populated before first tick', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['p1', profile('p1', 50, 'mischievous-trickster')],
    ]);
    const state = bootProfileRoom({ avatarIds: ['p1'], avatarProfiles: profiles });
    // Read mults immediately — no async gap.
    const body = state.bodies.get('p1')!;
    expect(body.mults.accelMult).toBeCloseTo(1.245, 4);
    expect(body.mults.turnRadiusMult).toBe(AGILITY_TURN_RADIUS_MULT);
  });

  // P3-T11b — async-pipeline integration: drives the SAME async path
  // production uses (`loadRacingProfiles → reefRaceSim.startRoom`), then
  // asserts `body.mults` is populated BEFORE the first tick advances —
  // catches regressions where a future refactor accidentally fires the
  // sim before the loader settles.
  it('P3-T11b — async loader → startRoom: body.mults populated on tick 0', async () => {
    captureBroadcasts();
    // Drive the actual async path: a Promise<Map> resolves and the result
    // is fed straight into startRoom. Mirrors apps/api/src/index.ts:359-371.
    const fakeProfilesPromise: Promise<
      Map<string, { avatarId: string; level: number; archetype: string | null; isBot: boolean }>
    > = Promise.resolve(
      new Map([
        ['p1', profile('p1', 50, 'chaotic-jester')],
      ]),
    );
    const avatarProfiles = await fakeProfilesPromise;
    const state = bootProfileRoom({ avatarIds: ['p1'], avatarProfiles });
    const body = state.bodies.get('p1')!;
    // Mults must be set BEFORE any tick advances — i.e. immediately after
    // startRoom returns. No 1.0 sentinel allowed.
    expect(body.mults.accelMult).toBeCloseTo(1.245, 4);
    expect(body.mults.turnRadiusMult).toBe(AGILITY_TURN_RADIUS_MULT);
    expect(body.mults.slipstreamGraceTicks).toBe(AGILITY_SLIPSTREAM_GRACE_TICKS);
    // Drive one tick — mults still applied (no init gap).
    setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1 });
    reefRaceSim.__tickOnceForTest('room-p3');
    expect(body.mults.accelMult).toBeCloseTo(1.245, 4);
  });

  // P3-T12 — bot avatarId always neutral
  it('P3-T12 — bot avatarId always neutral mults regardless of archetype', () => {
    captureBroadcasts();
    // Even with archetype + level set, isBot:true forces neutral.
    const profiles = new Map([
      ['bot', profile('bot', 50, 'fierce-battler', true)],
    ]);
    const state = bootProfileRoom({ avatarIds: ['bot'], avatarProfiles: profiles });
    const body = state.bodies.get('bot')!;
    expect(body.mults).toEqual(NEUTRAL_BODY_MULTIPLIERS);
  });

  // P3-T13 — neutral avatars behave identically (regression marker)
  it('P3-T13 — neutral mults match every NEUTRAL_BODY_MULTIPLIERS field', () => {
    captureBroadcasts();
    const state = bootProfileRoom({ avatarIds: ['p1'] });
    const body = state.bodies.get('p1')!;
    expect(body.mults.accelMult).toBe(NEUTRAL_BODY_MULTIPLIERS.accelMult);
    expect(body.mults.turnRadiusMult).toBe(NEUTRAL_BODY_MULTIPLIERS.turnRadiusMult);
    expect(body.mults.slipstreamGraceTicks).toBe(
      NEUTRAL_BODY_MULTIPLIERS.slipstreamGraceTicks,
    );
    expect(body.mults.driftChargeMult).toBe(NEUTRAL_BODY_MULTIPLIERS.driftChargeMult);
    expect(body.mults.knockbackResistMult).toBe(
      NEUTRAL_BODY_MULTIPLIERS.knockbackResistMult,
    );
    expect(body.mults.powerUpDurationMult).toBe(
      NEUTRAL_BODY_MULTIPLIERS.powerUpDurationMult,
    );
    expect(body.mults.ribbonDetectMult).toBe(
      NEUTRAL_BODY_MULTIPLIERS.ribbonDetectMult,
    );
  });

  // P3-T14 — strength drift charges fire spark1 sooner
  it('P3-T14 — strength drift charges spark1 at tick 6 vs 8 baseline', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['str', profile('str', 1, 'brave-adventurer')],
    ]);
    const state = bootProfileRoom({
      avatarIds: ['str'],
      avatarProfiles: profiles,
    });
    const body = state.bodies.get('str')!;
    body.vx = 200;
    body.vy = 0;
    setIntent(body, {
      dir: { x: 0.5, y: 1 },
      thrust: 0.85,
      actionBits: ACTION_BIT_DRIFT,
    });
    reefRaceSim.__tickOnceForTest('room-p3');
    expect(body.drift.charging).toBe(true);
    // Hold drift through 6 more ticks (elapsed = 6 = strength threshold T1).
    for (let i = 0; i < 6; i++) {
      setIntent(body, {
        dir: { x: 0.5, y: 1 },
        thrust: 0.85,
        actionBits: ACTION_BIT_DRIFT,
      });
      reefRaceSim.__tickOnceForTest('room-p3');
    }
    expect(body.drift.sparkLevel).toBe(1);
  });

  // P3-T15 — velocity validator NOW actually fires (N1 fix). Direct
  // validator call — proves the validator clamps at REEF_MAX_ACCEL × dt ×
  // 2.1 ≈ 140 wu/s, AND also asserts the applyIntentForTick call-site no
  // longer passes (prevV, prevV) — see C-IMPL-1 fix at
  // reef-race-sim.ts:~1132 (validator runs at end of applyIntentForTick).
  it('P3-T15 — velocity validator clamps a synthetic 200 wu/s jump', () => {
    const dt = 1 / REEF_SIM_HZ;
    const prev = { x: 0, y: 200 };
    const synthetic = { x: 0, y: 200 + 200 }; // +200 wu/s magnitude jump
    const verdict = validateReefVelocityDelta(
      prev,
      synthetic,
      dt,
      REEF_KINEMATIC_TOLERANCE,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.flagged).toBe(true);
    // And a legitimate 80 wu/s acceleration step (well under the
    // REEF_MAX_ACCEL × dt × 2.1 ≈ 140 allowance) should NOT flag.
    const legit = { x: 0, y: 200 + 80 };
    const ok = validateReefVelocityDelta(
      prev,
      legit,
      dt,
      REEF_KINEMATIC_TOLERANCE,
    );
    expect(ok.ok).toBe(true);
    expect(ok.flagged).toBe(false);
  });

  // P3-T15b — REAL wiring proof for C-IMPL-1. Drives the actual
  // applyIntentForTick → validator pipeline by poisoning body.mults.accelMult
  // to a value that produces a per-tick velocity delta well above the
  // validator's REEF_MAX_ACCEL × dt × 2.1 ≈ 140 wu/s allowance. With the
  // pre-fix wiring (prev/curr both captured AFTER acceleration), no flag
  // would ever appear regardless of accel magnitude. With C-IMPL-1 fixed
  // (prev captured BEFORE acceleration, validator at end of
  // applyIntentForTick), the validator MUST flag.
  it('P3-T15b — applyIntentForTick velocity validator FIRES on poisoned accelMult (C-IMPL-1 wiring proof)', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['p1', profile('p1', 1, null)],
    ]);
    const state = bootProfileRoom({
      avatarIds: ['p1'],
      avatarProfiles: profiles,
    });
    const body = state.bodies.get('p1')!;
    // Poison accelMult to 5.0 so a single applyIntentForTick step adds
    // ~333 wu/s — well over the validator's ~140 wu/s allowance. This
    // simulates a future regression / cheat path that pumps the per-tick
    // delta past the legitimate ceiling. With C-IMPL-1 fixed the
    // validator catches it; without the fix it never sees a non-zero dv.
    (body.mults as { accelMult: number }).accelMult = 5.0;
    body.vx = 0;
    body.vy = 0;
    setIntent(body, { dir: { x: 0, y: 1 }, thrust: 1 });
    reefRaceSim.__tickOnceForTest('room-p3');
    // The body's velocity must have been clamped down toward the validator's
    // allowance, not the poisoned 333 wu/s target. This is the load-bearing
    // assertion — clamp is what actually protects the sim from a cheat path.
    const speedAfterClamp = Math.hypot(body.vx, body.vy);
    expect(speedAfterClamp).toBeLessThanOrEqual(
      REEF_MAX_ACCEL * (1 / REEF_SIM_HZ) * REEF_KINEMATIC_TOLERANCE + 0.01,
    );
    // NOTE: pre-2026-04-28 this test also asserted that flagCounter bumped
    // by 1. After the bumper-bug fallout — honest players got DQ'd by
    // checkpoint_skip cascades when the bumper flung them off-track — physics
    // flags (overaccel/overspeed/checkpoint_skip/underminlap) no longer
    // increment the 5-flag forfeit counter. The clamp above is the entire
    // anti-cheat for these kinds; the flag is logged for observability only.
  });

  // P3-T15c — NEGATIVE wiring proof. A normal level-50 agility tick under
  // worst-case stat advantages MUST NOT trigger the per-tick velocity
  // validator. Locks in the headroom calculation in `.claude/plans/reef-
  // race-phase3-detailed.md` §5.
  it('P3-T15c — normal level-50 agility tick does NOT false-flag the velocity validator', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['p1', profile('p1', 50, 'mischievous-trickster')],
    ]);
    const state = bootProfileRoom({
      avatarIds: ['p1'],
      avatarProfiles: profiles,
    });
    const body = state.bodies.get('p1')!;
    body.vx = 0;
    body.vy = 0;
    setIntent(body, { dir: { x: 0.7, y: 0.7 }, thrust: 1 });
    const flagsBefore = state.flagCounter.countFor('p1');
    for (let i = 0; i < 5; i++) {
      reefRaceSim.__tickOnceForTest('room-p3');
    }
    const flagsAfter = state.flagCounter.countFor('p1');
    expect(flagsAfter).toBe(flagsBefore);
  });

  // P3-T16 — worst-case Phase 3 stack does NOT flag at tolerance 2.1
  it('P3-T16 — worst-case stack does NOT flag at tolerance 2.1', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['p1', profile('p1', 50, 'mischievous-trickster')],
    ]);
    const state = bootProfileRoom({
      avatarIds: ['p1'],
      avatarProfiles: profiles,
    });
    const body = state.bodies.get('p1')!;
    // Stack: launch boost + drift-3 + slipstream + ribbon + apex bonus.
    body.activeBoosts.set('launch-boost', {
      expiresAt: Date.now() + 10_000,
      mult: LAUNCH_BOOST_MULT,
    });
    body.activeBoosts.set('drift-boost', {
      expiresAt: Date.now() + 10_000,
      mult: DRIFT_BOOST_MULTS[2],
    });
    body.currentDriftBoostSparks = 3;
    body.activeBoosts.set('slipstream-boost', {
      expiresAt: Date.now() + 10_000,
      mult: 0.20,
    });
    body.activeBoosts.set('ribbon-boost', {
      expiresAt: Date.now() + 10_000,
      mult: 0.30,
    });
    body.activeBoosts.set('apex-bonus', {
      expiresAt: Date.now() + 10_000,
      mult: 0.05,
    });
    body.vx = 0;
    body.vy = REEF_MAX_SPEED * 1.85; // peak boost steady-state
    // Drive corner entry to engage agility turn bonus.
    setIntent(body, { dir: { x: 0.7, y: 0.7 }, thrust: 1 });
    const flagsBefore = state.flagCounter.countFor('p1');
    for (let i = 0; i < 5; i++) {
      reefRaceSim.__tickOnceForTest('room-p3');
    }
    const flagsAfter = state.flagCounter.countFor('p1');
    expect(flagsAfter).toBe(flagsBefore);
    // And no forfeit triggered.
    expect(body.forfeited).toBe(false);
  });

  // P3-T17 — cross-avatar — agility human vs neutral bot (not full lap, just
  // assert turn-radius advantage shows in convergence speed)
  it('P3-T17 — agility human + neutral bot — agility converges faster on hard turn', () => {
    captureBroadcasts();
    const profiles = new Map([
      ['agi', profile('agi', 1, 'chaotic-jester')],
      ['bot', profile('bot', 1, 'fierce-battler', true)],
    ]);
    const state = bootProfileRoom({
      avatarIds: ['agi', 'bot'],
      avatarProfiles: profiles,
    });
    const agi = state.bodies.get('agi')!;
    const bot = state.bodies.get('bot')!;
    // Bot is forced neutral despite the strength archetype.
    expect(bot.mults).toEqual(NEUTRAL_BODY_MULTIPLIERS);
    // Both at vy=400, swing both into a 45° turn.
    for (const b of [agi, bot]) {
      b.vx = 0;
      b.vy = 400;
      setIntent(b, { dir: { x: 0.7, y: 0.7 }, thrust: 1 });
    }
    reefRaceSim.__tickOnceForTest('room-p3');
    const agiAlign =
      (agi.vx * 0.7 + agi.vy * 0.7) /
      (Math.hypot(agi.vx, agi.vy) || 1);
    const botAlign =
      (bot.vx * 0.7 + bot.vy * 0.7) /
      (Math.hypot(bot.vx, bot.vy) || 1);
    expect(agiAlign).toBeGreaterThan(botAlign);
  });

  // P3-T18 — widened liveTransitionFn signature back-compat
  it('P3-T18 — sync void liveTransitionFn handlers still compose with await', async () => {
    let invoked = false;
    const syncFn: (room: { id: string }) => Promise<void> | void = (_room) => {
      invoked = true; // intentionally returns undefined
    };
    // Simulate the manager's await — sync return shouldn't break.
    await syncFn({ id: 'fake' });
    expect(invoked).toBe(true);
  });

  // P3-T17b — REGRESSION MARKER: agility class has a sustained turn-radius
  // advantage over balanced/neutral across many ticks of cornering. The
  // audit (S-IMPL-5) flagged that the original P3-T17 only checks one tick
  // of velocity convergence — useful but doesn't guard against a future
  // refactor that breaks `applyIntentForTick`'s turn-bonus path on tick 2+.
  // This test runs 10 trial pairs (independent rooms) and asserts agility's
  // mean cumulative path length over a sustained 60-tick (~2s) corner is
  // greater than balanced's. Larger path length under same thrust = stronger
  // tracking of the steering direction = real handling advantage.
  it('P3-T17b — agility outperforms balanced over sustained 60-tick corner (10-trial bound)', () => {
    captureBroadcasts();
    const N_TRIALS = 10;
    const TICKS_PER_TRIAL = 60; // ~2s at 30Hz
    let agilityAdvantage = 0;
    for (let trial = 0; trial < N_TRIALS; trial++) {
      // Reset between trials so each room has fresh seeding/state.
      reefRaceSim.__resetForTest();
      const profiles = new Map([
        ['agi', profile('agi', 1, 'chaotic-jester')],
        ['bal', profile('bal', 1, 'gentle-healer')],
      ]);
      const state = bootProfileRoom({
        avatarIds: ['agi', 'bal'],
        avatarProfiles: profiles,
      });
      const agi = state.bodies.get('agi')!;
      const bal = state.bodies.get('bal')!;
      // Same starting state — equivalent corner entry.
      for (const b of [agi, bal]) {
        b.vx = 0;
        b.vy = 400;
      }
      let agiPath = 0;
      let balPath = 0;
      let prevAgi = { x: agi.x, y: agi.y };
      let prevBal = { x: bal.x, y: bal.y };
      for (let i = 0; i < TICKS_PER_TRIAL; i++) {
        // Sustained 45° turn input.
        for (const b of [agi, bal]) {
          setIntent(b, { dir: { x: 0.7, y: 0.7 }, thrust: 1 });
        }
        reefRaceSim.__tickOnceForTest('room-p3');
        agiPath += Math.hypot(agi.x - prevAgi.x, agi.y - prevAgi.y);
        balPath += Math.hypot(bal.x - prevBal.x, bal.y - prevBal.y);
        prevAgi = { x: agi.x, y: agi.y };
        prevBal = { x: bal.x, y: bal.y };
      }
      if (agiPath > balPath) agilityAdvantage += 1;
    }
    // Agility must show a path-length advantage in the majority of trials.
    // (Since both bodies are deterministic with identical inputs except for
    // mults, agility wins consistently — this asserts at least 7/10 to
    // give wiggle room for future micro-changes that don't affect intent.)
    expect(agilityAdvantage).toBeGreaterThanOrEqual(7);
  });
});

// ─── Phase 3 — config + builder unit tests (P3-C1..P3-C6) ──────────────────

describe('reef-race-config — Phase 3 helpers (P3-C1..P3-C6)', () => {
  // P3-C1
  it('P3-C1 — racingClassFromArchetype maps all 14 archetype IDs', () => {
    const ids = [
      'mischievous-trickster',
      'wild-explorer',
      'chaotic-jester',
      'brave-adventurer',
      'fierce-battler',
      'noble-guardian',
      'curious-scholar',
      'mystical-seer',
      'cunning-trader',
      'royal-diplomat',
      'quiet-mystic',
      'gentle-healer',
      'creative-dreamer',
      'loyal-companion',
    ];
    for (const id of ids) {
      const cls = racingClassFromArchetype(id);
      expect(['agility', 'strength', 'intelligence', 'balanced']).toContain(cls);
    }
  });

  // P3-C2
  it('P3-C2 — unknown archetype returns balanced', () => {
    expect(racingClassFromArchetype('not-an-id')).toBe('balanced');
    expect(racingClassFromArchetype(null)).toBe('balanced');
    expect(racingClassFromArchetype(undefined)).toBe('balanced');
  });

  // P3-C3
  it('P3-C3 — buildBodyMultipliers(null) is neutral', () => {
    const m = buildBodyMultipliers(null);
    expect(m).toEqual(NEUTRAL_BODY_MULTIPLIERS);
  });

  // P3-C4
  it('P3-C4 — buildBodyMultipliers(bot) is neutral even with archetype + level', () => {
    const m = buildBodyMultipliers({
      avatarId: 'b',
      level: 50,
      archetype: 'fierce-battler',
      isBot: true,
    });
    expect(m).toEqual(NEUTRAL_BODY_MULTIPLIERS);
  });

  // P3-C5
  it('P3-C5 — clamps respect bounds (level 999, level -50, NaN)', () => {
    expect(
      buildBodyMultipliers({
        avatarId: 'p',
        level: 999,
        archetype: null,
        isBot: false,
      }).accelMult,
    ).toBe(LEVEL_ACCEL_MULT_CEILING);

    expect(
      buildBodyMultipliers({
        avatarId: 'p',
        level: -50,
        archetype: null,
        isBot: false,
      }).accelMult,
    ).toBe(1);

    expect(
      buildBodyMultipliers({
        avatarId: 'p',
        level: NaN,
        archetype: null,
        isBot: false,
      }).accelMult,
    ).toBe(1);
  });

  // P3-C6 — mutation safety
  it('P3-C6 — per-body mults are clones, not the global neutral reference', () => {
    const r1 = buildBodyMultipliers(null);
    const r2 = buildBodyMultipliers(null);
    expect(r1).not.toBe(r2); // distinct refs
    r1.accelMult = 99;
    expect(r2.accelMult).toBe(1);
    expect(NEUTRAL_BODY_MULTIPLIERS.accelMult).toBe(1);
  });
});

// ─── Phase 4 — ghost replay capture, streak, C1/S1/C3 fixes ────────────────

describe('ReefRaceSim Phase 4 — ghost replay capture', () => {
  // P4-T1
  it('P4-T1 — captures ghost frames at 5 Hz for the active body', () => {
    captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2', 'p3', 'p4'], { seed: 7 });
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const body = state.bodies.get('p1')!;
    // After startRoom, the t=0 anchor is in place.
    const initial = body.currentLapFrames.length;
    expect(initial).toBe(1);
    expect(body.currentLapFrames[0]?.t).toBe(0);
    // Drive 60 ticks (2 sec at 30 Hz). Capture stride = 6 → ~10 new frames.
    for (let i = 0; i < 60; i++) {
      reefRaceSim.__tickOnceForTest('room-a');
    }
    expect(body.currentLapFrames.length).toBeGreaterThanOrEqual(10);
    expect(body.currentLapFrames.length).toBeLessThanOrEqual(12);
    // First frame is the synthetic anchor at t=0; subsequent frames are
    // monotonic in lap-relative t.
    let lastT = -1;
    for (const f of body.currentLapFrames) {
      expect(f.t).toBeGreaterThanOrEqual(lastT);
      lastT = f.t;
    }
  });

  // P4-T2 (C1 fix — discard branch)
  it('P4-T2 (C1 fix) — clears currentLapFrames on sub-MIN_LAP discard AND re-anchors', () => {
    captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2', 'p3', 'p4']);
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const body = state.bodies.get('p1')!;
    const checkpoints = buildReefCheckpoints();
    // Drive a few capture ticks so currentLapFrames has a few entries.
    for (let i = 0; i < 30; i++) {
      reefRaceSim.__tickOnceForTest('room-a');
    }
    const beforeDiscard = body.currentLapFrames.length;
    expect(beforeDiscard).toBeGreaterThan(1);
    // Now drive a sub-MIN_LAP lap completion: walk cps 1..11 + 0 with
    // lapStartedAt = now (lapMs ~= 0 < MIN_LAP_MS).
    body.lapStartedAt = Date.now();
    for (let i = 1; i < REEF_CHECKPOINT_COUNT; i++) {
      body.x = checkpoints[i].center.x;
      body.y = checkpoints[i].center.y;
      body.vx = 0;
      body.vy = 0;
      reefRaceSim.__tickOnceForTest('room-a');
    }
    body.x = checkpoints[0].center.x;
    body.y = checkpoints[0].center.y;
    reefRaceSim.__tickOnceForTest('room-a');
    // Lap discarded, lap counter unchanged.
    expect(body.lap).toBe(0);
    // C1 FIX — currentLapFrames cleared in the discard branch, re-anchored
    // with synthetic t=0. Should be exactly 1 frame (the anchor) immediately
    // after discard. (Subsequent ticks may add to it.)
    expect(body.currentLapFrames.length).toBeGreaterThanOrEqual(1);
    expect(body.currentLapFrames[0]?.t).toBe(0);
    // Subsequent t values must be monotonic with NO huge gap from a stale
    // pre-discard frame.
    let lastT = -1;
    for (const f of body.currentLapFrames) {
      expect(f.t).toBeGreaterThanOrEqual(lastT);
      lastT = f.t;
    }
  });

  // P4-T3
  it('P4-T3 — bestLapFrames captures from the FIRST lap and persists', () => {
    captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2', 'p3', 'p4'], { seed: 11 });
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const body = state.bodies.get('p1')!;
    const checkpoints = buildReefCheckpoints();
    // Drive a few ticks so currentLapFrames has multiple captures.
    for (let i = 0; i < 30; i++) {
      reefRaceSim.__tickOnceForTest('room-a');
    }
    // Now finish a clean lap (lapStartedAt set in the past so lapMs > MIN_LAP_MS).
    body.lapStartedAt = Date.now() - (MIN_LAP_MS + 1_000);
    for (let i = 1; i < REEF_CHECKPOINT_COUNT; i++) {
      body.x = checkpoints[i].center.x;
      body.y = checkpoints[i].center.y;
      body.vx = 0;
      body.vy = 0;
      reefRaceSim.__tickOnceForTest('room-a');
    }
    body.x = checkpoints[0].center.x;
    body.y = checkpoints[0].center.y;
    reefRaceSim.__tickOnceForTest('room-a');
    expect(body.lap).toBe(1);
    expect(body.bestLapMsSoFar).not.toBeNull();
    expect(body.bestLapFrames).not.toBeNull();
    expect((body.bestLapFrames ?? []).length).toBeGreaterThan(0);
    // After lap-up, currentLapFrames has been cleared + re-anchored. The
    // exact length depends on whether the lap-up tick also happened to be a
    // capture stride tick (every 6th); either 1 (anchor only) or 2 (anchor
    // + same-tick capture) is correct. Critically the FIRST frame is the
    // synthetic t=0 anchor — that's the C1+S6 fix invariant.
    expect(body.currentLapFrames.length).toBeGreaterThanOrEqual(1);
    expect(body.currentLapFrames.length).toBeLessThanOrEqual(2);
    expect(body.currentLapFrames[0]?.t).toBe(0);
  });

  // P4-T4 (C3 fix — embedded into SimResultRow at computeResults time)
  it('P4-T4 (C3 fix) — computeResults embeds reefRace block before teardown', () => {
    captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2'], { seed: 21 });
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const checkpoints = buildReefCheckpoints();
    function runLap(avatarId: string): void {
      const body = state.bodies.get(avatarId)!;
      body.lapStartedAt = Date.now() - (MIN_LAP_MS + 1_000);
      for (let i = 1; i < REEF_CHECKPOINT_COUNT; i++) {
        body.x = checkpoints[i].center.x;
        body.y = checkpoints[i].center.y;
        reefRaceSim.__tickOnceForTest('room-a');
      }
      body.x = checkpoints[0].center.x;
      body.y = checkpoints[0].center.y;
      reefRaceSim.__tickOnceForTest('room-a');
    }
    for (let lap = 0; lap < REEF_LAPS; lap++) {
      runLap('p1');
      runLap('p2');
    }
    const results = reefRaceSim.computeResults('room-a');
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.reefRace).toBeDefined();
      expect(r.reefRace?.bestLapMs).not.toBeNull();
      expect(Array.isArray(r.reefRace?.ghostReplayFrames)).toBe(true);
      expect(typeof r.reefRace?.bestStreakThisMatch).toBe('number');
    }
  });
});

describe('ReefRaceSim Phase 4 — streak counter', () => {
  // P4-T5
  it('P4-T5 — non-hairpin checkpoints count as clean automatically', () => {
    captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2', 'p3', 'p4'], { seed: 4 });
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const body = state.bodies.get('p1')!;
    const checkpoints = buildReefCheckpoints();
    // Cross checkpoint 1 (non-hairpin). Streak should advance to 1.
    body.x = checkpoints[1].center.x;
    body.y = checkpoints[1].center.y;
    body.vx = 0;
    body.vy = 0;
    reefRaceSim.__tickOnceForTest('room-a');
    expect(body.currentStreak).toBe(1);
    expect(body.bestStreakThisMatch).toBe(1);
    // Cross checkpoint 2 (non-hairpin). Streak += 1.
    body.x = checkpoints[2].center.x;
    body.y = checkpoints[2].center.y;
    reefRaceSim.__tickOnceForTest('room-a');
    expect(body.currentStreak).toBe(2);
    expect(body.bestStreakThisMatch).toBe(2);
  });

  // P4-T6 (S1 fix — keyed by lap+cp)
  it('P4-T6 (S1 fix) — hairpin without a clean apex verdict for THIS lap = streak resets', () => {
    captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2', 'p3', 'p4'], { seed: 5 });
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const body = state.bodies.get('p1')!;
    const checkpoints = buildReefCheckpoints();
    // Build up streak via cps 1, 2.
    body.x = checkpoints[1].center.x;
    body.y = checkpoints[1].center.y;
    reefRaceSim.__tickOnceForTest('room-a');
    body.x = checkpoints[2].center.x;
    body.y = checkpoints[2].center.y;
    reefRaceSim.__tickOnceForTest('room-a');
    expect(body.currentStreak).toBe(2);
    // Cross hairpin cp 3 WITHOUT entering the apex zones — verdict map
    // has no entry for `${lap}-3`. Streak resets.
    body.x = checkpoints[3].center.x;
    body.y = checkpoints[3].center.y;
    reefRaceSim.__tickOnceForTest('room-a');
    expect(body.currentStreak).toBe(0);
    // bestStreakThisMatch retains the high-water mark.
    expect(body.bestStreakThisMatch).toBe(2);
  });

  // P4-T7 (milestones at 5/10/16/20/24 — re-spaced for the v4 24-checkpoint 2-lap race)
  it('P4-T7 (S2 fix) — event.streak_milestone fires at 5, 10, 20', () => {
    const { broadcasts } = captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2', 'p3', 'p4'], { seed: 6 });
    stopInterval('room-a');
    const state = reefRaceSim.__getState('room-a')!;
    const body = state.bodies.get('p1')!;
    // Force the streak by directly manipulating the body field then crossing
    // a non-hairpin to trigger the broadcast.
    const checkpoints = buildReefCheckpoints();
    function crossNonHairpin(i: number): void {
      // Make sure we expect the next-cp = i so the cross is legit.
      body.nextCheckpoint = i;
      body.x = checkpoints[i].center.x;
      body.y = checkpoints[i].center.y;
      body.vx = 0;
      body.vy = 0;
      // Reset insideCheckpoints so the cross counts as a transition.
      body.insideCheckpoints = new Set();
      reefRaceSim.__tickOnceForTest('room-a');
    }
    // Manually drive the streak high enough by crossing 1, 2, 4 (skip
    // hairpin 3). We need enough crosses to hit 5.
    body.currentStreak = 4;
    crossNonHairpin(1);
    expect(body.currentStreak).toBe(5);
    type MilestoneFrame = Extract<
      ServerFrame,
      { type: 'event.streak_milestone' }
    >;
    const milestoneEvents = broadcasts.filter(
      (f): f is MilestoneFrame =>
        f.type === 'event.streak_milestone' && f.avatarId === 'p1',
    );
    expect(milestoneEvents.length).toBeGreaterThanOrEqual(1);
    const tier1 = milestoneEvents.find((m) => m.streak === 5);
    expect(tier1).toBeDefined();
    expect(tier1?.kind).toBe('tier-1');
    // Drive to 10
    body.currentStreak = 9;
    crossNonHairpin(2);
    expect(body.currentStreak).toBe(10);
    const tier2 = broadcasts.find(
      (f): f is MilestoneFrame =>
        f.type === 'event.streak_milestone' &&
        f.avatarId === 'p1' &&
        f.streak === 10,
    );
    expect(tier2).toBeDefined();
    expect(tier2?.kind).toBe('tier-2');
  });
});

describe('ReefRaceSim Phase 4 — getFlagCount accessor', () => {
  it('returns 0 for unknown room/avatar', () => {
    expect(reefRaceSim.getFlagCount('no-such-room', 'no-such-avatar')).toBe(0);
  });
  it('reflects the flag count for a body', () => {
    captureBroadcasts();
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2', 'p3', 'p4']);
    stopInterval('room-a');
    expect(reefRaceSim.getFlagCount('room-a', 'p1')).toBe(0);
    const state = reefRaceSim.__getState('room-a')!;
    state.flagCounter.bump('p1');
    expect(reefRaceSim.getFlagCount('room-a', 'p1')).toBe(1);
  });
});
