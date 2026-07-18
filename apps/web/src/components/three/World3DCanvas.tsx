'use client';

import { useRef, useState, useEffect, useCallback, memo, Suspense, type RefObject } from 'react';
import { Canvas, useFrame, extend, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { ThreeToJSXElements } from '@react-three/fiber';

// Register Three.js WebGPU elements with R3F 9
declare module '@react-three/fiber' {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}
extend(THREE as any);
import ArenaTerrain from '@/lib/three/arena-terrain';
import { registerInputReset } from '@/lib/three/input-reset';
import { dampTowardConfirmedTarget } from '@/lib/three/npc-interpolation-damping';
import ArenaBuildings from '@/lib/three/arena-buildings';
import MeshletBuildingsR3F from '@/lib/three/meshlet/meshlet-buildings-r3f';
import ArenaNpcs from '@/lib/three/arena-npcs';
import RemotePlayers from '@/lib/three/remote-players';
import ArenaLocationNpcs from '@/lib/three/arena-location-npcs';
import { VRM_METRICS_ENABLED, registerBulkVRMIdleCallback } from '@/lib/three/vrm-loader';
import PlayerAvatar from '@/lib/three/player-avatar';
import NpcController from '@/lib/three/npc-controller';
import MergedSeaweed from '@/lib/three/merged-seaweed';
import { KelpForestAmbient } from '@/lib/three/kelp-forest';
import { KelpForestPortal } from '@/lib/three/kelp-forest-portal';
import QuestNpc from '@/lib/three/quest-npc';
import TownGuide from '@/lib/three/town-guide';
import BazaarStall from '@/lib/three/bazaar-stall';
import MarketplaceStall from '@/lib/three/marketplace-stall';
import QuestBountyPavilion from '@/lib/three/quest-bounty-pavilion';
import TownDirectorySign from '@/lib/three/town-directory-sign';
import CoveBeacon from '@/lib/three/cove-beacon';
import CoveEntrance from '@/lib/three/cove-entrance';
import ActivityIndicators from '@/lib/three/activity-indicators';
import FloatingTexts3D from '@/lib/three/floating-text-3d';
import NpcSpeechBubbles from '@/lib/three/npc-speech-bubbles';
import ClickToMove from '@/lib/three/click-to-move';
import LandParcels, { LandParcelSignHitboxes } from '@/lib/three/land-parcels';
import LandStructures from '@/lib/three/land-structures';
import LandShowroom from '@/lib/three/land-showroom';
import LandRingDecorations from '@/lib/three/land-ring-decorations';
import LandFounderApartments from '@/lib/three/land-founder-apartments';
import LandStateHydrator from '@/lib/three/land-state-hydrator';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';
import { MeshoptLoaderSetup } from '@/lib/three/meshopt-loader-setup';
import { WorldLabelsOverlayMount } from '@/lib/three/world-labels-overlay';
import JumpTicker from '@/lib/three/jump-ticker';
import { jumpState } from '@/lib/three/jump-state';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { DEFAULT_WORLD_PERF_FLAGS, type WorldPerfFlags } from '@/lib/three/PerfAudit';
import { detectLowEndGpuClass } from '@/lib/three/gpu-tier';

// ---------------------------------------------------------------------------
// SeaLoadingScreen progress bridge — wire THREE.DefaultLoadingManager.onProgress
// to window.__W3D_PROGRESS once at module load. The pre-mount loader screen
// prefers this real ratio (assets loaded / assets total) over its simulated
// curve so the bar tracks actual download progress instead of stalling at the
// fast-tail of an exponential ease. drei's useGLTF, useVRM, KTX2Loader and
// MeshoptLoader all route through DefaultLoadingManager, so this captures
// every GLB / VRM / texture the world streams in.
// ---------------------------------------------------------------------------
const defaultLoadingManagerIdleListeners = new Set<() => void>();

// The LoadingManager bridge is installed before any Canvas/gate exists, so it
// reports through one stable module-level function. The active gate owns the
// timestamp; this indirection adds no allocation to each loader progress tick.
let activeWorldWarmupProgressNotifier: (() => void) | undefined;
function noteWorldWarmupProgress(): void {
  activeWorldWarmupProgressNotifier?.();
}

if (typeof window !== 'undefined') {
  const _mgr = THREE.DefaultLoadingManager;
  const _prevOnProgress = _mgr.onProgress?.bind(_mgr);
  const _prevOnLoad = _mgr.onLoad?.bind(_mgr);
  _mgr.onProgress = (url: string, loaded: number, total: number) => {
    (window as unknown as { __W3D_PROGRESS?: number }).__W3D_PROGRESS =
      total > 0 ? Math.max(0, Math.min(1, loaded / total)) : 0;
    noteWorldWarmupProgress();
    if (_prevOnProgress) _prevOnProgress(url, loaded, total);
  };
  _mgr.onLoad = () => {
    try {
      if (_prevOnLoad) _prevOnLoad();
    } finally {
      for (const listener of defaultLoadingManagerIdleListeners) listener();
    }
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const CAM_PAN_SPEED = 500;

// Synchronous one-shot probe of the unmasked WebGL renderer string. Runs at
// module load before the Canvas mounts, so we can pick a DPR cap appropriate
// to the GPU class. False positives (lower DPR on a capable GPU) are mostly
// harmless — slightly softer rendering; false negatives (full DPR on Iris Xe)
// are the laggy baseline we want to avoid.
const LOW_END_GPU_DETECTED = detectLowEndGpuClass();
if (typeof window !== 'undefined') {
  console.log('[World3D] Low-end GPU detected:', LOW_END_GPU_DETECTED);
}
// Export so arena-npcs and other consumers can gate low-end-only code paths
// without duplicating the GPU probe.
export { LOW_END_GPU_DETECTED };
const SKY_COLOR = new THREE.Color(0x0a2a4a); // Deeper ocean blue

// Phase B meshlet integration — gated by URL query ?meshlets=1.
// When ON: <ArenaBuildings> is replaced by <MeshletBuildingsR3F>, which
// runs the Nanite-style WebGPU compute rasterizer as a high-priority
// useFrame hook INSIDE R3F's tree. Both the rasterizer and R3F's scene
// render write to the same WebGPU swap-chain texture each frame (rasterizer
// first, R3F's scene second). One canvas, one renderer — see file header
// of meshlet-buildings-r3f.tsx for the architectural reasoning.
// History: spike measured 167 FPS at full LOD 0 vs /game baseline ~18 FPS = ~9× lift.
// Layered-canvas v1 attempt broke /game (R3F rendered nothing visible) — pivoted
// to in-tree v1.1 architecture.
const USE_MESHLET_BUILDINGS: boolean =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('meshlets') === '1';
// 2026-07-14 — reversed-Z reduces far-plane z-fighting across the world's
// camera.near=1 / camera.far=11500 range. Three introduced the option in r183,
// moved reversed WebGPU depth attachments to depth32float in r184 (#33184),
// and fixed reversed-depth sorting in r185 (#33700). Configure it before init()
// for both WebGPU and forceWebGL; r185's WebGL2 backend warns and falls back to
// standard depth when EXT_clip_control is unavailable. The experimental meshlet
// rasterizer stays standard-Z because its visibility buffer packs (1 - NDC z),
// selects with atomicMax, then writes that conventional value via depthNode.
const USE_REVERSED_DEPTH_BUFFER = !USE_MESHLET_BUILDINGS;
const FOG_COLOR = new THREE.Color(0x0e3458); // Underwater haze — matches sky
const LOW_END_DPR_RANGE: [number, number] = [0.55, 0.7];
const STANDARD_DPR_RANGE: [number, number] = [0.75, 1];
const QUALITY_SAMPLE_MS = 2500;
const QUALITY_WARMUP_MS = 5000;
const QUALITY_FPS_DOWN = 58;
// Recovery threshold: 59 FPS is reachable on a 60 Hz display (vsync permits it).
// The old 90 threshold was unreachable at vsync, creating a one-way ratchet.
const QUALITY_FPS_UP = 59;
// Only one degradation tier: hide groundCover (seaweed / decorations).
// activityFx and labels are gameplay-functional and must never be auto-degraded.
const QUALITY_MAX_TIER = 1;

export type WorldMode = 'game' | 'arena';

interface World3DCanvasProps {
  mode: WorldMode;
  perfFlags?: Partial<WorldPerfFlags>;
}

// The governor may ONLY auto-hide groundCover (seaweed + decorations).
// activityFx and labels are gameplay-functional signals — never auto-degraded.
// Tier 0 = full quality; tier 1 = groundCover hidden.
function applyQualityTier(flags: WorldPerfFlags, tier: number): WorldPerfFlags {
  if (tier <= 0) return flags;
  return {
    ...flags,
    groundCover: false,
  };
}

function useAdaptiveWorldPerfFlags(perfFlags?: Partial<WorldPerfFlags>): WorldPerfFlags {
  const base = { ...DEFAULT_WORLD_PERF_FLAGS, ...perfFlags };

  // ?fast=1 is an explicit opt-in DEBUG flag — allowed to hide groundCover, activityFx,
  // and labels because the user consciously opted in. It is NOT a default auto-degradation
  // path. It also pins the governor off so no further automatic changes occur this session.
  const fastMode =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fast') === '1';

  const tieredFlagsEnabled = perfFlags === undefined;
  // Adaptive governor is active only when no explicit perfFlags override is passed in
  // AND the user has not opted into ?fast=1 debug mode.
  const adaptiveEnabled = tieredFlagsEnabled && !fastMode;

  const initialTier = fastMode
    ? QUALITY_MAX_TIER
    : LOW_END_GPU_DETECTED
      ? 1
      : 0;
  const [qualityTier, setQualityTier] = useState(initialTier);

  useEffect(() => {
    if (!adaptiveEnabled || typeof window === 'undefined') return;

    let raf = 0;
    let frames = 0;
    let sampleStart = performance.now();
    const startedAt = sampleStart;
    let stableHighSamples = 0;
    let tierRef = initialTier;
    // Anti-flap latch: if the governor degrades a second time in one session,
    // hold tier 1 for the rest of the session (degradeCount tracks triggers).
    let degradeCount = 0;
    let latched = false;

    const tick = (now: number) => {
      frames++;
      const elapsed = now - sampleStart;
      if (elapsed >= QUALITY_SAMPLE_MS) {
        const fps = (frames * 1000) / elapsed;
        const warmed = now - startedAt >= QUALITY_WARMUP_MS;

        if (!latched && warmed && fps < QUALITY_FPS_DOWN && tierRef < QUALITY_MAX_TIER) {
          tierRef = QUALITY_MAX_TIER;
          stableHighSamples = 0;
          degradeCount += 1;
          // Second degrade in the same session: lock tier for the rest of the session.
          if (degradeCount >= 2) latched = true;
          setQualityTier(tierRef);
        } else if (!latched && warmed && fps >= QUALITY_FPS_UP && tierRef > 0) {
          stableHighSamples += 1;
          // Require 3 consecutive stable-high samples (~7.5s sustained) before recovering.
          if (stableHighSamples >= 3) {
            tierRef -= 1;
            stableHighSamples = 0;
            setQualityTier(tierRef);
          }
        } else if (fps < QUALITY_FPS_UP) {
          stableHighSamples = 0;
        }
        frames = 0;
        sampleStart = now;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [adaptiveEnabled, initialTier]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__W3D_QUALITY_TIER = qualityTier;
    }
  }, [qualityTier]);

  if (fastMode) {
    // ?fast=1 explicitly disables groundCover, activityFx, labels — governor is frozen.
    return { ...base, groundCover: false, activityFx: false, labels: false };
  }

  return tieredFlagsEnabled ? applyQualityTier(base, qualityTier) : base;
}

// AdaptiveRendererDpr was DELETED 2026-06-10. It pinned DPR via a direct
// gl.setPixelRatio() call ~0.5s after first paint to counteract the (now
// removed) tier-4 DPR clamp. On the real WebGPU backend, setPixelRatio
// unconditionally calls setSize → WebGPUBackend.updateSize(), reconfiguring
// the swapchain OUTSIDE R3F's resize path — blanking the canvas until a
// manual window resize re-syncs it (the "blue until resize" bug; the
// first-paint nudge had already fired by then and could not help).
// Nothing lowers DPR at runtime anymore (governor is groundCover-only), so
// the guard had no remaining purpose. NEVER call gl.setPixelRatio or
// gl.setSize directly on the WebGPU backend after first paint — go through
// R3F's state.setSize/setDpr, or don't resize at all. (Sole exemption:
// forceFirstPaintSizeSync below, which syncs state.setSize FIRST and then
// refreshes the swapchain — that ordering is what makes it safe.)

// ---------------------------------------------------------------------------
// WASD Camera Controller (arena/spectator mode only)
// ---------------------------------------------------------------------------
interface KeyState {
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
  arrowup: boolean;
  arrowdown: boolean;
  arrowleft: boolean;
  arrowright: boolean;
}

// Shared key state for arrow-key camera rotation — read by ArrowKeyRotationController
// and written by whichever key listener is active.
const _arrowKeys: Pick<KeyState, 'arrowup' | 'arrowdown' | 'arrowleft' | 'arrowright'> = {
  arrowup: false,
  arrowdown: false,
  arrowleft: false,
  arrowright: false,
};

// S7 — release held arrow keys on window focus loss/regain so the camera doesn't
// keep orbiting after a window steals focus mid-hold (browser skips keyup).
function resetArrowKeys() {
  _arrowKeys.arrowup = false;
  _arrowKeys.arrowdown = false;
  _arrowKeys.arrowleft = false;
  _arrowKeys.arrowright = false;
}

const ARROW_ROT_SPEED = 1.5; // radians/second
const PHI_MIN = 0.1;                 // nearly straight down (bird's eye)
const PHI_MAX = Math.PI * 0.85;      // look steeply up toward surface (~153°)
const CAM_Y_MIN = -5;                // allow camera slightly below ground for upward views

// Spherical scratch objects — allocated once, reused every frame
const _offset = new THREE.Vector3();
const _spherical = new THREE.Spherical();

// Scratch objects for FPSFollowCamera — allocated once, reused every frame
const _followTarget = new THREE.Vector3();

// Scratch objects for WASDCameraController — allocated once, reused every frame
const _wasdForward = new THREE.Vector3();
const _wasdRight = new THREE.Vector3();
const _wasdFlatForward = new THREE.Vector3();
const _wasdWorldUp = new THREE.Vector3(0, 1, 0);

// Follow distance: how many units the camera sits behind/above the character.
// OrbitControls manages the actual angle — we just enforce the radial distance.
const FPS_FOLLOW_DISTANCE = 240;
// How high above the 2D game-plane the character target sits (approximate)
const CHAR_TARGET_Y = 15;
// Frame-rate independent follow stiffness. The previous fixed 0.1/frame lerp
// became visibly mushy when the scene dipped below 60 FPS.
const FPS_FOLLOW_STIFFNESS = 14;
// ---------------------------------------------------------------------------
// Arrow key camera rotation — active in ALL modes
// Reads _arrowKeys, adjusts orbit camera angles via spherical coordinates.
// Must be rendered inside SceneContents so it always runs.
// ---------------------------------------------------------------------------
function ArrowKeyRotationController({
  controlsRef,
}: {
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp':    _arrowKeys.arrowup    = true; e.preventDefault(); break;
        case 'ArrowDown':  _arrowKeys.arrowdown  = true; e.preventDefault(); break;
        case 'ArrowLeft':  _arrowKeys.arrowleft  = true; e.preventDefault(); break;
        case 'ArrowRight': _arrowKeys.arrowright = true; e.preventDefault(); break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp':    _arrowKeys.arrowup    = false; break;
        case 'ArrowDown':  _arrowKeys.arrowdown  = false; break;
        case 'ArrowLeft':  _arrowKeys.arrowleft  = false; break;
        case 'ArrowRight': _arrowKeys.arrowright = false; break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    const unregisterReset = registerInputReset(resetArrowKeys);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      unregisterReset();
    };
  }, []);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    // Keyboard arrow keys
    let dTheta =
      (_arrowKeys.arrowleft ? 1 : 0) - (_arrowKeys.arrowright ? 1 : 0);
    // Spherical phi: 0 = top (+Y), PI = bottom (-Y).
    // ArrowUp = "look up" = camera moves higher = phi DECREASES → -1
    // ArrowDown = "look down" = camera moves lower = phi INCREASES → +1
    let dPhi =
      (_arrowKeys.arrowdown ? 1 : 0) - (_arrowKeys.arrowup ? 1 : 0);

    // Right joystick (mobile camera stick) — analog, adds to keyboard delta
    // Stick-up → vy = -1 (from nipplejs inversion) → phi decreases → look up ✓
    const { cameraJoystickVelocity } = useGameStore.getState();
    if (cameraJoystickVelocity.x !== 0 || cameraJoystickVelocity.y !== 0) {
      dTheta += -cameraJoystickVelocity.x; // stick right = orbit right = theta decreases
      dPhi   +=  cameraJoystickVelocity.y;  // stick up (vy=-1) = look up = phi decreases
    }

    if (dTheta === 0 && dPhi === 0) return;

    const camera = controls.object;
    _offset.subVectors(camera.position, controls.target);
    _spherical.setFromVector3(_offset);

    _spherical.theta += dTheta * ARROW_ROT_SPEED * delta;
    _spherical.phi   += dPhi   * ARROW_ROT_SPEED * delta;
    _spherical.phi    = Math.max(PHI_MIN, Math.min(PHI_MAX, _spherical.phi));

    _offset.setFromSpherical(_spherical);
    camera.position.copy(controls.target).add(_offset);

    // Clamp camera Y so it never goes underground
    if (camera.position.y < CAM_Y_MIN) {
      camera.position.y = CAM_Y_MIN;
    }

    controls.update();
  });

  return null;
}

