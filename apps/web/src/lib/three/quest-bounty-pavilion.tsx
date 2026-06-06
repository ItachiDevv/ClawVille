'use client';

/**
 * QuestBountyPavilion — octagonal open-air pavilion housing the QUEST and
 * BOUNTY notice boards.
 *
 * Asset: /models/quest-bounty-pavilion.glb?v=3 (Sketchfab "Can You Dig It? Virtual
 * Drop-In" by GGLP, originally a museum display reconstruction). Optimised
 * with @gltf-transform: dedup → metalrough (KHR_materials_pbrSpecularGlossiness
 * dropped) → resize 1024 → webp. 35 MB → 8.7 MB. DO NOT re-optimise.
 *
 * Visual: octagonal wooden pavilion with 4 numbered display boards inside.
 * Boards 1 + 2 → openQuestBoard(), Boards 3 + 4 → openBountyBoard(). Click
 * volume is split L/R rather than per-board (board meshes are named generically
 * Object_0…Object_25 by the exporter; a follow-up pass can map them precisely
 * once we have runtime selection).
 *
 * Position: (0, groundedY, -1220) — 1100 wu behind the town-directory sign
 * at (0, 0, -120), facing the player spawn. The grounded Y is computed via
 * the canonical `groundedYOffset()` helper so the pavilion sits flush with
 * the sand floor regardless of where the GLB's pivot lives.
 *
 * Size: TARGET_HEIGHT_WU = 1080 (matches the bazaar + marketplace stalls
 * after their 15% reduction: 1200→1020 / 1300→1105). The pavilion reads as
 * a third plaza landmark at the same scale as the trade stalls.
 *
 * GPU constraints (Iris Xe invariants):
 *   - NO drei <Text> / <Billboard> — hard crash on integrated GPUs
 *   - NO InstancedMesh + ShaderMaterial — silent WebGPU crash
 *   - NO per-frame allocations in useFrame
 *   - matrixAutoUpdate=false after mount (never moves)
 *   - Bio-luminescent labels via WorldLabel (HTML overlay, not drei Text)
 */

