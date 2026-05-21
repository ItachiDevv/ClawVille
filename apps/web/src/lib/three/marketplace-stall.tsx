'use client';

/**
 * MarketplaceStall — world-surface anchor for the Marketplace modal.
 *
 * Asset: /models/marketplace-food-stall.glb (medieval food stall by
 * SpatialNeglect, CC-BY). Optimised with gltf-transform WebP@512 — DO NOT
 * re-optimise.
 *
 * Position: (1273, -2, 450) — east diagonal of the town plaza
 * (plaza cleanup 2026-05-21: moved outward from 800,300 to r≈1350wu).
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
import { groundedYOffset } from '@/lib/three/utils/ground-prop';

// ---------------------------------------------------------------------------
// Preload at module scope so Suspense has the data ready before first render.
// ---------------------------------------------------------------------------
useGLTF.preload('/models/marketplace-food-stall.glb');

// ---------------------------------------------------------------------------
// World position (Y computed at runtime via groundedYOffset — same canonical
// pattern as bazaar-stall.tsx). Previously hard-coded Y=4 as a magic-number
// workaround for the stall's below-origin frame; the canonical helper
// computes a correct Y from the post-scale bbox.min.y instead.
// Plaza cleanup (2026-05-21): moved outward to r≈1350wu (1273, 450).
// ---------------------------------------------------------------------------
const STALL_X = 1273;
const STALL_Z = 450;

// Target visual height — slightly larger than the bazaar.
// 2026-05-19: bumped 450→1300 to match the building ring scale (see
// bazaar-stall.tsx for rationale).
const TARGET_HEIGHT_WU = 1300;

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

  // Canonical sand-grounding (replaces the old magic Y=4 patch).
  const groundedY = useMemo(() => groundedYOffset(cloned, scale), [cloned, scale]);

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
  // Also hide the GLB's ground plane mesh — it pokes through the sand terrain.
  useEffect(() => {
    cloned.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
      // ground_ground_0 is a 2-triangle floor plate baked into the GLB; hiding
      // it prevents the cobblestone base from clipping through the sand terrain.
      if (/^ground/i.test(obj.name)) {
        obj.visible = false;
      }
    });
  }, [cloned]);

  return (
    <group
      position={[STALL_X, groundedY, STALL_Z]}
      scale={[scale, scale, scale]}
      userData={{ isOccluder: true }}
      onClick={(e) => {
        e.stopPropagation();
        // Repointed 2026-05-18: was openMarketplace() (knowledge-book
        // cross-building catalogue, now redundant with the per-building
        // shop overlays). The Marketplace stand now opens the EXCHANGE
        // modal — peer marketplace for Needs + Offers (one-shot or
        // repeatable). The 3D model stays; can swap to a more
        // marketplace-themed asset later if needed.
        useGameStore.getState().openExchange();
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
