#!/usr/bin/env node
// build-house-agents.mjs — bake the five P15 house-agent figures into ONE static GLB.
//
// Contract: ops/house-traders/arena-review/P15_PLAN_2026-10-02.md §2 "Asset
// contract (T3)", pinned by
// apps/web/src/lib/three/trading-floor/trading-floor-house-agents-asset.test.ts.
//
//   - five mesh nodes `HouseAgent_<templateId>` in FLOOR_ARENA_TEMPLATES order;
//   - each a STATIC mesh: no skin, no JOINTS_0 / WEIGHTS_0, no morph targets, no
//     animations, so the P10 first-draw freeze of a late skinned VRM cannot apply;
//   - at most 6,000 triangles per figure, height 270 +/- 5 wu, feet at y 0,
//     centred on the node origin, facing +Z, `extras.facing = "+Z"`;
//   - ONE opaque material and ONE KTX2 (ETC1S) atlas of at most 1024 x 1024;
//   - at most 600 KB.
//
// WHY A BAKE AND NOT FIVE LIVE VRMs: five skinned VRMs cost 1-12 draws each,
// five animators, and every candidate VRM has an 8-bit JOINTS_0, which is the
// P10 WebGL2 first-draw freeze (633-667 ms) five times over. A baked mesh has
// no skin attributes, so none of that applies. Cost: +5 draw calls.
//
// PIPELINE (all in Node, no GUI, deterministic):
//   1. Load each VRM with three's GLTFLoader + @pixiv/three-vrm exactly as the
//      game does (`vrm-loader.ts` normaliseVRM: removeUnnecessaryVertices, then
//      rotateVRM0). Textures are stubbed for the load; the pixels are read
//      separately from the GLB binary with sharp.
//   2. Size it like the game: `computeVRMAvatarFit` scales the REST-pose skinned
//      bounding box to 270 wu. The same scale is used here, so a figure stands
//      at the height of a live Milady player with the same look.
//   3. Pose it with the GAME'S OWN retarget: `/avatars/animations/idle.glb`
//      (the clip `vrm-character-animator.ts` plays for every Milady; no
//      per-character override exists for them) through `retargetMixamoClip`
//      from `apps/web/src/lib/three/mixamo-retarget.ts`, imported directly, so
//      the baked pose follows the live retarget if it ever changes. One frame
//      per figure (`idleTimeS` in FIGURES), so the five stand slightly differently.
//   4. Skin every vertex on the CPU exactly as three r185's skinning shader
//      does (position AND normal through the blended bone matrix; see
//      skinVertices), move the hips to x = z = 0 and the lowest point to y = 0.
//   5. Resolve each source material into the single opaque material:
//        - OPAQUE parts keep their texture x baseColorFactor;
//        - textured BLEND overlays (`SkinEye`, the eyeballs that fill the eye
//          holes of the face, and `Mouth`) are composited over the face skin
//          around them, because one opaque material cannot blend;
//        - untextured BLEND parts below alpha 0.5 (glasses lenses) are dropped:
//          an opaque lens would be a solid disc over the eyes. Their colour is
//          kept as a tint on the eye overlays behind them (alpha-blended in
//          order), so tinted glasses still read as tinted;
//        - metallic parts are darkened toward what MeshStandardMaterial shows
//          with no environment map (the Trading Floor has none), because the
//          single material is metallic 0.
//      All VRMs here are VRM 0.x with `VRM_USE_GLTFSHADER`, i.e. the game draws
//      them with plain MeshStandardMaterial, not MToon. Roughness 0.5 /
//      metallic 0 is the factor of the dominant Skin material, so the baked
//      figures shade like the live avatars under the same lights.
//   6. Simplify each figure to <= 6,000 triangles with meshoptimizer
//      (simplifyWithAttributes, normals + UVs weighted). One call per figure
//      spends the budget where the error is lowest, so dense accessories (a
//      gold glasses frame of 8,448 triangles) lose detail before the face does.
//      The eye and mouth overlays (~50 triangles) are vertex-locked: unlocked,
//      the mouth fell from 28 to 6 triangles and the smile broke apart. UVs of
//      flat-colour islands are zeroed for the error metric (they carry no data).
//   7. Pack a 1024 x 1024 atlas from UV ISLANDS, not whole textures. Space is
//      allocated by SURFACE AREA (atlas px per wu), never above source
//      resolution; front-facing face islands and overlays get 2x. Each island is
//      a crop of its UV bounds (REPEAT wrap honoured); near-uniform islands
//      become 16 px flat swatches. A binary search picks the largest density
//      that packs (skyline packer). Supersampled bilinear, linear-light colour.
//   8. Encode the atlas with toktx (KTX-Software 4.x) to KTX2 ETC1S, sRGB, full
//      mip chain; embed it through KHR_texture_basisu.
//   9. Write FLOAT positions (rounded to 1/64 wu so the meshopt codec compresses
//      them), int8 normals and uint16 UVs (KHR_mesh_quantization, no node
//      transform needed), then EXT_meshopt_compression. int8 VEC3 normals at
//      byteStride 4 are the format of live world GLBs such as
//      `models/boating-school-opt1-ktx.glb`, so both render backends already
//      draw it; int16 normals cost +70 KB here. Every node has an
//      IDENTITY transform: the T4 mount writes position, rotation.y and a
//      breathing scale.y straight onto the node, which would silently overwrite
//      a quantizer's node translation + scale.
//
// Usage (Node 24+ runs the imported .ts files natively; Bun also works):
//   node scripts/trading-floor/build-house-agents.mjs [--out <glb>] [--debug-dir <dir>]
// Default --out: apps/web/public/models/trading-floor/trading-floor-house-agents.glb
// Served as `?v=1`. ANY byte change to the shipped file needs `?v=2` at the mount
// (Cloudflare caches /models for a week and we cannot purge it).
// Needs toktx on PATH, or KTX2_TOKTX_BIN, same as scripts/compress-ktx2.ts.

import { Document, NodeIO, TextureInfo } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu } from '@gltf-transform/extensions';
import { reorder, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, 'apps', 'web');
const PUBLIC = join(WEB, 'public');

// ---------------------------------------------------------------------------
// Inputs and contract numbers
// ---------------------------------------------------------------------------

/** One look per house agent, in FLOOR_ARENA_TEMPLATES order (asserted below).
 *  Milady official 2-6 per the plan; official 1 is the default player look and
 *  is deliberately not used. `idleTimeS` is the idle.glb frame baked (s). */
const FIGURES = [
  { templateId: 'genesis', look: 2, idleTimeS: 0 },
  { templateId: 'runner', look: 3, idleTimeS: 4 },
  { templateId: 'dip-hunter', look: 4, idleTimeS: 8 },
  { templateId: 'midcap-climber', look: 5, idleTimeS: 2 },
  { templateId: 'late-bloomer', look: 6, idleTimeS: 6 },
];

