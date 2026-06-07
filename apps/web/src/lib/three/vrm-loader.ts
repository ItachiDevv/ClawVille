/**
 * vrm-loader.ts
 *
 * Suspense-compatible per-instance VRM loader.
 *
 * Architecture (Codex Critical #1, redesigned 2026-04-28):
 *   - VRM_BYTES — one ArrayBuffer fetch per path, shared across all instances.
 *     Network round-trip happens once per VRM file per session.
 *   - VRM_INSTANCES — one fully-disjoint VRM per (path, instanceId). Each
 *     mounted avatar gets its own scene, skeleton, humanoid, expressionManager,
 *     and springBoneManager. NO sharing of mutable state across consumers.
 *
 * Per-consumer cost: one parse (~30-80ms on Iris Xe). Per-path cost: one fetch.
 *
 * Why fully disjoint per instance:
 *   - vrm.scene is the live Object3D tree mounted under <primitive>. Sharing it
 *     causes R3F to reparent the same object between groups every frame.
 *   - vrm.humanoid/lookAt/expressionManager/springBoneManager hold direct refs
 *     to bones in vrm.scene. Cloning only the scene leaves these managers
 *     pointing at the wrong bones (the template's, not the consumer's clone).
 *   - The only correct fix is per-instance parse.
 *
 * Usage:
 *   const vrm = useVRMInstance('/avatars/milady-official-1.vrm', npc.id);
 *   useEffect(() => () => disposeVRMInstance(path, npc.id), [path, npc.id]);
 *
 * GPU constraints: no InstancedMesh, no ShaderMaterial, no drei Text/Billboard.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// meshoptimizer's decoder object satisfies three's strict `setMeshoptDecoder`
// type (has useWorkers + decodeGltfBufferAsync); three-stdlib's variant is
// missing those methods and fails tsc. meshoptimizer@^0.22.0 is a root dep.
import { MeshoptDecoder } from 'meshoptimizer';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { MToonMaterialLoaderPlugin } from '@pixiv/three-vrm-materials-mtoon';
import type { VRM } from '@pixiv/three-vrm';

// MToon plugin registration:
//   Explicitly register MToonMaterialLoaderPlugin so VRMLoaderPlugin produces
//   MToonMaterial instances (the WebGL ShaderMaterial variant) for all VRM
//   meshes. Without this line, Milady VRMs render with default
//   MeshStandardMaterial + no diffuse maps — black silhouettes. We import from
//   '@pixiv/three-vrm-materials-mtoon' (NOT '@pixiv/three-vrm/nodes') because
//   the /nodes path references THREE_WEBGPU.tslFn which Turbopack rejects.

// ---------------------------------------------------------------------------
// Shared frustum-culling helper (exported for VRM consumer call sites)
// ---------------------------------------------------------------------------

/**
 * applyFattenedFrustumCulling — replaces the defensive `frustumCulled = false`
 * traversal pattern with one that ACTUALLY culls off-screen VRMs and GLBs.
 *
 * For SkinnedMesh: fattens the geometry's bounding sphere by `factor` (default
 * 1.6) to cover the animated pose envelope. The bind-pose sphere computed by
 * Three.js is too tight — walk/run/emote cycles extend geometry outside it,
 * causing Three.js to wrongly cull the mesh when camera is close or angled.
 * Fattening gives a conservative bound that stays valid throughout the animation.
 *
 * Idempotent: tags the geometry with `_fattenedBy` so repeated calls from
 * multiple defensive call sites do NOT compound the fattening. Safe to call on
 * the same root multiple times (e.g. normaliseVRM + VRMNpcMesh useEffect).
 *
 * For Mesh / InstancedMesh: simply sets `frustumCulled = true` (restores the
 * Three.js default that was disabled by the old defensive pattern).
 *
 * For Object3D / Group / Bone: leaves `frustumCulled` at its default (true).
 * Groups use their children's world AABBs for culling — no change needed.
 *
 * Call this EVERYWHERE the old pattern `traverse((o) => { o.frustumCulled = false; })`
 * appeared in VRM-consumer code paths.
 */
