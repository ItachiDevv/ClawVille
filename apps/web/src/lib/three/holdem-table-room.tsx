'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';
import { useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';
import { useVRMInstance, disposeVRMInstance } from '@/lib/three/vrm-loader';
import { preloadClips, VRMCharacterAnimator, type AnimName } from '@/lib/three/vrm-character-animator';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import { MODEL_REGISTRY, type ModelKey, type ModelRegistryEntry } from '@/lib/three/agent-model-registry';
import { TableCards3D, type TableCardLayout, type TableCardSeat } from '@/lib/three/cove-table-cards';
import { useHoldemController } from '@/lib/cove/holdem-controller';
import {
  getHoldemBadgeRegistryVersion,
  getHoldemSeatBadgeElement,
  getHoldemTableRecenterEpoch,
} from '@/lib/cove/holdem-table-view';

const ROOM_PATH = '/models/cove-room-only.glb';
const TABLE_PATH = '/models/cove-table-clean.glb';
// Stools, not tall-backed chairs (2026-07-16 headed verify): the chair
// model's high back is a solid black slab at this camera height — near-side
// chairs walled off the frame corners and the far-center chair completely
// hid the dealer. Stools keep every sight line open.
const STOOL_PATH = '/models/cove-stool.glb';
const TABLE_POSE_SAMPLE_AT = 0.02;
const TABLE_POSE_BY_BOT = [
  'cove_peek',
  'cove_think',
  'cove_watch',
  'cove_peek',
  'cove_rest',
] as const satisfies readonly AnimName[];
const PEEK_ENGINE_SEATS = [1, 4] as const;
preloadClips([...TABLE_POSE_BY_BOT, 'sit_idle_m']);

// SCALE UNIFICATION (2026-07-17 founder feedback): every figure renders at
// the SAME world-standard height the walkable cove uses for the player's
// own avatar (COVE_VRM_TARGET_HEIGHT = 160) — the earlier 108-bot/118-dealer
// mix read as "the dealer milady is a giant" and none of them matched the
// movable agent's scale. `S` converts avatar/stool constants authored at the
// original scale-2 basis. Round 8 grows only the table's XZ footprint.
const WORLD_AVATAR_HEIGHT = 160;
const CHIBI_TARGET_HEIGHT = 120;
const FURNITURE_SCALE = 2.9;
const S = FURNITURE_SCALE / 2;
const TABLE_FOOTPRINT_MULTIPLIER = 1.34;
const TABLE_FOOTPRINT_SCALE = S * TABLE_FOOTPRINT_MULTIPLIER;
const TABLE_XZ_SCALE = FURNITURE_SCALE * TABLE_FOOTPRINT_MULTIPLIER;
// The stool is authored on the S=1.45 layout basis. At this scale its seat
// disc top is y=52, matching the frozen-pose humanoid hips at y≈51.
const STOOL_SCALE = S;
const STOOL_SEAT_TOP_Y = 52;
// Room shell scaled with the furniture so wall/ceiling proportions track.
const ROOM_SCALE = 1.45;
// Preserve the approved Y scale and translate the visual top from 91.6 to
// elbow-height 70. Round 8's XZ-only growth cannot change this relationship.
const TABLE_SOURCE_TOP_Y = 63.2 * S;
const TABLE_TOP_Y = 70;
const TABLE_VISUAL_Y = TABLE_TOP_Y - TABLE_SOURCE_TOP_Y;
const BOT_TARGET_HEIGHT = WORLD_AVATAR_HEIGHT;
const DEALER_TARGET_HEIGHT = WORLD_AVATAR_HEIGHT;

interface RoomSeat extends TableCardSeat {
  chairX: number;
  chairZ: number;
}

// PLAYER-SEAT STAGING (Round 8): the POV remains at 6 o'clock and all five
// opponents move onto the enlarged table's far arc at 8/10/~12/2/4 o'clock.
// The arc apex bulges toward -Z; the flat edge runs along +Z.
// MEASURED ORIENTATION (2026-07-17, vertex-profile ground truth): the
// table's FLAT full-width edge is at +Z (251wu straight edge at the zMax
// extreme) and the players' arc tapers to -Z (72wu at zMin) — every prior
// round had the player parked on the flat/dealer side. Player (camera) now
// sits at the ARC APEX at -Z; bots take arc seats toward the flat corners;
// the DEALER stands at the +Z flat edge. Basis coords use the XZ footprint.
function roomSeat(engineSeatIndex: number, xBasis: number, zBasis: number): RoomSeat {
  const x = xBasis * TABLE_FOOTPRINT_SCALE;
  const z = zBasis * TABLE_FOOTPRINT_SCALE;
  return { engineSeatIndex, x, z, faceYaw: Math.atan2(-x, -z), chairX: x, chairZ: z };
}

// One authoritative center per body/stool/card/badge anchor. Seat 3 is biased
// 20 basis-wu left of exact 12 o'clock so the standing dealer stays readable.
// Adjacent gaps are >=128wu; default-eye bearings are -47.6/-31.7/-6.2/
// +31.7/+47.6 degrees, for a minimum angular separation of 15.9 degrees.
const BOT_SEATS: readonly RoomSeat[] = [
  roomSeat(1, -93.53, -33),
  roomSeat(2, -93.53, 33),
  roomSeat(3, -20, 66),
  roomSeat(4, 93.53, 33),
  roomSeat(5, 93.53, -33),
] as const;

// boardYaw π: the board row sits toward the dealer's flat side (+Z) and its
// faces must read upright to the player camera at -Z.
const CARD_LAYOUT: Readonly<TableCardLayout> = Object.freeze({
  boardX: 0,
  // Mid-felt (founder-praised placement) — after the table-mesh rotation
  // the old +14 offset visually landed the row at the far edge among the
  // bot backs.
  boardZ: 0,
  boardYaw: Math.PI,
  boardCardWidth: 8 * S,
  boardCardHeight: 11.2 * S,
  boardSpacing: 10 * TABLE_FOOTPRINT_SCALE,
  botCardWidth: 6.5 * S,
  botCardHeight: 9.1 * S,
  botPairGap: 1.2 * S,
  botAnchorScale: 0.72,
  surfaceLift: 0.7 * S,
});

// Card-player rotations are authored once on the clyt Meshy reference rig
// and retargeted to every humanoid VRM. Rigless GLBs use the perch path.
const DEFAULT_BOT_MODEL_KEYS = [
  'milady_official_2',
  'milady_official_5',
  'hermes_female',
  'milady_official_7',
  'milady_official_4',
] as const satisfies readonly ModelKey[];

function getSeatModelKeys(): readonly ModelKey[] {
  if (typeof window === 'undefined') return DEFAULT_BOT_MODEL_KEYS;
  const isLocalhost = window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1'
    || window.location.hostname === '[::1]';
  if (process.env.NODE_ENV === 'production' && !isLocalhost) return DEFAULT_BOT_MODEL_KEYS;
  const requested = new URLSearchParams(window.location.search)
    .get('seatModels')
    ?.split(',')
    .map((key) => key.trim());
  if (!requested?.length) return DEFAULT_BOT_MODEL_KEYS;
  return BOT_SEATS.map((_, index) => {
    const requestedKey = requested[index];
    return requestedKey && requestedKey in MODEL_REGISTRY
      ? requestedKey as ModelKey
      : DEFAULT_BOT_MODEL_KEYS[index]!;
  });
}

const BOT_MODEL_KEYS = getSeatModelKeys();
const FORCE_PEEK_CARDS = (() => {
  if (typeof window === 'undefined') return false;
  const isLocalhost = window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1'
    || window.location.hostname === '[::1]';
  return (process.env.NODE_ENV !== 'production' || isLocalhost)
    && new URLSearchParams(window.location.search).get('seatCards') === '1';
})();
const DEALER_MODEL_KEY = 'milady_official_6' as const;

interface HandPoseSample {
  left: readonly [number, number, number];
  right: readonly [number, number, number];
}

type HandSampleHandler = (engineSeatIndex: number, sample: HandPoseSample | null) => void;

const HAND_SAMPLE_LEFT = new THREE.Vector3();
const HAND_SAMPLE_RIGHT = new THREE.Vector3();
const HIP_SAMPLE = new THREE.Vector3();
const SCALE100_SEATED_THIGH_QUAT = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  THREE.MathUtils.degToRad(-90),
);
const SCALE100_SEATED_KNEE_QUAT = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  THREE.MathUtils.degToRad(90),
);
const MANUAL_SEATED_SPINE_FORWARD_QUAT = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(THREE.MathUtils.degToRad(8), 0, 0),
);
const MANUAL_SEATED_HEAD_LEVEL_QUAT = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(THREE.MathUtils.degToRad(-5), 0, 0),
);
const MANUAL_SEATED_LEFT_UPPER_ARM_QUAT = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(0, THREE.MathUtils.degToRad(-18), THREE.MathUtils.degToRad(-64)),
);
const MANUAL_SEATED_RIGHT_UPPER_ARM_QUAT = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(0, THREE.MathUtils.degToRad(18), THREE.MathUtils.degToRad(64)),
);
const MANUAL_SEATED_LEFT_LOWER_ARM_QUAT = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(0, THREE.MathUtils.degToRad(-78), 0),
);
const MANUAL_SEATED_RIGHT_LOWER_ARM_QUAT = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(0, THREE.MathUtils.degToRad(78), 0),
);
const MANUAL_SEATED_NEUTRAL_HAND_QUAT = new THREE.Quaternion();

