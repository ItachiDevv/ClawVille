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
import ArenaBuildings from '@/lib/three/arena-buildings';
import MeshletBuildingsR3F from '@/lib/three/meshlet/meshlet-buildings-r3f';
import ArenaNpcs from '@/lib/three/arena-npcs';
import ArenaLocationNpcs from '@/lib/three/arena-location-npcs';
import PlayerAvatar from '@/lib/three/player-avatar';
import NpcController from '@/lib/three/npc-controller';
import MergedSeaweed from '@/lib/three/merged-seaweed';
import QuestNpc from '@/lib/three/quest-npc';
import TownGuide from '@/lib/three/town-guide';
import BazaarStall from '@/lib/three/bazaar-stall';
import MarketplaceStall from '@/lib/three/marketplace-stall';
import QuestBountyPavilion from '@/lib/three/quest-bounty-pavilion';
import AuctionPodium from '@/lib/three/auction-podium';
import TownDirectorySign from '@/lib/three/town-directory-sign';
import ActivityIndicators from '@/lib/three/activity-indicators';
import FloatingTexts3D from '@/lib/three/floating-text-3d';
import NpcSpeechBubbles from '@/lib/three/npc-speech-bubbles';
import ClickToMove from '@/lib/three/click-to-move';
import { KTX2LoaderSetup } from '@/lib/three/ktx2-loader-setup';
import { MeshoptLoaderSetup } from '@/lib/three/meshopt-loader-setup';
import { WorldLabelsOverlayMount } from '@/lib/three/world-labels-overlay';
import JumpTicker from '@/lib/three/jump-ticker';
import { jumpState } from '@/lib/three/jump-state';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { DEFAULT_WORLD_PERF_FLAGS, type WorldPerfFlags } from '@/lib/three/PerfAudit';

// ---------------------------------------------------------------------------
// SeaLoadingScreen progress bridge — wire THREE.DefaultLoadingManager.onProgress
// to window.__W3D_PROGRESS once at module load. The pre-mount loader screen
// prefers this real ratio (assets loaded / assets total) over its simulated
// curve so the bar tracks actual download progress instead of stalling at the
// fast-tail of an exponential ease. drei's useGLTF, useVRM, KTX2Loader and
// MeshoptLoader all route through DefaultLoadingManager, so this captures
// every GLB / VRM / texture the world streams in.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  const _mgr = THREE.DefaultLoadingManager;
  const _prevOnProgress = _mgr.onProgress?.bind(_mgr);
  _mgr.onProgress = (url: string, loaded: number, total: number) => {
    (window as unknown as { __W3D_PROGRESS?: number }).__W3D_PROGRESS =
      total > 0 ? Math.max(0, Math.min(1, loaded / total)) : 0;
    if (_prevOnProgress) _prevOnProgress(url, loaded, total);
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
const LOW_END_GPU_DETECTED: boolean = (() => {
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return true; // no webgl at all → almost certainly low-end
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '')
      : '';
    const lowEnd =
      /\bintel\b|\biris\b|\buhd graphics\b|\bhd graphics\b|\bgma\b|adreno|mali|powervr|apple gpu/i.test(
        renderer,
      );
    // Touch / coarse-pointer devices are almost universally low-end mobile.
    const isTouch =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    // Release the probe context so Firefox (strict context-count limit) doesn't
    // waste one of its ~16 WebGL2 slots on this throwaway canvas.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return lowEnd || isTouch;
  } catch {
    return false;
  }
})();
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
const FOG_COLOR = new THREE.Color(0x0e3458); // Underwater haze — matches sky

export type WorldMode = 'game' | 'arena';