export function applyFattenedFrustumCulling(root: THREE.Object3D, factor: number = 1.6): void {
  root.traverse((obj) => {
    if ((obj as unknown as THREE.SkinnedMesh).isSkinnedMesh) {
      const sm = obj as unknown as THREE.SkinnedMesh;
      const geom = sm.geometry;
      if (geom) {
        if (!geom.boundingSphere) geom.computeBoundingSphere();
        // Idempotent — tag the geometry so repeated calls don't compound fattening.
        const tag = '_fattenedBy';
        const already = (geom as unknown as Record<string, number>)[tag];
        if (already == null && geom.boundingSphere) {
          geom.boundingSphere.radius *= factor;
          (geom as unknown as Record<string, number>)[tag] = factor;
        }
      }
      sm.frustumCulled = true;
    } else if ((obj as THREE.Mesh).isMesh || (obj as THREE.InstancedMesh).isInstancedMesh) {
      obj.frustumCulled = true;
    }
    // Object3D / Group / Bone / etc — leave frustumCulled at default (true).
  });
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

type InstanceEntry =
  | { status: 'pending';  promise: Promise<VRM> }
  | { status: 'resolved'; vrm:     VRM }
  | { status: 'rejected'; error:   unknown };

/**
 * Bytes cache, keyed by path. One fetch per file per session.
 * Stores the in-flight Promise so concurrent first-mount calls dedup the
 * fetch instead of launching N parallel HTTP requests for the same VRM.
 */
const VRM_BYTES = new Map<string, Promise<ArrayBuffer>>();

/**
 * Instance cache, keyed by `${path}#${instanceId}`. One unique VRM per
 * (path, instanceId) pair. Each entry holds either an in-flight parse Promise
 * (for Suspense), a resolved VRM, or a parse error.
 *
 * Disposal is the consumer's responsibility: call `disposeVRMInstance(path, id)`
 * in useEffect cleanup. Dropped instances leak both GPU memory (geometry,
 * textures) and CPU memory (skeleton/scene graph) until disposed.
 */
const VRM_INSTANCES = new Map<string, InstanceEntry>();

// Single shared GLTFLoader instance — VRMLoaderPlugin registered once.
// Reused across all parses; the parser hooks into per-parse state internally.
let _loader: GLTFLoader | null = null;

type VRMSceneCounts = {
  objects: number;
  meshes: number;
  skinnedMeshes: number;
  geometries: number;
  materials: number;
  textures: number;
};

type VRMNormaliseTimings = {
  removeUnnecessaryVerticesMs: number;
  rotateVRM0Ms: number;
  outlineDisableMs: number;
  frustumCullingMs: number;
  springBoneScaleMs: number;
};

type VRMLoadMetric = {
  path: string;
  instanceId: string;
  bytes: number;
  fetchWaitMs: number;
  sliceMs: number;
  parseMs: number;
  normaliseMs: number;
  totalMs: number;
  sceneBefore: VRMSceneCounts;
  sceneAfter: VRMSceneCounts;
  normalise: VRMNormaliseTimings;
};

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function roundMs(n: number): number {
  return Math.round(n * 10) / 10;
}

function collectVRMSceneCounts(root: THREE.Object3D): VRMSceneCounts {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  let objects = 0;
  let meshes = 0;
  let skinnedMeshes = 0;

  root.traverse((obj) => {
    objects++;
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh && !(obj as THREE.SkinnedMesh).isSkinnedMesh) return;
    meshes++;
    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) skinnedMeshes++;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const matList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of matList) {
      if (!mat) continue;
      materials.add(mat);
      for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });

  return {
    objects,
    meshes,
    skinnedMeshes,
    geometries: geometries.size,
    materials: materials.size,
    textures: textures.size,
  };
}

