'use client';

/**
 * BumperShellsParticles.tsx
 *
 * REBUILT 2026-04-24 — Module-scope burst particle pool for impact VFX.
 *
 * Pool: BURST_POOL_SIZE (6) simultaneous bursts × BURST_POINT_COUNT (12) points each.
 * Each burst: quads scatter outward + upward from impact point over BURST_LIFETIME_MS.
 * Additive blending gives a hot-plasma look without alpha sorting.
 *
 * Iris Xe invariants:
 *   - PointsMaterial (standard) — safe on WebGPU (no ShaderMaterial).
 *   - ≤12 points per burst — Iris Xe fragment throughput constraint.
 *   - Float32BufferAttribute mutated in-place — no new attribute per frame.
 *   - Pool slots mounted at scene init as visible=false — no dynamic mesh creation.
 *   - No new THREE.Vector3() inside useFrame — module-scope scratch only.
 *
 * Public API:
 *   - `triggerBurst(x, y, z, color)` — imperative.
 *   - `<BumperShellsParticles />` — mount once at scene root.
 */

import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
// PERF FIX 2026-04-24: 'three' not 'three/webgpu' — two THREE instances = GPU context loss
import * as THREE from 'three';
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

// Pre-computed deterministic spread directions for each slot×point.
// Computed once at module load — no per-frame random calls, deterministic seed.
const _directions: Float32Array[] = Array.from({ length: BURST_POOL_SIZE }, (_, si) => {
  const d = new Float32Array(BURST_POINT_COUNT * 3);
  for (let i = 0; i < BURST_POINT_COUNT; i++) {
    const seed = (si * 1000 + i * 137);
    const angle = (i / BURST_POINT_COUNT) * Math.PI * 2 + (seed % 100) * 0.063;
    const upBias = ((seed * 7) % 100) / 100; // 0..1, biased upward for aerial look
    d[i * 3 + 0] = Math.cos(angle) * (0.6 + upBias * 0.4);
    d[i * 3 + 1] = 0.3 + upBias * 0.7; // more pronounced upward scatter
    d[i * 3 + 2] = Math.sin(angle) * (0.6 + upBias * 0.4);
    // Normalise
    const len = Math.sqrt(d[i*3]*d[i*3] + d[i*3+1]*d[i*3+1] + d[i*3+2]*d[i*3+2]);
    d[i*3] /= len; d[i*3+1] /= len; d[i*3+2] /= len;
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

    // PointsMaterial — safe on WebGPU/WebGL; additive blending = hot-plasma look.
    const mat = new THREE.PointsMaterial({
      size: BURST_POINT_SIZE,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      color: new THREE.Color('#ff8800'),
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
