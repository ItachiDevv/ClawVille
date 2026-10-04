import { describe, expect, test } from 'bun:test';
import { FLOOR_ARENA_TEMPLATES } from '@clawville/shared';
import {
  clampTradingFloorMovement2D,
  placeTradingFloorChaseCamera,
  tradingFloorHitsSolid,
  tradingFloorHouseAgentHidden,
  TRADING_FLOOR_BOARD_APPROACH_Z,
  TRADING_FLOOR_CAMERA,
  TRADING_FLOOR_CAMERA_SOLIDS_HIGH,
  TRADING_FLOOR_CAMERA_SOLIDS_LOW,
  TRADING_FLOOR_DOOR,
  TRADING_FLOOR_DOOR_APPROACH_Z,
  TRADING_FLOOR_HOUSE_AGENT_HALF_X,
  TRADING_FLOOR_HOUSE_AGENT_HALF_Z,
  TRADING_FLOOR_HOUSE_AGENT_HEIGHT,
  TRADING_FLOOR_HOUSE_AGENT_LABEL_Y,
  TRADING_FLOOR_HOUSE_AGENT_SOLIDS,
  TRADING_FLOOR_HOUSE_AGENT_SPOTS,
  TRADING_FLOOR_HOUSE_AGENT_STAGE,
  TRADING_FLOOR_HOUSE_AGENT_WALKUP_RADIUS,
  TRADING_FLOOR_MONITOR,
  TRADING_FLOOR_MONITOR_FRONT_Z,
  TRADING_FLOOR_PLAYER_RADIUS,
  TRADING_FLOOR_PLAYER_SPAWN,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_SCREEN,
  TRADING_FLOOR_SEATS,
  TRADING_FLOOR_SIDE_APPROACH_X,
  TRADING_FLOOR_SOLIDS,
} from './trading-floor-room';