function pushVRMLoadMetric(metric: VRMLoadMetric): void {
  if (typeof window === 'undefined') return;
  const bridge = window as unknown as { __CV_VRM_LOAD_METRICS?: VRMLoadMetric[] };
  const metrics = bridge.__CV_VRM_LOAD_METRICS ?? [];
  metrics.push(metric);
  bridge.__CV_VRM_LOAD_METRICS = metrics.slice(-200);
}

function getLoader(): GLTFLoader {
  if (_loader) return _loader;
  _loader = new GLTFLoader();
  // VRM files may ship with EXT_meshopt_compression buffers (the asset
  // pipeline runs gltfpack -cc for skinned meshes). Without this line
  // GLTFLoader throws "setMeshoptDecoder must be called before loading
  // compressed files" at loadBufferView, blocking the whole /game route.
  _loader.setMeshoptDecoder(MeshoptDecoder);
  _loader.register((parser) => new VRMLoaderPlugin(parser, {
    mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser),
  }));
  return _loader;
}

// ---------------------------------------------------------------------------
// Bytes fetch — one HTTP fetch per path
// ---------------------------------------------------------------------------

function fetchBytes(path: string): Promise<ArrayBuffer> {
  let p = VRM_BYTES.get(path);
  if (!p) {
    p = fetch(path).then((r) => {
      if (!r.ok) throw new Error(`[vrm-loader] fetch ${path} failed: ${r.status}`);
      return r.arrayBuffer();
    }).catch((err) => {
      // On error, evict so a future call can retry instead of replaying the rejection.
      VRM_BYTES.delete(path);
      throw err;
    });
    VRM_BYTES.set(path, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Per-instance VRM normalisation
// ---------------------------------------------------------------------------

function normaliseVRM(vrm: VRM): VRMNormaliseTimings {
  const timings: VRMNormaliseTimings = {
    removeUnnecessaryVerticesMs: 0,
    rotateVRM0Ms: 0,
    outlineDisableMs: 0,
    frustumCullingMs: 0,
    springBoneScaleMs: 0,
  };

  // Do NOT call VRMUtils.combineSkeletons — it merges SkinnedMesh skeletons
  // and leaves the raw humanoid bones orphaned (parent === null). The Mixamo
  // retargeter animates `humanoid.getNormalizedBoneNode(...)` whose updates
  // are then copied to the raw humanoid bones — but those raw bones would no
  // longer be in the SkinnedMesh's active skeleton, producing a frozen T-pose.
  // removeUnnecessaryVertices is safe (only culls unused verts).
  let t = nowMs();
  VRMUtils.removeUnnecessaryVertices(vrm.scene);
  timings.removeUnnecessaryVerticesMs = roundMs(nowMs() - t);

  // VRM 0.x faces +Z at rest; rotateVRM0 adds π on the scene root so it
  // matches VRM 1.0's -Z convention.
  t = nowMs();
  VRMUtils.rotateVRM0(vrm);
  timings.rotateVRM0Ms = roundMs(nowMs() - t);

  // MToon outline pass — disable to halve VRM draw calls (each MToon mesh
  // would otherwise render twice: fill + offset silhouette). For ClawVille's
  // wandering Milady VRMs the ink-line aesthetic isn't a core requirement;
  // the cel-shaded look is preserved by the fill pass alone. three-vrm 3.5.x
  // uses STRING literals for outlineWidthMode, not numeric enums.
  t = nowMs();
  vrm.scene.traverse((obj) => {
    const mat = (obj as THREE.Mesh).material as unknown;
    if (!mat) return;
    const mats = (Array.isArray(mat) ? mat : [mat]) as Array<{ isMToonMaterial?: boolean; outlineWidthMode?: string }>;
    for (const m of mats) {
      if (m?.isMToonMaterial) m.outlineWidthMode = 'none';
    }
  });
  timings.outlineDisableMs = roundMs(nowMs() - t);

  // Fattened-bounding-sphere frustum culling (2026-05-22 perf wave 3).
  //
  // applyFattenedFrustumCulling (exported above) fattens each SkinnedMesh's
  // bounding sphere by 1.6× so the animated pose envelope stays inside the
  // bound, then sets frustumCulled = true. Off-screen VRMs are now culled by
  // Three.js's built-in frustum check instead of being drawn every frame.
  //
  // The idempotent geometry tag (_fattenedBy) prevents compounding when
  // consumer call sites (VRMNpcMesh useEffect, cosmetic-loader) call this
  // helper again on the same VRM scene as a defensive re-apply.
  t = nowMs();
  applyFattenedFrustumCulling(vrm.scene);
  timings.frustumCullingMs = roundMs(nowMs() - t);

  // Spring-bone scale compensation. NOTE (CDP probe 2026-04-25): Milady VRMs
  // have springBoneManager.joints.size === 0 — the loop below is a no-op.
  // Retained for safety in case a future VRM ships with proper VRM 1.0
  // secondary animation (hair / cloth physics). If spring bones ARE present
  // at VRM_NPC_SCALE=112, they need stiffness multipliers + drag force on
  // hair joints to compensate for the scaling factor.
  t = nowMs();
  if (vrm.springBoneManager) {
    const HAIR_STIFFNESS_SCALE  = 30;
    const OTHER_STIFFNESS_SCALE = 20;
    const HAIR_DRAG_FORCE       = 0.7;
    for (const joint of vrm.springBoneManager.joints) {
      const boneName = joint.bone?.name ?? '';
      const isHair   = /hair/i.test(boneName);
      joint.settings.stiffness *= isHair ? HAIR_STIFFNESS_SCALE : OTHER_STIFFNESS_SCALE;
      if (isHair) joint.settings.dragForce = HAIR_DRAG_FORCE;
    }
  }
  timings.springBoneScaleMs = roundMs(nowMs() - t);
  return timings;
}

// ---------------------------------------------------------------------------
// Per-instance parse
// ---------------------------------------------------------------------------

async function loadInstance(cacheKey: string, path: string): Promise<VRM> {
  const totalStart = nowMs();
  const buffer = await fetchBytes(path);
  const fetchDone = nowMs();
  // .slice(0) gives the parser its own copy of the bytes. GLTFLoader doesn't
  // mutate the input, but the defensive copy guards against any future change
  // in three's parser semantics that could corrupt subsequent parses.
  const ownBuffer = buffer.slice(0);
  const sliceDone = nowMs();
  const gltf = await getLoader().parseAsync(ownBuffer, '');
  const parseDone = nowMs();
  const vrm: VRM | undefined = (gltf as unknown as { userData: { vrm?: VRM } }).userData.vrm;
  if (!vrm) throw new Error(`[vrm-loader] No VRM data in ${path}`);
  const sceneBefore = collectVRMSceneCounts(vrm.scene);
  const normalise = normaliseVRM(vrm);
  const normaliseDone = nowMs();
  const sceneAfter = collectVRMSceneCounts(vrm.scene);
  pushVRMLoadMetric({
    path,
    instanceId: cacheKey.slice(path.length + 1),
    bytes: buffer.byteLength,
    fetchWaitMs: roundMs(fetchDone - totalStart),
    sliceMs: roundMs(sliceDone - fetchDone),
    parseMs: roundMs(parseDone - sliceDone),
    normaliseMs: roundMs(normaliseDone - parseDone),
    totalMs: roundMs(normaliseDone - totalStart),
    sceneBefore,
    sceneAfter,
    normalise,
  });
  VRM_INSTANCES.set(cacheKey, { status: 'resolved', vrm });
  return vrm;
}

// ---------------------------------------------------------------------------
// Public API — Suspense-compatible per-instance hook
// ---------------------------------------------------------------------------

/**
 * Fetch + parse a fresh VRM instance for (path, instanceId).
 * Throws a Promise while loading (Suspense protocol). Returns the resolved
 * VRM on success. Re-throws errors on parse failure.
 *
 * Two calls with the same instanceId return the same cached VRM. Two calls
 * with different instanceIds return DIFFERENT VRMs even for the same path —
 * that's the whole point.
 *
 * Consumer responsibility: pass a stable instanceId per component instance
 * (e.g. `npc.id`, `'player-avatar'`, `'picker'`), and dispose on unmount via
 * `disposeVRMInstance(path, instanceId)`.
 */
export function useVRMInstance(path: string, instanceId: string): VRM {
  const cacheKey = `${path}#${instanceId}`;
  const entry = VRM_INSTANCES.get(cacheKey);

  if (!entry) {
    const promise = loadInstance(cacheKey, path).catch((err) => {
      VRM_INSTANCES.set(cacheKey, { status: 'rejected', error: err });
      throw err;
    });
    VRM_INSTANCES.set(cacheKey, { status: 'pending', promise });
    throw promise;
  }

  if (entry.status === 'pending')  throw entry.promise;
  if (entry.status === 'rejected') throw entry.error;
  return entry.vrm;
}

/**
 * Imperative loader for non-React contexts (tests, scripts).
 * Same per-instance semantics as useVRMInstance — the React hook is a thin
 * Suspense wrapper around this.
 */
export function loadVRMInstance(instanceId: string, path: string): Promise<VRM> {
  const cacheKey = `${path}#${instanceId}`;
  const entry = VRM_INSTANCES.get(cacheKey);
  if (entry) {
    if (entry.status === 'resolved') return Promise.resolve(entry.vrm);
    if (entry.status === 'rejected') return Promise.reject(entry.error);
    return entry.promise;
  }
  const promise = loadInstance(cacheKey, path).catch((err) => {
    VRM_INSTANCES.set(cacheKey, { status: 'rejected', error: err });
    throw err;
  });
  VRM_INSTANCES.set(cacheKey, { status: 'pending', promise });
  return promise;
}

/**
 * Dispose a specific VRM instance. Call from useEffect cleanup on unmount.
 *
 * Disposes the VRM's scene meshes/materials/geometries via VRMUtils.deepDispose,
 * then evicts the cache entry. Cached BYTES are kept — the next instance for
 * the same path can parse without re-fetching.
 *
 * Safe to call with an unknown (path, instanceId) — silently no-ops if the
 * instance was never created or already disposed.
 */
export function disposeVRMInstance(path: string, instanceId: string): void {
  const cacheKey = `${path}#${instanceId}`;
  const entry = VRM_INSTANCES.get(cacheKey);
  if (!entry) return;
  if (entry.status === 'resolved') {
    try {
      VRMUtils.deepDispose(entry.vrm.scene);
    } catch {
      // deepDispose can throw on partially-loaded scenes; swallow so the
      // cache entry is always evicted (preventing leaks even on dispose error).
    }
  }
  VRM_INSTANCES.delete(cacheKey);
}

/**
 * Warm the byte cache for a path so the first useVRMInstance call doesn't
 * pay the network round-trip. No parse — just fetch into VRM_BYTES.
 */
export function preloadVRMBytes(path: string): void {
  fetchBytes(path).catch(() => {
    // Errors will surface when useVRMInstance actually tries to parse.
  });
}

// ---------------------------------------------------------------------------
// Test/debug introspection
// ---------------------------------------------------------------------------

/** Test helper: count active instances. Internal, not for production code. */
export function _vrmInstanceCount(): number {
  return VRM_INSTANCES.size;
}

/** Test helper: clear all caches. Internal, not for production code. */
export function _vrmClearAllCaches(): void {
  for (const [, entry] of VRM_INSTANCES) {
    if (entry.status === 'resolved') {
      try { VRMUtils.deepDispose(entry.vrm.scene); } catch { /* ignore */ }
    }
  }
  VRM_INSTANCES.clear();
  VRM_BYTES.clear();
}
