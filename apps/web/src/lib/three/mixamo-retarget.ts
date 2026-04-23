/**
 * mixamo-retarget.ts
 *
 * Retargets a Mixamo AnimationClip to a VRM humanoid skeleton.
 *
 * Mixamo bones are named `mixamorig:Hips`, `mixamorig:Head`, etc.
 * VRM humanoid bones use the VRMHumanBoneName enum (`hips`, `head`, etc.)
 * connected to arbitrary Object3D names in the actual scene graph.
 *
 * Strategy (the VRoid Studio published approach, adapted):
 *   1. Build a map: mixamoBoneName → VRM raw bone Object3D
 *   2. Walk every KeyframeTrack in the clip
 *   3. Parse the bone name from the track name (e.g. `mixamorig:Hips.quaternion`)
 *   4. Find the corresponding VRM raw bone node
 *   5. Rewrite the track name to target the VRM node's UUID path
 *   6. Return a new AnimationClip bound to the VRM's scene
 *
 * VRM 0.x models face -Z (same as +Z forward with a π rotation applied by
 * rotateVRM0). VRM 1.0 models face -Z natively. Both cases are handled because
 * we load and call VRMUtils.rotateVRM0() before retargeting, so the scene
 * rotation is already π for VRM 0 models.
 *
 * No allocations in the hot path — this function runs once at load time per
 * (VRM, AnimationClip) pair, not per frame.
 */

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

// ---------------------------------------------------------------------------
// Mixamo bone name → VRMHumanBoneName
// Canonical map published by the VRoid Studio team and community.
// mixamorig: prefix is stripped before lookup.
// ---------------------------------------------------------------------------

export const MIXAMO_TO_VRM_BONE: Record<string, string> = {
  // Core spine
  Hips:            'hips',
  Spine:           'spine',
  Spine1:          'chest',
  Spine2:          'upperChest',
  Neck:            'neck',
  Head:            'head',

  // Left leg
  LeftUpLeg:       'leftUpperLeg',
  LeftLeg:         'leftLowerLeg',
  LeftFoot:        'leftFoot',
  LeftToeBase:     'leftToes',

  // Right leg
  RightUpLeg:      'rightUpperLeg',
  RightLeg:        'rightLowerLeg',
  RightFoot:       'rightFoot',
  RightToeBase:    'rightToes',

  // Left arm
  LeftShoulder:    'leftShoulder',
  LeftArm:         'leftUpperArm',
  LeftForeArm:     'leftLowerArm',
  LeftHand:        'leftHand',

  // Right arm
  RightShoulder:   'rightShoulder',
  RightArm:        'rightUpperArm',
  RightForeArm:    'rightLowerArm',
  RightHand:       'rightHand',

  // Left hand fingers
  LeftHandThumb1:  'leftThumbMetacarpal',
  LeftHandThumb2:  'leftThumbProximal',
  LeftHandThumb3:  'leftThumbDistal',
  LeftHandIndex1:  'leftIndexProximal',
  LeftHandIndex2:  'leftIndexIntermediate',
  LeftHandIndex3:  'leftIndexDistal',
  LeftHandMiddle1: 'leftMiddleProximal',
  LeftHandMiddle2: 'leftMiddleIntermediate',
  LeftHandMiddle3: 'leftMiddleDistal',
  LeftHandRing1:   'leftRingProximal',
  LeftHandRing2:   'leftRingIntermediate',
  LeftHandRing3:   'leftRingDistal',
  LeftHandPinky1:  'leftLittleProximal',
  LeftHandPinky2:  'leftLittleIntermediate',
  LeftHandPinky3:  'leftLittleDistal',

  // Right hand fingers
  RightHandThumb1:  'rightThumbMetacarpal',
  RightHandThumb2:  'rightThumbProximal',
  RightHandThumb3:  'rightThumbDistal',
  RightHandIndex1:  'rightIndexProximal',
  RightHandIndex2:  'rightIndexIntermediate',
  RightHandIndex3:  'rightIndexDistal',
  RightHandMiddle1: 'rightMiddleProximal',
  RightHandMiddle2: 'rightMiddleIntermediate',
  RightHandMiddle3: 'rightMiddleDistal',
  RightHandRing1:   'rightRingProximal',
  RightHandRing2:   'rightRingIntermediate',
  RightHandRing3:   'rightRingDistal',
  RightHandPinky1:  'rightLittleProximal',
  RightHandPinky2:  'rightLittleIntermediate',
  RightHandPinky3:  'rightLittleDistal',
};