interface PerchProfile {
  baselineMultiplier: number;
  minDimension: number;
  maxDimension: number;
  outwardOffset: number;
  seatOffsetY: number;
}

// Rigless assets have radically different source proportions: a crustacean's
// longest axis is horizontal while the seahorse's is vertical. Registry scale
// stays the starting point, then these bounded display profiles keep broad
// shells behind the rail and let the narrow seahorse read as a table player.
const DEFAULT_PERCH_PROFILE: Readonly<PerchProfile> = Object.freeze({
  baselineMultiplier: 3,
  minDimension: 42,
  maxDimension: 50,
  outwardOffset: 3,
  seatOffsetY: 0,
});
const PERCH_PROFILE_BY_MODEL: Readonly<Partial<Record<ModelKey, Readonly<PerchProfile>>>> = Object.freeze({
  lobster: { baselineMultiplier: 3, minDimension: 44, maxDimension: 50, outwardOffset: 6, seatOffsetY: 0 },
  sweet_crab: { baselineMultiplier: 3, minDimension: 42, maxDimension: 46, outwardOffset: 7, seatOffsetY: 0 },
  lobster_plush: { baselineMultiplier: 3, minDimension: 42, maxDimension: 46, outwardOffset: 7, seatOffsetY: 0 },
  hermitcrab: { baselineMultiplier: 3, minDimension: 42, maxDimension: 46, outwardOffset: 6, seatOffsetY: 0 },
  jellyfish: { baselineMultiplier: 3, minDimension: 42, maxDimension: 48, outwardOffset: 2, seatOffsetY: -18 },
  octopus: { baselineMultiplier: 3, minDimension: 44, maxDimension: 50, outwardOffset: 4, seatOffsetY: 0 },
  seahorse: { baselineMultiplier: 9, minDimension: 108, maxDimension: 116, outwardOffset: 2, seatOffsetY: -50 },
});

