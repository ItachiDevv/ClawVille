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
  | { status: 'resolved'; vrm: VRM; sharedTextureKeys: Set<string> }
  | { status: 'rejected'; error:   unknown };

type CanonicalTextureEntry = {
  tex: THREE.Texture;
  refs: number;
};

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

/**
 * Cross-instance texture cache. The path prefix intentionally prevents
 * content-identical textures in different VRM files from sharing ownership.
 * `refs` counts resolved VRM instances, not material slots.
 */
const VRM_CANONICAL_TEXTURES = new Map<string, CanonicalTextureEntry>();

/**
 * Deferred-dispose timers, keyed like VRM_INSTANCES (`${path}#${instanceId}`).
 *
 * WHY (2026-07-14, invisible-NPC root cause): React StrictMode (dev default)
 * double-invokes effects — mount → simulated unmount → remount. The simulated
 * unmount used to run `disposeVRMInstance` IMMEDIATELY, `deepDispose`-ing the
 * GPU buffers of a `<primitive object={vrm.scene}>` that was still committed
 * to the R3F graph: every VRM NPC in /game rendered as an invisible body
 * (name tag only) with 100+ "drawElements: no buffer is bound to enabled
 * attribute" errors, plus animator double-patch churn as Suspense re-parsed
 * the evicted entries. Disposal is now DEFERRED by a short grace window and
 * CANCELLED when the same (path, instanceId) is re-acquired — the drei
 * useGLTF pattern. Real unmounts still dispose (timer fires unopposed).
 */
const VRM_PENDING_DISPOSES = new Map<string, ReturnType<typeof setTimeout>>();

/** Grace window before a dispose actually runs. StrictMode re-acquires within
 * the same commit (ms); Suspense remounts within a frame or two. 500ms keeps
 * GPU memory held briefly on real unmounts while safely covering both. */
const VRM_DISPOSE_GRACE_MS = 500;

/** Cancel a scheduled dispose for cacheKey (consumer re-acquired in time). */
function cancelPendingDispose(cacheKey: string): void {
  const timer = VRM_PENDING_DISPOSES.get(cacheKey);
  if (timer !== undefined) {
    clearTimeout(timer);
    VRM_PENDING_DISPOSES.delete(cacheKey);
  }
}

/**
 * EXTEND (not cancel) a scheduled dispose — the render-time acquire path.
 * A render alone must never permanently cancel a real disposal (Codex
 * finding 2026-07-14): React can abandon a render before its effects commit,
 * and a render-time cancel would then leak the VRM's GPU memory forever.
 * Extending resets the grace window so the freshly-rendered component's
 * effect setup (`retainVRMInstance`) — which only runs on COMMIT — has time
 * to issue the authoritative cancel; an abandoned render just delays the
 * dispose by one grace window.
 */
function extendPendingDispose(cacheKey: string): void {
  const timer = VRM_PENDING_DISPOSES.get(cacheKey);
  if (timer === undefined) return;
  clearTimeout(timer);
  VRM_PENDING_DISPOSES.set(
    cacheKey,
    setTimeout(() => executePendingDispose(cacheKey), VRM_DISPOSE_GRACE_MS),
  );
}

// Single shared GLTFLoader instance — VRMLoaderPlugin registered once.
// Reused across all parses; the parser hooks into per-parse state internally.
let _loader: GLTFLoader | null = null;

// GLTFLoader.parseAsync does heavy synchronous work before yielding. Parsing
// every visible VRM at once starves RAF/requestIdleCallback and can keep /game
// in the texture-upload blue-screen state. Queue parses with limited concurrency;
// Suspense fallbacks remain null, so real VRMs stream in progressively without fake
// cylinder/capsule stand-ins.
//
// Concurrency is now DYNAMIC (perf round-3):
//   - BULK phase (before __W3D_READY):   VRM_PARSE_CONCURRENCY_BULK = 6
//     During the initial load the loading overlay is visible and there is no
//     frame budget to protect. Running 6 parses concurrently pipelines the
//     async fetch-buffer/decode steps, cutting the 9.6s queue-wait measured
//     in the baseline to ~2-3s. The synchronous normalise+frustumCulling pass
//     still runs single-threaded between yielded microtasks.
//   - STEADY-STATE (after __W3D_READY):  VRM_PARSE_CONCURRENCY_STEADY = 2
//     Remote-player join parses run at 2 to avoid starving the render loop.
//
// The player-avatar priority lane (PLAYER_INSTANCE_ID) still unshifts ahead of
// all slots regardless of concurrency mode.
const VRM_PARSE_CONCURRENCY_BULK   = 6;  // while loading overlay is up
const VRM_PARSE_CONCURRENCY_STEADY = 2;  // after __W3D_READY
const VRM_PARSE_QUEUE: Array<() => void> = [];
let vrmParseActive = 0;

