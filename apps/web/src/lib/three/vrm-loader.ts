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

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// meshoptimizer's decoder object satisfies three's strict `setMeshoptDecoder`
// type (has useWorkers + decodeGltfBufferAsync); three-stdlib's variant is
// missing those methods and fails tsc. meshoptimizer@^0.22.0 is a root dep.
import { MeshoptDecoder } from 'meshoptimizer';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { MToonMaterialLoaderPlugin } from '@pixiv/three-vrm-materials-mtoon';
import type { VRM } from '@pixiv/three-vrm';

// MToon plugin registration (2026-04-23):
//   Explicitly register MToonMaterialLoaderPlugin so VRMLoaderPlugin produces
//   MToonMaterial instances (the WebGL ShaderMaterial variant) for all VRM
//   meshes. Without this line, CDP-probe confirmed that Milady VRMs were
//   loading with default MeshStandardMaterial + no diffuse maps, rendering
//   as black silhouettes (see
//   .claude/memory/threejs/gotchas/mixamo-retarget-rest-pose-transform.md
//   for the T-pose investigation that surfaced this).
//
//   We intentionally import from '@pixiv/three-vrm-materials-mtoon' (main
//   package) rather than '@pixiv/three-vrm/nodes'. The /nodes subpath re-
//   exports MToonNodeMaterial which references THREE_WEBGPU.tslFn — a symbol
//   removed from three in r168+ (renamed to Fn). At runtime MToon's FnCompat
//   shim picks the Fn branch, but Turbopack's strict static-export analysis
//   rejects the reference to tslFn and fails the build. The non-nodes path
//   has no such reference.
//
//   The MToon WebGL ShaderMaterial path runs under both WebGLRenderer and
//   WebGPURenderer's WebGL2 backend (via TSL transpilation in three/webgpu).
//   World3DCanvas attempts WebGPURenderer first and falls back to WebGL if
//   init fails — either path renders MToon correctly with this plugin
//   registered.

// ---------------------------------------------------------------------------
// Module-level VRM cache
// Holds either the resolved VRM or the in-flight Promise so the hook can
// implement the Suspense throw-the-promise protocol without re-entrancy bugs.
// ---------------------------------------------------------------------------

type CacheEntry =
  | { status: 'pending';  promise: Promise<VRM> }
  | { status: 'resolved'; vrm:     VRM }
  | { status: 'rejected'; error:   unknown };

/**
 * @invariant VRM_CACHE — one VRM instance per path, shared across all consumers.
 *
 * VRM_CACHE stores exactly ONE `VRM` object per path string. Every call to
 * `useVRM(path)` or `preloadVRM(path)` returns — or eventually resolves to —
 * that same object. This means `vrm.scene` is a **shared Object3D**; any
 * mutation made by one consumer (e.g. nulling `vrm.lookAt`) is immediately
 * visible to all others.
 *
 * Enforced constraints for all consumers:
 *   1. Never render two R3F components with the same VRM path — they would
 *      share `vrm.scene` and R3F's `<primitive>` would reparent it between
 *      groups each frame, clobbering both components' transforms.
 *   2. Mutations on the shared VRM instance (e.g. setting `vrm.lookAt = null`
 *      in VRMNpcMesh) affect every consumer using that path. Today player-avatar.tsx
 *      (PlayerPetVRMInner) does NOT use `lookAt` or `expressionManager`, so the
 *      wanderer null-assignments in arena-npcs.tsx are safe for current paths
 *      (official_2/3/4/7/8). If `lookAt` is ever added to player-avatar, those paths
 *      must be kept disjoint from any VRMNpcMesh path — or the null-assignment must
 *      be guarded by a per-consumer clone.
 *   3. Dispose of the VRM scene via VRMUtils.deepDispose at the correct lifetime
 *      boundary (the outermost component that owns the VRM). Do NOT dispose from
 *      an inner per-instance animator — the cache still holds a reference.
 *
 * Player-selectable paths:  official_1 … official_8 (agent-model-registry.ts)
 * Wandering NPC paths:       official_2, official_3, official_4, official_7, official_8
 * Overlap (constraint #2):   official_2/3/4/7/8 — player-avatar and wanderers share these.
 */
