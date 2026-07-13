/**
 * Reef Race v2 — race-mechanics tests (§18d.v7, 2026-07-10).
 *
 * Locks in the Codex-round-2 fixes for the new competitive layer:
 *   - Boost pads: ENTRY-EDGE trigger (no re-fire while sitting inside) +
 *     AIRBORNE reject (floor pads have no vertical reach).
 *   - rr-ink-slick: slows RIVALS (behind the dropper), never the user.
 *   - rr-whirlpool: pulls rivals AND clamps the victim's speed to the 1202.5 cap.
 *   - Deterministic sim clock: identical input+tick sequences → identical
 *     trajectories (no Date.now() in the sim).
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// Silence DB/event-logger + replay wires (mirrors reef-race-spline-sim.test.ts).
mock.module('../../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: { ANTI_CHEAT_FLAG: 'anti_cheat.flag' },
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

const { reefRaceSplineSim } = await import('../reef-race-spline-sim');
const {
  REEF_TICK_HZ,
  REEF_MAX_SPEED,
  ACTION_BIT_POWERUP_0,
  buildSplineBoostPads,
} = await import('../reef-race-config');

const DT = 1 / REEF_TICK_HZ;
const A = 'avatar-A';
const B = 'avatar-B';

function input(thrust = 0, dirX = 0, dirZ = 1, actionBits = 0) {
  return { thrust, dir: { x: dirX, y: dirZ }, actionBits };
}

/** World-space center of a boost pad (mirrors resolveBoostPads' math). */
function padWorldCenter(state: any, padIndex: number) {
  const pad = buildSplineBoostPads()[padIndex];
  const pt = state.spline.centerlineAt(pad.t);
  const tang = state.spline.tangentAt(pad.t);
  const nx = -tang.z;
  const nz = tang.x;
  return {
    id: pad.id,
    x: pt.x + nx * pad.lateralOffset,
    z: pt.z + nz * pad.lateralOffset,
  };
}

