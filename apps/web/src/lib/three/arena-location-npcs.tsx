'use client';

import { useRef, useMemo, memo, Suspense, useEffect, useState, type ReactElement } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useWorldLabel, WorldLabel } from '@/lib/three/world-labels-overlay';
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { extendLoaderWithMeshopt } from '@/lib/three/meshopt-loader-setup';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
} from '@/lib/pixi/tilemap-data';
import {
  VILLAGE_CENTER_TILE_X,
  VILLAGE_CENTER_TILE_Z,
  NPC_INSET_WORLD,
} from '@/lib/three/character-positions';
import { applyStationaryIdleAnimation, idToSeed } from '@/lib/three/procedural-animation';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { getTerrainHeightAt, isTerrainHeightfieldReady } from '@/lib/three/terrain-heightfield';
import { applyColorTint } from '@/lib/three/character-animations';
import { clampMovement2D } from '@/lib/three/collision/world-colliders';
import { applyFattenedFrustumCulling } from '@/lib/three/vrm-loader';
import { extendLoaderWithKTX2 } from '@/lib/three/ktx2-loader-setup';

// ---------------------------------------------------------------------------
// Location NPCs — SpongeBob characters at their canonical buildings
// Auto-normalized: each GLB is measured and scaled to a target height
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

// Target height in world units for character NPCs.
// Pass 3 (2026-04-23): bumped 55→96 (×1.75 user request — building characters
//   should read more prominently in front of their buildings).
// Pass 2 (2026-04-16): reduced 90→55.
// Pass 1 (2026-04-16): reduced 140→90.
// 96 wu gives a ~1:8.3 ratio vs 800-wu building — bigger than TARGET_NPC_HEIGHT=45
// so SpongeBob cast reads as the heroes of each building.
const CHARACTER_HEIGHT = 96;

// PERF (2026-06-15): the raycast terrain lookup (_locRaycaster / _locRayOrigin /
// _locRayDir / findLocTerrainMesh / getTerrainY) has been REMOVED and replaced
// by the O(1) bilinear heightfield lookup (getTerrainHeightAt, terrain-heightfield.ts).
// The old raycast was confirmed at ~57% of JS CPU in a prod trace (intersectTriangle
// + _computeIntersections + attribute reads). The TERRAIN_LAYER import went with it.
// PHASE 1.5 — module-scope camera-position scratch for far-NPC mixer gate.
// Zero per-frame allocations across all 11 location-NPC useFrame calls per frame.
const _locCamPos = new THREE.Vector3();

// Fidelity-preserving resident streaming: do not replace far characters with
// capsules/cylinders. Far residents simply do not mount their real GLB until
// the camera is close enough for them to matter.
//
// Thresholds raised from 2600/3200 wu to 4600/5200 wu so the entire building ring
// (~4160 wu radius) mounts from spawn at town center. The old values were smaller
// than the ring radius, so zero resident teachers mounted on load.
const RESIDENT_STREAM_IN_DIST_SQ = 4_600 * 4_600;
const RESIDENT_STREAM_OUT_DIST_SQ = 5_200 * 5_200;
const RESIDENT_STREAM_CHECK_FRAMES = 12;

// Sanity bounds for computeNormalizedScale. Some GLBs have broken bounding boxes
// (e.g. tiny non-skinned accessories inflate the scale because their bbox height
// is small, or geometry extends far below the origin). When the computed scale
// falls outside [SCALE_MIN, SCALE_MAX], the scaleOverride value is used instead.
//
// NPC_SCALE_CLAMP_MIN = CHARACTER_HEIGHT / 200
//   → computed scale < this implies native above-pivot height > 200 units (inflated).
// NPC_SCALE_CLAMP_MAX = CHARACTER_HEIGHT / 1.0 = 55
//   → computed scale > this implies native above-pivot height < 1.0 unit. Tightened from
//     280 (CHARACTER_HEIGHT/0.5) to CHARACTER_HEIGHT/1.0 so the worst-case post-clamp
//     visual height is CHARACTER_HEIGHT * 1.0 = 55 wu (pass 2 2026-04-16, reduced from 90).
//     Mr.Krabs and Sandy bypass this via bind-pose fallback anyway; the clamp guards unnamed future
//     characters whose non-skinned accessories have sub-1-unit extent.
const NPC_SCALE_CLAMP_MIN = CHARACTER_HEIGHT / 200;  // ~0.275 at CHARACTER_HEIGHT=55
const NPC_SCALE_CLAMP_MAX = CHARACTER_HEIGHT / 1.0;  //  55 at CHARACTER_HEIGHT=55

/** Config for a single NPC model (primary or companion). */
type NpcModelConfig = {
  name: string;
  model: string;
  color?: number; // optional hex tint — applied via applyColorTint()
  /** Per-model scale override used when computeNormalizedScale returns a
   *  value outside [NPC_SCALE_CLAMP_MIN, NPC_SCALE_CLAMP_MAX] (broken bbox). */
  scaleOverride?: number;
  /** Extra Y-axis rotation (radians) added on top of facingRotY.
   *  Use when a GLB is authored with a non-standard forward axis (+X instead of +Z). */
  rotYOffset?: number;
  /** When true, apply the procedural ghost-float animation (large Y bob + Z sway
   *  + slow Y-axis drift). For static-mesh ghost characters like Flying Dutchman
   *  that have no skeleton/animations. Overrides the default small-bob behavior. */
  ghostFloat?: boolean;
};

