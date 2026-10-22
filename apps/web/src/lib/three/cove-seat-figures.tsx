'use client';

/**
 * Seated cove table figures, shared by the hold'em room
 * (`holdem-table-room.tsx`) and the baccarat room (`baccarat-table-room.tsx`).
 * Moved verbatim from `holdem-table-room.tsx` (2026-10-22, shared-table
 * baccarat port spec section 7.4). This module has NO module-level side
 * effects (no `preloadClips`, no `useGLTF.preload`): each room preloads its
 * own assets, so importing it never loads the other room's files.
 * Node names keep the original `holdem-*` prefix (tests and scene probes
 * assert on them); the hold'em room renders exactly as before the move.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';
import { useVRMInstance, disposeVRMInstance, retainVRMInstance } from '@/lib/three/vrm-loader';
import { ModelLoadBoundary } from '@/lib/three/model-load-boundary';
import { VRMCharacterAnimator, type AnimName } from '@/lib/three/vrm-character-animator';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import { MODEL_REGISTRY, type ModelKey, type ModelRegistryEntry } from '@/lib/three/agent-model-registry';
import { CHAIR_SCALE, SEAT_MODEL_RETRY } from '@/lib/three/holdem-table-layout';

export const TABLE_POSE_SAMPLE_AT = 0.02;
export const TABLE_POSE_BY_BOT = [
  'cove_peek',
  'cove_think',
  'cove_watch',
  'cove_peek',
  'cove_rest',
] as const satisfies readonly AnimName[];

export const CHIBI_TARGET_HEIGHT = 120;

// Round 10 restores the table's own chair at the table-matched 2.9× scale.
// A 0.05wu downward ray/bounds sweep measured source minY=-20.38519 and the
// flat cushion at y=-3.035, so its grounded world surface is y=50.32. The
// cushion spans local z=-6.30..+7.85; z=+3.13 is its front-third pelvis point.
const CHAIR_SOURCE_MIN_Y = -20.38519;
const CHAIR_SOURCE_CUSHION_Y = -3.035;
export const CHAIR_CUSHION_Y = (CHAIR_SOURCE_CUSHION_Y - CHAIR_SOURCE_MIN_Y) * CHAIR_SCALE;

// Card-player rotations are authored once on the clyt Meshy reference rig
// and retargeted to every humanoid VRM. Rigless GLBs use the perch path.
export const DEFAULT_BOT_MODEL_KEYS = [
  'milady_official_2',
  'milady_official_5',
  'hermes_female',
  'milady_official_7',
  'milady_official_4',
] as const satisfies readonly ModelKey[];

const CASH_AVATAR_MODEL_KEYS = (Object.keys(MODEL_REGISTRY) as ModelKey[])
  .filter((key) => !(MODEL_REGISTRY[key] as ModelRegistryEntry).pickerHidden);

export function stableAvatarModelKey(avatarId: string): ModelKey {
  let hash = 2166136261;
  for (let index = 0; index < avatarId.length; index += 1) {
    hash ^= avatarId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return CASH_AVATAR_MODEL_KEYS[Math.abs(hash) % CASH_AVATAR_MODEL_KEYS.length]
    ?? DEFAULT_BOT_MODEL_KEYS[0];
}

export interface HandPoseSample {
  left: readonly [number, number, number];
  right: readonly [number, number, number];
}

export type HandSampleHandler = (engineSeatIndex: number, sample: HandPoseSample | null) => void;

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
  lobster: { baselineMultiplier: 3, minDimension: 44, maxDimension: 50, outwardOffset: -10, seatOffsetY: 0 },
  sweet_crab: { baselineMultiplier: 3, minDimension: 42, maxDimension: 46, outwardOffset: 7, seatOffsetY: 0 },
  lobster_plush: { baselineMultiplier: 3, minDimension: 42, maxDimension: 46, outwardOffset: -9, seatOffsetY: 0 },
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

export function FrozenFigure({
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
   * apply the verified normalized-bone seated legs and pin hips to the chair. */
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

      // Every seated humanoid path pins its sampled/authored raw hips to the
      // measured cushion surface. Only the standing dealer is bbox-grounded.
      if (cushionY !== undefined) {
        const hips = vrm.humanoid?.getRawBoneNode('hips');
        if (!hips) return;
        hips.getWorldPosition(HIP_SAMPLE);
        vrm.scene.position.y += cushionY - HIP_SAMPLE.y;
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

  useEffect(() => {
    // Setup cancels the dispose that this effect's own cleanup scheduled on a
    // StrictMode replay or a fast remount of the same instance (vrm-loader
    // retain contract). Without it the deferred dispose fired ~500 ms later
    // against a still-mounted figure and destroyed GPU buffers in use.
    retainVRMInstance(reg.path, instanceId);
    return () => disposeVRMInstance(reg.path, instanceId);
  }, [instanceId, reg.path]);

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

export function RiglessPerchFigure({
  reg,
  modelKey,
  position,
  yaw,
  lift = 0,
}: {
  reg: ModelRegistryEntry;
  modelKey: ModelKey;
  position: readonly [number, number, number];
  yaw: number;
  /** Extra world-Y so a small perch clears the table horn beside its chair. */
  lift?: number;
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
        position[1] + CHAIR_CUSHION_Y + profile.seatOffsetY + lift,
        position[2] - outwardZ,
      ]}
      rotation={[0, yaw, 0]}
    >
      <primitive object={perch} />
    </group>
  );
}

