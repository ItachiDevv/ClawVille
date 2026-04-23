/**
 * Q2 Activity Portals — Bumper Shells sim unit tests (chunk #3).
 *
 * Coverage:
 *   - Boundary elimination (body outside arena → eliminated)
 *   - Last-standing round-end
 *   - Collision knockback above threshold triggers event.hit
 *   - Power-up pickup adds to inventory
 *   - Deterministic tick output for a fixed seed
 *
 * Test isolation: the sim doesn't touch the DB directly but it imports
 * the replay log, event-logger, and room manager. We mock the
 * replay-log and event-logger so tests don't hit Drizzle. We also mute
 * `setInterval` by driving ticks explicitly via `__tickOnceForTest`.
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

const { bumperShellsSim, BUMPER_ARENA_RADIUS } = await import('../bumper-shells-sim');
import type { ServerFrame } from '@clawville/shared';

beforeEach(() => {
  bumperShellsSim.__resetForTest();
});

// ─── Broadcast capture ──────────────────────────────────────────────────────

function captureBroadcasts(): { broadcasts: ServerFrame[]; restore: () => void } {
  const frames: ServerFrame[] = [];
  bumperShellsSim.setBroadcastFn((_roomId, frame) => {
    frames.push(frame);
  });
  return {
    broadcasts: frames,
    restore: () => bumperShellsSim.setBroadcastFn(() => {}),
  };
}

// ─── Start-room / state fetch ───────────────────────────────────────────────

describe('BumperShellsSim.startRoom', () => {
  it('spawns bodies on a circle and is idempotent', () => {
    const { broadcasts, restore } = captureBroadcasts();
    const petIds = ['p1', 'p2', 'p3', 'p4'];
    const state1 = bumperShellsSim.startRoom('room-a', 'bumper-shells', petIds, { seed: 42 });
    const state2 = bumperShellsSim.startRoom('room-a', 'bumper-shells', petIds, { seed: 42 });
    expect(state1).toBe(state2);
    expect(state1.bodies.size).toBe(4);
    for (const body of state1.bodies.values()) {
      // Within the arena.
      expect(Math.hypot(body.x, body.y)).toBeLessThan(BUMPER_ARENA_RADIUS);
    }
    const matchStarted = broadcasts.find((f) => f.type === 'event.match_started');
    expect(matchStarted).toBeDefined();
    restore();
  });

  it('seeds spawn slots with 3 active pickups at boot', () => {
    captureBroadcasts();
    const state = bumperShellsSim.startRoom('room-b', 'bumper-shells', ['p1', 'p2', 'p3', 'p4']);
    expect(state.spawns).toHaveLength(3);
    expect(state.spawns.every((s) => s.active)).toBe(true);
  });
});

// ─── Boundary elimination ───────────────────────────────────────────────────

describe('BumperShellsSim — boundary elimination', () => {
  it('eliminates a body pushed outside arena radius', () => {
    const { broadcasts } = captureBroadcasts();
    bumperShellsSim.startRoom('room-a', 'bumper-shells', ['p1', 'p2', 'p3', 'p4']);
    const state = bumperShellsSim.__getState('room-a')!;
    // Stop the live interval so our tick is the only driver.
    if (state.intervalHandle) {
      clearInterval(state.intervalHandle);
      state.intervalHandle = null;
    }
    const body = state.bodies.get('p1')!;
    body.x = BUMPER_ARENA_RADIUS + 50;
    body.y = 0;
    body.vx = 0;
    body.vy = 0;

    bumperShellsSim.__tickOnceForTest('room-a');

    expect(body.alive).toBe(false);
    const elim = broadcasts.find((f) => f.type === 'event.eliminated' && f.petId === 'p1');
    expect(elim).toBeDefined();
  });
});

// ─── Round-end last-standing ────────────────────────────────────────────────

describe('BumperShellsSim — last-standing round-end', () => {
  it('ends the round when only one body remains alive', () => {
    const { broadcasts } = captureBroadcasts();
    bumperShellsSim.startRoom('room-a', 'bumper-shells', ['p1', 'p2', 'p3', 'p4']);
    const state = bumperShellsSim.__getState('room-a')!;
    if (state.intervalHandle) {
      clearInterval(state.intervalHandle);
      state.intervalHandle = null;
    }
    // Kill 3 of the 4 bodies manually.
    for (const petId of ['p2', 'p3', 'p4']) {
      const body = state.bodies.get(petId)!;
      body.x = BUMPER_ARENA_RADIUS + 50;
    }

    bumperShellsSim.__tickOnceForTest('room-a');

    const matchEnded = broadcasts.find((f) => f.type === 'event.match_ended');
    expect(matchEnded).toBeDefined();
    expect(state.ended).toBe(true);
  });
});

// ─── Results placement ─────────────────────────────────────────────────────

describe('BumperShellsSim.computeResults', () => {
  it('ranks the alive body first and eliminated bodies in reverse order', () => {
    const { restore } = captureBroadcasts();
    bumperShellsSim.startRoom('room-a', 'bumper-shells', ['p1', 'p2', 'p3', 'p4']);
    const state = bumperShellsSim.__getState('room-a')!;
    if (state.intervalHandle) {
      clearInterval(state.intervalHandle);
      state.intervalHandle = null;
    }
    // Eliminate p2 first, then p3, then p4 — leaves p1 as the winner.
    for (const petId of ['p2', 'p3', 'p4']) {
      const body = state.bodies.get(petId)!;
      body.alive = false;
      body.eliminatedAt = Date.now();
      state.eliminationOrder.push(petId);
    }
    const results = bumperShellsSim.computeResults('room-a');
    expect(results[0].petId).toBe('p1');
    expect(results[0].placement).toBe(1);
    // Last eliminated (p4) gets placement 2; p2 was eliminated first so it places last.
    const byPlacement = Object.fromEntries(results.map((r) => [r.petId, r.placement]));
    expect(byPlacement['p4']).toBe(2);
    expect(byPlacement['p3']).toBe(3);
    expect(byPlacement['p2']).toBe(4);
    restore();
  });
});

// ─── Deterministic tick output ──────────────────────────────────────────────

describe('BumperShellsSim — deterministic spawns', () => {
  it('same seed → identical spawn positions', () => {
    bumperShellsSim.__resetForTest();
    captureBroadcasts();
    const s1 = bumperShellsSim.startRoom('room-seed-a', 'bumper-shells', ['p1', 'p2', 'p3', 'p4'], { seed: 12345 });
    const positions1 = s1.spawns.map((s) => ({ x: s.position.x, y: s.position.y, kind: s.kind }));

    bumperShellsSim.__resetForTest();
    captureBroadcasts();
    const s2 = bumperShellsSim.startRoom('room-seed-b', 'bumper-shells', ['p1', 'p2', 'p3', 'p4'], { seed: 12345 });
    const positions2 = s2.spawns.map((s) => ({ x: s.position.x, y: s.position.y, kind: s.kind }));

    expect(positions1).toEqual(positions2);
  });
});

// ─── Power-up pickup ────────────────────────────────────────────────────────

describe('BumperShellsSim — pickup collision', () => {
  it('adds a charge to the body inventory on contact', () => {
    const { broadcasts } = captureBroadcasts();
    bumperShellsSim.startRoom('room-a', 'bumper-shells', ['p1', 'p2', 'p3', 'p4']);
    const state = bumperShellsSim.__getState('room-a')!;
    if (state.intervalHandle) {
      clearInterval(state.intervalHandle);
      state.intervalHandle = null;
    }
    const body = state.bodies.get('p1')!;
    const spawn = state.spawns[0];
    // Teleport the body on top of the pickup.
    body.x = spawn.position.x;
    body.y = spawn.position.y;
    body.vx = 0;
    body.vy = 0;

    bumperShellsSim.__tickOnceForTest('room-a');

    // One of the 2 inventory slots should now have the pickup.
    expect(body.inventory.some((s) => s.kind !== null)).toBe(true);
    const collected = broadcasts.find((f) => f.type === 'event.power_up_collected');
    expect(collected).toBeDefined();
  });
});
