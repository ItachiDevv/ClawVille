import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activateTradingFloorSeat,
  tradingFloorSitClips,
} from './trading-floor-interior';
import {
  clampTradingFloorMovement2D,
  clampTradingFloorMovementSeated,
  consoleHalfExtents,
  pushCameraOutOfSolids,
  tradingFloorDistanceSq,
  validateAuthoredProp,
  AUTHORED_PROP_TOLERANCE_WU,
  tradingFloorHitsSolid,
  tradingFloorSeatedCameraYaw,
  wrapTradingFloorAngle,
  TRADING_FLOOR_CAMERA,
  TRADING_FLOOR_CAMERA_SOLID_CLEARANCE,
  TRADING_FLOOR_CAMERA_Z_MAX,
  TRADING_FLOOR_CAMERA_Z_MIN,
  TRADING_FLOOR_CHAIR_HALF_X,
  TRADING_FLOOR_CHAIR_HALF_Z,
  TRADING_FLOOR_CHAIR_SEAT_Y,
  TRADING_FLOOR_CONSOLE_HALF_X,
  TRADING_FLOOR_CONSOLE_HALF_Z,
  TRADING_FLOOR_CONSOLE_HEIGHT,
  TRADING_FLOOR_CONSOLE_ROW,
  TRADING_FLOOR_DESK_INNER_X,
  TRADING_FLOOR_DOOR,
  TRADING_FLOOR_DOOR_APPROACH_Z,
  TRADING_FLOOR_SCREEN,
  TRADING_FLOOR_SCREEN_SURROUND_FACE_Z,
  TRADING_FLOOR_PLAYER_RADIUS,
  TRADING_FLOOR_PLAYER_SPAWN,
  TRADING_FLOOR_PLAYER_SPEED_WU_PER_SEC,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_SEATS,
  TRADING_FLOOR_SOLIDS,
} from './trading-floor-room';

/**
 * trading-floor-seats.test.ts
 *
 * The founder's order for this room was "computers lined up against the side
 * that an agent can go up and sit at". These tests pin the three halves of that
 * sentence the geometry tests in `trading-floor-room.test.ts` do not reach:
 *
 *   1. an agent can GO UP to every seat — proved by a flood fill over the
 *      walkable floor, not by eyeballing the layout;
 *   2. a seated player is PINNED — WASD does not slide them out of the chair;
 *   3. standing up leaves them somewhere LEGAL, and the seated camera looks at
 *      the desk rather than at the wall two feet behind it.
 *
 * The interact LADDER (stand > monitor > door > sit) lives in
 * `trading-floor-monitor.test.ts` next to the input-parity guards it belongs
 * with. Nothing here re-tests it.
 */

/** One frame of held input at full walk speed — the real step size. */
const FRAME_SECONDS = 1 / 60;
const FRAME_STEP = TRADING_FLOOR_PLAYER_SPEED_WU_PER_SEC * FRAME_SECONDS;

/** Eight compass directions, so no single lucky axis carries a test. */
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [-Math.SQRT1_2, -Math.SQRT1_2],
];

describe('Trading Floor seats — a seated player does not move on WASD', () => {
  test('every direction of held input leaves the avatar on its seat', () => {
    const out = { x: 0, z: 0 };
    for (const seat of TRADING_FLOOR_SEATS) {
      for (const [dx, dz] of DIRECTIONS) {
        clampTradingFloorMovementSeated(
          seat.index,
          seat.x,
          seat.z,
          seat.x + dx * FRAME_STEP,
          seat.z + dz * FRAME_STEP,
          out,
        );
        expect({ seat: seat.index, x: out.x, z: out.z }).toEqual({
          seat: seat.index,
          x: seat.x,
          z: seat.z,
        });
      }
    }
  });

  // A pin that only holds for one frame is not a pin. Sixty frames of held
  // input is a full second of a player leaning on the stick.
  test('a second of held input does not drift the seat position', () => {
    const out = { x: 0, z: 0 };
    const seat = TRADING_FLOOR_SEATS[0]!;
    let x = seat.x;
    let z = seat.z;
    for (let frame = 0; frame < 60; frame += 1) {
      clampTradingFloorMovementSeated(
        seat.index,
        x,
        z,
        x + FRAME_STEP,
        z - FRAME_STEP,
        out,
      );
      x = out.x;
      z = out.z;
    }
    expect({ x, z }).toEqual({ x: seat.x, z: seat.z });
  });

  // The seated branch must not leak into ordinary walking, or the whole room
  // freezes the moment somebody refactors the index.
  test('seatedIndex -1 is the ordinary walking clamp, and it moves', () => {
    const seated = { x: 0, z: 0 };
    const walking = { x: 0, z: 0 };
    const startX = 0;
    const startZ = TRADING_FLOOR_PLAYER_SPAWN.z;
    clampTradingFloorMovementSeated(
      -1,
      startX,
      startZ,
      startX,
      startZ - FRAME_STEP,
      seated,
    );
    clampTradingFloorMovement2D(
      startX,
      startZ,
      startX,
      startZ - FRAME_STEP,
      walking,
    );
    expect(seated).toEqual(walking);
    expect(seated.z).toBeLessThan(startZ);
  });

  // An out-of-range index must fall through to walking rather than read
  // `undefined.x` and pin the player at NaN — the shape of bug that turns one
  // bad frame into an avatar that is gone for the rest of the visit.
  test('an out-of-range seat index falls back to walking, never NaN', () => {
    const out = { x: 0, z: 0 };
    for (const index of [99, TRADING_FLOOR_SEATS.length]) {
      clampTradingFloorMovementSeated(index, 0, 600, 0, 600 - FRAME_STEP, out);
      expect(Number.isFinite(out.x)).toBe(true);
      expect(Number.isFinite(out.z)).toBe(true);
      expect(out.z).toBeLessThan(600);
    }
  });
});

