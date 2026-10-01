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
  TRADING_FLOOR_CAMERA_SOLID_CLEARANCE,
  TRADING_FLOOR_CAMERA_Z_MAX,
  TRADING_FLOOR_CAMERA_Z_MIN,
  TRADING_FLOOR_DESK_INNER_X,
  TRADING_FLOOR_PLAYER_RADIUS,
  pushCameraOutOfSolids,
  tradingFloorHitsSolid,
  TRADING_FLOOR_CHAIR_HALF_X,
  TRADING_FLOOR_CHAIR_HALF_Z,
  TRADING_FLOOR_CHAIR_SEAT_Y,
  TRADING_FLOOR_CONSOLE_HALF_X,
  TRADING_FLOOR_CONSOLE_HALF_Z,
  TRADING_FLOOR_CONSOLE_HEIGHT,
  TRADING_FLOOR_CONSOLE_ROW,
  TRADING_FLOOR_MONITOR,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_SCREEN,
  TRADING_FLOOR_SOLIDS,
} from './trading-floor-room';
import { DECOR_BANK, DECOR_DESK_HOOD } from './trading-floor-decor-layout';

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
  materials: { name?: string; pbrMetallicRoughness?: { metallicFactor?: number } }[];
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
      'screen',
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
    expect(top + 68).toBeLessThanOrEqual(TRADING_FLOOR_ROOM.height);
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
      color: colors?.getElement(index, []),
    };
  });
  return { vertices, primitive };
}