/** Full config for a location slot. companion is an optional passive NPC that
 *  stands beside the primary. It does NOT register as a chat target — interaction
 *  always routes to the primary character. */
type LocationNpcConfig = NpcModelConfig & {
  companion?: NpcModelConfig & {
    /** World-unit X offset from primary NPC position (default 80). */
    offsetX?: number;
    /** World-unit Z offset from primary NPC position (default 0). */
    offsetZ?: number;
  };
};

const LOCATION_NPCS: Record<string, LocationNpcConfig> = {
  // Slot 0 — visual-creation — Pineapple House (SpongeBob's home)
  // Gary lives here too: he's a passive companion (no chat target)
  'visual-creation': {
    name: 'SpongeBob',
    model: '/models/characters/spongebob-ktx.glb',
    companion: {
      name: 'Gary',
      model: '/models/characters/gary-ktx.glb',
      offsetX: 180,
      offsetZ: 0,
      // gary.glb is authored facing +X; -π/2 rotates +X forward → +Z forward (toward center)
      rotYOffset: -Math.PI / 2,
    },
  },

  // Slot 1 — memory-rag — bb-building (interim Squidward's house)
  'memory-rag': { name: 'Squidward', model: '/models/characters/squidward-ktx.glb' },

  // Slot 2 — api-integrations — Salty Spitoon (the tough fish bar)
  // Flying Dutchman GLB sourced from Sketchfab (CC-BY 4.0) 2026-04-23 — the
  // canonical "intimidating spectral pirate" who fits the Salty Spitoon vibe
  // better than any tough-fish patron we could find. Iconic green ghost,
  // pirate hat, beard, hook hands. ~17.9k tris, 2.2MB.
  // ghostFloat: static mesh with no skeleton — uses procedural ghost-float
  // (large Y bob + Z sway) which is more thematic for a ghost than walk anims
  // anyway. Compare to Pearl in cron-automation which ships with 5 built-in animations.
  'api-integrations': { name: 'Flying Dutchman', model: '/models/characters/flying-dutchman-ktx.glb', ghostFloat: true },

  // Slot 3 — cron-automation — Downtown Building (Pearl Krabs's downtown teen vibe)
  // Pearl Krabs GLB sourced from Sketchfab (CC-BY 4.0) 2026-04-23 — official-look
  // low-poly Pearl, rigged with 5 idle/talk animations. ~4k tris, 2.1MB.
  // scaleOverride=184 (2026-05-18 pass 3): user requested 20-25% size increase from 150.
  // Midpoint 22.5% → 150 * 1.225 ≈ 184.
  'cron-automation': { name: 'Pearl', model: '/models/characters/pearl-ktx.glb', scaleOverride: 184 },

  // Slot 4 — app-publishing — Boating School (Mrs. Puff's workplace)
  // scaleOverride=3.3 (2026-05-18 pass 3): user requested 20-25% size increase from 2.7.
  // Midpoint 22.5% → 2.7 * 1.225 ≈ 3.3.
  // mrs-puff.glb uses INT16-quantized positions; native visual height ≈ 66.5wu post-node-scale.
  'app-publishing': { name: 'Mrs. Puff', model: '/models/characters/mrs-puff-ktx.glb', scaleOverride: 3.3 },

  // Slot 5 — deployment-ops — Lighthouse (Larry the Lobster as lighthouse keeper)
  // TODO: source proper larry.glb asset — currently using lobster_plush as a distinct stand-in.
  // lobster_plush had a broken bbox (world height 331 at CH=32). SkinnedMesh exclusion
  // should fix normalization; scaleOverride=55 is fallback assuming visual_native_H≈1.0 (= CHARACTER_HEIGHT/1.0).
  // Pass 2 (2026-04-16): reduced 90→55 to match CHARACTER_HEIGHT scale-down.
  'deployment-ops': { name: 'Larry', model: '/models/lobster_plush-ktx.glb?v=2', color: 0xff2020, scaleOverride: 96 },

  // Slot 6 — mcp-tool-use — patty-building (Krusty Krab — Mr. Krabs's restaurant)
  // mr-krabs.glb: non-skinned geometry is only tiny accessories → computed scale > CLAMP_MAX.
  // The non-skinned path now falls back to bind-pose bbox when computed > CLAMP_MAX, which
  // gives a reliable body height. scaleOverride removed (was 148, rendered at ~11487 wu
  // because native body h ≈ 77–82 units × 148 = 11000+).
  'mcp-tool-use': { name: 'Mr. Krabs', model: '/models/characters/mr-krabs-ktx.glb' },

  // Slot 7 — code-development — Chum Bucket (Plankton + Karen both live here)
  // Karen: karen.glb had a broken bbox (world height 1940 at CH=32) caused by
  // SkinnedMesh bind-pose inflation. The improved computeNormalizedScale() excludes
  // SkinnedMesh, which should fix the normalization automatically. scaleOverride=37
  // is a fallback activated ONLY if the non-skinned geometry also gives a bad bbox
  // (outside NPC_SCALE_CLAMP bounds). Assumes karen_visual_native_H ≈ 1.5 native units
  // (= CHARACTER_HEIGHT/1.5 = 55/1.5 ≈ 37). Pass 2 (2026-04-16): reduced 60→37.
  'code-development': {
    name: 'Plankton',
    model: '/models/characters/plankton-ktx.glb',
    // plankton.glb native body ~2.14 units tall. Target render 55 wu → scale 55/2.14 ≈ 26.
    // History: 110 (rendered sy=118 + underground), 55 (rendered sy=118, half underground
    // because localMinY*55≈121 pushed group to terrain-117 but geometry went to terrain-35).
    // 25 yields ~sy=53, offset≈55, position≈-49, feet at terrain+6.
    scaleOverride: 44, // pass 3 (2026-04-23): bumped 25→44 (×1.75) with CHARACTER_HEIGHT 55→96.
    companion: {
      name: 'Karen',
      model: '/models/characters/karen-ktx.glb',
      scaleOverride: 65, // pass 3 (2026-04-23): bumped 37→65 (×1.75) with CHARACTER_HEIGHT 55→96.
      offsetX: 180,
      offsetZ: 0,
    },
  },

  // Slot 8 — messaging-channels — sandy-treedome (real Sandy's Treedome)
  // sandy.glb (2026-04-29): replaced 43KB static GLB with Mixamo-rigged Sandy from
  // mustafatylan68 (CC-BY 4.0, Sketchfab uid 9fda6cf3...). 1 skin, 2 skinned meshes,
  // 1 animation clip 'mixamo.com' — runtime AnimationMixer auto-plays it (idle).
  // Native bind-pose ~1.7m; computeNormalizedScale produces scale ≈ 56 → ~96wu render.
  // scaleOverride=106 (1.8x) matches the Pearl/Mrs.Puff visual ratio with player VRM.
  'messaging-channels': { name: 'Sandy', model: '/models/characters/sandy-ktx.glb', scaleOverride: 106 },

  // Slot 9 — agent-security — building-cave (interim Patrick's Rock)
  'agent-security': { name: 'Patrick', model: '/models/characters/patrick-ktx.glb' },
};

