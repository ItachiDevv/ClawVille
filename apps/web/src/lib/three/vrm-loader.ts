/**
 * vrm-loader.ts
 *
 * Suspense-compatible VRM loader that wraps GLTFLoader + VRMLoaderPlugin.
 *
 * Usage:
 *   const vrm = useVRM('/avatars/milady-official-1.vrm');
 *
 * Features:
 *   - Module-level Promise cache — each path loads exactly once per session
 *   - Registers VRMLoaderPlugin exactly once per GLTFLoader instance
 *   - Calls VRMUtils.removeUnnecessaryVertices + combineSkeletons after load
 *   - Calls VRMUtils.rotateVRM0 to normalise VRM 0.x facing to -Z (matches VRM 1.0)
 *   - Throws the Promise while loading (Suspense protocol)
 *   - Does NOT call useGLTF — VRM requires the plugin registration step that
 *     useGLTF's internal loader doesn't know about
 *
 * GPU constraints: no InstancedMesh, no ShaderMaterial, no drei Text/Billboard.
 */

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';

// ---------------------------------------------------------------------------
// Module-level VRM cache
// Holds either the resolved VRM or the in-flight Promise so the hook can
// implement the Suspense throw-the-promise protocol without re-entrancy bugs.
// ---------------------------------------------------------------------------

type CacheEntry =
  | { status: 'pending';  promise: Promise<VRM> }
  | { status: 'resolved'; vrm:     VRM }
  | { status: 'rejected'; error:   unknown };

const VRM_CACHE = new Map<string, CacheEntry>();

// Single shared GLTFLoader instance — VRMLoaderPlugin registered once.
let _loader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  if (_loader) return _loader;
  _loader = new GLTFLoader();
  _loader.register((parser) => new VRMLoaderPlugin(parser));
  return _loader;
}

/**
 * Initiate (or return) a VRM load for the given path.
 * Always returns immediately — the returned Promise resolves to the VRM.
 */
function loadVRM(path: string): Promise<VRM> {
  const existing = VRM_CACHE.get(path);
  if (existing) {
    if (existing.status === 'resolved') return Promise.resolve(existing.vrm);
    if (existing.status === 'rejected') return Promise.reject(existing.error);
    return existing.promise;
  }

  const loader = getLoader();

  const promise = loader
    .loadAsync(path)
    .then((gltf) => {
      const vrm: VRM | undefined = gltf.userData.vrm;
      if (!vrm) throw new Error(`[vrm-loader] No VRM data in ${path}`);

      // Do NOT call VRMUtils.combineSkeletons here — it merges SkinnedMesh
      // skeletons into a single consolidated skeleton but leaves the original
      // raw humanoid bones orphaned (parent === null). The Mixamo retargeter
      // animates `humanoid.getNormalizedBoneNode(...)` which `vrm.update()`
      // then copies to the raw humanoid bones — but those raw bones are no
      // longer in the SkinnedMesh's active skeleton, so the character renders
      // in T-pose even though the bones behind the scenes ARE moving.
      //
      // Confirmed via live CDP probe 2026-04-23: Normalized_mixamorigHips AND
      // mixamorigHips quaternions changed over 500ms, but mixamorigHips.parent
      // was null — orphaned by combineSkeletons. Removing this call restores
      // the animation-skeleton binding so Mixamo idle/walk drives the visible
      // mesh. We keep removeUnnecessaryVertices (it only culls unused verts,
      // no skeleton-graph mutation).
      VRMUtils.removeUnnecessaryVertices(vrm.scene);

      // Normalise facing: VRM 0.x faces +Z at rest; rotateVRM0 adds π on scene
      // so it faces -Z, matching VRM 1.0 convention.
      VRMUtils.rotateVRM0(vrm);

      // Disable frustum culling on every node in the VRM scene.
      // VRM models use SkinnedMesh nodes whose bounding spheres are computed
      // from the bind pose (T-pose). When the avatar is animated the posed geometry
      // extends outside the bind-pose bounding sphere, causing Three.js frustum
      // culling to incorrectly hide the mesh when the camera is close or looking
      // down from above. Setting frustumCulled=false on every node prevents this
      // "disappears at close range" regression for all VRM NPCs and the player pet.
      vrm.scene.traverse((obj) => {
        obj.frustumCulled = false;
      });

      VRM_CACHE.set(path, { status: 'resolved', vrm });
      return vrm;
    })
    .catch((err) => {
      VRM_CACHE.set(path, { status: 'rejected', error: err });
      throw err;
    });

  VRM_CACHE.set(path, { status: 'pending', promise });
  return promise;
}

/**
 * Suspense-compatible hook.
 * Must be called inside a React component (or hook) wrapped in <Suspense>.
 * Throws the Promise while loading, returns the VRM when resolved,
 * re-throws errors when rejected.
 */
export function useVRM(path: string): VRM {
  // Kick off the load if not already started
  const entry = VRM_CACHE.get(path);

  if (!entry) {
    // First call — initiate load and throw the Promise
    const p = loadVRM(path);
    throw p;
  }

  if (entry.status === 'pending') {
    throw entry.promise;
  }

  if (entry.status === 'rejected') {
    throw entry.error;
  }

  return entry.vrm;
}

/**
 * Preload a VRM without triggering Suspense.
 * Call from useEffect or module scope to warm the cache ahead of rendering.
 */
export function preloadVRM(path: string): void {
  if (!VRM_CACHE.has(path)) {
    loadVRM(path).catch(() => {
      // Errors will be surfaced when useVRM is actually called; swallow here.
    });
  }
}

/**
 * Expose cache for testing/debug.
 * Do not use in production rendering paths.
 */
export function getVRMCacheEntry(path: string): CacheEntry | undefined {
  return VRM_CACHE.get(path);
}
