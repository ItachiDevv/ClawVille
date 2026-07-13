/**
 * mixamo-retarget.ts
 *
 * Retargets a Mixamo (or Meshy) AnimationClip to a VRM humanoid skeleton.
 *
 * This is a direct port of Milady's retargetMixamoGltfToVrm (MIT-licensed):
 *   milady-ai/milady/packages/app-core/src/components/avatar/retargetMixamoGltfToVrm.ts
 *
 * Meshy support (2026-07-12, cove sit-flow slice): the rest-pose-differential
 * math below is source-rig-agnostic — it reads the CLIP's own scene for rest
 * poses, not a hardcoded skeleton — so a second bone-name map (`meshyVRMRigMap`)
 * plus a near-identity normalizer covers Meshy's animation-library clips. The
 * Mixamo path (`retargetMixamoClip`) is byte-identical to before this change;
 * both wrappers now call a shared `buildRetargetedClip()` core.
 *
 * Meshy bone-name ground truth was NOT assumed — verified headlessly against
 * the actual clip GLBs (`stand_to_sit.glb`, `sit_idle_m/f.glb`, etc.) fired
 * from Meshy's animation library (action IDs 57/60/33/32/53/52) onto a rig
 * from our own `/rigging` task: bare names (`Hips`, `LeftUpLeg`, `Spine01`, …,
 * lowercase `neck`), no fingers — matching `scripts/hermes-pipeline/
 * inject-vrm-meshy.mjs`'s `MESHY_TO_VRM` map exactly. The skeleton has 24
 * skin joints total; 22 map to VRM humanoid bones (`meshyVRMRigMap` below) —
 * `head_end` and `headfront` are deliberately unmapped (no VRM humanoid
 * equivalent, harmless to skip).
 * Also verified the clip GLBs share a BIT-IDENTICAL rest pose with the rigging
 * task's own `rigged.glb` (diffed Hips + 5 other bones' rest rotation
 * component-for-component) — Meshy's animation library retargets onto the
 * exact rig it just built, not a separate shared skeleton with a different
 * rest pose, so there is no cross-rig pose divergence for the differential
 * transform to fight for this specific clip set. THREE's GLTFLoader resolves
 * `channel.target.node` to the node's own `name` (no "Armature|" FBX-export
 * prefix the way Mixamo's glTF conversion embeds one) — track names for these
 * clips are already bare ("Hips.quaternion"), so `normalizeMeshyRigName` is a
 * defensive near-identity, not a real parser.
 *
 * Root cause of the permanent T-pose bug (naive clone+rename approach):
 *   A Mixamo bone's keyframe quaternions are stored relative to the Mixamo
 *   skeleton's rest pose (T-pose). A VRM skeleton has a DIFFERENT rest pose.
 *   If you simply rename the track to point at the VRM bone without transforming
 *   the quaternion values, the AnimationMixer applies Mixamo-space rotations to
 *   VRM-space bones. Since the reference frames disagree, the character stays
 *   frozen at whatever pose results from interpreting Mixamo-T-pose quaternions
 *   in VRM-rest-pose space — which is T-pose.
 *
 * The fix — rest-pose-differential quaternion transform:
 *   For each Mixamo bone, compute:
 *     restRotationInverse   = world rotation of the Mixamo rig node at rest, inverted
 *     parentRestWorldRotation = world rotation of its parent node at rest
 *   Then transform every quaternion keyframe q:
 *     q' = parentRestWorldRotation * q * restRotationInverse
 *   This converts q from Mixamo-rest-relative space into the coordinate frame that
 *   the VRM AnimationMixer expects. Additionally, VRM 0.x models require an axis
 *   flip on every other component (i%2===0 → negate) to account for the coordinate
 *   system rotation applied by VRMUtils.rotateVRM0().
 *
 * Mixer root:
 *   The AnimationMixer MUST be rooted at vrm.scene (not normalizedHumanBonesRoot).
 *   getNormalizedBoneNode() returns Normalized_* Object3D nodes that live under
 *   VRMHumanoidRig, which is a child of vrm.scene. The mixer searches by node
 *   .name, so rooting at vrm.scene lets PropertyBinding find them. Rooting at
 *   normalizedHumanBonesRoot was a workaround for the broken naive retargeter —
 *   now that the quaternion transform is correct, that workaround is removed.
 *
 * References:
 *   - Milady: milady-ai/milady retargetMixamoGltfToVrm.ts (MIT)
 *   - pixiv:  humanoidAnimation/loadMixamoAnimation.js (MIT)
 *
 * No per-frame allocations — this function runs once at load time per
 * (VRM, AnimationClip) pair.
 */

