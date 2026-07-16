'use client';

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';
import { useVRMInstance, disposeVRMInstance } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator, type AnimName } from '@/lib/three/vrm-character-animator';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import { MODEL_REGISTRY, type ModelRegistryEntry } from '@/lib/three/agent-model-registry';
import { TableCards3D, type TableCardLayout, type TableCardSeat } from '@/lib/three/cove-table-cards';

const ROOM_PATH = '/models/cove-room-only.glb';
const TABLE_PATH = '/models/cove-table-clean.glb';
const CHAIR_PATH = '/models/cove-chair-clean.glb';

// World scale is explicit and shared by the extracted table/chairs. The raw
// table is 86.6 units wide; 2x makes it 173wu wide and legible from a 6-max
// first-person camera without reintroducing the giant in-cove room scale.
const FURNITURE_SCALE = 2;
const ROOM_SCALE = 0.5;
const TABLE_TOP_Y = 63.2;
const CHAIR_CUSHION_Y = 42;
const BOT_TARGET_HEIGHT = 84;
const DEALER_TARGET_HEIGHT = 92;

interface RoomSeat extends TableCardSeat {
  chairX: number;
  chairZ: number;
}

// Player gap is at +Z (camera side). Four paired anchors are mirrored around
// x=0; the fifth seat is the far-center 6-max position in front of the dealer.
const BOT_SEATS: readonly RoomSeat[] = [
  { engineSeatIndex: 1, x: -46, z: 18, faceYaw: Math.atan2(46, -18), chairX: -66, chairZ: 29 },
  { engineSeatIndex: 2, x: -29, z: 35, faceYaw: Math.atan2(29, -35), chairX: -45, chairZ: 53 },
  { engineSeatIndex: 3, x: 0, z: -25, faceYaw: 0, chairX: 0, chairZ: -45 },
  { engineSeatIndex: 4, x: 29, z: 35, faceYaw: Math.atan2(-29, -35), chairX: 45, chairZ: 53 },
  { engineSeatIndex: 5, x: 46, z: 18, faceYaw: Math.atan2(-46, -18), chairX: 66, chairZ: 29 },
] as const;

const CARD_LAYOUT: Readonly<TableCardLayout> = Object.freeze({
  boardX: 0,
  boardZ: -8,
  boardYaw: 0,
  boardCardWidth: 8,
  boardCardHeight: 11.2,
  boardSpacing: 10,
  botCardWidth: 6.5,
  botCardHeight: 9.1,
  botPairGap: 1.2,
  botAnchorScale: 0.72,
  surfaceLift: 0.7,
});

const BOT_MODEL_KEYS = [
  'milady_official_2',
  'milady_official_5',
  'milady_official_7',
  'milady_official_4',
  'hermes_female',
] as const satisfies readonly (keyof typeof MODEL_REGISTRY)[];
const DEALER_MODEL_KEY = 'milady_official_6' as const;

function preparedClone(source: THREE.Group, scale: number): THREE.Group {
  const clone = source.clone(true);
  const bounds = new THREE.Box3().setFromObject(clone);
  const center = bounds.getCenter(new THREE.Vector3());
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
}: {
  reg: ModelRegistryEntry;
  instanceId: string;
  pose: AnimName;
  position: readonly [number, number, number];
  yaw: number;
  targetHeight: number;
  cushionY?: number;
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

    void animator.init(pose).then(() => {
      if (cancelled || !animator.applyFrozenPose(pose, 0.0001)) return;
      group.updateMatrixWorld(true);

      if (cushionY !== undefined) {
        const hips = vrm.humanoid?.getRawBoneNode('hips');
        if (hips) {
          const hipWorld = hips.getWorldPosition(new THREE.Vector3());
          vrm.scene.position.y += cushionY - hipWorld.y;
          vrm.scene.updateMatrixWorld(true);
          animator.flushSkeletonUpdates();

          if (process.env.NODE_ENV !== 'production') {
            const adjustedHip = hips.getWorldPosition(new THREE.Vector3());
            const leftHand = vrm.humanoid?.getRawBoneNode('leftHand')?.getWorldPosition(new THREE.Vector3());
            const rightHand = vrm.humanoid?.getRawBoneNode('rightHand')?.getWorldPosition(new THREE.Vector3());
            const leftShoulder = vrm.humanoid?.getRawBoneNode('leftShoulder')?.getWorldPosition(new THREE.Vector3());
            const rightShoulder = vrm.humanoid?.getRawBoneNode('rightShoulder')?.getWorldPosition(new THREE.Vector3());
            console.assert(
              Math.abs(adjustedHip.y - cushionY) <= 1,
              `[HoldemTableRoom] ${instanceId} hips miss cushion`,
            );
            console.assert(
              (!leftHand || !leftShoulder || leftHand.y < leftShoulder.y) &&
              (!rightHand || !rightShoulder || rightHand.y < rightShoulder.y),
              `[HoldemTableRoom] ${instanceId} frozen hands are not below shoulders`,
            );
          }
        }
      }
      invalidate();
    });

    return () => {
      cancelled = true;
      animator.dispose();
    };
  }, [cushionY, instanceId, invalidate, pose, reg.animatorId, vrm]);

  useEffect(() => () => disposeVRMInstance(reg.path, instanceId), [instanceId, reg.path]);

  return (
    <group ref={groupRef} position={position} rotation={[0, yaw, 0]}>
      <primitive
        object={vrm.scene}
        scale={[fit.scale, fit.scale, fit.scale]}
        position={[0, fit.offsetY, 0]}
      />
    </group>
  );
}

