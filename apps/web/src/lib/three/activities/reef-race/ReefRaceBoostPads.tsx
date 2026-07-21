'use client';

/**
 * ReefRaceBoostPads.tsx
 *
 * v2 mechanics — WORLD render of the server-authoritative boost-pad zones as
 * vertical energy portals. Each torus is built in the XY plane, then yawed by
 * the pad heading so its +Z normal follows the track tangent and racers surf
 * through the opening.
 *
 * Position source (parity contract — WORLD↔BACKEND↔UI):
 *   1. PREFERRED: `room.reefSplineZones.boostPads` (server-authoritative
 *      world position + rotation, sent once in snapshot.init). When present,
 *      this is what actually triggers `event.boost_pad` server-side, so the
 *      client renders exactly where the sim's AABB lives.
 *   2. FALLBACK: `buildSplineBoostPadsClient()` (client-mirrored t + lateral
 *      offset, kept in sync by convention with `buildSplineBoostPads()` in
 *      `apps/api/src/services/activity/sim/reef-race-config.ts` — same
 *      pattern ramps.tsx already uses). Used when `reefSplineZones` hasn't
 *      landed on the wire yet, so portals remain visible without waiting on
 *      that last piece of server wiring.
 *
 * Buoyancy contract: every frame, each portal samples the same banked ribbon
 * datum + exported Gerstner CPU mirror as ReefRacePlayer. A light EWMA keeps
 * the moored gate responsive to swell without reflecting tiny height jitter.
 *
 * Iris Xe invariants:
 *   - Exactly two InstancedMesh draws: MeshStandardMaterial torus rings plus
 *     MeshBasicMaterial additive films. No ShaderMaterial / TSL.
 *   - One ring-material and one film-material mutation per frame.
 *   - Module-scope geometry, materials, and transform scratch.
 *   - No per-frame allocations; at most MAX_BOOST_PADS matrix writes per mesh.
 *   - Parent matrices stay static (`matrixAutoUpdate=false`); instance matrices
 *     carry the buoyant transforms.
 *
 * Draw calls: exactly 2 (ring InstancedMesh + film InstancedMesh).
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useActivityStore } from '@/stores/activity';
import {
  MAX_BOOST_PADS,
  buildSplineBoostPadsClient,
} from './reef-race-config';
import { clientSpline } from './reef-race-spline-instance';
import { bankedDatumYAtT } from './reef-race-elevation';
import { surfWaveHeightAt } from './reef-wave-height';

const PORTAL_RADIUS = 160;
const PORTAL_TUBE_RADIUS = 12;
const PORTAL_FILM_RADIUS = PORTAL_RADIUS - PORTAL_TUBE_RADIUS;
const PORTAL_CENTER_ABOVE_SURFACE = PORTAL_RADIUS * 0.6;
const PORTAL_HEIGHT_EWMA = 0.2;

// ─── Module-scope scratch (no per-frame allocations) ─────────────────────────
const _m4     = new THREE.Matrix4();
const _pos    = new THREE.Vector3();
const _quat   = new THREE.Quaternion();
const _scl    = new THREE.Vector3(1, 1, 1);
const _up     = new THREE.Vector3(0, 1, 0);
const _zeroM4 = new THREE.Matrix4().makeScale(0, 0, 0);

// ─── Shared page-lifetime geometry + materials ───────────────────────────────
const _ringGeo = new THREE.TorusGeometry(
  PORTAL_RADIUS,
  PORTAL_TUBE_RADIUS,
  12,
  48,
);
const _filmGeo = new THREE.CircleGeometry(PORTAL_FILM_RADIUS, 48);

const _ringMat = new THREE.MeshStandardMaterial({
  color: '#55eeff',
  emissive: '#00e5ff',
  emissiveIntensity: 1.15,
  roughness: 0.28,
  metalness: 0.18,
});

const _filmMat = new THREE.MeshBasicMaterial({
  color: '#00e5ff',
  transparent: true,
  opacity: 0.13,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
// DoubleSide normally renders transparent geometry in two passes. The film is
// planar and additive, so one pass preserves the two-draw-call budget.
_filmMat.forceSinglePass = true;

interface ResolvedPad {
  id: string;
  x: number;
  z: number;
  bankedDatumY: number;
  rotY: number;
}

type ServerBoostPads = NonNullable<
  NonNullable<ReturnType<typeof useActivityStore.getState>['room']>['reefSplineZones']
>['boostPads'];

/** Resolve pad positions from the server zone list (world-space, preferred). */
function resolveFromServer(serverPads: ServerBoostPads): ResolvedPad[] {
  return serverPads.map((p) => {
    const x = p.position.x;
    const z = p.position.y; // protocol y = scene Z
    const t = clientSpline.closestPointOnSpline({ x, z }).t;
    return {
      id: p.id,
      x,
      z,
      bankedDatumY: bankedDatumYAtT(x, z, t),
      rotY: p.rot,
    };
  });
}

