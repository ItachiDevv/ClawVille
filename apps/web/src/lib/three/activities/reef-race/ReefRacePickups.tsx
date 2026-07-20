'use client';

/**
 * ReefRacePickups.tsx
 *
 * 16 InstancedMesh '?-block' boxes pre-allocated at scene init.
 * Collected pickups are hidden by setting their instance matrix to zero-scale.
 * Respawns: matrix restored to normal position/scale.
 *
 * Iris Xe invariants:
 *   - InstancedMesh + MeshStandardMaterial (safe on WebGPU — no ShaderMaterial crash).
 *   - Canvas-generated '?' texture created once at module scope.
 *   - Active instances spin around their own cached world-space centers.
 *   - No per-frame allocations — module-scope transform scratch + fixed slot cache.
 *   - matrixAutoUpdate=false on static instances.
 *
 * Draw calls: 1 (InstancedMesh).
 */

import { useRef, useEffect, useMemo, useCallback } from 'react';
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
let _spinAngle  = 0;

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

  // Teal border
  ctx.strokeStyle = '#00bcd4';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, size - 4, size - 4);

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

  // Track which spawnId occupies which instance slot.
  const slotMap = useRef<Map<string, number>>(new Map());
  // Fixed xyz cache indexed by instance slot. Elevation is resolved only when
  // a spawn first becomes active; the per-frame spin reuses these world coords.
  const slotPositionsRef = useRef<Float32Array | null>(null);
  const occupiedSlotsRef = useRef<Uint8Array | null>(null);
  if (slotPositionsRef.current === null) {
    slotPositionsRef.current = new Float32Array(MAX_PICKUPS * 3);
  }
  if (occupiedSlotsRef.current === null) {
    occupiedSlotsRef.current = new Uint8Array(MAX_PICKUPS);
  }
  const slotPositions = slotPositionsRef.current;
  const occupiedSlots = occupiedSlotsRef.current;
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

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // The container MUST stay at identity: its instance translations are
    // already world-space track coordinates. Rotating the container would make
    // every box orbit the world origin instead of spinning in place.
    _spinAngle += delta * PICKUP_SPIN_SPEED;
    mesh.rotation.y = 0;
    _quat.setFromAxisAngle(_up, _spinAngle);

    // Sync pickup positions from store.
    const pickups = useActivityStore.getState().pickups;
    let needsUpdate = false;

    // Add/show newly spawned pickups.
    pickups.forEach((pickup, spawnId) => {
      if (!slotMap.current.has(spawnId)) {
        let slot = -1;
        for (let attempt = 0; attempt < MAX_PICKUPS; attempt++) {
          const candidate = (nextSlot.current + attempt) % MAX_PICKUPS;
          if (occupiedSlots[candidate] === 0) {
            slot = candidate;
            break;
          }
        }
        if (slot < 0) return;

        occupiedSlots[slot] = 1;
        nextSlot.current = (slot + 1) % MAX_PICKUPS;
        slotMap.current.set(spawnId, slot);

        const pickupY = USE_SPLINE
          ? elevationAtXZ(pickup.x, pickup.y, 'pickup-' + spawnId) + PICKUP_Y_ABOVE_TRACK
          : PICKUP_Y_ABOVE_TRACK;
        const offset = slot * 3;
        slotPositions[offset] = pickup.x;
        slotPositions[offset + 1] = pickupY;
        slotPositions[offset + 2] = pickup.y;
      }
    });

    // Hide collected pickups.
    slotMap.current.forEach((slot, spawnId) => {
      if (!pickups.has(spawnId)) {
        mesh.setMatrixAt(slot, _zeroM4);
        occupiedSlots[slot] = 0;
        slotMap.current.delete(spawnId);
        needsUpdate = true;
      }
    });

    // Recompose only active slots so each box spins about its own center. At
    // most MAX_PICKUPS (16) matrix writes/frame; scratch objects are reused.
    slotMap.current.forEach((slot) => {
      const offset = slot * 3;
      _pos.set(
        slotPositions[offset],
        slotPositions[offset + 1],
        slotPositions[offset + 2],
      );
      _m4.compose(_pos, _quat, _scl);
      mesh.setMatrixAt(slot, _m4);
      needsUpdate = true;
    });

    if (needsUpdate) {
      mesh.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geo, mat, MAX_PICKUPS]}
      frustumCulled={false}
      castShadow
    />
  );
}
