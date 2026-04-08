'use client';

import { Suspense, useEffect, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Bikini Bottom terrain — warm sandy ground from SpongeBob-style GLB
// The model includes sandy terrain with natural edges
// All terrain meshes tagged with Layer 1 for raycasting
// ---------------------------------------------------------------------------

export const TERRAIN_LAYER = 1;

useGLTF.preload('/models/bikini-bottom.glb');

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

export default function ArenaTerrain() {
  return (
    <Suspense fallback={null}>
      <BikiniBottomTerrain />
    </Suspense>
  );
}
