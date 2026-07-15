'use client';

/**
 * BumperShellsPlayer.tsx
 *
 * REBUILT 2026-04-24 — Player shell with full perspective-camera VFX pipeline.
 *
 * Per-player features:
 *   - Three.js GLB clone (lobster / crayfish) with LobsterAnimator locomotion
 *   - drei <Html> name label above shell (camera-cull gated; NO drei Text — Iris Xe crash)
 *   - Squash/stretch on hit (meshRootRef scale; orthogonal to bone rotations)
 *   - Elimination: death anim fires immediately, gravity drop starts in parallel
 *     (lobster tips over while falling — visually reads as "limp tumble off disc")
 *   - Combat animations: triggerCombatAction('attack'|'hurt'|'death') called
 *     imperatively by BumperShellsScene's HitEventProcessor via a module-scope Map.
 *   - Self-hit flash: fires onSelfHit callback so BumperShellsScene flashes DOM overlay
 *   - PR #51 position interpolation fully preserved (15Hz → 60fps lerp)
 *
 * Bug fixes vs prior build (2026-04-24):
 *   - Bug 1: Facing now comes from entity.rot (server-authoritative, only updates
 *     on player input direction). Velocity-derived facing caused snap-spazzing on
 *     every knockback impulse. Velocity is kept only for locomotion speed classification.
 *   - Bug 2: Combat animations wired. triggerCombatAction() calls
 *     animatorRef.current?.startAction(). LobsterAnimator.actionDone gates return
 *     to idle/walk naturally after ACTION_DURATIONS[state] expires.
 *   - Bug 3: Death anim starts at elimination alongside the gravity drop (parallel).
 *     The lobster tips sideways (body.rotation.z → π/2) while falling off disc —
 *     reads as a "limp tumble" which is visually better than instant drop.
 *
 * Iris Xe invariants:
 *   - SkeletonUtils.clone() + frustumCulled=false traverse immediately after clone.
 *   - Squash/stretch applied to ROOT GROUP (meshRootRef) not SkinnedMesh bones.
 *   - NO drei Text/Billboard — Iris Xe hard GPU crash.
 *   - drei <Html> with anchorInFrontOfCamera dot-product cull.
 *   - No per-frame allocations — module-scope scratch primitives only.
 *   - import from 'three' (plain), NOT 'three/webgpu'.
 *
 * Draw calls: 1 per player (lobster-ktx.glb = 1 SkinnedMesh draw call).
 *
 * External API (imperative handles attached to group):
 *   group.triggerHit?.()               — squash/stretch VFX
 *   group.triggerCombatAction?.(action) — 'attack' | 'hurt' | 'death' animator state
 *
 * Both are registered by BumperShellsScene's HitEventProcessor via the
 * PLAYER_GROUP_MAP module-scope Map<avatarId, THREE.Group>.
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html, useGLTF } from '@react-three/drei';
// PERF FIX 2026-04-24: 'three' not 'three/webgpu' — two THREE instances = GPU context loss
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LobsterAnimator } from '@/lib/three/lobster-animations';
import type { AnimState } from '@/lib/three/lobster-animations';
import { discoverLobsterParts } from '@/lib/three/lobster-parts';
import { anchorInFrontOfCamera } from '@/lib/three/utils/camera-cull';
import type { BumperShellEntity, ShellHitAnimState } from './bumper-shells-types';
import {
  SHELL_SCALE,
  HIT_ANIM_FRAMES,
  LABEL_Y_OFFSET,
  DROP_GRAVITY,
  DROP_FADE_DURATION,
} from './bumper-shells-config';
import {
  createSeaCreatureAnimator,
  type SeaCreatureAnimatorHandle,
} from '@/lib/three/sea-creature-animator';
import { SEA_CREATURE_MANIFEST } from '@/lib/three/sea-creature-manifest';
import type {
  SeaCreatureSpecies,
  SeaCreatureAnimState,
} from '@/lib/three/sea-creature-types';
import { applyTransformSwim, resetTransformSwimState } from '@/lib/three/sea-creature-swim';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { preloadKTX2Bytes, useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';

// ─── Preloads — fire at module scope so GLBs are warm before a round starts ──
preloadKTX2Bytes('/models/lobster-ktx.glb?v=2');
preloadKTX2Bytes('/models/crayfish-ktx.glb?v=2');

// ─── Module-scope player group registry ──────────────────────────────────────
// BumperShellsScene's HitEventProcessor uses this to call triggerCombatAction
// imperatively without React props or re-renders.
// Map is intentionally at module scope so it lives for the lifetime of the
// JS module — no per-render allocation.
export const PLAYER_GROUP_MAP = new Map<
  string,
  THREE.Group & { triggerHit?: () => void; triggerCombatAction?: (action: CombatAction) => void }
>();

export type CombatAction = 'attack' | 'hurt' | 'death';

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

// ─── Lobster facing note ──────────────────────────────────────────────────────
// lobster-ktx.glb faces +Z at rotation.y=0.
// BUG FIX (Bug 1): facing now comes from entity.rot (server-authoritative).
// entity.rot is set server-side as atan2(intent.dir.x, intent.dir.y) only when
// the player provides input — it does NOT update on knockback impulses.
// This eliminates the snap-spazzing caused by velocity-derived facing.
// Velocity magnitude is still used for the idle/walk locomotion classifier.

// ─── Per-snapshot record ─────────────────────────────────────────────────────

interface SnapRecord {
  /** performance.now() timestamp when this snapshot was received (ms). */
  t: number;
  x: number;
  z: number; // sim-space y → Three.js z
  /**
   * Facing angle in radians — directly from entity.rot (server-authoritative).
   * NaN only when entity.rot is exactly 0 AND velocity is also zero (initial
   * spawn frame before any input) — fall back to last rendered rotation.
   */
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

