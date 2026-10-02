import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { FLOOR_ARENA_TEMPLATES } from '@clawville/shared';

/**
 * trading-floor-house-agents-asset.test.ts
 *
 * Reads the SHIPPED house-agent GLB (P15 task T3) and pins the asset contract
 * in `ops/house-traders/arena-review/P15_PLAN_2026-10-02.md` §2:
 *
 *   - five mesh nodes `HouseAgent_<templateId>`, in FLOOR_ARENA_TEMPLATES order;
 *   - ONE opaque material and ONE KTX2 (ETC1S) texture, at most 1024 x 1024;
 *   - a static mesh: no skin, no JOINTS_0 / WEIGHTS_0, no morph targets, no
 *     animations (so the P10 first-draw freeze of a late skinned VRM cannot apply);
 *   - at most 6,000 triangles per figure and 30,000 in total;
 *   - each figure 270 +/- 5 wu tall, feet at y 0, centred on its node origin,
 *     facing +Z, with `extras.facing === '+Z'`;
 *   - the file at most 600 KB.
 *
 * Two pins go beyond the plan text because the T4 mount depends on them:
 *   - every node has an IDENTITY transform and POSITION is plain FLOAT. The mount
 *     writes `position`, `rotation.y` and a breathing `scale.y` straight onto the
 *     node. A quantizer node transform (translation + scale) would be silently
 *     overwritten by those writes, and the figure would shrink to a dot.
 *   - +Z facing is checked on the GEOMETRY (the toes of the feet), not only on
 *     the extras string, because a string cannot be wrong in a way a test sees.
 *
 * The glTF JSON chunk is parsed directly (as `trading-floor-asset.test.ts`
 * does). Only the facing check decodes vertex data, through NodeIO and the
 * meshopt decoder.
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
  'trading-floor-house-agents.glb',
);

const MAX_FILE_BYTES = 600 * 1024;
const MAX_TRIS_PER_FIGURE = 6_000;
const MAX_TRIS_TOTAL = 30_000;
const HEIGHT_MIN_WU = 265;
const HEIGHT_MAX_WU = 275;
const FEET_Y_TOL_WU = 0.5;
const CENTRE_TOL_WU = 40;
const MAX_TEXTURE_PX = 1024;

const GL_FLOAT = 5126;
const GL_TRIANGLES = 4;
const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const KTX2_SUPERCOMPRESSION_BASISLZ = 1; // ETC1S payloads are BasisLZ-supercompressed
const KHR_DF_MODEL_ETC1S = 163;
const KHR_DF_TRANSFER_SRGB = 2;

interface GltfAccessor {
  bufferView?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: unknown[];
}
interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extras?: { facing?: string; templateId?: string };
}
interface GltfMaterial {
  alphaMode?: string;
  doubleSided?: boolean;
  pbrMetallicRoughness?: {
    baseColorTexture?: { index: number };
    metallicRoughnessTexture?: unknown;
    metallicFactor?: number;
  };
  normalTexture?: unknown;
  occlusionTexture?: unknown;
  emissiveTexture?: unknown;
  extensions?: Record<string, unknown>;
}
interface GltfJson {
  scene?: number;
  scenes: { nodes?: number[] }[];
  nodes: GltfNode[];
  meshes: { primitives: GltfPrimitive[] }[];
  accessors: GltfAccessor[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number }[];
  materials?: GltfMaterial[];
  textures?: { source?: number; extensions?: { KHR_texture_basisu?: { source: number } } }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  skins?: unknown[];
  animations?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

interface ParsedGlb {
  json: GltfJson;
  bin: Buffer;
}

/** Read the JSON and BIN chunks out of a binary glTF container. */
function parseGlb(bytes: Buffer): ParsedGlb {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
  expect(bytes.readUInt32LE(4)).toBe(2);
  const jsonLength = bytes.readUInt32LE(12);
  expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a); // 'JSON'
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as GltfJson;
  const binHeader = 20 + jsonLength;
  expect(bytes.readUInt32LE(binHeader + 4)).toBe(0x004e4942); // 'BIN\0'
  const binLength = bytes.readUInt32LE(binHeader);
  return { json, bin: bytes.subarray(binHeader + 8, binHeader + 8 + binLength) };
}

