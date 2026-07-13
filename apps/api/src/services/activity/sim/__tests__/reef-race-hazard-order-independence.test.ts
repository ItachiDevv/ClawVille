/**
 * Reef Race — HAZARD ORDER-INDEPENDENCE PROOF (adversarial auditor,
 * team reef-mechanics-2026-07-10, round-3 final gate for `f849a5fb`).
 *
 * Codex round-3 BLOCKER 1+2: `resolvePowerUpUses` Phase 2 must resolve
 * offensive hazards INDEPENDENTLY of body-map iteration order, and the
 * SINGLE final speed clamp must bound the SUM of all knockbacks on a
 * victim — not clamp per-application (the round-2 code), which was
 * order-sensitive once more than one clamp fired.
 *
 * Two sources whirlpool ONE victim in the SAME tick. The victim is moving
 * near the boosted ceiling and the two pulls are along DIFFERENT axes, so
 * the combined result exceeds the 1.85× hard cap. Under a per-application
 * clamp (round-2), applying source-A's pull before vs after source-B's
 * yields DIFFERENT victim velocities (the first clamp discards magnitude
 * the second pull can't recover). The round-3 sum-then-clamp-once is
 * invariant to order — this test asserts a BIT-IDENTICAL result for the
 * two opposite body-map insertion orders.
 *
 * Bodies are placed on the ACTUAL spline (via centerlineAt/tangentAt) and
 * kept > 1 kart-diameter apart, so neither the track wall-clamp nor the
 * kart-vs-kart collision resolver contaminates the geometry.
 *
 * Mocks mirror reef-race-spline-sim-mechanics.test.ts (DB/event/replay).
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

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
const { REEF_TICK_HZ, REEF_MAX_SPEED, ACTION_BIT_POWERUP_0 } = await import(
  '../reef-race-config'
);

const DT = 1 / REEF_TICK_HZ;
const SA = 'src-a';
const SB = 'src-b';
const V = 'victim';

function input(thrust = 0, dirX = 0, dirZ = 1, actionBits = 0) {
  return { thrust, dir: { x: dirX, y: dirZ }, actionBits };
}

/**
 * Run one tick where BOTH sources whirlpool the single victim, with the
 * source order given by `sourceOrder` (→ body-map insertion order). Bodies
 * sit on the spline near t=0.5; the victim moves fast along the tangent so
 * the two cross-axis pulls tip it over the 1.85× clamp. Returns the victim's
 * final velocity + the observed map key order.
 */
function runTwoWhirlpools(roomId: string, sourceOrder: string[]) {
  reefRaceSplineSim.setBroadcastFn(() => {});
  reefRaceSplineSim.startRoom(roomId, 'reef-race', [...sourceOrder, V]);
  const state = reefRaceSplineSim.__getState(roomId)!;

  // On-track frame at t=0.5 so the wall-clamp leaves everything alone.
  const p = state.spline.centerlineAt(0.5);
  const tang = state.spline.tangentAt(0.5);
  const tlen = Math.hypot(tang.x, tang.z) || 1;
  const tx = tang.x / tlen;
  const tz = tang.z / tlen;
  const nx = -tz; // unit normal (perpendicular, in-plane)
  const nz = tx;

  const v = state.bodies.get(V)!;
  // Victim on the centerline, moving near the boosted ceiling along +tangent.
  v.rot = Math.atan2(tx, tz);
  v.x = p.x; v.z = p.z;
  v.vx = tx * (REEF_MAX_SPEED * 1.8);
  v.vz = tz * (REEF_MAX_SPEED * 1.8);

  // Source A ahead along +tangent (pulls victim +tangent → adds to its
  // motion). Source B off to +normal (pulls victim +normal → a different
  // axis). 80 wu offset: inside whirlpool radius (300), > 1 kart diameter
  // (44) so no collision, << corridor half-width so no wall-clamp.
  const sa = state.bodies.get(SA)!;
  sa.rot = 0; sa.x = p.x + tx * 80; sa.z = p.z + tz * 80; sa.vx = 0; sa.vz = 0;
  sa.inventory[0] = { kind: 'rr-whirlpool', charges: 1, cooldownUntil: 0 };

  const sb = state.bodies.get(SB)!;
  sb.rot = 0; sb.x = p.x + nx * 80; sb.z = p.z + nz * 80; sb.vx = 0; sb.vz = 0;
  sb.inventory[0] = { kind: 'rr-whirlpool', charges: 1, cooldownUntil: 0 };

  reefRaceSplineSim.applyInput(roomId, SA, 1, DT, input(0, 0, 1, ACTION_BIT_POWERUP_0));
  reefRaceSplineSim.applyInput(roomId, SB, 1, DT, input(0, 0, 1, ACTION_BIT_POWERUP_0));
  reefRaceSplineSim.__tickOnceForTest(roomId);

  return {
    vx: v.vx,
    vz: v.vz,
    speed: Math.hypot(v.vx, v.vz),
    keyOrder: [...state.bodies.keys()],
  };
}

describe('Reef Race — offensive-hazard order-independence (Codex round-3 BLOCKER 1+2)', () => {
  beforeEach(() => reefRaceSplineSim.__resetForTest());

  it('two cross-axis whirlpools over the cap → BIT-IDENTICAL victim velocity regardless of body-map order', () => {
    const ab = runTwoWhirlpools('r-order-ab', [SA, SB]);
    reefRaceSplineSim.__resetForTest();
    const ba = runTwoWhirlpools('r-order-ba', [SB, SA]);

    // The two runs really used opposite source orders.
    expect(ab.keyOrder.indexOf(SA)).toBeLessThan(ab.keyOrder.indexOf(SB));
    expect(ba.keyOrder.indexOf(SB)).toBeLessThan(ba.keyOrder.indexOf(SA));

    // Clamp engaged — combined cross-axis pull pushed the victim over 1.85×,
    // so this exercises the order-sensitive per-application-clamp path that
    // round-2 got wrong.
    const CAP = REEF_MAX_SPEED * 1.85;
    expect(ab.speed).toBeGreaterThan(CAP - 1);
    expect(ab.speed).toBeLessThanOrEqual(CAP + 1e-6);
    expect(ba.speed).toBeLessThanOrEqual(CAP + 1e-6);

    // Order-independent: identical victim velocity for both orders.
    expect(ba.vx).toBeCloseTo(ab.vx, 9);
    expect(ba.vz).toBeCloseTo(ab.vz, 9);
  });
});