function FixedCamera() {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(0, 104, 158);
    camera.lookAt(0, 45, -5);
    camera.updateProjectionMatrix();
  }, [camera]);
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
  const chairGltf = useGLTF(CHAIR_PATH);
  const room = useMemo(() => preparedClone(roomGltf.scene, ROOM_SCALE), [roomGltf.scene]);
  const table = useMemo(() => preparedClone(tableGltf.scene, FURNITURE_SCALE), [tableGltf.scene]);
  const chairs = useMemo(
    () => BOT_SEATS.map(() => preparedClone(chairGltf.scene, FURNITURE_SCALE)),
    [chairGltf.scene],
  );

  return (
    <>
      <FixedCamera />
      <ambientLight intensity={0.65} color={0xffe6cf} />
      <directionalLight position={[-70, 130, 80]} intensity={2.2} color={0xffd2a1} />
      <directionalLight position={[85, 85, 25]} intensity={1.35} color={0x7fd6ff} />
      <pointLight position={[0, 115, -55]} intensity={1150} distance={260} decay={2} color={0xffb86b} />

      <primitive object={room} />
      {/* Procedural floor/backdrop guarantees a clean modal-like stage even
          where the extracted shell opens beyond the fixed camera frustum. */}
      <mesh position={[0, -0.5, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[360, 360]} />
        <meshStandardMaterial color={0x17111d} roughness={0.92} metalness={0.04} />
      </mesh>
      <mesh position={[0, 85, -145]}>
        <planeGeometry args={[360, 190]} />
        <meshStandardMaterial color={0x241724} roughness={0.9} metalness={0.02} />
      </mesh>
      <primitive object={table} />

      {BOT_SEATS.map((seat, index) => (
        <group key={`holdem-seat-${seat.engineSeatIndex}`}>
          <group position={[seat.chairX, 0, seat.chairZ]} rotation={[0, seat.faceYaw, 0]}>
            <primitive object={chairs[index]!} />
          </group>
          <FrozenFigure
            reg={MODEL_REGISTRY[BOT_MODEL_KEYS[index]!] as ModelRegistryEntry}
            instanceId={`holdem-room-seat-${seat.engineSeatIndex}`}
            pose="sit_idle_m"
            position={[seat.chairX, 0, seat.chairZ]}
            yaw={seat.faceYaw}
            targetHeight={BOT_TARGET_HEIGHT}
            cushionY={CHAIR_CUSHION_Y}
          />
        </group>
      ))}

      <FrozenFigure
        reg={MODEL_REGISTRY[DEALER_MODEL_KEY] as ModelRegistryEntry}
        instanceId="holdem-room-dealer"
        pose="idle"
        position={[0, 0, -72]}
        yaw={Math.PI}
        targetHeight={DEALER_TARGET_HEIGHT}
      />

      <TableCards3D
        centerX={0}
        centerZ={0}
        feltTopY={TABLE_TOP_Y}
        seats={BOT_SEATS}
        layout={CARD_LAYOUT}
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
      camera={{ fov: 52, near: 0.5, far: 900, position: [0, 104, 158] }}
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
useGLTF.preload(CHAIR_PATH);