/** Returns the current effective parse-queue concurrency limit. */
function getVRMParseConcurrency(): number {
  if (typeof window === 'undefined') return VRM_PARSE_CONCURRENCY_BULK;
  return (window as any).__W3D_READY === true
    ? VRM_PARSE_CONCURRENCY_STEADY
    : VRM_PARSE_CONCURRENCY_BULK;
}

// ---------------------------------------------------------------------------
// Bulk-VRM-idle callback (perf round-3, change A)
// ---------------------------------------------------------------------------
//
// PreCompilePipelines fires compileAsync once at mount, before any VRM is in
// the scene. A second compileAsync call after the parse queue drains ensures
// the skinned-MeshStandardMaterial pipeline variants are compiled under the
// loading spinner rather than lazily at first reveal.
//
// Usage (from World3DCanvas.tsx PreCompilePipelines):
//   registerBulkVRMIdleCallback(() => gl.compileAsync(scene, camera));
//
// The callback fires ONCE (guarded by _bulkIdleFired) but ONLY after
// _bulkBatchStarted is true (i.e. at least one VRM parse has been enqueued).
// This prevents the common race where registerBulkVRMIdleCallback is called at
// mount-rAF (~16ms after mount) while the parse queue is still empty because
// no VRM fetch has resolved yet — without _bulkBatchStarted the callback would
// fire immediately, scheduling a second compileAsync before any VRM is in the
// scene, defeating Change A entirely on cold cache.
//
// Fire paths (both gated on _bulkBatchStarted):
//   1. pumpVRMParseQueue() drain detection — fires when queue goes idle after
//      the first enqueue.
//   2. registerBulkVRMIdleCallback() registration path — fires if the batch
//      already started AND is already drained by registration time (warm-cache
//      re-visit where all 14 VRMs parsed before the rAF fires).
//
// Zero-VRM edge case: if no VRMs ever load, _bulkBatchStarted stays false and
// the callback never fires. The mount compileAsync already covered the static
// scene, so the second call is correctly skipped.
let _bulkIdleFired   = false;
let _bulkBatchStarted = false;          // set true when first parse is enqueued
let _bulkIdleCb: (() => void) | null = null;

export function registerBulkVRMIdleCallback(cb: () => void): void {
  if (_bulkIdleFired) {
    // Batch already completed before we were called — fire on next microtask.
    Promise.resolve().then(cb);
    return;
  }
  _bulkIdleCb = cb;
  // Handle warm-cache re-visit: batch started AND queue already drained by the
  // time we register. Without this check the pumpVRMParseQueue drain path would
  // have already fired (and set _bulkIdleFired), so we'd be in the branch above.
  // But to be safe and symmetric with the pump check, mirror the exact condition.
  if (_bulkBatchStarted && VRM_PARSE_QUEUE.length === 0 && vrmParseActive === 0) {
    _fireBulkIdleCb();
  }
}

function _fireBulkIdleCb(): void {
  if (_bulkIdleFired || !_bulkIdleCb) return;
  _bulkIdleFired = true;
  const cb = _bulkIdleCb;
  _bulkIdleCb = null;
  // Schedule via idle or microtask so we don't run inside the queue pump.
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => cb(), { timeout: 200 });
  } else {
    Promise.resolve().then(cb);
  }
}

// ---------------------------------------------------------------------------
// Generation counters — dispose-while-pending race fix (punch list items 1–4)
// ---------------------------------------------------------------------------
//
// Each (path, instanceId) pair has a monotonically-increasing generation number.
// Cancellation is bound to the TASK (its generation), not the key string.
//
// Protocol:
//   - When a new load starts: gen = (VRM_LOAD_GEN.get(cacheKey) ?? 0) + 1;
//     VRM_LOAD_GEN.set(cacheKey, gen); pass gen into loadInstance/enqueueVRMParse.
//   - When disposeVRMInstance is called on a pending entry: increment the
//     generation counter — this "invalidates" all in-flight and queued tasks for
//     this cacheKey without touching any future tasks. No token to delete.
//   - Runner cancellation check: compares gen against VRM_LOAD_GEN.get(cacheKey).
//     If they diverge the task is stale; reject without parse. No CANCELLED set
//     to mis-route (items 1/4 fix: priority-remount and parse-error can no
//     longer consume a token that belongs to a different task).
//   - Post-parse guard: same generation check, then the existing
//     currentEntry.status !== 'pending' defensive check.
//   - catch handlers in useVRMInstance/loadVRMInstance: identity-guarded so a
//     stale load's rejection can NEVER re-insert or clobber a newer entry
//     (items 1/2/3 fix). A cancellation rejection writes nothing; a genuine
//     parse error writes 'rejected' only when the entry still belongs to THIS
//     load's promise.
const VRM_LOAD_GEN = new Map<string, number>();

