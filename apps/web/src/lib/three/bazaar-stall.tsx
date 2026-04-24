'use client';

/**
 * BazaarStall — world-surface anchor for the Skill Bazaar modal.
 *
 * Asset: /models/bazaar-fish-stall.glb (hand-painted fish market stall by
 * duckcracker02, CC-BY). Optimised with gltf-transform WebP@512 — DO NOT
 * re-optimise.
 *
 * Position: (-260, -2, -60) — west of town center, mirrored by MarketplaceStall
 * to the east.
 *
 * GPU constraints (Iris Xe invariants):
 *   - NO drei Text/Billboard — hard crash
 *   - NO InstancedMesh + ShaderMaterial — silent WebGPU crash
 *   - NO per-frame allocations inside useFrame
 *   - frustumCulled stays true (static mesh at known position — safe)
 *   - matrixAutoUpdate=false after mount (never moves)
 */

import { useMemo, useEffect, memo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { useGameStore } from '@/stores/game';

// ---------------------------------------------------------------------------
// Preload at module scope so Suspense has the data ready before first render.
// ---------------------------------------------------------------------------
useGLTF.preload('/models/bazaar-fish-stall.glb');

// ---------------------------------------------------------------------------
// World position
// ---------------------------------------------------------------------------
const STALL_X = -260;
const STALL_Y = -2;
const STALL_Z = -60;

// Target visual height in world units (tall enough to be readable at a distance)
const TARGET_HEIGHT_WU = 400;

// ---------------------------------------------------------------------------
// Scale helper — same algorithm as arena-location-npcs.tsx computeNormalizedScale.
// For static props (no SkinnedMesh) setFromObject is safe and correct.
// ---------------------------------------------------------------------------
function computeScale(root: THREE.Group): number {
  const bbox = new THREE.Box3().setFromObject(root);
  if (bbox.isEmpty()) return 1;
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  return maxDim > 0 ? TARGET_HEIGHT_WU / maxDim : 1;
}

// ---------------------------------------------------------------------------
// Inner component (wrapped in memo — position never changes)
// ---------------------------------------------------------------------------
const BazaarStallInner = memo(function BazaarStallInner() {
  const { scene } = useGLTF('/models/bazaar-fish-stall.glb');

  // Clone so multiple mounts don't share mutable scene state.
  const cloned = useMemo(() => scene.clone(true), [scene]);

  // Compute normalized scale and apply it.
  const scale = useMemo(() => computeScale(cloned), [cloned]);

  // Dispose cloned geometry/materials on unmount.
  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if ((mesh as any).isMesh) {
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material?.dispose();
        }
      });
    };
  }, [cloned]);

  // After mount: freeze world matrix (static object, never moves).
  useEffect(() => {
    // The group itself gets matrixAutoUpdate=false via the ref approach; we
    // disable it on all traversed children too for completeness.
    cloned.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
    });
  }, [cloned]);

  return (
    <group
      position={[STALL_X, STALL_Y, STALL_Z]}
      scale={[scale, scale, scale]}
      onClick={(e) => {
        e.stopPropagation();
        useGameStore.getState().openBazaar();
      }}
      onPointerEnter={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerLeave={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'auto';
      }}
    >
      <primitive object={cloned} />
    </group>
  );
});

export default function BazaarStall() {
  return <BazaarStallInner />;
}
