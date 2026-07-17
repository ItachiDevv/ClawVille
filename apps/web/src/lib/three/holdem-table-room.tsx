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
// Stools, not tall-backed chairs (2026-07-16 headed verify): the chair
// model's high back is a solid black slab at this camera height — near-side
// chairs walled off the frame corners and the far-center chair completely
// hid the dealer. Stools keep every sight line open.
const STOOL_PATH = '/models/cove-stool.glb';

// SCALE UNIFICATION (2026-07-17 founder feedback): every figure renders at
// the SAME world-standard height the walkable cove uses for the player's
// own avatar (COVE_VRM_TARGET_HEIGHT = 160) — the earlier 108-bot/118-dealer
// mix read as "the dealer milady is a giant" and none of them matched the
// movable agent's scale. The TABLE scales to the bodies (top ≈ 57% of body
// height), not the bodies to the table. `S` converts every layout constant
// authored at the original scale-2 basis.
const WORLD_AVATAR_HEIGHT = 160;
const FURNITURE_SCALE = 2.9;
const S = FURNITURE_SCALE / 2;
// Room shell scaled with the furniture so wall/ceiling proportions track.
const ROOM_SCALE = 1.45;
const TABLE_TOP_Y = 63.2 * S;
const BOT_TARGET_HEIGHT = WORLD_AVATAR_HEIGHT;
const DEALER_TARGET_HEIGHT = WORLD_AVATAR_HEIGHT;

interface RoomSeat extends TableCardSeat {
  chairX: number;
  chairZ: number;
}

// PLAYER-SEAT STAGING (2026-07-17 founder correction): the previous framing
// put the camera at the table's FLAT side — the DEALER's position. The felt
// betting-spot arc marks the players' curve; the camera now sits AT that
// curve's apex (a real player seat among the bots), the bots occupy the
// other curve seats flanking left/right, and the dealer stands across at
// the flat side. All coordinates authored at the scale-2 basis × S.
// The arc apex bulges toward -Z; the flat edge runs along +Z.
// Bots occupy the FAR half of the seating oval — the side rails at mid
// table and the flat-edge corners flanking the dealer. Two failed layouts
// proved the constraint (rounds 7-8): any 160wu body within ~100wu of the
// camera renders as a giant frame-edge blocker, so every occupied seat
// stays across the table; the player's own apex zone and both near rails
// are empty. This is how seated-POV poker games stage 6-max for a reason.
const BOT_SEATS: readonly RoomSeat[] = [
  { engineSeatIndex: 1, x: -82 * S, z: 18 * S, faceYaw: Math.atan2(82, -18), chairX: -93 * S, chairZ: 23 * S },
  { engineSeatIndex: 2, x: -48 * S, z: 34 * S, faceYaw: Math.atan2(48, -34), chairX: -55 * S, chairZ: 43 * S },
  { engineSeatIndex: 3, x: -16 * S, z: 42 * S, faceYaw: Math.atan2(16, -42), chairX: -18 * S, chairZ: 53 * S },
  { engineSeatIndex: 4, x: 48 * S, z: 34 * S, faceYaw: Math.atan2(-48, -34), chairX: 55 * S, chairZ: 43 * S },
  { engineSeatIndex: 5, x: 82 * S, z: 18 * S, faceYaw: Math.atan2(-82, -18), chairX: 93 * S, chairZ: 23 * S },
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
  boardSpacing: 10 * S,
  botCardWidth: 6.5 * S,
  botCardHeight: 9.1 * S,
  botPairGap: 1.2 * S,
  // 0.62 (was 0.72) after the table-mesh π rotation: the felt boundary is
  // asymmetric around the oval, and at 0.72 the far-side bot backs landed
  // on the black rail instead of the felt.
  botAnchorScale: 0.62,
  surfaceLift: 0.7 * S,
});

