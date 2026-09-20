import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  consoleHalfExtents,
  AUTHORED_PROP_TOLERANCE_WU,
  TRADING_FLOOR_CHAIR_HALF_X,
  TRADING_FLOOR_CHAIR_HALF_Z,
  TRADING_FLOOR_CONSOLE_HALF_X,
  TRADING_FLOOR_CONSOLE_HALF_Z,
  TRADING_FLOOR_CONSOLE_HEIGHT,
  TRADING_FLOOR_CONSOLE_ROW,
  TRADING_FLOOR_MONITOR,
  TRADING_FLOOR_ROOM,
  TRADING_FLOOR_SCREEN,
  TRADING_FLOOR_SOLIDS,
} from './trading-floor-room';

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
}
interface GltfJson {
  scene?: number;
  scenes: { extras?: GltfSceneExtras }[];
  nodes: GltfNode[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
  accessors: GltfAccessor[];
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
  test('extras survives the compression pipeline and carries all three blocks', () => {
    expect(extras).toBeDefined();
    expect(Object.keys(extras ?? {}).sort()).toEqual([
      'contract',
      'kiosk',
      'room',
      'screen',
    ]);
    for (const value of [
      extras?.screen?.width,
      extras?.kiosk?.halfX,
      extras?.room?.halfX,
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
  // Tolerance is 5 wu here, not the usual 1, and the reason is measured rather
  // than defensive: the chair's base spider dips to y -2.00 (top 173.00), which
  // agrees with the Blender importer's `min=[-64,-61,-2] max=[64,61,173]`. Two
  // wu of a chair foot inside a 60 wu floor slab is invisible and not worth an
  // asset change, but it is real and a 1 wu bound would fail on it.
  test('both instanced props carry their base-seating offset on the node', () => {
    for (const name of ['TradingFloorConsoleModule', 'TradingFloorChairModule']) {
      const node = nodeByName(name);
      const base = translation(node).y - worldHalfExtents(node).y;
      expect({ name, sunkBy: Math.abs(base) < 5 }).toEqual({ name, sunkBy: true });
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
