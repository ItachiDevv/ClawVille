'use client';

/**
 * BumperShellsPickups.tsx
 *
 * 6 pre-allocated pickup slots: TorusKnotGeometry prop + drei <Html> emoji label.
 *
 * All 6 meshes are mounted at scene init, toggled via visible=true/false on spawn/despawn.
 * No mesh creation during gameplay — avoids GC pressure and pipeline recompilation on Iris Xe.
 *
 * Iris Xe invariants:
 *   - NO drei <Text> — hard GPU crash. Emoji labels use drei <Html> (DOM overlay).
 *   - NO distanceFactor on <Html> — per-frame camera-distance recompute (perf-sweep 2026-04-21).
 *   - Label visibility toggled via labelRef.current.style.display imperatively in useFrame,
 *     NOT via React state or group.visible (drei <Html> ignores parent visible).
 *   - matrixAutoUpdate=false on all 6 pickup meshes after initial position set.
 *   - Per-frame position.y mutation via ref (no new Vector3 allocations).
 *
 * Draw calls: up to 6 (one TorusKnotGeometry per active pickup).
 */

import { useRef, useEffect, useMemo, Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import type { BumperPickup } from './bumper-shells-types';
import {
  MAX_PICKUPS,
  PICKUP_TORUS_RADIUS,
  PICKUP_TUBE_RADIUS,
  PICKUP_TUBULAR_SEGMENTS,
  PICKUP_RADIAL_SEGMENTS,
  PICKUP_BOB_AMP,
  PICKUP_BOB_FREQ,
  PICKUP_SPIN_SPEED,
  PICKUP_BASE_Y,
  PICKUP_EMISSIVE,
  PICKUP_EMOJI,
} from './bumper-shells-config';

// ─── Module-scope scratch + time accumulator ─────────────────────────────────
// One shared time counter for all pickups — no per-pickup time state.
let _pickupTime = 0;

// ─── Geometry singleton — shared across all pickup slots ──────────────────────
const pickupGeo = new THREE.TorusKnotGeometry(
  PICKUP_TORUS_RADIUS,
  PICKUP_TUBE_RADIUS,
  PICKUP_TUBULAR_SEGMENTS,
  PICKUP_RADIAL_SEGMENTS,
);

// ─── Pickup material pool ─────────────────────────────────────────────────────
// One material per pickup kind, created lazily. Never ShaderMaterial.
const materialCache: Record<string, THREE.MeshStandardMaterial> = {};

function getPickupMat(kind: string): THREE.MeshStandardMaterial {
  if (materialCache[kind]) return materialCache[kind];
  const emissiveHex = PICKUP_EMISSIVE[kind] ?? '#ffffff';
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#1a1a2e'),
    emissive: new THREE.Color(emissiveHex),
    emissiveIntensity: 0.9,
    roughness: 0.3,
    metalness: 0.6,
  });
  materialCache[kind] = mat;
  return mat;
}

// ─── Single pickup slot ───────────────────────────────────────────────────────

interface PickupSlotProps {
  slotIndex: number;
  pickup: BumperPickup | null;
}

function PickupSlot({ slotIndex, pickup }: PickupSlotProps) {
  const meshRef  = useRef<THREE.Mesh>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  // Pre-resolve material — changes when kind changes (rare).
  const mat = useMemo(
    () => getPickupMat(pickup?.kind ?? 'speed'),
    [pickup?.kind],
  );

  // Update mesh matrix when pickup position changes.
  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    if (!pickup) {
      m.visible = false;
      // Hide label imperatively — drei <Html> ignores parent visible.
      if (labelRef.current) labelRef.current.style.display = 'none';
      return;
    }
    m.position.set(pickup.x, PICKUP_BASE_Y, pickup.y);
    m.visible = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    if (labelRef.current) labelRef.current.style.display = 'flex';
  }, [pickup]);

  // Bob and spin — mutate position.y and rotation.y, no allocations.
  useFrame(() => {
    if (!pickup) return;
    const m = meshRef.current;
    if (!m || !m.visible) return;

    m.position.y = PICKUP_BASE_Y + Math.sin(_pickupTime * PICKUP_BOB_FREQ + slotIndex * 0.8) * PICKUP_BOB_AMP;
    m.rotation.y += PICKUP_SPIN_SPEED * 0.016; // ~60fps delta approximation (cheap)
    // matrixAutoUpdate is false — must update manually.
    m.updateMatrix();

    // Sync label visibility with mesh visibility.
    if (labelRef.current) {
      const display = m.visible ? 'flex' : 'none';
      if (labelRef.current.style.display !== display) {
        labelRef.current.style.display = display;
      }
    }
  });

  return (
    <group>
      <mesh
        ref={meshRef}
        geometry={pickupGeo}
        material={mat}
        visible={false}
        castShadow
        frustumCulled={false}
      />
      {/* Html label — DOM overlay, safe on Iris Xe. NO distanceFactor. */}
      {pickup && (
        <Html
          position={[
            pickup.x,
            PICKUP_BASE_Y + PICKUP_TORUS_RADIUS + 16,
            pickup.y,
          ]}
          center
          occlude={false}
          zIndexRange={[10, 100]}
        >
          <div
            ref={labelRef}
            style={{
              display: 'none',
              fontSize: '22px',
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          >
            {PICKUP_EMOJI[pickup.kind] ?? '?'}
          </div>
        </Html>
      )}
    </group>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface BumperShellsPickupsProps {
  /** Live pickups from the activity store. Map<spawnId, BumperPickup>. */
  pickups: Map<string, BumperPickup>;
}

export default function BumperShellsPickups({ pickups }: BumperShellsPickupsProps) {
  // Advance the shared time accumulator once per frame.
  // Using a static ref to avoid module-level mutation from multiple instances.
  useFrame((state) => {
    _pickupTime = state.clock.elapsedTime;
  });

  // Stable slot array — always render MAX_PICKUPS slots.
  // Map pickup data into indexed slots so slot identity stays stable.
  const slots = useMemo(() => {
    const arr: Array<BumperPickup | null> = Array(MAX_PICKUPS).fill(null);
    let i = 0;
    for (const p of pickups.values()) {
      if (i >= MAX_PICKUPS) break;
      arr[i++] = p;
    }
    return arr;
  }, [pickups]);

  return (
    <group>
      {slots.map((pickup, idx) => (
        <PickupSlot key={idx} slotIndex={idx} pickup={pickup} />
      ))}
    </group>
  );
}
