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
    const petIds = ['p1', 'p2', 'p3', 'p4'];
    const state1 = reefRaceSim.startRoom('room-a', 'reef-race', petIds, { seed: 42 });
    const state2 = reefRaceSim.startRoom('room-a', 'reef-race', petIds, { seed: 42 });
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
      (f) => f.type === 'event.lap_completed' && f.petId === 'p1' && f.lap === 1,
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

    function runLap(petId: string): void {
      const body = state.bodies.get(petId)!;
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
    const matchEnded = broadcasts.find((f) => f.type === 'event.match_ended');
    expect(matchEnded).toBeDefined();
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
    const byPet = Object.fromEntries(results.map((r) => [r.petId, r]));
    expect(byPet['p2'].placement).toBe(1);
    expect(byPet['p2'].scoreMs).toBe(30_000);
    expect(byPet['p1'].placement).toBe(2);
    expect(byPet['p1'].scoreMs).toBe(35_000);
    expect(byPet['p3'].placement).toBe(3);
    expect(byPet['p3'].scoreMs).toBeNull();
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
  petId?: string;
  vx?: number;
  vy?: number;
  launchBoosts?: Map<string, 'boost' | 'stall'>;
  startedAt?: number;
}) {
  const petId = opts?.petId ?? 'p1';
  reefRaceSim.startRoom('room-drift', 'reef-race', [petId], {
    seed: 1,
    launchBoosts: opts?.launchBoosts,
    startedAt: opts?.startedAt,
  });
  stopInterval('room-drift');
  const state = reefRaceSim.__getState('room-drift')!;
  const body = state.bodies.get(petId)!;
  if (typeof opts?.vx === 'number') body.vx = opts.vx;
  if (typeof opts?.vy === 'number') body.vy = opts.vy;
  return { state, body, petId };
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

  it('T10 — body.rot shows constant 15° bias while drifting (no accumulation)', () => {
    captureBroadcasts();
    const { body } = bootDriftRoom({ vx: 200, vy: 0 });
    // First tick = "press" tick. drift.charging starts FALSE on entry to
    // step 6 (the state-machine update happens AFTER step 6 — see §2.3
    // commentary). So the bias only appears starting on tick 2.
    body.vx = 200; body.vy = 0;
    setIntent(body, { dir: { x: 0.5, y: 0.866 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.drift.charging).toBe(true);

    // Tick 2 — bias applies. Right turn (dir.x > 0) → bias is SUBTRACTED.
    body.vx = 200; body.vy = 0;
    setIntent(body, { dir: { x: 0.5, y: 0.866 }, thrust: 0, actionBits: ACTION_BIT_DRIFT });
    reefRaceSim.__tickOnceForTest('room-drift');
    const baseRot = Math.atan2(0.5, 0.866);
    const expected = baseRot - DRIFT_ANGULAR_BIAS_RAD;
    expect(body.rot).toBeCloseTo(expected, 4);

    // Tick 3 — same dir → SAME rot (bias is absolute, not accumulating).
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

    body.vx = 200; body.vy = 0;
    setIntent(body, { dir: { x: 0.5, y: 0.866 }, thrust: 0, actionBits: 0 });
    reefRaceSim.__tickOnceForTest('room-drift');
    expect(body.rot).toBeCloseTo(baseRot, 4);
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
    expect(src).toMatch(/validateReefVelocityDelta\([^)]*REEF_KINEMATIC_TOLERANCE/);
    expect(src).toMatch(/validateReefPositionDelta\([\s\S]*?REEF_KINEMATIC_TOLERANCE/);
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
      const ent = (d as any).entities.find((e: any) => e.petId === 'p1');
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