describe('P15 house-agent stage and movement', () => {
  test('one ordered spot per shared template, derived from the board and room', () => {
    expect(TRADING_FLOOR_HOUSE_AGENT_SPOTS).toHaveLength(FLOOR_ARENA_TEMPLATES.length);
    expect(TRADING_FLOOR_HOUSE_AGENT_SPOTS.map((spot) => spot.x)).toEqual([-1020, -510, 0, 510, 1020]);
    expect(TRADING_FLOOR_HOUSE_AGENT_STAGE).toEqual({ minX: -1300, maxX: 1300, minZ: -1470, maxZ: -1100 });
    const stage = TRADING_FLOOR_HOUSE_AGENT_STAGE;
    expect(stage.minZ).toBe(TRADING_FLOOR_BOARD_APPROACH_Z);
    expect(stage.maxX).toBe(TRADING_FLOOR_SCREEN.width / 2 + 25);
    expect(stage.maxZ - stage.minZ).toBe(370);
    expect(stage.minX).toBeGreaterThanOrEqual(-TRADING_FLOOR_ROOM.halfX);
    expect(stage.maxX).toBeLessThanOrEqual(TRADING_FLOOR_ROOM.halfX);
    expect(stage.minZ).toBeGreaterThanOrEqual(-TRADING_FLOOR_ROOM.halfZ);
    expect(stage.maxZ).toBeLessThanOrEqual(TRADING_FLOOR_ROOM.halfZ);
    for (const [index, spot] of TRADING_FLOOR_HOUSE_AGENT_SPOTS.entries()) {
      expect(spot.index).toBe(index);
      expect(spot.x).toBe((index - 2) * TRADING_FLOOR_SCREEN.width / FLOOR_ARENA_TEMPLATES.length);
      expect(spot.z).toBe(-(TRADING_FLOOR_ROOM.halfZ - 300));
      expect(spot.z).toBe(-1350);
      expect(spot.facing).toBe(0);
      expect(spot.x).toBeGreaterThanOrEqual(stage.minX);
      expect(spot.x).toBeLessThanOrEqual(stage.maxX);
      expect(spot.z).toBeGreaterThanOrEqual(stage.minZ);
      expect(spot.z).toBeLessThanOrEqual(stage.maxZ);
      expect(Object.isFrozen(spot)).toBe(true);
    }
    expect(Object.isFrozen(TRADING_FLOOR_HOUSE_AGENT_SPOTS)).toBe(true);
    expect(TRADING_FLOOR_HOUSE_AGENT_WALKUP_RADIUS).toBe(250);
    expect(TRADING_FLOOR_HOUSE_AGENT_HEIGHT).toBe(270);
    expect(TRADING_FLOOR_HOUSE_AGENT_LABEL_Y).toBe(345);
    expect(TRADING_FLOOR_HOUSE_AGENT_HALF_X).toBe(70);
    expect(TRADING_FLOOR_HOUSE_AGENT_HALF_Z).toBe(76);
  });

  test('movement boxes stay in the stage, leave clear lanes, and close the rear strip', () => {
    const stage = TRADING_FLOOR_HOUSE_AGENT_STAGE;
    expect(TRADING_FLOOR_HOUSE_AGENT_SOLIDS).toHaveLength(FLOOR_ARENA_TEMPLATES.length);
    expect(TRADING_FLOOR_SOLIDS.slice(-FLOOR_ARENA_TEMPLATES.length)).toEqual([...TRADING_FLOOR_HOUSE_AGENT_SOLIDS]);
    let minimumGap = Infinity;
    for (const [index, box] of TRADING_FLOOR_HOUSE_AGENT_SOLIDS.entries()) {
      const spot = TRADING_FLOOR_HOUSE_AGENT_SPOTS[index]!;
      expect(box).toEqual({ centerX: spot.x, centerZ: spot.z, halfX: 70, halfZ: 76 });
      expect(Object.isFrozen(box)).toBe(true);
      expect(box.centerX - box.halfX).toBeGreaterThanOrEqual(stage.minX);
      expect(box.centerX + box.halfX).toBeLessThanOrEqual(stage.maxX);
      expect(box.centerZ - box.halfZ).toBeGreaterThanOrEqual(stage.minZ);
      expect(box.centerZ + box.halfZ).toBeLessThanOrEqual(stage.maxZ);
      expect(spot.z - box.halfZ - TRADING_FLOOR_PLAYER_RADIUS).toBeLessThanOrEqual(TRADING_FLOOR_BOARD_APPROACH_Z);
      for (let z = TRADING_FLOOR_BOARD_APPROACH_Z; z <= spot.z; z++) {
        expect(tradingFloorHitsSolid(spot.x, z)).toBe(true);
      }
      for (const other of TRADING_FLOOR_SOLIDS) {
        if (other === box) continue;
        const gapX = Math.abs(box.centerX - other.centerX) - box.halfX - other.halfX;
        const gapZ = Math.abs(box.centerZ - other.centerZ) - box.halfZ - other.halfZ;
        expect(gapX >= 0 || gapZ >= 0).toBe(true);
        const gap = Math.hypot(Math.max(0, gapX), Math.max(0, gapZ));
        minimumGap = Math.min(minimumGap, gap);
        expect(gap).toBeGreaterThanOrEqual(184);
      }
      expect(TRADING_FLOOR_CAMERA_SOLIDS_HIGH).not.toContainEqual(box);
      expect(TRADING_FLOOR_CAMERA_SOLIDS_LOW).not.toContainEqual(box);
    }
    expect(minimumGap).toBe(370);
    const out = { x: 0, z: 0 };
    clampTradingFloorMovement2D(0, -900, 0, -99_999, out);
    expect(out.z).toBe(-900); // The centre agent blocks the former straight board approach.
    const gapX = TRADING_FLOOR_HOUSE_AGENT_SPOTS[3]!.x / 2;
    clampTradingFloorMovement2D(gapX, -900, gapX, -99_999, out);
    expect(out.z).toBe(TRADING_FLOOR_BOARD_APPROACH_Z);
  });

  test('interaction bands stay separate from seats, door, kiosk and other agents', () => {
    let seatDistance = Infinity, doorDistance = Infinity, kioskDistance = Infinity, spotDistance = Infinity;
    for (const spot of TRADING_FLOOR_HOUSE_AGENT_SPOTS) {
      for (const seat of TRADING_FLOOR_SEATS) seatDistance = Math.min(seatDistance, Math.hypot(spot.x - seat.x, spot.z - seat.z));
      doorDistance = Math.min(doorDistance, Math.hypot(spot.x - TRADING_FLOOR_DOOR.x, spot.z - TRADING_FLOOR_DOOR.z));
      kioskDistance = Math.min(kioskDistance, Math.hypot(spot.x - TRADING_FLOOR_MONITOR.x, spot.z - TRADING_FLOOR_MONITOR.z));
      for (const other of TRADING_FLOOR_HOUSE_AGENT_SPOTS) if (other !== spot) {
        spotDistance = Math.min(spotDistance, Math.hypot(spot.x - other.x, spot.z - other.z));
      }
    }
    expect(seatDistance).toBeGreaterThanOrEqual(450);
    expect(seatDistance).toBeCloseTo(647.7075, 3);
    expect(doorDistance).toBeGreaterThanOrEqual(490);
    expect(doorDistance).toBe(3000);
    expect(kioskDistance).toBeGreaterThanOrEqual(630);
    expect(kioskDistance).toBeCloseTo(2920.0685, 3);
    expect(spotDistance).toBeGreaterThanOrEqual(500);
    expect(spotDistance).toBe(510);
    console.log(`P15 bands: seat=${seatDistance.toFixed(1)}, door=${doorDistance}, kiosk=${kioskDistance.toFixed(1)}, agent=${spotDistance}; clear gap=370`);
  });

  test('spawn flood fill reaches every seat, door, kiosk approach and agent walk-up band', () => {
    const step = 20;
    const key = (x: number, z: number) => `${x},${z}`;
    const spawn = TRADING_FLOOR_PLAYER_SPAWN;
    const visited = new Set<string>([key(spawn.x, spawn.z)]);
    const cells: { x: number; z: number }[] = [{ x: spawn.x, z: spawn.z }];
    const out = { x: 0, z: 0 };
    expect(tradingFloorHitsSolid(spawn.x, spawn.z)).toBe(false);
    for (let head = 0; head < cells.length; head++) {
      const cell = cells[head]!;
      for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const x = cell.x + dx!, z = cell.z + dz!;
        if (Math.abs(x) > TRADING_FLOOR_SIDE_APPROACH_X || z < TRADING_FLOOR_BOARD_APPROACH_Z || z > TRADING_FLOOR_DOOR_APPROACH_Z) continue;
        const next = key(x, z);
        if (visited.has(next)) continue;
        clampTradingFloorMovement2D(cell.x, cell.z, x, z, out);
        if (out.x !== x || out.z !== z) continue;
        visited.add(next);
        cells.push({ x, z });
      }
    }
    const nearest = (x: number, z: number) => cells.reduce((distance, cell) =>
      Math.min(distance, Math.hypot(cell.x - x, cell.z - z)), Infinity);
    expect(cells.length).toBeGreaterThan(19_000);
    for (const seat of TRADING_FLOOR_SEATS) {
      expect(nearest(seat.x, seat.z)).toBeLessThanOrEqual(step);
      expect(tradingFloorHitsSolid(seat.x, seat.z)).toBe(false);
    }
    const doorDistance = nearest(TRADING_FLOOR_DOOR.x, TRADING_FLOOR_DOOR.z);
    expect(doorDistance).toBeLessThanOrEqual(TRADING_FLOOR_DOOR.interactRadius);
    expect(doorDistance).toBe(180);
    const kioskApproachZ = TRADING_FLOOR_MONITOR_FRONT_Z - TRADING_FLOOR_PLAYER_RADIUS - 20;
    expect(nearest(TRADING_FLOOR_MONITOR.x, kioskApproachZ)).toBeLessThanOrEqual(step);
    expect(nearest(TRADING_FLOOR_MONITOR.x, TRADING_FLOOR_MONITOR.z)).toBeLessThanOrEqual(380);
    const walkupCells = TRADING_FLOOR_HOUSE_AGENT_SPOTS.map((spot) => {
      expect(nearest(spot.x, spot.z)).toBeLessThanOrEqual(TRADING_FLOOR_HOUSE_AGENT_WALKUP_RADIUS);
      return cells.filter((cell) => Math.hypot(cell.x - spot.x, cell.z - spot.z) <= TRADING_FLOOR_HOUSE_AGENT_WALKUP_RADIUS).length;
    });
    console.log(`P15 flood fill: cells=${cells.length}, door=${doorDistance}, walk-up cells=${walkupCells.join('/')}`);
  });
});