interface World3DCanvasProps {
  mode: WorldMode;
  perfFlags?: Partial<WorldPerfFlags>;
}

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
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
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
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

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
  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    const { controlMode, possessedNpcId } = useGameStore.getState();

    // Determine the character's 2D game-space position.
    // Use avatarPositionRef (module-scope, zero React overhead) for the player path —
    // the ref is always up-to-date at 60 Hz even when the reactive store is throttled.
    let gameX: number;
    let gameY: number;

    if (controlMode === 'npc' && possessedNpcId) {
      const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
      if (!npc) return;
      gameX = npc.x;
      gameY = npc.y;
    } else {
      // 'player' or 'autonomous' — follow player avatar
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
    tgt.x += (worldX - tgt.x) * 0.1;
    tgt.y += ((CHAR_TARGET_Y + extraY) - tgt.y) * 0.1;
    tgt.z += (worldZ - tgt.z) * 0.1;

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
function kickRenderLoop(state: any): void {
  if (typeof state.invalidate === 'function') {
    state.invalidate();
  }
  // Delay __W3D assignment until after the first rendered frame. On iOS
  // WebGL2, shaders compile synchronously on first draw — setting __W3D in
  // onCreated (before any frame renders) let the loading screen dismiss while
  // the canvas was still blank during shader compilation, producing the
  // "loaded twice" appearance. The RAF fires after the first paint.
  if (typeof window !== 'undefined') {
    requestAnimationFrame(() => {
      (window as any).__W3D = state;
      // Convenience helper for MCP browser automation / devtools — call
      // window.__W3D_step() to manually advance one frame when the tab is
      // hidden and RAF is throttled to 0 Hz.
      (window as any).__W3D_step = () =>
        state.advance(performance.now() / 1000, true);
    });
  }
}

// ---------------------------------------------------------------------------
// PreCompilePipelines — WebGPU pipeline pre-compilation
// ---------------------------------------------------------------------------
// Three.js WebGPURenderer.compileAsync(scene, camera) walks the scene graph
// and asynchronously compiles every render pipeline needed for the current
// scene. Calling it AFTER the first R3F commit (all child meshes are in the
// scene) moves the 274ms post-mount main-thread block into the loading-spinner
// phase so users never see the hitch.
//
// We use useEffect + requestAnimationFrame so the call fires after the first
// React commit paint, by which point all sibling components (ArenaTerrain,
// ArenaBuildings, etc.) have been added to scene.children.  Runs once only.
// ---------------------------------------------------------------------------
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
    } else if (mode === 'player' || mode === 'autonomous') {
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

function PreCompilePipelines() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    // DEBUG PROBE: expose scene/camera/renderer globally so CDP can introspect
    // scale issues without an extra deploy cycle. Safe — no runtime cost.
    if (typeof window !== 'undefined') {
      (window as any).__R3F = { scene, camera, gl };
    }
    const raf = requestAnimationFrame(() => {
      if (typeof (gl as any).compileAsync === 'function') {
        (gl as any).compileAsync(scene, camera).catch((err: unknown) => {
          console.warn('[World3D] compileAsync failed:', err);
        });
      }
    });
    return () => cancelAnimationFrame(raf);
    // gl/scene/camera are stable R3F refs — intentionally omitted from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
// StaggeredTextureUpload — spread GPU texture uploads across idle time
// ---------------------------------------------------------------------------
// Problem: after WebP decode, uploading all RGBA8 textures to the GPU in one
// frame causes a 400ms+ long task on Iris Xe (the WebP decode → GPU upload
// pipeline is CPU-bound and unthreaded).
//
// Old fix (BATCH=2 per rAF tick): 200 textures × 1 frame each = 200 frames to
// upload everything. At 12fps that's ~17s of "avatar not visible". The fixed
// per-frame count wastes the frame budget on fast machines and bottlenecks
// slow ones.
//
// New fix: use requestIdleCallback with a 6ms budget per slice. The browser
// schedules the slice during idle time after a frame paints, so we never
// steal the frame budget — but on fast hardware we burn through ~6ms of
// texture uploads per idle slice (~1-2 textures per slice on Iris Xe, more
// on a desktop GPU). On a fast machine the whole 200-texture pool finishes
// in a handful of slices (< 200ms total). On slow hardware it self-paces.
//
// Fallback for Safari (no rIC): rAF with BATCH=4 (still 2× the old rate).
// ---------------------------------------------------------------------------
const IDLE_SLICE_BUDGET_MS = 6;
const RAF_FALLBACK_BATCH = 4;

// All standard texture slot names on MeshStandardMaterial and related.
const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
  'emissiveMap', 'lightMap', 'envMap', 'alphaMap', 'bumpMap',
  'displacementMap', 'clearcoatMap', 'clearcoatNormalMap',
  'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'transmissionMap', 'thicknessMap', 'specularMap', 'specularColorMap',
] as const;

