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
// Phase 6.4.0 — blackjack table hotspot uses the store action openBlackjackTable
import { useGameStore } from '@/stores/game';
import { useVRMInstance, disposeVRMInstance } from '@/lib/three/vrm-loader';
import {
  VRMCharacterAnimator,
  preloadClips,
  type AnimName,
} from '@/lib/three/vrm-character-animator';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import { MODEL_REGISTRY, type ModelRegistryEntry } from '@/lib/three/agent-model-registry';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { clampCameraToRoom, type RoomBounds } from '@/lib/three/room-camera';
import { useWorldLabel, WorldLabel, WorldLabelsOverlayMount } from '@/lib/three/world-labels-overlay';
import { extendLoaderWithKTX2 } from '@/lib/three/ktx2-loader-setup';
import { preloadKTX2Bytes, useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';
import type { MachineSlug } from '@/lib/cove/types';
import { TableCards3D } from '@/lib/three/cove-table-cards';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gameready GLB path — temporarily pointed at cleaned-v1 to evaluate the
 *  Blender artifact removal pass (pillar fragments + Material4 ghost mesh
 *  removed; stump cleanup possibly over-broad — visual verification pending). */
const INTERIOR_GLB = '/models/cove/cove-interior-cleaned-v1-ktx.glb?v=5';
/** Fallback cartoon GLB */
const FALLBACK_GLB = '/models/cove/cove-interior-fallback.glb';

/** Emergency rollback for the Meshy sit flow; false restores the prior
 * static leg override + group-level seatDrop without reverting code. */
const USE_COVE_SIT_CLIPS = true;
const COVE_SIT_CLIP_NAMES = [
  'sit_stand_to_sit',
  'sit_idle_m',
  'sit_idle_f',
  'sit_to_stand_m',
  'sit_to_stand_f',
] as const satisfies readonly AnimName[];
/** Raw stand-to-sit is ~4.8s; this keeps the visible transition near 3.2s. */
const COVE_SIT_TRANSITION_TIME_SCALE = 1.5;

// Warm exactly the cove bundle's five clips so the first seated bust does not
// hitch. The asset path is new, so no cache-bust suffix is required.
if (USE_COVE_SIT_CLIPS) preloadClips(COVE_SIT_CLIP_NAMES);

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
 *
 * THE SINGLE ROOM-SCALE KNOB (2026-07-11, founder decision): every
 * world-space constant below that represents a physical position/size
 * inside the baked room GLB (table centers, felt extents, seat ring,
 * AABB colliders, spawn, bounds, cabinet hotspots, dealer AABB, camera.far,
 * fog) is now DERIVED from either `_ROOM_SCALE` (legacy room-relative
 * constants, unchanged mechanism) or the GLB-space ground-truth block below
 * (Slice 1's table/seat/spawn/hotspot constants, refactored from flat
 * world-space literals). Bumping ONLY this constant scales the whole room
 * + furniture coherently. Avatar constants (COVE_VRM_TARGET_HEIGHT,
 * COVE_AVATAR_SCALE, CAM_ABOVE/BEHIND/LOOK_Y, COVE_PLAYER_SPEED) are
 * DELIBERATELY excluded — the founder's brief is "the room grows around a
 * fixed-size avatar," not a uniform world rescale.
 */
const INTERIOR_TARGET_HEIGHT = 2800; // world units — was 600, was 2000. THE KNOB.
const COVE_SIT_HEIGHT_CHECK_DELAY_SECONDS =
  (4.8 / COVE_SIT_TRANSITION_TIME_SCALE) + 0.35;
const COVE_SIT_HIP_HEIGHT_TOLERANCE = 10 * (INTERIOR_TARGET_HEIGHT / 2800);
// Shared scratch for once-per-bust raw-hips validation; useFrame allocates none.
const _coveSitRawHipsWorld = new THREE.Vector3();
// Founder-picked 2026-07-11 from the A/B/C screenshot set (2000/2400/2800):
// "2800 looks great." Room + furniture read bigger relative to the fixed-
// size avatar without retuning COVE_PLAYER_SPEED or any avatar constant.

/** Scale factor applied to all room-relative coordinates (bounds, spawn, cabinets).
 *  MUST reference INTERIOR_TARGET_HEIGHT, not a hardcoded duplicate of its
 *  current value — this was a real bug caught during the room-scale-knob
 *  refactor (2026-07-11): `_ROOM_SCALE = 2000 / 600` looked knob-derived but
 *  was actually a second hardcoded "2000" that silently stopped tracking the
 *  knob the moment INTERIOR_TARGET_HEIGHT changed. Every constant below that
 *  multiplies by `_ROOM_SCALE` (BOUNDS_X/Z, SLOT_CABINET_POSITIONS, cabinet
 *  width/depth, bank centroids, fog) was affected. */
const _ROOM_SCALE = INTERIOR_TARGET_HEIGHT / 600; // ≈ 3.333 at today's knob value

// ---------------------------------------------------------------------------
// GLB-space ground truth + fit-scale conversion (room-scale-knob refactor,
// 2026-07-11). Source: docs/cove-glb-furniture-map-2026-07-10.md (Blender
// Z-up geometry forensics on the baked, never-edited cove-interior GLB —
// these numbers are measured from the mesh, not chosen). `computeAutoFit()`
// below computes this SAME ratio at runtime from the loaded scene's actual
// bounding box; these are the compile-time equivalents (the GLB is a fixed,
// unchanging asset, so hardcoding its measured bbox here — exactly as the
// furniture-map doc already did — is safe and matches computeAutoFit's own
// behaviour). Every Slice 1 table/seat/spawn/hotspot constant is now
// GLB_VALUE * FIT_SCALE (or the inverse for round-tripping a legacy
// world-space value that had no independent GLB measurement), so
// INTERIOR_TARGET_HEIGHT is the only place the knob lives.
// ---------------------------------------------------------------------------
const ROOM_GLB_MAX_DIM = 1016.7;   // Y-span (Blender) — the axis computeAutoFit scales to INTERIOR_TARGET_HEIGHT
const GLB_CENTER_X     = -720.56;  // Blender X room-bbox center
const GLB_CENTER_Y     = 0.29;     // Blender Y room-bbox center (maps to world -Z)
const GLB_FLOOR_Z      = -274.4;   // Blender Z-up floor plane
const GLB_CEILING_HEIGHT = 203.5;  // doc's measured floor-to-ceiling height (Blender Z units)

/** wu per Blender-GLB-unit at the CURRENT knob value. Replaces the old
 *  hardcoded "FIT_SCALE≈1.967" comment with the real derived constant. */
export const FIT_SCALE = INTERIOR_TARGET_HEIGHT / ROOM_GLB_MAX_DIM;

/** Fixed scale at the ORIGINAL baseline (INTERIOR_TARGET_HEIGHT=2000, the
 *  value every pre-refactor hardcoded world-space constant in this file was
 *  captured at). Deliberately NOT `FIT_SCALE` — this must stay pinned to
 *  2000 regardless of the live knob value, because it exists ONLY to invert
 *  a legacy world-space number back into its true GLB position ONE TIME
 *  (below). If this used the live `FIT_SCALE` instead, every legacy
 *  constant's GLB position would silently drift every time someone changed
 *  the knob — the opposite of what round-tripping is for. */
const BASELINE_FIT_SCALE = 2000 / ROOM_GLB_MAX_DIM;

/** Blender X → world X. */
function glbToWorldX(glbX: number): number { return (glbX - GLB_CENTER_X) * FIT_SCALE; }
/** Blender Y → world Z (Y-up flip). */
function glbToWorldZ(glbY: number): number { return -(glbY - GLB_CENTER_Y) * FIT_SCALE; }
/** Blender Z-up height-above-floor → world Y. */
function glbHeightToWorldY(glbZ: number): number { return (glbZ - GLB_FLOOR_Z) * FIT_SCALE; }
/** Inverse of glbToWorldX, evaluated at BASELINE_FIT_SCALE (see above) —
 *  round-trips a legacy world-space X with no independent GLB measurement
 *  into a GLB-space constant that then tracks the knob like everything
 *  else. Preserves the CURRENT (INTERIOR_TARGET_HEIGHT=2000) world value
 *  exactly; only future knob values move it. */
function worldToGlbX(worldX: number): number { return worldX / BASELINE_FIT_SCALE + GLB_CENTER_X; }
/** Inverse of glbToWorldZ, evaluated at BASELINE_FIT_SCALE — see worldToGlbX. */
function worldToGlbY(worldZ: number): number { return GLB_CENTER_Y - worldZ / BASELINE_FIT_SCALE; }

/** Player spawn position — at the door side near the slot machines (back wall area).
 *  Captured via [BJ-POS] probe 2026-05-27. Was (0, 800) which placed player at the
 *  opposite side; user clarified door is on the slot/back-wall end of the cove.
 *  Room-scale-knob refactor (2026-07-11): no independent GLB measurement exists
 *  for the spawn point, so the ORIGINAL (-12,-411) world value is round-tripped
 *  into GLB-space via worldToGlbX/Y (see above) — identical position at today's
 *  knob value, now tracks the knob at any other value. */
const PLAYER_SPAWN_GLB_X = worldToGlbX(-12);
const PLAYER_SPAWN_GLB_Y = worldToGlbY(-411);
const PLAYER_SPAWN_X = glbToWorldX(PLAYER_SPAWN_GLB_X);
const PLAYER_SPAWN_Z = glbToWorldZ(PLAYER_SPAWN_GLB_Y);

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

/** Ceiling height in world units at the CURRENT knob value — GLB_CEILING_HEIGHT
 *  (measured, doc ground truth) × FIT_SCALE. ≈400wu at today's knob (2000). */
const COVE_CEILING_Y = GLB_CEILING_HEIGHT * FIT_SCALE;

// AABB for camera containment — derived from room bounds + small inward margin.
const COVE_ROOM_BOUNDS: RoomBounds = {
  halfX: BOUNDS_X,
  zMin:  BOUNDS_Z_MIN,
  zMax:  BOUNDS_Z_MAX,
  yMin:  30,    // floor + clearance (fixed — avatar-relative, not room-scaled)
  // Room-scale-knob refactor (2026-07-11): was a flat 600 ("ceiling ≈400wu,
  // 600 gives slack for tilt") — a fixed number that stopped giving adequate
  // tilt slack as the ceiling itself grows with the knob (at 2800 the
  // ceiling alone reaches ~561wu, leaving only ~39wu of the old flat 600
  // headroom vs today's ~200wu). Now ceiling-relative: scaled ceiling height
  // + the SAME 200wu fixed slack margin that today's numbers implied
  // (600-400≈200), so the tilt-up feel stays constant across every knob value.
  yMax: Math.round(COVE_CEILING_Y + 200),
  margin: 50,   // wu inset from each wall face
};

/**
 * Camera far-clip plane, exported for CoveCanvas.tsx's `<Canvas camera={{far}}>`.
 *
 * Room-scale-knob refactor (2026-07-11) — the far-plane dark-void gotcha:
 * CoveCanvas.tsx previously hardcoded `far: 2000`, which was ALREADY smaller
 * than the room's true 3D bounding-box diagonal at today's knob value
 * (measured diagonal ≈2252wu at INTERIOR_TARGET_HEIGHT=2000 — the far plane
 * was clipping the room's own far corners before this refactor even
 * touched anything). At INTERIOR_TARGET_HEIGHT=2800 the diagonal grows to
 * ≈3153wu, which would have clipped visibly. Fixed by deriving far from the
 * room's fixed GLB proportions (3D-bbox-diagonal / maxDim ≈ 1.126, plus a
 * ~15% safety margin ⇒ ×1.3) so it always exceeds the room diagonal
 * regardless of knob value: 2600wu at 2000, 3120wu at 2400, 3640wu at 2800.
 */
export const COVE_CAMERA_FAR = Math.round(INTERIOR_TARGET_HEIGHT * 1.3);

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

// Camera yaw anchor — STATIC spawn-direction reference (avatar faces +Z = 0
// from the new -411 spawn at the door side, into the room).
// Bug 4 fix 2026-05-19: this is no longer auto-tracked to `rotRef.current`.
// Camera-relative WASD + auto-track = positive feedback loop on strafe input
// (every A/D press snapped the viewport ~45°). The camera now stays at spawn
// yaw and only orbits via `_coveArrowYawOffset` (arrow-key controlled).
let _coveCamYaw = 0;

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

/**
 * Touch-input bridge — mobile joystick controls (iPad / phone) write to
 * `_coveTouchVec` and the useFrame movement loop folds these values into
 * the WASD vector. Phase 6.7.x iPad fix (2026-05-27): cove had no touch
 * controls — user could SEE but not move.
 */
export const _coveTouchVec: { x: number; z: number } = { x: 0, z: 0 };
export function setCoveTouchVelocity(x: number, z: number) {
  _coveTouchVec.x = x;
  _coveTouchVec.z = z;
}
export function setCoveTouchArrowKey(key: 'left' | 'right' | 'up' | 'down', pressed: boolean) {
  _coveArrowKeys[key] = pressed;
}
export function setCoveTouchInteract(pressed: boolean) {
  coveKeys.e = pressed;
  if (!pressed) _eKeyConsumed = false;
}
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
  const gltfLoader = loader as GLTFLoader;
  gltfLoader.setDRACOLoader(_dracoLoader);
  extendLoaderWithKTX2(gltfLoader as any);
};

