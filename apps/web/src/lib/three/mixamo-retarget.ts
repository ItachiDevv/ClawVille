/**
 * mixamo-retarget.ts
 *
 * Retargets a Mixamo AnimationClip to a VRM humanoid skeleton.
 *
 * This is a direct port of Milady's retargetMixamoGltfToVrm (MIT-licensed):
 *   milady-ai/milady/packages/app-core/src/components/avatar/retargetMixamoGltfToVrm.ts
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
  animation.scene.updateMatrixWorld(true);
  vrm.scene.updateMatrixWorld(true);

  const sourceClip = animation.animations[0];
  if (!sourceClip) {
    throw new Error('[mixamo-retarget] GLB contains no animation clips');
  }

  const tracks: THREE.QuaternionKeyframeTrack[] = [];

  // Scratch quaternions — allocated once, reused across all bones/keyframes.
  const restRotationInverse      = new THREE.Quaternion();
  const parentRestWorldRotation  = new THREE.Quaternion();
  const q                        = new THREE.Quaternion();

  const vrm0 = isVrm0(vrm);

  // Compute hip position scale (vrmHipsHeight / motionHipsHeight) so that
  // the hip vertical bob in the clip lands at the VRM's hip height. Without
  // this the bob is in Mixamo-rig units (character ~1.5m tall) applied to a
  // VRM that may be taller/shorter → disproportionate vertical movement.
  const motionHipsNode = findNode(animation.scene, 'mixamorigHips', 'mixamorigHips');
  const motionHipsHeight = Math.abs(motionHipsNode?.position.y ?? 0);
  const vrmHipsHeight = Math.abs(
    (vrm.humanoid as any)?.normalizedRestPose?.hips?.position?.[1] ?? 0,
  );
  const hipsPositionScale =
    motionHipsHeight > 1e-6 && vrmHipsHeight > 1e-6
      ? vrmHipsHeight / motionHipsHeight
      : 1;

  for (const track of sourceClip.tracks) {
    const parts        = track.name.split('.');
    const rawRigName   = parts[0];
    const propertyName = parts[1];
    if (!rawRigName || !propertyName) continue;

    const normalizedRigName = normalizeMixamoRigName(rawRigName);
    const vrmBoneName       = mixamoVRMRigMap[normalizedRigName];
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

    // Position tracks (typically only on hips): scale by hipsPositionScale +
    // VRM 0.x coord flip (negate X & Z, keep Y). This is the natural body-bob
    // during walk/idle — without it, hips stay frozen, spring-bones (hair/skirt)
    // don't get the vertical shock they need to swing naturally, and the
    // character visually glides stiffly instead of bouncing.
    //
    // Ported verbatim from Milady's retargetMixamoGltfToVrm.ts (MIT).
    if (propertyName === 'position' && track instanceof THREE.VectorKeyframeTrack) {
      const values = track.values.map(
        (v, i) => (vrm0 && i % 3 !== 1 ? -v : v) * hipsPositionScale,
      );
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
      `[mixamo-retarget] Retargeting failed: no hips bone track found ` +
        `(mapped ${tracks.length} tracks total). ` +
        'Expected Mixamo bone names like mixamorigHips / mixamorigSpine...',
    );
  }

  const name = clipName ?? sourceClip.name ?? 'retargeted';
  const clip = new THREE.AnimationClip(name, sourceClip.duration, tracks);
  clip.optimize();
  return clip;
}
