'use client';

/**
 * ReefRacePlayer.tsx
 *
 * REBUILT 2026-04-24 — Three bugs fixed (port from BumperShellsPlayer pattern):
 *
 *   Bug 1 — No interpolation: direct entity.x/y assignment on every frame
 *   produced positional jumps at 60fps render rate. The current path uses a
 *   preallocated 8-snapshot ring, one-time server-clock mapping, fixed 225ms
 *   remote delay, 500ms bounded remote extrapolation, and velocity-fed output
 *   correction. Self staging/wipeout snapshots retain 100ms/80ms delay/coverage.
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
 *   - riderMountRef planted on the board DECK (2026-07-15): X/Z from
 *     RIDER_MOUNT_OFFSET_DEFAULT (0 / -0.3), Y = static deck-top plane
 *     (SURFBOARD_DECK_TOP_LOCAL_Y ≈ 0.357 local v2 / GLIDER_HEIGHT/2 v1). The old
 *     [0, 1.2, -0.3] mount + gentle per-frame bob are REMOVED — board+rider are
 *     one rigid unit and per-rider grounding lands feet/body on the deck.
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
 *
 * GLB creature riders now sit STATIC + face the board nose (2026-07-12,
 * founder directive — "actual lobsters and crustaceans should just be
 * sitting on the board facing forwards"). The old procedural
 * `applySwimmingAnim` (Bug 3's bone-name traverse, described above, PLUS a
 * whole-scene rotation.x/z/position.y wiggle from `sea-creature-swim.ts`'s
 * `applyTransformSwim`) is REMOVED for reef riders entirely — not paused,
 * not conditionally stopped after one call. VRM humanoid riders are
 * UNCHANGED (still surf via `VRMCharacterAnimator`'s skate-retarget). See
 * `REEF_CREATURE_RIDER_FACE_YAW` below for the per-species facing
 * corrections. `sea-creature-swim.ts` itself is untouched — it still backs
 * BumperShellsPlayer + the avatar-preview free-swim context.
 */

import { useRef, useEffect, useMemo, useCallback, Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  preloadKTX2Bytes,
  useGLTFWithKTX2,
} from '@/lib/three/use-gltf-ktx2';
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
  CLIENT_REEF_JUMP_IMPULSE_MANUAL,
  CLIENT_REEF_JUMP_IMPULSE_RAMP,
  CLIENT_REEF_GRAVITY,
  CLIENT_REEF_TRICK_STEER_DEADZONE_RAD,
  CLIENT_REBASE_HEIGHT,
  CLIENT_REBASE_HEIGHT_SNAP,
  CLIENT_REBASE_POS,
  CLIENT_REBASE_VEL,
  CLIENT_REBASE_ROT,
  CLIENT_REBASE_SNAP_DIST,
  SURF_REBASE_RENDER_DAMPING,
  SURF_REBASE_RENDER_OFFSET_MAX,
  SURF_REBASE_HEIGHT_OFFSET_MAX,
  SURF_RIDE_HEIGHT,
  SURF_PITCH_TRIM_DEG,
  SURF_PITCH_WAVE_GAIN,
  SURF_PITCH_HALF_LEN,
  SURF_ROLL_HALF_WIDTH,
  SURF_PITCH_CLAMP,
  SURF_ROLL_CLAMP,
  SURF_CONFORM_PLANING_START_SPEED,
  SURF_CONFORM_PLANING_FULL_SPEED,
  SURF_HEAVE_DAMPING,
  SURF_TILT_DAMPING_LOW_SPEED,
  SURF_TILT_DAMPING_HIGH_SPEED,
  SURF_BANK_LEAN_DAMPING,
  buildSplineBoostPadsClient,
} from './reef-race-config';

/** Degrees→radians for the surf nose-up trim. */
const SURF_DEG2RAD = 0.0174532925;
import {
  computeReefBoostPadKick,
  integrateSurfStep,
  type SurfBodyState,
  type SurfParams,
} from '@clawville/shared';
import { selfInputBus, selfPoseBus, resetSelfPoseBus } from './reef-race-self-bus';
import { tAtXZ, bankedDatumYAtT, forgetTKey } from './reef-race-elevation';
import { clientSpline } from './reef-race-spline-instance';
import { surfConformHeightAt } from './reef-wave-height';

// ─── v2 feature flag ──────────────────────────────────────────────────────────
const USE_SPLINE_PLAYER = process.env.NEXT_PUBLIC_REEF_RACE_USE_SPLINE === 'true';
import type { ReefRaceEntity } from './reef-race-types';
import {
  createSeaCreatureAnimator,
  type SeaCreatureAnimatorHandle,
} from '@/lib/three/sea-creature-animator';
// NOTE (2026-07-12): SEA_CREATURE_MANIFEST is deliberately NOT imported here —
// Reef Race hardcodes `wantsAnimator = false` (see the block comment at its
// declaration below) instead of reading the shared manifest, so a future
// `lobster.hasRig` flip for Bumper Shells can never silently re-enable
// swim-animation on reef riders. Do not re-add this import without also
// re-deriving `wantsAnimator` from a REEF-RACE-SPECIFIC decision, not the
// shared manifest.
import type {
  SeaCreatureSpecies,
  SeaCreatureAnimState,
} from '@/lib/three/sea-creature-types';
import { resetTransformSwimState } from '@/lib/three/sea-creature-swim';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import {
  useVRMInstance,
  disposeVRMInstance,
  retainVRMInstance,
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
import {
  findCollectedReefRaceItemKind,
  findConsumedReefRaceItemKind,
} from './reef-race-speed-surge';

// ─── Preloads — fire at module scope ─────────────────────────────────────────
// Canonical creature models use KHR_texture_basisu. The race Canvas does not
// exist yet at module load, so warm HTTP bytes only; parsing waits until
// KTX2LoaderSetup has detected renderer support inside ReefRaceScene.
preloadKTX2Bytes('/models/sea_horse-ktx.glb?v=2');
preloadKTX2Bytes('/models/lobster-ktx.glb?v=2');
preloadKTX2Bytes('/models/crayfish-ktx.glb?v=2');  // SPEC 1 — 3rd species, static mesh
// v2 spline path surfboard — plain .clone() (no skeleton, static mesh).
// Asset: surfboard_1.glb, 3 220 tris, 660 KB, CC-BY 4.0 (see ATTRIBUTIONS.md).
useGLTF.preload('/models/reef-race/surfboards/surfboard_1.glb');
// Registry-driven rider router (2026-07-10) — these GLB creature species are now
// reachable via MODEL_REGISTRY (previously all rendered as lobster.glb). Not
// covered by the global tier-2 preload manifest (asset-preload-manifest.ts),
// so warm them here to avoid a Suspense-cascade stutter mid-race.
// lobster_plush-ktx.glb is already globally preloaded (shared with the "Larry" NPC) —
// no duplicate call needed.
preloadKTX2Bytes('/models/sweet_crab_sketchfabweekly-ktx.glb');
preloadKTX2Bytes('/models/hermitcrab-ktx.glb');
preloadKTX2Bytes('/models/jellyfish-ktx.glb');
preloadKTX2Bytes('/models/octopus_toy-ktx.glb');

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

/** Uniform scale (gliderRef-local) for the orientation-corrected surfboard.
 *  Founder sizing pass (2026-07-16): GLB longest ≈1.989 local → ×3.8 →
 *  ≈151wu at KART_SCALE=20. Creature rider targets stay unchanged. */
// Founder knob: larger values grow the board without changing creature riders.
const SURFBOARD_UNIFORM_SCALE = 3.8;

/**
 * Board DECK-TOP height in gliderRef-LOCAL units — the grounding plane the
 * rider's feet (VRM) / body-bottom (GLB creature) sit ON. The board clone is
 * recentered at the gliderRef origin (see `clonedSurfboard`), so its deck top =
 * half the fitted board thickness.
 *
 * surfboard_1.glb thinnest raw axis = 0.18814 local (gltf-transform 2026-07-15)
 * → ×SURFBOARD_UNIFORM_SCALE(3.8) = 0.714932 → /2 = 0.357466 local (= 7.14932wu
 * at KART_SCALE=20). The expression below deliberately derives from the SAME
 * scale constant so every rider remains planted when board sizing changes.
 *
 * Founder 2026-07-15: "the board should be the grounding point for the feet …
 * feet planted on the board." Mounting `riderMountRef` AT this Y, combined with
 * the per-rider grounding already applied at mount (VRM: computeVRMAvatarFit's
 * offsetY drops feet to the mount origin; GLB: bbox-min → mount origin), plants
 * every rider ON the deck instead of floating ~12–22wu above it (measured
 * before-fix gap). The v1 BoxGeometry board (non-spline path) uses its own
 * GLIDER_HEIGHT/2 deck top.
 */
const SURFBOARD_DECK_TOP_LOCAL_Y = (0.18814 * SURFBOARD_UNIFORM_SCALE) / 2;

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

/** Server wipeout duration and allocation-free child-transform presentation. */
const WIPEOUT_PRESENTATION_DURATION_S = 3.2;
const WIPEOUT_TUMBLE_RADIANS = Math.PI * 4;
const WIPEOUT_SINK_LOCAL = 30 / KART_SCALE;
const RESPAWN_POP_DURATION_S = 0.3;
const RESPAWN_POP_AMOUNT = 0.15;

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
 *
 * ROUND 5 2026-07-16 (founder playtest — rider+board still a screen speck):
 * VRMs grow 80→110wu while SURFBOARD_UNIFORM_SCALE grows 3.4→3.8. The board is
 * now ≈151.2wu: board/VRM = 1.37 and board/22wu lobster = 6.87. Creature target
 * constants remain fixed, so the larger board intentionally reads bigger beside them.
 */
// Founder knob: one consistent humanoid height; computeVRMAvatarFit keeps feet deck-planted.
const REEF_VRM_RIDER_TARGET_HEIGHT_WU = 110;

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
 * Per-species OVERRIDE of GLB_RIDER_TARGET_HEIGHT_LOCAL for assets whose
 * bbox height is a bad proxy for their visible body (2026-07-13 Codex fit
 * audit, measured live at the /preview harness):
 *   - jellyfish: the bbox is tentacle-dominated — full box 0.581×1.598×0.585
 *     local but the visible bell is only 0.285 tall, so height-normalizing
 *     to 1.1 shrinks the bell to ~31% of the board's width (reads as a speck
 *     beside the board). 2.5 puts the bell at ~72% of board width.
 * Species not listed use GLB_RIDER_TARGET_HEIGHT_LOCAL.
 */
const REEF_CREATURE_RIDER_TARGET_HEIGHT_OVERRIDE: Record<string, number> = {
  jellyfish: 2.5,
};

/**
 * Fraction of the fitted bbox height that belongs BELOW the intended deck
 * contact point. Jellyfish is the special case: bbox bottom is the tentacle
 * tips, while the visible bell bottom is 82.19% up the full 1.598-unit box.
 * Ground the bell at the mount origin so the tentacles drape past the board.
 */
const REEF_CREATURE_RIDER_GROUND_SINK_FRACTION: Record<string, number> = {
  jellyfish: 0.821877,
};

