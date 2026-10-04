import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import {
  consoleHalfExtents,
  AUTHORED_PROP_TOLERANCE_WU,
  TRADING_FLOOR_CAMERA,
  TRADING_FLOOR_CAMERA_CLAW_SOLID,
  TRADING_FLOOR_CLAW_EXTENTS,
  TRADING_FLOOR_CAMERA_SOLID_CLEARANCE,
  TRADING_FLOOR_CAMERA_Z_MAX,
  TRADING_FLOOR_CAMERA_Z_MIN,
  TRADING_FLOOR_DESK_INNER_X,
  TRADING_FLOOR_DOOR,
  placeTradingFloorChaseCamera,
  TRADING_FLOOR_SIDE_APPROACH_X,
  TRADING_FLOOR_BOARD_APPROACH_Z,
  TRADING_FLOOR_DOOR_APPROACH_Z,
  TRADING_FLOOR_PLAYER_SPAWN,
  tradingFloorHitsSolid,
  TRADING_FLOOR_CHAIR_HALF_X,
  TRADING_FLOOR_CHAIR_HALF_Z,
  TRADING_FLOOR_CHAIR_SEAT_Y,
  TRADING_FLOOR_CONSOLE_HALF_X,
  TRADING_FLOOR_CONSOLE_HALF_Z,
  TRADING_FLOOR_CONSOLE_HEIGHT,
  TRADING_FLOOR_CONSOLE_ROW,
  TRADING_FLOOR_MONITOR,
  TRADING_FLOOR_MONITOR_FRONT_Z,
  TRADING_FLOOR_SEATS,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_SCREEN,
  TRADING_FLOOR_SOLIDS,
  TRADING_FLOOR_DAIS,
  TRADING_FLOOR_PILLAR_SOLIDS,
  TRADING_FLOOR_PLAYER_RADIUS,
  TRADING_FLOOR_SCREEN_FRAME_WIDTH,
} from './trading-floor-room';
import { DECOR_BANK, DECOR_DESK_HOOD, DECOR_SEAL } from './trading-floor-decor-layout';

/**
 * trading-floor-asset.test.ts
 *
 * The one test in this directory that reads the SHIPPED GLB.
 *
 * Every other check here feeds hand-built numbers to a pure function, which
 * proves the maths and proves nothing about the asset. The adversarial review
 * named that gap precisely: `validateAuthoredProp` is warn-only at runtime, so
 * a bad re-export would produce a `console.warn` in a browser nobody is watching
 * while the desks sit somewhere the colliders are not. This closes it — the
 * constants and the bytes are compared on every push, in the web lane.
 *
 * It parses the glTF container DIRECTLY rather than going through a loader. The
 * asset is meshopt-compressed with KTX2 textures, so a loader would need a WASM
 * decoder and a GPU-ish environment to open it. Everything asserted here (node
 * transforms, accessor min/max) lives in the uncompressed JSON chunk, so raw
 * parsing is both sufficient and far more robust in a unit-test process.
 */

const GLB_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'public',
  'models',
  'trading-floor',
  'trading-floor-interior-opt1-mo-ktx.glb',
);

interface GltfAccessor {
  componentType: number;
  normalized?: boolean;
  min?: number[];
  max?: number[];
}
interface GltfNode {
  name?: string;
  mesh?: number;
  translation?: number[];
  scale?: number[];
  rotation?: number[];
}
/**
 * The contract the build script publishes on the scene root. These are the
 * AUTHORED numbers, taken from the script's pre-quantization float geometry,
 * so the scene constants must match them to the digit.
 */
interface GltfSceneExtras {
  contract?: string;
  screen?: { width: number; height: number; bottomY: number; z: number };
  kiosk?: {
    x: number;
    y: number;
    z: number;
    rotY: number;
    halfX: number;
    halfZ: number;
    height: number;
  };
  room?: { halfX: number; halfZ: number; height: number };
  statue?: { top: number; claws: { min: number[]; max: number[] }[] };
}
interface GltfJson {
  scene?: number;
  scenes: { extras?: GltfSceneExtras }[];
  nodes: GltfNode[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
  accessors: GltfAccessor[];
  materials: { name?: string; extensions?: Record<string, unknown>; pbrMetallicRoughness?: { metallicFactor?: number } }[];
  textures: unknown[];
}

/** Read the JSON chunk out of a binary glTF container. */
function readGlbJson(path: string): GltfJson {
  const bytes = readFileSync(path);
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
  expect(bytes.readUInt32LE(4)).toBe(2); // version
  const jsonLength = bytes.readUInt32LE(12);
  expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a); // 'JSON' chunk type
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
}

const gltf = readGlbJson(GLB_PATH);

function nodeByName(name: string): GltfNode {
  const node = gltf.nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`[asset] no node named "${name}" in the GLB`);
  return node;
}

/**
 * World half-extents of a node's mesh. `KHR_mesh_quantization` stores POSITION
 * as normalized SHORTs, so the accessor min/max are integers in [-32767, 32767]
 * that have to be divided back out before the node scale is applied.
 */
function worldHalfExtents(node: GltfNode): { x: number; y: number; z: number } {
  const mesh = gltf.meshes[node.mesh!]!;
  const accessor = gltf.accessors[mesh.primitives[0]!.attributes.POSITION!]!;
  const divisor =
    accessor.normalized && accessor.componentType === 5122 ? 32767 : 1;
  const scale = node.scale?.[0] ?? 1;
  const half = (index: number) =>
    ((accessor.max![index]! - accessor.min![index]!) / 2 / divisor) * scale;
  return { x: half(0), y: half(1), z: half(2) };
}

function translation(node: GltfNode): { x: number; y: number; z: number } {
  const [x = 0, y = 0, z = 0] = node.translation ?? [];
  return { x, y, z };
}

const TOL = AUTHORED_PROP_TOLERANCE_WU;

const extras: GltfSceneExtras | undefined = gltf.scenes[gltf.scene ?? 0]?.extras;

describe('Trading Floor asset — the published contract in scene extras', () => {
  /**
   * The GLB carries its own contract, so the surround opening and the board
   * plane can never silently disagree again. They already did once: the script
   * framed y 360..880 while the scene drew y 340..880, and the bottom 20 wu of
   * live canvas rendered behind the bezel.
   *
   * This guard is not ceremony. `extras` is metadata, and a future pipeline step
   * could drop it — after which every assertion below would pass VACUOUSLY on
   * `undefined?.width === undefined`. The guard turns that silent hole into a
   * red test, which is the whole reason tf3d-shell asked for it.
   */
  test('extras survives the compression pipeline and carries the measured statue', () => {
    expect(extras).toBeDefined();
    expect(Object.keys(extras ?? {}).sort()).toEqual([
      'contract',
      'kiosk',
      'room',
      'ropeRing',
      'screen',
      'seaLife',
      'statue',
    ]);
    for (const value of [
      extras?.screen?.width,
      extras?.kiosk?.halfX,
      extras?.room?.halfX,
      extras?.statue?.top,
    ]) {
      expect(typeof value).toBe('number');
    }
  });

  // EXACT, not toBeCloseTo. Both sides are authored decimals written by hand;
  // a difference of any size is a disagreement, not measurement noise.
  test('the board rect matches TRADING_FLOOR_SCREEN exactly', () => {
    expect(extras!.screen).toEqual({
      width: TRADING_FLOOR_SCREEN.width,
      height: TRADING_FLOOR_SCREEN.height,
      bottomY: TRADING_FLOOR_SCREEN.bottomY,
      z: TRADING_FLOOR_SCREEN.z,
    });
  });

  test('the kiosk block matches TRADING_FLOOR_MONITOR exactly', () => {
    expect(extras!.kiosk).toEqual({
      x: TRADING_FLOOR_MONITOR.x,
      y: 0,
      z: TRADING_FLOOR_MONITOR.z,
      rotY: TRADING_FLOOR_MONITOR.rotY,
      halfX: TRADING_FLOOR_MONITOR.halfX,
      halfZ: TRADING_FLOOR_MONITOR.halfZ,
      height: TRADING_FLOOR_MONITOR.height,
    });
  });

  test('the hall matches TRADING_FLOOR_ROOM exactly', () => {
    expect(extras!.room).toEqual({
      halfX: TRADING_FLOOR_ROOM.halfX,
      halfZ: TRADING_FLOOR_ROOM.halfZ,
      height: TRADING_FLOOR_ROOM.height,
    });
  });

  /**
   * The authored contract against the SHIPPED mesh, which is a different
   * comparison and needs a different tolerance.
   *
   * `extras.kiosk.halfX` is 64.49 from pre-quantization floats; measuring the
   * shipped mesh through dequantized accessors gives 64.478. The 0.01 is the
   * `KHR_mesh_quantization` round-trip, not a defect — an exact assert here
   * would go red on quantizer noise. 0.05 is wide enough for the round-trip and
   * far under the 1 wu that could make a collider wrong.
   */
  const QUANTIZER_TOL = 0.05;

  test('the authored kiosk contract survives quantization into the mesh', () => {
    const half = worldHalfExtents(nodeByName('TradingFloorMonitorStation'));
    expect(Math.abs(half.x - extras!.kiosk!.halfX)).toBeLessThan(QUANTIZER_TOL);
    expect(Math.abs(half.z - extras!.kiosk!.halfZ)).toBeLessThan(QUANTIZER_TOL);
    expect(Math.abs(half.y * 2 - extras!.kiosk!.height)).toBeLessThan(QUANTIZER_TOL);
  });

  // The board plane has to sit INSIDE its surround opening, which is the failure
  // that actually shipped for one round.
  test('the board plane fits the surround the asset frames', () => {
    const top = extras!.screen!.bottomY + extras!.screen!.height;
    expect(TRADING_FLOOR_SCREEN.bottomY).toBeGreaterThanOrEqual(extras!.screen!.bottomY);
    expect(TRADING_FLOOR_SCREEN.bottomY + TRADING_FLOOR_SCREEN.height).toBeLessThanOrEqual(top);
    // And the surround's outer edge still clears the ceiling: bottom + h + 68.
    expect(top + TRADING_FLOOR_SCREEN_FRAME_WIDTH).toBeLessThanOrEqual(TRADING_FLOOR_ROOM.height);
  });
});

describe('Trading Floor asset — the node names the scene resolves', () => {
  // `buildInstancedRow` and `RoomShell` look these up by name. A rename in the
  // build script degrades to "no desks" at runtime with only a console warning,
  // which is exactly the kind of regression that reaches staging.
  test.each([
    ['TradingFloorConsoleModule'],
    ['TradingFloorChairModule'],
    ['TradingFloorMonitorStation'],
    ['TradingFloorHoloDais'],
    ['TradingFloorWalls'],
    ['TradingFloorCeiling'],
    ['TradingFloorFloorSlab'],
    ['TradingFloorBrass'],
    ['TradingFloorClaws'],
    ['TradingFloorIdentity'],
  ])('%s exists', (name) => {
    expect(() => nodeByName(name)).not.toThrow();
  });

  // The row applies `scale.x` to all three axes, so a non-uniform node would
  // render at the wrong size on the other two.
  test('every prop node has a uniform scale', () => {
    for (const name of [
      'TradingFloorConsoleModule',
      'TradingFloorChairModule',
      'TradingFloorMonitorStation',
      'TradingFloorHoloDais',
    ]) {
      const scale = nodeByName(name).scale ?? [1, 1, 1];
      expect({ name, spread: Math.max(...scale) - Math.min(...scale) }).toEqual({
        name,
        spread: 0,
      });
    }
  });
});

