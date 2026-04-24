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
 *   - Squash/stretch applied to ROOT GROUP (meshRootRef) not SkinnedMesh bones.
 *   - LobsterAnimator works on clonedScene parts — composes with squash (no bone conflict).
 *   - No per-frame allocations — module-scope scratch primitives only.
 *   - applyColorTint skipped for GLB shells (matches VRM-tinting convention from player-pet.tsx).
 *
 * Chunk #12a: LobsterAnimator wired. Locomotion blend driven by entity velocity
 * from activity store. Animator composes with squash/stretch — both applied to
 * separate groups so bone transforms and root scale never collide.
 *
 * Chunk #13 (interpolation): client-side position + facing interpolation eliminates
 * the 15Hz teleport jitter. Strategy:
 *   - Stamp each incoming entity snapshot with performance.now() at the moment the
 *     prop changes (detected by ref comparison in useFrame).
 *   - Maintain a per-component history ring of up to INTERP_HISTORY_SIZE snapshots.
 *   - Render at (now - INTERP_DELAY_MS), finding the two bracket snapshots and lerping.
 *   - Rotation uses shortest-angle lerp (never spins through 0/2π boundary).
 *   - Velocity is lerped in parallel — drives the locomotion blend smoothly.
 *   - If only one snapshot in buffer (startup), snap directly to it; no extrapolation.
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

// ─── Interpolation constants ──────────────────────────────────────────────────
/**
 * How far behind real-time we render (ms).
 * = 1.5× the 15Hz snapshot interval (66.67ms) → 100ms gives us a comfortable
 * bracket window with at least one "future" snapshot available whenever
 * the server has been running for > 1 snapshot period.
 */
const INTERP_DELAY_MS = 100;

/**
 * Maximum snapshot history kept per entity.
 * 4 entries covers 4 × 66ms ≈ 265ms of history — comfortably past INTERP_DELAY_MS.
 */
const INTERP_HISTORY_SIZE = 4;

// ─── Module-scope scratch — NO per-frame allocations ─────────────────────────
// All values are plain number primitives — safe on Iris Xe.
const _speedScratch = { speed: 0 };

// ─── Locomotion speed thresholds ─────────────────────────────────────────────
/** Below this speed (wu/s) the animator uses 'idle'. */
const WALK_SPEED_THRESHOLD = 20;
/** Above this speed (wu/s) the animator blends toward 'walk' at full rate. */
const RUN_SPEED_THRESHOLD = 80;

// ─── Lobster facing constant ──────────────────────────────────────────────────
// lobster.glb faces +Z at rotation.y=0. Facing formula: atan2(vx, vy) in sim-space,
// which maps to atan2(vx, vz) in 3D (sim-y → Three.js Z).
// idle default = 0 (faces +Z toward default camera).

// ─── Per-snapshot record ─────────────────────────────────────────────────────

interface SnapRecord {
  /** performance.now() timestamp when this snapshot was received (ms). */
  t: number;
  x: number;
  z: number; // sim-space y → Three.js z
  /** Facing angle in radians: atan2(vx, vy). NaN if velocity is zero (use prev). */
  rot: number;
  vx: number;
  vz: number; // sim-space vy → Three.js vz
}

// ─── Shortest-angle lerp ──────────────────────────────────────────────────────
/**
 * Lerps between two angles (radians) along the shortest arc.
 * Avoids spinning backwards through the 0/±π boundary.
 * No allocations — pure primitive math.
 */
