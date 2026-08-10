'use client';

import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';
import { useVRMInstance, disposeVRMInstance } from '@/lib/three/vrm-loader';
import { preloadClips, VRMCharacterAnimator } from '@/lib/three/vrm-character-animator';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import {
  MODEL_REGISTRY,
  type ModelRegistryEntry,
} from '@/lib/three/agent-model-registry';
import {
  BaccaratTableCards3D,
  type BaccaratHandLayout,
} from '@/lib/three/baccarat-table-cards';
import type { BaccaratRoomState } from '@/lib/cove/baccarat-room-controller';

const ROOM_PATH = '/models/cove-room-only.glb';
const TABLE_PATH = '/models/cove-table-clean.glb';
const DEALER_MODEL_KEY = 'milady_official_6' as const;
const DEALER_POSE_SAMPLE_AT = 0.0001;
preloadClips(['idle']);

const WORLD_AVATAR_HEIGHT = 160;
const FURNITURE_SCALE = 2.9;
const TABLE_FOOTPRINT_MULTIPLIER = 1.34;
const TABLE_XZ_SCALE = FURNITURE_SCALE * TABLE_FOOTPRINT_MULTIPLIER;
const TABLE_FOOTPRINT_SCALE = (FURNITURE_SCALE / 2) * TABLE_FOOTPRINT_MULTIPLIER;
const ROOM_SCALE = 1.45;
const TABLE_SOURCE_TOP_Y = 63.2 * (FURNITURE_SCALE / 2);
const TABLE_TOP_Y = 70;
const TABLE_VISUAL_Y = TABLE_TOP_Y - TABLE_SOURCE_TOP_Y;
const DEALER_Z = 78 * TABLE_FOOTPRINT_SCALE;

const CAM_EYE: readonly [number, number, number] = [0, TABLE_TOP_Y + 78, -230];
const CAM_LOOK: readonly [number, number, number] = [0, TABLE_TOP_Y + 14, 32 * TABLE_FOOTPRINT_SCALE];
const CAMERA_FOV = 66;
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
const CAMERA_LOOK_TARGET = new THREE.Vector3();
const ROOM_BACKGROUND = new THREE.Color(0x100b16);

const CARD_LAYOUT = Object.freeze({
  playerCenter: [-52, 20],
  bankerCenter: [52, 20],
  cardWidth: 20,
  cardHeight: 28,
  cardSpacing: 14,
  surfaceLift: 0.4,
  yaw: Math.PI,
} as const satisfies BaccaratHandLayout);

const ZONE_X = Object.freeze({
  player: -66,
  banker: 0,
  tie: 66,
} as const);

function preparedClone(
  source: THREE.Group,
  scale: number | readonly [number, number, number],
): THREE.Group {
  const clone = source.clone(true);
  const bounds = new THREE.Box3().setFromObject(clone);
  const center = bounds.getCenter(new THREE.Vector3());
  const [scaleX, scaleY, scaleZ] = typeof scale === 'number'
    ? [scale, scale, scale]
    : scale;
  clone.scale.set(scaleX, scaleY, scaleZ);
  clone.position.set(-center.x * scaleX, -bounds.min.y * scaleY, -center.z * scaleZ);
  clone.updateMatrixWorld(true);
  return clone;
}

function DealerFigure({ instanceId }: { instanceId: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const reg = MODEL_REGISTRY[DEALER_MODEL_KEY] as ModelRegistryEntry;
  const vrm = useVRMInstance(reg.path, instanceId);
  const { invalidate } = useThree();
  const fit = useMemo(
    () => computeVRMAvatarFit(vrm, reg.animatorId, WORLD_AVATAR_HEIGHT),
    [reg.animatorId, vrm],
  );

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    let cancelled = false;
    const animator = new VRMCharacterAnimator(vrm, reg.animatorId);
    void (async () => {
      await animator.init('idle');
      if (cancelled || !animator.applyFrozenPose('idle', DEALER_POSE_SAMPLE_AT)) return;
      group.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(vrm.scene);
      vrm.scene.position.y += -bounds.min.y;
      vrm.scene.updateMatrixWorld(true);
      animator.flushSkeletonUpdates();
      group.updateMatrixWorld(true);
      invalidate();
    })();
    return () => {
      cancelled = true;
      animator.dispose();
    };
  }, [invalidate, reg.animatorId, vrm]);

  useEffect(
    () => () => disposeVRMInstance(reg.path, instanceId),
    [instanceId, reg.path],
  );

  return (
    <group
      ref={groupRef}
      name="baccarat-room-dealer"
      position={[0, 0, DEALER_Z]}
      rotation={[0, Math.PI, 0]}
    >
      <primitive
        object={vrm.scene}
        scale={[fit.scale, fit.scale, fit.scale]}
        position={[0, fit.offsetY, 0]}
      />
    </group>
  );
}