// hermes_female REMOVED (2026-07-17 founder verdict — her defective rig's
// frozen frame still reads "possessed"; the milady-family poses are the
// approved ones). Five distinct miladys; dealer is milady_official_6.
const BOT_MODEL_KEYS = [
  'milady_official_2',
  'milady_official_5',
  'milady_official_7',
  'milady_official_4',
  'milady_official_3',
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

      // Ground the POSED figure by its real bounding box. The first cut
      // anchored hips to a cushion constant, but the retargeted clip's own
      // hip translation made that shift wildly over-drop: the headed verify
      // (2026-07-16) measured all five bots 26wu below the floor and the
      // dealer buried to the waist (-44). Feet-on-floor is the one invariant
      // every figure shares; the chair is then aligned to the body, not the
      // body to the chair.
      const bbox = new THREE.Box3().setFromObject(vrm.scene);
      vrm.scene.position.y += -bbox.min.y;
      vrm.scene.updateMatrixWorld(true);
      animator.flushSkeletonUpdates();

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

// Player-side elevated POV — the 2D modal's actual read: behind + above the
// player's own (empty) seat at the arc apex, high enough that the LATERAL
// arc neighbors land inside the frustum. A true eye-level seat POV leaves
// the whole table looking empty (verified: at eye height the flanking bots
// sit outside a 52° FOV and only the dealer is visible).
const CAM_EYE: readonly [number, number, number] = [0, 178, -49.6 * S - 90];
const CAM_LOOK: readonly [number, number, number] = [0, 42, 25 * S];

function FixedCamera() {
  const { camera } = useThree();
  useEffect(() => {
    camera.position.set(...CAM_EYE);
    camera.lookAt(...CAM_LOOK);
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
  const stoolGltf = useGLTF(STOOL_PATH);
  const room = useMemo(() => preparedClone(roomGltf.scene, ROOM_SCALE), [roomGltf.scene]);
  const table = useMemo(() => preparedClone(tableGltf.scene, FURNITURE_SCALE), [tableGltf.scene]);
  const chairs = useMemo(
    () => BOT_SEATS.map(() => preparedClone(stoolGltf.scene, FURNITURE_SCALE)),
    [stoolGltf.scene],
  );

  return (
    <>
      <FixedCamera />
      <ambientLight intensity={0.85} color={0xffe6cf} />
      <directionalLight position={[-70, 130, 80]} intensity={2.2} color={0xffd2a1} />
      <directionalLight position={[85, 85, 25]} intensity={1.35} color={0x7fd6ff} />
      <pointLight position={[0, 115, -55]} intensity={1150} distance={260} decay={2} color={0xffb86b} />
      {/* Dealer/back-row key — the flat (dealer) side now faces +Z after the
          2026-07-17 perspective flip; keep it lit or the dealer reads as a
          silhouette. */}
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
      {/* Table mesh rotated π (2026-07-17 founder catch): the GLB's built-in
          DEALER STATION CUTOUT is baked into what we treated as the player
          arc — unrotated, the cutout notch sat directly in front of the
          camera ("the playable character is on the dealer side"). The spin
          puts the cutout under the standing dealer; seats/cards/camera are
          mesh-independent and unchanged. */}
      <group rotation={[0, Math.PI, 0]}>
        <primitive object={table} />
      </group>

      {/* Stools deliberately NOT rendered (2026-07-16 framing pass 4): the
          wire-frame stool GLB read as floating white baskets at the table
          rim, and everything below the rail is invisible from the fixed
          camera anyway — seated bodies alone read cleaner. Keep the loaded
          asset + anchors for a later camera that shows under-table space. */}
      {BOT_SEATS.map((seat, index) => (
        <group key={`holdem-seat-${seat.engineSeatIndex}`}>
          <group position={[seat.chairX, 0, seat.chairZ]} rotation={[0, seat.faceYaw, 0]} visible={false}>
            <primitive object={chairs[index]!} />
          </group>
          <FrozenFigure
            reg={MODEL_REGISTRY[BOT_MODEL_KEYS[index]!] as ModelRegistryEntry}
            instanceId={`holdem-room-seat-${seat.engineSeatIndex}`}
            pose="sit_idle_m"
            position={[seat.chairX, 0, seat.chairZ]}
            yaw={seat.faceYaw}
            targetHeight={BOT_TARGET_HEIGHT}
          />
        </group>
      ))}

      {/* Dealer at the FLAT side (+Z) facing the table (-Z ⇒ yaw π under
          the atan2(vx, vz) convention) — the 2026-07-17 correction: the
          camera now owns the players' curve, the dealer the flat edge. */}
      <FrozenFigure
        reg={MODEL_REGISTRY[DEALER_MODEL_KEY] as ModelRegistryEntry}
        instanceId="holdem-room-dealer"
        pose="idle"
        position={[0, 0, 78 * S]}
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
      camera={{ fov: 52, near: 0.5, far: 900, position: [CAM_EYE[0], CAM_EYE[1], CAM_EYE[2]] }}
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