// Preload both GLBs at module scope
if (typeof window !== 'undefined') {
  preloadKTX2Bytes(INTERIOR_GLB);
  useGLTF.preload(FALLBACK_GLB);
  preloadKTX2Bytes('/models/lobster-ktx.glb');
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
// Blackjack table center — measured 2026-05-27 by walking the player to the
// target poker table and reading the BJ-POS log. Was (367, 0) which placed
// the sign over the roulette wheel; now matches the poker table the user
// arrowed in their screenshot.
// Room-scale-knob refactor (2026-07-11): no independent GLB measurement was
// taken for this specific station (it predates the furniture-map doc), so
// the ORIGINAL (-299,331) world value is round-tripped into GLB-space via
// worldToGlbX/Y — identical position at today's knob value, now tracks the
// knob at any other value, same treatment as PLAYER_SPAWN above.
const _DEALER_GLB_X = worldToGlbX(-299);
const _DEALER_GLB_Y = worldToGlbY(331);
const _DEALER_CENTER_X = glbToWorldX(_DEALER_GLB_X);
const _DEALER_CENTER_Z = glbToWorldZ(_DEALER_GLB_Y);
/** Half-extent unit-converted the same way (100/BASELINE_FIT_SCALE ≈ 50.84 GLB units). */
const _DEALER_HALF_GLB = 100 / BASELINE_FIT_SCALE;
const _DEALER_HALF_X   = _DEALER_HALF_GLB * FIT_SCALE;
const _DEALER_HALF_Z   = _DEALER_HALF_GLB * FIT_SCALE;

// ---------------------------------------------------------------------------
// The four baked card tables — Slice 1 (3D Hold'em experiment, 2026-07-10).
// Room-scale-knob refactor (2026-07-11): now GLB-space constants converted
// via the shared glbToWorldX/Z/glbHeightToWorldY helpers (top of file) —
// ALL of the derivation history below stays true at any INTERIOR_TARGET_
// HEIGHT, not just today's 2000, because the constants going INTO
// glbToWorld* are the GLB's own measured geometry, not a pre-multiplied
// world-space number.
//
// World positions originally derived from docs/cove-glb-furniture-map-
// 2026-07-10.md (Blender geometry forensics on the baked GLB — the room is
// 13 material-merged meshes with zero object-name semantics, so these came
// from height-band + XY clustering, not names).
//
// T1/T2 (near pair) X is within ~10-16wu of the EXISTING hand-measured
// _DEALER_CENTER_X (blackjack, -299) and _HOLDEM_CENTER_X (294) 2D hotspots
// above, but Z is NOT — the 2D hotspots sit ~35-39wu further out (331/335 vs
// 296/296 at today's knob). RESOLVED via runtime raycast probe (2026-07-10,
// real run): a straight-down ray at world (-309,296)/(310,296) hits a flat
// surface at Y=59.8, matching TABLE_TOP_Y=59 almost exactly. The 2D hotspot
// Z is a walk-up/approach-distance measurement (recorded from where the
// PLAYER stood, pushed back by the table's own AABB collider), NOT the felt
// centroid — the two numbers were never measuring the same point. T1/T2 XZ
// below is CORRECT; do not "fix" it to match the 2D hotspot Z.
//
// T3/T4 (far pair) felt-cluster bounds bled into adjacent corner geometry
// per the doc, so the ORIGINAL constants used pure room mirror-symmetry with
// T1/T2 (no independent measurement existed). A runtime boundary-sweep probe
// (raycasting a grid around the mirror-estimate, 2026-07-10) found a real
// felt-height (Y≈59.8-63.3) hit region spanning roughly X∈[-420,-220],
// Z∈[560,680] at today's knob — centroid ≈ (-320, 620), only ~16-21wu from
// the original mirror estimate (-336, 641), i.e. within the sweep's own
// 40wu grid resolution. Nudged to the measured centroid (expressed below as
// the GLB-space equivalent, so it scales); AABB half-extents already exceed
// the measured felt half-width so the existing collider padding covers this
// shift with margin. T3/T4 get no seats/camera in Slice 1 (collider-only),
// so sub-wu precision isn't required — a later slice building T3/T4
// seats should re-verify with TableProbeMarkers before trusting these
// further, especially after a knob change.
//
// Phase-0 runtime probe: cove3d-slice1-phase0-probe.png in the worktree root
// (2026-07-10) — screenshot + the console raycast log are the real
// verification; a prior session's comment claiming this was "confirmed" was
// fabricated (no screenshot or commit existed at the time it was written).
const T1_GLB_X = -877.6,  T1_GLB_Y = -150.2; // doc raw felt-cluster centroid
const T2_GLB_X = -563.0,  T2_GLB_Y = -150.2; // doc raw felt-cluster centroid
const T3_GLB_X = -883.2,  T3_GLB_Y = -314.9; // 2026-07-10 boundary-sweep-corrected
const T4_GLB_X = -557.9,  T4_GLB_Y = -314.9; // 2026-07-10 boundary-sweep-corrected

export const T1_CENTER_X = glbToWorldX(T1_GLB_X), T1_CENTER_Z = glbToWorldZ(T1_GLB_Y);
const T2_CENTER_X = glbToWorldX(T2_GLB_X), T2_CENTER_Z = glbToWorldZ(T2_GLB_Y);
const T3_CENTER_X = glbToWorldX(T3_GLB_X), T3_CENTER_Z = glbToWorldZ(T3_GLB_Y);
const T4_CENTER_X = glbToWorldX(T4_GLB_X), T4_CENTER_Z = glbToWorldZ(T4_GLB_Y);

/** Felt top surface, Blender Z-up (doc: "tabletop plane at GLB z ≈ −244.2/−244.3"). */
const GLB_FELT_TOP_Z = -244.25;
/** Table-top height off the floor — identical for all four (same GLB band).
 *  ≈59wu at today's knob; raycast-verified (see comment block above). */
export const TABLE_TOP_Y = glbHeightToWorldY(GLB_FELT_TOP_Z);

/** P2 felt-card layout. The approved 40x56wu sizing and all physical gaps
 * are captured at the founder-selected 2800 room knob, converted back to GLB
 * units, then re-applied through FIT_SCALE so a future knob change keeps the
 * entire layer proportional to the baked T1 felt. */
const T1_FELT_CARD_REFERENCE_FIT_SCALE = 2800 / ROOM_GLB_MAX_DIM;
/** P2.1 per-role layout (2026-07-15). Sizes diverge by role because the
 * seated camera geometry demands it: the player's holes stay the approved
 * 40x56 and hinge 18° toward the eye (anchored at 0.40 so they clear the
 * bottom frame edge after the look-target drop below); the 5-card board runs
 * PERPENDICULAR to the seat-0 sight line at 32x44.8 so its 168wu span fits
 * the felt's 182wu short axis; bot backs are 26x36.4 presence markers. */
export const T1_FELT_CARD_LAYOUT = Object.freeze({
  holeCardWidth: (40 / T1_FELT_CARD_REFERENCE_FIT_SCALE) * FIT_SCALE,
  holeCardHeight: (56 / T1_FELT_CARD_REFERENCE_FIT_SCALE) * FIT_SCALE,
  holePairGap: (8 / T1_FELT_CARD_REFERENCE_FIT_SCALE) * FIT_SCALE,
  holeAnchorScale: 0.40,
  holeHingeTiltRad: (18 * Math.PI) / 180,
  boardCardWidth: (32 / T1_FELT_CARD_REFERENCE_FIT_SCALE) * FIT_SCALE,
  boardCardHeight: (44.8 / T1_FELT_CARD_REFERENCE_FIT_SCALE) * FIT_SCALE,
  boardSpacing: (34 / T1_FELT_CARD_REFERENCE_FIT_SCALE) * FIT_SCALE,
  boardBackOffset: (24 / T1_FELT_CARD_REFERENCE_FIT_SCALE) * FIT_SCALE,
  botCardWidth: (26 / T1_FELT_CARD_REFERENCE_FIT_SCALE) * FIT_SCALE,
  botCardHeight: (36.4 / T1_FELT_CARD_REFERENCE_FIT_SCALE) * FIT_SCALE,
  botPairGap: (6 / T1_FELT_CARD_REFERENCE_FIT_SCALE) * FIT_SCALE,
  botAnchorScale: 0.55,
  surfaceLift: (1.5 / T1_FELT_CARD_REFERENCE_FIT_SCALE) * FIT_SCALE,
});

interface TableAABB { centerX: number; centerZ: number; halfX: number; halfZ: number; }

// T1/T2 felt cluster measured 115×66 GLB-units (doc) → half-extents 57.5×33
// GLB units. Padded (+~7.6 GLB units both axes ⇒ ≈128×80 world at today's
// knob) so the AABB also blocks the near chair ring, not just the bare felt
// — a player shouldn't be able to stand chest-to-felt. Padding value itself
// is unit-converted from the ORIGINAL chosen world padding (15wu at the
// 2000 baseline) via BASELINE_FIT_SCALE, same round-trip treatment as the
// legacy hotspot centers above.
const _T1T2_FELT_HALF_X_GLB = 115 / 2;
const _T1T2_FELT_HALF_Z_GLB = 66 / 2;
const _AABB_PAD_GLB = 15 / BASELINE_FIT_SCALE; // ≈7.6 GLB units
// T3/T4 felt cluster bled into corner geometry (doc caveat) — the raw
// 142×176 candidate is oversized for a felt-only AABB, so the CURRENT code
// used a deliberately smaller chair-ring estimate (128×100 world at the
// 2000 baseline) rather than trusting the bled bounds. Round-tripped into
// GLB units the same way as the other legacy-chosen values.
const _T3T4_AABB_HALF_X_GLB = 128 / BASELINE_FIT_SCALE;
const _T3T4_AABB_HALF_Z_GLB = 100 / BASELINE_FIT_SCALE;

const _TABLE_AABBS: TableAABB[] = [
  { centerX: T1_CENTER_X, centerZ: T1_CENTER_Z, halfX: (_T1T2_FELT_HALF_X_GLB + _AABB_PAD_GLB) * FIT_SCALE, halfZ: (_T1T2_FELT_HALF_Z_GLB + _AABB_PAD_GLB) * FIT_SCALE },
  { centerX: T2_CENTER_X, centerZ: T2_CENTER_Z, halfX: (_T1T2_FELT_HALF_X_GLB + _AABB_PAD_GLB) * FIT_SCALE, halfZ: (_T1T2_FELT_HALF_Z_GLB + _AABB_PAD_GLB) * FIT_SCALE },
  { centerX: T3_CENTER_X, centerZ: T3_CENTER_Z, halfX: _T3T4_AABB_HALF_X_GLB * FIT_SCALE, halfZ: _T3T4_AABB_HALF_Z_GLB * FIT_SCALE },
  { centerX: T4_CENTER_X, centerZ: T4_CENTER_Z, halfX: _T3T4_AABB_HALF_X_GLB * FIT_SCALE, halfZ: _T3T4_AABB_HALF_Z_GLB * FIT_SCALE },
];

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

  // Slice 1 (2026-07-10) — all four baked card tables. Same push-out AABB
  // algorithm as the cabinet/dealer blocks above.
  for (let i = 0; i < _TABLE_AABBS.length; i++) {
    const t = _TABLE_AABBS[i]!;
    const ox = (t.halfX + aw) - Math.abs(_col_px - t.centerX);
    const oz = (t.halfZ + aw) - Math.abs(_col_pz - t.centerZ);
    if (ox > 0 && oz > 0) {
      if (ox < oz) {
        _col_px += _col_px < t.centerX ? -ox : ox;
      } else {
        _col_pz += _col_pz < t.centerZ ? -oz : oz;
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
// BankBanner — big floating bank label (CLASSIC / BONUS) above each slot
// cluster. Built fresh per-label so the canvas texture carries the right
// text + accent colour. PlaneGeometry + MeshBasicMaterial transparent;
// Iris Xe safe (no drei Text/Billboard).
//
// Banner faces +X by default; spinning the plane is unnecessary since the
// room is small enough that the banner reads from any approach angle when
// rendered DoubleSide.
// ---------------------------------------------------------------------------
function _buildBankBannerTexture(label: string, color: string): THREE.CanvasTexture {
  const W = 512, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);

  // Dark capsule background — wood-tinted to match the cove palette
  ctx.fillStyle = 'rgba(15, 25, 40, 0.92)';
  const r = H / 2;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(W - r, 0);
  ctx.quadraticCurveTo(W, 0, W, r);
  ctx.lineTo(W, H - r);
  ctx.quadraticCurveTo(W, H, W - r, H);
  ctx.lineTo(r, H);
  ctx.quadraticCurveTo(0, H, 0, H - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  // Accent-color border
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.stroke();

  // Label text
  ctx.font = '700 64px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  // Soft glow
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.fillText(label, W / 2, H / 2 + 4);
  ctx.shadowBlur = 0;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const _bankBannerCache = new Map<string, { tex: THREE.CanvasTexture; mat: THREE.MeshBasicMaterial }>();
function _getBankBanner(label: string, color: string) {
  const key = `${label}:${color}`;
  let cached = _bankBannerCache.get(key);
  if (!cached) {
    const tex = _buildBankBannerTexture(label, color);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      side: THREE.FrontSide, // single-sided; the back-plane mesh uses a flipped-UV geometry to show readable text from the back
      depthWrite: false,
    });
    cached = { tex, mat };
    _bankBannerCache.set(key, cached);
  }
  return cached;
}

// Module-scope geometry — 240wu wide × 60wu tall, readable from across the room.
const _BANK_BANNER_GEO = (() => {
  if (typeof window === 'undefined') return new THREE.PlaneGeometry(240, 60);
  return new THREE.PlaneGeometry(240, 60);
})();

function BankBanner({ label, color, position }: { label: string; color: string; position: [number, number, number] }) {
  // Two back-to-back planes so the label reads correctly from BOTH sides
  // (a single PlaneGeometry is single-sided; viewing from behind shows mirrored text).
  // The two meshes share the same canvas texture; the second is rotated 180° around Y.
  // Both lock matrixAutoUpdate=false after first updateMatrix() for Iris Xe.
  const frontRef = useRef<THREE.Mesh>(null);
  const backRef = useRef<THREE.Mesh>(null);
  const cached = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return _getBankBanner(label, color);
  }, [label, color]);
  useEffect(() => {
    if (frontRef.current) {
      frontRef.current.matrixAutoUpdate = false;
      frontRef.current.updateMatrix();
    }
    if (backRef.current) {
      backRef.current.matrixAutoUpdate = false;
      backRef.current.updateMatrix();
    }
  }, []);
  if (!cached) return null;
  return (
    <group position={position}>
      <mesh ref={frontRef} geometry={_BANK_BANNER_GEO} material={cached.mat} />
      <mesh ref={backRef} geometry={_BANK_BANNER_GEO} material={cached.mat} rotation={[0, Math.PI, 0]} />
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
// Blackjack table hotspot (Phase 6.4.0)
//
// The cove-interior GLB has a dealer station on the right wall.
// The AABB collision system already tracks this station at
// _DEALER_CENTER_X=367, _DEALER_CENTER_Z=0 with HALF extents 100×100 wu.
//
// We place the click hotspot at the same XZ centre, slightly in front
// of the table face (toward the player spawn at +Z), so the invisible
// hit-test box sits between the player and the dealer station.
//
// Size: 200wu wide × 200wu tall × 150wu deep — generous so the player
// can click from normal approach distance without pixel-perfect aim.
// Y: 0→200 wu range, centre at 100 wu (covers table-top + standing zone).
//
// Iris Xe safe: meshBasicMaterial visible=false = no draw call.
// matrixAutoUpdate=false after first frame = zero matrix recomputes.
// ---------------------------------------------------------------------------

const _BJ_HOTSPOT_POS: [number, number, number] = [
  _DEALER_CENTER_X,      // X = dealer station X (poker table center)
  100,                   // Y centre = halfway up the table height
  _DEALER_CENTER_Z,      // Z = dealer station Z (poker table center)
];
const _BJ_HOTSPOT_SIZE: [number, number, number] = [200, 200, 150];

// ---------------------------------------------------------------------------
// Phase 6.5.0 — Texas Hold'em hotspot.
//
// Mirror of the blackjack hotspot across X. The cove interior GLB has a
// second poker table at (~294, 335) — captured via the `[BJ-POS]` probe
// 2026-05-27 and locked in the cove-texas-holdem plan §0 decision row 1.
// Same invisible boxGeometry pattern as BlackjackTableHotspot: no draw
// call, matrixAutoUpdate=false after first updateMatrix (Iris Xe rule).
// ---------------------------------------------------------------------------

// Room-scale-knob refactor (2026-07-11): round-tripped into GLB-space the
// same way as _DEALER_CENTER_X/Z above — identical position at today's knob
// value, now tracks the knob at any other value.
const _HOLDEM_GLB_X = worldToGlbX(294);
const _HOLDEM_GLB_Y = worldToGlbY(335);
const _HOLDEM_CENTER_X = glbToWorldX(_HOLDEM_GLB_X);
const _HOLDEM_CENTER_Z = glbToWorldZ(_HOLDEM_GLB_Y);
const _HOLDEM_HOTSPOT_POS: [number, number, number] = [
  _HOLDEM_CENTER_X,
  100,
  _HOLDEM_CENTER_Z,
];
const _HOLDEM_HOTSPOT_SIZE: [number, number, number] = [200, 200, 150];

function BlackjackTableHotspot() {
  const meshRef = useRef<THREE.Mesh>(null);
  const openBlackjackTable = useCoveStore((s) => s.openBlackjackTable);
  const { data: avatar } = useAvatar();

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, []);

  const handleClick = () => {
    // Slice 1 (2026-07-10, founder correction): while seated at ANY table
    // (currently only T1), the felt-click 2D-modal path must be a no-op —
    // the whole session is meant to render in-world on the felt, never an
    // overlay. Founder explicitly rejected the modal-still-opens-while-
    // seated behavior as "the exact failure we're replacing." Walk-around
    // click still opens the modal as before (other games keep this path
    // until they get their own in-world slice).
    if (useCoveStore.getState().seatedTable !== null) return;
    const balance = avatar?.clawTokens ?? 0;
    openBlackjackTable(balance);
  };

  return (
    <mesh
      ref={meshRef}
      position={_BJ_HOTSPOT_POS}
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
      <boxGeometry args={_BJ_HOTSPOT_SIZE} />
      <meshBasicMaterial visible={false} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Phase 6.5.0 — Texas Hold'em table hotspot.
//
// Mirror of BlackjackTableHotspot at the second poker table (+X mirror of
// the blackjack station). Click opens the HoldemModal with the current
// avatar's ClawToken balance as the suggested buy-in cap (clamped inside
// the store via `min(balance, COVE_HOLDEM_DEFAULT_BUYIN)`).
// ---------------------------------------------------------------------------

function HoldemTableHotspot() {
  const meshRef = useRef<THREE.Mesh>(null);
  const openHoldemTable = useCoveStore((s) => s.openHoldemTable);
  const { data: avatar } = useAvatar();

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, []);

  const handleClick = () => {
    // See BlackjackTableHotspot's identical guard above — same founder
    // correction, same rationale (2026-07-10).
    if (useCoveStore.getState().seatedTable !== null) return;
    const balance = avatar?.clawTokens ?? 0;
    openHoldemTable(balance);
  };

  return (
    <mesh
      ref={meshRef}
      position={_HOLDEM_HOTSPOT_POS}
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
      <boxGeometry args={_HOLDEM_HOTSPOT_SIZE} />
      <meshBasicMaterial visible={false} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Phase 6.6.1 — Baccarat (Punto Banco) table hotspot.
//
// The baccarat sign sits at the open-floor position (X=285, Z=584) captured via
// the [BJ-POS] probe (was a sign-only placeholder in Phase 6.6.0). Same invisible
// hit-box pattern as the blackjack/holdem hotspots: no draw call
// (meshBasicMaterial visible={false}), matrixAutoUpdate=false after the first
// updateMatrix() (Iris Xe rule — zero matrix recomputes). Click opens the
// BaccaratModal with the current avatar's ClawToken balance as the header seed.
// ---------------------------------------------------------------------------

// Room-scale-knob refactor (2026-07-11): round-tripped into GLB-space, same
// treatment as the other hotspot centers above.
const _BACCARAT_GLB_X = worldToGlbX(285);
const _BACCARAT_GLB_Y = worldToGlbY(584);
const _BACCARAT_CENTER_X = glbToWorldX(_BACCARAT_GLB_X);
const _BACCARAT_CENTER_Z = glbToWorldZ(_BACCARAT_GLB_Y);
const _BACCARAT_HOTSPOT_POS: [number, number, number] = [
  _BACCARAT_CENTER_X,
  100,
  _BACCARAT_CENTER_Z,
];
const _BACCARAT_HOTSPOT_SIZE: [number, number, number] = [200, 200, 150];

function BaccaratTableHotspot() {
  const meshRef = useRef<THREE.Mesh>(null);
  const openBaccaratTable = useCoveStore((s) => s.openBaccaratTable);
  const { data: avatar } = useAvatar();

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, []);

  const handleClick = () => {
    // See BlackjackTableHotspot's identical guard above — same founder
    // correction, same rationale (2026-07-10).
    if (useCoveStore.getState().seatedTable !== null) return;
    const balance = avatar?.clawTokens ?? 0;
    openBaccaratTable(balance);
  };

  return (
    <mesh
      ref={meshRef}
      position={_BACCARAT_HOTSPOT_POS}
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
      <boxGeometry args={_BACCARAT_HOTSPOT_SIZE} />
      <meshBasicMaterial visible={false} />
    </mesh>
  );
}

// ===========================================================================
// SIT-AT-TABLE — Slice 1 (3D Hold'em experiment, 2026-07-10)
//
// Adds a walk-up + "press E to sit" interaction at card table T1: the player
// occupies seat 0, the OTHER seats show placeholder VRM busts pre-aligned to
// measured chair anchors. They now transition through Meshy's stand-to-sit
// clip and hold a seated idle (with a static-pose rollback flag), while the
// camera transitions to a seated POV looking across the felt. Also
// adds AABB collision for all four baked card tables (see _TABLE_AABBS
// above, already wired into _resolveCoveCollisions).
//
// Deliberately independent from the existing _eKeyArmedBank slot-machine
// E-key system above — separate armed/consumed state so the two never
// cross-fire. Deliberately independent from the 2D modal state (holdemOpen
// etc.) — sitting at T1 opens no modal and settles no ClawTokens; this is a
// render-layer feature the cove agent wires real seat/game state into later
// (see useCoveStore.seatedTable — the tableId/seatIndex seam is the handoff).
// ===========================================================================

interface TableSeat { x: number; z: number; faceYaw: number; }

/** Build a ring of seats around a table's felt oval from an ARC FORMULA.
 *  `anglesDeg`: 0° = +Z (the room's near/player-approach side), increasing
 *  CCW. STILL USED — but no longer for T1 (see the measured-chair block
 *  below). Kept for T2-T4 whenever a later slice builds their seats/camera,
 *  as a placeholder ring until THEY get the same in-game measurement pass
 *  T1 got here. Do not assume this formula is accurate — it wasn't for T1
 *  (see the postmortem below). */
function _buildTableSeats(feltRX: number, feltRZ: number, seatOffsetWu: number, anglesDeg: number[]): TableSeat[] {
  return anglesDeg.map((deg) => {
    const a = deg * Math.PI / 180;
    const sx = Math.sin(a) * (feltRX + seatOffsetWu);
    const sz = Math.cos(a) * (feltRZ + seatOffsetWu);
    // Face the table centre — VRM facing convention used throughout this
    // codebase, atan2(vx, vz) applied to the look-direction vector.
    const faceYaw = Math.atan2(-sx, -sz);
    return { x: sx, z: sz, faceYaw };
  });
}

// ---------------------------------------------------------------------------
// T1 MEASURED chair-seat data (2026-07-11, Slice 2 postmortem fix).
//
// The arc-formula ring above (T1_SEAT_RING_OFFSET etc.) SYNTHESIZED seat
// positions from the felt radius + a chosen offset — it was never checked
// against the actual baked chair meshes. Founder + team-lead caught the
// consequence on the seated screenshot: busts sank so low their heads hid
// behind chair backs, and one bust sat visibly ON THE FLOOR beside her
// chair, not on it. Root cause was conceptual, not a tuning miss — the
// SEAT HEIGHT was calibrated as a fraction of AVATAR height (fixed,
// avatar-relative), but the CHAIRS are baked ROOM geometry that scales
// with the room-scale knob (2000→2800, ×1.4) while the avatar didn't. The
// old avatar-relative estimate (~41.6wu drop) was too aggressive once the
// room grew — it sank busts BELOW the now-taller real chair seats.
//
// Fixed by MEASUREMENT: an in-game raycast grid sweep (ChairSeatSweep, a
// temp diagnostic component, removed after this data was captured) found a
// real, consistent, room-scaled flat surface at world Y≈56.6wu (knob=2800)
// across many XZ points near T1 — traced to mesh `Material3001` (the same
// material the furniture-map doc already flagged as carrying "much
// furniture trim"). A visual marker check confirmed 56.6 (green) sits at
// the chair-cushion height, not 44.9 (blue, a lower Material2001 surface —
// likely the chair's structural base/frame under the cushion). Converting
// 56.6wu at knob=2800 back to GLB-space height-above-floor gives
// GLB_CHAIR_SEAT_TOP_Z below — which independently matches the ~-253.9/
// -256.7 GLB-Z band the team lead separately cited, corroborating the
// measurement from two directions.
//
// XZ positions: a SECOND, finer local sweep (±60wu, 8wu step) around each
// of the 6 arc-formula hypothesis points found the REAL nearby chair-seat
// centroid for every seat (n=7-33 confirming hits each) — offsets from the
// arc-formula guess ranged 10-58wu, confirming the old ring was in the
// right neighborhood but not accurate. Captured once at knob=2800 and
// converted to permanent GLB-space constants (glbX/glbY below) via the
// SAME forward math glbToWorldX/Z use, so they correctly re-derive at any
// future knob value — NOT hardcoded world-space numbers.
const GLB_CHAIR_SEAT_TOP_Z = -253.85; // height-above-floor band; matches team-lead's independently-cited -253.9/-256.7
/** Chair-seat surface height, world Y, at the CURRENT knob — replaces the
 *  old avatar-relative SEAT_DROP estimate entirely. */
const TABLE_SEAT_HEIGHT_Y = glbHeightToWorldY(GLB_CHAIR_SEAT_TOP_Z);

interface MeasuredChairGlb { glbX: number; glbY: number; }
/** Index 0 = the local player's own seat (T1_PLAYER_SEAT_INDEX below);
 *  1-5 = the 5 bust seats. Order matches the OLD arc-formula's angle order
 *  (100,140,180,220,260,300deg) purely for continuity — it no longer means
 *  anything positional now that these are direct measurements. */
const T1_CHAIRS_GLB: MeasuredChairGlb[] = [
  { glbX: -821.39, glbY: -144.92 }, // seat0 (player)
  { glbX: -844.63, glbY: -125.64 }, // seat1
  { glbX: -876.51, glbY: -116.78 }, // seat2
  { glbX: -906.29, glbY: -126.00 }, // seat3
  { glbX: -942.49, glbY: -145.24 }, // seat4
  { glbX: -932.03, glbY: -171.39 }, // seat5
];

// ---------------------------------------------------------------------------
// Front-edge pelvis offset (2026-07-11, Slice 2c postmortem #2).
//
// Founder caught chair BACKRESTS cutting through the seated torsos on the
// 2c(b) screenshots (clearest on the mid purple-haired bust and the
// skull-shirt bust). Root cause per team-lead: T1_CHAIRS_GLB above stores
// each cushion's MEASURED CENTROID (the average of every raycast hit in the
// seat-height band, which spans the cushion front-to-back) — but a seated
// pelvis belongs near the FRONT of the cushion, not its middle. Sitting at
// the centroid put the torso too far back, into the tall backrest.
//
// Fixed by a SECOND measurement pass (ChairFrontEdgeSweep, temp diagnostic,
// removed after data capture): for each seat, sampled a line along the
// seat's own toward-table direction (the same vector faceYaw already uses)
// to find where seat-height-band hits START (back edge, toward the
// backrest) and STOP (front edge, toward the table). Per team-lead's
// instruction, the pelvis anchor is placed at the FRONT THIRD of that
// depth: frontEdge − depth/3. Values below are each seat's measured
// forward offset (world units at knob=2800, converted to GLB units via
// FIT_SCALE so they re-derive correctly at any future knob value) — NOT a
// single flat number, because per-seat cushion measurements varied.
//
// Seats 0/1/2/3/5 measured a consistent depth (~44-48wu) and front-third
// offset (~8-13wu forward of centroid) — a modest, sane adjustment. Seat4
// measured as an outlier (depth 64wu, offset 50.7wu) — its ORIGINAL
// centroid (T1_CHAIRS_GLB above) was already the weakest measurement in
// the prior pass (n=7 raycast hits vs 20-33 for the others, flagged at the
// time) and a widened re-sweep still showed asymmetric back/front extents
// around it, meaning the stored centroid itself sits well toward the BACK
// of the true cushion — the large offset compensates for that, not a
// different chair shape. Verify seat4 specifically after this change
// (knee/table clearance risk from a big forward shift, per team-lead) —
// if it visibly clips the table, reduce ITS offset only, not the others.
const T1_SEAT_FORWARD_OFFSET_GLB: number[] = [13.3, 9.3, 13.3, 13.3, 50.7, 8.0].map((wu) => wu / FIT_SCALE);

export const T1_SEATS: TableSeat[] = T1_CHAIRS_GLB.map((c, i) => {
  const wx = glbToWorldX(c.glbX);
  const wz = glbToWorldZ(c.glbY);
  // Unit vector from the measured cushion centroid toward the table centre
  // — the SAME direction faceYaw below points, so "forward" for the offset
  // and "forward" for facing are guaranteed consistent.
  const towardDX = T1_CENTER_X - wx;
  const towardDZ = T1_CENTER_Z - wz;
  const towardDist = Math.hypot(towardDX, towardDZ) || 1;
  const towardUX = towardDX / towardDist;
  const towardUZ = towardDZ / towardDist;
  const forwardOffsetWorld = T1_SEAT_FORWARD_OFFSET_GLB[i]! * FIT_SCALE;
  const wxAdjusted = wx + towardUX * forwardOffsetWorld;
  const wzAdjusted = wz + towardUZ * forwardOffsetWorld;
  // Seat XZ is stored as an OFFSET from T1_CENTER (matching the existing
  // TableSeat shape, which every consumer — Table3D, the seat camera —
  // already adds to T1_CENTER_X/Z), so the measured + adjusted absolute
  // position is converted to a table-relative offset here, once.
  const sx = wxAdjusted - T1_CENTER_X;
  const sz = wzAdjusted - T1_CENTER_Z;
  // Face the table centre, same VRM convention as the old formula.
  const faceYaw = Math.atan2(-sx, -sz);
  return { x: sx, z: sz, faceYaw };
});

/** Seat 0 is reserved for the local player; seats 1..5 get placeholder busts. */
export const T1_PLAYER_SEAT_INDEX = 0;
/** Placeholder identities for the non-player seats — Slice 1 has no real
 *  roster yet (downstream: the cove agent wires live seat occupancy).
 *  Slice 2 fix (2026-07-11): was 5 entries with 'milady_official_2'
 *  duplicated (founder flag — "no duplicate models at one table"). Now 5
 *  DISTINCT MODEL_REGISTRY entries: 4 Miladies (already-verified proportions,
 *  hip-height fraction ~0.50 measured via headless harness) + 1 Hermes
 *  (adult-realistic proportions, hip-height fraction ~0.60 — also measured,
 *  not assumed) for variety without introducing a THIRD unmeasured body
 *  type. Chibi models deliberately excluded — mixing chibi (big-head/short-
 *  limb) proportions with these would need its own calibration pass; see
 *  SEATED_HIP_HEIGHT_FRACTION below for how the two measured body types are
 *  reconciled. */
const T1_SEAT_BUST_MODEL_KEYS: Array<keyof typeof MODEL_REGISTRY> = [
  'milady_official_2', 'milady_official_5', 'milady_official_7', 'milady_official_4', 'hermes_female',
];

// Seat-POV camera — eye at seat 0, looking across the felt toward the far
// rim so the OTHER seated busts are in frame (not just the felt centre).
//
// Room-scale-knob refactor (2026-07-11) — XZ vs Y split: the HORIZONTAL
// (XZ) position of the seat and the "look past centre" nudge are PHYSICAL
// positions tied to the growing table, so they scale with FIT_SCALE like
// everything else above. The VERTICAL (Y) eye/look heights are deliberately
// NOT re-scaled — they stay fixed avatar-relative offsets ABOVE the
// (scaled) TABLE_TOP_Y, because the avatar's own height is fixed by
// founder decision ("room grows around a fixed-size avatar"). A seated
// eye height that scaled with the room would eventually exceed the
// standing eye height (COVE_VRM_TARGET_HEIGHT) at a big enough knob value —
// nonsensical for a person sitting down. Offset values below are the
// ORIGINAL fixed numbers this file already had (128-59=69 eye-above-table,
// 30 look-above-table — the look offset was ALREADY expressed this way
// pre-refactor), now anchored to the scaled TABLE_TOP_Y instead of a flat 59.
const _t1PlayerSeat = T1_SEATS[T1_PLAYER_SEAT_INDEX]!;
const _t1SeatDist = Math.hypot(_t1PlayerSeat.x, _t1PlayerSeat.z) || 1;
const T1_SEAT_CAM_EYE_X = T1_CENTER_X + _t1PlayerSeat.x;
/** Fixed avatar-relative offset — seated eye sits below standing eye level. */
const SEAT_EYE_HEIGHT_ABOVE_TABLE = 69; // wu, fixed (was flat EYE_Y=128 at TABLE_TOP_Y=59)
const T1_SEAT_CAM_EYE_Y = TABLE_TOP_Y + SEAT_EYE_HEIGHT_ABOVE_TABLE;
const T1_SEAT_CAM_EYE_Z = T1_CENTER_Z + _t1PlayerSeat.z;
// Look-at point: table centre, nudged past centre AWAY from the player's
// seat so the far-side busts read clearly rather than dead-centre felt.
// Nudge distance (40wu at the 2000 baseline) round-tripped into GLB units —
// it's a framing choice tied to the table's own width, so it scales.
const _LOOK_NUDGE_GLB = 40 / BASELINE_FIT_SCALE;
const T1_SEAT_CAM_LOOK_NUDGE = _LOOK_NUDGE_GLB * FIT_SCALE;
const T1_SEAT_CAM_LOOK_X = T1_CENTER_X - (_t1PlayerSeat.x / _t1SeatDist) * T1_SEAT_CAM_LOOK_NUDGE;
/** Fixed avatar-relative offset — already expressed this way pre-refactor.
 * P2.1 (2026-07-15): 30 → 8, pitching the seated view down ~6° (view axis
 * 11.1° → 17.1° below horizontal). This moves the bottom-of-frame-on-felt
 * locus from ~71wu to ~57wu from the eye — the unlock that brings the
 * player's own hole cards into frame at all. Far-side busts stay fully
 * framed (top frame edge remains 15.4° above horizontal). Flagged for
 * founder sign-off vs the approved sit-flow framing. */
const SEAT_LOOK_HEIGHT_ABOVE_TABLE = 8; // wu, fixed
const T1_SEAT_CAM_LOOK_Y = TABLE_TOP_Y + SEAT_LOOK_HEIGHT_ABOVE_TABLE;
const T1_SEAT_CAM_LOOK_Z = T1_CENTER_Z - (_t1PlayerSeat.z / _t1SeatDist) * T1_SEAT_CAM_LOOK_NUDGE;
const T1_SEAT_CAM_LERP = 8; // exp-decay coefficient (1/s) — not spatial, unaffected by scale

// ---------------------------------------------------------------------------
// Static seated-pose fallback (2026-07-11). The default path now uses the
// Meshy transition + idle clips, whose hip track owns the full vertical
// descent. Keep these direct normalized-bone rotations and the seatDrop math
// intact behind USE_COVE_SIT_CLIPS so a clip regression can be disabled with
// one module-level flag and no revert. The two paths never stack.
//
// Rotation axis/sign VERIFIED (not assumed) via a headless VRM harness
// (bun, no browser — same verification pattern the squat-clip memory
// recommends): loaded milady-official-2.vrm, rotated leftUpperLeg around
// its NORMALIZED local X axis, and read the knee/foot world position
// before/after. -90° around local X swings the knee up to ~hip height and
// forward (matches a horizontal, seated thigh); a further +90° on
// leftLowerLeg (also local X) brings the shin back down so the foot lands
// roughly below the knee (matches a natural hanging shin). Cross-checked
// the SAME rotation values on rightUpperLeg/rightLowerLeg — VRM normalized
// bones use a symmetric local-axis convention, no mirrored sign needed.
const SEATED_THIGH_ROTATION_RAD = THREE.MathUtils.degToRad(-90);
const SEATED_KNEE_ROTATION_RAD  = THREE.MathUtils.degToRad(90);
// Module-scope, built once — never reallocated per frame or per instance.
const _seatedThighQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), SEATED_THIGH_ROTATION_RAD);
const _seatedKneeQuat  = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), SEATED_KNEE_ROTATION_RAD);

