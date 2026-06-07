'use client';

/**
 * BazaarStall — world-surface anchor for the Cosmetics shop modal.
 *
 * Asset: /models/bazaar-merchant-stand.glb (medieval merchant stand /
 * fantasy weapon shop — user-supplied 2026-05-18, replacing the prior
 * fish-stall asset). Name kept as "Bazaar" per user direction even
 * though the stand now functions as the first-party Cosmetics shop —
 * click handler opens setCosmeticDrawerOpen(true) (see below).
 *
 * Position: world-surface (-1273, -2, 450) — west diagonal of the town plaza
 * (plaza cleanup 2026-05-21: moved outward from -800,300 to r≈1350wu).
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
useGLTF.preload('/models/bazaar-merchant-stand.glb?v=2');

// ---------------------------------------------------------------------------
// World position (Y computed at runtime via groundedYOffset — see below).
// Phase 6.2 (2026-05-18): spread from (-600, -60) to (-800, 300).
// Plaza cleanup (2026-05-21): moved outward to r≈1350wu (-1273, 450) so
// stalls clear the building footprint ring at R=130 tiles (4160wu).
// ---------------------------------------------------------------------------
const STALL_X = -1273;
// 2026-05-21: STALL_Z moved from 450 → -120 to align on the same Z axis as
// the town-directory sign. The bazaar now flanks the sign west-side.
const STALL_Z = -120;

// Target visual height in world units.
// 2026-05-19: bumped 400→1200 to match the building ring scale.
// 2026-05-21: reduced 1200→1020 (×0.85) to set size budget for the new
// quest/bounty pavilion landmark — stalls and pavilion should read at the
// same visual tier.
const TARGET_HEIGHT_WU = 1020;

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
  const { scene } = useGLTF('/models/bazaar-merchant-stand.glb?v=2');

  // Clone so multiple mounts don't share mutable scene state.
  const cloned = useMemo(() => scene.clone(true), [scene]);

  // Compute normalized scale and apply it.
  const scale = useMemo(() => computeScale(cloned), [cloned]);

  // Ground the prop on the sand floor via canonical bbox-derived Y offset.
  // The new merchant-tent GLB has its origin at the apex, so a flat Y=-2
  // sinks most of it underground. groundedYOffset() computes the Y that
  // puts the LOWEST vertex of the scaled mesh exactly at SAND_BASELINE_Y.
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
      position={[STALL_X, groundedY, STALL_Z]}
      scale={[scale, scale, scale]}
      userData={{ isOccluder: true }}
      onClick={(e) => {
        e.stopPropagation();
        // Repointed 2026-05-18: was openBazaar() (peer skill trading,
        // gated under the marketplace-pause attack-vector policy). The
        // Bazaar stall now functions as the first-party COSMETICS SHOP
        // entry from the world — opens the cosmetic drawer which lands
        // on the Shop tab when the player owns nothing. The 3D model
        // stays for now (fish-market stall reads as a shop visually);
        // can swap to a more cosmetic-themed asset in a later pass.
        useGameStore.getState().setCosmeticDrawerOpen(true);
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
