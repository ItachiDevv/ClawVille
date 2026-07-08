'use client';

/**
 * QuestNpc — world-surface anchor for the Quest Board modal.
 *
 * A crayfish character standing in the town center (between building rows 2
 * and 3). A slowly-rotating octahedron diamond marker floats above its head —
 * the "!" look-alike, gold TSL emissive, additive blending.
 *
 * Position: village center (tile 120, 120) on 240×240 square map (Phase 6.1)
 *   worldX = -3840 + 120*32 = 0, worldZ = -3840 + 120*32 = 0
 *
 * Clicking opens useGameStore().openQuestBoard().
 *
 * GPU constraints (Iris Xe):
 *   - NO InstancedMesh + ShaderMaterial
 *   - NO drei Text/Billboard
 *   - TSL MeshBasicNodeMaterial for the marker (AdditiveBlending)
 *   - ~2–4 draw calls (GLB meshes) + 1 marker = ~3–5 total
 *
 * TODO: replace crayfish-ktx.glb with a dedicated "quest giver" character GLB
 *       once an artist produces one. The crayfish is a functional placeholder.
 */

import { useRef, useMemo, useEffect, memo, Suspense, useCallback } from 'react';
import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { color, float, sin, time } from 'three/tsl';
import { useGameStore } from '@/stores/game';
import { applyFattenedFrustumCulling } from '@/lib/three/vrm-loader';
import { preloadKTX2Bytes, useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';

// ---------------------------------------------------------------------------
// World-space position
// Moved 2026-04-17: was at village center (0, 0) which placed the NPC directly
// on top of the bazaar / marketplace pedestals cluster (center -50, -60).
// Now positioned next to the bazaar cluster — 40 wu west of the leftmost
// pedestal (x=-78) at the same Z row as the bazaar, so it flanks the
// marketplace without overlapping any pedestal.
//   Bazaar pedestals: x = -78, -50, -22  at  z = -60
//   Quest NPC:        x = -110            at  z = -60
// ---------------------------------------------------------------------------
const QUEST_NPC_X = -110;
const QUEST_NPC_Z = -60;
const QUEST_NPC_FLOOR_Y = -2;

// Preload so GLB is ready before first render
preloadKTX2Bytes('/models/crayfish-ktx.glb');

// Gold color for the quest marker octahedron
const MARKER_COLOR = 0xffd700;

// ---------------------------------------------------------------------------
// QuestNpcMarkerWrapper — floating octahedron marker
// Sits in the parent group's un-scaled space so it doesn't inherit NPC scale.
// Reads hoveredRef each frame to scale up on hover (no re-render cost).
// ---------------------------------------------------------------------------
function QuestNpcMarkerWrapper({ hoveredRef }: { hoveredRef: RefObject<boolean> }) {
  const markerRef = useRef<THREE.Mesh>(null!);

  const material = useMemo(() => {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    });
    // Pulse brightness via sin(time) — no per-frame CPU cost
    const pulse = sin(time.mul(float(2.5))).mul(float(0.3)).add(float(0.7));
    mat.colorNode = color(MARKER_COLOR).mul(pulse);
    mat.opacity = 0.9;
    return mat;
  }, []);

  useFrame(({ clock }) => {
    if (!markerRef.current) return;
    // Spin and bob — scratch scalar math, zero allocation
    markerRef.current.rotation.y = clock.elapsedTime * 1.4;
    markerRef.current.position.y = 42 + Math.sin(clock.elapsedTime * 2.0) * 1.5;
    // Hover scale — no state update, no re-render
    markerRef.current.scale.setScalar(hoveredRef.current ? 1.3 : 1.0);
  });

  return (
    <mesh ref={markerRef} position={[0, 42, 0]} material={material}>
      <octahedronGeometry args={[3.2, 0]} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// QuestNpcInner — the character body + marker
// ---------------------------------------------------------------------------
// Module-scope scratch for marker bob — avoids any per-frame closure captures
const _markerBobScratch = new THREE.Vector3();

const QuestNpcInner = memo(function QuestNpcInner() {
  const groupRef   = useRef<THREE.Group>(null!);
  const animRef    = useRef<THREE.Group>(null!);
  const hoveredRef = useRef(false);

  const { scene } = useGLTFWithKTX2('/models/crayfish-ktx.glb');

  // Clone + normalize to ~61 world units (×1.75 of original 35, matches 2026-04-23
  // CHARACTER_HEIGHT bump 55→96 in arena-location-npcs.tsx so the town-center
  // guide reads at the same prominence as building characters).
  const { cloned, npcScale } = useMemo(() => {
    const c = scene.clone(true);
    // Fatten SkinnedMesh bounding spheres + re-enable frustumCulled (Win G fix,
    // 2026-05-22 perf wave 3). Bind-pose sphere too tight for animated crayfish;
    // applyFattenedFrustumCulling fattens each SkinnedMesh sphere by 1.6× and
    // enables culling so off-screen quest NPC renders are correctly skipped.
    applyFattenedFrustumCulling(c);
    const box = new THREE.Box3().setFromObject(c);
    const sz  = new THREE.Vector3();
    box.getSize(sz);
    const maxDim = Math.max(sz.x, sz.y, sz.z);
    return { cloned: c, npcScale: maxDim > 0 ? 80 / maxDim : 1 };
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

  // Idle bob + gentle Y sway — pure math, no allocation.
  // Only the outer position Y and animRef rotation change — the XZ position is
  // constant so we don't need to set it every frame.
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.elapsedTime;
    const bob = Math.sin(t * 1.3 + 0.42) * 0.6;
    // Only update Y — X and Z are static and set via JSX position prop.
    groupRef.current.position.y = QUEST_NPC_FLOOR_Y + 6 + bob;
    if (animRef.current) {
      animRef.current.rotation.y = Math.sin(t * 0.4) * 0.18;
    }
  });

  return (
    <group
      position={[QUEST_NPC_X, QUEST_NPC_FLOOR_Y + 6, QUEST_NPC_Z]}
      onClick={(e) => {
        e.stopPropagation();
        useGameStore.getState().openQuestBoard();
      }}
      onPointerEnter={(e) => {
        e.stopPropagation();
        hoveredRef.current = true;
        document.body.style.cursor = 'pointer';
      }}
      onPointerLeave={(e) => {
        e.stopPropagation();
        hoveredRef.current = false;
        document.body.style.cursor = 'auto';
      }}
    >
      {/* NPC body — scaled group */}
      <group ref={groupRef} scale={[npcScale, npcScale, npcScale]}>
        <group ref={animRef}>
          <primitive object={cloned} />
        </group>
        {/* Invisible click target (easier to hit than the character mesh) */}
        <mesh visible={false} position={[0, 15, 0]}>
          <boxGeometry args={[8, 30, 8]} />
          <meshBasicMaterial />
        </mesh>
      </group>

      {/* Marker lives in un-scaled parent space — fixed world-unit size */}
      <QuestNpcMarkerWrapper hoveredRef={hoveredRef} />
    </group>
  );
});

export default function QuestNpc() {
  return (
    <Suspense fallback={null}>
      <QuestNpcInner />
    </Suspense>
  );
}
