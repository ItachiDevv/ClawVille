/**
 * sea-creature-animator.ts
 *
 * Drives rigged (non-humanoid) sea-creature GLBs with baked AnimationClips.
 * Parallel to vrm-character-animator.ts but NO Mixamo retargeting — clips are
 * already authored on the target skeleton, so they load directly.
 *
 * Asset layout (when hasRig=true in SEA_CREATURE_MANIFEST):
 *   /models/sea-creatures/<species>/base.glb        — rigged mesh (no clips)
 *   /models/sea-creatures/<species>/animations/<state>.glb  — one clip each
 *
 * When hasRig=false (manifest default), createSeaCreatureAnimator() returns null
 * and the caller falls back to the existing static-mesh path — zero regression.
 *
 * GPU / Iris Xe constraints honoured:
 *   - No InstancedMesh + ShaderMaterial
 *   - No drei Text / Billboard
 *   - No per-frame allocations — all scratch lives in the handle
 *   - frustumCulled=false on every node after SkeletonUtils.clone()
 *   - Module-scope GLB cache (load-once per URL)
 *   - MeshoptDecoder wired into GLTFLoader (Meshy/Tripo output)
 *
 * Animation states:
 *   Loop   — idle, swim, boost    (LoopRepeat)
 *   One-shot — hit, victory, wipeout  (LoopOnce + clampWhenFinished)
 *   `hit` auto-reverts to prior looping state via mixer 'finished' listener.
 *
 * Crossfade default: 200 ms. crossFadeTo + reset().fadeIn().play() pattern
 * (memory: vrm-crossfade-must-play — crossFadeTo schedules weights only).
 */

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
// meshoptimizer's decoder object satisfies three's strict setMeshoptDecoder
// signature; three-stdlib's callable does not — same rationale as vrm-loader.ts.
import { MeshoptDecoder } from 'meshoptimizer';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  type SeaCreatureSpecies,
  type SeaCreatureAnimState,
} from './sea-creature-types';
import { SEA_CREATURE_MANIFEST } from './sea-creature-manifest';
import { getKTX2Loader } from './ktx2-loader-setup';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CROSSFADE_DEFAULT_MS = 200;

/** States that loop forever. */
const LOOP_STATES = new Set<SeaCreatureAnimState>(['idle', 'swim', 'boost']);

/** States that play once and clamp on the last frame. */
const ONE_SHOT_STATES = new Set<SeaCreatureAnimState>(['hit', 'victory', 'wipeout']);

// ---------------------------------------------------------------------------
// Module-scope GLB cache
// Keyed by URL string. Stores the resolved GLTF or the in-flight Promise.
// ---------------------------------------------------------------------------

type GltfCacheEntry =
  | { status: 'pending';  promise: Promise<GLTF> }
  | { status: 'resolved'; gltf:    GLTF }
  | { status: 'rejected'; error:   unknown };

const GLB_CACHE = new Map<string, GltfCacheEntry>();

/** Lazily-created, module-scoped loader so we don't construct one per call. */
let _loader: GLTFLoader | null = null;

function getLoader(): GLTFLoader {
  if (!_loader) {
    _loader = new GLTFLoader();
    // Meshy/Tripo GLB exports are typically meshopt-compressed.
    _loader.setMeshoptDecoder(MeshoptDecoder);
  }
  const ktx2 = getKTX2Loader();
  if (ktx2) _loader.setKTX2Loader(ktx2);
  return _loader;
}

/**
 * Load a GLB (with module-scope cache).
 * Errors propagate — callers must catch and treat as "no rig".
 */