const IDLE_CLIP_PATH = '/avatars/animations/idle.glb';
const TARGET_HEIGHT_WU = 270; // VRM_AVATAR_TARGET_HEIGHT_WU in vrm-avatar-sizing.ts
const HEIGHT_TOL_WU = 5;
const MAX_TRIS_PER_FIGURE = 6000;
const MAX_FILE_BYTES = 600 * 1024;
const ATLAS_PX = 1024;
const ISLAND_PAD_PX = 4; // one ETC1S block of gutter on each side
const SWATCH_PX = 16; // flat-colour block, gutter included
const FACE_DENSITY = 2; // face islands get 2x the texel density of everything else
const FACE_MIN_FORWARD = 0.3; // a face island's area-weighted normal points this far toward +Z
const UNIFORM_STDDEV = 10; // 8-bit sRGB: an island flatter than this reads as one colour at figure scale
const LENS_ALPHA_DROP = 0.5; // untextured BLEND below this alpha is a see-through lens
const METAL_DARKEN = 0.9; // diffuse kept = 1 - METAL_DARKEN * metallic (the room has no env map, so metal reads dark)
const POSITION_GRID = 64; // positions rounded to 1/64 wu
const ROUGHNESS = 0.5; // the Skin material's roughness; Skin is most of every figure
const KTX2_QLEVEL = '192'; // same ETC1S quality as the other Trading Floor assets
const KTX2_CLEVEL = '2';

const args = process.argv.slice(2);
function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
const OUT = resolve(argValue('--out') ?? join(PUBLIC, 'models', 'trading-floor', 'trading-floor-house-agents.glb'));
const DEBUG_DIR = argValue('--debug-dir') ? resolve(argValue('--debug-dir')) : null;

// ---------------------------------------------------------------------------
// Modules. three and @pixiv/three-vrm are dependencies of apps/web only (Bun's
// isolated install links them under apps/web/node_modules), so they are loaded
// by path. realpath gives ONE module identity for three, which GLTFLoader and
// three-vrm both import as the bare specifier 'three'.
// ---------------------------------------------------------------------------

function webModuleUrl(relative) {
  for (const base of [join(WEB, 'node_modules'), join(REPO_ROOT, 'node_modules')]) {
    const candidate = join(base, relative);
    if (existsSync(candidate)) return pathToFileURL(realpathSync(candidate)).href;
  }
  throw new Error(`cannot find ${relative} under apps/web/node_modules or node_modules (run bun install)`);
}

const THREE = await import(webModuleUrl('three/build/three.module.js'));
const { GLTFLoader } = await import(webModuleUrl('three/examples/jsm/loaders/GLTFLoader.js'));
const { VRMLoaderPlugin, VRMUtils } = await import(webModuleUrl('@pixiv/three-vrm/lib/three-vrm.module.js'));
const { retargetMixamoClip } = await import(pathToFileURL(join(WEB, 'src', 'lib', 'three', 'mixamo-retarget.ts')).href);
const { FLOOR_ARENA_TEMPLATES } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages', 'shared', 'src', 'constants', 'floor-arena.ts')).href
);

