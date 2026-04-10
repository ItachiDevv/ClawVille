'use client';

import { useRef, useEffect, useCallback, memo } from 'react';
import { Canvas, useFrame, extend } from '@react-three/fiber';
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
import ArenaNpcs from '@/lib/three/arena-npcs';
import ArenaLocationNpcs from '@/lib/three/arena-location-npcs';
import ArenaFx from '@/lib/three/arena-fx';
import PlayerPet from '@/lib/three/player-pet';
import NpcController from '@/lib/three/npc-controller';
import MergedSeaweed from '@/lib/three/merged-seaweed';
import UnderwaterAtmosphere from '@/lib/three/underwater-atmosphere';
import UnderwaterLightRays from '@/lib/three/underwater-light-rays';
import { useGameStore } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const CAM_PAN_SPEED = 300;
const SKY_COLOR = new THREE.Color(0x0a2a4a); // Deeper ocean blue
const FOG_COLOR = new THREE.Color(0x0e3458); // Underwater haze — matches sky

export type WorldMode = 'game' | 'arena';

interface World3DCanvasProps {
  mode: WorldMode;
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
const _followOffset = new THREE.Vector3();
const _followTarget = new THREE.Vector3();

// Follow distance: how many units the camera sits behind/above the character.
// OrbitControls manages the actual angle — we just enforce the radial distance.
const FPS_FOLLOW_DISTANCE = 80;
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

    const dTheta =
      (_arrowKeys.arrowleft ? 1 : 0) - (_arrowKeys.arrowright ? 1 : 0);
    // ArrowUp = look up (phi increases toward PI = camera below target)
    // ArrowDown = look down (phi decreases toward 0 = camera above target)
    const dPhi =
      (_arrowKeys.arrowup ? 1 : 0) + (_arrowKeys.arrowdown ? -1 : 0);

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

    if (dx === 0 && dz === 0) return;

    const len = Math.sqrt(dx * dx + dz * dz);
    dx = (dx / len) * CAM_PAN_SPEED * delta;
    dz = (dz / len) * CAM_PAN_SPEED * delta;

    const camera = controls.object;
    // Full 3D forward direction (includes Y for swimming up/down)
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.normalize();

    // Right vector is always horizontal (cross forward with world up)
    const right = new THREE.Vector3();
    const flatForward = new THREE.Vector3(forward.x, 0, forward.z).normalize();
    right.crossVectors(flatForward, new THREE.Vector3(0, 1, 0)).normalize();

    // Move in full 3D: W/S along camera direction (incl. Y), A/D strafe horizontal
    const moveX = right.x * dx + forward.x * dz;
    const moveY = forward.y * dz; // swim up/down when looking up/down
    const moveZ = right.z * dx + forward.z * dz;

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

    const { controlMode, petPosition, possessedNpcId } = useGameStore.getState();

    // Determine the character's 2D game-space position
    let gameX: number;
    let gameY: number;

    if (controlMode === 'npc' && possessedNpcId) {
      const npc = useNpcStore.getState().npcs.find((n) => n.id === possessedNpcId);
      if (!npc) return;
      gameX = npc.x;
      gameY = npc.y;
    } else {
      // 'player' or 'autonomous' — follow player pet
      gameX = petPosition.x;
      gameY = petPosition.y;
    }

    // Convert to Three.js world coordinates (2D game plane → XZ)
    const worldX = gameX - HALF_W;
    const worldZ = gameY - HALF_H;

    // Lerp the orbit target toward the character (smooth follow)
    const tgt = controls.target;
    tgt.x += (worldX  - tgt.x) * 0.1;
    tgt.y += (CHAR_TARGET_Y - tgt.y) * 0.1;
    tgt.z += (worldZ  - tgt.z) * 0.1;