function sampleHands(
  leftHand: THREE.Object3D | null | undefined,
  rightHand: THREE.Object3D | null | undefined,
): HandPoseSample | null {
  if (!leftHand || !rightHand) return null;
  leftHand.getWorldPosition(HAND_SAMPLE_LEFT);
  rightHand.getWorldPosition(HAND_SAMPLE_RIGHT);
  const values = [HAND_SAMPLE_LEFT.x, HAND_SAMPLE_LEFT.y, HAND_SAMPLE_LEFT.z,
    HAND_SAMPLE_RIGHT.x, HAND_SAMPLE_RIGHT.y, HAND_SAMPLE_RIGHT.z];
  if (!values.every(Number.isFinite)) return null;
  return {
    left: [HAND_SAMPLE_LEFT.x, HAND_SAMPLE_LEFT.y, HAND_SAMPLE_LEFT.z],
    right: [HAND_SAMPLE_RIGHT.x, HAND_SAMPLE_RIGHT.y, HAND_SAMPLE_RIGHT.z],
  };
}

function preparedClone(
  source: THREE.Group,
  scale: number | readonly [number, number, number],
): THREE.Group {
  const clone = source.clone(true);
  const bounds = new THREE.Box3().setFromObject(clone);
  const center = bounds.getCenter(new THREE.Vector3());
  const [scaleX, scaleY, scaleZ] = typeof scale === 'number' ? [scale, scale, scale] : scale;
  clone.scale.set(scaleX, scaleY, scaleZ);
  clone.position.set(-center.x * scaleX, -bounds.min.y * scaleY, -center.z * scaleZ);
  clone.updateMatrixWorld(true);
  return clone;
}

function preparedPerchClone(
  source: THREE.Group,
  registryScale: number,
  profile: Readonly<PerchProfile>,
): THREE.Group {
  const clone = skeletonClone(source) as THREE.Group;
  const bounds = new THREE.Box3().setFromObject(clone);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const baselineMaxDimension = Math.max(size.x, size.y, size.z) * registryScale;
  const perchedMaxDimension = THREE.MathUtils.clamp(
    baselineMaxDimension * profile.baselineMultiplier,
    profile.minDimension,
    profile.maxDimension,
  );
  const scale = perchedMaxDimension / Math.max(size.x, size.y, size.z, 0.001);
  clone.scale.setScalar(scale);
  clone.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
  clone.updateMatrixWorld(true);
  return clone;
}