const glbBytes = existsSync(GLB_PATH) ? readFileSync(GLB_PATH) : null;
const parsed = glbBytes ? parseGlb(glbBytes) : null;

/** Every contract test fails with this message, not a TypeError, when the GLB is missing. */
function glb(): ParsedGlb {
  if (!parsed) {
    throw new Error(
      `[house-agents asset] ${GLB_PATH} does not exist. ` +
        'Build it: node scripts/trading-floor/build-house-agents.mjs',
    );
  }
  return parsed;
}

const EXPECTED_NAMES = FLOOR_ARENA_TEMPLATES.map((template) => `HouseAgent_${template.id}`);

function figureNodes(): GltfNode[] {
  const { json } = glb();
  return EXPECTED_NAMES.map((name) => {
    const node = json.nodes.find((candidate) => candidate.name === name);
    if (!node) throw new Error(`[house-agents asset] no node named "${name}"`);
    return node;
  });
}

function onlyPrimitive(node: GltfNode): GltfPrimitive {
  const { json } = glb();
  expect(node.mesh).toBeNumber();
  const primitives = json.meshes[node.mesh!]!.primitives;
  expect(primitives.length).toBe(1); // one draw call per figure (the per-figure hide rule needs it)
  return primitives[0]!;
}

function trisOf(node: GltfNode): number {
  const { json } = glb();
  const primitive = onlyPrimitive(node);
  expect(primitive.indices).toBeNumber();
  return json.accessors[primitive.indices!]!.count / 3;
}

function positionBounds(node: GltfNode): { min: number[]; max: number[] } {
  const { json } = glb();
  const accessor = json.accessors[onlyPrimitive(node).attributes.POSITION!]!;
  expect(accessor.min).toHaveLength(3);
  expect(accessor.max).toHaveLength(3);
  return { min: accessor.min!, max: accessor.max! };
}

describe('house-agents asset: the file', () => {
  test('the GLB exists', () => {
    expect(existsSync(GLB_PATH)).toBe(true);
  });

  test(`the file is at most ${MAX_FILE_BYTES} bytes (600 KB)`, () => {
    glb();
    expect(statSync(GLB_PATH).size).toBeLessThanOrEqual(MAX_FILE_BYTES);
  });
});

describe('house-agents asset: five figure nodes in template order', () => {
  test('FLOOR_ARENA_TEMPLATES still has the five P15 templates', () => {
    expect(FLOOR_ARENA_TEMPLATES.map((template) => template.id)).toEqual([
      'genesis',
      'runner',
      'dip-hunter',
      'midcap-climber',
      'late-bloomer',
    ]);
  });

  test('exactly five nodes, named HouseAgent_<templateId>, in template order', () => {
    const { json } = glb();
    expect(json.nodes.map((node) => node.name)).toEqual(EXPECTED_NAMES);
    const scene = json.scenes[json.scene ?? 0]!;
    expect((scene.nodes ?? []).map((index) => json.nodes[index]!.name)).toEqual(EXPECTED_NAMES);
  });

  test('each node is a leaf mesh node with an identity transform', () => {
    for (const node of figureNodes()) {
      expect(node.mesh).toBeNumber();
      expect(node.children ?? []).toEqual([]);
      expect(node.skin).toBeUndefined();
      expect(node.matrix).toBeUndefined();
      expect(node.translation).toBeUndefined();
      expect(node.rotation).toBeUndefined();
      expect(node.scale).toBeUndefined();
    }
  });

  test("each node carries extras.facing '+Z' and its template id", () => {
    figureNodes().forEach((node, index) => {
      expect(node.extras?.facing).toBe('+Z');
      expect(node.extras?.templateId).toBe(FLOOR_ARENA_TEMPLATES[index]!.id);
    });
  });
});

