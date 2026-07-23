'use client';

/**
 * ReefRacePickups.tsx
 *
 * 30 InstancedMesh '?-block' boxes pre-allocated at scene init.
 * Collected pickups are hidden by setting their instance matrix to zero-scale.
 * Respawns: matrix restored to normal position/scale.
 *
 * Iris Xe invariants:
 *   - InstancedMesh + MeshStandardMaterial (safe on WebGPU — no ShaderMaterial crash).
 *   - Canvas-generated '?' texture created once at module scope.
 *   - Active instances spin around their own cached world-space centers.
 *   - Standard/double/gamble variants use instance tint + scale in this same draw.
 *   - No per-frame allocations — module-scope transform scratch + fixed slot cache.
 *   - matrixAutoUpdate=false on static instances.
 *
 * Draw calls: 1 (InstancedMesh).
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useActivityStore } from '@/stores/activity';
import {
  MAX_PICKUPS,
  PICKUP_BOX_SIZE,
  PICKUP_SPIN_SPEED,
  PICKUP_Y_ABOVE_TRACK,
  PICKUP_TEXTURE_SIZE,
} from './reef-race-config';
import type { ReefRaceEntity } from './reef-race-types';
import { elevationAtXZ } from './reef-race-elevation';

// SURF ROAD (2026-06-23): pickups sit ON the floating ribbon, so their Y is the
// render-only ribbon elevation at their XZ (+ PICKUP_Y_ABOVE_TRACK hover) — NOT
// a flat plane. Positions are set once on spawn (not per-frame) so the
// elevation lookup cost is negligible.
const USE_SPLINE = process.env.NEXT_PUBLIC_REEF_RACE_USE_SPLINE === 'true';

// ─── Module-scope scratch ─────────────────────────────────────────────────────
const _m4       = new THREE.Matrix4();
const _zeroM4   = new THREE.Matrix4().makeScale(0, 0, 0);
const _pos      = new THREE.Vector3();
const _quat     = new THREE.Quaternion();
const _scl      = new THREE.Vector3(1, 1, 1);
const _up       = new THREE.Vector3(0, 1, 0);
const _instanceColor = new THREE.Color();
let _spinAngle  = 0;

const VARIANT_STANDARD = 0;
const VARIANT_DOUBLE = 1;
const VARIANT_GAMBLE = 2;

function variantCode(variant: unknown): number {
  return variant === 'double'
    ? VARIANT_DOUBLE
    : variant === 'gamble'
      ? VARIANT_GAMBLE
      : VARIANT_STANDARD;
}

// ─── Canvas texture (module scope) ───────────────────────────────────────────
// Created once for the lifetime of the module (not per-mount).
let _pickupTexture: THREE.CanvasTexture | null = null;

function getPickupTexture(): THREE.CanvasTexture {
  if (_pickupTexture) return _pickupTexture;
  const size = PICKUP_TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Yellow/orange background
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#ffcc00');
  grad.addColorStop(1, '#ff8800');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Neutral bright outline: per-instance tint leaves standard white, turns
  // double boxes gold, and color-cycles gamble boxes without another draw.
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.strokeRect(3, 3, size - 6, size - 6);

  // '?' text
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.floor(size * 0.6)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', size / 2, size / 2 + 2);

  _pickupTexture = new THREE.CanvasTexture(canvas);
  _pickupTexture.wrapS = THREE.RepeatWrapping;
  _pickupTexture.wrapT = THREE.RepeatWrapping;
  return _pickupTexture;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReefRacePickups() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const pickups = useActivityStore((state) => state.pickups);

  // Track which spawnId occupies which instance slot.
  const slotMap = useRef<Map<string, number>>(new Map());
  // Fixed xyz cache indexed by instance slot. Elevation is resolved only when
  // a spawn first becomes active; the per-frame spin reuses these world coords.
  const slotPositionsRef = useRef<Float32Array | null>(null);
  const occupiedSlotsRef = useRef<Uint8Array | null>(null);
  const slotVariantsRef = useRef<Uint8Array | null>(null);
  if (slotPositionsRef.current === null) {
    slotPositionsRef.current = new Float32Array(MAX_PICKUPS * 3);
  }
  if (occupiedSlotsRef.current === null) {
    occupiedSlotsRef.current = new Uint8Array(MAX_PICKUPS);
  }
  if (slotVariantsRef.current === null) {
    slotVariantsRef.current = new Uint8Array(MAX_PICKUPS);
  }
  const slotPositions = slotPositionsRef.current;
  const occupiedSlots = occupiedSlotsRef.current;
  const slotVariants = slotVariantsRef.current;
  const nextSlot = useRef(0);

  const geo = useMemo(
    () => new THREE.BoxGeometry(PICKUP_BOX_SIZE, PICKUP_BOX_SIZE, PICKUP_BOX_SIZE),
    [],
  );

  const mat = useMemo(() => {
    if (typeof document === 'undefined') {
      return new THREE.MeshStandardMaterial({ color: '#ffcc00' });
    }
    return new THREE.MeshStandardMaterial({
      map: getPickupTexture(),
      roughness: 0.4,
      metalness: 0.2,
      emissive: '#ff8800',
      emissiveIntensity: 0.15,
    });
  }, []);

  // Initialize all instances at zero-scale (invisible).
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < MAX_PICKUPS; i++) {
      mesh.setMatrixAt(i, _zeroM4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.rotation.y = 0;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return () => {
      geo.dispose();
      mat.dispose();
    };
  }, [geo, mat]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    let colorNeedsUpdate = false;
    for (const [spawnId, pickup] of pickups) {
      if (slotMap.current.has(spawnId)) continue;
      let slot = -1;
      for (let attempt = 0; attempt < MAX_PICKUPS; attempt++) {
        const candidate = (nextSlot.current + attempt) % MAX_PICKUPS;
        if (occupiedSlots[candidate] === 0) {
          slot = candidate;
          break;
        }
      }
      if (slot < 0) continue;
      occupiedSlots[slot] = 1;
      nextSlot.current = (slot + 1) % MAX_PICKUPS;
      slotMap.current.set(spawnId, slot);
      slotVariants[slot] = variantCode(pickup.variant);
      _instanceColor.setRGB(
        1,
        slotVariants[slot] === VARIANT_DOUBLE ? .72 : 1,
        slotVariants[slot] === VARIANT_DOUBLE ? .16 : 1,
      );
      mesh.setColorAt(slot, _instanceColor);
      colorNeedsUpdate = true;
      const offset = slot * 3;
      slotPositions[offset] = pickup.x;
      slotPositions[offset + 1] = USE_SPLINE
        ? elevationAtXZ(pickup.x, pickup.y, 'pickup-' + spawnId) + PICKUP_Y_ABOVE_TRACK
        : PICKUP_Y_ABOVE_TRACK;
      slotPositions[offset + 2] = pickup.y;
    }
    for (const [spawnId, slot] of slotMap.current) {
      if (pickups.has(spawnId)) continue;
      mesh.setMatrixAt(slot, _zeroM4);
      occupiedSlots[slot] = 0;
      slotVariants[slot] = VARIANT_STANDARD;
      slotMap.current.delete(spawnId);
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (colorNeedsUpdate && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [occupiedSlots, pickups, slotPositions, slotVariants]);

  useFrame(({ clock }, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // The container MUST stay at identity: its instance translations are
    // already world-space track coordinates. Rotating the container would make
    // every box orbit the world origin instead of spinning in place.
    _spinAngle += delta * PICKUP_SPIN_SPEED;
    mesh.rotation.y = 0;
    _quat.setFromAxisAngle(_up, _spinAngle);

    let needsUpdate = false;
    let colorNeedsUpdate = false;

    // Recompose only active slots so each box spins about its own center. At
    // most MAX_PICKUPS (30) matrix writes/frame; scratch objects are reused.
    for (let slot = 0; slot < MAX_PICKUPS; slot++) {
      if (occupiedSlots[slot] === 0) continue;
      const offset = slot * 3;
      _pos.set(
        slotPositions[offset],
        slotPositions[offset + 1],
        slotPositions[offset + 2],
      );
      const variant = slotVariants[slot];
      if (variant === VARIANT_DOUBLE) {
        _scl.setScalar(1.3);
        // The neutral bright face border becomes a thick gold outline while
        // the 30% scale-up makes the two-slot reward readable at race speed.
        _instanceColor.setRGB(1, 0.72, 0.16);
      } else if (variant === VARIANT_GAMBLE) {
        const pulse = 1.08 + Math.sin(clock.elapsedTime * 5.4 + slot) * 0.08;
        _scl.setScalar(pulse);
        _instanceColor.setHSL(
          (clock.elapsedTime * 0.22 + slot * 0.137) % 1,
          0.92,
          0.68,
        );
        mesh.setColorAt(slot, _instanceColor);
        colorNeedsUpdate = true;
      } else {
        _scl.setScalar(1);
      }
      _m4.compose(_pos, _quat, _scl);
      mesh.setMatrixAt(slot, _m4);
      needsUpdate = true;
    }

    if (needsUpdate) {
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (colorNeedsUpdate && mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geo, mat, MAX_PICKUPS]}
      frustumCulled={false}
    />
  );
}