describe('Trading Floor seats — standing up lands somewhere legal', () => {
  // Standing up does NOT teleport: the avatar was already standing AT the desk
  // the whole time (no sit clip ships in this change — the chair sits behind
  // it), so the stand-up position is the seat position. That is only safe
  // because the seat position is a legal standing point, which is what this
  // asserts.
  test('the stand-up position is inside the room and outside every solid', () => {
    for (const seat of TRADING_FLOOR_SEATS) {
      expect(tradingFloorHitsSolid(seat.x, seat.z)).toBe(false);
      expect(Math.abs(seat.x)).toBeLessThanOrEqual(
        TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_PLAYER_RADIUS,
      );
      expect(Math.abs(seat.z)).toBeLessThanOrEqual(
        TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS,
      );
    }
  });

  // Legal is not enough — the player must be able to LEAVE. A seat in a pocket
  // the clamp refuses to let go of is a soft lock.
  test('the player can walk off every seat toward the aisle', () => {
    const out = { x: 0, z: 0 };
    for (const seat of TRADING_FLOOR_SEATS) {
      // Away from the desk is away from the side wall, i.e. toward x = 0.
      const awayX = seat.x < 0 ? 1 : -1;
      clampTradingFloorMovementSeated(
        -1,
        seat.x,
        seat.z,
        seat.x + awayX * FRAME_STEP,
        seat.z,
        out,
      );
      expect(Math.abs(out.x)).toBeLessThan(Math.abs(seat.x));
      expect(tradingFloorHitsSolid(out.x, out.z)).toBe(false);
    }
  });

  test('sit then stand is a round trip with no position drift', () => {
    const out = { x: 0, z: 0 };
    for (const seat of TRADING_FLOOR_SEATS) {
      // Frame 1: seated, input held — pinned, and the scene stands the player
      // up on this same frame because the controller still reports `moving`.
      clampTradingFloorMovementSeated(
        seat.index,
        seat.x,
        seat.z,
        seat.x + FRAME_STEP,
        seat.z,
        out,
      );
      expect({ x: out.x, z: out.z }).toEqual({ x: seat.x, z: seat.z });
      // Frame 2: standing, same input — now it moves, from a legal point.
      clampTradingFloorMovementSeated(
        -1,
        out.x,
        out.z,
        out.x + FRAME_STEP,
        out.z,
        out,
      );
      expect(tradingFloorHitsSolid(out.x, out.z)).toBe(false);
    }
  });
});

describe('Trading Floor seats — the seated camera faces the desk', () => {
  test('the camera looks the same way the avatar does', () => {
    for (const seat of TRADING_FLOOR_SEATS) {
      const yaw = tradingFloorSeatedCameraYaw(seat.facing);
      // Camera forward at yaw θ is (sin θ, -cos θ); the avatar's at yaw f is
      // (sin f, cos f). The seated view is only "over the shoulder" when the
      // two agree.
      expect(Math.sin(yaw)).toBeCloseTo(Math.sin(seat.facing), 9);
      expect(-Math.cos(yaw)).toBeCloseTo(Math.cos(seat.facing), 9);
      expect(Math.abs(yaw)).toBeLessThanOrEqual(Math.PI);
    }
  });

  test('the camera ends up behind the avatar, over the aisle, not in the wall', () => {
    for (const seat of TRADING_FLOOR_SEATS) {
      const yaw = tradingFloorSeatedCameraYaw(seat.facing);
      // The scene's own eye formula, evaluated before the room clamp.
      const eyeX = seat.x - Math.sin(yaw) * TRADING_FLOOR_CAMERA.behind;
      const eyeZ = seat.z + Math.cos(yaw) * TRADING_FLOOR_CAMERA.behind;
      // Behind the avatar means further from the side wall it faces.
      expect(Math.abs(eyeX)).toBeLessThan(Math.abs(seat.x));
      // And inside the hall, so the room clamp has nothing to correct: a
      // clamped seated camera would shorten the arm and stare at the back of
      // the avatar's head.
      expect(Math.abs(eyeX)).toBeLessThan(
        TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_CAMERA.roomMargin,
      );
      expect(Math.abs(eyeZ)).toBeLessThan(
        TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_CAMERA.roomMargin,
      );
    }
  });

  test('the desk is in front of the seated camera, not behind it', () => {
    for (const seat of TRADING_FLOOR_SEATS) {
      const desk = TRADING_FLOOR_CONSOLE_ROW[seat.index]!;
      const yaw = tradingFloorSeatedCameraYaw(seat.facing);
      const eyeX = seat.x - Math.sin(yaw) * TRADING_FLOOR_CAMERA.behind;
      const eyeZ = seat.z + Math.cos(yaw) * TRADING_FLOOR_CAMERA.behind;
      // Dot the view direction against the vector from the eye to the desk.
      const viewX = Math.sin(yaw);
      const viewZ = -Math.cos(yaw);
      const toDeskX = desk.x - eyeX;
      const toDeskZ = desk.z - eyeZ;
      const length = Math.hypot(toDeskX, toDeskZ);
      expect((viewX * toDeskX + viewZ * toDeskZ) / length).toBeCloseTo(1, 6);
    }
  });

  test('the yaw easing always takes the SHORT arc around the circle', () => {
    for (const seat of TRADING_FLOOR_SEATS) {
      const target = tradingFloorSeatedCameraYaw(seat.facing);
      // Worst case: the player walked in with a yaw a long way round from the
      // target. The wrapped delta the scene applies must never exceed half a
      // turn, or sitting down spins the camera the wrong way.
      for (const current of [-Math.PI, -2, 0, 2, Math.PI, 5, -5]) {
        const delta = wrapTradingFloorAngle(target - current);
        expect(Math.abs(delta)).toBeLessThanOrEqual(Math.PI + 1e-9);
      }
    }
  });
});

