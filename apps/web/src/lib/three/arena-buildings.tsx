'use client';

import { useMemo, useRef, useState, useEffect, useCallback, Suspense } from 'react';
import * as THREE from 'three';
import { useGLTF, Html } from '@react-three/drei';
import { useWorldLabel, WorldLabel, resetLabelPrevOpacity } from '@/lib/three/world-labels-overlay';
import { useFrame, useThree } from '@react-three/fiber';
import { BUILDING_OPENCLAW_THEMES } from '@clawville/shared';
import { mergeStaticMeshesByMaterial } from '@/lib/three/utils/merge-static-meshes';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  MAP_COLS,
  MAP_ROWS,
  buildingZones,
  type BuildingZone,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// GLB model buildings with terrain raycasting
// Each building sits on the actual terrain surface
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;  // -5760 (Phase 6.2: 11520-world)
const OFFSET_Z = -MAP_HEIGHT / 2; // -5760
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;

function zoneCenter(zone: BuildingZone): [number, number, number] {
  const cx = OFFSET_X + (zone.x + zone.width / 2) * TILE_SIZE;
  const cz = OFFSET_Z + (zone.y + zone.height / 2) * TILE_SIZE;
  return [cx, 0, cz];
}

import { TERRAIN_LAYER } from '@/lib/three/arena-terrain';
import { makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { extendLoaderWithMeshopt } from '@/lib/three/meshopt-loader-setup';
import { useGameStore, avatarPositionRef } from '@/stores/game';
import { useTransitionStore } from '@/components/transitions/SceneTransition';

// Shared raycaster -- only hits layer 1 (terrain)
const _buildRaycaster = new THREE.Raycaster();
_buildRaycaster.layers.set(TERRAIN_LAYER);
const _buildRayOrigin = new THREE.Vector3();
const _buildRayDir = new THREE.Vector3(0, -1, 0);

// Target max-dimension for all buildings (world units).
// Phase 6.2 (2026-05-18): switched from Y-only normalization to max(X,Y,Z) normalization.
// Y-only caused wide/squat buildings (Chum Bucket, Patrick's Rock) to balloon in XZ
// while tall/narrow buildings (Squidward) stayed small — wildly inconsistent visual size.
// max-dim normalization means every building fits in a bounding cube of the same size,
// giving consistent visual presence across all architectural forms.
// 1000 is the ring floor; lighthouse stays at 1400 as the tallest landmark.
const BUILDING_TARGET_HEIGHT = 1000;

// ---------------------------------------------------------------------------
// Cove walk-in flow — Phase 6.0.3
//
// 1. Avatar pathfinds toward the cove door position (game-px coords).
//    Door target: ~300 game-px east of cove building center so the avatar
//    approaches from the plaza rather than teleporting inside the building.
//    Cove zone: cx=20 tiles → game-px x=640, cy=180 tiles → game-px y=5760.
//    Door target = (940, 5760) — 300px east, on the side facing town center.
// 2. When within DOOR_ARRIVE_DIST (200 game-px) of door target OR after
//    MAX_WAIT_MS (1500ms) — whichever comes first — trigger the SceneTransition.
// 3. SceneTransition fades to black (500ms), mid-fade pushes to /cove,
//    cove page fades in (500ms). Total flow ≤ 3s per plan acceptance criteria.
// ---------------------------------------------------------------------------

/** Cove door position in game-px (world tilemap space). */
const COVE_DOOR_PX = { x: 940, y: 5760 };
/** Avatar must be within this distance (game-px) to trigger the fade. */
const DOOR_ARRIVE_DIST = 200;
/** Hard timeout before triggering fade even if avatar hasn't arrived. */
const MAX_WALK_WAIT_MS = 1500;

/**
 * triggerCoveWalkIn() — called when the user clicks on the cove building.
 *
 * Sets a click-path to the cove door, then starts a polling loop that
 * watches avatarPositionRef until arrival (or timeout), then triggers the
 * SceneTransition to /cove.
 *
 * Deliberately avoids React state so it can be called from the module-scope
 * BUILDING_MODELS onClick without needing a hook context.
 */
function triggerCoveWalkIn(): void {
  const store = useGameStore.getState();

  // Only walk in player/npc mode — in explore mode there is no avatar to walk.
  if (store.controlMode === 'explore') {
    // Fallback for explore mode: direct transition, no walk.
    useTransitionStore.getState().triggerTransition({ to: '/cove' });
    return;
  }

  // Build a minimal two-waypoint path: current position → door target.
  // The existing click-to-move system in player-avatar.tsx will drive the avatar.
  const path = [
    { x: avatarPositionRef.x, y: avatarPositionRef.y },
    { x: COVE_DOOR_PX.x,    y: COVE_DOOR_PX.y },
  ];
  store.setClickPath(path, null);

  const startMs = Date.now();
  let rafId = 0;

  function poll() {
    const dx = avatarPositionRef.x - COVE_DOOR_PX.x;
    const dy = avatarPositionRef.y - COVE_DOOR_PX.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const elapsed = Date.now() - startMs;

    if (dist <= DOOR_ARRIVE_DIST || elapsed >= MAX_WALK_WAIT_MS) {
      // Avatar has arrived (or timed out) — clear the path and fade.
      store.clearClickPath();
      useTransitionStore.getState().triggerTransition({ to: '/cove' });
      return;
    }

    rafId = requestAnimationFrame(poll);
  }

  rafId = requestAnimationFrame(poll);

  // Safety: if this function is somehow called twice, a prior loop's rafId
  // will be orphaned. Acceptable since the transition store ignores re-triggers
  // while active (the guard `if (get().active) return` in triggerTransition).
  void rafId; // suppress unused-variable warning
}

// Map each building ID to a GLB model + display config.
// rotY: each building faces the village center at tile (120, 120) = world (0, 0).
// Formula: cx = zone.x + zone.width/2, cz = zone.y + zone.height/2
//          dx = 120 - cx, dz = 120 - cz
//          rotY = Math.atan2(dx, dz)  (model faces +Z at rotY=0)
// Ring layout (R=130 tiles, 30° spacing, 12 slots): rotY values are nearly identical to
// R=160 layout — atan2 depends only on angle direction, not ring radius.
/**
 * scaleOverride: bypasses computeBuildingScale entirely. Use for GLBs that
 * confuse the bbox-based auto-scale — typically GLBs that use
 * `EXT_mesh_gpu_instancing` where the source mesh bbox doesn't reflect
 * the instanced-rendered extent.
 *
 * yOffset: world-unit shift applied AFTER scaling. Negative values lower the
 * building (use to ground a floating model whose pivot isn't at its base).
 *
 * pivotZBias: optional extra Z bias added to the inner group's position,
 * on top of the computed -pivotOffsetZ. Use when the GLB's visual "front" is
 * displaced from the bbox center because foreground elements (steps, path,
 * decorative base) shift the bbox forward. A positive pivotZBias moves the
 * building body forward (toward camera / village center). Unit: world units.
 * DEPRECATED for buildings that use bodyAnchorChild — the dynamic anchor
 * replaces this magic number.
 *
 * childScaleOverrides: differential scale multipliers applied to named child nodes
 * AFTER computeBuildingScale. Keys are Three.js-sanitized node names (spaces→_, special
 * chars→_). The uniform buildingScale is still applied via <primitive scale={buildingScale} />;
 * child overrides multiply on top of that in the node's local space.
 *
 * Use when a GLB bundles a building body + pathway/sign into one file but the pathway/sign
 * forces the bbox max-dim to compress the building to a fraction of target height. Solution:
 * boost the building body node alone so it reads larger while the path/sign scales normally.
 *
 * Important: nodes targeted by childScaleOverrides MUST NOT be stripped by
 * stripDecorativeMeshes/stripGroundPlanes (the overrides run after those strip passes).
 *
 * bodyAnchorChild: name of the GLB child node whose bbox center should be used as the
 * building's anchor point (instead of the full-GLB bbox center). Set to the same node
 * name used in childScaleOverrides for buildings that bundle body + pathway/sign.
 *
 * Problem it solves: computeBuildingScale uses the FULL GLB bbox center as the anchor.
 * When a GLB has a building body + a forward-extending pathway/sign, the full bbox center
 * lands BETWEEN them — anchoring that combined center to the slot means the building body
 * sits BEHIND the slot center while the pathway extends in front. bodyAnchorChild computes
 * the body child's bbox center AFTER childScaleOverrides are applied, then shifts the
 * inner group so the body center aligns with the slot position.
 *
 * Example:
 *   'memory-rag': { ..., childScaleOverrides: { "Squidward's_House": 1.7 }, bodyAnchorChild: "Squidward's_House" }
 *   → the moai head body grows 1.4× AND its center aligns with the ring slot.
 */
const BUILDING_MODELS: Record<string, { model: string; yOffset: number; rotY?: number; rotYOffset?: number; scaleOverride?: number; targetMaxDim?: number; box3Recenter?: boolean; pivotZBias?: number; childScaleOverrides?: Record<string, number>; bodyAnchorChild?: string; onClick?: () => void }> = {
  // ---------------------------------------------------------------------------
  // 12-building TRUE CIRCULAR ring — Phase 6.2.1 (2026-05-18).
  // Ring tuned R=160→130 tiles (5120→4160wu — R=160 was too spaced out).
  // Grid stays at 360×360 tiles.
  //
  // Radius: 130 tiles = 4160 wu from center (180, 180) / world (0, 0).
  // Angular spacing: 30° (π/6 rad) — 12 evenly spaced slots, clockwise from North.
  // Arc spacing at R=130: ~2178wu (was ~2680wu at R=160 — too far).
  // rotY = atan2(180 − cx_tile, 180 − cy_tile) — nearly identical to R=160 layout
  // because atan2 depends only on direction angle, not radius magnitude.
  //
  // Slot assignment (clockwise from North):
  //   Slot  0 (  0°/N)   visual-creation    cx=180, cy=50   rotY= 0.000
  //   Slot  1 ( 30°/NNE) code-development   cx=245, cy=67   rotY=-0.522
  //   Slot  2 ( 60°/ENE) mcp-tool-use       cx=293, cy=115  rotY=-1.049
  //   Slot  3 ( 90°/E)   messaging-channels cx=310, cy=180  rotY=-1.571
  //   Slot  4 (120°/ESE) api-integrations   cx=293, cy=245  rotY=-2.093
  //   Slot  5 (150°/SSE) app-publishing     cx=245, cy=293  rotY=-2.620
  //   Slot  6 (180°/S)   cron-automation    cx=180, cy=310  rotY= 3.142
  //   Slot  7 (210°/SSW) deployment-ops     cx=115, cy=293  rotY= 2.620
  //   Slot  8 (240°/WSW) claw-arcade        cx=67,  cy=245  rotY= 2.093
  //   Slot  9 (270°/W)   cove             cx=50,  cy=180  rotY= 1.571  ← entertainment district
  //   Slot 10 (300°/WNW) agent-security     cx=67,  cy=115  rotY= 1.049
  //   Slot 11 (330°/NNW) memory-rag         cx=115, cy=67   rotY= 0.522
  // ---------------------------------------------------------------------------

  // Slot 0 — N (cx=180, cy=50): dx=0, dz=130 → atan2(0,130)=0
  // targetMaxDim: 1100 — pineapple house needs extra size to read from a distance.
  'visual-creation':     { model: '/models/pineapple-house-opt1.glb?v=2',     yOffset: 0, rotY:  0.000, targetMaxDim: 1100 },
  // Slot 1 — NNE (cx=245, cy=67): dx=-65, dz=113 → atan2(-65,113)≈-0.522 (-π/6)
  // Phase 6.2: targetMaxDim=1000→1400 — user reports bucket reads too small vs adjacent buildings.
  // 1400 puts Chum Bucket in the same landmark tier as Squidward + Krusty Krab (5-7× avatar height).
  'code-development':    { model: '/models/chum-bucket-v2-opt1.glb?v=2',      yOffset: 0, rotY: -0.522, targetMaxDim: 1400 },
  // Slot 2 — ENE (cx=293, cy=115): dx=-113, dz=65 → atan2(-113,65)≈-1.049 (-π/3)
  // krusty-krab-v2.glb = iconic ship restaurant (CC-BY, Yanez Designs, 1.59 MB original).
  // GLB node tree (runtime GLTFLoader dump verified 2026-05-25): RootNode → "The_Krusty_Krab" (underscores),
  //   "Road", "Skybox", "Sand", "Pole", "Enter Sign". Three.js preserves names verbatim.
  // targetMaxDim 1000→1400: sign pole Z (≈1438 GLB units) dominates bbox — raises base scale so
  // building reads bigger. childScaleOverride 1.5× on "The_Krusty_Krab" node (ship body) gives
  // differential sizing: restaurant body ≈600wu, sign stays at base scale proportionally.
  // bodyAnchorChild: sign extends in front → full-GLB bbox center is pulled toward sign → restaurant
  // body was behind the slot. Dynamic anchor ensures the restaurant body center lands at the slot.
  // FIXED 2026-05-25: the real runtime node is "The_Krusty_Krab"; the prior
  //   "The Krusty Krab" key was a no-op and logged a body-anchor warning.
  'mcp-tool-use':        { model: '/models/krusty-krab-v2-opt1.glb?v=2',      yOffset: 0, rotY: -1.049, targetMaxDim: 1400,
                           childScaleOverrides: { 'The_Krusty_Krab': 1.5 },
                           bodyAnchorChild: 'The_Krusty_Krab' },
  // Slot 3 — E (cx=310, cy=180): dx=-130, dz=0 → atan2(-130,0)=-π/2≈-1.571
  // Sandy's Treedome was previously /models/sandy-treedome-v3-opt1.glb?v=2.
  // Runtime measurement on 2026-05-25 showed that asset still contributed a
  // single merged green material bucket of ~1.1M tris at world x=4160,z=0.
  // Meshlet work is deferred, so production uses a procedural low-poly dome
  // component for the messaging building instead of loading the GLB.
  'messaging-channels':  { model: '/models/sandy-treedome-v3-opt1.glb?v=2',   yOffset: 0, rotY: -1.571, rotYOffset: Math.PI, targetMaxDim: 2500 },
  // Slot 4 — ESE (cx=293, cy=245): dx=-113, dz=-65 → atan2(-113,-65)≈-2.093 (-2π/3)
  // rotYOffset: salty-spitoon.glb authored facing +X; -π/2 aligns toward village center.
  // Phase 6.2.2: targetMaxDim 1300→2500. salty-spitoon.glb is authored at km-scale
  // (bbox ~655k×340k×655k GLB units — the base Circle.002 flat plane is stripped by
  // stripGroundPlanes). After strip, max-dim ≈507198. Scale = 2500/507198 = 0.00493.
  // Height = 340557×0.00493 = 1679wu — hits MAX_FOOTPRINT=2000: cap adjusts to
  // scale×(2000/XZ_scaled). Final height ≈ 1209wu (≈6.7× avatar). Visible improvement.
  // rotYOffset -π/2: the spitoon GLB is authored facing +X; rotate to face village center.
  'api-integrations':    { model: '/models/salty-spitoon-opt1.glb?v=2',       yOffset: 0, rotY: -2.093, rotYOffset: -Math.PI / 2, targetMaxDim: 2500 },
  // Slot 5 — SSE (cx=245, cy=293): dx=-65, dz=-113 → atan2(-65,-113)≈-2.620 (-5π/6)
  // rotYOffset: boating-school.glb classroom must face center (model-authored offset).
  'app-publishing':      { model: '/models/boating-school-opt1.glb?v=2',      yOffset: 0, rotY: -2.620, rotYOffset: Math.PI / 2, targetMaxDim: 1000 },
  // Slot 6 — S (cx=180, cy=310): dx=0, dz=-130 → atan2(0,-130)=π≈3.142
  // Phase 6.2.2: targetMaxDim 1300→2200. patty-building.glb bbox ≈255.78×193.50×150.
  // Max dim = 255.78 (X width). At targetMaxDim=2200: scale = 2200/255.78 = 8.6.
  // Height = 193.50×8.6 = 1664wu. XZ = 255.78×8.6 = 2200 — hits MAX_FOOTPRINT=2000.
  // Adjusted: scale×(2000/2200) = 7.82. Height = 193.50×7.82 = 1513wu (≈8.4× avatar). ✓
  // The civic anchor building visually dominates the south slot as intended.
  'cron-automation':     { model: '/models/patty-building-opt1.glb?v=2',      yOffset: 0, rotY:  3.142, targetMaxDim: 2200 },
  // Slot 7 — SSW (cx=115, cy=293): dx=65, dz=-113 → atan2(65,-113)≈2.620 (5π/6)
  // Lighthouse is the tallest landmark — targetMaxDim 1400 keeps it visually dominant.
  'deployment-ops':      { model: '/models/building-lighthouse-opt1.glb?v=2', yOffset: 0, rotY:  2.620, targetMaxDim: 1400 },
  // Slot 8 — WSW (cx=67, cy=245): dx=113, dz=-65 → atan2(113,-65)≈2.093 (2π/3)
  // Phase 6.1 swap preserved: claw-arcade at slot 8/WSW. Cove is at slot 9/W (2 slots away).
  'claw-arcade':         { model: '/models/arcade/claw-arcade-exterior-opt1.glb?v=2', yOffset: 0, rotY:  2.093, targetMaxDim: 1100,
                           onClick: () => { console.info('[claw-arcade] interior pending — Concern 6.3'); } },
  // Slot 9 — W (cx=50, cy=180): dx=130, dz=0 → atan2(130,0)=π/2≈1.571  ← entertainment district
  // cove-exterior.glb = "Pyramid Cove" by tl0615 (CC-BY-4.0, Sketchfab).
  // box3Recenter=true: geometry authored at ~(-1800, 166, 4540) Blender origin — centering handled by pivotOffset.
  // targetMaxDim: 1300 — cove is the entertainment-district landmark, deserves more visual mass.
  // onClick: Phase 6.0.3 walk-in flow — avatar walks toward door, then SceneTransition fades to /cove.
  // Door target in game-px: cove zone cx=50 tiles → x=1600, cy=180 tiles → y=5760; door is ~300 game-px
  // east of building center (toward town center at 5760,5760).
  'cove':              { model: '/models/cove/cove-exterior-opt1.glb?v=2', yOffset: 0, rotY:  1.571, targetMaxDim: 1300, box3Recenter: true,
                           onClick: () => { triggerCoveWalkIn(); } },
  // Slot 10 — WNW (cx=67, cy=115): dx=113, dz=65 → atan2(113,65)≈1.049 (π/3)
  // Phase 6.1 swap preserved: agent-security at slot 10/WNW.
  // targetMaxDim: 1100 — wide dome, max-dim normalization prevents over-inflation.
  'agent-security':      { model: '/models/patricks-rock-v2-opt1.glb?v=3',    yOffset: 0, rotY:  1.049, targetMaxDim: 1100 },
  // Slot 11 — NNW (cx=115, cy=67): dx=65, dz=113 → atan2(65,113)≈0.522 (π/6)
  // squidward-house.glb = Easter Island moai head (CC-BY, Yanez Designs).
  // GLB node tree (AUTHORITATIVE — verified via CDP live scene traversal 2026-05-21):
  //   Sketchfab_model → "Squidward’s_HouseFBX" → RootNode (straight U+0027, underscore not space)
  //     ├─ Skybox_*  [stripped by DECORATIVE_NAME_PREFIXES "Skybox_"]
  //     ├─ Sand      [stripped by DECORATIVE_PARENT_NAMES]
  //     ├─ Squidward’s_House  ← STRAIGHT U+0027 apostrophe + underscore (not space)
  //     └─ Stones
  // IMPORTANT: Use CDP `window.__W3D.scene.getObjectByName("Squidward’s_House")` to verify
  //   node names — hex-dumps of the GLB binary have proven unreliable due to possible
  //   transcoding. CDP traversal is ground truth. Pattern: spaces → underscores, U+0027 straight.
  // Phase 6.2.2: targetMaxDim 1400→1700, childScaleOverrides 1.4→1.7.
  //   Raw GLB bbox ≈4.57×1.90×4.59. Max dim = 4.59 (Z). Scale at targetMaxDim=1700:
  //   1700/4.59 ≈ 370wu/unit. childScaleOverride 1.7× on "Squidward’s_House" node:
  //   moai head reads 1.7× larger than the uniform scale; Stones stay proportional.
  // bodyAnchorChild "Squidward’s_House": stone steps extend in +Z from the moai body,
  //   pulling full-GLB bbox center toward the pathway. The dynamic anchor aligns the
  //   moai body center (after 1.7× override) with the ring slot — not the combined bbox.
  "memory-rag":          { model: '/models/squidward-house-opt1.glb?v=3',     yOffset: 0, rotY:  0.522, targetMaxDim: 1700,
                           childScaleOverrides: { "Squidward's_House": 1.7 },
                           bodyAnchorChild: "Squidward's_House" },
};

// Scratch objects for stripGroundPlanes — reused across calls to avoid GC.
const _stripBbox = new THREE.Box3();
const _stripMeshBox = new THREE.Box3();

/**
 * Authoring-aware: strip named decorative meshes from a cloned scene.
 *
 * Some GLBs contain flat non-structural planes (flowers, paths) as children of
 * named parent groups. These meshes inflate the XZ bounding box without
 * contributing to the visible building silhouette, triggering the MAX_FOOTPRINT
 * cap and shrinking the building's rendered height below BUILDING_TARGET_HEIGHT.
 *
 * For pineapple-house.glb specifically: Flowers + Path inflate XZ to
 * ~1852 × 1415 wu, triggering MAX_FOOTPRINT=1000 and scaling height down to ~432.
 * Removing them lets SpongebobsHouse + Chimney produce a ~1:1 bbox that keeps
 * height at the full 800 target.
 *
 * DECORATIVE_PARENT_NAMES is intentionally narrow — only meshes whose parent
 * (or any ancestor) matches this set are removed. Expand as new GLBs require it.
 */
/** Names of authoring-time environmental / decorative groups to strip before
 *  scale measurement. These meshes inflate the bbox and cause actual building
 *  geometry to normalize tiny.
 *    - Flowers, Path — pineapple-house.glb decorations (2.3× XZ inflation)
 *    - Skybox, Road, Sand — chum-bucket.glb environmental shell (caused the
 *      building to render inside a giant blue dome while the bucket itself
 *      shrank to ~60wu tall) */
const DECORATIVE_PARENT_NAMES = new Set(['Flowers', 'Path', 'Skybox', 'Road', 'Sand']);

/** 2026-05-12 — Mesh NAME prefix match for the SOLE problem mesh:
 *  the "Skybox_NN" hemisphere backdrop baked into every Yanez Designs
 *  Sketchfab building. 94-vert UV sphere, identical texture across the
 *  whole asset pack, renders as a giant blue dome around each building.
 *
 *  Sits directly under Sketchfab_Scene with no parent group, so the
 *  DECORATIVE_PARENT_NAMES rule (parent-name match) never catches it —
 *  the MESH itself is the named thing. Match by prefix on the mesh's
 *  own name. Three.js converts spaces to underscores when loading GLBs
 *  so "Skybox_10 - Default_0" arrives as "Skybox_10_-_Default_0".
 *
 *  IMPORTANT: do NOT add "Sand_" / "Road_" here — those are caught by
 *  stripGroundPlanes which uses a flat-and-at-bottom geometric test
 *  rather than a name match. Doubling up the kills was breaking the
 *  bbox calc in computeBuildingScale and miss-scaling Krusty Krab tiny.
 *
 *  Confirmed via gltf-transform inspection (scripts/inspect-broken-
 *  buildings.mjs). */
const DECORATIVE_NAME_PREFIXES = ['Skybox_'] as const;

/** 2026-05-11 — Explicit kill list for backdrop / display-stand domes baked
 *  into individual Sketchfab building GLBs. These meshes have huge square
 *  XZ footprints and low vert counts (UV-sphere hemispheres) — they look
 *  like skybox/diorama backings the original artist used for portfolio
 *  shots. They never have a sensible parent name (sit directly under
 *  "Sketchfab_Scene") so the name-prefix DECORATIVE_PARENT_NAMES rule
 *  can't catch them. Match by exact mesh name OR by material name.
 *
 *  Identified live via Chrome DevTools MCP scene inspection:
 *    - Patrick's_House_02_-_Default_0  → purple/blue starfish dome around
 *      Patrick's Rock (561 × 561 × 280 wu, 360 verts)
 *    - Patrick's_House_03_-_Default_0  → flat sand patch under Patrick
 *      (587 × 564 × 16 wu, 303 verts)
 *    - Material "Mesh_0030.rip" / "Mesh_0022.rip" → 1000 × 400 × 1000 wu
 *      dome backdrops at world (1280, -2, 1760) — Krusty Krab area
 *    - Background_Material004_0 → 380³ background sphere at (0, 200, -500)
 *      → "old Sandy treedome floating in the air" reported by user
 */
/** 2026-05-12 — exact-mesh-name kill list.
 *
 *  Object_1 — the giant 2.2M-vert glass dome inside sandy-treedome-v2.glb
 *  (the sandy_tree_opt.glb the user uploaded). Measured locally with
 *  scripts/read-glb-bbox.mjs: this single mesh is 50×26×49 GLB units
 *  while the actual visible tree+platform are six tiny meshes (Object_0/
 *  52/53/54/112/46) at 3-17 units each. The dome dominates bbox.min.y
 *  so computeBuildingScale calculates a pivot that grounds the dome and
 *  leaves the tree floating ~245 wu above the terrain. Stripping it
 *  lets the small meshes drive the pivot.
 *
 *  Background_Material004_0 is the Auction Podium's intentional glass
 *  dome (auction-dome.glb) — NOT in the kill list. */
const BACKDROP_KILL_NAMES = new Set<string>(['Object_1']);

/** Material kill list also empty for now — "Mesh_0030.rip" / "Mesh_0022.rip"
 *  weren't actually the blue domes at Krusty/Chum/Patrick; they were at
 *  a different building's position and removing them did nothing for the
 *  buildings the user actually complained about. */
const BACKDROP_KILL_MATERIALS = new Set<string>([]);

function stripDecorativeMeshes(scene: THREE.Object3D): void {
  const toRemove: THREE.Object3D[] = [];
  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    // 2026-05-12: the vertex-count outlier rule was wrong — Object_5
    // (2.2M verts) in sandy-treedome-v2 was the TREE+PLATFORM, not the
    // dome. Stripping it left only the faint dome shell + scattered
    // pebbles visible. Reverted to name/material-based strips only.

    // Prefix match on mesh name — catches "Skybox_10_-_Default_0",
    // "Sand_04_-_Default_0", "Road_19_-_Default_0" et al.
    if (child.name) {
      for (const prefix of DECORATIVE_NAME_PREFIXES) {
        if (child.name.startsWith(prefix)) {
          toRemove.push(child);
          return;
        }
      }
    }
    // Direct kill by exact mesh name (one-off backdrop domes).
    if (child.name && BACKDROP_KILL_NAMES.has(child.name)) {
      toRemove.push(child);
      return;
    }
    // Direct kill by material name (orphan domes lacking a useful mesh name).
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (mat?.name && BACKDROP_KILL_MATERIALS.has(mat.name)) {
      toRemove.push(child);
      return;
    }
    // Walk the parent chain looking for a named decorator group
    let p: THREE.Object3D | null = child.parent;
    while (p) {
      if (p.name && DECORATIVE_PARENT_NAMES.has(p.name)) {
        toRemove.push(child);
        break;
      }
      p = p.parent;
    }
  });
  toRemove.forEach((obj) => obj.removeFromParent());
}

