/**
 * hydra-halo.ts — soft neon halo around Hydra's glow lines, eyes and chest H (2026-11-01).
 *
 * Founder approved this look in the Hydra rig bench on 2026-11-01 ("oh wow the
 * glow is great", then "dope" on the final face). The bench drew the halo as
 * extra skinned copies of the body ("shells") that sample BLURRED copies of the
 * glow mask with additive blending. This module is the in-game port.
 *
 * Assets (baked by scripts/hermes-pipeline/hydra-face-fix.mjs step 5, same UV
 * layout as /avatars/hydra-w30k.vrm, glTF orientation so flipY = false):
 *   /avatars/hydra-halo-suit.webp  512², RGB = 3 suit layers (UV blur 8/22/48 px at 1024)
 *   /avatars/hydra-halo-hot.webp  1024², RGB = 3 eye + H layers (front-view blur 1.0/2.5/5.5 mm)
 * Each channel is a grey mask; the shader multiplies it by the neon colour
 * (the emissive map is one neon colour times a mask, so no colour is lost).
 *
 * Perf (AGENTS.md priority #1): the bench drew 6 full-body shells (6 draws x
 * 30.6k triangles). Here each GROUP (suit, hot) is ONE draw: the triangles a
 * layer actually lights are selected once at attach time by sampling the mask
 * on the CPU, and the selected triangles of the 3 layers are merged into one
 * geometry with per-vertex layer data:
 *   aHaloPush  normal push of that layer (mesh-local units, bench values)
 *   aHaloGain  base opacity x group gain of that layer (bench values)
 *   aHaloSel   one-hot channel selector of that layer (which grey mask)
 * So Hydra costs +2 draws, both skinned on the existing skeleton (no new bones),
 * and per frame ONE number write per group. Measured on hydra-w30k (30,597 body
 * triangles): suit shell 73,966 triangles (the 48 px layer reaches almost the
 * whole suit, whose glow lines run everywhere), hot shell 3,351. The bench drew
 * 183,582 (6 x 30,597). Selection uses a conservative coverage test (mask max
 * over each triangle's UV box on an 8-texel max grid dilated by one cell), so
 * no lit texel loses its triangle.
 *
 * Opacity parity with the bench: bench opacity = min(1, base x gain x k / 2.6)
 * (8-bit output clamps alpha), where k is the emissive pulse. The shader does
 * alpha = min(1, aHaloGain x uHaloK) with uHaloK = intensity / 2.6.
 *
 * Push units: the VRM mesh node sits under `Armature` (scale 0.01) and its
 * skinned positions are in that node's space, so the bench push values are
 * mesh-local units. They are kept exactly (the founder approved that look);
 * they mostly keep the shell off the body depth.
 *
 * Renderers: the world uses WebGPURenderer (also with forceWebGL), which builds
 * node materials and ignores onBeforeCompile; /preview/hermes uses a classic
 * WebGLRenderer. The material carries BOTH: a GLSL onBeforeCompile hook here,
 * and node overrides from a caller-supplied decorator (hydra-halo-node.ts, which
 * imports three/tsl). WebGPURenderer's NodeLibrary.fromMaterial copies every
 * own property of a classic material, so positionNode/colorNode/opacityNode
 * set on the MeshBasicMaterial carry over (same pattern as kelp-forest.tsx).
 */
import * as THREE from 'three';
import {
  HYDRA_ANIMATOR_ID,
  HYDRA_GLOW_AMPLITUDE,
  HYDRA_GLOW_MIN_INTENSITY,
  HYDRA_GLOW_STEADY_INTENSITY,
} from './hydra-glow';

export const HYDRA_HALO_SUIT_URL = '/avatars/hydra-halo-suit.webp?v=2';
export const HYDRA_HALO_HOT_URL = '/avatars/hydra-halo-hot.webp?v=2';
/** Hydra neon (#30a8ff), the colour of every glow line in the emissive map. */
export const HYDRA_HALO_NEON_SRGB = [48 / 255, 168 / 255, 255 / 255] as const;
/** Peak emissive intensity of the pulse; uHaloK = intensity / peak. */
const HYDRA_GLOW_PEAK = HYDRA_GLOW_MIN_INTENSITY + HYDRA_GLOW_AMPLITUDE;
/** A triangle joins a layer when its mask sample exceeds this (2/255). */
export const HYDRA_HALO_SAMPLE_THRESHOLD = 2 / 255;

