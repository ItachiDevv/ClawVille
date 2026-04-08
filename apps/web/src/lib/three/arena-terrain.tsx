'use client';

import { Suspense } from 'react';
import { useGLTF } from '@react-three/drei';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// GLB-based underwater terrain — replaces procedural sand/coral/rocks
// Single model = a few draw calls, looks way better than vertex-colored plane
// ---------------------------------------------------------------------------

useGLTF.preload('/models/underwater-scene.glb');

function UnderwaterTerrain() {
  const { scene } = useGLTF('/models/underwater-scene.glb');

  // Scale much bigger so the flat sandy center covers the entire play area
  // Rocky edges get pushed far out to the periphery (decorative border)
  // The model is roughly 10x10 units, map is 1280x800
  const scale = 200;

  return (
    <primitive
      object={scene}
      scale={scale}
      position={[0, -20, 0]}
    />
  );
}

// ---------------------------------------------------------------------------
// Main terrain export — just the GLB scene model
// ---------------------------------------------------------------------------
export default function ArenaTerrain() {
  return (
    <Suspense fallback={null}>
      <UnderwaterTerrain />
    </Suspense>
  );
}