// ---------------------------------------------------------------------------
// Priority lane — player-avatar parse always jumps the queue (punch list 2)
// ---------------------------------------------------------------------------
//
// The player avatar uses the stable instanceId 'player-avatar' (confirmed in
// player-avatar.tsx line ~297: useVRMInstance(reg.path, 'player-avatar')).
// Any cacheKey ending with '#player-avatar' is given priority=true so its
// parse task is unshifted to the FRONT of VRM_PARSE_QUEUE instead of pushed
// to the back. This prevents the player from waiting behind all 12+ wandering
// NPC parses (measured 19s worst case on Iris Xe).
const PLAYER_INSTANCE_ID = 'player-avatar';

// ---------------------------------------------------------------------------
// Metrics gating — evaluate once at module init (punch list 3)
// ---------------------------------------------------------------------------
//
// Collecting VRMSceneCounts runs two full traversals (before + after
// normalise) and Object.values over every material — non-trivial work on
// Iris Xe for a 13-VRM scene. Gate the traversals AND the window array writes
// behind a module-level flag evaluated once. Active when:
//   (a) location.search contains 'perf=1'  — prod URL flag
//   (b) window.__CV_PERF_HARNESS__ === true — set by the browser harness
//       via evaluateOnNewDocument BEFORE page scripts run
// In all other cases (normal /game session) the timing bookkeeping still runs
// (cheap performance.now() deltas) but the scene-count traversals are skipped
// and window.__CV_VRM_LOAD_METRICS is not written.
export const VRM_METRICS_ENABLED: boolean = (() => {
  if (typeof window === 'undefined') return false;
  if ((window as unknown as Record<string, unknown>).__CV_PERF_HARNESS__ === true) return true;
  try {
    return new URLSearchParams(location.search).get('perf') === '1';
  } catch {
    return false;
  }
})();

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
  queueWaitMs: number;
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

type MaterialTextureSlotVisitor = (
  texture: THREE.Texture,
  replace: (texture: THREE.Texture) => boolean,
) => void;

/**
 * Enumerate the texture slots used by both ordinary Three.js materials and
 * MToon. MToon extends ShaderMaterial and stores its texture accessors in
 * `uniforms.*.value`, so direct Object.entries(material) alone cannot see
 * them with the installed three-vrm version.
 */
function forEachMaterialTextureSlot(
  material: THREE.Material,
  visit: MaterialTextureSlotVisitor,
): void {
  const properties = material as unknown as Record<string, unknown>;
  for (const [property, value] of Object.entries(properties)) {
    if (!(value instanceof THREE.Texture)) continue;
    visit(value, (replacement) => {
      try {
        properties[property] = replacement;
        return true;
      } catch {
        return false;
      }
    });
  }

  const shaderMaterial = material as THREE.ShaderMaterial;
  if (!shaderMaterial.isShaderMaterial) return;
  for (const uniformValue of Object.values(shaderMaterial.uniforms)) {
    const uniform = uniformValue as { value?: unknown };
    if (!(uniform.value instanceof THREE.Texture)) continue;
    visit(uniform.value, (replacement) => {
      try {
        uniform.value = replacement;
        return true;
      } catch {
        return false;
      }
    });
  }
}

/**
 * Replace this instance's associated glTF textures with the per-path
 * canonical objects. Association misses deliberately fail open: those
 * textures remain private to the instance and are disposed with its scene.
 *
 * This whole traversal is synchronous. Even when multiple parses finish in
 * adjacent microtasks, the first traversal registers each key atomically and
 * the next traversal observes it, disposes its never-uploaded duplicate, and
 * increments the existing entry exactly once for this instance.
 */