describe('Trading Floor asset — instanced props sit where the row expects', () => {
  // The build script parks the single authored copy on slot 0 of the row. This
  // is the anchor `validateAuthoredProp`'s fatal rule compares against at
  // runtime; here it is checked against the real bytes.
  test('the console node is parked on slot 0 of the desk row', () => {
    const at = translation(nodeByName('TradingFloorConsoleModule'));
    expect(Math.abs(at.x - TRADING_FLOOR_CONSOLE_ROW[0]!.x)).toBeLessThan(TOL);
    expect(Math.abs(at.z - TRADING_FLOOR_CONSOLE_ROW[0]!.z)).toBeLessThan(TOL);
  });

  test('the chair node is parked at the origin', () => {
    const at = translation(nodeByName('TradingFloorChairModule'));
    expect(Math.abs(at.x)).toBeLessThan(TOL);
    expect(Math.abs(at.z)).toBeLessThan(TOL);
  });

  test('the console footprint matches the collider constants', () => {
    const half = worldHalfExtents(nodeByName('TradingFloorConsoleModule'));
    expect(Math.abs(half.x - TRADING_FLOOR_CONSOLE_HALF_X)).toBeLessThan(TOL);
    expect(Math.abs(half.z - TRADING_FLOOR_CONSOLE_HALF_Z)).toBeLessThan(TOL);
    // Height feeds the camera's X bound: the camera's own Y floor is 140, and
    // the desks being TALLER than that is why the bound is the desk face.
    expect(Math.abs(half.y * 2 - TRADING_FLOOR_CONSOLE_HEIGHT)).toBeLessThan(TOL);
  });

  test('the chair footprint matches the half-width the seat offset derives from', () => {
    const half = worldHalfExtents(nodeByName('TradingFloorChairModule'));
    expect(Math.abs(half.x - TRADING_FLOOR_CHAIR_HALF_X)).toBeLessThan(TOL);
    expect(Math.abs(half.z - TRADING_FLOOR_CHAIR_HALF_Z)).toBeLessThan(TOL);
  });

  // The seating Y is READ off the node at runtime rather than hardcoded, and
  // that is only correct because the quantizer puts the base-centring term
  // there. If a prop ever shipped with node Y 0, the row would sink into the
  // floor by half its height.
  //
  // Both v4 modules start at y=0. Only quantizer noise is permitted.
  test('both instanced props carry their base-seating offset on the node', () => {
    for (const name of ['TradingFloorConsoleModule', 'TradingFloorChairModule']) {
      const node = nodeByName(name);
      const base = translation(node).y - worldHalfExtents(node).y;
      expect({ name, sunkBy: Math.abs(base) < TOL }).toEqual({ name, sunkBy: true });
    }
  });
});

type Point = [number, number, number];

const decodedAsset = (async () => {
  await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder }).read(GLB_PATH);
})();

/** World-space vertices after meshopt decoding, including the quantizer transform. */
async function assetVertices(name: string) {
  const doc = await decodedAsset;
  const node = doc.getRoot().listNodes().find((candidate) => candidate.getName() === name)!;
  const primitive = node.getMesh()!.listPrimitives()[0]!;
  const positions = primitive.getAttribute('POSITION')!;
  const normals = primitive.getAttribute('NORMAL');
  const colors = primitive.getAttribute('COLOR_0');
  const world = node.getWorldMatrix();
  const vertices = Array.from({ length: positions.getCount() }, (_, index) => {
    const p = positions.getElement(index, []), n = normals?.getElement(index, []) ?? [0, 1, 0];
    const direction = [0, 1, 2].map((axis) =>
      world[axis]! * n[0]! + world[4 + axis]! * n[1]! + world[8 + axis]! * n[2]!);
    const length = Math.hypot(...direction);
    return {
      p: [0, 1, 2].map((axis) => world[12 + axis]! + world[axis]! * p[0]! +
        world[4 + axis]! * p[1]! + world[8 + axis]! * p[2]!) as Point,
      n: direction.map((v) => v / length) as Point,
      color: colors?.getElement(index, [] as number[]),
    };
  });
  return { vertices, primitive };
}

/** Clip to camera height before checking a triangle's complete axis interval.
 * A face can cross a camera plane without having a vertex near that plane. */
function triangleCameraMargins(triangle: Point[]): number[] {
  const maximumY = TRADING_FLOOR_CAMERA.above + TRADING_FLOOR_CAMERA.pitchMax;
  const clip = (polygon: Point[], axis: number, boundary: number, sign: number) => {
    const result: Point[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
      const da = (a[axis]! - boundary) * sign, db = (b[axis]! - boundary) * sign;
      if (da >= 0) result.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        result.push(a.map((value, coordinate) => value + (b[coordinate]! - value) * t) as Point);
      }
    }
    return result;
  };
  const belowCamera = clip(triangle, 1, maximumY, -1);
  return ([
    [0, -1, TRADING_FLOOR_ROOM.halfX, TRADING_FLOOR_DESK_INNER_X],
    [0, 1, TRADING_FLOOR_ROOM.halfX, TRADING_FLOOR_DESK_INNER_X],
    [2, -1, TRADING_FLOOR_ROOM.halfZ, -TRADING_FLOOR_CAMERA_Z_MIN],
    [2, 1, TRADING_FLOOR_ROOM.halfZ, TRADING_FLOOR_CAMERA_Z_MAX],
  ] as const).map(([axis, sign, innerFace, limit]) => {
    // Include the 6 wu margin beyond the reachable slab to catch corner faces.
    // A back-wall face beyond that band is not an X-plane intrusion.
    const tangent = axis === 0 ? 2 : 0;
    const tangentMin = axis === 0 ? TRADING_FLOOR_CAMERA_Z_MIN : -TRADING_FLOOR_DESK_INNER_X;
    const tangentMax = axis === 0 ? TRADING_FLOOR_CAMERA_Z_MAX : TRADING_FLOOR_DESK_INNER_X;
    const clipped = clip(clip(belowCamera, tangent, tangentMin - 6, 1), tangent, tangentMax + 6, -1);
    const values = clipped.map((p) => p[axis] * sign);
    const min = Math.min(...values), max = Math.max(...values);
    const inBand = values.some((v) => v >= limit - 6 && v <= innerFace);
    const crossesLimit = min <= limit && max >= limit;
    return inBand || crossesLimit ? min - limit : Infinity;
  });
}

