/**
 * vrm-character-animator.ts
 *
 * Drives VRM avatars with Mixamo-sourced animations retargeted to each VRM's
 * humanoid skeleton at runtime.
 *
 * Design:
 *   - 3 Mixamo GLBs (idle/walk/run) are loaded ONCE at module level and cached.
 *   - The cache stores the full GLTF ({ scene, animations }) — the retargeter
 *     needs animation.scene to query rest-pose world quaternions on source rig nodes.
 *   - For each VRM instance, retargetMixamoClip() applies the rest-pose-differential
 *     quaternion transform and emits tracks keyed to that VRM's normalized bone names.
 *   - Each VRM gets its own AnimationMixer (rooted at vrm.scene) + 3 retargeted clips.
 *   - idle ↔ walk crossfade via mixer.crossFadeTo() when isMoving changes.
 *
 * Mixer root — vrm.scene (NOT normalizedHumanBonesRoot):
 *   retargetMixamoClip emits tracks like "Normalized_J_Bip_C_Hips.quaternion".
 *   VRMHumanoidRig (containing those Normalized_* nodes) is a child of vrm.scene,
 *   so PropertyBinding can resolve them when the mixer is rooted at vrm.scene.
 *   The old workaround of rooting at normalizedHumanBonesRoot was only needed
 *   because the previous naive clone+rename retargeter produced stale T-pose
 *   data — the new rest-pose-differential transform makes that workaround
 *   unnecessary and incorrect.
 *
 * Performance:
 *   - Animation keyframe data (Float32Arrays) is shared between VRMs via the
 *     MixamoGltf cache — retargeting only allocates the transformed values slice.
 *   - No per-frame allocations — all scratch objects are class-scoped.
 *   - On Iris Xe budget ~0.3ms per VRM per frame for mixer.update + vrm.update.
 *
 * GPU constraints: no InstancedMesh, no ShaderMaterial, no drei Text/Billboard.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { VRM } from '@pixiv/three-vrm';
import { retargetMixamoClip, type MixamoGltf } from './mixamo-retarget';

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
// Module-level raw GLTF cache
//
// Each Mixamo animation GLB is loaded once. The cache stores the full GLTF
// ({ scene, animations }) — the retargeter needs animation.scene to query
// rest-pose world quaternions on the source Mixamo rig nodes.
// ---------------------------------------------------------------------------

type RawGltfEntry =
  | { status: 'pending';  promise: Promise<MixamoGltf> }
  | { status: 'resolved'; gltf:    MixamoGltf }
  | { status: 'rejected'; error:   unknown };

const RAW_CLIP_CACHE = new Map<AnimName, RawGltfEntry>();

// Separate loader for anim GLBs — no VRMLoaderPlugin needed
let _animLoader: GLTFLoader | null = null;
function getAnimLoader(): GLTFLoader {
  if (_animLoader) return _animLoader;
  _animLoader = new GLTFLoader();
  return _animLoader;
}

/**
 * Load a Mixamo animation GLB and return the full GLTF bundle ({ scene, animations }).
 * Promise is cached at module level — each path loads only once.
 */