/**
 * Per-species yaw correction (radians), applied ONCE to a GLB creature
 * rider's `clonedScene` in the mount effect so its authored facing axis
 * points along the board's nose — the SAME "longest axis → local +Z
 * forward" convention `surfboardBaseQuat` (above) already uses for the
 * surfboard mesh itself, since the rider sits under the same unrotated
 * `riderMountRef` → `gliderRef` parent chain (no yaw between them), so
 * `gliderRef`'s local +Z IS the board-nose direction the creature should
 * face.
 *
 * Founder directive (2026-07-12): GLB creature riders ("actual lobsters
 * and crustaceans") should sit STILL, facing FORWARD — not swim-wiggling
 * nor facing whatever arbitrary axis the source artist happened to model
 * on. There is no shared authoring convention across these assets (some
 * from different Sketchfab/asset-pack sources) — each entry below was
 * measured EMPIRICALLY via the `/preview/reef-race-v2?mode=racer&species=
 * <key>&camview=top&diag=1` harness (anatomical read — eyes/antennae/
 * shell/tail-fan — cross-checked against a live yaw trial + the numeric
 * board-forward dot product), NOT guessed:
 *   - lobster: eyes + claws already point along the mesh's local +Z (the
 *     SAME axis the kart assembly treats as forward) → 0.
 *   - crayfish: a DIFFERENT GLB from lobster.glb despite the similar body
 *     plan — its unmistakable tail-fan (the V-notched paddle uropods) sits
 *     opposite the eyes/legs along local +X, not +Z → -π/2.
 *   - hermitcrab: shell (trails at the rear) vs. eye+antenna (head, at
 *     local +X) → -π/2.
 *   - sweet_crab: same crab body plan as hermitcrab, legs/eye-stalks read
 *     consistent with the same +X-is-front axis → -π/2 (lower confidence —
 *     this asset reads closer to radially symmetric than the others; flag
 *     for founder sign-off).
 *   - lobster_plush: a stylized/rounded plush toy, not the realistic
 *     lobster.glb — its face marking (visible "eyes") sits along local -X →
 *     +π/2.
 *   - seahorse / sea_horse (same asset, two species keys — see the
 *     `glbPath` switch below): the down-turned snout already reads toward
 *     the mesh's local +Z → 0.
 *   - jellyfish, octopus: radially-symmetric toy sculpts with no
 *     discernible front — 0 (harmless; there is no "wrong" way for these
 *     to sit).
 * Species not listed here default to 0 (unmeasured / assumed already +Z).
 *
 * Deliberately NOT `MODEL_REGISTRY`'s `registry.faceYaw` — that field only
 * exists on VRM entries (verified: no GLB creature entry sets it) and is
 * PICKER-CAMERA-framing semantics for the /create-agent avatar picker, a
 * different convention than this in-world board-relative yaw (see
 * `feedback_vrm_facing_formula` / reef `rider-species-router` memory — the
 * VRM rider branch below deliberately applies NO yaw for the same reason).
 */
const REEF_CREATURE_RIDER_FACE_YAW: Record<string, number> = {
  lobster: 0,
  crayfish: -Math.PI / 2,
  hermitcrab: -Math.PI / 2,
  sweet_crab: -Math.PI / 2,
  lobster_plush: Math.PI / 2,
  seahorse: 0,
  sea_horse: 0,
  jellyfish: 0,
  octopus: 0,
};

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

interface SurfPoseDampingState {
  surfaceY: number;
  wavePitch: number;
  waveRoll: number;
  bankLean: number;
  initialized: boolean;
}

/** Per-avatarId surf render filters. Jumps/yaw never enter this state. */
const _surfPoseDamping: Record<string, SurfPoseDampingState> = {};

/** Nose-up pitch when airborne (radians). ~8°. */
const JUMP_NOSE_UP_RAD = 0.14;
/** Extended nose-up pitch after a ramp launch (radians). ~16°. 2× JUMP_NOSE_UP_RAD. */
const RAMP_NOSE_UP_RAD = 0.28;
/** How long the extended ramp tilt holds (seconds). */
const RAMP_TILT_HOLD_S = 0.35;
const TRICK_SPIN_DURATION_S = 0.5;
const TRICK_SPIN_RADIANS = Math.PI * 2;
const AIRBORNE_SURFACE_RELEASE_HEIGHT = 20;
/** Per-avatarId ramp-launch hold timer (seconds remaining). Module scope, no per-frame alloc. */
const _rampLaunchHold: Record<string, number> = {};
/** Shared event-time burst scratch; triggerBurst copies it synchronously. */
const _itemBurstPosition = new THREE.Vector3();
const _boostPadBurstPosition = new THREE.Vector3();

interface PredictedBoostPadVolume {
  id: string;
  x: number;
  z: number;
  fwdX: number;
  fwdZ: number;
  normalX: number;
  normalZ: number;
  halfLength: number;
  halfWidth: number;
}

function itemUseBurstColor(kind: string): string {
  switch (kind) {
    case 'rr-turbo-bubble': return '#7df9ff';
    case 'rr-bubble-shield': return '#72f6d1';
    case 'rr-ink-slick': return '#9b6cff';
    case 'rr-seeker-jelly': return '#ff5ec4';
    case 'rr-tide-wave': return '#4ddcff';
    case 'rr-whirlpool': return '#2f7cff';
    default: return '#ffffff';
  }
}
/** Duration of landing squash effect (seconds). */
const SQUASH_DURATION  = 0.18;
/** Squash factor at peak (scale Y multiplier — slightly compressed). */
const SQUASH_Y_MIN     = 0.7;
/** Squash factor at peak (scale XZ multiplier — slightly wider). */
const SQUASH_XZ_MAX    = 1.2;

// ─── Interpolation constants ──────────────────────────────────────────────────
/** Preserve the existing self staging/wipeout snapshot delay exactly. */
const SELF_INTERP_DELAY_MS = 100;
/** Remote mapped interval p95 measured 223ms; 225ms keeps a stable bracket. */
const REMOTE_INTERP_DELAY_MS = 225;
/** Preserve the existing bounded projection for self staging/wipeout snapshots. */
const SELF_INTERP_EXTRAP_MAX_MS = 80;
/**
 * Remote arrival p95 measured 451ms (server p95 452ms); cover that authentic
 * cadence with 500ms before freezing/recovery instead of stopping after 80ms.
 */
const REMOTE_INTERP_EXTRAP_MAX_MS = 500;

/**
 * Maximum snapshot history kept per entity.
 * 8 preallocated entries cover ~533ms at the effective 15Hz cadence. The
 * fixed ring is reused in useFrame; no per-snapshot object/array allocation.
 */
const INTERP_HISTORY_SIZE = 8;

/** Timestamp-matched prediction history (~3.2s at fixed 30 Hz). */
const PRED_HISTORY_SIZE = 96;
/** Old-server fallback: half an observed interval plus a small queue floor. */
const REBASE_LAG_BASE_MS = 20;
const REBASE_FALLBACK_MAX_MS = 150;

// (Removed 2026-07-15: the per-avatar `_bobTime` scratch + BOB_AMP_LOCAL /
// BOB_FREQ_HZ — the independent rider bob is gone; the rider is rigidly parented
// to the board deck. See the riderMount mount note in the render tree below.)

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

function shortestAngleDelta(a: number, b: number): number {
  return ((b - a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
}

interface PredictionHistory {
  t: Float64Array;
  x: Float64Array;
  z: Float64Array;
  vx: Float64Array;
  vz: Float64Array;
  rot: Float64Array;
  height: Float64Array;
  verticalVelocity: Float64Array;
  head: number;
  size: number;
}

interface PredictionSample {
  x: number;
  z: number;
  vx: number;
  vz: number;
  rot: number;
  height: number;
  verticalVelocity: number;
}

interface PredictedVerticalState {
  height: number;
  velocity: number;
}

function createPredictionHistory(): PredictionHistory {
  return {
    t: new Float64Array(PRED_HISTORY_SIZE),
    x: new Float64Array(PRED_HISTORY_SIZE),
    z: new Float64Array(PRED_HISTORY_SIZE),
    vx: new Float64Array(PRED_HISTORY_SIZE),
    vz: new Float64Array(PRED_HISTORY_SIZE),
    rot: new Float64Array(PRED_HISTORY_SIZE),
    height: new Float64Array(PRED_HISTORY_SIZE),
    verticalVelocity: new Float64Array(PRED_HISTORY_SIZE),
    head: 0,
    size: 0,
  };
}

function clearPredictionHistory(history: PredictionHistory): void {
  history.head = 0;
  history.size = 0;
}

function pushPredictionSample(
  history: PredictionHistory,
  atMs: number,
  state: SurfBodyState,
  vertical: PredictedVerticalState,
): void {
  const latest = (history.head - 1 + PRED_HISTORY_SIZE) % PRED_HISTORY_SIZE;
  const replaceLatest = history.size > 0 && atMs <= history.t[latest];
  const i = replaceLatest ? latest : history.head;
  history.t[i] = atMs;
  history.x[i] = state.x;
  history.z[i] = state.z;
  history.vx[i] = state.vx;
  history.vz[i] = state.vz;
  history.rot[i] = state.rot;
  history.height[i] = vertical.height;
  history.verticalVelocity[i] = vertical.velocity;
  if (!replaceLatest) {
    history.head = (history.head + 1) % PRED_HISTORY_SIZE;
    history.size = Math.min(PRED_HISTORY_SIZE, history.size + 1);
  }
}

function samplePredictionAt(
  history: PredictionHistory,
  atMs: number,
  out: PredictionSample,
): boolean {
  if (history.size === 0) return false;
  const oldest = (history.head - history.size + PRED_HISTORY_SIZE) % PRED_HISTORY_SIZE;
  const newest = (history.head - 1 + PRED_HISTORY_SIZE) % PRED_HISTORY_SIZE;
  if (atMs < history.t[oldest]) return false;
  if (atMs > history.t[newest]) {
    const aheadMs = atMs - history.t[newest];
    if (aheadMs > CLIENT_SURF_TICK_DT * 1000) return false;
    const aheadSeconds = aheadMs * 0.001;
    out.x = history.x[newest] + history.vx[newest] * aheadSeconds;
    out.z = history.z[newest] + history.vz[newest] * aheadSeconds;
    out.vx = history.vx[newest];
    out.vz = history.vz[newest];
    out.rot = history.rot[newest];
    out.height = history.height[newest]
      + history.verticalVelocity[newest] * aheadSeconds
      - 0.5 * CLIENT_REEF_GRAVITY * aheadSeconds * aheadSeconds;
    if (out.height < 0) out.height = 0;
    out.verticalVelocity = out.height > 0
      ? history.verticalVelocity[newest] - CLIENT_REEF_GRAVITY * aheadSeconds
      : 0;
    return true;
  }

  let a = oldest;
  let b = oldest;
  for (let n = 1; n < history.size; n++) {
    const i = (oldest + n) % PRED_HISTORY_SIZE;
    if (history.t[i] >= atMs) {
      b = i;
      break;
    }
    a = i;
    b = i;
  }
  const span = history.t[b] - history.t[a];
  const alpha = span > 0 ? (atMs - history.t[a]) / span : 0;
  out.x = history.x[a] + (history.x[b] - history.x[a]) * alpha;
  out.z = history.z[a] + (history.z[b] - history.z[a]) * alpha;
  out.vx = history.vx[a] + (history.vx[b] - history.vx[a]) * alpha;
  out.vz = history.vz[a] + (history.vz[b] - history.vz[a]) * alpha;
  out.rot = lerpAngle(history.rot[a], history.rot[b], alpha);
  out.height = history.height[a] + (history.height[b] - history.height[a]) * alpha;
  out.verticalVelocity = history.verticalVelocity[a]
    + (history.verticalVelocity[b] - history.verticalVelocity[a]) * alpha;
  return true;
}

interface ReefReconStats {
  snapshotCount: number;
  matchedCount: number;
  fallbackCount: number;
  hardSnapCount: number;
  meanErrDist: number;
  maxErrDist: number;
  meanAppliedCorrection: number;
  maxAppliedCorrection: number;
  lastErrDist: number;
  lastAppliedCorrection: number;
  lastMode: 'matched' | 'fallback' | 'hard-snap' | 'seed';
}

function getReconStats(): ReefReconStats | null {
  if (process.env.NODE_ENV === 'production' || typeof window === 'undefined') return null;
  const diagnosticWindow = window as typeof window & { __REEF_RECON_STATS?: ReefReconStats };
  return diagnosticWindow.__REEF_RECON_STATS ?? null;
}

function recordReconStats(
  errDist: number,
  appliedCorrection: number,
  mode: 'matched' | 'fallback' | 'hard-snap',
): void {
  const stats = getReconStats();
  if (!stats) return;
  stats.lastErrDist = errDist;
  stats.lastAppliedCorrection = appliedCorrection;
  stats.lastMode = mode;
  if (mode === 'hard-snap') {
    stats.hardSnapCount += 1;
    return;
  }
  stats.snapshotCount += 1;
  if (mode === 'matched') stats.matchedCount += 1;
  else stats.fallbackCount += 1;
  stats.meanErrDist += (errDist - stats.meanErrDist) / stats.snapshotCount;
  stats.meanAppliedCorrection +=
    (appliedCorrection - stats.meanAppliedCorrection) / stats.snapshotCount;
  if (errDist > stats.maxErrDist) stats.maxErrDist = errDist;
  if (appliedCorrection > stats.maxAppliedCorrection) {
    stats.maxAppliedCorrection = appliedCorrection;
  }
}

// ─── Per-snapshot record ──────────────────────────────────────────────────────
interface SnapRecord {
  /** Local performance.now() arrival time used by remote interpolation. */
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
  height: number;
  verticalVelocity: number;
}

// ─── SPEC 2: VRM rider inner component ────────────────────────────────────────
// Separate from ReefRacePlayerInner so a Suspense boundary can wrap it;
// useVRMInstance() throws a Promise on first load (Suspense protocol).

interface SnapshotHistory {
  records: SnapRecord[];
  head: number;
  size: number;
}

function createSnapshotHistory(): SnapshotHistory {
  const records: SnapRecord[] = [];
  for (let i = 0; i < INTERP_HISTORY_SIZE; i++) {
    records.push({
      t: 0,
      x: 0,
      z: 0,
      rot: Number.NaN,
      vx: 0,
      vz: 0,
      height: 0,
      verticalVelocity: 0,
    });
  }
  return { records, head: 0, size: 0 };
}

function clearSnapshotHistory(history: SnapshotHistory): void {
  history.head = 0;
  history.size = 0;
}

function snapshotAtIndex(history: SnapshotHistory, chronologicalIndex: number): SnapRecord {
  const oldest =
    (history.head - history.size + INTERP_HISTORY_SIZE) % INTERP_HISTORY_SIZE;
  return history.records[(oldest + chronologicalIndex) % INTERP_HISTORY_SIZE];
}

function pushSnapshot(
  history: SnapshotHistory,
  t: number,
  x: number,
  z: number,
  rot: number,
  vx: number,
  vz: number,
  height: number,
): void {
  if (history.size > 0) {
    const latest = snapshotAtIndex(history, history.size - 1);
    if (t <= latest.t) {
      latest.x = x;
      latest.z = z;
      latest.rot = rot;
      latest.vx = vx;
      latest.vz = vz;
      latest.height = height;
      return;
    }
  }
  const target = history.records[history.head];
  target.t = t;
  target.x = x;
  target.z = z;
  target.rot = rot;
  target.vx = vx;
  target.vz = vz;
  const previous = history.size > 0
    ? snapshotAtIndex(history, history.size - 1)
    : null;
  const intervalSeconds = previous ? (t - previous.t) * 0.001 : 0;
  target.height = height;
  target.verticalVelocity = previous && intervalSeconds > 0
    ? (height - previous.height) / intervalSeconds
    : 0;
  history.head = (history.head + 1) % INTERP_HISTORY_SIZE;
  history.size = Math.min(INTERP_HISTORY_SIZE, history.size + 1);
}

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
    retainVRMInstance(vrmPath, `reef-race-${avatarId}`); // cancel deferred dispose on StrictMode re-setup
    return () => { disposeVRMInstance(vrmPath, `reef-race-${avatarId}`); };
  }, [vrmPath, avatarId]);

  const vrmAnimatorRef = useRef<VRMCharacterAnimator | null>(null);
  const surfGroundPendingRef = useRef(false);

  // Initialise animator once we have the VRM.
  useEffect(() => {
    if (!vrm) return;
    // animatorId comes straight from the resolved MODEL_REGISTRY entry (the
    // caller already has it — no reverse path→animatorId lookup needed) so
    // surf_idle/wipeout/victory use per-character Mixamo bakes when available
    // (Hermes/Tekk/chibi each have their own; Miladies and Meshy/Hatcher rigs
    // without a dedicated override use the global bake). Every surf_idle path
    // is translation-stripped so the surface base stays on the board; all use
    // the same bone-name/rest-pose retarget pipeline proven for locomotion.
    const animator = new VRMCharacterAnimator(vrm, animatorId);
    vrmAnimatorRef.current = animator;
    animator.init('surf_idle').then(() => {
      // setSurfaceClip AFTER init so surf_idle retarget is cached in this.actions;
      // post-one-shot crossfades will correctly return to surf_idle (not idle).
      animator.setSurfaceClip('surf_idle');
      // Evaluate the stripped surf stance at frame zero, then arm a mount-local
      // animated-foot correction so bind-pose offsetY cannot leave a static gap.
      // This is a one-time mount correction (scaled exactly once), never the
      // per-frame normalized-rig feedback loop that made squat grounding flicker.
      animator.sampleCurrentActionStart();
      surfGroundPendingRef.current = true;
      onAnimatorReady(animator);
    }).catch((err: unknown) => {
      console.warn('[ReefRaceVRMRider] animator.init failed:', err);
    });
    return () => {
      surfGroundPendingRef.current = false;
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
    if (surfGroundPendingRef.current) {
      const mount = riderMountRef.current;
      const scene = vrm?.scene;
      if (mount && scene?.parent === mount) {
        // mount-local Y is board-normal/deck-relative even while the kart is
        // pitched or banked. Subtract once; never feed the result back again.
        const footMountY = animator.getFootYMinInSpace(mount);
        if (Number.isFinite(footMountY)) {
          scene.position.y -= footMountY;
          scene.updateMatrixWorld(true);
          surfGroundPendingRef.current = false;
        }
      }
    }
  });

  return null; // imperative scene graph — no JSX output
}

