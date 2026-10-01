import { Euler, Quaternion, type Object3D } from 'three';
import type { VRMHumanoid } from '@pixiv/three-vrm';

export const TRADING_FLOOR_SIT_NATIVE_SECONDS = 4.8;
export const TRADING_FLOOR_SIT_TIME_SCALE = 3.2;
export const TRADING_FLOOR_SIT_SECONDS = TRADING_FLOOR_SIT_NATIVE_SECONDS / TRADING_FLOOR_SIT_TIME_SCALE;
export const TRADING_FLOOR_EXIT_SECONDS = 6.233333 / TRADING_FLOOR_SIT_TIME_SCALE;
export const TRADING_FLOOR_MOVE_FADE_SECONDS = 0.2;
export const TRADING_FLOOR_ARM_FADE_SECONDS = 0.3;

/** Manual legs change instantly; their cushion correction must change with them. */
export function tradingFloorPinBlend(current: number, target: number, delta: number, clipOwner: boolean, fastStand: boolean): number {
  if (!clipOwner) return target;
  const seconds = target > 0 ? TRADING_FLOOR_SIT_SECONDS
    : fastStand ? TRADING_FLOOR_MOVE_FADE_SECONDS : TRADING_FLOOR_EXIT_SECONDS;
  return target > current ? Math.min(target, current + delta / seconds)
    : Math.max(target, current - delta / seconds);
}

/** Match clip crossfades, except the shorter movement stand. */
export function tradingFloorArmWeight(current: number, active: boolean, delta: number, fastStand: boolean): number {
  return active ? Math.min(1, current + delta / TRADING_FLOOR_ARM_FADE_SECONDS)
    : Math.max(0, current - delta / (fastStand ? TRADING_FLOOR_MOVE_FADE_SECONDS : TRADING_FLOOR_ARM_FADE_SECONDS));
}

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
// VRM0 normalized frames turn 180 degrees about Y: negate X/Z, retain Y.
const vrm0LeftArm = new Quaternion().setFromEuler(new Euler(0, -18 * radians, 64 * radians));
const vrm0RightArm = new Quaternion().setFromEuler(new Euler(0, 18 * radians, -64 * radians));
const neutral = new Quaternion();
const thigh = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0));
const knee = new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0));
const vrm0Thigh = new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0));
const vrm0Knee = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0));

export function tradingFloorSeatBones(humanoid: VRMHumanoid) {
  return {
    // Official VRM0 Miladys have left forearm along -X, a rotated basis.
    vrm0Basis: (humanoid.getNormalizedBoneNode('leftLowerArm')?.position.x ?? 1) < 0,
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
export function applyTradingFloorSeatPose(bones: SeatBones, armWeight: number, manualSeat: boolean, overrideArms = true): void {
  if (overrideArms && armWeight > 0) {
    pose(bones.leftShoulder, neutral, armWeight);
    pose(bones.rightShoulder, neutral, armWeight);
    pose(bones.leftArm, bones.vrm0Basis ? vrm0LeftArm : leftArm, armWeight);
    pose(bones.rightArm, bones.vrm0Basis ? vrm0RightArm : rightArm, armWeight);
    // Elbow Y stays unchanged in both bases; a mirrored Y bends behind the back.
    pose(bones.leftElbow, leftElbow, armWeight);
    pose(bones.rightElbow, rightElbow, armWeight);
    pose(bones.leftHand, neutral, armWeight);
    pose(bones.rightHand, neutral, armWeight);
  }
  if (manualSeat) {
    pose(bones.leftThigh, bones.vrm0Basis ? vrm0Thigh : thigh, 1);
    pose(bones.rightThigh, bones.vrm0Basis ? vrm0Thigh : thigh, 1);
    pose(bones.leftKnee, bones.vrm0Basis ? vrm0Knee : knee, 1);
    pose(bones.rightKnee, bones.vrm0Basis ? vrm0Knee : knee, 1);
  }
}