describe('Trading Floor asset — A3 camera clearance and claw sculpt', () => {
  test('a synthetic corner triangle inside the 6 wu margin fails the margin gate', () => {
    const margins = triangleCameraMargins([
      [TRADING_FLOOR_DESK_INNER_X + 5, 270, TRADING_FLOOR_CAMERA_Z_MIN - 2],
      [TRADING_FLOOR_DESK_INNER_X + 5, 300, TRADING_FLOOR_CAMERA_Z_MIN - 2],
      [TRADING_FLOOR_DESK_INNER_X + 10, 270, TRADING_FLOOR_CAMERA_Z_MIN - 6],
    ]);
    expect(Number.isFinite(margins[1])).toBe(true);
    expect(Number.isFinite(margins[2])).toBe(true);
    expect(margins[1]).toBe(5);
    expect(margins[2]).toBe(2);
    expect(() => expect(Math.min(...margins)).toBeGreaterThanOrEqual(6)).toThrow();
  });

  test('a synthetic back-wall triangle that crosses the camera plane fails the margin gate', () => {
    const wallZ = -TRADING_FLOOR_ROOM.halfZ;
    const crossingZ = TRADING_FLOOR_CAMERA_Z_MIN + 14;
    const cameraTop = TRADING_FLOOR_CAMERA.above + TRADING_FLOOR_CAMERA.pitchMax;
    // Its wall-side vertices clear by 46 wu. Its room-side vertex crosses by 14.
    const margins = triangleCameraMargins([[0, 270, wallZ], [20, cameraTop, crossingZ], [40, 270, wallZ]]);
    expect(margins[2]).toBe(-14);
    expect(() => expect(margins[2]).toBeGreaterThanOrEqual(6)).toThrow();
    // Also catch a tall triangle whose wall-side vertices sit above camera height.
    expect(triangleCameraMargins([[0, cameraTop + 90, wallZ], [20, 270, crossingZ], [40, cameraTop + 90, wallZ]])[2]).toBe(-14);
    expect(triangleCameraMargins([[0, cameraTop + 1, wallZ], [20, cameraTop + 90, crossingZ], [40, cameraTop + 1, wallZ]])).toEqual(
      [Infinity, Infinity, Infinity, Infinity]);
    // A back-wall strip crosses both X planes but stays outside reachable Z.
    const backWall = triangleCameraMargins([[-TRADING_FLOOR_ROOM.halfX, 270, wallZ], [TRADING_FLOOR_ROOM.halfX, 270, wallZ], [TRADING_FLOOR_ROOM.halfX, cameraTop, wallZ]]);
    expect(backWall[0]).toBe(Infinity); expect(backWall[1]).toBe(Infinity);
    expect(backWall[2]).toBe(TRADING_FLOOR_PLAYER_RADIUS);
  });

  test('all four wall bands clear the camera by at least 6 wu below its maximum height', async () => {
    const doc = await decodedAsset;
    const maximumY = TRADING_FLOOR_CAMERA.above + TRADING_FLOOR_CAMERA.pitchMax;
    const failures: string[] = [], margins = [Infinity, Infinity, Infinity, Infinity];
    for (const node of doc.getRoot().listNodes()) {
      // The floor spans every wall band but sits below the camera's Y floor.
      // Desk/chair source templates never render; the row rotates their copies.
      // Their decoded extents and actual row camera clamps have separate tests.
      // The wall-backed kiosk uses a dedicated camera solid; its sweep pins clearance.
      if (!node.getMesh() || ['TradingFloorFloorSlab', 'TradingFloorConsoleModule',
        'TradingFloorChairModule', 'TradingFloorMonitorStation'].includes(node.getName())) continue;
      const { vertices, primitive } = await assetVertices(node.getName());
      const indices = primitive.getIndices()!.getArray()!;
      for (let i = 0; i < indices.length; i += 3) {
        const triangle = [0, 1, 2].map((corner) => vertices[indices[i + corner]!]!.p);
        const candidates = triangleCameraMargins(triangle);
        candidates.forEach((margin, wall) => {
          margins[wall] = Math.min(margins[wall]!, margin);
          if (margin < 6) failures.push(`${node.getName()} triangle ${i / 3} wall ${wall}: margin ${margin}`);
        });
      }
    }
    expect(margins.every(Number.isFinite)).toBe(true);
    console.log(`wall camera margins left/right/back/front: ${margins.map((v) => v.toFixed(4)).join('/')} wu; y <= ${maximumY}`);
    expect(failures).toEqual([]);
  });

  // R1 must re-measure the decoded claw triangle totals and inversion limit.
  test('each claw has at most 40 inverted or degenerate triangles after per-mesh quantization', async () => {
    const { vertices, primitive } = await assetVertices('TradingFloorClaws');
    const indices = primitive.getIndices()!.getArray()!;
    const counts = [0, 0], totals = [0, 0];
    for (let i = 0; i < indices.length; i += 3) {
      const corners = [0, 1, 2].map((j) => vertices[indices[i + j]!]!);
      const claw = extras!.statue!.claws.findIndex((bounds) => corners.every(({ p }) =>
        p.every((v, axis) => v >= bounds.min[axis]! - .2 && v <= bounds.max[axis]! + .2)));
      if (claw < 0) continue;
      totals[claw]!++;
      const [a, b, c] = corners;
      const u = b!.p.map((v, axis) => v - a!.p[axis]!), v = c!.p.map((p, axis) => p - a!.p[axis]!);
      const face = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      if (Math.hypot(...face) <= 1e-8 || corners.some(({ n }) =>
        face.reduce((sum, value, axis) => sum + value * n[axis]!, 0) <= 0)) counts[claw]!++;
    }
    for (const total of totals) expect(total).toBeGreaterThan(2000);
    for (const count of counts) expect(count).toBeLessThanOrEqual(40);
    console.log(`claw inverted/degenerate triangles: ${counts.join('/')} of ${totals.join('/')}; maximum 40 each`);
  });

  // R1 must re-measure the decoded claw and combined vertex budgets.
  test('brass factors stay unchanged and both claws retain compact indexing without vertex colors', async () => {
    const { vertices, primitive } = await assetVertices('TradingFloorBrass');
    expect(primitive.getAttribute('COLOR_0')).toBeNull();
    expect(primitive.getMaterial()!.getExtension('KHR_materials_unlit')).toBeNull();
    expect(primitive.getMaterial()!.getBaseColorFactor()).toEqual([.75, .53, .16, 1]);
    expect(primitive.getMaterial()!.getEmissiveFactor()).toEqual([.13, .095, .032]);
    expect(primitive.getMaterial()!.getRoughnessFactor()).toBe(.32);
    expect(primitive.getMaterial()!.getMetallicFactor()).toBe(.25);
    const claws = await assetVertices('TradingFloorClaws');
    expect(claws.primitive.getAttribute('COLOR_0')).toBeNull();
    const clawCounts = [0, 0];
    for (const { p } of claws.vertices) {
      const index = extras!.statue!.claws.findIndex((bounds) =>
        p.every((v, axis) => v >= bounds.min[axis]! - .2 && v <= bounds.max[axis]! + .2));
      expect(index).toBeGreaterThanOrEqual(0);
      clawCounts[index]!++;
    }
    expect(clawCounts.every((count) => count > 2000 && count <= 2250)).toBe(true);
    // R3: 5,500 -> 6,536; 36 capped cylinders add exactly 1,152 indexed vertices.
    expect(vertices.length + claws.vertices.length).toBeLessThanOrEqual(6536);
    console.log(`indexed brass vertices ${vertices.length}; claw vertices ${clawCounts.join('/')} (total ${claws.vertices.length})`);
  });

  test('the shipped claws copy the exterior material factors and have no COLOR_0', async () => {
    const interior = await decodedAsset;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const exteriorJson = await io.readAsJSON(join(GLB_PATH, '..', 'trading-floor-exterior-opt1-mo-ktx.glb'));
    const exterior = await io.readJSON(exteriorJson);
    const source = exterior.getRoot().listMaterials()
      .find((material) => material.getName() === 'TradingFloorClawMtl');
    const material = interior.getRoot().listMaterials()
      .find((candidate) => candidate.getName() === 'TradingFloorClawMtl');
    expect(source).toBeDefined();
    expect(material).toBeDefined();
    // PBR factors stay in JSON; geometry quantization adds no material noise.
    const actual = [...material!.getBaseColorFactor(), ...material!.getEmissiveFactor(),
      material!.getRoughnessFactor(), material!.getMetallicFactor()];
    const expected = [...source!.getBaseColorFactor(), ...source!.getEmissiveFactor(),
      source!.getRoughnessFactor(), source!.getMetallicFactor()];
    for (let index = 0; index < actual.length; index++)
      expect(Math.abs(actual[index]! - expected[index]!)).toBeLessThanOrEqual(1e-6);
    expect(material!.getDoubleSided()).toBe(source!.getDoubleSided());
    expect(material!.getAlphaMode()).toBe(source!.getAlphaMode());
    expect(source!.getAlphaMode()).toBe('OPAQUE');
    expect(material!.listExtensions().map((extension) => extension.extensionName).sort())
      .toEqual(source!.listExtensions().map((extension) => extension.extensionName).sort());
    expect(source!.listExtensions()).toHaveLength(0);
    // Compare raw extensions too: the decoder can ignore unknown extensions.
    const sourceExtensions = exteriorJson.json.materials!
      .find((candidate) => candidate.name === 'TradingFloorClawMtl')!.extensions ?? {};
    expect(gltf.materials.find((candidate) => candidate.name === 'TradingFloorClawMtl')!.extensions ?? {})
      .toEqual(sourceExtensions);
    expect(Object.keys(sourceExtensions)).toHaveLength(0);
    expect(material!.getExtension('KHR_materials_unlit')).toBeNull();
    for (const candidate of [source!, material!])
      for (const texture of [candidate.getBaseColorTexture(), candidate.getEmissiveTexture(),
        candidate.getMetallicRoughnessTexture(), candidate.getNormalTexture(), candidate.getOcclusionTexture()])
        expect(texture).toBeNull();
    const mesh = interior.getRoot().listMeshes().find((candidate) => candidate.getName() === 'TradingFloorClaws');
    expect(mesh).toBeDefined();
    expect(mesh!.listPrimitives()).toHaveLength(1);
    const primitive = mesh!.listPrimitives()[0]!;
    expect(primitive.getMaterial()).toBe(material!);
    expect(primitive.getAttribute('COLOR_0')).toBeNull();
  });

  test('portal contacts have deliberate clearance and the plate fits the lowest tier', async () => {
    const brass = (await assetVertices('TradingFloorBrass')).vertices.map(({ p }) => p);
    const walls = (await assetVertices('TradingFloorWalls')).vertices.map(({ p }) => p);
    const trim = (await assetVertices('TradingFloorTrimGlow')).vertices;
    const jamb = brass.filter(([x, y, z]) => Math.abs(x) > 176 && Math.abs(x) < 208 && y < 501 && z > TRADING_FLOOR_DOOR.z - 10 && z < TRADING_FLOOR_DOOR.z + 7);
    // Only the room-facing front wall at z=1100 supplies the visible reveal.
    // Rear/hidden wall faces cannot substitute for this opening.
    const reveal = walls.filter(([x, y, z]) => Math.abs(x) > 100 && Math.abs(x) < 300 && y < 410 && z > TRADING_FLOOR_DOOR.z - 1 && z < TRADING_FLOOR_DOOR.z + 1);
    const header = brass.filter(([x, y, z]) => Math.abs(x) < 209 && y > 490 && y < 505 && z > TRADING_FLOOR_DOOR.z - 15 && z < TRADING_FLOOR_DOOR.z + 7);
    const lintel = walls.filter(([x, y, z]) => Math.abs(x) < 200 && y > 490 && y < 510 && z > TRADING_FLOOR_DOOR.z - 1);
    for (const points of [jamb, reveal, header, lintel]) expect(points.length).toBeGreaterThan(0);
    const jambInner = Math.min(...jamb.map(([x]) => Math.abs(x)));
    const revealInner = Math.min(...reveal.map(([x]) => Math.abs(x)));
    const headerBottom = Math.min(...header.map((p) => p[1]));
    const lintelBottom = Math.min(...lintel.map((p) => p[1]));
    const lintelEdge = Math.min(...lintel.map(([x]) => Math.abs(x)));
    expect(Math.abs(revealInner * 2 - TRADING_FLOOR_DOOR.width)).toBeLessThan(.2);
    expect(Math.abs(jambInner - revealInner)).toBeGreaterThanOrEqual(2);
    expect(lintelEdge - jambInner).toBeGreaterThanOrEqual(2);
    expect(lintelBottom - headerBottom).toBeGreaterThanOrEqual(2);
    const railFront = brass.filter(([x, y, z]) => Math.abs(x) > 181 && Math.abs(x) < TRADING_FLOOR_ROOM.halfX + 1 &&
      y > TRADING_FLOOR_ROOM.height * 296 / 950 - TRADING_FLOOR_ROOM.height * 9 / 950 - 1 &&
      y < TRADING_FLOOR_ROOM.height * 296 / 950 + TRADING_FLOOR_ROOM.height * 9 / 950 + 1 && z > TRADING_FLOOR_DOOR.z - 6 && z < TRADING_FLOOR_DOOR.z - 4);
    expect(railFront.length).toBeGreaterThan(0);
    expect(Math.min(...railFront.map(([x]) => Math.abs(x)))).toBeCloseTo(182, 0);
    // The authored 2 wu gap permits .2 wu of room-wide quantization noise.
    expect(Math.min(...railFront.map(([x]) => Math.abs(x))) - revealInner).toBeGreaterThanOrEqual(1.8);
    expect(Math.min(...railFront.map((p) => p[2])) - Math.min(...jamb.map((p) => p[2]))).toBeGreaterThan(.3);
    expect(Math.max(...jamb.map((p) => p[2])) - Math.min(...jamb.map((p) => p[2]))).toBeCloseTo(11, 0);
    const standoffs = brass.filter(([x, y, z]) => Math.abs(x) > 18 && Math.abs(x) < 30 && y > 174 && y < 186 && z > TRADING_FLOOR_DOOR.z + 10 && z < TRADING_FLOOR_DOOR.z + 31);
    const glass = trim.filter(({ p: [x, y, z], color }) =>
      Math.abs(x) < 180 && y > 10 && y < 490 && z > TRADING_FLOOR_DOOR.z + 27 && color![0]! < .025);
    expect(standoffs.length).toBeGreaterThan(0); expect(glass.length).toBeGreaterThan(0);
    const standoffBack = Math.max(...standoffs.map((p) => p[2]));
    const glassFront = Math.min(...glass.map(({ p }) => p[2]));
    // A small insertion removes the gap; separate contact planes cannot flicker.
    expect(standoffBack - glassFront).toBeGreaterThan(.2);
    expect(standoffBack - glassFront).toBeLessThan(2);
    const plate = brass.filter(([x, y, z]) => Math.abs(x) < 131 && y > 3 && y < 29 && z > TRADING_FLOOR_DAIS.z + TRADING_FLOOR_DAIS.halfZ - 1.5 && z < TRADING_FLOOR_DAIS.z + TRADING_FLOOR_DAIS.halfZ + 3);
    expect(plate.length).toBeGreaterThan(0);
    expect(Math.min(...plate.map((p) => p[1]))).toBeGreaterThan(3);
    expect(Math.max(...plate.map((p) => p[1]))).toBeLessThan(29);
    expect(plate.every(([x, , z]) => Math.hypot(x - DECOR_SEAL.x, z - DECOR_SEAL.z) < DECOR_SEAL.innerRadius)).toBe(true);
    const plateBack = Math.min(...plate.map((p) => p[2])), plateFront = Math.max(...plate.map((p) => p[2]));
    expect(plateFront - plateBack).toBeCloseTo(3, 0);
    expect(plateFront).toBeCloseTo(TRADING_FLOOR_DAIS.z + TRADING_FLOOR_DAIS.halfZ + 2, 0);
    expect(plateFront - (TRADING_FLOOR_DAIS.z + TRADING_FLOOR_DAIS.halfZ)).toBeCloseTo(2, 0);
    console.log(`portal: jamb x +/-${jambInner.toFixed(4)}, wall reveal +/-${revealInner.toFixed(4)}, lintel edge +/-${lintelEdge.toFixed(4)}; header/lintel y ${headerBottom.toFixed(4)}/${lintelBottom.toFixed(4)}; standoff/glass z ${standoffBack.toFixed(4)}/${glassFront.toFixed(4)}`);
    console.log(`plate y ${Math.min(...plate.map((p) => p[1])).toFixed(4)}..${Math.max(...plate.map((p) => p[1])).toFixed(4)}, z ${Math.min(...plate.map((p) => p[2])).toFixed(4)}..${Math.max(...plate.map((p) => p[2])).toFixed(4)}`);
  });
});

/** Undo quantization and the template anchor, exactly as the row does. */
async function moduleTriangles(name: string): Promise<Point[][]> {
  const doc = await decodedAsset;
  const node = doc.getRoot().listNodes().find((candidate) => candidate.getName() === name)!;
  const primitive = node.getMesh()!.listPrimitives()[0]!;
  const positions = primitive.getAttribute('POSITION')!;
  const world = node.getWorldMatrix();
  const at = node.getTranslation();
  const vertices = Array.from({ length: positions.getCount() }, (_, index): Point => {
    const p = positions.getElement(index, []);
    return [0, 1, 2].map((axis) => world[12 + axis]! +
      world[axis]! * p[0]! + world[4 + axis]! * p[1]! + world[8 + axis]! * p[2]! -
      (axis === 1 ? 0 : at[axis]!)) as Point;
  });
  const indices = primitive.getIndices()!.getArray()!;
  return Array.from({ length: indices.length / 3 }, (_, index) =>
    [0, 1, 2].map((corner) => vertices[indices[index * 3 + corner]!]!));
}

/** Height of the uppermost triangle over a desk-local point. */
function surfaceY(triangles: Point[][], x: number, z: number, ceiling = Infinity): number {
  let top = -Infinity;
  for (const [a, b, c] of triangles) {
    const det = (b![2] - c![2]) * (a![0] - c![0]) + (c![0] - b![0]) * (a![2] - c![2]);
    if (Math.abs(det) < 1e-8) continue;
    const u = ((b![2] - c![2]) * (x - c![0]) + (c![0] - b![0]) * (z - c![2])) / det;
    const v = ((c![2] - a![2]) * (x - c![0]) + (a![0] - c![0]) * (z - c![2])) / det;
    if (Math.min(u, v, 1 - u - v) < -0.0001) continue;
    const y = u * a![1] + v * b![1] + (1 - u - v) * c![1];
    if (y <= ceiling) top = Math.max(top, y);
  }
  return top;
}

