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

// ─── v2 feature flag ──────────────────────────────────────────────────────────
const USE_SPLINE_PLAYER = process.env.NEXT_PUBLIC_REEF_RACE_USE_SPLINE === 'true';
import type { ReefRaceEntity } from './reef-race-types';
import {
  createSeaCreatureAnimator,
  type SeaCreatureAnimatorHandle,
} from '@/lib/three/sea-creature-animator';
import {
  SEA_CREATURE_MANIFEST,
} from '@/lib/three/sea-creature-manifest';
import type {
  SeaCreatureSpecies,
  SeaCreatureAnimState,
} from '@/lib/three/sea-creature-types';
import { applyTransformSwim, resetTransformSwimState } from '@/lib/three/sea-creature-swim';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';

// ─── Preloads — fire at module scope ─────────────────────────────────────────
useGLTF.preload('/models/sea_horse.glb');
useGLTF.preload('/models/lobster.glb');
useGLTF.preload('/models/crayfish.glb');  // SPEC 1 — 3rd species, static mesh
// v2 spline path surfboard — plain .clone() (no skeleton, static mesh).
// Asset: surfboard_1.glb, 3 220 tris, 660 KB, CC-BY 4.0 (see ATTRIBUTIONS.md).
useGLTF.preload('/models/reef-race/surfboards/surfboard_1.glb');

// ─── Shared glider geometry + material (v1, ONE instance for ALL players) ─────
// Never disposed — page-lifetime, shared across all ReefRacePlayer instances.
// v2 replaces this with surfboard_1.glb per-instance via plain .clone().
const _gliderGeom = new THREE.BoxGeometry(GLIDER_WIDTH, GLIDER_HEIGHT, GLIDER_LENGTH);
const _gliderMat  = new THREE.MeshStandardMaterial({
  color:     '#1e293b',
  roughness: 0.5,
  metalness: 0.4,
});

// ─── Jump / squash tracking (module scope, no per-frame alloc) ────────────────
/** Per-petId previous height (for landing squash detection). */
const _prevHeight: Record<string, number> = {};
/** Per-petId squash progress (0 = at rest, >0 = squashing, decrements each frame). */
const _squashTime: Record<string, number> = {};

/** Nose-up pitch when airborne (radians). ~8°. */
const JUMP_NOSE_UP_RAD = 0.14;
/** Duration of landing squash effect (seconds). */
const SQUASH_DURATION  = 0.18;
/** Squash factor at peak (scale Y multiplier — slightly compressed). */
const SQUASH_Y_MIN     = 0.7;
/** Squash factor at peak (scale XZ multiplier — slightly wider). */
const SQUASH_XZ_MAX    = 1.2;

// ─── Interpolation constants ──────────────────────────────────────────────────
/**
 * How far behind real-time we render (ms).
 *
 * Server REEF_SNAPSHOT_HZ progression: 5 → 10 (2026-04-26) → 20 (2026-04-28).
 * At 20 Hz each snap is 50 ms apart. Worst-case arrival gap = snap_interval
 * (50 ms) + jitter (~30-50 ms). INTERP_DELAY_MS must exceed that gap so
 * renderTime always falls BEFORE the newest history entry — otherwise the
 * bracket scan extrapolates and the body teleports when the next snap arrives.
 *
 *   target = 50 ms snap_interval + 30 ms jitter buffer + 20 ms safety = 100 ms
 *
 * Trade-off: 100 ms input lag (down from 200 ms). Halving the snapshot
 * interval again trims the linear-lerp piecewise seam from ~33° / bracket
 * to ~16° / bracket — well below kart-steering perceptual jerk threshold.
 *
 * Earlier values that failed:
 *   - 100 ms (initial) — assumed 15 Hz; server was 5 Hz; freeze for ~100 ms.
 *   - 250 ms — covered avg interval not jitter; user reported jumps.
 *   - 350 ms — covered jitter but each segment was 200 ms long, so a single
 *     delayed snap looked like "feet in one jump" when the next snap arrived
 *     and the bracket interp scrubbed 400 ms of motion in 1-2 render frames.
 *   - 200 ms (with 10 Hz snaps) — perceptually smoother than 350, but rotation
 *     seam at the 100ms bracket boundary still picked up by users on tight
 *     curves ("left-right movement still choppy"). Halved alongside snap rate.
 */