/** Strip ground planes from a cloned scene.
 *  ONLY removes meshes that are trivially thin (< 0.5% height ratio) AND sit at the
 *  very bottom of the model (within 5% of min Y). This prevents eating actual building
 *  geometry like Patrick's Rock (which is flat+wide but IS the building).
 *
 *  Full-model bounds are computed from non-SkinnedMesh geometry only (same approach as
 *  computeBuildingScale). Using Box3.setFromObject() here inflates fullHeight for scenes
 *  that contain any rigged nodes, which incorrectly widens the "is at bottom" window and
 *  can cause real structural geometry to be stripped. */
function stripGroundPlanes(scene: THREE.Object3D): void {
  // First pass: measure the full model bounds using NON-SkinnedMesh geometry only.
  // This prevents bind-pose inflation from widening the "is at bottom" threshold and
  // accidentally stripping real building geometry (roofs, walls with wide footprints).
  scene.updateMatrixWorld(true);
  _stripBbox.makeEmpty();
  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      if (!bb) return;
      _stripMeshBox.copy(bb).applyMatrix4(mesh.matrixWorld);
      _stripBbox.union(_stripMeshBox);
    }
  });
  // Fall back to setFromObject if no non-skinned geometry found (shouldn't happen for buildings)
  if (_stripBbox.isEmpty()) _stripBbox.setFromObject(scene);
  const fullMinY = _stripBbox.min.y;
  const fullHeight = _stripBbox.max.y - _stripBbox.min.y;
  if (fullHeight === 0) return;

  const toRemove: THREE.Object3D[] = [];
  scene.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb) return;

    const sy = bb.max.y - bb.min.y;
    const sx = bb.max.x - bb.min.x;
    const sz = bb.max.z - bb.min.z;
    const maxXZ = Math.max(sx, sz);

    // Must be: extremely flat (< 0.5% height ratio), wide, AND at the model's floor
    const isFlat = maxXZ > 2 && sy / maxXZ < 0.005;
    const isAtBottom = bb.max.y < fullMinY + fullHeight * 0.05;
    if (isFlat && isAtBottom) {
      toRemove.push(mesh);
    }
  });
  toRemove.forEach((obj) => obj.removeFromParent());
}