const extendLoaderWithMeshoptAndKTX2 = (loader: unknown) => {
  extendLoaderWithMeshopt(loader as any);
  extendLoaderWithKTX2(loader as any);
};

/** Compute NPC world position and facing angle for a given building zone.
 *
 *  Position: moves NPC_INSET_WORLD world units from building center toward village
 *            center. Inset in world units avoids the tile-count mismatch that placed
 *            NPCs inside wide buildings (pineapple-house footprint is up to 1000 wu).
 *  Facing: SpongeBob character GLBs face +Z at rotation.y=0.
 *          atan2(dx, dz) rotates the +Z-forward model to face toward village center.
 *          No +PI flip needed (unlike lobster-ktx.glb which faces -Z). */
function computeNpcPlacement(zone: { x: number; y: number; width: number; height: number }): {
  worldX: number;
  worldZ: number;
  facingRotY: number;
} {
  // Building center in tile space
  const bcx = zone.x + zone.width  / 2;
  const bcz = zone.y + zone.height / 2; // tile Y = world Z axis

  // Direction from building center toward village center (tile space)
  const dx = VILLAGE_CENTER_TILE_X - bcx;
  const dz = VILLAGE_CENTER_TILE_Z - bcz;
  const len = Math.sqrt(dx * dx + dz * dz);

  // Convert NPC_INSET_WORLD to tile units and step along the normalized direction.
  // len is in tile space; the normalized direction (dx/len, dz/len) is unit-length
  // in tile space. Dividing world-unit inset by TILE_SIZE converts to tile steps.
  let npcTileX = bcx;
  let npcTileZ = bcz;
  if (len > 0.001) {
    const invLen = 1 / len;
    const insetTiles = NPC_INSET_WORLD / TILE_SIZE;
    npcTileX = bcx + (dx * invLen) * insetTiles;
    npcTileZ = bcz + (dz * invLen) * insetTiles;
  }

  const worldX = OFFSET_X + npcTileX * TILE_SIZE;
  const worldZ = OFFSET_Z + npcTileZ * TILE_SIZE;

  // Facing toward village center from NPC position.
  // The model faces +Z by default. atan2(dirX, dirZ) rotates the
  // +Z-forward model to face along (dirX, dirZ) toward center.
  const facingRotY = Math.atan2(dx, dz);

  return { worldX, worldZ, facingRotY };
}

// Character model preloads are deferred — see DeferredNpcPreloads exported below.
// useGLTF() inside LocationNpc will Suspense-throw if the cache isn't warm yet;
// the ArenaLocationNpcs Suspense fallback={null} wrapper absorbs that safely.

// Scratch vectors for computeNormalizedScale — allocated once to avoid GC in useMemo.
const _npcBboxScratch = new THREE.Box3();
const _npcSizeScratch = new THREE.Vector3();
const _npcMeshBox = new THREE.Box3();

// Module-scope scratch Box3 for the rendered-height hard cap (Layer 2 safety net).
// Allocated once — never inside useFrame to avoid GC pressure.
const _locRenderedBbox = new THREE.Box3();

