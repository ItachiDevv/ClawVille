import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import {
  clampTradingFloorMovement2D,
  consoleHalfExtents,
  nearestTradingFloorSeat,
  tradingFloorDistanceSq,
  tradingFloorHitsSolid,
  TRADING_FLOOR_CAMERA,
  TRADING_FLOOR_CAMERA_Z_MIN,
  TRADING_FLOOR_CAMERA_Z_MAX,
  TRADING_FLOOR_CAMERA_SOLID_CLEARANCE,
  TRADING_FLOOR_CAMERA_SOLIDS_HIGH,
  TRADING_FLOOR_CAMERA_SOLIDS_LOW,
  TRADING_FLOOR_CAMERA_KIOSK_SOLID,
  TRADING_FLOOR_CAMERA_CLAW_SOLID,
  TRADING_FLOOR_DESK_SOLIDS,
  TRADING_FLOOR_DAIS_SOLID,
  TRADING_FLOOR_KIOSK_SOLID,
  TRADING_FLOOR_PILLAR_SOLIDS,
  computeTradingFloorArming,
  createTradingFloorArming,
  TRADING_FLOOR_SIDE_APPROACH_X,
  TRADING_FLOOR_BOARD_APPROACH_Z,
  TRADING_FLOOR_DOOR_APPROACH_Z,
  TRADING_FLOOR_CAMERA_FAR,
  TRADING_FLOOR_CONSOLE_HALF_X,
  TRADING_FLOOR_CONSOLE_HALF_Z,
  TRADING_FLOOR_CONSOLE_ROW,
  TRADING_FLOOR_DOOR,
  TRADING_FLOOR_FOG,
  TRADING_FLOOR_MONITOR,
  TRADING_FLOOR_MONITOR_FRONT_Z,
  TRADING_FLOOR_PLAYER_RADIUS,
  TRADING_FLOOR_PLAYER_SPAWN,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_ROOM_DIAGONAL_WU,
  TRADING_FLOOR_CHAIR_OFFSET,
  TRADING_FLOOR_CHAIR_HALF_X,
  TRADING_FLOOR_CHAIR_SEAT_Y,
  TRADING_FLOOR_SCREEN,
  TRADING_FLOOR_SEAT_HINT_RADIUS,
  TRADING_FLOOR_SEAT_INTERACT_RADIUS,
  TRADING_FLOOR_SEAT_OFFSET,
  TRADING_FLOOR_SEATS,
  TRADING_FLOOR_SOLIDS,
} from './trading-floor-room';

/**
 * Walks the interior on a coarse grid and returns the closest reachable point
 * to (targetX, targetZ). "Reachable" = inside the walls and outside every
 * solid, i.e. somewhere the player can actually stand.
 */
function closestStandableDistanceSq(targetX: number, targetZ: number): number {
  const maxX = TRADING_FLOOR_SIDE_APPROACH_X;
  const minZ = TRADING_FLOOR_BOARD_APPROACH_Z, maxZ = TRADING_FLOOR_DOOR_APPROACH_Z;
  let best = Number.POSITIVE_INFINITY;
  for (let x = -maxX; x <= maxX; x += 5) {
    for (let z = minZ; z <= maxZ; z += 5) {
      if (tradingFloorHitsSolid(x, z)) continue;
      const distanceSq = tradingFloorDistanceSq(x, z, targetX, targetZ);
      if (distanceSq < best) best = distanceSq;
    }
  }
  return best;
}

describe('Trading Floor interior — camera far plane', () => {
  // Memory feedback_threejs_far_plane_dark_void: an interior far plane sized
  // against anything smaller than the room's 3D DIAGONAL slices the far wall
  // and reads as a sweeping black void.
  test('camera.far clears the room diagonal with the whole chase arm on top', () => {
    expect(TRADING_FLOOR_CAMERA_FAR).toBeGreaterThan(
      TRADING_FLOOR_ROOM_DIAGONAL_WU +
        TRADING_FLOOR_CAMERA.behind +
        TRADING_FLOOR_CAMERA.above,
    );
  });

  test('the diagonal really is the longest span in the room', () => {
    expect(TRADING_FLOOR_ROOM_DIAGONAL_WU).toBeGreaterThan(
      TRADING_FLOOR_ROOM.halfZ * 2,
    );
    expect(TRADING_FLOOR_ROOM_DIAGONAL_WU).toBeGreaterThan(
      TRADING_FLOOR_ROOM.halfX * 2,
    );
  });

  // Memory performance/fog-density-iris-xe-regression: fog past the far plane
  // is pure wasted fragment work on an Iris Xe.
  test('fog.far never exceeds camera.far', () => {
    expect(TRADING_FLOOR_FOG.far).toBeLessThanOrEqual(TRADING_FLOOR_CAMERA_FAR);
    expect(TRADING_FLOOR_FOG.near).toBeLessThan(TRADING_FLOOR_FOG.far);
  });
});