function DealerPlate() {
  const groupRef = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = 'rgba(10, 14, 16, 0.88)';
    context.beginPath();
    context.roundRect(6, 6, 500, 116, 28);
    context.fill();
    context.strokeStyle = 'rgba(255, 205, 120, 0.85)';
    context.lineWidth = 6;
    context.stroke();
    context.fillStyle = '#ffd88a';
    context.font = '700 64px ui-monospace, Consolas, monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('DEALER', 256, 68);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const geometry = new THREE.PlaneGeometry(52, 13);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    return () => {
      group.remove(mesh);
      geometry.dispose();
      material.dispose();
      texture.dispose();
    };
  }, []);
  return (
    <group
      ref={groupRef}
      position={[0, WORLD_AVATAR_HEIGHT + 18, DEALER_Z]}
      rotation={[0, Math.PI, 0]}
    />
  );
}

function StagePlanes() {
  const groupRef = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const floorGeometry = new THREE.PlaneGeometry(700, 700);
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x241a26,
      roughness: 0.92,
      metalness: 0.04,
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.position.set(0, -0.5, 0);
    floor.rotation.x = -Math.PI / 2;
    floor.updateMatrix();
    floor.matrixAutoUpdate = false;
    const backdropGeometry = new THREE.PlaneGeometry(800, 280);
    const backdropMaterial = new THREE.MeshStandardMaterial({
      color: 0x43283a,
      roughness: 0.9,
      metalness: 0.02,
    });
    const backdrop = new THREE.Mesh(backdropGeometry, backdropMaterial);
    backdrop.position.set(0, 120, 185);
    backdrop.rotation.y = Math.PI;
    backdrop.updateMatrix();
    backdrop.matrixAutoUpdate = false;
    group.add(floor, backdrop);
    return () => {
      group.remove(floor, backdrop);
      floorGeometry.dispose();
      floorMaterial.dispose();
      backdropGeometry.dispose();
      backdropMaterial.dispose();
    };
  }, []);
  return <group ref={groupRef} />;
}

function BaccaratBetZones({ selected }: { selected: BaccaratRoomState['betType'] }) {
  const groupRef = useRef<THREE.Group>(null);
  const chipRef = useRef<THREE.Mesh | null>(null);
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const colorValues = [0x4299e1, 0xf59e0b, 0x68d391] as const;
    (['player', 'banker', 'tie'] as const).forEach((bet, zoneIndex) => {
      const x = ZONE_X[bet];
      const y = TABLE_TOP_Y + 0.18;
      const z = -39;
      const vertexOffset = positions.length / 3;
      positions.push(
        x - 26, y, z - 17,
        x - 26, y, z + 17,
        x + 26, y, z + 17,
        x + 26, y, z - 17,
      );
      const color = new THREE.Color(colorValues[zoneIndex]);
      for (let index = 0; index < 4; index += 1) {
        colors.push(color.r, color.g, color.b);
      }
      indices.push(
        vertexOffset,
        vertexOffset + 1,
        vertexOffset + 2,
        vertexOffset,
        vertexOffset + 2,
        vertexOffset + 3,
      );
    });
    const zoneGeometry = new THREE.BufferGeometry();
    zoneGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    );
    zoneGeometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(colors, 3),
    );
    zoneGeometry.setIndex(indices);
    const zoneMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const zoneMesh = new THREE.Mesh(zoneGeometry, zoneMaterial);
    zoneMesh.name = 'baccarat-bet-zones-merged';
    zoneMesh.updateMatrix();
    zoneMesh.matrixAutoUpdate = false;
    group.add(zoneMesh);

    const chipGeometry = new THREE.CylinderGeometry(10, 10, 2.2, 20);
    const chipMaterial = new THREE.MeshStandardMaterial({
      color: 0xf6d365,
      roughness: 0.44,
      metalness: 0.18,
    });
    const chip = new THREE.Mesh(chipGeometry, chipMaterial);
    chip.name = 'baccarat-selected-bet-chip';
    chip.position.set(ZONE_X[selected], TABLE_TOP_Y + 2, -39);
    chip.updateMatrix();
    chip.matrixAutoUpdate = false;
    group.add(chip);
    chipRef.current = chip;
    return () => {
      chipRef.current = null;
      group.remove(zoneMesh);
      zoneGeometry.dispose();
      zoneMaterial.dispose();
      group.remove(chip);
      chipGeometry.dispose();
      chipMaterial.dispose();
    };
  }, []);

  useLayoutEffect(() => {
    const chip = chipRef.current;
    if (!chip) return;
    chip.position.set(ZONE_X[selected], TABLE_TOP_Y + 2, -39);
    chip.updateMatrix();
  }, [selected]);
  return <group ref={groupRef} />;
}

