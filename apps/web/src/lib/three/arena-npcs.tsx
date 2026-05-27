'use client';

import { useRef, useMemo, useEffect, memo, Suspense } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useWorldLabel, WorldLabel } from '@/lib/three/world-labels-overlay';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { useNpcStore, type NpcSpriteState } from '@/stores/npc';
import { useShallow } from 'zustand/react/shallow';
import { applyWalkAnimation, applyIdleAnimation, idToSeed } from '@/lib/three/procedural-animation';
import { LobsterAnimator, resolveAnimState } from '@/lib/three/lobster-animations';
import { discoverLobsterParts } from '@/lib/three/lobster-parts';
import {
  createCharacterAnimator,
  applyColorTint,
  type CharacterAnimator,
  MODEL_KEY_TO_TYPE,
} from '@/lib/three/character-animations';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';
import { useGameStore } from '@/stores/game';
import { PLAYER_NPC_ID } from '@/stores/npc';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { jumpState } from '@/lib/three/jump-state';
import { clampMovement2D, ENTITY_HALF_HUMANOID, ENTITY_HALF_CHIBI } from '@/lib/three/collision/world-colliders';
import { avatarPositionRef } from '@/stores/game';
import { useVRMInstance, disposeVRMInstance, preloadVRMBytes, applyFattenedFrustumCulling } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator, preloadMixamoClips, type AnimName } from '@/lib/three/vrm-character-animator';
import { MODEL_REGISTRY, getAnimatorIdByPath } from '@/lib/three/agent-model-registry';
import {
  computeVRMAvatarFit,
  VRM_AVATAR_TARGET_HEIGHT_WU,
  VRM_AVATAR_FALLBACK_SCALE,
} from '@/lib/three/vrm-avatar-sizing';
// Camera-cull import REMOVED 2026-05-11 — all NPC/label culling deleted per user
// directive ("remove all the culling completely it ruins the game"). The helper
// still ships for BumperShellsPlayer but is not used in the open world scene.

// ---------------------------------------------------------------------------
// GLB-based NPC renderer with terrain raycasting
// NPCs walk on the actual terrain surface instead of a static Y level
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
/**
 * NPC motion smoother — entity interpolation (CURRENT, 2026-05-18 PM).
 *
 * Render 1 server tick BEHIND real-time, lerp between the two most
 * recent snapshots. Adds ~200 ms latency (irrelevant for wandering
 * NPCs), removes ALL extrapolation, makes network jitter invisible:
 * we're only interpolating between positions the server has already
 * confirmed, never predicting forward.
 *
 *   alpha   = clamp((Date.now() - d.ts) / d.tsDelta, 0, 1)
 *   renderX = lerp(d.prevX, d.x, alpha)
 *
 * Both GLBNpcMesh and VRMNpcMesh useFrames use this pattern inline (no
 * helper function — keeps the hot path allocation-free at 60 × NPC × Hz).
 *
 * History (oldest → current):
 *   1. Pure exp-lerp toward raw d.x/d.y at LERP_SPEED=1.5. Tracked a
 *      stale 5 Hz snapshot, so visible velocity pumped every 200 ms —
 *      fast at the start of each tick, slow at the end. Removed 2026-05-17.
 *   2. Dead reckoning + exp-lerp toward projected target. Projected
 *      target moved linearly, but the asymptotic catch-up of the
 *      exp-lerp still produced visible drift on direction changes.
 *   3. Direct velocity integration (`simVel = (d.x - d.prevX) / tsDelta`
 *      held between snapshots, integrate forward). Theoretically smooth
 *      but `tsDelta` is wall-clock arrival time and network jitter
 *      amplifies straight into velocity errors (e.g. burst-delivered
 *      snapshots → tsDelta = 16ms → velocity 12×). User reported NPCs
 *      still stuttered. Removed.
 *   4. Entity interpolation (current). The endpoint positions are
 *      exactly what the server simulated; jitter only shifts elapsed-
 *      time alpha, never produces wrong-speed motion. Standard AAA
 *      pattern (Quake/HL/CS lineage).
 *
 * NOTE: the wandering-NPC stutter the user reported through patterns
 * 1–3 also turned out to have a SECOND root cause — the VRM animator's
 * 15 Hz spring-bone throttle was also throttling skeleton.update, so
 * the body's boneMatrices uniform refreshed only every 4th frame even
 * though group.position changed every frame. Fixed independently in
 * vrm-character-animator.ts: updateMixerOnly now does the cheap
 * humanoid copy + matrix update + skeleton flush every frame, while
 * updateSpringOnly handles only the expensive spring physics at 15 Hz.
 */
// TARGET_NPC_HEIGHT: desired world-unit height for wandering NPCs.
// Previously NPC_SCALE=50 was a flat multiplier applied to all species; measured
// heights were 30-36 wu because species GLBs have native heights of 0.6-0.7 units
// (0.65 × 50 = 32.5). Per-model normalization (computeNpcScale below) replaces the
// flat multiplier — each species is measured at mount time and scaled to this target.
// Pass 1 (2026-04-16): reduced 120→75. Pass 2 (2026-04-16): reduced 75→45.
// User tested pass 1 and the lobster NPC was still too big relative to buildings (800 wu).
// 45 wu gives a ~1:17.8 ratio vs 800-wu building — target was 1:16–1:20.
const TARGET_NPC_HEIGHT = 45;

// ---------------------------------------------------------------------------
// WIN B — Spring-bone distance LOD scratch vector (perf-audit-2026-05-22)
// Shared across all VRMNpcMesh useFrame calls in a single frame. Each NPC
// writes camera world-pos here once; subsequent reads within the same frame
// see the same value (correct — camera doesn't move mid-frame).
// ZERO per-frame allocations — module-scope, never inside useFrame.
const _springLodCamPos = new THREE.Vector3();

// Sanity clamp for per-species computed scale (mirrors arena-location-npcs logic).
// MAX = TARGET_NPC_HEIGHT/0.5 = 90 — any computed scale > 90 implies native above-pivot
// height < 0.5 units, which means only tiny props/accessories are non-skinned geometry.
// In that case we fall back to a safe default scale of TARGET_NPC_HEIGHT (assumes
// visual body native height ≈ 1.0 unit, which is true for the humanoid species).
const NPC_SCALE_CLAMP_MIN = TARGET_NPC_HEIGHT / 200; // ~0.225
const NPC_SCALE_CLAMP_MAX = TARGET_NPC_HEIGHT / 0.5; // 90
const NPC_LOD_NEAR_DIST_SQ = 2_500 * 2_500;
const NPC_LOD_FAR_DIST_SQ = 5_000 * 5_000;
const NPC_LOD_VERY_FAR_DIST_SQ = 6_000 * 6_000;

// Preload deferred to after SPECIES_MODEL declaration — see below.

function mapToWorld(px: number, py: number): [number, number, number] {
  return [px - HALF_W, 0, py - HALF_H];
}

// Lobster GLB faces +Z natively (rotation.y=0 → head toward +Z). EMPIRICALLY VERIFIED 2026-04-16 (late PM, clean side-view screenshot).
// Prior session concluded +X — that was WRONG (camera was orbited, misread as side-view).
// To face direction (worldVx, worldVz): θ = atan2(worldVx, worldVz)  (no negations)
const DIR_ROTATION: Record<string, number> = {
  down: 0, up: Math.PI, right: Math.PI / 2, left: -Math.PI / 2, idle: 0,
};

import { TERRAIN_LAYER } from '@/lib/three/arena-terrain';

// Scratch objects for computeLocalMinY — module-scope to avoid GC in useMemo.
const _npcBbox = new THREE.Box3();
const _npcMeshBbox = new THREE.Box3();

/** Measure the non-SkinnedMesh bbox of a freshly cloned scene, returning both
 *  the per-species normalized scale and the local min.y for pivot grounding.
 *
 *  Normalizing dimension: bbox.max.y (above-pivot visual height). Using size.y
 *  inflates h when geometry extends below the pivot, causing under-sized renders.
 *  bbox.max.y gives the true "height above ground" of the tallest point.
 *
 *  Falls back to Box3.setFromObject() if no non-skinned geometry is found,
 *  then falls back to TARGET_NPC_HEIGHT scale if the computed value is outside
 *  the sanity clamp (implies only tiny accessory props are non-skinned).
 *
 *  pivotOffsetY = localMinY * finalScale — subtract from group.position.y each
 *  frame so the model's geometry bottom aligns with terrain surface. */
