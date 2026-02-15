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
import PlayerAvatar from '@/lib/three/player-avatar';
import { useGameStore } from '@/stores/game';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const CAM_PAN_SPEED = 300;
const SKY_COLOR = new THREE.Color(0x87ceeb);
const FOG_COLOR = new THREE.Color(0x87ceeb);

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
// Camera follow controller (game mode — follows player avatar)
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
    const targetX = store.avatarPosition.x - HALF_W;
    const targetZ = store.avatarPosition.y - HALF_H;

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
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        minDistance={isGame ? 150 : 200}
        maxDistance={1000}
        maxPolarAngle={Math.PI / 2.5}
        target={[0, 0, 0]}
      />

      {/* Camera controller: WASD free-cam (arena) vs avatar follow (game) */}
      {isGame ? (
        <PetFollowCamera controlsRef={controlsRef} />
      ) : (
        <WASDCameraController controlsRef={controlsRef} />
      )}

      {/* Lighting */}
      <ambientLight intensity={0.6} />
      <directionalLight
        position={[200, 400, 200]}
        intensity={1.0}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-HALF_W}
        shadow-camera-right={HALF_W}
        shadow-camera-top={HALF_H}
        shadow-camera-bottom={-HALF_H}
        shadow-camera-near={1}
        shadow-camera-far={1200}
      />

      {/* Fog */}
      <fog attach="fog" args={[FOG_COLOR, 500, 1500]} />

      {/* Shared world geometry */}
      <ArenaTerrain />
      <ArenaBuildings />
      <ArenaNpcs />

      {/* Mode-specific content */}
      {isGame && <PlayerAvatar />}
      {!isGame && <ArenaFx />}
    </>
  );
});

// ---------------------------------------------------------------------------
// Main exported Canvas component
// ---------------------------------------------------------------------------
function World3DCanvas({ mode }: World3DCanvasProps) {
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
          position: mode === 'game' ? [0, 300, 350] : [0, 400, 500],
        }}
        onCreated={({ scene }) => {
          scene.background = SKY_COLOR;
        }}
      >
        <SceneContents mode={mode} />
      </Canvas>
    </div>
  );
}

export default memo(World3DCanvas);
