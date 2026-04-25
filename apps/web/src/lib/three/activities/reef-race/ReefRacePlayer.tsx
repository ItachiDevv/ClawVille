'use client';

/**
 * ReefRacePlayer.tsx
 *
 * REBUILT 2026-04-24 — Three bugs fixed (port from BumperShellsPlayer pattern):
 *
 *   Bug 1 — No interpolation: direct entity.x/y assignment on every frame
 *   produced 15Hz positional jumps at 60fps render rate. Fixed with the 4-snapshot
 *   history ring + 100ms render delay pattern from BumperShellsPlayer.
 *
 *   Bug 2 — Velocity-derived facing: atan2(vx,vy) snaps on every knockback
 *   impulse. Fixed: facing now comes from entity.rot (server-authoritative, only
 *   updated on player input direction — immune to knockback). lerpAngle via
 *   shortest arc applied across interpolated snapshots.
 *
 *   Bug 3 — Hardcoded sea_horse.glb ignoring entity.species. Fixed: branch on
 *   species === 'sea_horse' → sea_horse.glb, else → lobster.glb. The procedural
 *   applySwimmingAnim traverses by bone name (spine/tail/fin) and works on both
 *   models — lobster has these bones per lobster-parts.ts discovery patterns, so
 *   the swimming motion degrades gracefully (fish-like) on lobsters. No species-
 *   specific animator branch needed.
 *
 * Iris Xe invariants:
 *   - SkeletonUtils.clone() + frustumCulled=false traverse immediately after clone.
 *   - No per-frame allocations — module-scope scratch primitives only.
 *   - import from 'three' (plain), NOT 'three/webgpu'.
 *   - Color tint preserved unchanged (lines 87-106 in original — not touched).
 *
 * Draw calls: 1 per player.
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { KART_SCALE, KART_Y_ABOVE_TRACK } from './reef-race-config';
import type { ReefRaceEntity } from './reef-race-types';

// ─── Preloads — fire at module scope ─────────────────────────────────────────
useGLTF.preload('/models/sea_horse.glb');
useGLTF.preload('/models/lobster.glb');

// ─── Interpolation constants ──────────────────────────────────────────────────
/**
 * How far behind real-time we render (ms).
 * = 1.5× the 15Hz snapshot interval (66.67ms) → comfortable bracket window.
 */
const INTERP_DELAY_MS = 100;

/**
 * Maximum snapshot history kept per entity.
 * 4 entries covers 4 × 66ms ≈ 265ms — comfortably past INTERP_DELAY_MS.
 */
const INTERP_HISTORY_SIZE = 4;

// ─── Module-scope scratch — NO per-frame allocations ─────────────────────────
const _swimTime: Record<string, number> = {};

// ─── Shortest-angle lerp ──────────────────────────────────────────────────────
/**
 * Lerps between two angles (radians) along the shortest arc.
 * Avoids spinning backwards through the 0/±π boundary.
 * No allocations — pure primitive math.
 */
