/**
 * SPEC 3 — Ramp launch unit tests for reef-race-spline-sim.ts.
 *
 * Coverage (5 cases from plan Section C.8):
 *   1. Grounded body at ramp position receives ramp launch impulse + event
 *   2. No re-trigger within cooldown window
 *   3. Airborne body on ramp does NOT trigger
 *   4. Body outside AABB halfLength by 1wu does NOT trigger
 *   5. Triggers AFTER cooldown expires
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

const { reefRaceSplineSim } = await import('../reef-race-spline-sim');
const {
  REEF_JUMP_IMPULSE_RAMP,
  RAMP_COOLDOWN_MS,
  RAMP_HALF_LENGTH,
  buildSplineRamps,
} = await import('../reef-race-config');

// Must import ReefSpline + default track to compute ramp world positions in tests.
const { ReefSpline } = await import('../reef-race-spline');
const { REEF_RACE_DEFAULT_TRACK } = await import('../reef-race-track-layout');

const ROOM_ID = 'ramp-test-room';
const AVATAR_A   = 'ramp-avatar-A';

// Build a shared spline instance for test position computation. MUST be CLOSED
// (2026-06-22) to match the sim's `new ReefSpline(..., { closed: true })` — the
// ramp world positions are derived from centerlineAt(ramp.t), which differs
// between the OPEN and CLOSED splines, so an OPEN test spline would place the
// body at the wrong spot and the ramp would never trigger.
const _testSpline = new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true });

/**
 * Returns the world (x, z) center of ramp with given id.
 * Uses the same logic as resolveRamps().
 */
