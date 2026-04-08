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

  // Scale the scene to fill the map area
  // The lowpoly scene is roughly 10x10 units, we need it to cover 1280x800
  const scaleX = MAP_WIDTH / 10;
  const scaleZ = MAP_HEIGHT / 10;
  const scale = Math.max(scaleX, scaleZ) * 0.9;

  return (
    <primitive
      object={scene}
      scale={scale}
      position={[0, -5, 0]}
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
