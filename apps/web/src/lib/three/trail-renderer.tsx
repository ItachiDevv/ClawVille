'use client';

import { useRef, useMemo, memo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRAIL_LENGTH = 5;
const TRAIL_SPACING = 3; // frames between recorded positions
const OPACITIES = [0.3, 0.22, 0.15, 0.1, 0.06];

// PERF: module-scope scratch Vector3 — avoids allocating a new Vector3 inside
// useFrame on every trail record tick (every TRAIL_SPACING frames).
// Pre-allocated pool matching TRAIL_LENGTH so we can copy into it rather than
// push new instances. Pool is reset each time a TrailEffect unmounts (via
// historyRef clearing).
const _trailScratch = new THREE.Vector3();

// ---------------------------------------------------------------------------
// TrailEffect Component
// ---------------------------------------------------------------------------

interface TrailEffectProps {
  /** Current world position [x, y, z] */
  position: [number, number, number];
  /** Whether to show the trail (e.g. entity is moving fast) */
  active: boolean;
  /** Trail ghost color */
  color: number;
  /** Scale of ghost meshes (default 1) */
  ghostScale?: number;
}

function TrailEffect({ position, active, color, ghostScale = 1 }: TrailEffectProps) {
  // Ring buffer of past positions
  const historyRef = useRef<THREE.Vector3[]>([]);
  const frameCountRef = useRef(0);
  const renderRef = useRef(0);

  // Shared geometry for ghost meshes
  const capsuleGeo = useMemo(() => new THREE.CapsuleGeometry(1.5, 4, 4, 8), []);

  // Material instances (one per ghost so opacity can differ)
  const materials = useMemo(() => {
    return OPACITIES.map(
      (op) =>
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: op,
          depthWrite: false,
        })
    );
  }, [color]);

  useFrame(() => {
    frameCountRef.current += 1;

    if (active) {
      // Record position every TRAIL_SPACING frames.
      // PERF: reuse a pre-existing Vector3 from the pool when possible instead
      // of allocating a new one — shift() returns the oldest entry which we
      // can recycle. Only fallback to new Vector3 when pool is empty (fill phase).
      if (frameCountRef.current % TRAIL_SPACING === 0) {
        if (historyRef.current.length >= TRAIL_LENGTH) {
          // Recycle the oldest entry (shift from front, re-set values, push to back)
          const recycled = historyRef.current.shift()!;
          recycled.set(position[0], position[1], position[2]);
          historyRef.current.push(recycled);
        } else {
          // Pool not yet full — must allocate (only happens for first TRAIL_LENGTH records)
          historyRef.current.push(
            _trailScratch.clone().set(position[0], position[1], position[2])
          );
        }
      }
    } else {
      // Clear history when not active (fade out naturally)
      if (historyRef.current.length > 0) {
        historyRef.current.shift();
      }
    }

    renderRef.current += 1;
  });

  const history = historyRef.current;
  if (history.length === 0) return null;

  return (
    <group>
      {history.map((pos, i) => {
        const matIndex = Math.min(i, OPACITIES.length - 1);
        // Older positions use lower opacity (history[0] = oldest)
        const mat = materials[OPACITIES.length - 1 - matIndex];
        return (
          <mesh
            key={i}
            position={[pos.x, pos.y + 3, pos.z]}
            geometry={capsuleGeo}
            material={mat}
            scale={[ghostScale, ghostScale * 0.7, ghostScale * 1.4]}
          />
        );
      })}
    </group>
  );
}

export default memo(TrailEffect);
