'use client';

import { useRef, useEffect, memo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import ArenaTerrain from '@/lib/three/arena-terrain';
import ArenaBuildings from '@/lib/three/arena-buildings';
import ArenaNpcs from '@/lib/three/arena-npcs';
import ArenaFx from '@/lib/three/arena-fx';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const CAM_PAN_SPEED = 300;
const SKY_COLOR = new THREE.Color(0x87ceeb);
const FOG_COLOR = new THREE.Color(0x87ceeb);

// ---------------------------------------------------------------------------
// WASD Camera Controller
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

function WASDController({
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

  // Register keyboard listeners
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase() as keyof KeyState;
      if (key in keysRef.current) {
        keysRef.current[key] = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase() as keyof KeyState;
      if (key in keysRef.current) {
        keysRef.current[key] = false;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Move the OrbitControls target each frame
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

    // Normalize diagonal movement
    const len = Math.sqrt(dx * dx + dz * dz);
    dx = (dx / len) * CAM_PAN_SPEED * delta;
    dz = (dz / len) * CAM_PAN_SPEED * delta;

    // Get camera forward/right vectors projected onto the XZ plane
    const camera = controls.object;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    // Compute movement in world space
    const moveX = right.x * dx + forward.x * dz;
    const moveZ = right.z * dx + forward.z * dz;

    // Clamp target within map bounds
    const target = controls.target;
    const halfW = MAP_WIDTH / 2;
    const halfH = MAP_HEIGHT / 2;
    target.x = Math.max(-halfW, Math.min(halfW, target.x + moveX));
    target.z = Math.max(-halfH, Math.min(halfH, target.z + moveZ));

    // Move camera by the same offset to maintain relative position
    camera.position.x = Math.max(
      -halfW - 200,
      Math.min(halfW + 200, camera.position.x + moveX)
    );
    camera.position.z = Math.max(
      -halfH - 200,
      Math.min(halfH + 200, camera.position.z + moveZ)
    );

    controls.update();
  });

  return null;
}

// ---------------------------------------------------------------------------
// Scene contents (inside Canvas)
// ---------------------------------------------------------------------------
const SceneContents = memo(function SceneContents() {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  return (
    <>
      {/* Camera controls */}
      <OrbitControls
        ref={controlsRef}
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        minDistance={200}
        maxDistance={1000}
        maxPolarAngle={Math.PI / 2.5}
        target={[0, 0, 0]}
      />
      <WASDController controlsRef={controlsRef} />

      {/* Lighting */}
      <ambientLight intensity={0.6} />
      <directionalLight
        position={[200, 400, 200]}
        intensity={1.0}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-MAP_WIDTH / 2}
        shadow-camera-right={MAP_WIDTH / 2}
        shadow-camera-top={MAP_HEIGHT / 2}
        shadow-camera-bottom={-MAP_HEIGHT / 2}
        shadow-camera-near={1}
        shadow-camera-far={1200}
      />

      {/* Fog */}
      <fog attach="fog" args={[FOG_COLOR, 500, 1500]} />

      {/* Scene children */}
      <ArenaTerrain />
      <ArenaBuildings />
      <ArenaNpcs />
      <ArenaFx />
    </>
  );
});

// ---------------------------------------------------------------------------
// Main exported Canvas component
// ---------------------------------------------------------------------------
function Arena3DCanvas() {
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
        shadows
        gl={{ antialias: true }}
        camera={{
          fov: 50,
          near: 1,
          far: 3000,
          position: [0, 400, 500],
        }}
        onCreated={({ scene }) => {
          scene.background = SKY_COLOR;
        }}
      >
        <SceneContents />
      </Canvas>
    </div>
  );
}

export default memo(Arena3DCanvas);