function computeNpcScale(scene: THREE.Object3D): { scale: number; localMinY: number } {
  scene.updateMatrixWorld(true);
  _npcBbox.makeEmpty();

  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      _npcMeshBbox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _npcBbox.union(_npcMeshBbox);
    }
  });

  if (_npcBbox.isEmpty()) {
    // All geometry is SkinnedMesh (e.g. rigged humanoid models).
    // Use the bind-pose bbox to measure the actual native geometry height — DO NOT
    // assume native height ≈ 1.0 unit. Some GLBs are exported at 500–650 native units;
    // applying scale=TARGET(120) on top would render them at 60000–78000 wu.
    // setFromObject() uses bind-pose world matrices (inflated Y extents), but we only
    // use it for SCALE computation (max.y / total height). We force localMinY=0 to avoid
    // using the inflated min.y in the pivot-offset calculation (which caused skyward launch).
    _npcBbox.setFromObject(scene);
    if (_npcBbox.isEmpty()) {
      // Truly empty scene (no geometry at all) — safe minimum
      return { scale: NPC_SCALE_CLAMP_MIN, localMinY: 0 };
    }
    const bindH = _npcBbox.max.y > 0.001 ? _npcBbox.max.y : (_npcBbox.max.y - _npcBbox.min.y);
    const bindScale = bindH > 0.001 ? TARGET_NPC_HEIGHT / bindH : TARGET_NPC_HEIGHT;
    const scale = Math.max(NPC_SCALE_CLAMP_MIN, Math.min(NPC_SCALE_CLAMP_MAX, bindScale));
    // localMinY=0: never use the bind-pose min.y for pivot offset — it inflates to hundreds
    // of native units and would produce a catastrophic pivotOffsetY (scale * inflated_min).
    return { scale, localMinY: 0 };
  }

  // localMinY MUST come from the non-skinned bbox only — never from setFromObject.
  // If we used the inflated setFromObject fallback bbox, localMinY would be wrong
  // (bind-pose extends far below origin) and pivotOffsetY would launch NPCs skyward.
  const localMinY = _npcBbox.min.y;
  const maxY = _npcBbox.max.y;

  // Use bbox.max.y as normalizing height (above-pivot visual extent)
  const h = maxY > 0.001 ? maxY : 1.0;
  const computed = TARGET_NPC_HEIGHT / h;

  // If computed > CLAMP_MAX the non-skinned geometry is tiny accessories (not the body).
  // Fall back to bind-pose bbox for a more reliable body height estimate.
  // CRITICAL: force localMinY=0 here — localMinY came from a tiny accessory (e.g. a coin
  // at y=-154 local space). Using that value × a large scale would launch the NPC skyward.
  // (localMinY * 240 = -37000+ wu offset → NPC appears at +37000 above ground.)
  if (computed > NPC_SCALE_CLAMP_MAX) {
    const _bindBbox = new THREE.Box3().setFromObject(scene);
    if (!_bindBbox.isEmpty()) {
      const bindMaxY = _bindBbox.max.y > 0.001 ? _bindBbox.max.y : (_bindBbox.max.y - _bindBbox.min.y);
      if (bindMaxY > 0.001) {
        const bindScale = TARGET_NPC_HEIGHT / bindMaxY;
        const scale = Math.max(NPC_SCALE_CLAMP_MIN, Math.min(NPC_SCALE_CLAMP_MAX, bindScale));
        return { scale, localMinY: 0 };
      }
    }
  }

  // Hard cap — unconditional. Never allow scale to escape this range regardless of
  // what the bbox measurement returns. This is the final safety net, not a conditional.
  const scale = Math.max(NPC_SCALE_CLAMP_MIN, Math.min(NPC_SCALE_CLAMP_MAX, computed));

  return { scale, localMinY };
}

/** Legacy helper for computeLocalMinY — kept for call sites that only need minY.
 *  @deprecated Use computeNpcScale instead when you also need the scale. */
function computeLocalMinY(scene: THREE.Object3D): number {
  return computeNpcScale(scene).localMinY;
}

// Module-scope scratch Box3 for the rendered-height hard cap (Layer 2 safety net).
// Allocated once — never inside useFrame to avoid GC pressure.
const _renderedBbox = new THREE.Box3();

// Shared raycaster — set to only hit layer 1 (terrain)
const _raycaster = new THREE.Raycaster();
_raycaster.layers.set(TERRAIN_LAYER);
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3(0, -1, 0);

// Cached terrain mesh ref. PERF FIX (2026-04-22): the previous implementation
// called intersectObjects(scene.children, true) which recurses through ALL
// 4549 scene Object3Ds for EACH NPC's terrain check, even though only the
// terrain mesh has TERRAIN_LAYER set. The layer filter happens AFTER recursion
// so the traversal cost was paid in full. DevTools profile showed raycast
// eating 31.5% of frame time across 18 NPCs.
//
// Fix: cache the terrain mesh on first call (one scene traversal total) then
// intersect against ONLY that single mesh — no recursion, no scene-wide walk.
// Reduced raycast cost from O(NPCs × 4549 objects) → O(NPCs × 1 mesh).
let _cachedTerrainMesh: THREE.Object3D | null = null;
function findTerrainMesh(scene: THREE.Scene): THREE.Object3D | null {
  if (_cachedTerrainMesh && _cachedTerrainMesh.parent) return _cachedTerrainMesh;
  _cachedTerrainMesh = null;
  scene.traverse((obj) => {
    if (_cachedTerrainMesh) return;
    // Test layer membership — terrain is the only object with TERRAIN_LAYER enabled
    if ((obj as THREE.Mesh).isMesh && obj.layers.test(_raycaster.layers)) {
      _cachedTerrainMesh = obj;
    }
  });
  return _cachedTerrainMesh;
}

/** Raycast down from (x, z) to find terrain surface Y */
function getTerrainY(x: number, z: number, scene: THREE.Scene): number {
  const terrain = findTerrainMesh(scene);
  if (!terrain) return -2; // terrain not loaded yet, flat sand floor

  _rayOrigin.set(x, 200, z);
  _raycaster.set(_rayOrigin, _rayDir);
  _raycaster.layers.set(TERRAIN_LAYER);
  _raycaster.far = 400;

  // intersectObject(mesh, false) = NO recursion, just this one mesh.
  // 99.98% cheaper than intersectObjects(scene.children, true).
  const intersects = _raycaster.intersectObject(terrain, false);
  if (intersects.length > 0) {
    return intersects[0].point.y;
  }
  return -2;
}

// Map species strings to GLB paths + model keys for the new character system
const SPECIES_MODEL: Record<string, { path: string; key: string }> = {
  lobster:       { path: '/models/lobster.glb',                    key: 'lobster' },
  crayfish:      { path: '/models/crayfish.glb',                   key: 'crayfish' },
  sweet_crab:    { path: '/models/sweet_crab_sketchfabweekly.glb', key: 'sweet_crab' },
  lobster_plush: { path: '/models/lobster_plush.glb',              key: 'lobster_plush' },
  hermitcrab:    { path: '/models/hermitcrab.glb',                 key: 'hermitcrab' },
  // chihiro / priestess / chibi_goku removed 2026-04-21 — GLBs deleted from disk.
  // Any legacy DB rows with these species values will fall back to DEFAULT_SPECIES (lobster).
  jellyfish:     { path: '/models/jellyfish.glb',                  key: 'jellyfish' },
  octopus:       { path: '/models/octopus_toy.glb',                key: 'octopus' },
  seahorse:      { path: '/models/sea_horse.glb',                  key: 'seahorse' },
};
const DEFAULT_SPECIES = SPECIES_MODEL.lobster;

// Legacy land-themed species from pre-ocean-theme agent registration
// (apps/api/src/routes/agent-setup.ts and apps/web/src/stores/game.ts default
// to 'cat'). Every OpenClaw bot registered through agent-setup's `/configure`
// endpoint persisted with species ∈ {cat, dragon, fox, owl, wolf, bunny,
// phoenix, turtle} which are LAND animals that have never existed in this
// underwater world. Those species fall through SPECIES_MODEL lookup and land
// on DEFAULT_SPECIES (lobster), turning every registered bot into a red
// lobster — observed 2026-04-24 as "~15 lobsters on screen" with only the
// three real sea-creature wanderers meant to exist.
//
// Remap each legacy land species to a flavourful ocean equivalent so the
// existing DB rows render correctly. New registrations will use proper
// ocean species once the api side is updated separately.
const LEGACY_SPECIES_REMAP: Record<string, string> = {
  cat:     'lobster',       // default → bread-and-butter red lobster
  dragon:  'sweet_crab',    // big claws, fighty
  fox:     'hermitcrab',    // sneaky, tucked inside a shell
  owl:     'seahorse',      // vertical posture, perched
  wolf:    'octopus',       // pack hunter / many limbs
  bunny:   'jellyfish',     // hoppy → floaty
  phoenix: 'crayfish',      // fiery red claws
  turtle:  'lobster_plush', // soft/slow
};
function resolveSpecies(raw: string): string {
  return LEGACY_SPECIES_REMAP[raw] ?? raw;
}