function lerpAngle(a: number, b: number, t: number): number {
  // Bring difference into (-π, π].
  let diff = ((b - a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return a + diff * t;
}

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

  // LobsterAnimator instance — created once per clone, updated every frame.
  const animatorRef = useRef<LobsterAnimator | null>(null);

  // Elapsed time accumulator for the animator (module-level elapsed per instance).
  const elapsedRef = useRef(0);

  // ─── Interpolation state ────────────────────────────────────────────────────
  // Ring buffer of received snapshots. We preallocate INTERP_HISTORY_SIZE slots.
  const historyRef = useRef<SnapRecord[]>([]);
  // Pointer to the last entity object we saw (identity compare to detect new snapshot).
  const lastEntityRef = useRef<BumperShellEntity | null>(null);
  // Last interpolated rotation — used when velocity is zero (no new facing info).
  const lastRotRef = useRef(0);

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

  // Rebuild the animator whenever the clone changes.
  // discoverLobsterParts uses spatial heuristics — safe on any lobster/crayfish GLB.
  useEffect(() => {
    const parts = discoverLobsterParts(clonedScene);
    animatorRef.current = new LobsterAnimator(parts);
    // Reset elapsed so new clone starts from t=0.
    elapsedRef.current = 0;
  }, [clonedScene]);

  // Attach and detach the cloned scene to meshRootRef.
  // meshRootRef receives squash/stretch scale — the clonedScene inside is
  // the animator's target. Squash (root scale) and animator (bone rotations)
  // are orthogonal — no interference.
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

    // Cap delta to prevent spiral-of-death on stall frames.
    const dt = Math.min(delta, 0.1);

    // ─── Elapsed time accumulator ────────────────────────────────────────
    elapsedRef.current += dt;
    const elapsed = elapsedRef.current;

    // ─── Snapshot ingestion ───────────────────────────────────────────────
    // Detect new entity object by identity (store builds a new object per delta).
    if (entity !== lastEntityRef.current) {
      lastEntityRef.current = entity;

      // Compute facing from velocity. NaN when both are zero — we'll fall back
      // to the last rendered rotation so the lobster doesn't snap to 0.
      const hasVelocity = entity.vx !== 0 || entity.vy !== 0;
      const rot = hasVelocity ? Math.atan2(entity.vx, entity.vy) : NaN;

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

    // ─── Interpolation ────────────────────────────────────────────────────
    const history = historyRef.current;
    let interpX  = entity.x;
    let interpZ  = entity.y;
    let interpRot = lastRotRef.current;
    let interpVx = entity.vx;
    let interpVz = entity.vy;

    if (history.length === 1) {
      // Only one snapshot — snap directly to it (startup case).
      interpX   = history[0].x;
      interpZ   = history[0].z;
      interpVx  = history[0].vx;
      interpVz  = history[0].vz;
      if (!isNaN(history[0].rot)) {
        interpRot = history[0].rot;
      }
    } else if (history.length >= 2) {
      // Render at (now - INTERP_DELAY_MS).
      const renderTime = performance.now() - INTERP_DELAY_MS;

      // Find the pair of snapshots that bracket renderTime.
      // history is sorted ascending by t (push-only).
      let a = history[0];
      let b = history[1];
      for (let i = 1; i < history.length; i++) {
        if (history[i].t >= renderTime) {
          a = history[i - 1];
          b = history[i];
          break;
        }
        // renderTime is past the last snapshot — clamp to the last two.
        a = history[history.length - 2];
        b = history[history.length - 1];
      }

      // Interpolation factor in [0, 1]. Clamped so we never extrapolate.
      const span = b.t - a.t;
      const rawT = span > 0 ? (renderTime - a.t) / span : 1;
      const t = rawT < 0 ? 0 : rawT > 1 ? 1 : rawT;

      interpX  = a.x  + (b.x  - a.x)  * t;
      interpZ  = a.z  + (b.z  - a.z)  * t;
      interpVx = a.vx + (b.vx - a.vx) * t;
      interpVz = a.vz + (b.vz - a.vz) * t;

      // Rotation: prefer velocity-derived angle; skip NaN (zero-velocity) frames.
      const rotA = isNaN(a.rot) ? lastRotRef.current : a.rot;
      const rotB = isNaN(b.rot) ? rotA               : b.rot;
      interpRot = lerpAngle(rotA, rotB, t);
    }

    // Persist the interpolated rotation for the next zero-velocity frame.
    lastRotRef.current = interpRot;

    // ─── Apply interpolated transform to group ────────────────────────────
    group.position.x = interpX;
    group.position.y = 6; // top of disc
    group.position.z = interpZ;
    group.rotation.y = interpRot;

    // ─── LobsterAnimator: locomotion blend from interpolated velocity ──────
    // Speed is magnitude of (vx, vz) in sim-space (both map to XZ plane).
    // Reuse module-scope scratch — no allocation.
    _speedScratch.speed = Math.sqrt(interpVx * interpVx + interpVz * interpVz);

    let suggestedState: 'idle' | 'walk' = 'idle';
    let direction = 'idle';
    if (_speedScratch.speed >= WALK_SPEED_THRESHOLD) {
      suggestedState = 'walk';
      // Direction string is advisory for gait phasing — 'down' is the default
      // forward direction for the lobster (+Z facing). The animator uses it for
      // dodge phasing only; for walk it drives antenna streaming direction.
      direction = 'down';
    }

    const animator = animatorRef.current;
    if (animator) {
      animator.update(dt, elapsed, suggestedState, direction);
    }

    // ─── Squash/stretch animation (applied to meshRoot group) ─────────────
    // NOTE: meshRoot scale does NOT affect the animator's bone rotations.
    // The animator modifies clonedScene's child mesh local rotations.
    // meshRoot.scale is a separate transform above those children.
    const h = hitAnim.current;
    if (h.active) {
      h.elapsed += dt;
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
      fadeRef.current.opacity = Math.max(0, fadeRef.current.opacity - dt * 1.0);
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
      {/* meshRoot receives squash/stretch scale — separate from the position group.
          clonedScene is a child of meshRoot so the animator's bone mutations
          and the squash scale compose cleanly: worldScale = outerGroupScale × meshRootScale × boneLocal */}
      <group ref={meshRootRef} />
    </group>
  );
}

export default function BumperShellsPlayer(props: BumperShellsPlayerProps) {
  return (
    <BumperShellsPlayerInner {...props} />
  );
}