function StaggeredTextureUpload() {
  const { gl, scene } = useThree();

  useEffect(() => {
    // Verify initTexture is available (guard for unusual renderer builds)
    if (typeof (gl as any).initTexture !== 'function') {
      console.warn('[World3D] StaggeredTextureUpload: renderer.initTexture() not available, skipping');
      return;
    }

    // Wait two rAF ticks: first tick is PreCompilePipelines' compileAsync kick,
    // second tick is after at least one compile cycle has started.
    let outerRaf: number;
    let innerRaf: number;
    // Hoisted so the useEffect cleanup can cancel in-progress upload batches.
    // Need both rIC and rAF refs because we pick one per browser capability.
    let uploadRaf: number | undefined;
    let idleHandle: number | undefined;

    outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        // Collect all textures referenced by mesh materials in scene
        const seen = new Set<THREE.Texture>();

        scene.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const mat of mats) {
            if (!mat) continue;
            for (const slot of TEXTURE_SLOTS) {
              const tex = (mat as any)[slot];
              if (tex instanceof THREE.Texture && !seen.has(tex)) {
                seen.add(tex);
              }
            }
          }
        });

        const unique = Array.from(seen);
        if (unique.length === 0) return;

        const hasIdle = typeof (window as any).requestIdleCallback === 'function';
        console.log(`[World3D] StaggeredTextureUpload: uploading ${unique.length} textures via ${hasIdle ? 'rIC' : 'rAF'} budget`);

        let i = 0;

        function uploadIdle(deadline: IdleDeadline) {
          const t0 = performance.now();
          while (
            i < unique.length &&
            (deadline.timeRemaining() > 1 || performance.now() - t0 < IDLE_SLICE_BUDGET_MS)
          ) {
            try {
              (gl as any).initTexture(unique[i]);
            } catch (err) {
              console.warn('[World3D] initTexture error (non-fatal):', err);
            }
            i++;
          }
          if (i < unique.length) {
            idleHandle = (window as any).requestIdleCallback(uploadIdle, { timeout: 200 });
          } else {
            idleHandle = undefined;
            console.log('[World3D] StaggeredTextureUpload: all textures uploaded');
          }
        }

        function uploadRafFallback() {
          const t0 = performance.now();
          const end = Math.min(i + RAF_FALLBACK_BATCH, unique.length);
          for (; i < end; i++) {
            try {
              (gl as any).initTexture(unique[i]);
            } catch (err) {
              console.warn('[World3D] initTexture error (non-fatal):', err);
            }
          }
          const elapsed = performance.now() - t0;
          if (elapsed > 20) {
            console.warn(`[World3D] StaggeredTextureUpload: batch took ${elapsed.toFixed(1)}ms`);
          }
          if (i < unique.length) {
            uploadRaf = requestAnimationFrame(uploadRafFallback);
          } else {
            uploadRaf = undefined;
            console.log('[World3D] StaggeredTextureUpload: all textures uploaded');
          }
        }

        if (hasIdle) {
          idleHandle = (window as any).requestIdleCallback(uploadIdle, { timeout: 200 });
        } else {
          uploadRaf = requestAnimationFrame(uploadRafFallback);
        }
      });
    });

    return () => {
      cancelAnimationFrame(outerRaf);
      cancelAnimationFrame(innerRaf);
      if (uploadRaf !== undefined) cancelAnimationFrame(uploadRaf);
      if (idleHandle !== undefined && typeof (window as any).cancelIdleCallback === 'function') {
        (window as any).cancelIdleCallback(idleHandle);
      }
    };
    // gl/scene are stable R3F refs — intentionally omitted from deps
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
      {/* Pre-compile WebGPU render pipelines once after the first frame commit.
          Eliminates the 274ms post-mount main-thread hitch. No-ops on WebGL. */}
      <PreCompilePipelines />

      {/* Stagger GPU texture uploads across frames to prevent the 400ms+
          long task caused by uploading all WebP-decoded textures simultaneously.
          Fires 2 frames after mount, uploads TEXTURE_UPLOAD_BATCH textures/frame. */}
      <StaggeredTextureUpload />

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
            player            → FPSFollowCamera (follows player avatar)
            autonomous        → FPSFollowCamera (follows player avatar)
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
          New: near=5000 far=10000 (camera.far=10000 matched below). Far-ring
          buildings at 5493wu start fogging at ~10%, fully fogged by 10000wu,
          depth-clipped at 10000wu. Real distance culling for the half of the
          world the player isn't looking at. */}
      {showWaterFogParticles && <fog attach="fog" args={[FOG_COLOR, 5000, 10000]} />}

      {/* Shared world geometry */}
      <group name="perf:terrain" userData={{ perfChunk: 'terrain' }}>
        <ArenaTerrain />
      </group>
      {/* Phase B: when ?meshlets=1, ArenaBuildings is replaced by
          <MeshletBuildingsR3F /> which runs the rasterizer as a high-priority
          useFrame hook inside R3F's frame loop. Collision colliders are built
          from tilemap data not meshes, so dropping ArenaBuildings does NOT
          let players walk through buildings (world-colliders.ts line 248). */}
      <group name="perf:buildings" userData={{ perfChunk: 'buildings' }}>
        {USE_MESHLET_BUILDINGS ? <MeshletBuildingsR3F /> : <ArenaBuildings />}
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

      {/* Seaweed ground cover — merged geometry + TSL GPU animation (no InstancedMesh).
          Skipped on iOS/forceWebGL: 4500 blades with per-vertex TSL positionNode wind
          animation compile to GLSL loops on WebGL2 backend and spike frame time past
          the A-series GPU budget on first draw. Plain WebGL path has no equivalent
          GPU-side procedural animation so the cost isn't recoverable. */}
      {showWaterFogParticles && !FORCE_WEBGL && (
        <group name="perf:seaweed" userData={{ perfChunk: 'seaweed' }}>
          <MergedSeaweed />
        </group>
      )}

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
      <group name="perf:auction-podium" userData={{ perfChunk: 'auction-podium' }}>
        <AuctionPodium />
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

      {/* NPC speech bubbles — Dom overlay, renders chat from SSE stream */}
      {showLabels && showNpcs && <NpcSpeechBubbles />}

      {/* NPC activity indicators — pulsing spheres + typing dots above NPCs */}
      {showWaterFogParticles && showNpcs && (
        <group name="perf:activity-indicators" userData={{ perfChunk: 'activity-indicators' }}>
          <ActivityIndicators />
        </group>
      )}

      {/* Floating reward texts — spheres that float upward on token earn */}
      {showWaterFogParticles && (
        <group name="perf:floating-texts" userData={{ perfChunk: 'floating-texts' }}>
          <FloatingTexts3D />
        </group>
      )}

      {/* Click-to-move — only in modes where the user drives a character */}
      {isGame && !staticOnly && (controlMode === 'player' || controlMode === 'autonomous') && <ClickToMove />}

      {/* Player avatar lobster — only renders when an agent is connected (player/autonomous).
          Explore = floating spectator (no character), NPC = user controls a spawned NPC. */}
      {isGame && !staticOnly && (controlMode === 'player' || controlMode === 'autonomous') && (
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
// Three.js 0.182 ships a WebGPURenderer that auto-falls back to WebGL2.
// R3F v9 supports async gl factory: (defaultProps) => Promise<Renderer>.
// We dynamically import the WebGPU build to avoid bundling it when unsupported.
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
  const dprRange: readonly [number, number] = LOW_END_GPU_DETECTED ? [0.55, 0.7] : [0.75, 1];
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
  // Stable async gl factory — R3F v9 awaits this before rendering.
  // Returns a WebGPURenderer (with automatic WebGL2 fallback built in).
  // Falls back to standard WebGLRenderer if the dynamic import or init fails.
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
          forceWebGL: true,
        });
        await fallbackRenderer.init();
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
        // 2026-05-22 — DPR floor dropped to [0.5, 0.65] on Iris Xe (was [0.55, 0.7]).
        //   Integrated/mobile GPU (Iris Xe, Adreno, Mali, Apple integrated):
        //     [0.5, 0.65] → 18% fewer fragments than [0.55, 0.7], 65% fewer than [1, 1].
        //   Discrete desktop GPU: [0.75, 1] (unchanged from prior).
        // History: 0.5 was tried in 2026-05-11 and judged too blurry on its own.
        // After Wave 1 NPC cap + spring-bone LOD + pavilion VRAM relief landed,
        // the scene is much less fragment-bound, so dropping the cap to 0.5 floor
        // is now visually acceptable on the device classes that need it.
        dpr={LOW_END_GPU_DETECTED ? [0.55, 0.7] : [0.75, 1]}
        // MUST be "always" — R3F v9 with an async gl factory appears to skip
        // calling the factory entirely when frameloop="never" is set, so the
        // Canvas never initializes. "always" drives the normal RAF loop.
        frameloop="always"
        camera={{
          fov: 50,
          near: 1,
          // far: 10000 (tightened 2026-05-22 from 16000) matches fog.far for
          // real distance culling. World half-width is 5760 wu, so 10000 still
          // covers any visible neighbor while clipping the far half of the map.
          far: 10000,
          // Game mode: tighter starting position reinforces the bigger buildings/characters.
          // Pulled in from [0,700,1600] after proportions pass (2026-04-16).
          position: mode === 'game' ? [0, 600, 1300] : [0, 560, 1000],
        }}
        onCreated={(state) => {
          const { scene, gl } = state;
          scene.background = SKY_COLOR;
          gl.shadowMap.enabled = perfFlags?.shadows ?? DEFAULT_WORLD_PERF_FLAGS.shadows;
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
          kickRenderLoop(state);
        }}
      >
        <SceneContents mode={mode} perfFlags={perfFlags} />
      </Canvas>
    </div>
  );
}

export default World3DCanvas;