import { useMemo, useEffect, useRef, memo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { useGameStore } from '@/stores/game';
import { groundedYOffset } from '@/lib/three/utils/ground-prop';
import { useWorldLabel, WorldLabel, resetLabelPrevOpacity } from '@/lib/three/world-labels-overlay';

// ---------------------------------------------------------------------------
// Preload at module scope so Suspense has the asset ready
// ---------------------------------------------------------------------------
useGLTF.preload('/models/quest-bounty-pavilion.glb?v=3');

// ---------------------------------------------------------------------------
// World position — 1100 wu behind town-directory-sign at (0, 0, -120)
// ---------------------------------------------------------------------------
const PAV_X = 0;
const PAV_Z = -1220;

// ---------------------------------------------------------------------------
// Target visual height. Matches the trade stalls after their 15% reduction:
// bazaar 1200→1020, marketplace 1300→1105. 1080 lands in the middle.
// ---------------------------------------------------------------------------
const TARGET_HEIGHT_WU = 1080;

// ---------------------------------------------------------------------------
// Scale helper — same algorithm as the other stalls (max-dim normalization)
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
// Click-zone hitboxes
// Left half of pavilion (negative X) → Quest. Right half (positive X) → Bounty.
// Boxes are invisible meshes sized to cover the interior board area.
// Y is centered around the board mid-height (~mid of pavilion).
// ---------------------------------------------------------------------------
const ZONE_HALF_WIDTH = TARGET_HEIGHT_WU * 0.45;   // ~486 wu wide each
const ZONE_HEIGHT     = TARGET_HEIGHT_WU * 0.6;    // ~648 wu tall
const ZONE_DEPTH      = TARGET_HEIGHT_WU * 0.5;    // ~540 wu deep
const ZONE_Y_CENTER   = TARGET_HEIGHT_WU * 0.35;   // ~378 wu above ground (board height)

// ---------------------------------------------------------------------------
// Label anchor offsets — labels float above each half of the pavilion
// ---------------------------------------------------------------------------
const LABEL_Y_OFFSET = TARGET_HEIGHT_WU * 0.95;    // above the roof line

// ---------------------------------------------------------------------------
// Inner component (memoized — pavilion never moves)
// ---------------------------------------------------------------------------
const QuestBountyPavilionInner = memo(function QuestBountyPavilionInner() {
  const { scene } = useGLTF('/models/quest-bounty-pavilion.glb?v=3');

  // Clone so we don't mutate the cached GLB
  const cloned = useMemo(() => scene.clone(true), [scene]);

  // Normalize scale
  const scale = useMemo(() => computeScale(cloned), [cloned]);

  // Canonical sand-grounding (computes Y so the lowest scaled vertex sits at
  // SAND_BASELINE_Y). The pavilion's GLB has trim/skirting geometry slightly
  // below the visible wooden floor — naive grounding leaves the floor hovering.
  // FLOOR_NUDGE_Y pulls the whole pavilion down so the wooden floor reads
  // flush with the sand. Adjust if the structure clips into the sand instead.
  const FLOOR_NUDGE_Y = -60;
  const groundedY = useMemo(
    () => groundedYOffset(cloned, scale) + FLOOR_NUDGE_Y,
    [cloned, scale]
  );

  // Anchor refs for label projection
  const questAnchorRef = useRef<THREE.Object3D | null>(null);
  const bountyAnchorRef = useRef<THREE.Object3D | null>(null);

  // QUEST label — left half, brighter cyan-tinted capsule
  const questLabel = useWorldLabel({
    id: 'pavilion-quest',
    anchorRef: questAnchorRef,
    offset: [0, 0, 0],
    fadeNear: 800,
    fadeFar: 4500,
    fadeBaseOpacity: 0.85,
  });

  // BOUNTY label — right half, warmer amber-tinted capsule
  const bountyLabel = useWorldLabel({
    id: 'pavilion-bounty',
    anchorRef: bountyAnchorRef,
    offset: [0, 0, 0],
    fadeNear: 800,
    fadeFar: 4500,
    fadeBaseOpacity: 0.85,
  });

  // Dispose cloned geometry/materials on unmount
  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if ((mesh as { isMesh?: boolean }).isMesh) {
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material?.dispose();
        }
      });
    };
  }, [cloned]);

  // Freeze every traversed child after mount — static pavilion
  useEffect(() => {
    cloned.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
    });
  }, [cloned]);

  const openQuestBoard  = () => useGameStore.getState().openQuestBoard();
  const openBountyBoard = () => useGameStore.getState().openBountyBoard();

  return (
    <group position={[PAV_X, groundedY, PAV_Z]} userData={{ isOccluder: true }}>
      {/* The pavilion GLB itself — no click handler, click is on the half-zones */}
      <primitive object={cloned} scale={[scale, scale, scale]} />

      {/* QUEST click zone (left half) */}
      <mesh
        position={[-ZONE_HALF_WIDTH / 2, ZONE_Y_CENTER, 0]}
        onClick={(e) => { e.stopPropagation(); openQuestBoard(); }}
        onPointerEnter={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
        onPointerLeave={(e) => { e.stopPropagation(); document.body.style.cursor = 'auto'; }}
      >
        <boxGeometry args={[ZONE_HALF_WIDTH, ZONE_HEIGHT, ZONE_DEPTH]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      {/* BOUNTY click zone (right half) */}
      <mesh
        position={[ZONE_HALF_WIDTH / 2, ZONE_Y_CENTER, 0]}
        onClick={(e) => { e.stopPropagation(); openBountyBoard(); }}
        onPointerEnter={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
        onPointerLeave={(e) => { e.stopPropagation(); document.body.style.cursor = 'auto'; }}
      >
        <boxGeometry args={[ZONE_HALF_WIDTH, ZONE_HEIGHT, ZONE_DEPTH]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      {/* QUEST label anchor (invisible 3D point above left half) */}
      <object3D ref={questAnchorRef} position={[-ZONE_HALF_WIDTH / 2, LABEL_Y_OFFSET, 0]} />

      {/* BOUNTY label anchor (invisible 3D point above right half) */}
      <object3D ref={bountyAnchorRef} position={[ZONE_HALF_WIDTH / 2, LABEL_Y_OFFSET, 0]} />

      {/* QUEST bio-luminescent label */}
      <WorldLabel divRef={questLabel.divRef} pointerEvents="auto">
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            transform: 'translateY(-50%)',
            ['--label-phase' as string]: '0.2',
          }}
          onMouseEnter={() => {
            if (questLabel.divRef.current) {
              questLabel.divRef.current.style.opacity = '1';
              const capsule = questLabel.divRef.current.querySelector<HTMLElement>('[data-bio-capsule]');
              if (capsule) capsule.style.boxShadow = '0 0 28px rgba(120,240,255,0.85), 0 0 70px -8px rgba(80,220,255,0.7), inset 0 0 16px rgba(180,245,255,0.25)';
            }
          }}
          onMouseLeave={() => {
            if (questLabel.divRef.current) {
              questLabel.divRef.current.style.opacity = '';
              const capsule = questLabel.divRef.current.querySelector<HTMLElement>('[data-bio-capsule]');
              if (capsule) capsule.style.boxShadow = '';
            }
            resetLabelPrevOpacity(questLabel.divRef);
          }}
          onClick={() => useGameStore.getState().openQuestBoard()}
        >
          <div
            data-bio-capsule
            style={{
              fontFamily: 'var(--font-fraunces, "Cormorant Garamond", "Spectral", Georgia, serif)',
              fontVariationSettings: '"opsz" 9',
              fontWeight: 520,
              fontSize: 15,
              color: '#a0eaff',
              padding: '7px 15px 9px',
              borderRadius: 999,
              background: 'rgba(8, 18, 32, 0.85)',
              border: '1px solid rgba(120, 220, 255, 0.55)',
              boxShadow: '0 0 22px rgba(120,240,255,0.5), 0 0 60px -10px rgba(120,240,255,0.45), inset 0 0 14px rgba(120,200,240,0.18)',
              whiteSpace: 'nowrap',
              letterSpacing: '0.02em',
              lineHeight: 1,
              userSelect: 'none',
              cursor: 'pointer',
              animation: 'bio-drift 5.4s ease-in-out infinite',
              animationDelay: 'calc(var(--label-phase, 0) * -5.4s)',
              transition: 'box-shadow 0.18s ease',
            }}
          >
            Quests
            <span
              style={{
                display: 'block',
                fontSize: 9,
                fontStyle: 'italic',
                fontFamily: 'var(--font-oxanium, sans-serif)',
                fontWeight: 400,
                color: '#cdf5ff',
                opacity: 0.7,
                marginTop: 2,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
              }}
            >
              Board · Boards 1 + 2
            </span>
          </div>
          <div
            style={{
              width: 1,
              height: 56,
              backgroundImage: 'linear-gradient(rgba(140,240,255,0.78) 50%, transparent 50%)',
              backgroundSize: '1px 6px',
              backgroundRepeat: 'repeat-y',
              boxShadow: '0 0 6px rgba(120,240,255,0.55)',
              marginBottom: 2,
            }}
          />
          <div
            className="bio-anchor"
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'rgba(160,234,255,1)',
              animation: 'bio-pulse 2.4s ease-in-out infinite',
              animationDelay: 'calc(var(--label-phase, 0) * -2.4s)',
            }}
          />
        </div>
      </WorldLabel>

      {/* BOUNTY bio-luminescent label — amber tint to distinguish */}
      <WorldLabel divRef={bountyLabel.divRef} pointerEvents="auto">
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            transform: 'translateY(-50%)',
            ['--label-phase' as string]: '0.7',
          }}
          onMouseEnter={() => {
            if (bountyLabel.divRef.current) {
              bountyLabel.divRef.current.style.opacity = '1';
              const capsule = bountyLabel.divRef.current.querySelector<HTMLElement>('[data-bio-capsule]');
              if (capsule) capsule.style.boxShadow = '0 0 28px rgba(255,200,120,0.85), 0 0 70px -8px rgba(255,180,80,0.7), inset 0 0 16px rgba(255,220,180,0.25)';
            }
          }}
          onMouseLeave={() => {
            if (bountyLabel.divRef.current) {
              bountyLabel.divRef.current.style.opacity = '';
              const capsule = bountyLabel.divRef.current.querySelector<HTMLElement>('[data-bio-capsule]');
              if (capsule) capsule.style.boxShadow = '';
            }
            resetLabelPrevOpacity(bountyLabel.divRef);
          }}
          onClick={() => useGameStore.getState().openBountyBoard()}
        >
          <div
            data-bio-capsule
            style={{
              fontFamily: 'var(--font-fraunces, "Cormorant Garamond", "Spectral", Georgia, serif)',
              fontVariationSettings: '"opsz" 9',
              fontWeight: 520,
              fontSize: 15,
              color: '#ffd9a0',
              padding: '7px 15px 9px',
              borderRadius: 999,
              background: 'rgba(32, 18, 8, 0.85)',
              border: '1px solid rgba(255, 200, 120, 0.55)',
              boxShadow: '0 0 22px rgba(255,200,120,0.5), 0 0 60px -10px rgba(255,180,80,0.45), inset 0 0 14px rgba(255,200,140,0.18)',
              whiteSpace: 'nowrap',
              letterSpacing: '0.02em',
              lineHeight: 1,
              userSelect: 'none',
              cursor: 'pointer',
              animation: 'bio-drift 5.4s ease-in-out infinite',
              animationDelay: 'calc(var(--label-phase, 0) * -5.4s)',
              transition: 'box-shadow 0.18s ease',
            }}
          >
            Bounties
            <span
              style={{
                display: 'block',
                fontSize: 9,
                fontStyle: 'italic',
                fontFamily: 'var(--font-oxanium, sans-serif)',
                fontWeight: 400,
                color: '#ffe7c8',
                opacity: 0.7,
                marginTop: 2,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
              }}
            >
              Board · Boards 3 + 4
            </span>
          </div>
          <div
            style={{
              width: 1,
              height: 56,
              backgroundImage: 'linear-gradient(rgba(255,200,140,0.78) 50%, transparent 50%)',
              backgroundSize: '1px 6px',
              backgroundRepeat: 'repeat-y',
              boxShadow: '0 0 6px rgba(255,200,120,0.55)',
              marginBottom: 2,
            }}
          />
          <div
            className="bio-anchor"
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'rgba(255,217,160,1)',
              animation: 'bio-pulse 2.4s ease-in-out infinite',
              animationDelay: 'calc(var(--label-phase, 0) * -2.4s)',
            }}
          />
        </div>
      </WorldLabel>
    </group>
  );
});

export default function QuestBountyPavilion() {
  return <QuestBountyPavilionInner />;
}
