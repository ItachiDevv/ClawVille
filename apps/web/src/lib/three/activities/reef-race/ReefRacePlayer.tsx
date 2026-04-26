'use client';

/**
 * ReefRacePlayer.tsx
 *
 * REBUILT 2026-04-24 — Three bugs fixed (port from BumperShellsPlayer pattern):
 *
 *   Bug 1 — No interpolation: direct entity.x/y assignment on every frame
 *   produced positional jumps at 60fps render rate. Fixed with the 4-snapshot
 *   history ring + INTERP_DELAY_MS render delay (2× the snapshot interval).
 *   Snapshot rate bumped 5→10Hz on 2026-04-26 alongside delay 350→200ms.
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
 * Phase 1 §4 — Reef Glider scene node restructure (2026-04-24):
 *
 *   Scene graph restructured from:
 *     groupRef → meshRootRef (bank tilt + avatar)
 *
 *   To:
 *     groupRef → gliderRef (bank tilt) → [gliderMesh, riderMountRef → avatarMesh]
 *
 *   - gliderMesh: shared module-scope BoxGeometry(2.5, 0.25, 5) + MeshStandardMaterial.
 *     ONE geometry and ONE material instance for ALL player instances (no per-mount alloc).
 *   - gliderRef carries the bank tilt (rotation.z). riderMountRef.rotation.z = 0 always.
 *   - riderMountRef positioned at RIDER_MOUNT_OFFSET_DEFAULT = [0, 0.6, -0.5] local.
 *   - Gentle bob on riderMountRef.position.y (±2 local units at 1.2Hz).
 *   - KART_Y_ABOVE_TRACK elevation moves from group.position.y (world) to
 *     gliderRef.position.y (local = KART_Y_ABOVE_TRACK / KART_SCALE = 0.25).
 *
 * Iris Xe invariants:
 *   - SkeletonUtils.clone() + frustumCulled=false traverse immediately after clone.
 *   - No per-frame allocations — module-scope scratch primitives only.
 *   - import from 'three' (plain), NOT 'three/webgpu'.
 *   - Color tint preserved unchanged (same traverse + clone pattern as before).
 *   - Shared glider geometry/material never disposed (page-lifetime, multi-instance).
 *
 * Draw calls: 2 per player (glider board + avatar).
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  KART_SCALE,
  KART_Y_ABOVE_TRACK,
  GLIDER_WIDTH,
  GLIDER_HEIGHT,
  GLIDER_LENGTH,
  RIDER_MOUNT_OFFSET_DEFAULT,
} from './reef-race-config';
import type { ReefRaceEntity } from './reef-race-types';

// ─── Preloads — fire at module scope ─────────────────────────────────────────
useGLTF.preload('/models/sea_horse.glb');
useGLTF.preload('/models/lobster.glb');

// ─── Shared glider geometry + material (ONE instance for ALL players) ─────────
// Never disposed — these are page-lifetime, shared across all ReefRacePlayer
// instances. Disposing on any one instance would break all other live instances.
const _gliderGeom = new THREE.BoxGeometry(GLIDER_WIDTH, GLIDER_HEIGHT, GLIDER_LENGTH);
const _gliderMat  = new THREE.MeshStandardMaterial({
  color:     '#1e293b',
  roughness: 0.5,
  metalness: 0.4,
});

// ─── Interpolation constants ──────────────────────────────────────────────────
/**
 * How far behind real-time we render (ms).
 *
 * Server REEF_SNAPSHOT_HZ was bumped 5 → 10 (2026-04-26) so each snap is now
 * 100 ms apart. Worst-case arrival gap = snap_interval (100 ms) + jitter
 * (50–80 ms). INTERP_DELAY_MS must exceed that gap so renderTime always falls
 * BEFORE the newest history entry's arrival timestamp — otherwise the bracket
 * scan extrapolates past the newest snap and the body teleports forward when
 * the next snap finally arrives.
 *
 *   target = 100 ms snap_interval + 50 ms jitter buffer + 50 ms safety = 200 ms
 *
 * Trade-off: 200 ms input lag from press to on-screen kart motion. Half the
 * old 350 ms lag, with twice the snapshot resolution → much smoother motion
 * and faster control feel. Bumping snapshot rate further (15 / 30 Hz) would
 * trade more bandwidth for marginal smoothness gain — diminishing returns.
 *
 * Earlier values that failed:
 *   - 100 ms (initial) — assumed 15 Hz; server was 5 Hz; freeze for ~100 ms.
 *   - 250 ms — covered avg interval not jitter; user reported jumps.
 *   - 350 ms — covered jitter but each segment was 200 ms long, so a single
 *     delayed snap looked like "feet in one jump" when the next snap arrived
 *     and the bracket interp scrubbed 400 ms of motion in 1-2 render frames.
 */
