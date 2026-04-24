'use client';

import { useRef, useMemo, useEffect, useLayoutEffect, memo, Suspense } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF, Html } from '@react-three/drei';
import * as THREE from 'three';
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
import { jumpState } from '@/lib/three/jump-state';
import { useVRM, preloadVRM } from '@/lib/three/vrm-loader';
import { VRMCharacterAnimator, preloadMixamoClips } from '@/lib/three/vrm-character-animator';
import { MODEL_REGISTRY } from '@/lib/three/agent-model-registry';
import { anchorInFrontOfCamera } from '@/lib/three/utils/camera-cull';

// ---------------------------------------------------------------------------
// GLB-based NPC renderer with terrain raycasting
// NPCs walk on the actual terrain surface instead of a static Y level
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const LERP_SPEED = 5;
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
// bounding box via Box3.setFromObject which, for rigged GLBs with
// pre-skin parent transforms (transform1 scale ≈ 0.042, nurbsCircleMover
// scale ≈ 24.053 cancelling to ~1) reads the SKELETON extent rather than
// the actual rendered mesh extent. On hermitcrab that produced
// Species scale overrides calibrated AFTER the 2026-04-24 SkeletonUtils.clone fix.
// Before that fix the SkinnedMesh was bind-pose-only (bones bound to another
// instance), so old overrides (hermitcrab: 16) were calibrated against a
// frozen pose. Now bones animate correctly and the extent is larger — values
// reduced to ~TARGET_NPC_HEIGHT=45 Y extent with Milady-comparable footprint.
const SPECIES_WANDER_SCALE_OVERRIDE: Partial<Record<string, number>> = {
  hermitcrab: 2,   // was 4 — user reports still "HUGE" after SkeletonUtils skeleton exposed full shell extent
  sweet_crab:  7.6, // unchanged — bbox 56×53×67 reads acceptable in-game
  lobster:     22, // was computed 40.17 — 278wu width too wide; 22 yields ~150wu width
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
// See player-pet.tsx VRM_DIR_ROTATION for verification.
const VRM_DIR_ROTATION: Record<string, number> = {
  down: Math.PI, up: 0, right: Math.PI / 2, left: -Math.PI / 2, idle: Math.PI,
};

// VRM_NPC_SCALE: target visual height ≈ 180 wu for wandering Milady NPCs (4× the
// 45wu lobster/crab baseline). VRM native height ~1.6m → scale 112 ⇒ 179.2 wu.
// Doubled twice on 2026-04-23 per user request: the 45-wu "match the lobster"
// target read as too small on screen, and the first 2× bump (scale 56 ⇒ 90 wu)
// still wasn't reading as the world's main cast. At scale 112 the Miladys are
// the dominant human-scale figures the town is built around. Registry scale=13
// remains for the SelectAgentCanvas picker (~21 wu pedestal surface). VRM feet
// are at Y=0 per spec — no pivot offset calculation needed (unlike GLBs).
const VRM_NPC_SCALE = 112;

// NPC distance LOD thresholds (squared world-unit distances from camera).
//
// Applied uniformly to ALL wandering NPCs (GLB + VRM). Past NPC_CULL_DIST, we
// flip the group's `visible = false` and early-return from useFrame — Three.js
// then skips the entire render subtree (including the drei <Html> label
// portal, which is the most expensive per-NPC DOM cost).
//
//   Close (< 800 wu):  full 60Hz — animator + raycast + label
//   Mid   (< 2500 wu): VRM animator drops to 30Hz (GLB animators stay 60Hz
//                      since they're much cheaper than VRM spring-bone physics)
//   Far   (≥ 2500 wu): group.visible = false → no render, no label, no
//                      matrix/animator/raycast/lerp work. Zero cost per frame.
//
// NPC_CULL_DIST raised 1200→2000 (2026-04-21 bug fix): Maple/Miu spawned
//   beyond the old 1200wu threshold and were T-posed permanently.
// NPC_CULL_DIST raised 2000→2500 (2026-04-23 bug fix):
//   The 5120×5120 world (−2560..+2560 in world space) places many wandering
//   NPCs 1300–2500wu from any reasonable camera position (camera is at y≈600,
//   not y=0, so even NPCs on adjacent quadrants are 1300–1600wu XZ-distance
//   from the player). With the old 2000wu threshold, NPCs in the outer half of
//   the world were culled whenever the player was anywhere near center — they
//   would appear briefly as the camera approached and disappear again as it
//   receded past the 2000wu sphere. 2500wu covers ~half the map radius
//   (diagonal half = 3620wu) and matches the fog's effective visibility cutoff,
//   keeping all nearby-quadrant NPCs live while the distant corners remain culled.
//   VRM half-rate band raised 800→1000 proportionally.
const NPC_CULL_DIST_SQ          = 10000 * 10000;  // see rationale below
const VRM_NPC_HALF_RATE_DIST_SQ = 1000 * 1000;

// 2026-04-24: NPC_CULL_DIST_SQ widened 2500²→10000² (effectively disabled).
// The old 2500wu sphere caused two visible bugs on a 5120wu map:
//   1. Building residents on the far side of the ring (~2100wu from center)
//      would be culled whenever the camera was on the opposite side — their
//      group.position never got set, and they stayed invisible at (0,0,0)
//      even after they should have reappeared.
//   2. Crustacean wanderers (Driftwood/Marlin/Riptide) wander through the
//      whole town ring and crossed the 2500wu threshold routinely as the
//      user rotated the camera — their avatars flickered in and out despite
//      their labels being shown.
// 13 GLB NPCs (10 building residents + 3 wanderers) is a bounded set that
// can all render all the time without visible perf degradation. The VRM and
// GLB cull constants now match — neither far-culls in normal camera ranges.
const VRM_NPC_CULL_DIST_SQ      = NPC_CULL_DIST_SQ;

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
//   Maple → milady_official_3
//   Ash   → milady_official_4
// Only official_7/8 were preloaded before — official_2/3/4 cold-started, delaying
// animator.init() by a full network round-trip and leaving Vivi/Maple/Ash in T-pose
// until after their Suspense resolved AND the clip loads completed. Now all 5 are
// preloaded at module scope so they are hot when the Suspense boundaries resolve.
preloadVRM('/avatars/milady-official-2.vrm');
preloadVRM('/avatars/milady-official-3.vrm');
preloadVRM('/avatars/milady-official-4.vrm');
preloadVRM('/avatars/milady-official-7.vrm');
preloadVRM('/avatars/milady-official-8.vrm');
preloadMixamoClips();

// Module-scope scratch for getWorldPosition in behind-camera cull checks.
// Shared by GLBNpcMesh + VRMNpcMesh — each call overwrites before reading.
const _npcAnchorWorldPos = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Single NPC using GLB model with terrain following
// ---------------------------------------------------------------------------
const GLBNpcMesh = memo(function GLBNpcMesh({ npc }: { npc: NpcSpriteState }) {
  const groupRef = useRef<THREE.Group>(null!);
  const animGroupRef = useRef<THREE.Group>(null!);
  // Layer 2 safety net: one-shot rendered-height hard cap applied after first render.
  // Catches any NPC that slips through computeNpcScale with a wrong pivot offset.
  const rescaleAppliedRef = useRef(false);
  // drei <Html> uses a React DOM portal outside the Three.js scene graph — setting
  // group.visible=false does NOT propagate to the DOM label. We imperatively sync
  // label display in useFrame so the label disappears with the mesh.
  const labelRef = useRef<HTMLDivElement>(null);
  const npcRef = useRef(npc);
  npcRef.current = npc;
  const { scene: threeScene } = useThree();
  // idToSeed returns a float (0..10). Convert to integer so (frame + seed) % N
  // uses integer arithmetic — float modulo with strict === 0 never fires.
  const seed = useMemo(() => Math.round(idToSeed(npc.id)), [npc.id]);

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
    // SkeletonUtils.clone rebinds SkinnedMesh.skeleton correctly — plain scene.clone(true)
    // shares bones across instances, which causes every instance after the first to render
    // bound to another NPC's skeleton (observed 2026-04-24: Driftwood/Marlin/Riptide + the
    // 10 building-canvas GLB NPCs silently invisible despite valid scene-graph state).
    // Safe for plain-Mesh models too — SkeletonUtils falls through to THREE clone.
    const c = SkeletonUtils.clone(scene);
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
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material?.dispose();
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

    // ── Distance-LOD cull ────────────────────────────────────────────────
    // Perf: every NPC's useFrame ran terrain raycasts (scene-traverse), matrix
    // updates, animator ticks, + a drei <Html> label that recomputes CSS per
    // frame — all paid regardless of whether the NPC was visible. With 18 NPCs
    // that dominated frametime even when most were off-camera. Now when an NPC
    // is past the far-cull threshold, we hide the group (Three.js skips its
    // entire render subtree, including the Html portal) and early-return —
    // zero per-frame work until the NPC re-enters the view bubble.
    const camDx = targetPos.current.x - camera.position.x;
    const camDz = targetPos.current.z - camera.position.z;
    const camDistSq = camDx * camDx + camDz * camDz;
    if (camDistSq > NPC_CULL_DIST_SQ) {
      // Always write — not transition-only. React memo shallow-compares the npc prop
      // object reference; every SSE snapshot rebuilds the array so memo re-renders on
      // every snapshot, re-applying the JSX inline `display: 'flex'` and clobbering
      // any `display: 'none'` that a previous cull frame wrote. The transition-only
      // guard (`if (group.visible)`) then skipped re-writing because group.visible was
      // already false, so the label stayed visible at distance indefinitely.
      // Always writing the style (cheap when value doesn't change) prevents the leak.
      group.visible = false;
      // drei <Html> DOM portal is outside the scene graph — visibility flag does NOT
      // propagate to the DOM div. Imperatively hide the label so it doesn't float
      // over empty world space while the 3D mesh is culled.
      const label = labelRef.current;
      if (label && label.style.display !== 'none') label.style.display = 'none';
      return;
    }
    group.visible = true;
    {
      // Behind-camera cull: drei <Html> does not hide when the 3D anchor is behind
      // the near plane — calculatePosition still emits a screen XY, producing ghost
      // labels. Dot-product test hides the label when the anchor is behind the camera.
      group.getWorldPosition(_npcAnchorWorldPos);
      const inFront = anchorInFrontOfCamera(_npcAnchorWorldPos, camera);
      const label = labelRef.current;
      if (!inFront) {
        if (label && label.style.display !== 'none') label.style.display = 'none';
      } else {
        if (label && label.style.display !== 'flex') label.style.display = 'flex';
      }
    }

    // Raycast to find terrain surface Y (every 3rd frame to save perf).
    // Use (frame + seed) % 3 to stagger across NPCs — prevents all NPCs from
    // raycasting on the same frame tick (which would spike the CPU every 150ms).
    // Use clock.elapsedTime (already available) instead of Date.now() to avoid
    // a syscall allocation in the hot path.
    const frame = Math.floor(clock.elapsedTime * 60);
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
      {/* Name label — OUTSIDE scaled group so position is in world units.
          100 = clearance above TARGET_NPC_HEIGHT=45 for the tallest species. */}
      {/* PERF: removed `distanceFactor={300}` — drei recomputes camera-distance
          scale + writes a new CSS transform every frame for each Html, which
          forces a full Layout pass per label per frame (~14% of frame budget
          across 18 NPC labels per the DevTools profile). Labels now display
          at constant CSS size; positioning still tracks the 3D point. */}
      <Html
        position={[0, 100, 0]}
        center
        style={{ pointerEvents: 'none' }}
        zIndexRange={[10, 100]}
      >
        {/* ref attached so useFrame can imperatively sync display with group.visible.
            drei <Html> is a DOM portal — Three.js visibility flag does NOT propagate.
            Default display:'none' so labels start hidden; useFrame opens them when
            the NPC enters range. This prevents ghost labels on the very first frames
            before useFrame has had a chance to evaluate distance — and also ensures
            that memo re-renders (which re-apply the JSX inline style) default to
            hidden rather than overwriting a cull-frame 'none' with 'flex'. */}
        <div
          ref={labelRef}
          style={{
            display: 'none',
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
      </Html>
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
  // Same DOM-portal caveat as GLBNpcMesh — drei <Html> is outside the scene graph.
  // Imperatively sync label display with group.visible in the cull block.
  const labelRef = useRef<HTMLDivElement>(null);
  const { scene: threeScene } = useThree();
  const npcRef = useRef(npc);
  npcRef.current = npc;

  // idToSeed returns float — round to int so (frame + seed) % 3 uses integer arithmetic.
  const seed = useMemo(() => Math.round(idToSeed(npc.id)), [npc.id]);

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

  // Load VRM — suspends until resolved (parent Suspense absorbs the throw)
  const vrm = useVRM(vrmPath);

  // Disable lookAt + expressionManager — wandering NPCs never use them (B4 2026-04-24).
  // Skips per-frame eye-tracking + morph-target work inside vrm.update().
  // null > undefined: signals "deliberately cleared"; no dispose() exists on either
  // class in three-vrm 3.5.2. Cache-sharing constraint: see @invariant in vrm-loader.ts.
  // useLayoutEffect (not useEffect): closes the 1-frame race where vrm.update() could
  // run before this assignment — useLayoutEffect fires before the browser paints / rAF.
  useLayoutEffect(() => {
    if (!vrm) return;
    (vrm as any).lookAt = null;
    (vrm as any).expressionManager = null;
  }, [vrm]);

  // Per-instance VRM animator — each NPC gets its own AnimationMixer
  const vrmAnimatorRef = useRef<VRMCharacterAnimator | null>(null);

  useEffect(() => {
    if (!vrm) return;
    // Defensive re-apply of frustumCulled=false on every node in vrm.scene.
    // vrm-loader already does this once per path at load, but this guards
    // against any three-vrm / three-stdlib / post-processing pass that
    // toggles frustumCulled back on. Cheap (no-op if already false).
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    const animator = new VRMCharacterAnimator(vrm);
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
    // Pass the NPC's defaultIdleClip so Miu/Kyoko start on their assigned emote.
    // Falls back to 'idle' inside init() when defaultIdleClip is undefined.
    const startClip = (npc.defaultIdleClip as Parameters<typeof animator.init>[0]) ?? 'idle';
    animator.init(startClip).catch((err) => {
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

    // ── Distance-LOD cull (same policy as GLBNpcMesh) ────────────────────
    // Far: hide group (Three.js skips render subtree + Html portal); return.
    // Mid: animator throttles to 30Hz. Close: full 60Hz animator + spring.
    const camDx = targetPos.current.x - camera.position.x;
    const camDz = targetPos.current.z - camera.position.z;
    const camDistSq = camDx * camDx + camDz * camDz;

    // VRM animator must tick even when the NPC is culled (invisible).
    // Bug: NPCs that spawn beyond NPC_CULL_DIST start with their mixer never ticked —
    // the idle AnimationAction was play()'d in init() but mixer.update() was skipped
    // by the early-return, leaving all normalized bone quaternions at identity = T-pose.
    // When the NPC eventually walks into range, the mixer cold-starts but the visual
    // delay is a jarring T-pose snap. Ticking every frame keeps animation warm.
    // Cost: ~0.3ms × 5 VRM NPCs when culled (spring bone math, no GPU work since
    // Three.js skips vertex skinning on invisible SkinnedMesh nodes).
    const isMoving = d.direction !== 'idle' && !d.isDead;
    const frame = Math.floor(clock.elapsedTime * 60);

    if (camDistSq > VRM_NPC_CULL_DIST_SQ) {
      // Tick mixer at reduced rate (every 4th frame) while culled — keeps anim warm
      // without burning full frame budget on off-screen NPCs.
      if ((frame + seed) % 4 === 0) {
        vrmAnimatorRef.current?.update(dt * 4, isMoving);
      }
      // Always write — not transition-only. See GLBNpcMesh cull block for full rationale:
      // memo re-renders restore JSX inline style; always-write prevents the leak.
      group.visible = false;
      // drei <Html> DOM portal — Three.js visibility flag does NOT propagate.
      const label = labelRef.current;
      if (label && label.style.display !== 'none') label.style.display = 'none';
      return;
    }
    group.visible = true;
    {
      // Behind-camera cull: drei <Html> does not hide when the 3D anchor is behind
      // the near plane — calculatePosition still emits a screen XY, producing ghost
      // labels. Dot-product test hides the label when the anchor is behind the camera.
      group.getWorldPosition(_npcAnchorWorldPos);
      const inFront = anchorInFrontOfCamera(_npcAnchorWorldPos, camera);
      const label = labelRef.current;
      if (!inFront) {
        if (label && label.style.display !== 'none') label.style.display = 'none';
      } else {
        if (label && label.style.display !== 'flex') label.style.display = 'flex';
      }
    }

    // Raycast terrain every 3rd frame (staggered by seed to avoid per-frame spikes)
    if ((frame + seed) % 3 === 0) {
      const terrainY = getTerrainY(group.position.x, group.position.z, threeScene);
      currentTerrainY.current += (terrainY - currentTerrainY.current) * 0.3;
    }

    // VRM feet are at Y=0 per spec — no pivot offset needed.
    group.position.y = currentTerrainY.current;

    // Facing: compute continuous rotation from actual per-frame velocity rather
    // than the server's discrete 'up'/'down'/'left'/'right' direction. The
    // discrete version snaps to 4 cardinals and lerps at 8*dt, so when a
    // pathfinding waypoint flips the direction 180°, the NPC's position moves
    // fast (LERP_SPEED=6 catch-up) while its body rotates slowly — producing a
    // visible "walking backwards" window for ~0.5s. Using the velocity vector
    // keeps body facing locked to movement direction at all times.
    //
    // VRM facing: Math.atan2(vx, -vz). FINAL LOCKED FORMULA 2026-04-24 —
    // user confirmed this after multiple sign-flip sessions. Matches the
    // player-pet.tsx line 345 formula exactly. DO NOT CHANGE — the negated
    // `-vx` variant makes Miladys walk backwards.
    const vx = currentPos.current.x - prevX;
    const vz = currentPos.current.z - prevZ;
    const velMagSq = vx * vx + vz * vz;
    // Movement threshold: need at least 0.5wu/frame of motion to trust velocity
    // as a facing signal. Below that it's likely sub-pixel jitter during idle.
    if (velMagSq > 0.25 && d.direction !== 'idle') {
      const targetRot = Math.atan2(vx, -vz);
      let diff = targetRot - currentRotY.current;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // Faster rotation lerp (12*dt vs previous 8*dt) so 180° flips complete
      // in ~0.25s instead of ~0.4s — effectively eliminates the moonwalk window.
      currentRotY.current += diff * Math.min(1, 12 * dt);
    }
    group.rotation.y = currentRotY.current;

    // PERF: split mixer (60Hz unconditional) from spring-bone physics (tiered rate).
    //
    // FIX (B9 2026-04-24): The previous early-return gate
    //   `if (camDistSq > VRM_NPC_HALF_RATE_DIST_SQ && (frame+seed)%2!==0) return;`
    // killed the ENTIRE useFrame on odd mid-distance frames — including the
    // updateMixerOnly call below. Result: keyframe animation ran at ~30Hz for
    // Miu/Kyoko whenever they were in the 1000–10000wu band, causing visible
    // jank that Nori (unconditional 60Hz mixer in town-guide.tsx) did not exhibit.
    //
    // FIX: The early-return gate is REMOVED entirely.
    // The AnimationMixer MUST run every frame at 60Hz (Nori parity). Only the
    // spring-bone physics is tiered:
    //   close  (camDistSq ≤ VRM_NPC_HALF_RATE_DIST_SQ): every 2nd frame = 30Hz
    //   mid-dist (camDistSq > VRM_NPC_HALF_RATE_DIST_SQ): every 4th frame = 15Hz
    //
    // Spring-bone update (vrm.update) is O(joints) with matrix ops, verlet
    // integration, and quaternion arithmetic per joint. With 5 VRM NPCs × ~10-20
    // spring joints each = 50-100 expensive physics ops/frame at 60Hz. Hair/cloth
    // frequencies are <4 Hz — 15Hz is 3.75× Nyquist margin even at mid-distance.
    //
    // Walking NPCs keep full vrm.update() — movement causes large spring
    // displacements where sub-30Hz would produce visible lag on hair/tail physics.

    // Debug: log when animator ref is null at update time (should never happen post-init)
    if (!vrmAnimatorRef.current && frame % 120 === seed % 120) {
      console.warn('[VRMNpcMesh] animator ref null at update time', npc.id, npc.species);
    }

    const animator = vrmAnimatorRef.current;
    if (animator) {
      springDeltaAccRef.current += dt;
      if (isMoving) {
        // Walking: full update every frame — spring displacements are large.
        // Reset accumulator so the first post-walk spring tick isn't over-stepped.
        animator.update(dt, isMoving);
        springDeltaAccRef.current = 0;
      } else {
        // Idle: mixer ALWAYS at 60Hz (keyframe smoothness, Nori parity).
        animator.updateMixerOnly(dt, isMoving);
        // Tiered spring-bone rate: close = 30Hz (every 2nd frame), mid-dist = 15Hz (every 4th).
        const springMod = camDistSq > VRM_NPC_HALF_RATE_DIST_SQ ? 4 : 2;
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
      {/* VRM scale applied here — registry scale=13 is for the picker (21wu).
          VRM_NPC_SCALE=28 targets TARGET_NPC_HEIGHT=45wu (28 × 1.6m ≈ 44.8wu). */}
      <primitive
        object={vrm.scene}
        scale={[VRM_NPC_SCALE, VRM_NPC_SCALE, VRM_NPC_SCALE]}
      />
      {/* Name label — OUTSIDE scale so it's in world units. y=100 matches GLBNpcMesh. */}
      {/* PERF: removed `distanceFactor={300}` — drei recomputes camera-distance
          scale + writes a new CSS transform every frame for each Html, which
          forces a full Layout pass per label per frame (~14% of frame budget
          across 18 NPC labels per the DevTools profile). Labels now display
          at constant CSS size; positioning still tracks the 3D point. */}
      <Html
        position={[0, 100, 0]}
        center
        style={{ pointerEvents: 'none' }}
        zIndexRange={[10, 100]}
      >
        {/* ref attached so useFrame can imperatively sync display with group.visible.
            drei <Html> is a DOM portal — Three.js visibility flag does NOT propagate.
            Default display:'none' — same rationale as GLBNpcMesh: prevents ghost labels
            on first frames and prevents memo re-renders from restoring 'flex' on culled
            NPCs. useFrame opens the label when the NPC enters the cull radius. */}
        <div
          ref={labelRef}
          style={{
            display: 'none',
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
      </Html>
    </group>
  );
});

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export default function ArenaNpcs() {
  // useShallow performs element-wise reference comparison on the array.
  // Combined with B7 (object identity preservation in updateFromSnapshot),
  // this prevents ArenaNpcs from re-rendering on SSE ticks where no NPC changed.
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