// ─── Player inner component ───────────────────────────────────────────────────

interface ReefRacePlayerProps {
  entity: ReefRaceEntity;
  isSelf?: boolean;
  /** False for countdown-only staged twins; prevents any input prediction. */
  predictionEnabled?: boolean;
  /** Called on ramp launch for the self player — triggers camera screen shake. */
  triggerScreenShake?: (intensity: number) => void;
}

function ReefRacePlayerInner({
  entity,
  isSelf = false,
  predictionEnabled = true,
  triggerScreenShake,
}: ReefRacePlayerProps) {
  // Registry-driven rider router (2026-07-10) — derive from entity.species
  // (modelKey from avatars.model_key, injected by activity store on
  // snapshot.init via reefParticipantMeta) by looking it up in MODEL_REGISTRY,
  // the same single source of truth every other avatar render site uses.
  // Falls back to the canonical lobster-ktx.glb if species is absent or unrecognised.
  //
  // `avatar_type: 'vrm'` → render via useVRMInstance in ReefRaceVRMRiderInner
  // (Suspense boundary), using the registry's own path (preserves ?v=N
  // cache-bust queries) + animatorId. The GLB path falls back to lobster-ktx.glb
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
  // KTX2-aware GLTF hook is always called (Rules of Hooks).
  const glbPath = (() => {
    if (isVRM) return '/models/lobster-ktx.glb?v=2'; // sentinel — not rendered when isVRM
    if (regEntry && regEntry.avatar_type === 'glb') return regEntry.path;
    switch (speciesKey) {
      case 'crayfish':  return '/models/crayfish-ktx.glb?v=2';
      case 'seahorse':
      case 'sea_horse': return '/models/sea_horse-ktx.glb?v=2';
      default:
        // Unknown species — not in the registry, not a legacy special case.
        // Log once, render lobster.
        if (!_warnedUnknownSpeciesKeys.has(speciesKey)) {
          _warnedUnknownSpeciesKeys.add(speciesKey);
          console.warn(
            `[ReefRacePlayer] unknown species="${speciesKey}" — rendering lobster-ktx.glb as fallback`,
          );
        }
        return '/models/lobster-ktx.glb?v=2';
    }
  })();

  // Always call the KTX2-aware loader (Rules of Hooks). When isVRM=true,
  // srcScene is a lobster sentinel that is never mounted.
  const { scene: srcScene } = useGLTFWithKTX2(glbPath);
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
  const wasWipedOutRef = useRef(false);
  const wasObstacleControlLockedRef = useRef(false);
  const wipeoutStartedAtRef = useRef(0);
  const respawnPopRemainingRef = useRef(0);

  // ─── Interpolation state ────────────────────────────────────────────────────
  // Ring buffer of received snapshots.
  const historyRef = useRef<SnapshotHistory | null>(null);
  if (historyRef.current === null) historyRef.current = createSnapshotHistory();
  const arrivalTimingRef = useRef({ lastAtMs: 0 });
  const remoteTimelineRef = useRef({
    mapped: false,
    offsetMs: 0,
    timebaseTransitionActive: false,
  });
  const remoteOutputPoseRef = useRef({
    initialized: false,
    x: 0,
    z: 0,
    rot: 0,
    height: 0,
    wipedOut: false,
  });
  const remoteRecoveryRef = useRef({
    remainingMs: 0,
    durationMs: 1,
    fromX: 0,
    fromZ: 0,
    fromRot: 0,
    fromHeight: 0,
  });
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
  const predictedVerticalRef = useRef<PredictedVerticalState>({ height: 0, velocity: 0 });
  const prevVerticalTickRef = useRef<PredictedVerticalState>({ height: 0, velocity: 0 });
  const rebaseHeightOffsetRef = useRef(0);
  const lastJumpPressSeqRef = useRef(selfInputBus.jumpPressSeq);
  const pendingRampImpulseRef = useRef(0);
  const lastAuthorityVerticalRef = useRef({ height: 0, atMs: 0, velocity: 0 });
  const lastRenderedHeightRef = useRef(0);
  const localTrickSteerSideRef = useRef<-1 | 0 | 1>(0);
  const trickAnimationRef = useRef({
    active: false,
    queued: false,
    performedThisFlight: false,
    direction: 1,
    elapsed: 0,
  });
  // Allocated once: only speedMod is refreshed from authority; accelMult stays 1.
  const clientSurfParamsRef = useRef<SurfParams | null>(null);
  if (clientSurfParamsRef.current === null) {
    clientSurfParamsRef.current = { ...CLIENT_SURF_PARAMS };
  }
  // Previous-tick pose for RENDER interpolation ("fix your timestep"). The
  // fixed 30 Hz integration below only advances `pred` on tick boundaries, so
  // rendering `pred` directly steps the kart ~43 wu at a time at top speed —
  // on a 60–144 Hz display that reads as constant self-kart jitter (the exact
  // regression the founder reported 2026-07-14; remote karts were smooth
  // because they render through the 100–220 ms interpolation path). Render
  // pose = lerp(prevTick, pred, accum/TICK_DT) — ≤1 tick (33 ms) of visual
  // latency, motion is frame-smooth. Reconciliation corrections are applied
  // to BOTH states so a snapshot rebase never bleeds through the blend.
  const prevTickRef = useRef<{ x: number; z: number; vx: number; vz: number; rot: number }>({
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    rot: 0,
  });
  // Self-only presentation offset. A soft authority rebase moves prediction
  // immediately, then this inverse offset keeps the arrival frame visually
  // continuous and decays away in the render loop. Allocated once per rider.
  const rebaseRenderOffsetRef = useRef({ x: 0, z: 0, rot: 0 });
  const predictInitRef = useRef(false);
  // Fixed-timestep accumulator (s). Render frames are ~60 fps with variable dt,
  // but integrateSurfStep's drag/grip multipliers assume the server's fixed
  // 30 Hz tick — so we accumulate frame time and drain it in CLIENT_SURF_TICK_DT
  // steps, advancing prediction at exactly the server rate.
  const predictAccumRef = useRef(0);
  const predictionHistoryRef = useRef<PredictionHistory | null>(null);
  if (predictionHistoryRef.current === null) {
    predictionHistoryRef.current = createPredictionHistory();
  }
  const predictionSampleRef = useRef<PredictionSample>({
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    rot: 0,
    height: 0,
    verticalVelocity: 0,
  });
  const predictionTimeRef = useRef(0);
  const lastAuthorityArrivalRef = useRef(0);
  const authorityIntervalEwmaRef = useRef(1000 / 15);
  const serverBoostPads = useActivityStore(
    (s) => s.room?.reefSplineZones?.boostPads,
  );
  const predictedBoostPads = useMemo<PredictedBoostPadVolume[]>(() => {
    if (serverBoostPads && serverBoostPads.length > 0) {
      return serverBoostPads.map((pad) => {
        const fwdX = Math.sin(pad.rot);
        const fwdZ = Math.cos(pad.rot);
        return {
          id: pad.id,
          x: pad.position.x,
          z: pad.position.y,
          fwdX,
          fwdZ,
          normalX: -fwdZ,
          normalZ: fwdX,
          halfLength: pad.halfLength,
          halfWidth: pad.halfWidth,
        };
      });
    }

    return buildSplineBoostPadsClient().map((pad) => {
      const point = clientSpline.centerlineAt(pad.t);
      const tangent = clientSpline.tangentAt(pad.t);
      const normalX = -tangent.z;
      const normalZ = tangent.x;
      return {
        id: pad.id,
        x: point.x + normalX * pad.lateralOffset,
        z: point.z + normalZ * pad.lateralOffset,
        fwdX: tangent.x,
        fwdZ: tangent.z,
        normalX,
        normalZ,
        halfLength: pad.halfLength,
        halfWidth: pad.halfWidth,
      };
    });
  }, [serverBoostPads]);
  const predictedBoostPadInsideRef = useRef<Set<string> | null>(null);
  if (predictedBoostPadInsideRef.current === null) {
    predictedBoostPadInsideRef.current = new Set<string>();
  }
  // True only after the self kart has a real live authority pose. Countdown
  // staging keeps the same keyed instance but gates prediction + pose-bus writes.
  const predictsSelf = USE_SPLINE_PLAYER && isSelf && predictionEnabled;
  const surfPoseDamping = _surfPoseDamping[entity.avatarId] ??=
    { surfaceY: 0, wavePitch: 0, waveRoll: 0, bankLean: 0, initialized: false };

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

    // GLB rider auto-fit (registry-driven rider router, 2026-07-10; reworked
    // 2026-07-13 Codex fit audit): normalize this creature's bbox height to
    // its target (see the constants' doc comments — several assets export raw
    // quantized units in the tens of thousands) so species whose native mesh
    // scale wasn't authored for this context don't float above / sink through
    // / dwarf the board. Runs HERE (effect, not the useMemo above) — a Codex
    // review caught the original version mutating state during render, which
    // is unsafe.
    //
    // Face the board nose FIRST (2026-07-12 founder directive — creature
    // riders sit STILL, facing FORWARD), THEN measure: a yaw about +Y never
    // changes bbox height, and measuring the already-yawed scene puts the
    // bbox-center X/Z residuals below in final mount-local orientation so
    // they cancel directly (measuring pre-yaw rotated the centering deltas
    // out from under the fit). Persistent — nothing else writes a GLB rider's
    // rotation (the old per-frame swim call that touched rotation.x/z is
    // REMOVED entirely — see REEF_CREATURE_RIDER_FACE_YAW).
    clonedScene.rotation.y = REEF_CREATURE_RIDER_FACE_YAW[speciesKey] ?? 0;

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
    const fitCenter = new THREE.Vector3();
    fitBox.getSize(fitSize);
    fitBox.getCenter(fitCenter);
    const fitTarget =
      REEF_CREATURE_RIDER_TARGET_HEIGHT_OVERRIDE[speciesKey] ?? GLB_RIDER_TARGET_HEIGHT_LOCAL;
    const groundSinkFraction =
      REEF_CREATURE_RIDER_GROUND_SINK_FRACTION[speciesKey] ?? 0;
    // MULTIPLY the current scale by the fit ratio — never replace it. The
    // measurement above includes whatever scale the scene already carries, so
    // a re-run measures height == target → ratio ≈ 1 → no-op. The old
    // replace-based fit alternated fitted/native scale on repeated mounts
    // (HMR / strict-mode re-mounts — lobster_plush provably flip-flopped
    // 1.1 ↔ 0.675 local; 2026-07-13 Codex fit audit).
    const fitRatio = fitSize.y > 1e-4 ? fitTarget / fitSize.y : 1;
    clonedScene.scale.multiplyScalar(fitRatio);
    // Ground Y + cancel the bbox-center X/Z offset in the same one-time op —
    // several assets are modeled off their local origin (sweet_crab's center
    // sits ~0.34 local off in X, which read as "hanging off the board's
    // edge"). Deltas are ADDITIVE against the measured box (which already
    // includes the current position), so re-runs measure ≈0 residuals and
    // converge instead of clobbering a previously-applied offset.
    clonedScene.position.x -= fitCenter.x * fitRatio;
    clonedScene.position.z -= fitCenter.z * fitRatio;
    // Jellyfish bbox bottom is its tentacle tips, not the visible body. Ground
    // against a FRACTIONAL point inside the measured box so the bell sits on
    // the deck and a re-run measures that same point at y≈0 (no double sink).
    clonedScene.position.y -=
      (fitBox.min.y + groundSinkFraction * fitSize.y) * fitRatio;

    mount.add(clonedScene);
    return () => {
      mount.remove(clonedScene);
      // Clear per-avatarId procedural state so a remounted clone starts at t=0
      // and re-probes for bones (important if species changes across mounts).
      // Harmless no-op for reef now (nothing calls applyTransformSwim from this
      // file any more) — kept because sea-creature-swim.ts's internal Map is
      // keyed by avatarId across ALL its callers (reef + bumper-shells + the
      // avatar preview), so this defensively clears any stale entry.
      resetTransformSwimState(entity.avatarId);
    };
  }, [clonedScene, entity.avatarId, speciesKey]);

  // Per-avatar render/elevation cache cleanup for both GLB and VRM paths.
  useEffect(() => {
    return () => {
      delete _surfPoseDamping[entity.avatarId];
      delete _prevHeight[entity.avatarId];
      delete _squashTime[entity.avatarId];
      delete _rampLaunchHold[entity.avatarId];
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
    if (process.env.NODE_ENV !== 'production') {
      const diagnosticWindow = window as typeof window & { __REEF_RECON_STATS?: ReefReconStats };
      diagnosticWindow.__REEF_RECON_STATS = {
        snapshotCount: 0,
        matchedCount: 0,
        fallbackCount: 0,
        hardSnapCount: 0,
        meanErrDist: 0,
        maxErrDist: 0,
        meanAppliedCorrection: 0,
        maxAppliedCorrection: 0,
        lastErrDist: 0,
        lastAppliedCorrection: 0,
        lastMode: 'seed',
      };
    }
    return () => {
      predictInitRef.current = false;
      predictAccumRef.current = 0;
      rebaseRenderOffsetRef.current.x = 0;
      rebaseRenderOffsetRef.current.z = 0;
      rebaseRenderOffsetRef.current.rot = 0;
      predictedBoostPadInsideRef.current!.clear();
      clearPredictionHistory(predictionHistoryRef.current!);
      resetSelfPoseBus();
    };
  }, [predictsSelf]);

  // ─── Sea-creature animator (hot-swap when manifest enables this species) ───
  // CORRECTED 2026-07-12 (Codex adversarial review caught a stale premise in
  // this comment block — it claimed "0 species enabled (all hasRig=false)",
  // which was WRONG: `sea-creature-manifest.ts` has shipped `lobster: {
  // hasRig: true }` since 2026-04-27, with real rigged GLBs on disk at
  // /models/sea-creatures/lobster/{base.glb, animations/{idle,swim,hit}.glb}.
  // That means this hook is LIVE for lobster today, not dormant — and its
  // 'swim' state (fired whenever speed > 50, i.e. during any actual race) is
  // exactly the swim-wiggle the founder directive says to remove. Reef Race
  // hard-disables this hot-swap below (`wantsAnimator` forced false) so EVERY
  // GLB creature rider — rigged or not, regardless of what the SHARED manifest
  // says — renders the static, facing-corrected `clonedScene`
  // (REEF_CREATURE_RIDER_FACE_YAW) and nothing else. The manifest itself is
  // NOT touched — BumperShellsPlayer.tsx reads the SAME shared
  // SEA_CREATURE_MANIFEST/createSeaCreatureAnimator and legitimately still
  // wants lobster to swim-animate there; flipping `hasRig` off in the
  // manifest would silently regress that unrelated feature. This effect body
  // (the hot-swap load + mount/unmount) is kept byte-for-byte in case a
  // future reef feature needs it back — it's fully inert while
  // `wantsAnimator` is hardcoded false, since the effect returns immediately.
  //
  // FEATURE_GATE: sea_creature_animator (REEF-RACE SCOPE ONLY — see above;
  // Bumper Shells' own use of the same manifest is untouched and out of scope)
  // Status: LIVE for lobster in the shared manifest; explicitly DISABLED for
  //   Reef Race riders per the 2026-07-12 founder "sit still, face forward"
  //   directive. Re-enabling here requires an explicit product decision
  //   (would need per-state clips that read as "racing," not "swimming").
  // Metric to graduate (if ever re-enabled for reef): rigged base.glb +
  //   ≥1 animation clip whose MOTION matches the racing context, reviewed
  //   against the current static-rider bar, not the pre-2026-07-12 baseline.
  // Review deadline: N/A — disabled by explicit directive, not a lapsed gate.
  // Reference: tweet copyrebeldia 2026-04-26 — Meshy/Tripo auto-rig pipeline.
  const animatorRef = useRef<SeaCreatureAnimatorHandle | null>(null);
  // speciesKey is derived earlier (above useGLTF calls) for the glbPath dispatch.
  // Hardcoded false (2026-07-12) — see the block comment above. Was:
  // `SEA_CREATURE_MANIFEST[speciesKey as SeaCreatureSpecies]?.hasRig ?? false`,
  // which let lobster's shipped rig hot-swap in and swim-animate during races,
  // undermining the founder's "sit still, face forward" directive. The
  // `SEA_CREATURE_MANIFEST` import was removed entirely (see the NOTE at the
  // import block above) — Reef Race no longer reads or acts on the manifest.
  const wantsAnimator = false;

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
  const pendingRampVisualRef = useRef(false);

  useEffect(() => {
    if (!lastRampLaunchEvent) return;
    // Deduplicate: skip if we already processed this same event (same at + avatarId).
    const prev = lastSeenRampRef.current;
    if (prev && prev.avatarId === lastRampLaunchEvent.avatarId && prev.at === lastRampLaunchEvent.at) return;
    // Only react when this event is for our avatarId.
    if (lastRampLaunchEvent.avatarId !== entity.avatarId) return;

    lastSeenRampRef.current = { avatarId: lastRampLaunchEvent.avatarId, at: lastRampLaunchEvent.at };

    // The event can arrive before the delayed remote pose reaches liftoff.
    // Queue presentation until rendered height actually leaves the surface.
    pendingRampVisualRef.current = true;

    // Self-player-only: screen shake + burst.
    if (isSelf) {
      pendingRampImpulseRef.current = lastRampLaunchEvent.launchVel
        || CLIENT_REEF_JUMP_IMPULSE_RAMP;
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

  const lastTrickEvent = useActivityStore((s) => s.lastTrickEvent);
  const lastSeenTrickRef = useRef<{ phase: 'armed' | 'landed'; at: number } | null>(null);

  useEffect(() => {
    if (!lastTrickEvent || lastTrickEvent.avatarId !== entity.avatarId) return;
    const previous = lastSeenTrickRef.current;
    if (previous?.phase === lastTrickEvent.phase && previous.at === lastTrickEvent.at) return;
    lastSeenTrickRef.current = { phase: lastTrickEvent.phase, at: lastTrickEvent.at };
    if (lastTrickEvent.phase !== 'armed') return;

    const trick = trickAnimationRef.current;
    trick.direction = lastTrickEvent.direction === 'left' ? 1 : -1;
    if (!trick.active && !trick.performedThisFlight) {
      // Remote events precede their 225ms delayed pose. Self may already be
      // spinning from the immediate local steer edge, so only queue if idle.
      trick.queued = !isSelf;
      if (isSelf) {
        trick.active = true;
        trick.performedThisFlight = true;
        trick.elapsed = 0;
      }
    }
  }, [lastTrickEvent, entity.avatarId, isSelf]);

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
    _boostPadBurstPosition.set(entity.x, height, entity.y);
    triggerBurst(_boostPadBurstPosition, '#55eeff', 110);
  }, [lastBoostPadEvent, entity.avatarId]);

  // Self-only item confirmation from the EXISTING inventory snapshots. The
  // wire has no item-used event or activeEffects field, so whole-inventory
  // charge deltas confirm collect/use. This remains correct when slot 1 is
  // promoted into slot 0 after a consume. Scene FX uses the server kinetic
  // fields plus the controller's bounded Turbo Bubble presentation deadline.
  const powerUpInventory = useActivityStore((s) => s.powerUpInventory);
  const lastPowerUpInventoryRef = useRef<typeof powerUpInventory | null>(null);

  useEffect(() => {
    const previous = lastPowerUpInventoryRef.current;
    lastPowerUpInventoryRef.current = powerUpInventory;
    if (!isSelf || previous === null) return;

    const consumedKind = findConsumedReefRaceItemKind(previous, powerUpInventory);
    const collectedKind = findCollectedReefRaceItemKind(previous, powerUpInventory);
    if (consumedKind === null && collectedKind === null) return;

    const group = groupRef.current;
    if (!group) return;
    _itemBurstPosition.set(
      group.position.x,
      group.position.y + 28,
      group.position.z,
    );

    if (consumedKind !== null) {
      triggerBurst(
        _itemBurstPosition,
        itemUseBurstColor(consumedKind),
        consumedKind === 'rr-turbo-bubble' ? 125 : 105,
      );
      triggerScreenShake?.(
        consumedKind === 'rr-turbo-bubble' ? 0.09 : 0.05,
      );
    } else if (collectedKind !== null) {
      triggerBurst(_itemBurstPosition, '#ffd24a', 90);
      triggerScreenShake?.(0.035);
    }
  }, [powerUpInventory, isSelf, triggerScreenShake]);

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
    const interpDelayMs = isSelf ? SELF_INTERP_DELAY_MS : REMOTE_INTERP_DELAY_MS;
    const interpExtrapMaxMs = isSelf
      ? SELF_INTERP_EXTRAP_MAX_MS
      : REMOTE_INTERP_EXTRAP_MAX_MS;

    // Decay the prior self-only render correction BEFORE ingesting this frame's
    // snapshot. A new inverse correction therefore cancels its prediction rebase
    // exactly on the arrival frame, then begins easing out next render frame.
    if (predictsSelf) {
      const renderOffset = rebaseRenderOffsetRef.current;
      const decay = Math.exp(-SURF_REBASE_RENDER_DAMPING * dt);
      renderOffset.x *= decay;
      renderOffset.z *= decay;
      renderOffset.rot *= decay;
      rebaseHeightOffsetRef.current *= decay;
    }

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

      const h = historyRef.current!;
      const arrivedAtMs = performance.now();
      let snapAtMs = arrivedAtMs;
      if (!isSelf) {
        const remoteTimeline = remoteTimelineRef.current;
        const snapshotAtMs = entity.snapshotAtMs;
        if (typeof snapshotAtMs === 'number' && Number.isFinite(snapshotAtMs)) {
          if (!remoteTimeline.mapped) {
            // Keep the server snapshot cadence, but map it once into the local
            // performance clock used by renderTime. Never let arrival jitter
            // rewrite the timestamp of each individual remote snapshot.
            remoteTimeline.mapped = true;
            remoteTimeline.offsetMs = arrivedAtMs - snapshotAtMs;
            remoteTimeline.timebaseTransitionActive = true;
            clearSnapshotHistory(h);
            remoteRecoveryRef.current.remainingMs = 0;
            // Preserve the final output pose: its k=10 filter absorbs the new
            // single-sample target without exposing a startup position step.
          }
          snapAtMs = snapshotAtMs + remoteTimeline.offsetMs;
        } else if (remoteTimeline.mapped) {
          // Compatibility fallback for a source that stops supplying its clock.
          // A clean ring reset prevents mapped and arrival timestamps mixing.
          remoteTimeline.mapped = false;
          remoteTimeline.offsetMs = 0;
          remoteTimeline.timebaseTransitionActive = true;
          clearSnapshotHistory(h);
          remoteRecoveryRef.current.remainingMs = 0;
          // Keep the same output continuity when falling back to arrival time.
        }
      }
      const authorityHeight = (entity as ReefRaceEntity & { height?: number }).height ?? 0;
      pushSnapshot(
        h,
        snapAtMs,
        entity.x,
        entity.y,
        rot,
        entity.vx,
        entity.vy,
        authorityHeight,
      );

      const arrivalTiming = arrivalTimingRef.current;
      if (arrivalTiming.lastAtMs > 0) {
        const intervalMs = arrivedAtMs - arrivalTiming.lastAtMs;
        if (!predictsSelf && intervalMs > interpDelayMs + interpExtrapMaxMs) {
          const recovery = remoteRecoveryRef.current;
          recovery.durationMs = Math.min(200, Math.max(100, intervalMs - interpDelayMs));
          recovery.remainingMs = recovery.durationMs;
          recovery.fromX = group.position.x;
          recovery.fromZ = group.position.z;
          recovery.fromRot = group.rotation.y;
          recovery.fromHeight = lastRenderedHeightRef.current;
        }
      }
      arrivalTiming.lastAtMs = arrivedAtMs;

      // ─── v2 self prediction — re-baseline toward authority ──────────────────
      // Runs once per NEW server snapshot. Pulls the locally-predicted state
      // toward the server pose so wall-clamp on the tight corridor, kart
      // collisions, and any boost the client couldn't predict are corrected
      // within a few snapshots. Big errors (respawn / teleport) hard-snap.
      if (predictsSelf) {
        const pred = predictedRef.current;
        const predictionHistory = predictionHistoryRef.current!;
        // Server pose in prediction space (sim x → x, sim y → z).
        const sx = entity.x;
        const sz = entity.y;
        const svx = entity.vx;
        const svz = entity.vy;
        const vertical = predictedVerticalRef.current;
        const prevVertical = prevVerticalTickRef.current;
        const priorAuthorityVertical = lastAuthorityVerticalRef.current;
        const authoritySampleAtMs = typeof entity.snapshotAtMs === 'number'
          && Number.isFinite(entity.snapshotAtMs)
          ? entity.snapshotAtMs
          : arrivedAtMs;
        const authorityDt = priorAuthorityVertical.atMs > 0
          ? (authoritySampleAtMs - priorAuthorityVertical.atMs) * 0.001
          : 0;
        const authorityVerticalVelocity = authorityHeight > 0 && authorityDt > 0
          ? (authorityHeight - priorAuthorityVertical.height) / authorityDt
          : 0;
        priorAuthorityVertical.height = authorityHeight;
        priorAuthorityVertical.atMs = authoritySampleAtMs;
        priorAuthorityVertical.velocity = authorityVerticalVelocity;
        // Server rot, with the same spawn-frame fallback the snapshot used.
        const srot = isNaN(rot) ? pred.rot : rot;

        if (lastAuthorityArrivalRef.current > 0) {
          const intervalMs = arrivedAtMs - lastAuthorityArrivalRef.current;
          authorityIntervalEwmaRef.current +=
            (intervalMs - authorityIntervalEwmaRef.current) * 0.15;
        }
        lastAuthorityArrivalRef.current = arrivedAtMs;

        const obstacleAuthorityLocked = predictsSelf &&
          Date.now() < useActivityStore.getState().selfObstacleControlLockedUntil;
        if (entity.wipedOut || obstacleAuthorityLocked) {
          // Wipeout is fully server-authoritative. Snap the prediction anchors
          // to each received body pose, clear local time/history, and let the
          // normal snapshot interpolation below render between those poses.
          pred.x = sx;
          pred.z = sz;
          pred.vx = svx;
          pred.vz = svz;
          pred.rot = srot;
          prevTickRef.current.x = sx;
          prevTickRef.current.z = sz;
          prevTickRef.current.vx = svx;
          prevTickRef.current.vz = svz;
          prevTickRef.current.rot = srot;
          vertical.height = authorityHeight;
          vertical.velocity = 0;
          prevVertical.height = authorityHeight;
          prevVertical.velocity = 0;
          rebaseHeightOffsetRef.current = 0;
          rebaseRenderOffsetRef.current.x = 0;
          rebaseRenderOffsetRef.current.z = 0;
          rebaseRenderOffsetRef.current.rot = 0;
          predictInitRef.current = true;
          predictAccumRef.current = 0;
          predictionTimeRef.current = arrivedAtMs;
          predictedBoostPadInsideRef.current!.clear();
          clearPredictionHistory(predictionHistory);
          pushPredictionSample(predictionHistory, predictionTimeRef.current, pred, vertical);
        } else if (!predictInitRef.current) {
          // First snapshot — initialise predicted state directly from authority.
          pred.x = sx;
          pred.z = sz;
          pred.vx = svx;
          pred.vz = svz;
          pred.rot = srot;
          prevTickRef.current.x = sx;
          prevTickRef.current.z = sz;
          prevTickRef.current.vx = svx;
          prevTickRef.current.vz = svz;
          prevTickRef.current.rot = srot;
          vertical.height = authorityHeight;
          vertical.velocity = authorityVerticalVelocity;
          prevVertical.height = authorityHeight;
          prevVertical.velocity = authorityVerticalVelocity;
          rebaseHeightOffsetRef.current = 0;
          rebaseRenderOffsetRef.current.x = 0;
          rebaseRenderOffsetRef.current.z = 0;
          rebaseRenderOffsetRef.current.rot = 0;
          predictInitRef.current = true;
          // Fresh seed — drop any accumulated fixed-step time.
          predictAccumRef.current = 0;
          predictionTimeRef.current = arrivedAtMs;
          clearPredictionHistory(predictionHistory);
          pushPredictionSample(predictionHistory, predictionTimeRef.current, pred, vertical);
        } else {
          const rawDx = sx - pred.x;
          const rawDz = sz - pred.z;
          const rawErrDist = Math.hypot(rawDx, rawDz);
          if (rawErrDist > CLIENT_REBASE_SNAP_DIST) {
            // Respawn / teleport / catastrophic desync — snap, don't slide.
            surfPoseDamping.initialized = false;
            pred.x = sx;
            pred.z = sz;
            pred.vx = svx;
            pred.vz = svz;
            pred.rot = srot;
            prevTickRef.current.x = sx;
            prevTickRef.current.z = sz;
            prevTickRef.current.vx = svx;
            prevTickRef.current.vz = svz;
            prevTickRef.current.rot = srot;
            vertical.height = authorityHeight;
            vertical.velocity = authorityVerticalVelocity;
            prevVertical.height = authorityHeight;
            prevVertical.velocity = authorityVerticalVelocity;
            rebaseHeightOffsetRef.current = 0;
            rebaseRenderOffsetRef.current.x = 0;
            rebaseRenderOffsetRef.current.z = 0;
            rebaseRenderOffsetRef.current.rot = 0;
            // Teleport — discard stale accumulated time so we don't replay
            // pre-snap motion against the new pose.
            predictAccumRef.current = 0;
            predictionTimeRef.current = arrivedAtMs;
            clearPredictionHistory(predictionHistory);
            pushPredictionSample(predictionHistory, predictionTimeRef.current, pred, vertical);
            recordReconStats(rawErrDist, rawErrDist, 'hard-snap');
          } else {
            // Blend predicted toward authority. Position slower (smoothness),
            // velocity + heading faster (responsiveness to server corrections).
            const matchedSample = predictionSampleRef.current;
            const matched =
              typeof entity.snapshotAtMs === 'number' &&
              samplePredictionAt(predictionHistory, entity.snapshotAtMs, matchedSample);
            let posErrorX: number;
            let posErrorZ: number;
            let velErrorX: number;
            let velErrorZ: number;
            let rotError: number;
            let heightError: number;
            let verticalVelocityError: number;
            if (matched) {
              posErrorX = sx - matchedSample.x;
              posErrorZ = sz - matchedSample.z;
              velErrorX = svx - matchedSample.vx;
              velErrorZ = svz - matchedSample.vz;
              rotError = shortestAngleDelta(matchedSample.rot, srot);
              heightError = authorityHeight - matchedSample.height;
              verticalVelocityError = authorityVerticalVelocity
                - matchedSample.verticalVelocity;
            } else {
              const lagMs = Math.min(
                REBASE_FALLBACK_MAX_MS,
                typeof entity.snapshotAtMs === 'number'
                  ? Math.max(0, predictionTimeRef.current - entity.snapshotAtMs)
                  : authorityIntervalEwmaRef.current * 0.5 + REBASE_LAG_BASE_MS,
              );
              const lagSeconds = lagMs * 0.001;
              posErrorX = sx + svx * lagSeconds - pred.x;
              posErrorZ = sz + svz * lagSeconds - pred.z;
              velErrorX = svx - pred.vx;
              velErrorZ = svz - pred.vz;
              rotError = shortestAngleDelta(pred.rot, srot);
              const authorityProjectedHeight = Math.max(
                0,
                authorityHeight
                  + authorityVerticalVelocity * lagSeconds
                  - 0.5 * CLIENT_REEF_GRAVITY * lagSeconds * lagSeconds,
              );
              heightError = authorityProjectedHeight - vertical.height;
              verticalVelocityError = authorityProjectedHeight > 0
                ? authorityVerticalVelocity - CLIENT_REEF_GRAVITY * lagSeconds
                  - vertical.velocity
                : -vertical.velocity;
            }
            const errDist = Math.hypot(posErrorX, posErrorZ);
            const appliedX = posErrorX * CLIENT_REBASE_POS;
            const appliedZ = posErrorZ * CLIENT_REBASE_POS;
            const appliedRot = rotError * CLIENT_REBASE_ROT;
            pred.x += appliedX;
            pred.z += appliedZ;
            pred.vx += velErrorX * CLIENT_REBASE_VEL;
            pred.vz += velErrorZ * CLIENT_REBASE_VEL;
            pred.rot += appliedRot;
            if (Math.abs(heightError) > CLIENT_REBASE_HEIGHT_SNAP) {
              vertical.height = authorityHeight;
              vertical.velocity = authorityVerticalVelocity;
              prevVertical.height = authorityHeight;
              prevVertical.velocity = authorityVerticalVelocity;
              rebaseHeightOffsetRef.current = 0;
            } else {
              const appliedHeight = heightError * CLIENT_REBASE_HEIGHT;
              vertical.height = Math.max(0, vertical.height + appliedHeight);
              vertical.velocity += verticalVelocityError * CLIENT_REBASE_VEL;
              prevVertical.height = Math.max(0, prevVertical.height + appliedHeight);
              prevVertical.velocity += verticalVelocityError * CLIENT_REBASE_VEL;
              rebaseHeightOffsetRef.current -= appliedHeight;
              if (rebaseHeightOffsetRef.current > SURF_REBASE_HEIGHT_OFFSET_MAX) {
                rebaseHeightOffsetRef.current = SURF_REBASE_HEIGHT_OFFSET_MAX;
              } else if (rebaseHeightOffsetRef.current < -SURF_REBASE_HEIGHT_OFFSET_MAX) {
                rebaseHeightOffsetRef.current = -SURF_REBASE_HEIGHT_OFFSET_MAX;
              }
            }
            // Shift the render-interp anchor by the same correction so the
            // rebase applies uniformly across the blend (no partial-alpha kink).
            prevTickRef.current.x += appliedX;
            prevTickRef.current.z += appliedZ;
            prevTickRef.current.rot += appliedRot;
            // Prediction/history convergence stays immediate. Apply the exact
            // inverse only to the self render pose, then cap pathological
            // accumulated corrections; any residual deliberately remains a step.
            const renderOffset = rebaseRenderOffsetRef.current;
            renderOffset.x -= appliedX;
            renderOffset.z -= appliedZ;
            renderOffset.rot -= appliedRot;
            const renderOffsetLength = Math.hypot(renderOffset.x, renderOffset.z);
            if (renderOffsetLength > SURF_REBASE_RENDER_OFFSET_MAX) {
              const renderOffsetScale = SURF_REBASE_RENDER_OFFSET_MAX / renderOffsetLength;
              renderOffset.x *= renderOffsetScale;
              renderOffset.z *= renderOffsetScale;
            }
            // Velocity reconciliation applies directly to `pred`; unlike the
            // position/yaw anchors it needs no matching previous-tick shift.
            pushPredictionSample(predictionHistory, predictionTimeRef.current, pred, vertical);
            recordReconStats(
              errDist,
              Math.hypot(appliedX, appliedZ),
              matched ? 'matched' : 'fallback',
            );
          }
        }
      }

      // Authoritative wipeout/respawn edge; never infer this from teleport distance.
      const wipedOut = entity.wipedOut === true;
      if (wipedOut && !wasWipedOutRef.current) {
        wipeoutStartedAtRef.current = surfTime;
        respawnPopRemainingRef.current = 0;
        if (isVRM && vrmAnimatorRef.current) {
          void vrmAnimatorRef.current.playOneShot('wipeout');
        }
      } else if (!wipedOut && wasWipedOutRef.current) {
        surfPoseDamping.initialized = false;
        respawnPopRemainingRef.current = RESPAWN_POP_DURATION_S;
      }
      wasWipedOutRef.current = wipedOut;
    }

    // ─── Interpolation (BUG FIX Bug 1) ───────────────────────────────────────
    // Remote history renders at the measured fixed 225ms delay; self retains 100ms.
    const history = historyRef.current!;
    let interpX   = entity.x;
    let interpZ   = entity.y;
    let interpRot = lastRotRef.current;
    let interpVx  = entity.vx;
    let interpVz  = entity.vy;
    let renderedHeight = (entity as ReefRaceEntity & { height?: number }).height ?? 0;

    if (history.size === 1) {
      // Only one snapshot — snap directly (startup case, no bracket yet).
      const only = snapshotAtIndex(history, 0);
      interpX   = only.x;
      interpZ   = only.z;
      interpVx  = only.vx;
      interpVz  = only.vz;
      renderedHeight = only.height;
      if (!isNaN(only.rot)) {
        interpRot = only.rot;
      }
    } else if (history.size >= 2) {
      const renderTime = performance.now() - interpDelayMs;

      // Find the pair of snapshots that bracket renderTime.
      // history is sorted ascending by t (push-only, no reorder needed).
      let a = snapshotAtIndex(history, history.size - 2);
      let b = snapshotAtIndex(history, history.size - 1);
      for (let i = 1; i < history.size; i++) {
        const candidate = snapshotAtIndex(history, i);
        if (candidate.t >= renderTime) {
          a = snapshotAtIndex(history, i - 1);
          b = candidate;
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
      renderedHeight = a.height + (b.height - a.height) * t;

      // BUG FIX (Bug 2): lerp entity.rot angles via shortest arc. Skip NaN frames.
      const rotA = isNaN(a.rot) ? lastRotRef.current : a.rot;
      const rotB = isNaN(b.rot) ? rotA               : b.rot;
      interpRot = lerpAngle(rotA, rotB, t);

      const latest = snapshotAtIndex(history, history.size - 1);
      if (renderTime > latest.t && !entity.wipedOut) {
        const extrapMs = Math.min(interpExtrapMaxMs, renderTime - latest.t);
        interpX = latest.x + latest.vx * extrapMs * 0.001;
        interpZ = latest.z + latest.vz * extrapMs * 0.001;
        interpVx = latest.vx;
        interpVz = latest.vz;
        const extrapSeconds = extrapMs * 0.001;
        renderedHeight = Math.max(
          0,
          latest.height
            + latest.verticalVelocity * extrapSeconds
            - 0.5 * CLIENT_REEF_GRAVITY * extrapSeconds * extrapSeconds,
        );
        if (!isNaN(latest.rot)) interpRot = latest.rot;
      }
    }

    // A packet returning after a long underrun can put renderTime deep inside
    // a new bracket. Blend from the held/extrapolated pose for 100–200ms so
    // recovery is continuous instead of stepping to that bracket in one frame.
    const recovery = remoteRecoveryRef.current;
    if (!predictsSelf && recovery.remainingMs > 0) {
      recovery.remainingMs = Math.max(0, recovery.remainingMs - dt * 1000);
      const linear = 1 - recovery.remainingMs / recovery.durationMs;
      const eased = linear * linear * (3 - 2 * linear);
      interpX = recovery.fromX + (interpX - recovery.fromX) * eased;
      interpZ = recovery.fromZ + (interpZ - recovery.fromZ) * eased;
      interpRot = lerpAngle(recovery.fromRot, interpRot, eased);
      renderedHeight = recovery.fromHeight
        + (renderedHeight - recovery.fromHeight) * eased;
    }

    // Snapshot corrections can still move the bracket output even on a stable
    // mapped clock. Filter only the final remote pose; self prediction and its
    // pose bus never pass through this state.
    if (!isSelf) {
      const outputPose = remoteOutputPoseRef.current;
      const wipedOut = entity.wipedOut === true;
      const rawDx = interpX - outputPose.x;
      const rawDz = interpZ - outputPose.z;
      const timebaseTransitionActive =
        remoteTimelineRef.current.timebaseTransitionActive;
      const hardSeedOutput =
        !predictionEnabled
        || !outputPose.initialized
        || wipedOut !== outputPose.wipedOut
        || (!timebaseTransitionActive
          && rawDx * rawDx + rawDz * rawDz
            > CLIENT_REBASE_SNAP_DIST * CLIENT_REBASE_SNAP_DIST);

      if (hardSeedOutput) {
        outputPose.x = interpX;
        outputPose.z = interpZ;
        outputPose.rot = interpRot;
        outputPose.height = renderedHeight;
        outputPose.initialized = true;
      } else {
        const outputFactor = 1 - Math.exp(-SURF_REBASE_RENDER_DAMPING * dt);
        // Targeted harsh-window probe: 109–119 render spikes landed beside
        // snapshot edges while authoritative velocity had zero spikes. Advance
        // from that clean velocity first (sim Y maps to world Z), then let the
        // existing k=10 position correction trim accumulated prediction drift.
        outputPose.x += entity.vx * dt;
        outputPose.z += entity.vy * dt;
        outputPose.x += (interpX - outputPose.x) * outputFactor;
        outputPose.z += (interpZ - outputPose.z) * outputFactor;
        outputPose.rot = lerpAngle(outputPose.rot, interpRot, outputFactor);
        outputPose.height += (renderedHeight - outputPose.height) * outputFactor;
        if (renderedHeight === 0 && outputPose.height < 0.5) {
          outputPose.height = 0;
        }
      }
      outputPose.wipedOut = wipedOut;
      if (timebaseTransitionActive) {
        const remainingDx = interpX - outputPose.x;
        const remainingDz = interpZ - outputPose.z;
        if (remainingDx * remainingDx + remainingDz * remainingDz
          <= CLIENT_REBASE_SNAP_DIST * CLIENT_REBASE_SNAP_DIST) {
          remoteTimelineRef.current.timebaseTransitionActive = false;
        }
      }
      interpX = outputPose.x;
      interpZ = outputPose.z;
      interpRot = outputPose.rot;
      renderedHeight = outputPose.height;
    }

    // Persist the interpolated rotation for the next zero-velocity spawn frame.
    lastRotRef.current = interpRot;

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
    // Remote karts use the fixed-delay interpolation/recovery path above; v1 does
    // not enable self prediction.
    const obstacleControlLocked = predictsSelf &&
      Date.now() < useActivityStore.getState().selfObstacleControlLockedUntil;
    if (obstacleControlLocked) {
      // Consume DOM jump edges while authority rejects input so they cannot
      // replay as a client-only R18b launch on the first unlocked frame.
      lastJumpPressSeqRef.current = selfInputBus.jumpPressSeq;
    }
    if (!obstacleControlLocked && wasObstacleControlLockedRef.current) {
      // The last locked authority sample is the only safe unlock anchor. Wait
      // for the next snapshot's normal first-seed branch instead of resuming a
      // pre-spin prediction timeline.
      predictInitRef.current = false;
      predictAccumRef.current = 0;
      rebaseRenderOffsetRef.current.x = 0;
      rebaseRenderOffsetRef.current.z = 0;
      rebaseRenderOffsetRef.current.rot = 0;
      clearPredictionHistory(predictionHistoryRef.current!);
    }
    wasObstacleControlLockedRef.current = obstacleControlLocked;
    if (predictsSelf && !entity.wipedOut && !obstacleControlLocked && predictInitRef.current) {
      const pred = predictedRef.current;
      const vertical = predictedVerticalRef.current;
      const prevVertical = prevVerticalTickRef.current;
      const dirInput = selfInputBus.valid ? selfInputBus.dir : null;
      const thrustInput = selfInputBus.valid ? selfInputBus.thrust : 0;
      const jumpPressSeq = selfInputBus.jumpPressSeq;
      if (jumpPressSeq !== lastJumpPressSeqRef.current) {
        lastJumpPressSeqRef.current = jumpPressSeq;
        if (!entity.finishedAt && vertical.height <= 0 && vertical.velocity <= 0) {
          vertical.height = 0;
          vertical.velocity = CLIENT_REEF_JUMP_IMPULSE_MANUAL;
          prevVertical.height = 0;
          prevVertical.velocity = CLIENT_REEF_JUMP_IMPULSE_MANUAL;
        }
      }
      const pendingRampImpulse = pendingRampImpulseRef.current;
      pendingRampImpulseRef.current = 0;
      if (
        pendingRampImpulse > 0
        && vertical.height <= 0
        && vertical.velocity <= 0
      ) {
        vertical.height = 0;
        vertical.velocity = pendingRampImpulse;
        prevVertical.height = 0;
        prevVertical.velocity = pendingRampImpulse;
      }
      // Presentation parity only: authority remains server-owned. Reuse the
      // allocated params object so the fixed-step loop creates no frame garbage.
      const clientSurfParams = clientSurfParamsRef.current!;
      clientSurfParams.speedMod = entity.speedMod ?? 1;

      // Clamp the FRAME dt first (spiral-of-death guard after a tab-out), then
      // accumulate, then cap the accumulator so a long stall can't run dozens
      // of steps in one frame.
      const frameDt = dt > CLIENT_SURF_MAX_DT ? CLIENT_SURF_MAX_DT : dt;
      predictAccumRef.current += frameDt;
      if (predictAccumRef.current > CLIENT_SURF_MAX_ACCUM) {
        predictAccumRef.current = CLIENT_SURF_MAX_ACCUM;
      }

      while (predictAccumRef.current >= CLIENT_SURF_TICK_DT) {
        // Capture the pre-step pose — after the loop it holds tick N-1 while
        // `pred` holds tick N, the bracket the render blend below needs.
        prevTickRef.current.x = pred.x;
        prevTickRef.current.z = pred.z;
        prevTickRef.current.vx = pred.vx;
        prevTickRef.current.vz = pred.vz;
        prevTickRef.current.rot = pred.rot;
        prevVertical.height = vertical.height;
        prevVertical.velocity = vertical.velocity;
        const airborne = vertical.height > 0 || vertical.velocity > 0;
        const next = integrateSurfStep(
          pred,
          { dir: dirInput, thrust: thrustInput, airborne },
          clientSurfParams,
          CLIENT_SURF_TICK_DT, // fixed step — NOT the frame dt
        );
        pred.x = next.x;
        pred.z = next.z;
        pred.vx = next.vx;
        pred.vz = next.vz;
        pred.rot = next.rot;
        if (airborne) {
          vertical.velocity -= CLIENT_REEF_GRAVITY * CLIENT_SURF_TICK_DT;
          vertical.height = Math.max(
            0,
            vertical.height + vertical.velocity * CLIENT_SURF_TICK_DT,
          );
          if (vertical.height === 0 && vertical.velocity < 0) {
            vertical.velocity = 0;
          }
        }

        // Mirror authority's post-integrate boost-pad pass. Static volumes are
        // resolved once above; this hot path performs only scalar math and Set
        // membership checks. Grounded entry fires once, grounded exit clears,
        // and airborne ticks neither fire nor clear the latch.
        const padInside = predictedBoostPadInsideRef.current!;
        for (let padIndex = 0; padIndex < predictedBoostPads.length; padIndex++) {
          const pad = predictedBoostPads[padIndex];
          const dx = pred.x - pad.x;
          const dz = pred.z - pad.z;
          const along = dx * pad.fwdX + dz * pad.fwdZ;
          const perpendicular = dx * pad.normalX + dz * pad.normalZ;
          const withinXZ =
            Math.abs(along) <= pad.halfLength
            && Math.abs(perpendicular) <= pad.halfWidth;
          const wasInside = padInside.has(pad.id);

          if (!airborne && withinXZ && !wasInside) {
            padInside.add(pad.id);
            computeReefBoostPadKick(
              pred.vx,
              pred.vz,
              pred.rot,
              clientSurfParams.maxSpeed,
              pred,
            );
          } else if (!airborne && !withinXZ && wasInside) {
            padInside.delete(pad.id);
          }
        }

        predictionTimeRef.current += CLIENT_SURF_TICK_DT * 1000;
        pushPredictionSample(
          predictionHistoryRef.current!,
          predictionTimeRef.current,
          pred,
          vertical,
        );
        predictAccumRef.current -= CLIENT_SURF_TICK_DT;
      }

      // ─── Render interpolation between tick N-1 and tick N ──────────────────
      // The integration above only advances on 33.3 ms boundaries; without this
      // blend the kart held its pose on non-tick frames and jumped ~43 wu on
      // tick frames (visible self-kart jitter at any refresh rate above 30 Hz).
      // alpha = fraction of the next tick already elapsed (accumulator drains
      // to < TICK_DT above, so alpha ∈ [0, 1)). Reconciliation shifts both
      // anchors identically, so the blend never re-exposes a rebase as a kink.
      const prevTick = prevTickRef.current;
      const renderAlpha = predictAccumRef.current / CLIENT_SURF_TICK_DT;
      interpX = prevTick.x + (pred.x - prevTick.x) * renderAlpha;
      interpZ = prevTick.z + (pred.z - prevTick.z) * renderAlpha;
      interpRot = lerpAngle(prevTick.rot, pred.rot, renderAlpha);
      interpVx = prevTick.vx + (pred.vx - prevTick.vx) * renderAlpha;
      interpVz = prevTick.vz + (pred.vz - prevTick.vz) * renderAlpha;

      // Vertical presentation extrapolates the latest fixed state across the
      // accumulator remainder. Unlike a raw 30Hz tick blend, this moves on the
      // very first rAF after Space and on every rAF throughout the arc.
      const verticalRenderSeconds = predictAccumRef.current;
      renderedHeight = Math.max(
        0,
        vertical.height
          + vertical.velocity * verticalRenderSeconds
          - 0.5 * CLIENT_REEF_GRAVITY
            * verticalRenderSeconds * verticalRenderSeconds,
      );
      renderedHeight = Math.max(0, renderedHeight + rebaseHeightOffsetRef.current);
      if (vertical.height === 0 && vertical.velocity === 0 && renderedHeight < 0.5) {
        renderedHeight = 0;
        rebaseHeightOffsetRef.current = 0;
      }

      // Authority rebases prediction/history immediately, but reaches the
      // screen through this exponentially decaying inverse offset. Camera,
      // group and dev probe all consume the same smoothed pose below.
      const renderOffset = rebaseRenderOffsetRef.current;
      interpX += renderOffset.x;
      interpZ += renderOffset.z;
      interpRot += renderOffset.rot;
      lastRotRef.current = interpRot;

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
    const velAngle = (interpVx !== 0 || interpVz !== 0)
      ? Math.atan2(interpVx, interpVz)
      : interpRot;
    let bankDelta = velAngle - interpRot;
    bankDelta = ((bankDelta % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    const hardSeedSurfPose = !predictionEnabled || !surfPoseDamping.initialized;
    let renderedSurfaceY = 0;
    if (USE_SPLINE_PLAYER) {
      const tHere = tAtXZ(interpX, interpZ, entity.avatarId);
      // SURF RIDE (baked from the founder-signed-off sandbox 2026-06-27): the kart
      // sits ON the BANKED + WAVE water surface (not the flat centerline datum, which
      // floated it above the low side of banked turns + ignored the swell). The
      // composite banked-datum + Gerstner heave is damped together so small remote
      // XZ corrections cannot resample the datum into Y reversals. Ride height and
      // the sim's raw airborne heightOffset remain immediate outside this follower.
      const bankedDatum = bankedDatumYAtT(interpX, interpZ, tHere);
      const centerWave = surfConformHeightAt(interpX, interpZ, surfTime);

      // SURF TILT — pitch (nose-up trim + wave fore-aft slope) + roll (CONFORM to the
      // surface's lateral slope so the board lies flat on the banked/waved water).
      // Mirrors the sandbox surfTilt; signs verified there against the rendered mesh.
      const fX = Math.sin(interpRot), fZ = Math.cos(interpRot);   // forward
      const rX = Math.cos(interpRot), rZ = -Math.sin(interpRot);  // right
      const hNose = surfConformHeightAt(interpX + fX * SURF_PITCH_HALF_LEN, interpZ + fZ * SURF_PITCH_HALF_LEN, surfTime);
      const hTail = surfConformHeightAt(interpX - fX * SURF_PITCH_HALF_LEN, interpZ - fZ * SURF_PITCH_HALF_LEN, surfTime);
      const rawWavePitch = -Math.atan2(hNose - hTail, 2 * SURF_PITCH_HALF_LEN) * SURF_PITCH_WAVE_GAIN;
      const rxR = interpX + rX * SURF_ROLL_HALF_WIDTH, rzR = interpZ + rZ * SURF_ROLL_HALF_WIDTH;
      const rxL = interpX - rX * SURF_ROLL_HALF_WIDTH, rzL = interpZ - rZ * SURF_ROLL_HALF_WIDTH;
      const bankR = bankedDatumYAtT(rxR, rzR, tHere);
      const bankL = bankedDatumYAtT(rxL, rzL, tHere);
      const waveR = surfConformHeightAt(rxR, rzR, surfTime);
      const waveL = surfConformHeightAt(rxL, rzL, surfTime);
      // Board-footprint heave box filter: the ~151wu board bridges chop shorter
      // than itself. Pitch/roll inputs remain the same board-span differences.
      const rawWaveHeave = (centerWave + hNose + hTail + waveL + waveR) / 5;
      const rawSurfaceY = bankedDatum + rawWaveHeave;
      const rollSampleWidth = 2 * SURF_ROLL_HALF_WIDTH;
      const bankRoll = Math.atan2(bankR - bankL, rollSampleWidth);
      const rawSurfaceRoll = Math.atan2((bankR + waveR) - (bankL + waveL), rollSampleWidth);
      const rawWaveRoll = rawSurfaceRoll - bankRoll;

      if (hardSeedSurfPose) {
        // Pregame/first frame/respawn is a hard seed, matching ChaseCamera's
        // staged reset: never ease stale wave state into a new race pose.
        surfPoseDamping.surfaceY = rawSurfaceY;
        surfPoseDamping.wavePitch = rawWavePitch;
        surfPoseDamping.waveRoll = rawWaveRoll;
        surfPoseDamping.bankLean = bankDelta;
        surfPoseDamping.initialized = true;
      } else {
        const planarSpeed = Math.sqrt(interpVx * interpVx + interpVz * interpVz);
        let speedRatio = (planarSpeed - SURF_CONFORM_PLANING_START_SPEED)
          / (SURF_CONFORM_PLANING_FULL_SPEED - SURF_CONFORM_PLANING_START_SPEED);
        if (speedRatio < 0) speedRatio = 0;
        else if (speedRatio > 1) speedRatio = 1;
        const tiltDamping = SURF_TILT_DAMPING_LOW_SPEED
          + (SURF_TILT_DAMPING_HIGH_SPEED - SURF_TILT_DAMPING_LOW_SPEED) * speedRatio;
        const surfaceFactor = 1 - Math.exp(-SURF_HEAVE_DAMPING * dt);
        const tiltFactor = 1 - Math.exp(-tiltDamping * dt);
        const bankLeanFactor = 1 - Math.exp(-SURF_BANK_LEAN_DAMPING * dt);
        surfPoseDamping.surfaceY +=
          (rawSurfaceY - surfPoseDamping.surfaceY) * surfaceFactor;
        surfPoseDamping.wavePitch += (rawWavePitch - surfPoseDamping.wavePitch) * tiltFactor;
        surfPoseDamping.waveRoll += (rawWaveRoll - surfPoseDamping.waveRoll) * tiltFactor;
        surfPoseDamping.bankLean +=
          (bankDelta - surfPoseDamping.bankLean) * bankLeanFactor;
      }

      renderedSurfaceY = surfPoseDamping.surfaceY;
      group.position.y = renderedSurfaceY + SURF_RIDE_HEIGHT + renderedHeight;

      let surfPitch = surfPoseDamping.wavePitch - SURF_PITCH_TRIM_DEG * SURF_DEG2RAD;
      if (surfPitch < -SURF_PITCH_CLAMP) surfPitch = -SURF_PITCH_CLAMP; else if (surfPitch > SURF_PITCH_CLAMP) surfPitch = SURF_PITCH_CLAMP;
      // Bank roll is raw track truth; only the Gerstner contribution is filtered.
      let surfRoll = bankRoll + surfPoseDamping.waveRoll;
      if (surfRoll < -SURF_ROLL_CLAMP) surfRoll = -SURF_ROLL_CLAMP; else if (surfRoll > SURF_ROLL_CLAMP) surfRoll = SURF_ROLL_CLAMP;
      // YXZ order (yaw → pitch → roll) to MATCH the sandbox pivot the signs were
      // verified against. The glider child adds the airborne jump nose-up (rotation.x)
      // + a small velocity bank (rotation.z) on top.
      group.rotation.order = 'YXZ';
      let surfaceContact = 1 - renderedHeight / AIRBORNE_SURFACE_RELEASE_HEIGHT;
      if (surfaceContact < 0) surfaceContact = 0;
      else if (surfaceContact > 1) surfaceContact = 1;
      group.rotation.set(
        surfPitch * surfaceContact,
        interpRot,
        surfRoll * surfaceContact,
      );
    } else {
      group.position.y = 0;
      group.rotation.y = interpRot;
      if (hardSeedSurfPose) {
        surfPoseDamping.bankLean = bankDelta;
        surfPoseDamping.initialized = true;
      } else {
        const bankLeanFactor = 1 - Math.exp(-SURF_BANK_LEAN_DAMPING * dt);
        surfPoseDamping.bankLean +=
          (bankDelta - surfPoseDamping.bankLean) * bankLeanFactor;
      }
    }

    // ─── Jump nose-up tilt (v2 only) ─────────────────────────────────────────
    if (predictsSelf) {
      // Publish after surface damping resolves at priority -2. ChaseCamera reads
      // at -1, sharing this exact long-swell datum without inheriting jump Y.
      selfPoseBus.x = interpX;
      selfPoseBus.z = interpZ;
      selfPoseBus.rot = interpRot;
      selfPoseBus.surfaceY = renderedSurfaceY;
      selfPoseBus.renderedHeight = renderedHeight;
      selfPoseBus.valid = true;
      selfPoseBus.updatedAt = performance.now();
    }

    // When airborne (height > 0): pitch glider nose up by ~8°.
    // On landing (height was > 0, now 0): trigger squash animation.
    const isRenderedAirborne = renderedHeight > 0;
    if (pendingRampVisualRef.current && isRenderedAirborne) {
      pendingRampVisualRef.current = false;
      _rampLaunchHold[entity.avatarId] = RAMP_TILT_HOLD_S;
    }

    const trick = trickAnimationRef.current;
    if (trick.queued && isRenderedAirborne) {
      trick.queued = false;
      trick.active = true;
      trick.performedThisFlight = true;
      trick.elapsed = 0;
    }
    if (predictsSelf) {
      let steerSide: -1 | 0 | 1 = 0;
      const steerDir = selfInputBus.valid ? selfInputBus.dir : null;
      if (steerDir && (steerDir.x !== 0 || steerDir.z !== 0)) {
        const desiredHeading = Math.atan2(steerDir.x, steerDir.z);
        const steerDelta = Math.atan2(
          Math.sin(desiredHeading - interpRot),
          Math.cos(desiredHeading - interpRot),
        );
        if (Math.abs(steerDelta) >= CLIENT_REEF_TRICK_STEER_DEADZONE_RAD) {
          steerSide = steerDelta > 0 ? 1 : -1;
        }
      }
      if (
        isRenderedAirborne
        && !trick.active
        && !trick.queued
        && !trick.performedThisFlight
        && steerSide !== 0
        && steerSide !== localTrickSteerSideRef.current
      ) {
        trick.active = true;
        trick.performedThisFlight = true;
        trick.direction = steerSide > 0 ? 1 : -1;
        trick.elapsed = 0;
      }
      localTrickSteerSideRef.current = steerSide;
    }

    let trickYaw = 0;
    if (trick.active) {
      trick.elapsed += dt;
      const trickProgress = Math.min(1, trick.elapsed / TRICK_SPIN_DURATION_S);
      trickYaw = trick.direction * TRICK_SPIN_RADIANS * trickProgress;
      if (trickProgress >= 1) {
        trick.active = false;
        trickYaw = 0;
      }
    }

    if (USE_SPLINE_PLAYER) {
      const prevH = _prevHeight[entity.avatarId] ?? 0;
      const isAirborne = isRenderedAirborne;

      if (!isAirborne && prevH > 0) {
        // Just landed — start squash.
        _squashTime[entity.avatarId] = SQUASH_DURATION;
        trick.performedThisFlight = false;
        trick.active = false;
        trick.queued = false;
      }
      _prevHeight[entity.avatarId] = renderedHeight;

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
    // Bank uses render-interpolated velocity relative to render-interpolated
    // facing, then damps the applied slip lean so 30 Hz state never steps.
    // MOVES HERE from meshRootRef — now the BOARD tilts; the rider stays level.
    // Authoritative wipeout presentation composes on the glider child so it
    // never fights groupRef's server XZ/yaw or the shared wave/bank datum.
    if (entity.wipedOut) {
      trick.active = false;
      trick.queued = false;
      trick.performedThisFlight = false;
      const elapsed = Math.max(0, surfTime - wipeoutStartedAtRef.current);
      const progress = Math.min(1, elapsed / WIPEOUT_PRESENTATION_DURATION_S);
      const sinkProgress = 1 - (1 - progress) * (1 - progress);
      glider.rotation.y = progress * WIPEOUT_TUMBLE_RADIANS;
      glider.position.y = GLIDER_LOCAL_Y - sinkProgress * WIPEOUT_SINK_LOCAL;
    } else {
      glider.rotation.y = trickYaw;
      glider.position.y = GLIDER_LOCAL_Y;
      const popRemaining = respawnPopRemainingRef.current;
      if (popRemaining > 0) {
        const popProgress = 1 - popRemaining / RESPAWN_POP_DURATION_S;
        const popScale = 1 + Math.sin(popProgress * Math.PI) * RESPAWN_POP_AMOUNT;
        glider.scale.multiplyScalar(popScale);
        respawnPopRemainingRef.current = Math.max(0, popRemaining - dt);
      }
    }

    glider.rotation.z = -surfPoseDamping.bankLean * 0.15;
    lastRenderedHeightRef.current = renderedHeight;
    group.userData.reefRenderedHeight = renderedHeight;
    group.userData.reefSurfaceY = renderedSurfaceY;
    group.userData.reefTrickYaw = glider.rotation.y;
    group.userData.reefAvatarId = entity.avatarId;
    group.userData.reefIsSelf = isSelf;

    // Dev-only render-pose probe — lets the headless harness measure
    // per-frame motion and applied-bank deltas, not just reconciliation error.
    // Mutates one preallocated object; DCE-stripped from prod bundles.
    if (
      predictsSelf &&
      process.env.NODE_ENV !== 'production' &&
      typeof window !== 'undefined'
    ) {
      const dw = window as typeof window & {
        __REEF_RENDER_POSE?: {
          x: number;
          z: number;
          rot: number;
          bank: number;
          at: number;
        };
      };
      if (!dw.__REEF_RENDER_POSE) {
        dw.__REEF_RENDER_POSE = { x: 0, z: 0, rot: 0, bank: 0, at: 0 };
      }
      dw.__REEF_RENDER_POSE.x = interpX;
      dw.__REEF_RENDER_POSE.z = interpZ;
      dw.__REEF_RENDER_POSE.rot = interpRot;
      dw.__REEF_RENDER_POSE.bank = glider.rotation.z;
      dw.__REEF_RENDER_POSE.at = performance.now();
    }

    // ─── Rider adds no INDEPENDENT lean (Phase 1 §4) ─────────────────────────
    // Comment corrected 2026-07-12 (Codex review caught the prior wording
    // overclaiming): pinning riderMountRef.rotation.z to 0 does NOT make the
    // rider appear level in world space — riderMountRef is a CHILD of
    // gliderRef, so it still visually inherits/banks WITH gliderRef's tilt
    // above (rotations compose down the parent chain; zeroing a child's own
    // local rotation only means it adds no ADDITIONAL tilt on top of what it
    // inherits). What this line actually guarantees: the rider never picks up
    // its own separate wobble independent of the board.
    riderMount.rotation.z = 0;

    // ─── Rider is RIGIDLY mounted to the board deck (2026-07-15) ──────────────
    // Founder playtest: "the board should be the grounding point for the feet …
    // feet planted on the board … board+rider one rigid unit." The old
    // independent per-frame bob (riderMount.position.y = 1.2local + sin·BOB_AMP)
    // is REMOVED — it (a) floated the rider ~12–22wu ABOVE the deck (mount at
    // 1.2local=24wu vs current deck top 0.357466local=7.14932wu) and (b) added a VRM-ONLY Y
    // shimmer the board never shared, which read as self-jitter on the humanoid
    // rider specifically. riderMount.position.y is now a STATIC deck-top plane
    // (set once in JSX, below); the per-rider grounding already applied at mount
    // (VRM offsetY / GLB bbox-min → mount origin) plants feet/body on the deck.
    // No per-frame write here — the board+rider move as one rigid transform.

    // ─── Animation: animator (when manifest enabled) OR static rest pose ────
    const speed = Math.sqrt(interpVx * interpVx + interpVz * interpVz);
    const animator = animatorRef.current;
    if (animator) {
      // Drive the AnimationMixer + state machine. State derivation:
      //   finishedAt → victory   (one-shot, holds last frame)
      //   speed > 50 → swim      (loop)
      //   else        → idle     (loop)
      // Wipeout is driven separately by the authoritative entity boolean above.
      animator.tick(dt);
      const desiredState: SeaCreatureAnimState = entity.finishedAt
        ? 'victory'
        : speed > 50
          ? 'swim'
          : 'idle';
      if (animator.getState() !== desiredState) {
        animator.setState(desiredState);
      }
    }
    // else: GLB creature body stays static — founder directive 2026-07-12
    // ("actual lobsters and crustaceans should just be sitting on the board
    // facing forwards"). The old procedural swim-wiggle (applySwimmingAnim —
    // whole-scene rotation.x/z/position.y oscillation for static meshes via
    // applyTransformSwim, PLUS bone-name spine/tail/fin undulation for rigged
    // meshes like seahorse) is REMOVED entirely, not merely paused after one
    // call. The mount effect above already applies the full one-time fit
    // (per-species yaw → measure → idempotent scale ratio → ground Y +
    // bbox-center X/Z cancellation); rotation.x/z default to 0 and nothing
    // writes them per frame, so not calling anything here leaves a clean
    // static rest pose with no stale mid-oscillation values.

    // Mark finished if finishedAt is set.
    if (entity.finishedAt && !finishedRef.current) {
      finishedRef.current = true;
      // SPEC 2 — VRM victory one-shot on finish line crossing.
      if (isVRM && vrmAnimatorRef.current) {
        void vrmAnimatorRef.current.playOneShot('victory');
      }
    }
  // Publish/render before ChaseCamera's -1 reader. Both priorities stay
  // negative so R3F retains automatic render ownership (SurfBloom is +1).
  }, -2);

  return (
    /*
     * Scene graph (Phase 1 §4):
     *   groupRef  — world XZ position + Y rotation (from server via interpolation)
     *     └── gliderRef  — local Y elevation (GLIDER_LOCAL_Y) + bank tilt (rotation.z)
     *           ├── gliderMesh  — shared BoxGeometry board (2.5×0.25×5 local)
     *           └── riderMountRef  — X/Z [0,·,-0.3], Y=STATIC deck-top plane; rotation.z=0
     *                 └── clonedScene  (avatar GLB, color-tinted)
     */
    <group
      ref={groupRef}
      name={`reef-racer-${entity.avatarId}`}
      scale={[KART_SCALE, KART_SCALE, KART_SCALE]}
    >
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
        {/* Rider mount — planted ON the board deck (rigid, no bob; 2026-07-15).
            X/Z keep RIDER_MOUNT_OFFSET_DEFAULT (0 / slightly back toward tail);
            Y is the STATIC deck-top plane (v2 surfboard vs v1 box board) so the
            per-rider grounding (VRM offsetY / GLB bbox-min → mount origin) lands
            feet/body on the deck instead of ~12–22wu above it. rotation.z pinned 0. */}
        <group
          ref={riderMountRef}
          position={[
            RIDER_MOUNT_OFFSET_DEFAULT[0],
            USE_SPLINE_PLAYER ? SURFBOARD_DECK_TOP_LOCAL_Y : GLIDER_HEIGHT / 2,
            RIDER_MOUNT_OFFSET_DEFAULT[2],
          ]}
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
