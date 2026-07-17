'use client';

/**
 * ReefRaceBoostPads.tsx
 *
 * v2 mechanics — WORLD render of the server-authoritative boost-pad zones
 * (Mario-Kart floor boost strips). Renders one glowing flat marker per pad,
 * elevation-aware on the floating SURF ROAD ribbon (same technique as
 * ramps.tsx / ReefRacePickups.tsx).
 *
 * Position source (parity contract — WORLD↔BACKEND↔UI):
 *   1. PREFERRED: `room.reefSplineZones.boostPads` (server-authoritative
 *      world position + rotation, sent once in snapshot.init). When present,
 *      this is what actually triggers `event.boost_pad` server-side, so the
 *      client renders exactly where the sim's AABB lives. Elevation is
 *      re-derived from world XZ via `elevationAtXZ` (same technique
 *      ReefRacePickups.tsx uses for server-positioned pickups — the sim is
 *      purely 2D and doesn't know about the render-only ribbon height).
 *   2. FALLBACK: `buildSplineBoostPadsClient()` (client-mirrored t + lateral
 *      offset, kept in sync by convention with `buildSplineBoostPads()` in
 *      `apps/api/src/services/activity/sim/reef-race-config.ts` — same
 *      pattern ramps.tsx already uses). Used when `reefSplineZones` hasn't
 *      landed on the wire yet, so pads are still visible without waiting on
 *      that last piece of server wiring.
 *
 * Iris Xe invariants:
 *   - InstancedMesh + MeshStandardMaterial (safe — no ShaderMaterial, matches
 *     ReefRacePickups.tsx exactly).
 *   - Positions built ONCE per pad-list change (useEffect), not per-frame.
 *   - Single material mutation per frame (emissive pulse) — matches
 *     ReefRaceBoostRibbons.tsx's glow-pulse pattern, no per-instance cost.
 *   - Module-scope scratch matrix/vector/quaternion — no per-frame allocations.
 *   - matrixAutoUpdate=false — positions never change after mount.
 *
 * Draw calls: 1 (InstancedMesh).
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useActivityStore } from '@/stores/activity';
import {
  BOOST_PAD_VISUAL_LENGTH,
  BOOST_PAD_VISUAL_WIDTH,
  BOOST_PAD_Y_ABOVE_TRACK,
  MAX_BOOST_PADS,
  buildSplineBoostPadsClient,
} from './reef-race-config';
import { clientSpline } from './reef-race-spline-instance';
import { elevationAtT, elevationAtXZ } from './reef-race-elevation';

// ─── Module-scope scratch (no per-frame allocations) ─────────────────────────
const _m4     = new THREE.Matrix4();
const _pos    = new THREE.Vector3();
const _quat   = new THREE.Quaternion();
const _scl    = new THREE.Vector3(1, 1, 1);
const _up     = new THREE.Vector3(0, 1, 0);
const _zeroM4 = new THREE.Matrix4().makeScale(0, 0, 0);

// ─── Module-scope geometry + material (page-lifetime) ────────────────────────
const _padGeo = new THREE.BoxGeometry(BOOST_PAD_VISUAL_WIDTH, 5, BOOST_PAD_VISUAL_LENGTH);
const _padMat = new THREE.MeshStandardMaterial({
  color: '#00e5ff',
  emissive: '#00e5ff',
  emissiveIntensity: 0.7,
  roughness: 0.35,
  metalness: 0.15,
  transparent: true,
  opacity: 0.82,
  side: THREE.DoubleSide,
  depthWrite: false,
});

interface ResolvedPad {
  id: string;
  x: number;
  z: number;
  y: number;
  rotY: number;
}

type ServerBoostPads = NonNullable<
  NonNullable<ReturnType<typeof useActivityStore.getState>['room']>['reefSplineZones']
>['boostPads'];

/** Resolve pad positions from the server zone list (world-space, preferred). */
function resolveFromServer(serverPads: ServerBoostPads): ResolvedPad[] {
  return serverPads.map((p) => ({
    id: p.id,
    x: p.position.x,
    z: p.position.y, // protocol y = scene Z
    y: elevationAtXZ(p.position.x, p.position.y, `boostpad-${p.id}`) + BOOST_PAD_Y_ABOVE_TRACK,
    rotY: p.rot,
  }));
}

/** Resolve pad positions from the client-mirrored spline t-list (fallback). */
function resolveFromClient(): ResolvedPad[] {
  return buildSplineBoostPadsClient().map((pad) => {
    const pt = clientSpline.centerlineAt(pad.t);
    const tang = clientSpline.tangentAt(pad.t);
    const nx = -tang.z;
    const nz = tang.x;
    return {
      id: pad.id,
      x: pt.x + nx * pad.lateralOffset,
      z: pt.z + nz * pad.lateralOffset,
      y: elevationAtT(pad.t) + BOOST_PAD_Y_ABOVE_TRACK,
      rotY: Math.atan2(tang.x, tang.z),
    };
  });
}

export default function ReefRaceBoostPads() {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  // Reference-identity subscription — only re-renders on snapshot.init /
  // reset (matches ReefRaceBoostRibbons.tsx's `s.room?.reefStaticZones`
  // subscription pattern), NOT on every entity tick.
  const serverPads = useActivityStore((s) => s.room?.reefSplineZones?.boostPads);

  const pads = useMemo<ResolvedPad[]>(() => {
    if (serverPads && serverPads.length > 0) {
      return resolveFromServer(serverPads).slice(0, MAX_BOOST_PADS);
    }
    return resolveFromClient().slice(0, MAX_BOOST_PADS);
  }, [serverPads]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    pads.forEach((pad, i) => {
      _pos.set(pad.x, pad.y, pad.z);
      _quat.setFromAxisAngle(_up, pad.rotY);
      _scl.set(1, 1, 1);
      _m4.compose(_pos, _quat, _scl);
      mesh.setMatrixAt(i, _m4);
    });
    // Hide unused instance slots (fewer pads than the max-allocated count).
    for (let i = pads.length; i < MAX_BOOST_PADS; i++) {
      mesh.setMatrixAt(i, _zeroM4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, [pads]);

  // Gentle glow pulse — ONE material mutation/frame, not per-instance
  // (matches ReefRaceBoostRibbons.tsx's _ribbonMat.emissiveIntensity pattern).
  useFrame(({ clock }) => {
    _padMat.emissiveIntensity = 0.55 + 0.3 * Math.sin(clock.elapsedTime * Math.PI * 2 * 0.7);
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[_padGeo, _padMat, MAX_BOOST_PADS]}
      frustumCulled={false}
    />
  );
}
