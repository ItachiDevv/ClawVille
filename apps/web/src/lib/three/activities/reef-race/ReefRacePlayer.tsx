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
 *   - KART_Y_ABOVE_TRACK elevation moves from group.position.y (race-layer local) to
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

import { useRef, useEffect, useMemo, useCallback, Suspense } from 'react';
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
  CLIENT_SURF_PARAMS,
  CLIENT_SURF_MAX_DT,
  CLIENT_SURF_TICK_DT,
  CLIENT_SURF_MAX_ACCUM,
  CLIENT_REBASE_POS,
  CLIENT_REBASE_VEL,
  CLIENT_REBASE_ROT,
  CLIENT_REBASE_SNAP_DIST,
  SURF_RIDE_HEIGHT,
  SURF_PITCH_TRIM_DEG,
  SURF_PITCH_WAVE_GAIN,
  SURF_PITCH_HALF_LEN,
  SURF_ROLL_HALF_WIDTH,
  SURF_PITCH_CLAMP,
  SURF_ROLL_CLAMP,
} from './reef-race-config';

/** Degrees→radians for the surf nose-up trim. */
const SURF_DEG2RAD = 0.0174532925;
import {
  integrateSurfStep,
  type SurfBodyState,
} from '@clawville/shared';
import { selfInputBus, selfPoseBus, resetSelfPoseBus } from './reef-race-self-bus';
import { tAtXZ, bankedDatumYAtT, forgetTKey } from './reef-race-elevation';
import { surfWaveHeightAt } from './reef-wave-height';

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
import {
  useVRMInstance,
  disposeVRMInstance,
  preloadVRMBytes,
} from '@/lib/three/vrm-loader';
import {
  VRMCharacterAnimator,
  preloadClips,
  preloadMixamoClips,
} from '@/lib/three/vrm-character-animator';
import {
  MODEL_REGISTRY,
  type ModelRegistryEntry,
} from '@/lib/three/agent-model-registry';
import { computeVRMAvatarFit } from '@/lib/three/vrm-avatar-sizing';
import { useActivityStore } from '@/stores/activity';
import { triggerBurst } from '@/lib/three/activities/shared/activity-particles';

// ─── Preloads — fire at module scope ─────────────────────────────────────────
useGLTF.preload('/models/sea_horse.glb');
useGLTF.preload('/models/lobster.glb');
useGLTF.preload('/models/crayfish.glb');  // SPEC 1 — 3rd species, static mesh
// v2 spline path surfboard — plain .clone() (no skeleton, static mesh).
// Asset: surfboard_1.glb, 3 220 tris, 660 KB, CC-BY 4.0 (see ATTRIBUTIONS.md).
useGLTF.preload('/models/reef-race/surfboards/surfboard_1.glb');
// Registry-driven rider router (2026-07-10) — these GLB creature species are now
// reachable via MODEL_REGISTRY (previously all rendered as lobster.glb). Not
// covered by the global tier-2 preload manifest (asset-preload-manifest.ts),
// so warm them here to avoid a Suspense-cascade stutter mid-race.
// lobster_plush.glb is already globally preloaded (shared with the "Larry" NPC) —
// no duplicate call needed.
useGLTF.preload('/models/sweet_crab_sketchfabweekly.glb');
useGLTF.preload('/models/hermitcrab.glb');
useGLTF.preload('/models/jellyfish.glb');
useGLTF.preload('/models/octopus_toy.glb');

// SPEC 2 — Milady VRM preloads.
// preloadMixamoClips() warms the raw Mixamo GLB cache (idle/walk/run only).
// preloadClips() warms the specific Reef Race surf clips that ReefRacePlayer
// fires via playOneShot ('wipeout' on crash, 'victory' on finish). Without
// this they'd network-fetch lazily on the click, adding ~150 ms RTT.
// Surf_idle is set via setSurfaceClip() at init — its load races the avatar
// fetch and is rarely user-visible, but we warm it for symmetry.
// preloadVRMBytes() warms the ArrayBuffer fetch cache for all 8 official VRMs.
// Both are fire-and-forget — errors surface later when useVRMInstance() resolves.
preloadMixamoClips();
preloadClips(['surf_idle', 'wipeout', 'victory']);
for (let _n = 1; _n <= 8; _n++) {
  preloadVRMBytes(`/avatars/milady-official-${_n}.vrm`);
}
// Registry-driven rider router (2026-07-10) — Hermes/Tekk/chibi VRMs are already
// globally preloaded (asset-preload-manifest.ts tier-2); the Meshy/Hatcher bespoke
// avatars (Phanes/Cronus/Helen/Clytemnestra/Adinero) are NOT, and are now reachable
// as reef riders via the generalized registry router. Warm them here.
for (const _meshyVrmPath of [
  '/avatars/phanes.vrm?v=2',
  '/avatars/cronus.vrm?v=2',
  '/avatars/helen.vrm?v=2',
  '/avatars/clytemnestra.vrm?v=2',
  '/avatars/adinero.vrm?v=1',
]) {
  preloadVRMBytes(_meshyVrmPath);
}

// ─── SPEC 2: Milady VRM helpers ───────────────────────────────────────────────

/**
 * Lay an arbitrarily-authored board FLAT + nose-forward: map its longest local axis →
 * world +Z (forward) and its thinnest → +Y (up). The surfboard_1.glb is authored STANDING
 * VERTICAL (longest extent along local Y), so without this the v2 board renders upright.
 * Verified flat in the free-drive sandbox (same helper). Robust to the GLB's authored frame.
 */