// Preload only the live roaming GLB species. Legacy / user-configured species
// still resolve through SPECIES_MODEL, but they load on demand instead of adding
// every retired sea-creature GLB to the open-world boot path.
useGLTF.preload(DEFAULT_SPECIES.path);

// Per-species npcScale override. computeNpcScale measures the bind-pose
// Per-species scale overrides — calibrated AFTER the SkeletonUtils.clone fix.
// Pre-clone-fix the SkinnedMesh was effectively bind-pose-only (bones bound to
// another instance's skeleton), so old overrides like hermitcrab=16 were
// measured against a frozen pose. With bones now properly rebound the animated
// extent is much larger, and those values render the crustaceans massively
// oversized. Re-locked 2026-04-26 after PR #65 reverted hermitcrab to the
// pre-fix value of 16 and produced "fucking huge" wanderers in production:
//   - hermitcrab: 4   → ~54 wu Y-extent with the live animated skeleton
//   - sweet_crab: 7.6 → bbox 56×53×67 reads acceptable in-game
//   - lobster:    no override — computeNpcScale returns ~40 (matches
//                 player-avatar AVATAR_SCALE=40); only re-add an override if the
//                 lobster.glb is re-compressed and the bind-pose bbox shifts.
const SPECIES_WANDER_SCALE_OVERRIDE: Partial<Record<string, number>> = {
  hermitcrab: 4,
  sweet_crab: 7.6,
};

// ---------------------------------------------------------------------------
// VRM NPC constants
// ---------------------------------------------------------------------------

// VRM faces -Z natively (VRM 1.0 spec; VRM 0.x normalised via rotateVRM0 in vrm-loader).
// This is OPPOSITE of lobster GLB (+Z forward). Separate DIR_ROTATION for cardinal dirs.
//   down  vx=0,  vy=+1 → atan2(0, -1) = PI
//   up    vx=0,  vy=-1 → atan2(0,  1) = 0
//   right vx=+1, vy=0  → atan2(1,  0) = PI/2
//   left  vx=-1, vy=0  → atan2(-1, 0) = -PI/2
// See player-avatar.tsx VRM_DIR_ROTATION for verification.
const VRM_DIR_ROTATION: Record<string, number> = {
  down: Math.PI, up: 0, right: Math.PI / 2, left: -Math.PI / 2, idle: Math.PI,
};

// VRM_NPC_SCALE was a flat multiplier tuned for Milady VRMs (~1.6m native
// height → 1.6 × 112 = 179.2 wu on screen). It still ships as the fallback /
// picker-pedestal value, but at-mount we now AUTO-FIT each VRM individually:
//
// PROBLEM: Hermes-female / hermes-male / tekk export from Blender at CENTIMETER
// units (Mixamo source × global_scale=100 during import retains cm). Their
// native bbox.y reads as ~194 three.js units, NOT 1.94. Multiplying 194 × 112
// would produce a ~21,700wu giant.
//
// VRM sizing lives in vrm-avatar-sizing.ts — shared with player-avatar.tsx so
// player + NPC humanoids always render at the same target height. Re-export
// the legacy names below for back-compat with any in-file references.
const VRM_NPC_SCALE = VRM_AVATAR_FALLBACK_SCALE;
const VRM_NPC_TARGET_HEIGHT_WU = VRM_AVATAR_TARGET_HEIGHT_WU;
const computeVRMNpcScale = computeVRMAvatarFit;

// 2026-05-11: all NPC distance/behind-camera/occlusion culling REMOVED per user
// directive ("let's remove all the culling completely it ruins the game"). No
// LOD thresholds, no group.visible flips, no per-frame raycast occlusion test
// on labels. Mid-distance spring-bone throttling also flattened — all VRM NPCs
// now run uniform 15Hz spring physics. The world's 18 wandering NPCs are a
// bounded set that renders correctly at all camera positions; perf gains we
// chased through culling caused more visual bugs (pop-in, label flicker, scale
// regressions) than they recovered. See 3dStructure.md §5d for the throttle
// policy and the "Recent material changes" log for the rollout.

// Preload ALL Milady VRM paths used by wandering NPCs + Mixamo animation clips.
// These calls are module-scope so the caches are warm before any VRMNpcMesh mounts.
// IMPORTANT: each concurrent VRM NPC MUST use a distinct VRM path — vrm-loader caches
// exactly one VRM instance (vrm.scene Object3D) per path. Two components sharing a path
// would share vrm.scene; R3F's `<primitive>` would reparent the same Object3D between
// groups each frame, and both AnimationMixers would fight over the same scene root —
// causing T-pose / frozen animation on one of them.
// Demo NPC → VRM path mapping (all distinct, no collision):
//   Miu   → milady_official_7
//   Kyoko → milady_official_8
//   Vivi  → milady_official_2
//   Mira  → hermes-female  (replaced Maple/milady_official_3 — 2026-05-12)
//   Tekk  → hermes-male    (replaced Ash/milady_official_4    — 2026-05-12)
// Every concurrent wandering VRM MUST be a distinct path — vrm-loader caches one
// instance per path. The 5 paths below cover both the live NPC roster AND the
// retired Milady paths still selectable in the player-avatar picker (preloading
// _3/_4 is cheap and avoids T-pose hitches when a guest picks them).
// Full 8-Milady wanderer cast (restored 2026-05-27) — every path distinct,
// no instance sharing via the vrm-loader cache.
preloadVRMBytes('/avatars/milady-official-1.vrm');
preloadVRMBytes('/avatars/milady-official-2.vrm');
preloadVRMBytes('/avatars/milady-official-3.vrm');
preloadVRMBytes('/avatars/milady-official-4.vrm');
preloadVRMBytes('/avatars/milady-official-5.vrm');
preloadVRMBytes('/avatars/milady-official-6.vrm');
preloadVRMBytes('/avatars/milady-official-7.vrm');
preloadVRMBytes('/avatars/milady-official-8.vrm');
// Hermes wanderers (Mira / Cyrus / Tekk) — re-added 2026-05-12 PM after the
// per-VRM auto-fit in VRMNpcMesh let cm-authored VRMs render at the same
// world height as Milady (computeVRMNpcScale below).
preloadVRMBytes('/avatars/hermes-female.vrm');
preloadVRMBytes('/avatars/hermes-male.vrm');
preloadVRMBytes('/avatars/tekk.vrm');
preloadMixamoClips();

