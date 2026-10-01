import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DECOR_ATLAS_SIZE,
  DECOR_BAND_INSET,
  DECOR_BANDS,
  DECOR_BANK,
  DECOR_DEPTH_PANEL_COUNT,
  DECOR_DESK_CROSS_SECONDS,
  DECOR_DESK_HEADER_COUNT,
  DECOR_DESK_HOOD,
  DECOR_GLOW_FLOOR_Y,
  DECOR_SEAL,
  DECOR_SIDE_PILASTERS,
  DECOR_SWATCH_IDS,
  DECOR_UV_FLOATS_PER_QUAD,
  DECOR_WALL_CROSS_SECONDS,
  DECOR_WALL_HEADER_COUNT,
  DECOR_WALL_SCREEN,
  RIBBON_BACK_END_Z,
  RIBBON_BOTTOM_Y,
  RIBBON_CANVAS_WIDTH,
  RIBBON_STRIP_WU,
  RIBBON_TOP_Y,
  advanceDecorScroll,
  advanceRibbonOffset,
  buildGlowDecor,
  buildMonitorDecor,
  buildRibbonDecor,
  decorWallScreenSide,
  depthPanelRect,
  deskHeaderRect,
  swatchRect,
  wallHeaderRect,
  worldToDeskLocal,
  writeDecorScrollUvs,
  writeRibbonUvs,
  type AtlasRect,
  type DecorMeshData,
} from './trading-floor-decor-layout';
import {
  RIBBON_BRAND_PHRASES,
  RIBBON_PAPER_TAG,
  RIBBON_CLAW_PX,
  RIBBON_SEPARATOR_PX,
  buildRibbonSegments,
  drawClawIcon,
  drawDecorAtlas,
  drawRibbonStrip,
  layoutRibbon,
  periodicCandles,
  periodicWave,
  ribbonSignature,
  type DecorContext,
} from './trading-floor-decor-art';
import {
  TRADING_FLOOR_CAMERA,
  TRADING_FLOOR_CAMERA_Z_MAX,
  TRADING_FLOOR_CONSOLE_ROW,
  TRADING_FLOOR_DESK_INNER_X,
  TRADING_FLOOR_PLAYER_RADIUS,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_SCREEN,
  TRADING_FLOOR_SCREEN_SURROUND_FACE_Z,
  TRADING_FLOOR_SEATS,
  consoleHalfExtents,
} from './trading-floor-room';
import {
  TAPE_BOB,
  TAPE_CHIP_HEIGHT,
  TAPE_CHIP_WIDTH,
  TAPE_LANE_X,
  TAPE_POP_RISE,
  TAPE_Y,
  TAPE_Z_END,
  TAPE_Z_START,
  buildTapeSources,
  classifyArenaTapeItem,
  formatTapeSignedUsd,
  formatTapeUsd,
  readArenaTape,
  tapeTraderName,
} from './trading-floor-trade-tape';
import { buildFloorScreenData } from './trading-floor-screen-data';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type P3 = [number, number, number];

const MONITORS = buildMonitorDecor();
const RIBBON = buildRibbonDecor();
const GLOW = buildGlowDecor();
const ALL_MESHES: readonly [string, DecorMeshData][] = [
  ['monitors', MONITORS.mesh],
  ['ribbon', RIBBON.mesh],
  ['glow', GLOW],
];

function quadVertices(mesh: DecorMeshData, quad: number): P3[] {
  const out: P3[] = [];
  for (let vertex = 0; vertex < 4; vertex++) {
    const base = (quad * 4 + vertex) * 3;
    out.push([mesh.positions[base]!, mesh.positions[base + 1]!, mesh.positions[base + 2]!]);
  }
  return out;
}

function quadNormal(vertices: P3[]): P3 {
  const [bl, br, tl] = vertices;
  const a: P3 = [br![0] - bl![0], br![1] - bl![1], br![2] - bl![2]];
  const b: P3 = [tl![0] - bl![0], tl![1] - bl![1], tl![2] - bl![2]];
  const n: P3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = Math.hypot(...n) || 1;
  return [n[0] / length, n[1] / length, n[2] / length];
}

function quadCentre(vertices: P3[]): P3 {
  return [0, 1, 2].map((axis) => vertices.reduce((sum, v) => sum + v[axis]!, 0) / 4) as P3;
}

interface Box {
  min: P3;
  max: P3;
}

function aabb(vertices: P3[]): Box {
  const min: P3 = [Infinity, Infinity, Infinity];
  const max: P3 = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, v[axis]!);
      max[axis] = Math.max(max[axis]!, v[axis]!);
    }
  }
  return { min, max };
}

function disjoint(a: Box, b: Box): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (a.max[axis]! < b.min[axis]! || a.min[axis]! > b.max[axis]!) return true;
  }
  return false;
}

const EPS = 1e-6;

function insideDesk(v: P3, deskIndex: number): boolean {
  const slot = TRADING_FLOOR_CONSOLE_ROW[deskIndex]!;
  const { halfX, halfZ } = consoleHalfExtents(slot.rotY);
  return Math.abs(v[0] - slot.x) <= halfX + EPS && Math.abs(v[2] - slot.z) <= halfZ + EPS;
}

function forEachQuad(mesh: DecorMeshData, fn: (vertices: P3[], quad: number) => void): void {
  for (let quad = 0; quad < mesh.quadCount; quad++) fn(quadVertices(mesh, quad), quad);
}

/** Brace-matched body after `header`, the pattern `trading-floor-monitor.test.ts` uses. */
function bodiesAfter(source: string, header: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(header, from);
    if (start === -1) return bodies;
    let depth = 0;
    let index = source.indexOf('{', start + header.length - 1);
    const bodyStart = index;
    for (; index < source.length; index++) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(bodyStart, index + 1));
    from = index;
  }
}

/** The component's CODE: comments stripped, so prose that names a banned API
 *  (to say it is not used) cannot trip a pin, and a pin cannot pass on prose. */
