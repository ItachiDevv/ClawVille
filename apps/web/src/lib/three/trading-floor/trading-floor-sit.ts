import { Euler, Quaternion, type Object3D } from 'three';
import type { VRMHumanoid } from '@pixiv/three-vrm';

export const TRADING_FLOOR_SIT_NATIVE_SECONDS = 4.8;
export const TRADING_FLOOR_SIT_TIME_SCALE = 3.2;
export const TRADING_FLOOR_SIT_SECONDS = TRADING_FLOOR_SIT_NATIVE_SECONDS / TRADING_FLOOR_SIT_TIME_SCALE;
export const TRADING_FLOOR_EXIT_SECONDS = 6.233333 / TRADING_FLOOR_SIT_TIME_SCALE;
export const TRADING_FLOOR_MOVE_FADE_SECONDS = 0.2;

/** Same incompatible rig families as the hold'em room's manual seat path. */
export function tradingFloorManualSit(animatorId?: string): boolean {
  return animatorId === 'hermes-female' || animatorId === 'hermes-male'
    || animatorId === 'tekk' || animatorId === 'adinero' || animatorId === 'chibi';
}

export function tradingFloorStandRequested(
  seatedIndex: number, moving: boolean, escapeEdge: boolean, frozenPrev: boolean,
): boolean {
  return seatedIndex >= 0 && (moving || (escapeEdge && !frozenPrev));
}

const radians = Math.PI / 180;
// Room-local lap pose, in the normalized humanoid frame. No retarget policy change.
const leftArm = new Quaternion().setFromEuler(new Euler(0, -18 * radians, -64 * radians));
const rightArm = new Quaternion().setFromEuler(new Euler(0, 18 * radians, 64 * radians));
const leftElbow = new Quaternion().setFromEuler(new Euler(0, -78 * radians, 0));
const rightElbow = new Quaternion().setFromEuler(new Euler(0, 78 * radians, 0));
const mirroredLeftArm = new Quaternion().setFromEuler(new Euler(0, 18 * radians, 64 * radians));
const mirroredRightArm = new Quaternion().setFromEuler(new Euler(0, -18 * radians, -64 * radians));
const mirroredLeftElbow = new Quaternion().setFromEuler(new Euler(0, 78 * radians, 0));
const mirroredRightElbow = new Quaternion().setFromEuler(new Euler(0, -78 * radians, 0));
const neutral = new Quaternion();
const thigh = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0));
const knee = new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0));

export function tradingFloorSeatBones(humanoid: VRMHumanoid) {
  return {
    // Official VRM0 Miladys have left forearm along -X, unlike the hold'em
    // fallback rigs. Their arm-down rotation needs the opposite Y/Z signs.
    mirroredArms: (humanoid.getNormalizedBoneNode('leftLowerArm')?.position.x ?? 1) < 0,
    leftArm: humanoid.getNormalizedBoneNode('leftUpperArm'),
    rightArm: humanoid.getNormalizedBoneNode('rightUpperArm'),
    leftElbow: humanoid.getNormalizedBoneNode('leftLowerArm'),
    rightElbow: humanoid.getNormalizedBoneNode('rightLowerArm'),
    leftHand: humanoid.getNormalizedBoneNode('leftHand'),
    rightHand: humanoid.getNormalizedBoneNode('rightHand'),
    leftShoulder: humanoid.getNormalizedBoneNode('leftShoulder'),
    rightShoulder: humanoid.getNormalizedBoneNode('rightShoulder'),
    leftThigh: humanoid.getNormalizedBoneNode('leftUpperLeg'),
    rightThigh: humanoid.getNormalizedBoneNode('rightUpperLeg'),
    leftKnee: humanoid.getNormalizedBoneNode('leftLowerLeg'),
    rightKnee: humanoid.getNormalizedBoneNode('rightLowerLeg'),
  };
}

type SeatBones = ReturnType<typeof tradingFloorSeatBones>;
function pose(bone: Object3D | null, target: Quaternion, weight: number): void {
  bone?.quaternion.slerp(target, weight);
}

/** Call after the mixer, then propagate normalized bones and flush skeletons. */
export function applyTradingFloorSeatPose(bones: SeatBones, armWeight: number, manualSeat: boolean): void {
  if (armWeight > 0) {
    pose(bones.leftShoulder, neutral, armWeight);
    pose(bones.rightShoulder, neutral, armWeight);
    pose(bones.leftArm, bones.mirroredArms ? mirroredLeftArm : leftArm, armWeight);
    pose(bones.rightArm, bones.mirroredArms ? mirroredRightArm : rightArm, armWeight);
    pose(bones.leftElbow, bones.mirroredArms ? mirroredLeftElbow : leftElbow, armWeight);
    pose(bones.rightElbow, bones.mirroredArms ? mirroredRightElbow : rightElbow, armWeight);
    pose(bones.leftHand, neutral, armWeight);
    pose(bones.rightHand, neutral, armWeight);
  }
  if (manualSeat) {
    pose(bones.leftThigh, thigh, 1);
    pose(bones.rightThigh, thigh, 1);
    pose(bones.leftKnee, knee, 1);
    pose(bones.rightKnee, knee, 1);
  }
}