function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((b - a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return a + diff * t;
}

// ─── Per-snapshot record ──────────────────────────────────────────────────────
interface SnapRecord {
  /** performance.now() timestamp when this snapshot was received (ms). */
  t: number;
  x: number;
  z: number; // sim-space y → Three.js Z
  /**
   * Facing angle in radians from entity.rot (server-authoritative).
   * NaN on initial spawn frame (rot=0, no velocity) — fall back to lastRotRef.
   */
  rot: number;
  vx: number;
  vz: number; // sim-space vy → Three.js vz
}

/** Apply procedural swimming undulation to seahorse / lobster bones. */
function applySwimmingAnim(scene: THREE.Object3D, petId: string, delta: number, speed: number): void {
  if (!_swimTime[petId]) _swimTime[petId] = 0;
  _swimTime[petId] += delta;
  const t = _swimTime[petId];
  const freq = 2.5 + speed * 0.003;
  const amp  = 0.12;

  scene.traverse((o) => {
    const bone = o as THREE.Bone;
    if (!bone.isBone) return;
    const name = bone.name.toLowerCase();
    // Undulate any spine/tail/body bones
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
  // BUG FIX (Bug 3): branch on entity.species instead of hardcoding sea_horse.glb.
  // entity.species is populated from the pet's model_key via the server delta.
  // Default 'lobster' matches pets.model_key default in DB schema.
  const species = entity.species ?? 'lobster';
  const glbPath = species === 'sea_horse' ? '/models/sea_horse.glb' : '/models/lobster.glb';

  const { scene: srcScene } = useGLTF(glbPath);

  const groupRef    = useRef<THREE.Group>(null);
  const meshRootRef = useRef<THREE.Group>(null);

  // Fade state for finish (not elimination — racers don't vanish on finish).
  const finishedRef = useRef(false);

  // ─── Interpolation state ────────────────────────────────────────────────────
  // Ring buffer of received snapshots.
  const historyRef = useRef<SnapRecord[]>([]);
  // Identity compare to detect new snapshot (store builds new object per delta).
  const lastEntityRef = useRef<ReefRaceEntity | null>(null);
  // Last interpolated rotation — fallback when rot=0 + no velocity (initial spawn).
  const lastRotRef = useRef(0);

  const clonedScene = useMemo(() => {
    const c = skeletonClone(srcScene);
    // CRITICAL: frustumCulled=false traverse immediately after SkeletonUtils.clone.
    // SkinnedMesh bind-pose bounding spheres don't encompass animated poses.
    c.traverse((o) => {
      o.frustumCulled = false;
    });

    // Apply per-player color tint on MeshStandardMaterial children.
    // Uses material.clone() + color.setStyle() — same pattern as NPC tinting.
    // DO NOT MODIFY — this block is working correctly.
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

    // Cap delta to prevent spiral-of-death on stall frames.
    const dt = Math.min(delta, 0.1);

    // ─── Snapshot ingestion (BUG FIX Bug 1 + Bug 2) ──────────────────────────
    // Detect new entity object by identity — store builds a new object per delta.
    if (entity !== lastEntityRef.current) {
      lastEntityRef.current = entity;

      // BUG FIX (Bug 2): use entity.rot (server-authoritative facing).
      // entity.rot is set by the server as atan2(intent.dir.x, intent.dir.y)
      // on player input ONLY — it does NOT update on knockback impulses.
      // Fallback to lastRotRef when rot=0 AND no velocity (initial spawn frame).
      const hasVelocity = entity.vx !== 0 || entity.vy !== 0;
      const rot = (entity.rot !== 0 || hasVelocity) ? entity.rot : NaN;

      const snap: SnapRecord = {
        t: performance.now(),
        x: entity.x,
        z: entity.y, // sim-space y → Three.js Z
        rot,
        vx: entity.vx,
        vz: entity.vy, // sim-space vy → Three.js vz
      };

      const h = historyRef.current;
      h.push(snap);
      // Trim to keep only the latest INTERP_HISTORY_SIZE entries.
      if (h.length > INTERP_HISTORY_SIZE) {
        h.splice(0, h.length - INTERP_HISTORY_SIZE);
      }
    }

    // ─── Interpolation (BUG FIX Bug 1) ───────────────────────────────────────
    // Render at (now - INTERP_DELAY_MS) — smooth 60fps motion from 15Hz snapshots.
    const history = historyRef.current;
    let interpX   = entity.x;
    let interpZ   = entity.y;
    let interpRot = lastRotRef.current;
    let interpVx  = entity.vx;
    let interpVz  = entity.vy;

    if (history.length === 1) {
      // Only one snapshot — snap directly (startup case, no bracket yet).
      interpX   = history[0].x;
      interpZ   = history[0].z;
      interpVx  = history[0].vx;
      interpVz  = history[0].vz;
      if (!isNaN(history[0].rot)) {
        interpRot = history[0].rot;
      }
    } else if (history.length >= 2) {
      const renderTime = performance.now() - INTERP_DELAY_MS;

      // Find the pair of snapshots that bracket renderTime.
      // history is sorted ascending by t (push-only, no reorder needed).
      let a = history[history.length - 2];
      let b = history[history.length - 1];
      for (let i = 1; i < history.length; i++) {
        if (history[i].t >= renderTime) {
          a = history[i - 1];
          b = history[i];
          break;
        }
      }

      // Interpolation factor in [0, 1]. Clamped — never extrapolate.
      const span = b.t - a.t;
      const rawT = span > 0 ? (renderTime - a.t) / span : 1;
      const t = rawT < 0 ? 0 : rawT > 1 ? 1 : rawT;

      interpX  = a.x  + (b.x  - a.x)  * t;
      interpZ  = a.z  + (b.z  - a.z)  * t;
      interpVx = a.vx + (b.vx - a.vx) * t;
      interpVz = a.vz + (b.vz - a.vz) * t;

      // BUG FIX (Bug 2): lerp entity.rot angles via shortest arc. Skip NaN frames.
      const rotA = isNaN(a.rot) ? lastRotRef.current : a.rot;
      const rotB = isNaN(b.rot) ? rotA               : b.rot;
      interpRot = lerpAngle(rotA, rotB, t);
    }

    // Persist the interpolated rotation for the next zero-velocity spawn frame.
    lastRotRef.current = interpRot;

    // ─── Apply interpolated transform ─────────────────────────────────────────
    // BUG FIX (Bug 1): position now comes from interpolated history, not raw entity.
    // BUG FIX (Bug 2): rotation now comes from entity.rot, not atan2(vx,vy).
    group.position.x = interpX;
    group.position.y = KART_Y_ABOVE_TRACK;
    group.position.z = interpZ;
    group.rotation.y = interpRot;

    // ─── Procedural swimming animation ────────────────────────────────────────
    const speed = Math.sqrt(interpVx * interpVx + interpVz * interpVz);
    applySwimmingAnim(clonedScene, entity.petId, dt, speed);

    // ─── Slight bank on turning (velocity-derived — fine for visual lean) ─────
    // Bank uses velocity direction relative to current facing. Because facing is
    // now server-authoritative (entity.rot), delta between velocity angle and
    // group.rotation.y gives the correct lean amount without spazzing.
    const velAngle = (interpVx !== 0 || interpVz !== 0)
      ? Math.atan2(interpVx, interpVz)
      : interpRot;
    // Wrap bank delta into (-π, π]
    let bankDelta = velAngle - group.rotation.y;
    bankDelta = ((bankDelta % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    meshRoot.rotation.z = -bankDelta * 0.15;

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
