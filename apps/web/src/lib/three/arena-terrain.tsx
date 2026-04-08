'use client';

import { Suspense, useEffect, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// GLB-based underwater terrain
// All terrain meshes are set to Layer 1 so raycasters can target ONLY terrain
// ---------------------------------------------------------------------------

// Layer 1 = terrain (used by NPC/building raycasters)
export const TERRAIN_LAYER = 1;

useGLTF.preload('/models/underwater-scene.glb');

function UnderwaterTerrain() {
  const { scene } = useGLTF('/models/underwater-scene.glb');
  const groupRef = useRef<THREE.Group>(null);

  // Set terrain meshes to layer 1 + tint to warm sandy color
  useEffect(() => {
    if (!groupRef.current) return;
    const sandTint = new THREE.Color(0xd4b896); // warm sand
    groupRef.current.traverse((child) => {
      child.layers.enable(TERRAIN_LAYER);
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.material && (mesh.material as THREE.MeshStandardMaterial).color) {
          const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
          // Blend existing color with sandy tint
          mat.color.lerp(sandTint, 0.4);
          mesh.material = mat;
        }
      }
    });
  }, []);

  const scale = 200;

  return (
    <group ref={groupRef}>
      <primitive
        object={scene}
        scale={scale}
        position={[0, -20, 0]}
      />
    </group>
  );
}

export default function ArenaTerrain() {
  return (
    <Suspense fallback={null}>
      <UnderwaterTerrain />
    </Suspense>
  );
}