describe('Trading Floor seats — the chase camera clears the wall-side desks', () => {
  // The camera's X bound is the DESK face, not the wall. The desks are 166 wu
  // tall and the camera's own Y floor is `above + pitchMin` = 140, so a camera
  // clamped to the wall passes through a desk whenever the player pitches down
  // near the side of the hall. This is the assertion that keeps the two numbers
  // tied together.
  const cameraHalfX = TRADING_FLOOR_DESK_INNER_X + TRADING_FLOOR_CAMERA.roomMargin;
  /** What `clampCameraToRoom` actually permits: halfX minus the same margin. */
  const cameraMaxX = cameraHalfX - TRADING_FLOOR_CAMERA.roomMargin;

  test('the camera can pitch below the top of a desk, which is why this matters', () => {
    const cameraFloorY = TRADING_FLOOR_CAMERA.above + TRADING_FLOOR_CAMERA.pitchMin;
    expect(cameraFloorY).toBeLessThan(TRADING_FLOOR_CONSOLE_HEIGHT);
  });

  test('the bound stops at the desk face and never inside a desk', () => {
    for (const slot of TRADING_FLOOR_CONSOLE_ROW) {
      const { halfX } = consoleHalfExtents(slot.rotY);
      expect(cameraMaxX).toBeLessThanOrEqual(Math.abs(slot.x) - halfX);
    }
    expect(cameraMaxX).toBe(TRADING_FLOOR_DESK_INNER_X);
  });

  test('the same bound also clears the four corner pillars', () => {
    const pillars = TRADING_FLOOR_SOLIDS.filter(
      (solid) =>
        Math.abs(Math.abs(solid.centerX) - (TRADING_FLOOR_ROOM.halfX - 190)) < 1,
    );
    expect(pillars.length).toBe(4);
    for (const pillar of pillars) {
      expect(cameraMaxX).toBeLessThan(Math.abs(pillar.centerX) - pillar.halfX);
    }
  });

  // Narrowing X must not narrow the hall's depth: `clampCameraToRoom` takes X
  // and Z separately, and a 2200 wu room framed at 1970 would be a real cost.
  test('narrowing X leaves the full Z depth', () => {
    expect(cameraHalfX).toBeLessThan(TRADING_FLOOR_ROOM.halfX);
    // Still wide enough to hold the chase arm behind a player on the centre
    // line, or the camera would be clamped even in the middle of the room.
    expect(cameraMaxX).toBeGreaterThan(TRADING_FLOOR_CAMERA.behind);
  });

  test('the seated eye point is inside the narrowed bound', () => {
    for (const seat of TRADING_FLOOR_SEATS) {
      const yaw = tradingFloorSeatedCameraYaw(seat.facing);
      const eyeX = seat.x - Math.sin(yaw) * TRADING_FLOOR_CAMERA.behind;
      expect(Math.abs(eyeX)).toBeLessThan(cameraMaxX);
    }
  });
});

describe('Trading Floor seats — sit clips', () => {
  // The founder screenshot showed the avatar STANDING in the chair. The cove
  // sit bundle already ships, so the fix is wiring, not a new asset.
  test('a VRM avatar gets the cove sit clips, enter then hold then exit', () => {
    expect(tradingFloorSitClips('vrm')).toEqual({
      enter: 'sit_stand_to_sit',
      hold: 'sit_idle_m',
      exit: 'sit_to_stand_m',
    });
  });

  // GLB avatars (the lobster) have no humanoid rig and no animator, so there is
  // nothing to retarget onto. They keep the snap-only behaviour.
  test('a GLB avatar gets no clips at all', () => {
    expect(tradingFloorSitClips('glb')).toBeNull();
  });

  // The idle and the exit must be the same body type, or the avatar changes
  // posture halfway through standing up. ALL seats use the m-variant: the cove
  // rejected the f-variant on the live table (arms out at shoulder height).
  test('the hold and exit clips are the same variant', () => {
    const clips = tradingFloorSitClips('vrm')!;
    expect(clips.hold.endsWith('_m')).toBe(true);
    expect(clips.exit.endsWith('_m')).toBe(true);
  });

  // `playOneShot` refuses a one-shot that transitions to itself, which would
  // leave the avatar clamped on the transition's final frame forever.
  test('no clip transitions to itself', () => {
    const clips = tradingFloorSitClips('vrm')!;
    expect(clips.enter).not.toBe(clips.hold);
    expect(clips.exit).not.toBe(clips.hold);
  });

  // The GLB player must not grow a clip path by accident — it has no animator
  // to play one on, so a call would be a silent no-op that looks implemented.
  test('the GLB player component contains no clip call', () => {
    const source = readFileSync(
      join(import.meta.dir, 'trading-floor-interior.tsx'),
      'utf8',
    );
    const start = source.indexOf('function TradingFloorGLBPlayer');
    const end = source.indexOf('function TradingFloorPlayer(');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).not.toContain('playOneShot');
    expect(body).not.toContain('TRADING_FLOOR_SIT_CLIPS');
  });

  // The cushion pin is what makes the seat Y agree with the chair. The clips
  // carry the COVE chair's authored descent, so a residual is expected; the
  // pin's clamp has to be wide enough to absorb a real one and narrow enough
  // that a bad reading cannot put the avatar through the floor.
  test('the cushion height is inside the chair, under the backrest rail', () => {
    const CHAIR_TOP_RAIL = 173;
    expect(TRADING_FLOOR_CHAIR_SEAT_Y).toBeGreaterThan(0);
    expect(TRADING_FLOOR_CHAIR_SEAT_Y).toBeLessThan(CHAIR_TOP_RAIL);
    // Below the desk surface, or the avatar's knees are through the desk.
    expect(TRADING_FLOOR_CHAIR_SEAT_Y).toBeLessThan(TRADING_FLOOR_CONSOLE_HEIGHT);
  });
});

