'use client';

import { useRef, useEffect, useMemo, useCallback, memo } from 'react';
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
import { useGameStore } from '@/stores/game';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const CAM_PAN_SPEED = 300;
const SKY_COLOR = new THREE.Color(0x0e3458); // Deep ocean blue
const FOG_COLOR = new THREE.Color(0x123858); // Underwater haze — matches sky

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

function WASDCameraController({
  controlsRef,
}: {
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  const keysRef = useRef<KeyState>({
    w: false,
    a: false,
    s: false,
    d: false,
    arrowup: false,
    arrowdown: false,
    arrowleft: false,
    arrowright: false,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase() as keyof KeyState;
      if (key in keysRef.current) keysRef.current[key] = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase() as keyof KeyState;
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

    if (keys.w || keys.arrowup) dz -= 1;
    if (keys.s || keys.arrowdown) dz += 1;
    if (keys.a || keys.arrowleft) dx -= 1;
    if (keys.d || keys.arrowright) dx += 1;

    if (dx === 0 && dz === 0) return;

    const len = Math.sqrt(dx * dx + dz * dz);
    dx = (dx / len) * CAM_PAN_SPEED * delta;
    dz = (dz / len) * CAM_PAN_SPEED * delta;

    const camera = controls.object;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    const moveX = right.x * dx + forward.x * dz;
    const moveZ = right.z * dx + forward.z * dz;

    const target = controls.target;
    target.x = Math.max(-HALF_W, Math.min(HALF_W, target.x + moveX));
    target.z = Math.max(-HALF_H, Math.min(HALF_H, target.z + moveZ));

    camera.position.x = Math.max(
      -HALF_W - 200,
      Math.min(HALF_W + 200, camera.position.x + moveX)
    );
    camera.position.z = Math.max(
      -HALF_H - 200,
      Math.min(HALF_H + 200, camera.position.z + moveZ)
    );

    controls.update();
  });

  return null;
}

// ---------------------------------------------------------------------------
// Camera follow controller (game mode — follows player pet)
// ---------------------------------------------------------------------------
function PetFollowCamera({
  controlsRef,
}: {
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    const store = useGameStore.getState();
    const targetX = store.petPosition.x - HALF_W;
    const targetZ = store.petPosition.y - HALF_H;

    // Smooth follow
    const target = controls.target;
    target.x += (targetX - target.x) * 0.08;
    target.z += (targetZ - target.z) * 0.08;

    // Move camera to maintain relative offset
    const camera = controls.object;
    const offsetX = camera.position.x - target.x;
    const offsetZ = camera.position.z - target.z;

    camera.position.x = target.x + offsetX;
    camera.position.z = target.z + offsetZ;

    controls.update();
  });

  return null;
}

// ---------------------------------------------------------------------------
// Underwater bubbles (1 instanced mesh = 1 draw call)
// ---------------------------------------------------------------------------
function UnderwaterBubbles() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = 40;
  const data = useMemo(() => {
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push({
        x: (Math.random() - 0.5) * MAP_WIDTH,
        y: Math.random() * 300 - 20,
        z: (Math.random() - 0.5) * MAP_HEIGHT,
        speed: 15 + Math.random() * 25,
        wobble: Math.random() * Math.PI * 2,
        size: 0.5 + Math.random() * 1.5,
      });
    }
    return arr;
  }, []);

  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    data.forEach((b, i) => {
      const y = ((b.y + b.speed * t) % 320) - 20;
      dummy.position.set(
        b.x + Math.sin(t * 0.3 + b.wobble) * 5,
        y,
        b.z + Math.cos(t * 0.25 + b.wobble) * 4,
      );
      dummy.scale.setScalar(b.size);
      dummy.updateMatrix();
      ref.current!.setMatrixAt(i, dummy.matrix);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <sphereGeometry args={[1, 6, 6]} />
      <meshStandardMaterial color={0x88ddff} transparent opacity={0.2} roughness={0.1} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Scene contents (inside Canvas)
// ---------------------------------------------------------------------------
const SceneContents = memo(function SceneContents({ mode }: { mode: WorldMode }) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const isGame = mode === 'game';

  return (
    <>
      {/* Camera controls */}
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        minDistance={isGame ? 40 : 80}
        maxDistance={800}
        maxPolarAngle={Math.PI / 2.1}
        target={[0, 10, 0]}
      />

      {/* Camera controller: WASD free-cam (arena) vs pet follow (game) */}
      {isGame ? (
        <PetFollowCamera controlsRef={controlsRef} />
      ) : (
        <WASDCameraController controlsRef={controlsRef} />
      )}

      {/* Underwater lighting — bright but GPU-safe (no extra point lights) */}
      <hemisphereLight args={[0x88ccee, 0x445566, 1.2]} />
      <ambientLight intensity={0.6} color={0xaaddff} />
      <directionalLight position={[200, 400, 100]} intensity={1.5} color={0xeef4ff} />

      {/* Underwater fog — pushed back for better building visibility */}
      <fog attach="fog" args={[FOG_COLOR, 400, 1800]} />

      {/* Shared world geometry */}
      <ArenaTerrain />
      <ArenaBuildings />
      <ArenaNpcs />
      <ArenaLocationNpcs />

      {/* Bubbles disabled — per-frame instanced updates stress Intel Iris Xe */}

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
        frameloop="always"
        camera={{
          fov: 55,
          near: 1,
          far: 2000,
          position: mode === 'game' ? [0, 150, 300] : [0, 400, 600],
        }}
        onCreated={({ scene, gl }) => {
          scene.background = SKY_COLOR;
          gl.setPixelRatio(Math.min(window.devicePixelRatio, 1));
          // Log which backend was selected
          if ((gl as any).isWebGPURenderer) {
            const backend = (gl as any).backend;
            const name = backend?.constructor?.name ?? 'unknown';
            console.log(`[World3D] Using WebGPURenderer (backend: ${name})`);
          } else {
            console.log('[World3D] Using WebGLRenderer');
          }
        }}
      >
        <SceneContents mode={mode} />
      </Canvas>
    </div>
  );
}

export default World3DCanvas;