function FrozenFigure({
  reg,
  instanceId,
  pose,
  position,
  yaw,
  targetHeight,
  cushionY,
  sampleAt = 0.0001,
  freezeVia = 'sample',
  manualSeat = false,
  relaxManualUpperBody = false,
  handSampleSeat,
  onHandSample,
}: {
  reg: ModelRegistryEntry;
  instanceId: string;
  pose: AnimName;
  position: readonly [number, number, number];
  yaw: number;
  targetHeight: number;
  cushionY?: number;
  /** Clip time (seconds) to freeze at — per-rig frames read differently. */
  sampleAt?: number;
  /** 'sample' applies one direct clip sample. 'transition' remains available
   *  for seated flows that need the complete stand-to-sit sequence. */
  freezeVia?: 'sample' | 'transition';
  /** Scale-100 Hermes-family fallback: keep the calm upper-body sample, then
   * apply the verified normalized-bone seated legs and pin hips to the stool. */
  manualSeat?: boolean;
  /** Polish the scale-100 sampled fallback toward a natural table posture.
   * Chibi idle and rigless perch paths deliberately do not use this. */
  relaxManualUpperBody?: boolean;
  handSampleSeat?: number;
  onHandSample?: HandSampleHandler;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const vrm = useVRMInstance(reg.path, instanceId);
  const { invalidate } = useThree();
  const fit = useMemo(
    () => computeVRMAvatarFit(vrm, reg.animatorId, targetHeight),
    [reg.animatorId, targetHeight, vrm],
  );

  useEffect(() => {
    const group = groupRef.current;
    if (!vrm || !group) return;
    let cancelled = false;
    const animator = new VRMCharacterAnimator(vrm, reg.animatorId);

    const freeze = async (): Promise<boolean> => {
      if (manualSeat) {
        await animator.init(pose);
        if (cancelled || !animator.applyFrozenPose(pose, sampleAt)) return false;
        const humanoid = vrm.humanoid;
        const leftUpperLeg = humanoid?.getNormalizedBoneNode('leftUpperLeg');
        const rightUpperLeg = humanoid?.getNormalizedBoneNode('rightUpperLeg');
        const leftLowerLeg = humanoid?.getNormalizedBoneNode('leftLowerLeg');
        const rightLowerLeg = humanoid?.getNormalizedBoneNode('rightLowerLeg');
        if (!humanoid || !leftUpperLeg || !rightUpperLeg || !leftLowerLeg || !rightLowerLeg) return false;
        leftUpperLeg.quaternion.copy(SCALE100_SEATED_THIGH_QUAT);
        rightUpperLeg.quaternion.copy(SCALE100_SEATED_THIGH_QUAT);
        leftLowerLeg.quaternion.copy(SCALE100_SEATED_KNEE_QUAT);
        rightLowerLeg.quaternion.copy(SCALE100_SEATED_KNEE_QUAT);
        if (relaxManualUpperBody) {
          humanoid.getNormalizedBoneNode('spine')?.quaternion.multiply(MANUAL_SEATED_SPINE_FORWARD_QUAT);
          humanoid.getNormalizedBoneNode('head')?.quaternion.multiply(MANUAL_SEATED_HEAD_LEVEL_QUAT);
          humanoid.getNormalizedBoneNode('leftUpperArm')?.quaternion.slerp(MANUAL_SEATED_LEFT_UPPER_ARM_QUAT, 0.88);
          humanoid.getNormalizedBoneNode('rightUpperArm')?.quaternion.slerp(MANUAL_SEATED_RIGHT_UPPER_ARM_QUAT, 0.88);
          humanoid.getNormalizedBoneNode('leftLowerArm')?.quaternion.copy(MANUAL_SEATED_LEFT_LOWER_ARM_QUAT);
          humanoid.getNormalizedBoneNode('rightLowerArm')?.quaternion.copy(MANUAL_SEATED_RIGHT_LOWER_ARM_QUAT);
          humanoid.getNormalizedBoneNode('leftHand')?.quaternion.slerp(MANUAL_SEATED_NEUTRAL_HAND_QUAT, 0.72);
          humanoid.getNormalizedBoneNode('rightHand')?.quaternion.slerp(MANUAL_SEATED_NEUTRAL_HAND_QUAT, 0.72);
        }
        humanoid.update();
        vrm.scene.updateMatrixWorld(true);
        animator.flushSkeletonUpdates();
        return true;
      }
      if (freezeVia === 'transition') {
        // Simulate the approved sit-down: idle base -> stand_to_sit one-shot
        // chaining into the hold pose, ticked synchronously (~5s of sim at
        // 30Hz — a one-time ~160-iteration burst, no per-frame cost after).
        await animator.init('idle');
        if (cancelled) return false;
        await animator.playOneShot('sit_stand_to_sit', pose, 1.5);
        if (cancelled) return false;
        const totalSim = 4.8 / 1.5 + sampleAt;
        const step = 1 / 30;
        for (let t = 0; t < totalSim; t += step) animator.update(step, false, false);
        animator.flushSkeletonUpdates();
        return true;
      }
      await animator.init(pose);
      if (cancelled) return false;
      return animator.applyFrozenPose(pose, sampleAt);
    };

    void freeze().then((ok) => {
      if (cancelled || !ok) return;
      group.updateMatrixWorld(true);

      // Ground the POSED figure by its real bounding box. The first cut
      // anchored hips to a cushion constant, but the retargeted clip's own
      // hip translation made that shift wildly over-drop: the headed verify
      // (2026-07-16) measured all five bots 26wu below the floor and the
      // dealer buried to the waist (-44). Feet-on-floor is the one invariant
      // every figure shares; the chair is then aligned to the body, not the
      // body to the chair.
      if (manualSeat) {
        const hips = vrm.humanoid?.getRawBoneNode('hips');
        if (!hips) return;
        hips.getWorldPosition(HIP_SAMPLE);
        vrm.scene.position.y += STOOL_SEAT_TOP_Y - HIP_SAMPLE.y;
      } else {
        const bbox = new THREE.Box3().setFromObject(vrm.scene);
        vrm.scene.position.y += -bbox.min.y;
      }
      vrm.scene.updateMatrixWorld(true);
      animator.flushSkeletonUpdates();
      group.updateMatrixWorld(true);
      if (handSampleSeat !== undefined && onHandSample) {
        onHandSample(handSampleSeat, sampleHands(
          vrm.humanoid?.getRawBoneNode('leftHand'),
          vrm.humanoid?.getRawBoneNode('rightHand'),
        ));
      }

      if (process.env.NODE_ENV !== 'production') {
        const hips = vrm.humanoid?.getRawBoneNode('hips');
        const hipY = hips?.getWorldPosition(new THREE.Vector3()).y;
        console.info(
          `[HoldemTableRoom] ${instanceId} grounded: hipY=${hipY?.toFixed(1)}` +
          (cushionY !== undefined ? ` (chair cushion const ${cushionY})` : ' (standing)'),
        );
        const leftHand = vrm.humanoid?.getRawBoneNode('leftHand')?.getWorldPosition(new THREE.Vector3());
        const rightHand = vrm.humanoid?.getRawBoneNode('rightHand')?.getWorldPosition(new THREE.Vector3());
        const leftShoulder = vrm.humanoid?.getRawBoneNode('leftShoulder')?.getWorldPosition(new THREE.Vector3());
        const rightShoulder = vrm.humanoid?.getRawBoneNode('rightShoulder')?.getWorldPosition(new THREE.Vector3());
        console.assert(
          (!leftHand || !leftShoulder || leftHand.y < leftShoulder.y) &&
          (!rightHand || !rightShoulder || rightHand.y < rightShoulder.y),
          `[HoldemTableRoom] ${instanceId} frozen hands are not below shoulders`,
        );
      }
      invalidate();
    });

    return () => {
      cancelled = true;
      animator.dispose();
    };
  }, [cushionY, freezeVia, handSampleSeat, instanceId, invalidate, manualSeat, onHandSample, pose, reg.animatorId, relaxManualUpperBody, sampleAt, vrm]);

  useEffect(() => () => disposeVRMInstance(reg.path, instanceId), [instanceId, reg.path]);

  return (
    <group ref={groupRef} name={instanceId} position={position} rotation={[0, yaw, 0]}>
      <primitive
        object={vrm.scene}
        scale={[fit.scale, fit.scale, fit.scale]}
        position={[0, fit.offsetY, 0]}
      />
    </group>
  );
}

// FIRST-PERSON seated POV (founder spec 2026-07-17): the camera is the
// player avatar's EYES at the 6-o'clock seat — seated eye height for a
// 160wu body, just behind the near rail, gazing slightly down across the
// felt at the standing dealer. Neighbors appear at the frame edges the way
// they do from a real seat.
interface PoseAuditView {
  seat: number;
  eye: readonly [number, number, number];
  look: readonly [number, number, number];
}

/** Query-gated verification camera used only for the mandatory front+side
 * evidence set (`?poseSeat=1..5&poseView=front|side`). It reuses the real
 * SeatedLookCamera and room lighting while isolating one figure. */
const POSE_AUDIT_VIEW: PoseAuditView | null = (() => {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const seatIndex = Number(params.get('poseSeat'));
  const view = params.get('poseView');
  const seat = BOT_SEATS.find((candidate) => candidate.engineSeatIndex === seatIndex);
  if (!seat || (view !== 'front' && view !== 'side')) return null;
  const distance = view === 'front' ? 165 : 150;
  const forwardX = Math.sin(seat.faceYaw);
  const forwardZ = Math.cos(seat.faceYaw);
  const eyeX = view === 'front'
    ? seat.chairX + forwardX * distance
    : seat.chairX + Math.cos(seat.faceYaw) * distance;
  const eyeZ = view === 'front'
    ? seat.chairZ + forwardZ * distance
    : seat.chairZ - Math.sin(seat.faceYaw) * distance;
  return {
    seat: seat.engineSeatIndex,
    eye: [eyeX, TABLE_TOP_Y + 58, eyeZ],
    look: [seat.chairX, TABLE_TOP_Y + 5, seat.chairZ],
  };
})();

// Round 8 raises and pulls back the seated eye. The 66-degree lens contains
// both extreme shoulders without fisheye looming while the low aim preserves
// the felt-level first-person read.
const CAM_EYE: readonly [number, number, number] = POSE_AUDIT_VIEW?.eye ?? [0, TABLE_TOP_Y + 78, -230];
const CAM_LOOK: readonly [number, number, number] = POSE_AUDIT_VIEW?.look ?? [0, TABLE_TOP_Y + 16, 36 * TABLE_FOOTPRINT_SCALE];
const CAMERA_FOV = POSE_AUDIT_VIEW ? 48 : 66;

const LOOK_YAW_LIMIT = THREE.MathUtils.degToRad(75);
const LOOK_YAW_SPEED = THREE.MathUtils.degToRad(92);
const LOOK_EASE = 9;
const BASE_LOOK_DX = CAM_LOOK[0] - CAM_EYE[0];
const BASE_LOOK_DY = CAM_LOOK[1] - CAM_EYE[1];
const BASE_LOOK_DZ = CAM_LOOK[2] - CAM_EYE[2];
const BASE_LOOK_HORIZONTAL = Math.hypot(BASE_LOOK_DX, BASE_LOOK_DZ);
const BASE_LOOK_DISTANCE = Math.hypot(BASE_LOOK_DX, BASE_LOOK_DY, BASE_LOOK_DZ);
const BASE_LOOK_YAW = Math.atan2(BASE_LOOK_DX, BASE_LOOK_DZ);
const BASE_LOOK_PITCH = Math.atan2(BASE_LOOK_DY, BASE_LOOK_HORIZONTAL);
const BASE_LOOK_COS_PITCH = Math.cos(BASE_LOOK_PITCH);
const BASE_LOOK_SIN_PITCH = Math.sin(BASE_LOOK_PITCH);

const BADGE_TABLEWARD_OFFSET = 52 * S;
function tablewardBadgeAnchor(
  seat: RoomSeat,
  y: number,
): readonly [number, number, number] {
  const distance = Math.hypot(seat.x, seat.z);
  return [
    seat.x - (seat.x / distance) * BADGE_TABLEWARD_OFFSET,
    y,
    seat.z - (seat.z / distance) * BADGE_TABLEWARD_OFFSET,
  ];
}

/** Six static world anchors. Seat 0 stays in the screen-fixed private tray.
 * Opponent labels sit between torso and table, with a symmetric fixed height
 * stagger so projected neighbors cannot collapse into one stack. */
const SEAT_BADGE_WORLD_ANCHORS: readonly (readonly [number, number, number])[] = [
  [0, TABLE_TOP_Y + 14, -45 * TABLE_FOOTPRINT_SCALE],
  tablewardBadgeAnchor(BOT_SEATS[0]!, TABLE_TOP_Y + 25),
  tablewardBadgeAnchor(BOT_SEATS[1]!, TABLE_TOP_Y + 34),
  tablewardBadgeAnchor(BOT_SEATS[2]!, TABLE_TOP_Y + 5),
  tablewardBadgeAnchor(BOT_SEATS[3]!, TABLE_TOP_Y + 34),
  tablewardBadgeAnchor(BOT_SEATS[4]!, TABLE_TOP_Y + 25),
] as const;

// Module-scope scratch only: the yaw loop never allocates Three.js objects.
const CAMERA_LOOK_TARGET = new THREE.Vector3();
const BADGE_PROJECT_SCRATCH = new THREE.Vector3();
const BADGE_VIEW_PROJECTION = new THREE.Matrix4();

let handCardBackTextureCache: THREE.CanvasTexture | null = null;
function getHandCardBackTexture(): THREE.CanvasTexture {
  if (handCardBackTextureCache) return handCardBackTextureCache;
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, 192, 256);
  gradient.addColorStop(0, '#0d3a4a');
  gradient.addColorStop(1, '#0a2d3a');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 192, 256);
  context.strokeStyle = 'rgba(0, 200, 180, 0.32)';
  context.lineWidth = 7;
  context.strokeRect(8, 8, 176, 240);
  context.strokeStyle = 'rgba(0, 200, 180, 0.18)';
  context.lineWidth = 4;
  context.strokeRect(22, 22, 148, 212);
  context.fillStyle = 'rgba(0, 200, 180, 0.22)';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = '800 92px ui-monospace, Consolas, monospace';
  context.fillText('?', 96, 132);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  handCardBackTextureCache = texture;
  return texture;
}