function WASDCameraController({
  controlsRef,
}: {
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  const keysRef = useRef<Pick<KeyState, 'w' | 'a' | 's' | 'd'>>({
    w: false,
    a: false,
    s: false,
    d: false,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase() as keyof typeof keysRef.current;
      if (key in keysRef.current) keysRef.current[key] = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase() as keyof typeof keysRef.current;
      if (key in keysRef.current) keysRef.current[key] = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    // S7 — clear held WASD pan keys on focus loss/regain so the explore-mode
    // camera doesn't keep panning after a window steals focus mid-hold.
    const unregisterReset = registerInputReset(() => {
      const k = keysRef.current;
      k.w = false; k.a = false; k.s = false; k.d = false;
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      unregisterReset();
    };
  }, []);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    // One-shot camera focus (e.g. Hatcher launch → spectate the launched
    // agent's body). Drained here because WASDCameraController owns the
    // explore-mode camera; snapping target + camera together preserves the
    // OrbitControls orbit geometry the same way a programmatic target move
    // must (see FPSFollowCamera). After this the user keeps free WASD/orbit
    // control — the request is consumed so it fires exactly once. Game coords
    // (0..MAP_WIDTH) → world XZ via the same HALF_W/HALF_H projection the
    // follow camera uses. No per-frame allocation: consumeCameraFocus()
    // returns null on every normal frame and short-circuits.
    const focus = useGameStore.getState().consumeCameraFocus();
    if (focus) {
      const fx = Math.max(0, Math.min(MAP_WIDTH, focus.x)) - HALF_W;
      const fz = Math.max(0, Math.min(MAP_HEIGHT, focus.y)) - HALF_H;
      controls.target.set(fx, CHAR_TARGET_Y, fz);
      // Overhead-behind vantage so the agent body sits centred in frame.
      controls.object.position.set(fx, 420, fz + 720);
      controls.update();
      return;
    }

    const keys = keysRef.current;
    let dx = 0;
    let dz = 0;

    // Only WASD drives panning — arrow keys are handled by ArrowKeyRotationController
    if (keys.w) dz += 1;
    if (keys.s) dz -= 1;
    if (keys.a) dx -= 1;
    if (keys.d) dx += 1;

    // Mobile joystick — parallel input for explore-mode camera pan.
    // joystickVelocity.y is negative when pushing up (nipplejs convention, see
    // npc-controller.tsx:146 which uses the same sign flip), so negate it to
    // match the WASD convention where +dz = forward.
    const { joystickVelocity } = useGameStore.getState();
    if (joystickVelocity.x !== 0 || joystickVelocity.y !== 0) {
      dx += joystickVelocity.x;
      dz += -joystickVelocity.y;
    }

    if (dx === 0 && dz === 0) return;

    // Clamp magnitude to ≤1 so WASD stays full-speed and analog joystick
    // preserves partial-press proportionality (a 0.4 push pans at 40% speed).
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len > 1) { dx /= len; dz /= len; }
    dx *= CAM_PAN_SPEED * delta;
    dz *= CAM_PAN_SPEED * delta;

    const camera = controls.object;
    // Full 3D forward direction (includes Y for swimming up/down) — reuse scratch vectors
    camera.getWorldDirection(_wasdForward);
    _wasdForward.normalize();

    // Right vector is always horizontal (cross forward with world up)
    _wasdFlatForward.set(_wasdForward.x, 0, _wasdForward.z).normalize();
    _wasdRight.crossVectors(_wasdFlatForward, _wasdWorldUp).normalize();

    // Move in full 3D: W/S along camera direction (incl. Y), A/D strafe horizontal
    const moveX = _wasdRight.x * dx + _wasdForward.x * dz;
    const moveY = _wasdForward.y * dz; // swim up/down when looking up/down
    const moveZ = _wasdRight.z * dx + _wasdForward.z * dz;

    const target = controls.target;
    target.x = Math.max(-HALF_W, Math.min(HALF_W, target.x + moveX));
    target.y = Math.max(CAM_Y_MIN, target.y + moveY); // clamp above ground
    target.z = Math.max(-HALF_H, Math.min(HALF_H, target.z + moveZ));

    camera.position.x = Math.max(-HALF_W - 200, Math.min(HALF_W + 200, camera.position.x + moveX));
    camera.position.y = Math.max(CAM_Y_MIN, camera.position.y + moveY);
    camera.position.z = Math.max(-HALF_H - 200, Math.min(HALF_H + 200, camera.position.z + moveZ));

    controls.update();
  });

  return null;
}

