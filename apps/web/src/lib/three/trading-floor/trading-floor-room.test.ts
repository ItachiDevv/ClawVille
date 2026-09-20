import { describe, expect, test } from 'bun:test';
import {
  clampTradingFloorMovement2D,
  consoleHalfExtents,
  nearestTradingFloorSeat,
  tradingFloorDistanceSq,
  tradingFloorHitsSolid,
  TRADING_FLOOR_CAMERA,
  TRADING_FLOOR_CAMERA_FAR,
  TRADING_FLOOR_CONSOLE_HALF_X,
  TRADING_FLOOR_CONSOLE_HALF_Z,
  TRADING_FLOOR_CONSOLE_ROW,
  TRADING_FLOOR_DOOR,
  TRADING_FLOOR_FOG,
  TRADING_FLOOR_MONITOR,
  TRADING_FLOOR_PLAYER_RADIUS,
  TRADING_FLOOR_PLAYER_SPAWN,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_ROOM_DIAGONAL_WU,
  TRADING_FLOOR_CHAIR_OFFSET,
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
  const maxX = TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_PLAYER_RADIUS;
  const maxZ = TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS;
  let best = Number.POSITIVE_INFINITY;
  for (let x = -maxX; x <= maxX; x += 5) {
    for (let z = -maxZ; z <= maxZ; z += 5) {
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
      TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_PLAYER_RADIUS,
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
      TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_PLAYER_RADIUS,
    );
    expect(out.z).toBeLessThanOrEqual(
      TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS,
    );
    clampTradingFloorMovement2D(0, 0, -99_999, -99_999, out);
    expect(out.x).toBeGreaterThanOrEqual(
      -(TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_PLAYER_RADIUS),
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
    expect(TRADING_FLOOR_CONSOLE_ROW.length).toBe(6);
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
        TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_PLAYER_RADIUS,
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

  // This change adds NO sit clip, so the avatar holds its idle pose. Drawing it
  // at the chair's own origin put a 270 wu standing VRM through the seat pan,
  // the backrest and both armrests. The chair therefore sits BEHIND the
  // standing position, and the gap has to clear the chair's half-width plus the
  // player radius or the defect comes straight back.
  test('the chair stands clear of the avatar, further from the desk', () => {
    const CHAIR_HALF_WIDTH = 64;
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

  // The monitor has to be REACHABLE, not merely present. The holo dais sits
  // dead centre between the door and the monitor, so a straight walk is blocked
  // by design — but there must be a clear lane around it, or the venue's whole
  // point is unreachable on foot.
  test('a clear lane runs from the spawn to the monitor around the dais', () => {
    const straightBlocked = (() => {
      for (let z = TRADING_FLOOR_PLAYER_SPAWN.z; z >= TRADING_FLOOR_MONITOR.z; z -= 10) {
        if (tradingFloorHitsSolid(0, z)) return true;
      }
      return false;
    })();
    expect(straightBlocked).toBe(true);

    // Sweep every lane between the dais and the desk row for one that is clear
    // over the whole approach, then prove the end of it arms the monitor.
    const clearLanes: number[] = [];
    for (let x = 0; x <= TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_PLAYER_RADIUS; x += 10) {
      let clear = true;
      for (let z = TRADING_FLOOR_PLAYER_SPAWN.z; z >= TRADING_FLOOR_MONITOR.z; z -= 10) {
        if (tradingFloorHitsSolid(x, z)) { clear = false; break; }
      }
      if (clear) clearLanes.push(x);
    }
    expect(clearLanes.length).toBeGreaterThan(0);

    // Walking in down the nearest clear lane, then across, reaches the monitor's
    // interact radius.
    const lane = clearLanes[0]!;
    let best = Number.POSITIVE_INFINITY;
    for (let x = lane; x >= -lane; x -= 10) {
      if (tradingFloorHitsSolid(x, TRADING_FLOOR_MONITOR.z + 200)) continue;
      best = Math.min(
        best,
        tradingFloorDistanceSq(
          x,
          TRADING_FLOOR_MONITOR.z + 200,
          TRADING_FLOOR_MONITOR.x,
          TRADING_FLOOR_MONITOR.z,
        ),
      );
    }
    expect(best).toBeLessThan(
      TRADING_FLOOR_MONITOR.interactRadius * TRADING_FLOOR_MONITOR.interactRadius,
    );
  });
});