function BaccaratLookCamera() {
  const { camera } = useThree();
  const heldRef = useRef({ left: false, right: false });
  const viewRef = useRef({ yaw: 0, targetYaw: 0, snapCenter: true });
  useEffect(() => {
    camera.position.set(CAM_EYE[0], CAM_EYE[1], CAM_EYE[2]);
    camera.lookAt(...CAM_LOOK);
    camera.updateProjectionMatrix();
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
    const view = viewRef.current;
    const held = heldRef.current;
    const direction = Number(held.left) - Number(held.right);
    if (direction !== 0) {
      view.targetYaw = THREE.MathUtils.clamp(
        view.targetYaw + direction * LOOK_YAW_SPEED * Math.min(delta, 0.05),
        -LOOK_YAW_LIMIT,
        LOOK_YAW_LIMIT,
      );
    }
    if (view.snapCenter) {
      view.snapCenter = false;
      view.yaw = 0;
      view.targetYaw = 0;
    } else if (Math.abs(view.targetYaw - view.yaw) >= 0.00005) {
      const ease = 1 - Math.exp(-LOOK_EASE * Math.min(delta, 0.05));
      view.yaw += (view.targetYaw - view.yaw) * ease;
    } else if (direction === 0) {
      return;
    }
    const yaw = BASE_LOOK_YAW + view.yaw;
    CAMERA_LOOK_TARGET.set(
      CAM_EYE[0] + Math.sin(yaw) * BASE_LOOK_COS_PITCH * BASE_LOOK_DISTANCE,
      CAM_EYE[1] + BASE_LOOK_SIN_PITCH * BASE_LOOK_DISTANCE,
      CAM_EYE[2] + Math.cos(yaw) * BASE_LOOK_COS_PITCH * BASE_LOOK_DISTANCE,
    );
    camera.position.set(CAM_EYE[0], CAM_EYE[1], CAM_EYE[2]);
    camera.lookAt(CAMERA_LOOK_TARGET);
    camera.updateMatrixWorld();
  });
  return null;
}

function Precompile() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const renderer = gl as unknown as {
        compileAsync?: (nextScene: THREE.Scene, nextCamera: THREE.Camera) => Promise<void>;
      };
      void renderer.compileAsync?.(scene, camera).catch((error: unknown) => {
        console.warn('[BaccaratTableRoom] pipeline precompile failed:', error);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [camera, gl, scene]);
  return null;
}

function BaccaratTableRoomScene({
  instanceId,
  view,
}: {
  instanceId: string;
  view: BaccaratRoomState;
}) {
  const roomGltf = useGLTF(ROOM_PATH);
  const tableGltf = useGLTF(TABLE_PATH);
  const room = useMemo(
    () => preparedClone(roomGltf.scene, ROOM_SCALE),
    [roomGltf.scene],
  );
  const table = useMemo(
    () => preparedClone(
      tableGltf.scene,
      [TABLE_XZ_SCALE, FURNITURE_SCALE, TABLE_XZ_SCALE],
    ),
    [tableGltf.scene],
  );
  const coup = view.settled?.outcome ?? view.restored?.outcome ?? null;
  const selected = view.betzoneSelected as BaccaratRoomState['betType'] | null
    ?? view.betType;

  return (
    <>
      <BaccaratLookCamera />
      <ambientLight intensity={0.85} color={0xffe6cf} />
      <directionalLight position={[-70, 130, 80]} intensity={2.2} color={0xffd2a1} />
      <directionalLight position={[85, 85, 25]} intensity={1.35} color={0x7fd6ff} />
      <pointLight position={[0, 115, -55]} intensity={1150} distance={260} decay={2} color={0xffb86b} />
      <pointLight position={[0, 150, 110]} intensity={900} distance={260} decay={2} color={0xffd9b0} />
      <primitive object={room} />
      <StagePlanes />
      <group position={[0, TABLE_VISUAL_Y, 0]}>
        <primitive object={table} />
      </group>
      <DealerFigure instanceId={`${instanceId}-baccarat-dealer`} />
      <DealerPlate />
      <BaccaratBetZones selected={selected} />
      <BaccaratTableCards3D
        feltTopY={TABLE_TOP_Y}
        layout={CARD_LAYOUT}
        view={{
          instanceId,
          coup,
          revealedStep: view.revealedStep,
          dealSteps: view.dealSteps,
          phase: view.phase,
          bet: view.betType,
          stake: view.stake,
          // Landed parity requires handNumber even though the frozen room spec
          // abbreviates this correlation as `{hand}`.
          correlation: {
            hand: view.correlation?.hand ?? '',
            handNumber: null,
            ...(view.shoe ? { shoe: view.shoe.id } : {}),
          },
          ...(view.bannerText ? { bannerText: view.bannerText } : {}),
          ...(selected ? { betzoneSelected: selected } : {}),
        }}
      />
      <Precompile />
    </>
  );
}

export default function BaccaratTableRoomCanvas({
  view,
  instanceId,
}: {
  view: BaccaratRoomState;
  instanceId: string;
}) {
  return (
    <Canvas
      key="baccarat-table-room"
      dpr={[0.65, 1]}
      frameloop="always"
      camera={{
        fov: CAMERA_FOV,
        near: 0.5,
        far: 900,
        position: [CAM_EYE[0], CAM_EYE[1], CAM_EYE[2]],
      }}
      gl={{ antialias: false, powerPreference: 'low-power' }}
      onCreated={({ scene }) => {
        scene.background = ROOM_BACKGROUND;
      }}
    >
      <KTX2LoaderSetup />
      <Suspense fallback={null}>
        <BaccaratTableRoomScene instanceId={instanceId} view={view} />
      </Suspense>
    </Canvas>
  );
}

useGLTF.preload(ROOM_PATH);
useGLTF.preload(TABLE_PATH);
