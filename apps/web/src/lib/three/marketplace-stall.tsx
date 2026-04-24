'use client';

/**
 * MarketplaceStall — world-surface anchor for the Marketplace modal.
 *
 * Asset: /models/marketplace-food-stall.glb (medieval food stall by
 * SpatialNeglect, CC-BY). Optimised with gltf-transform WebP@512 — DO NOT
 * re-optimise.
 *
 * Position: (600, -2, -60) — east of town center, mirror of BazaarStall to
 * the west.
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
useGLTF.preload('/models/marketplace-food-stall.glb');

// ---------------------------------------------------------------------------
// World position
// ---------------------------------------------------------------------------
const STALL_X = 600;
const STALL_Y = -2;
const STALL_Z = -60;

// Target visual height — slightly larger than the bazaar to give the more
// elaborate food stall structure visual presence.
const TARGET_HEIGHT_WU = 450;

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
const MarketplaceStallInner = memo(function MarketplaceStallInner() {
  const { scene } = useGLTF('/models/marketplace-food-stall.glb');

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
        useGameStore.getState().openMarketplace();
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

export default function MarketplaceStall() {
  return <MarketplaceStallInner />;
}