// ---------------------------------------------------------------------------
// FPS-style follow camera — smooth 3rd-person follow for player/npc/autonomous modes.
// Lerps the OrbitControls TARGET toward the character world position, then
// rescales the camera-to-target offset to keep a fixed follow distance.
// Arrow key orbit (ArrowKeyRotationController) adjusts the angle around the target.
// ---------------------------------------------------------------------------
function FPSFollowCamera({
  controlsRef,
}: {
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  // Persisted scalar scratch: allocated once, mutated in useFrame. This mirrors
  // the streamed body's rendered XZ because the mesh position is not published.
  const autonomousBodyFollowRef = useRef({
    bodyId: null as string | null,
    initialized: false,
    x: 0,
    y: 0,
  });

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    const { controlMode, possessedNpcId, autonomousBodyId } = useGameStore.getState();

    // One-shot camera focus SNAP (town-fast-travel warp re-anchor, 2026-06-19).
    // The WarpOverlay teleports avatarPositionRef at its flash midpoint and then
    // calls requestCameraFocus(target) to drop a focus request. We drain it here
    // (FPSFollowCamera owns the camera in player/autonomous/npc modes — the only
    // modes a warp can fire from, since warpTo() is gated to 'player') and snap
    // the orbit target + camera to the destination in ONE frame. Without this,
    // the exponential follow-lerp below would slow-pan across the map after the
    // flash clears — a long warp would visibly "fly" the camera. Snapping target
    // and camera by the SAME delta preserves the orbit geometry (angle/zoom/phi),
    // exactly like WASDCameraController's focus drain and the jump translate below.
    // Game coords (0..MAP_WIDTH) → world XZ via the same HALF_W/HALF_H projection.
    // consumeCameraFocus() returns null on every normal frame (zero-alloc).
    const focus = useGameStore.getState().consumeCameraFocus();
    if (focus) {
      const fx = Math.max(0, Math.min(MAP_WIDTH, focus.x)) - HALF_W;
      const fz = Math.max(0, Math.min(MAP_HEIGHT, focus.y)) - HALF_H;
      const tgtSnap = controls.target;
      const dxSnap = fx - tgtSnap.x;
      const dySnap = CHAR_TARGET_Y - tgtSnap.y;
      const dzSnap = fz - tgtSnap.z;
      tgtSnap.set(fx, CHAR_TARGET_Y, fz);
      controls.object.position.x += dxSnap;
      controls.object.position.y += dySnap;
      controls.object.position.z += dzSnap;
      if (controls.object.position.y < CAM_Y_MIN) {
        controls.object.position.y = CAM_Y_MIN;
      }
      controls.update();
      // Don't also run the lerp this frame — the body ref is already at the
      // destination, so the snap leaves zero follow error. Fall through next
      // frame into the normal smooth follow.
      return;
    }

    // Determine the character's 2D game-space position.
    // Use avatarPositionRef (module-scope, zero React overhead) for the player path —
    // the ref is always up-to-date at 60 Hz even when the reactive store is throttled.
    let gameX: number;
    let gameY: number;

    if (controlMode !== 'autonomous') {
      autonomousBodyFollowRef.current.bodyId = null;
      autonomousBodyFollowRef.current.initialized = false;
    }

    if (controlMode === 'npc' && possessedNpcId) {
      const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
      if (!npc) return;
      gameX = npc.x;
      gameY = npc.y;
    } else if (controlMode === 'autonomous') {
      // §B.1b — Autonomous: PlayerAvatar is unmounted (see the render gate
      // below), so avatarPositionRef is FROZEN at whatever it last held before
      // the mode flip. Follow the server-streamed `ocb-` agent body instead —
      // it lands in the SAME npc.ts entity-interpolation array as any other
      // agent bot (npc-simulation.ts registerAgentBot), so this is the same
      // lookup-by-id pattern as the NPC-possession branch above. Hold position
      // (no-op this frame) until the id is confirmed and/or has streamed in —
      // avoids snapping the camera to the map origin during the brief window
      // between the toggle and the activation response / first SSE tick.
      if (!autonomousBodyId) {
        autonomousBodyFollowRef.current.bodyId = null;
        autonomousBodyFollowRef.current.initialized = false;
        return;
      }
      const body = useNpcStore.getState().npcs.find((n) => n.id === autonomousBodyId);
      if (!body) {
        autonomousBodyFollowRef.current.bodyId = autonomousBodyId;
        autonomousBodyFollowRef.current.initialized = false;
        return;
      }

      // The camera does not read the mesh's rendered position; reconstruct the
      // exact same prev→latest interpolation target, then apply the mesh's k=10
      // damping. Both endpoints are confirmed snapshots, and the convex update
      // never projects ahead of that target (no extrapolation).
      const nowMs = Date.now();
      const tsDelta = body.tsDelta > 0 ? body.tsDelta : 200;
      const elapsed = nowMs - body.ts;
      const interpAlpha = body.ts === 0
        ? 1
        : Math.max(0, Math.min(1, elapsed / tsDelta));
      const interpTargetX = body.prevX + (body.x - body.prevX) * interpAlpha;
      const interpTargetY = body.prevY + (body.y - body.prevY) * interpAlpha;
      const follow = autonomousBodyFollowRef.current;
      if (follow.bodyId !== autonomousBodyId || !follow.initialized || body.ts === 0) {
        follow.bodyId = autonomousBodyId;
        follow.initialized = true;
        follow.x = interpTargetX;
        follow.y = interpTargetY;
      } else {
        follow.x = dampTowardConfirmedTarget(follow.x, interpTargetX, delta);
        follow.y = dampTowardConfirmedTarget(follow.y, interpTargetY, delta);
      }
      gameX = follow.x;
      gameY = follow.y;
    } else {
      // 'player' — follow the locally-driven avatar
      gameX = avatarPositionRef.x;
      gameY = avatarPositionRef.y;
    }

    // Convert to Three.js world coordinates (2D game plane → XZ)
    const worldX = gameX - HALF_W;
    const worldZ = gameY - HALF_H;

    // Lerp the orbit target toward the character (smooth follow).
    // jumpState.heightOffset raises the target during a jump so the avatar stays
    // in frame. resetJump() guarantees heightOffset=0 outside player/npc modes.
    const extraY = jumpState.heightOffset;
    const tgt = controls.target;
    const prevTgtX = tgt.x;
    const prevTgtY = tgt.y;
    const prevTgtZ = tgt.z;
    const followAlpha = 1 - Math.exp(-FPS_FOLLOW_STIFFNESS * Math.min(delta, 0.05));
    tgt.x += (worldX - tgt.x) * followAlpha;
    tgt.y += ((CHAR_TARGET_Y + extraY) - tgt.y) * followAlpha;
    tgt.z += (worldZ - tgt.z) * followAlpha;

    // Translate camera by the same delta as the target so the orbit geometry
    // (angle, zoom distance, phi/theta) is preserved. Without this, a high jump
    // (target.y → 1500+) leaves the camera at its old Y while the target soars
    // above, forcing PHI near its clamp and making arrow-key rotation glitch at
    // near-vertical angles. This mirrors OrbitControls' internal behavior when
    // target moves programmatically.
    controls.object.position.x += (tgt.x - prevTgtX);
    controls.object.position.y += (tgt.y - prevTgtY);
    controls.object.position.z += (tgt.z - prevTgtZ);

    // Clamp camera Y so it never goes below the ground floor
    if (controls.object.position.y < CAM_Y_MIN) {
      controls.object.position.y = CAM_Y_MIN;
    }

    controls.update();
  });

  return null;
}

// ---------------------------------------------------------------------------
// kickRenderLoop — small insurance wrapper around R3F's native render loop
// ---------------------------------------------------------------------------
// R3F v9's native loop is RAF-based and kicks itself off from a zustand
// subscriber (invalidate → requestAnimationFrame(loop)). That works in
// foreground tabs. In hidden tabs RAF is throttled to 0 Hz, which pauses the
// scene — which is the correct behavior for a game (don't waste cycles when
// the user isn't looking).
//
// We expose `state` on window.__W3D for devtools diagnostics and explicitly
// call state.invalidate() once after mount. R3F already calls invalidate
// internally via its store subscriber, but belt-and-suspenders — if anything
// races in future upgrades, the explicit kick keeps the scene alive.
// ---------------------------------------------------------------------------
function markWorldReadyIfUploadsDone(): void {
  if (typeof window === 'undefined') return;
  const bridge = window as any;
  if (bridge.__W3D_CANVAS_READY && bridge.__W3D_TEXTURES_READY) {
    bridge.__W3D_READY = true;
  }
}

function measureCanvasHost(canvas: HTMLCanvasElement | undefined): { width: number; height: number; top: number; left: number } | null {
  const host = canvas?.parentElement;
  const rect = host?.getBoundingClientRect() ?? canvas?.getBoundingClientRect();
  if (!rect) return null;

  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width <= 0 || height <= 0) return null;

  return {
    width,
    height,
    top: rect.top,
    left: rect.left,
  };
}

/**
 * First-paint size/camera sync — BOTH backends (2026-06-10 rewrite).
 *
 * Two distinct boot races leave `/game` showing only the clear color ("blue
 * until resize"); this heals both:
 *
 * 1. WebGPU backend: the swapchain is configured once in init() and never
 *    re-configured, so a transient/wrong canvas size at init presents only
 *    the clear color until a real dimension change (original fix, kept).
 * 2. WebGL2 backend (ALWAYS the path on Iris Xe — FORCE_WEBGL includes
 *    LOW_END_GPU_DETECTED): under slow loads, R3F's size→camera layout
 *    effect can fail to run, leaving `camera.aspect = 0` → a NaN projection
 *    matrix → every frustum test fails → ~2 draw calls of background while
 *    the render loop runs "healthily". Reproduced deterministically with 6×
 *    CPU throttle (2026-06-10); confirmed healed by exactly the imperative
 *    sync below via live CDP on the broken state. The old gate
 *    (`!backend?.isWebGPUBackend → return`) meant this path had NO
 *    protection — which is why staging blue-screened on Iris Xe while the
 *    nudge existed all along.
 *
 * Retry policy: cheap property compares every ~500ms until the state is
 * healthy twice in a row AND the world is ready, capped at 30s. On a normal
 * boot the checks are already healthy, so the loop exits after the second
 * 500ms check (or whenever __W3D_READY flips). Bails immediately if the
 * canvas leaves the DOM (SPA route change) so it never retains the renderer.
 */
function forceFirstPaintSizeSync(state: any): void {
  const gl = state?.gl;
  const backend = gl?.backend;
  const canvas: HTMLCanvasElement | undefined = gl?.domElement;

  if (!canvas || typeof gl.setSize !== 'function') return;

  let cancelled = false;
  let healthyStreak = 0;

  const reconfigure = (): boolean => {
    if (cancelled) return false;

    const measured = measureCanvasHost(canvas);
    if (!measured || measured.width <= 0 || measured.height <= 0) return false;

    if (
      state.size?.width !== measured.width ||
      state.size?.height !== measured.height ||
      state.size?.top !== measured.top ||
      state.size?.left !== measured.left
    ) {
      state.setSize?.(measured.width, measured.height, measured.top, measured.left);
    }

    // Camera projection heal — the WebGL2-path fix. R3F should do this in its
    // size layout effect; when that never ran, aspect stays 0 and the whole
    // scene frustum-culls. Idempotent: skipped when aspect already matches.
    const cam = state.camera;
    const wantAspect = measured.width / measured.height;
    let cameraHealthy = true;
    if (cam?.isPerspectiveCamera && Number.isFinite(wantAspect) && wantAspect > 0) {
      if (!Number.isFinite(cam.aspect) || Math.abs(cam.aspect - wantAspect) > 1e-3) {
        cam.aspect = wantAspect;
        cam.updateProjectionMatrix();
        cameraHealthy = false; // was broken this check — require another clean pass
      }
    }

    // Renderer buffer + viewport sync — both backends, idempotent.
    gl.setSize(measured.width, measured.height, false);

    // WebGPU-only swapchain refresh. gl.setSize() → WebGPUBackend.updateSize()
    // nulls the cached render-pass descriptor + color buffer, but the shipped
    // three build does NOT re-call GPUCanvasContext.configure() — that runs
    // exactly once in init(). If the swapchain was configured while the canvas
    // was a transient/wrong size, nothing re-syncs it and the canvas presents
    // only the clear color until a real dimension change. configure() sizes
    // the swapchain to the canvas's CURRENT backing store.
    if (backend?.isWebGPUBackend) {
      try {
        const ctx = backend.context as GPUCanvasContext | undefined;
        const device = backend.device as GPUDevice | undefined;
        const format: GPUTextureFormat | undefined = backend.utils?.getPreferredCanvasFormat?.();
        if (ctx && device && format) {
          // Mirror WebGPUBackend.init()'s configure exactly.
          ctx.configure({
            device,
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            alphaMode: backend.parameters?.alpha ? 'premultiplied' : 'opaque',
          });
        }
      } catch (err) {
        console.warn('[World3D] WebGPU context reconfigure skipped:', err);
      }
    }

    state.invalidate?.();
    return cameraHealthy;
  };

  const STOP_AFTER_MS = 30_000;
  const CHECK_INTERVAL_MS = 500;
  const startedAt = performance.now();

  const checkLoop = () => {
    if (cancelled) return;
    // SPA route change unmounts the canvas but window timers survive — bail
    // so the closure doesn't retain the R3F state/renderer for up to 30s.
    if (!canvas.isConnected) {
      cancelled = true;
      return;
    }
    const healthy = reconfigure();
    healthyStreak = healthy ? healthyStreak + 1 : 0;
    const worldReady = (window as any).__W3D_READY === true;
    if ((healthyStreak >= 2 && worldReady) || performance.now() - startedAt > STOP_AFTER_MS) {
      cancelled = true;
      return;
    }
    window.setTimeout(checkLoop, CHECK_INTERVAL_MS);
  };

  // onCreated fires before the first frame. Two RAFs place the first check
  // after the first ordinary frame in frameloop="always", so the reconfigure
  // replaces an actual first swapchain texture instead of racing initial
  // context creation.
  requestAnimationFrame(() => {
    requestAnimationFrame(checkLoop);
  });
}