const VRM_CACHE = new Map<string, CacheEntry>();

// Single shared GLTFLoader instance — VRMLoaderPlugin registered once.
let _loader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  if (_loader) return _loader;
  _loader = new GLTFLoader();
  // VRM files may ship with EXT_meshopt_compression buffers (the asset
  // pipeline runs gltfpack -cc for skinned meshes). Without this line
  // GLTFLoader throws "setMeshoptDecoder must be called before loading
  // compressed files" at loadBufferView, which blocks the whole /game
  // route and shows Next's "This page couldn't load" error page.
  // three-stdlib's MeshoptDecoder is a callable that returns the decoder
  // object; GLTFLoader accepts either, but three-stdlib's signature is
  // `() => API` so we invoke it.
  // meshoptimizer's MeshoptDecoder is the decoder object itself (NOT a
  // callable — three-stdlib's is `() => API`, which is what caused the
  // PR #47 tsc break). Pass the object directly.
  _loader.setMeshoptDecoder(MeshoptDecoder);
  _loader.register((parser) => new VRMLoaderPlugin(parser, {
    mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser),
  }));
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

      // Joint pruning intentionally DROPPED 2026-04-25.
      // VRMUtils.removeUnnecessaryJoints is deprecated by pixiv. Their
      // "use combineSkeletons instead" recommendation is misleading — those
      // are different operations (combineSkeletons merges meshes and orphans
      // raw humanoid bones, see comment above). The deprecated joint-prune
      // function still works but emits a console.warn on every load.
      // The perf benefit it provided (~20-40% bone reduction → ~0.1ms/frame
      // across 5 VRMs) is small enough that a clean console is the better
      // tradeoff. If joint pruning becomes a real perf problem later, port
      // pixiv's pre-deprecation function locally instead of calling theirs.

      // Normalise facing: VRM 0.x faces +Z at rest; rotateVRM0 adds π on scene
      // so it faces -Z, matching VRM 1.0 convention.
      VRMUtils.rotateVRM0(vrm);

      // Hair accessory backward-tilt fix (2026-04-25 CDP diagnosis).
      //
      // These Milady VRMs have static non-skinned Hairmodel meshes parented to
      // mixamorigHead (raw Mixamo head bone). The Hairmodel geometry is symmetric
      // in Z (vertexZRange ≈ [-0.76, +0.76]) and the scalp (Body SkinnedMesh)
      // top vertices are 100% weighted to the same head bone — so there is no
      // positional separation between scalp and hair.
      //
      // Root cause: The Mixamo walk animation forward-tilts the head bone up to
      // ~0.10 rad (5.8°) via the hip/spine chain. When the head tilts forward,
      // the crown-back of the scalp tilts toward the camera. The Hairmodel tilts
      // with it, but its coverage at the crown-back is geometrically thin (222
      // verts at Z<-0.2 AND Y>0.5 vs 989 back verts total). The thin crown
      // becomes visible to a rear-above camera during the forward tilt phase.
      //
      // Fix: apply a static backward counter-rotation (rotation.x += +0.15 rad)
      // to the Hairmodel. This tilts the hair toward the back of the head by
      // 8.6°. At idle (no head tilt), the hair leans slightly backward, which
      // improves back-crown coverage aesthetically. At the max forward walk tilt
      // (0.10 rad), the net effective tilt is only 0.10 - 0.15 = -0.05 rad —
      // hair still drapes backward, no front gap created. The 0.15 rad value
      // is 1.5× the measured max head tilt, giving margin against variation.
      //
      // Rotation is around the mesh's own X axis (in head-bone local space):
      // positive X = tip forward, negative X = tip backward.
      // We add +0.15 to rotation.x which, in head-bone local space with Y-up
      // Z-forward convention, tilts the hair BACKWARD (toward -Z = body back).
      vrm.scene.traverse((obj) => {
        if (!(obj as THREE.Mesh).isMesh) return;
        if ((obj as any).isSkinnedMesh) return;
        const parent = obj.parent;
        if (!parent) return;
        const name = obj.name ?? '';
        if (name === 'Hairmodel') {
          // Tilt hair crown upward/backward to increase coverage of the crown-back
          // area exposed during walk animation.
          //
          // Measurement (2026-04-25 CDP live test): rotation.x += 0.15 on the
          // Hairmodel moves the crown vertex +1.94wu (UP) and -2.02wu in world Z
          // (toward the rear-camera direction). This increases crown-back visibility
          // and compensates for the Mixamo walk animation's max forward head tilt
          // of -0.10 rad (measured headBone.rotation.x range).
          //
          // The head bone tilts forward up to 0.10 rad during walk.
          // Iteration log:
          //   0.15 → user: "still sub par"  (+0.05 net at walk peak — too little)
          //   0.22 → user: "worse"           (overshoot, awkward windswept pose)
          //   0.18 → current — upper edge of 3da's measured 0.10-0.18 goldilocks
          //          band. Leaves +0.08 net at walk peak (3.5× the 0.15 attempt's
          //          coverage delta) without crossing into "leaning back too far"
          //          territory at idle.
          obj.rotation.x += 0.18;
        }
      });

      // MToon outline pass — disable to halve VRM draw calls (B1 2026-04-24).
      // MToon renders each mesh twice: once for the fill, once for an outset
      // silhouette (the "outline pass"). For ClawVille's wandering Milady VRMs
      // the ink-line aesthetic is not a core requirement; cel-shading look is
      // preserved by the fill pass alone. outlineWidthMode='none' per MToon
      // spec — no outline geometry is emitted. Reversible: set to
      // 'worldCoordinates' or 'screenCoordinates' to restore outlines.
      // Applied once per VRM at load time; safe for both renderers.
      //
      // NOTE: three-vrm 3.5.x uses STRING literals, not numeric enums.
      // Earlier `= 0` assignment silently did nothing at runtime.
      vrm.scene.traverse((obj) => {
        const mat = (obj as THREE.Mesh).material as any;
        if (!mat) return;
        const mats: any[] = Array.isArray(mat) ? mat : [mat];
        for (const m of mats) {
          if (m?.isMToonMaterial) m.outlineWidthMode = 'none';
        }
      });

      // Disable frustum culling on every node in the VRM scene.
      // VRM models use SkinnedMesh nodes whose bounding spheres are computed
      // from the bind pose (T-pose). When the avatar is animated the posed geometry
      // extends outside the bind-pose bounding sphere, causing Three.js frustum
      // culling to incorrectly hide the mesh when the camera is close or looking
      // down from above. Setting frustumCulled=false on every node prevents this
      // "disappears at close range" regression for all VRM NPCs and the player avatar.
      vrm.scene.traverse((obj) => {
        obj.frustumCulled = false;
      });

      // ── Spring-bone physics scale compensation ───────────────────────────
      // NOTE (2026-04-25 CDP probe): these Milady VRMs have springBoneManager.
      // joints.size === 0 — no spring-bone joints are registered. The for-of
      // loop is a no-op. Retained for safety in case a future VRM loads WITH
      // spring bones (e.g. a VRM 1.0 with proper secondary animation).
      //
      // If spring bones are ever present at VRM_NPC_SCALE=112, the two
      // scaling problems below apply:
      //   1. Stiffness overwhelmed → multiply HAIR_STIFFNESS_SCALE
      //   2. Translation lag from inertia term → SET dragForce high for hair
      if (vrm.springBoneManager) {
        const HAIR_STIFFNESS_SCALE  = 30;
        const OTHER_STIFFNESS_SCALE = 20;
        const HAIR_DRAG_FORCE       = 0.7;
        for (const joint of vrm.springBoneManager.joints) {
          const boneName = joint.bone?.name ?? '';
          const isHair   = /hair/i.test(boneName);
          joint.settings.stiffness *= isHair ? HAIR_STIFFNESS_SCALE : OTHER_STIFFNESS_SCALE;
          if (isHair) {
            joint.settings.dragForce = HAIR_DRAG_FORCE;
          }
        }
      }
      // ── End spring-bone scale compensation ────────────────────────────────

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