import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

// ---------------------------------------------------------------------------
// Mixamo bone name → VRMHumanBoneName
//
// Ported directly from Milady's mixamoVRMRigMap.ts.
// Keys are the full mixamorig-prefixed names (as they appear after
// normalizeMixamoRigName strips the pipe/path prefix).
// ---------------------------------------------------------------------------

export const mixamoVRMRigMap: Record<string, VRMHumanBoneName> = {
  mixamorigHips:              'hips',
  mixamorigSpine:             'spine',
  mixamorigSpine1:            'chest',
  mixamorigSpine2:            'upperChest',
  mixamorigNeck:              'neck',
  mixamorigHead:              'head',
  mixamorigLeftShoulder:      'leftShoulder',
  mixamorigLeftArm:           'leftUpperArm',
  mixamorigLeftForeArm:       'leftLowerArm',
  mixamorigLeftHand:          'leftHand',
  mixamorigLeftHandThumb1:    'leftThumbMetacarpal',
  mixamorigLeftHandThumb2:    'leftThumbProximal',
  mixamorigLeftHandThumb3:    'leftThumbDistal',
  mixamorigLeftHandIndex1:    'leftIndexProximal',
  mixamorigLeftHandIndex2:    'leftIndexIntermediate',
  mixamorigLeftHandIndex3:    'leftIndexDistal',
  mixamorigLeftHandMiddle1:   'leftMiddleProximal',
  mixamorigLeftHandMiddle2:   'leftMiddleIntermediate',
  mixamorigLeftHandMiddle3:   'leftMiddleDistal',
  mixamorigLeftHandRing1:     'leftRingProximal',
  mixamorigLeftHandRing2:     'leftRingIntermediate',
  mixamorigLeftHandRing3:     'leftRingDistal',
  mixamorigLeftHandPinky1:    'leftLittleProximal',
  mixamorigLeftHandPinky2:    'leftLittleIntermediate',
  mixamorigLeftHandPinky3:    'leftLittleDistal',
  mixamorigRightShoulder:     'rightShoulder',
  mixamorigRightArm:          'rightUpperArm',
  mixamorigRightForeArm:      'rightLowerArm',
  mixamorigRightHand:         'rightHand',
  mixamorigRightHandPinky1:   'rightLittleProximal',
  mixamorigRightHandPinky2:   'rightLittleIntermediate',
  mixamorigRightHandPinky3:   'rightLittleDistal',
  mixamorigRightHandRing1:    'rightRingProximal',
  mixamorigRightHandRing2:    'rightRingIntermediate',
  mixamorigRightHandRing3:    'rightRingDistal',
  mixamorigRightHandMiddle1:  'rightMiddleProximal',
  mixamorigRightHandMiddle2:  'rightMiddleIntermediate',
  mixamorigRightHandMiddle3:  'rightMiddleDistal',
  mixamorigRightHandIndex1:   'rightIndexProximal',
  mixamorigRightHandIndex2:   'rightIndexIntermediate',
  mixamorigRightHandIndex3:   'rightIndexDistal',
  mixamorigRightHandThumb1:   'rightThumbMetacarpal',
  mixamorigRightHandThumb2:   'rightThumbProximal',
  mixamorigRightHandThumb3:   'rightThumbDistal',
  mixamorigLeftUpLeg:         'leftUpperLeg',
  mixamorigLeftLeg:           'leftLowerLeg',
  mixamorigLeftFoot:          'leftFoot',
  mixamorigLeftToeBase:       'leftToes',
  mixamorigRightUpLeg:        'rightUpperLeg',
  mixamorigRightLeg:          'rightLowerLeg',
  mixamorigRightFoot:         'rightFoot',
  mixamorigRightToeBase:      'rightToes',
};