// Maximum footprint (XZ) allowed after height-based normalization (world units).
// Buildings wider than this get shrunk so their widest dimension = MAX_FOOTPRINT.
//
// History:
//   1000 wu — used for R=72-tile ring (Phase 6.1 initial). Circumference/10 = 1448 wu.
//             THIS WAS THE BUG: many buildings (Squidward, Sandy, Krusty Krab, Salty Spitoon,
//             Downtown) have GLBs that are wider than they are tall. At targetHeight=1000-1100
//             their scaledMaxXZ ≈ 1400-2000 wu — hitting the 1000 cap and shrinking rendered
//             height to 500-700 wu instead of the intended 900-1500 wu. Characters were taller
//             than buildings as a result.
//   1500 wu — Phase 6.1 fix (2026-05-18). Ring expanded to R=100 tiles (3200 wu radius),
//             circumference ≈ 20106 wu, slot spacing ≈ 1675 wu. MAX_FOOTPRINT=1500 gives
//             175 wu gap between adjacent building footprints — still visually separated.
//             Most buildings now hit their targetHeight rather than the footprint cap.
//   1800 wu — Phase 6.1.1 fix (2026-05-18). Salty Spitoon is authored facing +X (wide)
//             and its GLB aspect ratio means it hits 1500 cap before reaching targetHeight.
//             1800 wu gives 33% more room while still leaving 33 wu gap between worst-case
//             adjacent footprints. Other wide buildings (Sandy's Treedome, Boating School)
//             benefit similarly — they no longer get crushed to under-target heights.
//   2000 wu — Phase 6.2.2 fix (2026-05-18). Sandy's Treedome dome is square (aspect ≈ 1.0)
//             and hits the 1800 cap, rendering at only 738wu (4.1× avatar). R=130 ring arc
//             spacing is 2178wu so allowing 2000wu footprint keeps a 178wu clearance between
//             the widest adjacent pair. Only the dome and km-scale Salty Spitoon hit this cap.
const MAX_FOOTPRINT = 2000;