/** Measure bounding box and return scale so the model's Y-height matches targetHeight,
 *  plus the local-space min.y of the geometry (pivot offset).
 *
 *  Uses per-geometry vertex traversal restricted to regular Mesh nodes (NOT SkinnedMesh).
 *  This avoids the most common bbox-inflation bug: Box3.setFromObject() on a scene
 *  containing SkinnedMesh uses the bind-pose world matrix, which can extend the
 *  bounding box far beyond the visible geometry. Regular Mesh children (clothes,
 *  props, non-rigged parts) give a reliable geometry extent.
 *
 *  Fall back to full Box3.setFromObject() if no non-skinned geometry is found.
 *  Returns raw computed scale AND the local min.y; caller applies scaleOverride if set.
 *
 *  localMinY: the lowest point of geometry in local space at scale=1.
 *    - 0  → pivot at feet, no correction needed
 *    - < 0 → pivot above feet (geometry extends below origin); multiply by final scale
 *            and subtract from Y position to lift model so feet sit on terrain
 *    - > 0 → pivot below feet (model floating); same correction lowers it */
function computeNormalizedScale(scene: THREE.Object3D, targetHeight: number): { scale: number; localMinY: number } {
  // Ensure world matrices are current on the cloned scene (not yet in a live Three.js
  // scene graph, so updateWorldMatrix won't have been called automatically).
  scene.updateMatrixWorld(true);
  _npcBboxScratch.makeEmpty();

  scene.traverse((child) => {
    // Explicitly exclude SkinnedMesh — its world matrix reflects the bind pose
    // which may inflate the bbox far beyond the visible rest pose.
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      // Transform geo bbox into world space via mesh's world matrix
      _npcMeshBox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _npcBboxScratch.union(_npcMeshBox);
    }
  });

  // When no non-skinned geometry is found (all-SkinnedMesh GLB), use the bind-pose bbox
  // for SCALE computation only. DO NOT assume native height ≈ 1.0 unit — some character
  // GLBs are exported at 500–650 native units; applying scale=targetHeight on top produces
  // rendered heights of 60000–84000 wu. The bind-pose bbox gives a reliable height proxy.
  // Force localMinY=0: never derive pivot offset from the inflated bind-pose min.y, which
  // can be hundreds of native units below origin (e.g. -600 × scale=140 = -84000 wu launch).
  if (_npcBboxScratch.isEmpty()) {
    _npcBboxScratch.setFromObject(scene);
    if (_npcBboxScratch.isEmpty()) {
      // Truly empty scene — safe minimum scale
      return { scale: NPC_SCALE_CLAMP_MIN, localMinY: 0 };
    }
    const bindH = _npcBboxScratch.max.y > 0.001
      ? _npcBboxScratch.max.y
      : (_npcBboxScratch.max.y - _npcBboxScratch.min.y);
    const bindScale = bindH > 0.001 ? targetHeight / bindH : targetHeight;
    const scale = Math.max(NPC_SCALE_CLAMP_MIN, Math.min(NPC_SCALE_CLAMP_MAX, bindScale));
    return { scale, localMinY: 0 };
  }

  // localMinY MUST come from the non-skinned bbox only.
  const localMinY = _npcBboxScratch.min.y;

  // Use bbox.max.y as the normalizing height — this is the above-pivot visual extent.
  // Using size.y (max.y - min.y) inflates h when the geometry extends below the pivot
  // (localMinY < 0), causing the scale to be too small and the rendered body shorter than
  // targetHeight. bbox.max.y gives the true "height above ground" of the tallest point.
  const maxY = _npcBboxScratch.max.y;
  _npcBboxScratch.getSize(_npcSizeScratch);
  const h = maxY > 0.001 ? maxY : (_npcSizeScratch.y > 0.001 ? _npcSizeScratch.y : Math.max(_npcSizeScratch.x, _npcSizeScratch.y, _npcSizeScratch.z));
  if (h === 0) return { scale: 1, localMinY };

  const computed = targetHeight / h;

  // If computed > CLAMP_MAX the non-skinned geometry is tiny accessories (not the body).
  // Fall back to the bind-pose bbox to get a more reliable body height estimate.
  // CRITICAL: force localMinY=0 here. localMinY came from a tiny non-skinned accessory
  // (e.g. a glass pixel at y=-154 local space). Using that value × a large scale produces
  // a catastrophic pivot offset (localMinY * scale = -37000+ wu → NPC launches skyward).
  if (computed > NPC_SCALE_CLAMP_MAX) {
    const _bindBbox = new THREE.Box3().setFromObject(scene);
    if (!_bindBbox.isEmpty()) {
      const bindMaxY = _bindBbox.max.y > 0.001 ? _bindBbox.max.y : (_bindBbox.max.y - _bindBbox.min.y);
      if (bindMaxY > 0.001) {
        const bindScale = targetHeight / bindMaxY;
        const scale = Math.max(NPC_SCALE_CLAMP_MIN, Math.min(NPC_SCALE_CLAMP_MAX, bindScale));
        return { scale, localMinY: 0 };
      }
    }
  }

  // Hard cap — unconditional final safety net.
  const scale = Math.max(NPC_SCALE_CLAMP_MIN, Math.min(NPC_SCALE_CLAMP_MAX, computed));
  return { scale, localMinY };
}

/** O(1) terrain height lookup — bilinear interpolation into pre-built heightfield.
 *  Falls back to -2 (flat floor) if the heightfield is not yet initialised.
 *  The scene parameter is kept so callers do not need to change. */
function getTerrainY(x: number, z: number, _scene: THREE.Scene): number {
  if (!isTerrainHeightfieldReady()) return -2;
  return getTerrainHeightAt(x, z);
}