// ---------------------------------------------------------------------------
// Meshy bone name → VRMHumanBoneName
//
// Bare names, no namespace/prefix — verified against the actual clip GLBs
// (see file header) and cross-checked against
// scripts/hermes-pipeline/inject-vrm-meshy.mjs's MESHY_TO_VRM (the injector
// that gives our rigged Meshy characters their VRMC_vrm humanoid mapping in
// the first place, so this MUST agree with it or the same clip would resolve
// to different VRM bones depending on which map ran first).
// No finger bones — Meshy's /rigging output has 24 skin joints total, none
// of them fingers.
// ---------------------------------------------------------------------------

export const meshyVRMRigMap: Record<string, VRMHumanBoneName> = {
  Hips:           'hips',
  Spine:          'spine',
  Spine01:        'chest',
  Spine02:        'upperChest',
  neck:           'neck', // lowercase in Meshy's own rig — not a typo
  Head:           'head',
  LeftShoulder:   'leftShoulder',
  LeftArm:        'leftUpperArm',
  LeftForeArm:    'leftLowerArm',
  LeftHand:       'leftHand',
  RightShoulder:  'rightShoulder',
  RightArm:       'rightUpperArm',
  RightForeArm:   'rightLowerArm',
  RightHand:      'rightHand',
  LeftUpLeg:      'leftUpperLeg',
  LeftLeg:        'leftLowerLeg',
  LeftFoot:       'leftFoot',
  LeftToeBase:    'leftToes',
  RightUpLeg:     'rightUpperLeg',
  RightLeg:       'rightLowerLeg',
  RightFoot:      'rightFoot',
  RightToeBase:   'rightToes',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a raw Mixamo rig name to the `mixamorig<BoneName>` form that
 * mixamoVRMRigMap keys on.
 *
 * Handles these variants produced by different exporters / Three.js sanitization:
 *   "Armature|mixamorig:Hips"  → strip pipe prefix  → "mixamorig:Hips"
 *   "mixamorig:Hips"           → colon + ns=mixamorig → return "mixamorigHips"
 *   "mixamorigHips"            → no colon → return as-is ("mixamorigHips")
 *   "Hips"                     → no known prefix → return "Hips" (won't match map)
 *
 * Three.js GLTFLoader calls PropertyBinding.sanitizeNodeName() which strips `:`,
 * so tracks in a loaded GLTF will usually already be "mixamorigHips". The colon
 * branch handles raw GLTF exports before Three.js sanitizes them.
 */
function normalizeMixamoRigName(name: string): string {
  // Strip leading pipe path ("Armature|..." etc.)
  const pipe = name.lastIndexOf('|');
  const base = pipe >= 0 ? name.slice(pipe + 1) : name;

  const colon = base.indexOf(':');
  if (colon >= 0) {
    const ns   = base.slice(0, colon);   // e.g. "mixamorig"
    const rest = base.slice(colon + 1);  // e.g. "Hips"
    if (ns === 'mixamorig') return `mixamorig${rest}`;
    // Unknown namespace — drop it and return the tail
    return rest;
  }

  return base;
}

/**
 * Normalize a Meshy rig node name. Verified (see file header) that THREE's
 * GLTFLoader hands us bare names ("Hips", "LeftUpLeg", …) directly with no
 * "Armature|" export-path prefix — so this is a defensive identity, kept as
 * a real function (not a bare pass of the name) only so a future Meshy export
 * variant with a pipe-prefixed name doesn't silently fail to map, mirroring
 * normalizeMixamoRigName's pipe-stripping without needing colon/namespace
 * handling (Meshy names carry no colon).
 */
function normalizeMeshyRigName(name: string): string {
  const pipe = name.lastIndexOf('|');
  return pipe >= 0 ? name.slice(pipe + 1) : name;
}

function isVrm0(vrm: VRM): boolean {
  const mv = String((vrm.meta as any)?.metaVersion ?? '');
  return mv.startsWith('0');
}

/**
 * Try to locate a Mixamo rig node in the animation source scene.
 * Tries (in order): exact raw name, normalized name, name after stripping namespace.
 */
function findNode(
  scene: THREE.Object3D,
  rawName: string,
  normalizedName: string,
): THREE.Object3D | null {
  return (
    scene.getObjectByName(rawName) ??
    scene.getObjectByName(normalizedName) ??
    scene.getObjectByName(
      rawName.includes(':') ? (rawName.split(':')[1] ?? rawName) : rawName,
    ) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * The shape of a loaded Mixamo animation GLB — holds both the scene (needed
 * to query rest-pose world quaternions) and the animation clips.
 */
export interface MixamoGltf {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

/**
 * Per-VRM-instance memo for `measureVrmHipsHeightAboveFloor` — see that
 * function's doc comment for why this must be BOTH pose-safe and cached.
 * WeakMap keyed by the VRM instance so disposed VRMs don't leak entries.
 */
const _vrmHipsHeightCache = new WeakMap<VRM, number>();

/**
 * Measure a VRM's hip height ABOVE ITS OWN FEET, in the VRM's native local
 * units (scale=1, matching computeVRMAvatarFit's own measurement basis) — as
 * opposed to `normalizedRestPose.hips.position[1]`, which is the hip node's
 * local Y relative to its OWN PARENT NODE, not relative to the character's
 * feet.
 *
 * Those two are usually close enough to not matter (most VRMs are authored
 * with the hip's parent chain rooted near floor level), but NOT universally
 * true — caught via the headless retarget-verification harness before ever
 * touching a browser: `hermes-female.vrm`'s Hips bone carries its own
 * scale=[100,100,100] with no compensating Armature-wrapper ancestor (unlike
 * clytemnestra.vrm's Armature-wrapper-scale=0.01 pattern), so its raw
 * hips.position.y reads 18.58 — only ~9.7% of the character's own measured
 * bbox height, vs ~55-59% for every other roster VRM tested
 * (clytemnestra/milady). Feeding that into `hipsPositionScale` under-scaled
 * every retargeted hip-descent by ~6x (verified end-to-end through
 * `computeVRMAvatarFit`'s real render-scale: 40.64wu descent for clytemnestra
 * vs 6.73wu for hermes-female at the SAME target avatar height — hermes would
 * barely visibly sit down). This bug is NOT new — it silently affected every
 * EXISTING Mixamo idle/walk/run retarget for this animatorId too; a few-cm
 * hip bob just hid a 6x scale error where a real sit-descent didn't.
 *
 * Fix: measure hip height the same way computeVRMAvatarFit measures overall
 * body height — via the live bbox, floor-relative, at scale=1 — so the two
 * height measurements share a reference frame and stay proportionally
 * consistent regardless of how a given asset's internal node hierarchy
 * happens to be scaled.
 *
 * POSE-SAFETY, ROUND 1 (caught via the headless harness, 2026-07-12): unlike
 * the old `normalizedRestPose` lookup — a static snapshot three-vrm computes
 * once at load and never mutates — this measurement reads the LIVE skeleton,
 * so it is only correct if the VRM is at rest pose when measured. It is NOT
 * guaranteed to be: `playOneShot()` / `setSurfaceClip()` lazy-retarget a
 * clip the first time it's triggered, which can happen while the character
 * is mid-walk-cycle (skeleton posed, not resting). Verified this breaks
 * without a guard: retargeting the SAME clip onto the SAME VRM produced
 * different hip-Y readings depending on what pose a PRIOR retarget call had
 * left the skeleton in (caught when bundle-based retargeting of 5 clips in
 * sequence gave different numbers than retargeting each clip standalone).
 * Fixed (this round) by saving the current raw pose, calling
 * `resetRawPose()`, measuring, then restoring the saved pose.
 *
 * POSE-SAFETY, ROUND 2 (Codex adversarial review, 2026-07-13 — round 1's fix
 * was necessary but NOT sufficient): `resetRawPose()` correctly resets the
 * BONE NODES, so `hipsNode.getWorldPosition()` reads a true rest-pose value.
 * But `Box3.setFromObject` on a SkinnedMesh reads skinned vertex positions
 * via `skeleton.boneMatrices`, which are only refreshed by
 * `skeleton.update()` — and `VRMCharacterAnimator`'s constructor
 * monkey-patches EVERY `SkinnedMesh.skeleton.update` to a no-op the moment
 * an animator exists for a VRM (skeleton-batching optimization; see
 * `vrm-character-animator.ts` constructor, `_skeletonUpdateFns`). This
 * function's own "settle skeleton" traversal calls exactly that patched
 * no-op once any animator has been constructed for the VRM — so in the
 * BROWSER (where every visible VRM gets an animator), the bbox measurement
 * silently reads FROZEN boneMatrices from whatever pose was last genuinely
 * flushed, while `hipsNode.getWorldPosition()` reads the correctly-reset
 * LIVE node transform — two different frames mixed in one measurement. The
 * headless verification harness could not catch this because it drives
 * clips through a raw `THREE.AnimationMixer`, never constructing a
 * `VRMCharacterAnimator`, so `skeleton.update` was never patched there.
 *
 * FIX: this function must run ONCE per VRM, EAGERLY, at load time — before
 * any `VRMCharacterAnimator` is ever constructed for that VRM instance, so
 * `skeleton.update` is still the real, un-patched implementation. Call
 * `primeVrmHipsHeightCache(vrm)` from the VRM load pipeline (`vrm-loader.ts`
 * `normaliseVRM`, which runs inside the parse queue before the VRM is
 * returned to ANY consumer — guaranteed pre-animator). `buildRetargetedClip`
 * below then only ever READS the cache; it never invokes this measurement
 * itself on the lazy paths (`setSurfaceClip`/`playOneShot`).
 *
 * COLD-CACHE FALLBACK: if a lazy retarget path hits a VRM whose cache was
 * never primed (load-order regression — a new VRM-load call site skipped
 * `normaliseVRM`, or this file's own priming call was removed), this
 * function still attempts the measurement rather than throwing — a
 * possibly-stale hip height is better than crashing the character's
 * animation entirely. It emits a dev-mode `console.warn` so the regression
 * is visible instead of silently shipping wrong-but-plausible numbers.
 *
 * PERFORMANCE: memoized per-VRM-instance in `_vrmHipsHeightCache` — a
 * Box3.setFromObject + full skeleton traversal is real cost, so with eager
 * priming it runs exactly once per VRM instance's lifetime (at load), never
 * once per clip.
 */
function measureVrmHipsHeightAboveFloor(vrm: VRM, _isEagerPrime = false): number {
  const cached = _vrmHipsHeightCache.get(vrm);
  if (cached !== undefined) return cached;

  if (!_isEagerPrime && typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    console.warn(
      '[mixamo-retarget] measureVrmHipsHeightAboveFloor: cache was cold on a ' +
      'lazy retarget call — primeVrmHipsHeightCache(vrm) should have run at ' +
      'VRM load time (vrm-loader.ts normaliseVRM), before any ' +
      'VRMCharacterAnimator existed for this instance. Proceeding with a ' +
      'best-effort measurement, which may read a stale/mixed pose if an ' +
      'animator has already monkey-patched this VRM\'s skeleton.update.',
    );
  }

  const hipsNode = vrm.humanoid?.getRawBoneNode('hips' as VRMHumanBoneName);
  if (!hipsNode) return 0;

  const savedPose = vrm.humanoid!.getRawPose();
  vrm.humanoid!.resetRawPose();

  const prevScale = vrm.scene.scale.clone();
  vrm.scene.scale.setScalar(1);
  vrm.scene.updateMatrixWorld(true);

  // Settle skeleton bone matrices before measuring — same requirement
  // computeVRMAvatarFit documents: Box3.setFromObject on a SkinnedMesh reads
  // skeleton.boneMatrices, which are stale/zero until skeleton.update() runs.
  vrm.scene.traverse((obj) => {
    const sm = obj as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.update();
  });

  const box = new THREE.Box3().setFromObject(vrm.scene);
  const hipsWorldPos = new THREE.Vector3();
  hipsNode.getWorldPosition(hipsWorldPos);

  vrm.scene.scale.copy(prevScale);
  vrm.scene.updateMatrixWorld(true);

  // Restore whatever pose the caller's animation had the VRM in — this
  // function must be a read, never visibly disturb a live character.
  vrm.humanoid!.setRawPose(savedPose);
  vrm.scene.updateMatrixWorld(true);

  const height = hipsWorldPos.y - box.min.y;
  const result = Number.isFinite(height) ? Math.abs(height) : 0;
  _vrmHipsHeightCache.set(vrm, result);
  return result;
}

/**
 * Eagerly populate `_vrmHipsHeightCache` for a freshly-parsed VRM. MUST be
 * called before any `VRMCharacterAnimator` is constructed for this VRM
 * instance — see `measureVrmHipsHeightAboveFloor`'s "POSE-SAFETY, ROUND 2"
 * doc comment for why that ordering is load-bearing (skeleton.update() gets
 * monkey-patched to a no-op the moment an animator exists).
 *
 * Canonical call site: `vrm-loader.ts` `normaliseVRM(vrm)`, which runs
 * inside the parse queue before the VRM is handed to any consumer. Every
 * humanoid VRM in the game goes through that path (it's the sole producer
 * behind `useVRMInstance`), so calling this unconditionally there covers the
 * whole roster without per-consumer opt-in — no risk of "did I remember to
 * prime this specific character" bugs.
 */
export function primeVrmHipsHeightCache(vrm: VRM): void {
  measureVrmHipsHeightAboveFloor(vrm, /* _isEagerPrime */ true);
}

/**
 * Shared rest-pose-differential retarget core. Both `retargetMixamoClip` and
 * `retargetMeshyClip` call this with their own bone-name map + normalizer —
 * the math itself doesn't care which source rig it came from, only the
 * clip's OWN scene rest pose (read fresh per call, never hardcoded).
 *
 * @param animation      The loaded source GLB ({ scene, animations }).
 *                       animation.scene must have its matrixWorld updated
 *                       before calling (done internally below).
 * @param vrm            The target VRM instance.
 * @param rigMap         Source rig bone name → VRMHumanBoneName.
 * @param normalizeName  Normalizes a raw track rig-name before rigMap lookup.
 * @param sourceLabel    Only used in error messages (e.g. "mixamo-retarget"
 *                       vs "meshy-retarget") so a thrown error identifies
 *                       which pipeline failed.
 * @param clipName       Optional name for the returned clip.
 */
function buildRetargetedClip(
  animation: MixamoGltf,
  vrm: VRM,
  rigMap: Record<string, VRMHumanBoneName>,
  normalizeName: (name: string) => string,
  sourceLabel: string,
  clipName?: string,
): THREE.AnimationClip {
  animation.scene.updateMatrixWorld(true);
  vrm.scene.updateMatrixWorld(true);

  const sourceClip = animation.animations[0];
  if (!sourceClip) {
    throw new Error(`[${sourceLabel}] GLB contains no animation clips`);
  }

  const tracks: THREE.QuaternionKeyframeTrack[] = [];

  // Scratch quaternions — allocated once, reused across all bones/keyframes.
  const restRotationInverse      = new THREE.Quaternion();
  const parentRestWorldRotation  = new THREE.Quaternion();
  const q                        = new THREE.Quaternion();

  const vrm0 = isVrm0(vrm);

  // Compute hip position scale (vrmHipsHeight / motionHipsHeight) so that
  // the hip vertical bob in the clip lands at the VRM's hip height. Without
  // this the bob is in source-rig units (character ~1.5-1.7m tall) applied to
  // a VRM that may be taller/shorter → disproportionate vertical movement.
  // Hips is looked up by normalized name directly against the source scene —
  // works for both "mixamorigHips" (Mixamo) and "Hips" (Meshy) since
  // normalizeName has already been applied by the caller's map convention.
  const hipsRawName = Object.keys(rigMap).find((k) => rigMap[k] === 'hips') ?? 'Hips';
  const motionHipsNode = findNode(animation.scene, hipsRawName, hipsRawName);
  const motionHipsHeight = Math.abs(motionHipsNode?.position.y ?? 0);
  const vrmHipsHeight = measureVrmHipsHeightAboveFloor(vrm);
  const hipsPositionScale =
    motionHipsHeight > 1e-6 && vrmHipsHeight > 1e-6
      ? vrmHipsHeight / motionHipsHeight
      : 1;

  for (const track of sourceClip.tracks) {
    const parts        = track.name.split('.');
    const rawRigName   = parts[0];
    const propertyName = parts[1];
    if (!rawRigName || !propertyName) continue;

    const normalizedRigName = normalizeName(rawRigName);
    const vrmBoneName       = rigMap[normalizedRigName];
    if (!vrmBoneName) continue;

    // IMPORTANT: getNormalizedBoneNode, not getRawBoneNode.
    // three-vrm v3 drives the Normalized_* hierarchy; vrm.update() propagates
    // normalized → raw each frame. The mixer must write to normalized nodes.
    const vrmNode = vrm.humanoid?.getNormalizedBoneNode(vrmBoneName);
    if (!vrmNode) continue;

    const mixamoRigNode = findNode(animation.scene, rawRigName, normalizedRigName);
    if (!mixamoRigNode || !mixamoRigNode.parent) continue;

    // Quaternion tracks: rest-pose-differential transform + VRM 0.x axis flip.
    if (propertyName === 'quaternion' && track instanceof THREE.QuaternionKeyframeTrack) {
      mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
      mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation);

      const values = track.values.slice();
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(values, i);
        q.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
        q.toArray(values, i);
      }

      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${vrmNode.name}.quaternion`,
          track.times,
          // VRM 0.x axis flip: VRMUtils.rotateVRM0 adds π rotation to vrm.scene,
          // which inverts the X and Z axes of every bone. Every even-indexed component
          // (x, z in each xyzw tuple) must be negated to compensate.
          values.map((v, i) => (vrm0 && i % 2 === 0 ? -v : v)),
        ),
      );
      continue;
    }

    // Position tracks (typically only on hips): keep ONLY the Y axis
    // (vertical hip bob). Rationale: Mixamo walk/run clips encode forward
    // motion as positive Z on the hip bone. After the VRM 0.x coord flip
    // (i%3!=1 → negate X and Z) that becomes -Z locally; combined with
    // rotateVRM0's scene.rotation.y = π that flips -Z back to +Z in world.
    // Result: hips drift +Z in world independent of the game-driven group
    // rotation. Since our facing formula points the VRM's "forward" (-Z
    // after rotateVRM0) along the velocity direction, the HIPS then drift
    // OPPOSITE the facing direction → character skates backwards while
    // feet walk forward. User-visible as "Miladys walk backwards 2026-04-24".
    //
    // Y axis is safe — vertical bob doesn't conflict with horizontal
    // game-position. We keep it so hair/skirt spring bones receive the
    // vertical shock they need to swing naturally.
    //
    // vrmBoneName === 'hips' GATE (added for Meshy support, 2026-07-12):
    // Mixamo GLBs only ever emit a position channel on Hips (this branch's
    // original assumption, per the comment above — "typically only on
    // hips" was previously unenforced, just true by luck of Mixamo's FBX
    // export). Meshy's export bakes a translation channel on EVERY bone,
    // even ones that never move — verified on stand_to_sit.glb: LeftUpLeg's
    // "translation" track is 2 keyframes, both equal to its REST-local
    // offset (1.282, -4.161, 10.124), i.e. a no-op track. Without this
    // gate, that non-hips track would still be transformed (X/Z zeroed, Y
    // rescaled by the HIPS-specific hipsPositionScale) and pushed as a real
    // clip track — silently deforming the bone's length/offset every frame
    // the clip plays (caught via the headless retarget-verification harness
    // before this ever reached a browser, not by eyeballing a screenshot).
    if (
      propertyName === 'position' &&
      track instanceof THREE.VectorKeyframeTrack &&
      vrmBoneName === 'hips'
    ) {
      const src = track.values;
      const values = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        values[i    ] = 0; // X: zeroed (no lateral drift)
        values[i + 1] = src[i + 1] * hipsPositionScale; // Y: keep, scale for hip height
        values[i + 2] = 0; // Z: zeroed (no forward drift)
      }
      tracks.push(
        new THREE.VectorKeyframeTrack(
          `${vrmNode.name}.position`,
          track.times,
          values,
        ),
      );
    }
  }

  // Validate that at least the hips bone was mapped — without it the entire
  // skeleton has no root drive and the character stays in T-pose.
  const hipsBone = vrm.humanoid?.getNormalizedBoneNode('hips' as VRMHumanBoneName);
  const hasHipsTrack = hipsBone
    ? tracks.some((t) => t.name.startsWith(`${hipsBone.name}.`))
    : false;

  if (!hasHipsTrack) {
    throw new Error(
      `[${sourceLabel}] Retargeting failed: no hips bone track found ` +
        `(mapped ${tracks.length} tracks total, rig map has ${Object.keys(rigMap).length} entries).`,
    );
  }

  const name = clipName ?? sourceClip.name ?? 'retargeted';
  const clip = new THREE.AnimationClip(name, sourceClip.duration, tracks);
  clip.optimize();
  return clip;
}

/**
 * Retarget a Mixamo animation GLB to a VRM humanoid skeleton.
 *
 * @param animation  The loaded Mixamo GLB ({ scene, animations }).
 *                   animation.scene must have its matrixWorld updated before
 *                   calling (call animation.scene.updateMatrixWorld(true)).
 * @param vrm        The target VRM instance (vrm.scene.updateMatrixWorld(true)
 *                   called internally).
 * @param clipName   Optional name for the returned clip (defaults to source clip name).
 *
 * @throws if the GLB has no animation clips, or if no hips track could be mapped.
 *
 * The returned AnimationClip targets `vrmNode.name + '.quaternion'` tracks.
 * The AnimationMixer MUST be rooted at `vrm.scene` (not normalizedHumanBonesRoot)
 * so that PropertyBinding can resolve Normalized_* node names via
 * vrm.scene.getObjectByName().
 */
export function retargetMixamoClip(
  animation: MixamoGltf,
  vrm: VRM,
  clipName?: string,
): THREE.AnimationClip {
  return buildRetargetedClip(
    animation, vrm, mixamoVRMRigMap, normalizeMixamoRigName, 'mixamo-retarget', clipName,
  );
}

/**
 * Retarget a Meshy animation-library GLB to a VRM humanoid skeleton.
 * Same rest-pose-differential math as `retargetMixamoClip`, different bone
 * map + normalizer (see file header for the verification this map is built
 * on). Position-track policy (X/Z zeroed, Y kept+scaled) is currently shared
 * unchanged with the Mixamo path — verified correct for `stand_to_sit` /
 * `sit_to_stand_*` (their horizontal hip drift is small/incidental; the real
 * signal is the ~40-unit vertical hip descent, which the Y-keep path already
 * preserves). NOT yet verified correct for `walk_to_sit` (large, real forward
 * hip drift — zeroing it would produce an in-place moonwalk) — that clip is
 * deliberately not wired into ANIM_PATHS yet; see cove-interior.tsx /
 * vrm-character-animator.ts sit-flow comments.
 */
export function retargetMeshyClip(
  animation: MixamoGltf,
  vrm: VRM,
  clipName?: string,
): THREE.AnimationClip {
  return buildRetargetedClip(
    animation, vrm, meshyVRMRigMap, normalizeMeshyRigName, 'meshy-retarget', clipName,
  );
}