// ---------------------------------------------------------------------------
// Single NPC using GLB model with terrain following
// ---------------------------------------------------------------------------
export const GLBNpcMesh = memo(function GLBNpcMesh({ npc }: { npc: NpcSpriteState }) {
  const groupRef = useRef<THREE.Group>(null!);
  const animGroupRef = useRef<THREE.Group>(null!);
  // Layer 2 safety net: one-shot rendered-height hard cap applied after first render.
  // Catches any NPC that slips through computeNpcScale with a wrong pivot offset.
  const rescaleAppliedRef = useRef(false);
  const npcRef = useRef(npc);
  npcRef.current = npc;

  // Occluder-tag useLayoutEffect removed 2026-05-11 — label-occlusion raycast is
  // gone with the rest of culling, so the userData.isOccluder/npcId tag has no
  // consumer. The whole anti-self-occlusion machinery was a workaround for a
  // feature the user explicitly told us to delete.
  const { scene: threeScene } = useThree();
  // idToSeed returns a float (0..10). Convert to integer so (frame + seed) % N
  // uses integer arithmetic — float modulo with strict === 0 never fires.
  const seed = useMemo(() => Math.round(idToSeed(npc.id)), [npc.id]);

  // WorldLabelsOverlay label — subtle wordmark with distance fade + occlusion.
  // Baseline opacity 0.65 at ≤800wu; fades to 0 at 3000wu.
  // 10Hz raycast against building occluder meshes hides when covered.
  const { divRef: labelRef } = useWorldLabel({
    id: `glb-npc-label-${npc.id}`,
    anchorRef: groupRef,
    offset: [0, 100, 0],
    initialVisible: true,
    fadeNear: 15000,
    fadeFar: 25000,
    fadeBaseOpacity: 0.95,
    occlude: true,
  });

  // Per-frame rendered position. The entity-interpolation smoother
  // (see useFrame below) computes renderX/renderZ from the two latest
  // server snapshots; we mirror it into simPos so the facing/velocity
  // math further down can read previous-frame position via `simPos -
  // glbPrev`. simPos holds RENDER coordinates (post-HALF_W shift),
  // matching what's written to group.position.
  const simPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentRotY = useRef(0);
  const currentTerrainY = useRef(0);

  const resolvedSpecies = resolveSpecies(npc.species);
  const speciesInfo = SPECIES_MODEL[resolvedSpecies] ?? DEFAULT_SPECIES;
  const { scene } = useGLTF(speciesInfo.path);

  // Determine which animation system to use
  const useNewSystem = speciesInfo.key !== 'lobster' && speciesInfo.key !== 'crayfish';

  const { cloned, npcScale, lobsterAnimator, charAnimator, pivotOffsetY } = useMemo(() => {
    // SkeletonUtils.clone rebinds SkinnedMesh.skeleton correctly — plain
    // scene.clone(true) shares bones across instances, which causes every
    // instance after the first to render bound to another NPC's skeleton
    // (observed 2026-04-24: Marlin/Riptide/Driftwood + the 10 building-canvas
    // GLB NPCs silently invisible despite valid scene-graph state). Re-locked
    // 2026-04-26 after PR #65 reverted the import + call.
    // Safe for plain-Mesh models too — SkeletonUtils falls through to clone.
    const c = SkeletonUtils.clone(scene);
    makeObject3DWebGPUSafe(c);
    const tint = new THREE.Color(npc.color);
    applyColorTint(c, tint, 0.7, 0.25);

    // Fatten SkinnedMesh bounding spheres + re-enable frustumCulled (Win G fix,
    // 2026-05-22 perf wave 3). Old pattern set frustumCulled=false universally,
    // preventing Three.js from culling off-screen GLB NPCs at all.
    // applyFattenedFrustumCulling fattens each SkinnedMesh's bind-pose sphere by
    // 1.6× so animated poses stay inside the bound, then sets frustumCulled=true
    // so off-screen NPCs are correctly skipped. Idempotent via _fattenedBy geometry
    // tag — safe if called again downstream.
    applyFattenedFrustumCulling(c);

    // Compute per-species normalized scale + pivot offset.
    // npcScale normalizes the model's above-pivot height to TARGET_NPC_HEIGHT.
    // pivotOffset = localMinY * npcScale — subtracted from group.position.y so
    // the geometry bottom aligns with terrain regardless of model pivot placement.
    // SPECIES_WANDER_SCALE_OVERRIDE takes precedence for models whose
    // bind-pose bbox fools computeNpcScale (see override map comment).
    const { scale: npcScaleComputed, localMinY } = computeNpcScale(c);
    const override = SPECIES_WANDER_SCALE_OVERRIDE[speciesInfo.key];
    const npcScaleFinal = override != null ? override : npcScaleComputed;
    const pivotOffset = localMinY * npcScaleFinal;

    if (useNewSystem) {
      const anim = createCharacterAnimator(speciesInfo.key, c);
      return {
        cloned: c,
        npcScale: npcScaleFinal,
        lobsterAnimator: null as LobsterAnimator | null,
        charAnimator: anim as CharacterAnimator,
        pivotOffsetY: pivotOffset,
      };
    } else {
      const parts = discoverLobsterParts(c);
      const anim  = new LobsterAnimator(parts);
      return {
        cloned: c,
        npcScale: npcScaleFinal,
        lobsterAnimator: anim,
        charAnimator: null as CharacterAnimator | null,
        pivotOffsetY: pivotOffset,
      };
    }
  }, [scene, npc.color, speciesInfo.key, useNewSystem]);

  // Dispose cloned geometry + materials when the NPC is removed from the store
  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          // Do NOT dispose tinted materials — applyColorTint() uses a module-scope
          // shared cache; disposing here would corrupt the cache for other NPCs
          // sharing the same (baseMat.uuid|tintHex|lerpFactor|emissiveIntensity) key.
        }
      });
    };
  }, [cloned]);

  // Debug: expose each GLB NPC's mount metadata + refs to window so CDP can
  // probe whether the mesh actually rendered at expected world position.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as any;
    w.__GLB_NPC_DEBUG = w.__GLB_NPC_DEBUG || {};
    let meshCount = 0, skinnedCount = 0;
    cloned.traverse((o) => {
      if ((o as any).isSkinnedMesh) skinnedCount++;
      else if ((o as any).isMesh) meshCount++;
    });
    w.__GLB_NPC_DEBUG[npc.id] = {
      species: npc.species,
      speciesPath: speciesInfo.path,
      npcScale,
      pivotOffsetY,
      cloned,
      groupRef,
      clonedMeshCount: meshCount,
      clonedSkinnedCount: skinnedCount,
    };
    return () => {
      if (w.__GLB_NPC_DEBUG) delete w.__GLB_NPC_DEBUG[npc.id];
    };
  }, [cloned, npc.id, npc.species, speciesInfo.path, npcScale, pivotOffsetY]);

  useFrame(({ clock, camera }, delta) => {
    const d = npcRef.current;
    const group = groupRef.current;
    const animGroup = animGroupRef.current;
    if (!group || !animGroup) return;

    const dt = Math.min(delta, 0.1);

    // Entity interpolation — render 1 tick BEHIND real-time and lerp
    // between the two most recent server snapshots. This is the standard
    // network smoothing pattern in AAA games (Quake/HL/CS lineage) and
    // it produces perfectly smooth visible motion at the cost of one
    // tick (~200 ms) of latency. Acceptable for wandering NPCs.
    //
    // Why this beats extrapolation/dead-reckoning:
    //   - Extrapolation predicts FORWARD from the latest snapshot at
    //     the implied velocity. Network jitter (snapshot arrival
    //     timing) amplifies into velocity errors, which read as
    //     visible speed bursts + snap-back corrections.
    //   - Interpolation goes BACKWARD between two known snapshots.
    //     The endpoint positions are exactly what the server simulated;
    //     network jitter only shifts the elapsed-time alpha, never
    //     produces wrong-speed motion.
    //
    // For idle NPCs (direction==='idle'): d.x === d.prevX so the lerp
    // resolves to d.x — they sit still without any special-case path.
    //
    // For ts === 0 (demo wanderers, no SSE): the (now - d.ts) elapsed
    // is enormous → alpha clamps to 1 → render = d.x. Demo wander
    // updates x/prevX every 100 ms and we follow snap-to-current, same
    // as the pre-interpolation behaviour for that path.
    const nowMs = Date.now();
    const tsDelta = d.tsDelta > 0 ? d.tsDelta : 200;
    const elapsed = nowMs - d.ts;
    const alpha = d.ts === 0 ? 1 : Math.max(0, Math.min(1, elapsed / tsDelta));
    const renderX = (d.prevX + (d.x - d.prevX) * alpha) - HALF_W;
    const renderZ = (d.prevY + (d.y - d.prevY) * alpha) - HALF_H;

    // Facing velocity from displayed motion (not raw server step).
    // Reads simPos as a 1-frame velocity tracker — interp positions
    // change every frame so this is non-zero whenever the NPC is moving.
    const glbPrevX = simPos.current.x;
    const glbPrevZ = simPos.current.z;

    // XZ AABB collision clamp — prevents NPCs from walking inside buildings
    // and props. Clamping AFTER entity-interpolation so visible NPC position
    // never enters a building even if the server-side sim doesn't have walls.
    // Wandering NPCs use simPos.current as the "from" position (previous
    // render-frame position). clampMovement2D is zero-alloc (module-scope scratch).
    // entityHalf: chibi-type NPCs use a smaller radius than adult humanoids.
    const glbNpcHalf = (npc.id.startsWith('milady-') || npc.id.startsWith('chibi-'))
      ? ENTITY_HALF_CHIBI
      : ENTITY_HALF_HUMANOID;
    const npcClamped = clampMovement2D(simPos.current.x, simPos.current.z, renderX, renderZ, glbNpcHalf);
    simPos.current.x = npcClamped.x;
    simPos.current.z = npcClamped.z;
    // Track walkable surface Y for stair/ramp zones. Used below in group.position.y.
    const npcGroundY = npcClamped.groundY;

    // Entity-vs-player push-out (Phase 4 — client-side visual correction).
    // Only active when a real player avatar is present ('player'/'npc' mode).
    // In 'explore'/'autonomous' mode avatarPositionRef sits at the default
    // game-px origin (5760,6300) = world center, causing spurious push-outs.
    {
      const _cm = useGameStore.getState().controlMode;
      if (_cm === 'player' || _cm === 'npc') {
      const playerWX = avatarPositionRef.x - HALF_W;
      const playerWZ = avatarPositionRef.y - HALF_H;
      const npcHalf = (npc.id.startsWith('milady-') || npc.id.startsWith('chibi-')) ? ENTITY_HALF_CHIBI : ENTITY_HALF_HUMANOID;
      const combinedHalf = npcHalf + ENTITY_HALF_HUMANOID;
      const dvx = simPos.current.x - playerWX;
      const dvz = simPos.current.z - playerWZ;
      const distSq = dvx * dvx + dvz * dvz;
      if (distSq > 0 && distSq < combinedHalf * combinedHalf) {
        const dist = Math.sqrt(distSq);
        const push = combinedHalf - dist;
        simPos.current.x += (dvx / dist) * push;
        simPos.current.z += (dvz / dist) * push;
      }
      }
    }

    group.position.x = simPos.current.x;
    group.position.z = simPos.current.z;

    const frame = Math.floor(clock.elapsedTime * 60);
    _springLodCamPos.set(camera.position.x, camera.position.y, camera.position.z);
    const glbCamDx = group.position.x - _springLodCamPos.x;
    const glbCamDz = group.position.z - _springLodCamPos.z;
    const glbDistSq = glbCamDx * glbCamDx + glbCamDz * glbCamDz;
    const isPossessedPlayerNpc =
      d.id === PLAYER_NPC_ID &&
      useGameStore.getState().controlMode === 'npc';
    // Raycast to find terrain surface Y. Close NPCs retain the historical 20Hz
    // cadence; mid/far NPCs throttle progressively because terrain height changes
    // are visually imperceptible at distance, but the raycast still costs CPU.
    // Use clock.elapsedTime (already available) instead of Date.now() to avoid
    // a syscall allocation in the hot path.
    const terrainMod =
      glbDistSq < NPC_LOD_NEAR_DIST_SQ ? 3 :
      glbDistSq < NPC_LOD_VERY_FAR_DIST_SQ ? 6 :
      12;
    if ((frame + seed) % terrainMod === 0) {
      const terrainY = getTerrainY(group.position.x, group.position.z, threeScene);
      currentTerrainY.current += (terrainY - currentTerrainY.current) * 0.3;
    }

    // Base bob on top of terrain height.
    // Subtract pivotOffsetY to ground each GLB regardless of pivot placement:
    //   pivotOffsetY = localMinY * npcScale (per-species)
    //   - pivotOffsetY < 0 → pivot above feet → subtracting a negative raises the model
    //   - pivotOffsetY = 0 → no change
    //   - pivotOffsetY > 0 → pivot below feet (floating) → lowers it
    //
    // Jump support: only the possessed player NPC (PLAYER_NPC_ID while controlMode='npc')
    // reads jumpState. Wandering NPCs never jump. Bob is suppressed while airborne.
    // 'charging' keeps the NPC on the ground (heightOffset=0), so it is not airborne.
    // playerAltitude > 0 means the NPC is swimming above the ocean floor — also airborne.
    const airborne = isPossessedPlayerNpc &&
                     (jumpState.phase !== 'grounded' && jumpState.phase !== 'charging'
                   || jumpState.playerAltitude > 0);
    const jumpY = isPossessedPlayerNpc
      ? (jumpState.heightOffset + jumpState.playerAltitude)
      : 0;
    const isMoving = d.direction !== 'idle' && !d.isDead;
    const bob = (isMoving && !airborne) ? Math.sin(clock.elapsedTime * 4.0 + seed) * 0.6 : 0;
    // effectiveFloorY: when npcGroundY > currentTerrainY (NPC is on a stair/ramp
    // collider zone), use the walkable surface height so feet ride the stair.
    const npcEffectiveFloorY = Math.max(currentTerrainY.current, npcGroundY);
    group.position.y = npcEffectiveFloorY + 2 + bob + jumpY - pivotOffsetY;

    // Direction rotation. Possessed NPC uses server-provided facingAngle for
    // smooth camera-relative input. Autonomous wanderers use per-frame velocity
    // (more accurate than the discrete server direction, avoids "walking
    // backwards" during 180° direction flips — see VRMNpcMesh for full rationale).
    let targetRot: number | null = null;
    if (d.facingAngle != null) {
      targetRot = d.facingAngle;
    } else {
      const glbVx = simPos.current.x - glbPrevX;
      const glbVz = simPos.current.z - glbPrevZ;
      const velMagSq = glbVx * glbVx + glbVz * glbVz;
      if (velMagSq > 0.25 && d.direction !== 'idle') {
        // GLB crustaceans face +Z at rest (model faces +Z after preview calibration
        // 2026-04-16 late PM). For velocity (vx, vz), targetRot = atan2(vx, vz).
        targetRot = Math.atan2(glbVx, glbVz);
      }
    }
    if (targetRot != null) {
      let diff = targetRot - currentRotY.current;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      currentRotY.current += diff * Math.min(1, 12 * dt);
    }
    group.rotation.y = currentRotY.current;

    // Layer 2: one-shot rendered-height hard cap.
    // Runs once after 0.5s so geometry/bones settle before measurement.
    // Guards against any NPC whose pivot offset blows up despite Layer 1 fixes.
    // HARD_MAX = 95 wu — 2× TARGET_NPC_HEIGHT=45 headroom (pass 2: reduced from 160 on 2026-04-16).
    //
    // IMPORTANT: Box3.setFromObject on a skinned-rig cloned scene measures the
    // bind-pose skeleton extent (for hermitcrab with transform1×nurbsCircleMover
    // chain this reads 336 wu with npcScale=16), NOT the actual rendered mesh
    // extent (~30 wu). That triggers the cap and scales the NPC DOWN by ~4.5×,
    // making it invisible. When a SPECIES_WANDER_SCALE_OVERRIDE is applied
    // we trust the measured override and skip the cap entirely — the override
    // was measured against the rendered mesh, not bind-pose.
    if (!rescaleAppliedRef.current && clock.elapsedTime > 0.5) {
      const speciesHasOverride = SPECIES_WANDER_SCALE_OVERRIDE[speciesInfo.key] != null;
      if (!speciesHasOverride) {
        _renderedBbox.setFromObject(group);
        if (!_renderedBbox.isEmpty()) {
          const renderedH = _renderedBbox.max.y - _renderedBbox.min.y;
          const HARD_MAX = 95;
          if (renderedH > HARD_MAX) {
            const scaledSubGroup = group.children[0]; // the [npcScale, npcScale, npcScale] group
            if (scaledSubGroup) {
              scaledSubGroup.scale.multiplyScalar(HARD_MAX / renderedH);
            }
            // Also reset vertical position to terrain surface so it's no longer floating
            group.position.y = currentTerrainY.current + 2;
          }
        }
      }
      rescaleAppliedRef.current = true;
    }

    const skipFarGlbAnimation = !isPossessedPlayerNpc && glbDistSq > NPC_LOD_FAR_DIST_SQ;

    if (useNewSystem && charAnimator) {
      // Universal character animation system — handles all secondary motion internally
      if (!skipFarGlbAnimation) {
        charAnimator.update(animGroup, clock.elapsedTime, dt, isMoving);
      }
    } else if (lobsterAnimator) {
      // Legacy lobster skeletal animation
      const suggestedState = resolveAnimState({
        isDead: d.isDead,
        inCombat: false,
        combatAction: null,
        direction: d.direction,
        inConversation: false,
      });
      if (!skipFarGlbAnimation) {
        lobsterAnimator.update(dt, clock.elapsedTime, suggestedState, d.direction);
      }

      // Procedural group-level squash/stretch/tilt.
      // Walk animation needs full 60Hz — squash/stretch is fast (8 rad/s bob cycle).
      // Idle animation is slow (max 1.5 rad/s) — 20Hz (every 3rd frame) is imperceptible.
      // Stagger by seed so NPCs don't all update on the same frame.
      const animStateData = {
        group: animGroup,
        isMoving,
        elapsed: clock.elapsedTime,
        delta: dt,
        direction: d.direction,
        seed,
      };
      if (skipFarGlbAnimation) {
        // Keep the far NPC at its last believable pose. Position/facing still
        // update every frame, so identity and activity remain visible.
      } else if (isMoving) {
        applyWalkAnimation(animStateData);
      } else if ((frame + seed) % 3 === 0) {
        // PERF: idle animation throttled to 20Hz — 5 trig calls × 18 NPCs was
        // ~90 sin/cos evaluations/frame at 60Hz; now ~30 (only idle NPCs in range).
        applyIdleAnimation(animStateData);
      }
    }
  });

  return (
    <group ref={groupRef}>
      {/* Scaled model sub-group — per-species normalized scale */}
      <group scale={[npcScale, npcScale, npcScale]}>
        <group ref={animGroupRef}>
          <primitive object={cloned} />
        </group>
      </group>
      {/* Bio-luminescent NPC label — Fraunces serif capsule + dashed-cyan tether + pulsing anchor dot.
          Rig stack (top→bottom): capsule → tether → anchor-dot.
          transform: translateY(-50%) on the rig wrapper shifts the rig UP by half its height so
          the anchor dot (at the rig bottom) lands at the overlay's projected screen point (= head). */}
      <WorldLabel divRef={labelRef}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            transform: 'translateY(-50%)',
            // Per-label stagger so 30 NPCs don't all pulse in unison.
            // idToSeed returns a float; mod 10 / 10 gives [0, 0.9] in 0.1 steps.
            ['--label-phase' as string]: String(Math.round(idToSeed(npc.id)) % 10 / 10),
          }}
        >
          {/* Glowing Fraunces capsule */}
          <div
            style={{
              fontFamily: 'var(--font-fraunces, "Cormorant Garamond", "Spectral", Georgia, serif)',
              fontVariationSettings: '"opsz" 9',
              fontWeight: 480,
              fontSize: 13,
              color: '#effeff',
              padding: '5px 11px 6px',
              borderRadius: 999,
              background: 'rgba(8, 18, 32, 0.85)',
              border: '1px solid rgba(120, 220, 255, 0.45)',
              boxShadow: '0 0 14px rgba(100,230,255,0.45), 0 0 38px -4px rgba(80,220,255,0.35), inset 0 0 10px rgba(120,200,240,0.18)',
              whiteSpace: 'nowrap',
              letterSpacing: '0.01em',
              lineHeight: 1,
              userSelect: 'none',
              animation: 'bio-drift 5.4s ease-in-out infinite',
              animationDelay: 'calc(var(--label-phase, 0) * -5.4s)',
            }}
          >
            {npc.isOpenClaw && (
              <span
                className="oc-status-dot"
                title="OpenClaw agent"
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#4ade80',
                  marginRight: 6,
                  verticalAlign: 'middle',
                  boxShadow: '0 0 8px rgba(74,222,128,0.8)',
                }}
              />
            )}
            {npc.name}
          </div>
          {/* Dashed-cyan tether */}
          <div
            style={{
              width: 1,
              height: 38,
              backgroundImage: 'linear-gradient(rgba(140,240,255,0.78) 50%, transparent 50%)',
              backgroundSize: '1px 6px',
              backgroundRepeat: 'repeat-y',
              boxShadow: '0 0 6px rgba(120,240,255,0.55)',
              marginBottom: 2,
            }}
          />
          {/* Pulsing anchor dot — glow lives on ::after pseudo (compositor-safe) */}
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
    </group>
  );
});