export interface HydraHaloLayer {
  /** Mask channel (0 R, 1 G, 2 B). */
  channel: 0 | 1 | 2;
  /** Normal push, mesh-local units. */
  push: number;
  /** Base opacity x group gain. */
  gain: number;
}

/** Bench HALO_LAYERS ([blur, push, opacity]) at the approved Halo slider 2.0. */
export const HYDRA_HALO_SUIT_LAYERS: readonly HydraHaloLayer[] = Object.freeze([
  { channel: 0, push: 0.005, gain: 0.6 * 2.0 },
  { channel: 1, push: 0.015, gain: 0.4 * 2.0 },
  { channel: 2, push: 0.035, gain: 0.28 * 2.0 },
]);
/** Bench HOT_LAYERS at the approved "Eyes + H" slider 2.5. */
export const HYDRA_HALO_HOT_LAYERS: readonly HydraHaloLayer[] = Object.freeze([
  { channel: 0, push: 0.0012, gain: 1.0 * 2.5 },
  { channel: 1, push: 0.003, gain: 0.7 * 2.5 },
  { channel: 2, push: 0.006, gain: 0.45 * 2.5 },
]);

/** Grey value in [0, 1] of mask channel `channel` at glTF uv (u, v). */
/**
 * Conservative coverage query: the MAX of mask channel `channel` over the UV
 * rectangle [u0, u1] x [v0, v1] (plus the texture filter footprint), in [0, 1].
 */
export type HydraHaloSampler = (u0: number, v0: number, u1: number, v1: number, channel: number) => number;

/** Mask cell size (texels) of the coarse max grid behind the sampler. */
const HALO_GRID_CELL = 8;

/**
 * Pure: per-channel max grid of an RGBA image, dilated by one cell so a query
 * also covers bilinear and mip filtering across the rectangle edge. Returns the
 * conservative rectangle sampler.
 */
export function createHydraHaloSampler(data: Uint8ClampedArray | Uint8Array, width: number, height: number): HydraHaloSampler {
  const gw = Math.ceil(width / HALO_GRID_CELL), gh = Math.ceil(height / HALO_GRID_CELL);
  const raw = new Uint8Array(gw * gh * 3);
  for (let y = 0; y < height; y++) {
    const gy = (y / HALO_GRID_CELL) | 0;
    for (let x = 0; x < width; x++) {
      const g = (gy * gw + ((x / HALO_GRID_CELL) | 0)) * 3, p = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) if (data[p + c]! > raw[g + c]!) raw[g + c] = data[p + c]!;
    }
  }
  const grid = new Uint8Array(raw.length);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const g = (gy * gw + gx) * 3;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = gy + dy, xx = gx + dx;
      if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
      const n = (yy * gw + xx) * 3;
      for (let c = 0; c < 3; c++) if (raw[n + c]! > grid[g + c]!) grid[g + c] = raw[n + c]!;
    }
  }
  const cellX = (u: number) => Math.min(gw - 1, Math.max(0, Math.floor((u * width) / HALO_GRID_CELL)));
  const cellY = (v: number) => Math.min(gh - 1, Math.max(0, Math.floor((v * height) / HALO_GRID_CELL)));
  return (u0, v0, u1, v1, channel) => {
    let m = 0;
    for (let gy = cellY(v0), y1 = cellY(v1); gy <= y1; gy++) {
      for (let gx = cellX(u0), x1 = cellX(u1); gx <= x1; gx++) {
        const value = grid[(gy * gw + gx) * 3 + channel]!;
        if (value > m) m = value;
      }
    }
    return m / 255;
  };
}

/**
 * Pure: build the merged shell geometry of one group. For each layer, a source
 * triangle is kept when the mask max over its UV bounding box exceeds the
 * threshold (conservative: a lit texel anywhere inside the triangle keeps it);
 * its corners are copied (welded per layer) with the layer data.
 * Returns null when no layer lights any triangle.
 */