function PeekHandCards({ seat, sample }: { seat: RoomSeat; sample: HandPoseSample }) {
  const texture = useMemo(() => getHandCardBackTexture(), []);
  const center = useMemo(() => [
    (sample.left[0] + sample.right[0]) / 2 + Math.sin(seat.faceYaw) * 4,
    (sample.left[1] + sample.right[1]) / 2 + 2.5,
    (sample.left[2] + sample.right[2]) / 2 + Math.cos(seat.faceYaw) * 4,
  ] as const, [sample, seat.faceYaw]);
  const cardWidth = CARD_LAYOUT.botCardWidth * 0.72;
  const cardHeight = CARD_LAYOUT.botCardHeight * 0.72;
  return (
    <group position={center} rotation={[0, seat.faceYaw, 0]}>
      {([-1, 1] as const).map((fan, index) => (
        <mesh
          key={`peek-card-${seat.engineSeatIndex}-${index}`}
          position={[fan * cardWidth * 0.34, fan * 0.12, 0]}
          rotation={[THREE.MathUtils.degToRad(-8), 0, THREE.MathUtils.degToRad(fan * 9)]}
        >
          <planeGeometry args={[cardWidth, cardHeight]} />
          <meshBasicMaterial map={texture} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function RiglessPerchFigure({
  reg,
  modelKey,
  position,
  yaw,
}: {
  reg: ModelRegistryEntry;
  modelKey: ModelKey;
  position: readonly [number, number, number];
  yaw: number;
}) {
  const gltf = useGLTFWithKTX2(reg.path);
  const profile = PERCH_PROFILE_BY_MODEL[modelKey] ?? DEFAULT_PERCH_PROFILE;
  const perch = useMemo(
    () => preparedPerchClone(gltf.scene, reg.scale, profile),
    [gltf.scene, profile, reg.scale],
  );
  const outwardX = Math.sin(yaw) * profile.outwardOffset;
  const outwardZ = Math.cos(yaw) * profile.outwardOffset;

  return (
    <group
      name={`holdem-avatar-${modelKey}`}
      position={[
        position[0] - outwardX,
        position[1] + STOOL_SEAT_TOP_Y + profile.seatOffsetY,
        position[2] - outwardZ,
      ]}
      rotation={[0, yaw, 0]}
    >
      <primitive object={perch} />
    </group>
  );
}

let dealerPlateCache: THREE.CanvasTexture | null = null;
function getDealerPlate(): THREE.CanvasTexture {
  if (dealerPlateCache) return dealerPlateCache;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(10, 14, 16, 0.88)';
  ctx.beginPath();
  (ctx as CanvasRenderingContext2D & { roundRect?: (...a: number[]) => void }).roundRect?.(6, 6, 500, 116, 28);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 205, 120, 0.85)';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = '#ffd88a';
  ctx.font = '700 64px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('DEALER', 256, 68);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  dealerPlateCache = tex;
  return tex;
}

/** Floating DEALER nameplate above the dealer's head, facing the player
 *  camera (founder item 4: make it obvious who the dealer is). */
function DealerPlate({ position }: { position: readonly [number, number, number] }) {
  const tex = useMemo(() => getDealerPlate(), []);
  return (
    <mesh position={[position[0], position[1], position[2]]} rotation={[0, Math.PI, 0]}>
      <planeGeometry args={[52, 13]} />
      <meshBasicMaterial map={tex} transparent toneMapped={false} />
    </mesh>
  );
}

function SeatedLookCamera() {
  const { camera, size } = useThree();
  const heldRef = useRef({ left: false, right: false });
  const viewRef = useRef({
    yaw: 0,
    targetYaw: 0,
    snapCenter: true,
    lastProjectedYaw: Number.NaN,
    lastWidth: 0,
    lastHeight: 0,
    badgeVersion: -1,
    recenterEpoch: getHoldemTableRecenterEpoch(),
  });

  useEffect(() => {
    camera.position.set(...CAM_EYE);
    camera.lookAt(...CAM_LOOK);
    camera.updateProjectionMatrix();

    if (POSE_AUDIT_VIEW) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) return;
      if (event.key === 'ArrowLeft') {
        heldRef.current.left = true;
        event.preventDefault();
      } else if (event.key === 'ArrowRight') {
        heldRef.current.right = true;
        event.preventDefault();
      } else if (event.key === 'Home') {
        viewRef.current.targetYaw = 0;
        viewRef.current.snapCenter = true;
        event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') heldRef.current.left = false;
      else if (event.key === 'ArrowRight') heldRef.current.right = false;
    };
    const onBlur = () => {
      heldRef.current.left = false;
      heldRef.current.right = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [camera]);

  useFrame((_, delta) => {
    if (POSE_AUDIT_VIEW) return;
    const view = viewRef.current;
    const held = heldRef.current;
    const recenterEpoch = getHoldemTableRecenterEpoch();
    if (recenterEpoch !== view.recenterEpoch) {
      view.recenterEpoch = recenterEpoch;
      view.targetYaw = 0;
    }

    const lookDirection = Number(held.left) - Number(held.right);
    if (lookDirection !== 0) {
      view.targetYaw = THREE.MathUtils.clamp(
        view.targetYaw + lookDirection * LOOK_YAW_SPEED * Math.min(delta, 0.05),
        -LOOK_YAW_LIMIT,
        LOOK_YAW_LIMIT,
      );
    }

    if (view.snapCenter) {
      view.snapCenter = false;
      view.yaw = 0;
      view.targetYaw = 0;
    } else {
      const ease = 1 - Math.exp(-LOOK_EASE * Math.min(delta, 0.05));
      view.yaw += (view.targetYaw - view.yaw) * ease;
      if (Math.abs(view.targetYaw - view.yaw) < 0.00005) view.yaw = view.targetYaw;
    }

    const badgeVersion = getHoldemBadgeRegistryVersion();
    const cameraChanged = view.yaw !== view.lastProjectedYaw;
    const viewportChanged = size.width !== view.lastWidth || size.height !== view.lastHeight;
    const registryChanged = badgeVersion !== view.badgeVersion;
    if (!cameraChanged && !viewportChanged && !registryChanged) return;

    view.lastProjectedYaw = view.yaw;
    view.lastWidth = size.width;
    view.lastHeight = size.height;
    view.badgeVersion = badgeVersion;

    const lookYaw = BASE_LOOK_YAW + view.yaw;
    CAMERA_LOOK_TARGET.set(
      CAM_EYE[0] + Math.sin(lookYaw) * BASE_LOOK_COS_PITCH * BASE_LOOK_DISTANCE,
      CAM_EYE[1] + BASE_LOOK_SIN_PITCH * BASE_LOOK_DISTANCE,
      CAM_EYE[2] + Math.cos(lookYaw) * BASE_LOOK_COS_PITCH * BASE_LOOK_DISTANCE,
    );
    camera.position.set(...CAM_EYE);
    camera.lookAt(CAMERA_LOOK_TARGET);
    camera.updateMatrixWorld();

    BADGE_VIEW_PROJECTION.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    for (let seat = 0; seat < SEAT_BADGE_WORLD_ANCHORS.length; seat += 1) {
      const element = getHoldemSeatBadgeElement(seat);
      if (!element) continue;
      const anchor = SEAT_BADGE_WORLD_ANCHORS[seat]!;
      BADGE_PROJECT_SCRATCH.set(anchor[0], anchor[1], anchor[2]).applyMatrix4(BADGE_VIEW_PROJECTION);
      const left = (BADGE_PROJECT_SCRATCH.x * 0.5 + 0.5) * size.width;
      const top = (-BADGE_PROJECT_SCRATCH.y * 0.5 + 0.5) * size.height + 10;
      const visible = BADGE_PROJECT_SCRATCH.z > -1
        && BADGE_PROJECT_SCRATCH.z < 1
        && left > 58
        && left < size.width - 58
        && top > 44
        && top < size.height - 84;
      element.style.left = left + 'px';
      element.style.top = top + 'px';
      element.style.setProperty('--seat-visible', visible ? '1' : '0');
    }
  });

  return null;
}

function Precompile() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const renderer = gl as unknown as { compileAsync?: (s: THREE.Scene, c: THREE.Camera) => Promise<void> };
      void renderer.compileAsync?.(scene, camera).catch((error: unknown) => {
        console.warn('[HoldemTableRoom] pipeline precompile failed:', error);
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [camera, gl, scene]);
  return null;
}

function HoldemTableRoomScene() {
  const roomGltf = useGLTF(ROOM_PATH);
  const tableGltf = useGLTF(TABLE_PATH);
  const stoolGltf = useGLTF(STOOL_PATH);
  const room = useMemo(() => preparedClone(roomGltf.scene, ROOM_SCALE), [roomGltf.scene]);
  const table = useMemo(
    () => preparedClone(tableGltf.scene, [TABLE_XZ_SCALE, FURNITURE_SCALE, TABLE_XZ_SCALE]),
    [tableGltf.scene],
  );
  const chairs = useMemo(
    () => BOT_SEATS.map(() => preparedClone(stoolGltf.scene, STOOL_SCALE)),
    [stoolGltf.scene],
  );
  const phase = useHoldemController((state) => state.phase);
  const live = useHoldemController((state) => state.live);
  const publicSeats = useHoldemController((state) => state.seats);
  const [handSamples, setHandSamples] = useState<Readonly<Record<number, HandPoseSample | null>>>({});
  const onHandSample = useCallback<HandSampleHandler>((engineSeatIndex, sample) => {
    setHandSamples((current) => ({ ...current, [engineSeatIndex]: sample }));
  }, []);
  const inHandPeekSeats = useMemo(() => {
    if (FORCE_PEEK_CARDS) {
      return PEEK_ENGINE_SEATS.filter((engineSeatIndex) => handSamples[engineSeatIndex] != null);
    }
    if (!live || phase === 'idle' || phase === 'settled') return [];
    return PEEK_ENGINE_SEATS.filter((engineSeatIndex) => {
      const seat = publicSeats.find((candidate) => candidate.seatIndex === engineSeatIndex);
      return handSamples[engineSeatIndex] != null
        && seat?.status !== 'folded'
        && (seat?.holeCards?.length ?? 0) > 0;
    });
  }, [handSamples, live, phase, publicSeats]);

  return (
    <>
      <SeatedLookCamera />
      <ambientLight intensity={0.85} color={0xffe6cf} />
      <directionalLight position={[-70, 130, 80]} intensity={2.2} color={0xffd2a1} />
      <directionalLight position={[85, 85, 25]} intensity={1.35} color={0x7fd6ff} />
      <pointLight position={[0, 115, -55]} intensity={1150} distance={260} decay={2} color={0xffb86b} />
      {/* Dealer key — the dealer stands at the +Z flat edge; keep that
          zone lit or she reads as a silhouette. */}
      <pointLight position={[0, 150, 110]} intensity={900} distance={260} decay={2} color={0xffd9b0} />

      <primitive object={room} />
      {/* Procedural floor/backdrop guarantees a clean modal-like stage even
          where the extracted shell opens beyond the fixed camera frustum.
          Backdrop sits BEHIND THE DEALER (+Z, facing the camera at -Z) —
          after the perspective flip the old -Z plane sat behind the camera,
          leaving the shell's dark far-wall openings as black voids. */}
      <mesh position={[0, -0.5, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[700, 700]} />
        <meshStandardMaterial color={0x241a26} roughness={0.92} metalness={0.04} />
      </mesh>
      <mesh position={[0, 120, 185]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[800, 280]} />
        <meshStandardMaterial color={0x43283a} roughness={0.9} metalness={0.02} />
      </mesh>
      {/* Table unrotated: its baked dealer-station cutout faces -Z — which
          is where the dealer now STANDS (first-person restage). Betting
          spots face +Z, in front of the player camera and the near seats. */}
      <group position={[0, TABLE_VISUAL_Y, 0]}>
        <primitive object={table} />
      </group>

      {/* Scale-1.45 stools are the physical seat plane: disc top y=52 aligns
          to the frozen humanoid hips and anchors rigless perch avatars. */}
      {BOT_SEATS.map((seat, index) => {
        const modelKey = BOT_MODEL_KEYS[index]!;
        const reg = MODEL_REGISTRY[modelKey] as ModelRegistryEntry;
        const usesScale100SitFallback = reg.animatorId === 'hermes-female'
          || reg.animatorId === 'hermes-male'
          || reg.animatorId === 'tekk'
          || reg.animatorId === 'adinero';
        const usesChibiSitFallback = reg.animatorId === 'chibi';
        const usesManualSit = usesScale100SitFallback || usesChibiSitFallback;
        const handSampleSeat = PEEK_ENGINE_SEATS.some((value) => value === seat.engineSeatIndex)
          ? seat.engineSeatIndex
          : undefined;
        return (
          <group
            key={`holdem-seat-${seat.engineSeatIndex}`}
            name={`holdem-seat-${seat.engineSeatIndex}`}
            visible={!POSE_AUDIT_VIEW || POSE_AUDIT_VIEW.seat === seat.engineSeatIndex}
          >
            <group position={[seat.chairX, 0, seat.chairZ]} rotation={[0, seat.faceYaw, 0]}>
              <primitive object={chairs[index]!} />
            </group>
            {reg.avatar_type === 'glb' ? (
              <RiglessPerchFigure
                reg={reg}
                modelKey={modelKey}
                position={[seat.chairX, 0, seat.chairZ]}
                yaw={seat.faceYaw}
              />
            ) : (
              <FrozenFigure
                reg={reg}
                instanceId={`holdem-room-seat-${seat.engineSeatIndex}-${modelKey}`}
                pose={usesChibiSitFallback
                  ? 'idle'
                  : usesScale100SitFallback ? 'sit_idle_m' : TABLE_POSE_BY_BOT[index]!}
                position={[seat.chairX, 0, seat.chairZ]}
                yaw={seat.faceYaw}
                targetHeight={usesChibiSitFallback ? CHIBI_TARGET_HEIGHT : BOT_TARGET_HEIGHT}
                sampleAt={usesManualSit ? 0.2 : TABLE_POSE_SAMPLE_AT}
                manualSeat={usesManualSit}
                relaxManualUpperBody={usesScale100SitFallback}
                handSampleSeat={handSampleSeat}
                onHandSample={onHandSample}
              />
            )}
          </group>
        );
      })}

      {inHandPeekSeats.map((engineSeatIndex) => {
        const seat = BOT_SEATS.find((candidate) => candidate.engineSeatIndex === engineSeatIndex);
        const sample = handSamples[engineSeatIndex];
        return seat && sample
          ? <PeekHandCards key={`peek-hand-${engineSeatIndex}`} seat={seat} sample={sample} />
          : null;
      })}

      {/* Dealer STANDS at the MEASURED flat edge (+Z, the 251wu straight
          side), facing the player at the arc (-Z ⇒ yaw π). */}
      <group visible={!POSE_AUDIT_VIEW}>
        <FrozenFigure
          reg={MODEL_REGISTRY[DEALER_MODEL_KEY] as ModelRegistryEntry}
          instanceId="holdem-room-dealer"
          pose="idle"
          position={[0, 0, 78 * TABLE_FOOTPRINT_SCALE]}
          yaw={Math.PI}
          targetHeight={DEALER_TARGET_HEIGHT}
        />
        <DealerPlate position={[0, DEALER_TARGET_HEIGHT + 18, 78 * TABLE_FOOTPRINT_SCALE]} />
      </group>

      <TableCards3D
        centerX={0}
        centerZ={0}
        feltTopY={TABLE_TOP_Y}
        seats={BOT_SEATS}
        layout={CARD_LAYOUT}
        suppressSeatIndices={inHandPeekSeats}
      />
      <Precompile />
    </>
  );
}

export default function HoldemTableRoomCanvas() {
  return (
    <Canvas
      key="holdem-table-room"
      dpr={[0.65, 1]}
      frameloop="always"
      camera={{ fov: CAMERA_FOV, near: 0.5, far: 900, position: [CAM_EYE[0], CAM_EYE[1], CAM_EYE[2]] }}
      gl={{ antialias: false, powerPreference: 'low-power' }}
      onCreated={({ scene }) => { scene.background = new THREE.Color(0x100b16); }}
    >
      <KTX2LoaderSetup />
      <Suspense fallback={null}>
        <HoldemTableRoomScene />
      </Suspense>
    </Canvas>
  );
}

useGLTF.preload(ROOM_PATH);
useGLTF.preload(TABLE_PATH);
useGLTF.preload(STOOL_PATH);