/**
 * Static-fallback-only distance to lower the whole VRM (group Y) so the
 * pelvis reads at chair-seat
 * height instead of standing-hip height, given the leg rotation above keeps
 * the hips bone itself untouched (simpler + lower-risk than also moving the
 * hips bone position — the group-level Y offset achieves the same visual
 * result without touching VRMHumanoidRig's hips-specific position-propagation
 * special-case).
 *
 * POSTMORTEM (2026-07-11): the first version of this drop was an
 * avatar-relative ENGINEERING ESTIMATE (fraction of standing avatar height)
 * — wrong in principle, not just imprecise. Chairs are baked ROOM geometry
 * that scales with the room-scale knob (×1.4 at 2000→2800); avatars don't.
 * "seat ≈ half of standing hip" doesn't hold once the room and the avatar
 * scale independently — the estimate assumed a SMALLER seat than the real,
 * now-bigger chair, so busts sank BELOW the actual seat surface (one bust
 * visibly sat on the floor beside her chair, not on it).
 *
 * Fixed: drop target is now TABLE_SEAT_HEIGHT_Y, the MEASURED chair-seat
 * surface (in-game raycast grid sweep, see the T1_CHAIRS_GLB comment
 * block above) converted through the same knob-aware glbHeightToWorldY
 * helper every other physical-geometry constant in this file uses — so it
 * re-derives correctly at any future knob value, unlike the old fixed
 * fraction.
 *
 * The STANDING hip height itself stays avatar-relative (correctly so — the
 * avatar's own body proportions don't change with room scale).
 * SEATED_HIP_HEIGHT_FRACTION = 0.52 is VERIFIED (not guessed) via a
 * headless harness on the two body types in the roster: Milady measured
 * 0.5028, Hermes-female measured 0.5988, averaged. A per-model live
 * measurement would be marginally more precise; the averaged constant is
 * an accepted simplification for a background NPC bust.
 */