// Back-corner chairs (room index 1 and 3) sit beside the table's far horns:
// a 42-46 wu rigless perch on the 50 wu cushion is swallowed by the horn from
// the seated eye (the plush lobster rendered as a 4 px red dot). Lifting the
// perch clears the horn without changing the chair.
export const BACK_CORNER_PERCH_LIFT = 18;

const PLACEHOLDER_HUES = [0.02, 0.12, 0.33, 0.52, 0.66, 0.84] as const;
const placeholderMaterials = new Map<number, THREE.MeshStandardMaterial>();
let placeholderTorsoGeometry: THREE.CapsuleGeometry | null = null;
let placeholderHeadGeometry: THREE.SphereGeometry | null = null;

function getPlaceholderMaterial(engineSeatIndex: number): THREE.MeshStandardMaterial {
  const hue = PLACEHOLDER_HUES[engineSeatIndex % PLACEHOLDER_HUES.length]!;
  let material = placeholderMaterials.get(hue);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(hue, 0.55, 0.55),
      roughness: 0.7,
      metalness: 0.05,
    });
    placeholderMaterials.set(hue, material);
  }
  return material;
}

/**
 * Deterministic stand-in for a seated player whose model is loading or failed
 * every retry. A live seat must never show an empty chair: two meshes, shared
 * geometry, module-cached materials (never disposed; six at most).
 */
export function SeatPlaceholderFigure({
  engineSeatIndex,
  position,
  yaw,
}: {
  engineSeatIndex: number;
  position: readonly [number, number, number];
  yaw: number;
}) {
  placeholderTorsoGeometry ??= new THREE.CapsuleGeometry(10, 22, 4, 10);
  placeholderHeadGeometry ??= new THREE.SphereGeometry(8.5, 12, 10);
  const material = getPlaceholderMaterial(engineSeatIndex);
  return (
    <group
      name={`holdem-placeholder-seat-${engineSeatIndex}`}
      position={[position[0], position[1] + CHAIR_CUSHION_Y, position[2]]}
      rotation={[0, yaw, 0]}
    >
      <mesh geometry={placeholderTorsoGeometry} material={material} position={[0, 24, 0]} />
      <mesh geometry={placeholderHeadGeometry} material={material} position={[0, 52, 0]} />
    </group>
  );
}

/**
 * One seated figure with three guarantees the bare ModelLoadBoundary lacked:
 *  - while the model suspends, the placeholder shows (and the suspend can no
 *    longer bubble to the room's single Suspense and hide the whole scene);
 *  - a failed load shows the placeholder instead of an empty chair;
 *  - a failed load is retried (cache cleared by the boundary) up to
 *    SEAT_MODEL_RETRY.maxRetries times, so one transient 5xx is not permanent.
 * Key this component by figure identity so a new avatar starts clean.
 */
export function SeatFigureSlot({
  assetUrl,
  label,
  resetKey,
  placeholder,
  onModelFailed,
  children,
}: {
  assetUrl: string;
  label: string;
  resetKey: string;
  placeholder: ReactNode;
  onModelFailed?: () => void;
  children: ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);
  const handleFailed = useCallback(() => {
    onModelFailed?.();
    if (attemptRef.current >= SEAT_MODEL_RETRY.maxRetries) return;
    attemptRef.current += 1;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setAttempt(attemptRef.current);
    }, SEAT_MODEL_RETRY.delayMs * attemptRef.current);
  }, [onModelFailed]);
  return (
    <ModelLoadBoundary
      assetUrl={assetUrl}
      label={label}
      resetKey={`${resetKey}|${attempt}`}
      fallback={placeholder}
      onModelFailed={handleFailed}
    >
      <Suspense fallback={placeholder}>{children}</Suspense>
    </ModelLoadBoundary>
  );
}

export interface SeatedFigurePose {
  pose: AnimName;
  targetHeight: number;
  sampleAt: number;
  manualSeat: boolean;
  relaxManualUpperBody: boolean;
}

/**
 * Seated pose for one table figure. Same decision as the hold'em room's seat
 * map (`holdem-table-room.tsx`, which keeps its inline copy unchanged): the
 * scale-100 Hermes family and chibi rigs use the manual sit, every other VRM
 * samples the card-player pose for its room slot. Added 2026-10-22 for the
 * shared baccarat room.
 */
export function seatedFigurePose(
  reg: ModelRegistryEntry,
  roomIndex: number,
  standardHeight: number,
): SeatedFigurePose {
  const usesScale100SitFallback = reg.animatorId === 'hermes-female'
    || reg.animatorId === 'hermes-male'
    || reg.animatorId === 'tekk'
    || reg.animatorId === 'adinero';
  const usesChibiSitFallback = reg.animatorId === 'chibi';
  const usesManualSit = usesScale100SitFallback || usesChibiSitFallback;
  return {
    pose: usesChibiSitFallback
      ? 'idle'
      : usesScale100SitFallback
        ? 'sit_idle_m'
        : TABLE_POSE_BY_BOT[roomIndex % TABLE_POSE_BY_BOT.length]!,
    targetHeight: usesChibiSitFallback ? CHIBI_TARGET_HEIGHT : standardHeight,
    sampleAt: usesManualSit ? 0.2 : TABLE_POSE_SAMPLE_AT,
    manualSeat: usesManualSit,
    relaxManualUpperBody: usesScale100SitFallback,
  };
}