describe('Trading Floor seats — clicking a chair', () => {
  const scene = readFileSync(
    join(import.meta.dir, 'trading-floor-interior.tsx'),
    'utf8',
  );

  // The seats were KEYBOARD-ONLY until this: the monitor and the door had click
  // volumes from the first pass and the seats did not, so "walk up and sit at a
  // computer" could not be done with a mouse.
  test('every seat has its own click volume, built from the seat list', () => {
    expect(scene).toContain('TRADING_FLOOR_SEATS.map((seat) => ({');
    expect(scene).toContain('onActivate={() => activateTradingFloorSeat(');
  });

  // A click must not be a second sit path. If it were, a click could take a
  // seat that E would refuse, and the two inputs would disagree.
  test('the click path delegates to the shared ladder', () => {
    const start = scene.indexOf(
      'export function activateTradingFloorSeat(seatIndex: number): boolean {',
    );
    expect(start).toBeGreaterThan(0);
    const body = scene.slice(start, scene.indexOf('}', start) + 1);
    expect(body).toContain('activateTradingFloorUse()');
  });

  // This room has `clickPath: false`, so a click on a far chair cannot walk the
  // avatar there. Doing nothing beats teleporting them across the hall.
  test('clicking a seat that is not armed does nothing', () => {
    for (const seat of TRADING_FLOOR_SEATS) {
      expect(activateTradingFloorSeat(seat.index)).toBe(false);
    }
    expect(activateTradingFloorSeat(-1)).toBe(false);
    expect(activateTradingFloorSeat(999)).toBe(false);
  });
});

