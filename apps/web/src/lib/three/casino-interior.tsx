'use client';

/**
 * casino-interior.tsx
 *
 * Route-isolated R3F scene component for the casino interior.
 * Mounted exclusively at /casino — torn down on exit via Canvas key prop.
 *
 * Concern 6.0.5 — Walkable interior:
 *   - Player avatar (VRM or GLB) mounted inside the casino room.
 *   - WASD movement bounded to the interior (x∈[-383,+383], z∈[-900,+900]).
 *   - Third-person follow camera: +200wu above, +450wu behind avatar, looks
 *     at avatar Y=100 — calibrated for VRM avatar at ~270wu tall.
 *   - Player spawns at z≈+800 (near the front-wall entrance), facing -Z
 *     (into the room, toward the gaming floor).
 *   - Room scaled to INTERIOR_TARGET_HEIGHT=2000wu so ceiling (~400wu) clears
 *     VRM avatar height (~270wu). Was 600wu → 120wu ceiling → head clip.
 *
 * Concern 6.0.5 — Slot machine cabinet props:
 *   - 4 low-poly slot cabinet meshes along the left wall (x≈-120).
 *   - Each cabinet has a body box, emissive cyan screen panel, and a lever.
 *   - Hotspots are now positioned ON the cabinets (z spread at left wall).
 *   - Slot UI opens when player clicks a cabinet (useCasinoStore.openSlotScreen).
 *
 * Asset: /models/casino/casino-interior.glb (gameready, 4.2MB, Draco)
 *        /models/casino/casino-interior-fallback.glb (cartoon, 58KB, no Draco)
 *
 * Iris Xe invariants (enforced in this file):
 *   - NO shadows
 *   - NO drei Text / Billboard
 *   - NO InstancedMesh + ShaderMaterial
 *   - NO per-frame `new Vector3()` — module-scope scratch vectors only
 *   - matrixAutoUpdate=false on all static meshes after first transform
 *   - Draw calls < 140 (room ~21 + cabinets 12 + avatar ~2-4 + hotspot 4)
 */

import { Suspense, useRef, useEffect, useMemo, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { CasinoLighting } from '@/components/three/CasinoLighting';
import { useCasinoStore } from '@/stores/casino';
import { useAvatar } from '@/hooks/use-avatar';
import { useGameStore } from '@/stores/game';
import { useVRMInstance, disposeVRMInstance } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator } from '@/lib/three/vrm-character-animator';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import { MODEL_REGISTRY, type ModelRegistryEntry } from '@/lib/three/agent-model-registry';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import type { MachineSlug } from '@/lib/casino/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gameready GLB path */
const INTERIOR_GLB = '/models/casino/casino-interior.glb';
/** Fallback cartoon GLB */
const FALLBACK_GLB = '/models/casino/casino-interior-fallback.glb';

/** FPS threshold below which we auto-switch to fallback GLB */
const FPS_FALLBACK_THRESHOLD = 40;

/**
 * Target world-unit height for auto-fit scale normalisation.
 *
 * Bug fix 2026-05-18: was 600wu → room ceiling only ~120wu but VRM avatar
 * renders at ~270wu (computeVRMAvatarFit target). Head went through ceiling;
 * follow camera at Y=55 was below avatar feet → only legs visible.
 *
 * 2000wu gives ceiling ~400wu — plenty of headroom for 270wu avatar.
 * Room proportions scale proportionally (maxDim axis = 2000, the rest scale
 * by 2000/600 ≈ 3.333). Bounds, spawn, cabinet positions all follow.
 */
const INTERIOR_TARGET_HEIGHT = 2000; // world units — was 600

/** Scale factor applied to all room-relative coordinates (bounds, spawn, cabinets). */
const _ROOM_SCALE = 2000 / 600; // ≈ 3.333

/** Player spawn position — near the front entrance, facing into the room (-Z) */
const PLAYER_SPAWN_X = 0;
const PLAYER_SPAWN_Z = Math.round(240 * _ROOM_SCALE); // ≈ 800

/** Interior bounds — keep avatar inside the room */
const BOUNDS_X     = Math.round(115 * _ROOM_SCALE); // ≈ 383
const BOUNDS_Z_MIN = -Math.round(270 * _ROOM_SCALE); // ≈ -900
const BOUNDS_Z_MAX =  Math.round(270 * _ROOM_SCALE); // ≈  900

/** Player movement speed (world units / second) — boosted for larger room */
const CASINO_PLAYER_SPEED = 830; // was 250; ≈ 250 × 3.333 so same perceived traversal time

/** GLB avatar scale — matches AVATAR_SCALE in player-avatar.tsx */
const CASINO_AVATAR_SCALE = 40;