export function buildHydraHaloGeometry(
  source: THREE.BufferGeometry,
  layers: readonly HydraHaloLayer[],
  sample: HydraHaloSampler,
): THREE.BufferGeometry | null {
  const pos = source.getAttribute('position');
  const nrm = source.getAttribute('normal');
  const uv = source.getAttribute('uv');
  const skinIndex = source.getAttribute('skinIndex');
  const skinWeight = source.getAttribute('skinWeight');
  const index = source.getIndex();
  if (!pos || !nrm || !uv || !skinIndex || !skinWeight) return null;
  const triCount = index ? index.count / 3 : pos.count / 3;
  const corner = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);

  const src: number[] = []; // source vertex of each output vertex
  const layerOf: number[] = []; // layer of each output vertex
  const outIndex: number[] = [];
  for (let l = 0; l < layers.length; l++) {
    const { channel } = layers[l]!;
    const remap = new Map<number, number>();
    for (let t = 0; t < triCount; t++) {
      const a = corner(t, 0), b = corner(t, 1), c = corner(t, 2);
      const ua = uv.getX(a), va = uv.getY(a);
      const ub = uv.getX(b), vb = uv.getY(b);
      const uc = uv.getX(c), vc = uv.getY(c);
      const lit = sample(
        Math.min(ua, ub, uc), Math.min(va, vb, vc), Math.max(ua, ub, uc), Math.max(va, vb, vc), channel,
      ) > HYDRA_HALO_SAMPLE_THRESHOLD;
      if (!lit) continue;
      for (const s of [a, b, c]) {
        let o = remap.get(s);
        if (o === undefined) {
          o = src.length;
          remap.set(s, o);
          src.push(s);
          layerOf.push(l);
        }
        outIndex.push(o);
      }
    }
  }
  if (outIndex.length === 0) return null;

  const n = src.length;
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  const skinIdx = new Uint16Array(n * 4);
  const skinW = new Float32Array(n * 4);
  const push = new Float32Array(n);
  const gain = new Float32Array(n);
  const sel = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = src[i]!;
    const layer = layers[layerOf[i]!]!;
    // getX/getY/getZ/getW return de-normalized values for quantized attributes.
    position[i * 3] = pos.getX(s); position[i * 3 + 1] = pos.getY(s); position[i * 3 + 2] = pos.getZ(s);
    normal[i * 3] = nrm.getX(s); normal[i * 3 + 1] = nrm.getY(s); normal[i * 3 + 2] = nrm.getZ(s);
    uvs[i * 2] = uv.getX(s); uvs[i * 2 + 1] = uv.getY(s);
    skinIdx[i * 4] = skinIndex.getX(s); skinIdx[i * 4 + 1] = skinIndex.getY(s);
    skinIdx[i * 4 + 2] = skinIndex.getZ(s); skinIdx[i * 4 + 3] = skinIndex.getW(s);
    skinW[i * 4] = skinWeight.getX(s); skinW[i * 4 + 1] = skinWeight.getY(s);
    skinW[i * 4 + 2] = skinWeight.getZ(s); skinW[i * 4 + 3] = skinWeight.getW(s);
    push[i] = layer.push;
    gain[i] = layer.gain;
    sel[i * 3 + layer.channel] = 1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIdx, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinW, 4));
  geometry.setAttribute('aHaloPush', new THREE.BufferAttribute(push, 1));
  geometry.setAttribute('aHaloGain', new THREE.BufferAttribute(gain, 1));
  geometry.setAttribute('aHaloSel', new THREE.BufferAttribute(sel, 3));
  geometry.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(outIndex, 1) : new THREE.Uint16BufferAttribute(outIndex, 1));
  // Cull with the body's bounds (vrm-loader fattens them for animated poses).
  if (!source.boundingSphere) source.computeBoundingSphere();
  if (!source.boundingBox) source.computeBoundingBox();
  geometry.boundingSphere = source.boundingSphere!.clone();
  geometry.boundingBox = source.boundingBox!.clone();
  return geometry;
}

/** The shared per-group uniform holder: value = emissive intensity / peak. */
export interface HydraHaloK { value: number }

/**
 * Optional node-material decorator (world renderer). Receives the classic
 * material and must set positionNode / colorNode / opacityNode equivalent to
 * the GLSL below. Returns a setter for the k uniform.
 */