// Strip mixamorig: prefix variant — some Mixamo exports use `mixamorig:Hips`,
// others use `mixamorig_Hips` (underscore). Both are normalized.
function normalizeMixamoName(raw: string): string {
  return raw.replace(/^mixamorig[_:]/, '');
}

/**
 * Retarget a Mixamo AnimationClip to target a specific VRM instance.
 *
 * Returns null if no tracks could be retargeted (wrong clip format).
 *
 * The returned clip targets the VRM's raw humanoid bone nodes by UUID path
 * (e.g. `.bones[uuid=...]`). AnimationMixer must be created on `vrm.scene`.
 */
export function retargetMixamoClip(
  clip: THREE.AnimationClip,
  vrm: VRM,
): THREE.AnimationClip | null {
  const humanoid = vrm.humanoid;

  // IMPORTANT (@pixiv/three-vrm v3): use getNormalizedBoneNode, NOT getRawBoneNode.
  // In three-vrm v3, the animation system drives the *normalized* bone hierarchy
  // (Normalized_<name> nodes under VRMHumanoidRig). vrm.update() propagates the
  // normalized pose to raw bones each frame. Targeting raw bones directly is
  // bypassed by vrm.update() — the normalizer reads raw-bone rest poses and
  // overwrites them, so any mixer writes to raw bones are silently lost.
  // getNormalizedBoneNode returns the Normalized_* Object3D nodes which the mixer
  // CAN drive correctly. vrm.scene.getObjectByName("Normalized_mixamorigHips")
  // finds them since VRMHumanoidRig is a child of vrm.scene.
  const vrmBoneNodeByName = new Map<string, THREE.Object3D>();
  for (const boneName of Object.values(MIXAMO_TO_VRM_BONE)) {
    const node = humanoid.getNormalizedBoneNode(boneName as any);
    if (node) vrmBoneNodeByName.set(boneName, node);
  }

  const retargetedTracks: THREE.KeyframeTrack[] = [];

  for (const track of clip.tracks) {
    // Track names follow the pattern `BoneName.property` or
    // `BoneName.position` etc. The separator is always `.`.
    const dotIdx = track.name.lastIndexOf('.');
    if (dotIdx === -1) continue;

    const rawBonePart = track.name.slice(0, dotIdx);
    const property    = track.name.slice(dotIdx + 1);

    // Only handle quaternion (rotation) and position tracks — scale tracks
    // on root hips are skipped because they interfere with VRM rest-pose.
    if (property !== 'quaternion' && property !== 'position') continue;

    const simpleName   = normalizeMixamoName(rawBonePart);
    const vrmBoneName  = MIXAMO_TO_VRM_BONE[simpleName];
    if (!vrmBoneName) continue;

    const boneNode = vrmBoneNodeByName.get(vrmBoneName);
    if (!boneNode) continue;

    // Use the node's UUID to build an AnimationMixer-compatible path.
    // THREE.PropertyBinding resolves `.bones[uuid=<uuid>]` correctly.
    const newName = `${boneNode.name}.${property}`;

    // Clone the track with the new name but the same keyframe data.
    const newTrack = track.clone();
    newTrack.name = newName;

    retargetedTracks.push(newTrack);
  }

  if (retargetedTracks.length === 0) {
    console.warn('[mixamo-retarget] No tracks retargeted from clip:', clip.name);
    return null;
  }

  return new THREE.AnimationClip(clip.name, clip.duration, retargetedTracks);
}