/**
 * VRM avatar target height inside the casino (world units).
 *
 * BUG FIX 2026-05-18 (pass 2): dropped from 270wu → 160wu.
 *
 * The previous Implementer set CASINO_VRM_TARGET_HEIGHT = 270, which equals
 * VRM_AVATAR_TARGET_HEIGHT_WU — so computeVRMAvatarFit() produced the same
 * scale as the open world. The avatar was still towering at 270wu inside a
 * room whose ceiling is only ~400wu.
 *
 * Target sizing math (world-scale units, 158.8wu ≈ 1m):
 *   Real slot cabinet body: ~0.9m + ~0.1m base = 1.0m total → 159wu
 *   Target avatar height:   ~1.0m = 159wu  (matches cabinet top)
 *
 * Chosen value: 160wu
 *   Cabinet top / avatar = 159 / 160 = 99.4% — machine reaches forehead.
 *   This is accurate for traditional tall Vegas slot machines (5-6 ft /
 *   ~180cm), where the cabinet top meets standing player eye-level.
 *   Avatar / ceiling = 160 / 400 = 40% — slightly short person in a tall
 *   room. IRL ratio is ~49% (1.7m / 3.5m), so the player reads as modestly
 *   shorter than real scale — appropriate for a stylised game interior.
 *
 * Cabinet WIDTH/DEPTH still use _ROOM_SCALE so the footprint fills the floor.
 * Cabinet HEIGHT dimensions remain world-scale (not room-scale) so they are
 * calibrated against the avatar, not the 2000wu room max-dim.
 */
const CASINO_VRM_TARGET_HEIGHT = 160; // wu — deliberately SMALLER than VRM_AVATAR_TARGET_HEIGHT_WU=270

// Follow-camera offsets calibrated for VRM avatar at CASINO_VRM_TARGET_HEIGHT = 160wu.
//
//   Framing rules (proportional to avatar height H=160wu):
//     CAM_ABOVE  = H × 1.19 ≈ 190wu  — camera sits ~1.2× avatar height above
//                                       the floor; sees full body + some ceiling.
//     CAM_BEHIND = H × 2.81 ≈ 450wu  — generous pull-back so the tiny avatar
//                                       reads clearly against the wide room.
//     CAM_LOOK_Y = H × 0.44 ≈  70wu  — lookAt at avatar upper-chest / chin;
//                                       44% of H puts us level with the screen
//                                       panels on the slot machines (nice framing).
//
// The camera azimuth is driven by a SEPARATE _casinoCamYaw that lerps toward
// the avatar's facing yaw at a SLOWER rate (0.05 vs avatar's 0.15). This
// decouples the camera from the avatar's immediate turn so that pressing A
// or D doesn't instantly swing the full viewport by 45° — the avatar turns
// smoothly while the camera follows with a comfortable lag.
const CAM_ABOVE  = 190;
const CAM_BEHIND = 450;
const CAM_LOOK_Y = 70;
const CAM_YAW_LERP = 0.05; // camera azimuth tracks avatar yaw at 1/3 of avatar turn rate

// ---------------------------------------------------------------------------
// Module-scope scratch objects — NEVER allocated inside useFrame
// ---------------------------------------------------------------------------
const _bbox = new THREE.Box3();
const _center = new THREE.Vector3();
const _size = new THREE.Vector3();
const _meshBbox = new THREE.Box3();

// Follow-camera scratch vectors
const _camTarget = new THREE.Vector3();
const _camDesiredPos = new THREE.Vector3();

// Camera yaw state — separate from avatar yaw so the camera follows with lag.
// Initialized at Math.PI so camera starts behind spawn (avatar faces -Z = Math.PI).
// This is module-scope (not component-scope) because CasinoVRMAvatarInner and
// CasinoGLBAvatarInner both need it, and only one is ever mounted at a time.
let _casinoCamYaw = Math.PI;

// ---------------------------------------------------------------------------
// Module-scope casino WASD key state — separate from the world player-avatar
// keyState module to avoid cross-canvas contamination (casino is a different
// R3F Canvas instance entirely — it can't share global input state with the
// world canvas which may still be active in the component tree).
// ---------------------------------------------------------------------------
interface CasinoKeyState {
  w: boolean; a: boolean; s: boolean; d: boolean;
}
const casinoKeys: CasinoKeyState = { w: false, a: false, s: false, d: false };
let casinoKeyListenersAttached = false;

function attachCasinoKeyListeners() {
  if (casinoKeyListenersAttached) return;
  casinoKeyListenersAttached = true;

  /**
   * Bug fix 2026-05-18: arrow keys produced no movement.
   *
   * Arrow key e.key values are multi-character ('ArrowUp' etc.), so
   * e.key.toLowerCase() gives 'arrowup' — not 'w'. We detect them by
   * checking the raw e.key value (case-sensitive for arrows) and map:
   *   ArrowUp    → w (forward)
   *   ArrowDown  → s (back)
   *   ArrowLeft  → a (strafe left / turn left)
   *   ArrowRight → d (strafe right / turn right)
   *
   * Single-character keys (a/s/d/w) are lowercased before the checks.
   * This pattern mirrors player-avatar.tsx keyState which stores both
   * 'w' and 'arrowup' as separate keys; here we collapse them onto
   * the same four casinoKeys slots so the movement logic below is
   * unchanged — no additional branches needed.
   */
  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'w' || k === 'ArrowUp')    casinoKeys.w = true;
    if (k === 's' || k === 'ArrowDown')  casinoKeys.s = true;
    if (k === 'a' || k === 'ArrowLeft')  casinoKeys.a = true;
    if (k === 'd' || k === 'ArrowRight') casinoKeys.d = true;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'w' || k === 'ArrowUp')    casinoKeys.w = false;
    if (k === 's' || k === 'ArrowDown')  casinoKeys.s = false;
    if (k === 'a' || k === 'ArrowLeft')  casinoKeys.a = false;
    if (k === 'd' || k === 'ArrowRight') casinoKeys.d = false;
  };
  const onBlur = () => { casinoKeys.w = casinoKeys.a = casinoKeys.s = casinoKeys.d = false; };
  const onVis = () => { if (document.hidden) { casinoKeys.w = casinoKeys.a = casinoKeys.s = casinoKeys.d = false; } };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVis);
}

