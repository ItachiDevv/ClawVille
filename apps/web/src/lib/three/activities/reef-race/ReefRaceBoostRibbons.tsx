'use client';

/**
 * ReefRaceBoostRibbons.tsx
 *
 * Renders two flat glowing ribbon meshes on the track surface — one on each
 * long straight — indicating where the +30% speed bonus can be collected.
 *
 * Iris Xe invariants:
 *   - MeshStandardMaterial only (never ShaderMaterial).
 *   - Module-scope geometry + material — page-lifetime, allocated once.
 *   - 2 draw calls total (one mesh per ribbon).
 *   - matrixAutoUpdate=false on both meshes after mount.
 *   - No per-frame allocations — useFrame only mutates emissiveIntensity.
 *   - Subscribes to s.room?.reefStaticZones (primitive identity) — re-renders
 *     only on snapshot.init / reset, not on every entity tick.
 *
 * If the server sends reefStaticZones, ribbons are placed at the server-
 * authoritative positions. If not yet available (e.g. spectator join before
 * snapshot.init), falls back to the locally-computed positions from
 * buildReefBoostRibbonsClient().
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useActivityStore } from '@/stores/activity';
import {
  KART_Y_ABOVE_TRACK,
  buildReefBoostRibbonsClient,
  type ReefBoostRibbonClient,
} from './reef-race-config';

// ─── Module-scope geometry + material (page-lifetime, never disposed) ─────────

/** Ribbon dimensions — 8wu tall slab, lane-fraction wide.
 *  Length is computed per-ribbon from the a→b segment at mount time.
 *  We use a unit BoxGeometry and scale via the mesh's matrix. */
const _ribbonGeo = new THREE.BoxGeometry(1, 4, 1);

const _ribbonMat = new THREE.MeshStandardMaterial({
  color: '#00e676',
  emissive: '#00e676',
  emissiveIntensity: 0.6,
  roughness: 0.6,
  metalness: 0.0,
  transparent: true,
  opacity: 0.75,
  side: THREE.DoubleSide,
  depthWrite: false, // additive transparency without z-fighting the track
});

// ─── Module-scope scratch (no per-frame allocs) ────────────────────────────────

const _s = new THREE.Vector3();
const _e = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

const RIBBON_Y = KART_Y_ABOVE_TRACK + 1; // just above track surface

// ─── Single ribbon mesh ───────────────────────────────────────────────────────

interface RibbonMeshProps {
  ribbon: ReefBoostRibbonClient;
}

function RibbonMesh({ ribbon }: RibbonMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Compute segment midpoint, direction, length.
    _s.set(ribbon.a.x, RIBBON_Y, ribbon.a.y);
    _e.set(ribbon.b.x, RIBBON_Y, ribbon.b.y);
    _mid.addVectors(_s, _e).multiplyScalar(0.5);
    _dir.subVectors(_e, _s);
    const length = _dir.length();
    _dir.normalize();

    // Align mesh along the segment tangent (BoxGeometry default along Z).
    _q.setFromUnitVectors(_up, _up); // reset
    // Rotate so the mesh's Z aligns with _dir in the XZ plane.
    const angle = Math.atan2(_dir.x, _dir.z);
    mesh.rotation.set(0, angle, 0);
    mesh.position.copy(_mid);

    // Scale: X = ribbon half-width (70wu for visibility), Y = 4wu, Z = segment length.
    // RIBBON_HALF_WIDTH on the server = REEF_BODY_RADIUS * 1.6 = 35wu → full width 70wu.
    mesh.scale.set(70, 4, length);

    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, [ribbon]);

  // Gentle 1Hz glow pulse — zero allocations, just mutates float.
  useFrame(({ clock }) => {
    _ribbonMat.emissiveIntensity = 0.45 + 0.25 * Math.sin(clock.elapsedTime * Math.PI * 2);
  });

  return (
    <mesh
      ref={meshRef}
      geometry={_ribbonGeo}
      material={_ribbonMat}
      frustumCulled={false}
      matrixAutoUpdate={false}
    />
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReefRaceBoostRibbons() {
  // Primitive identity subscription — only re-renders on snapshot.init or reset.
  const serverZones = useActivityStore((s) => s.room?.reefStaticZones);

  // Use server-authoritative positions when available; fall back to local computation.
  const ribbons = useMemo<ReefBoostRibbonClient[]>(() => {
    if (serverZones?.ribbons && serverZones.ribbons.length > 0) {
      return serverZones.ribbons;
    }
    return buildReefBoostRibbonsClient();
  }, [serverZones]);

  return (
    <>
      {ribbons.map((r) => (
        <RibbonMesh key={r.id} ribbon={r} />
      ))}
    </>
  );
}