function canonicaliseVRMTextures(
  root: THREE.Object3D,
  path: string,
  associations: ReadonlyMap<THREE.Object3D | THREE.Material | THREE.Texture, { textures?: number }>,
): Set<string> {
  const instanceKeys = new Set<string>();
  const disposedDuplicates = new Set<THREE.Texture>();
  const visitedMaterials = new Set<THREE.Material>();
  const replacements: Array<{
    replace: (texture: THREE.Texture) => boolean;
    original: THREE.Texture;
  }> = [];
  const acquisitions: Array<{
    key: string;
    canonical: CanonicalTextureEntry;
    created: boolean;
  }> = [];

  try {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.material) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      for (const material of materials) {
        if (!material || visitedMaterials.has(material)) continue;
        visitedMaterials.add(material);
        forEachMaterialTextureSlot(material, (value, replace) => {
          const textureIndex = associations.get(value)?.textures;
          if (
            textureIndex === undefined
            || !Number.isInteger(textureIndex)
            || textureIndex < 0
          ) return;

          const key = `${path}#tx${textureIndex}`;
          let canonical = VRM_CANONICAL_TEXTURES.get(key);

          if (!canonical) {
            canonical = { tex: value, refs: 1 };
            VRM_CANONICAL_TEXTURES.set(key, canonical);
            instanceKeys.add(key);
            acquisitions.push({ key, canonical, created: true });
            return;
          }

          // A non-writable custom material slot cannot safely be shared. Leave
          // it private and fail open rather than corrupting ownership.
          if (value !== canonical.tex) {
            if (!replace(canonical.tex)) return;
            replacements.push({ replace, original: value });
          }
          if (!instanceKeys.has(key)) {
            canonical.refs++;
            instanceKeys.add(key);
            acquisitions.push({ key, canonical, created: false });
          }
          if (value !== canonical.tex) disposedDuplicates.add(value);
        });
      }
    });
  } catch (error) {
    // Duplicate disposal is deliberately deferred until after the traversal,
    // so rollback can restore every original slot without reviving a disposed
    // texture. Restore in reverse order, then unwind each per-instance ref.
    for (let i = replacements.length - 1; i >= 0; i--) {
      const replacement = replacements[i];
      replacement.replace(replacement.original);
    }
    for (let i = acquisitions.length - 1; i >= 0; i--) {
      const acquisition = acquisitions[i];
      if (acquisition.created) {
        if (VRM_CANONICAL_TEXTURES.get(acquisition.key) === acquisition.canonical) {
          VRM_CANONICAL_TEXTURES.delete(acquisition.key);
        }
      } else {
        acquisition.canonical.refs--;
      }
    }
    throw error;
  }

  // Fresh duplicates have not reached the renderer, so they normally have no
  // dispose listeners. Keep the now-committed acquisition non-throwing even if
  // a loader plugin attached an unexpected listener.
  for (const texture of disposedDuplicates) {
    try { texture.dispose(); } catch { /* best-effort duplicate cleanup */ }
  }

  return instanceKeys;
}

/**
 * Dispose a VRM scene without touching canonical textures still owned by the
 * cross-instance cache. Geometry, materials, and private textures are each
 * disposed at most once even when shared by several meshes or slots.
 */
function disposeVRMSceneSharedAware(
  scene: THREE.Object3D,
  sharedTextures: ReadonlySet<THREE.Texture>,
): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const skeletons = new Set<THREE.Skeleton>();
  const materials = new Set<THREE.Material>();
  const privateTextures = new Set<THREE.Texture>();

  scene.traverse((obj) => {
    const renderable = obj as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      skeleton?: THREE.Skeleton;
      material?: THREE.Material | THREE.Material[];
    };
    if (renderable.geometry) geometries.add(renderable.geometry);
    if (renderable.skeleton) skeletons.add(renderable.skeleton);
    if (!renderable.material) return;

    const materialList = Array.isArray(renderable.material)
      ? renderable.material
      : [renderable.material];
    for (const material of materialList) {
      if (!material || materials.has(material)) continue;
      materials.add(material);
      forEachMaterialTextureSlot(material, (value) => {
        if (!sharedTextures.has(value)) {
          privateTextures.add(value);
        }
      });
    }
  });

  for (const texture of privateTextures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}

function disposeResolvedVRMInstance(
  entry: Extract<InstanceEntry, { status: 'resolved' }>,
): void {
  const sharedTextures = new Set<THREE.Texture>();
  for (const key of entry.sharedTextureKeys) {
    const canonical = VRM_CANONICAL_TEXTURES.get(key);
    if (canonical) sharedTextures.add(canonical.tex);
  }

  try {
    disposeVRMSceneSharedAware(entry.vrm.scene, sharedTextures);
  } finally {
    // Each key was acquired once by canonicaliseVRMTextures, so release each
    // once regardless of material-slot multiplicity or disposal exceptions.
    for (const key of entry.sharedTextureKeys) {
      const canonical = VRM_CANONICAL_TEXTURES.get(key);
      if (!canonical) continue;
      canonical.refs--;
      if (canonical.refs <= 0) {
        VRM_CANONICAL_TEXTURES.delete(key);
        canonical.tex.dispose();
      }
    }
  }
}