// ---------------------------------------------------------------------------
// Draco loader singleton
// ---------------------------------------------------------------------------
const _dracoLoader = new DRACOLoader();
_dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

const extendWithDraco = (loader: unknown) => {
  (loader as GLTFLoader).setDRACOLoader(_dracoLoader);
};

// Preload both GLBs at module scope
if (typeof window !== 'undefined') {
  useGLTF.preload(INTERIOR_GLB, undefined, undefined, extendWithDraco);
  useGLTF.preload(FALLBACK_GLB);
  useGLTF.preload('/models/lobster.glb');
  _dracoLoader.preload();
}

// ---------------------------------------------------------------------------
// Utility: Box3 auto-fit
// ---------------------------------------------------------------------------
interface FitResult {
  scale: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

function computeAutoFit(scene: THREE.Object3D, targetHeight: number): FitResult {
  _bbox.makeEmpty();
  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh && mesh.geometry) {
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      _meshBbox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _bbox.union(_meshBbox);
    }
  });
  if (_bbox.isEmpty()) {
    _bbox.setFromObject(scene);
  }

  _bbox.getSize(_size);
  const maxDim = Math.max(_size.x, _size.y, _size.z);
  const scale = maxDim > 0.001 ? targetHeight / maxDim : 1;

  _bbox.getCenter(_center);
  return {
    scale,
    offsetX: _center.x * scale,
    offsetY: _bbox.min.y * scale,
    offsetZ: _center.z * scale,
  };
}

// ---------------------------------------------------------------------------
// Slot machine cabinet geometry + material constants
// (Module-scope: built once, never re-allocated; matrixAutoUpdate=false on meshes)
//
// BUG FIX 2026-05-18 — cabinet HEIGHT dimensions are now WORLD-SCALE (wu),
// not room-scale. The VRM avatar renders at CASINO_VRM_TARGET_HEIGHT=270wu
// (same as the open world), so cabinet heights must be calibrated against
// that 270wu avatar, NOT against the 2000wu room max-dim.
//
// Width/depth still use _ROOM_SCALE (≈3.333) so the cabinet footprint
// fills the room floor proportionally — the cabinets are physically large
// objects that should span a meaningful fraction of the wall.
//
// World-scale sizing (158.8wu ≈ 1m, avatar = 1.7m = 270wu):
//   Body:  ~0.9m tall × 0.6m wide × 0.5m deep  → 143wu × 127wu × 93wu
//   Base:  ~0.1m tall × 0.65m wide × 0.55m deep →  16wu × 140wu × 107wu
//   Screen: ~0.5m tall × 0.38m wide × 0.02m deep → 79wu × 80wu × 5wu
//   Lever: ~0.35m tall, r≈0.04m                  → 56wu height, r=8wu
//
// Cabinet top Y = base(16) + body(143) = 159wu = 59% of 270wu avatar = chest.
// ---------------------------------------------------------------------------
const _CAB_BODY_H_WU  = 143; // world units (NOT room-scaled)
const _CAB_BASE_H_WU  =  16; // world units (NOT room-scaled)
const _CAB_SCREEN_H   =  79; // world units
const _CAB_LEVER_H    =  56; // world units

const CABINET_BODY_GEO    = new THREE.BoxGeometry(
  Math.round(38 * _ROOM_SCALE),  // 127wu wide (room-scaled footprint)
  _CAB_BODY_H_WU,                // 143wu tall (world-scale height)
  Math.round(28 * _ROOM_SCALE),  // 93wu deep (room-scaled footprint)
);
const CABINET_SCREEN_GEO  = new THREE.BoxGeometry(
  Math.round(24 * _ROOM_SCALE),  // 80wu wide
  _CAB_SCREEN_H,                 // 79wu tall (world-scale)
  Math.round(2  * _ROOM_SCALE),  // 7wu thick
);
const CABINET_LEVER_GEO   = new THREE.CylinderGeometry(
  8,  // radius 8wu (world-scale)
  8,
  _CAB_LEVER_H, // 56wu tall (world-scale)
  8,
);
const CABINET_BASE_GEO    = new THREE.BoxGeometry(
  Math.round(42 * _ROOM_SCALE),  // 140wu wide (room-scaled)
  _CAB_BASE_H_WU,                // 16wu tall (world-scale)
  Math.round(32 * _ROOM_SCALE),  // 107wu deep (room-scaled)
);