// ---------------------------------------------------------------------------
// VRM NPC renderer — parallel to GLBNpcMesh, for Milady wandering NPCs
// ---------------------------------------------------------------------------
// CRITICAL CONSTRAINT: vrm-loader caches exactly one VRM instance per path.
// Do NOT render two VRMNpcMesh components with the same VRM path — they would
// share vrm.scene and clobber each other's position/animation state every frame.
// The 2 demo Milady NPCs intentionally use different paths (official_7 / official_8).
export const VRMNpcMesh = memo(function VRMNpcMesh({ npc }: { npc: NpcSpriteState }) {
  const groupRef = useRef<THREE.Group>(null!);
  const { scene: threeScene } = useThree();
  const npcRef = useRef(npc);
  npcRef.current = npc;

  // Occluder-tag useLayoutEffect removed 2026-05-11 — see GLBNpcMesh.

  // idToSeed returns float — round to int so (frame + seed) % 3 uses integer arithmetic.
  const seed = useMemo(() => Math.round(idToSeed(npc.id)), [npc.id]);

  // WorldLabelsOverlay label — same parameters as GLBNpcMesh except for the
  // Y offset: VRM humanoids are ~270wu tall (vs ~45wu for GLB crustaceans),
  // so a 100wu offset would land the capsule at the VRM's waist/chest and
  // cover the body. 320wu sits cleanly above the head.
  const { divRef: labelRef } = useWorldLabel({
    id: `vrm-npc-label-${npc.id}`,
    anchorRef: groupRef,
    offset: [0, 320, 0],
    initialVisible: true,
    fadeNear: 15000,
    fadeFar: 25000,
    fadeBaseOpacity: 0.95,
    occlude: true,
  });

  // Same entity-interpolation smoother as GLBNpcMesh — see the long
  // comment block at the top of this file (around line 44) and the
  // GLBNpcMesh useFrame for full rationale. simPos mirrors the rendered
  // position each frame so the facing math can read previous-frame state.
  const simPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentRotY = useRef(VRM_DIR_ROTATION.idle);
  // Pitch ref for the swim-upward lean — see player-avatar.tsx for full
  // rationale. Only meaningful for the possessed-player NPC; wandering
  // NPCs stay at pitch=0 because they're never airborne. Apply via the
  // YXZ Euler order so .x is in the local frame after the facing .y.
  const currentPitchX = useRef(0);
  const currentTerrainY = useRef(-2);
  // PERF: accumulated spring delta — we tick spring bones at 30Hz (every 2nd frame for
  // idle NPCs) by summing frame deltas and flushing them in a single vrm.update() call.
  // The verlet integrator is time-step independent so passing 2× dt is physically correct.
  const springDeltaAccRef = useRef(0);
  /**
   * Most recently applied surfaceClip for the possessed-player NPC.
   * useFrame computes desiredClip every frame (idle / jump / swim /
   * fly) and only calls setSurfaceClip when it changes — avoids
   * thrashing the animator's lazy GLB load + crossfade machinery
   * 60×/s. Wandering NPCs never touch this; defaults to 'idle'.
   */
  const lastSurfaceClipRef = useRef<AnimName>('idle');

  // Resolve VRM path from the model registry (or use the species key directly as path suffix)
  const regEntry = MODEL_REGISTRY[npc.species as keyof typeof MODEL_REGISTRY];
  const vrmPath = regEntry?.path ?? `/avatars/${npc.species.replace('milady_official_', 'milady-official-')}.vrm`;

  // Load a fresh VRM instance for this NPC — each NPC gets its own scene,
  // skeleton, humanoid, no sharing with player-avatar or other NPCs (Codex Critical #1).
  const vrm = useVRMInstance(vrmPath, npc.id);

  // Per-VRM render scale + foot-grounding offset — bbox-fit so cm-authored
  // Hermes VRMs (Mixamo rig, hips at origin) and m-authored Milady VRMs
  // (VRoid spec, feet at origin) both land at VRM_NPC_TARGET_HEIGHT_WU with
  // feet on the terrain. Runs once per loaded VRM instance.
  const { scale: vrmRenderScale, offsetY: vrmFootOffsetY } = useMemo(
    () => computeVRMNpcScale(vrm, npc.species),
    [vrm, npc.species],
  );

  // Dispose this instance when the NPC unmounts or path/id changes.
  useEffect(() => {
    return () => disposeVRMInstance(vrmPath, npc.id);
  }, [vrmPath, npc.id]);

  // Per-instance VRM animator — each NPC gets its own AnimationMixer
  const vrmAnimatorRef = useRef<VRMCharacterAnimator | null>(null);

  useEffect(() => {
    if (!vrm) return;
    // Defensive re-apply of fattened frustum culling on vrm.scene (Win G fix).
    // vrm-loader's normaliseVRM already called applyFattenedFrustumCulling once
    // at parse time, but this useEffect runs AFTER mount and guards against any
    // downstream pass that overwrites frustumCulled. The idempotent _fattenedBy
    // geometry tag means repeated calls don't compound sphere fattening — the
    // geometry stays fattened and frustumCulled is re-asserted to true.
    applyFattenedFrustumCulling(vrm.scene);
    // characterId routes per-character Mixamo overrides in VRMCharacterAnimator.
    // Sourced from the model registry's animatorId field — single source of
    // truth so picker + arena + player all agree. Hermes/Tekk use distinct
    // slugs (their bakes were per-character); every Milady shares 'vrm-milady'
    // (one shared bake — same mesh + proportions across the Milady fork).
    const characterId = getAnimatorIdByPath(vrmPath);
    const animator = new VRMCharacterAnimator(vrm, characterId);
    vrmAnimatorRef.current = animator;
    // Debug: track useEffect mount/cleanup on window for CDP diagnostics
    if (typeof window !== 'undefined') {
      const w = window as any;
      w.__VRM_NPC_EFFECT_LOG = w.__VRM_NPC_EFFECT_LOG || [];
      w.__VRM_NPC_EFFECT_LOG.push({ event: 'mount', id: npc.id, species: npc.species, t: Date.now() });
      // Expose each animator keyed by NPC id so CDP can inspect mixer/actions per NPC.
      w.__VRM_NPC_DEBUG = w.__VRM_NPC_DEBUG || {};
      w.__VRM_NPC_DEBUG[npc.id] = { animator, vrm, species: npc.species };
    }
    animator.init().catch((err) => {
      console.warn('[VRMNpcMesh] animator init failed:', err);
    });
    return () => {
      vrmAnimatorRef.current = null;
      if (typeof window !== 'undefined') {
        const w = window as any;
        w.__VRM_NPC_EFFECT_LOG = w.__VRM_NPC_EFFECT_LOG || [];
        w.__VRM_NPC_EFFECT_LOG.push({ event: 'cleanup', id: npc.id, species: npc.species, t: Date.now() });
        if (w.__VRM_NPC_DEBUG) delete w.__VRM_NPC_DEBUG[npc.id];
      }
      animator.dispose();
    };
  }, [vrm]);

  useFrame(({ clock, camera }, delta) => {
    const d = npcRef.current;
    const group = groupRef.current;
    if (!group) return;

    const dt = Math.min(delta, 0.1);

    // Entity interpolation — see GLBNpcMesh useFrame for the full
    // rationale. Render 1 tick behind real-time, lerp between the two
    // most recent server snapshots. Perfectly smooth visible motion,
    // ~200 ms latency (irrelevant for wandering NPCs).
    const nowMs = Date.now();
    const tsDelta = d.tsDelta > 0 ? d.tsDelta : 200;
    const elapsed = nowMs - d.ts;
    const alpha = d.ts === 0 ? 1 : Math.max(0, Math.min(1, elapsed / tsDelta));
    const renderX = (d.prevX + (d.x - d.prevX) * alpha) - HALF_W;
    const renderZ = (d.prevY + (d.y - d.prevY) * alpha) - HALF_H;

    // XZ AABB collision clamp for VRM NPC — mirrors GLBNpcMesh pattern.
    // Clamp AFTER entity-interpolation so visible position never enters a building.
    // entityHalf: chibi-type VRM NPCs use smaller radius than adult humanoids.
    const vrmNpcHalf = (npc.id.startsWith('milady-') || npc.id.startsWith('chibi-'))
      ? ENTITY_HALF_CHIBI
      : ENTITY_HALF_HUMANOID;
    const vrmClamped = clampMovement2D(simPos.current.x, simPos.current.z, renderX, renderZ, vrmNpcHalf);
    const prevX = simPos.current.x;
    const prevZ = simPos.current.z;
    simPos.current.x = vrmClamped.x;
    simPos.current.z = vrmClamped.z;
    // Track walkable surface Y for stair/ramp zones. Used below in group.position.y.
    const vrmNpcGroundY = vrmClamped.groundY;

    // Entity-vs-player push-out (Phase 4) — mirrors GLBNpcMesh inline push-out.
    // Guard: only active when a real player avatar is present ('player'/'npc').
    {
      const _cm = useGameStore.getState().controlMode;
      if (_cm === 'player' || _cm === 'npc') {
        const playerWX = avatarPositionRef.x - HALF_W;
        const playerWZ = avatarPositionRef.y - HALF_H;
        const npcHalf = (npc.id.startsWith('milady-') || npc.id.startsWith('chibi-')) ? ENTITY_HALF_CHIBI : ENTITY_HALF_HUMANOID;
        const combinedHalf = npcHalf + ENTITY_HALF_HUMANOID;
        const dvx = simPos.current.x - playerWX;
        const dvz = simPos.current.z - playerWZ;
        const distSq = dvx * dvx + dvz * dvz;
        if (distSq > 0 && distSq < combinedHalf * combinedHalf) {
          const dist = Math.sqrt(distSq);
          const push = combinedHalf - dist;
          simPos.current.x += (dvx / dist) * push;
          simPos.current.z += (dvz / dist) * push;
        }
      }
    }

    group.position.x = simPos.current.x;
    group.position.z = simPos.current.z;

    const isMoving = d.direction !== 'idle' && !d.isDead;
    const frame = Math.floor(clock.elapsedTime * 60);

    _springLodCamPos.set(camera.position.x, camera.position.y, camera.position.z);
    const vrmTerrainDx = group.position.x - _springLodCamPos.x;
    const vrmTerrainDz = group.position.z - _springLodCamPos.z;
    const vrmTerrainDistSq = vrmTerrainDx * vrmTerrainDx + vrmTerrainDz * vrmTerrainDz;
    const isPossessedPlayerNpc =
      d.id === PLAYER_NPC_ID &&
      useGameStore.getState().controlMode === 'npc';
    // Raycast terrain at distance-based cadence. Position still updates every
    // frame; only the floor-height sample is throttled for far NPCs.
    const terrainMod =
      vrmTerrainDistSq < NPC_LOD_NEAR_DIST_SQ ? 3 :
      vrmTerrainDistSq < NPC_LOD_VERY_FAR_DIST_SQ ? 6 :
      12;
    if ((frame + seed) % terrainMod === 0) {
      const terrainY = getTerrainY(group.position.x, group.position.z, threeScene);
      currentTerrainY.current += (terrainY - currentTerrainY.current) * 0.3;
    }

    // Jump + bob support for the possessed player NPC (PLAYER_NPC_ID, controlMode='npc').
    // Mirrors GLBNpcMesh exactly, with two differences:
    //   1. No `- pivotOffsetY` — VRM feet are at Y=0 per spec; no pivot correction needed.
    //   2. No `+ 2` baseline — player-avatar.tsx VRM branch confirms VRM feet sit flush on
    //      currentTerrainY with no extra offset.
    // Bob frequency (4.0) and amplitude (0.6) match GLBNpcMesh so jump feels identical.
    const airborne = isPossessedPlayerNpc &&
                     (jumpState.phase !== 'grounded' && jumpState.phase !== 'charging'
                   || jumpState.playerAltitude > 0);
    const jumpY = isPossessedPlayerNpc
      ? (jumpState.heightOffset + jumpState.playerAltitude)
      : 0;
    const bob = (isMoving && !airborne) ? Math.sin(clock.elapsedTime * 4.0 + seed) * 0.6 : 0;
    // effectiveFloorY: when vrmNpcGroundY > currentTerrainY (NPC is on a stair/ramp
    // collider zone), use the walkable surface height so feet ride the stair.
    const vrmNpcEffectiveFloorY = Math.max(currentTerrainY.current, vrmNpcGroundY);
    group.position.y = vrmNpcEffectiveFloorY + bob + jumpY;

    // VRM facing — LOCKED 2026-04-25 (re-locked 2026-04-26 after PR #65 regression).
    // The Milady VRMs in this project are rigged with Mixamo bones facing -Z natively
    // — opposite of the VRM 0.x spec (+Z forward). rotateVRM0() then over-rotates them,
    // so body world-forward at outer.rotation.y=θ ends up at (sin θ, cos θ).
    // Solving for body forward = (vx, vz): θ = atan2(vx, vz). NO NEGATIONS.
    // User confirmed live 2026-04-25; PR #65 "resolve to master version" reverted to
    // atan2(vx, -vz) which makes Miladys walk backwards. DO NOT change this without
    // a screenshot proving otherwise — see .claude/memory/feedback_vrm_facing_formula.md.
    const vx = simPos.current.x - prevX;
    const vz = simPos.current.z - prevZ;
    const velMagSq = vx * vx + vz * vz;
    if (velMagSq > 0.1 && d.direction !== 'idle') {
      const targetRot = Math.atan2(vx, vz);
      let diff = targetRot - currentRotY.current;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      currentRotY.current += diff * Math.min(1, 12 * dt);
    }

    // Pitch — possessed-player NPC leans back while ascending so the
    // swim/fly pose reads as "swimming upward". See player-avatar.tsx
    // for full rationale. Wandering NPCs are never airborne so this
    // stays at 0 for them automatically.
    const phaseAscendingPitch = isPossessedPlayerNpc &&
      (jumpState.phase === 'launch' || jumpState.phase === 'quick');
    const PITCH_ASCEND_NPC = -Math.PI / 3;
    const pitchTargetNpc = phaseAscendingPitch ? PITCH_ASCEND_NPC : 0;
    currentPitchX.current += (pitchTargetNpc - currentPitchX.current) * 0.15;

    group.rotation.order = 'YXZ';
    group.rotation.y = currentRotY.current;
    group.rotation.x = currentPitchX.current;

    // PERF: split mixer (60Hz unconditional) from spring-bone physics (15Hz).
    // Re-locked 2026-04-26 after PR #65 reverted to the early-return pattern that
    // killed the entire useFrame on odd mid-distance frames — including the
    // mixer.update() — causing keyframe animation to run at 30Hz with visible jank.
    //
    // The mixer MUST run every frame at 60Hz (Nori parity). Spring-bone physics
    // is uniform 15Hz for all VRM NPCs as of 2026-05-11 (was tiered 10/20Hz by
    // camera distance; flattened with the culling removal — see 3dStructure.md
    // §5d). Walking NPCs and idle NPCs use the same rate now; 15Hz is below the
    // perceptual hair/tail-lag threshold at typical viewing distance.
    if (!vrmAnimatorRef.current && frame % 120 === seed % 120) {
      console.warn('[VRMNpcMesh] animator ref null at update time', npc.id, npc.species);
    }

    const animator = vrmAnimatorRef.current;
    if (animator) {
      // Squat / swim / fly pipeline for the possessed-player NPC.
      // Mirrors the VRM player-avatar branch — surfaceClip is selected
      // every frame from jumpState.phase + airborne and only re-set
      // when it changes.
      //
      //   CHARGING (phase==='charging'): surfaceClip='squat'.
      //   AIRBORNE (any phase): surfaceClip='flying' for Tekk else
      //     'swimming'. Body pitch (computed above) leans back while
      //     ascending so the swim pose reads as upward motion;
      //     descending leaves pitch=0 so the same pose reads as
      //     forward/horizontal swim.
      //   GROUNDED non-charging: surfaceClip='idle'.
      //
      // Wandering NPCs (isPossessedPlayerNpc=false) skip this entire
      // block — airborne is always false for them above.
      if (isPossessedPlayerNpc) {
        const phase = jumpState.phase;
        const phaseCharging = phase === 'charging';
        const swimClip: AnimName = d.species === 'tekk' ? 'flying' : 'swimming';
        const desiredClip: AnimName =
          phaseCharging ? 'squat'
          : airborne    ? swimClip
          :               'idle';
        if (desiredClip !== lastSurfaceClipRef.current) {
          animator.setSurfaceClip(desiredClip);
          lastSurfaceClipRef.current = desiredClip;
        }
      }
      springDeltaAccRef.current += dt;
      // While charging OR airborne, gate the locomotion crossfade to
      // surfaceClip (squat/jump/swim/fly) by reporting isMoving=false.
      // Walk on the ground when neither is true; never "walking while
      // charging" or "walking through the air" if movement input is
      // held mid-leap.
      const npcLockIdle = isPossessedPlayerNpc &&
        (airborne || jumpState.phase === 'charging');

      // Compute distance² to camera ONCE — drives both Phase 1.5 far-gate
      // and the existing Win B spring-bone distance LOD. Zero per-frame
      // allocations via the module-scope _springLodCamPos scratch.
      const _springDistSq = vrmTerrainDistSq;

      // PHASE 1.5 — Far-NPC mixer + spring-bone gate (2026-05-22).
      // Past 5000 wu (distSq > 25M) the VRM is far enough from the camera
      // that its frame-by-frame animation is imperceptible; the cost of
      // AnimationMixer.update + spring physics dominates the main-thread
      // long-task budget. Skipping both entirely for far NPCs is the only
      // CPU saving Phase 1 (Three.js frustum culling) didn't cover —
      // Three.js culling only skips the GPU draw, not the per-frame JS
      // tick. Pose freezes at last value; resumes seamlessly when player
      // approaches. springDeltaAccRef keeps accumulating dt so spring
      // resumes with the correct delta on re-entry.
      const isFarNpc = _springDistSq > NPC_LOD_FAR_DIST_SQ;

      if (!isFarNpc) {
        animator.updateMixerOnly(dt, npcLockIdle ? false : isMoving);

        // WIN B — Spring-bone distance LOD (perf-audit-2026-05-22 Q4)
        // Close NPCs (<2500wu) run at 30Hz — better perceived quality for
        // the character the user is staring at. Far NPCs (>6000wu) drop to
        // ~7.5Hz — imperceptible at range.
        const springMod =
          _springDistSq < 6_250_000  ? 2 :   // < 2500wu → 30Hz
          _springDistSq < 36_000_000 ? 4 :   // < 6000wu → 15Hz
                                       8;    // ≥ 6000wu → ~7.5Hz
        if ((frame + seed) % springMod === 0) {
          const acc = Math.min(springDeltaAccRef.current, 0.1);
          animator.updateSpringOnly(acc);
          springDeltaAccRef.current = 0;
        }
      }
    }
  });

  return (
    <group ref={groupRef}>
      {/* VRM scale + foot-ground offset: per-VRM auto-fit (computeVRMNpcScale).
          Milady (1.6m, feet at Y=0)        → scale ~112, offsetY ~0.
          Hermes/Tekk (Mixamo, hips at Y=0) → scale ~0.93, offsetY ~+87. */}
      <primitive
        object={vrm.scene}
        scale={[vrmRenderScale, vrmRenderScale, vrmRenderScale]}
        position={[0, vrmFootOffsetY, 0]}
      />
      {/* Bio-luminescent NPC label — same rig as GLBNpcMesh. */}
      <WorldLabel divRef={labelRef}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            transform: 'translateY(-50%)',
            ['--label-phase' as string]: String(Math.round(idToSeed(npc.id)) % 10 / 10),
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-fraunces, "Cormorant Garamond", "Spectral", Georgia, serif)',
              fontVariationSettings: '"opsz" 9',
              fontWeight: 480,
              fontSize: 13,
              color: '#effeff',
              padding: '5px 11px 6px',
              borderRadius: 999,
              background: 'rgba(8, 18, 32, 0.85)',
              border: '1px solid rgba(120, 220, 255, 0.45)',
              boxShadow: '0 0 14px rgba(100,230,255,0.45), 0 0 38px -4px rgba(80,220,255,0.35), inset 0 0 10px rgba(120,200,240,0.18)',
              whiteSpace: 'nowrap',
              letterSpacing: '0.01em',
              lineHeight: 1,
              userSelect: 'none',
              animation: 'bio-drift 5.4s ease-in-out infinite',
              animationDelay: 'calc(var(--label-phase, 0) * -5.4s)',
            }}
          >
            {npc.isOpenClaw && (
              <span
                className="oc-status-dot"
                title="OpenClaw agent"
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#4ade80',
                  marginRight: 6,
                  verticalAlign: 'middle',
                  boxShadow: '0 0 8px rgba(74,222,128,0.8)',
                }}
              />
            )}
            {npc.name}
          </div>
          <div
            style={{
              width: 1,
              height: 38,
              backgroundImage: 'linear-gradient(rgba(140,240,255,0.78) 50%, transparent 50%)',
              backgroundSize: '1px 6px',
              backgroundRepeat: 'repeat-y',
              boxShadow: '0 0 6px rgba(120,240,255,0.55)',
              marginBottom: 2,
            }}
          />
          {/* Pulsing anchor dot — glow lives on ::after pseudo (compositor-safe) */}
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
    </group>
  );
});

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

