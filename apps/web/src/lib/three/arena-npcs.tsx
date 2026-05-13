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
import { useVRMInstance, disposeVRMInstance, preloadVRMBytes } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator, preloadMixamoClips } from '@/lib/three/vrm-character-animator';
import { MODEL_REGISTRY, getAnimatorIdByPath } from '@/lib/three/agent-model-registry';
// Camera-cull import REMOVED 2026-05-11 — all NPC/label culling deleted per user
// directive ("remove all the culling completely it ruins the game"). The helper
// still ships for BumperShellsPlayer but is not used in the open world scene.

// ---------------------------------------------------------------------------
// GLB-based NPC renderer with terrain raycasting
// NPCs walk on the actual terrain surface instead of a static Y level
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
// LERP_SPEED controls how fast currentPos catches up to targetPos from server.
// 2026-04-25 (re-locked 2026-04-26 after PR #65 reverted): server ticks at 5Hz
// (200ms) with baseStep=44 → 8.8wu per snapshot. LERP_SPEED=1.5 means
// exp(-1.5·0.2) = 0.74 → 26% convergence per snapshot.
// Steady-state lag = 8.8/0.26 ≈ 34wu (about 0.7 m at world scale), not visible.
// What IS visible is the smoothness — small per-tick delta + slow lerp = no
// burst-stop pattern, motion reads as continuous like Nori (who is static).
// DO NOT raise this back to 5 — that's the jittery value.
const LERP_SPEED = 1.5;
// TARGET_NPC_HEIGHT: desired world-unit height for wandering NPCs.
// Previously NPC_SCALE=50 was a flat multiplier applied to all species; measured
// heights were 30-36 wu because species GLBs have native heights of 0.6-0.7 units
// (0.65 × 50 = 32.5). Per-model normalization (computeNpcScale below) replaces the
// flat multiplier — each species is measured at mount time and scaled to this target.
// Pass 1 (2026-04-16): reduced 120→75. Pass 2 (2026-04-16): reduced 75→45.
// User tested pass 1 and the lobster NPC was still too big relative to buildings (800 wu).
// 45 wu gives a ~1:17.8 ratio vs 800-wu building — target was 1:16–1:20.
const TARGET_NPC_HEIGHT = 45;

// Sanity clamp for per-species computed scale (mirrors arena-location-npcs logic).
// MAX = TARGET_NPC_HEIGHT/0.5 = 90 — any computed scale > 90 implies native above-pivot
// height < 0.5 units, which means only tiny props/accessories are non-skinned geometry.
// In that case we fall back to a safe default scale of TARGET_NPC_HEIGHT (assumes
// visual body native height ≈ 1.0 unit, which is true for the humanoid species).
const NPC_SCALE_CLAMP_MIN = TARGET_NPC_HEIGHT / 200; // ~0.225
const NPC_SCALE_CLAMP_MAX = TARGET_NPC_HEIGHT / 0.5; // 90

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

// Preload all species GLBs at module level (11 models, ~3-4 MB total) so
// wandering NPCs don't cause network+parse pops when they first appear.
Object.values(SPECIES_MODEL).forEach(({ path }) => useGLTF.preload(path));

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
// FIX: replace flat constant at the primitive with per-VRM target-height auto-
// fit. Measure each VRM's natural bbox once at scale=1 and compute
// scale = VRM_NPC_TARGET_HEIGHT_WU / bbox.y. Milady (bbox≈1.6) → 112. Hermes
// (bbox≈194) → 0.92. Both land at the same on-screen height.
const VRM_NPC_SCALE = 112;                    // legacy fallback (picker, any caller importing this)
const VRM_NPC_TARGET_HEIGHT_WU = 179.2;       // 1.6m Milady × 112 — default on-screen height

// Per-species target overrides. The default fits the WHOLE bbox into 179.2 wu,
// which undersizes characters whose bbox is inflated by props that aren't part
// of the body silhouette (wings, big hair, capes). Override the target for
// those species so the BODY reads at the right size and the prop overshoots.
//
// Tekk has mechanical fan-wings that extend ~25% above his head — without an
// override his body+wings cluster at 179.2 wu, leaving the body itself at
// ~150 wu (visibly shorter than Mira/Cyrus/Milady).
const SPECIES_TARGET_HEIGHT_WU: Record<string, number> = {
  tekk: 230,  // 179.2 × 1.28 — body lands at ~Milady height, wings fan above
};

/**
 * Compute the per-VRM render scale + foot-grounding offsetY so the avatar
 * stands at VRM_NPC_TARGET_HEIGHT_WU on screen with feet at world Y=0,
 * regardless of the source rig's pivot convention.
 *
 *  - Milady (VRoid spec): feet at local Y=0, bbox.min.y ≈ 0 → offsetY ≈ 0.
 *  - Hermes / Tekk (Mixamo rig): HIPS at local Y=0, feet at Y≈-95cm.
 *    Without the offset, scale alone leaves the feet at world Y=-87 (buried).
 *
 * Mutates vrm.scene.scale during measurement and restores it before returning.
 */