function loadGlb(url: string): Promise<GLTF> {
  const cached = GLB_CACHE.get(url);
  if (cached) {
    if (cached.status === 'resolved') return Promise.resolve(cached.gltf);
    if (cached.status === 'rejected') return Promise.reject(cached.error);
    return cached.promise;
  }

  const promise = getLoader()
    .loadAsync(url)
    .then((gltf: GLTF) => {
      GLB_CACHE.set(url, { status: 'resolved', gltf });
      return gltf;
    })
    .catch((err: unknown) => {
      GLB_CACHE.set(url, { status: 'rejected', error: err });
      throw err;
    });

  GLB_CACHE.set(url, { status: 'pending', promise });
  return promise;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Per-instance handle returned by createSeaCreatureAnimator. Owns:
 *   - the cloned rigged scene (caller adds to its own group, e.g. riderMountRef)
 *   - the AnimationMixer
 *   - the currently-playing AnimationAction
 * Caller is responsible for advancing the mixer with `tick(dt)` each frame
 * and disposing via `dispose()` on unmount.
 */
export interface SeaCreatureAnimatorHandle {
  /** Cloned scene root — caller adds to its own group (e.g. riderMountRef). */
  scene: THREE.Object3D;
  /** Switch to a new state with optional crossfade (default 200ms). */
  setState: (next: SeaCreatureAnimState, fadeMs?: number) => void;
  /** Currently-active state (last successful setState target). */
  getState: () => SeaCreatureAnimState;
  /** Advance the AnimationMixer. Caller invokes from useFrame. */
  tick: (dtSeconds: number) => void;
  /** Detach scene + dispose mixer. Idempotent. */
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Async factory. Returns null when:
 *   - The species has hasRig=false in the manifest (no rigged GLB exists)
 *   - The base GLB fetch fails (404, network error)
 * Caller MUST handle null by falling back to the existing static-mesh path.
 *
 * On success the handle is returned with the scene cloned and the initial
 * state's clip already playing. If the requested initialState clip doesn't
 * exist, falls through swim → idle → first-available → bind-pose no-clip.
 */
export async function createSeaCreatureAnimator(
  species: SeaCreatureSpecies,
  initialState: SeaCreatureAnimState,
): Promise<SeaCreatureAnimatorHandle | null> {
  const manifest = SEA_CREATURE_MANIFEST[species];

  // Fast-path: manifest says no rig — skip the network entirely.
  if (!manifest.hasRig) return null;

  const baseUrl = species === 'lobster'
    ? '/models/sea-creatures/lobster/base-mo-ktx.glb'
    : `/models/sea-creatures/${species}/base.glb`;

  // Load base mesh. Any error → fall back to static mesh.
  let baseGltf: GLTF;
  try {
    baseGltf = await loadGlb(baseUrl);
  } catch (err) {
    console.warn(`[sea-creature-animator] base GLB missing for ${species}:`, err);
    return null;
  }

  // Clone skeleton so multiple players don't share a single skeleton (pose corruption).
  // SkeletonUtils.clone deep-clones SkinnedMeshes + skeleton independently.
  const scene = skeletonClone(baseGltf.scene);

  // CRITICAL: frustumCulled=false on every node after clone.
  // SkinnedMesh bounding spheres are computed in bind pose (T-pose) and don't
  // track animated geometry — Three.js culls the mesh at close angles.
  // Pattern established in vrm-loader.ts and ReefRacePlayer.tsx.
  scene.traverse((obj: THREE.Object3D) => {
    obj.frustumCulled = false;
  });

  // AnimationMixer rooted at the cloned scene.
  const mixer = new THREE.AnimationMixer(scene);

  // Map<state, AnimationAction> — populated as clips load.
  // clipAction() caches per (clip, root) internally; we cache only the action refs
  // here so setState() reuses them with zero allocations after first call.
  const actionCache = new Map<SeaCreatureAnimState, THREE.AnimationAction>();

  // Load animation clips for every available state in parallel.
  // Missing clips (404, parse error) are silently skipped — the fallback
  // priority logic below picks a substitute.
  const clipLoadPromises: Promise<void>[] = [];
  for (const state of manifest.availableStates) {
    const url = species === 'lobster'
      ? `/models/sea-creatures/lobster/animations/${state}-clip-ktx.glb`
      : `/models/sea-creatures/${species}/animations/${state}.glb`;
    const p = loadGlb(url)
      .then((gltf) => {
        if (!gltf.animations.length) {
          console.warn(`[sea-creature-animator] no clips in ${url}`);
          return;
        }
        // Take the first clip and rename it to the state for clarity.
        const clip = gltf.animations[0]!.clone();
        clip.name = state;

        const action = mixer.clipAction(clip);

        if (LOOP_STATES.has(state)) {
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.clampWhenFinished = false;
        } else {
          // ONE_SHOT_STATES: hit, victory, wipeout
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        }

        actionCache.set(state, action);
      })
      .catch((err) => {
        // Per the brief: missing clip GLBs are silently skipped.
        console.warn(`[sea-creature-animator] clip load failed for ${species}/${state}:`, err);
      });
    clipLoadPromises.push(p);
  }

  await Promise.all(clipLoadPromises);

  // ---------------------------------------------------------------------------
  // State machine
  // ---------------------------------------------------------------------------

  // Resolve which actual state to start playing given what loaded.
  // Priority: requested → swim → idle → first available → bind pose.
  function resolveState(requested: SeaCreatureAnimState): SeaCreatureAnimState | null {
    if (actionCache.has(requested)) return requested;
    if (actionCache.has('swim')) return 'swim';
    if (actionCache.has('idle')) return 'idle';
    const first = actionCache.keys().next();
    return first.done ? null : first.value;
  }

  let currentState: SeaCreatureAnimState = initialState;
  let currentAction: THREE.AnimationAction | null = null;

  // Track last looping state so `hit` can revert after playing.
  let lastLoopingState: SeaCreatureAnimState = 'idle';

  function playAction(
    targetState: SeaCreatureAnimState,
    fadeMs: number,
  ): void {
    const action = actionCache.get(targetState);
    if (!action) return; // bind pose — tick is still called, mixer is a no-op

    const fadeSec = fadeMs / 1000;

    if (currentAction && currentAction !== action) {
      currentAction.crossFadeTo(action, fadeSec, false);
      // crossFadeTo schedules weights only — MUST call play() on incoming action.
      // Memory: vrm-crossfade-must-play.md — without this the action stays frozen.
      action.reset().fadeIn(fadeSec).play();
    } else if (!currentAction) {
      action.reset().fadeIn(fadeSec).play();
    }
    // If currentAction === action, it's already playing — no-op.

    currentAction = action;
    currentState = targetState;

    if (LOOP_STATES.has(targetState)) {
      lastLoopingState = targetState;
    }
  }

  // Auto-revert for `hit` one-shot: when the mixer fires 'finished' for the
  // hit action, cross-fade back to the last looping state.
  mixer.addEventListener('finished', (e: THREE.Event) => {
    const finishedAction = (e as unknown as { action: THREE.AnimationAction }).action;
    if (finishedAction === actionCache.get('hit') && currentState === 'hit') {
      const revertTo = resolveState(lastLoopingState) ?? resolveState('idle');
      if (revertTo) {
        playAction(revertTo, CROSSFADE_DEFAULT_MS);
      }
    }
  });

  // Kick off initial state.
  const startState = resolveState(initialState);
  if (startState) {
    // For the very first action, no outgoing to fade from — just play.
    const firstAction = actionCache.get(startState)!;
    firstAction.reset().play();
    currentAction = firstAction;
    currentState = startState;
    if (LOOP_STATES.has(startState)) {
      lastLoopingState = startState;
    }
  }

  // ---------------------------------------------------------------------------
  // Handle implementation
  // ---------------------------------------------------------------------------

  let disposed = false;

  const handle: SeaCreatureAnimatorHandle = {
    scene,

    setState(next: SeaCreatureAnimState, fadeMs = CROSSFADE_DEFAULT_MS): void {
      if (disposed) return;
      const resolved = resolveState(next);
      if (!resolved) return; // bind pose — no clips at all
      playAction(resolved, fadeMs);
    },

    getState(): SeaCreatureAnimState {
      return currentState;
    },

    tick(dtSeconds: number): void {
      if (disposed) return;
      // When no clips loaded (bind pose path), mixer.update is a no-op — safe.
      mixer.update(dtSeconds);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
      // Drop strong refs so GC can collect the scene + clips.
      actionCache.clear();
      currentAction = null;
      // scene removal from its parent is the caller's responsibility.
    },
  };

  return handle;
}
