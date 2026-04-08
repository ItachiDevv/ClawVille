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
useGLTF.preload('/models/underwater-decorations.glb');

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
// Underwater decorations — scattered around map edges for visual richness
// Loads the full GLB and clones it at several border positions
// ---------------------------------------------------------------------------
const DECO_POSITIONS: [number, number, number, number][] = [
  // [x, z, scale, rotationY]
  [-500, -300, 12, 0],
  [500, -300, 10, Math.PI * 0.5],
  [-500, 300, 11, Math.PI],
  [500, 300, 10, Math.PI * 1.5],
  [0, -350, 9, Math.PI * 0.3],
  [0, 350, 10, Math.PI * 0.7],
  [-550, 0, 11, Math.PI * 0.2],
  [550, 0, 10, Math.PI * 1.1],
];

function UnderwaterDecorations() {
  const { scene } = useGLTF('/models/underwater-decorations.glb');

  const clones = useMemo(() => {
    return DECO_POSITIONS.map(([x, z, scale, rotY]) => {
      const c = scene.clone(true);
      return { clone: c, x, z, scale, rotY };
    });
  }, [scene]);

  return (
    <group>
      {clones.map((d, i) => (
        <primitive
          key={i}
          object={d.clone}
          position={[d.x, -5, d.z]}
          scale={d.scale}
          rotation={[0, d.rotY, 0]}
        />
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
