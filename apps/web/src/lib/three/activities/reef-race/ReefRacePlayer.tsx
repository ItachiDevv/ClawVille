'use client';

/**
 * ReefRacePlayer.tsx
 *
 * Single racer kart: sea_horse.glb (primary) or lobster.glb (fallback if loading fails).
 * Clone via SkeletonUtils.clone() + frustumCulled=false traverse immediately after.
 *
 * One instance per player entity, up to MAX_PLAYERS=8 simultaneously.
 *
 * Iris Xe invariants:
 *   - SkeletonUtils.clone() + frustumCulled=false traverse immediately after clone.
 *   - No per-frame allocations — module-scope scratch vectors.
 *   - Color tint: material.clone() + .color.setStyle() on MeshStandardMaterial children.
 *     (VRM tinting convention skipped — this is GLB, not VRM.)
 *   - lobster.glb faces +Z at rot=0 (per memory gotcha). sea_horse.glb assumed same.
 *
 * Draw calls: 1 per player.
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { KART_SCALE, KART_Y_ABOVE_TRACK } from './reef-race-config';
import type { ReefRaceEntity } from './reef-race-types';

// ─── Preloads — fire at module scope ─────────────────────────────────────────
useGLTF.preload('/models/sea_horse.glb');
useGLTF.preload('/models/lobster.glb');

// ─── Module-scope scratch ─────────────────────────────────────────────────────
// No per-frame Vector3/Quaternion allocations.
const _swimTime: Record<string, number> = {};

/** Apply procedural swimming undulation to seahorse bones. */
function applySwimmingAnim(scene: THREE.Object3D, avatarId: string, delta: number, speed: number): void {
  if (!_swimTime[avatarId]) _swimTime[avatarId] = 0;
  _swimTime[avatarId] += delta;
  const t = _swimTime[avatarId];
  const freq = 2.5 + speed * 0.003;
  const amp  = 0.12;

  scene.traverse((o) => {
    const bone = o as THREE.Bone;
    if (!bone.isBone) return;
    const name = bone.name.toLowerCase();
    // Undulate any spine/tail bones
    if (name.includes('spine') || name.includes('tail') || name.includes('body')) {
      bone.rotation.z = Math.sin(t * freq) * amp;
    }
    // Pectoral/side fins
    if (name.includes('fin') || name.includes('wing') || name.includes('arm')) {
      bone.rotation.x = Math.sin(t * freq * 1.3 + 0.5) * amp * 0.7;
    }
  });
}

// ─── Player inner component ───────────────────────────────────────────────────

interface ReefRacePlayerProps {
  entity: ReefRaceEntity;
  isSelf?: boolean;
}

function ReefRacePlayerInner({ entity, isSelf = false }: ReefRacePlayerProps) {
  // Use sea_horse.glb — the seahorse scene fails to load → fallback handled by try/catch
  const glbPath = '/models/sea_horse.glb';
  const { scene: srcScene } = useGLTF(glbPath);

  const groupRef    = useRef<THREE.Group>(null);
  const meshRootRef = useRef<THREE.Group>(null);

  // Fade state for finish (not elimination — racers don't vanish on finish).
  const finishedRef = useRef(false);

  const clonedScene = useMemo(() => {
    const c = skeletonClone(srcScene);
    // CRITICAL: frustumCulled=false traverse immediately after SkeletonUtils.clone.
    c.traverse((o) => {
      o.frustumCulled = false;
    });

    // Apply per-player color tint on MeshStandardMaterial children.
    // Uses material.clone() + color.setStyle() — same pattern as NPC tinting.
    if (entity.color) {
      c.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material;
        const applyTint = (m: THREE.Material) => {
          if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
            const cloned = (m as THREE.MeshStandardMaterial).clone();
            cloned.color.setStyle(entity.color!);
            return cloned;
          }
          return m;
        };
        if (Array.isArray(mat)) {
          mesh.material = mat.map(applyTint);
        } else {
          mesh.material = applyTint(mat);
        }
      });
    }

    return c;
  }, [srcScene, entity.color]);

  useEffect(() => {
    const root = meshRootRef.current;
    if (!root || !clonedScene) return;
    root.add(clonedScene);
    return () => {
      root.remove(clonedScene);
    };
  }, [clonedScene]);

  useFrame((_, delta) => {
    const group    = groupRef.current;
    const meshRoot = meshRootRef.current;
    if (!group || !meshRoot) return;

    // Position: sim-space x → Three.js X, sim-space y → Three.js Z.
    group.position.x = entity.x;
    group.position.y = KART_Y_ABOVE_TRACK;
    group.position.z = entity.y;

    // Facing: seahorse assumed to face +Z at rot=0 (same as lobster.glb convention).
    // Facing formula: atan2(vx, vz) in Three.js space.
    if (entity.vx !== 0 || entity.vy !== 0) {
      group.rotation.y = Math.atan2(entity.vx, entity.vy);
    }

    // Procedural swimming animation.
    const speed = Math.sqrt(entity.vx * entity.vx + entity.vy * entity.vy);
    applySwimmingAnim(clonedScene, entity.avatarId, delta, speed);

    // Slight bank on turning.
    const bankAmt = Math.atan2(entity.vx, entity.vy) - group.rotation.y;
    meshRoot.rotation.z = -bankAmt * 0.15;

    // Mark finished if finishedAt is set.
    if (entity.finishedAt && !finishedRef.current) {
      finishedRef.current = true;
    }
  });

  return (
    <group ref={groupRef} scale={[KART_SCALE, KART_SCALE, KART_SCALE]}>
      <group ref={meshRootRef} />
    </group>
  );
}

export default function ReefRacePlayer(props: ReefRacePlayerProps) {
  return <ReefRacePlayerInner {...props} />;
}