describe('ReefRaceSplineSim — race mechanics (v7)', () => {
  beforeEach(() => reefRaceSplineSim.__resetForTest());

  // ── Boost pads ────────────────────────────────────────────────────────────

  describe('boost pads', () => {
    it('fires on ENTRY and does NOT re-fire while the body sits inside', () => {
      const events: Array<{ type: string; padId?: string }> = [];
      reefRaceSplineSim.setBroadcastFn((_id, f) =>
        events.push(f as { type: string; padId?: string }),
      );
      reefRaceSplineSim.startRoom('r-pad', 'reef-race', [A]);
      const state = reefRaceSplineSim.__getState('r-pad')!;
      const body = state.bodies.get(A)!;

      const pad = padWorldCenter(state, 0);
      // Park the body dead-centre on the pad, grounded, no velocity/thrust.
      body.x = pad.x;
      body.z = pad.z;
      body.vx = 0;
      body.vz = 0;
      body.heightOffset = 0;
      body.airborneTicks = 0;

      events.length = 0;
      reefRaceSplineSim.__tickOnceForTest('r-pad'); // entry tick → fires once
      reefRaceSplineSim.__tickOnceForTest('r-pad'); // still inside → NO re-fire
      reefRaceSplineSim.__tickOnceForTest('r-pad'); // still inside → NO re-fire

      const padEvents = events.filter((e) => e.type === 'event.boost_pad');
      expect(padEvents.length).toBe(1);
      expect(padEvents[0].padId).toBe(pad.id);
      expect(body.activeBoosts.has('pad-boost')).toBe(true);
    });

    it('does NOT trigger for an AIRBORNE body over the pad', () => {
      const events: Array<{ type: string }> = [];
      reefRaceSplineSim.setBroadcastFn((_id, f) =>
        events.push(f as { type: string }),
      );
      reefRaceSplineSim.startRoom('r-pad-air', 'reef-race', [A]);
      const state = reefRaceSplineSim.__getState('r-pad-air')!;
      const body = state.bodies.get(A)!;

      const pad = padWorldCenter(state, 0);
      body.x = pad.x;
      body.z = pad.z;
      body.vx = 0;
      body.vz = 0;
      // Airborne over the pad — floor pads must not reach up.
      body.heightOffset = 60;
      body.vyAxis = 100;
      body.airborneTicks = 1;

      events.length = 0;
      reefRaceSplineSim.__tickOnceForTest('r-pad-air');

      expect(events.some((e) => e.type === 'event.boost_pad')).toBe(false);
      expect(body.activeBoosts.has('pad-boost')).toBe(false);
    });
  });

  // ── Item fixes ──────────────────────────────────────────────────────────────

  describe('rr-ink-slick', () => {
    it('slows a RIVAL behind the dropper, never the user', () => {
      reefRaceSplineSim.startRoom('r-ink', 'reef-race', [A, B]);
      const state = reefRaceSplineSim.__getState('r-ink')!;
      const src = state.bodies.get(A)!;
      const rival = state.bodies.get(B)!;

      // Src faces +Z; place the rival BEHIND (−Z) within INK_SLICK_RADIUS.
      src.rot = 0;
      src.x = 0;
      src.z = 0;
      src.vx = 0;
      src.vz = 0;
      rival.x = 0;
      rival.z = -120; // behind, ~120 wu (< 260)
      rival.vx = 0;
      rival.vz = 0;
      src.inventory[0] = { kind: 'rr-ink-slick', charges: 1, cooldownUntil: 0 };

      reefRaceSplineSim.applyInput('r-ink', A, 1, DT, input(0, 0, 1, ACTION_BIT_POWERUP_0));
      reefRaceSplineSim.__tickOnceForTest('r-ink');

      expect(rival.activeEffects.has('rr-ink-slick')).toBe(true);
      expect(src.activeEffects.has('rr-ink-slick')).toBe(false); // never self
    });
  });

  describe('rr-whirlpool', () => {
    it('pulls a nearby rival but clamps the victim speed to the 1202.5 cap', () => {
      reefRaceSplineSim.startRoom('r-whirl', 'reef-race', [A, B]);
      const state = reefRaceSplineSim.__getState('r-whirl')!;
      const src = state.bodies.get(A)!;
      const rival = state.bodies.get(B)!;

      src.rot = 0;
      src.x = 0;
      src.z = 0;
      src.vx = 0;
      src.vz = 0;
      // Rival close (60 wu) and already near top speed heading toward src (+Z),
      // so the pull would push it past the cap without the clamp.
      rival.rot = 0;
      rival.x = 0;
      rival.z = -60;
      rival.vx = 0;
      rival.vz = REEF_MAX_SPEED * 1.8;
      src.inventory[0] = { kind: 'rr-whirlpool', charges: 1, cooldownUntil: 0 };

      reefRaceSplineSim.applyInput('r-whirl', A, 1, DT, input(0, 0, 1, ACTION_BIT_POWERUP_0));
      reefRaceSplineSim.__tickOnceForTest('r-whirl');

      // Victim got the slow AND its speed is clamped to the hard cap.
      expect(rival.activeBoosts.has('hazard-slow')).toBe(true);
      const speed = Math.hypot(rival.vx, rival.vz);
      expect(speed).toBeLessThanOrEqual(REEF_MAX_SPEED * 1.85 + 1e-6);
    });
  });

  // ── Start-line shuttle (anti lap-farm) ──────────────────────────────────────

  describe('start-line shuttle anti-farm', () => {
    it('oscillating across the start/finish seam never nets a lap or finishes', () => {
      reefRaceSplineSim.setBroadcastFn(() => {});
      reefRaceSplineSim.startRoom('r-shuttle', 'reef-race', [A]);
      const state = reefRaceSplineSim.__getState('r-shuttle')!;
      const body = state.bodies.get(A)!;

      const placeAtT = (t: number) => {
        const p = state.spline.centerlineAt(t);
        body.x = p.x;
        body.z = p.z;
        body.vx = 0;
        body.vz = 0;
      };

      // Seed progress just behind the line.
      placeAtT(0.999);
      reefRaceSplineSim.__tickOnceForTest('r-shuttle');

      // Shuttle across the seam many times: forward (0.999→0.002) then backward
      // (0.002→0.998). The old code read the backward cross as +0.98 "forward
      // progress", letting the next forward cross farm a lap toward a FINISH.
      for (let i = 0; i < 8; i++) {
        placeAtT(0.002);
        reefRaceSplineSim.__tickOnceForTest('r-shuttle'); // forward seam cross
        placeAtT(0.998);
        reefRaceSplineSim.__tickOnceForTest('r-shuttle'); // backward seam cross
      }

      // A backward cross undoes each forward cross → lap never accrues, never
      // finishes. (A genuine full forward loop is the only way to a lap.)
      expect(body.lap).toBe(0);
      expect(body.finishedAt).toBeNull();
    });
  });

  // ── Determinism (sim clock) ─────────────────────────────────────────────────

  describe('deterministic sim clock', () => {
    it('identical input+tick sequences produce identical trajectories', () => {
      reefRaceSplineSim.setBroadcastFn(() => {});
      const opts = { startedAt: 1_000_000, seed: 42 };
      reefRaceSplineSim.startRoom('r-det-1', 'reef-race', [A], opts);
      reefRaceSplineSim.startRoom('r-det-2', 'reef-race', [A], opts);

      const s1 = reefRaceSplineSim.__getState('r-det-1')!;
      const s2 = reefRaceSplineSim.__getState('r-det-2')!;
      const tg = s1.spline.tangentAt(0);

      for (let i = 0; i < 90; i++) {
        // Same input to both rooms every tick — a carving drive so boosts/
        // mini-turbo/expiries all exercise the clock.
        const dirX = tg.x + Math.sin(i * 0.3) * 0.4;
        const dirZ = tg.z + Math.cos(i * 0.3) * 0.4;
        reefRaceSplineSim.applyInput('r-det-1', A, 10 + i, DT, input(1, dirX, dirZ));
        reefRaceSplineSim.applyInput('r-det-2', A, 10 + i, DT, input(1, dirX, dirZ));
        reefRaceSplineSim.__tickOnceForTest('r-det-1');
        reefRaceSplineSim.__tickOnceForTest('r-det-2');
      }

      const b1 = s1.bodies.get(A)!;
      const b2 = s2.bodies.get(A)!;
      expect(b1.x).toBe(b2.x);
      expect(b1.z).toBe(b2.z);
      expect(b1.vx).toBe(b2.vx);
      expect(b1.vz).toBe(b2.vz);
      expect(b1.rot).toBe(b2.rot);
      expect(s1.simTimeMs).toBe(s2.simTimeMs);
    });
  });
});
