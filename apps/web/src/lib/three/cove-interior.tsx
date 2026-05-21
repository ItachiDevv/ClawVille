'use client';

/**
 * cove-interior.tsx
 *
 * Route-isolated R3F scene component for the cove interior.
 * Mounted exclusively at /cove — torn down on exit via Canvas key prop.
 *
 * Concern 6.0.5 — Walkable interior:
 *   - Player avatar (VRM or GLB) mounted inside the cove room.
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
 *   - Slot UI opens when player clicks a cabinet (useCoveStore.openSlotScreen).
 *
 * Asset: /models/cove/cove-interior.glb (gameready, 4.2MB, Draco)
 *        /models/cove/cove-interior-fallback.glb (cartoon, 58KB, no Draco)
 *
 * Iris Xe invariants (enforced in this file):
 *   - NO shadows
 *   - NO drei Text / Billboard
 *   - NO InstancedMesh + ShaderMaterial
 *   - NO per-frame `new Vector3()` — module-scope scratch vectors only
 *   - matrixAutoUpdate=false on all static meshes after first transform
 *   - Draw calls < 140 (room ~21 + cabinets 12 + avatar ~2-4 + hotspot 4)
 */

import { Suspense, useRef, useEffect, useMemo, useState, type RefObject, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { CoveLighting } from '@/components/three/CoveLighting';
import { useCoveStore } from '@/stores/cove';
import { useAvatar } from '@/hooks/use-avatar';
import { useGameStore } from '@/stores/game';
import { useVRMInstance, disposeVRMInstance } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator } from '@/lib/three/vrm-character-animator';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import { MODEL_REGISTRY, type ModelRegistryEntry } from '@/lib/three/agent-model-registry';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { clampCameraToRoom, type RoomBounds } from '@/lib/three/room-camera';
import { useWorldLabel, WorldLabel, WorldLabelsOverlayMount } from '@/lib/three/world-labels-overlay';
import type { MachineSlug } from '@/lib/cove/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gameready GLB path */
const INTERIOR_GLB = '/models/cove/cove-interior.glb';
/** Fallback cartoon GLB */
const FALLBACK_GLB = '/models/cove/cove-interior-fallback.glb';

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

/** Player movement speed (world units / second) — tuned for cove interior */
// 2026-05-19: 830→450. User report: "WASD movement is way too fast". The
// 830 value (250×_ROOM_SCALE) preserved traversal *time* across the bigger
// room but ignored that the avatar reads as smaller now (160wu vs 270wu
// outdoors) — perceived speed scales with avatar height, not room size.
// 450wu/s feels like a brisk walk at this avatar scale.
const COVE_PLAYER_SPEED = 450;

/** GLB avatar scale — matches AVATAR_SCALE in player-avatar.tsx */
const COVE_AVATAR_SCALE = 40;

/**
 * VRM avatar target height inside the cove (world units).
 *
 * BUG FIX 2026-05-18 (pass 2): dropped from 270wu → 160wu.
 *
 * The previous Implementer set COVE_VRM_TARGET_HEIGHT = 270, which equals
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
const COVE_VRM_TARGET_HEIGHT = 160; // wu — deliberately SMALLER than VRM_AVATAR_TARGET_HEIGHT_WU=270

// Follow-camera offsets calibrated for VRM avatar at COVE_VRM_TARGET_HEIGHT = 160wu.
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
// The camera azimuth is FIXED at spawn yaw (Math.PI) and only changes via
// arrow-key orbit. It is NOT coupled to the avatar's facing — that produces
// a positive feedback loop with camera-relative strafe (see Bug 4 fix
// 2026-05-19 in the follow-camera block below). The avatar's body still
// rotates to face movement direction; only the camera is decoupled.
const CAM_ABOVE  = 190;
const CAM_BEHIND = 450;
const CAM_LOOK_Y = 70;

/**
 * Arrow-key orbit constants — mirror of World3DCanvas ArrowKeyRotationController.
 *
 * Left/Right: orbit the camera horizontally around the avatar (yaw offset).
 * Up/Down:    tilt the camera up or down (pitch offset, wu added to CAM_ABOVE).
 *
 * The offsets persist — pressing ArrowLeft keeps rotating until ArrowRight
 * is pressed or the key is released (same hold-to-orbit feel as the world).
 * Unlike the world they do NOT decay back to 0; the player must press the
 * opposite key (same as world OrbitControls behaviour).
 */
// 2026-05-19: 1.5→2.2 (user: "camera turn angles is a little bit too slow").
// 2.2 rad/s = ~126°/s — full 360° in 2.85s, comfortable orbit feel.
const ARROW_YAW_SPEED   = 2.2;   // radians / second
const ARROW_PITCH_SPEED = 200;   // wu / second  (camera height shift per second while held)
const ARROW_PITCH_MIN   = -100;  // wu relative to CAM_ABOVE (look down)
const ARROW_PITCH_MAX   =  400;  // wu relative to CAM_ABOVE (look up — sky)

// AABB for camera containment — derived from room bounds + small inward margin.
const COVE_ROOM_BOUNDS: RoomBounds = {
  halfX: BOUNDS_X,
  zMin:  BOUNDS_Z_MIN,
  zMax:  BOUNDS_Z_MAX,
  yMin:  30,    // floor + clearance
  yMax:  600,   // ceiling − clearance (room ceiling ≈ 400wu, 600 gives slack for tilt)
  margin: 50,   // wu inset from each wall face
};

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

// Camera yaw anchor — STATIC spawn-direction reference (avatar faces -Z = Math.PI).
// Bug 4 fix 2026-05-19: this is no longer auto-tracked to `rotRef.current`.
// Camera-relative WASD + auto-track = positive feedback loop on strafe input
// (every A/D press snapped the viewport ~45°). The camera now stays at spawn
// yaw and only orbits via `_coveArrowYawOffset` (arrow-key controlled).
let _coveCamYaw = Math.PI;

// Arrow-key perspective-orbit offsets (Bug 2 fix 2026-05-19).
// These accumulate while arrow keys are held, exactly like
// World3DCanvas.ArrowKeyRotationController — the camera orbits around
// the avatar and stays at the new angle when keys are released.
// Separate from WASD movement; avatars never rotate from arrow keys.
let _coveArrowYawOffset   = 0; // radians added to _coveCamYaw for behind-position
let _coveArrowPitchOffset = 0; // wu added to CAM_ABOVE for camera height

