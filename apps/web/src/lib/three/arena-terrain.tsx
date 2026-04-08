'use client';

import { Suspense, useEffect, useRef, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
} from '@/lib/pixi/tilemap-data';

export const TERRAIN_LAYER = 1;

useGLTF.preload('/models/underwater-scene.glb');

// ---------------------------------------------------------------------------
// Warm sandy ocean floor — simple plane with proper sand color
// The underwater GLB scene is used ONLY for the rocky border decoration
// ---------------------------------------------------------------------------

function SandyFloor() {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.layers.enable(TERRAIN_LAYER);
    }
  }, []);

  return (
    <mesh ref={meshRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, -2, 0]} receiveShadow>
      <planeGeometry args={[MAP_WIDTH * 3, MAP_HEIGHT * 3]} />
      <meshStandardMaterial
        color={0xd4c4a0}
        roughness={0.85}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Underwater scene GLB — used for rocky edges/decoration only
// Pushed down so only the rocks/hills poke above the sand floor
// ---------------------------------------------------------------------------
function RockyBorder() {
  const { scene } = useGLTF('/models/underwater-scene.glb');
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    if (!groupRef.current) return;
    groupRef.current.traverse((child) => {
      child.layers.enable(TERRAIN_LAYER);
    });
  }, []);

  return (
    <group ref={groupRef}>
      <primitive
        object={scene}
        scale={200}
        position={[0, -45, 0]}
      />
    </group>
  );
}

export default function ArenaTerrain() {
  return (
    <Suspense fallback={null}>
      <SandyFloor />
      <RockyBorder />
    </Suspense>
  );
}