describe('Trading Floor seats — the authored-prop assert', () => {
  /**
   * The SHIPPED numbers, read with `scripts/trading-floor/inspect-glb.mjs`
   * against `trading-floor-interior-opt1-mo-ktx.glb` (367,068 bytes, the
   * 2026-09-19 23:06 re-export). `KHR_mesh_quantization` normalises each mesh
   * into [-1, 1] and pushes the real size onto the node scale, which is why the
   * bounds below are fractions and the scale is ~87 to ~182.
   */
  const SHIPPED_CONSOLE = {
    scaleX: 182.165,
    scaleY: 182.165,
    scaleZ: 182.165,
    minX: -1,
    maxX: 1,
    minZ: -0.741,
    maxZ: 0.741,
    expectedHalfX: TRADING_FLOOR_CONSOLE_HALF_X,
    expectedHalfZ: TRADING_FLOOR_CONSOLE_HALF_Z,
    nodeX: -1120,
    nodeZ: -500,
    expectedNodeX: TRADING_FLOOR_CONSOLE_ROW[0]!.x,
    expectedNodeZ: TRADING_FLOOR_CONSOLE_ROW[0]!.z,
  };
  const SHIPPED_CHAIR = {
    scaleX: 87.5,
    scaleY: 87.5,
    scaleZ: 87.5,
    minX: -0.731,
    maxX: 0.731,
    minZ: -0.697,
    maxZ: 0.697,
    expectedHalfX: TRADING_FLOOR_CHAIR_HALF_X,
    expectedHalfZ: TRADING_FLOOR_CHAIR_HALF_Z,
    nodeX: 0,
    nodeZ: 0,
    expectedNodeX: 0,
    expectedNodeZ: 0,
  };

  test('both shipped props pass every rule', () => {
    expect(validateAuthoredProp('TradingFloorConsoleModule', SHIPPED_CONSOLE)).toEqual({
      problems: [],
      fatal: false,
    });
    expect(validateAuthoredProp('TradingFloorChairModule', SHIPPED_CHAIR)).toEqual({
      problems: [],
      fatal: false,
    });
  });

  // The console node's authored position IS slot 0. If the build script ever
  // parks the single copy somewhere else, this check is the thing that notices,
  // so the expectation must stay tied to the row rather than to a literal.
  test('the expected console anchor is slot 0 of the row, not a literal', () => {
    expect([SHIPPED_CONSOLE.expectedNodeX, SHIPPED_CONSOLE.expectedNodeZ]).toEqual([
      -1120, -500,
    ]);
    expect(TRADING_FLOOR_CONSOLE_ROW[0]!.x).toBe(-1120);
  });

  // The console measures 182.165 against a stated 182. The tolerance has to
  // absorb that rounding, or the assert cries wolf on a correct asset.
  test('the tolerance absorbs the sub-wu rounding the constants carry', () => {
    const measuredHalfX = SHIPPED_CONSOLE.maxX * SHIPPED_CONSOLE.scaleX;
    expect(Math.abs(measuredHalfX - TRADING_FLOOR_CONSOLE_HALF_X)).toBeGreaterThan(0);
    expect(Math.abs(measuredHalfX - TRADING_FLOOR_CONSOLE_HALF_X)).toBeLessThan(
      AUTHORED_PROP_TOLERANCE_WU,
    );
  });

  // Rule 1. The row composes its matrices from scale.x alone, so a non-uniform
  // node renders at the wrong size on the other two axes. Warn-only.
  test('a non-uniform node scale is reported but does not drop the row', () => {
    const result = validateAuthoredProp('c', { ...SHIPPED_CONSOLE, scaleZ: 150 });
    expect(result.problems.join(' ')).toContain('not uniform');
    expect(result.fatal).toBe(false);
  });

  // Rule 2, the FATAL one. This is the branch the adversarial review asked for:
  // the geometry bbox centre is structurally (0,0,0) for any quantized prop, so
  // the detectable quantity is the NODE translation against the anchor the build
  // script used.
  test('a moved authored node is FATAL and drops the row', () => {
    const movedX = validateAuthoredProp('c', { ...SHIPPED_CONSOLE, nodeX: -1090 });
    expect(movedX.fatal).toBe(true);
    expect(movedX.problems.join(' ')).toContain('authored node is at');
    expect(movedX.problems.join(' ')).toContain('DROPPED');

    const movedZ = validateAuthoredProp('c', { ...SHIPPED_CONSOLE, nodeZ: -460 });
    expect(movedZ.fatal).toBe(true);

    // The chair is anchored at the origin, so the same rule applies there.
    const movedChair = validateAuthoredProp('ch', { ...SHIPPED_CHAIR, nodeX: 40 });
    expect(movedChair.fatal).toBe(true);
  });

  // Sub-tolerance node noise must NOT drop the row, or a re-export that shifts
  // a node by a rounding step blanks the desks.
  test('node drift inside the tolerance is ignored', () => {
    const jittered = validateAuthoredProp('c', {
      ...SHIPPED_CONSOLE,
      nodeX: SHIPPED_CONSOLE.expectedNodeX + AUTHORED_PROP_TOLERANCE_WU * 0.9,
      nodeZ: SHIPPED_CONSOLE.expectedNodeZ - AUTHORED_PROP_TOLERANCE_WU * 0.9,
    });
    expect(jittered).toEqual({ problems: [], fatal: false });
  });

  // Rule 3. A re-export that resizes the prop without updating the constants
  // leaves the colliders the wrong size. Warn-only: the row still draws, and a
  // wrong-size desk is at least visible in the place the collider is.
  test('a footprint that no longer matches the collider constants is reported', () => {
    const wide = validateAuthoredProp('c', {
      ...SHIPPED_CONSOLE,
      scaleX: 220,
      scaleY: 220,
      scaleZ: 220,
    });
    expect(wide.problems.join(' ')).toContain('halfX');
    expect(wide.fatal).toBe(false);
    const deep = validateAuthoredProp('c', { ...SHIPPED_CONSOLE, minZ: -0.9, maxZ: 0.9 });
    expect(deep.problems.join(' ')).toContain('halfZ');
    expect(deep.fatal).toBe(false);
  });

  // A wrong-size prop must report the size and NOT the placement, or the message
  // sends the next reader after the wrong thing.
  test('each rule reports independently', () => {
    const deep = validateAuthoredProp('c', { ...SHIPPED_CONSOLE, minZ: -0.9, maxZ: 0.9 });
    expect(deep.problems.join(' ')).not.toContain('authored node is at');
    expect(deep.problems.length).toBe(1);
  });

  // The rule the earlier revision got wrong, pinned so it cannot come back:
  // a quantized prop's bbox centre is ALWAYS zero, so a centre-based check can
  // never fire and must not be what the placement rule reads.
  test('a quantized bbox centre carries no placement information', () => {
    for (const prop of [SHIPPED_CONSOLE, SHIPPED_CHAIR]) {
      expect((prop.minX + prop.maxX) / 2).toBeCloseTo(0, 9);
      expect((prop.minZ + prop.maxZ) / 2).toBeCloseTo(0, 9);
    }
    // Yet the console genuinely sits on the floor, 82.88 wu below its own
    // centre — the quantizer put that on the node, which is the whole point.
    expect(SHIPPED_CONSOLE.nodeX).not.toBe(0);
  });

  // The chair constants are load-bearing beyond the assert: the seat offset is
  // derived from the 64 wu half-width.
  test('the chair half-width the offset is derived from matches the asset', () => {
    const measured = SHIPPED_CHAIR.maxX * SHIPPED_CHAIR.scaleX;
    expect(Math.abs(measured - TRADING_FLOOR_CHAIR_HALF_X)).toBeLessThan(
      AUTHORED_PROP_TOLERANCE_WU,
    );
  });
});

