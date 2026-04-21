/**
 * vrm-character-animator.ts
 *
 * Drives VRM avatars with Mixamo-sourced animations retargeted to each VRM's
 * humanoid skeleton at runtime.
 *
 * Design:
 *   - 3 Mixamo GLBs (idle/walk/run) are loaded ONCE at module level and cached.
 *   - For each VRM instance, retargetMixamoClip() rewrites track names to
 *     target that VRM's specific bone nodes.
 *   - Each VRM gets its own AnimationMixer + 3 retargeted clips.
 *   - idle ↔ walk crossfade via mixer.crossFadeTo() when isMoving changes.
 *
 * Performance:
 *   - Animation data (Float32Arrays) is shared between VRMs — retargetion only
 *     rewrites track.name strings, not the keyframe data itself.
 *   - No per-frame allocations — all scratch objects are class-scoped.
 *   - On Iris Xe budget ~0.3ms per VRM per frame for mixer.update + vrm.update.
 *
 * GPU constraints: no InstancedMesh, no ShaderMaterial, no drei Text/Billboard.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { VRM } from '@pixiv/three-vrm';
import { retargetMixamoClip } from './mixamo-retarget';

// ---------------------------------------------------------------------------
// Mixamo animation asset paths
// ---------------------------------------------------------------------------

const ANIM_PATHS = {
  idle: '/avatars/animations/idle.glb',
  walk: '/avatars/animations/walk.glb',
  run:  '/avatars/animations/run.glb',
} as const;

type AnimName = keyof typeof ANIM_PATHS;

// ---------------------------------------------------------------------------
// Module-level raw clip cache
// Each Mixamo GLB is loaded once; clips are shared across all VRM instances.
// Retargeting creates per-VRM copies (name strings only, not data).
// ---------------------------------------------------------------------------

type RawClipEntry =
  | { status: 'pending';  promise: Promise<THREE.AnimationClip> }
  | { status: 'resolved'; clip: THREE.AnimationClip }
  | { status: 'rejected'; error: unknown };

const RAW_CLIP_CACHE = new Map<AnimName, RawClipEntry>();

// Separate loader for anim GLBs — no VRMLoaderPlugin needed
let _animLoader: GLTFLoader | null = null;
function getAnimLoader(): GLTFLoader {
  if (_animLoader) return _animLoader;
  _animLoader = new GLTFLoader();
  return _animLoader;
}

/**
 * Load a raw Mixamo clip from a GLB. Returns the first AnimationClip found.
 * Promise is cached at module level — each path loads only once.
 */
function loadRawClip(name: AnimName): Promise<THREE.AnimationClip> {
  const cached = RAW_CLIP_CACHE.get(name);
  if (cached) {
    if (cached.status === 'resolved') return Promise.resolve(cached.clip);
    if (cached.status === 'rejected') return Promise.reject(cached.error);
    return cached.promise;
  }

  const path = ANIM_PATHS[name];
  const promise = getAnimLoader()
    .loadAsync(path)
    .then((gltf) => {
      const clip = gltf.animations[0];
      if (!clip) throw new Error(`[vrm-animator] No animation clip in ${path}`);
      RAW_CLIP_CACHE.set(name, { status: 'resolved', clip });
      return clip;
    })
    .catch((err) => {
      RAW_CLIP_CACHE.set(name, { status: 'rejected', error: err });
      throw err;
    });

  RAW_CLIP_CACHE.set(name, { status: 'pending', promise });
  return promise;
}

/**
 * Preload all 3 Mixamo animation GLBs.
 * Call once from the component that renders VRM avatars.
 * Errors are swallowed — they will surface when VRMCharacterAnimator.init() is called.
 */
export function preloadMixamoClips(): void {
  for (const name of Object.keys(ANIM_PATHS) as AnimName[]) {
    loadRawClip(name).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// VRMCharacterAnimator
// One instance per VRM avatar instance (created in useMemo alongside VRM clone).
// ---------------------------------------------------------------------------

const CROSSFADE_DURATION = 0.3; // seconds

export class VRMCharacterAnimator {
  private vrm: VRM;
  private mixer: THREE.AnimationMixer;
  private actions: Partial<Record<AnimName, THREE.AnimationAction>> = {};
  private currentAction: THREE.AnimationAction | null = null;
  private ready = false;
  private wasMoving = false;

  constructor(vrm: VRM) {
    this.vrm   = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
  }

  /**
   * Async initialisation — retargets all 3 clips for this VRM.
   * Called once after construction. Returns a Promise that resolves when
   * all clips are loaded and retargeted. Calling update() before init()
   * resolves is safe — it's a no-op until ready=true.
   */
  async init(): Promise<void> {
    const names: AnimName[] = ['idle', 'walk', 'run'];

    try {
      const rawClips = await Promise.all(names.map((n) => loadRawClip(n)));

      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const raw  = rawClips[i];

        const retargeted = retargetMixamoClip(raw, this.vrm);
        if (!retargeted) {
          console.warn(`[VRMCharacterAnimator] retarget failed for clip: ${name}`);
          continue;
        }

        const action = this.mixer.clipAction(retargeted);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
        this.actions[name] = action;
      }

      // Start idle immediately
      const idle = this.actions.idle;
      if (idle) {
        idle.play();
        this.currentAction = idle;
      }

      this.ready = true;
    } catch (err) {
      console.warn('[VRMCharacterAnimator] init failed:', err);
      // ready stays false — update() will be a no-op
    }
  }

  /**
   * Main update — call every frame inside useFrame.
   *
   * @param delta   Clamped frame delta (Math.min(rawDelta, 0.1))
   * @param isMoving  true when the avatar is walking/running
   */
  update(delta: number, isMoving: boolean): void {
    if (!this.ready) return;

    // Crossfade when movement state changes
    if (isMoving !== this.wasMoving) {
      const next = this.actions[isMoving ? 'walk' : 'idle'];
      if (next && next !== this.currentAction) {
        if (this.currentAction) {
          this.currentAction.crossFadeTo(next, CROSSFADE_DURATION, true);
        } else {
          next.play();
        }
        this.currentAction = next;
      }
      this.wasMoving = isMoving;
    }

    // Update mixer — advances all active AnimationActions
    this.mixer.update(delta);

    // Update VRM-specific systems: expressions, spring bones, look-at
    this.vrm.update(delta);
  }

  /**
   * Clean up — call on component unmount to release GPU resources.
   * The VRM scene itself is not disposed here — caller manages scene lifetime.
   */
  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.vrm.scene);
    // VRMUtils.deepDispose on the VRM scene is the caller's responsibility
    // (matches the pattern used in player-avatar.tsx for GLB material disposal)
  }
}
