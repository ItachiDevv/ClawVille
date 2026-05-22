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

function normaliseVRM(vrm: VRM): void {
  // Do NOT call VRMUtils.combineSkeletons — it merges SkinnedMesh skeletons
  // and leaves the raw humanoid bones orphaned (parent === null). The Mixamo
  // retargeter animates `humanoid.getNormalizedBoneNode(...)` whose updates
  // are then copied to the raw humanoid bones — but those raw bones would no
  // longer be in the SkinnedMesh's active skeleton, producing a frozen T-pose.
  // removeUnnecessaryVertices is safe (only culls unused verts).
  VRMUtils.removeUnnecessaryVertices(vrm.scene);

  // VRM 0.x faces +Z at rest; rotateVRM0 adds π on the scene root so it
  // matches VRM 1.0's -Z convention.
  VRMUtils.rotateVRM0(vrm);

  // MToon outline pass — disable to halve VRM draw calls (each MToon mesh
  // would otherwise render twice: fill + offset silhouette). For ClawVille's
  // wandering Milady VRMs the ink-line aesthetic isn't a core requirement;
  // the cel-shaded look is preserved by the fill pass alone. three-vrm 3.5.x
  // uses STRING literals for outlineWidthMode, not numeric enums.
  vrm.scene.traverse((obj) => {
    const mat = (obj as THREE.Mesh).material as unknown;
    if (!mat) return;
    const mats = (Array.isArray(mat) ? mat : [mat]) as Array<{ isMToonMaterial?: boolean; outlineWidthMode?: string }>;
    for (const m of mats) {
      if (m?.isMToonMaterial) m.outlineWidthMode = 'none';
    }
  });

  // Fattened-bounding-sphere frustum culling (2026-05-22 perf wave 3).
  //
  // Previously this loop disabled frustumCulled entirely on every VRM node
  // because Three.js computes SkinnedMesh bounding spheres from the BIND
  // pose (T-pose), which is smaller than the animated pose envelope —
  // walk/run cycles extend the geometry past the bind sphere, causing
  // Three.js to incorrectly cull the mesh at close range / steep camera.
  //
  // The fix: keep frustumCulled = true (so off-screen VRMs get culled
  // for free) but fatten each SkinnedMesh's bounding sphere by 1.6× radius
  // so the animated pose stays inside the bound. Static meshes inside
  // the VRM (eyes, accessory geometry) keep their stock bounding spheres
  // since they don't deform — only SkinnedMesh nodes need fattening.
  //
  // Trade-off: a tiny band around the camera frustum where the mesh would
  // be marginally off-screen but stays drawn. Cheap. The win is that the
  // 11 stationary building-resident VRMs facing away from the camera
  // (or behind the player) get correctly culled instead of being drawn
  // every frame. Estimated -10 to -30 draw calls when looking away from
  // a cluster of NPCs.
  const FATTEN_FACTOR = 1.6;
  vrm.scene.traverse((obj) => {
    // SkinnedMesh check via duck-typed property — avoids the dual-three-types
    // cast issue between the 0.170 and 0.182 @types/three (the unknown→cast
    // pattern would be safe but noisier; the runtime check is equivalent).
    const mesh = obj as unknown as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh && mesh.geometry) {
      const geom = mesh.geometry;
      // Compute the bind-pose bounding sphere if it doesn't exist.
      if (!geom.boundingSphere) geom.computeBoundingSphere();
      // Fatten radius in place. Safe because the geometry is shared per-VRM-instance
      // (useVRMInstance pattern); siblings of the same VRM at the same scale see the
      // same animation envelope, so one shared fattened sphere is correct.
      if (geom.boundingSphere) {
        geom.boundingSphere.radius *= FATTEN_FACTOR;
      }
      mesh.frustumCulled = true;
    } else {
      // Non-skinned meshes (eyes, accessory geometry, lookAt helpers):
      // keep frustumCulled enabled with stock bounding sphere.
      obj.frustumCulled = true;
    }
  });

  // Spring-bone scale compensation. NOTE (CDP probe 2026-04-25): Milady VRMs
  // have springBoneManager.joints.size === 0 — the loop below is a no-op.
  // Retained for safety in case a future VRM ships with proper VRM 1.0
  // secondary animation (hair / cloth physics). If spring bones ARE present
  // at VRM_NPC_SCALE=112, they need stiffness multipliers + drag force on
  // hair joints to compensate for the scaling factor.
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
}

// ---------------------------------------------------------------------------
// Per-instance parse
// ---------------------------------------------------------------------------

async function loadInstance(cacheKey: string, path: string): Promise<VRM> {
  const buffer = await fetchBytes(path);
  // .slice(0) gives the parser its own copy of the bytes. GLTFLoader doesn't
  // mutate the input, but the defensive copy guards against any future change
  // in three's parser semantics that could corrupt subsequent parses.
  const ownBuffer = buffer.slice(0);
  const gltf = await getLoader().parseAsync(ownBuffer, '');
  const vrm: VRM | undefined = (gltf as unknown as { userData: { vrm?: VRM } }).userData.vrm;
  if (!vrm) throw new Error(`[vrm-loader] No VRM data in ${path}`);
  normaliseVRM(vrm);
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