/** NpcMesh — renders a single GLB (primary or companion) at the given world position.
 *  Handles: GLB load, bbox-aware scale normalization (SkinnedMesh excluded), optional
 *  color tint, pivot-offset grounding, idle bob + procedural animation, name label.
 *
 *  showLabel: primary NPCs show their name label; companions do not (passive presence).
 *  seedBase: integer seed for staggered raycasting and procedural animation timing. */
const NpcMesh = memo(function NpcMesh({
  modelCfg,
  worldX,
  worldZ,
  facingRotY,
  seedBase,
  showLabel,
}: {
  modelCfg: NpcModelConfig;
  worldX: number;
  worldZ: number;
  facingRotY: number;
  seedBase: number;
  showLabel: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const animGroupRef = useRef<THREE.Group>(null);
  // Layer 2 safety net: one-shot rendered-height hard cap applied after first render.
  // Catches any location NPC whose pivot offset slips through computeNormalizedScale.
  const rescaleAppliedRef = useRef(false);
  // AnimationMixer ref — populated for GLBs that ship with their own animations
  // (Pearl Krabs has 5: Walk / Breathing Idle / Standard Run / Jump / Breakdance).
  // Null for un-rigged GLBs (most of the canonical SpongeBob cast + Flying Dutchman).
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  // Real incrementing frame counter — avoids Math.floor(clock.elapsedTime * 60) which
  // drifts when the tab is backgrounded or the refresh rate varies.
  const npcFrameCountRef = useRef(0);
  const { scene: threeScene } = useThree();

  // WorldLabelsOverlay label — distance-faded wordmark for primary NPCs.
  // Same style as wandering NPC labels; teacher NPCs are stationary so users
  // approach them — a near-range cap of 800wu fits the interaction distance.
  // Occlusion raycasting enabled (teacher can be behind a building at certain
  // camera angles). id encodes model path + position so companion instances
  // don't collide with primary.
  // Location NPCs are SpongeBob-style GLB cartoons — taller than the
  // sea-floor crustaceans (Patrick, Sandy, Squidward all read ~300-350wu
  // tall after scale). A 150wu offset sits at the chest; 320wu sits above
  // the head where the label belongs.
  const { divRef: locationLabelRef } = useWorldLabel({
    id: `location-npc-label-${modelCfg.model}-${worldX}-${worldZ}`,
    anchorRef: groupRef,
    offset: [0, 320, 0],
    initialVisible: showLabel,
    fadeNear: 15000,
    fadeFar: 25000,
    fadeBaseOpacity: 0.95,
    occlude: true,
  });
  // extendLoaderWithMeshopt: belt-and-suspenders for location NPC GLBs that are
  // compressed with EXT_meshopt_compression (e.g. sandy.glb). The global
  // MeshoptLoaderSetup component handles most cases, but passing extendLoader
  // here ensures the decoder is registered on this exact loader instance so
  // quantized geometry (KHR_mesh_quantization) decodes with full bone data intact.
  const { scene, animations } = useGLTF(modelCfg.model, undefined, undefined, extendLoaderWithMeshoptAndKTX2);
  const terrainY = useRef(-2);
  const placed = useRef(false);

  // Clone and compute normalized scale; apply optional color tint.
  // scaleOverride is used for characters whose GLB bbox is broken (Karen, Larry):
  //   - Karen: screen/helper geometry inflates bbox → computed scale too small → world height 1940
  //   - Larry (lobster_plush): bbox too tall relative to visual form → computed scale too large
  // If no scaleOverride, the raw computed scale is used unless it falls outside the
  // sanity clamp [NPC_SCALE_CLAMP_MIN, NPC_SCALE_CLAMP_MAX].
  //
  // pivotOffsetY: world-space Y correction so each GLB's feet sit on the terrain.
  //   = localMinY * finalScale
  //   localMinY is the bbox min.y of non-skinned geometry at scale=1 (local space).
  //   - If pivot is at feet (localMinY ≈ 0): no change.
  //   - If pivot is at torso (localMinY < 0): pivotOffsetY is negative; we subtract it
  //     (double negative = add) to raise the model so geometry bottom aligns with terrainY.
  //   Applied each frame as: group.position.y = terrainY + BASE_LIFT + bob - pivotOffsetY
  const { cloned, npcScale, pivotOffsetY } = useMemo(() => {
    // SkeletonUtils.clone deep-clones the skeleton along with the SkinnedMeshes,
    // unlike scene.clone(true) which leaves cloned SkinnedMeshes pointing at the
    // ORIGINAL bones. Without this, AnimationMixer drives the original skeleton
    // (not visible in our scene) and the cloned mesh deforms into nothing —
    // Pearl Krabs invisible in the Downtown building was the symptom that
    // surfaced this. Safe for non-skinned scenes (falls back to standard clone).
    const c = SkeletonUtils.clone(scene);
    makeObject3DWebGPUSafe(c);
    // Fatten SkinnedMesh bounding spheres + re-enable frustumCulled (Win G fix,
    // 2026-05-22 perf wave 3). SkinnedMesh bind-pose spheres are too tight for
    // animated characters; applyFattenedFrustumCulling fattens each by 1.6× so
    // animated poses stay inside the bound, then enables culling so off-screen
    // location NPCs are correctly skipped. Idempotent via _fattenedBy geometry tag.
    applyFattenedFrustumCulling(c);
    if (modelCfg.color != null) {
      applyColorTint(c, new THREE.Color(modelCfg.color), 0.7, 0.25);
    }
    const { scale: computed, localMinY } = computeNormalizedScale(c, CHARACTER_HEIGHT);
    // scaleOverride takes UNCONDITIONAL priority — for characters whose GLB geometry
    // cannot be reliably measured (all-skinned body, tiny accessories as only non-skinned
    // geometry), the override encodes the empirically correct scale and must not be
    // bypassed even when the computed value happens to fall inside the sanity clamp.
    // Without this, Mr. Krabs (computed≈2000) and Sandy (computed≈482) slip past the
    // old 14000 clamp and render at 1892 and 482 world units respectively.
    let s: number;
    if (modelCfg.scaleOverride != null) {
      s = modelCfg.scaleOverride;
    } else if (computed >= NPC_SCALE_CLAMP_MIN && computed <= NPC_SCALE_CLAMP_MAX) {
      s = computed;
    } else {
      s = Math.max(NPC_SCALE_CLAMP_MIN, Math.min(NPC_SCALE_CLAMP_MAX, computed));
    }
    // pivotOffsetY = localMinY × scale in both paths. For Plankton (override=55,
    // localMinY≈2.3): offset=127 → position.y = terrainY-121 → geometry floor
    // = position + localMinY*s = -121+127 = terrainY+6. Feet on ground.
    let offset = localMinY * s;

    // GhostFloat patch: computeNormalizedScale's >CLAMP_MAX fallback forces
    // localMinY=0 to guard against SkinnedMesh bind-pose inflation. That's
    // correct for rigged characters but WRONG for static unrigged ghosts whose
    // pivot is at the geometry center (not feet). Without this fix the Flying
    // Dutchman appeared half-buried — his bbox y range is [-0.71, +0.69]
    // native, so at scale 96 his geometry extends ~68wu below his transform.
    // Recompute the real cloned bbox min.y so the ghost's bottom can be
    // grounded properly (then ghostBob in useFrame lifts him to hover).
    if (modelCfg.ghostFloat) {
      const realBox = new THREE.Box3().setFromObject(c);
      if (!realBox.isEmpty()) {
        offset = realBox.min.y * s;
      }
    }

    return { cloned: c, npcScale: s, pivotOffsetY: offset };
  }, [scene, modelCfg.color, modelCfg.scaleOverride, modelCfg.ghostFloat]);

  // Dispose cloned geometry + materials on unmount
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

  // Built-in AnimationMixer for GLBs that ship with their own clips.
  // Pearl Krabs: 5 clips (Walk / Breathing Idle / Standard Run / Jump / Breakdance).
  // Sandy: 1 Mixamo clip named "mixamo.com" (idle walk cycle from Mixamo auto-rig).
  // Picks 'Breathing Idle' if present, else first clip. Plays on loop.
  // Other location NPCs have no animations — this hook is a no-op for them.
  //
  // IMPORTANT: always pass `cloned` as the optionalRoot to clipAction().
  // The animation clips from useGLTF() target nodes by name from the ORIGINAL
  // scene root. After SkeletonUtils.clone(), the cloned bones have the same
  // names but different UUIDs. Passing `cloned` as the explicit root pins
  // track resolution to the cloned hierarchy — Three.js resolves node paths
  // via getObjectByName() from this root, matching the cloned bone names.
  // Without this, Three.js may reuse a cached binding pointing at the ORIGINAL
  // scene's nodes (which are not in our scene graph), producing T-pose.
  useEffect(() => {
    if (!animations || animations.length === 0) return;
    const mixer = new THREE.AnimationMixer(cloned);
    mixerRef.current = mixer;
    const idleClip =
      animations.find((c) => /idle|breathing/i.test(c.name)) ?? animations[0];
    // Pass cloned as optionalRoot to force track resolution against the cloned
    // bone hierarchy. reset() clears any cached weight/time from prior plays.
    const action = mixer.clipAction(idleClip, cloned);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(cloned);
      mixerRef.current = null;
    };
  }, [cloned, animations]);

  useFrame(({ clock, camera }, delta) => {
    if (!groupRef.current) return;

    // PHASE 1.5 — Far-location-NPC mixer gate (2026-05-22).
    // Past 5000 wu (distSq > 25M) the building resident's idle/breathing
    // animation is imperceptible from the camera; skip mixer.update() to
    // recover main-thread CPU. Pose freezes at the last frame; resumes
    // seamlessly when the player walks closer. Module-scope scratch,
    // zero per-frame allocations.
    _locCamPos.set(camera.position.x, camera.position.y, camera.position.z);
    const _ldx = worldX - _locCamPos.x;
    const _ldz = worldZ - _locCamPos.z;
    const _locDistSq = _ldx * _ldx + _ldz * _ldz;
    const FAR_LOC_NPC_DIST_SQ = 25_000_000; // 5000 wu²
    const isFarLocNpc = _locDistSq > FAR_LOC_NPC_DIST_SQ;

    // Drive built-in AnimationMixer if present (Pearl Krabs etc.). Skip
    // entirely for far NPCs — biggest CPU win available without altering
    // visible NPC density.
    if (!isFarLocNpc && mixerRef.current) mixerRef.current.update(delta);

    // Re-raycast terrain Y periodically (not just once) to handle late terrain loading.
    // Stagger by seedBase so NPCs don't all spike CPU on the same frame.
    npcFrameCountRef.current += 1;
    const frame = npcFrameCountRef.current;
    if (!placed.current || (frame + seedBase) % 20 === 0) {
      const y = getTerrainY(worldX, worldZ, threeScene);
      if (y > -100) {
        terrainY.current = y;
        placed.current = true;
      }
    }

    // Position: terrainY + BASE_LIFT + bob - pivotOffsetY.
    // ghostFloat NPCs (Flying Dutchman) get a much larger Y bob (4 wu vs 0.5)
    // and a Z-axis sway on the inner anim group — matches the canonical
    // "ghost slowly drifts in the air" motion better than the small idle bob.
    const t = clock.elapsedTime;
    if (modelCfg.ghostFloat) {
      // Base lift = 35wu so bbox bottom hovers ~35wu above terrain at bob
      // midpoint, range ~28-42wu above ground with the ±7 sin bob — clearly
      // floating, not standing. The proper pivotOffsetY (computed from real
      // bbox.min.y for ghosts, not the >CLAMP_MAX fallback's forced 0) does
      // the rest of the lifting.
      const ghostBob = Math.sin(t * 0.8 + seedBase) * 7;
      groupRef.current.position.set(worldX, terrainY.current + 35 + ghostBob - pivotOffsetY, worldZ);
      if (animGroupRef.current) {
        animGroupRef.current.rotation.z = Math.sin(t * 0.5 + seedBase * 0.7) * 0.06;
      }
    } else {
      const bob = Math.sin(t * 1.5 + seedBase) * 0.5;
      groupRef.current.position.set(worldX, terrainY.current + 6 + bob - pivotOffsetY, worldZ);
    }

    // Layer 2: one-shot rendered-height hard cap.
    // Runs once after 0.5s so geometry/bones settle before measurement.
    // Guards against any location NPC whose pivot offset produces a skyward launch.
    // HARD_MAX = 201 wu — 2× CHARACTER_HEIGHT=96 headroom (pass 3: bumped 115→201 with CHARACTER_HEIGHT 55→96 on 2026-04-23).
    if (!rescaleAppliedRef.current && clock.elapsedTime > 0.5 && groupRef.current) {
      _locRenderedBbox.setFromObject(groupRef.current);
      if (!_locRenderedBbox.isEmpty()) {
        const renderedH = _locRenderedBbox.max.y - _locRenderedBbox.min.y;
        const HARD_MAX = 201;
        if (renderedH > HARD_MAX) {
          const scaledSubGroup = groupRef.current.children[0]; // the [npcScale,npcScale,npcScale] group
          if (scaledSubGroup) {
            scaledSubGroup.scale.multiplyScalar(HARD_MAX / renderedH);
          }
          // Reset Y position to terrain so character isn't floating
          groupRef.current.position.y = terrainY.current + 6;
        }
        rescaleAppliedRef.current = true;
      }
    }

    // PERF: throttle procedural idle animation to 20Hz (every 3rd frame, staggered by seed).
    //
    // Rationale: applyStationaryIdleAnimation runs 5 Math.sin calls + writes 4 Object3D
    // properties (scale.x/y/z + rotation.x/y/z). With 10-12 location NPC instances this
    // was ~60 trig evaluations/frame at 60Hz. The animation frequencies are all ≤1.3 rad/s
    // (max ≈ 0.21 Hz), so 20Hz sampling satisfies Nyquist with 48× margin — imperceptible
    // difference at any screen refresh rate. stagger via seedBase prevents all 12 NPCs
    // from updating on the same frame (each updates on its own 3-frame slot).
    if (animGroupRef.current && (frame + seedBase) % 3 === 0) {
      applyStationaryIdleAnimation({
        group: animGroupRef.current,
        isMoving: false,
        elapsed: clock.elapsedTime,
        delta: Math.min(delta, 0.1),
        direction: 'idle',
        seed: seedBase,
      });
    }
  });

  return (
    <group ref={groupRef}>
      {/* Scaled + rotated model sub-group */}
      <group scale={[npcScale, npcScale, npcScale]} rotation={[0, facingRotY + (modelCfg.rotYOffset ?? 0), 0]}>
        <group ref={animGroupRef}>
          <primitive object={cloned} />
        </group>
      </group>
      {/* Bio-luminescent NPC label — same rig as GLBNpcMesh / VRMNpcMesh.
          Only primary NPCs get a label (showLabel=true via initialVisible). */}
      {showLabel && (
        <WorldLabel divRef={locationLabelRef}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              transform: 'translateY(-50%)',
              ['--label-phase' as string]: String(
                (modelCfg.name.charCodeAt(0) + modelCfg.name.length) % 10 / 10,
              ),
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
                boxShadow: '0 0 14px rgba(100,230,255,0.55), 0 0 38px -4px rgba(80,220,255,0.45), inset 0 0 12px rgba(180,245,255,0.18)',
                whiteSpace: 'nowrap',
                letterSpacing: '0.01em',
                lineHeight: 1,
                userSelect: 'none',
                animation: 'bio-drift 5.4s ease-in-out infinite',
                animationDelay: 'calc(var(--label-phase, 0) * -5.4s)',
              }}
            >
              {modelCfg.name}
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
      )}
    </group>
  );
});