/** Clip whole triangles to the mount corridor. Vertex-only tests miss a broad
 * hood or a sloped face whose vertices all sit outside the corridor. */
function clipToMount(triangle: Point[]): Point[] {
  let polygon = triangle;
  for (const [axis, boundary, direction] of [[0, -60, 1], [0, 60, -1],
    [2, DECOR_DESK_HOOD.minLocalZ, 1], [2, -100, -1]]) {
    const clipped: Point[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index]!, b = polygon[(index + 1) % polygon.length]!;
      const da = (a[axis!]! - boundary!) * direction!;
      const db = (b[axis!]! - boundary!) * direction!;
      if (da >= 0) clipped.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        clipped.push(a.map((v, i) => v + (b[i]! - v) * t) as Point);
      }
    }
    polygon = clipped;
  }
  return polygon;
}

describe('Trading Floor asset — v4 desk and leather chair', () => {
  test('algae tiles belong only to lower cabinet faces and drawer fronts, never upward faces', async () => {
    const { vertices, primitive } = await assetVertices('TradingFloorConsoleModule');
    const uv = primitive.getAttribute('TEXCOORD_0')!;
    const indices = primitive.getIndices()!.getArray()!;
    const counts = [0, 0];
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const corners = Array.from({ length: 3 }, (_, corner) => indices[triangle + corner]!);
      const tile = corners.map((index) => {
        const [u, v] = uv.getElement(index, [] as number[]);
        if (v! < 168 / 256 || v! > 248 / 256) return -1;
        if (u! >= 336 / 512 && u! <= 416 / 512) return 0;
        if (u! >= 424 / 512 && u! <= 504 / 512) return 1;
        return -1;
      });
      if (tile.every((region) => region === -1)) continue;
      expect(tile.every((region) => region === tile[0])).toBe(true);
      const region = tile[0]!;
      counts[region]!++;
      const points = corners.map((index) => vertices[index]!);
      expect(Math.min(...points.map(({ p }) => p[1]))).toBeLessThanOrEqual(region ? 24.02 : 16.02);
      for (const [corner, index] of corners.entries()) {
        const { p, n } = points[corner]!;
        expect(n[1]).toBeLessThanOrEqual(.001);
        expect(p[1]).toBeLessThanOrEqual(region ? 110.02 : 116.02);
        const v = uv.getElement(index, [])[1]! * 256;
        // Affine Y-to-V mapping confines every sample of the painted band
        // (image rows 232..248) below y19.34 / drawer y38.34, even mid-triangle.
        const expectedY = (244 - v) / 72 * (region ? 86 : 116) + (region ? 24 : 0);
        // Decoded UV/position quantization measures .040583 wu worst-case.
        expect(Math.abs(p[1] - expectedY)).toBeLessThan(.05);
        if (region) expect(n[2]).toBeGreaterThan(.99);
      }
    }
    expect(counts).toEqual([50, 4]);
  });

  // R1 must re-measure the module triangle pins, texture bytes and GLB budgets.
  test('one primitive per row, module budgets and atlas size survive compression', async () => {
    const doc = await decodedAsset;
    for (const [name, budget] of [['TradingFloorConsoleModule', 1500], ['TradingFloorChairModule', 900]] as const) {
      const node = doc.getRoot().listNodes().find((candidate) => candidate.getName() === name)!;
      const primitives = node.getMesh()!.listPrimitives();
      expect(primitives).toHaveLength(1);
      expect(primitives[0]!.getIndices()!.getCount() / 3).toBeLessThanOrEqual(budget);
      expect(primitives[0]!.getIndices()!.getCount() / 3).toBe(name === 'TradingFloorChairModule' ? 864 : 980);
      expect(node.getRotation()).toEqual([0, 0, 0, 1]);
    }
    const desk = doc.getRoot().listMaterials().find((material) => material.getName() === 'TradingFloorConsoleModuleMtl')!;
    expect(desk.getBaseColorTexture()!.getSize()).toEqual([512, 256]);
    expect(desk.getBaseColorTexture()!.getImage()!.byteLength).toBeLessThan(16000);
    const chair = doc.getRoot().listMaterials().find((material) => material.getName() === 'TradingFloorChair')!;
    expect(chair.getRoughnessFactor()).toBe(0.48);
    expect(chair.getMetallicFactor()).toBe(0.18);
    expect(readFileSync(GLB_PATH).byteLength).toBeLessThanOrEqual(500000);
    const total = doc.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())
      .reduce((sum, primitive) => sum + primitive.getIndices()!.getCount() / 3, 0);
    expect(total).toBeLessThanOrEqual(32000);
  });

  test('the complete flat hood supports the runtime mount and nothing crosses its corridor', async () => {
    const triangles = await moduleTriangles('TradingFloorConsoleModule');
    const heights: number[] = [];
    for (const x of [-60, -30, 0, 30, 60]) {
      for (const z of [-135, -128, -120, -110]) {
        const y = surfaceY(triangles, x, z);
        heights.push(y);
        expect(y).toBeGreaterThanOrEqual(164);
        expect(y).toBeLessThanOrEqual(DECOR_DESK_HOOD.topY + 0.02);
      }
    }
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.02);
    const corridor = triangles.flatMap(clipToMount);
    expect(corridor.length).toBeGreaterThan(0);
    const top = Math.max(...corridor.map((p) => p[1]));
    expect(top).toBeLessThanOrEqual(166.02);
    for (const x of [-DECOR_BANK.plate.halfX, 0, DECOR_BANK.plate.halfX]) {
      const top = surfaceY(triangles, x, DECOR_BANK.plate.centerZ);
      expect(top).toBeGreaterThan(DECOR_BANK.footY);
      expect(top).toBeLessThan(DECOR_BANK.plate.topY);
    }
    console.log(`desk hood sampled y ${Math.min(...heights).toFixed(4)}..${Math.max(...heights).toFixed(4)}; corridor top ${top.toFixed(4)}`);
  });

  test('the flat cushion stays at seat y85 and casters meet the floor', async () => {
    const triangles = await moduleTriangles('TradingFloorChairModule');
    for (const x of [-30, 0, 30]) for (const z of [0, 20, 35]) {
      expect(Math.abs(surfaceY(triangles, x, z, 90) - TRADING_FLOOR_CHAIR_SEAT_Y)).toBeLessThan(0.02);
    }
    const points = triangles.flat();
    expect(Math.abs(Math.min(...points.map((p) => p[1])))).toBeLessThan(0.02);
    expect(Math.max(...points.map((p) => p[1]))).toBeCloseTo(174, 2);
    for (const axis of [0, 2]) {
      const half = axis === 0 ? TRADING_FLOOR_CHAIR_HALF_X : TRADING_FLOOR_CHAIR_HALF_Z;
      expect(Math.abs(Math.min(...points.map((p) => p[axis]!)) + half)).toBeLessThan(TOL);
      expect(Math.abs(Math.max(...points.map((p) => p[axis]!)) - half)).toBeLessThan(TOL);
    }
  });

  test('arm posts enter the cushion and arm pads within the chair footprint', async () => {
    const { vertices } = await assetVertices('TradingFloorChairModule');
    for (const side of [-1, 1]) {
      const posts = vertices.filter(({ p, color }) => side * p[0] > 49 && side * p[0] < 59 &&
        p[1] > 60 && p[2] > 10 && p[2] < 20 && Math.abs(color![0]! - 110 / 255) < 1e-6 &&
        Math.abs(color![1]! - 125 / 255) < 1e-6);
      // R1 must re-measure this decoded arm-post vertex count.
      expect(posts).toHaveLength(24);
      for (const [axis, low, high] of [[0, 50, 58], [1, 64, 100], [2, 11, 19]] as const) {
        const values = posts.map(({ p }) => axis === 0 ? side * p[0] : p[axis]);
        expect(Math.abs(Math.min(...values) - low)).toBeLessThan(0.02);
        expect(Math.abs(Math.max(...values) - high)).toBeLessThan(0.02);
      }
    }
  });

  test('the brass hood strip meets the hood without overlapping its top', async () => {
    const { vertices, primitive } = await assetVertices('TradingFloorConsoleModule');
    const uv = primitive.getAttribute('TEXCOORD_0')!;
    const strip = vertices.filter(({ p }, i) => p[1] > 161 && p[2] > TRADING_FLOOR_CONSOLE_ROW[0]!.z - 101 && p[2] < TRADING_FLOOR_CONSOLE_ROW[0]!.z - 97 &&
      Math.abs(uv.getElement(i, [])[0]! - 416 / 512) < 0.001);
    // R1 must re-measure this decoded hood-strip vertex count.
    expect(strip).toHaveLength(24);
    expect(Math.abs(Math.min(...strip.map(({ p }) => p[2])) - (TRADING_FLOOR_CONSOLE_ROW[0]!.z - 100))).toBeLessThan(0.02);
    expect(Math.abs(Math.max(...strip.map(({ p }) => p[2])) - (TRADING_FLOOR_CONSOLE_ROW[0]!.z - 98))).toBeLessThan(0.02);
  });

  test('desktop end faces map wood grain across depth instead of a constant u', async () => {
    const { vertices, primitive } = await assetVertices('TradingFloorConsoleModule');
    const uv = primitive.getAttribute('TEXCOORD_0')!;
    const ends = vertices.flatMap(({ p, n }, i) => {
      if (Math.abs(p[0] - TRADING_FLOOR_CONSOLE_ROW[0]!.x) < TRADING_FLOOR_CONSOLE_HALF_X - 0.05 || Math.abs(n[0]) < 0.99) return [];
      const u = uv.getElement(i, [])[0]!;
      if (u > 320 / 512) return []; // Exclude the brass desktop lip swatch.
      expect(Math.abs(u - (8 + ((p[2] - TRADING_FLOOR_CONSOLE_ROW[0]!.z + TRADING_FLOOR_CONSOLE_HALF_Z) / (TRADING_FLOOR_CONSOLE_HALF_Z * 2)) * 304) / 512)).toBeLessThan(0.001);
      return [u];
    });
    expect(ends.length).toBeGreaterThanOrEqual(8);
    expect(Math.max(...ends) - Math.min(...ends)).toBeGreaterThan(0.5);
  });

  // R1 must re-measure the 5500 vertex budget, 6040 triangles and 4280 claw vertices.
  test('chairs retain normalized byte colors and claws retain welded sculpt creases', async () => {
    const { vertices, primitive } = await assetVertices('TradingFloorChairModule');
    const colors = primitive.getAttribute('COLOR_0')!;
    expect(colors.getComponentType()).toBe(5121);
    expect(colors.getNormalized()).toBe(true);
    expect(colors.getType()).toBe('VEC3');
    expect(new Set(vertices.map(({ color }) => color!.join(','))).size).toBeGreaterThan(1);
    const brass = await assetVertices('TradingFloorBrass');
    const claws = await assetVertices('TradingFloorClaws');
    // R3: 5,500 -> 6,536 vertices; 6,088 -> 7,096 triangles (+1,008 post triangles).
    expect(brass.vertices.length + claws.vertices.length).toBeLessThanOrEqual(6536);
    expect((brass.primitive.getIndices()!.getCount() + claws.primitive.getIndices()!.getCount()) / 3).toBe(7096);
    // An un-welded build retains 16,536 vertices, one per triangle corner.
    expect(claws.vertices).toHaveLength(4280);
    expect(new Set(claws.vertices.map(({ n }) => n.join(','))).size).toBeGreaterThan(1);
  });
});

