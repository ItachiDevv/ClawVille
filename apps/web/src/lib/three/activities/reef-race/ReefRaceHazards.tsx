'use client';

/**
 * ReefRaceHazards.tsx
 *
 * Renders two sea-urchin hazard field markers — one at each hairpin apex.
 * Driving through a hazard applies -40% speed while inside it.
 *
 * Visual: a TorusKnotGeometry (low-complexity "urchin" silhouette) placed
 * flat on the track surface, purple + emissive. Static — no useFrame animation.
 *
 * Iris Xe invariants:
 *   - MeshStandardMaterial only (never ShaderMaterial).
 *   - Module-scope geometry + material — page-lifetime, allocated once.
 *   - 2 draw calls total (one mesh per hazard).
 *   - matrixAutoUpdate=false on both meshes after mount.
 *   - No per-frame allocations.
 *   - Subscribes to s.room?.reefStaticZones (primitive identity).
 *
 * Final art (urchin sprites) is deferred to Phase 2.5 — this is the
 * Phase 2 placeholder per plan §5.2.
 */

import { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useActivityStore } from '@/stores/activity';
import {
  buildReefHazardPatchesClient,
  type ReefHazardPatchClient,
} from './reef-race-config';

// ─── Module-scope geometry + material (page-lifetime, never disposed) ─────────

/**
 * TorusKnotGeometry at radius=1 — scaled per-hazard by mesh.scale.
 * Low settings: tubularSegments=24, radialSegments=4 → cheap on Iris Xe.
 * Placed flat (rotation.x = -PI/2) so it reads as a ground-hugging field.
 */
const _hazardGeo = new THREE.TorusKnotGeometry(1, 0.08, 24, 4);

const _hazardMat = new THREE.MeshStandardMaterial({
  color: '#9c27b0',
  emissive: '#7b1fa2',
  emissiveIntensity: 0.4,
  roughness: 0.8,
  metalness: 0.1,
  side: THREE.DoubleSide,
});

// ─── Single hazard mesh ────────────────────────────────────────────────────────

interface HazardMeshProps {
  hazard: ReefHazardPatchClient;
}

function HazardMesh({ hazard }: HazardMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Position at hazard center, flat on track (y=0).
    mesh.position.set(hazard.center.x, 2, hazard.center.y);
    // Rotate flat: TorusKnotGeometry stands upright by default — lay it down.
    mesh.rotation.set(-Math.PI / 2, 0, 0);
    // Scale uniformly to hazard radius.
    mesh.scale.setScalar(hazard.radius);

    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, [hazard]);

  return (
    <mesh
      ref={meshRef}
      geometry={_hazardGeo}
      material={_hazardMat}
      frustumCulled={false}
      matrixAutoUpdate={false}
      receiveShadow
    />
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReefRaceHazards() {
  const serverZones = useActivityStore((s) => s.room?.reefStaticZones);

  const hazards = useMemo<ReefHazardPatchClient[]>(() => {
    if (serverZones?.hazards && serverZones.hazards.length > 0) {
      return serverZones.hazards;
    }
    return buildReefHazardPatchesClient();
  }, [serverZones]);

  return (
    <>
      {hazards.map((h) => (
        <HazardMesh key={h.id} hazard={h} />
      ))}
    </>
  );
}
