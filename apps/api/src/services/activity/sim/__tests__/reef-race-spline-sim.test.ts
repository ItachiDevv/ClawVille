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
const {
  REEF_TICK_HZ,
  REEF_RACE_LAPS,
  ACTION_BIT_JUMP,
  REEF_GRAVITY,
  REEF_JUMP_IMPULSE_MANUAL,
  REEF_MAX_SPEED,
  REEF_MAX_ACCEL,
  REEF_TURN_RATE,
  REEF_KINEMATIC_TOLERANCE,
} = await import('../reef-race-config');
const {
  integrateSurfStep,
  reefRaceStartGridPose,
  turnToward,
} = await import('@clawville/shared');

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
      // CLOSED-LOOP: bodies spawn ON the loop, just behind the start/finish line
      // (anchored at centerlineAt(0)), inside the corridor. Assert the spawn
      // sits inside the corridor near the start line (t≈0.99) — NOT at a fixed z.
      const spawnClosest = state!.spline.closestPointOnSpline({ x: bodyA.x, z: bodyA.z });
      expect(spawnClosest.distance).toBeLessThanOrEqual(
        state!.spline.widthAt(spawnClosest.t) + 5,
      );
      // Just before the seam (finish straight) — the grid is behind the line.
      expect(spawnClosest.t).toBeGreaterThan(0.9);
      expect(bodyA.heightOffset).toBe(0);
      expect(bodyA.progress).toBe(0);
      expect(bodyA.lap).toBe(0);
      expect(bodyA.startCrossed).toBe(false);
      expect(bodyA.alive).toBe(true);
      expect(bodyA.finishedAt).toBeNull();
    });

    it('uses the shared exact 2-column / 4-row formation for all 8 racers', () => {
      const avatarIds = Array.from({ length: 8 }, (_, i) => `grid-avatar-${i}`);
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', avatarIds);
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const frame = {
        center: state.spline.centerlineAt(0),
        tangent: state.spline.tangentAt(0),
        normal: state.spline.normalAt(0),
      };

      avatarIds.forEach((avatarId, i) => {
        const body = state.bodies.get(avatarId)!;
        const expected = reefRaceStartGridPose(frame, i);
        expect(body.x).toBe(expected.x);
        expect(body.z).toBe(expected.z);
        expect(body.rot).toBe(expected.heading);

        // Independent projections pin insertion order: left/right, then 176wu back
        // (151wu boards + ~25wu nose-to-tail clearance; deliberately a literal
        // so a silent helper drift fails here). The +40 front-row backoff is an
        // independent constant, not spacing/4.
        const dx = body.x - frame.center.x;
        const dz = body.z - frame.center.z;
        const back = -(dx * frame.tangent.x + dz * frame.tangent.z);
        const lateral = dx * frame.normal.x + dz * frame.normal.z;
        expect(back).toBeCloseTo(Math.floor(i / 2) * 176 + 40, 8);
        expect(lateral).toBeCloseTo((i % 2 === 0 ? -1 : 1) * 320, 8);
      });
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
    it('advances along the loop when body drives with full thrust', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const body = state.bodies.get(AVATAR_A)!;

      const spawnX = body.x;
      const spawnZ = body.z;

      // Drive in the START TANGENT direction (down-track) each tick. On the
      // closed loop the start straight heads ~ -21° (mostly +X), so steer along
      // the tangent rather than a fixed world axis.
      const tg = state.spline.tangentAt(0);
      for (let i = 0; i < 120; i++) {
        reefRaceSplineSim.applyInput(
          ROOM_ID, AVATAR_A, 10 + i, DT, makeInput(1, tg.x, tg.z),
        );
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      }

      // Body moved off the spawn point and crossed the start/finish line (the
      // grid spawns just behind it), so the start gun has fired.
      const moved = Math.hypot(body.x - spawnX, body.z - spawnZ);
      expect(moved).toBeGreaterThan(50);
      expect(body.startCrossed).toBe(true);
    });
  });

  // ── Surf-carving model (2026-06-01) ─────────────────────────────────────────
  // Asserts the NEW heading-rate + lateral-grip + carried-momentum behavior
  // that replaced the old "snap facing to input + global drag 0.97" model.

  describe('surf-carving model', () => {
    it('HEADING TURNS AT A BOUNDED RATE (no snap to input)', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const body = reefRaceSplineSim.__getState(ROOM_ID)!.bodies.get(AVATAR_A)!;

      // Spawn faces +Z (rot ≈ 0). Demand a hard LEFT (dir = +X) which is a 90°
      // (π/2) heading change. The old model snapped rot to atan2(1,0)=π/2 in a
      // single tick; the surf model must turn at most ~REEF_TURN_RATE*dt.
      body.rot = 0;
      body.vx = 0;
      body.vz = REEF_MAX_SPEED * 0.4; // some forward speed so falloff applies
      reefRaceSplineSim.applyInput(ROOM_ID, AVATAR_A, 1, DT, makeInput(1, 1, 0));
      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);

      // After ONE tick rot must be well short of π/2 (no snap) and bounded by
      // the per-tick turn budget (+ a little slack for the speed falloff math).
      expect(body.rot).toBeGreaterThan(0);
      expect(body.rot).toBeLessThan(REEF_TURN_RATE * DT + 1e-6);
      expect(body.rot).toBeLessThan(Math.PI / 2 - 0.5); // nowhere near snapped
    });

    it('EASE OFF = COAST (thrust release keeps most forward speed)', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const body = state.bodies.get(AVATAR_A)!;

      // CLOSED-LOOP: steer along the body's actual spawn heading (the start
      // tangent ~ -21°, mostly +X), NOT a fixed +Z — otherwise the demanded
      // turn bleeds the speed we're trying to build (geometry-independent test).
      const tg = state.spline.tangentAt(0);
      // Cruise up to speed with full thrust down the start tangent.
      for (let i = 0; i < 60; i++) {
        reefRaceSplineSim.applyInput(ROOM_ID, AVATAR_A, 1 + i, DT, makeInput(1, tg.x, tg.z));
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      }
      const cruiseSpeed = Math.hypot(body.vx, body.vz);
      expect(cruiseSpeed).toBeGreaterThan(REEF_MAX_SPEED * 0.5);

      // Release thrust (thrust 0, keep heading). After ~0.5s of coasting the
      // body must retain the MAJORITY of its speed — NOT dead-stop like the old
      // global-drag model (0.97^15 ≈ 0.63, but surf forwardDrag 0.992^15 ≈ 0.89).
      for (let i = 0; i < 15; i++) {
        // Re-apply a fresh seq so intent keeps being consumed (thrust stays 0).
        reefRaceSplineSim.applyInput(ROOM_ID, AVATAR_A, 100 + i, DT, makeInput(0, tg.x, tg.z));
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      }
      const coastSpeed = Math.hypot(body.vx, body.vz);
      // Coasted, not stopped — retains > 75% of cruise after half a second.
      expect(coastSpeed).toBeGreaterThan(cruiseSpeed * 0.75);
    });

    it('CARVING never trips the over-accel anti-cheat flag', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const body = state.bodies.get(AVATAR_A)!;

      // Drive at full speed while flicking the steer direction hard each tick
      // (left/right slalom). This is the worst case for the velocity-delta
      // validator under the new model. No 'overaccel' flag must be raised.
      let seq = 1;
      for (let i = 0; i < 300; i++) {
        // Alternate hard left / hard right relative to down-track.
        const dirX = i % 2 === 0 ? 0.9 : -0.9;
        reefRaceSplineSim.applyInput(ROOM_ID, AVATAR_A, seq++, DT, makeInput(1, dirX, 0.44));
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      }
      // The flag() path bumps the counter for non-physics kinds; physics flags
      // (overaccel/overspeed) are NOT counted toward forfeit but DO log. The
      // cleanest assertion: the body never got force-clamped into an integrity
      // forfeit and effective speed stayed under the validator ceiling.
      expect(body.forfeited).toBe(false);
      const speed = Math.hypot(body.vx, body.vz);
      expect(speed).toBeLessThanOrEqual(REEF_MAX_SPEED * REEF_KINEMATIC_TOLERANCE);
    });
  });

  // ── Pure integrateSurfStep unit checks ──────────────────────────────────────
  // The sim delegates per-tick kinematics to this shared pure function so the
  // web client can mirror it for prediction. Lock its contract here.

  describe('integrateSurfStep (pure shared function)', () => {
    const params = {
      maxSpeed: REEF_MAX_SPEED,
      maxAccel: REEF_MAX_ACCEL,
      turnRate: REEF_TURN_RATE,
      turnSpeedFalloff: 0.45,
      airborneSteerMult: 0.30,
      forwardDrag: 0.992,
      lateralGrip: 0.90,
      speedMod: 1.0,
      accelMult: 1.0,
    };

    it('is pure — does not mutate the input state', () => {
      const prev = { x: 10, z: 20, vx: 5, vz: 100, rot: 0.2 };
      const snapshot = { ...prev };
      integrateSurfStep(prev, { dir: { x: 1, z: 0 }, thrust: 1, airborne: false }, params, DT);
      expect(prev).toEqual(snapshot);
    });

    it('turnToward never overshoots the max delta and takes the shortest arc', () => {
      // Turning from 0 toward π/2 by a 0.1 budget → +0.1 exactly.
      expect(turnToward(0, Math.PI / 2, 0.1)).toBeCloseTo(0.1, 6);
      // Shortest arc across the ±π seam: from 3.0 toward -3.0 is a SHORT +0.28
      // step (through π), not a long -6.0 step.
      const out = turnToward(3.0, -3.0, 1.0);
      expect(Math.abs(Math.atan2(Math.sin(out - 3.0), Math.cos(out - 3.0)))).toBeLessThanOrEqual(1.0 + 1e-9);
    });

    it('preserves forward momentum on thrust release (coast), bleeds lateral (grip)', () => {
      // Pure forward velocity, thrust released → mild forward drag only.
      const fwd = integrateSurfStep(
        { x: 0, z: 0, vx: 0, vz: 400, rot: 0 },
        { dir: null, thrust: 0, airborne: false },
        params,
        DT,
      );
      expect(fwd.vz).toBeCloseTo(400 * 0.992, 3); // coasts
      expect(Math.abs(fwd.vx)).toBeLessThan(1e-6);

      // Pure sideways velocity (perp to heading) → bled by lateralGrip.
      const side = integrateSurfStep(
        { x: 0, z: 0, vx: 400, vz: 0, rot: 0 }, // heading +Z, velocity +X = perp
        { dir: null, thrust: 0, airborne: false },
        params,
        DT,
      );
      expect(side.vx).toBeCloseTo(400 * 0.90, 3); // sideways grip bleed
    });

    it('airborne reduces TURN RATE only, not forward speed', () => {
      const start = { x: 0, z: 0, vx: 0, vz: 300, rot: 0 };
      const grounded = integrateSurfStep(start, { dir: { x: 1, z: 0 }, thrust: 1, airborne: false }, params, DT);
      const airborneState = integrateSurfStep(start, { dir: { x: 1, z: 0 }, thrust: 1, airborne: true }, params, DT);
      // Airborne turns LESS (smaller rot change).
      expect(Math.abs(airborneState.rot)).toBeLessThan(Math.abs(grounded.rot));
      // But forward speed (along the ORIGINAL +Z heading at tick start) is not
      // penalised by being airborne — both gain forward speed from thrust.
      expect(airborneState.vz).toBeGreaterThan(start.vz * 0.9);
    });
  });

  // ── CLOSED-LOOP lap / finish detection (2026-06-22) ─────────────────────────

  describe('closed-loop laps + finish', () => {
    // Helper: teleport a body to the centerline at a given within-lap t, then
    // run one tick so resolveProgress samples that position. (Teleport bypasses
    // the position validator's interest — we're testing the lap state machine,
    // not anti-cheat — and __tickOnceForTest re-projects via closestPointOnSpline.)
    function placeAtT(roomId: string, avatarId: string, t: number): void {
      const state = reefRaceSplineSim.__getState(roomId)!;
      const body = state.bodies.get(avatarId)!;
      const c = state.spline.centerlineAt(t);
      body.x = c.x;
      body.z = c.z;
      body.vx = 0;
      body.vz = 0;
      reefRaceSplineSim.__tickOnceForTest(roomId);
    }

    it('a forward seam crossing increments the completed-lap count', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const body = state.bodies.get(AVATAR_A)!;

      // Tick once to seed progress from the spawn (behind the line, t≈0.99).
      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      expect(body.lap).toBe(0);
      expect(body.startCrossed).toBe(false);

      // Drive forward across the seam → START GUN (lap stays 0, startCrossed set).
      placeAtT(ROOM_ID, AVATAR_A, 0.05);
      expect(body.startCrossed).toBe(true);
      expect(body.lap).toBe(0);

      // Lap 1: go round (mid-loop) then cross the seam again → lap 1.
      placeAtT(ROOM_ID, AVATAR_A, 0.5);
      placeAtT(ROOM_ID, AVATAR_A, 0.9);
      placeAtT(ROOM_ID, AVATAR_A, 0.05); // wrap → lap completion
      expect(body.lap).toBe(1);
    });

    it('finishes only after completing lap N and crossing the line', () => {
      const events: Array<{ type: string; avatarId?: string; lap?: number }> = [];
      reefRaceSplineSim.setBroadcastFn((_id, f) =>
        events.push(f as { type: string; avatarId?: string; lap?: number }),
      );
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const body = reefRaceSplineSim.__getState(ROOM_ID)!.bodies.get(AVATAR_A)!;

      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      // Start gun.
      placeAtT(ROOM_ID, AVATAR_A, 0.05);

      // REEF_RACE_LAPS laps. Each lap = round the loop + seam cross.
      for (let lap = 1; lap <= REEF_RACE_LAPS; lap++) {
        placeAtT(ROOM_ID, AVATAR_A, 0.5);
        placeAtT(ROOM_ID, AVATAR_A, 0.9);
        // Before the FINAL seam cross the body must NOT be finished yet.
        if (lap < REEF_RACE_LAPS) {
          expect(body.finishedAt).toBeNull();
        }
        placeAtT(ROOM_ID, AVATAR_A, 0.05); // seam cross → lap completion
      }

      // After REEF_RACE_LAPS completions the body is FINISHED + frozen.
      expect(body.lap).toBe(REEF_RACE_LAPS);
      expect(body.finishedAt).not.toBeNull();
      expect(body.vx).toBe(0);
      expect(body.vz).toBe(0);
      expect(events.some((e) => e.type === 'event.crossed_finish')).toBe(true);
      // Non-final laps emit event.lap_completed (REEF_RACE_LAPS - 1 of them).
      const lapEvents = events.filter((e) => e.type === 'event.lap_completed');
      expect(lapEvents.length).toBe(REEF_RACE_LAPS - 1);
    });

    it('does NOT count the start-gun cross as a completed lap', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const body = reefRaceSplineSim.__getState(ROOM_ID)!.bodies.get(AVATAR_A)!;
      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      // The very first forward cross is the start gun.
      placeAtT(ROOM_ID, AVATAR_A, 0.05);
      expect(body.startCrossed).toBe(true);
      expect(body.lap).toBe(0);
      expect(body.finishedAt).toBeNull();
    });
  });

  // ── Live placement ordering by (lap, within-lap progress) ──────────────────

  describe('live placement order (lap, then progress)', () => {
    it('a lap-2 racer at progress 0.1 outranks a lap-1 racer at progress 0.9', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A, AVATAR_B]);
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const a = state.bodies.get(AVATAR_A)!;
      const b = state.bodies.get(AVATAR_B)!;

      // A is on lap 2 but only 10% through it; B is on lap 1 but 90% through.
      a.lap = 2; a.progress = 0.1; a.startCrossed = true; a.progressInitialized = true;
      b.lap = 1; b.progress = 0.9; b.startCrossed = true; b.progressInitialized = true;

      // computeLivePlacements runs at the top of each tick → refreshes the map.
      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      const placements = state.lastPlacementMap;
      expect(placements.get(AVATAR_A)).toBe(1); // further along the race
      expect(placements.get(AVATAR_B)).toBe(2);
    });
  });

  // ── Vertical axis (jump + gravity) ────────────────────────────────────────

  describe('jump and gravity', () => {
    it('jump impulse makes body airborne', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const body = reefRaceSplineSim.__getState(ROOM_ID)!.bodies.get(AVATAR_A)!;

      // Trigger the manual jump on bit 2.
      reefRaceSplineSim.applyInput(
        ROOM_ID, AVATAR_A, 1, DT, makeInput(0, 0, 1, ACTION_BIT_JUMP),
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
        ROOM_ID, AVATAR_A, 1, DT, makeInput(0, 0, 1, ACTION_BIT_JUMP),
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
        ROOM_ID, AVATAR_A, 1, DT, makeInput(0, 0, 1, ACTION_BIT_JUMP),
      );

      let peakHeight = 0;
      for (let i = 0; i < 200; i++) {
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
        if (body.heightOffset > peakHeight) peakHeight = body.heightOffset;
        if (body.heightOffset === 0 && i > 5) break;
      }

      // Theoretical peak: v²/(2g) = 550²/(2×1200) ≈ 126 wu. The fixed-step
      // semi-implicit integrator lands slightly below the continuous solution.
      const theoreticalPeak = (REEF_JUMP_IMPULSE_MANUAL * REEF_JUMP_IMPULSE_MANUAL) /
        (2 * REEF_GRAVITY);
      expect(theoreticalPeak).toBeCloseTo(126, 0);
      expect(peakHeight).toBeGreaterThan(theoreticalPeak * 0.9);
      expect(peakHeight).toBeLessThanOrEqual(theoreticalPeak);
    });
  });

  // ── Wall clamp ────────────────────────────────────────────────────────────

  describe('wall clamp', () => {
    // CLOSED-LOOP (2026-06-22): place the body well outside the lagoon corridor
    // at the start straight (t≈0.05, halfWidth ~540) and assert the clamp (a)
    // never yanks more than the per-tick cap on a deep overshoot, and (b)
    // converges the body INTO the corridor over several ticks. Coordinates are
    // derived from the live spline so they track future track edits.
    it('walks a body outside the corridor back inside over several ticks (no one-tick yank)', () => {
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const state = reefRaceSplineSim.__getState(ROOM_ID)!;
      const body = state.bodies.get(AVATAR_A)!;

      // Centerline + outward normal at the start straight; push ~2500 wu past
      // the wall along the normal.
      const T = 0.05;
      const center = state.spline.centerlineAt(T);
      const normal = state.spline.normalAt(T);
      const halfW = state.spline.widthAt(T);
      const OVERSHOOT = 2500;
      body.x = center.x + normal.x * (halfW + OVERSHOOT);
      body.z = center.z + normal.z * (halfW + OVERSHOOT);
      body.vx = normal.x * 200; // moving outward
      body.vz = normal.z * 200;

      const distFromCenter = (): number =>
        Math.hypot(body.x - center.x, body.z - center.z);

      // First tick must NOT snap all the way back — per-tick correction is capped.
      const before = distFromCenter();
      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      const firstStep = before - distFromCenter(); // positive = moved inward
      expect(firstStep).toBeGreaterThan(0);   // moved inward
      // Not a hard snap-back: the per-tick inward walk is bounded by
      // WALL_MAX_CORRECTION_WU, doubled 60→120 alongside the 2× speed cap
      // (2026-07-15), so the first step is ~234 wu (was <200). 400 stays well
      // under a hard yank of the full 2500 wu overshoot while tracking the cap.
      expect(firstStep).toBeLessThan(400);

      // Over many ticks the spring + outward scrub converge the body into the
      // corridor (halfWidth + body radius + inset tolerance).
      for (let i = 0; i < 300; i++) {
        reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      }
      // The body re-enters near the (possibly moved) closest centerline; assert
      // it is inside the corridor at its final t (not the original T).
      const finalClosest = state.spline.closestPointOnSpline({ x: body.x, z: body.z });
      expect(finalClosest.distance).toBeLessThanOrEqual(
        state.spline.widthAt(finalClosest.t) + 5,
      );
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

    it('emits the authoritative effective speedMod on wire entity deltas', () => {
      const frames: unknown[] = [];
      reefRaceSplineSim.setBroadcastFn((_id, frame) => frames.push(frame));
      reefRaceSplineSim.startRoom(ROOM_ID, 'reef-race', [AVATAR_A]);
      const body = reefRaceSplineSim.__getState(ROOM_ID)!.bodies.get(AVATAR_A)!;
      body.activeEffects.set('rr-turbo-bubble', Date.now() + 60_000);

      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);
      reefRaceSplineSim.__tickOnceForTest(ROOM_ID);

      const delta = frames.find(
        (frame) => (frame as { type?: string }).type === 'snapshot.delta',
      ) as
        | { entities: Array<{ avatarId: string; changed: { speedMod?: number } }> }
        | undefined;
      expect(delta).toBeTruthy();
      expect(
        delta!.entities.find((e) => e.avatarId === AVATAR_A)?.changed.speedMod,
      ).toBe(1.4);
    });
  });
});
