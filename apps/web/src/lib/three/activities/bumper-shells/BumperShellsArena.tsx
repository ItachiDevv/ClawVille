'use client';

/**
 * BumperShellsArena.tsx
 *
 * Static arena geometry: platform disc, rim glow torus, danger ring, void backdrop.
 * All meshes are static — matrixAutoUpdate=false after mount.
 *
 * Draw calls: 4 (platform, rim, danger ring, void backdrop).
 * Iris Xe invariants:
 *   - MeshBasicNodeMaterial for the rim glow (no lighting = no ShaderMaterial needed).
 *   - MeshStandardMaterial for platform and danger ring (no ShaderMaterial).
 *   - Void backdrop at y=-2000 — MeshBasicNodeMaterial ignores fog, so we place it
 *     far enough that the edge is never visible (fog kills everything past 900wu).
 *   - matrixAutoUpdate=false on every mesh — these never move.
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import {
  ARENA_RADIUS,
  ARENA_HEIGHT,
  ARENA_RADIAL_SEGMENTS,
  RIM_TUBE_RADIUS,
  RIM_RADIAL_SEGMENTS,
  RIM_TUBULAR_SEGMENTS,
  DANGER_RING_INNER,
  VOID_BACKDROP_Y,
  VOID_BACKDROP_SIZE,
} from './bumper-shells-config';

// ─── Module-scope scratch ────────────────────────────────────────────────────
// No allocations inside useFrame.
let _elapsedTime = 0;

// ─── Geometry / material singletons ─────────────────────────────────────────
// Created once at module load, shared across HMR cycles, disposed on unmount.
const platformGeo = new THREE.CylinderGeometry(
  ARENA_RADIUS,
  ARENA_RADIUS,
  ARENA_HEIGHT,
  ARENA_RADIAL_SEGMENTS,
  1,
);

const rimGeo = new THREE.TorusGeometry(
  ARENA_RADIUS,
  RIM_TUBE_RADIUS,
  RIM_RADIAL_SEGMENTS,
  RIM_TUBULAR_SEGMENTS,
);

// Danger ring: outer radius = ARENA_RADIUS, inner = DANGER_RING_INNER.
// Built as a thin CylinderGeometry ring (open at top/bottom).
const dangerGeo = new THREE.CylinderGeometry(
  ARENA_RADIUS,
  ARENA_RADIUS,
  4, // thin disc
  ARENA_RADIAL_SEGMENTS,
  1,
  false, // openEnded=false so it renders as a ring cap
);

const voidGeo = new THREE.PlaneGeometry(VOID_BACKDROP_SIZE, VOID_BACKDROP_SIZE);

const platformMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#1a2a3a'),
  roughness: 0.85,
  metalness: 0.0,
});

const dangerMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#cc2200'),
  roughness: 0.7,
  metalness: 0.0,
  transparent: true,
  opacity: 0.75,
});

// MeshBasicNodeMaterial for the rim glow — safe on WebGPU, no fog dependency.
// Pulse via JS opacity mutation each frame (simpler than TSL opacityNode for now).
const rimMat = new THREE.MeshBasicNodeMaterial
  ? new (THREE as any).MeshBasicNodeMaterial({
      color: new THREE.Color(0x00ccff),
      transparent: true,
      depthWrite: false,
    })
  : new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x00ccff),
      transparent: true,
      depthWrite: false,
    });

const voidMat = new THREE.MeshBasicMaterial
  ? (THREE as any).MeshBasicNodeMaterial
    ? new (THREE as any).MeshBasicNodeMaterial({
        color: new THREE.Color('#020810'),
        transparent: true,
        opacity: 1,
        depthWrite: false,
      })
    : new THREE.MeshBasicMaterial({
        color: new THREE.Color('#020810'),
        side: THREE.DoubleSide,
      })
  : new THREE.MeshBasicMaterial({
      color: new THREE.Color('#020810'),
      side: THREE.DoubleSide,
    });

export default function BumperShellsArena() {
  const platformRef = useRef<THREE.Mesh>(null);
  const rimRef = useRef<THREE.Mesh>(null);
  const dangerRef = useRef<THREE.Mesh>(null);
  const voidRef = useRef<THREE.Mesh>(null);

  // Freeze matrices after mount — these never move.
  useEffect(() => {
    for (const ref of [platformRef, rimRef, dangerRef, voidRef]) {
      const m = ref.current;
      if (!m) continue;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
    }
  }, []);

  // Rim glow pulse — GPU-driven: sin(t*2)*0.3+0.7.
  // No new allocations — just write opacity.
  useFrame((_, delta) => {
    _elapsedTime += delta;
    const rim = rimRef.current;
    if (rim) {
      (rim.material as THREE.Material & { opacity: number }).opacity =
        Math.sin(_elapsedTime * 2) * 0.3 + 0.7;
    }
  });

  return (
    <group>
      {/* Platform disc — flat at y=0 */}
      <mesh
        ref={platformRef}
        geometry={platformGeo}
        material={platformMat}
        position={[0, 0, 0]}
        receiveShadow
        castShadow={false}
        frustumCulled={false}
      />

      {/* Rim glow torus — top surface of disc */}
      <mesh
        ref={rimRef}
        geometry={rimGeo}
        material={rimMat}
        position={[0, ARENA_HEIGHT / 2, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        frustumCulled={false}
      />

      {/* Danger zone ring — outer 15% of disc, slightly above platform */}
      <mesh
        ref={dangerRef}
        geometry={dangerGeo}
        material={dangerMat}
        position={[0, ARENA_HEIGHT / 2 + 1, 0]}
        frustumCulled={false}
      />

      {/* Void backdrop — deep below arena, fills the view past the edge */}
      <mesh
        ref={voidRef}
        geometry={voidGeo}
        material={voidMat}
        position={[0, VOID_BACKDROP_Y, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        frustumCulled={false}
      />
    </group>
  );
}