const SEATED_HIP_HEIGHT_FRACTION = 0.52;

// ---------------------------------------------------------------------------
// TableSeatedBust — one seated VRM figure locked at a table seat.
// Per-instance unique instanceId → unique VRM parse (never share a parsed
// VRM across visible avatars — gotchas/vrm-shared-instance-corruption.md).
//
// Ticks the active clip every frame via useFrame — the same live pattern
// vrm-wandering-npc.tsx NPCs use (patterns/vrm-wandering-npc.md), NOT a
// "settle once then freeze" bake. An earlier version of this component
// constructed a VRMCharacterAnimator, ran its update() loop 60 times inside
// a single useEffect, then disposed — the loop provably completed (verified
// via console logging, 2026-07-10) but every bust still rendered in the raw
// VRM bind T-pose. Root cause not fully isolated (candidates: React
// StrictMode's double-effect-invoke racing the per-seat animator
// construction/disposal, since the "already patched" skeleton.update warning
// fired repeatedly for these instances; or some other one-shot-bake
// assumption that doesn't hold for this asset). Rather than chase an
// unverified fix for a novel bake pattern, switched to the SAME continuous
// per-frame update() pattern every other animated character in this codebase
// already uses successfully — 5 extra ticking VRMs is a known-cheap cost
// (idle-only, no locomotion, no user IK), well inside the Iris Xe budget for
// a small interior room.
//
// When USE_COVE_SIT_CLIPS=false, the Slice 2 fallback layers a per-frame
// SEATED LEG POSE on top of the idle tick: after anim.update() ticks idle
// (upper-body life — breathing/sway), this overrides the 4 leg bones to a
// fixed seated bend, then re-propagates (vrm.humanoid.update() + scene.
// updateMatrixWorld) and re-flushes the skeleton (anim.flushSkeletonUpdates()
// — a new public method; without it the override computes correctly but
// never reaches the GPU, since skeleton.update() is patched to a no-op and
// only the animator's OWN internal flush call runs it, which happens BEFORE
// this override in the same frame). This doubles the per-bust
// updateMatrixWorld cost (idle tick's internal call + this one) — a real,
// non-zero addition on top of the already-accepted "5 idle-only ticking
// VRMs" baseline; still small for 5 static background busts in a small
// interior room, but flagged honestly rather than hidden.
// ---------------------------------------------------------------------------
function TableSeatedBustInner({ reg, seat, seatIndex, instanceId, targetHeight }: {
  reg: ModelRegistryEntry;
  seat: TableSeat;
  seatIndex: number;
  instanceId: string;
  targetHeight: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const vrm = useVRMInstance(reg.path, instanceId);
  const animRef = useRef<VRMCharacterAnimator | null>(null);
  const sitHeightElapsedRef = useRef(-1);
  const sitHeightCheckedRef = useRef(false);
  // ModelRegistryEntry has no gender metadata. Alternate the Meshy M/F idle
  // variants by stable seat index until live roster metadata supplies it.
  const sitIdleClip: AnimName = seatIndex % 2 === 0 ? 'sit_idle_f' : 'sit_idle_m';
  // Cached leg-bone refs — looked up once when the VRM loads, never re-queried
  // per frame (getNormalizedBoneNode is a map lookup, cheap, but there is no
  // reason to pay it 4x every frame for a value that never changes per-VRM).
  const legBonesRef = useRef<{
    leftUpperLeg: THREE.Object3D; rightUpperLeg: THREE.Object3D;
    leftLowerLeg: THREE.Object3D; rightLowerLeg: THREE.Object3D;
  } | null>(null);

  const { scale: vrmRenderScale, offsetY: vrmFootOffsetY } = useMemo(
    () => computeVRMAvatarFit(vrm, reg.animatorId, targetHeight),
    [vrm, reg.animatorId, targetHeight],
  );

  // Seated Y offset — standing hip height (avatar-relative, fixed) minus
  // the MEASURED chair-seat surface (room-scale-knob-aware). See the
  // TABLE_SEAT_HEIGHT_Y / SEATED_HIP_HEIGHT_FRACTION comment blocks above
  // for the postmortem on why this used to be purely avatar-relative and
  // why that was wrong.
  const seatDrop = useMemo(
    () => (targetHeight * SEATED_HIP_HEIGHT_FRACTION) - TABLE_SEAT_HEIGHT_Y,
    [targetHeight],
  );

  useEffect(() => {
    return () => disposeVRMInstance(reg.path, instanceId);
  }, [reg.path, instanceId]);

  useEffect(() => {
    if (!vrm) return;
    if (USE_COVE_SIT_CLIPS) {
      legBonesRef.current = null;
      return;
    }
    const humanoid = vrm.humanoid;
    if (!humanoid) { legBonesRef.current = null; return; }
    const leftUpperLeg = humanoid.getNormalizedBoneNode('leftUpperLeg');
    const rightUpperLeg = humanoid.getNormalizedBoneNode('rightUpperLeg');
    const leftLowerLeg = humanoid.getNormalizedBoneNode('leftLowerLeg');
    const rightLowerLeg = humanoid.getNormalizedBoneNode('rightLowerLeg');
    if (leftUpperLeg && rightUpperLeg && leftLowerLeg && rightLowerLeg) {
      legBonesRef.current = { leftUpperLeg, rightUpperLeg, leftLowerLeg, rightLowerLeg };
    } else {
      console.warn('[TableSeatedBust] missing leg bone(s) on', reg.path, '— rendering standing (no seated pose).');
      legBonesRef.current = null;
    }
  }, [vrm, reg.path]);

  useEffect(() => {
    if (!vrm) return;
    let cancelled = false;
    sitHeightElapsedRef.current = -1;
    sitHeightCheckedRef.current = false;
    const anim = new VRMCharacterAnimator(vrm, reg.animatorId);
    anim.init('idle').then(async () => {
      if (cancelled) { anim.dispose(); return; }
      animRef.current = anim;
      if (USE_COVE_SIT_CLIPS) {
        // The outer group is already declaratively positioned at the seat's
        // final XZ anchor and yaw. Flush that transform before the in-place
        // transition starts; the clip owns vertical hip descent only.
        groupRef.current?.updateMatrixWorld(true);
        await anim.playOneShot(
          'sit_stand_to_sit',
          sitIdleClip,
          COVE_SIT_TRANSITION_TIME_SCALE,
        );
        if (!cancelled) sitHeightElapsedRef.current = 0;
      }
    }).catch((e) => { console.warn('[TableSeatedBust] init failed:', e); anim.dispose(); });
    return () => {
      cancelled = true;
      if (animRef.current === anim) animRef.current = null;
      // React removes this scene subtree in the same teardown that disposes
      // the animator, so sit_to_stand_m/f would never render a frame here.
      // They stay registered/prewarmed for a future occupancy handoff that can
      // keep the bust mounted while a leave transition completes.
      anim.dispose();
    };
  }, [vrm, reg.animatorId, sitIdleClip]);

  useFrame((_, delta) => {
    const anim = animRef.current;
    if (!anim) return;
    anim.update(Math.min(delta, 0.1), false, false);

    const legs = legBonesRef.current;
    if (!USE_COVE_SIT_CLIPS && legs && vrm.humanoid) {
      legs.leftUpperLeg.quaternion.copy(_seatedThighQuat);
      legs.rightUpperLeg.quaternion.copy(_seatedThighQuat);
      legs.leftLowerLeg.quaternion.copy(_seatedKneeQuat);
      legs.rightLowerLeg.quaternion.copy(_seatedKneeQuat);
      vrm.humanoid.update();
      vrm.scene.updateMatrixWorld(true);
      anim.flushSkeletonUpdates();
    }

    if (
      USE_COVE_SIT_CLIPS &&
      typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production' &&
      !sitHeightCheckedRef.current && sitHeightElapsedRef.current >= 0
    ) {
      sitHeightElapsedRef.current += Math.min(delta, 0.1);
      if (sitHeightElapsedRef.current >= COVE_SIT_HEIGHT_CHECK_DELAY_SECONDS) {
        sitHeightCheckedRef.current = true;
        const rawHips = vrm.humanoid?.getRawBoneNode('hips');
        if (!rawHips) {
          console.warn('[TableSeatedBust] cannot validate seated height: raw hips bone missing', reg.path);
        } else {
          rawHips.getWorldPosition(_coveSitRawHipsWorld);
          const heightError = Math.abs(_coveSitRawHipsWorld.y - TABLE_SEAT_HEIGHT_Y);
          if (heightError > COVE_SIT_HIP_HEIGHT_TOLERANCE) {
            console.warn(
              `[TableSeatedBust] seated raw hips Y=${_coveSitRawHipsWorld.y.toFixed(2)}wu ` +
              `misses cushion Y=${TABLE_SEAT_HEIGHT_Y.toFixed(2)}wu by ${heightError.toFixed(2)}wu ` +
              `(tolerance ${COVE_SIT_HIP_HEIGHT_TOLERANCE.toFixed(2)}wu; seat ${seatIndex})`,
            );
          }
        }
      }
    }
  });

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.updateMatrix();
    g.matrixAutoUpdate = false;
  }, [vrm, instanceId]);

  return (
    <group ref={groupRef} position={[seat.x, 0, seat.z]} rotation={[0, seat.faceYaw, 0]}>
      <primitive
        object={vrm.scene}
        scale={[vrmRenderScale, vrmRenderScale, vrmRenderScale]}
        position={[0, USE_COVE_SIT_CLIPS ? vrmFootOffsetY : vrmFootOffsetY - seatDrop, 0]}
      />
    </group>
  );
}