function pushVRMLoadMetric(metric: VRMLoadMetric): void {
  if (typeof window === 'undefined') return;
  const bridge = window as unknown as { __CV_VRM_LOAD_METRICS?: VRMLoadMetric[] };
  const metrics = bridge.__CV_VRM_LOAD_METRICS ?? [];
  metrics.push(metric);
  bridge.__CV_VRM_LOAD_METRICS = metrics.slice(-200);
}

function scheduleNextVRMParse(): void {
  const run = () => pumpVRMParseQueue();
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 100 });
  } else {
    setTimeout(run, 0);
  }
}

function pumpVRMParseQueue(): void {
  while (vrmParseActive < getVRMParseConcurrency() && VRM_PARSE_QUEUE.length > 0) {
    const next = VRM_PARSE_QUEUE.shift();
    if (next) next();
  }
  // Fire the bulk-idle callback once the queue fully drains (perf round-3 change A).
  // _bulkBatchStarted guard: only fire after at least one parse task has been
  // enqueued. This prevents a false drain-fire on the first pump() call when the
  // queue is still empty because no VRM fetch has resolved yet.
  if (_bulkBatchStarted && vrmParseActive === 0 && VRM_PARSE_QUEUE.length === 0) {
    _fireBulkIdleCb();
  }
}

type EnqueueOptions = { priority?: boolean; cacheKey?: string; gen?: number };

function enqueueVRMParse<T>(task: () => Promise<T>, opts?: EnqueueOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cacheKey = opts?.cacheKey;
    const gen = opts?.gen;
    const runner = () => {
      // Generation-based cancellation check: if the generation recorded at
      // enqueue time no longer matches the current generation for this cacheKey,
      // this task is stale (disposeVRMInstance incremented the counter while
      // this task was queued). Reject without parsing — the identity-guarded
      // catch in useVRMInstance/loadVRMInstance will skip the 'rejected' write
      // because the entry was deleted (or replaced) by disposeVRMInstance.
      // Do NOT increment vrmParseActive — we skipped the actual parse work.
      if (cacheKey !== undefined && gen !== undefined && VRM_LOAD_GEN.get(cacheKey) !== gen) {
        reject(new Error(`[vrm-loader] parse cancelled (stale gen) for ${cacheKey}`));
        // Pump the queue so the next task starts without waiting for an idle cb.
        scheduleNextVRMParse();
        return;
      }
      vrmParseActive++;
      task().then(resolve, reject).finally(() => {
        vrmParseActive--;
        scheduleNextVRMParse();
      });
    };
    // Mark that the bulk batch has started (perf round-3 change A).
    // Flip the flag before the push so _fireBulkIdleCb drain checks can
    // distinguish "queue empty because nothing ever loaded" from "queue empty
    // because the batch finished".
    _bulkBatchStarted = true;
    if (opts?.priority) {
      VRM_PARSE_QUEUE.unshift(runner);
    } else {
      VRM_PARSE_QUEUE.push(runner);
    }
    pumpVRMParseQueue();
  });
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

const _EMPTY_SCENE_COUNTS: VRMSceneCounts = { objects: 0, meshes: 0, skinnedMeshes: 0, geometries: 0, materials: 0, textures: 0 };