export type HydraHaloNodeDecorator = (material: THREE.MeshBasicMaterial) => (k: number) => void;

function createHaloMaterial(map: THREE.Texture, decorate?: HydraHaloNodeDecorator) {
  const material = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    side: THREE.FrontSide,
  });
  material.color.setRGB(...HYDRA_HALO_NEON_SRGB, THREE.SRGBColorSpace);
  const k: HydraHaloK = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHaloK = k;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aHaloPush;\nattribute float aHaloGain;\nattribute vec3 aHaloSel;\nvarying float vHaloGain;\nvarying vec3 vHaloSel;',
      )
      .replace(
        '#include <skinning_vertex>',
        '#include <skinning_vertex>\ntransformed += normalize( objectNormal ) * aHaloPush;\nvHaloGain = aHaloGain;\nvHaloSel = aHaloSel;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uHaloK;\nvarying float vHaloGain;\nvarying vec3 vHaloSel;')
      .replace(
        '#include <map_fragment>',
        'diffuseColor.rgb *= dot( texture2D( map, vMapUv ).rgb, vHaloSel );\ndiffuseColor.a = min( 1.0, vHaloGain * uHaloK );',
      );
  };
  material.customProgramCacheKey = () => 'hydra-halo-v1';
  const setNodeK = decorate ? decorate(material) : null;
  const setK = (value: number) => {
    k.value = value;
    if (setNodeK) setNodeK(value);
  };
  return { material, setK };
}

interface HaloMask { texture: THREE.Texture; sample: HydraHaloSampler }