// Scratch objects for computeBuildingScale — module-scope to avoid per-call GC.
const _buildBbox = new THREE.Box3();
const _buildMeshBox = new THREE.Box3();
const _buildSize = new THREE.Vector3();
const _buildCenter = new THREE.Vector3();
// Scratch for body-anchor offset computation — used after computeBuildingScale.
const _bodyBbox = new THREE.Box3();
const _bodyCenter = new THREE.Vector3();

interface BuildingScaleResult {
  scale: number;
  /** World-space X offset to subtract from the assigned world position so the
   *  bbox center lands exactly on the position rather than offset by authoring quirks. */
  pivotOffsetX: number;
  /** World-space Y offset equal to bbox.min.y * scale.
   *  Applied as -pivotOffsetY to the inner group so the geometry floor sits at
   *  the outer group's Y regardless of how the GLB was authored:
   *  - min.y > 0 (geometry above pivot): inner shifts down, cures floating
   *  - min.y = 0 (pivot at floor):       offset is 0, no-op
   *  - min.y < 0 (geometry below pivot): inner shifts up, cures underground */
  pivotOffsetY: number;
  /** World-space Z offset to subtract from the assigned world position. */
  pivotOffsetZ: number;
}

/** Measure bounding box and return scale + XZ pivot-correction offsets.
 *
 *  Scale: normalizes so the building's max(X,Y,Z) dimension = targetMaxDim.
 *  Phase 6.2 (2026-05-18): switched from Y-only normalization. Y-only caused
 *  wide/squat GLBs (Chum Bucket bucket, Patrick's Rock dome) to balloon in XZ
 *  while tall/narrow GLBs (Squidward) stayed compact — wildly uneven visual size.
 *  max(X,Y,Z) normalization fits every building in a bounding cube of the same
 *  size, giving consistent visual presence regardless of architectural form.
 *  Matches the cove-interior computeAutoFit pattern (commit 166961d).
 *
 *  Footprint cap: if after max-dim normalization max(scaled_sx, scaled_sz) > MAX_FOOTPRINT,
 *  scale is reduced so the widest XZ dimension = MAX_FOOTPRINT. Wide buildings will be
 *  smaller than targetMaxDim but won't sprawl and dominate the scene.
 *
 *  Pivot correction: some GLBs (e.g. downtown-building.glb) have their geometry
 *  authored far from the scene pivot. pivotOffsetX/Z = bbox_center_XZ * scale,
 *  which the caller subtracts from the world position so the geometry's visual
 *  center lands at the intended world coordinate.
 *
 *  Excludes SkinnedMesh nodes from the bbox to avoid bind-pose inflation.
 *  Called AFTER stripping ground planes. */
function computeBuildingScale(scene: THREE.Object3D, targetMaxDim: number = BUILDING_TARGET_HEIGHT): BuildingScaleResult {
  scene.updateMatrixWorld(true);
  _buildBbox.makeEmpty();

  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      _buildMeshBox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _buildBbox.union(_buildMeshBox);
    }
  });

  if (_buildBbox.isEmpty()) {
    _buildBbox.setFromObject(scene);
  }

  _buildBbox.getSize(_buildSize);
  // Use max(X,Y,Z) as the normalizing dimension so every building occupies a
  // comparably-sized bounding cube. This prevents wide/squat buildings from
  // dominating and tall/narrow buildings from appearing tiny.
  const maxDim = Math.max(_buildSize.x, _buildSize.y, _buildSize.z);
  let scale = maxDim > 0.001 ? targetMaxDim / maxDim : 1;

  // Footprint cap — shrink extremely wide buildings so they don't sprawl.
  const scaledMaxXZ = Math.max(_buildSize.x, _buildSize.z) * scale;
  if (scaledMaxXZ > MAX_FOOTPRINT) {
    scale *= MAX_FOOTPRINT / scaledMaxXZ;
  }

  // Pivot correction — compute bbox center XZ and scale to world space.
  // Subtract from the assigned world position so geometry's visual center
  // lands on the intended coordinate even when the GLB pivot is offset.
  _buildBbox.getCenter(_buildCenter);
  const pivotOffsetX = _buildCenter.x * scale;
  const pivotOffsetZ = _buildCenter.z * scale;
  // Y grounding — bbox.min.y * scale is the world-space distance from the GLB
  // pivot down to the geometry floor. Applying -pivotOffsetY to the inner group
  // ensures the geometry floor always lands at the outer group's Y (-2 = sand floor).
  const pivotOffsetY = _buildBbox.min.y * scale;

  return { scale, pivotOffsetX, pivotOffsetY, pivotOffsetZ };
}

