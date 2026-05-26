'use client';

/**
 * MarketplaceStall — world-surface anchor for the Exchange modal.
 *
 * Asset: /models/shisha-oasis.glb (DAE bazaar — shisha oasis, user-supplied
 * 2026-05-21, optimised via gltf-transform resize 1024 + webp = 1.6 MB).
 * DO NOT re-optimise. Replaces the prior `marketplace-food-stall.glb` which
 * never thematically matched the Exchange modal it opens.
 *
 * Position: (1273, groundedY, -120) — east of the town-directory sign,
 * aligned on the same Z axis as the sign (sign at z=-120).
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
import { mergeStaticMeshesByMaterial } from '@/lib/three/utils/merge-static-meshes';

// ---------------------------------------------------------------------------
// Preload at module scope so Suspense has the data ready before first render.
// ---------------------------------------------------------------------------
useGLTF.preload('/models/shisha-oasis.glb');

// ---------------------------------------------------------------------------
// World position (Y computed at runtime via groundedYOffset — same canonical
// pattern as bazaar-stall.tsx).
// 2026-05-21: STALL_Z moved from 450 → -120 to align on the same Z axis
// as the town-directory sign. The stall now flanks the sign east-side instead
// of standing south of the player.
// ---------------------------------------------------------------------------
const STALL_X = 1273;
const STALL_Z = -120;

// Target visual height — slightly larger than the bazaar.
// 2026-05-19: bumped 450→1300 to match the building ring scale.
// 2026-05-21: reduced 1300→1105 (×0.85) — see bazaar-stall.tsx rationale.
// 2026-05-21 (pass 2): shisha-oasis swap — reduced 1105→994 (a further ×0.9)
// per user direction "make the new structure 10% smaller".
const TARGET_HEIGHT_WU = 994;

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
  const { scene } = useGLTF('/models/shisha-oasis.glb');

  // Clone so multiple mounts don't share mutable scene state, then merge
  // static submeshes by shared material to reduce draw calls.
  const cloned = useMemo(() => {
    const c = scene.clone(true);
    const merge = mergeStaticMeshesByMaterial(c);
    if (typeof window !== 'undefined') {
      (window as any).__CV_STATIC_MERGE = (window as any).__CV_STATIC_MERGE || {};
      (window as any).__CV_STATIC_MERGE.marketplaceStall = merge;
    }
    return c;
  }, [scene]);

  // Compute normalized scale and apply it.
  const scale = useMemo(() => computeScale(cloned), [cloned]);

  // Canonical sand-grounding plus a lightly-sunk nudge so the GLB's stone
  // platform base sits partially under the sand line (user direction
  // 2026-05-21: "lightly sunk into the ground").
  const FLOOR_NUDGE_Y = -30;
  const groundedY = useMemo(
    () => groundedYOffset(cloned, scale) + FLOOR_NUDGE_Y,
    [cloned, scale]
  );

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
