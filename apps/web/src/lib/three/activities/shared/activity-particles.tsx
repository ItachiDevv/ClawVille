'use client';

/**
 * activity-particles.tsx
 *
 * Shared reusable burst particle pool for both Bumper Shells and Reef Race.
 * 8 pool slots × 16 Points each = 128 max simultaneous particles.
 *
 * Iris Xe invariants:
 *   - PointsMaterial with AdditiveBlending — safe on both WebGL and WebGPU.
 *   - Float32BufferAttribute mutated in-place — no per-frame allocations.
 *   - All 8 Points objects mounted at scene init as visible=false.
 *   - Pre-computed random directions per slot at module load — no per-burst RNG.
 *   - Module-scope pool state — triggerBurst() is imperative, zero React re-renders.
 *
 * API:
 *   - `triggerBurst(position, color, radius)` — imperative, call from useFrame or event handler.
 *   - `<ActivityBursts />` — JSX component, mount once at scene root.
 *
 * Per 3d-spec §3.3:
 *   Pool size = 8 (both games combined), each burst = 16 Points.
 *   Trail emitter (Reef Race boost) is NOT shared — lives in ReefRaceBoostFX.tsx.
 */

import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// ─── Configuration ────────────────────────────────────────────────────────────

const SHARED_BURST_POOL_SIZE  = 8;
const SHARED_BURST_POINT_COUNT = 16;
const DEFAULT_BURST_LIFETIME_MS = 400;

// ─── Module-scope pool state ──────────────────────────────────────────────────

interface SharedBurstSlot {
  active: boolean;
  startedAt: number;
  colorHex: string;
  radius: number;
}

const _sharedPool: SharedBurstSlot[] = Array.from(
  { length: SHARED_BURST_POOL_SIZE },
  () => ({ active: false, startedAt: 0, colorHex: '#ffffff', radius: 80 }),
);

// Pre-computed random spread directions for each slot (never changes).
const _sharedDirections: Float32Array[] = Array.from(
  { length: SHARED_BURST_POOL_SIZE },
  (_, slotIdx) => {
    const d = new Float32Array(SHARED_BURST_POINT_COUNT * 3);
    for (let i = 0; i < SHARED_BURST_POINT_COUNT; i++) {
      const angle = (i / SHARED_BURST_POINT_COUNT) * Math.PI * 2 + (slotIdx * 0.3);
      d[i * 3 + 0] = Math.cos(angle);
      d[i * 3 + 1] = (Math.random() * 0.6) - 0.3; // slight Y scatter
      d[i * 3 + 2] = Math.sin(angle);
    }
    return d;
  },
);

// Origin positions per slot.
const _sharedOrigins: Array<THREE.Vector3> = Array.from(
  { length: SHARED_BURST_POOL_SIZE },
  () => new THREE.Vector3(),
);

// ─── Public imperative API ────────────────────────────────────────────────────

/**
 * Trigger a shared burst at a Three.js world-space position.
 * Safe to call outside React — no state mutation, no re-renders.
 *
 * @param position  THREE.Vector3 world position of the burst origin.
 * @param color     CSS color string, e.g. '#ff6600'.
 * @param radius    Spread radius in world-units. Default: 80.
 */
export function triggerBurst(
  position: THREE.Vector3,
  color = '#ffffff',
  radius = 80,
): void {
  // Find inactive slot; steal oldest if all active.
  let slot = _sharedPool.findIndex((s) => !s.active);
  if (slot === -1) {
    let oldest = 0;
    let oldestTime = Infinity;
    for (let i = 0; i < SHARED_BURST_POOL_SIZE; i++) {
      if (_sharedPool[i].startedAt < oldestTime) {
        oldest = i;
        oldestTime = _sharedPool[i].startedAt;
      }
    }
    slot = oldest;
  }

  _sharedPool[slot].active    = true;
  _sharedPool[slot].startedAt = performance.now();
  _sharedPool[slot].colorHex  = color;
  _sharedPool[slot].radius    = radius;
  _sharedOrigins[slot].copy(position);
}

// ─── Internal per-slot component ─────────────────────────────────────────────

function SharedBurstPoints({ slotIndex }: { slotIndex: number }) {
  const pointsRef = useRef<THREE.Points>(null);
  const posBuffer = useRef(new Float32Array(SHARED_BURST_POINT_COUNT * 3));

  useEffect(() => {
    const pts = pointsRef.current;
    if (!pts) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(posBuffer.current, 3),
    );

    const mat = new THREE.PointsMaterial({
      size: 6,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      color: new THREE.Color('#ffffff'),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    pts.geometry = geo;
    pts.material = mat;

    return () => {
      geo.dispose();
      mat.dispose();
    };
  }, []);

  useFrame(() => {
    const slot = _sharedPool[slotIndex];
    const pts  = pointsRef.current;
    if (!pts) return;

    if (!slot.active) {
      if (pts.visible) pts.visible = false;
      return;
    }

    const elapsed = performance.now() - slot.startedAt;
    const t = Math.min(elapsed / DEFAULT_BURST_LIFETIME_MS, 1);

    if (t >= 1) {
      slot.active = false;
      pts.visible = false;
      return;
    }

    pts.visible = true;

    const mat = pts.material as THREE.PointsMaterial;
    mat.opacity = 1 - t;
    mat.color.set(_sharedPool[slotIndex].colorHex);
    mat.needsUpdate = true;

    const dirs   = _sharedDirections[slotIndex];
    const origin = _sharedOrigins[slotIndex];
    const pos    = posBuffer.current;
    const spread = _sharedPool[slotIndex].radius * t;

    for (let i = 0; i < SHARED_BURST_POINT_COUNT; i++) {
      pos[i * 3 + 0] = origin.x + dirs[i * 3 + 0] * spread;
      pos[i * 3 + 1] = origin.y + dirs[i * 3 + 1] * spread * 0.5;
      pos[i * 3 + 2] = origin.z + dirs[i * 3 + 2] * spread;
    }

    if (pts.geometry) {
      (pts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
  });

  return <points ref={pointsRef} frustumCulled={false} />;
}

// ─── Main exported component ──────────────────────────────────────────────────

/**
 * Mount once inside the activity scene root.
 * Contains all SHARED_BURST_POOL_SIZE (8) burst Point objects.
 * Both Bumper Shells and Reef Race can share this component.
 */
export function ActivityBursts() {
  return (
    <group>
      {Array.from({ length: SHARED_BURST_POOL_SIZE }, (_, i) => (
        <SharedBurstPoints key={i} slotIndex={i} />
      ))}
    </group>
  );
}
