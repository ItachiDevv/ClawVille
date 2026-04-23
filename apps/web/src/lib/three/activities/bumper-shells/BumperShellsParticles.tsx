'use client';

/**
 * BumperShellsParticles.tsx
 *
 * Module-scope burst particle pool for knockback hit VFX.
 * Pool: BURST_POOL_SIZE (4) simultaneous bursts × BURST_POINT_COUNT (16) points each.
 *
 * Iris Xe invariants:
 *   - PointsNodeMaterial (TSL) — safe on WebGPU. Falls back gracefully.
 *   - 16 points per burst max — Iris Xe fragment throughput constraint.
 *   - Float32BufferAttribute mutated in-place — no new attribute per frame.
 *   - Pool slots are mounted at scene init as visible=false — no dynamic mesh creation.
 *   - No new THREE.Vector3() inside useFrame — module-scope scratch only.
 *
 * Public API:
 *   - `triggerBurst(x, y, z, color)` — imperative, called from BumperShellsScene.
 *   - `<BumperShellsParticles />` — JSX component, mount once at scene root.
 */

import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import {
  BURST_POOL_SIZE,
  BURST_POINT_COUNT,
  BURST_RADIUS,
  BURST_LIFETIME_MS,
  BURST_POINT_SIZE,
} from './bumper-shells-config';

// ─── Module-scope pool state ──────────────────────────────────────────────────
// These live at module scope so `triggerBurst` can be called from outside React.

interface BurstSlot {
  active: boolean;
  startedAt: number;
  colorHex: string;
}

const _pool: BurstSlot[] = Array.from({ length: BURST_POOL_SIZE }, () => ({
  active: false,
  startedAt: 0,
  colorHex: '#ffffff',
}));

// Pre-computed random XZ directions for each slot×point.
// Computed once at module load — no per-frame random calls.
const _directions: Float32Array[] = Array.from({ length: BURST_POOL_SIZE }, () => {
  const d = new Float32Array(BURST_POINT_COUNT * 3);
  for (let i = 0; i < BURST_POINT_COUNT; i++) {
    const angle = (i / BURST_POINT_COUNT) * Math.PI * 2 + Math.random() * 0.5;
    d[i * 3 + 0] = Math.cos(angle);
    d[i * 3 + 1] = (Math.random() - 0.5) * 0.6; // slight Y scatter
    d[i * 3 + 2] = Math.sin(angle);
  }
  return d;
});

// Origin positions per slot — set on triggerBurst, read in useFrame.
const _origins: Array<[number, number, number]> = Array.from(
  { length: BURST_POOL_SIZE },
  () => [0, 0, 0],
);

// ─── Public imperative API ────────────────────────────────────────────────────

/**
 * Trigger a radial particle burst at the given Three.js world-space position.
 * Safe to call from outside React (e.g. from BumperShellsScene's useFrame hit handler).
 *
 * @param x Three.js world X
 * @param y Three.js world Y (usually disc top = 6)
 * @param z Three.js world Z
 * @param color CSS hex color string, e.g. '#ff6600'
 */
export function triggerBurst(x: number, y: number, z: number, color = '#ffffff'): void {
  // Find an inactive slot. If all active, steal the oldest.
  let slot = _pool.findIndex((s) => !s.active);
  if (slot === -1) {
    // Steal oldest active.
    let oldest = 0;
    let oldestTime = Infinity;
    for (let i = 0; i < BURST_POOL_SIZE; i++) {
      if (_pool[i].startedAt < oldestTime) {
        oldest = i;
        oldestTime = _pool[i].startedAt;
      }
    }
    slot = oldest;
  }

  _pool[slot].active = true;
  _pool[slot].startedAt = performance.now();
  _pool[slot].colorHex = color;
  _origins[slot][0] = x;
  _origins[slot][1] = y;
  _origins[slot][2] = z;
}

// ─── Internal per-slot component ─────────────────────────────────────────────

// Geometry and positions are shared — each slot has its own BufferGeometry
// with its own Float32BufferAttribute so updates don't interfere.

function BurstPoints({ slotIndex }: { slotIndex: number }) {
  const pointsRef = useRef<THREE.Points>(null);

  // Pre-allocate the positions buffer for this slot (BURST_POINT_COUNT * 3 floats).
  const posBuffer = useRef(new Float32Array(BURST_POINT_COUNT * 3));

  const geometry = useRef<THREE.BufferGeometry>(null!);
  const material = useRef<THREE.PointsMaterial>(null!);

  useEffect(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(posBuffer.current, 3),
    );
    geometry.current = geo;

    // PointsMaterial as fallback — PointsNodeMaterial would need TSL setup.
    // Using standard PointsMaterial: transparent + additive = acceptable on Iris Xe.
    const mat = new THREE.PointsMaterial({
      size: BURST_POINT_SIZE,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      color: new THREE.Color('#ffffff'),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    material.current = mat;

    const pts = pointsRef.current;
    if (pts) {
      pts.geometry = geo;
      pts.material = mat;
    }

    return () => {
      geo.dispose();
      mat.dispose();
    };
  }, []);

  useFrame(() => {
    const slot = _pool[slotIndex];
    const pts  = pointsRef.current;
    if (!pts) return;

    if (!slot.active) {
      if (pts.visible) pts.visible = false;
      return;
    }

    const now     = performance.now();
    const elapsed = now - slot.startedAt;
    const t       = Math.min(elapsed / BURST_LIFETIME_MS, 1);

    if (t >= 1) {
      slot.active  = false;
      pts.visible  = false;
      (material.current as THREE.PointsMaterial).opacity = 0;
      return;
    }

    pts.visible = true;

    // Update opacity on material.
    (material.current as THREE.PointsMaterial).opacity = 1 - t;
    (material.current as THREE.PointsMaterial).color.set(_pool[slotIndex].colorHex);
    (material.current as THREE.PointsMaterial).needsUpdate = true;

    // Update point positions in-place.
    const dirs   = _directions[slotIndex];
    const origin = _origins[slotIndex];
    const pos    = posBuffer.current;
    const spread = BURST_RADIUS * t; // expand outward over lifetime

    for (let i = 0; i < BURST_POINT_COUNT; i++) {
      pos[i * 3 + 0] = origin[0] + dirs[i * 3 + 0] * spread;
      pos[i * 3 + 1] = origin[1] + dirs[i * 3 + 1] * spread * 0.5;
      pos[i * 3 + 2] = origin[2] + dirs[i * 3 + 2] * spread;
    }

    if (geometry.current) {
      (geometry.current.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
  });

  return <points ref={pointsRef} frustumCulled={false} />;
}

// ─── Main exported component ──────────────────────────────────────────────────

/**
 * Mount once inside BumperShellsScene. Contains all BURST_POOL_SIZE burst slots.
 */
export default function BumperShellsParticles() {
  return (
    <group>
      {Array.from({ length: BURST_POOL_SIZE }, (_, i) => (
        <BurstPoints key={i} slotIndex={i} />
      ))}
    </group>
  );
}