// ---------------------------------------------------------------------------
// Module-scope cove WASD key state — separate from the world player-avatar
// keyState module to avoid cross-canvas contamination (cove is a different
// R3F Canvas instance entirely — it can't share global input state with the
// world canvas which may still be active in the component tree).
//
// Bug 2 fix 2026-05-19: Arrow keys are NO LONGER mapped to WASD movement.
// They now drive camera perspective-orbit only (see _coveArrowKeys below).
// WASD-only movement matches how the main world works: WASD moves the avatar,
// arrows rotate the camera.
// ---------------------------------------------------------------------------
interface CoveKeyState {
  w: boolean; a: boolean; s: boolean; d: boolean; e: boolean;
}
const coveKeys: CoveKeyState = { w: false, a: false, s: false, d: false, e: false };
let coveKeyListenersAttached = false;

function attachCoveKeyListeners() {
  if (coveKeyListenersAttached) return;
  coveKeyListenersAttached = true;

  const onKeyDown = (e: KeyboardEvent) => {
    // Only single-character keys drive movement. Arrow keys (multi-char)
    // are handled exclusively by attachCoveArrowListeners for camera orbit.
    const k = e.key.length === 1 ? e.key.toLowerCase() : null;
    if (k === 'w') coveKeys.w = true;
    if (k === 's') coveKeys.s = true;
    if (k === 'a') coveKeys.a = true;
    if (k === 'd') coveKeys.d = true;
    if (k === 'e') coveKeys.e = true;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : null;
    if (k === 'w') coveKeys.w = false;
    if (k === 's') coveKeys.s = false;
    if (k === 'a') coveKeys.a = false;
    if (k === 'd') coveKeys.d = false;
    if (k === 'e') { coveKeys.e = false; _eKeyConsumed = false; }
  };
  const onBlur = () => {
    coveKeys.w = coveKeys.a = coveKeys.s = coveKeys.d = coveKeys.e = false;
    _eKeyConsumed = false;
  };
  const onVis = () => {
    if (document.hidden) {
      coveKeys.w = coveKeys.a = coveKeys.s = coveKeys.d = coveKeys.e = false;
      _eKeyConsumed = false;
    }
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVis);
}

// ---------------------------------------------------------------------------
// Arrow-key perspective-orbit listener — mirrors World3DCanvas.ArrowKeyRotationController.
//
// ArrowLeft/Right → horizontal orbit (yaw around avatar, matches world theta).
// ArrowUp/Down    → vertical tilt (camera height, matches world phi).
//
// No movement whatsoever — these keys ONLY affect the camera, not the avatar.
// ---------------------------------------------------------------------------
interface CoveArrowState {
  left: boolean; right: boolean; up: boolean; down: boolean;
}
const _coveArrowKeys: CoveArrowState = { left: false, right: false, up: false, down: false };
let coveArrowListenersAttached = false;

function attachCoveArrowListeners() {
  if (coveArrowListenersAttached) return;
  coveArrowListenersAttached = true;

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowLeft':  _coveArrowKeys.left  = true; e.preventDefault(); break;
      case 'ArrowRight': _coveArrowKeys.right = true; e.preventDefault(); break;
      case 'ArrowUp':    _coveArrowKeys.up    = true; e.preventDefault(); break;
      case 'ArrowDown':  _coveArrowKeys.down  = true; e.preventDefault(); break;
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowLeft':  _coveArrowKeys.left  = false; break;
      case 'ArrowRight': _coveArrowKeys.right = false; break;
      case 'ArrowUp':    _coveArrowKeys.up    = false; break;
      case 'ArrowDown':  _coveArrowKeys.down  = false; break;
    }
  };
  const onBlur = () => {
    _coveArrowKeys.left = _coveArrowKeys.right = _coveArrowKeys.up = _coveArrowKeys.down = false;
  };
  const onVis = () => { if (document.hidden) {
    _coveArrowKeys.left = _coveArrowKeys.right = _coveArrowKeys.up = _coveArrowKeys.down = false;
  } };
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
// not room-scale. The VRM avatar renders at COVE_VRM_TARGET_HEIGHT=270wu
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
// Bonus cabinet body: subtle gold tint so players can distinguish at a glance
const CABINET_BODY_BONUS_MAT = new THREE.MeshStandardMaterial({
  color: 0x2a1800,
  emissive: new THREE.Color(0xffaa00),
  emissiveIntensity: 0.18,
  roughness: 0.55,
  metalness: 0.55,
});
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
  /** Which paytable to load when this cabinet is clicked. */
  paytableId: MachineSlug;
  /** True for the bonus-paytable cabinets (tinted gold body + BONUS badge). */
  isBonus: boolean;
}

// Cabinet Y helpers (world-scale heights — bug fix 2026-05-18, removed _ROOM_SCALE)
const _CAB_BASE_H  = _CAB_BASE_H_WU;                   // 16wu (world-scale)
const _CAB_BODY_H  = _CAB_BODY_H_WU;                   // 143wu (world-scale)
const _CAB_BODY_CY = _CAB_BASE_H + _CAB_BODY_H / 2;   // 87.5wu body center Y

// ---------------------------------------------------------------------------
// BONUS badge — canvas texture built once at module scope.
// PlaneGeometry + MeshBasicMaterial (no lighting, always visible).
// Iris Xe safe: no drei Text/Billboard.
// Declared after _CAB_BASE_H/_CAB_BODY_H so _BADGE_Y can reference them.
// ---------------------------------------------------------------------------
function _buildBonusBadgeTexture(): THREE.CanvasTexture {
  const W = 256, H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Transparent background
  ctx.clearRect(0, 0, W, H);

  // Background pill
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0,   'rgba(255,170,0,0.85)');
  grad.addColorStop(0.5, 'rgba(255,210,80,0.92)');
  grad.addColorStop(1,   'rgba(255,170,0,0.85)');
  ctx.fillStyle = grad;
  const r = H / 2;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(W - r, 0);
  ctx.arcTo(W, 0, W, H, r);
  ctx.lineTo(W, H); ctx.lineTo(0, H);
  ctx.arcTo(0, H, 0, 0, r);
  ctx.closePath();
  ctx.fill();

  // "💎 BONUS" text
  ctx.fillStyle = '#1a0800';
  ctx.font = 'bold 28px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('\u{1F48E} BONUS', W / 2, H / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Lazy-init: only allocate when running in browser (CanvasTexture needs a DOM).
let _bonusBadgeTexture: THREE.CanvasTexture | null = null;
function getBonusBadgeTexture(): THREE.CanvasTexture {
  if (!_bonusBadgeTexture) _bonusBadgeTexture = _buildBonusBadgeTexture();
  return _bonusBadgeTexture;
}

