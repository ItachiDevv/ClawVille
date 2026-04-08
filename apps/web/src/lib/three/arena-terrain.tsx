'use client';

import { Suspense, useEffect, useRef, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Bikini Bottom terrain — warm sandy ground from SpongeBob-style GLB
// The model includes sandy terrain with natural edges
// All terrain meshes tagged with Layer 1 for raycasting
// ---------------------------------------------------------------------------

export const TERRAIN_LAYER = 1;

useGLTF.preload('/models/bikini-bottom.glb');
useGLTF.preload('/models/coral-reef1.glb');
useGLTF.preload('/models/coral-reef2.glb');
useGLTF.preload('/models/coral-reef3.glb');
useGLTF.preload('/models/kelp.glb');

function BikiniBottomTerrain() {
  const { scene } = useGLTF('/models/bikini-bottom.glb');
  const groupRef = useRef<THREE.Group>(null);

  // Tag all meshes with terrain layer for raycasting
  useEffect(() => {
    if (!groupRef.current) return;
    groupRef.current.traverse((child) => {
      child.layers.enable(TERRAIN_LAYER);
    });
  }, []);

  // The model is a complete Bikini Bottom scene — we use it as terrain
  // Scale to fit our 1280x800 map area
  return (
    <group ref={groupRef}>
      <primitive
        object={scene}
        scale={30}
        position={[0, -5, 0]}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Large sand plane — extends the sandy area beyond the Bikini Bottom GLB patch
// Sits just below the GLB so the small sand patch blends into a larger floor
// ---------------------------------------------------------------------------
const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;

function SandFloor() {
  const ref = useRef<THREE.Mesh>(null);
  useEffect(() => {
    if (ref.current) ref.current.layers.enable(TERRAIN_LAYER);
  }, []);
  return (
    <mesh
      ref={ref}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -6, 0]}
    >
      <planeGeometry args={[MAP_WIDTH * 3, MAP_HEIGHT * 3]} />
      <meshBasicMaterial color={0xe8d5b0} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Varied coral/kelp decorations — uses 4 different models for visual variety
// ---------------------------------------------------------------------------
interface DecoEntry {
  model: string;
  x: number;
  z: number;
  scale: number;
  rotY: number;
}

const DECORATIONS: DecoEntry[] = [
  // Coral reefs around the borders
  { model: '/models/coral-reef1.glb', x: -500, z: -280, scale: 15, rotY: 0 },
  { model: '/models/coral-reef2.glb', x: 480, z: -300, scale: 12, rotY: 1.2 },
  { model: '/models/coral-reef3.glb', x: -480, z: 280, scale: 14, rotY: 2.5 },
  { model: '/models/coral-reef1.glb', x: 500, z: 300, scale: 11, rotY: 3.8 },
  // Kelp patches between buildings
  { model: '/models/kelp.glb', x: -300, z: -100, scale: 18, rotY: 0.5 },
  { model: '/models/kelp.glb', x: 300, z: 150, scale: 16, rotY: 2.0 },
  { model: '/models/kelp.glb', x: -100, z: 300, scale: 20, rotY: 4.0 },
  { model: '/models/kelp.glb', x: 200, z: -250, scale: 14, rotY: 1.0 },
  // More coral to fill in
  { model: '/models/coral-reef2.glb', x: 0, z: -350, scale: 10, rotY: 0.8 },
  { model: '/models/coral-reef3.glb', x: -550, z: 0, scale: 13, rotY: 3.2 },
  { model: '/models/coral-reef1.glb', x: 550, z: 0, scale: 11, rotY: 5.0 },
  { model: '/models/coral-reef2.glb', x: 0, z: 350, scale: 12, rotY: 1.6 },
];

function SingleDecoration({ entry }: { entry: DecoEntry }) {
  const { scene } = useGLTF(entry.model);
  const cloned = useMemo(() => scene.clone(true), [scene]);
  return (
    <primitive
      object={cloned}
      position={[entry.x, -5, entry.z]}
      scale={entry.scale}
      rotation={[0, entry.rotY, 0]}
    />
  );
}

function UnderwaterDecorations() {
  return (
    <group>
      {DECORATIONS.map((entry, i) => (
        <SingleDecoration key={i} entry={entry} />
      ))}
    </group>
  );
}

export default function ArenaTerrain() {
  return (
    <Suspense fallback={null}>
      <SandFloor />
      <BikiniBottomTerrain />
      <UnderwaterDecorations />
    </Suspense>
  );
}
