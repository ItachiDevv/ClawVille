'use client';

/**
 * ReefRaceApexMarkers.tsx
 *
 * Renders subtle feedback ring markers at each hairpin apex:
 *   - Green ring at `innerCenter` — "drive through here for +5%"
 *   - Amber ring at `outerCenter` — "drift too wide and you eat -5%"
 *
 * These are FEEDBACK markers, not visual hazards — subtle enough to read as
 * "racing line guides" rather than obstacles.
 *
 * Iris Xe invariants:
 *   - MeshStandardMaterial only (never ShaderMaterial).
 *   - Two module-scope geometries + two materials (inner/outer) — page-lifetime.
 *   - 4 draw calls total (2 zones × 2 rings). Under the 70-call budget.
 *   - matrixAutoUpdate=false on all meshes after mount.
 *   - No per-frame allocations.
 *   - Subscribes to s.room?.reefStaticZones (primitive identity).
 */

import { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useActivityStore } from '@/stores/activity';
import {
  buildReefApexZonesClient,
  type ReefApexZoneClient,
} from './reef-race-config';

// ─── Module-scope geometries + materials (page-lifetime, never disposed) ──────

/**
 * Ring geometry: RingGeometry at inner=0.85, outer=1.0 normalised.
 * We scale to the apex detection radii at mount time (server: 44wu each).
 */
const _innerRingGeo = new THREE.RingGeometry(0.75, 1.0, 32);
const _outerRingGeo = new THREE.RingGeometry(0.75, 1.0, 32);

/** Green — "clean line" */
const _innerMat = new THREE.MeshStandardMaterial({
  color: '#00e676',
  emissive: '#00c853',
  emissiveIntensity: 0.35,
  roughness: 0.7,
  metalness: 0.0,
  transparent: true,
  opacity: 0.55,
  side: THREE.DoubleSide,
  depthWrite: false,
});

/** Amber — "wide line" */
const _outerMat = new THREE.MeshStandardMaterial({
  color: '#ff9800',
  emissive: '#e65100',
  emissiveIntensity: 0.3,
  roughness: 0.7,
  metalness: 0.0,
  transparent: true,
  opacity: 0.45,
  side: THREE.DoubleSide,
  depthWrite: false,
});

// Apex disc radius (wu) — must match server APEX_INNER_RADIUS / APEX_OUTER_RADIUS = REEF_BODY_RADIUS * 2 = 44wu.
const APEX_RING_RADIUS = 44;

// ─── Single zone (inner + outer ring) ────────────────────────────────────────

interface ApexZoneMeshProps {
  zone: ReefApexZoneClient;
}

function ApexZoneMesh({ zone }: ApexZoneMeshProps) {
  const innerRef = useRef<THREE.Mesh>(null);
  const outerRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const inner = innerRef.current;
    const outer = outerRef.current;
    if (!inner || !outer) return;

    // RingGeometry lies in XY plane — rotate to lie flat on XZ track plane.
    const flatRot = new THREE.Euler(-Math.PI / 2, 0, 0);

    inner.position.set(zone.innerCenter.x, 1, zone.innerCenter.y);
    inner.rotation.copy(flatRot);
    inner.scale.setScalar(APEX_RING_RADIUS);
    inner.matrixAutoUpdate = false;
    inner.updateMatrix();

    outer.position.set(zone.outerCenter.x, 1, zone.outerCenter.y);
    outer.rotation.copy(flatRot);
    outer.scale.setScalar(APEX_RING_RADIUS);
    outer.matrixAutoUpdate = false;
    outer.updateMatrix();
  }, [zone]);

  return (
    <>
      <mesh
        ref={innerRef}
        geometry={_innerRingGeo}
        material={_innerMat}
        frustumCulled={false}
        matrixAutoUpdate={false}
      />
      <mesh
        ref={outerRef}
        geometry={_outerRingGeo}
        material={_outerMat}
        frustumCulled={false}
        matrixAutoUpdate={false}
      />
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReefRaceApexMarkers() {
  const serverZones = useActivityStore((s) => s.room?.reefStaticZones);

  const zones = useMemo<ReefApexZoneClient[]>(() => {
    if (serverZones?.apexZones && serverZones.apexZones.length > 0) {
      return serverZones.apexZones;
    }
    return buildReefApexZonesClient();
  }, [serverZones]);

  return (
    <>
      {zones.map((z) => (
        <ApexZoneMesh key={z.hairpinIndex} zone={z} />
      ))}
    </>
  );
}