/**
 * applyChildScaleOverrides — differential scale pass applied after computeBuildingScale.
 *
 * For each entry in overrides, walk the cloned scene and find Object3D nodes whose
 * sanitized name (Three.js replaces non-word chars with '_' when loading GLTF)
 * matches the key. Multiply that node's local scale by the override factor.
 *
 * This is applied BEFORE the static matrix lock in GLBBuilding's useEffect so the
 * override becomes part of the locked transform. The outer <primitive scale={buildingScale} />
 * still provides the uniform baseline — child overrides compound on top in local space.
 *
 * Important: this must run AFTER stripDecorativeMeshes/stripGroundPlanes so overridden
 * nodes are guaranteed to still exist in the scene.
 *
 * @param scene  — cloned GLB scene (already stripped)
 * @param overrides — Record<sanitizedNodeName, scaleMultiplier>
 */
function applyChildScaleOverrides(scene: THREE.Object3D, overrides: Record<string, number>): void {
  if (!overrides || Object.keys(overrides).length === 0) return;
  scene.traverse((child) => {
    const factor = overrides[child.name];
    if (factor != null && factor !== 1) {
      child.scale.multiplyScalar(factor);
    }
  });
}

// Preload all 12 models (Phase 6.0.1: added cove-exterior.glb + claw-arcade-exterior.glb).
// extendLoaderWithMeshopt registers MeshoptDecoder on the per-call loader so
// GLBs with EXT_meshopt_compression (patricks-rock, krusty-krab, chum-bucket)
// decode at preload time. Without this, the module-scope preload fires before
// drei's shared loader has the decoder registered → those buildings load as
// empty scenes and don't render.
Object.entries(BUILDING_MODELS).forEach(([id, { model }]) => {
  if (id === 'messaging-channels') return;
  useGLTF.preload(model, undefined, undefined, extendLoaderWithMeshopt);
});

// Entertainment building labels (cove, claw-arcade) — not in BUILDING_OPENCLAW_THEMES
// (those are shop-only). Defined here so GLBBuilding can render a label for them.
const ENTERTAINMENT_LABELS: Record<string, { label: string; category: string }> = {
  'cove':      { label: 'Predictive Gaming Cove', category: 'Entertainment' },
  'claw-arcade': { label: 'Arcade City',    category: 'Arcade' },
};

const _buildingProxyGeometry = new THREE.BoxGeometry(360, 520, 360);
_buildingProxyGeometry.clearGroups();
const _buildingProxyRoofGeometry = new THREE.ConeGeometry(255, 180, 4);
_buildingProxyRoofGeometry.clearGroups();
const BUILDING_PROXY_COLORS = [
  0xf5c84c,
  0x8bd3ff,
  0xff8a5c,
  0x8fe388,
  0xd7a8ff,
  0xffabc8,
  0x72e0d1,
  0xffdf7a,
  0x8fa4ff,
  0x7dd3fc,
  0xff9f6e,
  0xb5e48c,
] as const;
const BUILDING_PROXY_MATERIALS = BUILDING_PROXY_COLORS.map(
  (color) => new THREE.MeshBasicMaterial({ color, toneMapped: false }),
);
const _buildingProxyRoofMaterial = new THREE.MeshBasicMaterial({
  color: 0xe8f7ff,
  toneMapped: false,
});

function BuildingProxy({ zone, index }: { zone: BuildingZone; index: number }) {
  const [cx, , cz] = zoneCenter(zone);
  const config = BUILDING_MODELS[zone.id];
  const material = BUILDING_PROXY_MATERIALS[index % BUILDING_PROXY_MATERIALS.length] ?? BUILDING_PROXY_MATERIALS[0];

  return (
    <group position={[cx, -2, cz]} rotation={[0, config?.rotY ?? 0, 0]}>
      <mesh
        geometry={_buildingProxyGeometry}
        material={material}
        position={[0, 260, 0]}
        onClick={config?.onClick}
        userData={{ isOccluder: true, buildingId: zone.id }}
        frustumCulled
      />
      <mesh
        geometry={_buildingProxyRoofGeometry}
        material={_buildingProxyRoofMaterial}
        position={[0, 548, 0]}
        frustumCulled
      />
    </group>
  );
}

function ProceduralSandyTreedome({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const groupRef = useRef<THREE.Group>(null);
  const labelYOffset = 1020;
  const { divRef: labelDivRef } = useWorldLabel({
    id: `building-label-${zone.id}`,
    anchorRef: groupRef,
    offset: [0, labelYOffset, 0],
    initialVisible: true,
    fadeNear: 15000,
    fadeFar: 25000,
    fadeBaseOpacity: 0.85,
    occlude: false,
  });

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.userData.isOccluder = true;
    g.matrixAutoUpdate = false;
    g.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) mesh.frustumCulled = true;
    });
    g.updateMatrix();
  }, []);

  return (
    <group ref={groupRef} position={[cx, -2, cz]} rotation={[0, -Math.PI / 2 + Math.PI, 0]}>
      <mesh position={[0, 14, 0]} frustumCulled>
        <cylinderGeometry args={[640, 680, 28, 36]} />
        <meshBasicMaterial color="#7cc6aa" />
      </mesh>
      <mesh position={[0, 448, 0]} scale={[1, 0.7, 1]} frustumCulled>
        <sphereGeometry args={[640, 28, 14]} />
        <meshBasicMaterial color="#8ee8ff" transparent opacity={0.24} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 42, 0]} rotation={[Math.PI / 2, 0, 0]} frustumCulled>
        <torusGeometry args={[640, 7, 8, 64]} />
        <meshBasicMaterial color="#d6fff5" />
      </mesh>
      <mesh position={[0, 240, 0]} frustumCulled>
        <cylinderGeometry args={[54, 74, 420, 10]} />
        <meshBasicMaterial color="#8a5b36" />
      </mesh>
      <mesh position={[0, 500, 0]} frustumCulled>
        <icosahedronGeometry args={[250, 2]} />
        <meshBasicMaterial color="#3fb66b" />
      </mesh>
      <mesh position={[-170, 390, 70]} frustumCulled>
        <icosahedronGeometry args={[170, 1]} />
        <meshBasicMaterial color="#47c978" />
      </mesh>
      <mesh position={[180, 405, -80]} frustumCulled>
        <icosahedronGeometry args={[165, 1]} />
        <meshBasicMaterial color="#2fa85b" />
      </mesh>
      <mesh position={[0, 110, -600]} frustumCulled>
        <boxGeometry args={[180, 220, 18]} />
        <meshBasicMaterial color="#f8df8d" />
      </mesh>
      <mesh position={[0, 34, -600]} rotation={[Math.PI / 2, 0, 0]} frustumCulled>
        <torusGeometry args={[104, 6, 8, 24]} />
        <meshBasicMaterial color="#7ed7ff" />
      </mesh>
      <WorldLabel divRef={labelDivRef} pointerEvents="auto">
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            transform: 'translateY(-50%)',
            ['--label-phase' as string]: '0.7',
          }}
          onMouseEnter={() => {
            if (labelDivRef.current) {
              labelDivRef.current.style.opacity = '1';
              const capsule = labelDivRef.current.querySelector<HTMLElement>('[data-bio-capsule]');
              if (capsule) capsule.style.boxShadow = '0 0 28px rgba(120,240,255,0.85), 0 0 70px -8px rgba(80,220,255,0.7), inset 0 0 16px rgba(180,245,255,0.25)';
            }
          }}
          onMouseLeave={() => {
            if (labelDivRef.current) {
              labelDivRef.current.style.opacity = '';
              const capsule = labelDivRef.current.querySelector<HTMLElement>('[data-bio-capsule]');
              if (capsule) capsule.style.boxShadow = '';
            }
            resetLabelPrevOpacity(labelDivRef);
          }}
        >
          <div
            data-bio-capsule
            style={{
              fontFamily: 'var(--font-fraunces, "Cormorant Garamond", "Spectral", Georgia, serif)',
              fontVariationSettings: '"opsz" 9',
              fontWeight: 520,
              fontSize: 15,
              color: '#a0eaff',
              padding: '7px 15px 9px',
              borderRadius: 999,
              background: 'rgba(8, 18, 32, 0.85)',
              border: '1px solid rgba(120, 220, 255, 0.55)',
              boxShadow: '0 0 22px rgba(120,240,255,0.5), 0 0 60px -10px rgba(120,240,255,0.45), inset 0 0 14px rgba(120,200,240,0.18)',
              whiteSpace: 'nowrap',
              letterSpacing: '0.02em',
              lineHeight: 1,
              userSelect: 'none',
              cursor: 'pointer',
              animation: 'bio-drift 5.4s ease-in-out infinite',
              animationDelay: 'calc(var(--label-phase, 0) * -5.4s)',
              transition: 'box-shadow 0.18s ease',
            }}
          >
            Sandy's Treedome
            <span
              style={{
                display: 'block',
                fontSize: 9,
                fontStyle: 'italic',
                fontFamily: 'var(--font-oxanium, sans-serif)',
                fontWeight: 400,
                color: '#cdf5ff',
                opacity: 0.7,
                marginTop: 2,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
              }}
            >
              Communication
            </span>
          </div>
          <div
            style={{
              width: 1,
              height: 56,
              backgroundImage: 'linear-gradient(rgba(140,240,255,0.78) 50%, transparent 50%)',
              backgroundSize: '1px 6px',
              backgroundRepeat: 'repeat-y',
              boxShadow: '0 0 6px rgba(120,240,255,0.55)',
              marginBottom: 2,
            }}
          />
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
}