describe('Trading Floor asset — A3 camera clearance and claw sculpt', () => {
  test('all four wall bands clear the camera by at least 6 wu below its maximum height', async () => {
    const doc = await decodedAsset;
    const maximumY = TRADING_FLOOR_CAMERA.above + TRADING_FLOOR_CAMERA.pitchMax;
    const failures: string[] = [], margins = [Infinity, Infinity, Infinity, Infinity];
    for (const node of doc.getRoot().listNodes()) {
      // The floor spans every wall band but sits below the camera's Y floor.
      // No board exemption: even its bottom surround and glow must clear.
      if (!node.getMesh() || node.getName() === 'TradingFloorFloorSlab') continue;
      const { vertices } = await assetVertices(node.getName());
      for (const { p: [x, y, z] } of vertices) {
        if (y > maximumY) continue;
        // A wall-mounted vertex occupies the inner-face-to-player-clamp band.
        // Centre props and collider pillars lie outside these four wall bands.
        const candidates = [
          x <= -TRADING_FLOOR_ROOM.halfX + TRADING_FLOOR_PLAYER_RADIUS ? -x - TRADING_FLOOR_DESK_INNER_X : Infinity,
          x >= TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_PLAYER_RADIUS ? x - TRADING_FLOOR_DESK_INNER_X : Infinity,
          z <= -TRADING_FLOOR_ROOM.halfZ + TRADING_FLOOR_PLAYER_RADIUS ? TRADING_FLOOR_CAMERA_Z_MIN - z : Infinity,
          z >= TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS ? z - TRADING_FLOOR_CAMERA_Z_MAX : Infinity,
        ];
        candidates.forEach((margin, wall) => {
          margins[wall] = Math.min(margins[wall]!, margin);
          if (margin < 6) failures.push(`${node.getName()} wall ${wall}: [${x},${y},${z}] margin ${margin}`);
        });
      }
    }
    expect(margins.every(Number.isFinite)).toBe(true);
    console.log(`wall camera margins left/right/back/front: ${margins.map((v) => v.toFixed(4)).join('/')} wu; y <= ${maximumY}`);
    expect(failures).toEqual([]);
  });

  test('each claw has at most 40 inverted or degenerate triangles after room-wide quantization', async () => {
    const { vertices, primitive } = await assetVertices('TradingFloorBrass');
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

  test('sculpt shading stays neutral and leaves every other brass vertex white', async () => {
    const { vertices, primitive } = await assetVertices('TradingFloorBrass');
    expect(primitive.getAttribute('COLOR_0')!.getCount()).toBe(vertices.length);
    expect(primitive.getMaterial()!.getExtension('KHR_materials_unlit')).toBeNull();
    expect(primitive.getMaterial()!.getBaseColorFactor()).toEqual([.62, .40, .10, 1]);
    expect(primitive.getMaterial()!.getRoughnessFactor()).toBe(.32);
    expect(primitive.getMaterial()!.getMetallicFactor()).toBeLessThanOrEqual(.45);
    const shades: number[] = [];
    for (const { p, color } of vertices) {
      const claw = extras!.statue!.claws.some((bounds) =>
        p.every((v, axis) => v >= bounds.min[axis]! - .2 && v <= bounds.max[axis]! + .2));
      expect(color).toBeDefined();
      if (claw) {
        expect(Math.max(...color!) - Math.min(...color!)).toBe(0);
        expect(color![0]!).toBeGreaterThanOrEqual(.44);
        expect(color![0]!).toBeLessThanOrEqual(1);
        shades.push(color![0]!);
      } else expect(color).toEqual([1, 1, 1]);
    }
    expect(Math.max(...shades) - Math.min(...shades)).toBeGreaterThan(.3);
  });

  test('portal contacts have deliberate clearance and the plate fits the lowest tier', async () => {
    const brass = (await assetVertices('TradingFloorBrass')).vertices.map(({ p }) => p);
    const walls = (await assetVertices('TradingFloorWalls')).vertices.map(({ p }) => p);
    const trim = (await assetVertices('TradingFloorTrimGlow')).vertices;
    const jamb = brass.filter(([x, y, z]) => Math.abs(x) > 176 && Math.abs(x) < 208 && y < 501 && z > 1090 && z < 1107);
    const reveal = walls.filter(([x, y, z]) => Math.abs(x) > 100 && Math.abs(x) < 300 && y < 410 && z > 1099);
    const header = brass.filter(([x, y, z]) => Math.abs(x) < 209 && y > 490 && y < 505 && z > 1085 && z < 1107);
    const lintel = walls.filter(([x, y, z]) => Math.abs(x) < 200 && y > 490 && y < 510 && z > 1099);
    for (const points of [jamb, reveal, header, lintel]) expect(points.length).toBeGreaterThan(0);
    const jambInner = Math.min(...jamb.map(([x]) => Math.abs(x)));
    const revealInner = Math.min(...reveal.map(([x]) => Math.abs(x)));
    const headerBottom = Math.min(...header.map((p) => p[1]));
    const lintelBottom = Math.min(...lintel.map((p) => p[1]));
    const lintelEdge = Math.min(...lintel.map(([x]) => Math.abs(x)));
    expect(Math.abs(jambInner - revealInner)).toBeGreaterThanOrEqual(2);
    expect(lintelEdge - jambInner).toBeGreaterThanOrEqual(2);
    expect(lintelBottom - headerBottom).toBeGreaterThanOrEqual(2);
    const standoffs = brass.filter(([x, y, z]) => Math.abs(x) > 18 && Math.abs(x) < 30 && y > 174 && y < 186 && z > 1110 && z < 1131);
    const glass = trim.filter(({ p: [x, y, z], color }) =>
      Math.abs(x) < 180 && y > 10 && y < 490 && z > 1127 && color![0]! < .025);
    expect(standoffs.length).toBeGreaterThan(0); expect(glass.length).toBeGreaterThan(0);
    const standoffBack = Math.max(...standoffs.map((p) => p[2]));
    const glassFront = Math.min(...glass.map(({ p }) => p[2]));
    // A small insertion removes the gap; separate contact planes cannot flicker.
    expect(standoffBack - glassFront).toBeGreaterThan(.2);
    expect(standoffBack - glassFront).toBeLessThan(2);
    const plate = brass.filter(([x, y, z]) => Math.abs(x) < 131 && y > 3 && y < 29 && z > 285 && z < 293);
    expect(plate.length).toBeGreaterThan(0);
    expect(Math.min(...plate.map((p) => p[1]))).toBeGreaterThan(3);
    expect(Math.max(...plate.map((p) => p[1]))).toBeLessThan(29);
    expect(plate.every(([x, , z]) => Math.hypot(x, z + 60) < 380)).toBe(true);
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
  test('one primitive per row, module budgets and atlas size survive compression', async () => {
    const doc = await decodedAsset;
    for (const [name, budget] of [['TradingFloorConsoleModule', 1500], ['TradingFloorChairModule', 900]] as const) {
      const node = doc.getRoot().listNodes().find((candidate) => candidate.getName() === name)!;
      const primitives = node.getMesh()!.listPrimitives();
      expect(primitives).toHaveLength(1);
      expect(primitives[0]!.getIndices()!.getCount() / 3).toBeLessThanOrEqual(budget);
      expect(node.getRotation()).toEqual([0, 0, 0, 1]);
    }
    const desk = doc.getRoot().listMaterials().find((material) => material.getName() === 'TradingFloorConsoleModuleMtl')!;
    expect(desk.getBaseColorTexture()!.getSize()).toEqual([512, 256]);
    expect(desk.getBaseColorTexture()!.getImage()!.byteLength).toBeLessThan(16000);
    const chair = doc.getRoot().listMaterials().find((material) => material.getName() === 'TradingFloorChair')!;
    expect(chair.getRoughnessFactor()).toBe(0.48);
    expect(chair.getMetallicFactor()).toBe(0.18);
    expect(readFileSync(GLB_PATH).byteLength).toBeLessThanOrEqual(650000);
    const total = doc.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())
      .reduce((sum, primitive) => sum + primitive.getIndices()!.getCount() / 3, 0);
    expect(total).toBeLessThanOrEqual(16000);
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
    for (const axis of [0, 2]) {
      const half = axis === 0 ? TRADING_FLOOR_CHAIR_HALF_X : TRADING_FLOOR_CHAIR_HALF_Z;
      expect(Math.abs(Math.min(...points.map((p) => p[axis]!)) + half)).toBeLessThan(TOL);
      expect(Math.abs(Math.max(...points.map((p) => p[axis]!)) - half)).toBeLessThan(TOL);
    }
  });
});

describe('Trading Floor asset — the monitor kiosk matches its hotspot', () => {
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
    expect(Math.abs(solid!.halfX - half.x)).toBeLessThan(TOL);
    expect(Math.abs(solid!.halfZ - half.z)).toBeLessThan(TOL);
  });

  test('both measured claws clear the board from spawn and default-height reachable poses', async () => {
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
    });
    const doc = await io.read(GLB_PATH);
    const brass = doc.getRoot().listNodes().find((node) => node.getName() === 'TradingFloorBrass');
    expect(brass).toBeDefined();
    const mesh = brass!.getMesh()!.listPrimitives()[0]!;
    const accessor = mesh.getAttribute('POSITION')!;
    const positions = accessor.getArray()!;
    const divisor = accessor.getNormalized() && positions instanceof Int16Array ? 32767 : 1;
    const world = brass!.getWorldMatrix();
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
      expect(bounds.min[2]!).toBeGreaterThanOrEqual(-220);
      expect(bounds.max[2]!).toBeLessThanOrEqual(100);
      for (const point of points[claw]!) {
        expect(Math.abs(point.x) + Math.abs(point.z + 60)).toBeLessThanOrEqual(435 + 1);
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

    // Match the room camera: 520 wu arm, axis clamp, solid push, 60-degree FOV.
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
      const bodies: [number, number][] = spawnOnly ? [[0, 780]] : [];
      if (!spawnOnly) for (let x = -1254; x <= 1254; x += 48)
        for (let z = -1054; z <= 920; z += 48)
          if (!tradingFloorHitsSolid(x, z)) bodies.push([x, z]);
      for (const [bx, bz] of bodies) for (let degrees = 0; degrees < 360; degrees += spawnOnly ? 2 : 15) {
        const yaw = degrees * Math.PI / 180;
        const forwardX = Math.sin(yaw), forwardZ = -Math.cos(yaw);
        const camera = {
          x: Math.max(-TRADING_FLOOR_DESK_INNER_X, Math.min(TRADING_FLOOR_DESK_INNER_X,
            bx - forwardX * TRADING_FLOOR_CAMERA.behind)),
          z: Math.max(TRADING_FLOOR_CAMERA_Z_MIN, Math.min(TRADING_FLOOR_CAMERA_Z_MAX,
            bz - forwardZ * TRADING_FLOOR_CAMERA.behind)),
        };
        pushCameraOutOfSolids(camera, TRADING_FLOOR_SOLIDS, TRADING_FLOOR_CAMERA_SOLID_CLEARANCE);
        const lookX = bx + forwardX * TRADING_FLOOR_CAMERA.lookAhead;
        const lookZ = bz + forwardZ * TRADING_FLOOR_CAMERA.lookAhead;
        for (let claw = 0; claw < 2; claw++) for (const point of points[claw]!) {
          if (camera.z <= point.z + 1) continue;
          const t = (camera.z - TRADING_FLOOR_SCREEN.z) / (camera.z - point.z);
          const boardX = camera.x + (point.x - camera.x) * t;
          if (Math.abs(boardX) > TRADING_FLOOR_SCREEN.width / 2) continue;
          const shadowY = camY + (point.y - camY) * t;
          const boardY = Math.max(TRADING_FLOOR_SCREEN.bottomY,
            Math.min(shadowY, TRADING_FLOOR_SCREEN.bottomY + TRADING_FLOOR_SCREEN.height));
          if (inFrame(camera.x, camY, camera.z, lookX, lookZ, boardX, boardY))
            worst[claw] = Math.max(worst[claw]!, shadowY);
        }
      }
      return worst;
    };
    for (const camY of [140, 260, 410]) {
      const worst = worstShadow(camY, true);
      console.log(`statue spawn camera ${camY}: left ${worst[0]!.toFixed(2)}, right ${worst[1]!.toFixed(2)}, sill 360`);
      expect(Math.max(...worst)).toBeLessThanOrEqual(TRADING_FLOOR_SCREEN.bottomY);
    }
    const reachable = worstShadow(TRADING_FLOOR_CAMERA.above, false);
    console.log(`statue reachable camera 260: left ${reachable[0]!.toFixed(2)}, right ${reachable[1]!.toFixed(2)}, sill 360`);
    expect(Math.max(...reachable)).toBeLessThanOrEqual(TRADING_FLOOR_SCREEN.bottomY);
  });
});

describe('Trading Floor asset — v4 colours, seal and portal', () => {
  test('the seal and both banners share one draw call', () => {
    expect(gltf.meshes).toHaveLength(10);
    expect(gltf.materials).toHaveLength(10);
    expect(gltf.textures).toHaveLength(7);
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
      if (Math.hypot(x, z + 60) <= 600) expect(y).toBeGreaterThan(15);
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
      if (Math.abs(x!) > 180 || y! < 10 || y! > 490 || z! < 1127 || z! > 1137) continue;
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
    const pillars = TRADING_FLOOR_SOLIDS.filter((solid) => solid.halfX === 55);
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