/** Resolve pad positions from the client-mirrored spline t-list (fallback). */
function resolveFromClient(): ResolvedPad[] {
  return buildSplineBoostPadsClient().map((pad) => {
    const pt = clientSpline.centerlineAt(pad.t);
    const tang = clientSpline.tangentAt(pad.t);
    const nx = -tang.z;
    const nz = tang.x;
    const x = pt.x + nx * pad.lateralOffset;
    const z = pt.z + nz * pad.lateralOffset;
    return {
      id: pad.id,
      x,
      z,
      bankedDatumY: bankedDatumYAtT(x, z, pad.t),
      rotY: Math.atan2(tang.x, tang.z),
    };
  });
}

export default function ReefRaceBoostPads() {
  const ringRef = useRef<THREE.InstancedMesh>(null);
  const filmRef = useRef<THREE.InstancedMesh>(null);
  const smoothedYRef = useRef<Float32Array | null>(null);
  const seededYRef = useRef<Uint8Array | null>(null);
  if (smoothedYRef.current === null) {
    smoothedYRef.current = new Float32Array(MAX_BOOST_PADS);
  }
  if (seededYRef.current === null) {
    seededYRef.current = new Uint8Array(MAX_BOOST_PADS);
  }
  const smoothedY = smoothedYRef.current;
  const seededY = seededYRef.current;

  // Reference-identity subscription — only re-renders on snapshot.init / reset,
  // not on every entity tick.
  const serverPads = useActivityStore((s) => s.room?.reefSplineZones?.boostPads);

  const pads = useMemo<ResolvedPad[]>(() => {
    if (serverPads && serverPads.length > 0) {
      return resolveFromServer(serverPads).slice(0, MAX_BOOST_PADS);
    }
    return resolveFromClient().slice(0, MAX_BOOST_PADS);
  }, [serverPads]);

  useEffect(() => {
    const ring = ringRef.current;
    const film = filmRef.current;
    if (!ring || !film) return;

    seededY.fill(0);
    for (let i = 0; i < MAX_BOOST_PADS; i++) {
      ring.setMatrixAt(i, _zeroM4);
      film.setMatrixAt(i, _zeroM4);
    }
    ring.instanceMatrix.needsUpdate = true;
    film.instanceMatrix.needsUpdate = true;
    ring.matrixAutoUpdate = false;
    film.matrixAutoUpdate = false;
    ring.updateMatrix();
    film.updateMatrix();
  }, [pads, seededY]);

  useFrame(({ clock }) => {
    const ring = ringRef.current;
    const film = filmRef.current;
    if (!ring || !film) return;

    const elapsed = clock.elapsedTime;
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      const surfaceY =
        pad.bankedDatumY
        + surfWaveHeightAt(pad.x, pad.z, elapsed);
      const targetY = surfaceY + PORTAL_CENTER_ABOVE_SURFACE;

      if (seededY[i] === 0) {
        smoothedY[i] = targetY;
        seededY[i] = 1;
      } else {
        smoothedY[i] += (targetY - smoothedY[i]) * PORTAL_HEIGHT_EWMA;
      }

      _pos.set(pad.x, smoothedY[i], pad.z);
      _quat.setFromAxisAngle(_up, pad.rotY);
      _m4.compose(_pos, _quat, _scl);
      ring.setMatrixAt(i, _m4);
      film.setMatrixAt(i, _m4);
    }
    ring.instanceMatrix.needsUpdate = true;
    film.instanceMatrix.needsUpdate = true;

    // Exactly one shared-material mutation per draw each frame.
    _ringMat.emissiveIntensity =
      1.05 + 0.35 * Math.sin(elapsed * Math.PI * 2 * 0.7);
    _filmMat.opacity =
      0.13 + 0.025 * Math.sin(elapsed * Math.PI * 2 * 0.55);
  });

  return (
    <>
      <instancedMesh
        ref={ringRef}
        args={[_ringGeo, _ringMat, MAX_BOOST_PADS]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={filmRef}
        args={[_filmGeo, _filmMat, MAX_BOOST_PADS]}
        frustumCulled={false}
      />
    </>
  );
}