async function loadInstance(cacheKey: string, path: string, gen: number): Promise<VRM> {
  const totalStart = nowMs();
  const buffer = await fetchBytes(path);
  const fetchDone = nowMs();
  const queuedAt = nowMs();

  // Determine if this is the player avatar for priority scheduling.
  const instanceId = cacheKey.slice(path.length + 1);
  const isPlayer = instanceId === PLAYER_INSTANCE_ID;

  const parsed = await enqueueVRMParse(async () => {
    const queueStart = nowMs();
    // .slice(0) gives the parser its own copy of the bytes. GLTFLoader doesn't
    // mutate the input, but the defensive copy guards against any future change
    // in three's parser semantics that could corrupt subsequent parses.
    const ownBuffer = buffer.slice(0);
    const sliceDone = nowMs();
    const gltf = await getLoader().parseAsync(ownBuffer, '');
    const parseDone = nowMs();
    const vrm: VRM | undefined = (gltf as unknown as { userData: { vrm?: VRM } }).userData.vrm;
    if (!vrm) throw new Error(`[vrm-loader] No VRM data in ${path}`);
    // Gate scene-count traversals behind the metrics flag to avoid double
    // full-tree traversal on every production VRM load.
    const sceneBefore = VRM_METRICS_ENABLED ? collectVRMSceneCounts(vrm.scene) : _EMPTY_SCENE_COUNTS;
    const normalise = normaliseVRM(vrm);
    const normaliseDone = nowMs();
    const sceneAfter = VRM_METRICS_ENABLED ? collectVRMSceneCounts(vrm.scene) : _EMPTY_SCENE_COUNTS;
    return {
      vrm,
      associations: gltf.parser.associations,
      queueStart,
      sliceDone,
      parseDone,
      normaliseDone,
      sceneBefore,
      sceneAfter,
      normalise,
    };
  }, { priority: isPlayer, cacheKey, gen });

  // Post-parse generation / stale-entry guard.
  //
  // These guards deliberately run BEFORE canonical texture registration. A
  // stale parse therefore owns only private textures and can be disposed with
  // an empty shared set; it never acquires refs that would need rolling back.
  // Two cases require disposing the parsed VRM without writing 'resolved':
  //
  //   (A) Generation mismatch: disposeVRMInstance was called while parseAsync
  //       was in flight (race window up to ~19s on Iris Xe), incrementing the
  //       generation counter for this cacheKey. Our `gen` no longer matches
  //       VRM_LOAD_GEN.get(cacheKey). The entry was deleted from VRM_INSTANCES
  //       by disposeVRMInstance; writing 'resolved' here would resurrect an
  //       orphaned VRM that will never be disposed.
  //
  //   (B) Entry mismatch (re-mount during parse): disposeVRMInstance was called
  //       AND useVRMInstance re-mounted the same (path, instanceId) before this
  //       parse finished. The new load incremented the generation again and
  //       created a fresh pending entry. The generation check already catches
  //       this; the currentEntry.status !== 'pending' check below is a further
  //       defensive guard for any edge case where generation matches but the
  //       entry was settled by another path.
  //
  // Only write 'resolved' when our generation still matches AND the entry is
  // still 'pending'. The identity-guarded catch in callers (useVRMInstance and
  // loadVRMInstance) ensures that the throw below does NOT clobber the new
  // pending entry — the catch only writes 'rejected' when cur.promise === promise.
  if (VRM_LOAD_GEN.get(cacheKey) !== gen) {
    try { disposeVRMSceneSharedAware(parsed.vrm.scene, new Set()); } catch { /* ignore */ }
    // Throw so the caller's catch fires. The identity-guarded catch skips the
    // 'rejected' write because the entry was deleted or replaced; this is safe.
    throw new Error(`[vrm-loader] parse completed after dispose (stale gen) for ${cacheKey}`);
  }

  // Defensive: entry must still be pending (not already settled by another path).
  const currentEntry = VRM_INSTANCES.get(cacheKey);
  if (!currentEntry || currentEntry.status !== 'pending') {
    try { disposeVRMSceneSharedAware(parsed.vrm.scene, new Set()); } catch { /* ignore */ }
    throw new Error(`[vrm-loader] entry gone or already settled for ${cacheKey}`);
  }

  if (VRM_METRICS_ENABLED) {
    pushVRMLoadMetric({
      path,
      instanceId,
      bytes: buffer.byteLength,
      fetchWaitMs: roundMs(fetchDone - totalStart),
      queueWaitMs: roundMs(parsed.queueStart - queuedAt),
      sliceMs: roundMs(parsed.sliceDone - parsed.queueStart),
      parseMs: roundMs(parsed.parseDone - parsed.sliceDone),
      normaliseMs: roundMs(parsed.normaliseDone - parsed.parseDone),
      totalMs: roundMs(parsed.normaliseDone - totalStart),
      sceneBefore: parsed.sceneBefore,
      sceneAfter: parsed.sceneAfter,
      normalise: parsed.normalise,
    });
  }

  // No await may occur between registration and storing the resolved entry:
  // the acquired key set must become reachable by disposal atomically.
  let sharedTextureKeys: Set<string>;
  try {
    sharedTextureKeys = canonicaliseVRMTextures(
      parsed.vrm.scene,
      path,
      parsed.associations,
    );
  } catch (error) {
    // canonicaliseVRMTextures rolls back slot swaps and refs before throwing,
    // so the parsed scene is private again and can use the empty shared set.
    try { disposeVRMSceneSharedAware(parsed.vrm.scene, new Set()); } catch { /* ignore */ }
    throw error;
  }
  VRM_INSTANCES.set(cacheKey, {
    status: 'resolved',
    vrm: parsed.vrm,
    sharedTextureKeys,
  });
  return parsed.vrm;
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
  // Render-time re-acquire EXTENDS any scheduled dispose (never cancels —
  // React can abandon a render before its effects commit; the authoritative
  // cancel is retainVRMInstance() in the consumer's committed effect setup).
  extendPendingDispose(cacheKey);
  const entry = VRM_INSTANCES.get(cacheKey);

  if (!entry) {
    // Assign and record the generation BEFORE creating the pending entry so
    // that the entry identity check in the catch can reference `pendingEntry`.
    const gen = (VRM_LOAD_GEN.get(cacheKey) ?? 0) + 1;
    VRM_LOAD_GEN.set(cacheKey, gen);
    // Create the pending entry first so we can use its identity in the catch.
    const pendingEntry: Extract<InstanceEntry, { status: 'pending' }> = {
      status: 'pending',
      // promise is assigned below; TypeScript needs the field to exist.
      promise: null as unknown as Promise<VRM>,
    };
    const promise = loadInstance(cacheKey, path, gen).catch((err) => {
      // Identity guard: only write 'rejected' if this load still owns the
      // entry. A stale catch (cancelled or clobbered by re-mount) must NOT
      // re-insert or overwrite the new pending entry.
      if (VRM_INSTANCES.get(cacheKey) === pendingEntry) {
        VRM_INSTANCES.set(cacheKey, { status: 'rejected', error: err });
      }
      throw err;
    });
    pendingEntry.promise = promise;
    VRM_INSTANCES.set(cacheKey, pendingEntry);
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
  // Re-acquire cancels any scheduled dispose — see useVRMInstance.
  cancelPendingDispose(cacheKey);
  const entry = VRM_INSTANCES.get(cacheKey);
  if (entry) {
    if (entry.status === 'resolved') return Promise.resolve(entry.vrm);
    if (entry.status === 'rejected') return Promise.reject(entry.error);
    return entry.promise;
  }
  // Assign and record the generation BEFORE creating the pending entry so
  // that the entry identity check in the catch can reference `pendingEntry`.
  const gen = (VRM_LOAD_GEN.get(cacheKey) ?? 0) + 1;
  VRM_LOAD_GEN.set(cacheKey, gen);
  // Create the pending entry first so we can use its identity in the catch.
  const pendingEntry: Extract<InstanceEntry, { status: 'pending' }> = {
    status: 'pending',
    // promise is assigned below; TypeScript needs the field to exist.
    promise: null as unknown as Promise<VRM>,
  };
  const promise = loadInstance(cacheKey, path, gen).catch((err) => {
    // Identity guard: only write 'rejected' if this load still owns the
    // entry. A stale catch (cancelled or clobbered by re-mount) must NOT
    // re-insert or overwrite the new pending entry.
    if (VRM_INSTANCES.get(cacheKey) === pendingEntry) {
      VRM_INSTANCES.set(cacheKey, { status: 'rejected', error: err });
    }
    throw err;
  });
  pendingEntry.promise = promise;
  VRM_INSTANCES.set(cacheKey, pendingEntry);
  return promise;
}

/**
 * Dispose a specific VRM instance. Call from useEffect cleanup on unmount.
 *
 * Disposes the VRM's scene meshes/materials/geometries and private textures,
 * then evicts the cache entry. Cached BYTES are kept — the next instance for
 * the same path can parse without re-fetching.
 *
 * Safe to call with an unknown (path, instanceId) — silently no-ops if the
 * instance was never created or already disposed.
 */
export function disposeVRMInstance(path: string, instanceId: string): void {
  const cacheKey = `${path}#${instanceId}`;
  if (!VRM_INSTANCES.has(cacheKey)) return;
  // DEFERRED (2026-07-14): never destroy buffers synchronously — a StrictMode
  // simulated unmount calls this while the scene is still committed to the R3F
  // graph (see VRM_PENDING_DISPOSES doc). Schedule the real teardown; a
  // re-acquire of the same key within the grace window cancels (effect) or
  // extends (render) it.
  if (VRM_PENDING_DISPOSES.has(cacheKey)) return; // already scheduled
  VRM_PENDING_DISPOSES.set(
    cacheKey,
    setTimeout(() => executePendingDispose(cacheKey), VRM_DISPOSE_GRACE_MS),
  );
}

/** The actual teardown a deferred dispose runs when its grace timer fires. */
function executePendingDispose(cacheKey: string): void {
  VRM_PENDING_DISPOSES.delete(cacheKey);
  const entry = VRM_INSTANCES.get(cacheKey);
  if (!entry) return;
  if (entry.status === 'resolved') {
    // Evict first so a synchronous dispose-event listener cannot re-enter this
    // function and release the same instance's canonical refs twice.
    VRM_INSTANCES.delete(cacheKey);
    try {
      disposeResolvedVRMInstance(entry);
    } catch {
      // Scene disposal can throw on partially-loaded scenes; ref release runs
      // in a finally block and the cache entry is still always evicted.
    }
    return;
  } else if (entry.status === 'pending') {
    // Increment the generation counter for this cacheKey. This "invalidates"
    // the in-flight or queued parse task — the runner's generation check
    // (VRM_LOAD_GEN.get(cacheKey) !== gen) will reject it without parsing,
    // and loadInstance's post-parse guard will dispose any result that
    // slipped through. The increment is idempotent under double-dispose.
    //
    // A re-mount of the same (path, instanceId) BEFORE the queued parse runs
    // will record a NEW generation, and the new task's gen will again match
    // the current counter — the stale task's gen will still be lower.
    VRM_LOAD_GEN.set(cacheKey, (VRM_LOAD_GEN.get(cacheKey) ?? 0) + 1);
    // Entry is evicted now. The pending promise will reject (stale-gen error),
    // which is harmless — the consumer component has already unmounted, and
    // the identity-guarded catch in useVRMInstance/loadVRMInstance will NOT
    // write 'rejected' because the entry no longer exists.
  }
  VRM_INSTANCES.delete(cacheKey);
}

/**
 * Cancel a scheduled dispose for (path, instanceId) — call in the SETUP of
 * the same effect whose cleanup calls disposeVRMInstance:
 *
 *   useEffect(() => {
 *     retainVRMInstance(path, id);
 *     return () => disposeVRMInstance(path, id);
 *   }, [path, id]);
 *
 * WHY the render-time cancel in useVRMInstance isn't enough: React StrictMode
 * re-invokes EFFECTS (setup → cleanup → setup) without a re-render, and many
 * consumers (NPCs driven via refs in useFrame) don't re-render for long
 * stretches — so the scheduled dispose from the simulated unmount fired
 * against a still-mounted scene 500ms later ("buffer used in submit while
 * destroyed", animator double-patch churn). Effect-setup retain closes that
 * hole: simulated unmount schedules, the immediate re-setup cancels; a real
 * unmount schedules with no re-setup, so the timer fires and disposes.
 */
export function retainVRMInstance(path: string, instanceId: string): void {
  cancelPendingDispose(`${path}#${instanceId}`);
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

/**
 * Debug introspection for the cross-instance texture cache (CDP probes,
 * `window.__CV_VRM_TEX_STATS()`). refs > 1 on any key is live proof that two
 * VRM instances of the same path share one GPU texture.
 */
function _vrmTexCacheStats(): { canonicalCount: number; sharedKeys: number; refsByKey: Record<string, number> } {
  const refsByKey: Record<string, number> = {};
  let sharedKeys = 0;
  for (const [key, entry] of VRM_CANONICAL_TEXTURES) {
    refsByKey[key] = entry.refs;
    if (entry.refs > 1) sharedKeys++;
  }
  return { canonicalCount: VRM_CANONICAL_TEXTURES.size, sharedKeys, refsByKey };
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__CV_VRM_TEX_STATS = _vrmTexCacheStats;
}

/** Test helper: clear all caches. Internal, not for production code. */
export function _vrmClearAllCaches(): void {
  for (const [, timer] of VRM_PENDING_DISPOSES) clearTimeout(timer);
  VRM_PENDING_DISPOSES.clear();
  const entries = [...VRM_INSTANCES.entries()];
  for (const [cacheKey, entry] of entries) {
    if (entry.status === 'pending') {
      // Invalidate queued/in-flight parses before clearing their entries. A
      // parse that finishes later hits the pre-dedupe stale guard, disposes
      // only its private scene, and cannot repopulate either cache.
      VRM_LOAD_GEN.set(cacheKey, (VRM_LOAD_GEN.get(cacheKey) ?? 0) + 1);
    }
  }
  // Evict before disposal to make texture/material dispose-event re-entry a
  // no-op rather than a second release of the same instance keys.
  VRM_INSTANCES.clear();
  VRM_BYTES.clear();

  for (const [, entry] of entries) {
    if (entry.status === 'resolved') {
      try { disposeResolvedVRMInstance(entry); } catch { /* ignore */ }
    }
  }

  // Accurate refcounts empty the map during the resolved-entry loop. Dispose
  // any defensive residue before clearing so debug/test resets cannot leak a
  // canonical texture after a partially-loaded or externally-mutated scene.
  for (const [, canonical] of VRM_CANONICAL_TEXTURES) canonical.tex.dispose();
  VRM_CANONICAL_TEXTURES.clear();
}