function surfboardBaseQuat(size: THREE.Vector3): THREE.Quaternion {
  const dims = [size.x, size.y, size.z];
  const longI = dims.indexOf(Math.max(dims[0], dims[1], dims[2]));
  const thinI = dims.indexOf(Math.min(dims[0], dims[1], dims[2]));
  const midI = 3 - longI - thinI;
  const world: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  world[longI].set(0, 0, 1);  // longest → forward
  world[thinI].set(0, 1, 0);  // thinnest → up
  world[midI].set(1, 0, 0);   // remaining → right
  const m = new THREE.Matrix4().makeBasis(world[0], world[1], world[2]);
  if (m.determinant() < 0) { world[midI].multiplyScalar(-1); m.makeBasis(world[0], world[1], world[2]); }
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/** Uniform scale (gliderRef-local) for the orientation-corrected surfboard so its longest
 *  (now forward) extent ≈ GLIDER_LENGTH. GLB longest ≈ 2.0 local → ×2.5 ≈ 5.0. */
const SURFBOARD_UNIFORM_SCALE = 2.5;

/**
 * Registry-driven rider router (2026-07-10 generalization).
 *
 * Was: `isMiladySpecies()` hard-gated ONLY `milady_official_N` species into the
 * VRM rider branch; everything else (hermes_female/male, tekk, chibis, all 8
 * Hatcher placeholders, the 4 Meshy Hatcher avatars, adinero, AND every non-
 * lobster/crayfish/sea_horse GLB creature — sweet_crab/lobster_plush/hermitcrab/
 * jellyfish/octopus) fell through a GLB `switch` that defaulted to lobster.glb
 * with zero humanoid animation.
 *
 * Now: look the species up in MODEL_REGISTRY (the same single source of truth
 * the /create-agent picker and every other avatar render site uses).
 * `avatar_type: 'vrm'` → the VRM rider branch below, using the registry's own
 * `path` (preserves ?v=N cache-bust queries) and `animatorId` directly — no
 * reverse path→animatorId lookup needed, we already have the full entry.
 * `avatar_type: 'glb'` → mount the REAL creature mesh (glbPath resolution
 * below), not a lobster placeholder. Unrecognized species (not in the
 * registry AND not one of the two legacy special-cased GLB paths below) keep
 * the pre-existing lobster.glb fallback, logged once.
 */
function resolveRegistryEntry(species: string): ModelRegistryEntry | undefined {
  return (MODEL_REGISTRY as Record<string, ModelRegistryEntry>)[species];
}

/**
 * Maximum squared position delta (world units²) achievable in one 20Hz
 * snapshot interval via normal physics. REEF_MAX_SPEED ≈ 1650wu/s × 0.05s
 * = 82.5wu/tick max. 500wu is 6× above that — uniquely identifies a respawn
 * teleport without false positives from normal high-speed straight-line movement.
 */
const WIPEOUT_TELEPORT_THRESHOLD_SQ = 500 * 500;

/** Per-avatarId last known XZ (for wipeout teleport detection). Module scope,
 * no per-frame allocations. Cleaned up on component unmount. */
const _lastXZ: Record<string, { x: number; z: number }> = {};

/** Deduplicated warn set — log each unique unrecognized species key only once. */
const _warnedUnknownSpeciesKeys = new Set<string>();

/**
 * Consistent WORLD-space rider height (world units) applied to EVERY VRM
 * species on the surfboard — deliberately NOT each avatar's own world-player
 * height (SPECIES_TARGET_HEIGHT_WU ranges 135–320wu across chibi/Milady/
 * Hermes/Tekk/Phanes). Racers read better lined up at one board-relative
 * scale than at their proportional world height.
 *
 * Value derivation (2026-07-10 registry-router generalization — CORRECTED
 * after a Codex review caught the first pass): `112` is a flat LOCAL SCALE
 * FACTOR the shipped Milady-only path applied directly to `vrmScene.scale`
 * (`VRM_RIDER_LOCAL_SCALE=5.6` × `KART_SCALE=20`), NOT a target height in
 * world units — the actual old rendered height was
 * `nativeBboxHeight_meters × 112`, which varies per VRM. Measured
 * `milady-official-1/2/8.vrm`'s native bbox height via a real
 * GLTFLoader+VRMLoaderPlugin parse (script:
 * `apps/web/scratch-measure-vrm.mjs`, run 2026-07-10, deleted after use) —
 * all three read 2.1930964433095035 (VRoid meters, feet at local Y≈0,
 * min.y=0.0031 confirms). Old world height = 2.1930964433095035 × 112 =
 * 245.6268016506644wu. Rounded to 245.63 and passed as
 * computeVRMAvatarFit's targetHeightOverride so every species — not just
 * Milady — auto-fits to this SAME height, with feet correctly grounded via
 * the returned offsetY (Milady/VRoid rigs have offsetY≈0 already, so this
 * preserves Milady's exact prior visual height; Mixamo-rig VRMs — Hermes/
 * Tekk/chibi/Meshy — previously had NO grounding at all since they never
 * reached this branch, and now correctly ground via fit.offsetY).
 */
const REEF_VRM_RIDER_TARGET_HEIGHT_WU = 245.63;

/**
 * Rider-mount-LOCAL (not world) bbox-height target for GLB creature riders
 * (lobster/crayfish/sweet_crab/lobster_plush/hermitcrab/jellyfish/octopus/
 * sea_horse). These assets were authored at wildly inconsistent native
 * scales — some calibrated only for the /create-agent picker's camera
 * framing (agent-model-registry.ts `scale: 10`), several export raw
 * quantized int16 units in the tens of thousands (verified via
 * gltf-transform 2026-07-10: sweet_crab/lobster_plush/hermitcrab/crayfish
 * all measure > 10,000 local units on their longest axis). A fixed scale
 * constant per species would be fragile and asset-dependent; auto-fitting
 * each creature's OWN measured bbox height to this LOCAL target — same
 * technique as computeVRMAvatarFit for VRMs — makes every creature ride the
 * board at a consistent, non-floating/non-oversized size regardless of its
 * native units.
 *
 * Value chosen to match lobster.glb's own native bbox height (1.1201 local
 * units, verified via gltf-transform 2026-07-10) so the pre-existing
 * shipped lobster rider is visually unchanged (fit scale factor ≈ 0.98,
 * imperceptible).
 */
const GLB_RIDER_TARGET_HEIGHT_LOCAL = 1.1;

/**
 * Per-avatarId GLB rider grounding offset (rider-mount-LOCAL units),
 * computed once when `clonedScene` is built (auto-fit bbox measurement).
 * `applySwimmingAnim`'s per-frame `position.y` write (STATIC/unrigged
 * creatures only — `applyTransformSwim` returns early for rigged meshes)
 * needs this as its `baseY`; without it, that write resets `position.y`
 * back to ~0 every frame, undoing the auto-fit grounding. Rigged creatures
 * (sea_horse/sweet_crab/hermitcrab) never hit that write path, so their
 * one-time `clonedScene.position.y` assignment persists untouched.
 * Module scope, no per-frame allocation. Cleaned up on unmount alongside
 * `_lastXZ`.
 */
const _glbRiderBaseY: Record<string, number> = {};

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
/** Per-avatarId previous height (for landing squash detection). */
const _prevHeight: Record<string, number> = {};
/** Per-avatarId squash progress (0 = at rest, >0 = squashing, decrements each frame). */
const _squashTime: Record<string, number> = {};

/** Nose-up pitch when airborne (radians). ~8°. */
const JUMP_NOSE_UP_RAD = 0.14;
/** Extended nose-up pitch after a ramp launch (radians). ~16°. 2× JUMP_NOSE_UP_RAD. */
const RAMP_NOSE_UP_RAD = 0.28;
/** How long the extended ramp tilt holds (seconds). */
const RAMP_TILT_HOLD_S = 0.35;
/** Per-avatarId ramp-launch hold timer (seconds remaining). Module scope, no per-frame alloc. */
const _rampLaunchHold: Record<string, number> = {};
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
 * `baseY` is the GLB rider auto-fit grounding offset (see
 * `_glbRiderBaseY`/`GLB_RIDER_TARGET_HEIGHT_LOCAL`) — clonedScene is parented
 * to riderMountRef whose OWN position.y is already driven by the bob loop
 * above, so this is the resting Y clonedScene itself oscillates around
 * (previously hardcoded 0, which was correct only for lobster.glb's
 * near-zero native offset — every other GLB creature needs its own fitted
 * offset here or it renders floating/sunk).
 *
 * The bone-path below (traverse + isBone) still handles rigged species correctly
 * because applyTransformSwim returns early when hasBones=true, leaving the
 * scene's rotation/position untouched for the traverse to work on.
 */
function applySwimmingAnim(scene: THREE.Object3D, avatarId: string, delta: number, speed: number, baseY: number): void {
  // Transform-only path for static meshes (lobster.glb, crayfish.glb, etc.).
  // Returns early internally when bones are present, so rigged meshes pass through.
  applyTransformSwim(scene, avatarId, delta, speed, baseY);

  // Bone-based undulation for rigged species (sea_horse.glb, future rigged GLBs).
  // applyTransformSwim's hasBones=true guard ensures transform is NOT also applied.
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

// ─── SPEC 2: VRM rider inner component ────────────────────────────────────────
// Separate from ReefRacePlayerInner so a Suspense boundary can wrap it;
// useVRMInstance() throws a Promise on first load (Suspense protocol).

interface ReefRaceVRMRiderProps {
  vrmPath: string;
  /** From the resolved MODEL_REGISTRY entry — every VRM entry defines one. */
  animatorId: string | undefined;
  avatarId: string;
  riderMountRef: React.RefObject<THREE.Group>;
  onAnimatorReady: (animator: VRMCharacterAnimator) => void;
}

function ReefRaceVRMRiderInner({
  vrmPath,
  animatorId,
  avatarId,
  riderMountRef,
  onAnimatorReady,
}: ReefRaceVRMRiderProps) {
  const vrm = useVRMInstance(vrmPath, `reef-race-${avatarId}`);

  // Dispose on unmount — must match the instanceId used above.
  useEffect(() => {
    return () => { disposeVRMInstance(vrmPath, `reef-race-${avatarId}`); };
  }, [vrmPath, avatarId]);

  const vrmAnimatorRef = useRef<VRMCharacterAnimator | null>(null);

  // Initialise animator once we have the VRM.
  useEffect(() => {
    if (!vrm) return;
    // animatorId comes straight from the resolved MODEL_REGISTRY entry (the
    // caller already has it — no reverse path→animatorId lookup needed) so
    // surf_idle/wipeout/victory use per-character Mixamo bakes when available
    // (Hermes/Tekk/chibi/Meshy each have their own; Miladies share
    // 'vrm-milady'). No per-character surf_idle override exists today
    // (character-anim-overrides.json), so every animatorId retargets the same
    // global skateboarding.glb via its own bone-name/rest-pose differential —
    // the same retarget pipeline already proven for idle/walk/run.
    const animator = new VRMCharacterAnimator(vrm, animatorId);
    vrmAnimatorRef.current = animator;
    animator.init('surf_idle').then(() => {
      // setSurfaceClip AFTER init so surf_idle retarget is cached in this.actions;
      // post-one-shot crossfades will correctly return to surf_idle (not idle).
      animator.setSurfaceClip('surf_idle');
      onAnimatorReady(animator);
    }).catch((err: unknown) => {
      console.warn('[ReefRaceVRMRider] animator.init failed:', err);
    });
    return () => {
      vrmAnimatorRef.current = null;
      animator.dispose();
    };
  }, [vrm, animatorId, onAnimatorReady]);

  // Attach VRM scene to riderMountRef imperatively.
  useEffect(() => {
    const mount = riderMountRef.current;
    const vrmScene = vrm?.scene;
    if (!mount || !vrmScene) return;
    // frustumCulled=false — skinned mesh bind-pose bbox culls animated poses.
    // Consistent with pattern in vrm-loader.ts normaliseVRM() + gotcha memo.
    vrmScene.traverse((o) => { o.frustumCulled = false; });
    // Registry-driven rider router (2026-07-10): auto-fit EVERY VRM species
    // (not just Milady) to a consistent WORLD height via computeVRMAvatarFit,
    // then convert its WORLD scale/offset down to riderMountRef-LOCAL space
    // (the parent groupRef already applies KART_SCALE=20, so dividing by it
    // here is what makes the compounded scale land on
    // REEF_VRM_RIDER_TARGET_HEIGHT_WU world units tall). This also grounds
    // Mixamo-rig VRMs (Hermes/Tekk/chibi/Meshy — hips at local Y=0, feet
    // below) via fit.offsetY; Milady/VRoid rigs have offsetY≈0 already, so
    // this is a no-visual-regression swap for the previously-shipped path.
    const fit = computeVRMAvatarFit(vrm, animatorId, REEF_VRM_RIDER_TARGET_HEIGHT_WU);
    vrmScene.scale.setScalar(fit.scale / KART_SCALE);
    vrmScene.position.set(0, fit.offsetY / KART_SCALE, 0);
    mount.add(vrmScene);
    return () => { mount.remove(vrmScene); };
  }, [vrm, animatorId, riderMountRef]);

  // Tick the mixer + spring bones every frame.
  // surf context: isMoving=false always (rider stays in surf_idle base).
  useFrame((_, delta) => {
    const animator = vrmAnimatorRef.current;
    if (!animator) return;
    animator.update(Math.min(delta, 0.1), false);
  });

  return null; // imperative scene graph — no JSX output
}

// ─── Player inner component ───────────────────────────────────────────────────

interface ReefRacePlayerProps {
  entity: ReefRaceEntity;
  isSelf?: boolean;
  /** Called on ramp launch for the self player — triggers camera screen shake. */
  triggerScreenShake?: (intensity: number) => void;
}

function ReefRacePlayerInner({ entity, isSelf = false, triggerScreenShake }: ReefRacePlayerProps) {
  // Registry-driven rider router (2026-07-10) — derive from entity.species
  // (modelKey from avatars.model_key, injected by activity store on
  // snapshot.init via reefParticipantMeta) by looking it up in MODEL_REGISTRY,
  // the same single source of truth every other avatar render site uses.
  // Falls back to lobster.glb if species is absent or unrecognised.
  //
  // `avatar_type: 'vrm'` → render via useVRMInstance in ReefRaceVRMRiderInner
  // (Suspense boundary), using the registry's own path (preserves ?v=N
  // cache-bust queries) + animatorId. The GLB path falls back to lobster.glb
  // sentinel in that case, but effectiveSrcScene is set to null so GLB
  // rendering is suppressed while VRM renders.
  // `avatar_type: 'glb'` → mount the registry's real creature mesh.
  //
  // NOTE: pre-existing spelling gap — MODEL_REGISTRY uses key 'seahorse' (no
  // underscore, already resolves correctly via the registry lookup below);
  // SeaCreatureSpecies type / some DB rows use 'sea_horse' (underscore) —
  // NOT in the registry, so it still needs the legacy switch fallback below.
  // 'crayfish' was removed from MODEL_REGISTRY entirely (still ships as an
  // asset — see the top-of-file preload comment) so it ALSO needs the legacy
  // switch fallback. Reconcile when seahorse gets a full animator rig.
  const speciesStr = (entity as ReefRaceEntity & { species?: string }).species;
  const speciesKey = speciesStr ?? 'lobster';
  const regEntry = resolveRegistryEntry(speciesKey);
  const isVRM = regEntry?.avatar_type === 'vrm';
  const vrmPath = isVRM ? regEntry!.path : null;
  const vrmAnimatorId = isVRM ? regEntry?.animatorId : undefined;

  // Determine GLB path. For VRM species use lobster as the sentinel so the
  // useGLTF hook is always called (Rules of Hooks).
  const glbPath = (() => {
    if (isVRM) return '/models/lobster.glb'; // sentinel — not rendered when isVRM
    if (regEntry && regEntry.avatar_type === 'glb') return regEntry.path;
    switch (speciesKey) {
      case 'crayfish':  return '/models/crayfish.glb';
      case 'seahorse':
      case 'sea_horse': return '/models/sea_horse.glb';
      default:
        // Unknown species — not in the registry, not a legacy special case.
        // Log once, render lobster.
        if (!_warnedUnknownSpeciesKeys.has(speciesKey)) {
          _warnedUnknownSpeciesKeys.add(speciesKey);
          console.warn(
            `[ReefRacePlayer] unknown species="${speciesKey}" — rendering lobster.glb as fallback`,
          );
        }
        return '/models/lobster.glb';
    }
  })();

  // Always call useGLTF (Rules of Hooks). When isVRM=true, srcScene is a
  // lobster sentinel that is never mounted (effectiveSrcScene = null).
  const { scene: srcScene } = useGLTF(glbPath);
  // Gate all GLB clone/mount logic on this. Null when VRM branch is active.
  const effectiveSrcScene = isVRM ? null : srcScene;

  // v2: surfboard GLB — always call the hook (rules of hooks); use result only
  // when USE_SPLINE_PLAYER. Plain .clone() — no skeleton, static mesh.
  const { scene: surfboardSrc } = useGLTF('/models/reef-race/surfboards/surfboard_1.glb');

  const groupRef      = useRef<THREE.Group>(null);
  const gliderRef     = useRef<THREE.Group>(null);
  const riderMountRef = useRef<THREE.Group>(null);

  // SPEC 2 — VRM animator ref. Set by onVrmAnimatorReady callback once
  // ReefRaceVRMRiderInner's init() resolves. Used for wipeout/victory one-shots.
  const vrmAnimatorRef = useRef<VRMCharacterAnimator | null>(null);
  const onVrmAnimatorReady = useCallback((animator: VRMCharacterAnimator) => {
    vrmAnimatorRef.current = animator;
  }, []);

  // Fade state for finish (not elimination — racers don't vanish on finish).
  const finishedRef = useRef(false);

  // ─── Interpolation state ────────────────────────────────────────────────────
  // Ring buffer of received snapshots.
  const historyRef = useRef<SnapRecord[]>([]);
  // Identity compare to detect new snapshot (store builds new object per delta).
  const lastEntityRef = useRef<ReefRaceEntity | null>(null);
  // Last interpolated rotation — fallback when rot=0 + no velocity (initial spawn).
  const lastRotRef = useRef(0);

  // ─── v2 self-kart client prediction state ─────────────────────────────────
  // Only used when (USE_SPLINE_PLAYER && isSelf). predictedRef holds the locally
  // integrated surf state ({x,z,vx,vz,rot}); it is initialised from the first
  // server snapshot, advanced each frame by integrateSurfStep against the
  // self-input bus, and re-baselined toward authority on every new snapshot.
  const predictedRef = useRef<SurfBodyState>({ x: 0, z: 0, vx: 0, vz: 0, rot: 0 });
  const predictInitRef = useRef(false);
  // Fixed-timestep accumulator (s). Render frames are ~60 fps with variable dt,
  // but integrateSurfStep's drag/grip multipliers assume the server's fixed
  // 30 Hz tick — so we accumulate frame time and drain it in CLIENT_SURF_TICK_DT
  // steps, advancing prediction at exactly the server rate.
  const predictAccumRef = useRef(0);
  // True for THIS instance for the lifetime of the component when it's the self
  // kart on the spline path — gates all prediction work + pose-bus writes.
  const predictsSelf = USE_SPLINE_PLAYER && isSelf;

  const clonedScene = useMemo(() => {
    // When isVRM=true, effectiveSrcScene=null — return null so the GLB mount
    // useEffect no-ops and the VRM rider branch handles the scene graph instead.
    if (!effectiveSrcScene) return null;
    const c = skeletonClone(effectiveSrcScene);
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

    // GLB rider auto-fit (scale + grounding) is applied in the mount useEffect
    // below, NOT here — useMemo must stay a pure render-phase function (Codex
    // review 2026-07-10 caught the original version mutating a module-scope
    // cache mid-render, which React can legally discard/replay). Cloning +
    // tinting is a pure transform of the input GLB, safe to memoize.
    return c;
  }, [effectiveSrcScene, entity.color]);

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
    // Orient FLAT: the GLB is authored standing vertical, so a non-uniform scale left it
    // upright. Recenter, then rotate longest→forward(+Z) / thinnest→up(+Y) via the verified
    // base quat inside a wrapper group + a uniform scale. (Was sb.scale.set(2.5,1,5) which
    // kept the longest extent on Y = vertical board.)
    const box = new THREE.Box3().setFromObject(sb);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    sb.position.sub(center);
    const oriented = new THREE.Group();
    oriented.add(sb);
    // surfboardBaseQuat lays the board FLAT, but bounding-box sizing recovers WHICH axis is
    // long/thin — not its SIGN. For surfboard_1.glb the authored long/thin axes point
    // nose-back + deck-down: the /preview/reef-race-v2?mode=racer harness measured
    // normalDotDeckUp = longDotDeckForward = -1 (perfectly flat, but flipped 180° about the
    // lateral axis). Correct with a 180° pre-rotation about the deck-right (gliderRef ±X)
    // axis so the deck faces UP + nose points FORWARD. (180° about ±X is the same rotation,
    // so the det-flip sign of the width axis is irrelevant.)
    const _flipLateral = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    oriented.quaternion.copy(_flipLateral).multiply(surfboardBaseQuat(size));
    oriented.scale.setScalar(SURFBOARD_UNIFORM_SCALE);
    return oriented;
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
    // clonedScene is null when isVRM=true (effectiveSrcScene=null guard in useMemo).
    // In that case the VRM rider manages its own scene graph; this effect is a no-op.
    if (!mount || !clonedScene) return;

    // GLB rider auto-fit (registry-driven rider router, 2026-07-10): normalize
    // this creature's bbox height to GLB_RIDER_TARGET_HEIGHT_LOCAL so species
    // whose native mesh scale wasn't authored for this context (see the
    // constant's doc comment — several export raw quantized units in the
    // tens of thousands) don't float above / sink through / dwarf the board.
    // Runs HERE (effect, not the useMemo above) — a Codex review caught the
    // original version mutating state during render, which is unsafe.
    // updateMatrixWorld(true) FIRST, then skeleton.update() — Skeleton.update()
    // reads existing matrixWorld values, it does not recompute them, so a
    // freshly-cloned hierarchy needs its world matrices current before bone
    // matrices are derived (mirrors computeVRMAvatarFit's exact ordering,
    // fixed here after an initial version had the calls swapped).
    clonedScene.updateMatrixWorld(true);
    clonedScene.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.update();
    });
    const fitBox = new THREE.Box3().setFromObject(clonedScene);
    const fitSize = new THREE.Vector3();
    fitBox.getSize(fitSize);
    const fitScale = fitSize.y > 1e-4 ? GLB_RIDER_TARGET_HEIGHT_LOCAL / fitSize.y : 1;
    clonedScene.scale.setScalar(fitScale);
    const groundOffsetY = -fitBox.min.y * fitScale;
    clonedScene.position.y = groundOffsetY;
    // Stored for applySwimmingAnim's per-frame baseY (static/unrigged creatures
    // only — rigged creatures never hit that write path, so this assignment
    // above already persists for them).
    _glbRiderBaseY[entity.avatarId] = groundOffsetY;

    mount.add(clonedScene);
    return () => {
      mount.remove(clonedScene);
      // Clear per-avatarId procedural state so a remounted clone starts at t=0
      // and re-probes for bones (important if species changes across mounts).
      resetTransformSwimState(entity.avatarId);
      // _lastXZ cleanup is handled by the dedicated useEffect below (covers VRM path too).
    };
  }, [clonedScene, entity.avatarId]);

  // Dedicated cleanup for _lastXZ: runs for BOTH GLB and VRM paths.
  // The clonedScene effect above has an early-return guard (`if (!mount || !clonedScene)`)
  // so VRM riders (clonedScene=null) never reach the delete there, leaking a stale
  // XZ entry across unmount/remount and triggering a spurious wipeout on rejoin.
  useEffect(() => {
    return () => {
      delete _lastXZ[entity.avatarId];
      // Registry-driven rider router (2026-07-10): drop the GLB rider
      // grounding-offset cache alongside _lastXZ so it doesn't accrete dead
      // avatarIds across remounts (mirrors the forgetTKey cleanup below).
      delete _glbRiderBaseY[entity.avatarId];
      // SURF ROAD: drop the per-kart elevation XZ→t cache key so the Map in
      // reef-race-elevation doesn't accrete dead avatarIds across remounts.
      forgetTKey(entity.avatarId);
    };
  }, [entity.avatarId]);

  // v2 self prediction — invalidate the pose bus on self-player teardown so the
  // chase camera reverts to its own server-interp behaviour (room exit, WS
  // reconnect remount). Also resets the per-instance prediction-init flag so a
  // remount re-seeds predicted state from the first fresh snapshot.
  useEffect(() => {
    if (!predictsSelf) return;
    return () => {
      predictInitRef.current = false;
      predictAccumRef.current = 0;
      resetSelfPoseBus();
    };
  }, [predictsSelf]);

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
        if (clonedScene) mount.remove(clonedScene);
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
        if (clonedScene) mount.add(clonedScene);
      }
      handle?.dispose();
      animatorRef.current = null;
    };
  }, [wantsAnimator, speciesKey, entity.color, clonedScene]);

  // ─── SPEC 3: ramp-launch event subscription ──────────────────────────────────
  // Subscribe to the lastRampLaunchEvent slice. For ALL players: set _rampLaunchHold
  // so the extended 16° nose-up tilt applies in useFrame. For self player only:
  // trigger screen shake + particle burst.
  //
  // useActivityStore(selector) re-runs on every store change and is React-hook safe.
  // Using a ref-based event is intentional — the burst/shake are imperative calls
  // that produce NO React state updates (zero re-renders).
  const lastRampLaunchEvent = useActivityStore((s) => s.lastRampLaunchEvent);
  const lastSeenRampRef = useRef<{ avatarId: string; at: number } | null>(null);

  useEffect(() => {
    if (!lastRampLaunchEvent) return;
    // Deduplicate: skip if we already processed this same event (same at + avatarId).
    const prev = lastSeenRampRef.current;
    if (prev && prev.avatarId === lastRampLaunchEvent.avatarId && prev.at === lastRampLaunchEvent.at) return;
    // Only react when this event is for our avatarId.
    if (lastRampLaunchEvent.avatarId !== entity.avatarId) return;

    lastSeenRampRef.current = { avatarId: lastRampLaunchEvent.avatarId, at: lastRampLaunchEvent.at };

    // Extended nose-up tilt for ALL instances of this avatarId.
    _rampLaunchHold[entity.avatarId] = RAMP_TILT_HOLD_S;

    // Self-player-only: screen shake + burst.
    if (isSelf) {
      triggerScreenShake?.(0.12);
      // Compute world position from current entity snapshot.
      // entity.x / entity.y are the latest received sim-space coords (not interpolated),
      // which is close enough for burst placement (visual only, < 1 frame stale).
      // entity.height is the heightOffset broadcast in SplineBodySnap — may be
      // undefined on older snapshots; default to 0 (water surface).
      const height = (entity as ReefRaceEntity & { height?: number }).height ?? 0;
      triggerBurst(
        new THREE.Vector3(entity.x, height, entity.y),
        '#ff9944', // warm orange burst — matches ramp color (#c9884a)
        100,
      );
    }
  }, [lastRampLaunchEvent, entity.avatarId, isSelf, triggerScreenShake]);
  // NOTE: entity.x / entity.y / entity.height are intentionally NOT deps —
  // they change every snapshot and we only want to fire once per ramp event.

  // ─── v2 mechanics: boost-pad hit event subscription ──────────────────────────
  // Mirrors the ramp-launch block above exactly. Fired for ANY avatar (WORLD↔
  // BACKEND parity — a boost pad the sim actually triggered on renders a burst
  // for every visible rider, not just self). No screen shake here (brief:
  // "burst/streak on hit" only) — the HUD toast (self-only) lives in
  // reef-race-event-toasts.tsx and reads the same store field independently.
  const lastBoostPadEvent = useActivityStore((s) => s.lastBoostPadEvent);
  const lastSeenBoostPadRef = useRef<{ avatarId: string; at: number } | null>(null);

  useEffect(() => {
    if (!lastBoostPadEvent) return;
    const prev = lastSeenBoostPadRef.current;
    if (prev && prev.avatarId === lastBoostPadEvent.avatarId && prev.at === lastBoostPadEvent.at) return;
    if (lastBoostPadEvent.avatarId !== entity.avatarId) return;

    lastSeenBoostPadRef.current = { avatarId: lastBoostPadEvent.avatarId, at: lastBoostPadEvent.at };

    const height = (entity as ReefRaceEntity & { height?: number }).height ?? 0;
    triggerBurst(
      new THREE.Vector3(entity.x, height, entity.y),
      '#00e5ff', // cyan — matches the boost-pad marker color
      110,
    );
  }, [lastBoostPadEvent, entity.avatarId]);

  // ─── v2 mechanics: mini-turbo release event subscription ─────────────────────
  // Same fan-out as ramp-launch: burst for ANY avatar, self additionally gets
  // screen shake (brief: "release burst + screen shake for self"). Tier 2
  // (big) gets a stronger shake + a distinct color from tier 1 (small).
  const lastMiniTurboFireEvent = useActivityStore((s) => s.lastMiniTurboFireEvent);
  const lastSeenMiniTurboRef = useRef<{ avatarId: string; at: number } | null>(null);

  useEffect(() => {
    if (!lastMiniTurboFireEvent) return;
    const prev = lastSeenMiniTurboRef.current;
    if (prev && prev.avatarId === lastMiniTurboFireEvent.avatarId && prev.at === lastMiniTurboFireEvent.at) return;
    if (lastMiniTurboFireEvent.avatarId !== entity.avatarId) return;

    lastSeenMiniTurboRef.current = { avatarId: lastMiniTurboFireEvent.avatarId, at: lastMiniTurboFireEvent.at };

    const height = (entity as ReefRaceEntity & { height?: number }).height ?? 0;
    const isTier2 = lastMiniTurboFireEvent.level === 2;
    triggerBurst(
      new THREE.Vector3(entity.x, height, entity.y),
      isTier2 ? '#ff5e2b' : '#5ce1ff', // tier 2 = hot orange, tier 1 = cyan
      isTier2 ? 140 : 100,
    );

    if (isSelf) {
      triggerScreenShake?.(isTier2 ? 0.16 : 0.08);
    }
  }, [lastMiniTurboFireEvent, entity.avatarId, isSelf, triggerScreenShake]);
  // The burst position is "good enough" at the moment the event lands.

  useFrame((state, delta) => {
    const group      = groupRef.current;
    const glider     = gliderRef.current;
    const riderMount = riderMountRef.current;
    if (!group || !glider || !riderMount) return;
    // Wave time — SAME clock the water shader's uTime uses, so the kart rides the
    // surface in phase with the rendered waves.
    const surfTime = state.clock.elapsedTime;

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

      // ─── v2 self prediction — re-baseline toward authority ──────────────────
      // Runs once per NEW server snapshot. Pulls the locally-predicted state
      // toward the server pose so wall-clamp on the tight corridor, kart
      // collisions, and any boost the client couldn't predict are corrected
      // within a few snapshots. Big errors (respawn / teleport) hard-snap.
      if (predictsSelf) {
        const pred = predictedRef.current;
        // Server pose in prediction space (sim x → x, sim y → z).
        const sx = entity.x;
        const sz = entity.y;
        const svx = entity.vx;
        const svz = entity.vy;
        // Server rot, with the same spawn-frame fallback the snapshot used.
        const srot = isNaN(snap.rot) ? pred.rot : snap.rot;

        if (!predictInitRef.current) {
          // First snapshot — initialise predicted state directly from authority.
          pred.x = sx;
          pred.z = sz;
          pred.vx = svx;
          pred.vz = svz;
          pred.rot = srot;
          predictInitRef.current = true;
          // Fresh seed — drop any accumulated fixed-step time.
          predictAccumRef.current = 0;
        } else {
          const dx = sx - pred.x;
          const dz = sz - pred.z;
          const errDist = Math.hypot(dx, dz);
          if (errDist > CLIENT_REBASE_SNAP_DIST) {
            // Respawn / teleport / catastrophic desync — snap, don't slide.
            pred.x = sx;
            pred.z = sz;
            pred.vx = svx;
            pred.vz = svz;
            pred.rot = srot;
            // Teleport — discard stale accumulated time so we don't replay
            // pre-snap motion against the new pose.
            predictAccumRef.current = 0;
          } else {
            // Blend predicted toward authority. Position slower (smoothness),
            // velocity + heading faster (responsiveness to server corrections).
            pred.x += dx * CLIENT_REBASE_POS;
            pred.z += dz * CLIENT_REBASE_POS;
            pred.vx += (svx - pred.vx) * CLIENT_REBASE_VEL;
            pred.vz += (svz - pred.vz) * CLIENT_REBASE_VEL;
            pred.rot = lerpAngle(pred.rot, srot, CLIENT_REBASE_ROT);
          }
        }
      }

      // SPEC 2 — Wipeout detection (VRM only).
      // Server doesn't surface respawnAt to the client yet (see §C.2 in the plan).
      // Heuristic: detect XZ teleport > 500wu in one snapshot interval — this is
      // only achievable by a respawn teleport, not normal physics.
      // Fires once per new snapshot, inside this guard, not per frame.
      if (isVRM && vrmAnimatorRef.current) {
        const prev = _lastXZ[entity.avatarId];
        if (prev) {
          const dx = entity.x - prev.x;
          const dz = entity.y - prev.z; // entity.y = sim-Y = Three.js Z
          const distSq = dx * dx + dz * dz;
          if (distSq > WIPEOUT_TELEPORT_THRESHOLD_SQ) {
            void vrmAnimatorRef.current.playOneShot('wipeout');
          }
        }
        _lastXZ[entity.avatarId] = { x: entity.x, z: entity.y };
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

    // Y elevation: v2 spline path reads entity.height (race-layer local jump
    // height, default 0 = track surface). v1 ellipse path stays at y=0.
    const entityHeight = (entity as ReefRaceEntity & { height?: number }).height ?? 0;

    // ─── v2 self prediction — fixed-timestep integrate + override interp pose ─
    // Only the self kart on the spline path. Reads the smoothed dir/thrust the
    // input loop just published (same intent the server integrates) and advances
    // the PURE shared surf model with a FIXED-TIMESTEP accumulator at the server
    // tick rate (CLIENT_SURF_TICK_DT = 1/30) — NOT once per variable render
    // frame. integrateSurfStep bakes drag/grip into per-call multipliers that
    // assume that tick, so each step MUST pass CLIENT_SURF_TICK_DT (never the
    // frame dt) or carving fidelity is corrupted. The sub-tick remainder (≤33ms)
    // is left in the accumulator for next frame — no extrapolation (avoids
    // jitter). Renders from the latest predicted state; the bank-tilt velocity
    // also comes from prediction so the lean matches the rendered heading.
    // Remote karts + v1 path are untouched.
    if (predictsSelf && predictInitRef.current) {
      const pred = predictedRef.current;
      const dirInput = selfInputBus.valid ? selfInputBus.dir : null;
      const thrustInput = selfInputBus.valid ? selfInputBus.thrust : 0;
      const airborne = entityHeight > 0;

      // Clamp the FRAME dt first (spiral-of-death guard after a tab-out), then
      // accumulate, then cap the accumulator so a long stall can't run dozens
      // of steps in one frame.
      const frameDt = dt > CLIENT_SURF_MAX_DT ? CLIENT_SURF_MAX_DT : dt;
      predictAccumRef.current += frameDt;
      if (predictAccumRef.current > CLIENT_SURF_MAX_ACCUM) {
        predictAccumRef.current = CLIENT_SURF_MAX_ACCUM;
      }

      while (predictAccumRef.current >= CLIENT_SURF_TICK_DT) {
        const next = integrateSurfStep(
          pred,
          { dir: dirInput, thrust: thrustInput, airborne },
          CLIENT_SURF_PARAMS,
          CLIENT_SURF_TICK_DT, // fixed step — NOT the frame dt
        );
        pred.x = next.x;
        pred.z = next.z;
        pred.vx = next.vx;
        pred.vz = next.vz;
        pred.rot = next.rot;
        predictAccumRef.current -= CLIENT_SURF_TICK_DT;
      }

      interpX = pred.x;
      interpZ = pred.z;
      interpRot = pred.rot;
      interpVx = pred.vx;
      interpVz = pred.vz;
      lastRotRef.current = interpRot;

      // Publish the rendered predicted pose for the chase camera (one timebase).
      selfPoseBus.x = pred.x;
      selfPoseBus.z = pred.z;
      selfPoseBus.rot = pred.rot;
      selfPoseBus.valid = true;
      selfPoseBus.updatedAt = performance.now();
    }

    // ─── Apply interpolated/predicted XZ transform to groupRef ────────────────
    // BUG FIX (Bug 1): position from interpolated history (or prediction for self).
    // BUG FIX (Bug 2): rotation from entity.rot (or prediction for self), not atan2.
    // Glider local-Y elevation (KART_Y_ABOVE_TRACK / KART_SCALE) is additive on
    // top of group.position.y via gliderRef.position.y.
    //
    // SURF ROAD (2026-06-23): the kart rides the FLOATING ribbon. Its Y is the
    // render-only ribbon elevation at its XZ (reefTrackElevationAt at the
    // closest spline-t, cheaply cached per avatarId via tAtXZ) PLUS the sim's
    // per-body airborne heightOffset (entity.height). The SAME elevation
    // function feeds the chase camera + the ribbon geometry — one vertical datum
    // (the parity contract). The kart also ROLLS into banked turns by
    // reefTrackBankAngleAt(t) so a banked turn reads as banked for ribbon +
    // rider + camera together. v1 ellipse path is untouched (stays flat at y=0).
    group.position.x = interpX;
    group.position.z = interpZ;
    if (USE_SPLINE_PLAYER) {
      const tHere = tAtXZ(interpX, interpZ, entity.avatarId);
      // SURF RIDE (baked from the founder-signed-off sandbox 2026-06-27): the kart
      // sits ON the BANKED + WAVE water surface (not the flat centerline datum, which
      // floated it above the low side of banked turns + ignored the swell). Y =
      // banked-datum + Gerstner wave heave + a small ride-height, plus the sim's
      // airborne heightOffset. Same datum the water shader renders (phase-locked).
      group.position.y =
        bankedDatumYAtT(interpX, interpZ, tHere) +
        surfWaveHeightAt(interpX, interpZ, surfTime) +
        SURF_RIDE_HEIGHT + entityHeight;

      // SURF TILT — pitch (nose-up trim + wave fore-aft slope) + roll (CONFORM to the
      // surface's lateral slope so the board lies flat on the banked/waved water).
      // Mirrors the sandbox surfTilt; signs verified there against the rendered mesh.
      const fX = Math.sin(interpRot), fZ = Math.cos(interpRot);   // forward
      const rX = Math.cos(interpRot), rZ = -Math.sin(interpRot);  // right
      const hNose = surfWaveHeightAt(interpX + fX * SURF_PITCH_HALF_LEN, interpZ + fZ * SURF_PITCH_HALF_LEN, surfTime);
      const hTail = surfWaveHeightAt(interpX - fX * SURF_PITCH_HALF_LEN, interpZ - fZ * SURF_PITCH_HALF_LEN, surfTime);
      let surfPitch = -Math.atan2(hNose - hTail, 2 * SURF_PITCH_HALF_LEN) * SURF_PITCH_WAVE_GAIN - SURF_PITCH_TRIM_DEG * SURF_DEG2RAD;
      if (surfPitch < -SURF_PITCH_CLAMP) surfPitch = -SURF_PITCH_CLAMP; else if (surfPitch > SURF_PITCH_CLAMP) surfPitch = SURF_PITCH_CLAMP;
      const rxR = interpX + rX * SURF_ROLL_HALF_WIDTH, rzR = interpZ + rZ * SURF_ROLL_HALF_WIDTH;
      const rxL = interpX - rX * SURF_ROLL_HALF_WIDTH, rzL = interpZ - rZ * SURF_ROLL_HALF_WIDTH;
      const sR = bankedDatumYAtT(rxR, rzR, tHere) + surfWaveHeightAt(rxR, rzR, surfTime);
      const sL = bankedDatumYAtT(rxL, rzL, tHere) + surfWaveHeightAt(rxL, rzL, surfTime);
      let surfRoll = Math.atan2(sR - sL, 2 * SURF_ROLL_HALF_WIDTH);   // conform: lie flat on the lateral slope
      if (surfRoll < -SURF_ROLL_CLAMP) surfRoll = -SURF_ROLL_CLAMP; else if (surfRoll > SURF_ROLL_CLAMP) surfRoll = SURF_ROLL_CLAMP;
      // YXZ order (yaw → pitch → roll) to MATCH the sandbox pivot the signs were
      // verified against. The glider child adds the airborne jump nose-up (rotation.x)
      // + a small velocity bank (rotation.z) on top.
      group.rotation.order = 'YXZ';
      group.rotation.set(surfPitch, interpRot, surfRoll);
    } else {
      group.position.y = 0;
      group.rotation.y = interpRot;
    }

    // ─── Jump nose-up tilt (v2 only) ─────────────────────────────────────────
    // When airborne (height > 0): pitch glider nose up by ~8°.
    // On landing (height was > 0, now 0): trigger squash animation.
    if (USE_SPLINE_PLAYER) {
      const prevH = _prevHeight[entity.avatarId] ?? 0;
      const isAirborne = entityHeight > 0;

      if (!isAirborne && prevH > 0) {
        // Just landed — start squash.
        _squashTime[entity.avatarId] = SQUASH_DURATION;
      }
      _prevHeight[entity.avatarId] = entityHeight;

      // Apply nose-up pitch on glider when airborne.
      // Ramp launches hold extended 16° tilt for RAMP_TILT_HOLD_S seconds.
      const rampHold = _rampLaunchHold[entity.avatarId] ?? 0;
      let noseAngle: number;
      if (rampHold > 0) {
        noseAngle = RAMP_NOSE_UP_RAD;
        _rampLaunchHold[entity.avatarId] = Math.max(0, rampHold - dt);
      } else {
        noseAngle = isAirborne ? JUMP_NOSE_UP_RAD : 0;
      }
      glider.rotation.x = -noseAngle;

      // Squash animation on landing (xz expand, y compress) decays over time.
      const sq = _squashTime[entity.avatarId] ?? 0;
      if (sq > 0) {
        _squashTime[entity.avatarId] = Math.max(0, sq - dt);
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
    // Accumulate per-avatarId bob time in module-scope scratch (no per-frame alloc).
    if (!_bobTime[entity.avatarId]) _bobTime[entity.avatarId] = 0;
    _bobTime[entity.avatarId] += dt;
    riderMount.position.y =
      RIDER_MOUNT_OFFSET_DEFAULT[1] +
      Math.sin(_bobTime[entity.avatarId] * BOB_FREQ_HZ * Math.PI * 2) * BOB_AMP_LOCAL;

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
      // Guard: clonedScene is null when isVRM=true (effectiveSrcScene=null).
      if (clonedScene) {
        applySwimmingAnim(clonedScene, entity.avatarId, dt, speed, _glbRiderBaseY[entity.avatarId] ?? 0);
      }
    }

    // Mark finished if finishedAt is set.
    if (entity.finishedAt && !finishedRef.current) {
      finishedRef.current = true;
      // SPEC 2 — VRM victory one-shot on finish line crossing.
      if (isVRM && vrmAnimatorRef.current) {
        void vrmAnimatorRef.current.playOneShot('victory');
      }
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
      {/*
       * Registry-driven VRM rider (Suspense boundary) — EVERY VRM species in
       * MODEL_REGISTRY, not just Milady (2026-07-10 generalization).
       * ReefRaceVRMRiderInner throws a Promise on first load (Suspense protocol).
       * fallback={null} means no placeholder is rendered while loading —
       * the board still shows, the rider appears once the VRM parses (~30-80ms).
       * Only mounted when isVRM=true so GLB species see zero overhead from this.
       */}
      {isVRM && vrmPath && (
        <Suspense fallback={null}>
          <ReefRaceVRMRiderInner
            vrmPath={vrmPath}
            animatorId={vrmAnimatorId}
            avatarId={entity.avatarId}
            riderMountRef={riderMountRef as React.RefObject<THREE.Group>}
            onAnimatorReady={onVrmAnimatorReady}
          />
        </Suspense>
      )}
    </group>
  );
}

export default function ReefRacePlayer(props: ReefRacePlayerProps) {
  return <ReefRacePlayerInner {...props} />;
}