import { useLodStore } from '@/stores/lod';
import { NpcProxy } from '@/lib/three/remote-player-proxy';

// Per-NPC entry — subscribes to its own LOD tier so a single NPC flipping
// full↔proxy doesn't re-render any sibling. Mirrors the player-side
// `RemotePlayerEntry` in `remote-players.tsx`.
const NpcEntry = memo(function NpcEntry({ npc }: { npc: NpcSpriteState }) {
  const isFull = useLodStore((s) => s.fullSet.has(npc.id));
  // The possessed player NPC (NPC mode) always renders full — the LOD
  // orchestrator excludes it from the candidate pool, so isFull will be
  // false unless we force-allow here. Player input drives that mesh, so
  // demoting it to a capsule mid-play is unacceptable.
  const forceFull = npc.id === PLAYER_NPC_ID;
  const showFull = forceFull || isFull;

  if (!showFull) {
    return <NpcProxy npc={npc} />;
  }

  const regEntry = MODEL_REGISTRY[npc.species as keyof typeof MODEL_REGISTRY];
  if (regEntry?.avatar_type === 'vrm') {
    return (
      <Suspense fallback={null}>
        <VRMNpcMesh npc={npc} />
      </Suspense>
    );
  }
  return <GLBNpcMesh npc={npc} />;
});