describe('house-agents asset: static mesh, no skinning', () => {
  test('no skins and no animations', () => {
    const { json } = glb();
    expect(json.skins ?? []).toEqual([]);
    expect(json.animations ?? []).toEqual([]);
  });

  test('no JOINTS_n / WEIGHTS_n attributes and no morph targets on any primitive', () => {
    const { json } = glb();
    for (const mesh of json.meshes) {
      for (const primitive of mesh.primitives) {
        const keys = Object.keys(primitive.attributes);
        expect(keys.filter((key) => /^(JOINTS|WEIGHTS)_\d+$/.test(key))).toEqual([]);
        expect(primitive.targets ?? []).toEqual([]);
        expect(primitive.mode ?? GL_TRIANGLES).toBe(GL_TRIANGLES);
        expect(keys).toContain('NORMAL');
        expect(keys).toContain('TEXCOORD_0');
      }
    }
  });

  test('POSITION is plain FLOAT, so the node needs no dequantization transform', () => {
    const { json } = glb();
    for (const node of figureNodes()) {
      const accessor = json.accessors[onlyPrimitive(node).attributes.POSITION!]!;
      expect(accessor.componentType).toBe(GL_FLOAT);
      expect(accessor.normalized ?? false).toBe(false);
    }
  });
});

describe('house-agents asset: triangle budget', () => {
  test(`each figure has at most ${MAX_TRIS_PER_FIGURE} triangles`, () => {
    for (const node of figureNodes()) {
      expect(trisOf(node)).toBeLessThanOrEqual(MAX_TRIS_PER_FIGURE);
    }
  });

  test(`all figures together have at most ${MAX_TRIS_TOTAL} triangles`, () => {
    const total = figureNodes().reduce((sum, node) => sum + trisOf(node), 0);
    expect(total).toBeLessThanOrEqual(MAX_TRIS_TOTAL);
  });
});

describe('house-agents asset: size, grounding and centring (1 unit = 1 wu)', () => {
  test(`each figure is ${HEIGHT_MIN_WU}..${HEIGHT_MAX_WU} wu tall`, () => {
    for (const node of figureNodes()) {
      const { min, max } = positionBounds(node);
      const height = max[1]! - min[1]!;
      expect(height).toBeGreaterThanOrEqual(HEIGHT_MIN_WU);
      expect(height).toBeLessThanOrEqual(HEIGHT_MAX_WU);
    }
  });

  test('each figure stands with its feet at y 0', () => {
    for (const node of figureNodes()) {
      expect(Math.abs(positionBounds(node).min[1]!)).toBeLessThanOrEqual(FEET_Y_TOL_WU);
    }
  });

  test(`each figure is centred on its node origin within ${CENTRE_TOL_WU} wu`, () => {
    for (const node of figureNodes()) {
      const { min, max } = positionBounds(node);
      expect(Math.abs((min[0]! + max[0]!) / 2)).toBeLessThanOrEqual(CENTRE_TOL_WU);
      expect(Math.abs((min[2]! + max[2]!) / 2)).toBeLessThanOrEqual(CENTRE_TOL_WU);
    }
  });

  /**
   * The feet point forward, measured on the geometry (no bones survive the bake):
   *   - at sole height (y < 6) the toes reach further toward +Z than the heels
   *     reach toward -Z (shipped build: toes +18.1..18.5, heels -12.8..-13.2);
   *   - the shins (y 20..35) stand BEHIND the middle of the feet, because the
   *     ankle sits over the heel (shipped build: 4.9..5.8 wu behind).
   * A figure baked facing -Z inverts both signs, so a 2 wu margin separates the
   * two cases by ~10 wu.
   */
  test('each figure faces +Z: the toes point toward +Z', async () => {
    glb();
    await MeshoptDecoder.ready;
    const document = await new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
      .read(GLB_PATH);
    for (const name of EXPECTED_NAMES) {
      const node = document.getRoot().listNodes().find((candidate) => candidate.getName() === name);
      expect(node).toBeDefined();
      const position = node!.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!;
      const element: number[] = [];
      let toe = -Infinity;
      let heel = Infinity;
      let shinZ = 0;
      let shinCount = 0;
      for (let index = 0; index < position.getCount(); index++) {
        position.getElement(index, element);
        const [, y, z] = element as [number, number, number];
        if (y < 6) {
          toe = Math.max(toe, z);
          heel = Math.min(heel, z);
        } else if (y > 20 && y < 35) {
          shinZ += z;
          shinCount++;
        }
      }
      expect(Number.isFinite(toe) && Number.isFinite(heel)).toBe(true);
      expect(shinCount).toBeGreaterThan(0);
      expect(toe).toBeGreaterThan(10);
      expect(toe).toBeGreaterThan(-heel + 2);
      expect(shinZ / shinCount).toBeLessThan((toe + heel) / 2 - 2);
    }
  });
});