const LocationNpc = memo(function LocationNpc({
  zoneId,
  worldX,
  worldZ,
  facingRotY,
}: {
  zoneId: string;
  worldX: number;
  worldZ: number;
  facingRotY: number;
}) {
  // idToSeed returns a float (0..10). Convert to integer so (frame + seed) % N
  // uses integer arithmetic — float modulo with strict === 0 never fires.
  const seed = useMemo(() => Math.round(idToSeed(zoneId)), [zoneId]);
  const config = LOCATION_NPCS[zoneId];
  const { camera } = useThree();
  const [mounted, setMounted] = useState(false);
  // Real incrementing frame counter — replaces Math.floor(clock.elapsedTime * 60)
  // which drifted when the tab was backgrounded or the frame rate varied.
  const frameCountRef = useRef(0);

  useEffect(() => {
    const dx = worldX - camera.position.x;
    const dz = worldZ - camera.position.z;
    setMounted(dx * dx + dz * dz <= RESIDENT_STREAM_IN_DIST_SQ);
  }, [camera, worldX, worldZ]);

  useFrame(({ camera: frameCamera }) => {
    frameCountRef.current += 1;
    const frame = frameCountRef.current;
    if ((frame + seed) % RESIDENT_STREAM_CHECK_FRAMES !== 0) return;

    const dx = worldX - frameCamera.position.x;
    const dz = worldZ - frameCamera.position.z;
    const distSq = dx * dx + dz * dz;
    setMounted((current) => {
      if (current) return distSq <= RESIDENT_STREAM_OUT_DIST_SQ;
      return distSq <= RESIDENT_STREAM_IN_DIST_SQ;
    });
  });

  if (!config) return null;
  if (!mounted) return null;

  const companion = config.companion;
  const companionX = companion ? worldX + (companion.offsetX ?? 80) : 0;
  const companionZ = companion ? worldZ + (companion.offsetZ ?? 0) : 0;
  // Companion seed offset (+17) separates its raycast stagger from the primary
  const companionSeed = seed + 17;

  return (
    <Suspense fallback={null}>
      {/* Primary NPC — interactive chat target */}
      <NpcMesh
        modelCfg={config}
        worldX={worldX}
        worldZ={worldZ}
        facingRotY={facingRotY}
        seedBase={seed}
        showLabel={true}
      />
      {/* Companion NPC (if any) — passive presence, no chat, no label */}
      {companion && (
        <NpcMesh
          modelCfg={companion}
          worldX={companionX}
          worldZ={companionZ}
          facingRotY={facingRotY}
          seedBase={companionSeed}
          showLabel={false}
        />
      )}
    </Suspense>
  );
});