function computeVRMNpcScale(
  vrm: { scene: THREE.Object3D } | null | undefined,
  species?: string,
): { scale: number; offsetY: number } {
  if (!vrm) return { scale: VRM_NPC_SCALE, offsetY: 0 };
  const prev = vrm.scene.scale.clone();
  vrm.scene.scale.setScalar(1);
  vrm.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  vrm.scene.scale.copy(prev);
  vrm.scene.updateMatrixWorld(true);
  const target =
    (species && SPECIES_TARGET_HEIGHT_WU[species]) || VRM_NPC_TARGET_HEIGHT_WU;
  const scale = size.y > 0 ? target / size.y : VRM_NPC_SCALE;
  // Lift the model so its lowest point (feet) lands at the primitive's local
  // y=0. For Mixamo-rigged VRMs box.min.y is negative (feet below hips/pivot),
  // so offsetY = -box.min.y * scale > 0.
  const offsetY = -box.min.y * scale;
  return { scale, offsetY };
}

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
preloadVRMBytes('/avatars/milady-official-2.vrm');
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
const GLBNpcMesh = memo(function GLBNpcMesh({ npc }: { npc: NpcSpriteState }) {
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

  // WorldLabelsOverlay label — name tag, always visible (no cull, 2026-05-11).
  // The projection useFrame still hides via NDC z>1 when the anchor is behind
  // the near plane, which is correct projection math — not "culling".
  const { divRef: labelRef } = useWorldLabel({
    id: `glb-npc-label-${npc.id}`,
    anchorRef: groupRef,
    offset: [0, 100, 0],
    initialVisible: true,
  });

  const targetPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
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

    // Disable frustum culling on every node in the clone.
    // GLB NPCs with SkinnedMesh (animated crabs, hermit crabs, etc.) have their
    // bounding spheres computed from the bind pose (T-pose). When the camera is
    // close to the NPC or looking steeply down, the animated geometry extends
    // outside the bind-pose sphere and Three.js wrongly culls the mesh, making
    // the NPC disappear at close range. frustumCulled=false prevents this.
    c.traverse((obj) => { obj.frustumCulled = false; });

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

    // Update target XZ position
    targetPos.current.set(d.x - HALF_W, 0, d.y - HALF_H);

    // Lerp + set group.position unconditionally so culled NPCs still track
    // their real world position. Previously group.position was only updated
    // inside the visible branch — a far-culled NPC's group stayed at (0,0,0)
    // throughout the culled window, causing users to see NPCs "teleport in
    // at origin" when the camera panned toward them. Capture pre-lerp x/z
    // for the velocity-based facing calculation below.
    const glbPrevX = currentPos.current.x;
    const glbPrevZ = currentPos.current.z;
    currentPos.current.x += (targetPos.current.x - currentPos.current.x) * (1 - Math.exp(-LERP_SPEED * dt));
    currentPos.current.z += (targetPos.current.z - currentPos.current.z) * (1 - Math.exp(-LERP_SPEED * dt));
    group.position.x = currentPos.current.x;
    group.position.z = currentPos.current.z;

    // 2026-05-11 — All NPC culling removed per user directive.
    // Previously: distance-cull (hide group past 10000² wu), behind-camera cull
    // (hide label when anchor outside frustum), occlusion raycast (hide label
    // when blocked by building). Every layer caused visible bugs (NPCs popping
    // in/out, labels flashing, race conditions with React.memo). The user
    // explicitly said "let's remove all the culling completely it ruins the
    // game" 2026-05-11. NDC z>1 hide in WorldLabelsOverlay still applies
    // (correct projection math, not culling).
    group.visible = true;
    const frame = Math.floor(clock.elapsedTime * 60);

    // Raycast to find terrain surface Y (every 3rd frame to save perf).
    // Use (frame + seed) % 3 to stagger across NPCs — prevents all NPCs from
    // raycasting on the same frame tick (which would spike the CPU every 150ms).
    // Use clock.elapsedTime (already available) instead of Date.now() to avoid
    // a syscall allocation in the hot path.
    if ((frame + seed) % 3 === 0) {
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
    const isPossessedPlayerNpc =
      d.id === PLAYER_NPC_ID &&
      useGameStore.getState().controlMode === 'npc';
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
    group.position.y = currentTerrainY.current + 2 + bob + jumpY - pivotOffsetY;

    // Direction rotation. Possessed NPC uses server-provided facingAngle for
    // smooth camera-relative input. Autonomous wanderers use per-frame velocity
    // (more accurate than the discrete server direction, avoids "walking
    // backwards" during 180° direction flips — see VRMNpcMesh for full rationale).
    let targetRot: number | null = null;
    if (d.facingAngle != null) {
      targetRot = d.facingAngle;
    } else {
      const glbVx = currentPos.current.x - glbPrevX;
      const glbVz = currentPos.current.z - glbPrevZ;
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

    if (useNewSystem && charAnimator) {
      // Universal character animation system — handles all secondary motion internally
      charAnimator.update(animGroup, clock.elapsedTime, dt, isMoving);
    } else if (lobsterAnimator) {
      // Legacy lobster skeletal animation
      const suggestedState = resolveAnimState({
        isDead: d.isDead,
        inCombat: false,
        combatAction: null,
        direction: d.direction,
        inConversation: false,
      });
      lobsterAnimator.update(dt, clock.elapsedTime, suggestedState, d.direction);

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
      if (isMoving) {
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
      {/* Name label — WorldLabelsOverlay manages projection + DOM writes.
          offset [0,100,0]: 100wu clearance above TARGET_NPC_HEIGHT=45. */}
      <WorldLabel divRef={labelRef}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: 'rgba(8, 20, 38, 0.78)',
            border: '1px solid rgba(100, 200, 255, 0.25)',
            borderRadius: 6,
            padding: '2px 8px',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
        >
          <span
            style={{
              color: '#fff',
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: '0.03em',
            }}
          >
            {npc.name}
          </span>
          {npc.isOpenClaw && (
            <span
              style={{
                background: 'rgba(16, 185, 129, 0.85)',
                color: '#fff',
                fontWeight: 700,
                fontSize: 9,
                borderRadius: 4,
                padding: '1px 4px',
                letterSpacing: '0.04em',
              }}
            >
              OpenClaw
            </span>
          )}
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
const VRMNpcMesh = memo(function VRMNpcMesh({ npc }: { npc: NpcSpriteState }) {
  const groupRef = useRef<THREE.Group>(null!);
  const { scene: threeScene } = useThree();
  const npcRef = useRef(npc);
  npcRef.current = npc;

  // Occluder-tag useLayoutEffect removed 2026-05-11 — see GLBNpcMesh.

  // idToSeed returns float — round to int so (frame + seed) % 3 uses integer arithmetic.
  const seed = useMemo(() => Math.round(idToSeed(npc.id)), [npc.id]);

  // WorldLabelsOverlay label — always visible (no cull, 2026-05-11).
  // NDC z>1 hide in WorldLabelsOverlay handles behind-near-plane projection.
  const { divRef: labelRef } = useWorldLabel({
    id: `vrm-npc-label-${npc.id}`,
    anchorRef: groupRef,
    offset: [0, 100, 0],
    initialVisible: true,
  });

  const targetPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentRotY = useRef(VRM_DIR_ROTATION.idle);
  const currentTerrainY = useRef(-2);
  // PERF: accumulated spring delta — we tick spring bones at 30Hz (every 2nd frame for
  // idle NPCs) by summing frame deltas and flushing them in a single vrm.update() call.
  // The verlet integrator is time-step independent so passing 2× dt is physically correct.
  const springDeltaAccRef = useRef(0);

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
    // Defensive re-apply of frustumCulled=false on every node in vrm.scene.
    // vrm-loader already does this once per path at load, but this guards
    // against any three-vrm / three-stdlib / post-processing pass that
    // toggles frustumCulled back on. Cheap (no-op if already false).
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
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

    // Update target XZ position
    targetPos.current.set(d.x - HALF_W, 0, d.y - HALF_H);

    // Lerp + set group.position unconditionally (same reasoning as GLBNpcMesh):
    // culled NPCs still need their group at the correct world position so that
    // on un-cull they don't flash in at origin.
    const prevX = currentPos.current.x;
    const prevZ = currentPos.current.z;
    currentPos.current.x += (targetPos.current.x - currentPos.current.x) * (1 - Math.exp(-LERP_SPEED * dt));
    currentPos.current.z += (targetPos.current.z - currentPos.current.z) * (1 - Math.exp(-LERP_SPEED * dt));
    group.position.x = currentPos.current.x;
    group.position.z = currentPos.current.z;

    // 2026-05-11 — All VRM NPC culling removed per user directive
    // ("remove all the culling completely it ruins the game"). Mirrors GLBNpcMesh.
    const isMoving = d.direction !== 'idle' && !d.isDead;
    const frame = Math.floor(clock.elapsedTime * 60);
    group.visible = true;

    // Raycast terrain every 3rd frame (staggered by seed to avoid per-frame spikes)
    if ((frame + seed) % 3 === 0) {
      const terrainY = getTerrainY(group.position.x, group.position.z, threeScene);
      currentTerrainY.current += (terrainY - currentTerrainY.current) * 0.3;
    }

    // Jump + bob support for the possessed player NPC (PLAYER_NPC_ID, controlMode='npc').
    // Mirrors GLBNpcMesh exactly, with two differences:
    //   1. No `- pivotOffsetY` — VRM feet are at Y=0 per spec; no pivot correction needed.
    //   2. No `+ 2` baseline — player-avatar.tsx VRM branch confirms VRM feet sit flush on
    //      currentTerrainY with no extra offset.
    // Bob frequency (4.0) and amplitude (0.6) match GLBNpcMesh so jump feels identical.
    const isPossessedPlayerNpc =
      d.id === PLAYER_NPC_ID &&
      useGameStore.getState().controlMode === 'npc';
    const airborne = isPossessedPlayerNpc &&
                     (jumpState.phase !== 'grounded' && jumpState.phase !== 'charging'
                   || jumpState.playerAltitude > 0);
    const jumpY = isPossessedPlayerNpc
      ? (jumpState.heightOffset + jumpState.playerAltitude)
      : 0;
    const bob = (isMoving && !airborne) ? Math.sin(clock.elapsedTime * 4.0 + seed) * 0.6 : 0;
    group.position.y = currentTerrainY.current + bob + jumpY;

    // VRM facing — LOCKED 2026-04-25 (re-locked 2026-04-26 after PR #65 regression).
    // The Milady VRMs in this project are rigged with Mixamo bones facing -Z natively
    // — opposite of the VRM 0.x spec (+Z forward). rotateVRM0() then over-rotates them,
    // so body world-forward at outer.rotation.y=θ ends up at (sin θ, cos θ).
    // Solving for body forward = (vx, vz): θ = atan2(vx, vz). NO NEGATIONS.
    // User confirmed live 2026-04-25; PR #65 "resolve to master version" reverted to
    // atan2(vx, -vz) which makes Miladys walk backwards. DO NOT change this without
    // a screenshot proving otherwise — see .claude/memory/feedback_vrm_facing_formula.md.
    const vx = currentPos.current.x - prevX;
    const vz = currentPos.current.z - prevZ;
    const velMagSq = vx * vx + vz * vz;
    if (velMagSq > 0.1 && d.direction !== 'idle') {
      const targetRot = Math.atan2(vx, vz);
      let diff = targetRot - currentRotY.current;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      currentRotY.current += diff * Math.min(1, 12 * dt);
    }
    group.rotation.y = currentRotY.current;

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
      springDeltaAccRef.current += dt;
      animator.updateMixerOnly(dt, isMoving);
      const springMod = 4; // 15Hz — see comment block above
      if ((frame + seed) % springMod === 0) {
        const acc = Math.min(springDeltaAccRef.current, 0.1);
        animator.updateSpringOnly(acc);
        springDeltaAccRef.current = 0;
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
      {/* Name label — WorldLabelsOverlay manages projection + DOM writes.
          offset [0,100,0]: 100wu clearance, matches GLBNpcMesh. */}
      <WorldLabel divRef={labelRef}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: 'rgba(8, 20, 38, 0.78)',
            border: '1px solid rgba(100, 200, 255, 0.25)',
            borderRadius: 6,
            padding: '2px 8px',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
        >
          <span
            style={{
              color: '#fff',
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: '0.03em',
            }}
          >
            {npc.name}
          </span>
          {npc.isOpenClaw && (
            <span
              style={{
                background: 'rgba(16, 185, 129, 0.85)',
                color: '#fff',
                fontWeight: 700,
                fontSize: 9,
                borderRadius: 4,
                padding: '1px 4px',
                letterSpacing: '0.04em',
              }}
            >
              OpenClaw
            </span>
          )}
        </div>
      </WorldLabel>
    </group>
  );
});

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
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
  // spawnPlayerNpc() places PLAYER_NPC_ID at world center (2560,2560) for NPC-mode
  // possession. In agent modes ('player' / 'autonomous') this NPC must not render —
  // it obscures the bazaar / town-center buildings at the world center.
  const npcs = controlMode === 'npc'
    ? allNpcs
    : allNpcs.filter((n) => n.id !== PLAYER_NPC_ID);

  return (
    <Suspense fallback={null}>
      <group>
        {npcs.map((npc) => {
          // Route to VRM renderer if the species maps to a VRM entry in the registry.
          // All other species fall through to the existing GLB renderer.
          const regEntry = MODEL_REGISTRY[npc.species as keyof typeof MODEL_REGISTRY];
          if (regEntry?.avatar_type === 'vrm') {
            return (
              <Suspense key={npc.id} fallback={null}>
                <VRMNpcMesh npc={npc} />
              </Suspense>
            );
          }
          return <GLBNpcMesh key={npc.id} npc={npc} />;
        })}
      </group>
    </Suspense>
  );
}
