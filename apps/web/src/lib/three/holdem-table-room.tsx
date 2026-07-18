'use client';

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';
import { useVRMInstance, disposeVRMInstance } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator, type AnimName } from '@/lib/three/vrm-character-animator';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import { MODEL_REGISTRY, type ModelRegistryEntry } from '@/lib/three/agent-model-registry';
import { TableCards3D, type TableCardLayout, type TableCardSeat } from '@/lib/three/cove-table-cards';
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
// hermes NATIVE sit (2026-07-17 founder start-over): her own mesh, rigged by
// Meshy, chair-sit idle baked ON HER SKELETON — no VRM retarget anywhere.
// ?hermesClip=f swaps the female-variant clip for comparison.
const HERMES_SIT_PATH = (() => {
  if (typeof window === 'undefined') return '/models/hermes-female-sit-m.glb';
  return new URLSearchParams(window.location.search).get('hermesClip') === 'f'
    ? '/models/hermes-female-sit-f.glb'
    : '/models/hermes-female-sit-m.glb';
})();

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
// MEASURED ORIENTATION (2026-07-17, vertex-profile ground truth): the
// table's FLAT full-width edge is at +Z (251wu straight edge at the zMax
// extreme) and the players' arc tapers to -Z (72wu at zMin) — every prior
// round had the player parked on the flat/dealer side. Player (camera) now
// sits at the ARC APEX at -Z; bots take arc seats toward the flat corners;
// the DEALER stands at the +Z flat edge. Basis coords x S as before.
const BOT_SEATS: readonly RoomSeat[] = [
  { engineSeatIndex: 1, x: -46 * S, z: -40 * S, faceYaw: Math.atan2(46, 40), chairX: -53 * S, chairZ: -50 * S },
  { engineSeatIndex: 2, x: -86 * S, z: -12 * S, faceYaw: Math.atan2(86, 12), chairX: -98 * S, chairZ: -15 * S },
  { engineSeatIndex: 3, x: -94 * S, z: 32 * S, faceYaw: Math.atan2(94, -32), chairX: -106 * S, chairZ: 39 * S },
  { engineSeatIndex: 4, x: 86 * S, z: -12 * S, faceYaw: Math.atan2(-86, 12), chairX: 98 * S, chairZ: -15 * S },
  { engineSeatIndex: 5, x: 94 * S, z: 32 * S, faceYaw: Math.atan2(-94, -32), chairX: 106 * S, chairZ: 39 * S },
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
  botAnchorScale: 0.72,
  surfaceLift: 0.7 * S,
});

// hermes_female RESTORED (2026-07-17 founder correction — fix her, don't
// cut her): her frozen pose samples the clip at HERMES_SAMPLE_AT instead of
// t=0 (per-figure sampleAt) — the t=0 frame on her rig reads possessed;
// later frames hold hands-on-lap.
const BOT_MODEL_KEYS = [
  'milady_official_2',
  'milady_official_5',
  'hermes_female',
  'milady_official_7',
  'milady_official_4',
] as const satisfies readonly (keyof typeof MODEL_REGISTRY)[];
// (index 3 = hermes -> BOT_SEATS[3], the right side-rail seat: her fixed
// t=2.0 lean reads natural side-on, lunging head-on.)
const HERMES_SAMPLE_AT = (() => {
  if (typeof window === 'undefined') return 0.2;
  const raw = Number(new URLSearchParams(window.location.search).get('hermesSample'));
  return Number.isFinite(raw) && raw > 0 ? raw : 0.2;
})(); // seconds into sit_idle_m — per-rig frames read differently
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
  sampleAt = 0.0001,
  freezeVia = 'sample',
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
  /** 'sample' applies one direct clip sample (clean rigs). 'transition'
   *  simulates the full stand_to_sit -> hold path in a synchronous tick
   *  burst before freezing — the hermes-family rig only reaches a correct
   *  seated pose through the real transition (its direct sit_idle sample
   *  leaves the legs standing; founder-approved live path = transition). */
  freezeVia?: 'sample' | 'transition';
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
  }, [cushionY, freezeVia, instanceId, invalidate, pose, reg.animatorId, sampleAt, vrm]);

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

// FIRST-PERSON seated POV (founder spec 2026-07-17): the camera is the
// player avatar's EYES at the 6-o'clock seat — seated eye height for a
// 160wu body, just behind the near rail, gazing slightly down across the
// felt at the standing dealer. Neighbors appear at the frame edges the way
// they do from a real seat.
const CAM_EYE: readonly [number, number, number] = [0, 150, -49.6 * S - 46];
const CAM_LOOK: readonly [number, number, number] = [0, 66, 78 * S];

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

/** Six static world anchors. Seat 0 is the viewer's own near-edge marker;
 * its registered DOM label remains inside the screen-fixed private tray.
 * Opponent anchors sit outside each torso so the badge never masks a face. */