describe('Trading Floor camera — the rig never inverts at a wall', () => {
  /**
   * The invariant: the camera's bound must leave an arm BEHIND the player's own
   * bound, on every axis. When it does not, the camera ends up in FRONT of the
   * avatar at that wall — the view faces away from the thing the player walked
   * to, the avatar smears across the near plane, and any label anchored past the
   * camera is culled in view space.
   *
   * That shipped on Z. `zMax: halfZ` gave the camera ±1040 while the movement
   * clamp lets the player reach ±1054, so the rig inverted 14 wu from either end
   * wall, and the Exit prompt (anchor z 1060) was behind the camera at EVERY
   * distance rather than merely when armed.
   */
  const playerMaxZ = TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS;
  const cameraMaxX = TRADING_FLOOR_DESK_INNER_X;

  test('the camera can get behind a player pressed into the door wall', () => {
    expect(TRADING_FLOOR_CAMERA_Z_MAX).toBeGreaterThan(playerMaxZ);
  });

  // Zero arm, not negative: the board surround protrudes, so the camera stops at
  // the player's own limit rather than reversing into the bezel.
  test('the camera never ends up in front of the player at the board wall', () => {
    expect(TRADING_FLOOR_CAMERA_Z_MIN).toBeLessThanOrEqual(-playerMaxZ);
  });

  test('the camera clears the board surround it stops short of', () => {
    expect(TRADING_FLOOR_CAMERA_Z_MIN).toBeGreaterThan(
      TRADING_FLOOR_SCREEN_SURROUND_FACE_Z,
    );
    // And the surround really is in front of the board plane it frames.
    expect(TRADING_FLOOR_SCREEN_SURROUND_FACE_Z).toBeGreaterThan(
      TRADING_FLOOR_SCREEN.z,
    );
  });

  test('both Z limits stay inside the hall', () => {
    expect(TRADING_FLOOR_CAMERA_Z_MAX).toBeLessThan(TRADING_FLOOR_ROOM.halfZ);
    expect(TRADING_FLOOR_CAMERA_Z_MIN).toBeGreaterThan(-TRADING_FLOOR_ROOM.halfZ);
  });

  /**
   * The symptom that made this a functional defect rather than a framing one.
   * `world-labels-overlay` culls any anchor at or behind the camera plane in
   * view space, so a door label the camera can never get behind is a prompt that
   * never renders — and the exit still works, which is why it survived.
   */
  test('the exit label sits IN FRONT of the camera at its furthest point', () => {
    const anchorZ = TRADING_FLOOR_DOOR.z - 40;
    expect(anchorZ).toBeLessThan(TRADING_FLOOR_CAMERA_Z_MAX);
  });

  // The X bound is tangent by design and the player is stopped short of it, so
  // X is the one axis where an arm is not required. Pinned so the asymmetry
  // reads as deliberate rather than as the same bug half-fixed.
  test('X needs no arm because the player never reaches its bound', () => {
    const playerMaxXAtADesk = cameraMaxX - TRADING_FLOOR_PLAYER_RADIUS;
    expect(playerMaxXAtADesk).toBeLessThan(cameraMaxX);
  });
});

describe('Trading Floor camera — the door approach leaves a real arm', () => {
  // The camera-side bound alone stopped the INVERSION but left only 34 wu of
  // arm, which is not a chase shot — the avatar fills the near plane. The player
  // stops short instead, and the arm comes back without taking room from anyone.
  const playerMaxZ = TRADING_FLOOR_DOOR_APPROACH_Z;

  test('the camera keeps at least 100 wu behind the player at the door', () => {
    expect(TRADING_FLOOR_CAMERA_Z_MAX - playerMaxZ).toBeGreaterThanOrEqual(100);
  });

  test('the door still arms at the player closest legal approach', () => {
    const distance = TRADING_FLOOR_DOOR.z - playerMaxZ;
    expect(distance).toBeLessThan(TRADING_FLOOR_DOOR.interactRadius);
    // Pressed to the limit, dead ahead of the door, E fires.
    expect(
      tradingFloorDistanceSq(
        TRADING_FLOOR_DOOR.x,
        playerMaxZ,
        TRADING_FLOOR_DOOR.x,
        TRADING_FLOOR_DOOR.z,
      ),
    ).toBeLessThan(TRADING_FLOOR_DOOR.interactRadius ** 2);
  });

  test('the walkable clamp actually enforces the approach limit', () => {
    const out = { x: 0, z: 0 };
    clampTradingFloorMovement2D(0, 900, 0, 99_999, out);
    expect(out.z).toBe(TRADING_FLOOR_DOOR_APPROACH_Z);
    // The board end is UNCHANGED — you can still walk up and read the board.
    clampTradingFloorMovement2D(0, -900, 0, -99_999, out);
    expect(out.z).toBe(-(TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS));
  });

  test('the spawn is unaffected and still short of the limit', () => {
    expect(TRADING_FLOOR_PLAYER_SPAWN.z).toBeLessThan(TRADING_FLOOR_DOOR_APPROACH_Z);
    expect(tradingFloorHitsSolid(TRADING_FLOOR_PLAYER_SPAWN.x, TRADING_FLOOR_PLAYER_SPAWN.z)).toBe(false);
    // And the door is still NOT armed on arrival, which the pull-back could
    // have broken by moving the limit past the spawn.
    expect(
      tradingFloorDistanceSq(
        TRADING_FLOOR_PLAYER_SPAWN.x,
        TRADING_FLOOR_PLAYER_SPAWN.z,
        TRADING_FLOOR_DOOR.x,
        TRADING_FLOOR_DOOR.z,
      ),
    ).toBeGreaterThan(TRADING_FLOOR_DOOR.interactRadius ** 2);
  });

  test('the approach limit is still outside every solid', () => {
    expect(tradingFloorHitsSolid(TRADING_FLOOR_DOOR.x, TRADING_FLOOR_DOOR_APPROACH_Z)).toBe(false);
  });
});