const COMPONENT_SOURCE = readFileSync(join(import.meta.dir, 'trading-floor-decor.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// (a) The rigs sit on their desks
// ---------------------------------------------------------------------------

describe('desk monitor banks', () => {
  test('every bank quad lies inside its own desk footprint in XZ', () => {
    let checked = 0;
    forEachQuad(MONITORS.mesh, (vertices, quad) => {
      const tag = MONITORS.mesh.tags[quad]!;
      if (!tag.part.startsWith('bank-')) return;
      for (const v of vertices) {
        expect({ quad, desk: tag.owner, inside: insideDesk(v, tag.owner) }).toEqual({ quad, desk: tag.owner, inside: true });
      }
      checked++;
    });
    expect(checked).toBeGreaterThan(0);
  });

  test('monitors stand above the hood; only the mount foot goes lower, and only into the hood', () => {
    forEachQuad(MONITORS.mesh, (vertices, quad) => {
      const tag = MONITORS.mesh.tags[quad]!;
      if (!tag.part.startsWith('bank-')) return;
      const slot = TRADING_FLOOR_CONSOLE_ROW[tag.owner]!;
      for (const v of vertices) {
        if (tag.part === 'bank-mount') {
          expect(v[1]).toBeGreaterThanOrEqual(DECOR_BANK.footY - EPS);
          if (v[1] < DECOR_DESK_HOOD.topY) {
            const local = worldToDeskLocal(slot, v[0], v[2]);
            expect(local.localZ).toBeGreaterThanOrEqual(DECOR_DESK_HOOD.minLocalZ - EPS);
            expect(local.localZ).toBeLessThanOrEqual(DECOR_DESK_HOOD.maxLocalZ + EPS);
            expect(Math.abs(local.localX)).toBeLessThanOrEqual(DECOR_DESK_HOOD.flatHalfX);
          }
        } else {
          expect(v[1]).toBeGreaterThan(DECOR_DESK_HOOD.topY + 30);
        }
        expect(v[1]).toBeLessThanOrEqual(335 + EPS);
      }
    });
  });

  test('banks stay inside the brief\'s zone: |x| 1180..1258, z = row +- 165, top <= 335', () => {
    forEachQuad(MONITORS.mesh, (vertices, quad) => {
      const tag = MONITORS.mesh.tags[quad]!;
      if (!tag.part.startsWith('bank-')) return;
      const rowZ = TRADING_FLOOR_CONSOLE_ROW[tag.owner]!.z;
      for (const v of vertices) {
        expect(Math.abs(v[0])).toBeGreaterThanOrEqual(1180 - EPS);
        expect(Math.abs(v[0])).toBeLessThanOrEqual(1258 + EPS);
        expect(Math.abs(v[2] - rowZ)).toBeLessThanOrEqual(165 + EPS);
        expect(v[1]).toBeLessThanOrEqual(335 + EPS);
      }
    });
  });

  test('each desk carries six monitors, each with a header and a body', () => {
    const screensPerDesk = new Map<number, number>();
    for (const tag of MONITORS.mesh.tags) {
      if (tag.part === 'bank-screen') screensPerDesk.set(tag.owner, (screensPerDesk.get(tag.owner) ?? 0) + 1);
    }
    expect([...screensPerDesk.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    for (const count of screensPerDesk.values()) expect(count).toBe(12);
  });

  test('the screens face their own operator', () => {
    forEachQuad(MONITORS.mesh, (vertices, quad) => {
      const tag = MONITORS.mesh.tags[quad]!;
      if (tag.part !== 'bank-screen') return;
      const seat = TRADING_FLOOR_SEATS[tag.owner]!;
      const centre = quadCentre(vertices);
      const normal = quadNormal(vertices);
      const toSeat = [seat.x - centre[0], 0, seat.z - centre[2]];
      const facing = (normal[0] * toSeat[0]! + normal[2] * toSeat[2]!) / Math.hypot(toSeat[0]!, toSeat[2]!);
      // Outer columns are turned in, so every screen points within ~30 deg of
      // its seat.
      expect(facing).toBeGreaterThan(Math.cos((30 * Math.PI) / 180));
    });
  });

  test('the rig stays out of the seated avatar and the chase camera', () => {
    const avatarReach = Math.abs(TRADING_FLOOR_SEATS[0]!.x) + TRADING_FLOOR_PLAYER_RADIUS;
    forEachQuad(MONITORS.mesh, (vertices, quad) => {
      const tag = MONITORS.mesh.tags[quad]!;
      if (!tag.part.startsWith('bank-')) return;
      for (const v of vertices) {
        // The camera's X bound IS the desk face; the rig is far behind it.
        expect(Math.abs(v[0])).toBeGreaterThan(TRADING_FLOOR_DESK_INNER_X + 150);
        expect(Math.abs(v[0])).toBeGreaterThan(avatarReach + 150);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// (b) Nothing low enters the walkable volume
// ---------------------------------------------------------------------------

describe('player clamp volume', () => {
  const clampX = TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_PLAYER_RADIUS;
  const clampZ = TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS;

  test('below avatar height, monitor and ribbon quads are on a desk or outside the clamp', () => {
    for (const [name, mesh] of [['monitors', MONITORS.mesh], ['ribbon', RIBBON.mesh]] as const) {
      forEachQuad(mesh, (vertices, quad) => {
        const high = vertices.every((v) => v[1] >= 270);
        const onDesk = TRADING_FLOOR_CONSOLE_ROW.some((_, desk) => vertices.every((v) => insideDesk(v, desk)));
        const outside =
          vertices.every((v) => v[0] > clampX) ||
          vertices.every((v) => v[0] < -clampX) ||
          vertices.every((v) => v[2] > clampZ) ||
          vertices.every((v) => v[2] < -clampZ);
        expect({ name, quad, ok: high || onDesk || outside }).toEqual({ name, quad, ok: true });
      });
    }
  });

  // The glow is light, not a prop: floor pools are flat decals at the glow
  // height and wall glows are on the walls, so neither stands in the aisle.
  test('glow quads are flat on the floor or flat on a side wall', () => {
    forEachQuad(GLOW, (vertices, quad) => {
      const tag = GLOW.tags[quad]!;
      if (tag.part === 'glow-floor') {
        for (const v of vertices) expect(v[1]).toBe(DECOR_GLOW_FLOOR_Y);
      } else {
        for (const v of vertices) expect(Math.abs(v[0])).toBeGreaterThan(clampX + 30);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// (c) The trade tape keeps its flight volume
// ---------------------------------------------------------------------------

describe('trade-tape flight volume', () => {
  const reach = TAPE_CHIP_WIDTH / 2;
  const lanes: Box[] = [-1, 1].map((sign) => ({
    min: [sign * TAPE_LANE_X - reach, TAPE_Y - TAPE_CHIP_HEIGHT / 2 - TAPE_BOB - TAPE_POP_RISE, TAPE_Z_START - reach],
    max: [sign * TAPE_LANE_X + reach, TAPE_Y + TAPE_CHIP_HEIGHT / 2 + TAPE_BOB, TAPE_Z_END + reach],
  }));

  test('the conservative volume covers the documented 352.75..481', () => {
    expect(lanes[0]!.min[1]).toBeLessThanOrEqual(352.75);
    expect(lanes[0]!.max[1]).toBeGreaterThanOrEqual(481);
  });

  test('no decor quad touches either lane', () => {
    for (const [name, mesh] of ALL_MESHES) {
      forEachQuad(mesh, (vertices, quad) => {
        for (const lane of lanes) {
          expect({ name, quad, clear: disjoint(aabb(vertices), lane) }).toEqual({ name, quad, clear: true });
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------
// (d) The ribbon leaves the back wall to the board
// ---------------------------------------------------------------------------

describe('ticker ribbon placement', () => {
  const surround: Box = {
    min: [-918, 292, -TRADING_FLOOR_ROOM.halfZ],
    max: [918, 948, TRADING_FLOOR_SCREEN_SURROUND_FACE_Z],
  };

  test('never reaches the back wall and never overlaps the board surround', () => {
    forEachQuad(RIBBON.mesh, (vertices) => {
      for (const v of vertices) expect(v[2]).toBeGreaterThanOrEqual(RIBBON_BACK_END_Z - EPS);
      expect(disjoint(aabb(vertices), surround)).toBe(true);
    });
    expect(RIBBON_BACK_END_Z).toBeGreaterThan(-TRADING_FLOOR_ROOM.halfZ + 10);
  });

  test('no decor quad overlaps the board surround', () => {
    for (const [name, mesh] of ALL_MESHES) {
      forEachQuad(mesh, (vertices, quad) => {
        expect({ name, quad, clear: disjoint(aabb(vertices), surround) }).toEqual({ name, quad, clear: true });
      });
    }
  });

  test('no crawling face is on the back wall; each faces into the room', () => {
    forEachQuad(RIBBON.mesh, (vertices, quad) => {
      if (RIBBON.mesh.tags[quad]!.part !== 'ribbon-face') return;
      const normal = quadNormal(vertices);
      expect(normal[2]).toBeLessThan(0.5);
      const centre = quadCentre(vertices);
      expect(normal[0] * -centre[0] + normal[2] * -centre[2]).toBeGreaterThan(0);
    });
  });

  test('it runs in the band zone, in front of the pilaster faces', () => {
    forEachQuad(RIBBON.mesh, (vertices) => {
      for (const v of vertices) {
        expect(v[1]).toBeGreaterThanOrEqual(790);
        expect(v[1]).toBeLessThanOrEqual(860);
        expect(Math.abs(v[0])).toBeLessThan(TRADING_FLOOR_ROOM.halfX);
        expect(Math.abs(v[2])).toBeLessThan(TRADING_FLOOR_ROOM.halfZ);
      }
    });
    for (const segment of RIBBON.segments) {
      if (segment.normal[0] !== 0) expect(Math.abs(segment.start[0])).toBeLessThan(DECOR_SIDE_PILASTERS.faceX);
    }
  });

  test('the crawl is one continuous strip: U meets at both corners, with no stretch', () => {
    const uvs = new Float32Array(RIBBON.mesh.uvs);
    for (const offset of [0, 1234.5, RIBBON_STRIP_WU - 0.25]) {
      writeRibbonUvs(uvs, RIBBON.pathStarts, RIBBON.lengths, offset);
      for (let quad = 0; quad < RIBBON.segments.length; quad++) {
        const base = quad * DECOR_UV_FLOATS_PER_QUAD;
        const u0 = uvs[base]!;
        const u1 = uvs[base + 2]!;
        expect(uvs[base + 4]).toBe(u0);
        expect(uvs[base + 6]).toBe(u1);
        expect((u1 - u0) * RIBBON_STRIP_WU).toBeCloseTo(RIBBON.segments[quad]!.length, 2);
        if (quad > 0) {
          const previousEnd = uvs[(quad - 1) * DECOR_UV_FLOATS_PER_QUAD + 2]!;
          expect(u0).toBeCloseTo(previousEnd, 5);
        }
      }
    }
    // The strip keeps the canvas aspect: one strip period is 64 px tall.
    expect(RIBBON_STRIP_WU / RIBBON_CANVAS_WIDTH).toBeCloseTo((RIBBON_TOP_Y - RIBBON_BOTTOM_Y) / 64, 9);
  });

  test('U grows toward the viewer\'s right on every wall, so the text reads left to right', () => {
    for (let quad = 0; quad < RIBBON.segments.length; quad++) {
      const [bl, br] = quadVertices(RIBBON.mesh, quad);
      const segment = RIBBON.segments[quad]!;
      const run: P3 = [br![0] - bl![0], br![1] - bl![1], br![2] - bl![2]];
      const length = Math.hypot(...run);
      expect(run.map((v) => v / length)).toEqual([...segment.direction].map((v) => v + 0));
      // Viewer's right on a wall with normal n is up x n.
      const n = segment.normal;
      const right = [1 * n[2] - 0, 0, 0 - 1 * n[0]];
      expect(right[0]! * segment.direction[0] + right[2]! * segment.direction[2]).toBeCloseTo(1, 9);
    }
  });

  test('the crawl offset wraps inside one strip period', () => {
    let offset = 0;
    for (let frame = 0; frame < 5000; frame++) {
      offset = advanceRibbonOffset(offset, 0.1);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(RIBBON_STRIP_WU);
    }
  });
});

// ---------------------------------------------------------------------------
// (e) Wall screens stay in their bays
// ---------------------------------------------------------------------------

describe('wall screens', () => {
  const pilasterSpans = DECOR_SIDE_PILASTERS.z.map((z) => [z - DECOR_SIDE_PILASTERS.halfWidth, z + DECOR_SIDE_PILASTERS.halfWidth]);

  test('six screens, one per middle bay, each clear of both pilasters by 15 wu', () => {
    const owners = new Set<number>();
    forEachQuad(MONITORS.mesh, (vertices, quad) => {
      const tag = MONITORS.mesh.tags[quad]!;
      if (!tag.part.startsWith('wall-')) return;
      owners.add(tag.owner);
      const bayZ = DECOR_WALL_SCREEN.bayCentersZ[tag.owner % 3]!;
      const side = decorWallScreenSide(tag.owner);
      const box = aabb(vertices);
      for (const [low, high] of pilasterSpans) {
        expect(box.max[2] < low! - 15 || box.min[2] > high! + 15).toBe(true);
      }
      expect(box.min[2]).toBeGreaterThan(bayZ - 225);
      expect(box.max[2]).toBeLessThan(bayZ + 225);
      expect(box.min[1]).toBeGreaterThanOrEqual(DECOR_WALL_SCREEN.bottomY - EPS);
      expect(box.max[1]).toBeLessThanOrEqual(DECOR_WALL_SCREEN.bottomY + DECOR_WALL_SCREEN.height + EPS);
      for (const v of vertices) {
        expect(Math.sign(v[0])).toBe(side);
        expect(Math.abs(v[0])).toBeGreaterThan(DECOR_SIDE_PILASTERS.faceX);
        expect(Math.abs(v[0])).toBeLessThan(TRADING_FLOOR_ROOM.halfX);
      }
    });
    expect([...owners].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // The lane-B zones in the shared design brief, as LITERALS on purpose: a
  // check against the layout's own constants would move with the constant.
  // Lane A builds everything else on the walls around these rectangles.
  test('wall screens stay inside the brief\'s zone: middle bays, y 430..760', () => {
    const bays = [[-775, -325], [-225, 225], [325, 775]];
    forEachQuad(MONITORS.mesh, (vertices, quad) => {
      const tag = MONITORS.mesh.tags[quad]!;
      if (!tag.part.startsWith('wall-')) return;
      const box = aabb(vertices);
      expect(box.min[1]).toBeGreaterThanOrEqual(430 - EPS);
      expect(box.max[1]).toBeLessThanOrEqual(760 + EPS);
      expect(bays.some(([low, high]) => box.min[2] >= low! && box.max[2] <= high!)).toBe(true);
    });
  });

  test('wall screen glass faces the aisle', () => {
    forEachQuad(MONITORS.mesh, (vertices, quad) => {
      const tag = MONITORS.mesh.tags[quad]!;
      if (tag.part !== 'wall-screen') return;
      expect(quadNormal(vertices)[0]).toBeCloseTo(-decorWallScreenSide(tag.owner), 9);
    });
  });
});

// ---------------------------------------------------------------------------
// The big board stays fully visible from the spawn camera
// ---------------------------------------------------------------------------

describe('board visibility from the spawn', () => {
  const camera: P3 = [0, TRADING_FLOOR_CAMERA.above, TRADING_FLOOR_CAMERA_Z_MAX];
  const boardZ = TRADING_FLOOR_SCREEN.z;
  const board = {
    minX: -TRADING_FLOOR_SCREEN.width / 2,
    maxX: TRADING_FLOOR_SCREEN.width / 2,
    minY: TRADING_FLOOR_SCREEN.bottomY,
    maxY: TRADING_FLOOR_SCREEN.bottomY + TRADING_FLOOR_SCREEN.height,
  };

  /** Clip a polygon to z <= camera z - 1, keeping only what is in front of the lens. */
  function clipInFront(polygon: P3[]): P3[] {
    const limit = camera[2] - 1;
    const out: P3[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index]!;
      const b = polygon[(index + 1) % polygon.length]!;
      const aIn = a[2] <= limit;
      const bIn = b[2] <= limit;
      if (aIn) out.push(a);
      if (aIn !== bIn) {
        const t = (limit - a[2]) / (b[2] - a[2]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, limit]);
      }
    }
    return out;
  }

  test('no decor quad projects onto the board rectangle', () => {
    for (const [name, mesh] of ALL_MESHES) {
      forEachQuad(mesh, (vertices, quad) => {
        // Perimeter order bl, br, tr, tl.
        const polygon = clipInFront([vertices[0]!, vertices[1]!, vertices[3]!, vertices[2]!]);
        if (polygon.length === 0) return;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const v of polygon) {
          const t = (boardZ - camera[2]) / (v[2] - camera[2]);
          const x = camera[0] + (v[0] - camera[0]) * t;
          const y = camera[1] + (v[1] - camera[1]) * t;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
        const clear = maxX < board.minX || minX > board.maxX || maxY < board.minY || minY > board.maxY;
        expect({ name, quad, clear }).toEqual({ name, quad, clear: true });
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Glow pools
// ---------------------------------------------------------------------------

describe('glow pools', () => {
  test('no floor pool reaches the floor seal annulus', () => {
    forEachQuad(GLOW, (vertices, quad) => {
      if (GLOW.tags[quad]!.part !== 'glow-floor') return;
      const box = aabb(vertices);
      // Nearest and farthest point of the rect from the seal centre.
      const nx = Math.max(box.min[0], Math.min(DECOR_SEAL.x, box.max[0]));
      const nz = Math.max(box.min[2], Math.min(DECOR_SEAL.z, box.max[2]));
      const nearest = Math.hypot(nx - DECOR_SEAL.x, nz - DECOR_SEAL.z);
      const farthest = Math.max(
        ...vertices.map((v) => Math.hypot(v[0] - DECOR_SEAL.x, v[2] - DECOR_SEAL.z)),
      );
      expect(nearest > DECOR_SEAL.outerRadius || farthest < DECOR_SEAL.innerRadius).toBe(true);
    });
  });

  test('floor pools face up and wall glows face the room', () => {
    forEachQuad(GLOW, (vertices, quad) => {
      const normal = quadNormal(vertices);
      if (GLOW.tags[quad]!.part === 'glow-floor') expect(normal[1]).toBeCloseTo(1, 9);
      else expect(normal[0] * -Math.sign(vertices[0]![0])).toBeCloseTo(1, 9);
    });
  });

  test('every pool is tinted and none is opaque paint', () => {
    expect(GLOW.colors).not.toBeNull();
    for (let index = 0; index < GLOW.colors!.length; index += 4) {
      expect(GLOW.colors![index + 3]).toBeGreaterThan(0);
      // Float32 storage: 0.4 reads back as 0.40000000596.
      expect(GLOW.colors![index + 3]).toBeLessThanOrEqual(0.4 + 1e-6);
    }
  });
});

// ---------------------------------------------------------------------------
// Atlas map, aspect and periodicity
// ---------------------------------------------------------------------------

describe('monitor atlas', () => {
  const rects: [string, AtlasRect][] = [
    ...Object.entries(DECOR_BANDS).map(([id, band]) => [`band:${id}`, { x: 0, y: band.y, width: DECOR_ATLAS_SIZE, height: band.height }] as [string, AtlasRect]),
    ...Array.from({ length: DECOR_DESK_HEADER_COUNT }, (_, i) => [`deskHeader:${i}`, deskHeaderRect(i)] as [string, AtlasRect]),
    ...Array.from({ length: DECOR_WALL_HEADER_COUNT }, (_, i) => [`wallHeader:${i}`, wallHeaderRect(i)] as [string, AtlasRect]),
    ...Array.from({ length: DECOR_DEPTH_PANEL_COUNT }, (_, i) => [`depth:${i}`, depthPanelRect(i)] as [string, AtlasRect]),
    ...DECOR_SWATCH_IDS.map((id) => [`swatch:${id}`, swatchRect(id)] as [string, AtlasRect]),
  ];

  test('every region is inside the atlas and no two overlap', () => {
    for (const [name, rect] of rects) {
      expect({ name, inside: rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= DECOR_ATLAS_SIZE && rect.y + rect.height <= DECOR_ATLAS_SIZE }).toEqual({ name, inside: true });
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]![1];
        const b = rects[j]![1];
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect({ a: rects[i]![0], b: rects[j]![0], apart }).toEqual({ a: rects[i]![0], b: rects[j]![0], apart: true });
      }
    }
  });

  // The atlas wraps on S. A static region touching the left or right edge
  // would pick up the opposite edge through bilinear filtering.
  test('static regions keep clear of the wrapping edges', () => {
    for (const [name, rect] of rects) {
      if (name.startsWith('band:')) continue;
      expect(rect.x).toBeGreaterThanOrEqual(8);
      expect(rect.x + rect.width).toBeLessThanOrEqual(DECOR_ATLAS_SIZE - 8);
    }
  });

  test('static panels are not stretched on the quads that show them', () => {
    const bodyW = DECOR_BANK.monitorWidth - DECOR_BANK.bezel * 2;
    const bodyH = DECOR_BANK.monitorHeight - DECOR_BANK.bezel * 2 - DECOR_BANK.headerHeight;
    const depth = depthPanelRect(0);
    const header = deskHeaderRect(0);
    expect(Math.abs(bodyW / bodyH / (depth.width / depth.height) - 1)).toBeLessThan(0.02);
    expect(Math.abs(bodyW / DECOR_BANK.headerHeight / (header.width / header.height) - 1)).toBeLessThan(0.03);
  });

  test('bands are periodic along U', () => {
    const candles = periodicCandles(7, 128, 1);
    expect(candles.open[0]).toBe(candles.close[127]);
    for (let i = 1; i < 128; i++) expect(candles.open[i]).toBe(candles.close[i - 1]);
    for (const seed of [1, 2, 99]) {
      const wave = periodicWave(seed, 256);
      let maxStep = 0;
      for (let i = 1; i < wave.length; i++) maxStep = Math.max(maxStep, Math.abs(wave[i]! - wave[i - 1]!));
      // The seam step (last -> first) is no bigger than an ordinary step.
      expect(Math.abs(wave[0]! - wave[wave.length - 1]!)).toBeLessThanOrEqual(maxStep * 1.5);
    }
  });

  test('the atlas carries no text at all: no tickers, no prices, no digits', () => {
    const { ctx, texts } = recordingContext();
    drawDecorAtlas(ctx);
    expect(texts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scrolling: speeds, wrap, and the per-frame budget
// ---------------------------------------------------------------------------

describe('screen scrolling', () => {
  test('every chart crosses its screen in 20 to 60 s', () => {
    const scroll = MONITORS.scroll;
    expect(scroll.count).toBeGreaterThan(0);
    for (let i = 0; i < scroll.count; i++) {
      const seconds = scroll.widths[i]! / scroll.speeds[i]!;
      expect(seconds).toBeGreaterThanOrEqual(Math.min(DECOR_DESK_CROSS_SECONDS.min, DECOR_WALL_CROSS_SECONDS.min) - 1e-3);
      expect(seconds).toBeLessThanOrEqual(Math.max(DECOR_DESK_CROSS_SECONDS.max, DECOR_WALL_CROSS_SECONDS.max) + 1e-3);
      expect(scroll.widths[i]).toBeGreaterThan(0);
      expect(scroll.widths[i]).toBeLessThan(1);
      expect(scroll.phases[i]).toBeGreaterThanOrEqual(0);
      expect(scroll.phases[i]).toBeLessThan(1);
    }
    // Different speeds per screen, not one global pan.
    expect(new Set(Array.from(scroll.speeds, (s) => s.toFixed(6))).size).toBe(scroll.count);
  });

  test('the scrolling quads are the leading quads and only their U moves', () => {
    const scroll = MONITORS.scroll;
    for (let quad = 0; quad < scroll.count; quad++) {
      expect(['bank-screen', 'wall-screen']).toContain(MONITORS.mesh.tags[quad]!.part);
    }
    const uvs = new Float32Array(MONITORS.mesh.uvs);
    const offsets = new Float32Array(scroll.phases);
    advanceDecorScroll(offsets, scroll.speeds, scroll.count, 7.3);
    writeDecorScrollUvs(uvs, scroll.widths, offsets, scroll.count);
    for (let index = 0; index < uvs.length; index++) {
      const isScrollU = index < scroll.count * DECOR_UV_FLOATS_PER_QUAD && index % 2 === 0;
      if (!isScrollU) expect(uvs[index]).toBe(MONITORS.mesh.uvs[index]!);
    }
    for (let quad = 0; quad < scroll.count; quad++) {
      const base = quad * DECOR_UV_FLOATS_PER_QUAD;
      expect(uvs[base + 2]! - uvs[base]!).toBeCloseTo(scroll.widths[quad]!, 6);
      expect(uvs[base]).toBeGreaterThanOrEqual(0);
      expect(uvs[base]).toBeLessThan(1);
    }
  });

  test('scroll windows keep the band\'s V inset', () => {
    for (let quad = 0; quad < MONITORS.scroll.count; quad++) {
      const vTop = MONITORS.mesh.uvs[quad * DECOR_UV_FLOATS_PER_QUAD + 5]!;
      const top = (1 - vTop) * DECOR_ATLAS_SIZE;
      const band = Object.values(DECOR_BANDS).find((b) => Math.abs(top - (b.y + DECOR_BAND_INSET)) < 1e-3);
      expect(band).toBeDefined();
    }
  });

  test('per-frame float writes stay under ~400', () => {
    const writes = MONITORS.scroll.count * 4 + RIBBON.segments.length * 4;
    expect(writes).toBeLessThanOrEqual(400);
  });

  // What actually crosses the bus each frame: the two update ranges, V
  // included (a range is contiguous). The brief's budget is ~600.
  test('per-frame uploaded floats stay under ~600', () => {
    const monitorRange = MONITORS.scroll.count * DECOR_UV_FLOATS_PER_QUAD;
    const ribbonRange = RIBBON.segments.length * DECOR_UV_FLOATS_PER_QUAD;
    // The ribbon's crawling faces are its leading quads, like the monitors'.
    for (let quad = 0; quad < RIBBON.segments.length; quad++) {
      expect(RIBBON.mesh.tags[quad]!.part).toBe('ribbon-face');
    }
    expect(RIBBON.mesh.tags.slice(RIBBON.segments.length).every((tag) => tag.part === 'ribbon-soffit')).toBe(true);
    expect(monitorRange + ribbonRange).toBeLessThanOrEqual(600);
    // Pinned exactly so a change in either shows up here: 48 x 8 + 3 x 8.
    expect(monitorRange + ribbonRange).toBe(408);
  });
});

// ---------------------------------------------------------------------------
// (f) + (g) Source pins on the component
// ---------------------------------------------------------------------------

describe('component source', () => {
  test('exactly three meshes and three stock materials', () => {
    expect(COMPONENT_SOURCE.match(/<mesh\s/g)).toHaveLength(3);
    expect(COMPONENT_SOURCE.match(/new THREE\.MeshBasicMaterial\(/g)).toHaveLength(3);
    expect(COMPONENT_SOURCE.match(/new THREE\.\w*Material\(/g)).toHaveLength(3);
    expect(COMPONENT_SOURCE.includes('InstancedMesh')).toBe(false);
    expect(COMPONENT_SOURCE.includes('ShaderMaterial')).toBe(false);
    expect(/new THREE\.\w*Light\(|<\w+Light\b/.test(COMPONENT_SOURCE)).toBe(false);
    expect(/<Text|Billboard/.test(COMPONENT_SOURCE)).toBe(false);
    expect(COMPONENT_SOURCE).toContain('blending: THREE.AdditiveBlending');
    expect(COMPONENT_SOURCE).toContain('depthWrite: false');
    // Only the glow is transparent; monitors and ribbon stay opaque so they
    // never tie with the tape chips on transparent sort.
    expect(COMPONENT_SOURCE.match(/transparent: true/g)).toHaveLength(1);
  });

  // Transparents sort by renderOrder first. Without it the glow and the tape
  // chips tie on depth near the room middle and the glow can land on a chip.
  test('the glow draws before every other transparent', () => {
    const glow = COMPONENT_SOURCE.slice(COMPONENT_SOURCE.indexOf('function TradingFloorDecorGlow('));
    const mesh = glow.slice(glow.indexOf('<mesh'), glow.indexOf('/>', glow.indexOf('<mesh')));
    expect(mesh).toContain('name="TradingFloorDecorGlow"');
    expect(mesh).toContain('renderOrder={-1}');
    expect(COMPONENT_SOURCE.match(/renderOrder=/g)).toHaveLength(1);
  });

  test('the frame callbacks allocate nothing', () => {
    const bodies = bodiesAfter(COMPONENT_SOURCE, 'useSceneFrame(');
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).not.toContain('new ');
      expect(body).not.toContain('=>');
      expect(body).not.toContain('function');
      expect(body).not.toContain('addUpdateRange(');
      expect(body).not.toMatch(/\.(map|filter|slice|concat|from)\(/);
      expect(body).not.toMatch(/[=(,]\s*[[{]/);
      expect(body).not.toContain('...');
      // No texture upload from a frame loop, ever.
      expect(body).not.toContain('texture');
      expect(body).not.toContain('drawRibbonStrip');
      expect(body).toContain('if (!active) return;');
      // Uploads go through ONE preallocated range, pushed only when the
      // renderer has consumed the last one.
      expect(body).toContain('if (ranges.length === 0) ranges.push(frame.range);');
    }
  });

  test('textures upload only on mount or on a ribbon text change', () => {
    // Atlas at creation, ribbon brand strip at creation, ribbon text change,
    // glow at creation.
    expect(COMPONENT_SOURCE.match(/texture\.needsUpdate = true/g)).toHaveLength(4);
    const ribbonEffect = COMPONENT_SOURCE.indexOf('drawRibbonStrip(surface.context, segments)');
    expect(ribbonEffect).toBeGreaterThan(0);
    expect(COMPONENT_SOURCE.slice(ribbonEffect, ribbonEffect + 400)).toContain('[surface, signature]');
  });

  // Round 3 (lead): every decor texture is uploaded at mount, inside the
  // stage's warm gate, never on the first visible frame.
  test('all three textures are pre-uploaded with initTexture at mount', () => {
    const hook = COMPONENT_SOURCE.slice(COMPONENT_SOURCE.indexOf('function useWarmUpload('));
    const body = hook.slice(0, hook.indexOf('\n}\n'));
    expect(body).toContain('gl.initTexture(texture)');
    expect(body).toContain('useEffect(');
    expect(COMPONENT_SOURCE.match(/useWarmUpload\(surface\?\.texture \?\? null\);/g)).toHaveLength(3);
    for (const component of ['function TradingFloorDecorMonitors(', 'function TradingFloorDecorRibbon(', 'function TradingFloorDecorGlow(']) {
      const start = COMPONENT_SOURCE.indexOf(component);
      const end = COMPONENT_SOURCE.indexOf('\n}\n', start);
      expect({ component, warms: COMPONENT_SOURCE.slice(start, end).includes('useWarmUpload(surface?.texture ?? null);') })
        .toEqual({ component, warms: true });
    }
  });

  test('the ribbon paints its brand strip at creation and uploads after its repaint effect', () => {
    const start = COMPONENT_SOURCE.indexOf('function TradingFloorDecorRibbon(');
    const ribbon = COMPONENT_SOURCE.slice(start, COMPONENT_SOURCE.indexOf('\n}\n', start));
    const memo = ribbon.slice(ribbon.indexOf('const surface = useMemo('), ribbon.indexOf('}, []);'));
    expect(memo).toContain('drawRibbonStrip(next.context, BRAND_ONLY_SEGMENTS)');
    // Effects run in declaration order: a tape cached at mount is painted
    // before the one upload, not uploaded twice.
    expect(ribbon.indexOf('drawRibbonStrip(surface.context, segments)')).toBeGreaterThan(0);
    expect(ribbon.indexOf('useWarmUpload(')).toBeGreaterThan(ribbon.indexOf('drawRibbonStrip(surface.context, segments)'));
    // The repaint skips the text already on the canvas.
    expect(ribbon).toContain('signature === drawnSignatureRef.current');
    expect(COMPONENT_SOURCE).toContain('const BRAND_ONLY_SEGMENTS = buildRibbonSegments({ data: undefined, isError: false });');
  });

  test('the ribbon shares the board\'s tape key and every mesh is out of raycasting', () => {
    expect(COMPONENT_SOURCE).toContain('useFloorArenaTape(ARENA_TAPE_LIMIT, active)');
    expect(COMPONENT_SOURCE).toContain('mesh.raycast = skipRaycast');
    expect(COMPONENT_SOURCE.match(/useStaticScenery\(meshRef\)/g)).toHaveLength(3);
  });

  test('the interior mounts the decor right after the trade tape', () => {
    const interior = readFileSync(join(import.meta.dir, 'trading-floor-interior.tsx'), 'utf8');
    expect(interior).toContain(
      '<TradingFloorTradeTape active={active} />\n      <TradingFloorDecor active={active} />',
    );
  });
});

// ---------------------------------------------------------------------------
// (h) The ribbon says only the tape and the brand
// ---------------------------------------------------------------------------

const MINT = 'So11111111111111111111111111111111111111112';

function tapeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    at: '2026-09-30T12:00:00.000Z',
    agentName: 'Genesis',
    type: 'entry',
    symbol: 'BONK',
    usd: 20,
    pnlUsd: null,
    mint: MINT,
    ...overrides,
  };
}

const FIXTURE = [
  tapeRow(),
  tapeRow({ id: 'x1', at: '2026-09-30T11:59:00.000Z', agentName: 'Runner', type: 'exit', symbol: 'WIF', pnlUsd: 2.14 }),
  tapeRow({ id: 'x2', at: '2026-09-30T11:58:00.000Z', agentName: 'Dip Hunter', type: 'exit', symbol: 'POPCAT', pnlUsd: -3.21 }),
  tapeRow({ id: 'x3', at: '2026-09-30T11:57:00.000Z', agentName: 'Late Bloomer', type: 'exit', symbol: null, pnlUsd: null }),
];

describe('ribbon text', () => {
  test('a tape that never arrived, or arrived empty, says the brand phrases and nothing else', () => {
    for (const tape of [
      { data: undefined, isError: false },
      { data: undefined, isError: true },
      { data: [], isError: false },
      { data: [], isError: true },
      { data: { items: [] }, isError: false },
    ]) {
      const segments = buildRibbonSegments(tape);
      expect(segments.map((s) => s.text)).toEqual([...RIBBON_BRAND_PHRASES]);
      expect(segments.every((s) => s.tone === 'brand')).toBe(true);
      expect(segments.map((s) => s.text).join(' ')).not.toMatch(/\d/);
    }
  });

  // Room-wide rule (lead, 2026-10-01): a failed REFETCH keeps the last good
  // tape. react-query keeps `data` across a refetch error, so data wins.
  test('a failed refetch keeps the last good tape on the ribbon', () => {
    const kept = buildRibbonSegments({ data: FIXTURE, isError: true });
    expect(kept).toEqual(buildRibbonSegments({ data: FIXTURE, isError: false }));
    expect(kept.some((s) => s.tone !== 'brand')).toBe(true);
  });

  test('every other word on the ribbon is a tape row, formatted the board\'s way', () => {
    const segments = buildRibbonSegments({ data: FIXTURE, isError: false });
    const rows = readArenaTape(FIXTURE).map((item) => {
      const face = classifyArenaTapeItem(item);
      const parts = [tapeTraderName(item.agentName), face.action, face.amount, RIBBON_PAPER_TAG];
      return { text: parts.filter((p) => p.length > 0).join(' '), tone: face.kind };
    });
    expect(rows.map((r) => r.text)).toEqual([
      'GENESIS BUY BONK $20.00 PAPER',
      'RUNNER SELL WIF +$2.14 PAPER',
      'DIP HUNTER SELL POPCAT -$3.21 PAPER',
      'LATE BLOOM SELL PAPER',
    ]);
    const allowed = new Set<string>([...RIBBON_BRAND_PHRASES, ...rows.map((r) => r.text)]);
    for (const segment of segments) expect(allowed.has(segment.text)).toBe(true);
    // Every row appears exactly once, newest first, with its own tone.
    const tradeSegments = segments.filter((s) => s.tone !== 'brand');
    expect(tradeSegments).toEqual(rows);
    // BLOCKING-class honesty pin: EVERY trade segment carries PAPER, with or
    // without a figure, so no wall stretch can show a trade that reads as real
    // money (Codex review of 6b9593db).
    for (const segment of tradeSegments) expect(segment.text.endsWith(` ${RIBBON_PAPER_TAG}`)).toBe(true);
    // Every brand phrase still appears.
    for (const phrase of RIBBON_BRAND_PHRASES) expect(segments.some((s) => s.text === phrase)).toBe(true);
    // No mint, no fragment of one.
    const text = segments.map((s) => s.text).join(' ');
    expect(text).not.toContain(MINT.slice(0, 5));
    // The only digits are the route's own figures.
    for (const segment of segments) {
      if (/\d/.test(segment.text)) expect(rows.some((r) => r.text === segment.text)).toBe(true);
    }
  });

  // Codex BLOCK on 6b9593db: the API keeps `$` in token symbols
  // (`sanitizeArenaSymbol` allows `$ . _ -`), and the board's
  // `sanitiseScreenText` keeps `$` on purpose. So the ribbon strips `$` from
  // the symbol and the agent name itself; the only `$` left is the amount the
  // tape formatters print.
  test('a $ in a token symbol or agent name never reads as a figure', () => {
    const cases: [Record<string, unknown>, string][] = [
      // A symbol with no letter left after the `$` goes is no symbol at all
      // (`tapeSymbol`, the shared root fix): a price is not a token.
      [tapeRow({ id: 's1', symbol: '$100', usd: 20 }), 'GENESIS BUY $20.00 PAPER'],
      [tapeRow({ id: 's2', type: 'exit', symbol: '$100', pnlUsd: null }), 'GENESIS SELL PAPER'],
      [tapeRow({ id: 's3', type: 'exit', symbol: '$WIF', pnlUsd: 2.14 }), 'GENESIS SELL WIF +$2.14 PAPER'],
      [tapeRow({ id: 's4', type: 'exit', symbol: '$', pnlUsd: null }), 'GENESIS SELL PAPER'],
      [tapeRow({ id: 's5', type: 'exit', symbol: '$1,000.00', pnlUsd: null }), 'GENESIS SELL PAPER'],
      [tapeRow({ id: 's6', agentName: '$500 Club', symbol: 'BONK', usd: 20 }), '500 CLUB BUY BONK $20.00 PAPER'],
      // `USD100`: neither sanitiser treats it (no `$`, nothing to strip), so it
      // prints as the route's symbol and is still carried by PAPER.
      [tapeRow({ id: 's7', type: 'exit', symbol: 'USD100', pnlUsd: null }), 'GENESIS SELL USD100 PAPER'],
    ];
    for (const [row, expected] of cases) {
      const segments = buildRibbonSegments({ data: [row], isError: false });
      const trades = segments.filter((s) => s.tone !== 'brand');
      expect(trades.map((s) => s.text)).toEqual([expected]);
      const trade = trades[0]!;
      expect(trade.text.endsWith(` ${RIBBON_PAPER_TAG}`)).toBe(true);
      // Remove the one figure the tape formatters print; no `$` may remain.
      const usd = typeof row.usd === 'number' && row.type === 'entry' ? formatTapeUsd(row.usd) : '';
      const pnl = typeof row.pnlUsd === 'number' ? formatTapeSignedUsd(row.pnlUsd) : '';
      const figure = row.type === 'entry' ? usd : pnl;
      const rest = figure ? trade.text.replace(figure, '') : trade.text;
      expect({ expected, dollarOutsideFigure: rest.includes('$') }).toEqual({ expected, dollarOutsideFigure: false });
    }
  });

  // Found by Codex review (lane B) and tfx-audit: attacker-chosen symbols like
  // `+$4,200.00`, and a user-chosen name like `$500 Club`, printed as dollar
  // figures on the board's tape row, the 3D chips and the ribbon, all through
  // `classifyArenaTapeItem` / `tapeTraderName`. The only `$` any of the three
  // surfaces may print is the tape formatters' own amount.
  test('no surface prints a dollar figure from a token symbol or a trader name', () => {
    const rows = [
      { id: 'a', type: 'exit', at: '2026-10-01T03:58:00.000Z', agentName: 'Runner', symbol: '+$4,200.00', usd: 20, pnlUsd: null },
      { id: 'b', type: 'entry', at: '2026-10-01T03:57:00.000Z', agentName: 'Genesis', symbol: '$500', usd: 20, pnlUsd: null },
      { id: 'c', type: 'exit', at: '2026-10-01T03:56:00.000Z', agentName: 'Dip Hunter', symbol: '$9999999', usd: 20, pnlUsd: null },
      { id: 'd', type: 'entry', at: '2026-10-01T03:55:00.000Z', agentName: 'Late Bloomer', symbol: '$PEPE', usd: 20, pnlUsd: null },
      { id: 'e', type: 'entry', at: '2026-10-01T03:54:00.000Z', agentName: '$500 Club', symbol: 'BONK', usd: 20, pnlUsd: null },
    ];
    // The only figure these rows may print: an entry's $20.00 ticket (every
    // exit here is unpriced, so it prints no figure at all).
    const withoutTicket = (text: string) => text.split(formatTapeUsd(20)).join('');
    const assertOnlyTicket = (surface: string, text: string) =>
      expect({ surface, text, stray: withoutTicket(text).includes('$') }).toEqual({ surface, text, stray: false });

    const now = Date.parse('2026-10-01T04:00:00.000Z');
    const query = (data: unknown) => ({ data, isLoading: false, isError: false });
    const board = buildFloorScreenData({ leaderboard: query({ rows: [] }), contest: query(null), tape: query({ items: rows }) }, now);
    expect(board.tape).toHaveLength(5);
    for (const line of board.tape) assertOnlyTicket('board', line);
    expect(board.tape[3]).toContain('BUY PEPE');
    expect(board.tape[4]).toContain('500 CLUB BUY BONK $20.00');

    const chips = buildTapeSources({ items: rows });
    expect(chips).toHaveLength(5);
    for (const chip of chips) {
      expect({ trader: chip.trader, dollar: chip.trader.includes('$') }).toEqual({ trader: chip.trader, dollar: false });
      expect({ action: chip.action, dollar: chip.action.includes('$') }).toEqual({ action: chip.action, dollar: false });
      assertOnlyTicket('chip amount', chip.amount);
    }
    expect(chips.map((chip) => chip.action)).toEqual(['SELL', 'BUY', 'SELL', 'BUY PEPE', 'BUY BONK']);
    expect(chips[4]!.trader).toBe('500 CLUB');

    const ribbon = buildRibbonSegments({ data: { items: rows }, isError: false }).filter((s) => s.tone !== 'brand');
    expect(ribbon.map((s) => s.text)).toEqual([
      'RUNNER SELL PAPER',
      'GENESIS BUY $20.00 PAPER',
      'DIP HUNTER SELL PAPER',
      'LATE BLOOM BUY PEPE $20.00 PAPER',
      '500 CLUB BUY BONK $20.00 PAPER',
    ]);
    for (const segment of ribbon) assertOnlyTicket('ribbon', segment.text);
  });

  // tfx-audit r2: a decimal number in a symbol reads as a price even with
  // letters on it (`4200.00USD` printed "SELL 4200.00U"; `1.5M` collided with
  // the board's "12M" age column). Integer tickers stay.
  test('no surface prints a decimal-number symbol; integer tickers stay', () => {
    const rows = [
      { id: 'a', type: 'exit', at: '2026-10-01T03:58:00.000Z', agentName: 'Agent4', symbol: '4200.00USD', usd: 20, pnlUsd: null },
      { id: 'b', type: 'entry', at: '2026-10-01T03:57:00.000Z', agentName: 'Genesis', symbol: '$1.5M', usd: 20, pnlUsd: null },
      { id: 'c', type: 'entry', at: '2026-10-01T03:56:00.000Z', agentName: 'Runner', symbol: '1INCH', usd: 20, pnlUsd: null },
      { id: 'd', type: 'exit', at: '2026-10-01T03:55:00.000Z', agentName: 'Dip Hunter', symbol: 'W3', usd: 20, pnlUsd: null },
      { id: 'e', type: 'entry', at: '2026-10-01T03:54:00.000Z', agentName: 'Late Bloomer', symbol: 'BONK2', usd: 20, pnlUsd: null },
    ];
    const ticket = formatTapeUsd(20);
    const decimal = /\d[.,]\d/;

    const now = Date.parse('2026-10-01T04:00:00.000Z');
    const query = (data: unknown) => ({ data, isLoading: false, isError: false });
    const board = buildFloorScreenData({ leaderboard: query({ rows: [] }), contest: query(null), tape: query({ items: rows }) }, now);
    expect(board.tape).toHaveLength(5);
    for (const line of board.tape) {
      // Drop the formatter's ticket and the trailing age ("2M"); nothing left
      // may be a decimal number.
      const rest = line.split(ticket).join('').replace(/ \S+$/, '');
      expect({ line, decimal: decimal.test(rest) }).toEqual({ line, decimal: false });
    }
    expect(board.tape[0]).toMatch(/^AGENT4 SELL \d+M$/);
    expect(board.tape[1]).toMatch(/^GENESIS BUY \$20\.00 \d+M$/);
    expect(board.tape.slice(2).map((line) => line.replace(/ \S+$/, ''))).toEqual([
      'RUNNER BUY 1INCH $20.00',
      'DIP HUNTER SELL W3',
      'LATE BLOOM BUY BONK2 $20.00',
    ]);

    expect(buildTapeSources({ items: rows }).map((chip) => chip.action)).toEqual([
      'SELL',
      'BUY',
      'BUY 1INCH',
      'SELL W3',
      'BUY BONK2',
    ]);

    const ribbon = buildRibbonSegments({ data: { items: rows }, isError: false }).filter((s) => s.tone !== 'brand');
    expect(ribbon.map((s) => s.text)).toEqual([
      'AGENT4 SELL PAPER',
      'GENESIS BUY $20.00 PAPER',
      'RUNNER BUY 1INCH $20.00 PAPER',
      'DIP HUNTER SELL W3 PAPER',
      'LATE BLOOM BUY BONK2 $20.00 PAPER',
    ]);
    for (const segment of ribbon) expect(decimal.test(segment.text.split(ticket).join(''))).toBe(false);
  });

  test('the signature ignores time: a re-timed tape in the same order repaints nothing', () => {
    const later = FIXTURE.map((row, index) => ({ ...row, at: `2026-09-30T13:0${index}:00.000Z` })).reverse();
    // Reverse the times too, so the newest-first order is unchanged.
    const retimed = FIXTURE.map((row, index) => ({ ...row, at: later[index]!.at }));
    expect(ribbonSignature(buildRibbonSegments({ data: retimed, isError: false }))).toBe(
      ribbonSignature(buildRibbonSegments({ data: FIXTURE, isError: false })),
    );
    const changed = [...FIXTURE, tapeRow({ id: 'e9', at: '2026-09-30T12:01:00.000Z', agentName: 'Mid-Cap Climber' })];
    expect(ribbonSignature(buildRibbonSegments({ data: changed, isError: false }))).not.toBe(
      ribbonSignature(buildRibbonSegments({ data: FIXTURE, isError: false })),
    );
  });

  test('the packer places whole segments only and fills exactly one strip period', () => {
    for (const data of [undefined, FIXTURE, Array.from({ length: 24 }, (_, i) => tapeRow({ id: `r${i}`, at: `2026-09-30T10:${String(i).padStart(2, '0')}:00.000Z` }))]) {
      const segments = buildRibbonSegments({ data, isError: false });
      const { ctx } = recordingContext();
      const placements = layoutRibbon(ctx, segments);
      expect(placements.length).toBeGreaterThan(0);
      const texts = new Set(segments.map((s) => s.text));
      let cursor = 0;
      for (const placement of placements) {
        expect(texts.has(placement.text)).toBe(true);
        expect(placement.x).toBeCloseTo(cursor, 6);
        expect(placement.separatorX).toBeGreaterThan(placement.x + placement.width);
        cursor = placement.x + placement.width + 2 * (placement.separatorX - placement.x - placement.width);
      }
      // Period closes exactly at the strip width: the crawl wraps seamlessly.
      expect(cursor).toBeCloseTo(RIBBON_CANVAS_WIDTH, 4);
      // A prefix of the crawl order, never a reshuffle.
      const order = placements.slice(0, segments.length).map((p) => p.text);
      expect(order).toEqual(segments.slice(0, order.length).map((s) => s.text));
    }
  });

  // Round 3 (lead): the separator is a claw, drawn with paths, never loaded.
  test('the claw separator is drawn with paths only and fits inside its gap', () => {
    const art = readFileSync(join(import.meta.dir, 'trading-floor-decor-art.ts'), 'utf8');
    expect(art.includes('drawImage')).toBe(false);
    expect(art.includes('new Image')).toBe(false);
    const { ctx, points, fills } = recordingContext();
    drawClawIcon(ctx, 100, 10, RIBBON_CLAW_PX, '#d4a94e', '#4a3818');
    // Two fingers + two spikes are filled paths; the wrist is rectangles.
    expect(fills.length).toBeGreaterThanOrEqual(4);
    expect(points.length).toBeGreaterThan(10);
    // Control points bound every curve (convex hull), so this bounds the claw.
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(10 - 1e-9);
    expect(Math.max(...ys)).toBeLessThanOrEqual(10 + RIBBON_CLAW_PX + 1e-9);
    // drawRibbonStrip anchors the claw at separatorX - 0.45 x size; it must
    // stay inside half the separator room on both sides, clear of the text.
    const anchor = 100 + RIBBON_CLAW_PX * 0.45;
    expect(anchor - Math.min(...xs)).toBeLessThanOrEqual(RIBBON_SEPARATOR_PX / 2);
    expect(Math.max(...xs) - anchor).toBeLessThanOrEqual(RIBBON_SEPARATOR_PX / 2);
    // And inside the LED panel between the rims (rows 4..60).
    expect(6 + RIBBON_CLAW_PX).toBeLessThanOrEqual(64 - 4);
  });

  test('the strip draws only the placed text, with every figure\'s PAPER tag', () => {
    const segments = buildRibbonSegments({ data: FIXTURE, isError: false });
    const { ctx, texts } = recordingContext();
    const placements = drawRibbonStrip(ctx, segments);
    const suffix = ` ${RIBBON_PAPER_TAG}`;
    const pieces = new Set<string>([RIBBON_PAPER_TAG]);
    let expected = 0;
    let tagged = 0;
    for (const placement of placements) {
      const isTagged = placement.text.endsWith(suffix);
      pieces.add(isTagged ? placement.text.slice(0, -suffix.length) : placement.text);
      // Glow pass + crisp pass, for the body and (when tagged) for the tag.
      expected += isTagged ? 4 : 2;
      if (isTagged) {
        tagged++;
        const tag = texts.find(
          (t) => t.text === RIBBON_PAPER_TAG && t.x > placement.x && t.x < placement.x + placement.width,
        );
        expect(tag).toBeDefined();
      }
    }
    expect(tagged).toBeGreaterThan(0);
    expect(texts.length).toBe(expected);
    for (const drawn of texts) {
      expect(pieces.has(drawn.text)).toBe(true);
      expect(drawn.x).toBeLessThan(RIBBON_CANVAS_WIDTH);
    }
  });
});

// ---------------------------------------------------------------------------
// Recording 2D context
// ---------------------------------------------------------------------------

interface RecordedText {
  text: string;
  x: number;
  y: number;
}

function recordingContext(): {
  ctx: DecorContext;
  texts: RecordedText[];
  points: { x: number; y: number }[];
  fills: number[];
} {
  const texts: RecordedText[] = [];
  const points: { x: number; y: number }[] = [];
  const fills: number[] = [];
  const point = (...xy: number[]) => {
    for (let i = 0; i + 1 < xy.length; i += 2) points.push({ x: xy[i]!, y: xy[i + 1]! });
  };
  const gradient = { addColorStop: () => undefined };
  const state = {
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowBlur: 0,
    shadowColor: '',
  };
  const noop = () => undefined;
  const ctx = {
    ...state,
    // Rectangles count toward the drawn extent too (the claw's wrist is one).
    fillRect: (x: number, y: number, w: number, h: number) => point(x, y, x + w, y + h),
    strokeRect: noop,
    clearRect: noop,
    beginPath: noop,
    moveTo: point,
    lineTo: point,
    quadraticCurveTo: point,
    bezierCurveTo: point,
    closePath: noop,
    stroke: noop,
    fill: () => fills.push(fills.length),
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y });
    },
    measureText(this: { font: string }, text: string) {
      const px = Number(this.font.match(/(\d+)px/)?.[1] ?? 16);
      return { width: text.length * px * 0.6 };
    },
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  } as unknown as DecorContext;
  return { ctx, texts, points, fills };
}