// ---------------------------------------------------------------------------
// Normal mode: static buildings with terrain raycasting
// ---------------------------------------------------------------------------

function GLBBuilding({ zone }: { zone: BuildingZone }) {
  const config = BUILDING_MODELS[zone.id];
  if (!config) return null;

  const [cx, , cz] = zoneCenter(zone);
  // Pass extendLoaderWithMeshopt for buildings with EXT_meshopt_compression.
  // Same rationale as the module-scope preload above.
  const { scene } = useGLTF(config.model, undefined, undefined, extendLoaderWithMeshopt);
  const groupRef = useRef<THREE.Group>(null);

  // WorldLabelsOverlay label — distance-faded landmark.
  // Base opacity 0.85 at ≤2000wu, linear fade to 0 at 5000wu. Was 0.40, which
  // multiplied with the new solid dark-navy capsule (alpha 0.85) landed at
  // ~0.34 effective — barely visible. 0.85 baseline reads like a proper
  // landmark while still fading naturally at distance.
  // Label floats above the building: use per-building targetMaxDim so tall buildings
  // (lighthouse 1400) get a proportionally elevated label. Fallback to BUILDING_TARGET_HEIGHT.
  const labelYOffset = (config.targetMaxDim ?? BUILDING_TARGET_HEIGHT) + 20;
  const { divRef: labelDivRef } = useWorldLabel({
    id: `building-label-${zone.id}`,
    anchorRef: groupRef,
    offset: [0, labelYOffset, 0],
    initialVisible: true,
    // Buildings are permanent landmarks, NOT proximity-faded. World diagonal
    // is ~16300wu; fadeNear=15000 / fadeFar=25000 keeps every label at full
    // opacity within the playable area.
    fadeNear: 15000,
    fadeFar: 25000,
    fadeBaseOpacity: 0.85,
    occlude: false,
  });

  const { cloned, buildingScale, pivotOffsetX, pivotOffsetY, pivotOffsetZ } = useMemo(() => {
    const c = scene.clone(true);
    makeObject3DWebGPUSafe(c);
    // 2026-05-11 — Strip backdrop / display-stand domes baked into source GLBs
    // (Patrick's hemisphere, Krusty Krab "Mesh_0030.rip" / "Mesh_0022.rip"
    // domes, Sandy's floating "Background_Material004_0"). This runs
    // UNCONDITIONALLY — even buildings with scaleOverride should not render
    // a 1000-wu skybox dome.
    stripDecorativeMeshes(c);
    // scaleOverride bypasses bbox-based auto-scaling for GLBs that confuse the
    // measurement (e.g. EXT_mesh_gpu_instancing — source-mesh bbox doesn't
    // reflect the instanced render extent). Pivot offsets are zero; yOffset
    // is applied by the caller to ground the model.
    let result;
    if (config.scaleOverride != null) {
      result = { cloned: c, buildingScale: config.scaleOverride, pivotOffsetX: 0, pivotOffsetY: 0, pivotOffsetZ: 0 };
    } else {
      // Strip flat ground planes before measuring so the max-dim normalization
      // is accurate — ground planes inflate bbox and distort the normalizing dim.
      stripGroundPlanes(c);
      // Phase 6.2: targetMaxDim replaces targetHeight; computeBuildingScale now
      // normalises by max(X,Y,Z) for consistent visual size across all shapes.
      const targetMD = config.targetMaxDim ?? BUILDING_TARGET_HEIGHT;
      const { scale: s, pivotOffsetX: px, pivotOffsetY: py, pivotOffsetZ: pz } = computeBuildingScale(c, targetMD);
      // Save the full-bbox center IMMEDIATELY after computeBuildingScale returns.
      // _buildCenter is a module-scope scratch that may be overwritten by later calls —
      // capture the XZ values before the child-override pass runs.
      const fullCenterX = _buildCenter.x;
      const fullCenterZ = _buildCenter.z;

      result = { cloned: c, buildingScale: s, pivotOffsetX: px, pivotOffsetY: py, pivotOffsetZ: pz };

      // Differential child-scale pass — applied BEFORE mergeStaticMeshesByMaterial so that
      // the overridden child node scales are baked into vertex positions by the merger.
      // After the merge the named parent nodes (e.g. "Squidward's_House") still exist as
      // empty containers, but all their mesh children will have had their matrixWorld
      // (which incorporates this scale) snapshotted and baked into merged geo vertex positions.
      // This gives differential sizing: building body reads larger, pathway/sign unchanged.
      if (config.childScaleOverrides) {
        // Force a matrixWorld update BEFORE applying overrides so mergeStaticMeshesByMaterial
        // sees the correct inherited transforms when it snapshots each mesh's matrixWorld.
        c.updateMatrixWorld(true);
        applyChildScaleOverrides(c, config.childScaleOverrides);
        // Re-update matrixWorld so the override scales propagate to all descendants
        // before mergeStaticMeshesByMaterial reads them.
        c.updateMatrixWorld(true);
      }

      // Body anchor correction — when a GLB bundles a building body + forward-extending
      // pathway/sign, the full-bbox center is pulled between them. anchoring that combined
      // center at the slot means the building body sits BEHIND the slot. Fix: compute the
      // body child's bbox center (AFTER childScaleOverrides propagated) and offset pivotX/Z
      // so the body center aligns with the slot instead.
      //
      // This runs AFTER the child-override updateMatrixWorld so the body bbox reflects the
      // post-override scale. It runs BEFORE mergeStaticMeshesByMaterial because the named
      // body node (e.g. "Squidward's_House") becomes an empty container after the merge.
      if (config.bodyAnchorChild) {
        const bodyChild = c.getObjectByName(config.bodyAnchorChild);
        if (bodyChild) {
          // Measure body child bbox in scene-local space (same coordinate space as _buildCenter).
          _bodyBbox.makeEmpty();
          bodyChild.traverse((child) => {
            if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
              const mesh = child as THREE.Mesh;
              if (!mesh.geometry) return;
              mesh.geometry.computeBoundingBox();
              const geoBB = mesh.geometry.boundingBox;
              if (!geoBB) return;
              _buildMeshBox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
              _bodyBbox.union(_buildMeshBox);
            }
          });

          if (!_bodyBbox.isEmpty()) {
            _bodyBbox.getCenter(_bodyCenter);
            // anchorDelta: body center minus full-bbox center (both scene-local).
            // Multiplied by scale → world units.
            // Add to pivotOffset so the inner group shifts toward the body center:
            //   inner group position = [-pivotOffsetX, -pivotOffsetY, -pivotOffsetZ]
            //   currently slots full-bbox center at origin; we want body center at origin.
            //   body center = fullCenter + anchorDelta
            //   new pivotOffsetX = (fullCenter.x + anchorDelta.x) * s = body center * s
            const bodyDeltaX = _bodyCenter.x - fullCenterX;
            const bodyDeltaZ = _bodyCenter.z - fullCenterZ;
            result = {
              ...result,
              pivotOffsetX: px + bodyDeltaX * s,
              pivotOffsetZ: pz + bodyDeltaZ * s,
            };

            if (typeof window !== 'undefined') {
              console.log(
                `[body-anchor] ${zone.id}: fullCenter=(${fullCenterX.toFixed(1)},${fullCenterZ.toFixed(1)})` +
                ` bodyCenter=(${_bodyCenter.x.toFixed(1)},${_bodyCenter.z.toFixed(1)})` +
                ` delta=(${bodyDeltaX.toFixed(1)},${bodyDeltaZ.toFixed(1)})` +
                ` worldDelta=(${(bodyDeltaX * s).toFixed(0)},${(bodyDeltaZ * s).toFixed(0)})wu`
              );
            }
          }
        } else {
          if (typeof window !== 'undefined') {
            console.warn(`[body-anchor] ${zone.id}: bodyAnchorChild "${config.bodyAnchorChild}" not found in scene`);
          }
        }
      }
    }
    // Phase 6.2 — Sandy's Treedome dome glass fix:
    // sandy-treedome-v3.glb dome mesh is single-sided (THREE.FrontSide), so the
    // camera looking from outside sees nothing (backfaces culled). Apply DoubleSide
    // to any transparent/alphaTest material on the messaging-channels building so
    // the glass dome is visible from outside without modifying the GLB asset.
    if (zone.id === 'messaging-channels') {
      c.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          if (mat && (mat.transparent || (mat as THREE.MeshStandardMaterial).alphaTest > 0)) {
            (mat as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
          }
        }
      });
    }
    // 2026-05-11 — collapse same-material draw calls into one mesh each.
    // Buildings have ~5-15 submeshes from the source GLB but many share a
    // material (wood/metal/sand) — merging by material reference cuts draws
    // proportional to the duplication ratio.
    const merge = mergeStaticMeshesByMaterial(c);
    if (typeof window !== 'undefined') {
      console.log(`[building-merge] ${zone.id}: ${merge.meshesBefore} → ${merge.meshesAfter} meshes (${merge.buckets} buckets merged, ${merge.skipped} skipped)`);
    }
    return result;
  }, [scene, config.model, config.scaleOverride, config.targetMaxDim, config.pivotZBias, config.childScaleOverrides, config.bodyAnchorChild, zone.id]);

  // Dispose cloned geometry + materials on unmount (navigation away / hot-reload)
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

  // PERF: buildings never move at runtime in normal play (only EditableBuilding
  // does, and that's a separate component). Disable matrixAutoUpdate on the
  // group + every cloned mesh so Three.js doesn't re-multiply matrices for
  // ~30+ static meshes per building × 10 buildings every frame.
  // Was contributing to the 9.9% updateMatrixWorld cost in the DevTools profile.
  //
  // Also tag the group as an occluder so arena-npcs.tsx label-occlusion raycast
  // can find building geometry via scene traversal without a hardcoded name list.
  // The tag is read once on first useFrame call in ArenaNpcs and cached.
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.userData.isOccluder = true;
    g.matrixAutoUpdate = false;
    g.updateMatrix();
    cloned.traverse((obj) => {
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
    });
  }, [cloned]);

  // Shop buildings use BUILDING_OPENCLAW_THEMES; entertainment buildings (cove,
  // claw-arcade) use ENTERTAINMENT_LABELS fallback. Both render the same label UI.
  const theme = BUILDING_OPENCLAW_THEMES[zone.id] ?? ENTERTAINMENT_LABELS[zone.id];

  // Buildings sit on the flat sand floor (y=-2). No raycasting needed —
  // dune ripples are small relative to the 100-unit building height.
  // pivotOffsetX/Z corrects for GLBs authored with geometry far from their pivot
  // (e.g. downtown-building.glb bbox center is ~4120wu east of scene origin;
  //  cove-exterior.glb authored at ~(-1800, 166, 4540) Blender units — box3Recenter
  //  flag documents this but the actual centering is handled by computeBuildingScale
  //  pivotOffsetX/Z like every other building).
  return (
    <>
      {/* BuildingPedestal removed 2026-05-21 — was authoring as a sandstone
          ground-separator disc under each building, but the canonical
          groundedYOffset pattern already keeps buildings flush with the sand
          terrain. With the matrixAutoUpdate=false bug fixed earlier today the
          pedestals were finally rendering at the correct per-building
          positions instead of stacking at origin, and showed up as dark plates
          under every building. Removed entirely — the canonical grounding +
          terrain texture is sufficient. */}
      <group ref={groupRef} position={[cx, -2 + config.yOffset, cz]} rotation={[0, (config.rotY ?? 0) + (config.rotYOffset ?? 0), 0]}>
        {/* pivotZBias: extra Z shift to compensate for step/foreground geometry displacing the bbox center.
            Positive value moves inner group toward village center (closer to camera at standard view).
            Applied on top of -pivotOffsetZ. Zero for all buildings except those with explicit pivotZBias config. */}
        <group position={[-pivotOffsetX, -pivotOffsetY, -pivotOffsetZ + (config.pivotZBias ?? 0)]}>
          <primitive object={cloned} scale={buildingScale} />
        </group>
        {/* Invisible click volume — used by entertainment buildings (cove, claw-arcade)
            that have a config.onClick handler. Sized to ~1/8 of BUILDING_TARGET_HEIGHT
            to give a generous click target without needing a visible mesh. */}
        {config.onClick && (
          <mesh
            position={[0, (config.targetMaxDim ?? BUILDING_TARGET_HEIGHT) * 0.4, 0]}
            onClick={(e) => { e.stopPropagation(); config.onClick!(); }}
          >
            <boxGeometry args={[200, (config.targetMaxDim ?? BUILDING_TARGET_HEIGHT) * 0.8, 200]} />
            <meshBasicMaterial visible={false} />
          </mesh>
        )}
        {/* Bio-luminescent building label — Fraunces serif capsule with brighter glow.
            Rig stack (top→bottom): capsule (name + category) → longer tether → anchor dot.
            translateY(-50%) anchors the dot at the projected screen point (top of building).
            Hover: onMouseEnter writes opacity=1 to the outer div (labelDivRef.current);
            onMouseLeave clears it and resets _prevOpacity so the fade re-derives on next frame.
            pointerEvents='auto' keeps the click target active. */}
        {theme && (
          <WorldLabel divRef={labelDivRef} pointerEvents="auto">
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                transform: 'translateY(-50%)',
                ['--label-phase' as string]: String(
                  (zone.id.charCodeAt(0) + zone.id.length) % 10 / 10,
                ),
              }}
              onMouseEnter={() => {
                if (labelDivRef.current) {
                  labelDivRef.current.style.opacity = '1';
                  // Boost glow on hover by overriding the capsule box-shadow inline
                  const capsule = labelDivRef.current.querySelector<HTMLElement>('[data-bio-capsule]');
                  if (capsule) capsule.style.boxShadow = '0 0 28px rgba(120,240,255,0.85), 0 0 70px -8px rgba(80,220,255,0.7), inset 0 0 16px rgba(180,245,255,0.25)';
                }
              }}
              onMouseLeave={() => {
                if (labelDivRef.current) {
                  labelDivRef.current.style.opacity = '';
                  const capsule = labelDivRef.current.querySelector<HTMLElement>('[data-bio-capsule]');
                  if (capsule) capsule.style.boxShadow = '';
                }
                resetLabelPrevOpacity(labelDivRef);
              }}
            >
              {/* Glowing Fraunces capsule — brighter than NPC variant */}
              <div
                data-bio-capsule
                style={{
                  fontFamily: 'var(--font-fraunces, "Cormorant Garamond", "Spectral", Georgia, serif)',
                  fontVariationSettings: '"opsz" 9',
                  fontWeight: 520,
                  fontSize: 15,
                  color: '#a0eaff',
                  padding: '7px 15px 9px',
                  borderRadius: 999,
                  background: 'rgba(8, 18, 32, 0.85)',
                  border: '1px solid rgba(120, 220, 255, 0.55)',
                  boxShadow: '0 0 22px rgba(120,240,255,0.5), 0 0 60px -10px rgba(120,240,255,0.45), inset 0 0 14px rgba(120,200,240,0.18)',
                  whiteSpace: 'nowrap',
                  letterSpacing: '0.02em',
                  lineHeight: 1,
                  userSelect: 'none',
                  cursor: 'pointer',
                  animation: 'bio-drift 5.4s ease-in-out infinite',
                  animationDelay: 'calc(var(--label-phase, 0) * -5.4s)',
                  transition: 'box-shadow 0.18s ease',
                }}
              >
                {theme.label}
                <span
                  style={{
                    display: 'block',
                    fontSize: 9,
                    fontStyle: 'italic',
                    fontFamily: 'var(--font-oxanium, sans-serif)',
                    fontWeight: 400,
                    color: '#cdf5ff',
                    opacity: 0.7,
                    marginTop: 2,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                  }}
                >
                  {theme.category}
                </span>
              </div>
              {/* Longer tether for buildings */}
              <div
                style={{
                  width: 1,
                  height: 56,
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Edit mode: draggable buildings with labels + copy button
// Activate by visiting /game?edit=1
// ---------------------------------------------------------------------------

interface EditZone extends BuildingZone {
  worldX: number;
  worldZ: number;
}

function toEditZone(z: BuildingZone): EditZone {
  const [cx, , cz] = zoneCenter(z);
  return { ...z, worldX: cx, worldZ: cz };
}

function EditableBuilding({
  zone,
  isDragging,
  onDragStart,
}: {
  zone: EditZone;
  isDragging: boolean;
  onDragStart: (id: string) => void;
}) {
  const config = BUILDING_MODELS[zone.id];
  if (!config) return null;

  const { scene } = useGLTF(config.model, undefined, undefined, extendLoaderWithMeshopt);
  const { scene: threeScene } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const terrainY = useRef(-15);

  const { cloned, buildingScale, pivotOffsetX, pivotOffsetY, pivotOffsetZ } = useMemo(() => {
    const c = scene.clone(true);
    makeObject3DWebGPUSafe(c);
    stripDecorativeMeshes(c);
    stripGroundPlanes(c);
    const targetMD = config.targetMaxDim ?? BUILDING_TARGET_HEIGHT;
    const { scale: s, pivotOffsetX: px, pivotOffsetY: py, pivotOffsetZ: pz } = computeBuildingScale(c, targetMD);
    const fullCenterX = _buildCenter.x;
    const fullCenterZ = _buildCenter.z;
    if (config.childScaleOverrides) {
      c.updateMatrixWorld(true);
      applyChildScaleOverrides(c, config.childScaleOverrides);
      c.updateMatrixWorld(true);
    }
    // Body anchor correction — mirrors GLBBuilding logic.
    let finalPX = px, finalPZ = pz;
    if (config.bodyAnchorChild) {
      const bodyChild = c.getObjectByName(config.bodyAnchorChild);
      if (bodyChild) {
        _bodyBbox.makeEmpty();
        bodyChild.traverse((child) => {
          if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
            const mesh = child as THREE.Mesh;
            if (!mesh.geometry) return;
            mesh.geometry.computeBoundingBox();
            const geoBB = mesh.geometry.boundingBox;
            if (!geoBB) return;
            _buildMeshBox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
            _bodyBbox.union(_buildMeshBox);
          }
        });
        if (!_bodyBbox.isEmpty()) {
          _bodyBbox.getCenter(_bodyCenter);
          finalPX = px + (_bodyCenter.x - fullCenterX) * s;
          finalPZ = pz + (_bodyCenter.z - fullCenterZ) * s;
        }
      }
    }
    return { cloned: c, buildingScale: s, pivotOffsetX: finalPX, pivotOffsetY: py, pivotOffsetZ: finalPZ };
  }, [scene, config.targetMaxDim, config.childScaleOverrides, config.bodyAnchorChild]);

  // Re-raycast terrain Y whenever position changes
  useFrame(() => {
    if (!groupRef.current) return;
    _buildRayOrigin.set(zone.worldX, 200, zone.worldZ);
    _buildRaycaster.set(_buildRayOrigin, _buildRayDir);
    _buildRaycaster.layers.set(TERRAIN_LAYER);
    _buildRaycaster.far = 400;

    const intersects = _buildRaycaster.intersectObjects(threeScene.children, true);
    if (intersects.length > 0) {
      terrainY.current = intersects[0].point.y;
    }
    groupRef.current.position.set(zone.worldX, terrainY.current + config.yOffset, zone.worldZ);
  });

  return (
    <group ref={groupRef} rotation={[0, (config.rotY ?? 0) + (config.rotYOffset ?? 0), 0]}>
      <group position={[-pivotOffsetX, -pivotOffsetY, -pivotOffsetZ]}>
        <primitive object={cloned} scale={buildingScale} />
      </group>
      {/* Invisible click box for drag detection */}
      <mesh
        position={[0, 20, 0]}
        onPointerDown={(e) => {
          e.stopPropagation();
          onDragStart(zone.id);
        }}
      >
        <boxGeometry args={[50, 80, 50]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      {/* Label */}
      {/* PERF: removed distanceFactor (was 400) — see arena-npcs.tsx PERF note */}
      <Html position={[0, 50, 0]} center style={{ pointerEvents: 'none' }}>
        <div
          style={{
            background: isDragging ? '#d97706' : '#1e293b',
            color: 'white',
            padding: '4px 10px',
            borderRadius: 6,
            fontSize: 12,
            fontFamily: 'monospace',
            whiteSpace: 'nowrap',
            border: isDragging ? '2px solid #fbbf24' : '1px solid #475569',
            boxShadow: isDragging ? '0 0 12px rgba(251,191,36,0.5)' : '0 2px 8px rgba(0,0,0,0.4)',
            userSelect: 'none',
          }}
        >
          <strong>{zone.id}</strong>
          <br />
          x:{zone.x} y:{zone.y}
        </div>
      </Html>
    </group>
  );
}

function EditMode() {
  const [zones, setZones] = useState<EditZone[]>(() => buildingZones.map(toEditZone));
  const [dragging, setDragging] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const controls = useThree((s) => s.controls) as any;
  const { camera, pointer } = useThree();

  const dragPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const intersection = useMemo(() => new THREE.Vector3(), []);
  const dragRaycaster = useMemo(() => new THREE.Raycaster(), []);
  const lastTile = useRef({ x: -1, y: -1 });

  // Disable orbit controls during drag
  useEffect(() => {
    if (controls) controls.enabled = !dragging;
    return () => {
      if (controls) controls.enabled = true;
    };
  }, [dragging, controls]);

  // Track drag position — only update state when tile changes
  useFrame(() => {
    if (!dragging) return;
    dragRaycaster.setFromCamera(pointer, camera);
    if (!dragRaycaster.ray.intersectPlane(dragPlane, intersection)) return;

    const zone = zones.find((z) => z.id === dragging);
    if (!zone) return;

    const newTileX = Math.max(
      0,
      Math.min(MAP_COLS - zone.width, Math.round((intersection.x - OFFSET_X) / TILE_SIZE - zone.width / 2)),
    );
    const newTileY = Math.max(
      0,
      Math.min(MAP_ROWS - zone.height, Math.round((intersection.z - OFFSET_Z) / TILE_SIZE - zone.height / 2)),
    );

    if (newTileX === lastTile.current.x && newTileY === lastTile.current.y) return;
    lastTile.current = { x: newTileX, y: newTileY };

    setZones((prev) =>
      prev.map((z) => {
        if (z.id !== dragging) return z;
        return {
          ...z,
          x: newTileX,
          y: newTileY,
          worldX: OFFSET_X + (newTileX + z.width / 2) * TILE_SIZE,
          worldZ: OFFSET_Z + (newTileY + z.height / 2) * TILE_SIZE,
        };
      }),
    );
  });

  // End drag on pointer up (window-level to catch releases outside canvas)
  useEffect(() => {
    const onUp = () => {
      setDragging(null);
      lastTile.current = { x: -1, y: -1 };
    };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, []);

  const copyPositions = useCallback(() => {
    const lines = zones.map(
      (z) =>
        `  { id: '${z.id}',${' '.repeat(Math.max(1, 21 - z.id.length))}x: ${String(z.x).padStart(2)},  y: ${String(z.y).padStart(2)},  width: ${z.width}, height: ${z.height} },`,
    );
    const code = `export const buildingZones: BuildingZone[] = [\n${lines.join('\n')}\n];`;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
    console.log('[EditMode] Building positions:\n' + code);
  }, [zones]);

  return (
    <Suspense fallback={null}>
      <group>
        {zones.map((zone) => (
          <EditableBuilding
            key={zone.id}
            zone={zone}
            isDragging={dragging === zone.id}
            onDragStart={setDragging}
          />
        ))}
      </group>

      {/* Floating edit panel */}
      <Html position={[HALF_W + 50, 150, -HALF_H]} center style={{ pointerEvents: 'auto' }}>
        <div
          style={{
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: 10,
            padding: 16,
            minWidth: 200,
            color: 'white',
            fontFamily: 'monospace',
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 'bold', fontSize: 14, marginBottom: 8, color: '#38bdf8' }}>
            Building Editor
          </div>
          <div style={{ color: '#94a3b8', marginBottom: 12, lineHeight: 1.4 }}>
            Click and drag buildings
            <br />
            to reposition them.
          </div>
          <button
            onClick={copyPositions}
            style={{
              background: copied ? '#16a34a' : '#2563eb',
              color: 'white',
              padding: '8px 16px',
              borderRadius: 6,
              fontWeight: 'bold',
              fontSize: 13,
              cursor: 'pointer',
              border: 'none',
              width: '100%',
              transition: 'background 0.2s',
            }}
          >
            {copied ? 'Copied!' : 'Copy Positions'}
          </button>
          <div style={{ marginTop: 12, color: '#64748b', fontSize: 11 }}>
            {zones.map((z) => (
              <div key={z.id}>
                {z.id}: ({z.x},{z.y})
              </div>
            ))}
          </div>
        </div>
      </Html>
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Main export — switches between normal and edit mode
// ---------------------------------------------------------------------------
export default function ArenaBuildings({ fullDetail = true }: { fullDetail?: boolean }) {
  const [editMode] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('edit'),
  );

  if (editMode) return <EditMode />;

  if (!fullDetail) {
    return (
      <group>
        {buildingZones.map((zone, index) => (
          <BuildingProxy key={zone.id} zone={zone} index={index} />
        ))}
      </group>
    );
  }

  return (
    <Suspense fallback={null}>
      <group>
        {buildingZones.map((zone) => (
          zone.id === 'messaging-channels'
            ? <ProceduralSandyTreedome key={zone.id} zone={zone} />
            : <GLBBuilding key={zone.id} zone={zone} />
        ))}
      </group>
    </Suspense>
  );
}
