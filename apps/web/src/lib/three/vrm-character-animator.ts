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
    // Mixer MUST be rooted at the normalized humanoid rig, NOT vrm.scene.
    // retargetMixamoClip emits track names like "Normalized_mixamorigLeftArm.quaternion".
    // In @pixiv/three-vrm v3 those nodes live under vrm.humanoid.normalizedHumanBonesRoot,
    // which is a side rig not parented to vrm.scene. If the mixer searches vrm.scene it
    // can't find the nodes → PropertyBinding falls through to a sentinel → writes go
    // nowhere → bones stay at bind pose (T-pose). vrm.update() then propagates the
    // (unchanged) normalized pose to raw bones, so the visible skeleton also stays in
    // T-pose. Rooting the mixer at normalizedHumanBonesRoot lets PropertyBinding resolve.
    const rigRoot = (vrm.humanoid as any)?.normalizedHumanBonesRoot as THREE.Object3D | undefined;
    this.mixer = new THREE.AnimationMixer(rigRoot ?? vrm.scene);
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
      // Debug: track init completions on window for CDP diagnostics
      if (typeof window !== 'undefined') {
        const w = window as any;
        w.__VRM_INIT_COUNT = (w.__VRM_INIT_COUNT || 0) + 1;
        w.__VRM_INIT_LOG = w.__VRM_INIT_LOG || [];
        const leftArm = this.vrm.humanoid.getNormalizedBoneNode('leftUpperArm' as any);
        // Diagnose PropertyBinding resolution — bindings bind to real nodes if the
        // mixer root's subtree contains the track target names, else fall through
        // to sentinel and writes silently do nothing (classic T-pose cause).
        const mixerAny = this.mixer as any;
        const bindings = (mixerAny._bindings || []) as any[];
        const withNode = bindings.filter((b) => b?.binding?.node != null).length;
        const mixerRootName = (mixerAny._root?.name || mixerAny._root?.type || 'unknown') as string;
        const hasNormalizedRig = !!(this.vrm.humanoid as any)?.normalizedHumanBonesRoot;
        w.__VRM_INIT_LOG.push({
          n: w.__VRM_INIT_COUNT,
          idleAction: !!idle,
          idleClip: idle ? idle.getClip().name : null,
          leftArmNode: leftArm ? leftArm.name : null,
          mixerRoot: mixerRootName,
          hasNormalizedRig,
          bindings: bindings.length,
          boundToReal: withNode,
          trackNames: idle ? idle.getClip().tracks.slice(0, 3).map((t) => t.name) : [],
        });
      }
    } catch (err) {
      console.warn('[VRMCharacterAnimator] init failed:', err);
      if (typeof window !== 'undefined') {
        const w = window as any;
        w.__VRM_INIT_ERRORS = w.__VRM_INIT_ERRORS || [];
        w.__VRM_INIT_ERRORS.push(String(err));
      }
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
   * PERF split: advance the AnimationMixer only (no spring-bone physics).
   * Use this at 60Hz to keep keyframe animations smooth.
   * Must be paired with updateSpringOnly() called at a lower rate.
   *
   * Also handles isMoving crossfade — crossfade state must be in sync with
   * the mixer, so we handle it here rather than in updateSpringOnly.
   *
   * @param delta  Clamped frame delta
   * @param isMoving  true when walking/running
   */
  updateMixerOnly(delta: number, isMoving: boolean): void {
    if (!this.ready) return;

    // Crossfade when movement state changes (mirrors the logic in update())
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

    this.mixer.update(delta);
    // Note: vrm.update() intentionally skipped — caller must call updateSpringOnly()
    // at the desired spring-bone rate (e.g. every 2nd frame for idle NPCs).
  }

  /**
   * PERF split: run VRM system updates (humanoid, lookAt, expressions, spring bones).
   * Call this at a lower rate (30Hz / every 2nd frame) for idle NPCs to halve
   * the spring-bone physics cost without visible visual degradation.
   *
   * The spring-bone verlet integrator is time-step independent (uses delta internally),
   * so passing an accumulated delta (e.g. 2 × frame_dt) produces physically correct
   * output — spring displacement is proportional to elapsed time regardless of call rate.
   *
   * @param accumulatedDelta  Sum of all deltas since last spring update. On a 30Hz
   *   schedule this is approximately 2 × (1/60) ≈ 0.033s. Pass clamped to 0.1s max.
   */
  updateSpringOnly(accumulatedDelta: number): void {
    if (!this.ready) return;
    this.vrm.update(accumulatedDelta);
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