function getRampCenter(rampId: string): { cx: number; cz: number } {
  const ramp = buildSplineRamps().find((r) => r.id === rampId);
  if (!ramp) throw new Error(`No ramp with id '${rampId}'`);
  const pt   = _testSpline.centerlineAt(ramp.t);
  const tang = _testSpline.tangentAt(ramp.t);
  const nx   = -tang.z;
  const nz   =  tang.x;
  return {
    cx: pt.x + nx * ramp.lateralOffset,
    cz: pt.z + nz * ramp.lateralOffset,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('resolveRamps (SPEC 3)', () => {
  beforeEach(() => {
    reefRaceSplineSim.__resetForTest();
  });

  // ── Case 1: grounded body at ramp → launch + event ────────────────────────

  it('launches a grounded body at ramp-canyon-2 position', () => {
    const events: Array<{ type: string; avatarId?: string; rampId?: string; launchVel?: number }> = [];
    reefRaceSplineSim.setBroadcastFn((_id, frame) =>
      events.push(frame as typeof events[0]),
    );
    reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);

    const state = reefRaceSplineSim.__getState(ROOM_ID)!;
    const body  = state.bodies.get(AVATAR_A)!;

    // Place body exactly at ramp-canyon-2 center.
    const { cx, cz } = getRampCenter('ramp-canyon-2');
    body.x           = cx;
    body.z           = cz;
    body.heightOffset = 0;
    body.airborneTicks = 0;

    const prevVyAxis = body.vyAxis;

    reefRaceSplineSim.__tickOnceForTest(ROOM_ID);

    // vyAxis must have increased by at least REEF_JUMP_IMPULSE_RAMP.
    expect(body.vyAxis).toBeGreaterThanOrEqual(prevVyAxis + REEF_JUMP_IMPULSE_RAMP);
    // airborneTicks must be > 0 after launch.
    expect(body.airborneTicks).toBeGreaterThan(0);

    // event.ramp_launch must have been broadcast.
    const launchEvent = events.find(
      (e) => e.type === 'event.ramp_launch' && e.avatarId === AVATAR_A,
    );
    expect(launchEvent).toBeTruthy();
    expect(launchEvent!.rampId).toBe('ramp-canyon-2');
    expect(launchEvent!.launchVel).toBe(REEF_JUMP_IMPULSE_RAMP);
  });

  // ── Case 2: no re-trigger within cooldown ─────────────────────────────────

  it('does NOT re-trigger within cooldown window', () => {
    const events: Array<{ type: string }> = [];
    reefRaceSplineSim.setBroadcastFn((_id, frame) =>
      events.push(frame as { type: string }),
    );
    reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);

    const state = reefRaceSplineSim.__getState(ROOM_ID)!;
    const body  = state.bodies.get(AVATAR_A)!;
    const { cx, cz } = getRampCenter('ramp-canyon-2');

    // First tick — launch.
    body.x = cx; body.z = cz; body.heightOffset = 0; body.airborneTicks = 0;
    reefRaceSplineSim.__tickOnceForTest(ROOM_ID);

    const countAfterFirst = events.filter((e) => e.type === 'event.ramp_launch').length;
    expect(countAfterFirst).toBe(1);

    // Force body grounded again (simulate landing) WITHOUT advancing real time.
    // The rampCooldown was set to now + RAMP_COOLDOWN_MS using Date.now() in tickRoom.
    // We cannot advance Date.now() in tests, so we use the sub-ms window where
    // Date.now() < cooldownExpiry. Simply retick — cooldown is still active.
    body.heightOffset  = 0;
    body.airborneTicks = 0;
    body.x = cx; body.z = cz;

    reefRaceSplineSim.__tickOnceForTest(ROOM_ID);

    // No second event within cooldown.
    const countAfterSecond = events.filter((e) => e.type === 'event.ramp_launch').length;
    expect(countAfterSecond).toBe(1);
  });

  // ── Case 3: airborne body on ramp → no trigger ────────────────────────────

  it('does NOT trigger when body is already airborne (airborneTicks > 0)', () => {
    const events: Array<{ type: string }> = [];
    reefRaceSplineSim.setBroadcastFn((_id, frame) =>
      events.push(frame as { type: string }),
    );
    reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);

    const state = reefRaceSplineSim.__getState(ROOM_ID)!;
    const body  = state.bodies.get(AVATAR_A)!;
    const { cx, cz } = getRampCenter('ramp-canyon-2');

    // Airborne: airborneTicks=1, heightOffset=50
    body.x = cx; body.z = cz;
    body.heightOffset  = 50;
    body.airborneTicks = 1;

    reefRaceSplineSim.__tickOnceForTest(ROOM_ID);

    const rampEvents = events.filter((e) => e.type === 'event.ramp_launch');
    expect(rampEvents.length).toBe(0);
  });

  // ── Case 4: body 1wu past halfLength → no trigger ─────────────────────────

  it('does NOT trigger when body is outside AABB half-length by 1wu', () => {
    const events: Array<{ type: string }> = [];
    reefRaceSplineSim.setBroadcastFn((_id, frame) =>
      events.push(frame as { type: string }),
    );
    reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);

    const state = reefRaceSplineSim.__getState(ROOM_ID)!;
    const body  = state.bodies.get(AVATAR_A)!;

    // Get ramp-canyon-2 center and tangent direction.
    const ramp = buildSplineRamps().find((r) => r.id === 'ramp-canyon-2')!;
    const pt   = _testSpline.centerlineAt(ramp.t);
    const tang = _testSpline.tangentAt(ramp.t);
    const { cx, cz } = getRampCenter('ramp-canyon-2');

    // Place body 1wu BEYOND half-length along the tangent direction.
    const overshot = RAMP_HALF_LENGTH + 1;
    body.x = cx + tang.x * overshot;
    body.z = cz + tang.z * overshot;
    body.heightOffset  = 0;
    body.airborneTicks = 0;

    reefRaceSplineSim.__tickOnceForTest(ROOM_ID);

    const rampEvents = events.filter((e) => e.type === 'event.ramp_launch');
    expect(rampEvents.length).toBe(0);
  });

  // ── Case 5: triggers AFTER cooldown expires ───────────────────────────────

  it('triggers AFTER cooldown expires', () => {
    const events: Array<{ type: string }> = [];
    reefRaceSplineSim.setBroadcastFn((_id, frame) =>
      events.push(frame as { type: string }),
    );
    reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);

    const state = reefRaceSplineSim.__getState(ROOM_ID)!;
    const body  = state.bodies.get(AVATAR_A)!;
    const { cx, cz } = getRampCenter('ramp-canyon-2');

    // First launch.
    body.x = cx; body.z = cz; body.heightOffset = 0; body.airborneTicks = 0;
    reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
    expect(events.filter((e) => e.type === 'event.ramp_launch').length).toBe(1);

    // Manually expire the cooldown by back-dating it to 0 (past expiry).
    const bodyRampCooldowns = state.rampCooldowns.get(AVATAR_A)!;
    bodyRampCooldowns.set('ramp-canyon-2', 0);

    // Force grounded again.
    body.heightOffset  = 0;
    body.airborneTicks = 0;
    body.vyAxis        = 0;
    body.x = cx; body.z = cz;

    reefRaceSplineSim.__tickOnceForTest(ROOM_ID);

    // Second launch should have fired now that cooldown is expired.
    expect(events.filter((e) => e.type === 'event.ramp_launch').length).toBe(2);
  });
});
