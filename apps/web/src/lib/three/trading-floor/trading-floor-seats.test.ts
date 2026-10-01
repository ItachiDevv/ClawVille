import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import type { RootState } from '@react-three/fiber';
import { useGameStore } from '@/stores/game';
import { DEFAULT_PLAYER_CAPABILITIES } from '@/lib/three/player/player-capability-mask';
import { createPlayerControllerTestRuntime, runPlayerControllerFrameForTests, type PlayerCapabilityControllerConfig } from '@/lib/three/player/player-capability-controller';
import { playerKeyState, resetPlayerKeys } from '@/lib/three/player/player-input';
import { TRADING_FLOOR_POLICY } from '@/lib/three/player/player-motion-policy';
import { tradingFloorStandRequested, tradingFloorManualSit, tradingFloorPinBlend, tradingFloorArmWeight } from './trading-floor-sit';
import {
  activateTradingFloorSeat,
  tradingFloorSitClips,
} from './trading-floor-interior';
import {
  clampTradingFloorMovement2D,
  clampTradingFloorMovementSeated,
  computeTradingFloorArming,
  consoleHalfExtents,
  createTradingFloorArming,
  placeTradingFloorChaseCamera,
  smoothTradingFloorCameraArm,
  TRADING_FLOOR_CAMERA_BOUNDS,
  TRADING_FLOOR_CAMERA_ARM,
  TRADING_FLOOR_CAMERA_SOLIDS_HIGH,
  TRADING_FLOOR_CAMERA_SOLIDS_LOW,
  TRADING_FLOOR_CLAW_EXTENTS,
  TRADING_FLOOR_SIDE_APPROACH_X,
  TRADING_FLOOR_BOARD_APPROACH_Z,
  TRADING_FLOOR_MONITOR,
  tradingFloorDoorPromptVisible,
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

describe('Trading Floor stand intent', () => {
  test('manual-seat cushion pin snaps with the legs on sit and every stand path', () => {
    for (const id of ['hermes-female', 'hermes-male', 'tekk', 'adinero', 'chibi']) {
      expect(tradingFloorManualSit(id)).toBe(true);
      expect(tradingFloorPinBlend(0, 1, FRAME_SECONDS, false, false)).toBe(1);
      for (const fastStand of [false, true]) {
        expect(tradingFloorPinBlend(1, 0, FRAME_SECONDS, false, fastStand)).toBe(0);
      }
    }
    expect(tradingFloorPinBlend(0, 1, FRAME_SECONDS, true, false)).toBeLessThan(0.02);
    expect(tradingFloorPinBlend(1, 0, FRAME_SECONDS, true, false)).toBeGreaterThan(0.98);
  });

  test('arm override follows the 0.3 second clip fades and the 0.2 second movement stand', () => {
    expect(tradingFloorArmWeight(0, true, FRAME_SECONDS, false)).toBeCloseTo(1 / 18);
    expect(tradingFloorArmWeight(0, true, 0.3, false)).toBe(1);
    expect(tradingFloorArmWeight(1, false, 0.2, false)).toBeCloseTo(1 / 3);
    expect(tradingFloorArmWeight(1, false, 0.3, false)).toBe(0);
    expect(tradingFloorArmWeight(1, false, 0.2, true)).toBe(0);
  });
  test('full seated/movement/Escape/previous-freeze truth table', () => {
    for (const seat of [-1, ...TRADING_FLOOR_SEATS.map((seat) => seat.index)]) {
      for (const moving of [false, true]) for (const escape of [false, true]) for (const frozenPrev of [false, true]) {
        expect(tradingFloorStandRequested(seat, moving, escape, frozenPrev))
          .toBe(seat >= 0 && (moving || (escape && !frozenPrev)));
      }
    }
  });

  test('Escape after a modal frozen frame cannot stand the avatar', () => {
    resetPlayerKeys();
    const oldExchangeOpen = useGameStore.getState().exchangeOpen;
    let seated = 0;
    let frozenLast = false;
    let frozenPrev = false;
    let afterMove = 0;
    const config: PlayerCapabilityControllerConfig = {
      sceneId: 'trading-floor', capabilities: DEFAULT_PLAYER_CAPABILITIES,
      motion: TRADING_FLOOR_POLICY.motion, input: TRADING_FLOOR_POLICY.input,
      isDriving: () => true, isFrozen: () => useGameStore.getState().exchangeOpen,
      onFrameStart: () => { frozenPrev = frozenLast; frozenLast = useGameStore.getState().exchangeOpen; },
      space: {
        speedPerSec: 1, readPosition: (out) => { out.x = 0; out.z = 0; },
        clampMovement: (_px, _pz, x, z, out) => { out.x = x; out.z = z; out.groundY = 0; },
        commitPosition: () => {},
      },
      onAfterMove: (state) => {
        afterMove++;
        if (tradingFloorStandRequested(seated, state.intent.move.moving, state.intent.escapeEdge, frozenPrev)) seated = -1;
      },
    };
    const runtime = createPlayerControllerTestRuntime(config.motion);
    const state = { camera: new THREE.PerspectiveCamera(), clock: { elapsedTime: 0 } } as RootState;
    try {
      useGameStore.setState({ exchangeOpen: true });
      runPlayerControllerFrameForTests(config, runtime, state, FRAME_SECONDS);
      expect(afterMove).toBe(0);
      // Modal keydown closes the store before the next controller frame.
      useGameStore.getState().closeExchange();
      playerKeyState.escape = true;
      runPlayerControllerFrameForTests(config, runtime, state, FRAME_SECONDS);
      expect(afterMove).toBe(1);
      expect(seated).toBe(0);
    } finally {
      resetPlayerKeys();
      useGameStore.setState({ exchangeOpen: oldExchangeOpen });
    }
  });

  test('all five hold’em fallback rigs use manual seats; Milady retains the enter clip', () => {
    for (const id of ['hermes-female', 'hermes-male', 'tekk', 'adinero', 'chibi']) {
      expect(tradingFloorManualSit(id)).toBe(true);
      expect(tradingFloorSitClips('vrm', id)).toBeNull();
    }
    expect(tradingFloorSitClips('vrm', 'vrm-milady')?.enter).toBe('sit_stand_to_sit');
  });
});

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
        TRADING_FLOOR_SIDE_APPROACH_X,
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
    const CHAIR_TOP_RAIL = 174;
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
   * against `trading-floor-interior-opt1-mo-ktx.glb` (340,820 bytes, ?v=5).
   * `KHR_mesh_quantization` normalises each mesh
   * into [-1, 1] and pushes the real size onto the node scale, which is why the
   * bounds below are fractions and the scale is ~87 to ~182.
   */
  const SHIPPED_CONSOLE = {
    scaleX: 182,
    scaleY: 182,
    scaleZ: 182,
    minX: -1,
    maxX: 1,
    minZ: -0.7417828913235878,
    maxZ: 0.7417828913235878,
    expectedHalfX: TRADING_FLOOR_CONSOLE_HALF_X,
    expectedHalfZ: TRADING_FLOOR_CONSOLE_HALF_Z,
    nodeX: -1120,
    nodeZ: -500,
    expectedNodeX: TRADING_FLOOR_CONSOLE_ROW[0]!.x,
    expectedNodeZ: TRADING_FLOOR_CONSOLE_ROW[0]!.z,
  };
  const SHIPPED_CHAIR = {
    scaleX: 87,
    scaleY: 87,
    scaleZ: 87,
    minX: -0.7356791894283883,
    maxX: 0.7356791894283883,
    minZ: -0.7011322367015594,
    maxZ: 0.7011322367015594,
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

  // The console Z half-extent measures 135.0045 against a stated 135. The tolerance has to
  // absorb that rounding, or the assert cries wolf on a correct asset.
  test('the tolerance absorbs the sub-wu rounding the constants carry', () => {
    const measuredHalfZ = SHIPPED_CONSOLE.maxZ * SHIPPED_CONSOLE.scaleZ;
    expect(Math.abs(measuredHalfZ - TRADING_FLOOR_CONSOLE_HALF_Z)).toBeGreaterThan(0);
    expect(Math.abs(measuredHalfZ - TRADING_FLOOR_CONSOLE_HALF_Z)).toBeLessThan(
      AUTHORED_PROP_TOLERANCE_WU,
    );
    const mismatched = validateAuthoredProp('c', {
      ...SHIPPED_CONSOLE,
      minZ: -(TRADING_FLOOR_CONSOLE_HALF_Z + AUTHORED_PROP_TOLERANCE_WU * 1.1) / SHIPPED_CONSOLE.scaleZ,
      maxZ: (TRADING_FLOOR_CONSOLE_HALF_Z + AUTHORED_PROP_TOLERANCE_WU * 1.1) / SHIPPED_CONSOLE.scaleZ,
    });
    expect(mismatched.problems.join(' ')).toContain('halfZ');
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
    // Yet the console genuinely sits on the floor, 82.99 wu below its own
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

  test('both side clamps leave an arm even between desks and past the row', () => {
    const out = { x: 0, z: 0 };
    for (const sign of [-1, 1]) {
      clampTradingFloorMovement2D(0, TRADING_FLOOR_DOOR_APPROACH_Z,
        sign * TRADING_FLOOR_ROOM.halfX, TRADING_FLOOR_DOOR_APPROACH_Z, out);
      expect(out.x).toBe(sign * TRADING_FLOOR_SIDE_APPROACH_X);
      expect(cameraMaxX - Math.abs(out.x)).toBe(TRADING_FLOOR_PLAYER_RADIUS);
    }
  });
});

describe('Trading Floor camera — the door approach leaves a real arm', () => {
  // The camera-side bound alone stopped the INVERSION but left only 34 wu of
  // arm, which is not a chase shot — the avatar fills the near plane. The player
  // stops short instead, and the arm comes back without taking room from anyone.
  const playerMaxZ = TRADING_FLOOR_DOOR_APPROACH_Z;

  test('the camera keeps at least 100 wu behind the player at the door', () => {
    expect(TRADING_FLOOR_CAMERA_Z_MAX - playerMaxZ).toBeGreaterThanOrEqual(100);
    const camera = { x: 0, y: 0, z: 0 };
    for (let deg = 0; deg < 360; deg += 3)
      for (const pitch of [TRADING_FLOOR_CAMERA.pitchMin, 0, TRADING_FLOOR_CAMERA.pitchMax]) {
        const arm = placeTradingFloorChaseCamera(TRADING_FLOOR_DOOR.x, playerMaxZ, deg * Math.PI / 180, pitch, camera);
        expect(arm).toBeGreaterThanOrEqual(100);
      }
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
    // The board approach mirrors the door standoff.
    clampTradingFloorMovement2D(0, -900, 0, -99_999, out);
    expect(out.z).toBe(TRADING_FLOOR_BOARD_APPROACH_Z);
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
    const cam = { x: 0, y: 0, z: 0 };
    placeTradingFloorChaseCamera(TRADING_FLOOR_DOOR.x, bodyZ, 0, pitch, cam);
    const camY = cam.y, camZ = cam.z;
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

  // Swept across the whole hint band, not just at the clamp. Facing the board
  // (this pose), the capsule has been shown only inside the ARMED band since
  // 2026-09-30 (`tradingFloorDoorPromptVisible`, next describe); the sweep still
  // covers the whole band so the anchor stays on screen if that rule widens.
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

describe('Trading Floor exit capsule — never a hint over the big board', () => {
  /**
   * Verifier B, staging 9dc59f73 (shots b-01/b-02): the "Exit" capsule sat on
   * the board's basis line and ticker from the spawn. The spawn is 320 wu from
   * the door, inside the 460 wu hint band, and facing the board the anchor
   * projects onto the board's bottom edge at EVERY point of that band, because
   * the camera is clamped at z 1088 the whole way. The hint now needs the camera
   * to face the door half-space; the armed prompt is always shown.
   */
  test('the rule: armed always, the hint only while facing the door', () => {
    expect(tradingFloorDoorPromptVisible(true, true, -1)).toBe(true);
    expect(tradingFloorDoorPromptVisible(true, true, 1)).toBe(true);
    expect(tradingFloorDoorPromptVisible(false, true, 1)).toBe(true);
    expect(tradingFloorDoorPromptVisible(false, true, 0.01)).toBe(true);
    // Facing the board, or exactly sideways: no hint.
    expect(tradingFloorDoorPromptVisible(false, true, -1)).toBe(false);
    expect(tradingFloorDoorPromptVisible(false, true, 0)).toBe(false);
    // Out of the band: nothing, whichever way the camera faces.
    expect(tradingFloorDoorPromptVisible(false, false, 1)).toBe(false);
  });

  test('on arrival (spawn, camera facing the board) the hint is on and the capsule is hidden', () => {
    const arming = createTradingFloorArming();
    computeTradingFloorArming(TRADING_FLOOR_PLAYER_SPAWN.x, TRADING_FLOOR_PLAYER_SPAWN.z, arming);
    expect(arming.doorHint).toBe(true);
    expect(arming.doorArmed).toBe(false);
    // Yaw 0 is the spawn yaw: forward = (sin 0, 0, -cos 0).
    expect(tradingFloorDoorPromptVisible(arming.doorArmed, arming.doorHint, -Math.cos(0))).toBe(
      false,
    );
  });

  /**
   * THE PROJECTION PIN. The camera is placed exactly as the frame loop places
   * it (the shared spring-arm placement and look-ahead target), the capsule's screen rectangle is sampled, and a ray from the
   * camera through each sample is tested against the board's rectangle in the
   * world. A ray test rather than projecting the board's corners, because a
   * board partly behind the camera has no meaningful projected outline.
   *
   * The capsule is centred horizontally on the anchor and sits ABOVE it
   * (`translate(-50%,-50%)` in the overlay plus the capsule's own
   * `translateY(-50%)`): about 63 x 33 px as a hint and 102 x 44 px armed, so
   * the sampled box is a conservative 128 x 48 px.
   */
  const ANCHOR = new THREE.Vector3(
    TRADING_FLOOR_DOOR.x,
    270, // AVATAR_TARGET_HEIGHT, the label's head-height anchor
    TRADING_FLOOR_DOOR_APPROACH_Z - 40,
  );
  const CAPSULE_HALF_W = 64;
  const CAPSULE_H = 48;
  const VIEWPORTS: ReadonlyArray<readonly [number, number]> = [
    [1366, 768],
    [1350, 805],
    [1920, 1080],
    [2560, 1080],
  ];
  const BOARD_HALF_W = TRADING_FLOOR_SCREEN.width / 2;
  const BOARD_BOTTOM = TRADING_FLOOR_SCREEN.bottomY;
  const BOARD_TOP = TRADING_FLOOR_SCREEN.bottomY + TRADING_FLOOR_SCREEN.height;

  const camera = new THREE.PerspectiveCamera(TRADING_FLOOR_CAMERA.fov, 1, TRADING_FLOOR_CAMERA.near, 10_000);
  const camPos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const view = new THREE.Vector3();
  const sample = new THREE.Vector3();

  /**
   * Where the capsule lands for the current camera:
   *   culled    — the anchor is behind the camera; the overlay draws nothing.
   *   offscreen — in front, but the anchor projects outside the viewport.
   *   over      — some sampled point of the capsule lies over the board.
   *   clear     — on screen and clear of the board.
   * Codex r16: the sweep's "shown" count must count only what a player can SEE,
   * or a sweep of culled labels would pass while proving nothing.
   */
  function capsuleState(width: number, height: number): 'culled' | 'offscreen' | 'over' | 'clear' {
    view.copy(ANCHOR).applyMatrix4(camera.matrixWorldInverse);
    if (view.z >= 0) return 'culled';
    ndc.copy(ANCHOR).project(camera);
    const onScreen = Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
    if (capsuleOverBoard(width, height)) return 'over';
    return onScreen ? 'clear' : 'offscreen';
  }

  /** True when any sampled point of the capsule lies over the board. Call
   *  after `ndc` holds the anchor's projection (see `capsuleState`). */
  function capsuleOverBoard(width: number, height: number): boolean {
    for (const dx of [-CAPSULE_HALF_W, 0, CAPSULE_HALF_W]) {
      for (const dy of [0, CAPSULE_H / 2, CAPSULE_H]) {
        // Screen y grows DOWN, NDC y grows UP: "above the anchor" is +NDC y.
        sample
          .set(ndc.x + (dx * 2) / width, ndc.y + (dy * 2) / height, 0.5)
          .unproject(camera)
          .sub(camPos);
        if (sample.z >= 0) continue; // the board is at -Z of every camera
        const t = (TRADING_FLOOR_SCREEN.z - camPos.z) / sample.z;
        const x = camPos.x + sample.x * t;
        const y = camPos.y + sample.y * t;
        if (Math.abs(x) <= BOARD_HALF_W && y >= BOARD_BOTTOM && y <= BOARD_TOP) return true;
      }
    }
    return false;
  }

  function placeCamera(bodyX: number, bodyZ: number, yaw: number, pitch: number): void {
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    placeTradingFloorChaseCamera(bodyX, bodyZ, yaw, pitch, camPos);
    look.set(
      bodyX + sin * TRADING_FLOOR_CAMERA.lookAhead,
      TRADING_FLOOR_CAMERA.lookY,
      bodyZ - cos * TRADING_FLOOR_CAMERA.lookAhead,
    );
    camera.position.copy(camPos);
    camera.lookAt(look);
    camera.updateMatrixWorld(true);
  }

  test('swept over the hint band, every yaw, pitch and viewport: a visible HINT never covers the board', () => {
    const arming = createTradingFloorArming();
    /** Visible hints whose capsule a player can actually see on screen. */
    let hintsOnScreen = 0;
    /** Visible hints over the board, on screen or partly off it. */
    let hintOverlaps = 0;
    let oldRuleOverlaps = 0;
    let armedOverlaps = 0;
    for (const [width, height] of VIEWPORTS) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      for (let bodyX = -900; bodyX <= 900; bodyX += 100) {
        for (let bodyZ = TRADING_FLOOR_DOOR.z - TRADING_FLOOR_DOOR.nearHintRadius; bodyZ <= TRADING_FLOOR_DOOR_APPROACH_Z; bodyZ += 40) {
          if (tradingFloorHitsSolid(bodyX, bodyZ)) continue;
          computeTradingFloorArming(bodyX, bodyZ, arming);
          if (!arming.doorHint) continue;
          for (let step = 0; step < 24; step += 1) {
            const yaw = (step / 24) * Math.PI * 2;
            const forwardZ = -Math.cos(yaw);
            for (const pitch of [TRADING_FLOOR_CAMERA.pitchMin, 0, TRADING_FLOOR_CAMERA.pitchMax]) {
              placeCamera(bodyX, bodyZ, yaw, pitch);
              const state = capsuleState(width, height);
              const over = state === 'over';
              if (over) oldRuleOverlaps += 1; // the shipped rule: doorHint alone
              if (!tradingFloorDoorPromptVisible(arming.doorArmed, arming.doorHint, forwardZ)) continue;
              if (arming.doorArmed) {
                if (over) armedOverlaps += 1;
                continue;
              }
              if (state === 'clear') hintsOnScreen += 1;
              if (over) hintOverlaps += 1;
            }
          }
        }
      }
    }
    // Non-vacuous: many hints are ON SCREEN (in front of the camera, anchor
    // inside the viewport) in this sweep, and the sweep DOES detect the defect
    // under the shipped rule.
    expect(hintsOnScreen).toBeGreaterThan(1000);
    expect(oldRuleOverlaps).toBeGreaterThan(0);
    // The fix: no visible hint over the board, on screen or partly off it.
    expect(hintOverlaps).toBe(0);
    // The documented exception, pinned so it cannot grow unnoticed: the ARMED
    // prompt facing the board may still cover the board's footer. It exists
    // (backing into the door with the camera on the board), and it is bounded
    // by the 240 wu armed radius.
    expect(armedOverlaps).toBeGreaterThan(0);
  });

  test('the frame loop publishes the camera forward Z for the label rule', () => {
    const source = readFileSync(join(import.meta.dir, 'trading-floor-interior.tsx'), 'utf8');
    expect(source).toContain('_cameraForwardZ = _forwardScratch.z;');
    expect(source).toContain('tradingFloorDoorPromptVisible(');
    expect(source).toContain('const rawArm = placeTradingFloorChaseCamera(');
    expect(source).toContain('cameraArm.current = smoothTradingFloorCameraArm(');
    expect(source).not.toContain('pushCameraOutOfSolids');
    expect(source).not.toContain('clampCameraToRoom');
    expect(source).not.toContain('camera.position.lerp(');
    // The old rule, visibility straight off the hint, must not come back.
    expect(source).not.toContain('setDoorVisible(_arming.doorHint)');
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
    const maxX = TRADING_FLOOR_SIDE_APPROACH_X;
    const minZ = TRADING_FLOOR_BOARD_APPROACH_Z, maxZ = TRADING_FLOOR_DOOR_APPROACH_Z;
    const key = (cx: number, cz: number) => `${cx},${cz}`;
    const inBounds = (x: number, z: number) =>
      Math.abs(x) <= maxX && z >= minZ && z <= maxZ;

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
        const step = { x: 0, z: 0 };
        clampTradingFloorMovement2D(x, z, nx, nz, step);
        if (step.x !== nx || step.z !== nz) continue;
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
      const arming = createTradingFloorArming();
      computeTradingFloorArming(seat.x, seat.z, arming);
      expect(arming.seatArmedIndex).toBe(seat.index);
      const exact = { x: 0, z: 0 };
      clampTradingFloorMovement2D(seat.x - Math.sign(seat.x) * STEP, seat.z, seat.x, seat.z, exact);
      expect(exact).toEqual({ x: seat.x, z: seat.z });
      expect({ seat: seat.index, withinOneStep: closest <= STEP }).toEqual({
        seat: seat.index,
        withinOneStep: true,
      });
    }
  });

  test('the kiosk and door approaches connect to spawn and arm their hotspots', () => {
    const kioskZ = TRADING_FLOOR_MONITOR.z + TRADING_FLOOR_MONITOR.halfZ +
      TRADING_FLOOR_PLAYER_RADIUS + TRADING_FLOOR_CAMERA_ARM.originInset;
    for (const [x, z, hotspot] of [
      [TRADING_FLOOR_MONITOR.x, kioskZ, 'monitor'],
      [TRADING_FLOOR_DOOR.x, TRADING_FLOOR_DOOR_APPROACH_Z, 'door'],
    ] as const) {
      let nearestX = 0, nearestZ = 0, nearest = Infinity;
      for (const cell of reachable) {
        const [cx, cz] = cell.split(',').map(Number) as [number, number];
        const distance = Math.hypot(cx - x, cz - z);
        if (distance < nearest) { nearest = distance; nearestX = cx; nearestZ = cz; }
      }
      expect(nearest).toBeLessThanOrEqual(STEP);
      const out = { x: 0, z: 0 };
      clampTradingFloorMovement2D(nearestX, nearestZ, x, z, out);
      expect(out).toEqual({ x, z });
      const arming = createTradingFloorArming();
      computeTradingFloorArming(out.x, out.z, arming);
      expect(hotspot === 'monitor' ? arming.monitorArmed : arming.doorArmed).toBe(true);
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


describe('Trading Floor camera - spring arm', () => {
  test('all legal floor poses keep the camera behind, on the ray and outside blockers', () => {
    const camera = { x: 0, y: 0, z: 0 };
    let poses = 0, inversions = 0, inside = 0, envelopeErrors = 0, armErrors = 0;
    let maxViewError = 0, maxRayError = 0;
    // XZ view heading is the WASD basis. Pitch and boom intentionally affect Y.
    for (let x = -TRADING_FLOOR_SIDE_APPROACH_X; x <= TRADING_FLOOR_SIDE_APPROACH_X; x += 20)
      for (let z = TRADING_FLOOR_BOARD_APPROACH_Z; z <= TRADING_FLOOR_DOOR_APPROACH_Z; z += 20) {
        if (tradingFloorHitsSolid(x, z)) continue;
        for (let deg = 0; deg < 360; deg += 3) {
          const yaw = deg * Math.PI / 180, fx = Math.sin(yaw), fz = -Math.cos(yaw);
          for (const pitch of [TRADING_FLOOR_CAMERA.pitchMin, 0, TRADING_FLOOR_CAMERA.pitchMax]) {
            const arm = placeTradingFloorChaseCamera(x, z, yaw, pitch, camera);
            poses++;
            if (arm < 0 || arm > TRADING_FLOOR_CAMERA.behind) armErrors++;
            const bx = x - camera.x, bz = z - camera.z;
            if (bx * fx + bz * fz < -1e-8) inversions++;
            maxRayError = Math.max(maxRayError, Math.abs(bx * fz - bz * fx));
            const vx = bx + fx * TRADING_FLOOR_CAMERA.lookAhead;
            const vz = bz + fz * TRADING_FLOOR_CAMERA.lookAhead;
            const error = Math.acos(Math.max(-1, Math.min(1,
              (vx * fx + vz * fz) / Math.hypot(vx, vz)))) * 180 / Math.PI;
            maxViewError = Math.max(maxViewError, error);
            const w = TRADING_FLOOR_CAMERA_BOUNDS;
            if (Math.abs(camera.x) > w.halfX - w.margin + 1e-8 ||
                camera.z < w.zMin + w.margin - 1e-8 || camera.z > w.zMax - w.margin + 1e-8 ||
                camera.y < TRADING_FLOOR_CAMERA.above + TRADING_FLOOR_CAMERA.pitchMin ||
                camera.y > TRADING_FLOOR_ROOM.height - TRADING_FLOOR_CAMERA_SOLID_CLEARANCE) envelopeErrors++;
            const solids = camera.y < TRADING_FLOOR_CLAW_EXTENTS.topY + TRADING_FLOOR_CAMERA_SOLID_CLEARANCE ?
              TRADING_FLOOR_CAMERA_SOLIDS_LOW : TRADING_FLOOR_CAMERA_SOLIDS_HIGH;
            for (const solid of solids) if (
              Math.abs(camera.x - solid.centerX) < solid.halfX + TRADING_FLOOR_CAMERA_SOLID_CLEARANCE &&
              Math.abs(camera.z - solid.centerZ) < solid.halfZ + TRADING_FLOOR_CAMERA_SOLID_CLEARANCE) inside++;
          }
        }
      }
    console.log(`spring-arm sweep: poses=${poses}, inversions=${inversions}, max view error=${maxViewError.toFixed(6)} deg, camera-in-solid=${inside}`);
    expect(poses).toBeGreaterThan(1_000_000);
    expect(inversions).toBe(0);
    expect(inside).toBe(0);
    expect(armErrors).toBe(0);
    expect(envelopeErrors).toBe(0);
    expect(maxViewError).toBeLessThanOrEqual(2);
    expect(maxRayError).toBeLessThan(1e-8);
  }, 30_000);

  test('arm shrink is immediate and extension is monotonic and never exceeds raw', () => {
    let arm: number = TRADING_FLOOR_CAMERA.behind;
    const short = TRADING_FLOOR_PLAYER_RADIUS;
    arm = smoothTradingFloorCameraArm(arm, short, FRAME_SECONDS);
    expect(arm).toBe(short);
    for (let frame = 0; frame < 300; frame++) {
      const previous = arm;
      arm = smoothTradingFloorCameraArm(arm, TRADING_FLOOR_CAMERA.behind, FRAME_SECONDS);
      expect(arm).toBeGreaterThanOrEqual(previous);
      expect(arm).toBeLessThanOrEqual(TRADING_FLOOR_CAMERA.behind);
    }
    expect(smoothTradingFloorCameraArm(arm, short, FRAME_SECONDS, true)).toBe(short);
  });

  test('shorter drawn arms use the same ray, boom and safe solids', () => {
    const cam = { x: 0, y: 0, z: 0 };
    for (const seat of TRADING_FLOOR_SEATS) for (let deg = 0; deg < 360; deg += 3)
      for (const pitch of [TRADING_FLOOR_CAMERA.pitchMin, 0, TRADING_FLOOR_CAMERA.pitchMax]) {
        const yaw = deg * Math.PI / 180;
        const raw = placeTradingFloorChaseCamera(seat.x, seat.z, yaw, pitch, cam);
        for (const length of [0, raw / 2, raw]) {
          expect(placeTradingFloorChaseCamera(seat.x, seat.z, yaw, pitch, cam, length)).toBe(raw);
          expect(Math.hypot(cam.x - seat.x, cam.z - seat.z)).toBeCloseTo(length, 6);
          const solids = cam.y < TRADING_FLOOR_CLAW_EXTENTS.topY + TRADING_FLOOR_CAMERA_SOLID_CLEARANCE ?
            TRADING_FLOOR_CAMERA_SOLIDS_LOW : TRADING_FLOOR_CAMERA_SOLIDS_HIGH;
          expect(solids.some((s) => Math.abs(cam.x - s.centerX) < s.halfX + TRADING_FLOOR_CAMERA_SOLID_CLEARANCE &&
            Math.abs(cam.z - s.centerZ) < s.halfZ + TRADING_FLOOR_CAMERA_SOLID_CLEARANCE)).toBe(false);
        }
      }
  });

  test('origin inset keeps a snapped body on an envelope plane safe', () => {
    const cam = { x: 0, y: 0, z: 0 };
    placeTradingFloorChaseCamera(TRADING_FLOOR_DESK_INNER_X, TRADING_FLOOR_DOOR_APPROACH_Z,
      -Math.PI / 2, 0, cam, 0);
    expect(cam.x).toBe(TRADING_FLOOR_DESK_INNER_X - TRADING_FLOOR_CAMERA_ARM.originInset);
  });

  test('controller feedback preserves held-key direction at side gaps and behind the plinth', () => {
    let maxHeadingStep = 0, maxMoveStep = 0, maxFullViewStep = 0;
    const dais = TRADING_FLOOR_SOLIDS[TRADING_FLOOR_CONSOLE_ROW.length]!;
    const gapZ = (TRADING_FLOOR_CONSOLE_ROW[0]!.z + TRADING_FLOOR_CONSOLE_ROW[1]!.z) / 2;
    const trials = [
      ...[-1, 1].flatMap((sign) => ['s', 'w'].map((key) => ({
        x: sign * TRADING_FLOOR_SIDE_APPROACH_X, z: gapZ,
        yaw: -sign * Math.PI / 2, keys: [key] as string[],
      }))),
      { x: -dais.halfX - TRADING_FLOOR_PLAYER_RADIUS, z: dais.centerZ - dais.halfZ - TRADING_FLOOR_PLAYER_RADIUS,
        yaw: 0, keys: ['a', 'd'] },
    ];
    try {
      for (const trial of trials) {
        const position = { x: trial.x, z: trial.z };
        const camera = new THREE.PerspectiveCamera();
        const scratch = new THREE.Vector3(), look = new THREE.Vector3(), direction = new THREE.Vector3();
        const previousDirection = new THREE.Vector3();
        let arm: number = TRADING_FLOOR_CAMERA.behind;
        const draw = (snap: boolean) => {
          const raw = placeTradingFloorChaseCamera(position.x, position.z, trial.yaw, 0, scratch);
          arm = smoothTradingFloorCameraArm(arm, raw, FRAME_SECONDS, snap);
          placeTradingFloorChaseCamera(position.x, position.z, trial.yaw, 0, scratch, arm);
          camera.position.copy(scratch);
          look.set(position.x + Math.sin(trial.yaw) * TRADING_FLOOR_CAMERA.lookAhead,
            TRADING_FLOOR_CAMERA.lookY, position.z - Math.cos(trial.yaw) * TRADING_FLOOR_CAMERA.lookAhead);
          camera.lookAt(look); camera.updateMatrixWorld(true);
          camera.getWorldDirection(direction);
          return Math.atan2(direction.x, -direction.z);
        };
        let previousHeading = draw(true), previousMove = 0, frameInKey = 0;
        previousDirection.copy(direction);
        const config: PlayerCapabilityControllerConfig = {
          sceneId: 'trading-floor', capabilities: DEFAULT_PLAYER_CAPABILITIES,
          motion: TRADING_FLOOR_POLICY.motion, input: TRADING_FLOOR_POLICY.input,
          isDriving: () => true,
          space: {
            speedPerSec: TRADING_FLOOR_PLAYER_SPEED_WU_PER_SEC,
            readPosition: (out) => { out.x = position.x; out.z = position.z; },
            clampMovement: (px, pz, x, z, out) => { clampTradingFloorMovement2D(px, pz, x, z, out); out.groundY = 0; },
            commitPosition: (result) => { position.x = result.x; position.z = result.z; },
          },
          onAfterMove: (state) => {
            const heading = draw(false);
            maxFullViewStep = Math.max(maxFullViewStep, previousDirection.angleTo(direction) * 180 / Math.PI);
            previousDirection.copy(direction);
            maxHeadingStep = Math.max(maxHeadingStep, Math.abs(wrapTradingFloorAngle(heading - previousHeading)) * 180 / Math.PI);
            previousHeading = heading;
            const move = Math.atan2(state.intent.move.worldVx, state.intent.move.worldVz);
            if (frameInKey > 0) maxMoveStep = Math.max(maxMoveStep,
              Math.abs(wrapTradingFloorAngle(move - previousMove)) * 180 / Math.PI);
            previousMove = move;
          },
        };
        const runtime = createPlayerControllerTestRuntime(config.motion);
        const root = { camera, clock: { elapsedTime: 0 } } as RootState;
        for (const key of trial.keys) {
          resetPlayerKeys();
          playerKeyState[key as 'w' | 's' | 'a' | 'd'] = true;
          for (frameInKey = 0; frameInKey < 180; frameInKey++)
            runPlayerControllerFrameForTests(config, runtime, root, FRAME_SECONDS);
        }
      }
    } finally { resetPlayerKeys(); }
    console.log(`spring-arm controller: max horizontal view step=${maxHeadingStep.toFixed(6)} deg, max held-key direction step=${maxMoveStep.toFixed(6)} deg, max full 3D view step=${maxFullViewStep.toFixed(6)} deg`);
    expect(maxHeadingStep).toBeLessThanOrEqual(0.5);
    expect(maxMoveStep).toBeLessThanOrEqual(90);
  });
});