function TableSeatedBust(props: {
  reg: ModelRegistryEntry;
  seat: TableSeat;
  seatIndex: number;
  instanceId: string;
  targetHeight: number;
}) {
  return (
    <Suspense fallback={null}>
      <TableSeatedBustInner {...props} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Table3D — mounts the seated-bust ring above the baked GLB table T1.
// The baked felt/rail geometry IS the visual table (no procedural overlay);
// this component only places the OTHER players' figures around it.
// ---------------------------------------------------------------------------
function Table3D({ centerX, centerZ, seats, playerSeatIndex, seatModelKeys, bustTargetHeight }: {
  centerX: number; centerZ: number;
  seats: TableSeat[];
  playerSeatIndex: number;
  seatModelKeys: Array<keyof typeof MODEL_REGISTRY>;
  bustTargetHeight: number;
}) {
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.updateMatrixWorld(true);
    g.traverse((obj) => { obj.matrixAutoUpdate = false; });
  }, []);

  return (
    <group ref={groupRef} position={[centerX, 0, centerZ]}>
      {seats.map((seat, i) => {
        if (i === playerSeatIndex) return null; // the local player occupies this seat
        const key = seatModelKeys[i % seatModelKeys.length];
        if (!key) return null;
        const reg = MODEL_REGISTRY[key] as ModelRegistryEntry;
        return (
          <TableSeatedBust
            key={`t1-bust-${i}`}
            reg={reg}
            seat={seat}
            seatIndex={i}
            instanceId={`cove-t1-seat-${i}`}
            targetHeight={bustTargetHeight}
          />
        );
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// TableSeatCamera — owns the camera while seatedTable is set. Lerps to the
// seat-0 POV and holds the lookAt. Both CovePlayerAvatar branches gate their
// own follow-camera code off whenever seatedTable !== null (see the `seated`
// checks below), so this is the sole camera author while seated.
// ---------------------------------------------------------------------------
const _tableSeatCamPos = new THREE.Vector3();
const _tableSeatCamLook = new THREE.Vector3(T1_SEAT_CAM_LOOK_X, T1_SEAT_CAM_LOOK_Y, T1_SEAT_CAM_LOOK_Z);

function TableSeatCamera() {
  const { camera } = useThree();
  useFrame((_, delta) => {
    const { seatedTable } = useCoveStore.getState();
    if (!seatedTable) return;
    // Slice 1 has only one seated table (T1); a later slice indexes a
    // per-table config map keyed by seatedTable.tableId.
    const cam = camera as THREE.PerspectiveCamera;
    _tableSeatCamPos.set(T1_SEAT_CAM_EYE_X, T1_SEAT_CAM_EYE_Y, T1_SEAT_CAM_EYE_Z);
    cam.position.lerp(_tableSeatCamPos, 1 - Math.exp(-T1_SEAT_CAM_LERP * delta));
    cam.lookAt(_tableSeatCamLook);
  });
  return null;
}

// ---------------------------------------------------------------------------
// Sit/stand proximity + E-key — independent armed/consumed state from the
// existing _eKeyArmedBank mechanism above (slot machines keep working
// unmodified). Read by TableSitLabel each frame to drive the WorldLabel hint
// text; zero allocations.
// ---------------------------------------------------------------------------
// Room-scale-knob refactor (2026-07-11): interaction radii are physical
// distances from the (scaled) table centre, so a bigger table reasonably
// needs a bigger "walk up" radius too — round-tripped into GLB units like
// the other legacy-chosen values above.
const _SIT_NEAR_GLB = 260 / BASELINE_FIT_SCALE;
const _SIT_ARM_GLB  = 180 / BASELINE_FIT_SCALE;
const TABLE_SIT_NEAR = _SIT_NEAR_GLB * FIT_SCALE; // wu — label becomes visible
const TABLE_SIT_ARM  = _SIT_ARM_GLB * FIT_SCALE;  // wu — E key actually arms

let _eKeyArmedTableSit = false;
let _eKeyTableConsumed = false;
let _tableSitNearHint = false;

/** Called every frame while walking (not seated) — arms/fires the sit action. */
function _updateTableSitProximity(px: number, pz: number): void {
  const dSq = (px - T1_CENTER_X) ** 2 + (pz - T1_CENTER_Z) ** 2;
  _eKeyArmedTableSit = dSq <= TABLE_SIT_ARM * TABLE_SIT_ARM;
  _tableSitNearHint  = dSq <= TABLE_SIT_NEAR * TABLE_SIT_NEAR;
  if (!_eKeyArmedTableSit) _eKeyTableConsumed = false;

  if (_eKeyArmedTableSit && coveKeys.e && !_eKeyTableConsumed) {
    _eKeyTableConsumed = true;
    if (useCoveStore.getState().seatedTable === null) {
      useCoveStore.getState().sitAtTable('T1', T1_PLAYER_SEAT_INDEX);
    }
  }
}

/** Called every frame while seated — E key stands back up. */
function _updateTableStandProximity(): void {
  if (coveKeys.e && !_eKeyTableConsumed) {
    _eKeyTableConsumed = true;
    useCoveStore.getState().standFromTable();
  } else if (!coveKeys.e) {
    _eKeyTableConsumed = false;
  }
}

// Module-scope anchor for the sit-prompt WorldLabel — table centre, above
// the felt (mirrors the _classicBankAnchor / _bonusBankAnchor pattern).
const _t1SitAnchor = new THREE.Object3D();
_t1SitAnchor.position.set(T1_CENTER_X, TABLE_TOP_Y + 150, T1_CENTER_Z);
_t1SitAnchor.matrixAutoUpdate = false;
_t1SitAnchor.updateMatrix();
_t1SitAnchor.updateWorldMatrix(false, false);
const _t1SitAnchorRef = { current: _t1SitAnchor } as RefObject<THREE.Object3D | null>;

function _tableSitLabelCapsule(seated: boolean, hint: boolean) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: 'translateY(-50%)' }}>
      <div
        style={{
          fontFamily: 'var(--font-fraunces, "Cormorant Garamond", "Spectral", Georgia, serif)',
          fontVariationSettings: '"opsz" 9',
          fontWeight: 520,
          fontSize: 15,
          color: '#ffd8a0',
          padding: '7px 15px 9px',
          borderRadius: 999,
          background: 'rgba(32, 18, 8, 0.85)',
          border: '1px solid rgba(255, 200, 120, 0.55)',
          boxShadow: '0 0 22px rgba(255,200,120,0.5), 0 0 60px -10px rgba(255,200,120,0.45), inset 0 0 14px rgba(240,200,120,0.18)',
          whiteSpace: 'nowrap',
          letterSpacing: '0.02em',
          lineHeight: 1,
          userSelect: 'none',
        }}
      >
        {seated ? 'Seated' : 'Table T1'}
        {hint && (
          <span
            style={{
              display: 'block', fontSize: 9, fontStyle: 'italic',
              fontFamily: 'var(--font-oxanium, sans-serif)', fontWeight: 400,
              color: '#ffe875', opacity: 0.9, marginTop: 2, letterSpacing: '0.1em', textTransform: 'uppercase',
            }}
          >
            {seated ? 'press E to stand' : 'press E to sit'}
          </span>
        )}
      </div>
      <div
        style={{
          width: 1, height: 40,
          backgroundImage: 'linear-gradient(rgba(255,200,120,0.78) 50%, transparent 50%)',
          backgroundSize: '1px 6px', backgroundRepeat: 'repeat-y',
          boxShadow: '0 0 6px rgba(255,200,120,0.55)', marginBottom: 2,
        }}
      />
      <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'rgba(255,216,160,1)' }} />
    </div>
  );
}

