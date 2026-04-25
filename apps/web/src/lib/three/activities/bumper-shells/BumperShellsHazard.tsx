'use client';

/**
 * BumperShellsHazard.tsx
 *
 * Central spinning spiked-ball hazard: sphere body + 8 instanced cone spikes.
 *
 * Draw calls: 2 (sphere + InstancedMesh of 8 cones).
 * Iris Xe invariants:
 *   - InstancedMesh + MeshStandardMaterial — SAFE (only ShaderMaterial crashes WebGPU).
 *   - matrixAutoUpdate=false on sphere (InstancedMesh doesn't support it per-instance —
 *     matrices are managed via setMatrixAt).
 *   - Spikes positioned once in useEffect, never re-computed per frame.
 *   - Spin via group.rotation.y mutation in useFrame — 1 write per frame, no allocations.
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
// PERF FIX 2026-04-24: 'three' not 'three/webgpu' — two THREE instances = GPU context loss
import * as THREE from 'three';
import {
  HAZARD_SPHERE_RADIUS,
  HAZARD_SPIKE_COUNT,
  HAZARD_SPIN_SPEED,
} from './bumper-shells-config';

// ─── Module-scope scratch ─────────────────────────────────────────────────────
const _spikeMatrix = new THREE.Matrix4();
const _spikeQuat   = new THREE.Quaternion();
const _spikePos    = new THREE.Vector3();
const _spikeScale  = new THREE.Vector3(1, 1, 1);
const _up          = new THREE.Vector3(0, 1, 0);

// ─── Geometry / material singletons ──────────────────────────────────────────
const sphereGeo = new THREE.SphereGeometry(HAZARD_SPHERE_RADIUS, 16, 16);

// Cone spikes: length = 0.6 * sphere radius, radius = 0.15 * sphere radius.
const spikeLength = HAZARD_SPHERE_RADIUS * 0.6;
const spikeRadius = HAZARD_SPHERE_RADIUS * 0.15;
const spikeGeo = new THREE.ConeGeometry(spikeRadius, spikeLength, 6, 1);

const hazardMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#2a2a3a'),
  roughness: 0.4,
  metalness: 0.7,
});

const spikeMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#cc3300'),
  roughness: 0.3,
  metalness: 0.8,
});

interface BumperShellsHazardProps {
  enabled?: boolean;
}

export default function BumperShellsHazard({ enabled = true }: BumperShellsHazardProps) {
  const groupRef  = useRef<THREE.Group>(null);
  const sphereRef = useRef<THREE.Mesh>(null);
  const spikesRef = useRef<THREE.InstancedMesh>(null);

  // Place spikes around the sphere in a ring on the equatorial plane (8 spikes, evenly spaced).
  useEffect(() => {
    const im = spikesRef.current;
    if (!im) return;

    for (let i = 0; i < HAZARD_SPIKE_COUNT; i++) {
      const angle = (i / HAZARD_SPIKE_COUNT) * Math.PI * 2;

      // Position on sphere surface — spikes point outward from equator.
      const px = Math.cos(angle) * HAZARD_SPHERE_RADIUS;
      const pz = Math.sin(angle) * HAZARD_SPHERE_RADIUS;
      _spikePos.set(px, 0, pz);

      // Cone default up-axis is Y. Rotate it to point along the radial direction.
      const radialDir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      _spikeQuat.setFromUnitVectors(_up, radialDir);

      // Offset position so spike base sits at the sphere surface.
      const spikeOffset = _spikePos.clone().normalize().multiplyScalar(spikeLength / 2);
      _spikePos.add(spikeOffset);

      _spikeMatrix.compose(_spikePos, _spikeQuat, _spikeScale);
      im.setMatrixAt(i, _spikeMatrix);
    }
    im.instanceMatrix.needsUpdate = true;

    // Freeze sphere matrix — it never translates (only the group rotates).
    const sphere = sphereRef.current;
    if (sphere) {
      sphere.matrixAutoUpdate = false;
      sphere.updateMatrix();
    }
  }, []);

  useFrame((_, delta) => {
    const g = groupRef.current;
    if (!g || !enabled) return;
    g.rotation.y += HAZARD_SPIN_SPEED * delta;
  });

  if (!enabled) return null;

  return (
    <group ref={groupRef} position={[0, HAZARD_SPHERE_RADIUS, 0]}>
      {/* Sphere body */}
      <mesh
        ref={sphereRef}
        geometry={sphereGeo}
        material={hazardMat}
        castShadow
        frustumCulled={false}
      />

      {/* 8 spike cones — InstancedMesh + MeshStandardMaterial = safe on WebGPU */}
      <instancedMesh
        ref={spikesRef}
        args={[spikeGeo, spikeMat, HAZARD_SPIKE_COUNT]}
        castShadow
        frustumCulled={false}
      />
    </group>
  );
}