describe('Trading Floor asset — the monitor kiosk matches its hotspot', () => {
  test('the kiosk screens face -Z in the actual node transform', () => {
    const rotation = nodeByName('TradingFloorMonitorStation').rotation ?? [0, 0, 0, 1];
    expect(rotation[0]).toBeCloseTo(0, 8);
    expect(Math.abs(rotation[1]!)).toBeCloseTo(1, 8);
    expect(rotation[2]).toBeCloseTo(0, 8);
    expect(rotation[3]).toBeCloseTo(0, 8);
  });

  test('the door-wall kiosk clears the board from spawn, seats and the plinth band', async () => {
    const { vertices } = await assetVertices('TradingFloorMonitorStation');
    // Project actual geometry: the counter front is only 150 wu high, while
    // the 360 wu riser sits at the back. Full-height AABB corners invent shadows.
    const points = [...new Map(vertices.map(({ p }) => [p.join(','), p] as const)).values()];
    const groups: { name: string; bodies: [number, number][]; yawStep: number }[] = [
      { name: 'spawn', bodies: [[TRADING_FLOOR_PLAYER_SPAWN.x, TRADING_FLOOR_PLAYER_SPAWN.z]], yawStep: 2 },
      { name: 'seats', bodies: TRADING_FLOOR_SEATS.map((seat) => [seat.x, seat.z]), yawStep: 5 },
      { name: 'plinth', bodies: [], yawStep: 15 },
      { name: 'distant', bodies: [], yawStep: 15 },
    ];
    for (let x = -TRADING_FLOOR_SIDE_APPROACH_X; x <= TRADING_FLOOR_SIDE_APPROACH_X; x += 48)
      for (let z = TRADING_FLOOR_BOARD_APPROACH_Z; z <= TRADING_FLOOR_DOOR_APPROACH_Z; z += 48) {
        if (tradingFloorHitsSolid(x, z)) continue;
        const dx = Math.max(0, Math.abs(x - TRADING_FLOOR_DAIS.x) - TRADING_FLOOR_DAIS.halfX);
        const dz = Math.max(0, Math.abs(z - TRADING_FLOOR_DAIS.z) - TRADING_FLOOR_DAIS.halfZ);
        if (Math.hypot(dx, dz) <= 300) groups[2]!.bodies.push([x, z]);
        if (TRADING_FLOOR_MONITOR_FRONT_Z - z >= 600)
          groups[3]!.bodies.push([x, z]);
      }
    const camera = { x: 0, y: 0, z: 0 };
    const tanV = Math.tan(TRADING_FLOOR_CAMERA.fov * Math.PI / 360);
    for (const group of groups) {
      let worst = -Infinity, projected = 0, poses = 0;
      for (const [bx, bz] of group.bodies) for (const height of [140, 260, 410])
        for (let deg = 0; deg < 360; deg += group.yawStep) {
          poses++;
          const yaw = deg * Math.PI / 180;
          placeTradingFloorChaseCamera(bx, bz, yaw, height - TRADING_FLOOR_CAMERA.above, camera);
          let fx = bx + Math.sin(yaw) * TRADING_FLOOR_CAMERA.lookAhead - camera.x;
          let fy = TRADING_FLOOR_CAMERA.lookY - camera.y;
          let fz = bz - Math.cos(yaw) * TRADING_FLOOR_CAMERA.lookAhead - camera.z;
          const length = Math.hypot(fx, fy, fz);
          fx /= length; fy /= length; fz /= length;
          const rightLength = Math.hypot(fx, fz), rx = -fz / rightLength, rz = fx / rightLength;
          const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
          for (const [px, py, pz] of points) {
            const t = (TRADING_FLOOR_SCREEN.z - camera.z) / (pz - camera.z);
            if (t < 1 || !Number.isFinite(t)) continue;
            const shadowX = camera.x + (px - camera.x) * t;
            const shadowY = camera.y + (py - camera.y) * t;
            if (Math.abs(shadowX) > TRADING_FLOOR_SCREEN.width / 2) continue;
            const boardY = Math.max(TRADING_FLOOR_SCREEN.bottomY,
              Math.min(TRADING_FLOOR_SCREEN.bottomY + TRADING_FLOOR_SCREEN.height, shadowY));
            const dx = shadowX - camera.x, dy = boardY - camera.y, dz = TRADING_FLOOR_SCREEN.z - camera.z;
            const depth = dx * fx + dy * fy + dz * fz;
            if (depth <= 1 || Math.abs((dx * rx + dz * rz) / depth) > tanV * 1366 / 768 ||
              Math.abs((dx * ux + dy * uy + dz * uz) / depth) > tanV) continue;
            projected++;
            worst = Math.max(worst, shadowY);
          }
        }
      expect(poses).toBeGreaterThan(0);
      console.log(`kiosk shadow ${group.name}: ${projected ? worst.toFixed(2) : 'none'}; visible samples=${projected}; poses=${poses}`);
      expect(worst).toBeLessThanOrEqual(TRADING_FLOOR_SCREEN.bottomY - 20);
    }
  }, 30_000);

  // The hotspot, the click volume, the label anchor and the collider are all
  // derived from TRADING_FLOOR_MONITOR. If the constant and the prop disagree,
  // the player presses E at empty air.
  test('the kiosk node is where the hotspot says it is', () => {
    const at = translation(nodeByName('TradingFloorMonitorStation'));
    expect(Math.abs(at.x - TRADING_FLOOR_MONITOR.x)).toBeLessThan(TOL);
    expect(Math.abs(at.z - TRADING_FLOOR_MONITOR.z)).toBeLessThan(TOL);
  });

  test('the kiosk is the size and height the constants claim', () => {
    const half = worldHalfExtents(nodeByName('TradingFloorMonitorStation'));
    expect(Math.abs(half.x - TRADING_FLOOR_MONITOR.halfX)).toBeLessThan(TOL);
    expect(Math.abs(half.z - TRADING_FLOOR_MONITOR.halfZ)).toBeLessThan(TOL);
    expect(Math.abs(half.y * 2 - TRADING_FLOOR_MONITOR.height)).toBeLessThan(TOL);
  });

  // v3 shrank the kiosk from 470 to 300 so it stopped shadowing the board.
  // A re-export that restores the tall version silently re-occludes it.
  test('the kiosk is the SHORT v3 version, not the 470 wu original', () => {
    const half = worldHalfExtents(nodeByName('TradingFloorMonitorStation'));
    expect(half.y * 2).toBeLessThan(400);
  });

  test('the label anchor sits above the kiosk, not inside it', () => {
    expect(TRADING_FLOOR_MONITOR.screenY).toBeLessThan(TRADING_FLOOR_MONITOR.height);
    expect(TRADING_FLOOR_MONITOR.screenY).toBeGreaterThan(0);
  });
});

describe('Trading Floor asset — the holo dais matches its collider', () => {
  test('the dais node and footprint match the solid built for it', () => {
    const node = nodeByName('TradingFloorHoloDais');
    const at = translation(node);
    const half = worldHalfExtents(node);
    const solid = TRADING_FLOOR_SOLIDS.find(
      (candidate) =>
        Math.abs(candidate.centerX - at.x) < TOL &&
        Math.abs(candidate.centerZ - at.z) < TOL &&
        candidate.halfX > 300,
    );
    expect(solid).toBeDefined();
    // R3 grows only the movement collider; the physical plinth retains its footprint.
    expect(Math.abs(TRADING_FLOOR_DAIS.halfX - half.x)).toBeLessThan(TOL);
    expect(Math.abs(TRADING_FLOOR_DAIS.halfZ - half.z)).toBeLessThan(TOL);
    expect(solid!.halfX).toBeGreaterThanOrEqual(half.x);
    expect(solid!.halfZ).toBeGreaterThanOrEqual(half.z);
  });

  test('both measured claws clear the board from spawn and default-height reachable poses', async () => {
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
    });
    const doc = await io.read(GLB_PATH);
    const clawNode = doc.getRoot().listNodes().find((node) => node.getName() === 'TradingFloorClaws');
    expect(clawNode).toBeDefined();
    const mesh = clawNode!.getMesh()!.listPrimitives()[0]!;
    const accessor = mesh.getAttribute('POSITION')!;
    const positions = accessor.getArray()!;
    const divisor = accessor.getNormalized() && positions instanceof Int16Array ? 32767 : 1;
    const world = clawNode!.getWorldMatrix();
    const claws = extras?.statue?.claws;
    expect(claws).toHaveLength(2);
    const points: { x: number; y: number; z: number }[][] = [[], []];
    const seen = [new Set<string>(), new Set<string>()];
    for (let index = 0; index < positions.length; index += 3) {
      const x = positions[index]! / divisor * world[0]! + world[12]!;
      const y = positions[index + 1]! / divisor * world[5]! + world[13]!;
      const z = positions[index + 2]! / divisor * world[10]! + world[14]!;
      for (let claw = 0; claw < 2; claw++) {
        const bounds = claws![claw]!;
        if (y < 74 || x < bounds.min[0]! - 1 || x > bounds.max[0]! + 1 ||
            z < bounds.min[2]! - 1 || z > bounds.max[2]! + 1) continue;
        const key = [x, y, z].map((v) => Math.round(v)).join(',');
        if (!seen[claw]!.has(key)) {
          seen[claw]!.add(key);
          points[claw]!.push({ x, y, z });
        }
      }
    }
    for (let claw = 0; claw < 2; claw++) {
      const bounds = claws![claw]!;
      const top = Math.max(...points[claw]!.map((point) => point.y));
      expect(points[claw]!.length).toBeGreaterThan(50);
      expect(Math.abs(top - bounds.max[1]!)).toBeLessThan(1);
      expect(top).toBeLessThanOrEqual(230);
      expect(Math.abs(bounds.min[0]! + bounds.max[0]!)).toBeGreaterThan(300);
      expect(bounds.min[0]!).toBeGreaterThanOrEqual(-310);
      expect(bounds.max[0]!).toBeLessThanOrEqual(310);
      expect(bounds.min[1]!).toBe(70);
      expect(bounds.max[2]! - bounds.min[2]!).toBeGreaterThan(80);
      expect(bounds.min[2]!).toBeGreaterThanOrEqual(TRADING_FLOOR_DAIS.z - 160);
      expect(bounds.max[2]!).toBeLessThanOrEqual(TRADING_FLOOR_DAIS.z + 160);
      for (const point of points[claw]!) {
        expect(Math.abs(point.x - TRADING_FLOOR_DAIS.x) + Math.abs(point.z - TRADING_FLOOR_DAIS.z)).toBeLessThanOrEqual(435 + 1);
      }
    }
    // At the default camera height, every claw point is below the camera.
    // Projection toward the board has t > 1, so shadowY < pointY < the sill.
    // This proves the reachable-pose rule beyond the finite diagnostic sweep.
    expect(points.flat().every((point) => point.y < TRADING_FLOOR_CAMERA.above &&
      point.y < TRADING_FLOOR_SCREEN.bottomY)).toBe(true);
    expect(Math.abs(claws![0]!.max[0]! + claws![1]!.min[0]!)).toBeLessThan(0.01);
    expect(extras!.statue!.top).toBeLessThanOrEqual(230);
    const dais = nodeByName('TradingFloorHoloDais');
    expect(translation(dais).y + worldHalfExtents(dais).y).toBeLessThan(extras!.statue!.top);

    // Use the same spring-arm placement as the room frame loop.
    const inFrame = (cx: number, cy: number, cz: number, lx: number, lz: number,
      px: number, py: number) => {
      let fx = lx - cx, fy = TRADING_FLOOR_CAMERA.lookY - cy, fz = lz - cz;
      const length = Math.hypot(fx, fy, fz);
      fx /= length; fy /= length; fz /= length;
      let rx = -fz, rz = fx;
      const rightLength = Math.hypot(rx, rz);
      rx /= rightLength; rz /= rightLength;
      const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
      const dx = px - cx, dy = py - cy, dz = TRADING_FLOOR_SCREEN.z - cz;
      const depth = dx * fx + dy * fy + dz * fz;
      const tanV = Math.tan(TRADING_FLOOR_CAMERA.fov * Math.PI / 360);
      return depth > 1 && Math.abs((dx * rx + dz * rz) / depth) <= tanV * 1366 / 768 &&
        Math.abs((dx * ux + dy * uy + dz * uz) / depth) <= tanV;
    };
    const worstShadow = (camY: number, spawnOnly: boolean) => {
      const worst = [0, 0];
      const bodies: [number, number][] = spawnOnly ? [[TRADING_FLOOR_PLAYER_SPAWN.x, TRADING_FLOOR_PLAYER_SPAWN.z]] : [];
      if (!spawnOnly) for (let x = -TRADING_FLOOR_SIDE_APPROACH_X; x <= TRADING_FLOOR_SIDE_APPROACH_X; x += 48)
        for (let z = TRADING_FLOOR_BOARD_APPROACH_Z; z <= TRADING_FLOOR_DOOR_APPROACH_Z; z += 48)
          if (!tradingFloorHitsSolid(x, z)) bodies.push([x, z]);
      for (const [bx, bz] of bodies) for (let degrees = 0; degrees < 360; degrees += spawnOnly ? 2 : 15) {
        const yaw = degrees * Math.PI / 180;
        const forwardX = Math.sin(yaw), forwardZ = -Math.cos(yaw);
        const camera = { x: 0, y: 0, z: 0 };
        placeTradingFloorChaseCamera(bx, bz, yaw, camY - TRADING_FLOOR_CAMERA.above, camera);
        const lookX = bx + forwardX * TRADING_FLOOR_CAMERA.lookAhead;
        const lookZ = bz + forwardZ * TRADING_FLOOR_CAMERA.lookAhead;
        for (let claw = 0; claw < 2; claw++) for (const point of points[claw]!) {
          if (camera.z <= point.z + 1) continue;
          const t = (camera.z - TRADING_FLOOR_SCREEN.z) / (camera.z - point.z);
          const boardX = camera.x + (point.x - camera.x) * t;
          if (Math.abs(boardX) > TRADING_FLOOR_SCREEN.width / 2) continue;
          const shadowY = camera.y + (point.y - camera.y) * t;
          const boardY = Math.max(TRADING_FLOOR_SCREEN.bottomY,
            Math.min(shadowY, TRADING_FLOOR_SCREEN.bottomY + TRADING_FLOOR_SCREEN.height));
          if (inFrame(camera.x, camera.y, camera.z, lookX, lookZ, boardX, boardY))
            worst[claw] = Math.max(worst[claw]!, shadowY);
        }
      }
      return worst;
    };
    for (const camY of [TRADING_FLOOR_CAMERA.pitchMin, 0, TRADING_FLOOR_CAMERA.pitchMax].map((pitch) => TRADING_FLOOR_CAMERA.above + pitch)) {
      const worst = worstShadow(camY, true);
      console.log(`statue spawn camera ${camY}: left ${worst[0]!.toFixed(2)}, right ${worst[1]!.toFixed(2)}, sill ${TRADING_FLOOR_SCREEN.bottomY}`);
      expect(Math.max(...worst)).toBeLessThanOrEqual(TRADING_FLOOR_SCREEN.bottomY);
    }
    const reachable = worstShadow(TRADING_FLOOR_CAMERA.above, false);
    console.log(`statue reachable camera ${TRADING_FLOOR_CAMERA.above}: left ${reachable[0]!.toFixed(2)}, right ${reachable[1]!.toFixed(2)}, sill ${TRADING_FLOOR_SCREEN.bottomY}`);
    expect(Math.max(...reachable)).toBeLessThanOrEqual(TRADING_FLOOR_SCREEN.bottomY);
  });
});