const CABINET_BODY_MAT = new THREE.MeshStandardMaterial({ color: 0x1a0a2e, roughness: 0.7, metalness: 0.4 });
const CABINET_BASE_MAT = new THREE.MeshStandardMaterial({ color: 0x0d0520, roughness: 0.8, metalness: 0.3 });
const CABINET_LEVER_MAT= new THREE.MeshStandardMaterial({ color: 0xcc3333, roughness: 0.5, metalness: 0.6 });
const CABINET_SCREEN_MAT = new THREE.MeshStandardMaterial({
  color: 0x00ffe0,
  emissive: new THREE.Color(0x00ffe0),
  emissiveIntensity: 1.2,
  roughness: 0.2,
  metalness: 0.1,
});

// ---------------------------------------------------------------------------
// Hotspot definitions — now placed ON the slot cabinet positions
// ---------------------------------------------------------------------------
interface HotspotDef {
  position: [number, number, number];
  size: [number, number, number];
  machineSlug: MachineSlug;
}

// Cabinet Y helpers (world-scale heights — bug fix 2026-05-18, removed _ROOM_SCALE)
const _CAB_BASE_H  = _CAB_BASE_H_WU;                   // 16wu (world-scale)
const _CAB_BODY_H  = _CAB_BODY_H_WU;                   // 143wu (world-scale)
const _CAB_BODY_CY = _CAB_BASE_H + _CAB_BODY_H / 2;   // 87.5wu body center Y

/**
 * Slot cabinet positions: left wall (x≈-380), spread Z across the room.
 * Rotated 90° (facing +X / into the room).
 * All X/Z coordinates scaled by _ROOM_SCALE from the original 600wu values.
 */
const SLOT_CABINET_POSITIONS: Array<{ x: number; z: number }> = [
  { x: -BOUNDS_X, z: Math.round(-175 * _ROOM_SCALE) }, // ≈ -583
  { x: -BOUNDS_X, z: Math.round(-100 * _ROOM_SCALE) }, // ≈ -333
  { x: -BOUNDS_X, z: Math.round( -25 * _ROOM_SCALE) }, // ≈  -83
  { x: -BOUNDS_X, z: Math.round(  50 * _ROOM_SCALE) }, // ≈  166
];

/**
 * Hotspots placed at each cabinet position.
 *
 * Reach/size are world-scale (bug fix 2026-05-18) so the interaction
 * volume matches a 270wu avatar, not the room scale.
 *
 * _CAB_REACH: horizontal distance from cabinet face into room for hotspot center.
 *   Room-scaled width of cabinet footprint / 2 ≈ 47wu + small reach into room.
 * _HOT_SIZE_X: depth into room (x axis) = cabinet footprint depth ≈ 93wu
 * _HOT_SIZE_Y: interaction height = full cabinet body height + base = 159wu
 * _HOT_SIZE_Z: width along wall (z axis) = cabinet width + small buffer = 140wu
 */
const _CAB_REACH   = 80; // wu — reach into room from wall
const _HOT_SIZE_X  = 100; // wu — interaction depth (x)
const _HOT_SIZE_Y  = _CAB_BASE_H + _CAB_BODY_H; // 159wu — full cabinet height
const _HOT_SIZE_Z  = 150; // wu — width along wall (z)

const GAMEREADY_HOTSPOTS: HotspotDef[] = SLOT_CABINET_POSITIONS.map((pos) => ({
  position: [pos.x + _CAB_REACH, _CAB_BODY_CY, pos.z] as [number, number, number],
  size: [_HOT_SIZE_X, _HOT_SIZE_Y, _HOT_SIZE_Z] as [number, number, number],
  machineSlug: 'classic-3x5' as MachineSlug,
}));

const FALLBACK_HOTSPOTS: HotspotDef[] = [
  { position: [-267, 200, -133], size: [167, 267, 133], machineSlug: 'classic-3x5' },
  { position: [ 267, 200, -133], size: [167, 267, 133], machineSlug: 'classic-3x5' },
];