    // Compute current camera-to-target offset and rescale to follow distance.
    // This keeps the camera at a consistent distance while preserving the orbit
    // angle set by ArrowKeyRotationController or mouse drag.
    _followOffset.subVectors(controls.object.position, tgt);
    const currentDist = _followOffset.length();
    if (currentDist > 0.001) {
      // Gently nudge distance toward target rather than snapping — feels smoother
      const lerpedDist = currentDist + (FPS_FOLLOW_DISTANCE - currentDist) * 0.1;
      _followOffset.multiplyScalar(lerpedDist / currentDist);
      _followTarget.copy(tgt).add(_followOffset);

      // Clamp camera Y so it never goes below the ground floor
      if (_followTarget.y < CAM_Y_MIN) {
        _followTarget.y = CAM_Y_MIN;
      }
      controls.object.position.copy(_followTarget);
    }

    controls.update();
  });

  return null;
}

// ---------------------------------------------------------------------------
// startManualRenderLoop — R3F v9 + WebGPURenderer workaround
// ---------------------------------------------------------------------------
// R3F v9's internal render loop never starts when paired with WebGPURenderer:
// state.internal.active stays false even with frameloop="always", and nothing
// calls gl.renderAsync. But state.advance(t, true) drives a full frame
// correctly (useFrame subscribers + renderAsync).
//
// We can't run this loop from a child component inside the Canvas because R3F
// wraps children in a Suspense; on first load SceneContents suspends while
// GLBs load, so any child of the Canvas never gets to mount its useEffect
// until loading completes — meanwhile zero frames render and the canvas is
// black. Instead we start the RAF loop from onCreated (which fires once the
// renderer is ready, regardless of suspended children) and attach a cancel
// handle to the state so it can be stopped if the Canvas is ever torn down.
// ---------------------------------------------------------------------------
function startManualRenderLoop(state: any): void {
  // Expose the state globally so we can poke it from devtools if anything
  // goes wrong in production.
  (window as any).__W3D = state;
  if (state.__manualLoopRunning) {
    // eslint-disable-next-line no-console
    console.warn('[World3D] manual render loop already running, skipping start');
    return;
  }
  state.__manualLoopRunning = true;
  let rafId = 0;
  let tick = 0;
  // eslint-disable-next-line no-console
  console.warn('[World3D] starting manual render loop');
  const loop = (t: number) => {
    if (!state.__manualLoopRunning) return;
    try {
      state.advance(t / 1000, true);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[World3D] manual render loop advance threw', err);
    }
    tick++;
    if (tick === 1 || tick === 60 || tick === 300) {
      // eslint-disable-next-line no-console
      console.warn(`[World3D] manual loop tick ${tick}`);
    }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
  state.__manualLoopCancel = () => {
    state.__manualLoopRunning = false;
    if (rafId) cancelAnimationFrame(rafId);
  };
}

// ---------------------------------------------------------------------------
// Scene contents (inside Canvas)
// ---------------------------------------------------------------------------
const SceneContents = memo(function SceneContents({ mode }: { mode: WorldMode }) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const isGame = mode === 'game';
  // Read controlMode once at mount for camera routing; camera routing uses
  // getState() inside useFrame so it always has the latest value at zero cost.
  // We only need a reactive read here if we conditionally render JSX based on
  // controlMode — which we do for the controller switch below.
  const controlMode = useGameStore((s) => s.controlMode);

  // Tight follow distance for any mode where the camera tracks a character.
  // Explore mode ('explore' + arena) gets a wider minDistance for free-look.
  const followMode = controlMode !== 'explore';

  return (
    <>
      {/* Camera controls */}
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        minDistance={followMode ? 20 : 80}
        maxDistance={800}
        maxPolarAngle={Math.PI * 0.85}
        target={[0, 10, 0]}
      />

      {/* Camera controller routing based on controlMode:
            explore    → WASDCameraController (free cam, WASD pans world)
            player     → FPSFollowCamera (follows player pet)
            autonomous → FPSFollowCamera (follows player pet, WASD drives pet not camera)
            npc        → FPSFollowCamera (follows possessed NPC)
          Arrow key rotation is always active in all modes. */}
      {controlMode === 'explore' ? (
        <WASDCameraController controlsRef={controlsRef} />
      ) : (
        <FPSFollowCamera controlsRef={controlsRef} />
      )}
      <ArrowKeyRotationController controlsRef={controlsRef} />

      {/* Underwater lighting — warm caustic tones with strong contrast */}
      <hemisphereLight args={[0x66bbdd, 0x223344, 1.5]} />
      <ambientLight intensity={0.4} color={0x88ccee} />
      <directionalLight position={[150, 350, 80]} intensity={2.0} color={0xffeedd} />
      {/* Secondary fill light from opposite side for depth */}
      <directionalLight position={[-100, 200, -60]} intensity={0.5} color={0x88aacc} />

      {/* Underwater fog — pushed back for better visibility */}
      <fog attach="fog" args={[FOG_COLOR, 400, 2000]} />

      {/* Underwater atmosphere — caustic light plane, depth backdrop, dust particles */}
      <UnderwaterAtmosphere />

      {/* Volumetric light rays — 7 cone shafts with pulsing TSL opacity, additive blending */}
      <UnderwaterLightRays />

      {/* Shared world geometry */}
      <ArenaTerrain />
      <ArenaBuildings />
      <ArenaNpcs />
      <ArenaLocationNpcs />

      {/* Seaweed ground cover — merged geometry + TSL GPU animation (no InstancedMesh) */}
      <MergedSeaweed />

      {/* NPC possession controller — active when controlMode === 'npc' */}
      <NpcController />

      {/* Mode-specific content */}
      {isGame && <PlayerPet />}
      {!isGame && <ArenaFx />}
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

async function createWebGPURenderer(canvas: HTMLCanvasElement): Promise<any> {
  // Dynamic import — tree-shakes out when WebGPU path isn't taken
  const { WebGPURenderer } = await import('three/webgpu');
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    // powerPreference is not a WebGPURenderer option; low-power is handled
    // by the browser's GPU adapter selection (it prefers integrated GPU by default)
  });
  // WebGPURenderer.render() throws if not initialized — must await init()
  // init() internally: tries WebGPU backend → falls back to WebGL2 if unavailable
  await renderer.init();

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

function World3DCanvas({ mode }: World3DCanvasProps) {
  // Stable async gl factory — R3F v9 awaits this before rendering.
  // Returns a WebGPURenderer (with automatic WebGL2 fallback built in).
  // Falls back to standard WebGLRenderer if the dynamic import or init fails.
  const glFactory = useCallback(
    async (defaultProps: { canvas: HTMLCanvasElement }) => {
      try {
        return await createWebGPURenderer(defaultProps.canvas);
      } catch (err) {
        console.warn('[World3D] WebGPURenderer unavailable, falling back to WebGLRenderer:', err);
        // Import classic WebGLRenderer from base three (not three/webgpu)
        const { WebGLRenderer } = await import('three');
        return new WebGLRenderer({
          canvas: defaultProps.canvas,
          antialias: false,
          powerPreference: 'low-power',
        });
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
        dpr={[0.75, 1]}
        // IMPORTANT: R3F v9's own render loop never starts when paired with
        // WebGPURenderer (state.internal.active stays false). We drive the
        // loop ourselves via <ManualRenderLoop /> below, so Canvas frameloop
        // MUST be "never" to avoid R3F's broken internal scheduler conflict.
        frameloop="never"
        camera={{
          fov: 50,
          near: 1,
          far: 2000,
          position: mode === 'game' ? [0, 80, 150] : [0, 200, 350],
        }}
        onCreated={(state) => {
          const { scene, gl } = state;
          scene.background = SKY_COLOR;
          gl.setPixelRatio(Math.min(window.devicePixelRatio, 1));
          if ((gl as any).isWebGPURenderer) {
            const backend = (gl as any).backend;
            const name = backend?.constructor?.name ?? 'unknown';
            // eslint-disable-next-line no-console
            console.warn(`[World3D] Using WebGPURenderer (backend: ${name})`);
          } else {
            // eslint-disable-next-line no-console
            console.warn('[World3D] Using WebGLRenderer');
          }
          // Drive the render loop ourselves — see startManualRenderLoop() for why.
          startManualRenderLoop(state);
        }}
      >
        <SceneContents mode={mode} />
      </Canvas>
    </div>
  );
}

export default World3DCanvas;
