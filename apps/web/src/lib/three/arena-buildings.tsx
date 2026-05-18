'use client';

import { useMemo, useRef, useState, useEffect, useCallback, Suspense } from 'react';
import * as THREE from 'three';
import { useGLTF, Html } from '@react-three/drei';
import { useWorldLabel, WorldLabel } from '@/lib/three/world-labels-overlay';
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

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;
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

// Shared raycaster -- only hits layer 1 (terrain)
const _buildRaycaster = new THREE.Raycaster();
_buildRaycaster.layers.set(TERRAIN_LAYER);
const _buildRayOrigin = new THREE.Vector3();
const _buildRayDir = new THREE.Vector3(0, -1, 0);

// Target height for all buildings (world units).
// 800 gives buildings proper visual weight on the 160x160 (5120 world-unit) map —
// previously 480 made buildings feel like tiny props relative to the vast sand floor.
const BUILDING_TARGET_HEIGHT = 800;

// Map each building ID to a GLB model + display config.
// rotY: each building faces the village center at tile (80, 80) = world (0, 0).
// Formula: cx = zone.x + zone.width/2, cz = zone.y + zone.height/2
//          dx = 80 - cx, dz = 80 - cz
//          rotY = Math.atan2(dx, dz)  (model faces +Z at rotY=0)
// Ring layout (radius 56, 36° spacing): all angles are exactly atan2(−sin_i, −cos_i)
// where θ_i = −π/2 + i*(π/5). Values recomputed for 2026-04-16 ring layout.
/**
 * scaleOverride: bypasses computeBuildingScale entirely. Use for GLBs that
 * confuse the bbox-based auto-scale — typically GLBs that use
 * `EXT_mesh_gpu_instancing` where the source mesh bbox doesn't reflect
 * the instanced-rendered extent.
 *
 * yOffset: world-unit shift applied AFTER scaling. Negative values lower the
 * building (use to ground a floating model whose pivot isn't at its base).
 */