export default function ArenaNpcs() {
  // useShallow on the npcs array — combined with NPC-identity preservation in
  // updateFromSnapshot (see stores/npc.ts npcFieldsEqual), this skips re-renders
  // entirely when no NPC actually changed between SSE snapshots. Previously,
  // every snapshot rebuilt the array and forced ArenaNpcs to re-render +
  // re-evaluate npcs.filter(); useShallow checks element-by-element so an
  // unchanged 18-NPC array stays referentially equal for React.
  const allNpcs = useNpcStore(useShallow((s) => s.npcs));
  const controlMode = useGameStore((s) => s.controlMode);

  // Filter out the dedicated player NPC when not in NPC mode.
  // spawnPlayerNpc() places PLAYER_NPC_ID at world center (3840,3840) for NPC-mode
  // possession. In agent modes ('player' / 'autonomous') this NPC must not render —
  // it obscures the bazaar / town-center buildings at the world center.
  const unposessedNpcs = controlMode === 'npc'
    ? allNpcs
    : allNpcs.filter((n) => n.id !== PLAYER_NPC_ID);

  const npcs = unposessedNpcs;

  return (
    <Suspense fallback={null}>
      <group>
        {npcs.map((npc) => (
          <NpcEntry key={npc.id} npc={npc} />
        ))}
      </group>
    </Suspense>
  );
}