describe('Trading Floor interior — spawn', () => {
  test('spawns inside the walls', () => {
    expect(Math.abs(TRADING_FLOOR_PLAYER_SPAWN.x)).toBeLessThanOrEqual(
      TRADING_FLOOR_SIDE_APPROACH_X,
    );
    expect(Math.abs(TRADING_FLOOR_PLAYER_SPAWN.z)).toBeLessThanOrEqual(
      TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS,
    );
  });

  test('does not spawn inside a desk or the dais', () => {
    expect(
      tradingFloorHitsSolid(
        TRADING_FLOOR_PLAYER_SPAWN.x,
        TRADING_FLOOR_PLAYER_SPAWN.z,
      ),
    ).toBe(false);
  });

  // Arriving already armed on the door means the first E press walks the
  // player straight back out of the room they just entered.
  test('the exit hotspot is NOT armed on arrival', () => {
    const distanceSq = tradingFloorDistanceSq(
      TRADING_FLOOR_PLAYER_SPAWN.x,
      TRADING_FLOOR_PLAYER_SPAWN.z,
      TRADING_FLOOR_DOOR.x,
      TRADING_FLOOR_DOOR.z,
    );
    expect(distanceSq).toBeGreaterThan(
      TRADING_FLOOR_DOOR.interactRadius * TRADING_FLOOR_DOOR.interactRadius,
    );
  });

  test('the monitor hotspot is NOT armed on arrival', () => {
    const distanceSq = tradingFloorDistanceSq(
      TRADING_FLOOR_PLAYER_SPAWN.x,
      TRADING_FLOOR_PLAYER_SPAWN.z,
      TRADING_FLOOR_MONITOR.x,
      TRADING_FLOOR_MONITOR.z,
    );
    expect(distanceSq).toBeGreaterThan(
      TRADING_FLOOR_MONITOR.interactRadius *
        TRADING_FLOOR_MONITOR.interactRadius,
    );
  });
});

describe('Trading Floor interior — hotspots are reachable on foot', () => {
  // The dais is solid, so the player can never stand ON the monitor. What
  // matters is that the closest point they CAN stand on still arms it.
  test('walking to the monitor arms it', () => {
    expect(
      closestStandableDistanceSq(TRADING_FLOOR_MONITOR.x, TRADING_FLOOR_MONITOR.z),
    ).toBeLessThan(
      TRADING_FLOOR_MONITOR.interactRadius *
        TRADING_FLOOR_MONITOR.interactRadius,
    );
  });

  test('walking to the door arms it', () => {
    expect(
      closestStandableDistanceSq(TRADING_FLOOR_DOOR.x, TRADING_FLOOR_DOOR.z),
    ).toBeLessThan(
      TRADING_FLOOR_DOOR.interactRadius * TRADING_FLOOR_DOOR.interactRadius,
    );
  });

  test('the two interact bands never overlap, so E is never ambiguous', () => {
    const separation = Math.hypot(
      TRADING_FLOOR_MONITOR.x - TRADING_FLOOR_DOOR.x,
      TRADING_FLOOR_MONITOR.z - TRADING_FLOOR_DOOR.z,
    );
    expect(separation).toBeGreaterThan(
      TRADING_FLOOR_MONITOR.interactRadius + TRADING_FLOOR_DOOR.interactRadius,
    );
  });

  test('the doorway opening is wide enough to walk through', () => {
    expect(TRADING_FLOOR_DOOR.width).toBeGreaterThan(
      TRADING_FLOOR_PLAYER_RADIUS * 2,
    );
  });
});

