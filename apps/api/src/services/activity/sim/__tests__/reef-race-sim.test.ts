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
} = await import('../reef-race-config');
import type { ServerFrame } from '@clawville/shared';

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
    const byPet = Object.fromEntries(results.map((r) => [r.avatarId, r]));
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