function loadRawGltf(name: AnimName): Promise<MixamoGltf> {
  const cached = RAW_CLIP_CACHE.get(name);
  if (cached) {
    if (cached.status === 'resolved') return Promise.resolve(cached.gltf);
    if (cached.status === 'rejected') return Promise.reject(cached.error);
    return cached.promise;
  }

  const path = ANIM_PATHS[name];
  const promise = getAnimLoader()
    .loadAsync(path)
    .then((gltf) => {
      if (!gltf.animations.length) {
        throw new Error(`[vrm-animator] No animation clips in ${path}`);
      }
      const entry: MixamoGltf = {
        scene:      gltf.scene as THREE.Group,
        animations: gltf.animations,
      };
      // Force matrix world computation once at load time so the retargeter
      // gets accurate rest-pose world quaternions from the source rig nodes.
      entry.scene.updateMatrixWorld(true);
      RAW_CLIP_CACHE.set(name, { status: 'resolved', gltf: entry });
      return entry;
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
    loadRawGltf(name).catch(() => undefined);
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

  // Verse Engine skeleton.update batching (B2 2026-04-24).
  // Three.js WebGLRenderer calls skeleton.update() once per SkinnedMesh before
  // drawing it — but a VRM typically shares one skeleton across 3-4 SkinnedMeshes
  // (body, hair, face, outfit). That's 3× redundant calls per VRM per frame.
  // Pattern from VerseEngine/three-avatar avatar.ts:614:
  //   replace each mesh's skeleton.update with a no-op, cache the original,
  //   and invoke it once per unique skeleton per tick from our update methods.
  // Declared here; populated in constructor after VRM is available.
  // Reference: https://github.com/VerseEngine/three-avatar/blob/main/src/avatar.ts#L614
  private _skeletonUpdateFns: Array<() => void> = [];

  constructor(vrm: VRM) {
    this.vrm = vrm;
    // Mixer is rooted at vrm.scene so PropertyBinding can resolve
    // Normalized_* node names. VRMHumanoidRig (containing those nodes)
    // is a child of vrm.scene — scene.getObjectByName() finds them from here.
    // (Previous workaround rooted at normalizedHumanBonesRoot; removed because
    //  the retargeter now applies the correct rest-pose-differential transform.)
    this.mixer = new THREE.AnimationMixer(vrm.scene);

    // Wire skeleton batching: collect one update fn per unique skeleton,
    // replace each SkinnedMesh's skeleton.update with a no-op so the renderer
    // doesn't call it N times per frame (once per mesh that shares the skeleton).
    const seenSkeletons = new Set<THREE.Skeleton>();
    vrm.scene.traverse((obj) => {
      const sm = obj as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh || !sm.skeleton) return;
      if (seenSkeletons.has(sm.skeleton)) {
        // Second+ mesh sharing this skeleton — no-op its update too so the
        // renderer skips it, but we already have the original fn cached.
        sm.skeleton.update = () => {};
        return;
      }
      seenSkeletons.add(sm.skeleton);
      const originalUpdate = sm.skeleton.update.bind(sm.skeleton);
      this._skeletonUpdateFns.push(originalUpdate);
      sm.skeleton.update = () => {}; // renderer skips; we call manually below
    });
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
      const rawGltfs = await Promise.all(names.map((n) => loadRawGltf(n)));

      for (let i = 0; i < names.length; i++) {
        const name = names[i]!;
        const gltf = rawGltfs[i]!;

        let retargeted: THREE.AnimationClip;
        try {
          retargeted = retargetMixamoClip(gltf, this.vrm, name);
        } catch (err) {
          console.warn(`[VRMCharacterAnimator] retarget failed for clip "${name}":`, err);
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

      // Debug instrumentation — preserved for CDP diagnostics
      if (typeof window !== 'undefined') {
        const w = window as any;
        w.__VRM_INIT_COUNT = (w.__VRM_INIT_COUNT || 0) + 1;
        w.__VRM_INIT_LOG   = w.__VRM_INIT_LOG || [];

        const leftArm = this.vrm.humanoid.getNormalizedBoneNode('leftUpperArm' as any);

        const mixerAny   = this.mixer as any;
        const bindings   = (mixerAny._bindings || []) as any[];
        const withNode   = bindings.filter((b: any) => b?.binding?.node != null).length;
        // mixerRoot is vrm.scene — name/type varies by VRM, use uuid as stable id
        const mixerRootName = (mixerAny._root?.name || mixerAny._root?.type || 'vrm.scene') as string;
        // hasNormalizedRig: still true — we just no longer use it as the mixer root
        const hasNormalizedRig = !!(this.vrm.humanoid as any)?.normalizedHumanBonesRoot;

        w.__VRM_INIT_LOG.push({
          n:             w.__VRM_INIT_COUNT,
          idleAction:    !!idle,
          idleClip:      idle ? idle.getClip().name : null,
          leftArmNode:   leftArm ? leftArm.name : null,
          mixerRoot:     mixerRootName,
          hasNormalizedRig,
          mixerRootIsScene: true,
          bindings:      bindings.length,
          boundToReal:   withNode,
          trackNames:    idle ? idle.getClip().tracks.slice(0, 3).map((t) => t.name) : [],
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
   * Order: mixer.update() → vrm.update() (matches Milady's VrmEngine.ts).
   * mixer.update advances keyframe actions; vrm.update propagates normalized
   * bone poses to raw bones + runs spring-bone physics.
   *
   * @param delta    Clamped frame delta (Math.min(rawDelta, 0.1))
   * @param isMoving true when the avatar is walking/running
   */
  update(delta: number, isMoving: boolean): void {
    if (!this.ready) return;

    if (isMoving !== this.wasMoving) {
      this.applyCrossfade(isMoving);
      this.wasMoving = isMoving;
    }

    this.mixer.update(delta);
    // Flush batched skeleton.update() once per unique skeleton (Verse Engine pattern).
    // The renderer's per-mesh calls are no-ops; we run each unique skeleton exactly once.
    for (const fn of this._skeletonUpdateFns) fn();
    this.vrm.update(delta);
  }

  /**
   * Transition to the action matching `isMoving`.
   *
   * three.js's `crossFadeTo` schedules weight changes but does NOT call `.play()`
   * on the incoming action — it assumes both actions are already running. At
   * init() only `idle.play()` is called; `walk` and `run` are constructed
   * stopped. Without an explicit `.play()` on the incoming action here, the
   * first idle→walk transition silently fails: the mixer ticks, weights fade,
   * but the walk action's `isRunning` stays false so its tracks never write
   * to the bone nodes. Symptom observed 2026-04-23: VRM NPCs that the server
   * marked as walking held identity quaternions on Normalized_mixamorigHips
   * forever — bones appeared frozen, NPC locomotion looked broken.
   *
   * Fix: `next.reset()` clears time/weight/timeScale/enabled/paused back to
   * defaults (also undoing any `warp` timeScale residual from prior crossfades),
   * then `next.fadeIn(duration)` schedules the weight ramp, then `next.play()`
   * actually starts the action ticking. The outgoing action gets a matching
   * `fadeOut` so both weights cross at 50%. `warp=true` on the old crossFadeTo
   * was dropped because the Mixamo clip durations (walk=1.03s, idle=12.04s)
   * produced a warp ratio of ~11.65× that persisted on the idle action after
   * every transition, accumulating drift across repeated idle↔walk toggles.
   */
  private applyCrossfade(isMoving: boolean): void {
    const next = this.actions[isMoving ? 'walk' : 'idle'];
    if (!next || next === this.currentAction) return;
    next.reset().fadeIn(CROSSFADE_DURATION).play();
    if (this.currentAction) {
      this.currentAction.fadeOut(CROSSFADE_DURATION);
    }
    this.currentAction = next;
  }

  /**
   * PERF split: advance the AnimationMixer only (no spring-bone physics).
   * Use this at 60Hz to keep keyframe animations smooth.
   * Must be paired with updateSpringOnly() called at a lower rate.
   *
   * Also handles isMoving crossfade — crossfade state must be in sync with
   * the mixer, so we handle it here rather than in updateSpringOnly.
   *
   * @param delta    Clamped frame delta
   * @param isMoving true when walking/running
   */
  updateMixerOnly(delta: number, isMoving: boolean): void {
    if (!this.ready) return;

    if (isMoving !== this.wasMoving) {
      this.applyCrossfade(isMoving);
      this.wasMoving = isMoving;
    }

    this.mixer.update(delta);
    // Flush batched skeleton.update() once per unique skeleton (Verse Engine pattern).
    // Must run after mixer.update() so bone world matrices are current before draw.
    for (const fn of this._skeletonUpdateFns) fn();
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

    // Restore skeleton.update on all SkinnedMesh nodes so the VRM is safe
    // if a new animator is constructed from the same VRM instance (hot-reload
    // or re-mount). The restored fns are the original bound methods captured
    // in the constructor.
    let fnIdx = 0;
    const seenSkeletons = new Set<THREE.Skeleton>();
    this.vrm.scene.traverse((obj) => {
      const sm = obj as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh || !sm.skeleton) return;
      if (seenSkeletons.has(sm.skeleton)) return;
      seenSkeletons.add(sm.skeleton);
      if (this._skeletonUpdateFns[fnIdx]) {
        sm.skeleton.update = this._skeletonUpdateFns[fnIdx]!;
        fnIdx++;
      }
    });
    this._skeletonUpdateFns = [];

    // VRMUtils.deepDispose on the VRM scene is the caller's responsibility
    // (matches the pattern used in player-pet.tsx for GLB material disposal)
  }
}