const INTERP_DELAY_MS = 200;

/**
 * Maximum snapshot history kept per entity.
 * 4 entries at 5 Hz covers 800 ms — well past the 250 ms INTERP_DELAY_MS.
 * Trim logic in useFrame keeps only the latest INTERP_HISTORY_SIZE entries,
 * so the bracket scan always has ≥ 2 entries available after the 2nd snap.
 */
const INTERP_HISTORY_SIZE = 4;

// ─── Module-scope scratch — NO per-frame allocations ─────────────────────────
const _swimTime: Record<string, number> = {};
const _bobTime: Record<string, number>  = {};

/**
 * Bob amplitude in local units (× KART_SCALE = world units).
 *
 * Old value was 2 local = 40 world units — caused rider to oscillate between
 * +52 wu and -28 wu, sinking FAR below the board (board top = 7.5 wu world).
 *
 * New value: 0.04 local = 0.8 wu world — gentle float effect.
 * With RIDER_MOUNT_OFFSET_DEFAULT[1] = 1.2 local:
 *   rider Y range in local = [1.16, 1.24] → world = [23.2, 24.8] wu
 *   board top in world     = 7.5 wu
 *   clearance above board  = 15.7 – 17.3 wu  ✓  never clips board
 */
const BOB_AMP_LOCAL  = 0.04;
/** Bob frequency in Hz. */
const BOB_FREQ_HZ    = 1.2;
/** gliderRef Y in local space = KART_Y_ABOVE_TRACK (world) / KART_SCALE. */
const GLIDER_LOCAL_Y = KART_Y_ABOVE_TRACK / KART_SCALE; // = 0.25

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
  // entity.species deferred per C8 fix — Phase 1 uses lobster.glb as sole default.
  // Phase 1.5 will restore species branching once the server populates the field.
  // (Note: master's PR #62 reintroduced the `species ?? 'lobster'` branch, but
  // `species` is NOT in `EntityDelta` or `WorldState.entities` per the audit, so
  // the branch always falls through to lobster.glb anyway — and the Milady-default
  // flip in `a50bb28` only affects `model_key` / VRM avatars, not Reef Race GLBs.)
  const glbPath = '/models/lobster.glb';

  const { scene: srcScene } = useGLTF(glbPath);

  const groupRef      = useRef<THREE.Group>(null);
  const gliderRef     = useRef<THREE.Group>(null);
  const riderMountRef = useRef<THREE.Group>(null);

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
    const mount = riderMountRef.current;
    if (!mount || !clonedScene) return;
    mount.add(clonedScene);
    return () => {
      mount.remove(clonedScene);
    };
  }, [clonedScene]);

  useFrame((_, delta) => {
    const group      = groupRef.current;
    const glider     = gliderRef.current;
    const riderMount = riderMountRef.current;
    if (!group || !glider || !riderMount) return;

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
    // Render at (now - INTERP_DELAY_MS=200ms) — smooth 60fps motion from 10Hz snapshots.
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

    // ─── Apply interpolated XZ transform to groupRef ──────────────────────────
    // BUG FIX (Bug 1): position now comes from interpolated history, not raw entity.
    // BUG FIX (Bug 2): rotation now comes from entity.rot, not atan2(vx,vy).
    // Y elevation is now carried by gliderRef in local space (KART_Y_ABOVE_TRACK /
    // KART_SCALE = 0.25 local units). group.position.y stays 0.
    group.position.x = interpX;
    group.position.y = 0;
    group.position.z = interpZ;
    group.rotation.y = interpRot;

    // ─── Bank tilt on gliderRef (Phase 1 §4) ─────────────────────────────────
    // Bank uses velocity direction relative to current facing. Because facing is
    // now server-authoritative (entity.rot), delta between velocity angle and
    // group.rotation.y gives the correct lean amount without spazzing.
    // MOVES HERE from meshRootRef — now the BOARD tilts; the rider stays level.
    const velAngle = (interpVx !== 0 || interpVz !== 0)
      ? Math.atan2(interpVx, interpVz)
      : interpRot;
    // Wrap bank delta into (-π, π]
    let bankDelta = velAngle - group.rotation.y;
    bankDelta = ((bankDelta % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    glider.rotation.z = -bankDelta * 0.15;

    // ─── Rider stays level (Phase 1 §4) ──────────────────────────────────────
    // riderMountRef.rotation.z is explicitly kept at 0 — the rider does not lean
    // even as the board banks. This is the key visual distinction of the glider prop.
    riderMount.rotation.z = 0;

    // ─── Gentle bob on riderMountRef.position.y (Phase 1 §4) ─────────────────
    // ±BOB_AMP_LOCAL local units at BOB_FREQ_HZ — rider appears to float on board.
    // Accumulate per-avatarId bob time in module-scope scratch (no per-frame alloc).
    if (!_bobTime[entity.avatarId]) _bobTime[entity.avatarId] = 0;
    _bobTime[entity.avatarId] += dt;
    riderMount.position.y =
      RIDER_MOUNT_OFFSET_DEFAULT[1] +
      Math.sin(_bobTime[entity.avatarId] * BOB_FREQ_HZ * Math.PI * 2) * BOB_AMP_LOCAL;

    // ─── Procedural swimming animation ────────────────────────────────────────
    const speed = Math.sqrt(interpVx * interpVx + interpVz * interpVz);
    applySwimmingAnim(clonedScene, entity.avatarId, dt, speed);

    // Mark finished if finishedAt is set.
    if (entity.finishedAt && !finishedRef.current) {
      finishedRef.current = true;
    }
  });

  return (
    /*
     * Scene graph (Phase 1 §4):
     *   groupRef  — world XZ position + Y rotation (from server via interpolation)
     *     └── gliderRef  — local Y elevation (GLIDER_LOCAL_Y) + bank tilt (rotation.z)
     *           ├── gliderMesh  — shared BoxGeometry board (2.5×0.25×5 local)
     *           └── riderMountRef  — offset [0, 0.6, -0.5] + bob on Y; rotation.z=0
     *                 └── clonedScene  (avatar GLB, color-tinted)
     */
    <group ref={groupRef} scale={[KART_SCALE, KART_SCALE, KART_SCALE]}>
      <group ref={gliderRef} position={[0, GLIDER_LOCAL_Y, 0]}>
        {/* Glider board — shared geometry + material, no per-instance alloc */}
        <mesh geometry={_gliderGeom} material={_gliderMat} />
        {/* Rider mount — offset so avatar sits on board; rotation.z pinned 0 */}
        <group
          ref={riderMountRef}
          position={RIDER_MOUNT_OFFSET_DEFAULT}
        />
      </group>
    </group>
  );
}

export default function ReefRacePlayer(props: ReefRacePlayerProps) {
  return <ReefRacePlayerInner {...props} />;
}