// ---------------------------------------------------------------------------
// SlotCabinets — 4 primitive-based slot machine props on the left wall
// Static geometry; matrixAutoUpdate=false after initial placement.
// ---------------------------------------------------------------------------
function SlotCabinets() {
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    // Lock matrix on the root group and every mesh child — all static.
    g.updateMatrixWorld(true);
    g.traverse((obj) => {
      obj.matrixAutoUpdate = false;
    });
  }, []);

  return (
    <group ref={groupRef}>
      {SLOT_CABINET_POSITIONS.map((pos, i) => (
        <group
          key={i}
          position={[pos.x, 0, pos.z]}
          rotation={[0, Math.PI / 2, 0]} // face into room (+X direction)
        >
          {/* Base plinth — sits on floor, y = half of base height */}
          <mesh geometry={CABINET_BASE_GEO} material={CABINET_BASE_MAT} position={[0, _CAB_BASE_H / 2, 0]} />
          {/* Body — sits on top of base */}
          <mesh geometry={CABINET_BODY_GEO} material={CABINET_BODY_MAT} position={[0, _CAB_BASE_H + _CAB_BODY_H / 2, 0]} />
          {/* Emissive screen — upper 75% of body face, inset slightly toward room.
              Y: base + 75% of body = 16 + 107 = 123wu.
              Z: 45wu inset (world-scale, was room-scaled 50wu). */}
          <mesh geometry={CABINET_SCREEN_GEO} material={CABINET_SCREEN_MAT} position={[0, _CAB_BASE_H + Math.round(_CAB_BODY_H * 0.75), -45]} />
          {/* Lever — extends from right side, world-scale offsets */}
          <mesh geometry={CABINET_LEVER_GEO} material={CABINET_LEVER_MAT} position={[50, _CAB_BASE_H + _CAB_BODY_H / 2, -15]} rotation={[0, 0, Math.PI / 5]} />
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Slot hotspot click box
// ---------------------------------------------------------------------------
function SlotHotspot({ def }: { def: HotspotDef }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const openSlotScreen = useCasinoStore((s) => s.openSlotScreen);
  const { data: avatar } = useAvatar();

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, []);

  const handleClick = () => {
    const startBalance = avatar?.clawTokens ?? 60;
    openSlotScreen(def.machineSlug, 'classic-3x5', startBalance);
  };

  return (
    <mesh
      ref={meshRef}
      position={def.position}
      onPointerOver={(e) => {
        e.stopPropagation();
        if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        if (typeof document !== 'undefined') document.body.style.cursor = 'default';
      }}
      onClick={(e) => {
        e.stopPropagation();
        handleClick();
      }}
    >
      <boxGeometry args={def.size} />
      <meshBasicMaterial visible={false} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// VRM player avatar for casino interior
// Minimal version: loads VRM via useVRMInstance, drives VRMCharacterAnimator,
// WASD movement, no world-map coupling, no terrain raycast (flat floor).
// ---------------------------------------------------------------------------

// Scratch: follow camera + rotation
const _casinoAvatarFwd = new THREE.Vector3();
const _casinoAvatarRight = new THREE.Vector3();
const _casinoWorldUp = new THREE.Vector3(0, 1, 0);

interface CasinoVRMAvatarProps {
  reg: ModelRegistryEntry;
}

function CasinoVRMAvatarInner({ reg }: CasinoVRMAvatarProps) {
  const groupRef = useRef<THREE.Group>(null);
  const rotRef = useRef(Math.PI); // face -Z = into the room on spawn
  const { camera } = useThree();

  // Fix C 2026-05-18: reset module-scope camera yaw on mount so re-entering
  // the casino starts with the camera directly behind the avatar, not carrying
  // over yaw from the previous visit.
  useEffect(() => {
    _casinoCamYaw = Math.PI;
  }, []);

  const vrm = useVRMInstance(reg.path, 'casino-player');

  const { scale: vrmRenderScale, offsetY: vrmFootOffsetY } = useMemo(
    () => computeVRMAvatarFit(vrm, reg.animatorId, CASINO_VRM_TARGET_HEIGHT),
    [vrm, reg.animatorId],
  );

  useEffect(() => {
    return () => disposeVRMInstance(reg.path, 'casino-player');
  }, [reg.path]);

  const vrmAnimRef = useRef<VRMCharacterAnimator | null>(null);
  useEffect(() => {
    if (!vrm) return;
    const anim = new VRMCharacterAnimator(vrm, reg.animatorId);
    vrmAnimRef.current = anim;
    anim.init().catch((e) => console.warn('[CasinoVRM] animator init:', e));
    return () => { vrmAnimRef.current = null; anim.dispose(); };
  }, [vrm, reg.animatorId]);

  // Position state held in refs (zero React overhead)
  const posX = useRef(PLAYER_SPAWN_X);
  const posZ = useRef(PLAYER_SPAWN_Z);

  useFrame((_, delta) => {
    attachCasinoKeyListeners();

    let vx = 0, vz = 0;
    // Camera-relative WASD: project camera forward onto XZ plane
    camera.getWorldDirection(_casinoAvatarFwd);
    _casinoAvatarFwd.y = 0;
    const fwdLen = _casinoAvatarFwd.length();
    if (fwdLen > 0.001) {
      _casinoAvatarFwd.divideScalar(fwdLen);
      _casinoAvatarRight.crossVectors(_casinoAvatarFwd, _casinoWorldUp).normalize();
      let inputFwd = 0, inputRight = 0;
      if (casinoKeys.w) inputFwd += 1;
      if (casinoKeys.s) inputFwd -= 1;
      if (casinoKeys.a) inputRight -= 1;
      if (casinoKeys.d) inputRight += 1;
      if (inputFwd !== 0 || inputRight !== 0) {
        vx = _casinoAvatarFwd.x * inputFwd + _casinoAvatarRight.x * inputRight;
        vz = _casinoAvatarFwd.z * inputFwd + _casinoAvatarRight.z * inputRight;
        const len = Math.sqrt(vx * vx + vz * vz);
        if (len > 1) { vx /= len; vz /= len; }
      }
    }

    const isMoving = vx !== 0 || vz !== 0;

    if (isMoving) {
      posX.current = Math.max(-BOUNDS_X, Math.min(BOUNDS_X, posX.current + vx * CASINO_PLAYER_SPEED * delta));
      posZ.current = Math.max(BOUNDS_Z_MIN, Math.min(BOUNDS_Z_MAX, posZ.current + vz * CASINO_PLAYER_SPEED * delta));
      // Facing: VRM faces -Z at rot=0; atan2(vx, vz) gives facing toward movement direction
      const targetRot = Math.atan2(vx, vz);
      let diff = targetRot - rotRef.current;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      rotRef.current += diff * 0.15;
    }

    const group = groupRef.current;
    if (!group) return;

    group.position.x = posX.current;
    group.position.y = 0;
    group.position.z = posZ.current;
    group.rotation.y = rotRef.current;

    // Follow camera — CAM_ABOVE wu above, CAM_BEHIND wu behind, look at avatar mid-torso.
    // Bug fix 2026-05-18: camera azimuth now uses a SEPARATE _casinoCamYaw that
    // lerps toward the avatar's rotRef.current at CAM_YAW_LERP=0.05 (1/3 of avatar
    // turn rate 0.15). This decouples the viewport from immediate avatar yaw so
    // pressing A/D causes the avatar to turn while the camera follows with lag —
    // feels like a real room camera rather than the whole view snapping 45°.
    const slotOpen = useCasinoStore.getState().slotScreenOpen;
    if (!slotOpen) {
      const cam = camera as THREE.PerspectiveCamera;
      // Smooth camera yaw — shortest-path lerp toward avatar facing
      let camYawDiff = rotRef.current - _casinoCamYaw;
      while (camYawDiff > Math.PI) camYawDiff -= Math.PI * 2;
      while (camYawDiff < -Math.PI) camYawDiff += Math.PI * 2;
      _casinoCamYaw += camYawDiff * CAM_YAW_LERP;
      // Camera behind position derived from lagged camYaw, not avatar yaw
      const behindX = -Math.sin(_casinoCamYaw) * CAM_BEHIND;
      const behindZ = -Math.cos(_casinoCamYaw) * CAM_BEHIND;
      _camDesiredPos.set(
        posX.current + behindX,
        CAM_ABOVE,
        posZ.current + behindZ,
      );
      // Soft lerp — exp-decay for smooth position follow
      cam.position.lerp(_camDesiredPos, 1 - Math.exp(-8 * delta));
      _camTarget.set(posX.current, CAM_LOOK_Y, posZ.current);
      cam.lookAt(_camTarget);
    }

    // Animate VRM
    const anim = vrmAnimRef.current;
    if (anim) {
      anim.update(Math.min(delta, 0.1), isMoving, false);
    }
  });

  return (
    <group ref={groupRef} position={[PLAYER_SPAWN_X, 0, PLAYER_SPAWN_Z]} rotation={[0, Math.PI, 0]}>
      <primitive
        object={vrm.scene}
        scale={[vrmRenderScale, vrmRenderScale, vrmRenderScale]}
        position={[0, vrmFootOffsetY, 0]}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// GLB fallback player avatar (lobster)
// ---------------------------------------------------------------------------

// Scratch for GLB pivot
const _glbAvatarBbox = new THREE.Box3();
const _glbMeshBbox   = new THREE.Box3();

function computeGlbLocalMinY(scene: THREE.Object3D): number {
  scene.updateMatrixWorld(true);
  _glbAvatarBbox.makeEmpty();
  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox; if (!bb) return;
      _glbMeshBbox.copy(bb).applyMatrix4(mesh.matrixWorld);
      _glbAvatarBbox.union(_glbMeshBbox);
    }
  });
  if (_glbAvatarBbox.isEmpty()) _glbAvatarBbox.setFromObject(scene);
  return _glbAvatarBbox.isEmpty() ? 0 : _glbAvatarBbox.min.y;
}

function CasinoGLBAvatarInner() {
  const groupRef  = useRef<THREE.Group>(null);
  const rotRef    = useRef(Math.PI);
  const { camera } = useThree();

  // Fix C 2026-05-18: reset module-scope camera yaw on mount (mirrors VRM branch).
  useEffect(() => {
    _casinoCamYaw = Math.PI;
  }, []);

  const { scene } = useGLTF('/models/lobster.glb');

  const { cloned, pivotOffsetY } = useMemo(() => {
    const c = scene.clone(true);
    makeObject3DWebGPUSafe(c);
    c.traverse((obj) => {
      obj.frustumCulled = false;
      // Bug fix 2026-05-18: clone every material so this canvas's renderer
      // context gets fresh GPU program compilations instead of sharing the
      // MeshStandardMaterial instances that were compiled in the world
      // canvas's WebGL context.  Shared materials across renderer contexts
      // produce the purple/pink #ff00ff "missing program" fallback color.
      // This mirrors the pattern in player-avatar.tsx PlayerAvatarGLBInner.
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map((m) => m.clone());
        } else {
          mesh.material = mesh.material.clone();
        }
      }
    });
    const localMinY = computeGlbLocalMinY(c);
    return { cloned: c, pivotOffsetY: localMinY * CASINO_AVATAR_SCALE };
  }, [scene]);

  const posX = useRef(PLAYER_SPAWN_X);
  const posZ = useRef(PLAYER_SPAWN_Z);

  useFrame((_, delta) => {
    attachCasinoKeyListeners();

    let vx = 0, vz = 0;
    camera.getWorldDirection(_casinoAvatarFwd);
    _casinoAvatarFwd.y = 0;
    const fwdLen = _casinoAvatarFwd.length();
    if (fwdLen > 0.001) {
      _casinoAvatarFwd.divideScalar(fwdLen);
      _casinoAvatarRight.crossVectors(_casinoAvatarFwd, _casinoWorldUp).normalize();
      let inputFwd = 0, inputRight = 0;
      if (casinoKeys.w) inputFwd += 1;
      if (casinoKeys.s) inputFwd -= 1;
      if (casinoKeys.a) inputRight -= 1;
      if (casinoKeys.d) inputRight += 1;
      if (inputFwd !== 0 || inputRight !== 0) {
        vx = _casinoAvatarFwd.x * inputFwd + _casinoAvatarRight.x * inputRight;
        vz = _casinoAvatarFwd.z * inputFwd + _casinoAvatarRight.z * inputRight;
        const len = Math.sqrt(vx * vx + vz * vz);
        if (len > 1) { vx /= len; vz /= len; }
      }
    }

    const isMoving = vx !== 0 || vz !== 0;

    if (isMoving) {
      posX.current = Math.max(-BOUNDS_X, Math.min(BOUNDS_X, posX.current + vx * CASINO_PLAYER_SPEED * delta));
      posZ.current = Math.max(BOUNDS_Z_MIN, Math.min(BOUNDS_Z_MAX, posZ.current + vz * CASINO_PLAYER_SPEED * delta));
      // lobster.glb faces +Z at rot=0 — same formula as main world
      const targetRot = Math.atan2(vx, vz);
      let diff = targetRot - rotRef.current;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      rotRef.current += diff * 0.15;
    }

    const group = groupRef.current;
    if (!group) return;

    group.position.x = posX.current;
    group.position.y = 2 - pivotOffsetY;
    group.position.z = posZ.current;
    group.rotation.y = rotRef.current;

    // Follow camera — same offsets as VRM branch (CAM_ABOVE/CAM_BEHIND/CAM_LOOK_Y).
    // Bug fix 2026-05-18: use shared _casinoCamYaw (same module-scope ref as VRM
    // branch) so the GLB lobster fallback also gets the lagged camera behaviour —
    // pressing A/D turns the lobster smoothly without snapping the viewport 45°.
    const slotOpen = useCasinoStore.getState().slotScreenOpen;
    if (!slotOpen) {
      const cam = camera as THREE.PerspectiveCamera;
      // Smooth camera yaw — shortest-path lerp toward avatar facing (same as VRM branch)
      let camYawDiff = rotRef.current - _casinoCamYaw;
      while (camYawDiff > Math.PI) camYawDiff -= Math.PI * 2;
      while (camYawDiff < -Math.PI) camYawDiff += Math.PI * 2;
      _casinoCamYaw += camYawDiff * CAM_YAW_LERP;
      const behindX = -Math.sin(_casinoCamYaw) * CAM_BEHIND;
      const behindZ = -Math.cos(_casinoCamYaw) * CAM_BEHIND;
      _camDesiredPos.set(posX.current + behindX, CAM_ABOVE, posZ.current + behindZ);
      cam.position.lerp(_camDesiredPos, 1 - Math.exp(-8 * delta));
      _camTarget.set(posX.current, CAM_LOOK_Y, posZ.current);
      cam.lookAt(_camTarget);
    }
  });

  return (
    <group ref={groupRef} position={[PLAYER_SPAWN_X, 2 - 0, PLAYER_SPAWN_Z]} rotation={[0, Math.PI, 0]}>
      <primitive object={cloned} scale={CASINO_AVATAR_SCALE} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// CasinoPlayerAvatar — routes to VRM or GLB based on avatarModelKey
// ---------------------------------------------------------------------------
function CasinoPlayerAvatar() {
  const avatarModelKey = useGameStore((s) => s.avatarModelKey);
  const reg: ModelRegistryEntry =
    MODEL_REGISTRY[avatarModelKey as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY.lobster;

  if (reg.avatar_type === 'vrm') {
    return (
      <Suspense fallback={null}>
        <CasinoVRMAvatarInner reg={reg} />
      </Suspense>
    );
  }

  return <CasinoGLBAvatarInner />;
}

// ---------------------------------------------------------------------------
// GLB loader + scene subtree
// ---------------------------------------------------------------------------
interface InteriorSceneProps {
  useFallback: boolean;
  onFallbackRequest: () => void;
  onSceneEmpty: () => void;
}

function InteriorScene({ useFallback, onFallbackRequest, onSceneEmpty }: InteriorSceneProps) {
  const glbPath = useFallback ? FALLBACK_GLB : INTERIOR_GLB;
  const { scene } = useGLTF(
    glbPath,
    undefined,
    undefined,
    useFallback ? undefined : extendWithDraco,
  );
  const { camera } = useThree();

  const groupRef = useRef<THREE.Group>(null);

  const fpsFrames  = useRef(0);
  const fpsAccum   = useRef(0);
  const fpsChecked = useRef(false);
  const emptyFired = useRef(false);

  const { cloned, hotspots, meshCount } = useMemo(() => {
    const c = scene.clone(true);
    c.updateMatrixWorld(true);

    const fitResult = computeAutoFit(c, INTERIOR_TARGET_HEIGHT);

    c.scale.setScalar(fitResult.scale);
    c.position.set(-fitResult.offsetX, -fitResult.offsetY, -fitResult.offsetZ);
    c.updateMatrixWorld(true);

    c.traverse((obj) => {
      obj.matrixAutoUpdate = false;
    });

    if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_CASINO_DEBUG === '1') {
      const bbox2 = new THREE.Box3().setFromObject(c);
      const sz = new THREE.Vector3(); bbox2.getSize(sz);
      const ct = new THREE.Vector3(); bbox2.getCenter(ct);
      console.info('[casino-fit]',
        'scale=' + fitResult.scale.toFixed(4),
        'worldCenter=(' + ct.x.toFixed(1) + ',' + ct.y.toFixed(1) + ',' + ct.z.toFixed(1) + ')',
        'worldSize=(' + sz.x.toFixed(1) + ',' + sz.y.toFixed(1) + ',' + sz.z.toFixed(1) + ')');
    }

    const hotspotDefs = useFallback ? FALLBACK_HOTSPOTS : GAMEREADY_HOTSPOTS;

    let count = 0;
    c.traverse((obj) => { if ((obj as THREE.Mesh).isMesh) count++; });

    return { cloned: c, hotspots: hotspotDefs, meshCount: count };
  }, [scene, useFallback]);

  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m) => m?.dispose());
        }
      });
    };
  }, [cloned]);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.matrixAutoUpdate = false;
    g.updateMatrix();
  }, [cloned]);

  // Camera debug log
  const debugLogged = useRef(false);
  useFrame(() => {
    if (debugLogged.current) return;
    debugLogged.current = true;
    if (process.env.NEXT_PUBLIC_CASINO_DEBUG === '1') {
      const cam = camera as THREE.PerspectiveCamera;
      const g = groupRef.current;
      console.info(
        '[casino-interior DEBUG]\n' +
        `  glb: ${glbPath}\n` +
        `  meshCount: ${meshCount}\n` +
        `  cloned.position: (${cloned.position.x.toFixed(1)}, ${cloned.position.y.toFixed(1)}, ${cloned.position.z.toFixed(1)})\n` +
        `  cloned.scale: ${cloned.scale.x.toFixed(4)}\n` +
        `  group.position: ${g ? `(${g.position.x.toFixed(1)}, ${g.position.y.toFixed(1)}, ${g.position.z.toFixed(1)})` : 'null'}\n` +
        `  camera.position: (${cam.position.x.toFixed(1)}, ${cam.position.y.toFixed(1)}, ${cam.position.z.toFixed(1)})\n` +
        `  camera.fov=${cam.fov} near=${cam.near} far=${cam.far}`
      );
    }
  });

  // FPS auto-fallback + scene-empty fail-safe
  useFrame((_, delta) => {
    if (useFallback && fpsChecked.current && emptyFired.current) return;

    fpsAccum.current += delta;
    fpsFrames.current += 1;

    if (!emptyFired.current && fpsAccum.current >= 3.0 && meshCount === 0) {
      emptyFired.current = true;
      onSceneEmpty();
    }

    if (!fpsChecked.current && !useFallback && fpsAccum.current >= 5.0) {
      fpsChecked.current = true;
      const avgFps = fpsFrames.current / fpsAccum.current;
      if (avgFps < FPS_FALLBACK_THRESHOLD) {
        console.warn(`[casino-interior] avg FPS ${avgFps.toFixed(1)} < ${FPS_FALLBACK_THRESHOLD} — switching to fallback GLB`);
        onFallbackRequest();
      } else {
        console.log(`[casino-interior] FPS OK (avg ${avgFps.toFixed(1)})`);
      }
    }
  });

  return (
    <group ref={groupRef}>
      <primitive object={cloned} />

      {/* Slot cabinet props — visible 3D objects players click to open slot screen */}
      {!useFallback && <SlotCabinets />}

      {/* Invisible click hotspots over slot machines */}
      {hotspots.map((def, i) => (
        <SlotHotspot key={i} def={def} />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Default export — full casino interior scene
// ---------------------------------------------------------------------------
export interface CasinoInteriorSceneProps {
  onSceneEmpty?: () => void;
}

export default function CasinoInteriorScene({ onSceneEmpty }: CasinoInteriorSceneProps = {}) {
  const [useFallback, setUseFallback] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('fallback') === '1';
  });

  return (
    <>
      <CasinoLighting />

      {/* Fog scaled with room: near=4000, far=10000 (was 1200/3000 for 600wu room → ×3.333) */}
      <fog attach="fog" args={[0x0a0015, 4000, 10000]} />

      <Suspense fallback={null}>
        <InteriorScene
          useFallback={useFallback}
          onFallbackRequest={() => setUseFallback(true)}
          onSceneEmpty={onSceneEmpty ?? (() => {})}
        />
      </Suspense>

      {/* Walkable player avatar — mounted outside InteriorScene Suspense so
          GLB/VRM loading doesn't block the casino room from appearing first. */}
      <CasinoPlayerAvatar />
    </>
  );
}