describe('house-agents asset: one material, one KTX2 (ETC1S) texture', () => {
  test('exactly one opaque, non-metallic material, used by every figure', () => {
    const { json } = glb();
    expect(json.materials ?? []).toHaveLength(1);
    const material = json.materials![0]!;
    expect(material.alphaMode ?? 'OPAQUE').toBe('OPAQUE');
    expect(material.pbrMetallicRoughness?.metallicFactor).toBe(0);
    expect(material.pbrMetallicRoughness?.baseColorTexture?.index).toBe(0);
    // ONE texture means no second map in any other slot.
    expect(material.pbrMetallicRoughness?.metallicRoughnessTexture).toBeUndefined();
    expect(material.normalTexture).toBeUndefined();
    expect(material.occlusionTexture).toBeUndefined();
    expect(material.emissiveTexture).toBeUndefined();
    for (const node of figureNodes()) {
      expect(onlyPrimitive(node).material).toBe(0);
    }
  });

  test('exactly one texture and one image, stored as KTX2 through KHR_texture_basisu', () => {
    const { json } = glb();
    expect(json.textures ?? []).toHaveLength(1);
    expect(json.images ?? []).toHaveLength(1);
    const texture = json.textures![0]!;
    expect(texture.extensions?.KHR_texture_basisu?.source).toBe(0);
    expect(json.images![0]!.mimeType).toBe('image/ktx2');
    expect(json.images![0]!.uri).toBeUndefined();
    expect(json.extensionsRequired ?? []).toContain('KHR_texture_basisu');
  });

  test(`the KTX2 payload is ETC1S, sRGB, at most ${MAX_TEXTURE_PX} px, with a full mip chain`, () => {
    const { json, bin } = glb();
    const view = json.bufferViews[json.images![0]!.bufferView!]!;
    const ktx = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    expect([...ktx.subarray(0, 12)]).toEqual(KTX2_IDENTIFIER);
    const width = ktx.readUInt32LE(20);
    const height = ktx.readUInt32LE(24);
    const levelCount = ktx.readUInt32LE(40);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(MAX_TEXTURE_PX);
    expect(height).toBeLessThanOrEqual(MAX_TEXTURE_PX);
    // Compressed textures cannot generate mipmaps at runtime; the file must carry them.
    expect(levelCount).toBe(Math.floor(Math.log2(Math.max(width, height))) + 1);
    expect(ktx.readUInt32LE(44)).toBe(KTX2_SUPERCOMPRESSION_BASISLZ);
    // Data format descriptor: basic block, colour model ETC1S, sRGB transfer.
    const dfd = ktx.readUInt32LE(48);
    expect(ktx[dfd + 12]).toBe(KHR_DF_MODEL_ETC1S);
    expect(ktx[dfd + 14]).toBe(KHR_DF_TRANSFER_SRGB);
  });
});