describe('Trading Floor camera — the exit prompt is actually on screen', () => {
  /**
   * This prompt has been invisible twice, for two different reasons, and both
   * times the exit still worked — so nothing but a human looking at the screen
   * caught it. First the anchor was BEHIND the camera plane and culled in view
   * space; then, with the camera bound raised, it was in front but 96.6° off the
   * view axis and above the top edge.
   *
   * The trap is that the camera is itself pitched DOWN: it sits at `above` and
   * looks at `lookY`, about 14.6° below horizontal at the door. An anchor's
   * elevation from HORIZONTAL is therefore not its angle from the VIEW AXIS, and
   * a candidate that looks fine at 20.3° of elevation is really at 34.9° and
   * still off-screen. This test measures the angle that actually matters.
   */
  const HALF_FOV_DEG = TRADING_FLOOR_CAMERA.fov / 2;
  const anchorY = 270; // AVATAR_TARGET_HEIGHT, the label's head-height anchor
  const anchorZ = TRADING_FLOOR_DOOR_APPROACH_Z - 40;

  /** Angle between the camera's view axis and the anchor, in degrees. */
  function offAxisDeg(bodyZ: number, pitch: number): number {
    const camY = TRADING_FLOOR_CAMERA.above + pitch;
    const camZ = Math.min(bodyZ + TRADING_FLOOR_CAMERA.behind, TRADING_FLOOR_CAMERA_Z_MAX);
    // The scene looks at (bodyZ - lookAhead) at height lookY, yaw 0 at the door.
    const axisY = TRADING_FLOOR_CAMERA.lookY - camY;
    const axisZ = bodyZ - TRADING_FLOOR_CAMERA.lookAhead - camZ;
    const axisLen = Math.hypot(axisY, axisZ);
    const vecY = anchorY - camY;
    const vecZ = anchorZ - camZ;
    const vecLen = Math.hypot(vecY, vecZ);
    const dot = (axisY * vecY + axisZ * vecZ) / (axisLen * vecLen);
    return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  }

  test('the anchor is in FRONT of the camera, not merely inside the room', () => {
    expect(anchorZ).toBeLessThan(TRADING_FLOOR_CAMERA_Z_MAX);
  });

  // Swept across the whole band the label is shown in, not just at the clamp.
  test('the prompt stays inside the vertical FOV across the whole approach', () => {
    const hintStart = TRADING_FLOOR_DOOR.z - TRADING_FLOOR_DOOR.nearHintRadius;
    let worst = 0;
    for (let bodyZ = hintStart; bodyZ <= TRADING_FLOOR_DOOR_APPROACH_Z; bodyZ += 10) {
      worst = Math.max(worst, offAxisDeg(bodyZ, 0));
    }
    expect(worst).toBeLessThan(HALF_FOV_DEG);
    // With real margin, not scraping the edge.
    expect(worst).toBeLessThan(HALF_FOV_DEG - 5);
  });

  test('it survives the player pitching the camera', () => {
    for (const pitch of [TRADING_FLOOR_CAMERA.pitchMin, -60, 0, 60]) {
      expect(offAxisDeg(TRADING_FLOOR_DOOR_APPROACH_Z, pitch)).toBeLessThan(HALF_FOV_DEG);
    }
  });

  // The exact two placements that shipped broken, so neither can come back.
  test('the two historical anchor positions are proved off-screen', () => {
    const historical = (y: number, z: number) => {
      const camY = TRADING_FLOOR_CAMERA.above;
      const camZ = TRADING_FLOOR_CAMERA_Z_MAX;
      const bodyZ = TRADING_FLOOR_DOOR_APPROACH_Z;
      const axisY = TRADING_FLOOR_CAMERA.lookY - camY;
      const axisZ = bodyZ - TRADING_FLOOR_CAMERA.lookAhead - camZ;
      const aLen = Math.hypot(axisY, axisZ);
      const vY = y - camY;
      const vZ = z - camZ;
      const vLen = Math.hypot(vY, vZ);
      const dot = (axisY * vY + axisZ * vZ) / (aLen * vLen);
      return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
    };
    // (DOOR.height - 40, DOOR.z - 40) — the original, off the top edge.
    expect(historical(460, 1060)).toBeGreaterThan(HALF_FOV_DEG);
    // The first replacement proposed from an elevation figure that ignored the
    // camera's own downward pitch. Still off-screen.
    expect(historical(300, 980)).toBeGreaterThan(HALF_FOV_DEG);
  });
});