async function loadMask(url: string): Promise<HaloMask> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`hydra halo mask ${url}: HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  try {
    const { width, height } = bitmap;
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('hydra halo: no 2d context');
    ctx.drawImage(bitmap, 0, 0);
    const sample = createHydraHaloSampler(ctx.getImageData(0, 0, width, height).data, width, height);
    const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement);
    // sRGB on purpose: the approved bench sampled neon x mask as an sRGB colour
    // texture, i.e. decode(L x neon). With a grey mask, decode(L) x decode(neon)
    // (this texture x material.color) gives the same gamma curve per layer.
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false; // glTF UV orientation, like the VRM's own maps
    // No mipmaps: a coarse mip spreads the mask past the triangles the coverage
    // test selected (bilinear reads stay inside the one-cell dilation). The
    // masks are already blurred, so minification aliasing is not visible.
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return { texture, sample };
  } catch (err) {
    bitmap.close();
    throw err;
  }
}

function disposeMask(mask: HaloMask) {
  mask.texture.dispose();
  (mask.texture.image as ImageBitmap | undefined)?.close?.();
}

// One fetch + decode per page; every Hydra instance shares the two textures.
let masksPromise: Promise<{ suit: HaloMask; hot: HaloMask }> | null = null;
function loadMasks() {
  if (!masksPromise) {
    masksPromise = Promise.allSettled([loadMask(HYDRA_HALO_SUIT_URL), loadMask(HYDRA_HALO_HOT_URL)])
      .then(([suit, hot]) => {
        if (suit.status === 'fulfilled' && hot.status === 'fulfilled') return { suit: suit.value, hot: hot.value };
        for (const r of [suit, hot]) if (r.status === 'fulfilled') disposeMask(r.value);
        masksPromise = null; // allow a retry on the next mount
        throw (suit.status === 'rejected' ? suit.reason : (hot as PromiseRejectedResult).reason);
      });
  }
  return masksPromise;
}

export interface HydraHalo {
  /** Write the pulse: `intensity` is the emissive intensity of this frame. */
  setIntensity(intensity: number): void;
  dispose(): void;
}

/** Handle a mount effect keeps: `live` is non-null only while the pulse must be written per frame. */
export interface HydraHaloMount {
  live: HydraHalo | null;
  dispose(): void;
}

/** Shared handle for every non-Hydra instance (no work, no allocation). */
export const NO_HYDRA_HALO_MOUNT: HydraHaloMount = Object.freeze({ live: null, dispose() {} }) as HydraHaloMount;

/**
 * Mount-effect wrapper: starts the async attach, survives an unmount before the
 * masks load, and under reduced motion writes the steady glow once and keeps
 * `live` null so the frame loop does nothing.
 */
export function mountHydraHalo(
  scene: THREE.Object3D,
  animatorId: string | undefined,
  reducedMotion: boolean,
  decorate?: HydraHaloNodeDecorator,
): HydraHaloMount {
  if (animatorId !== HYDRA_ANIMATOR_ID) return NO_HYDRA_HALO_MOUNT;
  let cancelled = false;
  let halo: HydraHalo | null = null;
  const mount: HydraHaloMount = {
    live: null,
    dispose() {
      cancelled = true;
      mount.live = null;
      halo?.dispose();
      halo = null;
    },
  };
  attachHydraHalo(scene, animatorId, () => cancelled, decorate)
    .then((attached) => {
      if (!attached) return;
      if (cancelled) { attached.dispose(); return; }
      halo = attached;
      if (reducedMotion) attached.setIntensity(HYDRA_GLOW_STEADY_INTENSITY);
      else mount.live = attached;
    })
    .catch((err) => console.warn('[hydra-halo] halo not attached:', err));
  return mount;
}

/**
 * Attach the halo shells to a loaded Hydra VRM scene. Run ONCE per loaded
 * instance (mount effect). Returns null for every other character, when the
 * scene has no glow-masked skinned mesh, or when `isCancelled()` turns true
 * while the masks load (the caller unmounted).
 */
export async function attachHydraHalo(
  scene: THREE.Object3D,
  animatorId: string | undefined,
  isCancelled: () => boolean,
  decorate?: HydraHaloNodeDecorator,
): Promise<HydraHalo | null> {
  if (animatorId !== HYDRA_ANIMATOR_ID) return null;
  let body: THREE.SkinnedMesh | null = null;
  scene.traverse((obj) => {
    const mesh = obj as THREE.SkinnedMesh;
    if (body || !mesh.isSkinnedMesh || !mesh.parent) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (list.some((m) => (m as THREE.MeshStandardMaterial | undefined)?.emissiveMap)) body = mesh;
  });
  if (!body) return null;
  const masks = await loadMasks();
  if (isCancelled()) return null;
  const mesh: THREE.SkinnedMesh = body;

  const shells: THREE.SkinnedMesh[] = [];
  const setters: Array<(k: number) => void> = [];
  for (const [mask, layers, name] of [
    [masks.suit, HYDRA_HALO_SUIT_LAYERS, 'hydra-halo-suit'],
    [masks.hot, HYDRA_HALO_HOT_LAYERS, 'hydra-halo-hot'],
  ] as const) {
    const geometry = buildHydraHaloGeometry(mesh.geometry, layers, mask.sample);
    if (!geometry) continue;
    const { material, setK } = createHaloMaterial(mask.texture, decorate);
    const shell = new THREE.SkinnedMesh(geometry, material);
    shell.name = name;
    shell.bind(mesh.skeleton, mesh.bindMatrix);
    shell.position.copy(mesh.position);
    shell.quaternion.copy(mesh.quaternion);
    shell.scale.copy(mesh.scale);
    // Frustum.intersectsObject uses the SkinnedMesh's OWN sphere (computed from
    // a pose), not the geometry's. Share the body's sphere object so the halo
    // is culled exactly when the body is (the shell is the body surface plus a
    // push of at most 0.035 mesh-local units).
    if (!mesh.boundingSphere) mesh.computeBoundingSphere();
    shell.boundingSphere = mesh.boundingSphere;
    shell.frustumCulled = mesh.frustumCulled;
    shell.castShadow = false;
    shell.receiveShadow = false;
    shell.renderOrder = 2;
    mesh.parent!.add(shell);
    shells.push(shell);
    setters.push(setK);
  }
  if (shells.length === 0) return null;
  return {
    setIntensity(intensity: number) {
      const k = intensity / HYDRA_GLOW_PEAK;
      for (let i = 0; i < setters.length; i++) setters[i]!(k);
    },
    dispose() {
      for (const shell of shells) {
        shell.removeFromParent();
        shell.geometry.dispose();
        (shell.material as THREE.Material).dispose(); // textures are shared per page; kept
      }
      shells.length = 0;
      setters.length = 0;
    },
  };
}