const BONUS_BADGE_GEO = (() => {
  // Badge plane: 120wu wide × 30wu tall — readable above 159wu cabinet top.
  // Built at module scope but only in browser context.
  if (typeof window === 'undefined') return new THREE.PlaneGeometry(1, 1);
  return new THREE.PlaneGeometry(120, 30);
})();

// Badge center Y: cabinet top (159wu) + 20wu gap + 15wu (half badge height) = 194wu.
const _BADGE_Y = _CAB_BASE_H + _CAB_BODY_H + 20 + 15;

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

/**
 * Cabinet paytable assignment: first 2 cabinets are classic, last 2 are bonus.
 * Cabinet order: z≈-583, z≈-333 = classic; z≈-83, z≈166 = bonus.
 */
const GAMEREADY_HOTSPOTS: HotspotDef[] = SLOT_CABINET_POSITIONS.map((pos, i) => {
  const isBonus = i >= 2;
  return {
    position: [pos.x + _CAB_REACH, _CAB_BODY_CY, pos.z] as [number, number, number],
    size: [_HOT_SIZE_X, _HOT_SIZE_Y, _HOT_SIZE_Z] as [number, number, number],
    machineSlug: (isBonus ? 'classic-3x5-bonus' : 'classic-3x5') as MachineSlug,
    paytableId: (isBonus ? 'classic-3x5-bonus' : 'classic-3x5') as MachineSlug,
    isBonus,
  };
});

const FALLBACK_HOTSPOTS: HotspotDef[] = [
  { position: [-267, 200, -133], size: [167, 267, 133], machineSlug: 'classic-3x5', paytableId: 'classic-3x5', isBonus: false },
  { position: [ 267, 200, -133], size: [167, 267, 133], machineSlug: 'classic-3x5', paytableId: 'classic-3x5', isBonus: false },
];

// ---------------------------------------------------------------------------
// Proximity label + E-key interaction constants
// (placed after SLOT_CABINET_POSITIONS so computed Z values are accurate)
// ---------------------------------------------------------------------------

/** Distance at which the bank label becomes visible. */
const BANK_LABEL_FADE_NEAR = 50;
/** Distance at which the bank label fades to 0. */
const BANK_LABEL_FADE_FAR  = 600;
/** Distance at which "press E" hint appears in label. */
const BANK_INTERACT_NEAR = 250;
/** Distance at which pressing E actually fires openSlotScreen. */
const BANK_INTERACT_ARM  = 200;

// Classic bank: cabinets 0+1 (z≈-583, z≈-333)
// _CAB_BASE_H_WU=16, _CAB_BODY_H_WU=143 → top=159wu; label at 219wu
const CLASSIC_BANK_CENTROID_X = -(Math.round(115 * (2000 / 600))) + 60; // -383+60 = -323
const CLASSIC_BANK_CENTROID_Z = -458; // midpoint of cabs 0+1
const CLASSIC_BANK_LABEL_Y    = 219;  // 159wu cabinet top + 60wu

// Bonus bank: cabinets 2+3 (z≈-83, z≈166)
const BONUS_BANK_CENTROID_X = -(Math.round(115 * (2000 / 600))) + 60;
const BONUS_BANK_CENTROID_Z = 41;   // midpoint of cabs 2+3
const BONUS_BANK_LABEL_Y    = 219;

// Module-scope anchor Object3Ds for label projection (never added to scene — getWorldPosition still works)
const _classicBankAnchor = new THREE.Object3D();
_classicBankAnchor.position.set(CLASSIC_BANK_CENTROID_X, CLASSIC_BANK_LABEL_Y, CLASSIC_BANK_CENTROID_Z);
_classicBankAnchor.matrixAutoUpdate = false;
_classicBankAnchor.updateMatrix();
_classicBankAnchor.updateWorldMatrix(false, false);

const _bonusBankAnchor = new THREE.Object3D();
_bonusBankAnchor.position.set(BONUS_BANK_CENTROID_X, BONUS_BANK_LABEL_Y, BONUS_BANK_CENTROID_Z);
_bonusBankAnchor.matrixAutoUpdate = false;
_bonusBankAnchor.updateMatrix();
_bonusBankAnchor.updateWorldMatrix(false, false);

// Stable RefObjects wrapping the module-scope anchors
const _classicAnchorRef = { current: _classicBankAnchor } as RefObject<THREE.Object3D | null>;
const _bonusAnchorRef   = { current: _bonusBankAnchor }   as RefObject<THREE.Object3D | null>;

// E-key armed state
type ArmedBank = 'classic' | 'bonus' | null;
let _eKeyArmedBank: ArmedBank = null;
// Consumed guard: prevent repeat-fire while E is held
let _eKeyConsumed = false;
// Proximity hint flags: true = player is within BANK_INTERACT_NEAR of that bank
// Read by BankLabels useFrame to update label content
let _classicBankNearHint = false;
let _bonusBankNearHint   = false;
// Avatar ClawToken balance — written by avatar components via useEffect, read by E-key handler
let _coveAvatarClawTokens = 60;

// ---------------------------------------------------------------------------
// AABB collision — cabinet footprints + dealer station (XZ plane only)
// All computations use read-time values (post-const, post-SLOT_CABINET_POSITIONS).
// ---------------------------------------------------------------------------

// Cabinet AABB half-extents
const _CAB_AABB_HALF_X = 60; // wu — depth into room from wall face
const _CAB_AABB_HALF_Z = 80; // wu — half width along wall

interface CabinetAABB {
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
}

const _cabinetAABBs: CabinetAABB[] = SLOT_CABINET_POSITIONS.map((pos) => ({
  centerX: pos.x + _CAB_AABB_HALF_X, // cabinet face + half depth into room
  centerZ: pos.z,
  halfX: _CAB_AABB_HALF_X,
  halfZ: _CAB_AABB_HALF_Z,
}));

// Dealer station AABB (world X ≈ +367 post-autofit, Z ≈ 0)
const _DEALER_CENTER_X =  367;
const _DEALER_CENTER_Z =    0;
const _DEALER_HALF_X   =  100;
const _DEALER_HALF_Z   =  100;

// Scratch for collision — never allocated in useFrame
let _col_px = 0, _col_pz = 0;