const SEAT_BADGE_WORLD_ANCHORS: readonly (readonly [number, number, number])[] = [
  [0, 106, -45 * S],
  [BOT_SEATS[0]!.x - 14 * S, 126, BOT_SEATS[0]!.z],
  [BOT_SEATS[1]!.x - 12 * S, 126, BOT_SEATS[1]!.z],
  [BOT_SEATS[2]!.x - 10 * S, 126, BOT_SEATS[2]!.z],
  [BOT_SEATS[3]!.x + 12 * S, 126, BOT_SEATS[3]!.z],
  [BOT_SEATS[4]!.x + 10 * S, 126, BOT_SEATS[4]!.z],
] as const;

// Module-scope scratch only: the yaw loop never allocates Three.js objects.
const CAMERA_LOOK_TARGET = new THREE.Vector3();
const BADGE_PROJECT_SCRATCH = new THREE.Vector3();
const BADGE_VIEW_PROJECTION = new THREE.Matrix4();

/** Frozen figure from a NATIVE Meshy-rigged GLB (mesh + rig + clip in one
 *  asset, zero retargeting). Plays its baked clip once to `sampleAt` and
 *  freezes. Single-mount asset: the cached useGLTF scene is used directly.
 *  rawHeightMeters: the GLB's standing-normalized height, used for world
 *  scale (WORLD_AVATAR_HEIGHT / rawHeightMeters). */
function FrozenGlbFigure({
  path,
  position,
  yaw,
  sampleAt = 0.0001,
  rawHeightMeters = 1.7,
}: {
  path: string;
  position: readonly [number, number, number];
  yaw: number;
  sampleAt?: number;
  rawHeightMeters?: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const gltf = useGLTF(path);
  const { invalidate } = useThree();
  const scale = WORLD_AVATAR_HEIGHT / rawHeightMeters;

  useEffect(() => {
    const group = groupRef.current;
    const clip = gltf.animations[0];
    if (!group || !clip) return;
    const mixer = new THREE.AnimationMixer(gltf.scene);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    mixer.update(sampleAt);
    group.updateMatrixWorld(true);
    // Ground the POSED figure: feet exactly on the floor.
    const bbox = new THREE.Box3().setFromObject(gltf.scene);
    group.position.setY(group.position.y - bbox.min.y);
    group.updateMatrixWorld(true);
    if (process.env.NODE_ENV !== 'production') {
      console.info(`[HoldemTableRoom] native GLB frozen: ${path} @ t=${sampleAt}`);
    }
    invalidate();
    return () => { mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene); };
  }, [gltf, invalidate, path, sampleAt]);

  return (
    <group ref={groupRef} position={[position[0], position[1], position[2]]} rotation={[0, yaw, 0]}>
      <primitive object={gltf.scene} scale={[scale, scale, scale]} />
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
      const outwardNudge = seat === 0 ? 0 : (BADGE_PROJECT_SCRATCH.x < 0 ? -42 : 42);
      const left = (BADGE_PROJECT_SCRATCH.x * 0.5 + 0.5) * size.width + outwardNudge;
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
  const table = useMemo(() => preparedClone(tableGltf.scene, FURNITURE_SCALE), [tableGltf.scene]);
  const chairs = useMemo(
    () => BOT_SEATS.map(() => preparedClone(stoolGltf.scene, FURNITURE_SCALE)),
    [stoolGltf.scene],
  );

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
      <primitive object={table} />

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
          {BOT_MODEL_KEYS[index] === 'hermes_female' ? (
            <FrozenGlbFigure
              path={HERMES_SIT_PATH}
              position={[seat.chairX, 0, seat.chairZ]}
              yaw={seat.faceYaw}
              sampleAt={HERMES_SAMPLE_AT}
            />
          ) : (
          <FrozenFigure
            reg={MODEL_REGISTRY[BOT_MODEL_KEYS[index]!] as ModelRegistryEntry}
            instanceId={`holdem-room-seat-${seat.engineSeatIndex}`}
            pose="sit_idle_m"
            position={[seat.chairX, 0, seat.chairZ]}
            yaw={seat.faceYaw}
            targetHeight={BOT_TARGET_HEIGHT}
          />
          )}
        </group>
      ))}

      {/* Dealer STANDS at the MEASURED flat edge (+Z, the 251wu straight
          side), facing the player at the arc (-Z ⇒ yaw π). */}
      <FrozenFigure
        reg={MODEL_REGISTRY[DEALER_MODEL_KEY] as ModelRegistryEntry}
        instanceId="holdem-room-dealer"
        pose="idle"
        position={[0, 0, 78 * S]}
        yaw={Math.PI}
        targetHeight={DEALER_TARGET_HEIGHT}
      />
      <DealerPlate position={[0, DEALER_TARGET_HEIGHT + 18, 78 * S]} />

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
      camera={{ fov: 62, near: 0.5, far: 900, position: [CAM_EYE[0], CAM_EYE[1], CAM_EYE[2]] }}
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
useGLTF.preload('/models/hermes-female-sit-m.glb');