describe('Trading Floor camera — push-out of solids', () => {
  const CLEAR = TRADING_FLOOR_CAMERA_SOLID_CLEARANCE;
  const dais = TRADING_FLOOR_SOLIDS.find((s) => s.halfX === 350)!;

  function isInside(x: number, z: number): boolean {
    return TRADING_FLOOR_SOLIDS.some(
      (s) =>
        Math.abs(x - s.centerX) < s.halfX + CLEAR &&
        Math.abs(z - s.centerZ) < s.halfZ + CLEAR,
    );
  }

  // The reported symptom: player on the far side of the ring, pitched down, and
  // the camera ends up INSIDE the dais with dark geometry across the frame.
  test('a camera inside the dais comes out along the shortest axis', () => {
    // Nearer the dais Z face than its X face, so Z is the shortest way out.
    const pos = { x: dais.centerX, z: dais.centerZ + dais.halfZ - 5 };
    pushCameraOutOfSolids(pos, TRADING_FLOOR_SOLIDS, CLEAR);
    expect(pos.x).toBe(dais.centerX);
    expect(pos.z).toBeCloseTo(dais.centerZ + dais.halfZ + CLEAR, 6);
    expect(isInside(pos.x, pos.z)).toBe(false);
  });

  test('dead centre of a solid still resolves, and does not stay put', () => {
    // Math.sign(0) is 0, so a naive push would "resolve" this by not moving.
    const pos = { x: dais.centerX, z: dais.centerZ };
    pushCameraOutOfSolids(pos, TRADING_FLOOR_SOLIDS, CLEAR);
    expect(isInside(pos.x, pos.z)).toBe(false);
  });

  test('a camera already outside is left exactly alone', () => {
    for (const point of [
      { x: 0, z: 900 },
      { x: 600, z: 800 },
      { x: -985, z: 200 },
    ]) {
      const pos = { ...point };
      pushCameraOutOfSolids(pos, TRADING_FLOOR_SOLIDS, CLEAR);
      expect(pos).toEqual(point);
    }
  });

  // Resolving one solid can push the point into a neighbour, so the contract is
  // the POSTCONDITION, not a single pass.
  test('every point in the hall ends up outside every solid', () => {
    const pos = { x: 0, z: 0 };
    let worst: string | null = null;
    for (let x = -1300; x <= 1300; x += 37) {
      for (let z = -1100; z <= 1100; z += 37) {
        pos.x = x;
        pos.z = z;
        pushCameraOutOfSolids(pos, TRADING_FLOOR_SOLIDS, CLEAR);
        if (isInside(pos.x, pos.z)) worst = `(${x}, ${z})`;
      }
    }
    expect(worst).toBeNull();
  });

  test('a corner of the dais resolves out of the box on both axes', () => {
    const pos = {
      x: dais.centerX + dais.halfX - 2,
      z: dais.centerZ + dais.halfZ - 2,
    };
    pushCameraOutOfSolids(pos, TRADING_FLOOR_SOLIDS, CLEAR);
    expect(isInside(pos.x, pos.z)).toBe(false);
  });

  // The clearance is deliberately NOT roomMargin. At 60 the desks would shove
  // the camera from the desk face at 985 out to 925, costing another 60 wu of
  // framing at the side walls where it is already tight.
  test('the clearance is small enough not to eat the desk-face bound', () => {
    expect(CLEAR).toBeLessThan(TRADING_FLOOR_CAMERA.roomMargin);
    const pos = { x: TRADING_FLOOR_DESK_INNER_X, z: -500 };
    pushCameraOutOfSolids(pos, TRADING_FLOOR_SOLIDS, CLEAR);
    expect(TRADING_FLOOR_DESK_INNER_X - Math.abs(pos.x)).toBeLessThanOrEqual(CLEAR);
  });
});

describe('Trading Floor seats — an agent can walk to every one of them', () => {
  /**
   * Flood fill the standable floor from the spawn on a 10 wu grid. This is the
   * founder's sentence turned into an assertion: a seat that no walk can reach
   * is a desk nobody sits at, however correct its coordinates look in a table.
   *
   * 10 wu is well under the 46 wu player radius already baked into
   * `tradingFloorHitsSolid`, so the fill cannot squeeze through a gap the real
   * clamp would refuse.
   */
  const STEP = 10;

  function floodFillFromSpawn(): Set<string> {
    const maxX = TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_PLAYER_RADIUS;
    const maxZ = TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS;
    const key = (cx: number, cz: number) => `${cx},${cz}`;
    const inBounds = (x: number, z: number) =>
      Math.abs(x) <= maxX && Math.abs(z) <= maxZ;

    const startX = Math.round(TRADING_FLOOR_PLAYER_SPAWN.x / STEP) * STEP;
    const startZ = Math.round(TRADING_FLOOR_PLAYER_SPAWN.z / STEP) * STEP;
    const visited = new Set<string>([key(startX, startZ)]);
    const queue: number[] = [startX, startZ];

    for (let head = 0; head < queue.length; head += 2) {
      const x = queue[head]!;
      const z = queue[head + 1]!;
      for (const [dx, dz] of [
        [STEP, 0],
        [-STEP, 0],
        [0, STEP],
        [0, -STEP],
      ] as const) {
        const nx = x + dx;
        const nz = z + dz;
        if (!inBounds(nx, nz)) continue;
        const cell = key(nx, nz);
        if (visited.has(cell)) continue;
        if (tradingFloorHitsSolid(nx, nz)) continue;
        visited.add(cell);
        queue.push(nx, nz);
      }
    }
    return visited;
  }

  const reachable = floodFillFromSpawn();

  test('the spawn itself is standable', () => {
    expect(
      tradingFloorHitsSolid(
        TRADING_FLOOR_PLAYER_SPAWN.x,
        TRADING_FLOOR_PLAYER_SPAWN.z,
      ),
    ).toBe(false);
    expect(reachable.size).toBeGreaterThan(1000);
  });

  test('every seat has a reachable cell within one grid step', () => {
    for (const seat of TRADING_FLOOR_SEATS) {
      let closest = Number.POSITIVE_INFINITY;
      for (const cell of reachable) {
        const comma = cell.indexOf(',');
        const cx = Number(cell.slice(0, comma));
        const cz = Number(cell.slice(comma + 1));
        closest = Math.min(closest, Math.hypot(cx - seat.x, cz - seat.z));
        if (closest <= STEP) break;
      }
      expect({ seat: seat.index, withinOneStep: closest <= STEP }).toEqual({
        seat: seat.index,
        withinOneStep: true,
      });
    }
  });

  // Both walls, so a mirroring mistake cannot hide behind one reachable side.
  test('three seats line each side wall and they mirror in Z', () => {
    const left = TRADING_FLOOR_SEATS.filter((seat) => seat.x < 0);
    const right = TRADING_FLOOR_SEATS.filter((seat) => seat.x > 0);
    expect([left.length, right.length]).toEqual([3, 3]);
    const leftZ = left.map((seat) => seat.z).sort((a, b) => a - b);
    const rightZ = right.map((seat) => seat.z).sort((a, b) => a - b);
    expect(leftZ).toEqual(rightZ);
    for (let index = 0; index < left.length; index += 1) {
      expect(left[index]!.x).toBe(-right[index]!.x);
    }
  });
});