function _resolveCoveCollisions(posX: MutableRefObject<number>, posZ: MutableRefObject<number>, avatarHalf: number): void {
  _col_px = posX.current;
  _col_pz = posZ.current;
  const aw = avatarHalf;

  for (let i = 0; i < _cabinetAABBs.length; i++) {
    const cab = _cabinetAABBs[i]!;
    const ox = (cab.halfX + aw) - Math.abs(_col_px - cab.centerX);
    const oz = (cab.halfZ + aw) - Math.abs(_col_pz - cab.centerZ);
    if (ox > 0 && oz > 0) {
      if (ox < oz) {
        _col_px += _col_px < cab.centerX ? -ox : ox;
      } else {
        _col_pz += _col_pz < cab.centerZ ? -oz : oz;
      }
    }
  }

  {
    const ox = (_DEALER_HALF_X + aw) - Math.abs(_col_px - _DEALER_CENTER_X);
    const oz = (_DEALER_HALF_Z + aw) - Math.abs(_col_pz - _DEALER_CENTER_Z);
    if (ox > 0 && oz > 0) {
      if (ox < oz) {
        _col_px += _col_px < _DEALER_CENTER_X ? -ox : ox;
      } else {
        _col_pz += _col_pz < _DEALER_CENTER_Z ? -oz : oz;
      }
    }
  }

  posX.current = _col_px;
  posZ.current = _col_pz;
}

// ---------------------------------------------------------------------------
// SlotCabinets — 4 primitive-based slot machine props on the left wall
// Static geometry; matrixAutoUpdate=false after initial placement.
// Props: hotspots array provides isBonus flag for material + badge selection.
// ---------------------------------------------------------------------------
interface SlotCabinetsProps {
  hotspots: HotspotDef[];
}