describe('Trading Floor asset — v4 colours, seal and portal', () => {
  // R1 must re-measure the 96 glow vertices, 32 vertices per tier and upper-tier dimensions.
  test('three warm-gold glow bands surround recessed tier faces inside the dais collider', async () => {
    const { vertices, primitive } = await assetVertices('TradingFloorTrimGlow');
    expect(primitive.getMaterial()!.getExtension('KHR_materials_unlit')).not.toBeNull();
    const granite = (await assetVertices('TradingFloorHoloDais')).vertices;
    const glow = vertices.filter(({ color }) => color && color[0]! > .99 &&
      Math.abs(color[1]! - .57758) < .01 && Math.abs(color[2]! - .11697) < .01);
    expect(glow).toHaveLength(96);
    for (const [top, halfX, halfZ, chamfer] of [[32, TRADING_FLOOR_DAIS.halfX, TRADING_FLOOR_DAIS.halfZ, 65], [50, 330, 210, 55], [70, 310, 160, 35]]) {
      const band = glow.filter(({ p }) => p[1] > top! - 4.2 && p[1] < top! - 1.3);
      expect(band).toHaveLength(32);
      expect(Math.max(...band.map(({ p }) => p[1])) - Math.min(...band.map(({ p }) => p[1]))).toBeCloseTo(2.5, 0);
      const insetFace = granite.filter(({ p, n }) => Math.abs(n[1]) < .1 && Math.abs(p[1] - top!) < .2);
      expect(insetFace.length).toBeGreaterThanOrEqual(16);
      const bandX = Math.max(...band.map(({ p }) => Math.abs(p[0])));
      const bandZ = Math.max(...band.map(({ p }) => Math.abs(p[2] - TRADING_FLOOR_DAIS.z)));
      expect(bandX).toBeCloseTo(halfX! - .75, 0);
      expect(bandZ).toBeCloseTo(halfZ! - .75, 0);
      expect(bandX - Math.max(...insetFace.map(({ p }) => Math.abs(p[0])))).toBeGreaterThan(.5);
      expect(bandX - Math.max(...insetFace.map(({ p }) => Math.abs(p[0])))).toBeLessThan(1);
      for (const { p: [x, y, z] } of band) {
        expect(Math.abs(x - TRADING_FLOOR_DAIS.x)).toBeLessThanOrEqual(TRADING_FLOOR_DAIS.halfX);
        expect(Math.abs(z - TRADING_FLOOR_DAIS.z)).toBeLessThanOrEqual(TRADING_FLOOR_DAIS.halfZ);
        expect(y).toBeLessThan(top! - 1.3);
        // The diagonal face also has a 0.75 wu offset, not a corner overlap.
        expect(Math.abs(x) + Math.abs(z - TRADING_FLOOR_DAIS.z)).toBeLessThanOrEqual(
          halfX! + halfZ! - chamfer! - Math.SQRT2 * .75 + .2);
      }
      console.log(`plinth glow tier ${top}: height 2.5 wu, X proud ${(bandX - Math.max(...insetFace.map(({ p }) => Math.abs(p[0])))).toFixed(4)} wu; footprint ${bandX.toFixed(4)}/${bandZ.toFixed(4)}`);
    }
  });

  // R4 keeps 11 meshes and shares the desk material: 10 materials, 6 textures.
  test('the seal and both banners share one draw call', () => {
    // Merged v5 part 2: sea life +1 mesh/+1 material (W2); the procedural kiosk shares the desk material and drops the
    // Meshy kiosk texture (R4). Re-measured by the merge-fix job on the rebuilt GLB.
    expect(gltf.meshes).toHaveLength(12);
    expect(gltf.materials).toHaveLength(11);
    expect(gltf.textures).toHaveLength(6);
    const identity = nodeByName('TradingFloorIdentity');
    expect(gltf.meshes[identity.mesh!]!.primitives).toHaveLength(1);
  });

  test('the old mint dais ring is absent from unlit trim', async () => {
    await MeshoptDecoder.ready;
    const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder }).read(GLB_PATH);
    const trim = doc.getRoot().listNodes().find((node) => node.getName() === 'TradingFloorTrimGlow')!;
    const positions = trim.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!;
    const world = trim.getWorldMatrix();
    for (let i = 0; i < positions.getCount(); i++) {
      const p = positions.getElement(i, []);
      const x = p[0]! * world[0]! + world[12]!;
      const y = p[1]! * world[5]! + world[13]!;
      const z = p[2]! * world[10]! + world[14]!;
      // Door glass reaches y=12, outside the dais. Keep the original 15 wu
      // exclusion on the dais footprint rather than the whole merged mesh.
      if (Math.hypot(x - DECOR_SEAL.x, z - DECOR_SEAL.z) <= DECOR_SEAL.outerRadius) expect(y).toBeGreaterThan(15);
    }
  });

  test('trim and instanced chairs carry vertex colours', () => {
    for (const name of ['TradingFloorTrimGlow', 'TradingFloorChairModule']) {
      const node = nodeByName(name);
      expect(gltf.meshes[node.mesh!]!.primitives[0]!.attributes.COLOR_0).toBeNumber();
    }
  });

  test('the smoked double doors stay behind the wall face and share the trim draw', async () => {
    await MeshoptDecoder.ready;
    const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder }).read(GLB_PATH);
    const trim = doc.getRoot().listNodes().find((node) => node.getName() === 'TradingFloorTrimGlow')!;
    const primitive = trim.getMesh()!.listPrimitives()[0]!;
    const positions = primitive.getAttribute('POSITION')!;
    const colors = primitive.getAttribute('COLOR_0')!;
    const world = trim.getWorldMatrix();
    const leaves: number[][][] = [[], []];
    for (let i = 0; i < positions.getCount(); i++) {
      const p = positions.getElement(i, []);
      const [x, y, z] = [0, 1, 2].map((axis) => world[12 + axis]! +
        world[axis]! * p[0]! + world[4 + axis]! * p[1]! + world[8 + axis]! * p[2]!);
      if (Math.abs(x!) > 180 || y! < 10 || y! > 490 || z! < TRADING_FLOOR_DOOR.z + 27 || z! > TRADING_FLOOR_DOOR.z + 37) continue;
      const color = colors.getElement(i, []);
      expect(color[2]!).toBeGreaterThan(color[0]!);
      expect(color[0]!).toBeGreaterThan(0);
      expect(z!).toBeGreaterThan(TRADING_FLOOR_ROOM.halfZ);
      expect(z!).toBeLessThan(TRADING_FLOOR_ROOM.halfZ + TRADING_FLOOR_ROOM.wallThickness);
      leaves[x! < 0 ? 0 : 1]!.push([x!, y!, z!]);
    }
    for (const leaf of leaves) {
      expect(leaf.length).toBeGreaterThanOrEqual(8);
      expect(Math.max(...leaf.map((p) => p[1]!))).toBeCloseTo(488, 0);
      expect(Math.min(...leaf.map((p) => p[1]!))).toBeCloseTo(12, 0);
    }
    const brass = gltf.materials.find((material) => material.name === 'TradingFloorBrass')!;
    expect(brass.pbrMetallicRoughness!.metallicFactor!).toBeLessThanOrEqual(0.45);
  });
});

describe('Trading Floor asset — the shell matches the hall constants', () => {
  test('the walls enclose exactly the hall the movement clamp assumes', () => {
    const half = worldHalfExtents(nodeByName('TradingFloorWalls'));
    // The wall mesh spans to the OUTER face, so the inner face is one wall
    // thickness in — that inner face is what `TRADING_FLOOR_ROOM` describes.
    expect(
      Math.abs(half.x - TRADING_FLOOR_ROOM.wallThickness - TRADING_FLOOR_ROOM.halfX),
    ).toBeLessThan(TOL);
    expect(
      Math.abs(half.z - TRADING_FLOOR_ROOM.wallThickness - TRADING_FLOOR_ROOM.halfZ),
    ).toBeLessThan(TOL);
  });

  // The ceiling slab's INNER face is the hall height, not its node centre: the
  // node sits at 980 with a 30 wu half-thickness, so the face the player sees is
  // at 949.95. `ROOM_BOUNDS.yMax` and the fog are sized against that face.
  test('the ceiling INNER face sits at the hall height the camera bounds use', () => {
    const node = nodeByName('TradingFloorCeiling');
    const innerFace = translation(node).y - worldHalfExtents(node).y;
    expect(Math.abs(innerFace - TRADING_FLOOR_ROOM.height)).toBeLessThan(TOL);
  });
});

