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
 *   - Slow rotation applied to ENTIRE InstancedMesh rotation.y per frame (1 mutation, not per instance).
 *   - No per-frame allocations — module-scope scratch matrix.
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
    mesh.matrixAutoUpdate = false;
    return () => {
      geo.dispose();
      mat.dispose();
    };
  }, [geo, mat]);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Spin the entire InstancedMesh — 1 mutation, not per-instance.
    _spinAngle += delta * PICKUP_SPIN_SPEED;
    mesh.rotation.y = _spinAngle;

    // Sync pickup positions from store.
    const pickups = useActivityStore.getState().pickups;
    let needsUpdate = false;

    // Add/show newly spawned pickups.
    pickups.forEach((pickup, spawnId) => {
      if (!slotMap.current.has(spawnId)) {
        const slot = nextSlot.current % MAX_PICKUPS;
        nextSlot.current++;
        slotMap.current.set(spawnId, slot);

        const pickupY = USE_SPLINE
          ? elevationAtXZ(pickup.x, pickup.y, 'pickup-' + spawnId) + PICKUP_Y_ABOVE_TRACK
          : PICKUP_Y_ABOVE_TRACK;
        _pos.set(pickup.x, pickupY, pickup.y);
        _quat.identity();
        _scl.set(1, 1, 1);
        _m4.compose(_pos, _quat, _scl);
        mesh.setMatrixAt(slot, _m4);
        needsUpdate = true;
      }
    });

    // Hide collected pickups.
    slotMap.current.forEach((slot, spawnId) => {
      if (!pickups.has(spawnId)) {
        mesh.setMatrixAt(slot, _zeroM4);
        slotMap.current.delete(spawnId);
        needsUpdate = true;
      }
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
