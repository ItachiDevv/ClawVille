'use client';

/**
 * BumperShellsPlayer.tsx
 *
 * Single player shell component. Clones lobster.glb or crayfish.glb, applies
 * squash/stretch on hit, fades out on elimination.
 *
 * One instance per player, up to MAX_PLAYERS=8 simultaneously.
 *
 * Iris Xe invariants:
 *   - SkeletonUtils.clone() + frustumCulled=false traverse immediately after clone.
 *   - Squash/stretch applied to ROOT GROUP not SkinnedMesh bones.
 *   - No per-frame allocations — module-scope scratch vectors.
 *   - applyColorTint skipped for GLB shells (matches VRM-tinting convention from player-pet.tsx).
 *
 * Draw calls: 1 per player (lobster.glb is 1 SkinnedMesh draw call).
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LobsterAnimator } from '@/lib/three/lobster-animations';
import { discoverLobsterParts } from '@/lib/three/lobster-parts';
import type { BumperShellEntity, ShellHitAnimState } from './bumper-shells-types';
import { SHELL_SCALE, HIT_ANIM_FRAMES } from './bumper-shells-config';

// ─── Preloads — fire at module scope so GLBs are warm before a round starts ──
useGLTF.preload('/models/lobster.glb');
useGLTF.preload('/models/crayfish.glb');

// ─── Module-scope scratch ─────────────────────────────────────────────────────
const _scale = new THREE.Vector3();

// ─── Lobster facing constant ──────────────────────────────────────────────────
// lobster.glb faces +Z at rotation.y=0. Facing formula: atan2(vx, vy) in sim-space,
// which maps to atan2(vx, vz) in 3D.
// idle default = 0 (faces +Z toward default camera).

interface BumperShellsPlayerProps {
  entity: BumperShellEntity;
  /** True if this is the local player (used for highlight, not yet used in 3D). */
  isSelf?: boolean;
}

function BumperShellsPlayerInner({ entity, isSelf = false }: BumperShellsPlayerProps) {
  const species = entity.species ?? 'lobster';
  const glbPath = species === 'crayfish' ? '/models/crayfish.glb' : '/models/lobster.glb';

  const { scene: srcScene } = useGLTF(glbPath);

  const groupRef    = useRef<THREE.Group>(null);
  const meshRootRef = useRef<THREE.Group>(null);

  // Hit animation state — managed via ref (no React re-render needed).
  const hitAnim = useRef<ShellHitAnimState>({ active: false, elapsed: 0 });

  // Fade state for elimination.
  const fadeRef = useRef({ active: false, opacity: 1 });

  // Clone the GLB once per entity/species change.
  const clonedScene = useMemo(() => {
    const c = skeletonClone(srcScene);
    // CRITICAL: frustumCulled=false traverse immediately after SkeletonUtils.clone.
    // SkinnedMesh bind-pose bounding spheres don't encompass animated poses.
    c.traverse((o) => {
      o.frustumCulled = false;
    });
    return c;
  }, [srcScene]);

  // Attach and detach the cloned scene.
  useEffect(() => {
    const root = meshRootRef.current;
    if (!root || !clonedScene) return;
    root.add(clonedScene);
    return () => {
      root.remove(clonedScene);
    };
  }, [clonedScene]);

  // Track previous alive state to trigger fade on elimination.
  const wasAlive = useRef(true);

  useFrame((_, delta) => {
    const group    = groupRef.current;
    const meshRoot = meshRootRef.current;
    if (!group || !meshRoot) return;

    // ─── Position + rotation from entity ──────────────────────────────────
    // Sim-space: x → Three.js X, y → Three.js Z (top-down arena).
    group.position.x = entity.x;
    group.position.y = 6; // top of disc
    group.position.z = entity.y;

    // Facing: lobster faces +Z at rot=0 → atan2(vx, vz).
    if (entity.vx !== 0 || entity.vy !== 0) {
      group.rotation.y = Math.atan2(entity.vx, entity.vy);
    }

    // ─── Squash/stretch animation (applied to meshRoot group) ─────────────
    const h = hitAnim.current;
    if (h.active) {
      h.elapsed += delta;
      const lastFrame = HIT_ANIM_FRAMES[HIT_ANIM_FRAMES.length - 1];
      if (h.elapsed >= lastFrame.t) {
        h.active = false;
        meshRoot.scale.set(1, 1, 1);
      } else {
        // Linear interpolation between keyframes.
        for (let i = 1; i < HIT_ANIM_FRAMES.length; i++) {
          const prev = HIT_ANIM_FRAMES[i - 1];
          const next = HIT_ANIM_FRAMES[i];
          if (h.elapsed >= prev.t && h.elapsed <= next.t) {
            const t = (h.elapsed - prev.t) / (next.t - prev.t);
            meshRoot.scale.set(
              prev.scale[0] + (next.scale[0] - prev.scale[0]) * t,
              prev.scale[1] + (next.scale[1] - prev.scale[1]) * t,
              prev.scale[2] + (next.scale[2] - prev.scale[2]) * t,
            );
            break;
          }
        }
      }
    }

    // ─── Elimination fade ─────────────────────────────────────────────────
    if (wasAlive.current && !entity.alive) {
      // Just eliminated — start fade.
      wasAlive.current = false;
      fadeRef.current.active = true;
      fadeRef.current.opacity = 1;
    }

    if (fadeRef.current.active) {
      fadeRef.current.opacity = Math.max(0, fadeRef.current.opacity - delta * 1.0);
      clonedScene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
          if (mat) {
            mat.transparent = true;
            mat.opacity = fadeRef.current.opacity;
          }
        }
      });
      if (fadeRef.current.opacity <= 0) {
        fadeRef.current.active = false;
        group.visible = false;
      }
    }

    // Show/hide based on alive state (after any fade completes).
    if (entity.alive && !wasAlive.current) {
      // Re-spawned (future: respawn support).
      wasAlive.current = true;
      group.visible = true;
      fadeRef.current.opacity = 1;
    }
  });

  /**
   * Called externally (by BumperShellsScene) when a hit event matches this petId.
   * Triggers the squash/stretch animation.
   */
  // We expose this via an imperative handle pattern using a ref on the outer group.
  // BumperShellsScene calls: playerRefs[petId].current?.triggerHit?.()
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    (group as THREE.Group & { triggerHit?: () => void }).triggerHit = () => {
      hitAnim.current = { active: true, elapsed: 0 };
    };
  });

  return (
    <group ref={groupRef} scale={[SHELL_SCALE, SHELL_SCALE, SHELL_SCALE]}>
      {/* meshRoot receives squash/stretch scale — separate from the position group */}
      <group ref={meshRootRef} />
    </group>
  );
}

export default function BumperShellsPlayer(props: BumperShellsPlayerProps) {
  return (
    <BumperShellsPlayerInner {...props} />
  );
}
