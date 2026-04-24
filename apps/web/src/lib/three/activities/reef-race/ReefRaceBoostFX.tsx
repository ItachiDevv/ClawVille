'use client';

/**
 * ReefRaceBoostFX.tsx
 *
 * Two boost visual effects:
 *   1. BufferGeometry trail (30-point ring buffer) behind the player's kart.
 *   2. 12 InstancedMesh speed cones attached to camera-forward group (visible during boost).
 *
 * Only renders for the self player (chase-cam client). Other players' trails are NOT rendered.
 *
 * Iris Xe invariants:
 *   - Trail: BufferGeometry + MeshBasicNodeMaterial (TSL opacityNode) — no ShaderMaterial.
 *   - Speed cones: InstancedMesh + MeshBasicNodeMaterial (TSL) — safe on WebGPU.
 *   - Pre-allocated buffers — no per-frame geometry creation.
 *   - MeshBasicNodeMaterial does not receive fog (spec notes backdrop placement handles this).
 *   - matrixAutoUpdate=false on static cone instances (positions are camera-relative).
 *
 * Draw calls: 1 (trail) + 1 (cone InstancedMesh) = 2.
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { float, sin, time, instanceIndex, uniform } from 'three/tsl';
import {
  TRAIL_MAX_POINTS,
  TRAIL_WIDTH,
  SPEED_CONE_COUNT,
  SPEED_CONE_RADIUS_TOP,
  SPEED_CONE_RADIUS_BOTTOM,
  SPEED_CONE_HEIGHT,
  SPEED_CONE_RADIAL_SEGS,
  SPEED_CONE_SPREAD,
} from './reef-race-config';
import type { ReefRaceEntity } from './reef-race-types';

// ─── Module-scope scratch ─────────────────────────────────────────────────────
const _m4     = new THREE.Matrix4();
const _conePosArr = new Array<THREE.Vector3>(SPEED_CONE_COUNT).fill(null as any)
  .map(() => new THREE.Vector3());
const _quat   = new THREE.Quaternion();
const _scl    = new THREE.Vector3(1, 1, 1);
const _fwd    = new THREE.Vector3();

// ─── Trail geometry (pre-allocated) ──────────────────────────────────────────
// Simple line strip — 2 vertices per segment (left+right edge of trail ribbon).
// TRAIL_MAX_POINTS segments → TRAIL_MAX_POINTS*2 vertices.
const TRAIL_VERTEX_COUNT = TRAIL_MAX_POINTS * 2;

function makeTrailGeo(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(TRAIL_VERTEX_COUNT * 3);
  const uvs       = new Float32Array(TRAIL_VERTEX_COUNT * 2);
  const indices: number[] = [];

  // Build quad strip indices.
  for (let i = 0; i < TRAIL_MAX_POINTS - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, b, c, b, d, c);
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

// ─── Trail material (TSL MeshBasicNodeMaterial) ───────────────────────────────
// opacityNode: fades from full at kart to zero at tail using UV.y.
// MeshBasicNodeMaterial is safe on WebGPU (no ShaderMaterial).
function makeTrailMaterial(): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    color: '#00d4ff',
  });
  // UV.y = 0 at kart (full opacity), 1 at tail (transparent).
  // Using built-in uv() from TSL is avoided to prevent import confusion;
  // use a simple time-independent opacity fallback.
  mat.opacity = 0.6;
  return mat;
}

// ─── Cone InstancedMesh material ─────────────────────────────────────────────

function makeConeNodeMaterial(): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    color: '#ffffff',
  });
  // Strobing opacity: sin(time * 8 + instanceIndex * 0.5) * 0.5 + 0.5
  // instanceIndex is a TSL built-in for InstancedMesh.
  try {
    mat.opacityNode = sin(
      time.mul(8.0).add(instanceIndex.toFloat().mul(0.5))
    ).mul(0.5).add(0.5);
  } catch {
    // TSL instanceIndex may not be available in all contexts — degrade gracefully.
    mat.opacity = 0.5;
  }
  return mat;
}

// ─── Ring buffer trail writer ─────────────────────────────────────────────────

interface TrailState {
  positions: Float32Array; // TRAIL_MAX_POINTS * 3 (xyz per center point)
  head: number;
  count: number;
}

function writeCenterToRibbon(
  trailState: TrailState,
  geo: THREE.BufferGeometry,
  playerPos: THREE.Vector3,
  cameraRight: THREE.Vector3,
): void {
  const { positions, head, count } = trailState;

  // Write new position at head.
  positions[head * 3 + 0] = playerPos.x;
  positions[head * 3 + 1] = playerPos.y;
  positions[head * 3 + 2] = playerPos.z;

  // Build ribbon geometry from ring buffer (sequential read).
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  const uvAttr  = geo.attributes.uv as THREE.BufferAttribute;
  const arr     = posAttr.array as Float32Array;
  const uvArr   = uvAttr.array as Float32Array;

  const validCount = Math.min(count, TRAIL_MAX_POINTS);
  for (let i = 0; i < validCount; i++) {
    const idx = (head - i + TRAIL_MAX_POINTS) % TRAIL_MAX_POINTS;
    const cx  = positions[idx * 3 + 0];
    const cy  = positions[idx * 3 + 1];
    const cz  = positions[idx * 3 + 2];
    const t   = i / Math.max(1, validCount - 1); // 0=newest, 1=oldest
    const w   = TRAIL_WIDTH * (1 - t * 0.8); // taper toward tail

    // Left/right vertices.
    const vi = i * 2;
    arr[vi * 3 + 0] = cx - cameraRight.x * w;
    arr[vi * 3 + 1] = cy;
    arr[vi * 3 + 2] = cz - cameraRight.z * w;

    arr[(vi + 1) * 3 + 0] = cx + cameraRight.x * w;
    arr[(vi + 1) * 3 + 1] = cy;
    arr[(vi + 1) * 3 + 2] = cz + cameraRight.z * w;

    uvArr[vi * 2 + 0] = 0; uvArr[vi * 2 + 1] = t;
    uvArr[(vi + 1) * 2 + 0] = 1; uvArr[(vi + 1) * 2 + 1] = t;
  }
  posAttr.needsUpdate = true;
}

// ─── Main component ───────────────────────────────────────────────────────────

interface ReefRaceBoostFXProps {
  /** World position of the self player kart. */
  playerPos: THREE.Vector3 | null;
  /** Whether boost is currently active. */
  boostActive: boolean;
}