describe('P15 house-agent camera visibility', () => {
  test('spawn heads and label bands project below the board sill at all three pitches', () => {
    const camera = { x: 0, y: 0, z: 0 };
    // Same board-plane viewport test as the asset statue sweep, 1366 x 768.
    function inFrame(yaw: number, px: number, py: number): boolean {
      let fx = TRADING_FLOOR_PLAYER_SPAWN.x + Math.sin(yaw) * TRADING_FLOOR_CAMERA.lookAhead - camera.x;
      let fy = TRADING_FLOOR_CAMERA.lookY - camera.y;
      let fz = TRADING_FLOOR_PLAYER_SPAWN.z - Math.cos(yaw) * TRADING_FLOOR_CAMERA.lookAhead - camera.z;
      const length = Math.hypot(fx, fy, fz);
      fx /= length; fy /= length; fz /= length;
      let rx = -fz, rz = fx;
      const rightLength = Math.hypot(rx, rz);
      rx /= rightLength; rz /= rightLength;
      const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
      const dx = px - camera.x, dy = py - camera.y, dz = TRADING_FLOOR_SCREEN.z - camera.z;
      const depth = dx * fx + dy * fy + dz * fz;
      const tanV = Math.tan(TRADING_FLOOR_CAMERA.fov * Math.PI / 360);
      return depth > 1 && Math.abs((dx * rx + dz * rz) / depth) <= tanV * 1366 / 768 &&
        Math.abs((dx * ux + dy * uy + dz * uz) / depth) <= tanV;
    }
    for (const camY of [140, 260, 410]) {
      let headMax = -Infinity, labelMax = -Infinity;
      const seen = new Set<number>();
      for (let degrees = 0; degrees < 360; degrees += 2) {
        const yaw = degrees * Math.PI / 180;
        placeTradingFloorChaseCamera(TRADING_FLOOR_PLAYER_SPAWN.x, TRADING_FLOOR_PLAYER_SPAWN.z,
          yaw, camY - TRADING_FLOOR_CAMERA.above, camera);
        for (const spot of TRADING_FLOOR_HOUSE_AGENT_SPOTS) {
          for (const [height, halfWidth, halfDepth] of [
            [TRADING_FLOOR_HOUSE_AGENT_HEIGHT, 45, 30],
            [TRADING_FLOOR_HOUSE_AGENT_LABEL_Y - 15, 60, 0],
            [TRADING_FLOOR_HOUSE_AGENT_LABEL_Y + 15, 60, 0],
          ] as const) for (const dx of [-halfWidth, 0, halfWidth]) for (const dz of [-halfDepth, 0, halfDepth]) {
            const x = spot.x + dx, z = spot.z + dz;
            const t = (camera.z - TRADING_FLOOR_SCREEN.z) / (camera.z - z);
            const boardX = camera.x + (x - camera.x) * t;
            const shadowY = camera.y + (height - camera.y) * t;
            expect(shadowY).toBeLessThanOrEqual(TRADING_FLOOR_SCREEN.bottomY - 20);
            if (Math.abs(boardX) > TRADING_FLOOR_SCREEN.width / 2) continue;
            const boardY = Math.max(TRADING_FLOOR_SCREEN.bottomY,
              Math.min(shadowY, TRADING_FLOOR_SCREEN.bottomY + TRADING_FLOOR_SCREEN.height));
            if (!inFrame(yaw, boardX, boardY)) continue;
            seen.add(spot.index);
            if (height === TRADING_FLOOR_HOUSE_AGENT_HEIGHT) headMax = Math.max(headMax, shadowY);
            else labelMax = Math.max(labelMax, shadowY);
          }
        }
      }
      expect(seen.size).toBe(FLOOR_ARENA_TEMPLATES.length);
      expect(headMax).toBeGreaterThan(0);
      expect(labelMax).toBeGreaterThan(headMax);
      expect(labelMax).toBeLessThanOrEqual(520);
      console.log(`P15 spawn camera ${camY}: heads=${headMax.toFixed(1)}, labels=${labelMax.toFixed(1)}, limit=520`);
    }
  });

  test('the hide rule stays false at every spawn and seat pose, 24 yaws x three pitches', () => {
    const camera = { x: 0, y: 0, z: 0 };
    let poses = 0, hidden = 0;
    for (const body of [TRADING_FLOOR_PLAYER_SPAWN, ...TRADING_FLOOR_SEATS]) {
      for (let index = 0; index < 24; index++) for (const camY of [140, 260, 410]) {
        placeTradingFloorChaseCamera(body.x, body.z, index * Math.PI / 12, camY - TRADING_FLOOR_CAMERA.above, camera);
        poses++;
        for (const spot of TRADING_FLOOR_HOUSE_AGENT_SPOTS) {
          if (tradingFloorHouseAgentHidden(spot.index, camera.x, camera.y, camera.z, body.x, body.z)) hidden++;
        }
      }
    }
    expect(poses).toBe((TRADING_FLOOR_SEATS.length + 1) * 24 * 3);
    expect(hidden).toBe(0);
    console.log(`P15 hide sweep: poses=${poses}, hidden=${hidden}`);
  });

  test('near-zone boundaries and segment distance/height control mesh hiding', () => {
    for (const spot of TRADING_FLOOR_HOUSE_AGENT_SPOTS) {
      const near = (dx: number, dz: number, y: number) => tradingFloorHouseAgentHidden(
        spot.index, spot.x + dx, y, spot.z + dz, spot.x + dx + 1000, spot.z + dz + 1000);
      expect(near(81.99, 87.99, 281.99)).toBe(true);
      expect(near(82, 87.99, 281.99)).toBe(false);
      expect(near(81.99, 88, 281.99)).toBe(false);
      expect(near(81.99, 87.99, 282)).toBe(false);
      const across = (y: number, dz: number) => tradingFloorHouseAgentHidden(
        spot.index, spot.x - 200, y, spot.z + dz, spot.x + 200, spot.z + dz);
      expect(across(140, 0)).toBe(true);
      expect(across(360, 0)).toBe(true); // Interpolated height 270 at the spot.
      expect(across(600, 0)).toBe(false);
      expect(across(140, 45)).toBe(true);
      expect(across(140, 45.01)).toBe(false);
      // Descending ray enters the body below 270 after its closest full-segment point.
      expect(across(400, 0)).toBe(true);
      expect(tradingFloorHouseAgentHidden(spot.index, spot.x - 200, 140, spot.z, spot.x - 100, spot.z)).toBe(false);
      expect(tradingFloorHouseAgentHidden(spot.index, spot.x, 410, spot.z, spot.x, spot.z)).toBe(true);
      expect(tradingFloorHouseAgentHidden(spot.index, spot.x + 100, 410, spot.z, spot.x + 100, spot.z)).toBe(false);
    }
    expect(tradingFloorHouseAgentHidden(-1, 0, 140, 0, 0, 0)).toBe(false);
    expect(tradingFloorHouseAgentHidden(FLOOR_ARENA_TEMPLATES.length, 0, 140, 0, 0, 0)).toBe(false);
  });
});