function SlotCabinets({ hotspots }: SlotCabinetsProps) {
  const groupRef = useRef<THREE.Group>(null);

  // Resolve badge material lazily — CanvasTexture requires browser DOM.
  const bonusBadgeMat = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new THREE.MeshBasicMaterial({
      map: getBonusBadgeTexture(),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }, []);

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
      {SLOT_CABINET_POSITIONS.map((pos, i) => {
        const isBonus = hotspots[i]?.isBonus ?? false;
        const bodyMat = isBonus ? CABINET_BODY_BONUS_MAT : CABINET_BODY_MAT;
        return (
          <group
            key={i}
            position={[pos.x, 0, pos.z]}
            rotation={[0, Math.PI / 2, 0]} // face into room (+X direction)
          >
            {/* Base plinth — sits on floor, y = half of base height */}
            <mesh geometry={CABINET_BASE_GEO} material={CABINET_BASE_MAT} position={[0, _CAB_BASE_H / 2, 0]} />
            {/* Body — classic or gold-tinted bonus */}
            <mesh geometry={CABINET_BODY_GEO} material={bodyMat} position={[0, _CAB_BASE_H + _CAB_BODY_H / 2, 0]} />
            {/* Emissive screen — upper 75% of body face, inset slightly toward room.
                Y: base + 75% of body = 16 + 107 = 123wu.
                Z: 45wu inset (world-scale, was room-scaled 50wu). */}
            <mesh geometry={CABINET_SCREEN_GEO} material={CABINET_SCREEN_MAT} position={[0, _CAB_BASE_H + Math.round(_CAB_BODY_H * 0.75), -45]} />
            {/* Lever — extends from right side, world-scale offsets */}
            <mesh geometry={CABINET_LEVER_GEO} material={CABINET_LEVER_MAT} position={[50, _CAB_BASE_H + _CAB_BODY_H / 2, -15]} rotation={[0, 0, Math.PI / 5]} />
            {/* BONUS badge — canvas texture plane above bonus cabinet only.
                Faces +Z in cabinet-local space (= +X world after PI/2 rotation),
                which is the room-facing direction. DoubleSide so player sees it
                from any approach angle. */}
            {isBonus && bonusBadgeMat && (
              <mesh
                geometry={BONUS_BADGE_GEO}
                material={bonusBadgeMat}
                position={[0, _BADGE_Y, -45]}
              />
            )}
          </group>
        );
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Slot hotspot click box
// ---------------------------------------------------------------------------
function SlotHotspot({ def }: { def: HotspotDef }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const openSlotScreen = useCoveStore((s) => s.openSlotScreen);
  const { data: avatar } = useAvatar();

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, []);

  const handleClick = () => {
    const startBalance = avatar?.clawTokens ?? 60;
    openSlotScreen(def.machineSlug, def.paytableId, startBalance);
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
// VRM player avatar for cove interior
// Minimal version: loads VRM via useVRMInstance, drives VRMCharacterAnimator,
// WASD movement, no world-map coupling, no terrain raycast (flat floor).
// ---------------------------------------------------------------------------

// Scratch: follow camera + rotation
const _coveAvatarFwd = new THREE.Vector3();
const _coveAvatarRight = new THREE.Vector3();
const _coveWorldUp = new THREE.Vector3(0, 1, 0);

interface CoveVRMAvatarProps {
  reg: ModelRegistryEntry;
}

function CoveVRMAvatarInner({ reg }: CoveVRMAvatarProps) {
  const groupRef = useRef<THREE.Group>(null);
  const rotRef = useRef(Math.PI); // face -Z = into the room on spawn
  const { camera } = useThree();
  const { data: avatar } = useAvatar();

  // Sync avatar balance to module-scope so E-key handler can read it without hooks
  useEffect(() => {
    if (avatar?.clawTokens != null) _coveAvatarClawTokens = avatar.clawTokens;
  }, [avatar?.clawTokens]);

  // Reset module-scope camera state on mount so re-entering the cove
  // starts with the camera directly behind the avatar (no stale yaw /
  // arrow offsets from a previous visit).
  useEffect(() => {
    _coveCamYaw          = Math.PI;
    _coveArrowYawOffset   = 0;
    _coveArrowPitchOffset = 0;
  }, []);

  const vrm = useVRMInstance(reg.path, 'cove-player');

  const { scale: vrmRenderScale, offsetY: vrmFootOffsetY } = useMemo(
    () => computeVRMAvatarFit(vrm, reg.animatorId, COVE_VRM_TARGET_HEIGHT),
    [vrm, reg.animatorId],
  );

  useEffect(() => {
    return () => disposeVRMInstance(reg.path, 'cove-player');
  }, [reg.path]);

  const vrmAnimRef = useRef<VRMCharacterAnimator | null>(null);
  useEffect(() => {
    if (!vrm) return;
    const anim = new VRMCharacterAnimator(vrm, reg.animatorId);
    vrmAnimRef.current = anim;
    anim.init().catch((e) => console.warn('[CoveVRM] animator init:', e));
    return () => { vrmAnimRef.current = null; anim.dispose(); };
  }, [vrm, reg.animatorId]);

  // Position state held in refs (zero React overhead)
  const posX = useRef(PLAYER_SPAWN_X);
  const posZ = useRef(PLAYER_SPAWN_Z);

  useFrame((_, delta) => {
    attachCoveKeyListeners();
    attachCoveArrowListeners();

    // --- Arrow-key perspective orbit (Bug 2 fix 2026-05-19) ---
    // Accumulate yaw + pitch offsets while keys are held.
    // ArrowLeft orbits camera left (positive dTheta), ArrowRight orbits right.
    // Mirrors World3DCanvas ARROW_ROT_SPEED convention.
    const dYaw = ((_coveArrowKeys.left ? 1 : 0) - (_coveArrowKeys.right ? 1 : 0)) * ARROW_YAW_SPEED * delta;
    _coveArrowYawOffset += dYaw;

    const dPitch = ((_coveArrowKeys.up ? 1 : 0) - (_coveArrowKeys.down ? 1 : 0)) * ARROW_PITCH_SPEED * delta;
    _coveArrowPitchOffset = Math.max(ARROW_PITCH_MIN, Math.min(ARROW_PITCH_MAX, _coveArrowPitchOffset + dPitch));

    let vx = 0, vz = 0;
    // Camera-relative WASD: project camera forward onto XZ plane
    camera.getWorldDirection(_coveAvatarFwd);
    _coveAvatarFwd.y = 0;
    const fwdLen = _coveAvatarFwd.length();
    if (fwdLen > 0.001) {
      _coveAvatarFwd.divideScalar(fwdLen);
      _coveAvatarRight.crossVectors(_coveAvatarFwd, _coveWorldUp).normalize();
      let inputFwd = 0, inputRight = 0;
      if (coveKeys.w) inputFwd += 1;
      if (coveKeys.s) inputFwd -= 1;
      if (coveKeys.a) inputRight -= 1;
      if (coveKeys.d) inputRight += 1;
      if (inputFwd !== 0 || inputRight !== 0) {
        vx = _coveAvatarFwd.x * inputFwd + _coveAvatarRight.x * inputRight;
        vz = _coveAvatarFwd.z * inputFwd + _coveAvatarRight.z * inputRight;
        const len = Math.sqrt(vx * vx + vz * vz);
        if (len > 1) { vx /= len; vz /= len; }
      }
    }

    const isMoving = vx !== 0 || vz !== 0;

    if (isMoving) {
      posX.current = Math.max(-BOUNDS_X, Math.min(BOUNDS_X, posX.current + vx * COVE_PLAYER_SPEED * delta));
      posZ.current = Math.max(BOUNDS_Z_MIN, Math.min(BOUNDS_Z_MAX, posZ.current + vz * COVE_PLAYER_SPEED * delta));
      // Cabinet + dealer AABB push-out (before wall-bounds clamp so wall still wins)
      _resolveCoveCollisions(posX, posZ, 30);
      // Re-clamp to room bounds after push-out (collision may have nudged past wall)
      posX.current = Math.max(-BOUNDS_X, Math.min(BOUNDS_X, posX.current));
      posZ.current = Math.max(BOUNDS_Z_MIN, Math.min(BOUNDS_Z_MAX, posZ.current));
      // Bug 1 fix 2026-05-19: lerp rate reduced 0.15→0.08.
      // At 60fps, 0.15 produced ~13.5°/frame on A/D press — visually
      // snapping 45° in 3-4 frames. 0.08 spreads the same 90° turn over
      // ~35 frames (0.58s) for a smooth rotation-through-the-angle feel.
      // VRM facing: atan2(vx, vz) — see feedback_vrm_facing_formula memory.
      const targetRot = Math.atan2(vx, vz);
      let diff = targetRot - rotRef.current;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      rotRef.current += diff * 0.08;
    }

    // --- Proximity + E-key interaction ---
    // Compute XZ distance to each bank centroid. Arm / disarm E key based on distance.
    // All arithmetic is scalar — zero allocations.
    {
      const px = posX.current;
      const pz = posZ.current;
      const dClassicSq = (px - CLASSIC_BANK_CENTROID_X) ** 2 + (pz - CLASSIC_BANK_CENTROID_Z) ** 2;
      const dBonusSq   = (px - BONUS_BANK_CENTROID_X)   ** 2 + (pz - BONUS_BANK_CENTROID_Z)   ** 2;
      const armSq      = BANK_INTERACT_ARM  * BANK_INTERACT_ARM;
      const nearSq     = BANK_INTERACT_NEAR * BANK_INTERACT_NEAR;

      if (dClassicSq <= armSq) {
        _eKeyArmedBank = 'classic';
      } else if (dBonusSq <= armSq) {
        _eKeyArmedBank = 'bonus';
      } else {
        _eKeyArmedBank = null;
        _eKeyConsumed  = false;
      }

      // Update setVisible for the "press E" prompt labels (handled in BankLabels component
      // via _eKeyArmedBank read — WorldLabel content is updated there each render tick).

      // Fire on E if armed and not already consumed this press
      if (_eKeyArmedBank !== null && coveKeys.e && !_eKeyConsumed) {
        _eKeyConsumed = true;
        const slotAlreadyOpen = useCoveStore.getState().slotScreenOpen;
        if (!slotAlreadyOpen) {
          const startBalance = _coveAvatarClawTokens;
          const slug: MachineSlug = _eKeyArmedBank === 'bonus' ? 'classic-3x5-bonus' : 'classic-3x5';
          useCoveStore.getState().openSlotScreen(slug, slug, startBalance);
        }
      }

      // Expose proximity state so BankLabels useFrame can read it
      // nearHint = true when player is within BANK_INTERACT_NEAR (250wu) of that bank
      _classicBankNearHint = dClassicSq <= nearSq;
      _bonusBankNearHint   = dBonusSq   <= nearSq;
    }

    const group = groupRef.current;
    if (!group) return;

    group.position.x = posX.current;
    group.position.y = 0;
    group.position.z = posZ.current;
    group.rotation.y = rotRef.current;

    // Follow camera — CAM_ABOVE wu above, CAM_BEHIND wu behind.
    //
    // Bug 4 fix 2026-05-19: camera yaw is NO LONGER coupled to avatar yaw.
    //
    // The previous design lerped `_coveCamYaw` toward `rotRef.current` so
    // the camera tracked the avatar's facing. Combined with camera-relative
    // WASD (W = camera-forward), strafe input created a positive feedback
    // loop: A press → avatar yaw rotates 90° to face strafe direction →
    // camera yaw lerps to follow → camera forward rotates → strafe vector
    // rotates → avatar yaw rotates more → ... Result: every A/D tap snapped
    // the viewport ~45° and holding the key spun the world continuously.
    //
    // Fix: `_coveCamYaw` is now a STATIC spawn-direction anchor (Math.PI)
    // that only changes via arrow-key orbit (`_coveArrowYawOffset`). The
    // avatar's body still rotates to face movement direction (atan2(vx,vz)),
    // but the camera does not auto-follow. This matches the main world's
    // OrbitControls behavior — the camera is user-driven (arrow keys here),
    // not avatar-driven.
    //
    // Camera position is AABB-clamped to keep it inside the room walls.
    const slotOpen = useCoveStore.getState().slotScreenOpen;
    if (!slotOpen) {
      const cam = camera as THREE.PerspectiveCamera;
      // Orbit yaw = static spawn yaw + arrow-key offset (no avatar coupling)
      const orbitYaw = _coveCamYaw + _coveArrowYawOffset;
      const behindX = -Math.sin(orbitYaw) * CAM_BEHIND;
      const behindZ = -Math.cos(orbitYaw) * CAM_BEHIND;
      _camDesiredPos.set(
        posX.current + behindX,
        CAM_ABOVE + _coveArrowPitchOffset,
        posZ.current + behindZ,
      );
      // Bug 3 fix 2026-05-19: clamp camera inside room AABB so it never
      // pokes through a wall and renders the black void background.
      clampCameraToRoom(_camDesiredPos, COVE_ROOM_BOUNDS);
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

function CoveGLBAvatarInner() {
  const groupRef  = useRef<THREE.Group>(null);
  const rotRef    = useRef(Math.PI);
  const { camera } = useThree();
  const { data: avatar } = useAvatar();

  // Sync avatar balance to module-scope so E-key handler can read it
  useEffect(() => {
    if (avatar?.clawTokens != null) _coveAvatarClawTokens = avatar.clawTokens;
  }, [avatar?.clawTokens]);

  // Reset module-scope camera state on mount (mirrors VRM branch).
  useEffect(() => {
    _coveCamYaw          = Math.PI;
    _coveArrowYawOffset   = 0;
    _coveArrowPitchOffset = 0;
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
    return { cloned: c, pivotOffsetY: localMinY * COVE_AVATAR_SCALE };
  }, [scene]);

  const posX = useRef(PLAYER_SPAWN_X);
  const posZ = useRef(PLAYER_SPAWN_Z);

  useFrame((_, delta) => {
    attachCoveKeyListeners();
    attachCoveArrowListeners();

    // --- Arrow-key perspective orbit (Bug 2 fix 2026-05-19) ---
    // Shared with VRM branch via module-scope vars.
    const dYaw = ((_coveArrowKeys.left ? 1 : 0) - (_coveArrowKeys.right ? 1 : 0)) * ARROW_YAW_SPEED * delta;
    _coveArrowYawOffset += dYaw;
    const dPitch = ((_coveArrowKeys.up ? 1 : 0) - (_coveArrowKeys.down ? 1 : 0)) * ARROW_PITCH_SPEED * delta;
    _coveArrowPitchOffset = Math.max(ARROW_PITCH_MIN, Math.min(ARROW_PITCH_MAX, _coveArrowPitchOffset + dPitch));

    let vx = 0, vz = 0;
    camera.getWorldDirection(_coveAvatarFwd);
    _coveAvatarFwd.y = 0;
    const fwdLen = _coveAvatarFwd.length();
    if (fwdLen > 0.001) {
      _coveAvatarFwd.divideScalar(fwdLen);
      _coveAvatarRight.crossVectors(_coveAvatarFwd, _coveWorldUp).normalize();
      let inputFwd = 0, inputRight = 0;
      if (coveKeys.w) inputFwd += 1;
      if (coveKeys.s) inputFwd -= 1;
      if (coveKeys.a) inputRight -= 1;
      if (coveKeys.d) inputRight += 1;
      if (inputFwd !== 0 || inputRight !== 0) {
        vx = _coveAvatarFwd.x * inputFwd + _coveAvatarRight.x * inputRight;
        vz = _coveAvatarFwd.z * inputFwd + _coveAvatarRight.z * inputRight;
        const len = Math.sqrt(vx * vx + vz * vz);
        if (len > 1) { vx /= len; vz /= len; }
      }
    }

    const isMoving = vx !== 0 || vz !== 0;

    if (isMoving) {
      posX.current = Math.max(-BOUNDS_X, Math.min(BOUNDS_X, posX.current + vx * COVE_PLAYER_SPEED * delta));
      posZ.current = Math.max(BOUNDS_Z_MIN, Math.min(BOUNDS_Z_MAX, posZ.current + vz * COVE_PLAYER_SPEED * delta));
      // Cabinet + dealer AABB push-out
      _resolveCoveCollisions(posX, posZ, 30);
      posX.current = Math.max(-BOUNDS_X, Math.min(BOUNDS_X, posX.current));
      posZ.current = Math.max(BOUNDS_Z_MIN, Math.min(BOUNDS_Z_MAX, posZ.current));
      // Bug 1 fix 2026-05-19: lerp rate 0.15→0.08 (smoother yaw, same formula).
      // lobster.glb faces +Z at rot=0 — see feedback_lobster_faces_negative_z memory.
      const targetRot = Math.atan2(vx, vz);
      let diff = targetRot - rotRef.current;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      rotRef.current += diff * 0.08;
    }

    // --- Proximity + E-key (mirrors VRM branch) ---
    {
      const px = posX.current;
      const pz = posZ.current;
      const dClassicSq = (px - CLASSIC_BANK_CENTROID_X) ** 2 + (pz - CLASSIC_BANK_CENTROID_Z) ** 2;
      const dBonusSq   = (px - BONUS_BANK_CENTROID_X)   ** 2 + (pz - BONUS_BANK_CENTROID_Z)   ** 2;
      const armSq      = BANK_INTERACT_ARM  * BANK_INTERACT_ARM;
      const nearSq     = BANK_INTERACT_NEAR * BANK_INTERACT_NEAR;

      if (dClassicSq <= armSq) {
        _eKeyArmedBank = 'classic';
      } else if (dBonusSq <= armSq) {
        _eKeyArmedBank = 'bonus';
      } else {
        _eKeyArmedBank = null;
        _eKeyConsumed  = false;
      }

      if (_eKeyArmedBank !== null && coveKeys.e && !_eKeyConsumed) {
        _eKeyConsumed = true;
        const slotAlreadyOpen = useCoveStore.getState().slotScreenOpen;
        if (!slotAlreadyOpen) {
          const startBalance = _coveAvatarClawTokens;
          const slug: MachineSlug = _eKeyArmedBank === 'bonus' ? 'classic-3x5-bonus' : 'classic-3x5';
          useCoveStore.getState().openSlotScreen(slug, slug, startBalance);
        }
      }

      _classicBankNearHint = dClassicSq <= nearSq;
      _bonusBankNearHint   = dBonusSq   <= nearSq;
    }

    const group = groupRef.current;
    if (!group) return;

    group.position.x = posX.current;
    group.position.y = 2 - pivotOffsetY;
    group.position.z = posZ.current;
    group.rotation.y = rotRef.current;

    // Follow camera — same offsets as VRM branch + arrow orbit + AABB clamp.
    // Bug 4 fix 2026-05-19: camera yaw is decoupled from avatar yaw (was a
    // positive feedback loop with camera-relative strafe). See VRM branch
    // for full rationale.
    const slotOpen = useCoveStore.getState().slotScreenOpen;
    if (!slotOpen) {
      const cam = camera as THREE.PerspectiveCamera;
      const orbitYaw = _coveCamYaw + _coveArrowYawOffset;
      const behindX = -Math.sin(orbitYaw) * CAM_BEHIND;
      const behindZ = -Math.cos(orbitYaw) * CAM_BEHIND;
      _camDesiredPos.set(posX.current + behindX, CAM_ABOVE + _coveArrowPitchOffset, posZ.current + behindZ);
      // Bug 3 fix 2026-05-19: clamp inside room so camera never clips a wall.
      clampCameraToRoom(_camDesiredPos, COVE_ROOM_BOUNDS);
      cam.position.lerp(_camDesiredPos, 1 - Math.exp(-8 * delta));
      _camTarget.set(posX.current, CAM_LOOK_Y, posZ.current);
      cam.lookAt(_camTarget);
    }
  });

  return (
    <group ref={groupRef} position={[PLAYER_SPAWN_X, 2 - 0, PLAYER_SPAWN_Z]} rotation={[0, Math.PI, 0]}>
      <primitive object={cloned} scale={COVE_AVATAR_SCALE} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// CovePlayerAvatar — routes to VRM or GLB based on avatarModelKey
// ---------------------------------------------------------------------------
function CovePlayerAvatar() {
  const avatarModelKey = useGameStore((s) => s.avatarModelKey);
  const reg: ModelRegistryEntry =
    MODEL_REGISTRY[avatarModelKey as keyof typeof MODEL_REGISTRY] ?? MODEL_REGISTRY.lobster;

  if (reg.avatar_type === 'vrm') {
    return (
      <Suspense fallback={null}>
        <CoveVRMAvatarInner reg={reg} />
      </Suspense>
    );
  }

  return <CoveGLBAvatarInner />;
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

    if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_COVE_DEBUG === '1') {
      const bbox2 = new THREE.Box3().setFromObject(c);
      const sz = new THREE.Vector3(); bbox2.getSize(sz);
      const ct = new THREE.Vector3(); bbox2.getCenter(ct);
      console.info('[cove-fit]',
        'scale=' + fitResult.scale.toFixed(4),
        'worldCenter=(' + ct.x.toFixed(1) + ',' + ct.y.toFixed(1) + ',' + ct.z.toFixed(1) + ')',
        'worldSize=(' + sz.x.toFixed(1) + ',' + sz.y.toFixed(1) + ',' + sz.z.toFixed(1) + ')');
    }

    // ─── Slot cabinet discovery ──────────────────────────────────────────
    // The cove-interior.glb has slot machine cabinets BAKED IN (visible as
    // the two long rows of dark machines with pink chairs). We bind click
    // hotspots to those baked meshes instead of overlaying procedural
    // cabinets at the bar.
    //
    // Heuristic (no name match — GLB nodes are named after materials):
    //   - World bbox height between 80wu and 350wu
    //   - Footprint (min of width, depth) between 30wu and 220wu
    //   - World Y center between 30wu and 250wu (sits on the floor)
    //   - Reject anything with a huge X or Z span (walls, ceiling, floor)
    //
    // Returns one HotspotDef per matched mesh. If discovery finds <2 cabinets,
    // we fall back to the legacy hand-placed GAMEREADY_HOTSPOTS.
    const _bb = new THREE.Box3();
    const _bbSize = new THREE.Vector3();
    const _bbCenter = new THREE.Vector3();
    const discoveredHotspots: HotspotDef[] = [];
    const discoveredDebug: Array<{ name: string; pos: string; size: string }> = [];
    c.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
      if (!mesh.geometry) return;
      mesh.updateWorldMatrix(true, false);
      _bb.setFromObject(mesh);
      if (_bb.isEmpty()) return;
      _bb.getSize(_bbSize);
      _bb.getCenter(_bbCenter);
      const h = _bbSize.y;
      const w = _bbSize.x;
      const d = _bbSize.z;
      const minFootprint = Math.min(w, d);
      const maxFootprint = Math.max(w, d);
      const yMid = _bbCenter.y;
      const ok =
        h >= 80 && h <= 350 &&
        minFootprint >= 30 && minFootprint <= 220 &&
        maxFootprint <= 600 &&     // reject room-spanning shells
        yMid >= 30 && yMid <= 250;
      if (process.env.NEXT_PUBLIC_COVE_DEBUG === '1') {
        discoveredDebug.push({
          name: mesh.name || '(unnamed)',
          pos: `(${_bbCenter.x.toFixed(0)},${_bbCenter.y.toFixed(0)},${_bbCenter.z.toFixed(0)})`,
          size: `${w.toFixed(0)}×${h.toFixed(0)}×${d.toFixed(0)}${ok ? ' ✓SLOT' : ''}`,
        });
      }
      if (!ok) return;
      // Build a click-zone roughly matching the cabinet bbox + 20wu reach
      // into the room.
      discoveredHotspots.push({
        position: [_bbCenter.x, _bbCenter.y, _bbCenter.z] as [number, number, number],
        size:     [w + 20, h, d + 20] as [number, number, number],
        machineSlug: 'classic-3x5' as MachineSlug,
        paytableId:  'classic-3x5' as MachineSlug,
        isBonus:     false,
      });
    });

    if (process.env.NEXT_PUBLIC_COVE_DEBUG === '1') {
      console.info(`[cove-interior] discovered ${discoveredHotspots.length} slot cabinets from ${discoveredDebug.length} candidate meshes`);
      for (const d of discoveredDebug) {
        console.info(`  ${d.name.padEnd(30)} pos=${d.pos.padEnd(18)} size=${d.size}`);
      }
    }

    // If discovery worked, use those positions. Otherwise fall back to the
    // legacy hand-placed array (so the room is never un-clickable).
    const hotspotDefs = useFallback
      ? FALLBACK_HOTSPOTS
      : (discoveredHotspots.length >= 2 ? discoveredHotspots : GAMEREADY_HOTSPOTS);

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
    if (process.env.NEXT_PUBLIC_COVE_DEBUG === '1') {
      const cam = camera as THREE.PerspectiveCamera;
      const g = groupRef.current;
      console.info(
        '[cove-interior DEBUG]\n' +
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
        console.warn(`[cove-interior] avg FPS ${avgFps.toFixed(1)} < ${FPS_FALLBACK_THRESHOLD} — switching to fallback GLB`);
        onFallbackRequest();
      } else {
        console.log(`[cove-interior] FPS OK (avg ${avgFps.toFixed(1)})`);
      }
    }
  });

  return (
    <group ref={groupRef}>
      <primitive object={cloned} />

      {/*
        Procedural <SlotCabinets/> render REMOVED — the cove-interior.glb
        already has slot machines baked in (the two long rows of dark
        cabinets with pink chairs). Overlaying procedural cabinets at the
        bar was creating "double slot machines" — the bonus-badge boxes
        the user pointed out as wrong. We now discover the baked slot
        meshes via bbox-heuristic above and bind click hotspots directly
        to them. The procedural SlotCabinets component is dead code as
        of Phase 6.1.13; leaving the source for now in case future work
        wants the bonus-badge / lever style for a different cabinet type.
      */}

      {/* Invisible click hotspots over the BAKED slot machines (discovered
          at runtime from the GLB). Fallback hotspots from FALLBACK_HOTSPOTS
          are used only when the entire fallback GLB is in play. */}
      {hotspots.map((def, i) => (
        <SlotHotspot key={i} def={def} />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// BankLabels — proximity-driven floating labels for Classic and Bonus banks.
//
// Each label registers via useWorldLabel with a module-scope anchor Object3D.
// The anchor is at each bank's centroid (XZ) + CLASSIC_BANK_LABEL_Y above floor.
// In useFrame, the label content is updated imperatively each frame based on
// _classicBankNearHint / _eKeyArmedBank — zero React re-renders per frame.
// ---------------------------------------------------------------------------

// Bio-label style (shared with building labels in arena-buildings.tsx)
function _bankLabelCapsule(name: string, hint: boolean) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        transform: 'translateY(-50%)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-fraunces, "Cormorant Garamond", "Spectral", Georgia, serif)',
          fontVariationSettings: '"opsz" 9',
          fontWeight: 520,
          fontSize: 15,
          color: '#a0eaff',
          padding: '7px 15px 9px',
          borderRadius: 999,
          background: 'rgba(8, 18, 32, 0.85)',
          border: '1px solid rgba(120, 220, 255, 0.55)',
          boxShadow: '0 0 22px rgba(120,240,255,0.5), 0 0 60px -10px rgba(120,240,255,0.45), inset 0 0 14px rgba(120,200,240,0.18)',
          whiteSpace: 'nowrap',
          letterSpacing: '0.02em',
          lineHeight: 1,
          userSelect: 'none',
        }}
      >
        {name}
        {hint && (
          <span
            style={{
              display: 'block',
              fontSize: 9,
              fontStyle: 'italic',
              fontFamily: 'var(--font-oxanium, sans-serif)',
              fontWeight: 400,
              color: '#ffe875',
              opacity: 0.9,
              marginTop: 2,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            press E to play
          </span>
        )}
      </div>
      <div
        style={{
          width: 1,
          height: 40,
          backgroundImage: 'linear-gradient(rgba(140,240,255,0.78) 50%, transparent 50%)',
          backgroundSize: '1px 6px',
          backgroundRepeat: 'repeat-y',
          boxShadow: '0 0 6px rgba(120,240,255,0.55)',
          marginBottom: 2,
        }}
      />
      <div
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: 'rgba(160,234,255,1)',
        }}
      />
    </div>
  );
}

function BankLabels() {
  // State-driven hint flags so React re-renders only when proximity changes
  const [classicHint, setClassicHint] = useState(false);
  const [bonusHint,   setBonusHint]   = useState(false);

  const { divRef: classicDivRef, setVisible: setClassicVisible } = useWorldLabel({
    id:             'cove-classic-bank',
    anchorRef:      _classicAnchorRef,
    offset:         [0, 0, 0],
    initialVisible: true,
    fadeNear:       BANK_LABEL_FADE_NEAR,
    fadeFar:        BANK_LABEL_FADE_FAR,
    fadeBaseOpacity: 0.9,
    occlude:        false,
  });

  const { divRef: bonusDivRef } = useWorldLabel({
    id:             'cove-bonus-bank',
    anchorRef:      _bonusAnchorRef,
    offset:         [0, 0, 0],
    initialVisible: true,
    fadeNear:       BANK_LABEL_FADE_NEAR,
    fadeFar:        BANK_LABEL_FADE_FAR,
    fadeBaseOpacity: 0.9,
    occlude:        false,
  });

  // Poll module-scope hint flags in useFrame and drive React state
  // only when they actually change — one setState per transition.
  useFrame(() => {
    if (_classicBankNearHint !== classicHint) setClassicHint(_classicBankNearHint);
    if (_bonusBankNearHint   !== bonusHint)   setBonusHint(_bonusBankNearHint);
  });

  // Suppress unused variable warning from setClassicVisible
  void setClassicVisible;

  return (
    <>
      <WorldLabel divRef={classicDivRef}>
        {_bankLabelCapsule('Classic', classicHint)}
      </WorldLabel>
      <WorldLabel divRef={bonusDivRef}>
        {_bankLabelCapsule('Bonus', bonusHint)}
      </WorldLabel>
    </>
  );
}

// ---------------------------------------------------------------------------
// Default export — full cove interior scene
// ---------------------------------------------------------------------------
export interface CoveInteriorSceneProps {
  onSceneEmpty?: () => void;
}

export default function CoveInteriorScene({ onSceneEmpty }: CoveInteriorSceneProps = {}) {
  const [useFallback, setUseFallback] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('fallback') === '1';
  });

  return (
    <>
      <CoveLighting />

      {/* Fog scaled with room: near=4000, far=10000 (was 1200/3000 for 600wu room → ×3.333) */}
      <fog attach="fog" args={[0x0a0015, 4000, 10000]} />

      {/* WorldLabelsOverlay — single overlay root for BankLabels */}
      <WorldLabelsOverlayMount />

      <Suspense fallback={null}>
        <InteriorScene
          useFallback={useFallback}
          onFallbackRequest={() => setUseFallback(true)}
          onSceneEmpty={onSceneEmpty ?? (() => {})}
        />
      </Suspense>

      {/* Walkable player avatar — mounted outside InteriorScene Suspense so
          GLB/VRM loading doesn't block the cove room from appearing first. */}
      <CovePlayerAvatar />

      {/* Bank labels + E-key proximity hints */}
      <BankLabels />
    </>
  );
}