/** Proximity-driven "Sit at Table T1" / "Seated — press E to stand" label. */
function TableSitLabel() {
  const [hint, setHint] = useState(false);
  const [seated, setSeated] = useState(false);

  const { divRef } = useWorldLabel({
    id: 'cove-t1-sit',
    anchorRef: _t1SitAnchorRef,
    offset: [0, 0, 0],
    initialVisible: true,
    fadeNear: BANK_LABEL_FADE_NEAR,
    fadeFar: BANK_LABEL_FADE_FAR,
    fadeBaseOpacity: 0.9,
    occlude: false,
  });

  useFrame(() => {
    const isSeated = useCoveStore.getState().seatedTable !== null;
    if (isSeated !== seated) setSeated(isSeated);
    const nextHint = isSeated || _tableSitNearHint;
    if (nextHint !== hint) setHint(nextHint);
  });

  return (
    <WorldLabel divRef={divRef}>
      {_tableSitLabelCapsule(seated, hint)}
    </WorldLabel>
  );
}

// ---------------------------------------------------------------------------
// Phase-0 debug probe (2026-07-10) — gated behind NEXT_PUBLIC_COVE_DEBUG='1'
// or ?probe=1 (see the flag check in the default export below). Renders a
// small marker sphere at each derived table centre and raycasts straight
// down to confirm a hit near TABLE_TOP_Y. Mirrors the existing [cove-fit]
// / [cove-interior DEBUG] console-probe convention already in this file —
// zero cost when the flag is off (component isn't mounted at all).
// ---------------------------------------------------------------------------
const _TABLE_PROBE_GEO = new THREE.SphereGeometry(15, 12, 12);
const _TABLE_PROBE_MAT = new THREE.MeshBasicMaterial({ color: 0xff00ff });
const _probeRaycaster = new THREE.Raycaster();
const _probeOrigin = new THREE.Vector3();
const _probeDir = new THREE.Vector3(0, -1, 0);

