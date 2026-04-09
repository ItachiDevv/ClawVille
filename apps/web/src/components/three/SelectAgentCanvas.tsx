'use client';

/**
 * SelectAgentCanvas — 3D character preview for the Agent Setup screen.
 *
 * Renders a rotating platform with the selected agent's GLB model,
 * underwater atmosphere effects, and dramatic lighting.
 *
 * GPU constraints: no InstancedMesh, no drei Text/Billboard, TSL only.
 */

import { useRef, memo, Suspense } from 'react';
import { Canvas, useFrame, extend } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import type { ThreeToJSXElements } from '@react-three/fiber';

// Register Three.js WebGPU elements
declare module '@react-three/fiber' {
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}
extend(THREE as any);

import UnderwaterAtmosphere from '@/lib/three/underwater-atmosphere';
import UnderwaterLightRays from '@/lib/three/underwater-light-rays';
import { discoverLobsterParts } from '@/lib/three/lobster-parts';
import { LobsterAnimator, resolveAnimState } from '@/lib/three/lobster-animations';
import { applyIdleAnimation, idToSeed } from '@/lib/three/procedural-animation';

// ---------------------------------------------------------------------------
// Model Registry — maps agent type to GLB path
// ---------------------------------------------------------------------------

export const MODEL_REGISTRY: Record<string, { path: string; scale: number; label: string }> = {
  // OpenClaw lobster variants — all use lobster.glb with different color tints
  lobster:   { path: '/models/lobster.glb',   scale: 14, label: 'Reef Lobster' },
  crayfish:  { path: '/models/crayfish.glb',  scale: 14, label: 'Crayfish' },
  // Future: Hermes anime models
  // hermes_01: { path: '/models/hermes-agent-01.glb', scale: 10, label: 'Hermes Scout' },
  // hermes_02: { path: '/models/hermes-agent-02.glb', scale: 10, label: 'Hermes Sentinel' },
};

// Color tint presets
const COLOR_TINTS: Record<string, number> = {
  red:    0xff3030,
  blue:   0x3070ff,
  green:  0x30ff70,
  yellow: 0xffd700,
  purple: 0xaa44ff,
  orange: 0xff8800,
  pink:   0xff66aa,
  cyan:   0x00ddff,
  white:  0xeeeeee,
};

// Preload default model
useGLTF.preload('/models/lobster.glb');

// ---------------------------------------------------------------------------
// Rotating Platform
// ---------------------------------------------------------------------------

function RotatingPlatform({ children }: { children?: React.ReactNode }) {
  const groupRef = useRef<THREE.Group>(null!);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.3;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Main platform disc */}
      <mesh position={[0, -1, 0]} receiveShadow>
        <cylinderGeometry args={[12, 14, 1.5, 32]} />
        <meshStandardMaterial
          color={0x0d2a40}
          roughness={0.7}
          metalness={0.3}
          transparent
          opacity={0.8}
        />
      </mesh>

      {/* Inner glow ring */}
      <mesh position={[0, -0.2, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[10, 0.15, 8, 48]} />
        <meshBasicMaterial color={0x00ccff} transparent opacity={0.3} />
      </mesh>

      {/* Outer glow ring */}
      <mesh position={[0, -0.2, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[13, 0.1, 8, 48]} />
        <meshBasicMaterial color={0x0088cc} transparent opacity={0.15} />
      </mesh>

      {/* Model sits on top of the platform */}
      {children}
    </group>
  );
}

// ---------------------------------------------------------------------------
// GLB Model on Platform
// ---------------------------------------------------------------------------

const PlatformModel = memo(function PlatformModel({
  modelKey,
  color,
}: {
  modelKey: string;
  color: string;
}) {
  const reg = MODEL_REGISTRY[modelKey] ?? MODEL_REGISTRY.lobster;
  const { scene } = useGLTF(reg.path);
  const groupRef = useRef<THREE.Group>(null!);
  const animGroupRef = useRef<THREE.Group>(null!);

  const { cloned, animator } = React.useMemo(() => {
    const c = scene.clone(true);
    const tint = new THREE.Color(COLOR_TINTS[color] ?? 0x00ccdd);
    c.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.material) {
          const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
          mat.color.lerp(tint, 0.6);
          mat.emissive = tint.clone();
          mat.emissiveIntensity = 0.2;
          mesh.material = mat;
        }
      }
    });
    const parts = discoverLobsterParts(c);
    const anim = new LobsterAnimator(parts);
    return { cloned: c, animator: anim };
  }, [scene, modelKey, color]);

  const seed = React.useMemo(() => idToSeed(modelKey + color), [modelKey, color]);

  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.1);

    // Idle animation
    const animState = resolveAnimState({
      isDead: false,
      inCombat: false,
      combatAction: null,
      direction: 'idle',
      inConversation: false,
    });
    animator.update(dt, clock.elapsedTime, animState, 'idle');

    if (animGroupRef.current) {
      applyIdleAnimation({
        group: animGroupRef.current,
        isMoving: false,
        elapsed: clock.elapsedTime,
        delta: dt,
        direction: 'idle',
        seed,
      });
    }
  });

  return (
    <group ref={groupRef} position={[0, 1.5, 0]} scale={[reg.scale, reg.scale, reg.scale]}>
      <group ref={animGroupRef}>
        <primitive object={cloned} />
      </group>
    </group>
  );
});

// Need React import for useMemo in the memo'd component
import React from 'react';

// ---------------------------------------------------------------------------
// Scene Contents
// ---------------------------------------------------------------------------

const SceneContents = memo(function SceneContents({
  modelKey,
  color,
}: {
  modelKey: string;
  color: string;
}) {
  return (
    <>
      {/* Camera controls — limited rotation, no pan */}
      <OrbitControls
        makeDefault
        enablePan={false}
        enableZoom={true}
        minDistance={25}
        maxDistance={80}
        minPolarAngle={Math.PI * 0.3}
        maxPolarAngle={Math.PI * 0.55}
        target={[0, 8, 0]}
      />

      {/* Dramatic underwater lighting */}
      <directionalLight position={[10, 40, 20]} intensity={1.2} color={0xfff5e0} />
      <pointLight position={[0, -5, 10]} color={0x00aaff} intensity={0.8} distance={60} />
      <ambientLight color={0x05152b} intensity={0.4} />

      {/* Underwater fog */}
      <fog attach="fog" args={[0x030d1a, 80, 220]} />

      {/* Atmosphere effects */}
      <UnderwaterAtmosphere />
      <UnderwaterLightRays />

      {/* Rotating platform with model */}
      <Suspense fallback={null}>
        <RotatingPlatform>
          <PlatformModel modelKey={modelKey} color={color} />
        </RotatingPlatform>
      </Suspense>
    </>
  );
});

// ---------------------------------------------------------------------------
// Exported Canvas
// ---------------------------------------------------------------------------

interface SelectAgentCanvasProps {
  modelKey?: string;
  color?: string;
}

export default function SelectAgentCanvas({
  modelKey = 'lobster',
  color = 'cyan',
}: SelectAgentCanvasProps) {
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

  return (
    <Canvas
      className="w-full h-full"
      camera={{ position: [0, 18, 55], fov: 45 }}
      gl={{
        antialias: true,
        ...(hasWebGPU ? {} : { forceWebGL: true } as any),
      }}
      scene={{ background: new THREE.Color(0x030d1a) }}
    >
      <SceneContents modelKey={modelKey} color={color} />
    </Canvas>
  );
}
