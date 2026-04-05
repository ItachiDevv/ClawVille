'use client';

import { useRef, useMemo, memo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRAIL_LENGTH = 5;
const TRAIL_SPACING = 3; // frames between recorded positions
const OPACITIES = [0.3, 0.22, 0.15, 0.1, 0.06];

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
      // Record position every TRAIL_SPACING frames
      if (frameCountRef.current % TRAIL_SPACING === 0) {
        historyRef.current.push(
          new THREE.Vector3(position[0], position[1], position[2])
        );
        // Keep only TRAIL_LENGTH entries
        if (historyRef.current.length > TRAIL_LENGTH) {
          historyRef.current.shift();
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
