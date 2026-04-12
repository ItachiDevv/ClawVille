'use client';

/**
 * QuestNpc — world-surface anchor for the Quest Board modal.
 *
 * A crayfish character standing in the town center (between building rows 2
 * and 3). A slowly-rotating octahedron diamond marker floats above its head —
 * the "!" look-alike, gold TSL emissive, additive blending.
 *
 * Position: village center (tile 20, 12)
 *   worldX = -640 + 20*32 = 0, worldZ = -400 + 12*32 = -16
 *
 * Clicking opens useGameStore().openQuestBoard().
 *
 * GPU constraints (Iris Xe):
 *   - NO InstancedMesh + ShaderMaterial
 *   - NO drei Text/Billboard
 *   - TSL MeshBasicNodeMaterial for the marker (AdditiveBlending)
 *   - ~2–4 draw calls (GLB meshes) + 1 marker = ~3–5 total
 *
 * TODO: replace crayfish.glb with a dedicated "quest giver" character GLB
 *       once an artist produces one. The crayfish is a functional placeholder.
 */

import { useRef, useMemo, memo, Suspense } from 'react';
import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { color, float, sin, time } from 'three/tsl';
import { useGameStore } from '@/stores/game';

// ---------------------------------------------------------------------------
// World-space position
// ---------------------------------------------------------------------------
const QUEST_NPC_X = 0;
const QUEST_NPC_Z = -16;
const QUEST_NPC_FLOOR_Y = -2;

// Preload so GLB is ready before first render
useGLTF.preload('/models/crayfish.glb');

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
const QuestNpcInner = memo(function QuestNpcInner() {
  const groupRef   = useRef<THREE.Group>(null!);
  const animRef    = useRef<THREE.Group>(null!);
  const hoveredRef = useRef(false);

  const { scene } = useGLTF('/models/crayfish.glb');

  // Clone + normalize to ~35 world units (slightly larger than the 30-unit location NPCs)
  const { cloned, npcScale } = useMemo(() => {
    const c = scene.clone(true);
    const box = new THREE.Box3().setFromObject(c);
    const sz  = new THREE.Vector3();
    box.getSize(sz);
    const maxDim = Math.max(sz.x, sz.y, sz.z);
    return { cloned: c, npcScale: maxDim > 0 ? 35 / maxDim : 1 };
  }, [scene]);

  // Idle bob + gentle Y sway — pure math, no allocation
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const bob = Math.sin(clock.elapsedTime * 1.3 + 0.42) * 0.6;
    groupRef.current.position.y = QUEST_NPC_FLOOR_Y + 6 + bob;
    if (animRef.current) {
      animRef.current.rotation.y = Math.sin(clock.elapsedTime * 0.4) * 0.18;
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