const BUILDING_MODELS: Record<string, { model: string; yOffset: number; rotY?: number; rotYOffset?: number; scaleOverride?: number; box3Recenter?: boolean; onClick?: () => void }> = {
  // ---------------------------------------------------------------------------
  // 12-building square ring (Phase 6.0.1, 2026-05-17)
  // rotY = atan2(80 − cx_tile, 80 − cy_tile) so building faces plaza center.
  // Square ring slots: N1-N3 (north), E1-E3 (east), S1-S3 (south), W1-W3 (west).
  // ---------------------------------------------------------------------------

  // === NORTH SIDE ===
  // N1 center=(32,8)  dx=48,dz=72  → atan2(48,72)≈0.588
  'visual-creation':     { model: '/models/pineapple-house.glb',     yOffset: 0, rotY:  0.588 },
  // N2 center=(80,8)  dx= 0,dz=72  → atan2(0,72)=0
  // squidward-house.glb = Squidward's Easter Island moai head house (CC-BY, Yanez Designs)
  'memory-rag':          { model: '/models/squidward-house.glb',     yOffset: 0, rotY:  0.000 },
  // N3 center=(128,8) dx=-48,dz=72 → atan2(-48,72)≈-0.588
  // rotYOffset: salty-spitoon.glb authored facing +X; -π/2 aligns toward village center.
  'api-integrations':    { model: '/models/salty-spitoon.glb',       yOffset: 0, rotY: -0.588, rotYOffset: -Math.PI / 2 },

  // === EAST SIDE ===
  // E1 center=(152,32) dx=-72,dz=48 → atan2(-72,48)≈-0.983
  'cron-automation':     { model: '/models/patty-building.glb',      yOffset: 0, rotY: -0.983 },
  // E2 center=(152,80) dx=-72,dz= 0 → atan2(-72,0)=-π/2≈-1.571
  // casino-exterior.glb = Pyramid Casino (CC-BY-4.0, tl0615 / Sketchfab).
  // GLB author placed geometry at ~(-1800, 166, 4540) Blender units from scene origin.
  // box3Recenter=true documents the origin-offset; centering is handled by
  // computeBuildingScale's pivotOffsetX/Z (same pipeline as every other building).
  // Interior load is Concern 6.0.2; onClick is a placeholder per Concern 6.0.1 spec.
  'casino':              { model: '/models/casino/casino-exterior.glb', yOffset: 0, rotY: -1.571, box3Recenter: true,
                           onClick: () => { console.info('[casino] interior pending — Concern 6.0.2'); } },
  // E3 center=(152,128) dx=-72,dz=-48 → atan2(-72,-48)≈-2.159
  // rotYOffset: boating-school.glb classroom must face center.
  'app-publishing':      { model: '/models/boating-school.glb',      yOffset: 0, rotY: -2.159, rotYOffset: Math.PI / 2 },

  // === SOUTH SIDE ===
  // S1 center=(32,152) dx=48,dz=-72 → atan2(48,-72)≈2.554
  'deployment-ops':      { model: '/models/building-lighthouse.glb', yOffset: 0, rotY:  2.554 },
  // S2 center=(80,152) dx= 0,dz=-72 → atan2(0,-72)=π≈3.142
  // patricks-rock-v2.glb (3.88 MB, original patricks_house_spongebob.glb)
  'agent-security':      { model: '/models/patricks-rock-v2.glb',    yOffset: 0, rotY:  3.142 },
  // S3 center=(128,152) dx=-48,dz=-72 → atan2(-48,-72)≈-2.554
  // claw-arcade-exterior.glb = Arcade City (CC-BY-4.0, vanessalani / Sketchfab).
  // Interior / crane game is Phase 6.3 — onClick is placeholder per Concern 6.0.1.
  'claw-arcade':         { model: '/models/arcade/claw-arcade-exterior.glb', yOffset: 0, rotY: -2.554,
                           onClick: () => { console.info('[claw-arcade] interior pending — Concern 6.3'); } },

  // === WEST SIDE ===
  // W1 center=(8,32)  dx=72,dz=48  → atan2(72,48)≈0.983
  // 2026-05-12: swapped to sandy-treedome-v3.glb (sandy_tree_final.glb, 4.4 MB).
  'messaging-channels':  { model: '/models/sandy-treedome-v3.glb',   yOffset: 0, rotY:  0.983, rotYOffset: Math.PI },
  // W2 center=(8,80)  dx=72,dz= 0  → atan2(72,0)=π/2≈1.571
  // krusty-krab-v2.glb = iconic ship restaurant (CC-BY, Yanez Designs, 1.59 MB original).
  'mcp-tool-use':        { model: '/models/krusty-krab-v2.glb',      yOffset: 0, rotY:  1.571 },
  // W3 center=(8,128) dx=72,dz=-48 → atan2(72,-48)≈2.159
  // 2026-05-12: chum-bucket-v2.glb restored from spongebob_chum_bucket.glb (1.85 MB original).
  'code-development':    { model: '/models/chum-bucket-v2.glb',      yOffset: 0, rotY:  2.159 },
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
// This prevents wide GLBs (pineapple, boating-school, salty-spitoon) from
// dominating the scene — they'll stand shorter than 800 but won't sprawl.
// Tightened 1400→1000 (2026-04-16 ring expansion): ring is now radius 72 tiles
// (2304 wu, was 68/2176 — bumped 2026-05-13 for inner-band breathing room).
// Circumference/10 = 1448 wu per slot. MAX_FOOTPRINT=1000 gives a 448 wu
// (~14 tile) gap between neighboring buildings — visually spread out.
const MAX_FOOTPRINT = 1000;

// Scratch objects for computeBuildingScale — module-scope to avoid per-call GC.
const _buildBbox = new THREE.Box3();
const _buildMeshBox = new THREE.Box3();
const _buildSize = new THREE.Vector3();
const _buildCenter = new THREE.Vector3();

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
 *  Scale: normalizes so the building's Y-height = BUILDING_TARGET_HEIGHT.
 *  Uses size.y exclusively — NOT max(w,h,d). Wide/squat buildings (salty-spitoon,
 *  boating-school) would otherwise have their width become the normalizing dim,
 *  crushing actual height far below 800.
 *
 *  Footprint cap: if after height normalization max(scaled_sx, scaled_sz) > MAX_FOOTPRINT,
 *  scale is reduced so the widest XZ dimension = MAX_FOOTPRINT. Wide buildings will be
 *  shorter than 800 but won't sprawl and dominate the scene.
 *
 *  Pivot correction: some GLBs (e.g. downtown-building.glb) have their geometry
 *  authored far from the scene pivot. pivotOffsetX/Z = bbox_center_XZ * scale,
 *  which the caller subtracts from the world position so the geometry's visual
 *  center lands at the intended world coordinate.
 *
 *  Excludes SkinnedMesh nodes from the bbox to avoid bind-pose inflation.
 *  Called AFTER stripping ground planes. */
function computeBuildingScale(scene: THREE.Object3D): BuildingScaleResult {
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
  // Use Y (height) as the normalizing dimension. Fall back to maxDim only if Y
  // is degenerate (e.g. a completely flat mesh or a scene with zero height content).
  const h = _buildSize.y > 0.001 ? _buildSize.y : Math.max(_buildSize.x, _buildSize.y, _buildSize.z);
  let scale = h === 0 ? 1 : BUILDING_TARGET_HEIGHT / h;

  // Footprint cap — shrink wide buildings so they don't dominate the scene.
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

// Preload all 12 models (Phase 6.0.1: added casino-exterior.glb + claw-arcade-exterior.glb).
// extendLoaderWithMeshopt registers MeshoptDecoder on the per-call loader so
// GLBs with EXT_meshopt_compression (patricks-rock, krusty-krab, chum-bucket)
// decode at preload time. Without this, the module-scope preload fires before
// drei's shared loader has the decoder registered → those buildings load as
// empty scenes and don't render.
Object.values(BUILDING_MODELS).forEach(({ model }) => {
  useGLTF.preload(model, undefined, undefined, extendLoaderWithMeshopt);
});

// Entertainment building labels (casino, claw-arcade) — not in BUILDING_OPENCLAW_THEMES
// (those are shop-only). Defined here so GLBBuilding can render a label for them.
const ENTERTAINMENT_LABELS: Record<string, { label: string; category: string }> = {
  'casino':      { label: 'Pyramid Casino', category: 'Entertainment' },
  'claw-arcade': { label: 'Arcade City',    category: 'Arcade' },
};

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

  // WorldLabelsOverlay label — always visible (buildings are never distance-culled).
  // pointerEvents='auto' preserves click-target behavior from the original <Html>.
  const { divRef: labelDivRef } = useWorldLabel({
    id: `building-label-${zone.id}`,
    anchorRef: groupRef,
    offset: [0, BUILDING_TARGET_HEIGHT + 20, 0],
    initialVisible: true,
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
      // Strip flat ground planes before measuring height so BUILDING_TARGET_HEIGHT
      // is accurate — ground planes inflate the bounding box and make buildings
      // appear shorter than 100 world units after scaling.
      stripGroundPlanes(c);
      const { scale: s, pivotOffsetX: px, pivotOffsetY: py, pivotOffsetZ: pz } = computeBuildingScale(c);
      result = { cloned: c, buildingScale: s, pivotOffsetX: px, pivotOffsetY: py, pivotOffsetZ: pz };
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
  }, [scene, config.model, config.scaleOverride, zone.id]);

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

  // Shop buildings use BUILDING_OPENCLAW_THEMES; entertainment buildings (casino,
  // claw-arcade) use ENTERTAINMENT_LABELS fallback. Both render the same label UI.
  const theme = BUILDING_OPENCLAW_THEMES[zone.id] ?? ENTERTAINMENT_LABELS[zone.id];

  // Buildings sit on the flat sand floor (y=-2). No raycasting needed —
  // dune ripples are small relative to the 100-unit building height.
  // pivotOffsetX/Z corrects for GLBs authored with geometry far from their pivot
  // (e.g. downtown-building.glb bbox center is ~4120wu east of scene origin;
  //  casino-exterior.glb authored at ~(-1800, 166, 4540) Blender units — box3Recenter
  //  flag documents this but the actual centering is handled by computeBuildingScale
  //  pivotOffsetX/Z like every other building).
  return (
    <group ref={groupRef} position={[cx, -2 + config.yOffset, cz]} rotation={[0, (config.rotY ?? 0) + (config.rotYOffset ?? 0), 0]}>
      <group position={[-pivotOffsetX, -pivotOffsetY, -pivotOffsetZ]}>
        <primitive object={cloned} scale={buildingScale} />
      </group>
      {/* Invisible click volume — used by entertainment buildings (casino, claw-arcade)
          that have a config.onClick handler. Sized to ~1/8 of BUILDING_TARGET_HEIGHT
          to give a generous click target without needing a visible mesh. */}
      {config.onClick && (
        <mesh
          position={[0, BUILDING_TARGET_HEIGHT * 0.4, 0]}
          onClick={(e) => { e.stopPropagation(); config.onClick!(); }}
        >
          <boxGeometry args={[200, BUILDING_TARGET_HEIGHT * 0.8, 200]} />
          <meshBasicMaterial visible={false} />
        </mesh>
      )}
      {/* Floating building label — WorldLabelsOverlay projects offset [0, BUILDING_TARGET_HEIGHT+20, 0].
          pointerEvents='auto' preserves click-target behavior. */}
      {theme && (
        <WorldLabel divRef={labelDivRef} pointerEvents="auto">
          <div
            style={{
              background: 'rgba(10, 22, 40, 0.85)',
              backdropFilter: 'blur(4px)',
              border: '1px solid rgba(56, 189, 248, 0.3)',
              borderRadius: 8,
              padding: '6px 12px',
              cursor: 'pointer',
              textAlign: 'center',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            <div style={{ color: '#7dd3fc', fontWeight: 'bold', fontSize: 13 }}>{theme.label}</div>
            <div style={{ color: 'rgba(148,163,184,0.7)', fontSize: 10, marginTop: 2 }}>{theme.category}</div>
          </div>
        </WorldLabel>
      )}
    </group>
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
    const { scale: s, pivotOffsetX: px, pivotOffsetY: py, pivotOffsetZ: pz } = computeBuildingScale(c);
    return { cloned: c, buildingScale: s, pivotOffsetX: px, pivotOffsetY: py, pivotOffsetZ: pz };
  }, [scene]);

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
export default function ArenaBuildings() {
  const [editMode] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('edit'),
  );

  if (editMode) return <EditMode />;

  return (
    <Suspense fallback={null}>
      <group>
        {buildingZones.map((zone) => (
          <GLBBuilding key={zone.id} zone={zone} />
        ))}
      </group>
    </Suspense>
  );
}