const _TABLE_PROBE_CANDIDATES: Array<{ id: string; x: number; z: number }> = [
  { id: 'T1', x: T1_CENTER_X, z: T1_CENTER_Z },
  { id: 'T2', x: T2_CENTER_X, z: T2_CENTER_Z },
  { id: 'T3', x: T3_CENTER_X, z: T3_CENTER_Z },
  { id: 'T4', x: T4_CENTER_X, z: T4_CENTER_Z },
];

function TableProbeMarkers() {
  const { scene } = useThree();
  // Retry-until-hit, not fire-once-on-frame-1: the interior GLB loads async
  // (Suspense), so a frame-1 raycast always misses (scene.children is empty
  // of interior geometry that early) regardless of whether the XZ position
  // is correct. Re-probe every ~0.5s for up to ~10s so the log reflects the
  // GLB's actual loaded state. Bug found + fixed during the Slice 1 Phase-0
  // verification pass (2026-07-10) — the predecessor session's frame-1-only
  // version could never produce a real hit.
  const attemptsRef = useRef(0);
  const lastLogRef = useRef(0);
  const doneRef = useRef(false);

  useFrame((state) => {
    if (doneRef.current) return;
    const t = state.clock.elapsedTime;
    if (t - lastLogRef.current < 0.5) return;
    lastLogRef.current = t;
    attemptsRef.current += 1;

    const results = _TABLE_PROBE_CANDIDATES.map((c) => {
      _probeOrigin.set(c.x, 400, c.z);
      _probeRaycaster.set(_probeOrigin, _probeDir);
      const hits = _probeRaycaster.intersectObjects(scene.children, true);
      // Room-shell/trim meshes span nearly the full room height and can
      // occlude the felt from a straight-down ray, so report ALL hits
      // (not just the first) — the felt-level hit is whichever lands
      // nearest TABLE_TOP_Y, not necessarily first in the list.
      const nearFelt = hits.find((h) => Math.abs(h.point.y - TABLE_TOP_Y) < 25);
      return { c, hit: hits[0], nearFelt, allYs: hits.map((h) => h.point.y.toFixed(1)) };
    });
    const allHit = results.every((r) => r.hit);
    const allFeltConfirmed = results.every((r) => r.nearFelt);

    console.info(`[cove3d-probe] attempt #${attemptsRef.current} (t=${t.toFixed(1)}s) — raycast straight down from Y=400:`);
    for (const { c, hit, nearFelt, allYs } of results) {
      console.info(
        `  ${c.id} world=(${c.x},${c.z}) expectedTopY≈${TABLE_TOP_Y} ` +
        (hit
          ? `firstHitY=${hit.point.y.toFixed(1)} allHitYs=[${allYs.join(',')}] ` +
            (nearFelt ? `FELT-CONFIRMED at Y=${nearFelt.point.y.toFixed(1)}` : 'NO hit near felt height')
          : 'raycast MISS (no geometry below — position likely wrong, OR GLB not loaded yet)'),
      );
    }
    if (allFeltConfirmed || attemptsRef.current >= 20) {
      doneRef.current = true;
      console.info(`[cove3d-probe] ${allFeltConfirmed ? 'all 4 felt-confirmed — done.' : 'giving up after 20 attempts — see rows above (allHit=' + allHit + ').'}`);
    }
  });

  return (
    <>
      {_TABLE_PROBE_CANDIDATES.map((c) => (
        <mesh key={c.id} geometry={_TABLE_PROBE_GEO} material={_TABLE_PROBE_MAT} position={[c.x, TABLE_TOP_Y + 25, c.z]} />
      ))}
    </>
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
  const rotRef = useRef(0); // face +Z = into the room from the new -411 spawn (door side)
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
    _coveCamYaw          = 0;
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

    // Seated at T1 (Slice 1, 2026-07-10) — TableSeatCamera owns the camera.
    // Freeze WASD movement entirely, hide the standing avatar (the seat POV
    // should show the OTHER players across the felt, not the local player's
    // own back), and keep the VRM idle-ticking so it's settled the instant
    // we stand. E-key stands back up. Early-return: nothing below this
    // block should run while seated.
    if (useCoveStore.getState().seatedTable !== null) {
      _updateTableStandProximity();
      const seatedGroup = groupRef.current;
      if (seatedGroup) seatedGroup.visible = false;
      const seatedAnim = vrmAnimRef.current;
      if (seatedAnim) seatedAnim.update(Math.min(delta, 0.1), false, false);
      return;
    }

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
      // iPad / touch joystick contribution — folded on top of WASD so a user
      // with both keyboard and touch could combine inputs without conflict.
      // _coveTouchVec.x = strafe (+right), _coveTouchVec.z = forward (+fwd).
      inputFwd  += _coveTouchVec.z;
      inputRight += _coveTouchVec.x;
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
    // Walking (not seated) — always visible. Mirrors the seated early-return
    // above, which is the only place this gets set false.
    group.visible = true;

    // Sit-at-table T1 proximity — after position is finalised for this frame.
    _updateTableSitProximity(posX.current, posZ.current);

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
    <group ref={groupRef} position={[PLAYER_SPAWN_X, 0, PLAYER_SPAWN_Z]} rotation={[0, 0, 0]}>
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
  const rotRef    = useRef(0); // face +Z = into the room from the -411 spawn (door side)
  const { camera } = useThree();
  const { data: avatar } = useAvatar();

  // Sync avatar balance to module-scope so E-key handler can read it
  useEffect(() => {
    if (avatar?.clawTokens != null) _coveAvatarClawTokens = avatar.clawTokens;
  }, [avatar?.clawTokens]);

  // Reset module-scope camera state on mount (mirrors VRM branch).
  useEffect(() => {
    _coveCamYaw          = 0;
    _coveArrowYawOffset   = 0;
    _coveArrowPitchOffset = 0;
  }, []);

  const { scene } = useGLTFWithKTX2('/models/lobster-ktx.glb');

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

    // Seated at T1 (Slice 1, 2026-07-10) — mirrors the VRM branch: freeze
    // movement, hide the standing avatar, let TableSeatCamera own the
    // camera. No VRM animator to tick in this GLB branch. Early-return.
    if (useCoveStore.getState().seatedTable !== null) {
      _updateTableStandProximity();
      const seatedGroup = groupRef.current;
      if (seatedGroup) seatedGroup.visible = false;
      return;
    }

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
      // iPad / touch joystick contribution — folded on top of WASD so a user
      // with both keyboard and touch could combine inputs without conflict.
      // _coveTouchVec.x = strafe (+right), _coveTouchVec.z = forward (+fwd).
      inputFwd  += _coveTouchVec.z;
      inputRight += _coveTouchVec.x;
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
      // lobster-ktx.glb faces +Z at rot=0 — see feedback_lobster_faces_negative_z memory.
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
    // Walking (not seated) — always visible. Mirrors the seated early-return
    // above, which is the only place this gets set false.
    group.visible = true;

    // Sit-at-table T1 proximity — after position is finalised for this frame.
    _updateTableSitProximity(posX.current, posZ.current);

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

  const { cloned, hotspots, meshCount, classicCentroid, bonusCentroid, hasDiscovery } = useMemo(() => {
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

    // ─── Slot cabinet discovery — BANK CLUSTER + X-AXIS SPLIT ────────────
    //
    // The cove-interior.glb merges every cabinet in a bank into one mesh
    // per material slot (sketchfab "merge by material" export setting).
    // There are NO individual cabinet meshes. CDP runtime dump confirmed:
    //
    //   Material2 / Material3_{2,3,5,8} all cluster at pos≈(1, 79, -453)
    //   with footprint 670-690wu wide × 337-358wu deep. That's ONE BANK
    //   (the only bank in the room). The "two rows" visible in screenshots
    //   are back-to-back cabinets in that same bank, each row facing
    //   outward to the chairs on either side.
    //
    // So instead of per-mesh discovery, we:
    //   1. Find the bank-cluster meshes (low height, large but not
    //      room-spanning footprint, far Z from room center).
    //   2. UNION their bboxes into one bank bbox.
    //   3. SPLIT the bank bbox in half along X.
    //   4. Emit TWO hotspots: left half = classic, right half = bonus.
    //   5. Place a BANNER above each half centred on that half's centroid.
    //
    // If we can't find a bank cluster, fall back to GAMEREADY_HOTSPOTS so
    // the room stays clickable.
    const _bb = new THREE.Box3();
    const _bbSize = new THREE.Vector3();
    const _bbCenter = new THREE.Vector3();

    // Cluster filter: meshes with "bank-row" geometry — wide along one
    // axis, narrow on the others, sitting near the floor, AT LEAST one
    // axis ≥ 400wu, AND total volume ≤ 30M wu³ (rejects room shells).
    //
    // Derived from the CDP dump (2026-05-21):
    //   Material2:    688×63×358  vol≈15.5M ✓
    //   Material3_2:  673×11×337  vol≈2.5M  ✓
    //   Material3_3:  685×14×338  vol≈3.2M  ✓
    //   Material3_5:  688×63×347  vol≈15.0M ✓
    //   Material3_8:  672×2×354   vol≈0.5M  ✓
    //   Material3_4 (room shell): 954×400×1999 vol≈762M ✗
    //   Material3_1 (floor):      897×99×1377 vol≈122M  ✗
    interface ClusterMesh { name: string; pos: [number, number, number]; size: [number, number, number]; }
    const clusterMeshes: ClusterMesh[] = [];
    const allMeshDebug: Array<{ name: string; pos: string; size: string; verdict: string }> = [];

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
      const w = _bbSize.x;
      const h = _bbSize.y;
      const d = _bbSize.z;
      const yMid = _bbCenter.y;
      const name = mesh.name || '(unnamed)';
      const volume = w * h * d;

      // Bank-row filter
      const okHeight = h >= 1   && h <= 200;          // flat-ish (cabinet tops / bases)
      const okWidth  = w >= 400 && w <= 1000;          // bank-width
      const okDepth  = d >= 250 && d <= 500;           // bank-depth (one row deep)
      const okY      = yMid >= 30 && yMid <= 200;     // floor-level
      const okVolume = volume <= 30_000_000;          // not a room shell
      const ok = okHeight && okWidth && okDepth && okY && okVolume;

      const verdict = ok
        ? '✓BANK-MESH'
        : `skipped (${[
            !okHeight && `h=${h.toFixed(0)}`,
            !okWidth  && `w=${w.toFixed(0)}`,
            !okDepth  && `d=${d.toFixed(0)}`,
            !okY      && `y=${yMid.toFixed(0)}`,
            !okVolume && `vol=${(volume/1e6).toFixed(0)}M`,
          ].filter(Boolean).join(',') || 'unknown'})`;

      allMeshDebug.push({
        name,
        pos: `(${_bbCenter.x.toFixed(0)},${_bbCenter.y.toFixed(0)},${_bbCenter.z.toFixed(0)})`,
        size: `${w.toFixed(0)}×${h.toFixed(0)}×${d.toFixed(0)}`,
        verdict,
      });
      if (!ok) return;
      clusterMeshes.push({
        name,
        pos:  [_bbCenter.x, _bbCenter.y, _bbCenter.z],
        size: [w, h, d],
      });
    });

    // Union the cluster meshes into one bank bbox.
    let bankBox: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null = null;
    for (const m of clusterMeshes) {
      const halfW = m.size[0] / 2, halfH = m.size[1] / 2, halfD = m.size[2] / 2;
      const mx0 = m.pos[0] - halfW, mx1 = m.pos[0] + halfW;
      const my0 = m.pos[1] - halfH, my1 = m.pos[1] + halfH;
      const mz0 = m.pos[2] - halfD, mz1 = m.pos[2] + halfD;
      if (!bankBox) {
        bankBox = { minX: mx0, maxX: mx1, minY: my0, maxY: my1, minZ: mz0, maxZ: mz1 };
      } else {
        bankBox.minX = Math.min(bankBox.minX, mx0); bankBox.maxX = Math.max(bankBox.maxX, mx1);
        bankBox.minY = Math.min(bankBox.minY, my0); bankBox.maxY = Math.max(bankBox.maxY, my1);
        bankBox.minZ = Math.min(bankBox.minZ, mz0); bankBox.maxZ = Math.max(bankBox.maxZ, mz1);
      }
    }

    // Split the bank box in half along X. Left half (lower X) = classic;
    // right half = bonus. The vertical extent is padded to ~200wu so the
    // click-zones cover the full visual cabinet height (the merged-by-
    // material meshes only contain low trim; cabinet bodies must be
    // attached to OTHER meshes the heuristic doesn't pick up, but our
    // click-zone bbox is what matters for raycast targeting).
    const discoveredHotspots: HotspotDef[] = [];
    let classicCentroid: [number, number, number] = [0, 0, 0];
    let bonusCentroid:   [number, number, number] = [0, 0, 0];
    let splitValue = 0;
    if (bankBox) {
      const cx = (bankBox.minX + bankBox.maxX) / 2;
      const cz = (bankBox.minZ + bankBox.maxZ) / 2;
      splitValue = cx;
      const halfW = (bankBox.maxX - bankBox.minX) / 2;
      const depth = bankBox.maxZ - bankBox.minZ;
      const clickHeight = 220;                        // visual cabinet height
      const clickCenterY = 110;                       // above floor, below ceiling
      // Slight reach into the room (+ on Z towards the player) so the
      // click-zone catches the player walking up to the bank face.
      const reach = 30;
      const halfHalfW = halfW / 2;

      classicCentroid = [cx - halfHalfW, clickCenterY, cz];
      bonusCentroid   = [cx + halfHalfW, clickCenterY, cz];

      // Hotspot X-size is `halfW` (a HALF of the bank), NOT `halfW + reach`.
      // Previously each hotspot covered the FULL bank width — they overlapped
      // in the middle and the array-first (classic) hotspot always won the
      // raycast hit, so the BONUS side opened the classic modal. The `reach`
      // value is applied to Z (depth into the room toward the player) only.
      // Tiny 0.92 squeeze leaves a hairline dead-zone at the split so a click
      // exactly on the seam doesn't double-hit (Phase 6.1.16).
      const halfHotspotW = halfW * 0.92;
      discoveredHotspots.push({
        position: classicCentroid,
        size:     [halfHotspotW, clickHeight, depth + reach],
        machineSlug: 'classic-3x5' as MachineSlug,
        paytableId:  'classic-3x5' as MachineSlug,
        isBonus:     false,
      });
      discoveredHotspots.push({
        position: bonusCentroid,
        size:     [halfHotspotW, clickHeight, depth + reach],
        machineSlug: 'classic-3x5-bonus' as MachineSlug,
        paytableId:  'classic-3x5-bonus' as MachineSlug,
        isBonus:     true,
      });
    }

    // Always-on diagnostic
    if (bankBox) {
      console.info(
        `[cove-interior] bank bbox: X=[${bankBox.minX.toFixed(0)}..${bankBox.maxX.toFixed(0)}] ` +
        `Y=[${bankBox.minY.toFixed(0)}..${bankBox.maxY.toFixed(0)}] ` +
        `Z=[${bankBox.minZ.toFixed(0)}..${bankBox.maxZ.toFixed(0)}] ` +
        `· splitX=${splitValue.toFixed(0)} · ${clusterMeshes.length} cluster meshes`,
      );
    } else {
      console.warn(`[cove-interior] no bank cluster found — falling back to GAMEREADY_HOTSPOTS`);
    }
    console.groupCollapsed('[cove-interior] mesh inventory (click to expand)');
    for (const d of allMeshDebug) {
      console.info(`  ${d.name.padEnd(30)} pos=${d.pos.padEnd(20)} size=${d.size.padEnd(20)} ${d.verdict}`);
    }
    console.groupEnd();

    // If discovery worked, use the two split hotspots; otherwise fall back.
    const hotspotDefs = useFallback
      ? FALLBACK_HOTSPOTS
      : (discoveredHotspots.length === 2 ? discoveredHotspots : GAMEREADY_HOTSPOTS);

    let count = 0;
    c.traverse((obj) => { if ((obj as THREE.Mesh).isMesh) count++; });

    return {
      cloned:   c,
      hotspots: hotspotDefs,
      meshCount: count,
      classicCentroid,
      bonusCentroid,
      hasDiscovery: discoveredHotspots.length >= 2,
    };
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

      {/* Bank labels — one big banner above each of the two slot banks.
          Banner Y is PINNED to 280wu (just above cabinet tops, well below
          the ceiling) instead of computed-from-centroid + offset, so a
          weird centroid (caused by Material3 meshes outside the cabinet
          Y range — floor decals, ceiling trim) can't push the banner
          out of view. */}
      {hasDiscovery && (
        <>
          <BankBanner
            label="CLASSIC"
            color="#00d4ff"
            position={[classicCentroid[0], 280, classicCentroid[2]]}
          />
          <BankBanner
            label="BONUS"
            color="#ffd54f"
            position={[bonusCentroid[0], 280, bonusCentroid[2]]}
          />
        </>
      )}
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
  // Phase-0 debug probe gate (Slice 1, 2026-07-10) — NEXT_PUBLIC_COVE_DEBUG='1'
  // (matches the existing [cove-fit] flag) or ?probe=1 for a one-off check
  // without an env var. See TableProbeMarkers above.
  const [showTableProbe] = useState(() => {
    if (typeof window === 'undefined') return false;
    return process.env.NEXT_PUBLIC_COVE_DEBUG === '1' || new URLSearchParams(window.location.search).get('probe') === '1';
  });

  return (
    <>
      <CoveLighting />

      {/* Fog scaled with room via _ROOM_SCALE (room-scale-knob refactor 2026-07-11
          — was hardcoded 4000/10000 literals that LOOKED _ROOM_SCALE-derived per
          the old comment but didn't actually reference it, so fog silently
          stopped tracking the knob the same way _ROOM_SCALE itself did until
          fixed above). Note (pre-existing, unrelated to this refactor, flagged
          not fixed): fog.far still exceeds COVE_CAMERA_FAR at every knob value,
          so fog never visually tapers before the hard clip — an existing
          atmosphere-tuning gap, out of scope here. */}
      <fog attach="fog" args={[0x0a0015, 1200 * _ROOM_SCALE, 3000 * _ROOM_SCALE]} />

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

      {/* Phase 6.4.0 — blackjack table click hotspot.
          Positioned at the dealer station (right wall, X≈307, Z=0).
          Invisible mesh — cursor: pointer on hover. Opens BlackjackModal. */}
      <BlackjackTableHotspot />

      {/* Blackjack table label — rendered above the dealer station */}
      <BankBanner
        label="BLACKJACK"
        color="#ef4444"
        position={[_BJ_HOTSPOT_POS[0], 280, _BJ_HOTSPOT_POS[2]]}
      />

      {/* Phase 6.5.0 — Texas Hold'em table click hotspot at the second
          poker table (mirror across X of the blackjack station). Same
          invisible hit-box pattern; opens HoldemModal. */}
      <HoldemTableHotspot />

      {/* Hold'em table label — rendered above the second poker table. */}
      <BankBanner
        label="TEXAS HOLD'EM"
        color="#ffffff"
        position={[_HOLDEM_HOTSPOT_POS[0], 280, _HOLDEM_HOTSPOT_POS[2]]}
      />

      {/* Phase 6.6.1 — Baccarat (Punto Banco) table click hotspot at the
          open-floor position (X=285, Z=584). Invisible hit-box (same pattern
          as the blackjack/holdem hotspots); opens BaccaratModal. */}
      <BaccaratTableHotspot />

      {/* Baccarat table label — rendered above the baccarat station. */}
      <BankBanner
        label="BACCARAT"
        color="#3b82f6"
        position={[_BACCARAT_HOTSPOT_POS[0], 280, _BACCARAT_HOTSPOT_POS[2]]}
      />

      {/* Slice 1 (3D Hold'em experiment, 2026-07-10) — sit-at-table T1.
          Render-layer only: no modal, no ClawToken settlement. Does NOT
          touch the 2D BlackjackTableHotspot/HoldemTableHotspot/
          BaccaratTableHotspot above — those keep working unmodified. */}
      <Table3D
        centerX={T1_CENTER_X}
        centerZ={T1_CENTER_Z}
        seats={T1_SEATS}
        playerSeatIndex={T1_PLAYER_SEAT_INDEX}
        seatModelKeys={T1_SEAT_BUST_MODEL_KEYS}
        bustTargetHeight={COVE_VRM_TARGET_HEIGHT}
      />
      <TableCards3D
        centerX={T1_CENTER_X}
        centerZ={T1_CENTER_Z}
        feltTopY={TABLE_TOP_Y}
        seats={T1_SEATS}
        playerSeatIndex={T1_PLAYER_SEAT_INDEX}
        layout={T1_FELT_CARD_LAYOUT}
      />
      <TableSeatCamera />
      <TableSitLabel />

      {/* Phase-0 runtime probe — only mounted with NEXT_PUBLIC_COVE_DEBUG=1
          or ?probe=1. Zero cost otherwise (component not created at all). */}
      {showTableProbe && <TableProbeMarkers />}
    </>
  );
}