function kickRenderLoop(state: any): void {
  if (typeof state.invalidate === 'function') {
    state.invalidate();
  }
  // Delay __W3D assignment by one RAF. Historically that RAF followed the first
  // rendered frame; on iOS WebGL2 this kept the loading screen over synchronous
  // first-draw shader compilation and avoided the "loaded twice" appearance.
  // 2026-07-14 gate exception: while frameloop="never" this RAF runs after the
  // Canvas commit but BEFORE any R3F render. That timing is intentionally kept;
  // __W3D_TEXTURES_READY remains false until the later controlled warm render,
  // so markWorldReadyIfUploadsDone still cannot dismiss the overlay early.
  if (typeof window !== 'undefined') {
    requestAnimationFrame(() => {
      (window as any).__W3D = state;
      (window as any).__W3D_CANVAS_READY = true;
      markWorldReadyIfUploadsDone();
      // Convenience helper for MCP browser automation / devtools — call
      // window.__W3D_step() to manually advance one frame when the tab is
      // hidden and RAF is throttled to 0 Hz.
      (window as any).__W3D_step = () =>
        state.advance(performance.now() / 1000, true);
      // Minimal renderer-info accessor for the steady-state harness.
      // Gated on VRM_METRICS_ENABLED (same flag as VRM/texture metrics).
      // Returns a plain object snapshot — zero cost when not called.
      // The harness samples this once per second during the steady window,
      // not per-frame, so the function call overhead is negligible.
      // Pattern: `window.__CV_GL_INFO?.()?.calls` — safe even if the export
      // is absent (fallback to undefined → null).
      if (VRM_METRICS_ENABLED) {
        (window as any).__CV_GL_INFO = () => {
          const info = (state.gl as any)?.info;
          if (!info) return null;
          return {
            // WebGPURenderer resets render.drawCalls each frame; WebGLRenderer
            // uses render.calls for the same per-frame counter. render.calls on
            // WebGPU is a cumulative lifetime counter (never reset) so we must
            // prefer drawCalls there and fall back to calls for WebGL.
            calls:     (info.render?.drawCalls ?? info.render?.calls) ?? 0,
            triangles: info.render?.triangles ?? 0,
            lines:     info.render?.lines     ?? 0,
            points:    info.render?.points    ?? 0,
            programs:  info.programs?.length  ?? 0,
          } as { calls: number; triangles: number; lines: number; points: number; programs: number };
        };
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Runtime warmup frameloop gate (2026-07-14)
// ---------------------------------------------------------------------------

type WorldWarmupGate = {
  readonly resumed: boolean;
  resume: (reason: 'warmup-complete' | 'warmup-error' | 'safety-timeout') => void;
  onResume: (listener: () => void) => () => void;
  dispose: () => void;
};

// The renderer survives RootState object replacement when setFrameloop updates
// the zustand store, so key the gate by `gl`, not by the transient state snapshot.
const WORLD_WARMUP_GATES = new WeakMap<object, WorldWarmupGate>();

/**
 * Runtime frameloop gate (2026-07-14).
 *
 * Canvas must still be CREATED with frameloop="always" because R3F v9 skips
 * our async renderer factory when it is created as "never". onCreated is the
 * first safe point to switch the live store to "never", before R3F's first
 * full-scene render can synchronously upload every compressed KTX2 mip.
 *
 * 2026-07-14: the React prop must switch with the live store. R3F 9.5's
 * root.configure() reconciles state.frameloop back to the Canvas prop on every
 * Canvas re-render (installed events-5a94e5eb.esm.js:15670). A store-only pause
 * was therefore silently reverted during world/NPC commits and leaked a real
 * R3F frame mid-warmup, measured as a 6.4-6.8s compressed-texture upload task.
 *
 * Resume is deliberately centralized and idempotent. The normal warmup path,
 * any thrown warmup step, and the progress-aware safety watchdog all converge
 * here. Only R3F 9.5's invalidate explicitly no-ops while frameloop is "never",
 * so the historical kick remains in onCreated to preserve
 * __W3D_CANVAS_READY timing. Only the first-paint size healer is deferred until
 * the loop is live again.
 */
function createWorldWarmupGate(
  state: any,
  pauseForWarmup: boolean,
  onFrameloopChange: (mode: 'always' | 'never') => void,
): WorldWarmupGate {
  let disposed = false;
  let resumed = !pauseForWarmup;
  let lastProgressAt = performance.now();
  let watchdogInterval: number | undefined;
  let absoluteCeilingTimer: number | undefined;
  let safetyFuseCause: 'no-progress' | 'absolute-ceiling' | undefined;
  const resumeListeners = new Set<() => void>();
  const noteProgress = () => {
    if (disposed || resumed) return;
    lastProgressAt = performance.now();
  };
  const clearWatchdog = () => {
    if (watchdogInterval !== undefined) {
      window.clearInterval(watchdogInterval);
      watchdogInterval = undefined;
    }
    if (absoluteCeilingTimer !== undefined) {
      window.clearTimeout(absoluteCeilingTimer);
      absoluteCeilingTimer = undefined;
    }
    if (activeWorldWarmupProgressNotifier === noteProgress) {
      activeWorldWarmupProgressNotifier = undefined;
    }
  };

  const gate: WorldWarmupGate = {
    get resumed() {
      return resumed;
    },
    resume(reason) {
      if (disposed || resumed) return;
      resumed = true;
      clearWatchdog();
      onFrameloopChange('always');
      state.setFrameloop('always');
      state.invalidate();
      // 2026-07-14: fail open as one atomic UI transition. SeaLoadingScreen
      // dismisses only after __W3D_READY; resuming R3F without releasing its
      // texture-ready half would render behind the overlay until its 45s ceiling.
      // The normal completion path already set this flag, so repeating it here
      // keeps every resume reason idempotent and prevents a safety fuse/error
      // from turning into a second, much longer apparent hang.
      (window as any).__W3D_TEXTURES_READY = true;
      markWorldReadyIfUploadsDone();
      // Heal both blue-until-resize boot races (WebGPU swapchain config +
      // WebGL2 camera.aspect=0 NaN projection) only after resume. Its internal
      // invalidate must never be allowed to create a pre-warmup draw.
      forceFirstPaintSizeSync(state);
      for (const listener of resumeListeners) listener();
      resumeListeners.clear();
      if (reason === 'safety-timeout') {
        const limit = safetyFuseCause === 'absolute-ceiling'
          ? 'hit the 40s absolute ceiling'
          : 'made no progress for 10s';
        console.warn(`[World3D] warmup ${limit}; resumed render loop via safety fuse`);
      }
    },
    onResume(listener) {
      if (disposed) return () => {};
      if (resumed) {
        listener();
        return () => {};
      }
      resumeListeners.add(listener);
      return () => resumeListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearWatchdog();
      resumeListeners.clear();
      if (WORLD_WARMUP_GATES.get(state.gl) === gate) {
        WORLD_WARMUP_GATES.delete(state.gl);
      }
    },
  };

  WORLD_WARMUP_GATES.set(state.gl, gate);
  if (pauseForWarmup) {
    state.setFrameloop('never');
    onFrameloopChange('never');
    lastProgressAt = performance.now();
    activeWorldWarmupProgressNotifier = noteProgress;
    // 2026-07-14: a fixed 10s-from-canvas fuse fired while cold-network asset
    // loading was still healthy, then the first resumed R3F frame paid all
    // remaining uploads/compiles in one measured 9.9s main-thread task. Treat
    // only 10s with NO loader/upload/scan/compile progress as a hang. A separate
    // 40s absolute ceiling still fails open before SeaLoadingScreen's 45s
    // force-dismiss, allowing resume() to release renderer + overlay atomically.
    watchdogInterval = window.setInterval(() => {
      if (resumed || performance.now() - lastProgressAt <= 10_000) return;
      safetyFuseCause = 'no-progress';
      gate.resume('safety-timeout');
    }, 2_000);
    absoluteCeilingTimer = window.setTimeout(() => {
      safetyFuseCause = 'absolute-ceiling';
      gate.resume('safety-timeout');
    }, 40_000);
  }
  return gate;
}

// ---------------------------------------------------------------------------
// MinimapPositionTracker — writes the current follow-point to gameStore.avatarPosition
// each frame when neither the player-avatar nor the NPC-possession controller is
// doing so (i.e. controlMode === 'explore'). Uses the OrbitControls target as
// the focus point — that's what the user is actually looking at. Also handles
// NPC-mode by copying the possessed NPC's map coordinates on each tick.
// ---------------------------------------------------------------------------
function MinimapPositionTracker() {
  const { camera } = useThree();
  const lastWriteRef = useRef(0);
  useFrame(({ clock }) => {
    const now = clock.elapsedTime;
    // 5×/sec throttle
    if (now - lastWriteRef.current < 0.2) return;
    lastWriteRef.current = now;

    const store = useGameStore.getState();
    const mode = store.controlMode;

    let mapX: number | null = null;
    let mapY: number | null = null;

    if (mode === 'npc' && store.possessedNpcId) {
      const npc = useNpcStore.getState().npcs.find((n) => n.id === store.possessedNpcId);
      if (npc) { mapX = npc.x; mapY = npc.y; }
    } else if (mode === 'autonomous') {
      // §B.1b — PlayerAvatar is unmounted in Autonomous, so nothing writes
      // avatarPositionRef anymore; source the minimap blip from the streamed
      // `ocb-` body the same way FPSFollowCamera does, or leave the blip at
      // its last position if the body id isn't confirmed/streamed in yet.
      if (store.autonomousBodyId) {
        const body = useNpcStore.getState().npcs.find((n) => n.id === store.autonomousBodyId);
        if (body) { mapX = body.x; mapY = body.y; }
      }
      if (mapX == null || mapY == null) return;
    } else if (mode === 'player') {
      // Keep whatever player-avatar wrote; don't overwrite from camera (camera can
      // be far from the avatar while orbiting). Only avatar mesh position is authoritative.
      return;
    } else {
      // explore — camera XZ projected to map coords
      mapX = camera.position.x + HALF_W;
      mapY = camera.position.z + HALF_H;
    }

    if (mapX == null || mapY == null) return;
    // Clamp to map bounds so stray camera positions don't break the minimap
    mapX = Math.max(0, Math.min(MAP_WIDTH, mapX));
    mapY = Math.max(0, Math.min(MAP_HEIGHT, mapY));
    // Use avatarPositionRef for the diff-check — it's always current at 60 Hz.
    if (
      Math.abs(mapX - avatarPositionRef.x) > 2 ||
      Math.abs(mapY - avatarPositionRef.y) > 2
    ) {
      store.setAvatarPosition(mapX, mapY);
    }
  });
  return null;
}

function PerfCameraPreset({
  controlsRef,
}: {
  controlsRef: RefObject<OrbitControlsImpl | null>;
}) {
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(0, 600, 1300);
    camera.lookAt(0, 80, 0);
    camera.updateProjectionMatrix();
    const controls = controlsRef.current;
    if (controls) {
      controls.target.set(0, 80, 0);
      controls.update();
    }
  }, [camera, controlsRef]);

  return null;
}

// ---------------------------------------------------------------------------
// CoveEntranceCameraPush — smooth camera drift toward the cove on walk-in.
// Listens for the 'cove-walkin-start' DOM event dispatched by triggerCoveWalkIn()
// in arena-buildings.tsx, then for 1.2s pushes the camera slightly toward
// world X=-4160 (cove direction). Zero per-frame allocations — uses module-scope
// scratch Vector3 and purely primitive ref reads.
// ---------------------------------------------------------------------------
const _covePushTarget = new THREE.Vector3(-4160, 80, 0);
const _covePushScratch = new THREE.Vector3();

function CoveEntranceCameraPush() {
  const { camera } = useThree();
  const pushRef = useRef<{ startTime: number; startX: number; startY: number; startZ: number } | null>(null);

  useEffect(() => {
    function onCoveWalkIn() {
      pushRef.current = {
        startTime: performance.now(),
        startX: camera.position.x,
        startY: camera.position.y,
        startZ: camera.position.z,
      };
    }
    window.addEventListener('cove-walkin-start', onCoveWalkIn);
    return () => window.removeEventListener('cove-walkin-start', onCoveWalkIn);
  }, [camera]);

  useFrame(() => {
    const state = pushRef.current;
    if (!state) return;
    const elapsed = (performance.now() - state.startTime) / 1000;
    const PUSH_DURATION = 1.2;
    if (elapsed > PUSH_DURATION) {
      pushRef.current = null;
      return;
    }
    // Ease out cubic — starts fast, slows into the transition fade.
    const t = elapsed / PUSH_DURATION;
    const ease = 1 - Math.pow(1 - t, 3);
    // Push camera 180 wu toward cove (X direction, slight pull-down in Y for drama).
    _covePushScratch.set(
      state.startX + (_covePushTarget.x - state.startX) * 0.08 * ease,
      state.startY - 30 * ease,
      state.startZ + (_covePushTarget.z - state.startZ) * 0.05 * ease,
    );
    camera.position.lerp(_covePushScratch, 0.12);
  });

  return null;
}

// REMOVED 2026-05-31 — OpaqueCanvasClearGuard caused the permanent blue screen.
// It ran an INDEPENDENT requestAnimationFrame loop calling gl.render(scene, camera)
// on top of R3F's own frameloop='always' render loop — measured live at exactly
// 2.00 gl.render() calls per frame. On WebGPU the swapchain texture can only be
// acquired once per frame (context.getCurrentTexture()); the guard's second
// render presented only the SKY_COLOR clear and clobbered R3F's real frame, so
// the whole world showed as uniform blue. Opaque presentation is already
// guaranteed by: alpha:false on the renderer + renderer.setClearColor(SKY_COLOR,1)
// in createWebGPURenderer/onCreated + scene.background=SKY_COLOR. R3F's
// frameloop='always' renders the populated scene every frame on its own — the
// guard added nothing but the fatal double-render. Introduced in commit 11034881
// ("stabilize world canvas presentation"); that "stabilization" was the regression.

// ---------------------------------------------------------------------------
// WorldWarmup — ordered upload/compile/render behind the loading overlay
// ---------------------------------------------------------------------------
// 2026-07-14: the old PreCompilePipelines + StaggeredTextureUpload helpers both
// started AFTER R3F registered its frameloop callback. The first ordinary scene
// render therefore always won, synchronously uploading ~115 compressed KTX2
// textures (CPU writeTexture per mip) and compiling/drawing the whole scene in
// one 4.1–4.3s main-thread task. Their pacing code never got a chance to help.
//
// The runtime gate now makes ordering structural: wait for loader idle + a
// committed scene, pre-upload until two scans find nothing new, await Three
// r185's cooperative compileAsync, perform exactly one warm render, then resume
// R3F. Post-ready scans every 2s for 60s use the gentle path to catch late VRM
// textures without adding any per-frame allocation or changing steady state.
// ---------------------------------------------------------------------------
// Gentle pacing — used once __W3D_READY (world is interactive, frame budget matters)
const IDLE_SLICE_BUDGET_MS = 6;
const IDLE_MAX_TEXTURES_PER_SLICE = 4;
const RAF_FALLBACK_BATCH = 4;

// Fast-blast pacing — used while !__W3D_READY (loading overlay hides the scene;
// there is no visible frame budget to protect). Perf round-3 change B.
// 30ms / 32-tex cap per idle slice; 24-tex per rAF tick.
// Still bounded: on Iris Xe 30ms ≈ 8-12 textures before timeRemaining drops,
// so the practical rate is limited by the GPU, not the cap.
const FAST_SLICE_BUDGET_MS = 30;
const FAST_MAX_TEXTURES_PER_SLICE = 32;
const RAF_FAST_BATCH = 24;

// All standard texture slot names on MeshStandardMaterial and related.
const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
  'emissiveMap', 'lightMap', 'envMap', 'alphaMap', 'bumpMap',
  'displacementMap', 'clearcoatMap', 'clearcoatNormalMap',
  'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'transmissionMap', 'thicknessMap', 'specularMap', 'specularColorMap',
] as const;

type TextureUploadSliceMetric = {
  mode: 'idle' | 'raf';
  startMs: number;
  durationMs: number;
  count: number;
  done: number;
};

type TextureUploadMetrics = {
  mode: 'idle' | 'raf';
  totalTextures: number;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  slices: TextureUploadSliceMetric[];
};

function createTextureUploadMetrics(mode: 'idle' | 'raf', totalTextures: number): TextureUploadMetrics {
  const metrics: TextureUploadMetrics = {
    mode,
    totalTextures,
    startedAt: performance.now(),
    slices: [],
  };
  if (VRM_METRICS_ENABLED && typeof window !== 'undefined') {
    (window as any).__CV_TEXTURE_UPLOAD_METRICS = metrics;
  }
  return metrics;
}

function pushTextureUploadSlice(
  metrics: TextureUploadMetrics,
  mode: 'idle' | 'raf',
  start: number,
  count: number,
  done: number,
): void {
  metrics.slices.push({
    mode,
    startMs: Math.round(start),
    durationMs: Math.round((performance.now() - start) * 10) / 10,
    count,
    done,
  });
}

function completeTextureUploadMetrics(metrics: TextureUploadMetrics): void {
  metrics.completedAt = performance.now();
  metrics.durationMs = Math.round((metrics.completedAt - metrics.startedAt) * 10) / 10;
}

function WorldWarmup() {
  const state = useThree();
  const { camera, gl, scene } = state;

  useEffect(() => {
    // DEBUG PROBE: expose scene/camera/renderer globally so CDP can introspect
    // scale issues without an extra deploy cycle. Safe — no per-frame cost.
    (window as any).__R3F = { scene, camera, gl };
    (window as any).__CV_STORES__ = { useGameStore, useNpcStore };

    const gate = WORLD_WARMUP_GATES.get(gl as object);
    const gateWasPending = gate?.resumed === false;
    const canInitTexture = typeof (gl as any).initTexture === 'function';
    const hasIdle = typeof (window as any).requestIdleCallback === 'function';
    const seen = new Set<THREE.Texture>();
    const bridge = window as any;
    let cancelled = false;
    let discoveredTotal = Math.max(0, Number(bridge.__W3D_TEXTURE_UPLOAD_TOTAL) || 0);
    let uploadedDone = Math.max(0, Number(bridge.__W3D_TEXTURE_UPLOAD_DONE) || 0);
    let idleHandle: number | undefined;
    let uploadRaf: number | undefined;
    let settleRaf: number | undefined;
    let managerCapTimer: number | undefined;
    let postScanTimer: number | undefined;
    let postStopTimer: number | undefined;
    let managerIdleCleanup: (() => void) | undefined;
    let activeUploadResolve: (() => void) | undefined;
    let settleRafResolve: (() => void) | undefined;
    let uploadQueue = Promise.resolve();
    let postScanStarted = false;
    let warmupUploadedTextures = 0;

    // Perf round-3 change A, retained by the 2026-07-14 warmup gate: the
    // initial ordered compile can still precede the 14 asynchronously parsed NPC
    // VRMs. Their skinned-MeshStandardMaterial variants are absent from that
    // first scene walk and otherwise lazy-compile at reveal (7.5s main-thread
    // smear in the pre-r185 baseline). The bulk-idle hook fires once the parse
    // queue first drains, when those meshes are in the scene, so run one more
    // cooperative r185 compileAsync pass. It may occur after resume; it yields
    // between objects, performs no independent render, and is guarded against
    // an unmounted/stale renderer.
    registerBulkVRMIdleCallback(() => {
      if (cancelled || typeof (gl as any).compileAsync !== 'function') return;
      noteWorldWarmupProgress();
      (gl as any).compileAsync(scene, camera)
        .then(() => {
          if (!cancelled) bridge.__W3D_VRM_COMPILE_DONE = performance.now();
        })
        .catch((err: unknown) => {
          console.warn('[World3D] post-VRM compileAsync failed:', err);
        })
        .finally(() => {
          noteWorldWarmupProgress();
        });
    });

    const uploadMetrics = createTextureUploadMetrics(hasIdle ? 'idle' : 'raf', discoveredTotal);

    const publishProgress = () => {
      // Re-scans may grow TOTAL, but neither counter may ever move backwards:
      // SeaLoadingScreen polls these globals and a reset would regress its bar.
      bridge.__W3D_TEXTURE_UPLOAD_TOTAL = Math.max(
        Number(bridge.__W3D_TEXTURE_UPLOAD_TOTAL) || 0,
        discoveredTotal,
      );
      bridge.__W3D_TEXTURE_UPLOAD_DONE = Math.max(
        Number(bridge.__W3D_TEXTURE_UPLOAD_DONE) || 0,
        uploadedDone,
      );
      uploadMetrics.totalTextures = Math.max(uploadMetrics.totalTextures, discoveredTotal);
    };

    const scanForUnseenTextures = (): THREE.Texture[] => {
      const fresh: THREE.Texture[] = [];
      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (!mat) continue;
          for (const slot of TEXTURE_SLOTS) {
            const tex = (mat as any)[slot];
            if (tex instanceof THREE.Texture && !seen.has(tex)) {
              seen.add(tex);
              fresh.push(tex);
            }
          }
        }
      });
      if (fresh.length > 0) {
        noteWorldWarmupProgress();
        discoveredTotal += fresh.length;
        publishProgress();
      }
      return fresh;
    };

    const finishActiveUpload = () => {
      const resolve = activeUploadResolve;
      activeUploadResolve = undefined;
      resolve?.();
    };

    const uploadBatch = (
      textures: THREE.Texture[],
      fastMode: boolean,
      recordMetrics: boolean,
    ): Promise<void> => new Promise((resolve) => {
      if (cancelled || !canInitTexture || textures.length === 0) {
        resolve();
        return;
      }

      let i = 0;
      activeUploadResolve = resolve;
      const finish = () => {
        idleHandle = undefined;
        uploadRaf = undefined;
        finishActiveUpload();
      };

      const uploadOne = (texture: THREE.Texture) => {
        try {
          (gl as any).initTexture(texture);
        } catch (err) {
          console.warn('[World3D] initTexture error (non-fatal):', err);
        }
        uploadedDone += 1;
        if (recordMetrics) warmupUploadedTextures += 1;
        noteWorldWarmupProgress();
      };

      const uploadIdle = (deadline: IdleDeadline) => {
        if (cancelled) {
          finish();
          return;
        }
        const t0 = performance.now();
        const before = i;
        const budgetMs = fastMode ? FAST_SLICE_BUDGET_MS : IDLE_SLICE_BUDGET_MS;
        const maxPerSlice = fastMode ? FAST_MAX_TEXTURES_PER_SLICE : IDLE_MAX_TEXTURES_PER_SLICE;
        // Preserve the proven deadline-aware path: a real idle window drains
        // until <2ms remains; timed-out callbacks use the bounded fast/gentle
        // constants. At least one texture is attempted in every slice.
        const useDeadline = !deadline.didTimeout && deadline.timeRemaining() > 0;
        while (i < textures.length) {
          if (i > before) {
            if (useDeadline) {
              if (deadline.timeRemaining() < 2) break;
            } else {
              if (i - before >= maxPerSlice) break;
              if (performance.now() - t0 >= budgetMs) break;
            }
          }
          uploadOne(textures[i]);
          i += 1;
        }
        publishProgress();
        if (recordMetrics) {
          pushTextureUploadSlice(uploadMetrics, 'idle', t0, i - before, uploadedDone);
        }
        if (i < textures.length) {
          idleHandle = (window as any).requestIdleCallback(uploadIdle, { timeout: 200 });
        } else {
          finish();
        }
      };

      const uploadRafFallback = () => {
        if (cancelled) {
          finish();
          return;
        }
        const t0 = performance.now();
        const before = i;
        const batch = fastMode ? RAF_FAST_BATCH : RAF_FALLBACK_BATCH;
        const end = Math.min(i + batch, textures.length);
        for (; i < end; i += 1) uploadOne(textures[i]);
        publishProgress();
        if (recordMetrics) {
          pushTextureUploadSlice(uploadMetrics, 'raf', t0, i - before, uploadedDone);
        }
        const elapsed = performance.now() - t0;
        if (elapsed > 20) {
          console.warn(`[World3D] texture upload batch took ${elapsed.toFixed(1)}ms`);
        }
        if (i < textures.length) {
          uploadRaf = requestAnimationFrame(uploadRafFallback);
        } else {
          finish();
        }
      };

      if (hasIdle) {
        idleHandle = (window as any).requestIdleCallback(uploadIdle, { timeout: 200 });
      } else {
        uploadRaf = requestAnimationFrame(uploadRafFallback);
      }
    });

    const queueUpload = (
      textures: THREE.Texture[],
      fastMode: boolean,
      recordMetrics: boolean,
    ): Promise<void> => {
      uploadQueue = uploadQueue.then(() => uploadBatch(textures, fastMode, recordMetrics));
      return uploadQueue;
    };

    const waitForCommitFrame = (): Promise<void> => new Promise((resolve) => {
      if (cancelled) {
        resolve();
        return;
      }
      settleRafResolve = resolve;
      settleRaf = requestAnimationFrame(() => {
        settleRaf = undefined;
        settleRafResolve = undefined;
        resolve();
      });
    });

    const waitForLoadingManagerIdle = (): Promise<void> => new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        defaultLoadingManagerIdleListeners.delete(finish);
        managerIdleCleanup = undefined;
        if (managerCapTimer !== undefined) {
          window.clearTimeout(managerCapTimer);
          managerCapTimer = undefined;
        }
        resolve();
      };
      defaultLoadingManagerIdleListeners.add(finish);
      managerIdleCleanup = finish;
      managerCapTimer = window.setTimeout(finish, 8_000);

      // LoadingManager exposes no public isLoading/counts. A synthetic balanced
      // item is an exact barrier that cannot miss tier-1 preloads already active
      // before this dynamically imported module installed its callbacks: onLoad
      // fires now when idle, or after every pre-existing item drains.
      const barrierUrl = `__w3d-warmup-barrier-${performance.now()}`;
      THREE.DefaultLoadingManager.itemStart(barrierUrl);
      THREE.DefaultLoadingManager.itemEnd(barrierUrl);
    });

    const startPostReadyScans = () => {
      if (cancelled || postScanStarted || !canInitTexture) return;
      postScanStarted = true;
      const scan = () => {
        if (cancelled) return;
        const fresh = scanForUnseenTextures();
        if (fresh.length > 0) {
          // Serialize with any still-finishing initial batch if the safety
          // watchdog resumed early. Nothing uploads concurrently with another batch.
          void queueUpload(fresh, false, false);
        }
        postScanTimer = window.setTimeout(scan, 2_000);
      };
      postScanTimer = window.setTimeout(scan, 2_000);
      postStopTimer = window.setTimeout(() => {
        if (postScanTimer !== undefined) window.clearTimeout(postScanTimer);
        postScanTimer = undefined;
      }, 60_000);
    };

    const unsubscribeResume = gate?.onResume(startPostReadyScans) ?? (() => {
      startPostReadyScans();
    });

    void (async () => {
      try {
        // The effect itself proves one React commit. The manager barrier waits
        // for all already-started world loads (8s cap), then this RAF gives
        // Suspense retries one commit opportunity before the first scan.
        const barrierStartedAt = performance.now();
        await waitForLoadingManagerIdle();
        await waitForCommitFrame();
        const barrierMs = performance.now() - barrierStartedAt;
        if (cancelled || (gateWasPending && gate?.resumed)) return;

        const scansStartedAt = performance.now();
        if (!canInitTexture) {
          console.warn('[World3D] WorldWarmup: renderer.initTexture() not available, skipping uploads');
          publishProgress();
        } else {
          console.log(`[World3D] WorldWarmup: pre-uploading textures via ${hasIdle ? 'rIC' : 'rAF'} budget`);
          let zeroScans = 0;
          while (!cancelled && zeroScans < 2) {
            const fresh = scanForUnseenTextures();
            if (fresh.length > 0) {
              zeroScans = 0;
              await queueUpload(fresh, true, true);
            } else {
              zeroScans += 1;
            }
            if (zeroScans < 2) await waitForCommitFrame();
            if (gateWasPending && gate?.resumed) return;
          }
          completeTextureUploadMetrics(uploadMetrics);
          console.log(`[World3D] WorldWarmup: uploaded ${uploadedDone}/${discoveredTotal} textures`);
        }
        const scansMs = performance.now() - scansStartedAt;

        if (cancelled || (gateWasPending && gate?.resumed)) return;
        let compileMs = 0;
        if (typeof (gl as any).compileAsync === 'function') {
          const compileStartedAt = performance.now();
          noteWorldWarmupProgress();
          try {
            await (gl as any).compileAsync(scene, camera);
          } catch (err) {
            console.warn('[World3D] compileAsync failed (continuing warmup):', err);
          } finally {
            compileMs = performance.now() - compileStartedAt;
            noteWorldWarmupProgress();
          }
        }
        if (cancelled || (gateWasPending && gate?.resumed)) return;

        // One controlled warm draw behind the overlay. On WebGL2 this is also
        // the synchronous shader compile. Never run it after the safety watchdog
        // has resumed R3F or it could recreate the historic double-render blue screen.
        if (cancelled || (gateWasPending && gate?.resumed)) return;
        const warmRenderStartedAt = performance.now();
        noteWorldWarmupProgress();
        gl.setClearColor(SKY_COLOR, 1);
        gl.setClearAlpha?.(1);
        gl.render(scene, camera);
        const warmRenderMs = performance.now() - warmRenderStartedAt;
        bridge.__W3D_TEXTURES_READY = true;
        markWorldReadyIfUploadsDone();
        console.log(
          `[World3D] WorldWarmup done: barrier ${barrierMs.toFixed(1)}ms, `
          + `scans ${scansMs.toFixed(1)}ms (${warmupUploadedTextures} textures), `
          + `compile ${compileMs.toFixed(1)}ms, warmRender ${warmRenderMs.toFixed(1)}ms`,
        );

        if (gate) {
          gate.resume('warmup-complete');
        } else {
          // Defensive fallback: onCreated always installs a gate, but never let
          // a future refactor strand the canvas if that contract changes.
          state.setFrameloop('always');
          state.invalidate();
          forceFirstPaintSizeSync(state);
          startPostReadyScans();
        }
      } catch (err) {
        if (cancelled) return;
        console.warn('[World3D] WorldWarmup failed; resuming render loop:', err);
        if (gate) {
          gate.resume('warmup-error');
        } else {
          state.setFrameloop('always');
          state.invalidate();
          forceFirstPaintSizeSync(state);
          startPostReadyScans();
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribeResume();
      if (managerCapTimer !== undefined) window.clearTimeout(managerCapTimer);
      managerIdleCleanup?.();
      if (postScanTimer !== undefined) window.clearTimeout(postScanTimer);
      if (postStopTimer !== undefined) window.clearTimeout(postStopTimer);
      if (settleRaf !== undefined) cancelAnimationFrame(settleRaf);
      if (uploadRaf !== undefined) cancelAnimationFrame(uploadRaf);
      if (idleHandle !== undefined && typeof (window as any).cancelIdleCallback === 'function') {
        (window as any).cancelIdleCallback(idleHandle);
      }
      settleRafResolve?.();
      finishActiveUpload();
    };
    // gl/scene/camera/state are stable R3F refs — intentionally omitted from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

// ---------------------------------------------------------------------------
// Scene contents (inside Canvas)
// ---------------------------------------------------------------------------
// Detect touch/mobile once (stable across re-renders)
const isTouchDevice = typeof window !== 'undefined' &&
  (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768);

const SceneContents = memo(function SceneContents({
  mode,
  perfFlags,
}: {
  mode: WorldMode;
  perfFlags?: Partial<WorldPerfFlags>;
}) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const isGame = mode === 'game';
  const flags = { ...DEFAULT_WORLD_PERF_FLAGS, ...perfFlags };
  const staticOnly = flags.staticWorldOnly;
  const showLabels = flags.labels && !staticOnly;
  const showNpcs = flags.npcs && !staticOnly;
  const showWaterFogParticles = flags.waterFogParticles && !staticOnly;
  const showGroundCover = flags.groundCover && !staticOnly;
  const showActivityFx = flags.activityFx && !staticOnly;
  const showBuildingDetail = flags.buildingDetail && !staticOnly;
  // Read controlMode once at mount for camera routing; camera routing uses
  // getState() inside useFrame so it always has the latest value at zero cost.
  // We only need a reactive read here if we conditionally render JSX based on
  // controlMode — which we do for the controller switch below.
  const controlMode = useGameStore((s) => s.controlMode);

  // Follow camera in all modes except explore (free camera for manual orbit/pan).
  const useFollowCam = controlMode !== 'explore';

  // Tight follow distance for any mode where the camera tracks a character.
  // Explore mode ('explore' + arena) gets a wider minDistance for free-look.
  const followMode = useFollowCam;

  return (
    <>
      {/* 2026-07-14: first child by design. Its passive effect proves the world
          tree committed once, then explicitly waits for LoadingManager idle and
          Suspense retry time before the stable texture scans. R3F stays paused
          until this ordered upload → compile → warm-render sequence completes. */}
      <WorldWarmup />

      {/* KTX2Loader initialisation — detects GPU compressed format support
          (BC7 on Iris Xe via WebGPU) and arms the module-level singleton used
          by useGLTFWithKTX2. Must render before any KTX2-textured GLB loads. */}
      <KTX2LoaderSetup />

      {/* MeshoptDecoder initialisation — registers the WASM decoder so that
          GLBs compressed with EXT_meshopt_compression (C6 asset pipeline)
          decode correctly. Belt-and-suspenders alongside the module-scope init
          in meshopt-loader-setup.tsx. Must render before any meshopt GLB loads. */}
      <MeshoptLoaderSetup />

      {/* Jump physics tick — mounted FIRST so its useFrame runs before every
          consumer (FPSFollowCamera, ArenaNpcs, NpcController, PlayerAvatar).
          R3F runs useFrame hooks in mount order; hoisting here ensures every
          consumer reads current-frame heightOffset, not the prior frame's stale value. */}
      <JumpTicker />

      {/* Cove entrance camera push — listens for 'cove-walkin-start' event
          (dispatched by triggerCoveWalkIn in arena-buildings.tsx) and smoothly
          pushes the camera toward the cove for 1.2s. Task 2 entrance anim. */}
      <CoveEntranceCameraPush />

      {/* Single DOM overlay for all world-space labels (NPC names, building labels,
          speech bubbles). Replaces 30+ per-instance drei <Html> portals.
          Mount early so consumers (ArenaNpcs, ArenaBuildings, etc.) see the overlay
          node ready on their first render. */}
      {showLabels && <WorldLabelsOverlayMount />}

      {/* Camera controls.
          Target at z=-50 centres on the middle building row (z ≈ -64) so the
          initial overview shows all 3 rows symmetrically. */}
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enablePan={!isTouchDevice}
        enableZoom={true}
        enableRotate={true}
        minDistance={followMode ? 40 : 160}
        maxDistance={5500}
        maxPolarAngle={Math.PI * 0.85}
        rotateSpeed={isTouchDevice ? 0.4 : 1}
        zoomSpeed={isTouchDevice ? 0.6 : 1}
        target={[0, 10, 0]}
      />
      {perfFlags && <PerfCameraPreset controlsRef={controlsRef} />}

      {/* Camera controller routing based on controlMode:
            explore           → WASDCameraController (free cam, WASD pans world)
            player            → FPSFollowCamera (follows the local PlayerAvatar)
            autonomous        → FPSFollowCamera (follows the streamed `ocb-`
                                 agent body by autonomousBodyId — §B.1b; the
                                 local PlayerAvatar is unmounted in this mode,
                                 see the player-avatar render gate below)
            npc               → FPSFollowCamera (follows possessed NPC)
          Arrow key rotation is always active in all modes. */}
      {!useFollowCam ? (
        <WASDCameraController controlsRef={controlsRef} />
      ) : (
        <FPSFollowCamera controlsRef={controlsRef} />
      )}
      <ArrowKeyRotationController controlsRef={controlsRef} />

      {/* Underwater lighting — warm caustic tones with strong contrast.
          3 lights max for Intel Iris Xe budget: hemisphereLight already
          provides ambient sky/ground fill, so no separate ambientLight. */}
      <hemisphereLight args={[0x66bbdd, 0x223344, 1.8]} />
      <directionalLight position={[150, 350, 80]} intensity={2.0} color={0xffeedd} />
      {/* Secondary fill from opposite side for depth */}
      <directionalLight position={[-100, 200, -60]} intensity={0.5} color={0x88aacc} />

      {/* Underwater fog — scaled for 360x360 map (11520wu world) / R=130-tile ring.
          Phase 6.2.3 fog tuning (2026-05-19): near 4500→6000, far 9000→15000.
          User feedback: "the blue density of far off buildings that makes you unable to see them"
          even at [4500, 9000]. Far-ring buildings at 5493wu were still at 22% fog blend.
          Geometry: camera at (0,600,1300). Ring radius=4160wu.
            Near-side ring (slot 6, South, world z≈+4160): d=√(600²+2860²)≈2922wu
            Far-side ring  (slot 0, North, world z≈-4160): d=√(600²+5460²)≈5493wu
          With near=6000, far=15000:
            near-ring (2922wu):  factor = clamp((2922−6000)/9000, 0, 1) = 0.00 → fully clear ✓
            far-ring  (5493wu):  factor = clamp((5493−6000)/9000, 0, 1) = 0.00 → fully clear ✓ (FIX)
            mid       (10000wu): factor = (10000−6000)/9000 ≈ 0.44 → gradual fade
            horizon   (15000wu): factor = 1.00 → full fog at horizon
          fog.far rule: camera.far raised 10000→16000 to satisfy fog.far(15000) ≤ camera.far(16000). */}
      {/* Fog tightened 2026-05-22 per user direction "target the fog more,
          i don't care about it much".
          Old: near=6000 far=16000 (camera.far=16000). Geometry past the world
          half-width (5760 wu) still rendered fully even when fog-faded.
          New (2026-05-22): near=5000 far=10000 (camera.far=10000). Far-ring
          buildings at 5493wu start fogging at ~10%, fully fogged by 10000wu.
          2026-06-15 (Phase 0 land, 576x576 world, half=9216wu): near=6500
          far=13500 (camera.far=14000) — pushed OUT for the bigger world, which
          re-exposed the distant low-res sprawl (pixelly on Iris-Xe low DPR).
          Pulled back 2026-06-20 per founder "target the fog more": near=5000
          far=10500 (camera.far=11500). Building ring (≤8320wu across) stays
          visible; everything past ~10500wu fogs out so the distant low-res
          buildings/terrain are hidden again; fog.far(10500) ≤ camera.far(11500)
          so geometry fully fades to fog BEFORE the far-plane cull (no pop). */}
      {showWaterFogParticles && <fog attach="fog" args={[FOG_COLOR, 5000, 10500]} />}

      {/* Shared world geometry */}
      <group name="perf:terrain" userData={{ perfChunk: 'terrain' }}>
        <ArenaTerrain />
      </group>
      {/* Land state hydrator — headless, no geometry, returns null.
          Fetches all parcel ownership (available + owned) from the public API
          and writes the parcelCode-keyed result into useLandStore.parcels so
          every land-parcels / land-structures / land-showroom consumer reflects
          real DB ownership without opening any modal. Invalidated by the Land
          Office modal after buy/claim/place/upgrade so the world updates live.
          Must live inside the R3F Canvas tree so React context (QueryClient)
          is available. Guest-safe (public endpoint). */}
      <LandStateHydrator />

      {/* Land parcels — 180 for-sale lots (Phase 1, square block-frames).
          Merged BufferGeometry pads + posts/rails + signs, 7 draw calls total.
          Ownership state now read from useLandStore.parcels (hydrated above).
          See lib/three/land-parcels.tsx for draw-call budget and tier scheme.
          Wrapped in Suspense so a useMemo failure during canvas texture build
          doesn't crash the whole world. */}
      <Suspense fallback={null}>
        <group name="perf:land-parcels" userData={{ perfChunk: 'land-parcels' }}>
          <LandParcels />
        </group>
      </Suspense>

      {/* Land parcel sign hitboxes — invisible click targets on available FOR-SALE
          signs.  R3F onClick → openLandOffice(parcelCode) → Land Office modal opens
          focused on the clicked parcel.  Rebuilt reactively when parcels change.
          Invisible meshes (visible=false) have ZERO GPU draw calls. */}
      <LandParcelSignHitboxes />

      {/* Land structures — placed homes/shops rendered on owned parcels (Phase 1
          Stage 2). Clean low-poly primitive fallback today; real GLBs swap in
          after the founder picks a Stage-1 style. Self-hydrates the signed-in
          owner's structures via api.getMyLand(). Distance-culled (14000wu); ≤5
          visible per owner. See lib/three/land-structures.tsx. */}
      <Suspense fallback={null}>
        <group name="perf:land-structures" userData={{ perfChunk: 'land-structures' }}>
          <LandStructures />
        </group>
      </Suspense>

      {/* Land showroom — ~15 model buildings on outer starter lots with FOR RENT
          signs. Decorative only (no backend). Hides when a lot is actually owned
          so the buyer's real structure cleanly takes over. Distance-culled 14000wu.
          See lib/three/land-showroom.tsx for draw budget and sign details. */}
      <Suspense fallback={null}>
        <group name="perf:land-showroom" userData={{ perfChunk: 'land-showroom' }}>
          <LandShowroom />
        </group>
      </Suspense>

      {/* Land ring ambient decorations — first representative pass (2026-06-24).
          Fills inter-parcel gaps on founder/starter/c-ring with merged sea-themed
          props (coral, kelp, barrels, lanterns, anchors, shells) + flat path
          ribbons connecting parcels. All geometry merged by material UUID into
          ~10-14 draw calls total. Props already preloaded by DeferredTerrainPreloads
          (shared model paths) so zero additional fetch cost.
          See lib/three/land-ring-decorations.tsx for full perf contract. */}
      <group name="perf:land-ring-decorations" userData={{ perfChunk: 'land-ring-decorations' }}>
        <LandRingDecorations />
      </group>

      {/* Founder-ring luxury apartment buildings — procedural, ~3 draw calls for 3
          Type-A placements (body/gold/window merged per material bucket). Type B+C
          and full-ring fill follow after sign-off. See land-founder-apartments.tsx. */}
      <group name="perf:land-founder-apartments" userData={{ perfChunk: 'land-founder-apartments' }}>
        <LandFounderApartments />
      </group>

      {/* Phase B: when ?meshlets=1, ArenaBuildings is replaced by
          <MeshletBuildingsR3F /> which runs the rasterizer as a high-priority
          useFrame hook inside R3F's frame loop. Collision colliders are built
          from tilemap data not meshes, so dropping ArenaBuildings does NOT
          let players walk through buildings (world-colliders.ts line 248). */}
      <group name="perf:buildings" userData={{ perfChunk: 'buildings' }}>
        {USE_MESHLET_BUILDINGS ? <MeshletBuildingsR3F /> : <ArenaBuildings fullDetail={showBuildingDetail} />}
      </group>
      {showNpcs && (
        <group name="perf:wandering-npcs" userData={{ perfChunk: 'wandering-npcs' }}>
          <ArenaNpcs />
        </group>
      )}
      {showNpcs && (
        <group name="perf:location-npcs" userData={{ perfChunk: 'location-npcs' }}>
          <ArenaLocationNpcs />
        </group>
      )}
      {/* Multiplayer Phase 1: remote players in the same room. Local viewer is
          filtered out by isLocal so we never double-render the player avatar. */}
      {showNpcs && (
        <group name="perf:remote-players" userData={{ perfChunk: 'remote-players' }}>
          <RemotePlayers />
        </group>
      )}

      {/* Seaweed ground cover — merged geometry + TSL GPU animation (no InstancedMesh).
          Skipped on iOS/forceWebGL: 18,000 blades with per-vertex TSL positionNode wind
          animation compile to GLSL loops on WebGL2 backend and spike frame time past
          the A-series GPU budget on first draw. Plain WebGL path has no equivalent
          GPU-side procedural animation so the cost isn't recoverable. */}
      {showGroundCover && !FORCE_WEBGL && (
        <group name="perf:seaweed" userData={{ perfChunk: 'seaweed' }}>
          <MergedSeaweed />
        </group>
      )}

      {/* Northeast Kelp Forest — three merged tall-blade variants with heavy TSL wind.
          Ambient blades keep the water-fog and ground-cover governor gates;
          their TSL/GLSL wind now runs on both renderer backends. */}
      {showWaterFogParticles && showGroundCover && (
        <group name="perf:kelp-forest" userData={{ perfChunk: 'kelp-forest' }}>
          <KelpForestAmbient forceWebGL={FORCE_WEBGL} />
        </group>
      )}

      {/* Realm entrance stays mounted when the adaptive governor hides ground cover. */}
      <group name="perf:kelp-forest-portal" userData={{ perfChunk: 'kelp-forest-portal' }}>
        <KelpForestPortal forceWebGL={FORCE_WEBGL} />
      </group>

      {/* NPC possession controller — active when controlMode === 'npc' */}
      {showNpcs && <NpcController />}

      {/* Minimap position tracker — updates avatarPosition in gameStore so the
          minimap blip reflects whichever entity the user is currently following
          (avatar/NPC/camera). Player-avatar + NPC controller update the avatar position
          themselves; this covers explore/spectator mode (no entity → camera target). */}
      <MinimapPositionTracker />

      {/* Town center — guide NPC + scaled marketplace anchors (8× from original sizes) */}
      {showNpcs && (
        <group name="perf:quest-npc" userData={{ perfChunk: 'quest-npc' }}>
          <QuestNpc />
        </group>
      )}
      {showNpcs && (
        <group name="perf:town-guide" userData={{ perfChunk: 'town-guide' }}>
          <TownGuide />
        </group>
      )}
      <group name="perf:bazaar-stall" userData={{ perfChunk: 'bazaar-stall' }}>
        <BazaarStall />
      </group>
      <group name="perf:marketplace-stall" userData={{ perfChunk: 'marketplace-stall' }}>
        <MarketplaceStall />
      </group>
      {/* Quest + Bounty Pavilion — octagonal open-air pavilion 1100wu behind
          the town directory sign. Houses both the Quest Board (boards 1+2, left
          half) and the Bounty Board (boards 3+4, right half). Replaces the
          standalone BountyBoardObject mount. Click zones split L/R; bio-luminescent
          labels float above each half. See quest-bounty-pavilion.tsx for layout. */}
      <group name="perf:quest-bounty-pavilion" userData={{ perfChunk: 'quest-bounty-pavilion' }}>
        <QuestBountyPavilion />
      </group>
      {/* Wooden signboard directory — informational landmark at centre of stall row */}
      <group name="perf:town-directory-sign" userData={{ perfChunk: 'town-directory-sign' }}>
        <TownDirectorySign />
      </group>

      {/* Cove entertainment district beacon — neon marquee sign + glow ring
          Floats above the Cove building (slot 9/W) at world (-4160, 870, 0).
          Proximity prompt (isCoveProximate) drives the LocationHUD CTA. */}
      <group name="perf:cove-beacon" userData={{ perfChunk: 'cove-beacon' }}>
        <CoveBeacon />
      </group>

      {/* Glowing portal/tunnel archway at the east (+X, town-facing) base of the
          cove pyramid. Gives players a visible ENTER ▸ doorway to walk into.
          Component owns 2 point lights (cyan/magenta); total scene point lights = 5. */}
      <group name="perf:cove-entrance" userData={{ perfChunk: 'cove-entrance' }}>
        <CoveEntrance />
      </group>

      {/* NPC speech bubbles — Dom overlay, renders chat from SSE stream */}
      {showLabels && showNpcs && <NpcSpeechBubbles />}

      {/* NPC activity indicators — pulsing spheres + typing dots above NPCs */}
      {showActivityFx && showNpcs && (
        <group name="perf:activity-indicators" userData={{ perfChunk: 'activity-indicators' }}>
          <ActivityIndicators />
        </group>
      )}

      {/* Floating reward texts — spheres that float upward on token earn */}
      {showActivityFx && (
        <group name="perf:floating-texts" userData={{ perfChunk: 'floating-texts' }}>
          <FloatingTexts3D />
        </group>
      )}

      {/* Click-to-move — path-dot visuals for a programmatic warp/fast-travel
          (see click-to-move.tsx header). warpTo() is gated to controlMode
          === 'player' only, so this stays player-only too — mounting it in
          Autonomous would render dead space for a warp that can never fire. */}
      {isGame && !staticOnly && controlMode === 'player' && <ClickToMove />}

      {/* Player avatar lobster — the LOCALLY-DRIVEN body. Renders ONLY in
          'player' (Controlled): the human is driving it directly, camera
          follows it (FPSFollowCamera above).
          §B.1b (double-body fix, 2026-07-08): Autonomous does NOT mount this
          — the visible body there is the server-streamed `ocb-` agent bot
          (npc-simulation.ts registerAgentBot → npc.ts autonomousBodyId roster,
          rendered by ArenaNpcs like any other agent bot), which the
          FPSFollowCamera/MinimapPositionTracker branches above now follow
          instead of avatarPositionRef. Mounting PlayerAvatar in BOTH modes was
          the bug: the human's local avatar rendered at its frozen last
          position WHILE the streamed agent body also rendered nearby — two
          visible copies of the same character. Explore = floating spectator
          (no character), NPC = user controls a spawned NPC. */}
      {isGame && !staticOnly && controlMode === 'player' && (
        <group name="perf:player-avatar" userData={{ perfChunk: 'player-avatar' }}>
          <PlayerAvatar />
        </group>
      )}
    </>
  );
});

// ---------------------------------------------------------------------------
// WebGPU renderer factory
// ---------------------------------------------------------------------------
// Three.js 0.185 ships a WebGPURenderer that auto-falls back to WebGL2.
// R3F v9 supports async gl factory: (defaultProps) => Promise<Renderer>.
// The renderer and TSL materials share the static three/webgpu import above.
// ---------------------------------------------------------------------------

function getCanvasCssSize(canvas: HTMLCanvasElement): { width: number; height: number } | null {
  const rect = canvas.getBoundingClientRect();
  let width = Math.round(rect.width);
  let height = Math.round(rect.height);

  if ((width <= 0 || height <= 0) && canvas.parentElement) {
    const parentRect = canvas.parentElement.getBoundingClientRect();
    width = Math.round(parentRect.width);
    height = Math.round(parentRect.height);
  }

  if ((width <= 0 || height <= 0) && typeof window !== 'undefined') {
    width = window.innerWidth;
    height = window.innerHeight;
  }

  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

async function waitForCanvasCssSize(canvas: HTMLCanvasElement): Promise<{ width: number; height: number }> {
  // WebGPU allocates depth/stencil textures during init(). If init sees the
  // default HTML canvas size (300x150), later R3F color-attachment resize causes
  // WebGPU validation failures. Wait briefly for layout to settle before init.
  for (let i = 0; i < 10; i++) {
    const size = getCanvasCssSize(canvas);
    if (size && size.width !== 300 && size.height !== 150) return size;
    if (size && (size.width > 300 || size.height > 150)) return size;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  return getCanvasCssSize(canvas) ?? { width: 1, height: 1 };
}

// iOS Safari does not have navigator.gpu even in recent versions. When WebGPU
// is unavailable, three/webgpu's WebGPUBackend.init() reaches the line
//   await navigator.gpu.requestAdapter(...)
// and throws TypeError because navigator.gpu is undefined — even though the
// getFallback() path catches it and falls back to WebGLBackend, iOS Safari
// may already have entered a broken canvas state before the catch fires.
// Passing forceWebGL:true skips the WebGPU adapter path entirely and goes
// straight to the WebGL2 backend while retaining full TSL node-material support.
const IOS_SAFARI =
  typeof navigator !== 'undefined' &&
  /iP(hone|ad|od)/i.test(navigator.userAgent) &&
  /WebKit/i.test(navigator.userAgent) &&
  !/CriOS|FxiOS|OPiOS|mercury/i.test(navigator.userAgent);

// Also force WebGL when navigator.gpu is completely absent — catches any
// other browser/device that lacks WebGPU support.
const WEBGPU_ABSENT =
  typeof navigator !== 'undefined' && !('gpu' in navigator);

// Integrated-GPU stability gate (2026-05-21). Browser WebGPU on integrated
// GPUs periodically rotates the compositor's swap-chain texture's device
// without notifying the renderer, firing
// `THREE.[Texture ...] is associated with [Device], and cannot be used
// with [Device]` every frame during copyFramebufferToTexture and rendering
// the scene as a solid black void. The error originates in Chromium's
// D3D/Metal WebGPU backend; no Three.js or app-level recovery path exists
// short of full renderer + scene tear-down on device-loss (Phase 7 task).
// Industry-standard workaround across WebGPU production engines is to
// detect integrated-GPU class and route them to the WebGL2 backend, which
// compiles the same TSL materials via GLSLNodeBuilder — visually identical,
// no swap-chain device-rotation issue. Dedicated desktop GPUs (NVIDIA /
// AMD / Apple M-series) still get WebGPU.
//
// 2026-05-23 — A/B override added: `?webgpu=1` query string forces the
// WebGPU path even on integrated GPUs. Lets us empirically test whether
// Chrome's WebGPU swap-chain bug has been fixed in current Chrome (the
// Needle Tools meshlet demo at three-meshlets-z23hmxbz1jwlff.needle.run
// runs at 41 FPS full-res on this Iris Xe, suggesting the bug is gone).
// The query is opt-in so the default-safe WebGL2 path stays in place for
// all other users. Once we've validated the WebGPU path is stable across
// sessions, the LOW_END_GPU_DETECTED branch can be removed from FORCE_WEBGL.
// ?meshlets=1 ALSO implies WebGPU override — the rasterizer's TSL compute
// shaders emit WGSL pointer-atomic syntax (`atomicStore(&buf, 0u)`) which
// CANNOT compile to GLSL. If the renderer falls back to WebGL2 on a
// low-end GPU detect, the rasterizer floods the console with shader compile
// errors and renders nothing. So treat ?meshlets=1 as ?webgpu=1 too.
const FORCE_WEBGPU_OVERRIDE =
  typeof window !== 'undefined' &&
  (new URLSearchParams(window.location.search).get('webgpu') === '1' ||
   new URLSearchParams(window.location.search).get('meshlets') === '1');
const FORCE_WEBGL = FORCE_WEBGPU_OVERRIDE
  ? (IOS_SAFARI || WEBGPU_ABSENT)              // override: drop the low-end gate
  : (IOS_SAFARI || WEBGPU_ABSENT || LOW_END_GPU_DETECTED);

if (typeof window !== 'undefined') {
  console.log(
    `[World3D] GPU path: ${FORCE_WEBGL ? 'forceWebGL (WebGL2+TSL)' : 'WebGPU'} — iOS:${IOS_SAFARI} noGPU:${WEBGPU_ABSENT} lowEnd:${LOW_END_GPU_DETECTED} webgpuOverride:${FORCE_WEBGPU_OVERRIDE}`,
  );
}

async function createWebGPURenderer(canvas: HTMLCanvasElement): Promise<any> {
  // -------------------------------------------------------------------------
  // Fix: depth-stencil attachment size mismatch (300×150 vs actual CSS size)
  //
  // Problem: when the async gl factory runs, the canvas element is in the DOM
  // but the browser may not have flushed the CSS layout pass yet. The canvas
  // still has its default HTML attribute dimensions (300×150). WebGPURenderer
  // creates its depth buffer at those dimensions inside init(). R3F then calls
  // renderer.setSize() from its ResizeObserver, which resizes color attachments
  // but does NOT recreate the depth/stencil texture in Three.js r182. Every
  // subsequent BeginRenderPass fails WebGPU validation: depth (300×150) ≠
  // color (actual size).
  //
  // Fix: force a synchronous layout reflow via getBoundingClientRect() to get
  // the true CSS-resolved dimensions, then stamp those onto the canvas's width/
  // height attributes before constructing the renderer. WebGPURenderer reads
  // canvas.width/height for the initial depth buffer allocation, so this
  // ensures the depth buffer is created at the correct size from the start.
  // -------------------------------------------------------------------------
  const { width: cssW, height: cssH } = await waitForCanvasCssSize(canvas);
  // -------------------------------------------------------------------------
  // FIX (2026-05-21 v2): depth-stencil size mismatch — first attempt used the
  // raw devicePixelRatio (capped at 2). That was wrong: R3F's <Canvas dpr=...
  // prop CAPS the pixel ratio further. On Iris/low-end GPUs the cap is
  // [0.55, 0.7]; on dedicated [0.75, 1]. R3F applies its dpr AFTER our factory
  // returns by calling setPixelRatio + setSize, overriding our stamp. Result:
  // depth allocated at 1776×1238 (our raw-DPR guess) but R3F sized the
  // backbuffer to 828×577 (Iris cap × cssDims) — same mismatch, mirrored.
  //
  // The fix is to compute the IDENTICAL dpr R3F will resolve from the same
  // LOW_END_GPU_DETECTED flag the Canvas prop reads. Stamp canvas dims at
  // that ratio; setPixelRatio to match; init; setSize. R3F's later setSize
  // at the same (cssW, cssH) with the same pixelRatio is a true no-op.
  //
  // KEEP THIS IN SYNC with the <Canvas dpr={...}> prop below.
  // -------------------------------------------------------------------------
  const dprRange = LOW_END_GPU_DETECTED ? LOW_END_DPR_RANGE : STANDARD_DPR_RANGE;
  const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const dpr = Math.max(dprRange[0], Math.min(rawDpr, dprRange[1]));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  // Use WebGPURenderer from the SAME static 'three/webgpu' import at the top of
  // this module (via the THREE namespace). Dynamic import('three/webgpu') would
  // create a SECOND webpack chunk with a separate module instance — its IndexNode,
  // NodeShaderStage, etc. would be different objects from those used by materials
  // registered via extend(THREE). That mismatch causes IndexNode.VERTEX to appear
  // undefined during shader compilation → SES_UNCAUGHT_EXCEPTION crash on first
  // load for any browser without navigator.gpu (Chrome without WebGPU, Brave, etc).
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,
    alpha: false,
    reversedDepthBuffer: USE_REVERSED_DEPTH_BUFFER,
    // forceWebGL: bypass the navigator.gpu adapter path on iOS Safari and any
    // browser where WebGPU is absent. WebGLBackend with TSL (GLSLNodeBuilder)
    // compiles all MeshBasicNodeMaterial / PointsNodeMaterial / MeshStandardNodeMaterial
    // to GLSL — same visual output, no WebGPU negotiation, no iOS black-screen.
    forceWebGL: FORCE_WEBGL,
    // powerPreference is not a WebGPURenderer option; low-power is handled
    // by the browser's GPU adapter selection (it prefers integrated GPU by default)
  });
  renderer.setPixelRatio(dpr);
  // WebGPURenderer.render() throws if not initialized — must await init()
  // With forceWebGL:true, init() goes straight to WebGLBackend (no adapter request).
  // Without forceWebGL, init() tries WebGPU first then falls back to WebGL2.
  await renderer.init();
  renderer.setClearColor(SKY_COLOR, 1);
  renderer.setClearAlpha?.(1);
  renderer.setSize(cssW, cssH, false);

  // Device-loss handler — log and attempt page reload on unexpected loss
  try {
    const device = (renderer as any).backend?.device;
    if (device?.lost) {
      device.lost.then((info: any) => {
        console.error('[World3D] GPU device lost:', info.reason, info.message);
        if (info.reason === 'unknown') {
          // Unexpected loss (driver crash, resource pressure) — reload after delay
          setTimeout(() => window.location.reload(), 500);
        }
      });
    }
  } catch {
    // Device-loss API may not be available on WebGL fallback — safe to ignore
  }

  return renderer;
}

// ---------------------------------------------------------------------------
// Main exported Canvas component
// ---------------------------------------------------------------------------
function ContextLostFallback() {
  return (
    <div className="absolute inset-0 bg-[#061520] flex items-center justify-center">
      <div className="text-center max-w-md px-6">
        <div className="text-5xl mb-4">🦞</div>
        <h2 className="font-clawville text-2xl text-cyan-300 mb-3">GPU Overloaded</h2>
        <p className="text-white/50 text-sm mb-6">
          Your graphics driver ran out of memory. Try refreshing or use a device with a dedicated GPU.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-2 bg-cyan-600 text-white rounded-lg text-sm font-bold hover:bg-cyan-500 transition-colors"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

function World3DCanvas({ mode, perfFlags }: World3DCanvasProps) {
  const resolvedPerfFlags = useAdaptiveWorldPerfFlags(perfFlags);
  const [frameloopMode, setFrameloopMode] = useState<'always' | 'never'>('always');
  const warmupGateRef = useRef<WorldWarmupGate | null>(null);

  useEffect(() => () => {
    warmupGateRef.current?.dispose();
    warmupGateRef.current = null;
  }, []);

  // Stable async gl factory — R3F v9 awaits this before rendering.
  // Returns a WebGPURenderer (with automatic WebGL2 fallback built in).
  // If primary init fails, retries a fresh WebGPURenderer forced to WebGL2.
  const glFactory = useCallback(
    async (defaultProps: { canvas: HTMLCanvasElement }) => {
      try {
        return await createWebGPURenderer(defaultProps.canvas);
      } catch (err) {
        console.warn('[World3D] WebGPURenderer init failed, retrying with forceWebGL on fresh canvas:', err);
        // Use THREE.WebGPURenderer from the static import — same module instance
        // as the materials registered via extend(THREE). A dynamic import would
        // create a separate chunk and separate IndexNode instance → shader crash.
        // Fresh canvas prevents double-binding the R3F canvas that just failed.
        const fallbackCanvas = document.createElement('canvas');
        fallbackCanvas.width = defaultProps.canvas.width || window.innerWidth;
        fallbackCanvas.height = defaultProps.canvas.height || window.innerHeight;
        const fallbackRenderer = new THREE.WebGPURenderer({
          canvas: fallbackCanvas,
          antialias: false,
          alpha: false,
          // Match the primary renderer's constructor-time depth convention.
          reversedDepthBuffer: USE_REVERSED_DEPTH_BUFFER,
          forceWebGL: true,
        });
        await fallbackRenderer.init();
        fallbackRenderer.setClearColor(SKY_COLOR, 1);
        fallbackRenderer.setClearAlpha?.(1);
        fallbackRenderer.setSize(fallbackCanvas.width, fallbackCanvas.height, false);
        return fallbackRenderer;
      }
    },
    [],
  );

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'absolute',
        top: 0,
        left: 0,
      }}
    >
      <Canvas
        gl={glFactory as any}
        // 2026-06-06 — DPR floor dropped to [0.5, 0.65] on Iris Xe/mobile.
        //   Integrated/mobile GPU (Iris Xe, Adreno, Mali, Apple integrated):
        //     [0.5, 0.65] → 18% fewer fragments than [0.55, 0.7], 65% fewer than [1, 1].
        //   Discrete desktop GPU: [0.75, 1] (unchanged from prior).
        // History: 0.5 was tried in 2026-05-11 and judged too blurry on its own.
        // After Wave 1 NPC cap + spring-bone LOD + pavilion VRAM relief landed,
        // the scene is much less fragment-bound, so dropping the cap to 0.5 floor
        // is now visually acceptable on the device classes that need it.
        dpr={LOW_END_GPU_DETECTED ? LOW_END_DPR_RANGE : STANDARD_DPR_RANGE}
        // MUST be "always" AT CREATION — R3F v9 with an async gl factory skips
        // calling the factory entirely when frameloop="never" is set, so the
        // Canvas never initializes. After onCreated, this React state-backed
        // prop is the source of truth: root.configure() re-applies it on every
        // Canvas re-render (installed events-5a94e5eb.esm.js:15670), so the prop
        // and live store must pause/resume together throughout WorldWarmup.
        frameloop={frameloopMode}
        camera={{
          fov: 50,
          near: 1,
          // far: 11500 (pulled back 2026-06-20 from 14000). The 06-15 bump to
          // 14000 for the 576x576 world re-exposed distant low-res geometry that
          // reads as pixelly on the Iris-Xe low DPR; fog now fully hides it by
          // 10500wu (fog.far ≤ camera.far invariant), so culling past 11500
          // reclaims fill/geometry cost with nothing visible lost. Building ring
          // (~4160wu radius, ≤8320wu across) stays well within view.
          far: 11500,
          // Game mode: tighter starting position reinforces the bigger buildings/characters.
          // Pulled in from [0,700,1600] after proportions pass (2026-04-16).
          position: mode === 'game' ? [0, 600, 1300] : [0, 560, 1000],
        }}
        onCreated={(state) => {
          // 2026-07-14: pause the LIVE R3F store immediately, while retaining
          // frameloop="always" at Canvas creation for the async gl factory.
          // SeaLoadingScreen resets __W3D_READY=false before this canvas mounts,
          // so SPA remounts intentionally re-run the gate for the fresh renderer.
          const pauseForWarmup = (window as any).__W3D_READY !== true;
          warmupGateRef.current?.dispose();
          const warmupGate = createWorldWarmupGate(state, pauseForWarmup, setFrameloopMode);
          warmupGateRef.current = warmupGate;

          const { scene, gl } = state;
          scene.background = SKY_COLOR;
          gl.setClearColor(SKY_COLOR, 1);
          gl.setClearAlpha?.(1);
          gl.shadowMap.enabled = resolvedPerfFlags.shadows;
          // PERF: do NOT call gl.setPixelRatio() here — it overrides the Canvas
          // dpr={[0.75, 1]} prop cap. R3F resolves the DPR from the prop before
          // onCreated fires; a manual setPixelRatio resets it and can raise DPR
          // above the intended cap on devices where devicePixelRatio > 1.0.
          // The dpr prop handles clamping correctly without this call.
          if ((gl as any).isWebGPURenderer) {
            const backend = (gl as any).backend;
            const name = backend?.constructor?.name ?? 'unknown';
            console.log(`[World3D] Using WebGPURenderer (backend: ${name})`);
          } else {
            console.log('[World3D] Using WebGLRenderer');
          }
          // Preserve kickRenderLoop's historical onCreated timing. In installed
          // R3F 9.5 invalidate() is an explicit no-op while frameloop="never",
          // while the diagnostic/__W3D_CANVAS_READY RAF still runs as before.
          kickRenderLoop(state);
          if (!pauseForWarmup) {
            // Defensive already-ready/no-overlay path: if no loader reset ran,
            // the loop was never paused, so retain today's immediate healer.
            forceFirstPaintSizeSync(state);
          }
        }}
      >
        <SceneContents mode={mode} perfFlags={resolvedPerfFlags} />
      </Canvas>
    </div>
  );
}

export default World3DCanvas;
