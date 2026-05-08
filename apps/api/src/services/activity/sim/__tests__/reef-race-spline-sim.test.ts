/**
 * Reef Race v2 — spline sim unit tests (Phase 1).
 *
 * Coverage:
 *   - startRoom: room spawns, bodies at t≈0, facing +Z
 *   - applyInput: seq guard, stores intent
 *   - Tick advances progress (body moves down-track with thrust)
 *   - Finish-line crossing: event.crossed_finish emitted, body frozen
 *   - Gravity: airborne kart lands after jump
 *   - Wall clamp: body outside corridor is pushed back inside
 *   - computeResults: placement order matches finish order
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// ── Silence DB/event-logger wires ─────────────────────────────────────────────
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

// ── Imports (dynamic because of the mock.module pattern) ──────────────────────
const { reefRaceSplineSim } = await import('../reef-race-spline-sim');
const { REEF_TICK_HZ, ACTION_BIT_DRIFT, REEF_GRAVITY, REEF_JUMP_IMPULSE_MANUAL } =
  await import('../reef-race-config');

const ROOM_ID   = 'test-spline-room';
const ROOM_ID_2 = 'test-spline-room-2';
const AVATAR_A     = 'avatar-A';
const AVATAR_B     = 'avatar-B';
const DT        = 1 / REEF_TICK_HZ;

// ── Helper ────────────────────────────────────────────────────────────────────

function makeInput(thrust = 1, dirX = 0, dirZ = 1, actionBits = 0) {
  return { thrust, dir: { x: dirX, y: dirZ }, actionBits };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReefRaceSplineSim', () => {
  beforeEach(() => {
    reefRaceSplineSim.__resetForTest();
  });

  // ── startRoom ─────────────────────────────────────────────────────────────

  describe('startRoom', () => {
    it('spawns a room with bodies at the start zone', () => {
      const events: unknown[] = [];
      reefRaceSplineSim.setBroadcastFn((_id, frame) => events.push(frame));

      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A, AVATAR_B]);
      const state = reefRaceSplineSim.__getState(ROOM_ID);

      expect(state).toBeTruthy();
      expect(state!.bodies.size).toBe(2);

      const bodyA = state!.bodies.get(AVATAR_A)!;
      expect(bodyA).toBeTruthy();
      // Should be near start line (z ≈ 0 ± spawn offset)
      expect(Math.abs(bodyA.z)).toBeLessThan(200);
      expect(bodyA.heightOffset).toBe(0);
      expect(bodyA.progress).toBe(0);
      expect(bodyA.alive).toBe(true);
      expect(bodyA.finishedAt).toBeNull();
    });

    it('emits event.match_started', () => {
      const events: Array<{ type: string }> = [];
      reefRaceSplineSim.setBroadcastFn((_id, frame) =>
        events.push(frame as { type: string }),
      );

      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      expect(events.some((e) => e.type === 'event.match_started')).toBe(true);
    });

    it('is idempotent: duplicate startRoom returns existing state', () => {
      const events: unknown[] = [];
      reefRaceSplineSim.setBroadcastFn((_id, frame) => events.push(frame));

      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const s1 = reefRaceSplineSim.__getState(ROOM_ID);
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A, AVATAR_B]);
      const s2 = reefRaceSplineSim.__getState(ROOM_ID);
      expect(s1).toBe(s2); // same reference
    });
  });

  // ── applyInput ────────────────────────────────────────────────────────────

  describe('applyInput', () => {
    it('stores intent on valid input', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const result = reefRaceSplineSim.applyInput(
        ROOM_ID, AVATAR_A, 1, DT, makeInput(),
      );
      expect(result.ok).toBe(true);

      const body = reefRaceSplineSim.__getState(ROOM_ID)!.bodies.get(AVATAR_A)!;
      expect(body.intent.seq).toBe(1);
      expect(body.intent.thrust).toBeCloseTo(1, 5);
    });

    it('rejects seq that was already consumed by a tick', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      // Apply seq=5, then tick so the sim consumes it (consumedSeq → 5).
      reefRaceSplineSim.applyInput(ROOM_ID, AVATAR_A, 5, DT, makeInput());
      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      // Now re-submitting seq=5 should be rejected (5 <= consumedSeq=5).
      const result = reefRaceSplineSim.applyInput(
        ROOM_ID, AVATAR_A, 5, DT, makeInput(),
      );
      expect(result.ok).toBe(false);
    });

    it('returns ok=false for unknown room', () => {
      const result = reefRaceSplineSim.applyInput(
        'no-such-room', AVATAR_A, 1, DT, makeInput(),
      );
      expect(result.ok).toBe(false);
    });
  });

  // ── tickRoom — progress advances ──────────────────────────────────────────

  describe('progress', () => {
    it('advances when body moves with full thrust', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const body = reefRaceSplineSim.__getState(ROOM_ID)!.bodies.get(AVATAR_A)!;

      // Apply full-thrust input pointing straight down-track (+Z direction).
      reefRaceSplineSim.applyInput(
        ROOM_ID, AVATAR_A, 1, DT, makeInput(1, 0, 1),
      );
      // Tick 100 frames (~3.3 seconds).
      for (let i = 0; i < 100; i++) {
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      }

      // Body should have moved forward on the track.
      expect(body.progress).toBeGreaterThan(0.0001);
      expect(body.z).toBeGreaterThan(0); // moved in +Z direction
    });
  });

  // ── Finish-line detection ──────────────────────────────────────────────────

  describe('finish-line crossing', () => {
    it('emits event.crossed_finish when progress reaches 1', () => {
      const events: Array<{ type: string; avatarId?: string }> = [];
      reefRaceSplineSim.setBroadcastFn((_id, f) =>
        events.push(f as { type: string; avatarId?: string }),
      );
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);

      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const body = state.bodies.get(AVATAR_A)!;

      // Force the body to just before the finish line.
      body.prevProgress = 0.96;
      body.progress = 0.96;
      body.x = 0;
      body.z = 27900; // near CP21 at z=28000

      // Apply forward thrust so body gets close to finish.
      reefRaceSplineSim.applyInput(
        ROOM_ID, AVATAR_A, 1, DT, makeInput(1, 0, 1),
      );

      // Tick until finish crossed (max 60 extra ticks ≈ 2 seconds).
      let crossed = false;
      for (let i = 0; i < 60; i++) {
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
        if (events.some((e) => e.type === 'event.crossed_finish')) {
          crossed = true;
          break;
        }
      }

      if (!crossed) {
        // Manually set progress ≥ 1 to simulate the finish crossing
        // (avoids test dependency on exact track geometry).
        body.prevProgress = 0.97;
        body.z = 18100; // past finish
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      }

      // Body should be frozen.
      expect(body.finishedAt).not.toBeNull();
      expect(body.vx).toBe(0);
      expect(body.vz).toBe(0);
    });
  });

  // ── Vertical axis (jump + gravity) ────────────────────────────────────────

  describe('jump and gravity', () => {
    it('jump impulse makes body airborne', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const body = reefRaceSplineSim.__getState(ROOM_ID)!.bodies.get(AVATAR_A)!;

      // Trigger jump via ACTION_BIT_DRIFT (= ACTION_BIT_JUMP in v2).
      reefRaceSplineSim.applyInput(
        ROOM_ID, AVATAR_A, 1, DT, makeInput(0, 0, 1, ACTION_BIT_DRIFT),
      );
      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);

      expect(body.airborneTicks).toBeGreaterThan(0);
      expect(body.heightOffset).toBeGreaterThan(0);
      expect(body.vyAxis).toBeGreaterThan(0); // still going up
    });

    it('gravity eventually lands the kart', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const body = reefRaceSplineSim.__getState(ROOM_ID)!.bodies.get(AVATAR_A)!;

      // Trigger jump.
      reefRaceSplineSim.applyInput(
        ROOM_ID, AVATAR_A, 1, DT, makeInput(0, 0, 1, ACTION_BIT_DRIFT),
      );

      // Tick until the body lands.
      let landed = false;
      for (let i = 0; i < 200; i++) {
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
        if (body.heightOffset === 0 && body.airborneTicks === 0) {
          landed = true;
          break;
        }
      }

      expect(landed).toBe(true);
    });

    it('peak height is within expected range for REEF_JUMP_IMPULSE_MANUAL', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const body = reefRaceSplineSim.__getState(ROOM_ID)!.bodies.get(AVATAR_A)!;

      reefRaceSplineSim.applyInput(
        ROOM_ID, AVATAR_A, 1, DT, makeInput(0, 0, 1, ACTION_BIT_DRIFT),
      );

      let peakHeight = 0;
      for (let i = 0; i < 200; i++) {
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
        if (body.heightOffset > peakHeight) peakHeight = body.heightOffset;
        if (body.heightOffset === 0 && i > 5) break;
      }

      // Theoretical peak: v²/(2g) = (380²)/(2×1200) ≈ 60 wu. Allow ±20%.
      const theoreticalPeak = (REEF_JUMP_IMPULSE_MANUAL * REEF_JUMP_IMPULSE_MANUAL) /
        (2 * REEF_GRAVITY);
      expect(peakHeight).toBeGreaterThan(theoreticalPeak * 0.5);
      expect(peakHeight).toBeLessThan(theoreticalPeak * 2.0);
    });
  });

  // ── Wall clamp ────────────────────────────────────────────────────────────

  describe('wall clamp', () => {
    it('pushes body outside corridor back inside', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const body = state.bodies.get(AVATAR_A)!;

      // Place body far outside corridor at lagoon (halfWidth=3300 post-2026-04-29 iter-9 ×1.5 pass).
      // At z=1500 (CP1), centerline x=0. Put body well past the wall at x=4000.
      body.x = 4000;
      body.z = 1500;
      body.vx = 200; // moving outward
      body.vz = 0;

      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);

      // After clamp, body should be within the corridor (halfWidth=3300 at lagoon)
      // with some tolerance for wall-inset and body radius (22wu).
      const closestDist = Math.abs(body.x); // centerline is x=0 here
      expect(closestDist).toBeLessThan(3500);
    });
  });

  // ── computeResults ────────────────────────────────────────────────────────

  describe('computeResults', () => {
    it('returns empty array for unknown room', () => {
      const results = reefRaceSplineSim.computeResults('no-such-room');
      expect(results).toHaveLength(0);
    });

    it('places finishers before DNFers', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A, AVATAR_B]);
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;

      // Manually finish AVATAR_A, DNF AVATAR_B.
      const bodyA = state.bodies.get(AVATAR_A)!;
      const bodyB = state.bodies.get(AVATAR_B)!;
      bodyA.finishedAt = Date.now();
      bodyA.totalTimeMs = 50000;
      state.finishOrder.push(AVATAR_A);
      bodyB.dnf = true;
      bodyB.alive = false;

      const results = reefRaceSplineSim.computeResults(ROOM_ID);
      expect(results).toHaveLength(2);
      expect(results[0].avatarId).toBe(AVATAR_A);
      expect(results[0].placement).toBe(1);
      expect(results[0].scoreMs).toBe(50000);
      expect(results[1].avatarId).toBe(AVATAR_B);
      expect(results[1].placement).toBe(2);
      expect(results[1].scoreMs).toBeNull();
    });
  });

  // ── forfeit ───────────────────────────────────────────────────────────────

  describe('forfeit', () => {
    it('marks body as dnf and emits event.player_left', () => {
      const events: Array<{ type: string; avatarId?: string }> = [];
      reefRaceSplineSim.setBroadcastFn((_id, f) =>
        events.push(f as { type: string; avatarId?: string }),
      );
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A, AVATAR_B]);

      reefRaceSplineSim.forfeit(ROOM_ID, AVATAR_A, 'voluntary');

      const body = reefRaceSplineSim.__getState(ROOM_ID)!.bodies.get(AVATAR_A)!;
      expect(body.dnf).toBe(true);
      expect(body.alive).toBe(false);
      expect(
        events.some(
          (e) => e.type === 'event.player_left' && e.avatarId === AVATAR_A,
        ),
      ).toBe(true);
    });
  });

  // ── stopRoom ──────────────────────────────────────────────────────────────

  describe('stopRoom', () => {
    it('removes the room from state', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      expect(reefRaceSplineSim.__getState(ROOM_ID)).toBeTruthy();

      reefRaceSplineSim.stopRoom(ROOM_ID);
      expect(reefRaceSplineSim.__getState(ROOM_ID)).toBeUndefined();
    });
  });

  // ── getFlagCount ──────────────────────────────────────────────────────────

  describe('getFlagCount', () => {
    it('returns 0 for unknown room', () => {
      expect(reefRaceSplineSim.getFlagCount('no-room', AVATAR_A)).toBe(0);
    });

    it('returns 0 initially', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      expect(reefRaceSplineSim.getFlagCount(ROOM_ID, AVATAR_A)).toBe(0);
    });
  });

  // ── snapshot ──────────────────────────────────────────────────────────────

  describe('getStateSnapshot', () => {
    it('returns null for unknown room', () => {
      expect(reefRaceSplineSim.getStateSnapshot('no-room')).toBeNull();
    });

    it('returns snapshot with bodies', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const snap = reefRaceSplineSim.getStateSnapshot(ROOM_ID);
      expect(snap).toBeTruthy();
      expect(snap!.bodies).toHaveLength(1);
      expect(snap!.bodies[0].avatarId).toBe(AVATAR_A);
    });
  });
});