const templateIds = FLOOR_ARENA_TEMPLATES.map((template) => template.id);
if (JSON.stringify(templateIds) !== JSON.stringify(FIGURES.map((figure) => figure.templateId))) {
  throw new Error(`FIGURES order ${FIGURES.map((f) => f.templateId)} != FLOOR_ARENA_TEMPLATES ${templateIds}`);
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

// ---------------------------------------------------------------------------
// Colour helpers (8-bit sRGB <-> linear)
// ---------------------------------------------------------------------------

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb8(value) {
  const c = Math.min(1, Math.max(0, value));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

// ---------------------------------------------------------------------------
// GLB reading
// ---------------------------------------------------------------------------

function readGlb(path) {
  const bytes = readFileSync(path);
  if (bytes.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path} is not a GLB`);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binStart = 20 + jsonLength + 8;
  const binLength = bytes.readUInt32LE(20 + jsonLength);
  return { bytes, json, bin: bytes.subarray(binStart, binStart + binLength) };
}

/** three's GLTFLoader, with every texture stubbed: the loader needs DOM image
 *  APIs Node lacks, and the bake reads pixels itself. The plugin borrows the
 *  EXT_texture_webp name so it REPLACES the built-in WebP plugin (whose
 *  support probe calls `new Image()`); its loadTexture answers every index. */
async function parseWithThree(bytes, withVrm) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.register(() => ({ name: 'EXT_texture_webp', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  if (withVrm) loader.register((parser) => new VRMLoaderPlugin(parser));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((resolvePromise, reject) => loader.parse(buffer, '', resolvePromise, reject));
}

/** Decoded RGBA pixels of one glTF texture index (sRGB 8-bit, row 0 = top = v 0). */
async function decodeTexture(glb, textureIndex) {
  const texture = glb.json.textures[textureIndex];
  const source = texture.extensions?.EXT_texture_webp?.source ?? texture.source;
  const image = glb.json.images[source];
  if (image.uri) throw new Error('external image URIs are not supported');
  const view = glb.json.bufferViews[image.bufferView];
  const encoded = glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  const { data, info } = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Bilinear sample with REPEAT wrap (every source sampler here is REPEAT).
 *  Returns linear RGB and alpha into `out`. Pixel centres sit at +0.5. */
function sampleLinear(tex, sx, sy, out) {
  const x = sx - 0.5;
  const y = sy - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const w = tex.width;
  const h = tex.height;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      if (weight === 0) continue;
      const px = (((x0 + i) % w) + w) % w;
      const py = (((y0 + j) % h) + h) % h;
      const o = (py * w + px) * 4;
      out[0] += SRGB_TO_LINEAR[tex.data[o]] * weight;
      out[1] += SRGB_TO_LINEAR[tex.data[o + 1]] * weight;
      out[2] += SRGB_TO_LINEAR[tex.data[o + 2]] * weight;
      out[3] += (tex.data[o + 3] / 255) * weight;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 1-5: load, size, pose, skin, resolve materials
// ---------------------------------------------------------------------------

const idleGlb = readGlb(join(PUBLIC, IDLE_CLIP_PATH));
const idleGltf = await parseWithThree(idleGlb.bytes, false);

/** How one source material enters the single opaque material. */
async function resolveMaterial(glb, materialIndex, textureCache) {
  const def = glb.json.materials[materialIndex];
  const pbr = def.pbrMetallicRoughness ?? {};
  const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
  const alphaMode = def.alphaMode ?? 'OPAQUE';
  let metallic = pbr.metallicFactor ?? 1; // glTF default is 1
  const textureIndex = pbr.baseColorTexture?.index;
  const name = def.name ?? `material${materialIndex}`;
  const loadTex = async (index) => {
    if (!textureCache.has(index)) textureCache.set(index, await decodeTexture(glb, index));
    return textureCache.get(index);
  };
  if (pbr.metallicRoughnessTexture) {
    // glTF metalness is the B channel. Use its mean: the one textured case here
    // (a glasses frame) is a flat colour, so a per-texel value buys nothing.
    const mr = await loadTex(pbr.metallicRoughnessTexture.index);
    let sum = 0;
    for (let i = 2; i < mr.data.length; i += 4) sum += mr.data[i];
    metallic *= sum / (mr.data.length / 4) / 255;
  }
  const base = {
    name,
    materialIndex,
    factor,
    diffuseKeep: 1 - METAL_DARKEN * metallic,
    metallic,
  };
  if (alphaMode === 'BLEND' && textureIndex === undefined && factor[3] < LENS_ALPHA_DROP) {
    return { ...base, kind: 'drop', lens: true, reason: `see-through lens (alpha ${factor[3].toFixed(2)}); it tints the eyes behind it instead` };
  }
  if (textureIndex === undefined) return { ...base, kind: 'flat' };
  const texture = await loadTex(textureIndex);
  if (alphaMode === 'BLEND') return { ...base, kind: 'composite', texture };
  return { ...base, kind: 'texture', texture };
}

const _m = new THREE.Matrix4();
const _blend = new THREE.Matrix4();
const _skin = new THREE.Matrix4();
const _full = new THREE.Matrix4();
const _skinNormal = new THREE.Matrix3();
const _worldNormal = new THREE.Matrix3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

/** World-space posed position + normal of every vertex of one mesh, computed
 *  the way three r185 draws it (skinning_vertex / skinnormal_vertex /
 *  defaultnormal_vertex): the blended skin matrix
 *  `bindMatrixInverse * sum(w * bone * boneInverse) * bindMatrix` moves the
 *  position AND is applied DIRECTLY to the normal (not its inverse transpose);
 *  then the mesh's own normal matrix takes the normal to world space. */
function skinVertices(mesh) {
  const geometry = mesh.geometry;
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const count = position.count;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const skinIndex = geometry.attributes.skinIndex;
  const skinWeight = geometry.attributes.skinWeight;
  _worldNormal.getNormalMatrix(mesh.matrixWorld);
  for (let i = 0; i < count; i++) {
    if (mesh.isSkinnedMesh) {
      _blend.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      let total = 0;
      for (let k = 0; k < 4; k++) {
        const weight = skinWeight.getComponent(i, k);
        if (weight === 0) continue;
        const bone = skinIndex.getComponent(i, k);
        _m.multiplyMatrices(mesh.skeleton.bones[bone].matrixWorld, mesh.skeleton.boneInverses[bone]);
        for (let e = 0; e < 16; e++) _blend.elements[e] += _m.elements[e] * weight;
        total += weight;
      }
      if (total === 0) throw new Error(`${mesh.name}: vertex ${i} has no skin weight`);
      if (Math.abs(total - 1) > 1e-3) for (let e = 0; e < 16; e++) _blend.elements[e] /= total;
      _skin.multiplyMatrices(mesh.bindMatrixInverse, _blend).multiply(mesh.bindMatrix);
    } else {
      _skin.identity();
    }
    _full.multiplyMatrices(mesh.matrixWorld, _skin);
    _p.fromBufferAttribute(position, i).applyMatrix4(_full);
    _skinNormal.setFromMatrix4(_skin);
    _n.fromBufferAttribute(normal, i).applyMatrix3(_skinNormal).applyMatrix3(_worldNormal).normalize();
    positions.set([_p.x, _p.y, _p.z], i * 3);
    normals.set([_n.x, _n.y, _n.z], i * 3);
  }
  return { positions, normals };
}

/** UVs as floats. The VRMs store TEXCOORD_0 quantized (KHR_mesh_quantization),
 *  so the raw `.array` holds integers; getX/getY apply the normalization. */
function readUvs(attribute) {
  const out = new Float32Array(attribute.count * 2);
  for (let i = 0; i < attribute.count; i++) {
    out[i * 2] = attribute.getX(i);
    out[i * 2 + 1] = attribute.getY(i);
  }
  return out;
}

/** Rest-pose skinned bounding box, as computeVRMAvatarFit measures it. */
function restBounds(scene) {
  scene.updateMatrixWorld(true);
  scene.traverse((object) => {
    if (object.isSkinnedMesh) object.skeleton.update();
  });
  return new THREE.Box3().setFromObject(scene);
}

async function bakeFigure(figure) {
  const vrmPath = join(PUBLIC, 'avatars', `milady-official-${figure.look}.vrm`);
  const glb = readGlb(vrmPath);
  const gltf = await parseWithThree(glb.bytes, true);
  const vrm = gltf.userData.vrm;
  if (!vrm?.humanoid) throw new Error(`${vrmPath}: not a VRM`);

  // vrm-loader.ts normaliseVRM, in the same order.
  VRMUtils.removeUnnecessaryVertices(vrm.scene);
  VRMUtils.rotateVRM0(vrm);

  const rest = restBounds(vrm.scene);
  const scale = TARGET_HEIGHT_WU / (rest.max.y - rest.min.y);

  const clip = retargetMixamoClip(idleGltf, vrm, 'idle');
  const mixer = new THREE.AnimationMixer(vrm.scene);
  mixer.clipAction(clip).play();
  mixer.setTime(figure.idleTimeS);
  vrm.update(0); // normalized -> raw bones, expressions, lookAt
  vrm.scene.updateMatrixWorld(true);
  vrm.scene.traverse((object) => {
    if (object.isSkinnedMesh) object.skeleton.update();
  });

  const hips = new THREE.Vector3();
  vrm.humanoid.getRawBoneNode('hips').getWorldPosition(hips);
  const neck = new THREE.Vector3();
  vrm.humanoid.getRawBoneNode('neck').getWorldPosition(neck);

  const textureCache = new Map();
  const materials = new Map();
  const parts = [];
  const lensParts = [];
  const meshes = [];
  vrm.scene.traverse((object) => {
    if (object.isMesh) meshes.push(object);
  });
  for (const mesh of meshes) {
    const materialIndex = gltf.parser.associations.get(mesh.material)?.materials;
    if (materialIndex === undefined) throw new Error(`${mesh.name}: material has no glTF index`);
    if (!materials.has(materialIndex)) materials.set(materialIndex, await resolveMaterial(glb, materialIndex, textureCache));
    const material = materials.get(materialIndex);
    const triCount = mesh.geometry.index.count / 3;
    if (material.kind === 'drop') {
      console.log(`  ${figure.templateId}: drop ${mesh.name} (${material.name}, ${triCount} tris): ${material.reason}`);
      if (material.lens) lensParts.push({ material, positions: skinVertices(mesh).positions });
      continue;
    }
    const { positions, normals } = skinVertices(mesh);
    parts.push({
      meshName: mesh.name,
      isBody: mesh.name.startsWith('Body'),
      material,
      positions,
      normals,
      uvs: readUvs(mesh.geometry.attributes.uv),
      indices: new Uint32Array(mesh.geometry.index.array),
    });
  }

  // Merge every kept part into one indexed mesh in final world units.
  const vertexCount = parts.reduce((n, part) => n + part.positions.length / 3, 0);
  const indexCount = parts.reduce((n, part) => n + part.indices.length, 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const partOf = new Uint16Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  let v = 0;
  let ix = 0;
  parts.forEach((part, partIndex) => {
    const n = part.positions.length / 3;
    for (let i = 0; i < n; i++) {
      positions[(v + i) * 3] = (part.positions[i * 3] - hips.x) * scale;
      positions[(v + i) * 3 + 1] = part.positions[i * 3 + 1] * scale;
      positions[(v + i) * 3 + 2] = (part.positions[i * 3 + 2] - hips.z) * scale;
      partOf[v + i] = partIndex;
    }
    normals.set(part.normals, v * 3);
    uvs.set(part.uvs, v * 2);
    for (let i = 0; i < part.indices.length; i++) indices[ix + i] = part.indices[i] + v;
    v += n;
    ix += part.indices.length;
  });
  let minY = Infinity;
  for (let i = 1; i < positions.length; i += 3) minY = Math.min(minY, positions[i]);
  for (let i = 1; i < positions.length; i += 3) positions[i] -= minY;

  // A dropped lens still colours what is seen through it: keep its colour,
  // alpha and screen-facing bounds so the eye overlays behind it are tinted.
  const lenses = lensParts.map(({ material, positions: lensPositions }) => {
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, maxZ: -Infinity };
    for (let i = 0; i < lensPositions.length; i += 3) {
      const x = (lensPositions[i] - hips.x) * scale;
      const y = lensPositions[i + 1] * scale - minY;
      const z = (lensPositions[i + 2] - hips.z) * scale;
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minY = Math.min(box.minY, y);
      box.maxY = Math.max(box.maxY, y);
      box.maxZ = Math.max(box.maxZ, z);
    }
    return { ...box, colour: flatColour(material), alpha: material.factor[3] };
  });

  return {
    figure,
    vrmPath,
    scale,
    neckY: (neck.y * scale) - minY,
    parts,
    positions,
    normals,
    uvs,
    partOf,
    indices,
    sourceTris: indexCount / 3,
    lenses,
  };
}

// ---------------------------------------------------------------------------
// Step 6: classify islands, then simplify
// ---------------------------------------------------------------------------

/** Connected components over shared vertex indices. Parts never share a vertex,
 *  so every island belongs to exactly one source material. */
function findIslands(mesh) {
  const parent = new Int32Array(mesh.positions.length / 3).map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = find(mesh.indices[t]);
    const b = find(mesh.indices[t + 1]);
    const c = find(mesh.indices[t + 2]);
    parent[b] = a;
    parent[c] = a;
  }
  const byRoot = new Map();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const root = find(mesh.indices[t]);
    if (!byRoot.has(root)) byRoot.set(root, { triangles: [], vertices: new Set() });
    const island = byRoot.get(root);
    island.triangles.push(t);
    for (let k = 0; k < 3; k++) island.vertices.add(mesh.indices[t + k]);
  }
  return [...byRoot.values()];
}

/** Linear RGB of one texture sample after the material's colour rules.
 *  `ctx.skinRef` is the skin a composited overlay sits on; `ctx.tints` are the
 *  dropped see-through lenses in front of it ({ colour, alpha }), applied in
 *  order like stacked BLEND layers. */
function shadeSample(material, sample, ctx, out) {
  let r = sample[0] * material.factor[0];
  let g = sample[1] * material.factor[1];
  let b = sample[2] * material.factor[2];
  if (material.kind === 'composite') {
    const a = sample[3] * material.factor[3];
    r = r * a + ctx.skinRef[0] * (1 - a);
    g = g * a + ctx.skinRef[1] * (1 - a);
    b = b * a + ctx.skinRef[2] * (1 - a);
  }
  out[0] = r * material.diffuseKeep;
  out[1] = g * material.diffuseKeep;
  out[2] = b * material.diffuseKeep;
  for (const tint of ctx.tints ?? []) {
    for (let c = 0; c < 3; c++) out[c] = out[c] * (1 - tint.alpha) + tint.colour[c] * tint.alpha;
  }
  return out;
}

/** Linear RGB of an untextured material. */
function flatColour(material) {
  return [0, 1, 2].map((c) => material.factor[c] * material.diffuseKeep);
}

const COVERAGE_SAMPLES_PER_TRIANGLE = 256;

/** Colour statistics (8-bit sRGB, after the colour rules) of the texels an
 *  island's triangles cover. Each triangle is sampled on a grid of at most
 *  ~256 points: some accessories map thousands of triangles over the WHOLE
 *  texture, so an exhaustive raster would be billions of samples. */
function islandCoverage(mesh, island, material, ctx) {
  const tex = material.texture;
  const sample = [0, 0, 0, 0];
  const shaded = [0, 0, 0];
  const sum = [0, 0, 0];
  const sumSq = [0, 0, 0];
  let n = 0;
  const add = (x, y) => {
    shadeSample(material, sampleLinear(tex, x, y, sample), ctx, shaded);
    for (let c = 0; c < 3; c++) {
      const value = linearToSrgb8(shaded[c]);
      sum[c] += value;
      sumSq[c] += value * value;
    }
    n++;
  };
  for (const t of island.triangles) {
    const p = [0, 1, 2].map((k) => {
      const vi = mesh.indices[t + k];
      return [mesh.uvs[vi * 2] * tex.width, mesh.uvs[vi * 2 + 1] * tex.height];
    });
    const minX = Math.min(p[0][0], p[1][0], p[2][0]);
    const maxX = Math.max(p[0][0], p[1][0], p[2][0]);
    const minY = Math.min(p[0][1], p[1][1], p[2][1]);
    const maxY = Math.max(p[0][1], p[1][1], p[2][1]);
    const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
    const step = Math.max(1, Math.sqrt(((maxX - minX) * (maxY - minY)) / COVERAGE_SAMPLES_PER_TRIANGLE));
    let hits = 0;
    if (Math.abs(area) > 1e-9) {
      for (let py = minY + step / 2; py < maxY; py += step) {
        for (let px = minX + step / 2; px < maxX; px += step) {
          const w0 = ((p[1][0] - px) * (p[2][1] - py) - (p[2][0] - px) * (p[1][1] - py)) / area;
          const w1 = ((p[2][0] - px) * (p[0][1] - py) - (p[0][0] - px) * (p[2][1] - py)) / area;
          if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
          add(px, py);
          hits++;
        }
      }
    }
    if (hits === 0) add((p[0][0] + p[1][0] + p[2][0]) / 3, (p[0][1] + p[1][1] + p[2][1]) / 3);
  }
  const mean = sum.map((s) => s / n);
  const stddev = Math.sqrt(Math.max(...sumSq.map((s, c) => Math.max(0, s / n - mean[c] * mean[c]))));
  return { mean: mean.map((c) => Math.round(c)), stddev };
}

/** Face skin colour (linear) under a composited overlay: the nearest vertex of
 *  an opaque textured part, sampled from its texture over a 5x5 px window. */
function skinReference(baked, overlayPart) {
  const { positions, uvs, partOf } = baked;
  const centroid = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < partOf.length; i++) {
    if (partOf[i] !== overlayPart) continue;
    for (let c = 0; c < 3; c++) centroid[c] += positions[i * 3 + c];
    n++;
  }
  for (let c = 0; c < 3; c++) centroid[c] /= n;
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < partOf.length; i++) {
    if (baked.parts[partOf[i]].material.kind !== 'texture') continue;
    const d = (positions[i * 3] - centroid[0]) ** 2 + (positions[i * 3 + 1] - centroid[1]) ** 2 +
      (positions[i * 3 + 2] - centroid[2]) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  if (best < 0) throw new Error(`${baked.figure.templateId}: no opaque textured part under an overlay`);
  const material = baked.parts[partOf[best]].material;
  const tex = material.texture;
  const sample = [0, 0, 0, 0];
  const sum = [0, 0, 0];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      sampleLinear(tex, uvs[best * 2] * tex.width + dx, uvs[best * 2 + 1] * tex.height + dy, sample);
      for (let c = 0; c < 3; c++) sum[c] += (sample[c] * material.factor[c] * material.diffuseKeep) / 25;
    }
  }
  return sum;
}

/** Classify every SOURCE island once, before simplification:
 *    swatch  -> one flat colour (untextured part, or a texture flatter than
 *               UNIFORM_STDDEV over the island); its UVs carry no information,
 *               so the simplifier is told to ignore them;
 *    texture -> a cropped atlas rect; `face` islands get FACE_DENSITY.
 *  Simplification only removes vertices and triangles, so every simplified
 *  island is a subset of one source island and inherits its class. */
function classifyIslands(baked) {
  const islandOf = new Int32Array(baked.positions.length / 3).fill(-1);
  const info = [];
  const skinRefs = new Map();
  for (const island of findIslands(baked)) {
    const id = info.length;
    for (const vi of island.vertices) islandOf[vi] = id;
    const partIndex = baked.partOf[island.vertices.values().next().value];
    const part = baked.parts[partIndex];
    const material = part.material;
    if (material.kind === 'flat') {
      info.push({ swatch: flatColour(material).map(linearToSrgb8) });
      continue;
    }
    if (material.kind === 'composite' && !skinRefs.has(partIndex)) skinRefs.set(partIndex, skinReference(baked, partIndex));
    const skinRef = skinRefs.get(partIndex) ?? [0, 0, 0];
    let tints = [];
    if (material.kind === 'composite') {
      const centroid = [0, 0, 0];
      for (const vi of island.vertices) {
        for (let c = 0; c < 3; c++) centroid[c] += baked.positions[vi * 3 + c] / island.vertices.size;
      }
      tints = baked.lenses.filter((box) => centroid[0] >= box.minX && centroid[0] <= box.maxX &&
        centroid[1] >= box.minY && centroid[1] <= box.maxY && centroid[2] < box.maxZ);
    }
    const coverage = islandCoverage(baked, island, material, { skinRef, tints });
    if (coverage.stddev < UNIFORM_STDDEV) {
      info.push({ swatch: coverage.mean });
      continue;
    }
    // Face = front-facing skin of the BODY mesh above the neck (not the hair,
    // which shares the texture but is low-frequency, and not the back of the
    // head, which the hair covers), plus the overlays drawn on the face (eyes,
    // mouth). The area-weighted normal of the island decides "front".
    let meanY = 0;
    for (const vi of island.vertices) meanY += baked.positions[vi * 3 + 1] / island.vertices.size;
    const normal = [0, 0, 0];
    for (const t of island.triangles) {
      const [a, b, c] = [baked.indices[t], baked.indices[t + 1], baked.indices[t + 2]];
      const e1 = [0, 1, 2].map((k) => baked.positions[b * 3 + k] - baked.positions[a * 3 + k]);
      const e2 = [0, 1, 2].map((k) => baked.positions[c * 3 + k] - baked.positions[a * 3 + k]);
      normal[0] += e1[1] * e2[2] - e1[2] * e2[1];
      normal[1] += e1[2] * e2[0] - e1[0] * e2[2];
      normal[2] += e1[0] * e2[1] - e1[1] * e2[0];
    }
    const frontFacing = normal[2] / (Math.hypot(...normal) || 1) > FACE_MIN_FORWARD;
    const face = (part.isBody && meanY > baked.neckY && frontFacing) || material.kind === 'composite';
    info.push({ material, skinRef, tints, face });
  }
  return { islandOf, info };
}

function simplifyFigure(baked, classes) {
  const { positions, normals, uvs, indices } = baked;
  const count = positions.length / 3;
  // Attributes: normal xyz, uv xy. A collapse keeps an existing vertex, so a
  // vertex UV never changes and islands stay intact. Swatch islands get a
  // constant UV here: their UVs map to one colour, so they must not cost error.
  const attributes = new Float32Array(count * 5);
  for (let i = 0; i < count; i++) {
    const swatch = classes.info[classes.islandOf[i]].swatch !== undefined;
    attributes.set([
      normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2],
      swatch ? 0 : uvs[i * 2], swatch ? 0 : uvs[i * 2 + 1],
    ], i * 5);
  }
  // Lock the face overlays (eyeballs, mouth): ~50 triangles that carry the
  // whole expression, and the first thing an error-ranked collapse would thin.
  const lock = new Uint8Array(count);
  for (let i = 0; i < count; i++) lock[i] = baked.parts[baked.partOf[i]].material.kind === 'composite' ? 1 : 0;
  const target = Math.min(indices.length, MAX_TRIS_PER_FIGURE * 3);
  const [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(
    indices, positions, 3, attributes, 5, [0.5, 0.5, 0.5, 1, 1], lock, target, 1, [],
  );
  if (simplified.length > MAX_TRIS_PER_FIGURE * 3) {
    throw new Error(`${baked.figure.templateId}: simplify stopped at ${simplified.length / 3} tris`);
  }
  // Compact to the referenced vertices.
  const remap = new Int32Array(count).fill(-1);
  let next = 0;
  for (const index of simplified) if (remap[index] < 0) remap[index] = next++;
  const out = {
    positions: new Float32Array(next * 3),
    normals: new Float32Array(next * 3),
    uvs: new Float32Array(next * 2),
    partOf: new Uint16Array(next),
    islandOf: new Int32Array(next),
    indices: new Uint32Array(simplified.length),
  };
  for (let i = 0; i < count; i++) {
    const r = remap[i];
    if (r < 0) continue;
    out.positions.set(positions.subarray(i * 3, i * 3 + 3), r * 3);
    out.normals.set(normals.subarray(i * 3, i * 3 + 3), r * 3);
    out.uvs.set(uvs.subarray(i * 2, i * 2 + 2), r * 2);
    out.partOf[r] = baked.partOf[i];
    out.islandOf[r] = classes.islandOf[i];
  }
  for (let i = 0; i < simplified.length; i++) out.indices[i] = remap[simplified[i]];
  // Relative quadric error. It includes the normal and UV terms, so it is a
  // ranking number, not a distance in wu.
  out.error = error;
  return out;
}

// ---------------------------------------------------------------------------
// Step 7: atlas
// ---------------------------------------------------------------------------

/** Skyline bottom-left packer. Returns false when the rects do not all fit. */
function pack(rects, size) {
  let skyline = [{ x: 0, y: 0, w: size }];
  const order = [...rects].sort((a, b) => b.h - a.h || b.w - a.w || a.order - b.order);
  for (const rect of order) {
    let best = null;
    for (let i = 0; i < skyline.length; i++) {
      if (skyline[i].x + rect.w > size) break;
      let y = 0;
      let widthLeft = rect.w;
      let j = i;
      while (widthLeft > 0) {
        y = Math.max(y, skyline[j].y);
        widthLeft -= skyline[j].w;
        j++;
        if (widthLeft > 0 && j >= skyline.length) {
          y = Infinity;
          break;
        }
      }
      if (y + rect.h > size) continue;
      if (!best || y < best.y || (y === best.y && skyline[i].x < best.x)) best = { i, x: skyline[i].x, y };
    }
    if (!best) return false;
    rect.x = best.x;
    rect.y = best.y;
    // Raise the skyline under the rect.
    const top = best.y + rect.h;
    const next = [];
    for (const segment of skyline) {
      const segEnd = segment.x + segment.w;
      const rectEnd = rect.x + rect.w;
      if (segEnd <= rect.x || segment.x >= rectEnd) {
        next.push(segment);
        continue;
      }
      if (segment.x < rect.x) next.push({ x: segment.x, y: segment.y, w: rect.x - segment.x });
      if (segEnd > rectEnd) next.push({ x: rectEnd, y: segment.y, w: segEnd - rectEnd });
    }
    next.push({ x: rect.x, y: top, w: rect.w });
    next.sort((a, b) => a.x - b.x);
    skyline = [];
    for (const segment of next) {
      const last = skyline[skyline.length - 1];
      if (last && last.y === segment.y && last.x + last.w === segment.x) last.w += segment.w;
      else skyline.push({ ...segment });
    }
  }
  return true;
}

function buildAtlas(entries) {
  // entries: { baked, classes, mesh } per figure (mesh = simplified).
  const islands = [];
  const swatches = new Map(); // sRGB hex -> swatch
  const swatchFor = (srgb) => {
    const key = srgb.map((c) => c.toString(16).padStart(2, '0')).join('');
    if (!swatches.has(key)) swatches.set(key, { key, srgb, w: SWATCH_PX, h: SWATCH_PX, order: swatches.size, users: [] });
    return swatches.get(key);
  };
  const stats = [];
  entries.forEach(({ classes, mesh }, figureIndex) => {
    let faceIslands = 0;
    let flatIslands = 0;
    for (const island of findIslands(mesh)) {
      const source = classes.info[mesh.islandOf[island.vertices.values().next().value]];
      if (source.swatch) {
        swatchFor(source.swatch).users.push({ figureIndex, island });
        flatIslands++;
        continue;
      }
      let u0 = Infinity;
      let v0 = Infinity;
      let u1 = -Infinity;
      let v1 = -Infinity;
      for (const vi of island.vertices) {
        u0 = Math.min(u0, mesh.uvs[vi * 2]);
        u1 = Math.max(u1, mesh.uvs[vi * 2]);
        v0 = Math.min(v0, mesh.uvs[vi * 2 + 1]);
        v1 = Math.max(v1, mesh.uvs[vi * 2 + 1]);
      }
      if (source.face) faceIslands++;
      const { material } = source;
      // Texel density of the SOURCE on this island: source px per wu, from the
      // ratio of UV area to surface area. The atlas allocates by surface area,
      // so a 2-triangle island whose UVs span the whole texture (there is one
      // inside every Milady head) gets a few px, not a full-texture crop.
      let worldArea = 0;
      let uvArea = 0;
      for (const t of island.triangles) {
        const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
        const e1 = [0, 1, 2].map((k) => mesh.positions[b * 3 + k] - mesh.positions[a * 3 + k]);
        const e2 = [0, 1, 2].map((k) => mesh.positions[c * 3 + k] - mesh.positions[a * 3 + k]);
        worldArea += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
        const du1 = (mesh.uvs[b * 2] - mesh.uvs[a * 2]) * material.texture.width;
        const dv1 = (mesh.uvs[b * 2 + 1] - mesh.uvs[a * 2 + 1]) * material.texture.height;
        const du2 = (mesh.uvs[c * 2] - mesh.uvs[a * 2]) * material.texture.width;
        const dv2 = (mesh.uvs[c * 2 + 1] - mesh.uvs[a * 2 + 1]) * material.texture.height;
        uvArea += Math.abs(du1 * dv2 - du2 * dv1) / 2;
      }
      islands.push({
        figureIndex,
        island,
        material,
        ctx: { skinRef: source.skinRef, tints: source.tints },
        density: source.face ? FACE_DENSITY : 1,
        sourcePxPerWu: worldArea > 1e-6 ? Math.sqrt(uvArea / worldArea) : 0,
        sx0: u0 * material.texture.width,
        sy0: v0 * material.texture.height,
        sw: Math.max(1, (u1 - u0) * material.texture.width),
        sh: Math.max(1, (v1 - v0) * material.texture.height),
        order: islands.length,
      });
    }
    stats.push({ faceIslands, flatIslands });
  });

  // Largest surface density that packs.
  const swatchList = [...swatches.values()];
  // D = atlas px per wu of surface (x FACE_DENSITY on faces). k = atlas px per
  // source px, capped at 1: never upsample past the source texture.
  const sizeIslands = (D) => {
    for (const island of islands) {
      const want = D * island.density;
      island.k = island.sourcePxPerWu > 0 ? Math.min(1, want / island.sourcePxPerWu) : 1;
      island.w = Math.ceil(island.sw * island.k) + 2 * ISLAND_PAD_PX;
      island.h = Math.ceil(island.sh * island.k) + 2 * ISLAND_PAD_PX;
    }
  };
  let lo = 0.01;
  let hi = 16;
  for (let step = 0; step < 24; step++) {
    const mid = (lo + hi) / 2;
    sizeIslands(mid);
    if (pack([...islands, ...swatchList], ATLAS_PX)) lo = mid;
    else hi = mid;
  }
  sizeIslands(lo);
  if (!pack([...islands, ...swatchList], ATLAS_PX)) {
    const minArea = islands.reduce((n, r) => n + r.w * r.h, 0) + swatchList.length * SWATCH_PX * SWATCH_PX;
    for (const r of [...islands].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 5)) {
      console.error(`  island fig ${r.figureIndex} ${r.material.name} k ${r.k} src ${r.sx0.toFixed(1)},${r.sy0.toFixed(1)} ${r.sw.toFixed(1)}x${r.sh.toFixed(1)} -> ${r.w}x${r.h} tris ${r.island.triangles.length}`);
    }
    throw new Error(`atlas packing failed: ${islands.length} islands + ${swatchList.length} swatches need >= ${minArea} px`);
  }

  // Rasterize.
  const pixels = Buffer.alloc(ATLAS_PX * ATLAS_PX * 3, 0x80);
  const sample = [0, 0, 0, 0];
  const shaded = [0, 0, 0];
  for (const island of islands) {
    const tex = island.material.texture;
    const ss = Math.min(4, Math.max(1, Math.ceil(1 / island.k)));
    for (let ay = island.y; ay < island.y + island.h; ay++) {
      for (let ax = island.x; ax < island.x + island.w; ax++) {
        const acc = [0, 0, 0];
        for (let sy = 0; sy < ss; sy++) {
          for (let sxi = 0; sxi < ss; sxi++) {
            const fx = ax + (sxi + 0.5) / ss;
            const fy = ay + (sy + 0.5) / ss;
            const srcX = island.sx0 + (fx - island.x - ISLAND_PAD_PX) / island.k;
            const srcY = island.sy0 + (fy - island.y - ISLAND_PAD_PX) / island.k;
            shadeSample(island.material, sampleLinear(tex, srcX, srcY, sample), island.ctx, shaded);
            for (let c = 0; c < 3; c++) acc[c] += shaded[c] / (ss * ss);
          }
        }
        const o = (ay * ATLAS_PX + ax) * 3;
        for (let c = 0; c < 3; c++) pixels[o + c] = linearToSrgb8(acc[c]);
      }
    }
  }
  for (const swatch of swatchList) {
    for (let ay = swatch.y; ay < swatch.y + swatch.h; ay++) {
      for (let ax = swatch.x; ax < swatch.x + swatch.w; ax++) {
        pixels.set(swatch.srgb, (ay * ATLAS_PX + ax) * 3);
      }
    }
  }

  // Atlas UVs per figure.
  const atlasUvs = entries.map(({ mesh }) => new Float32Array(mesh.uvs.length));
  for (const island of islands) {
    const { uvs } = entries[island.figureIndex].mesh;
    const out = atlasUvs[island.figureIndex];
    const tex = island.material.texture;
    for (const vi of island.island.vertices) {
      const ax = island.x + ISLAND_PAD_PX + (uvs[vi * 2] * tex.width - island.sx0) * island.k;
      const ay = island.y + ISLAND_PAD_PX + (uvs[vi * 2 + 1] * tex.height - island.sy0) * island.k;
      out[vi * 2] = ax / ATLAS_PX;
      out[vi * 2 + 1] = ay / ATLAS_PX;
    }
  }
  for (const swatch of swatchList) {
    for (const { figureIndex, island } of swatch.users) {
      for (const vi of island.vertices) {
        atlasUvs[figureIndex][vi * 2] = (swatch.x + swatch.w / 2) / ATLAS_PX;
        atlasUvs[figureIndex][vi * 2 + 1] = (swatch.y + swatch.h / 2) / ATLAS_PX;
      }
    }
  }
  const usedArea = [...islands, ...swatchList].reduce((n, r) => n + r.w * r.h, 0);
  return {
    pixels,
    atlasUvs,
    density: lo,
    islandCount: islands.length,
    swatchCount: swatchList.length,
    fill: usedArea / (ATLAS_PX * ATLAS_PX),
    stats,
  };
}

// ---------------------------------------------------------------------------
// Step 8: KTX2
// ---------------------------------------------------------------------------

function findToktx() {
  const configured = process.env.KTX2_TOKTX_BIN;
  const exe = process.platform === 'win32' ? 'toktx.exe' : 'toktx';
  if (configured && existsSync(join(configured, exe))) return join(configured, exe);
  const scoop = join(homedir(), 'scoop', 'apps', 'ktx-software');
  if (existsSync(scoop)) {
    const found = readdirSync(scoop)
      .map((entry) => join(scoop, entry, 'bin', exe))
      .filter((candidate) => existsSync(candidate))
      .sort()
      .reverse()[0];
    if (found) return found;
  }
  return 'toktx'; // PATH
}

async function encodeKtx2(pixels) {
  const dir = mkdtempSync(join(tmpdir(), 'house-agents-'));
  try {
    const png = join(dir, 'atlas.png');
    const ktx = join(dir, 'atlas.ktx2');
    await sharp(pixels, { raw: { width: ATLAS_PX, height: ATLAS_PX, channels: 3 } }).png().toFile(png);
    execFileSync(findToktx(), [
      '--t2', '--encode', 'etc1s', '--clevel', KTX2_CLEVEL, '--qlevel', KTX2_QLEVEL,
      '--genmipmap', '--assign_oetf', 'srgb', '--assign_primaries', 'bt709', ktx, png,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    return readFileSync(ktx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Step 9: write
// ---------------------------------------------------------------------------

async function writeGlb(entries, atlas, ktxBytes) {
  const doc = new Document();
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  doc.createExtension(KHRTextureBasisu).setRequired(true);
  doc.createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const buffer = doc.createBuffer();
  const texture = doc.createTexture('HouseAgentsAtlas').setMimeType('image/ktx2').setImage(new Uint8Array(ktxBytes));
  const material = doc.createMaterial('HouseAgentsMtl')
    .setBaseColorTexture(texture)
    .setMetallicFactor(0)
    .setRoughnessFactor(ROUGHNESS)
    .setDoubleSided(true); // every source material is double-sided (hair cards, sleeves)
  material.getBaseColorTextureInfo()
    .setWrapS(TextureInfo.WrapMode.CLAMP_TO_EDGE)
    .setWrapT(TextureInfo.WrapMode.CLAMP_TO_EDGE)
    .setMinFilter(TextureInfo.MinFilter.LINEAR_MIPMAP_LINEAR)
    .setMagFilter(TextureInfo.MagFilter.LINEAR);
  const scene = doc.createScene('HouseAgents');
  doc.getRoot().setDefaultScene(scene);

  entries.forEach(({ baked, mesh }, figureIndex) => {
    const count = mesh.positions.length / 3;
    const position = new Float32Array(count * 3);
    for (let i = 0; i < position.length; i++) position[i] = Math.round(mesh.positions[i] * POSITION_GRID) / POSITION_GRID;
    const normal = new Int8Array(count * 3);
    for (let i = 0; i < count; i++) {
      const x = mesh.normals[i * 3];
      const y = mesh.normals[i * 3 + 1];
      const z = mesh.normals[i * 3 + 2];
      const length = Math.hypot(x, y, z);
      if (length < 1e-6) throw new Error(`${baked.figure.templateId}: vertex ${i} has a zero normal`);
      normal[i * 3] = Math.round((x / length) * 127);
      normal[i * 3 + 1] = Math.round((y / length) * 127);
      normal[i * 3 + 2] = Math.round((z / length) * 127);
    }
    const uv = new Uint16Array(count * 2);
    const atlasUv = atlas.atlasUvs[figureIndex];
    for (let i = 0; i < uv.length; i++) uv[i] = Math.round(Math.min(1, Math.max(0, atlasUv[i])) * 65535);
    if (count > 65535) throw new Error(`${baked.figure.templateId}: ${count} vertices need 32-bit indices`);
    const name = `HouseAgent_${baked.figure.templateId}`;
    const primitive = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(position).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normal).setNormalized(true).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv).setNormalized(true).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(mesh.indices)).setBuffer(buffer))
      .setMaterial(material);
    const node = doc.createNode(name)
      .setMesh(doc.createMesh(name).addPrimitive(primitive))
      .setExtras({
        facing: '+Z',
        templateId: baked.figure.templateId,
        look: `milady_official_${baked.figure.look}`,
        sourceVrm: `/avatars/milady-official-${baked.figure.look}.vrm`,
        idleClip: IDLE_CLIP_PATH,
        idleTimeS: baked.figure.idleTimeS,
      });
    scene.addChild(node);
  });

  // weld: after the atlas mapping, the vertices of a flat-colour swatch share one
  // UV, so seam duplicates there become bitwise identical and merge.
  await doc.transform(weld(), reorder({ encoder: MeshoptEncoder, target: 'size' }));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
  // Check the budget BEFORE touching the shipped path, so a failed build never
  // leaves an over-budget file behind.
  const bytes = await io.writeBinary(doc);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(`${bytes.byteLength} bytes is over the ${MAX_FILE_BYTES} byte budget; nothing written`);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, bytes);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const entries = [];
for (const figure of FIGURES) {
  const baked = await bakeFigure(figure);
  const classes = classifyIslands(baked);
  const mesh = simplifyFigure(baked, classes);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], mesh.positions[i + c]);
      max[c] = Math.max(max[c], mesh.positions[i + c]);
    }
  }
  const height = max[1] - min[1];
  if (Math.abs(height - TARGET_HEIGHT_WU) > HEIGHT_TOL_WU) {
    throw new Error(`${figure.templateId}: posed height ${height.toFixed(1)} wu is outside 270 +/- ${HEIGHT_TOL_WU}`);
  }
  console.log(
    `${figure.templateId.padEnd(15)} milady-official-${figure.look} t=${figure.idleTimeS}s | ` +
      `scale ${baked.scale.toFixed(2)} | tris ${baked.sourceTris} -> ${mesh.indices.length / 3} ` +
      `(quadric error ${mesh.error.toFixed(4)}) | verts ${mesh.positions.length / 3} | ` +
      `x ${min[0].toFixed(1)}..${max[0].toFixed(1)} y ${min[1].toFixed(1)}..${max[1].toFixed(1)} ` +
      `z ${min[2].toFixed(1)}..${max[2].toFixed(1)}`,
  );
  const kept = new Map();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const part = baked.parts[mesh.partOf[mesh.indices[t]]];
    const key = `${part.meshName}/${part.material.name}`;
    kept.set(key, (kept.get(key) ?? 0) + 1);
  }
  console.log(`  parts: ${baked.parts.map((part) => {
    const key = `${part.meshName}/${part.material.name}`;
    return `${key} ${part.indices.length / 3}->${kept.get(key) ?? 0}`;
  }).join(', ')}`);
  entries.push({ baked, classes, mesh });
}

const atlas = buildAtlas(entries);
console.log(
  `atlas ${ATLAS_PX}x${ATLAS_PX}: ${atlas.density.toFixed(3)} atlas px per wu of surface ` +
    `(faces x${FACE_DENSITY}) | ${atlas.islandCount} islands + ${atlas.swatchCount} swatches | fill ${(atlas.fill * 100).toFixed(0)}% | ` +
    atlas.stats.map((s, i) => `${FIGURES[i].templateId} face ${s.faceIslands} flat ${s.flatIslands}`).join(', '),
);
if (DEBUG_DIR) {
  mkdirSync(DEBUG_DIR, { recursive: true });
  await sharp(atlas.pixels, { raw: { width: ATLAS_PX, height: ATLAS_PX, channels: 3 } }).png().toFile(join(DEBUG_DIR, 'atlas.png'));
}

const ktxBytes = await encodeKtx2(atlas.pixels);
await writeGlb(entries, atlas, ktxBytes);

const size = statSync(OUT).size;
const totalTris = entries.reduce((n, { mesh }) => n + mesh.indices.length / 3, 0);
console.log(
  `wrote ${OUT}\n  ${size} bytes (${(size / 1024).toFixed(0)} KB) | ${totalTris} tris | 5 nodes | 1 material | ` +
    `KTX2 ETC1S ${ATLAS_PX}x${ATLAS_PX} ${(ktxBytes.length / 1024).toFixed(0)} KB`,
);