const INTERP_DELAY_MS = 100;

/**
 * Maximum snapshot history kept per entity.
 * 4 entries at 20 Hz covers 200 ms — well past the 100 ms INTERP_DELAY_MS.
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

/**
 * Apply swimming animation to the avatar scene.
 *
 * For RIGGED meshes (sea_horse.glb — 93 bone nodes): delegates to the bone-based
 * undulation path via applyTransformSwim's internal `hasBones` branch, which
 * returns early and lets the original bone traversal run via the scene.traverse below.
 *
 * For STATIC meshes (lobster.glb — 0 bones): applyTransformSwim does pure
 * rotation.x / rotation.z / position.y oscillation on the whole scene group —
 * producing visible swimming motion that was a complete no-op before this change.
 *
 * `baseY = 0` because clonedScene is parented to riderMountRef whose position.y
 * is already driven by the bob loop above; position.y on clonedScene itself
 * starts at 0 and we oscillate around that.
 *
 * The bone-path below (traverse + isBone) still handles rigged species correctly
 * because applyTransformSwim returns early when hasBones=true, leaving the
 * scene's rotation/position untouched for the traverse to work on.
 */
function applySwimmingAnim(scene: THREE.Object3D, petId: string, delta: number, speed: number): void {
  // Transform-only path for static meshes (lobster.glb, crayfish.glb, etc.).
  // Returns early internally when bones are present, so rigged meshes pass through.
  applyTransformSwim(scene, petId, delta, speed, 0);

  // Bone-based undulation for rigged species (sea_horse.glb, future rigged GLBs).
  // applyTransformSwim's hasBones=true guard ensures transform is NOT also applied.
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
  // SPEC 1 — derive GLB path from entity.species (modelKey from pets.model_key,
  // injected by activity store on snapshot.init via reefParticipantMeta).
  // Falls back to 'lobster' if species is absent or unrecognised (safe default).
  // VRM species (milady_official_*) are SPEC 2 — fall back to lobster with a warn.
  //
  // NOTE: pre-existing spelling gap — AGENT_MODELS registry uses key 'seahorse'
  // (no underscore); SeaCreatureSpecies type uses 'sea_horse' (underscore); DB
  // model_key column may store either. Both spellings are handled in the switch
  // below. Reconcile when seahorse gets a full animator rig (SPEC 2+).
  const speciesKey = (entity as ReefRaceEntity & { species?: string }).species ?? 'lobster';
  const glbPath = (() => {
    switch (speciesKey) {
      case 'crayfish':  return '/models/crayfish.glb';
      case 'seahorse':
      case 'sea_horse': return '/models/sea_horse.glb';
      default:
        // Milady VRM keys (milady_official_*) are SPEC 2. Log once, render lobster.
        if (speciesKey.startsWith('milady_official_')) {
          console.warn(
            `[ReefRacePlayer] species="${speciesKey}" is a VRM (SPEC 2) — rendering lobster.glb as fallback`,
          );
        }
        return '/models/lobster.glb';
    }
  })();

  const { scene: srcScene } = useGLTF(glbPath);

  // v2: surfboard GLB — always call the hook (rules of hooks); use result only
  // when USE_SPLINE_PLAYER. Plain .clone() — no skeleton, static mesh.
  const { scene: surfboardSrc } = useGLTF('/models/reef-race/surfboards/surfboard_1.glb');

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
    makeObject3DWebGPUSafe(c);
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

  // v2: clone surfboard scene per-instance. Plain .clone() because surfboard_1.glb
  // has no skeleton. Apply per-player color tint to the surfboard material so
  // each player's board matches their kart color.
  const clonedSurfboard = useMemo(() => {
    if (!USE_SPLINE_PLAYER) return null;
    const sb = surfboardSrc.clone();
    sb.traverse(o => { o.frustumCulled = false; });
    if (entity.color) {
      sb.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material;
        const applyTint = (m: THREE.Material) => {
          if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
            const cloned = (m as THREE.MeshStandardMaterial).clone();
            // Blend the player color at 50% intensity over the original material.
            // Full override would erase surfboard texture detail; 50% tints while
            // preserving shape. Done by lerping color toward player color.
            cloned.color.lerp(new THREE.Color(entity.color!), 0.5);
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
    // Scale: surfboard_1.glb is nominally 1m. In KART_SCALE local space, we
    // target roughly GLIDER_LENGTH (5) in Z and GLIDER_WIDTH (2.5) in X.
    // A scale of GLIDER_LENGTH fits the board footprint to the old BoxGeometry.
    sb.scale.set(GLIDER_WIDTH, GLIDER_HEIGHT * 4, GLIDER_LENGTH);
    return sb;
  }, [surfboardSrc, entity.color]);

  // v2: attach / detach surfboard clone to gliderRef.
  const gliderSceneRef = useRef<THREE.Object3D | null>(null);
  useEffect(() => {
    if (!USE_SPLINE_PLAYER || !clonedSurfboard || !gliderRef.current) return;
    gliderRef.current.add(clonedSurfboard);
    gliderSceneRef.current = clonedSurfboard;
    return () => {
      if (gliderRef.current) gliderRef.current.remove(clonedSurfboard);
      gliderSceneRef.current = null;
    };
  }, [clonedSurfboard]);

  useEffect(() => {
    const mount = riderMountRef.current;
    if (!mount || !clonedScene) return;
    mount.add(clonedScene);
    return () => {
      mount.remove(clonedScene);
      // Clear per-petId procedural state so a remounted clone starts at t=0
      // and re-probes for bones (important if species changes across mounts).
      resetTransformSwimState(entity.petId);
    };
  }, [clonedScene, entity.petId]);

  // ─── Sea-creature animator (hot-swap when manifest enables this species) ───
  // Manifest defaults to all-empty so this hook is a no-op until rigged GLBs
  // ship at /models/sea-creatures/<species>/{base.glb, animations/<state>.glb}
  // and the manifest is flipped to hasRig=true. While that's the case the
  // existing static `clonedScene` + procedural `applySwimmingAnim` keep running
  // unchanged. When manifest is enabled, the animator's scene REPLACES
  // clonedScene at the rider mount and the per-state animation plays.
  //
  // FEATURE_GATE: sea_creature_animator
  // Status: scaffolded import path; dormant until manifest hasRig=true.
  // Metric to graduate: rigged base.glb + ≥1 animation clip exists for any
  //   species AND visual review confirms motion matches the racing context.
  // Current reading: 0 species enabled (all hasRig=false in manifest).
  // Review deadline: 2026-05-26
  // On deadline: if no GLBs shipped, DELETE the animator import path and
  //   keep procedural-only. Don't extend without a Meshy export to point at.
  // Reference: tweet copyrebeldia 2026-04-26 — Meshy/Tripo auto-rig pipeline.
  const animatorRef = useRef<SeaCreatureAnimatorHandle | null>(null);
  // speciesKey is derived earlier (above useGLTF calls) for the glbPath dispatch.
  // Cast to SeaCreatureSpecies for the manifest lookup (unknown values produce
  // undefined from the manifest, which the hasRig ?? false guard handles safely).
  const wantsAnimator = SEA_CREATURE_MANIFEST[speciesKey as SeaCreatureSpecies]?.hasRig ?? false;

  useEffect(() => {
    if (!wantsAnimator) return;
    let cancelled = false;
    let handle: SeaCreatureAnimatorHandle | null = null;

    createSeaCreatureAnimator(speciesKey as SeaCreatureSpecies, 'idle').then((h) => {
      if (cancelled || !h) {
        h?.dispose();
        return;
      }
      handle = h;
      animatorRef.current = h;

      // Hot-swap: detach static fallback scene, attach animator scene.
      const mount = riderMountRef.current;
      if (mount) {
        mount.remove(clonedScene);
        // Re-apply the per-player color tint to the animator's freshly-cloned
        // scene (animator clones from its own cache and doesn't know about
        // entity.color).
        if (entity.color) {
          h.scene.traverse((o: THREE.Object3D) => {
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
        mount.add(h.scene);
      }
    });

    return () => {
      cancelled = true;
      const mount = riderMountRef.current;
      if (handle && mount) {
        mount.remove(handle.scene);
        // Restore static fallback in case the component re-mounts before
        // a fresh animator load completes (rare — race restart, navigation).
        mount.add(clonedScene);
      }
      handle?.dispose();
      animatorRef.current = null;
    };
  }, [wantsAnimator, speciesKey, entity.color, clonedScene]);

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
    // Y elevation: v2 spline path reads entity.height (world-space jump height,
    // default 0 = ground level). v1 ellipse path stays at y=0.
    // Glider local-Y elevation (KART_Y_ABOVE_TRACK / KART_SCALE) is additive on
    // top of group.position.y via gliderRef.position.y.
    const entityHeight = (entity as ReefRaceEntity & { height?: number }).height ?? 0;
    group.position.x = interpX;
    group.position.y = USE_SPLINE_PLAYER ? entityHeight : 0;
    group.position.z = interpZ;
    group.rotation.y = interpRot;

    // ─── Jump nose-up tilt (v2 only) ─────────────────────────────────────────
    // When airborne (height > 0): pitch glider nose up by ~8°.
    // On landing (height was > 0, now 0): trigger squash animation.
    if (USE_SPLINE_PLAYER) {
      const prevH = _prevHeight[entity.petId] ?? 0;
      const isAirborne = entityHeight > 0;

      if (!isAirborne && prevH > 0) {
        // Just landed — start squash.
        _squashTime[entity.petId] = SQUASH_DURATION;
      }
      _prevHeight[entity.petId] = entityHeight;

      // Apply nose-up pitch on glider when airborne.
      glider.rotation.x = isAirborne ? -JUMP_NOSE_UP_RAD : 0;

      // Squash animation on landing (xz expand, y compress) decays over time.
      const sq = _squashTime[entity.petId] ?? 0;
      if (sq > 0) {
        _squashTime[entity.petId] = Math.max(0, sq - dt);
        const progress = sq / SQUASH_DURATION; // 1→0
        // Peak squash at progress=1, return to normal at progress=0.
        const squashY  = 1 - (1 - SQUASH_Y_MIN)  * progress;
        const squashXZ = 1 + (SQUASH_XZ_MAX - 1) * progress;
        glider.scale.set(squashXZ, squashY, squashXZ);
      } else {
        glider.scale.set(1, 1, 1);
      }
    }

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
    // Accumulate per-petId bob time in module-scope scratch (no per-frame alloc).
    if (!_bobTime[entity.petId]) _bobTime[entity.petId] = 0;
    _bobTime[entity.petId] += dt;
    riderMount.position.y =
      RIDER_MOUNT_OFFSET_DEFAULT[1] +
      Math.sin(_bobTime[entity.petId] * BOB_FREQ_HZ * Math.PI * 2) * BOB_AMP_LOCAL;

    // ─── Animation: animator (when manifest enabled) OR procedural fallback ──
    const speed = Math.sqrt(interpVx * interpVx + interpVz * interpVz);
    const animator = animatorRef.current;
    if (animator) {
      // Drive the AnimationMixer + state machine. State derivation:
      //   finishedAt → victory   (one-shot, holds last frame)
      //   speed > 50 → swim      (loop)
      //   else        → idle     (loop)
      // Note: 'wipeout' (respawnAt) and 'hit' (knockback) are not derivable from
      // ReefRaceEntity yet — server doesn't surface respawnAt to the client.
      // Ship them in a follow-up after the wire-format adds the fields.
      animator.tick(dt);
      const desiredState: SeaCreatureAnimState = entity.finishedAt
        ? 'victory'
        : speed > 50
          ? 'swim'
          : 'idle';
      if (animator.getState() !== desiredState) {
        animator.setState(desiredState);
      }
    } else {
      // Fallback path — procedural per-bone undulation on the static GLB.
      // Currently a no-op for lobster.glb / crayfish.glb (0 bones) and a faint
      // wiggle on sea_horse.glb (93-node rig with bone names that match).
      applySwimmingAnim(clonedScene, entity.petId, dt, speed);
    }

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
        {/*
         * Glider board:
         *   v2 (USE_SPLINE_PLAYER=true): surfboard_1.glb clone, attached via
         *     useEffect into gliderRef (no JSX mesh needed — scene added imperatively).
         *   v1 (default): shared BoxGeometry + MeshStandardMaterial, 0 allocs.
         */}
        {!USE_SPLINE_PLAYER && (
          <mesh geometry={_gliderGeom} material={_gliderMat} />
        )}
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