describe('Trading Floor interior — movement clamp', () => {
  const out = { x: 0, z: 0 };

  test('never lets the player leave the room', () => {
    clampTradingFloorMovement2D(0, 0, 99_999, 99_999, out);
    expect(out.x).toBeLessThanOrEqual(
      TRADING_FLOOR_SIDE_APPROACH_X,
    );
    expect(out.z).toBeLessThanOrEqual(
      TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS,
    );
    clampTradingFloorMovement2D(0, 0, -99_999, -99_999, out);
    expect(out.x).toBeGreaterThanOrEqual(
      -(TRADING_FLOOR_SIDE_APPROACH_X),
    );
    expect(out.z).toBeGreaterThanOrEqual(
      -(TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS),
    );
  });

  test('rejects a step into a console but keeps the free axis', () => {
    // The desk nearest the door — far enough from the holo dais that the aisle
    // start point is genuinely clear, so this tests the desk and nothing else.
    const desk = [...TRADING_FLOOR_CONSOLE_ROW].sort((a, b) => b.z - a.z)[0]!;
    const startX = 0;
    const startZ = desk.z;
    expect(tradingFloorHitsSolid(startX, startZ)).toBe(false);
    clampTradingFloorMovement2D(startX, startZ, desk.x, startZ, out);
    expect(tradingFloorHitsSolid(out.x, out.z)).toBe(false);
    // Sliding along +Z while pressed against it still moves.
    clampTradingFloorMovement2D(startX, startZ, desk.x, startZ + 40, out);
    expect(out.z).toBeGreaterThan(startZ);
  });

  // The renderer composes its instance matrices from TRADING_FLOOR_CONSOLE_ROW
  // and the collider list is derived from the same array. If those ever come
  // apart, a desk is drawn where the player can walk through it — the
  // world/collision decoupling that land and cove exist to prevent.
  //
  // v2 makes this sharper: the desks are yawed ±π/2 against the side walls, so
  // the collider half-extents are the AXIS-SWAPPED footprint. The previous
  // revision hard-coded them and warned in a comment that a ±π/2 yaw "would
  // silently make every collider wrong" — this pins the derivation instead.
  test('every rendered console has a collider with its ROTATED footprint', () => {
    for (const slot of TRADING_FLOOR_CONSOLE_ROW) {
      const match = TRADING_FLOOR_SOLIDS.find(
        (solid) => solid.centerX === slot.x && solid.centerZ === slot.z,
      );
      expect(match).toBeDefined();
      const expected = consoleHalfExtents(slot.rotY);
      expect(match!.halfX).toBeCloseTo(expected.halfX, 4);
      expect(match!.halfZ).toBeCloseTo(expected.halfZ, 4);
      // The authored console is 364 (X) × 270 (Z). Rotated a quarter turn, the
      // footprint has to be 270 × 364 — not the unrotated numbers.
      expect(match!.halfX).toBeCloseTo(TRADING_FLOOR_CONSOLE_HALF_Z, 4);
      expect(match!.halfZ).toBeCloseTo(TRADING_FLOOR_CONSOLE_HALF_X, 4);
    }
  });

  test('consoleHalfExtents swaps the axes at a quarter turn and not at zero', () => {
    expect(consoleHalfExtents(0)).toEqual({
      halfX: TRADING_FLOOR_CONSOLE_HALF_X,
      halfZ: TRADING_FLOOR_CONSOLE_HALF_Z,
    });
    expect(consoleHalfExtents(Math.PI)).toEqual({
      halfX: TRADING_FLOOR_CONSOLE_HALF_X,
      halfZ: TRADING_FLOOR_CONSOLE_HALF_Z,
    });
    for (const rotY of [Math.PI / 2, -Math.PI / 2]) {
      const extents = consoleHalfExtents(rotY);
      expect(extents.halfX).toBeCloseTo(TRADING_FLOOR_CONSOLE_HALF_Z, 4);
      expect(extents.halfZ).toBeCloseTo(TRADING_FLOOR_CONSOLE_HALF_X, 4);
    }
  });

  test('the desk row lines the SIDE walls and faces the aisle', () => {
    expect(TRADING_FLOOR_CONSOLE_ROW.length).toBe(TRADING_FLOOR_SEATS.length);
    for (const slot of TRADING_FLOOR_CONSOLE_ROW) {
      const { halfX, halfZ } = consoleHalfExtents(slot.rotY);
      // Against the wall: the desk's outer face is within a pilaster depth of
      // the wall plane.
      expect(Math.abs(slot.x) + halfX).toBeLessThanOrEqual(
        TRADING_FLOOR_ROOM.halfX,
      );
      expect(TRADING_FLOOR_ROOM.halfX - (Math.abs(slot.x) + halfX)).toBeLessThanOrEqual(
        45,
      );
      // Still leaves the central aisle walkable.
      expect(Math.abs(slot.x) - halfX).toBeGreaterThan(
        TRADING_FLOOR_PLAYER_RADIUS,
      );
      // The authored console faces +Z, and a model's forward at yaw θ is
      // (sin θ, 0, cos θ). A desk on the -X wall must therefore face +X and one
      // on the +X wall must face -X, or the player walks up to a blank back.
      const facingX = Math.sin(slot.rotY);
      expect(Math.sign(facingX)).toBe(slot.x < 0 ? 1 : -1);
      expect(Math.abs(facingX)).toBeCloseTo(1, 6);
      expect(halfZ).toBeCloseTo(TRADING_FLOOR_CONSOLE_HALF_X, 4);
    }
    // No two desks on the same side overlap.
    for (const a of TRADING_FLOOR_CONSOLE_ROW) {
      for (const b of TRADING_FLOOR_CONSOLE_ROW) {
        if (a === b || a.x !== b.x) continue;
        expect(Math.abs(a.z - b.z)).toBeGreaterThan(
          consoleHalfExtents(a.rotY).halfZ * 2,
        );
      }
    }
  });

  test('every GLB prop AABB sits inside the hall', () => {
    for (const solid of TRADING_FLOOR_SOLIDS) {
      expect(Math.abs(solid.centerX) + solid.halfX).toBeLessThanOrEqual(
        TRADING_FLOOR_ROOM.halfX,
      );
      expect(Math.abs(solid.centerZ) + solid.halfZ).toBeLessThanOrEqual(
        TRADING_FLOOR_ROOM.halfZ,
      );
    }
  });

  // The whole point of the seats: an agent or a player can WALK to one and sit
  // at it. A seat inside a solid is a seat nobody can occupy, and a seat outside
  // the walls is a seat outside the room.
  test('every seat is outside every solid and inside the room', () => {
    expect(TRADING_FLOOR_SEATS.length).toBe(TRADING_FLOOR_CONSOLE_ROW.length);
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

  test('every seat sits on the AISLE side of its own desk, looking back at it', () => {
    for (const seat of TRADING_FLOOR_SEATS) {
      const desk = TRADING_FLOOR_CONSOLE_ROW[seat.index]!;
      // On the desk's facing axis, at exactly the declared offset.
      expect(Math.hypot(seat.x - desk.x, seat.z - desk.z)).toBeCloseTo(
        TRADING_FLOOR_SEAT_OFFSET,
        0,
      );
      // Toward the room's centre line, never into the wall.
      expect(Math.abs(seat.x)).toBeLessThan(Math.abs(desk.x));
      // The occupant looks at the desk: forward at yaw θ is (sin θ, cos θ).
      const toDesk = Math.atan2(desk.x - seat.x, desk.z - seat.z);
      expect(Math.cos(seat.facing - toDesk)).toBeCloseTo(1, 6);
      // The chair prop shares that yaw — the model seats a +Z occupant.
      expect(seat.chairRotY).toBe(seat.facing);
    }
  });

  test('sit points centre the cushion ahead of the backrest; stand points and facing stay unchanged', async () => {
    const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
      .read(join(import.meta.dir, '../../../../public/models/trading-floor/trading-floor-interior-opt1-mo-ktx.glb'));
    const chair = doc.getRoot().listNodes().find((node) => node.getName() === 'TradingFloorChairModule')!;
    const positions = chair.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!;
    const matrix = chair.getWorldMatrix();
    const at = chair.getTranslation();
    const cushion = Array.from({ length: positions.getCount() }, (_, index) => {
      const p = positions.getElement(index, []);
      return [0, 1, 2].map((axis) => matrix[12 + axis]! + matrix[axis]! * p[0]!
        + matrix[4 + axis]! * p[1]! + matrix[8 + axis]! * p[2]! - (axis === 1 ? 0 : at[axis]!));
    }).filter((p) => Math.abs(p[1]! - TRADING_FLOOR_CHAIR_SEAT_Y) < 0.02);
    // R1 must re-measure this decoded cushion vertex count.
    expect(cushion).toHaveLength(16);
    const bounds = [0, 2].map((axis) => ({
      min: Math.min(...cushion.map((p) => p[axis]!)), max: Math.max(...cushion.map((p) => p[axis]!)),
    }));
    expect(TRADING_FLOOR_SEATS.map((seat) => [seat.index, seat.x, seat.z, seat.facing])).toEqual(
      TRADING_FLOOR_CONSOLE_ROW.map((slot, index) => [index,
        Math.round(slot.x + Math.sin(slot.rotY) * TRADING_FLOOR_SEAT_OFFSET),
        Math.round(slot.z + Math.cos(slot.rotY) * TRADING_FLOOR_SEAT_OFFSET),
        Math.sign(slot.x) * Math.PI / 2]),
    );
    const cushionCenterZ = (Math.max(-30, Math.round(bounds[1]!.min)) + Math.round(bounds[1]!.max)) / 2;
    expect(TRADING_FLOOR_SEATS.map((seat) => [seat.sitX, seat.sitZ])).toEqual(
      TRADING_FLOOR_CONSOLE_ROW.map((slot) => {
        const facing = Math.sign(slot.x) * Math.PI / 2;
        return [Math.round(slot.x + Math.sin(slot.rotY) * TRADING_FLOOR_CHAIR_OFFSET) + Math.sin(facing) * cushionCenterZ,
          Math.round(slot.z + Math.cos(slot.rotY) * TRADING_FLOOR_CHAIR_OFFSET) + Math.cos(facing) * cushionCenterZ];
      }),
    );
    for (const seat of TRADING_FLOOR_SEATS) {
      const dx = seat.sitX - seat.chairX, dz = seat.sitZ - seat.chairZ;
      const local = [Math.cos(seat.chairRotY) * dx - Math.sin(seat.chairRotY) * dz,
        Math.sin(seat.chairRotY) * dx + Math.cos(seat.chairRotY) * dz];
      for (const [axis, value] of local.entries()) {
        expect(value).toBeGreaterThan(bounds[axis]!.min);
        expect(value).toBeLessThan(bounds[axis]!.max);
        // The backrest covers local Z through -30; centre only the exposed cushion.
        const frontMin = axis === 1 ? Math.max(-30, bounds[axis]!.min) : bounds[axis]!.min;
        expect(value).toBeCloseTo((frontMin + bounds[axis]!.max) / 2, 3);
      }
      expect(tradingFloorHitsSolid(seat.sitX, seat.sitZ)).toBe(false);
      expect(seat.chairRotY).toBe(seat.facing);
    }
  });

  // This change adds NO sit clip, so the avatar holds its idle pose. Drawing it
  // at the chair's own origin put a 270 wu standing VRM through the seat pan,
  // the backrest and both armrests. The chair therefore sits BEHIND the
  // standing position, and the gap has to clear the chair's half-width plus the
  // player radius or the defect comes straight back.
  test('the chair stands clear of the avatar, further from the desk', () => {
    const CHAIR_HALF_WIDTH = TRADING_FLOOR_CHAIR_HALF_X;
    for (const seat of TRADING_FLOOR_SEATS) {
      const desk = TRADING_FLOOR_CONSOLE_ROW[seat.index]!;
      expect(Math.hypot(seat.chairX - desk.x, seat.chairZ - desk.z)).toBeCloseTo(
        TRADING_FLOOR_CHAIR_OFFSET,
        0,
      );
      // Further from the desk than the avatar, i.e. behind it.
      expect(TRADING_FLOOR_CHAIR_OFFSET).toBeGreaterThan(TRADING_FLOOR_SEAT_OFFSET);
      // And far enough that the two volumes never intersect.
      expect(Math.hypot(seat.chairX - seat.x, seat.chairZ - seat.z)).toBeGreaterThan(
        CHAIR_HALF_WIDTH + TRADING_FLOOR_PLAYER_RADIUS,
      );
      // The chair is still inside the hall.
      expect(Math.abs(seat.chairX) + CHAIR_HALF_WIDTH).toBeLessThan(
        TRADING_FLOOR_ROOM.halfX,
      );
    }
  });

  // The floor under the offset: anything at or inside desk half-depth + player
  // radius is inside the desk's own collider and could never be stood on.
  test('the seat offset clears the desk collider it is derived from', () => {
    for (const slot of TRADING_FLOOR_CONSOLE_ROW) {
      const { halfZ } = consoleHalfExtents(slot.rotY);
      // halfZ is the desk's extent ALONG its facing axis after the quarter turn.
      expect(TRADING_FLOOR_SEAT_OFFSET).toBeGreaterThan(
        consoleHalfExtents(slot.rotY).halfX + TRADING_FLOOR_PLAYER_RADIUS,
      );
      expect(halfZ).toBeGreaterThan(0);
    }
  });

  test('two seats can never be armed at once', () => {
    for (const a of TRADING_FLOOR_SEATS) {
      for (const b of TRADING_FLOOR_SEATS) {
        if (a.index === b.index) continue;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(
          TRADING_FLOOR_SEAT_INTERACT_RADIUS * 2,
        );
      }
    }
    expect(TRADING_FLOOR_SEAT_HINT_RADIUS).toBeGreaterThan(
      TRADING_FLOOR_SEAT_INTERACT_RADIUS,
    );
  });

  test('nearestTradingFloorSeat returns the seat you are standing on', () => {
    const out = { index: -1, distanceSq: 0 };
    for (const seat of TRADING_FLOOR_SEATS) {
      nearestTradingFloorSeat(seat.x, seat.z, out);
      expect(out.index).toBe(seat.index);
      expect(out.distanceSq).toBe(0);
    }
    // Dead centre of the hall is inside no seat's arm band.
    nearestTradingFloorSeat(0, 800, out);
    expect(out.distanceSq).toBeGreaterThan(
      TRADING_FLOOR_SEAT_INTERACT_RADIUS * TRADING_FLOOR_SEAT_INTERACT_RADIUS,
    );
  });

  test('the spawn arms no seat, so arrival does not offer a chair', () => {
    const out = { index: -1, distanceSq: 0 };
    nearestTradingFloorSeat(
      TRADING_FLOOR_PLAYER_SPAWN.x,
      TRADING_FLOOR_PLAYER_SPAWN.z,
      out,
    );
    expect(out.distanceSq).toBeGreaterThan(
      TRADING_FLOOR_SEAT_INTERACT_RADIUS * TRADING_FLOOR_SEAT_INTERACT_RADIUS,
    );
  });

  test('the big board fits the back wall and clears the ceiling', () => {
    expect(TRADING_FLOOR_SCREEN.width / 2).toBeLessThan(TRADING_FLOOR_ROOM.halfX);
    expect(
      TRADING_FLOOR_SCREEN.bottomY + TRADING_FLOOR_SCREEN.height,
    ).toBeLessThan(TRADING_FLOOR_ROOM.height);
    // Bottom sits above the desks so the row never crosses the board.
    expect(TRADING_FLOOR_SCREEN.bottomY).toBeGreaterThan(200);
    // Inside the room, in front of the wall plane.
    expect(TRADING_FLOOR_SCREEN.z).toBeGreaterThan(-TRADING_FLOOR_ROOM.halfZ);
    expect(TRADING_FLOOR_SCREEN.centerY).toBe(
      TRADING_FLOOR_SCREEN.bottomY + TRADING_FLOOR_SCREEN.height / 2,
    );
    // The canvas aspect must track the plane's or the board renders stretched.
    expect(
      TRADING_FLOOR_SCREEN.canvasWidth / TRADING_FLOOR_SCREEN.canvasHeight,
    ).toBeCloseTo(TRADING_FLOOR_SCREEN.width / TRADING_FLOOR_SCREEN.height, 2);
  });

  test('a straight walk from spawn to the kiosk face touches no solid and arms it', () => {
    const approachX = TRADING_FLOOR_MONITOR.x;
    const approachZ = TRADING_FLOOR_MONITOR_FRONT_Z - TRADING_FLOOR_PLAYER_RADIUS - 20;
    for (let step = 0; step <= 200; step++) {
      const t = step / 200;
      const x = TRADING_FLOOR_PLAYER_SPAWN.x + (approachX - TRADING_FLOOR_PLAYER_SPAWN.x) * t;
      const z = TRADING_FLOOR_PLAYER_SPAWN.z + (approachZ - TRADING_FLOOR_PLAYER_SPAWN.z) * t;
      expect(tradingFloorHitsSolid(x, z)).toBe(false);
      expect(Math.abs(x)).toBeLessThanOrEqual(TRADING_FLOOR_SIDE_APPROACH_X);
      expect(z).toBeLessThanOrEqual(TRADING_FLOOR_DOOR_APPROACH_Z);
    }
    const arming = createTradingFloorArming();
    computeTradingFloorArming(approachX, approachZ, arming);
    expect(arming.monitorArmed).toBe(true);
  });
});

describe('Trading Floor camera blockers - named parts', () => {
  test('HIGH contains desks, pillars and the extended kiosk; LOW adds only claws', () => {
    expect(TRADING_FLOOR_CAMERA_SOLIDS_HIGH).toEqual([
      ...TRADING_FLOOR_DESK_SOLIDS, ...TRADING_FLOOR_PILLAR_SOLIDS,
      TRADING_FLOOR_CAMERA_KIOSK_SOLID,
    ]);
    expect(TRADING_FLOOR_CAMERA_SOLIDS_LOW).toEqual([
      ...TRADING_FLOOR_CAMERA_SOLIDS_HIGH, TRADING_FLOOR_CAMERA_CLAW_SOLID,
    ]);
    for (const list of [TRADING_FLOOR_CAMERA_SOLIDS_HIGH, TRADING_FLOOR_CAMERA_SOLIDS_LOW]) {
      expect(list).not.toContain(TRADING_FLOOR_DAIS_SOLID);
      expect(list).not.toContain(TRADING_FLOOR_KIOSK_SOLID);
    }
    expect(TRADING_FLOOR_DESK_SOLIDS).toHaveLength(TRADING_FLOOR_CONSOLE_ROW.length);
    expect(TRADING_FLOOR_PILLAR_SOLIDS).toHaveLength(4);
  });

  test('the extended kiosk remains backed by the door wall after a resize', () => {
    expect(TRADING_FLOOR_MONITOR.z + TRADING_FLOOR_MONITOR.halfZ).toBeGreaterThanOrEqual(
      TRADING_FLOOR_CAMERA_Z_MAX - 2 * TRADING_FLOOR_CAMERA_SOLID_CLEARANCE,
    );
  });

  test('the door approach clamp stops the body before the kiosk and keeps E armed', () => {
    const x = TRADING_FLOOR_MONITOR.x;
    const z = Math.min(TRADING_FLOOR_DOOR_APPROACH_Z,
      TRADING_FLOOR_MONITOR_FRONT_Z - TRADING_FLOOR_PLAYER_RADIUS);
    const out = { x: 0, z: 0 };
    clampTradingFloorMovement2D(x, z - 10, x, z, out);
    expect(out).toEqual({ x, z });
    clampTradingFloorMovement2D(x, z, x, z + 10, out);
    expect(out).toEqual({ x, z });
    expect(z).toBeLessThanOrEqual(TRADING_FLOOR_DOOR_APPROACH_Z);
    expect(tradingFloorHitsSolid(x, z)).toBe(false);
    expect(TRADING_FLOOR_MONITOR.z - z).toBeGreaterThanOrEqual(
      TRADING_FLOOR_MONITOR.halfZ + TRADING_FLOOR_PLAYER_RADIUS);
    const arming = createTradingFloorArming();
    computeTradingFloorArming(out.x, out.z, arming);
    expect(arming.monitorArmed).toBe(true);
  });
});

describe('Trading Floor interior - R3 rope collider and frozen P15 clearance', () => {
  // R5 runs in parallel. Probe its frozen footprints now; reuse them after the lead merges R5.
  const spots = [-2,-1,0,1,2].map((i) => ({ x: i * TRADING_FLOOR_SCREEN.width / 5, z: -1350 }));
  const agents = spots.map(({x,z}) => ({ centerX: x, centerZ: z, halfX: 70, halfZ: 76 }));
  const blockers = [...TRADING_FLOOR_SOLIDS, ...agents.filter((a) =>
    !TRADING_FLOOR_SOLIDS.some((s) => s.centerX === a.centerX && s.centerZ === a.centerZ))];
  const hits = (x: number, z: number) => blockers.some((s) =>
    Math.abs(x - s.centerX) < s.halfX + TRADING_FLOOR_PLAYER_RADIUS &&
    Math.abs(z - s.centerZ) < s.halfZ + TRADING_FLOOR_PLAYER_RADIUS);

  test('one grown dais solid encloses the ring but remains outside both camera lists', () => {
    expect(TRADING_FLOOR_DAIS_SOLID).toEqual({ centerX: 0, centerZ: -90, halfX: 492, halfZ: 488 });
    expect(TRADING_FLOOR_SOLIDS.filter((s) => s === TRADING_FLOOR_DAIS_SOLID)).toHaveLength(1);
    for (const list of [TRADING_FLOOR_CAMERA_SOLIDS_HIGH, TRADING_FLOOR_CAMERA_SOLIDS_LOW])
      expect(list).not.toContain(TRADING_FLOOR_DAIS_SOLID);
    for (const side of [-1,1]) {
      expect(tradingFloorHitsSolid(side * 491, -90)).toBe(true);
      expect(tradingFloorHitsSolid(0, -90 + side * 487)).toBe(true);
    }
    const out = { x: 0, z: 0 }, edge = 492 + TRADING_FLOOR_PLAYER_RADIUS;
    clampTradingFloorMovement2D(edge, -90, edge - 1, -80, out);
    expect(out).toEqual({ x: edge, z: -80 });
  });

  test('body lanes retain 1051 wu at the desks and 604 wu at the house agents', () => {
    const deskFace = Math.min(...TRADING_FLOOR_DESK_SOLIDS.map((s) => Math.abs(s.centerX) - s.halfX));
    expect(deskFace - TRADING_FLOOR_DAIS_SOLID.halfX - 2 * TRADING_FLOOR_PLAYER_RADIUS).toBe(1051);
    const ringBack = TRADING_FLOOR_DAIS_SOLID.centerZ - TRADING_FLOOR_DAIS_SOLID.halfZ;
    for (const agent of agents) {
      const lane = ringBack - (agent.centerZ + agent.halfZ) - 2 * TRADING_FLOOR_PLAYER_RADIUS;
      expect(lane).toBe(604);
      expect(lane).toBeGreaterThanOrEqual(600);
    }
  });

  test('a flood fill from spawn reaches every seat, door, kiosk and P15 walk-up band', () => {
    const step = 20, halfColumns = Math.floor(TRADING_FLOOR_SIDE_APPROACH_X / step);
    const rows = Math.floor((TRADING_FLOOR_DOOR_APPROACH_Z - TRADING_FLOOR_BOARD_APPROACH_Z) / step) + 1;
    const key = (x: number, z: number) => (x / step + halfColumns) * rows +
      (z - TRADING_FLOOR_BOARD_APPROACH_Z) / step;
    const spawn = TRADING_FLOOR_PLAYER_SPAWN;
    expect(hits(spawn.x, spawn.z)).toBe(false);
    const visited = new Set<number>([key(spawn.x, spawn.z)]), queue = [{ x: spawn.x, z: spawn.z }];
    for (let head = 0; head < queue.length; head++) {
      const p = queue[head]!;
      for (const [dx,dz] of [[step,0],[-step,0],[0,step],[0,-step]]) {
        const x = p.x + dx!, z = p.z + dz!;
        if (Math.abs(x) > halfColumns * step || z < TRADING_FLOOR_BOARD_APPROACH_Z ||
            z > TRADING_FLOOR_DOOR_APPROACH_Z || hits(x,z)) continue;
        const cell = key(x,z);
        if (visited.has(cell)) continue;
        visited.add(cell); queue.push({x,z});
      }
    }
    const nearest = (x: number, z: number) => Math.min(...queue.map((p) => Math.hypot(p.x - x, p.z - z)));
    for (const seat of TRADING_FLOOR_SEATS) expect(nearest(seat.x,seat.z)).toBeLessThanOrEqual(step);
    expect(nearest(TRADING_FLOOR_DOOR.x,TRADING_FLOOR_DOOR.z)).toBeLessThanOrEqual(TRADING_FLOOR_DOOR.interactRadius);
    expect(nearest(TRADING_FLOOR_MONITOR.x,TRADING_FLOOR_MONITOR.z)).toBeLessThanOrEqual(TRADING_FLOOR_MONITOR.interactRadius);
    const bands = spots.map(({x,z}) => queue.filter((p) => Math.hypot(p.x - x, p.z - z) <= 250).length);
    for (const count of bands) expect(count).toBeGreaterThan(0);
    console.log(`R3 flood fill: ${queue.length} cells; P15 walk-up bands ${bands.join('/')}; lane 604 wu`);
  });
});
