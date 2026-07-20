/**
 * Reef Race v2 — race-mechanics tests (§18d.v7, 2026-07-10).
 *
 * Locks in the Codex-round-2 fixes for the new competitive layer:
 *   - Boost pads: ENTRY-EDGE trigger (no re-fire while sitting inside) +
 *     AIRBORNE reject (floor pads have no vertical reach).
 *   - rr-ink-slick: slows RIVALS (behind the dropper), never the user.
 *   - rr-whirlpool: pulls rivals AND clamps the victim's speed to the 2405 cap (1.85× @ 2× speed cap).
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
  computeReefBoostPadKick,
  integrateSurfStep,
  parabolicRefineOffset,
  ReefSpline,
  REEF_RACE_DEFAULT_TRACK,
  reefTrackElevationAt,
} = await import('@clawville/shared');
const {
  REEF_TICK_HZ,
  REEF_MAX_SPEED,
  REEF_MAX_ACCEL,
  REEF_TURN_RATE,
  REEF_TURN_SPEED_FALLOFF,
  REEF_AIRBORNE_STEER_MULT,
  REEF_FORWARD_DRAG,
  REEF_LATERAL_GRIP,
  ACTION_BIT_POWERUP_0,
  BOOST_PAD_KICK,
  REEF_POWERUP_RESPAWN_MS,
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

describe('parabolic closest-sample refinement', () => {
  it('returns exact symmetric, asymmetric, degenerate, and clamped offsets', () => {
    const dt = 0.1;
    expect(parabolicRefineOffset(4, 1, 4, dt)).toBe(0);
    expect(parabolicRefineOffset(4, 1, 2, dt)).toBeCloseTo(dt / 4, 12);
    expect(parabolicRefineOffset(1, 1, 1, dt)).toBe(0);
    expect(parabolicRefineOffset(100, 10, 9, dt)).toBe(dt / 2);
    expect(parabolicRefineOffset(9, 10, 100, dt)).toBe(-dt / 2);
  });

  it('keeps real-track elevation continuous across three LUT cells', () => {
    const spline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });
    const lutSamples = 1000;
    const dt = 1 / lutSamples;
    const startT = 0.12;
    const endT = startT + 3 * dt;
    const scanCenter = Math.round((startT + endT) * 0.5 * lutSamples);
    const start = spline.centerlineAt(startT);
    const end = spline.centerlineAt(endT);
    const chordX = end.x - start.x;
    const chordZ = end.z - start.z;
    const querySteps = Math.ceil(Math.hypot(chordX, chordZ) / 10);

    // Inline warm-path mirror: local coarse scan followed by wrapped-neighbour
    // parabolic refinement. The fixed window contains this three-cell walk.
    const refinedTAt = (x: number, z: number): number => {
      let bestIndex = scanCenter;
      let bestDistSq = Infinity;
      for (let d = -6; d <= 6; d++) {
        const index = ((scanCenter + d) % lutSamples + lutSamples) % lutSamples;
        const point = spline.centerlineAt(index * dt);
        const dx = point.x - x;
        const dz = point.z - z;
        const distSq = dx * dx + dz * dz;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestIndex = index;
        }
      }

      const prev = spline.centerlineAt(((bestIndex + lutSamples - 1) % lutSamples) * dt);
      const next = spline.centerlineAt(((bestIndex + 1) % lutSamples) * dt);
      const prevDx = prev.x - x;
      const prevDz = prev.z - z;
      const nextDx = next.x - x;
      const nextDz = next.z - z;
      const offset = parabolicRefineOffset(
        prevDx * prevDx + prevDz * prevDz,
        bestDistSq,
        nextDx * nextDx + nextDz * nextDz,
        dt,
      );
      const refined = bestIndex * dt + offset;
      return ((refined % 1) + 1) % 1;
    };

    let fullCellElevationDelta = 0;
    for (let i = 0; i < 3; i++) {
      fullCellElevationDelta = Math.max(
        fullCellElevationDelta,
        Math.abs(
          reefTrackElevationAt(startT + (i + 1) * dt)
            - reefTrackElevationAt(startT + i * dt),
        ),
      );
    }
    expect(querySteps).toBeGreaterThan(3);
    expect(fullCellElevationDelta).toBeGreaterThan(0);

    let previousY = reefTrackElevationAt(refinedTAt(start.x, start.z));
    for (let step = 1; step <= querySteps; step++) {
      const alpha = step / querySteps;
      const x = start.x + chordX * alpha;
      const z = start.z + chordZ * alpha;
      const y = reefTrackElevationAt(refinedTAt(x, z));
      expect(Math.abs(y - previousY)).toBeLessThanOrEqual(
        fullCellElevationDelta * 0.2,
      );
      previousY = y;
    }
  });
});

describe('ReefRaceSplineSim — race mechanics (v7)', () => {
  beforeEach(() => reefRaceSplineSim.__resetForTest());

  // ── Boost pads ────────────────────────────────────────────────────────────

  describe('boost pads', () => {
    it('keeps client/server pad-kick parity (same inputs -> same velocity result)', () => {
      reefRaceSplineSim.setBroadcastFn(() => {});
      reefRaceSplineSim.startRoom('r-pad-parity', 'reef-race', [A]);
      const state = reefRaceSplineSim.__getState('r-pad-parity')!;
      const body = state.bodies.get(A)!;
      const pad = padWorldCenter(state, 0);

      body.x = pad.x;
      body.z = pad.z;
      body.vx = 0;
      body.vz = 0;
      body.rot = 0.37;
      body.heightOffset = 0;
      body.airborneTicks = 0;

      const expected = { vx: body.vx, vz: body.vz };
      computeReefBoostPadKick(
        expected.vx,
        expected.vz,
        body.rot,
        REEF_MAX_SPEED,
        expected,
      );

      reefRaceSplineSim.__tickOnceForTest('r-pad-parity');

      expect(BOOST_PAD_KICK).toBe(416);
      expect(body.vx).toBeCloseTo(expected.vx, 12);
      expect(body.vz).toBeCloseTo(expected.vz, 12);
    });

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

  describe('pickup collection reach', () => {
    function arrangePass(roomId: string, bodyLateralOffset: number) {
      reefRaceSplineSim.setBroadcastFn(() => {});
      reefRaceSplineSim.startRoom(roomId, 'reef-race', [A]);
      const state = reefRaceSplineSim.__getState(roomId)!;
      const body = state.bodies.get(A)!;
      const pickup = state.pickups[0]!;
      const pickupT = 0.5 / 8;
      const center = state.spline.centerlineAt(pickupT);
      const tangent = state.spline.tangentAt(pickupT);
      const normal = state.spline.normalAt(pickupT);

      for (const candidate of state.pickups) {
        candidate.active = false;
        candidate.respawnAt = Number.MAX_SAFE_INTEGER;
      }
      pickup.active = true;
      pickup.collectedAt = null;
      pickup.respawnAt = 0;

      // One authority tick carries the kart through the box's longitudinal
      // plane. The spawned box itself remains 40wu off the centerline.
      body.x = center.x + normal.x * bodyLateralOffset - tangent.x * 30;
      body.z = center.z + normal.z * bodyLateralOffset - tangent.z * 30;
      body.vx = tangent.x * 900;
      body.vz = tangent.z * 900;
      body.rot = Math.atan2(tangent.x, tangent.z);
      body.heightOffset = 0;
      body.airborneTicks = 0;

      reefRaceSplineSim.__tickOnceForTest(roomId);
      return { body, pickup };
    }

    it('collects a box 40wu off a centerline pass and starts its respawn timer', () => {
      const { body, pickup } = arrangePass('r-pickup-centerline', 0);

      expect(body.inventory[0].kind).not.toBeNull();
      expect(body.inventory[0].charges).toBe(1);
      expect(pickup.active).toBe(false);
      expect(pickup.collectedAt).not.toBeNull();
      expect(pickup.respawnAt).toBe(
        pickup.collectedAt! + REEF_POWERUP_RESPAWN_MS,
      );
    });

    it('does not collect that box from a 150wu lateral racing line', () => {
      const { body, pickup } = arrangePass('r-pickup-far', 150);

      expect(body.inventory.every((slot) => slot.kind === null)).toBe(true);
      expect(pickup.active).toBe(true);
      expect(pickup.collectedAt).toBeNull();
      expect(pickup.respawnAt).toBe(0);
    });
  });

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
    it('pulls a nearby rival but clamps the victim speed to the 2405 cap (1.85× @ 2× speed cap)', () => {
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

  describe('held steering target refresh', () => {
    const params = {
      maxSpeed: REEF_MAX_SPEED,
      maxAccel: REEF_MAX_ACCEL,
      turnRate: REEF_TURN_RATE,
      turnSpeedFalloff: REEF_TURN_SPEED_FALLOFF,
      airborneSteerMult: REEF_AIRBORNE_STEER_MULT,
      forwardDrag: REEF_FORWARD_DRAG,
      lateralGrip: REEF_LATERAL_GRIP,
      speedMod: 1,
      accelMult: 1,
    };
    const TURN_BIAS = 0.12;

    it('recomputed held-A target keeps advancing at the effective limiter rate', () => {
      let state = { x: 0, z: 0, vx: 0, vz: 0, rot: 0 };
      let measuredYaw = 0;
      let integratedLimiter = 0;

      for (let tick = 0; tick < 90; tick++) {
        // Mirror the client helper: target = current-heading forward + right*0.12.
        const fwdX = Math.sin(state.rot);
        const fwdZ = Math.cos(state.rot);
        const rightX = Math.cos(state.rot);
        const rightZ = -Math.sin(state.rot);
        const dirX = fwdX + rightX * TURN_BIAS;
        const dirZ = fwdZ + rightZ * TURN_BIAS;
        const mag = Math.hypot(dirX, dirZ);
        const speedFrac = Math.min(1, Math.hypot(state.vx, state.vz) / REEF_MAX_SPEED);
        const limiter =
          REEF_TURN_RATE * (1 - REEF_TURN_SPEED_FALLOFF * speedFrac) * DT;
        const next = integrateSurfStep(
          state,
          { dir: { x: dirX / mag, z: dirZ / mag }, thrust: 1, airborne: false },
          params,
          DT,
        );
        const delta = Math.atan2(
          Math.sin(next.rot - state.rot),
          Math.cos(next.rot - state.rot),
        );
        if (tick >= 30) {
          expect(delta).toBeGreaterThan(0);
          measuredYaw += delta;
          integratedLimiter += limiter;
        }
        state = next;
      }

      // 60 post-convergence ticks: no plateau, full 2.86 rad limiter integral.
      expect(measuredYaw).toBeCloseTo(2.86, 6);
      expect(integratedLimiter).toBeCloseTo(2.86, 6);
      expect(measuredYaw).toBeGreaterThanOrEqual(integratedLimiter * 0.85);
    });

    it('fixed initial target reproduces the old dead-pause shape', () => {
      let state = { x: 0, z: 0, vx: 0, vz: 0, rot: 0 };
      const fixedMag = Math.hypot(TURN_BIAS, 1);
      const fixedDir = { x: TURN_BIAS / fixedMag, z: 1 / fixedMag };
      let totalYaw = 0;
      let tick0Delta = 0;
      let tick1Delta = 0;

      for (let tick = 0; tick < 90; tick++) {
        const next = integrateSurfStep(
          state,
          { dir: fixedDir, thrust: 1, airborne: false },
          params,
          DT,
        );
        const delta = Math.atan2(
          Math.sin(next.rot - state.rot),
          Math.cos(next.rot - state.rot),
        );
        if (tick === 0) tick0Delta = delta;
        if (tick === 1) tick1Delta = delta;
        if (tick >= 2) expect(Math.abs(delta)).toBeLessThan(1e-12);
        totalYaw += delta;
        state = next;
      }

      expect(tick0Delta).toBeCloseTo(0.086666667, 8);
      expect(tick1Delta).toBeCloseTo(0.032762259, 8);
      expect(totalYaw).toBeCloseTo(Math.atan(TURN_BIAS), 9);
      expect(totalYaw).toBeCloseTo(0.119428926, 8);
    });
  });

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
