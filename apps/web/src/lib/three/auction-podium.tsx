'use client';

/**
 * AuctionPodium — world-surface anchor for the Auction House modal.
 *
 * Asset: /models/auction-dome.glb (Space Dome Showcase by dylanheyes, CC-BY).
 * Optimised with gltf-transform WebP@512 — DO NOT re-optimise.
 *
 * The dome GLB handles its own visual materials via glTF → Three.js auto-mapping.
 * No custom TSL materials. Old stepped-cylinder base, torus rim, and spotlight
 * cone were all removed — the dome is the whole visual.
 *
 * Inside the dome: floating jellyfish.glb (already preloaded) acts as the
 * "featured lot". It spins slowly on the Y axis and floats at 60% of dome
 * height (~228wu off the dome group origin).
 *
 * Position: (0, -2, -280) — flush with sand surface, 220wu north of stall row (Z=-60), near back of play area from the camera's south-facing POV.
 *
 * GPU constraints (Iris Xe invariants):
 *   - NO drei Text/Billboard — hard crash
 *   - NO InstancedMesh + ShaderMaterial — silent WebGPU crash
 *   - NO per-frame allocations inside useFrame — use refs + module-scope scratch
 *   - frustumCulled=false on jellyfish (SkinnedMesh bounding sphere from bind pose
 *     may not cover animated deformation — safe default)
 *   - matrixAutoUpdate=false on dome group after mount (never moves)
 */

import { useRef, useMemo, useEffect, memo, Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { useGameStore } from '@/stores/game';
import { mergeStaticMeshesByMaterial } from '@/lib/three/utils/merge-static-meshes';

// ---------------------------------------------------------------------------
// Preloads at module scope
// ---------------------------------------------------------------------------
useGLTF.preload('/models/auction-dome.glb');
useGLTF.preload('/models/jellyfish.glb');

// ---------------------------------------------------------------------------
// World position — unchanged from old podium
// ---------------------------------------------------------------------------
const DOME_X = 0;
// Kept climbing Y — 12 and 80 both still looked buried. Going way up to +200
// because the GLB's geometry extends dramatically below its pivot point.
const DOME_Y = 200;
// Phase 6.2 (2026-05-18): moved from z=-500 to z=-1000 as part of plaza expansion.
// Props now form a loose ring at 800-1000wu from center. The auction dome anchors
// the north edge of the town square at ~1000wu north of plaza center.
const DOME_Z = -1000;

// Target visual height for the dome (the centerpiece — give it presence)
const DOME_TARGET_HEIGHT_WU = 380;

// Target size for the floating jellyfish inside the dome
const JELLY_TARGET_SIZE_WU = 130;

// Jellyfish floats at 60 % of dome height above the dome's local origin
const JELLY_Y_OFFSET = DOME_TARGET_HEIGHT_WU * 0.6; // 228 wu

// ---------------------------------------------------------------------------
// Scale helper
// ---------------------------------------------------------------------------
function computeScale(root: THREE.Group, targetHeight: number): number {
  const bbox = new THREE.Box3().setFromObject(root);
  if (bbox.isEmpty()) return 1;
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  return maxDim > 0 ? targetHeight / maxDim : 1;
}

// ---------------------------------------------------------------------------
// Floating jellyfish inside the dome — the "featured lot"
// ---------------------------------------------------------------------------
function FloatingJellyfish() {
  const floatRef = useRef<THREE.Group>(null!);
  const { scene } = useGLTF('/models/jellyfish.glb');

  const cloned = useMemo(() => {
    const c = scene.clone(true);
    // Disable frustum culling: jellyfish may contain SkinnedMesh whose
    // bounding sphere (bind pose) doesn't cover animated deformation.
    c.traverse((obj) => { obj.frustumCulled = false; });
    // Normalize scale
    const s = computeScale(c as THREE.Group, JELLY_TARGET_SIZE_WU);
    c.scale.setScalar(s);
    return c;
  }, [scene]);

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

  // Spin only the jellyfish ref — no allocations, single useFrame for both anchors.
  useFrame(({ clock }) => {
    if (!floatRef.current) return;
    floatRef.current.rotation.y = clock.elapsedTime * 0.8;
  });

  return (
    <group ref={floatRef}>
      <primitive object={cloned} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Dome GLB — the main visual
// ---------------------------------------------------------------------------
function DomeGlb() {
  const { scene } = useGLTF('/models/auction-dome.glb');

  const cloned = useMemo(() => {
    const c = scene.clone(true);
    // Hide the Sketchfab background plate before merging so it does not get
    // baked into a merged material bucket.
    c.traverse((obj) => {
      if (/^Background_Material/i.test(obj.name)) {
        obj.visible = false;
      }
    });
    const merge = mergeStaticMeshesByMaterial(c);
    if (typeof window !== 'undefined') {
      (window as any).__CV_STATIC_MERGE = (window as any).__CV_STATIC_MERGE || {};
      (window as any).__CV_STATIC_MERGE.auctionDome = merge;
    }
    return c;
  }, [scene]);

  const scale = useMemo(() => computeScale(cloned as THREE.Group, DOME_TARGET_HEIGHT_WU), [cloned]);

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

  // Freeze world matrix — dome never moves.
  // Also hide the GLB's "Background" plate — Sketchfab's "Space Dome Showcase"
  // bakes in a flat circular platform under the dome for its original product-
  // photography render. In our scene this reads as a stray grey disc on the
  // sand. Same pattern as marketplace-stall hiding its ground_ground_0 plate.
  useEffect(() => {
    cloned.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
      if (/^Background_Material/i.test(obj.name)) {
        obj.visible = false;
      }
    });
  }, [cloned]);

  return <primitive object={cloned} scale={[scale, scale, scale]} />;
}

// ---------------------------------------------------------------------------
// Full auction podium
// ---------------------------------------------------------------------------
const AuctionPodiumInner = memo(function AuctionPodiumInner() {
  return (
    <group
      position={[DOME_X, DOME_Y, DOME_Z]}
      userData={{ isOccluder: true }}
      onClick={(e) => {
        e.stopPropagation();
        // Repointed 2026-05-18: was openAuction() (peer skill auction,
        // gated under the marketplace-pause attack-vector policy). The
        // auction podium now opens the QUEST BOARD — daily/weekly
        // quests and bounties. Same drop-in pattern as the bazaar
        // stall → cosmetic drawer repoint earlier today. The dome
        // 3D model stays for now (reads as a "showcase / call to
        // action" visually); can swap to a quest-themed pinboard
        // asset in a follow-up pass if needed.
        useGameStore.getState().openQuestBoard();
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
      {/* Glass dome showcase */}
      <Suspense fallback={null}>
        <DomeGlb />
      </Suspense>

      {/* Floating featured lot inside the dome — offset to 60 % of dome height */}
      <Suspense fallback={null}>
        <group position={[0, JELLY_Y_OFFSET, 0]}>
          <FloatingJellyfish />
        </group>
      </Suspense>
    </group>
  );
});

export default function AuctionPodium() {
  return <AuctionPodiumInner />;
}