describe('Trading Floor asset — nothing intersects anything', () => {
  // AABB overlap across the whole collider set. A prop embedded in another prop
  // is a founder-visible defect and, for two colliders, a movement bug as well.
  // This caught a proposed kiosk position that sat 46 x 44 wu inside a corner
  // pillar, which the desk-only check asked for at the time would have passed.
  test('no two collision solids overlap', () => {
    const overlaps: string[] = [];
    for (let a = 0; a < TRADING_FLOOR_SOLIDS.length; a += 1) {
      for (let b = a + 1; b < TRADING_FLOOR_SOLIDS.length; b += 1) {
        const first = TRADING_FLOOR_SOLIDS[a]!;
        const second = TRADING_FLOOR_SOLIDS[b]!;
        const gapX =
          Math.abs(first.centerX - second.centerX) - (first.halfX + second.halfX);
        const gapZ =
          Math.abs(first.centerZ - second.centerZ) - (first.halfZ + second.halfZ);
        if (gapX < 0 && gapZ < 0) {
          overlaps.push(
            `(${first.centerX}, ${first.centerZ}) vs (${second.centerX}, ${second.centerZ})`,
          );
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  // Named separately because it is the pair that actually collided once.
  test('the kiosk solid clears every corner pillar', () => {
    const pillars = TRADING_FLOOR_PILLAR_SOLIDS;
    expect(pillars.length).toBe(4);
    for (const pillar of pillars) {
      const gapX =
        Math.abs(TRADING_FLOOR_MONITOR.x - pillar.centerX) -
        (TRADING_FLOOR_MONITOR.halfX + pillar.halfX);
      const gapZ =
        Math.abs(TRADING_FLOOR_MONITOR.z - pillar.centerZ) -
        (TRADING_FLOOR_MONITOR.halfZ + pillar.halfZ);
      expect(gapX > 0 || gapZ > 0).toBe(true);
    }
  });

  test('the kiosk solid clears every desk solid', () => {
    for (const slot of TRADING_FLOOR_CONSOLE_ROW) {
      const { halfX, halfZ } = consoleHalfExtents(slot.rotY);
      const gapX =
        Math.abs(TRADING_FLOOR_MONITOR.x - slot.x) -
        (TRADING_FLOOR_MONITOR.halfX + halfX);
      const gapZ =
        Math.abs(TRADING_FLOOR_MONITOR.z - slot.z) -
        (TRADING_FLOOR_MONITOR.halfZ + halfZ);
      expect(gapX > 0 || gapZ > 0).toBe(true);
    }
  });
});

test('the measured claw camera box covers every decoded claw vertex', async () => {
  const doc = await decodedAsset;
  const mesh = doc.getRoot().listNodes().find((node) => node.getName() === 'TradingFloorClaws')!.getMesh()!;
  expect(mesh.listPrimitives()).toHaveLength(1);
  const { vertices } = await assetVertices('TradingFloorClaws');
  const box = TRADING_FLOOR_CAMERA_CLAW_SOLID;
  expect(vertices.length).toBeGreaterThan(100);
  let marginX = Infinity, marginZ = Infinity, marginY = Infinity;
  for (const { p: [x, y, z] } of vertices) {
    marginX = Math.min(marginX, box.halfX - Math.abs(x - box.centerX));
    marginZ = Math.min(marginZ, box.halfZ - Math.abs(z - box.centerZ));
    marginY = Math.min(marginY, TRADING_FLOOR_CLAW_EXTENTS.topY - y);
  }
  expect(marginX).toBeGreaterThan(0);
  expect(marginZ).toBeGreaterThan(0);
  expect(marginY).toBeGreaterThan(0);
  expect(extras!.statue!.top).toBeLessThanOrEqual(TRADING_FLOOR_CLAW_EXTENTS.topY);
  console.log(`claw camera box margins: x=${marginX.toFixed(3)}, z=${marginZ.toFixed(3)}, y=${marginY.toFixed(3)} wu`);
});


test('the house-agent stage has no GLB prop or shell-detail geometry', async () => {
  const doc = await decodedAsset;
  const failures: string[] = [];
  for (const node of doc.getRoot().listNodes()) {
    // Floor and ceiling enclose the stage; source row templates never render here.
    if (!node.getMesh() || ['TradingFloorFloorSlab', 'TradingFloorCeiling',
      'TradingFloorConsoleModule', 'TradingFloorChairModule'].includes(node.getName())) continue;
    const { vertices, primitive } = await assetVertices(node.getName());
    const indices = primitive.getIndices()!.getArray()!;
    for (let i = 0; i < indices.length; i += 3) {
      const points = [0, 1, 2].map((corner) => vertices[indices[i + corner]!]!.p);
      const minX = Math.min(...points.map((p) => p[0])), maxX = Math.max(...points.map((p) => p[0]));
      const minZ = Math.min(...points.map((p) => p[2])), maxZ = Math.max(...points.map((p) => p[2]));
      if (maxX > -1300 && minX < 1300 && maxZ > TRADING_FLOOR_BOARD_APPROACH_Z && minZ < -1100)
        failures.push(`${node.getName()} triangle ${i / 3}`);
    }
  }
  expect(failures).toEqual([]);
});

describe('Trading Floor asset - frozen R3 rope ring', () => {
  const ring = (extras as GltfSceneExtras & { ropeRing: {
    x: number; z: number; halfX: number; halfZ: number;
    posts: { x: number; z: number }[];
    post: { baseRadius: number; baseY: number[]; poleRadius: number; poleY: number[];
      finialRadius: number; finialY: number[]; sides: number };
    attachY: number; sag: number; lowestY: number; radius: number;
    sides: number; segments: number; color: number[];
  } }).ropeRing;

  test('compression retains all twelve equally spaced posts and the frozen rope recipe', () => {
    expect(ring).toBeDefined();
    expect([ring.x, ring.z, ring.halfX, ring.halfZ]).toEqual([0, -90, 470, 466]);
    expect([ring.attachY, ring.sag, ring.lowestY, ring.radius, ring.sides, ring.segments])
      .toEqual([134, 28, 106, 4, 6, 12]);
    expect(ring.color).toEqual([.20, .010, .016]);
    expect(ring.post).toEqual({ baseRadius: 20, baseY: [0,6], poleRadius: 5,
      poleY: [6,140], finialRadius: 9, finialY: [140,152], sides: 8 });
    expect(ring.posts).toHaveLength(12);
    expect(new Set(ring.posts.map(({x,z}) => `${x},${z}`)).size).toBe(12);
    const corners = [[-470,-556],[470,-556],[470,376],[-470,376]];
    for (let edge = 0; edge < 4; edge++) for (let i = 0; i < 3; i++) {
      const a = corners[edge]!, b = corners[(edge + 1) % 4]!, post = ring.posts[edge * 3 + i]!;
      expect(post.x).toBeCloseTo(a[0]! + (b[0]! - a[0]!) * i / 3, 8);
      expect(post.z).toBeCloseTo(a[1]! + (b[1]! - a[1]!) * i / 3, 8);
    }
  });

  test('decoded posts stay inside the collider and leave 128 wu before the seal text', async () => {
    const solid = TRADING_FLOOR_SOLIDS.find((s) => s.centerX === 0 && s.centerZ === -90)!;
    expect(solid).toEqual({ centerX: 0, centerZ: -90, halfX: 492, halfZ: 488 });
    const { vertices } = await assetVertices('TradingFloorBrass');
    for (const post of ring.posts) {
      // 14-bit room-wide position quantization measures up to .1071 wu error here.
      const points = vertices.filter(({p}) => Math.abs(p[0] - post.x) <= 20.13 &&
        Math.abs(p[2] - post.z) <= 20.13 && p[1] <= 152.13);
      expect(points).toHaveLength(96);
      for (const {p} of points) {
        expect(Math.abs(p[0] - solid.centerX)).toBeLessThan(solid.halfX);
        expect(Math.abs(p[2] - solid.centerZ)).toBeLessThan(solid.halfZ);
        expect(p[2]).toBeLessThan(524);
      }
      for (const y of [0,6,140,152])
        expect(Math.min(...points.map(({p}) => Math.abs(p[1] - y)))).toBeLessThan(.13);
    }
    expect(524 - (ring.z + ring.halfZ + ring.post.baseRadius)).toBe(128);
    expect(ring.z - ring.halfZ - ring.post.baseRadius).toBeGreaterThan(-1100);
  });

  test('decoded velvet tubes preserve endpoints, sag, shaded red and outward triangles', async () => {
    const { vertices, primitive } = await assetVertices('TradingFloorTrimGlow');
    const ropes = vertices.filter(({color}) => color && color[0]! > .10 && color[0]! < .21 && color[1]! < .02);
    expect(ropes).toHaveLength(936);
    expect(primitive.getMaterial()!.getExtension('KHR_materials_unlit')).toBeTruthy();
    // Unlit compression removes NORMAL. Recover the radial normal from the nearest centreline point.
    const surfaceNormal = (p: Point): Point => {
      let best = Infinity, radial: Point = [0,0,0];
      for (let span = 0; span < 12; span++) {
        const a = ring.posts[span]!, b = ring.posts[(span + 1) % 12]!;
        const dx = b.x - a.x, dz = b.z - a.z, lengthSq = dx * dx + dz * dz;
        let s = Math.max(0,Math.min(1,((p[0] - a.x) * dx + (p[2] - a.z) * dz) / lengthSq));
        for (let i = 0; i < 5; i++) {
          const dy = -4 * ring.sag * (1 - 2 * s), oy = p[1] - ring.attachY + 4 * ring.sag * s * (1 - s);
          const dot = (p[0] - a.x - dx * s) * dx + oy * dy + (p[2] - a.z - dz * s) * dz;
          s = Math.max(0,Math.min(1,s + dot / (lengthSq + dy * dy - oy * 8 * ring.sag)));
        }
        const offset: Point = [p[0] - a.x - dx * s,
          p[1] - ring.attachY + 4 * ring.sag * s * (1 - s), p[2] - a.z - dz * s];
        const distance = Math.hypot(...offset);
        if (distance < best) { best = distance; radial = offset.map((v) => v / distance) as Point; }
      }
      return radial;
    };
    for (const {p,color} of ropes) {
      expect(p[1]).toBeGreaterThanOrEqual(102 - .13);
      expect(p[1]).toBeLessThanOrEqual(138 + .13);
      expect(p[2]).toBeLessThan(524);
    }
    for (let span = 0; span < 12; span++) {
      const a = ring.posts[span]!, b = ring.posts[(span + 1) % 12]!;
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx,dz);
      for (let segment = 0; segment <= 12; segment++) {
        const s = segment / 12;
        const x = a.x + (b.x - a.x) * s, z = a.z + (b.z - a.z) * s;
        const y = ring.attachY - ring.sag * 4 * s * (1 - s);
        const slope = -112 * (1 - 2 * s) / length, norm = Math.hypot(1,slope);
        for (let side = 0; side < 6; side++) {
          const angle = side / 6 * 2 * Math.PI, c = Math.cos(angle), sn = Math.sin(angle);
          const n: Point = [-dx / length * slope / norm * c + dz / length * sn,
            c / norm, -dz / length * slope / norm * c - dx / length * sn];
          const expected: Point = [x + 4 * n[0],y + 4 * n[1],z + 4 * n[2]];
          const nearest = ropes.reduce((best,v) =>
            Math.hypot(...v.p.map((p,i) => p - expected[i]!)) <
              Math.hypot(...best.p.map((p,i) => p - expected[i]!)) ? v : best);
          // A .13 wu per-axis position tolerance permits .21 wu Euclidean error.
          expect(Math.hypot(...nearest.p.map((p,i) => p - expected[i]!))).toBeLessThan(.21);
          const shade = .55 + .45 * Math.max(0,n[1]);
          ring.color.forEach((v,i) => expect(Math.abs(nearest.color![i]! - v * shade)).toBeLessThan(.003));
        }
      }
    }
    const indices = primitive.getIndices()!.getArray()!;
    let ropeTriangles = 0, inversions = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const points = [0,1,2].map((j) => vertices[indices[i + j]!]!);
      if (!points.every(({color}) => color && color[0]! > .10 && color[0]! < .21 && color[1]! < .02)) continue;
      ropeTriangles++;
      const [a,b,c] = points.map(({p}) => p) as [Point,Point,Point];
      const u = b.map((v,j) => v - a[j]!), v = c.map((v,j) => v - a[j]!);
      const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!];
      const normal = surfaceNormal(a.map((v,j) => (v + b[j]! + c[j]!) / 3) as Point);
      if (cross.reduce((sum,v,j) => sum + v * normal[j]!, 0) <= 0) inversions++;
    }
    expect(ropeTriangles).toBe(1728);
    expect(inversions).toBe(0);
  });

  test('post and rope costs stay measured within the existing draws and total budget', async () => {
    const brass = await assetVertices('TradingFloorBrass'), trim = await assetVertices('TradingFloorTrimGlow');
    // Before -> after: BRASS 576/1104 -> 1584/2256; TRIM 228/456 -> 1956/1392 (tris/vertices).
    expect([brass.primitive.getIndices()!.getCount() / 3, brass.vertices.length]).toEqual([1584,2256]);
    expect([trim.primitive.getIndices()!.getCount() / 3, trim.vertices.length]).toEqual([1956,1392]);
    // Merged W2 adds sea life; R4 shares the desk material and removes one texture.
    expect([gltf.meshes.length, gltf.materials.length, gltf.textures.length]).toEqual([12,11,6]);
    console.log('R3 budgets: BRASS 576/1104 -> 1584/2256; TRIM 228/456 -> 1956/1392 tris/vertices');
  });
});

describe('Trading Floor asset - W2 sea floor', () => {
  type SeaLife = { kind: string; x: number; z: number; height: number; min: Point; max: Point; triangles: number; cluster: number | null };
  const pieces = async () => (await decodedAsset).getRoot().getDefaultScene()!.getExtras().seaLife as SeaLife[];
  const contains = (p: Point, piece: SeaLife) => p.every((v, a) =>
    v >= piece.min[a]! - .15 && v <= piece.max[a]! + .15);
  const overlap = (p: SeaLife, minX: number, maxX: number, minZ: number, maxZ: number) =>
    p.max[0] > minX && p.min[0] < maxX && p.max[2] > minZ && p.min[2] < maxZ;
  const circleDistance = (p: SeaLife, x: number, z: number) => Math.hypot(
    Math.max(p.min[0] - x, 0, x - p.max[0]), Math.max(p.min[2] - z, 0, z - p.max[2]));

  test('one lit indexed vertex-colour draw stays within the welded triangle and byte budgets', async () => {
    const { primitive, vertices } = await assetVertices('TradingFloorSeaLife');
    const node = (await decodedAsset).getRoot().listNodes().find((n) => n.getName() === 'TradingFloorSeaLife')!;
    expect(node.getMesh()!.listPrimitives()).toHaveLength(1);
    const material = primitive.getMaterial()!;
    expect(material.getName()).toBe('TradingFloorSeaLifeMtl');
    expect(material.getExtension('KHR_materials_unlit')).toBeNull();
    expect(material.getRoughnessFactor()).toBe(.7);
    expect(material.getMetallicFactor()).toBe(0);
    expect(material.getBaseColorTexture()).toBeNull();
    expect(material.getEmissiveFactor().some((v) => v > 0)).toBe(true);
    expect(primitive.getAttribute('COLOR_0')!.getCount()).toBe(vertices.length);
    const triangles = primitive.getIndices()!.getCount() / 3;
    expect(triangles).toBeLessThanOrEqual(12000);
    expect(triangles).toBe((await pieces()).reduce((sum, piece) => sum + piece.triangles, 0));
    expect(vertices.length).toBeLessThanOrEqual(16000);
    expect(vertices.length).toBeLessThan(triangles * 3);
    expect(readFileSync(GLB_PATH).byteLength).toBeLessThanOrEqual(500000);
    expect(new Set(vertices.map(({ color }) => color!.map((v) => v.toFixed(2)).join(','))).size).toBeGreaterThan(50);
  });

  test('75..95 scattered pieces cover every decoded vertex and triangle with upright low plants', async () => {
    const list = await pieces();
    expect(list.length).toBeGreaterThanOrEqual(75);
    expect(list.length).toBeLessThanOrEqual(95);
    const stars = list.filter((p) => p.kind === 'starfish');
    expect(stars.length).toBeGreaterThanOrEqual(10);
    expect(stars.length).toBeLessThanOrEqual(14);
    expect(list.filter((p) => p.kind === 'seaweed-tuft').length).toBeGreaterThan(list.length / 2);
    expect(list.some((p) => p.kind === 'kelp')).toBe(true);
    for (const kind of ['brain', 'fan', 'staghorn', 'tubes']) expect(list.some((p) => p.kind === `coral-${kind}`)).toBe(true);
    const { vertices, primitive } = await assetVertices('TradingFloorSeaLife');
    const indices = primitive.getIndices()!.getArray()!;
    for (const piece of list) {
      const measured = vertices.filter(({ p }) => contains(p, piece));
      expect(measured.length).toBeGreaterThan(20);
      const spans = [0, 1, 2].map((a) => {
        const lo = Math.min(...measured.map(({ p }) => p[a]!)), hi = Math.max(...measured.map(({ p }) => p[a]!));
        expect(Math.abs(lo - piece.min[a]!)).toBeLessThan(.15);
        expect(Math.abs(hi - piece.max[a]!)).toBeLessThan(.15);
        return hi - lo;
      });
      expect(Math.abs(spans[1]! - piece.height)).toBeLessThan(.3);
      expect(piece.min[1]).toBeGreaterThanOrEqual(0);
      expect(piece.max[1]).toBeLessThanOrEqual(140);
      if (piece.kind === 'starfish') {
        expect(piece.max[1]).toBeLessThanOrEqual(5);
        expect(piece.triangles).toBe(120);
      } else {
        expect(piece.height).toBeGreaterThanOrEqual(40);
        // Decode actual positions rather than trusting metadata or authoring orientation.
        expect(spans[1]!).toBeGreaterThan(spans[0]!);
        expect(spans[1]!).toBeGreaterThan(spans[2]!);
        if (piece.kind === 'seaweed-tuft') {
          expect(piece.triangles).toBeGreaterThanOrEqual(30);
          expect(piece.triangles).toBeLessThanOrEqual(60);
          expect(piece.height).toBeLessThanOrEqual(110);
        } else {
          expect(piece.triangles).toBeGreaterThanOrEqual(150);
          expect(piece.triangles).toBeLessThanOrEqual(250);
        }
      }
      let triangles = 0;
      for (let i = 0; i < indices.length; i += 3)
        if ([0, 1, 2].every((a) => contains(vertices[indices[i + a]!]!.p, piece))) triangles++;
      expect(triangles).toBe(piece.triangles);
    }
    for (const vertex of vertices) expect(list.filter((p) => contains(vertex.p, p))).toHaveLength(1);
    for (let i = 0; i < indices.length; i += 3)
      expect(list.some((p) => [0, 1, 2].every((a) => contains(vertices[indices[i + a]!]!.p, p)))).toBe(true);
  });

  test('full piece bounds clear the seal text, stage front, desks, kiosk, door and spawn', async () => {
    for (const piece of await pieces()) {
      expect(overlap(piece, -1300, 1300, -1470, -950)).toBe(false);
      expect(overlap(piece, -1300, -700, 1300, 1650)).toBe(false);
      expect(overlap(piece, -300, 300, 1250, 1650)).toBe(false);
      expect(circleDistance(piece, 0, 1170)).toBeGreaterThanOrEqual(200);
      for (const row of [-1000, -500, 0, 500, 1000])
        if (piece.min[0] < -1380 || piece.max[0] > 1380)
          expect(piece.max[2] <= row - 182 || piece.min[2] >= row + 182).toBe(true);
      for (const pillar of TRADING_FLOOR_PILLAR_SOLIDS)
        expect(overlap(piece, pillar.centerX - pillar.halfX, pillar.centerX + pillar.halfX,
          pillar.centerZ - pillar.halfZ, pillar.centerZ + pillar.halfZ)).toBe(false);
      if (circleDistance(piece, 0, -90) < 900) {
        expect(piece.kind).toBe('starfish');
        expect(piece.max[1]).toBeLessThanOrEqual(5);
        expect(Math.max(Math.abs(piece.min[0]), Math.abs(piece.max[0]))).toBeLessThanOrEqual(470);
        expect(Math.max(Math.abs(piece.min[2] + 90), Math.abs(piece.max[2] + 90))).toBeLessThanOrEqual(466);
        expect(overlap(piece, -350, 350, -436, 256)).toBe(false);
      }
    }
  });

  test('open-floor distribution spans both sides and front depth with singles and small clusters', async () => {
    const plants = (await pieces()).filter(p => p.kind !== 'starfish');
    expect(plants.filter(p => p.x < 0).length).toBeGreaterThanOrEqual(10);
    expect(plants.filter(p => p.x > 0).length).toBeGreaterThanOrEqual(10);
    expect(plants.filter(p => p.z < 0).length).toBeGreaterThanOrEqual(8);
    expect(plants.filter(p => p.z > 700).length).toBeGreaterThanOrEqual(8);
    expect(plants.filter(p => Math.abs(p.x) < 1380).length).toBeGreaterThanOrEqual(28);
    expect(plants.some(p => p.cluster !== null)).toBe(true);
    expect(plants.some(p => p.cluster === null)).toBe(true);
    for (let i = 0; i < plants.length; i++) for (let j = i + 1; j < plants.length; j++)
      expect(Math.hypot(plants[i]!.x - plants[j]!.x, plants[i]!.z - plants[j]!.z)).toBeGreaterThanOrEqual(125);
  });

  test('decoded sea-floor tops clear the board from all spawn camera heights', async () => {
    for (const { p: [x, y, z] } of (await assetVertices('TradingFloorSeaLife')).vertices) {
      expect(y).toBeLessThanOrEqual(140);
      expect(y).toBeLessThan(TRADING_FLOOR_CAMERA.above);
      expect(y).toBeLessThan(TRADING_FLOOR_SCREEN.bottomY);
      for (const camY of [140, 260, 410]) {
        const t = (1638 - TRADING_FLOOR_SCREEN.z) / (1638 - z);
        if (Math.abs(x * t) <= TRADING_FLOOR_SCREEN.width / 2)
          expect(camY + (y - camY) * t).toBeLessThan(TRADING_FLOOR_SCREEN.bottomY);
      }
    }
  });
});

describe('R4 procedural kiosk asset', () => {
  test('publishes exact bounds and decodes within 0.05 wu on every axis', async () => {
    expect(extras!.kiosk).toEqual({ x: -1000, y: 0, z: 1570, halfX: 240, halfZ: 70, height: 360, rotY: Math.PI });
    const { vertices, primitive } = await assetVertices('TradingFloorMonitorStation');
    const expected = [[-1240, -760], [0, 360], [1500, 1640]];
    for (let axis = 0; axis < 3; axis++) {
      const values = vertices.map(({ p }) => p[axis]!);
      expect(Math.abs(Math.min(...values) - expected[axis]![0]!)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(Math.max(...values) - expected[axis]![1]!)).toBeLessThanOrEqual(0.05);
    }
    const triangles = primitive.getIndices()!.getCount() / 3;
    expect(triangles).toBeGreaterThanOrEqual(600);
    expect(triangles).toBeLessThanOrEqual(900);
  });

  test('shares the desk material and removes the Meshy texture and props dependency', async () => {
    const doc = await decodedAsset;
    const meshes = doc.getRoot().listMeshes();
    const kiosk = meshes.find((mesh) => mesh.getName() === 'TradingFloorMonitorStation')!;
    const desk = meshes.find((mesh) => mesh.getName() === 'TradingFloorConsoleModule')!;
    expect(kiosk.listPrimitives()).toHaveLength(1);
    expect(kiosk.listPrimitives()[0]!.getMaterial()).toBe(desk.listPrimitives()[0]!.getMaterial());
    expect(doc.getRoot().listTextures().some((texture) => /MonitorStation/.test(texture.getName()))).toBe(false);
    const source = readFileSync(join(import.meta.dir, '../../../../../../scripts/trading-floor/build-interior.mjs'), 'utf8');
    expect(source).not.toMatch(/copyProp|PROPS_GLB|--props|existsSync/);
    expect(source).toContain("group('kiosk', 'collider in TRADING_FLOOR_SOLIDS'");
  });
});