// ---------------------------------------------------------------------------
// DeferredNpcPreloads
// Render OUTSIDE the Canvas — fires after first paint via requestAnimationFrame.
// All 9 SpongeBob character GLBs + the lobster NPC are loaded here, not at
// module-evaluation time, so they don't compete with buildings + player on the
// initial frame. ArenaLocationNpcs is wrapped in Suspense fallback={null} so
// NPCs render nothing until each model resolves.
// ---------------------------------------------------------------------------
export function DeferredNpcPreloads(): ReactElement | null {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let idleHandle = 0;

    const preloadNext = (models: string[], index: number) => {
      if (cancelled || index >= models.length) return;

      const run = () => {
        if (cancelled) return;
        useGLTF.preload(models[index], undefined, undefined, extendLoaderWithMeshoptAndKTX2);
        preloadNext(models, index + 1);
      };

      if ('requestIdleCallback' in window) {
        idleHandle = window.requestIdleCallback(run, { timeout: 2500 });
      } else {
        timer = globalThis.setTimeout(run, 250);
      }
    };

    const waitForReady = () => {
      if (cancelled) return;
      if (!(window as any).__W3D_READY) {
        timer = globalThis.setTimeout(waitForReady, 500);
        return;
      }

      const seen = new Set<string>();
      const models: string[] = [];
      Object.values(LOCATION_NPCS).forEach((cfg) => {
        if (!seen.has(cfg.model)) {
          seen.add(cfg.model);
          models.push(cfg.model);
        }
        if (cfg.companion && !seen.has(cfg.companion.model)) {
          seen.add(cfg.companion.model);
          models.push(cfg.companion.model);
        }
      });

      preloadNext(models, 0);
    };

    timer = globalThis.setTimeout(waitForReady, 500);

    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
      if (idleHandle && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleHandle);
      }
    };
  }, []);
  return null;
}

export default function ArenaLocationNpcs() {
  const npcs = useMemo(() => {
    return buildingZones.map((zone) => {
      const config = LOCATION_NPCS[zone.id];
      if (!config) return null;
      const { worldX, worldZ, facingRotY } = computeNpcPlacement(zone);
      // Sanity push-out: location NPCs are stationary. If NPC_INSET_WORLD + tile rounding
      // accidentally places this NPC inside any disc collider (its own building or a prop),
      // push it radially outward. Village center (0,0) is always outside all building
      // colliders, so using it as "from" guarantees the push direction is away from center.
      const clamped = clampMovement2D(0, 0, worldX, worldZ);
      return { zoneId: zone.id, worldX: clamped.x, worldZ: clamped.z, facingRotY };
    }).filter(Boolean) as { zoneId: string; worldX: number; worldZ: number; facingRotY: number }[];
  }, []);

  return (
    <Suspense fallback={null}>
      <group>
        {npcs.map((npc) => (
          <LocationNpc key={npc.zoneId} {...npc} />
        ))}
      </group>
    </Suspense>
  );
}