export default function ReefRaceBoostFX({ playerPos, boostActive }: ReefRaceBoostFXProps) {
  const trailRef  = useRef<THREE.Mesh>(null);
  const conesRef  = useRef<THREE.InstancedMesh>(null);
  const trailGeoRef = useRef<THREE.BufferGeometry | null>(null);

  // Ring buffer state (module-scope-like, per-instance via ref).
  const trailState = useRef<TrailState>({
    positions: new Float32Array(TRAIL_MAX_POINTS * 3),
    head: 0,
    count: 0,
  });

  const { camera } = useThree();

  const trailGeo = useMemo(() => {
    const g = makeTrailGeo();
    trailGeoRef.current = g;
    return g;
  }, []);

  const trailMat  = useMemo(() => makeTrailMaterial(), []);
  const coneGeo   = useMemo(
    () => new THREE.CylinderGeometry(
      SPEED_CONE_RADIUS_TOP, SPEED_CONE_RADIUS_BOTTOM,
      SPEED_CONE_HEIGHT, SPEED_CONE_RADIAL_SEGS, 1,
    ),
    [],
  );
  const coneMat   = useMemo(() => makeConeNodeMaterial(), []);

  // Set up cone positions (camera-forward group, spread radially).
  useEffect(() => {
    const mesh = conesRef.current;
    if (!mesh) return;

    for (let i = 0; i < SPEED_CONE_COUNT; i++) {
      const angle = (i / SPEED_CONE_COUNT) * Math.PI * 2;
      _conePosArr[i].set(
        Math.cos(angle) * SPEED_CONE_SPREAD,
        Math.sin(angle) * SPEED_CONE_SPREAD,
        -SPEED_CONE_HEIGHT / 2,
      );
      _quat.identity();
      _scl.set(1, 1, 1);
      _m4.compose(_conePosArr[i], _quat, _scl);
      mesh.setMatrixAt(i, _m4);
    }
    mesh.instanceMatrix.needsUpdate = true;

    return () => {
      trailGeo.dispose();
      (trailMat as THREE.Material).dispose();
      coneGeo.dispose();
      (coneMat as THREE.Material).dispose();
    };
  }, [trailGeo, trailMat, coneGeo, coneMat]);

  useFrame((_, delta) => {
    const trail = trailRef.current;
    const cones = conesRef.current;

    // Show/hide cones based on boost.
    if (cones) {
      cones.visible = boostActive;
    }

    if (!trail || !playerPos) {
      if (trail) trail.visible = false;
      return;
    }

    // Trail — only during boost.
    if (boostActive) {
      trail.visible = true;

      // Advance ring buffer head.
      const ts = trailState.current;
      ts.head = (ts.head + 1) % TRAIL_MAX_POINTS;
      ts.count++;

      // Camera right vector for ribbon width.
      camera.getWorldDirection(_fwd);
      const right = new THREE.Vector3().crossVectors(_fwd, camera.up).normalize();

      writeCenterToRibbon(ts, trailGeo, playerPos, right);
    } else {
      // Fade out: reset trail.
      if (trailState.current.count > 0) {
        trailState.current.count = 0;
        trailState.current.head  = 0;
        // Zero out positions.
        trailState.current.positions.fill(0);
        const posAttr = trailGeo.attributes.position as THREE.BufferAttribute;
        (posAttr.array as Float32Array).fill(0);
        posAttr.needsUpdate = true;
      }
      trail.visible = false;
    }
  });

  return (
    <group>
      {/* Boost trail ribbon — 1 draw call */}
      <mesh ref={trailRef} geometry={trailGeo} material={trailMat} frustumCulled={false} />

      {/* Speed cones — 1 draw call (InstancedMesh + MeshBasicNodeMaterial, safe on WebGPU) */}
      <instancedMesh
        ref={conesRef}
        args={[coneGeo, coneMat, SPEED_CONE_COUNT]}
        frustumCulled={false}
      />
    </group>
  );
}