// ─── Module-scope anchor temp (shared by all player instances) ───────────────
// anchorInFrontOfCamera uses its own module-scope temporaries — safe.
const _anchorPos = new THREE.Vector3();

interface BumperShellsPlayerProps {
  entity: BumperShellEntity;
  /** True if this is the local player — triggers self-hit flash via callback. */
  isSelf?: boolean;
  /** Called when this shell gets hit AND isSelf=true — parent adds screen flash. */
  onSelfHit?: () => void;
  /** Player display name — rendered as HTML label above shell. */
  displayName?: string;
}

function BumperShellsPlayerInner({
  entity,
  isSelf = false,
  onSelfHit,
  displayName,
}: BumperShellsPlayerProps) {
  const species = entity.species ?? 'lobster';
  const glbPath = species === 'crayfish' ? '/models/crayfish-ktx.glb?v=2' : '/models/lobster-ktx.glb?v=2';

  const { scene: srcScene } = useGLTFWithKTX2(glbPath);

  const { camera } = useThree();

  const groupRef    = useRef<THREE.Group>(null);
  const meshRootRef = useRef<THREE.Group>(null);
  const labelRef    = useRef<HTMLDivElement>(null);

  // Hit animation state — managed via ref (no React re-render needed).
  const hitAnim = useRef<ShellHitAnimState>({ active: false, elapsed: 0 });

  // Elimination drop state
  const dropRef = useRef({ active: false, elapsed: 0, velocityY: 0 });

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
  // Last interpolated rotation — used when rot is zero + velocity is zero (initial spawn).
  const lastRotRef = useRef(0);

  // Clone the GLB once per entity/species change.
  const clonedScene = useMemo(() => {
    const c = skeletonClone(srcScene);
    makeObject3DWebGPUSafe(c);
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
      // Reset procedural swim state so a remounted clone re-probes bones at t=0.
      resetTransformSwimState(entity.avatarId);
    };
  }, [clonedScene, entity.avatarId]);

  // ─── Sea-creature animator (hot-swap when manifest enables this species) ───
  // Same pattern as ReefRacePlayer. While manifest hasRig=false (default), the
  // existing LobsterAnimator + procedural bone discovery path runs unchanged.
  // When manifest is enabled, the animator's scene REPLACES clonedScene and
  // LobsterAnimator's per-frame call is skipped.
  //
  // Caveat: Bumper Shells has combat states (attack / hurt / death) that the
  // sea-creature pipeline doesn't surface yet. Once manifest is enabled they
  // map onto 'hit' (attack/hurt) and 'wipeout' (death) — but only if the
  // corresponding clip GLBs are shipped. Combat states with no clip silently
  // fall through swim → idle per the animator's fallback chain.
  //
  // FEATURE_GATE: sea_creature_animator (bumper-shells)
  // Status: scaffolded; dormant until manifest hasRig=true.
  // Metric to graduate: rigged base.glb + ≥1 animation clip exists for any
  //   species AND visual review confirms motion matches arena combat feel.
  // Current reading: 0 species enabled (all hasRig=false in manifest).
  // Review deadline: 2026-05-26
  // On deadline: if no GLBs shipped, DELETE this block + the import.
  // Reference: tweet copyrebeldia 2026-04-26 — Meshy/Tripo auto-rig pipeline.
  const seaCreatureAnimRef = useRef<SeaCreatureAnimatorHandle | null>(null);
  const speciesKey: SeaCreatureSpecies =
    ((entity as BumperShellEntity & { species?: string }).species as SeaCreatureSpecies | undefined) ?? 'lobster';
  const wantsSeaCreatureAnim = SEA_CREATURE_MANIFEST[speciesKey]?.hasRig ?? false;

  useEffect(() => {
    if (!wantsSeaCreatureAnim) return;
    let cancelled = false;
    let handle: SeaCreatureAnimatorHandle | null = null;

    createSeaCreatureAnimator(speciesKey, 'idle').then((h) => {
      if (cancelled || !h) {
        h?.dispose();
        return;
      }
      handle = h;
      seaCreatureAnimRef.current = h;
      const root = meshRootRef.current;
      if (root) {
        root.remove(clonedScene);
        root.add(h.scene);
      }
    });

    return () => {
      cancelled = true;
      const root = meshRootRef.current;
      if (handle && root) {
        root.remove(handle.scene);
        root.add(clonedScene);
      }
      handle?.dispose();
      seaCreatureAnimRef.current = null;
    };
  }, [wantsSeaCreatureAnim, speciesKey, clonedScene]);

  // Track previous alive state to trigger fade on elimination.
  const wasAlive = useRef(true);

  // ─── Register in module-scope PLAYER_GROUP_MAP ───────────────────────────
  // Must run after groupRef is populated (after first render).
  // Uses useEffect (not useLayoutEffect) — Map registration is not frame-timing
  // critical; BumperShellsScene reads the Map in useFrame at ≥1 frame latency.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const avatarId = entity.avatarId;

    // Attach imperative handles to the group object (same pattern as triggerHit).
    (group as THREE.Group & { triggerHit?: () => void; triggerCombatAction?: (action: CombatAction) => void }).triggerHit = () => {
      hitAnim.current = { active: true, elapsed: 0 };
    };

    (group as THREE.Group & { triggerCombatAction?: (action: CombatAction) => void }).triggerCombatAction = (action: CombatAction) => {
      // Sea-creature animator path (manifest-enabled): map combat → state and
      // setState() — the LoopOnce + 'finished' handler in sea-creature-animator
      // auto-reverts to the prior locomotion state when the clip ends.
      const seaAnim = seaCreatureAnimRef.current;
      if (seaAnim) {
        const mapped: SeaCreatureAnimState = action === 'death' ? 'wipeout' : 'hit';
        seaAnim.setState(mapped);
        return;
      }
      // BUG FIX (Bug 2): wire combat states to animator.
      // startAction() is a no-op if the same state is already playing + !actionDone.
      // For 'death': also handled by the elimination path in useFrame; calling it
      // here from the external event lets the anim fire even if entity.alive hasn't
      // updated yet (event arrives on the same tick as the alive=false delta).
      animatorRef.current?.startAction(action as AnimState, elapsedRef.current);
    };

    PLAYER_GROUP_MAP.set(avatarId, group as any);

    return () => {
      PLAYER_GROUP_MAP.delete(avatarId);
    };
  }, [entity.avatarId]); // re-run if avatarId ever changes (shouldn't, but safe)

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

      // BUG FIX (Bug 1): use entity.rot (server-authoritative, only changes on
      // player input direction — NOT updated by knockback impulses).
      // Fallback to last rendered rotation only when rot is 0 AND velocity is also
      // zero (initial spawn frame; server initializes rot=0 at spawn so we can't
      // distinguish "facing +Z" from "not yet moved"). Once the player provides
      // any input direction, entity.rot is trusted unconditionally.
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

      // BUG FIX (Bug 1): lerp entity.rot angles, skip NaN (zero-velocity spawn) frames.
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
    // BUG FIX (Bug 1): velocity magnitude is still used for idle/walk classification —
    // only facing (rotation) was moved to entity.rot. No change here.
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

    const seaCreatureAnim = seaCreatureAnimRef.current;
    if (seaCreatureAnim) {
      // Manifest-enabled path: AnimationMixer drives the rigged GLB.
      // Locomotion-only here — combat actions (attack/hurt/death) come
      // through the imperative `triggerCombatAction` group handle below
      // and call setState('hit'|'wipeout') directly. Don't override an
      // active one-shot (hit / wipeout / victory) — let it finish before
      // the locomotion derivation reasserts.
      seaCreatureAnim.tick(dt);
      const cur = seaCreatureAnim.getState();
      if (cur === 'idle' || cur === 'swim') {
        const desiredLocomotion: SeaCreatureAnimState =
          suggestedState === 'walk' ? 'swim' : 'idle';
        if (cur !== desiredLocomotion) {
          seaCreatureAnim.setState(desiredLocomotion);
        }
      }
    } else {
      const animator = animatorRef.current;
      if (animator) {
        animator.update(dt, elapsed, suggestedState, direction);
      }
      // Transform-only swim for static meshes (lobster-ktx.glb / crayfish-ktx.glb — 0 bones).
      // applyTransformSwim internally probes for bones on first call (cached) and
      // skips itself when hasBones=true, so rigged species (if added later) are safe.
      // baseY=0: clonedScene's position.y is 0 relative to meshRoot; bob oscillates around 0.
      // LobsterAnimator modifies bone rotations on child meshes — orthogonal to
      // clonedScene.rotation.x/z and clonedScene.position.y (the transform targets).
      applyTransformSwim(clonedScene, entity.avatarId, dt, _speedScratch.speed, 0);
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

    // ─── Elimination: death anim + gravity drop in parallel ──────────────────
    // BUG FIX (Bug 3): death anim and gravity drop are parallel (Option B).
    // The death anim tips body.rotation.z → π/2 (limp sideways) while the
    // group falls via DROP_GRAVITY. Visually: "tips over while tumbling off the disc."
    // This is orthogonal — body.rotation.z is in clonedScene's child space
    // (animator's domain), group.position.y is in world space (our domain).
    if (wasAlive.current && !entity.alive) {
      // Just eliminated — start both death anim + physics drop simultaneously.
      wasAlive.current = false;
      dropRef.current.active = true;
      dropRef.current.elapsed = 0;
      dropRef.current.velocityY = 0;
      fadeRef.current.active = true;
      fadeRef.current.opacity = 1;
      // Fire knockout sound + hide label immediately
      if (isSelf) onSelfHit?.();
      if (labelRef.current) labelRef.current.style.display = 'none';

      // Trigger death anim (joins any in-progress anim via startAction guard).
      animatorRef.current?.startAction('death', elapsed);
    }

    if (dropRef.current.active) {
      dropRef.current.elapsed += dt;
      dropRef.current.velocityY -= DROP_GRAVITY * dt;
      group.position.y += dropRef.current.velocityY * dt;
      if (dropRef.current.elapsed >= DROP_FADE_DURATION) {
        dropRef.current.active = false;
      }
    }

    if (fadeRef.current.active) {
      fadeRef.current.opacity = Math.max(
        0,
        fadeRef.current.opacity - dt / DROP_FADE_DURATION,
      );
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

    // ─── Name label: dot-product cull via anchorInFrontOfCamera ──────────────
    if (labelRef.current && entity.alive && group.visible) {
      _anchorPos.set(
        group.position.x,
        group.position.y + LABEL_Y_OFFSET,
        group.position.z,
      );
      const inFront = anchorInFrontOfCamera(_anchorPos, camera);
      const display = inFront ? 'flex' : 'none';
      if (labelRef.current.style.display !== display) {
        labelRef.current.style.display = display;
      }
    }

    // Show/hide based on alive state (after any fade completes).
    if (entity.alive && !wasAlive.current) {
      // Re-spawned (future: respawn support).
      wasAlive.current = true;
      group.visible = true;
      fadeRef.current.opacity = 1;
      dropRef.current.active = false;
    }
  });

  const labelText = displayName ?? entity.avatarId.slice(0, 8);

  return (
    // castShadow removed — shadow pipeline disabled in Canvas (no `shadows` prop)
    <group ref={groupRef} scale={[SHELL_SCALE, SHELL_SCALE, SHELL_SCALE]}>
      {/* meshRoot receives squash/stretch scale — separate from position group.
          bone mutations from animator + root scale compose cleanly. */}
      <group ref={meshRootRef} />

      {/* Name label — drei <Html> DOM portal, safe on Iris Xe.
          NO drei Text/Billboard — hard GPU crash on integrated graphics.
          Visibility controlled imperatively via labelRef in useFrame.
          NO distanceFactor — per-frame camera distance recompute (perf hit). */}
      <Html
        position={[0, LABEL_Y_OFFSET / SHELL_SCALE, 0]}
        center
        occlude={false}
        zIndexRange={[20, 100]}
        style={{ pointerEvents: 'none' }}
      >
        <div
          ref={labelRef}
          style={{
            display: 'none',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              color: isSelf ? '#00e5ff' : '#ffffff',
              fontSize: '11px',
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              fontWeight: isSelf ? 700 : 500,
              textShadow: '0 1px 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
              letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
              background: isSelf
                ? 'rgba(0,20,40,0.75)'
                : 'rgba(0,0,0,0.55)',
              padding: '2px 7px',
              borderRadius: 4,
              border: isSelf ? '1px solid rgba(0,229,255,0.5)' : 'none',
            }}
          >
            {labelText}
          </span>
        </div>
      </Html>
    </group>
  );
}

export default function BumperShellsPlayer(props: BumperShellsPlayerProps) {
  return (
    <BumperShellsPlayerInner {...props} />
  );
}
