'use client';

/**
 * BatchedBuildings — draw-call–optimised production renderer for the 10 static building GLBs.
 *
 * STRATEGY: Option B (Hybrid).
 *   - EditMode (?edit=1) is NOT touched. Only the production rendering path is replaced.
 *   - arena-buildings.tsx keeps all its logic; it imports this component and swaps
 *     the production <group>{buildingZones.map(...)}</group> for <BatchedBuildings />.
 *
 * HOW IT REDUCES DRAW CALLS:
 *   Each building GLB contains N meshes with M unique materials (M ≤ N). The previous
 *   renderer created one draw call per mesh. This renderer groups meshes within each
 *   building by material.uuid and creates one BatchedMesh per material group — reducing
 *   per-building draw calls from N → M.
 *
 *   Cross-building batching is IMPOSSIBLE: each building has unique texture maps, so
 *   each material instance is unique to its building. Two different buildings' meshes
 *   cannot share one BatchedMesh even if both use MeshStandardMaterial.
 *
 * WHY NOT mergeGeometries:
 *   mergeGeometries is a better fit for "many unique static meshes, same material" but
 *   produces a non-updateable merged blob. BatchedMesh gives us per-geometry-slot frustum
 *   culling (Three.js r182 computes a bounding box per geometry slot and culls individually)
 *   and the ability to toggle visibility per slot — useful for future LOD.
 *
 * SKINNED MESH EXCLUSION:
 *   Building GLBs are static — no SkinnedMesh expected. Any SkinnedMesh found is skipped.
 *
 * WORLDLABELSOVERLAY:
 *   Each building registers a lightweight Object3D anchor at its world position (the base
 *   of the building). The overlay projects anchor.worldPosition + offset each frame.
 *   No per-building <group> in the React tree is needed.
 *
 * CLICK HANDLERS:
 *   Building entry is proximity-based (nearLocation + F-key or auto-trigger).
 *   There is no onClick on building mesh geometry — the WorldLabel div carries
 *   pointerEvents='auto' for label clicks, unchanged from the previous implementation.
 *
 * OCCLUDER TAG:
 *   Each BatchedMesh has userData.isOccluder=true so NPC label occlusion raycasts work.
 */

import { useMemo, useRef, useEffect, Suspense, type RefObject } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { useWorldLabel, WorldLabel } from '@/lib/three/world-labels-overlay';
import { BUILDING_OPENCLAW_THEMES } from '@clawville/shared';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
  type BuildingZone,
} from '@/lib/pixi/tilemap-data';
import { makeGeometryWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { useThree } from '@react-three/fiber';

// ---------------------------------------------------------------------------
// Constants — must match arena-buildings.tsx. Verified against source 2026-05-09.
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

/**
 * Target visual height for all buildings (world units).
 * Must match BUILDING_TARGET_HEIGHT in arena-buildings.tsx.
 */
const BUILDING_TARGET_HEIGHT = 800;

/** Maximum footprint (XZ) after height-based normalization. Must match arena-buildings.tsx. */
const MAX_FOOTPRINT = 1000;

/** Per-building GLB paths + rotation/offset config. Mirrors BUILDING_MODELS in arena-buildings.tsx. */
const BUILDING_MODELS: Record<
  string,
  { model: string; yOffset: number; rotY?: number; rotYOffset?: number; scaleOverride?: number }
> = {
  'visual-creation':   { model: '/models/pineapple-house.glb',     yOffset: 0, rotY:  0.000 },
  'memory-rag':        { model: '/models/squidward-house.glb',     yOffset: 0, rotY: -0.632 },
  'api-integrations':  { model: '/models/salty-spitoon.glb',       yOffset: 0, rotY: -1.259, rotYOffset: -Math.PI / 2 },
  'cron-automation':   { model: '/models/patty-building.glb',      yOffset: 0, rotY: -1.882 },
  'app-publishing':    { model: '/models/boating-school.glb',      yOffset: 0, rotY: -2.510, rotYOffset: Math.PI / 2 },
  'deployment-ops':    { model: '/models/building-lighthouse.glb', yOffset: 0, rotY:  3.142 },
  'mcp-tool-use':      { model: '/models/krusty-krab.glb',         yOffset: 0, rotY:  2.510 },
  'code-development':  { model: '/models/chum-bucket.glb',         yOffset: 0, rotY:  1.882 },
  'messaging-channels':{ model: '/models/sandy-treedome.glb',      yOffset: -50, rotY: 1.259, scaleOverride: 60 },
  'agent-security':    { model: '/models/patricks-rock.glb',       yOffset: 0, rotY:  0.632 },
};

// Preload all 10 building GLBs at module scope (matches arena-buildings.tsx).
Object.values(BUILDING_MODELS).forEach(({ model }) => {
  useGLTF.preload(model);
});

// ---------------------------------------------------------------------------
// Helpers — local copies of the bbox / stripping logic from arena-buildings.tsx.
// These must stay in sync. If arena-buildings.tsx changes stripGroundPlanes /
// computeBuildingScale, update here too.
// ---------------------------------------------------------------------------

/** Module-scope scratch — avoid per-call GC. */
const _stripBbox   = new THREE.Box3();
const _stripMeshBx = new THREE.Box3();
const _buildBbox   = new THREE.Box3();
const _buildMeshBx = new THREE.Box3();
const _buildSize   = new THREE.Vector3();
const _buildCenter = new THREE.Vector3();

const DECORATIVE_PARENT_NAMES = new Set(['Flowers', 'Path', 'Skybox', 'Road', 'Sand']);

function stripDecorativeMeshes(scene: THREE.Object3D): void {
  const toRemove: THREE.Object3D[] = [];
  scene.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    let p: THREE.Object3D | null = child.parent;
    while (p) {
      if (p.name && DECORATIVE_PARENT_NAMES.has(p.name)) { toRemove.push(child); break; }
      p = p.parent;
    }
  });
  toRemove.forEach((o) => o.removeFromParent());
}

function stripGroundPlanes(scene: THREE.Object3D): void {
  scene.updateMatrixWorld(true);
  _stripBbox.makeEmpty();
  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      if (!bb) return;
      _stripMeshBx.copy(bb).applyMatrix4(mesh.matrixWorld);
      _stripBbox.union(_stripMeshBx);
    }
  });
  if (_stripBbox.isEmpty()) _stripBbox.setFromObject(scene);
  const fullMinY  = _stripBbox.min.y;
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
    const isFlat = maxXZ > 2 && sy / maxXZ < 0.005;
    const isAtBottom = bb.max.y < fullMinY + fullHeight * 0.05;
    if (isFlat && isAtBottom) toRemove.push(mesh);
  });
  toRemove.forEach((o) => o.removeFromParent());
}

interface BuildingScaleResult {
  scale: number;
  pivotOffsetX: number;
  pivotOffsetY: number;
  pivotOffsetZ: number;
}

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
      _buildMeshBx.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _buildBbox.union(_buildMeshBx);
    }
  });
  if (_buildBbox.isEmpty()) _buildBbox.setFromObject(scene);
  _buildBbox.getSize(_buildSize);
  const h = _buildSize.y > 0.001 ? _buildSize.y : Math.max(_buildSize.x, _buildSize.y, _buildSize.z);
  let scale = h === 0 ? 1 : BUILDING_TARGET_HEIGHT / h;
  const scaledMaxXZ = Math.max(_buildSize.x, _buildSize.z) * scale;
  if (scaledMaxXZ > MAX_FOOTPRINT) scale *= MAX_FOOTPRINT / scaledMaxXZ;
  _buildBbox.getCenter(_buildCenter);
  return {
    scale,
    pivotOffsetX: _buildCenter.x * scale,
    pivotOffsetY: _buildBbox.min.y * scale,
    pivotOffsetZ: _buildCenter.z * scale,
  };
}

function zoneCenter(zone: BuildingZone): [number, number, number] {
  const cx = OFFSET_X + (zone.x + zone.width  / 2) * TILE_SIZE;
  const cz = OFFSET_Z + (zone.y + zone.height / 2) * TILE_SIZE;
  return [cx, 0, cz];
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Convert a geometry attribute to Float32BufferAttribute if it isn't already one.
 * Required for WebGPU stride-alignment safety (mirrors makeGeometryWebGPUSafe but
 * operates directly on geometries we create here).
 */
function ensureFloat32(geo: THREE.BufferGeometry): void {
  for (const [name, attr] of Object.entries(geo.attributes)) {
    if (!attr) continue;
    const ba = attr as THREE.BufferAttribute;
    if (ba.array instanceof Float32Array) continue;
    const f32 = new Float32Array(ba.count * ba.itemSize);
    for (let i = 0; i < ba.count; i++) {
      for (let c = 0; c < ba.itemSize; c++) {
        f32[i * ba.itemSize + c] = ba.getComponent(i, c);
      }
    }
    geo.setAttribute(name, new THREE.Float32BufferAttribute(f32, ba.itemSize));
  }
}

/**
 * Extract one geometry-group range from a source BufferGeometry as a new standalone geometry.
 * Handles both indexed and non-indexed geometries.
 */
function extractGeometryGroup(
  source: THREE.BufferGeometry,
  grp: { start: number; count: number },
): THREE.BufferGeometry {
  const srcIndex = source.getIndex();

  if (!srcIndex) {
    // Non-indexed path: slice the vertex range.
    const geo = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(source.attributes)) {
      if (!attr) continue;
      const ba = attr as THREE.BufferAttribute;
      const slice = new Float32Array(grp.count * ba.itemSize);
      for (let i = 0; i < grp.count; i++) {
        for (let c = 0; c < ba.itemSize; c++) {
          slice[i * ba.itemSize + c] = ba.getComponent(grp.start + i, c);
        }
      }
      geo.setAttribute(name, new THREE.Float32BufferAttribute(slice, ba.itemSize));
    }
    return geo;
  }

  // Indexed path: gather the referenced vertex indices and remap to a compact buffer.
  const rawSub: number[] = [];
  for (let i = grp.start; i < grp.start + grp.count; i++) {
    rawSub.push(srcIndex.getX(i));
  }
  const uniqueVerts = [...new Set(rawSub)].sort((a, b) => a - b);
  const remapMap = new Map<number, number>();
  uniqueVerts.forEach((v, i) => remapMap.set(v, i));

  const newIndex = new Uint32Array(rawSub.map((v) => remapMap.get(v)!));
  const geo = new THREE.BufferGeometry();
  geo.setIndex(new THREE.BufferAttribute(newIndex, 1));

  for (const [name, attr] of Object.entries(source.attributes)) {
    if (!attr) continue;
    const ba = attr as THREE.BufferAttribute;
    const newArr = new Float32Array(uniqueVerts.length * ba.itemSize);
    for (let i = 0; i < uniqueVerts.length; i++) {
      for (let c = 0; c < ba.itemSize; c++) {
        newArr[i * ba.itemSize + c] = ba.getComponent(uniqueVerts[i], c);
      }
    }
    geo.setAttribute(name, new THREE.Float32BufferAttribute(newArr, ba.itemSize));
  }

  return geo;
}

// ---------------------------------------------------------------------------
// Material-group collection
// ---------------------------------------------------------------------------

interface MaterialGroup {
  material: THREE.Material;
  geos: THREE.BufferGeometry[];
}

/**
 * Traverse a cloned building scene, group its static (non-skinned) meshes by
 * shared material.uuid, and bake each mesh's world transform into its vertex positions.
 *
 * The buildingMatrix encodes the full chain:
 *   outerGroup(position + rotation) × innerGroup(pivot offset) × scale
 *
 * After baking, all returned geometries are in world space. The BatchedMesh is
 * placed at the scene origin (identity transform).
 */
function collectMaterialGroups(
  scene: THREE.Object3D,
  buildingMatrix: THREE.Matrix4,
): MaterialGroup[] {
  scene.updateMatrixWorld(true);

  const groupMap = new Map<string, MaterialGroup>();

  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (!mesh.geometry) return;

    // Full world transform for this mesh: buildingMatrix × mesh's local matrixWorld.
    // (The cloned scene has matrixWorld reflecting the hierarchy but NOT the
    //  building's own position/rotation/scale — those are in buildingMatrix.)
    const worldMatrix = new THREE.Matrix4().copy(buildingMatrix).multiply(mesh.matrixWorld);

    const materials = Array.isArray(mesh.material)
      ? (mesh.material as THREE.Material[])
      : [mesh.material as THREE.Material];

    const geomGroups = mesh.geometry.groups;

    if (geomGroups.length > 1 && Array.isArray(mesh.material)) {
      // Split multi-material mesh by geometry groups.
      for (const grp of geomGroups) {
        const mat = materials[grp.materialIndex ?? 0];
        if (!mat) continue;
        const subGeo = extractGeometryGroup(mesh.geometry, grp);
        subGeo.applyMatrix4(worldMatrix);
        ensureFloat32(subGeo);
        // Strip normal attribute if not Float32 after baking (applyMatrix4 handles it).

        if (!groupMap.has(mat.uuid)) groupMap.set(mat.uuid, { material: mat, geos: [] });
        groupMap.get(mat.uuid)!.geos.push(subGeo);
      }
    } else {
      // Single-material mesh (or multi-material without explicit groups).
      const mat = materials[0];
      if (!mat) return;
      const geoClone = mesh.geometry.clone();
      makeGeometryWebGPUSafe(geoClone); // fix interleaved / non-float32 attributes
      geoClone.applyMatrix4(worldMatrix);
      ensureFloat32(geoClone);

      if (!groupMap.has(mat.uuid)) groupMap.set(mat.uuid, { material: mat, geos: [] });
      groupMap.get(mat.uuid)!.geos.push(geoClone);
    }
  });

  return [...groupMap.values()];
}

// ---------------------------------------------------------------------------
// BatchedMesh construction
// ---------------------------------------------------------------------------

/**
 * Build one BatchedMesh per material group.
 * Returns an array of configured BatchedMesh nodes (at world origin, transforms baked).
 * Returns null if the building produced no usable geometry.
 */
function buildBatchedMeshes(matGroups: MaterialGroup[]): THREE.BatchedMesh[] | null {
  if (matGroups.length === 0) return null;

  const result: THREE.BatchedMesh[] = [];
  const identity = new THREE.Matrix4();

  for (const { material, geos } of matGroups) {
    if (geos.length === 0) continue;

    // Count totals for pre-allocation (r182 requires upfront budget — Constraint #1).
    // For non-indexed geometries, we will synthesise a trivial index buffer (v_i → i),
    // so we budget pos.count indices for each non-indexed geometry.
    let totalVerts = 0;
    let totalIdx   = 0;
    for (const geo of geos) {
      const pos = geo.getAttribute('position');
      if (!pos) continue;
      totalVerts += pos.count;
      const idx = geo.getIndex();
      totalIdx += idx ? idx.count : pos.count; // non-indexed: budget pos.count indices
    }
    if (totalVerts === 0) continue;

    const maxIdx = totalIdx;

    // maxInstanceCount = geos.length (one instance per geometry slot).
    // Pre-allocate exact counts so BatchedMesh doesn't throw at runtime.
    const bm = new THREE.BatchedMesh(geos.length, totalVerts, maxIdx, material);
    bm.matrixAutoUpdate = false;
    bm.updateMatrix();
    bm.userData.isOccluder = true;

    for (const geo of geos) {
      const pos = geo.getAttribute('position');
      if (!pos || pos.count === 0) continue;

      // BatchedMesh requires an index buffer. If the geometry is non-indexed, synthesise one.
      if (!geo.getIndex()) {
        const idx = new Uint32Array(pos.count);
        for (let i = 0; i < pos.count; i++) idx[i] = i;
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        // Update totalIdx bookkeeping (already consumed by earlier count — safe to overcount here).
      }

      try {
        const geoId      = bm.addGeometry(geo);
        const instanceId = bm.addInstance(geoId);
        // Transform is baked into vertex data — instance matrix is identity.
        bm.setMatrixAt(instanceId, identity);
      } catch (err) {
        // Over-budget guard: should not happen with exact pre-allocation.
        console.warn('[BatchedBuildings] addGeometry/addInstance failed:', err);
      }
    }

    result.push(bm);
  }

  return result.length > 0 ? result : null;
}

// ---------------------------------------------------------------------------
// BatchedBuildingMeshes — renders one building as ≤M BatchedMesh nodes
// (M = number of unique materials in the building's cloned scene).
// ---------------------------------------------------------------------------

function BatchedBuildingMeshes({ zone }: { zone: BuildingZone }) {
  const config = BUILDING_MODELS[zone.id];
  if (!config) return null;

  const [cx, , cz] = zoneCenter(zone);
  const { scene } = useGLTF(config.model);
  const { scene: threeScene } = useThree();

  // Anchor Object3D at the building's world base for WorldLabelsOverlay projection.
  // Lives outside React — updated in useMemo, cleaned up in useEffect.
  const anchorRef = useRef<THREE.Object3D>(new THREE.Object3D());

  const { divRef: labelDivRef } = useWorldLabel({
    id: `building-label-${zone.id}`,
    anchorRef: anchorRef as RefObject<THREE.Object3D | null>,
    offset: [0, BUILDING_TARGET_HEIGHT + 20, 0],
    initialVisible: true,
  });

  const theme = BUILDING_OPENCLAW_THEMES[zone.id];

  // Compute batched meshes once per source scene load.
  const batchedMeshes = useMemo<THREE.BatchedMesh[] | null>(() => {
    const c = scene.clone(true);

    // Apply WebGPU geometry safety (fix interleaved / non-float32 attributes) on every mesh.
    c.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.isMesh && m.geometry) makeGeometryWebGPUSafe(m.geometry);
    });

    let buildingScale: number;
    let pivotOffsetX:  number;
    let pivotOffsetY:  number;
    let pivotOffsetZ:  number;

    if (config.scaleOverride != null) {
      buildingScale = config.scaleOverride;
      pivotOffsetX  = 0;
      pivotOffsetY  = 0;
      pivotOffsetZ  = 0;
    } else {
      stripDecorativeMeshes(c);
      stripGroundPlanes(c);
      const r = computeBuildingScale(c);
      buildingScale = r.scale;
      pivotOffsetX  = r.pivotOffsetX;
      pivotOffsetY  = r.pivotOffsetY;
      pivotOffsetZ  = r.pivotOffsetZ;
    }

    // Building world matrix: outer(position+rotation) × inner(pivot offset) × scale.
    const rotY = (config.rotY ?? 0) + (config.rotYOffset ?? 0);

    const outerMat = new THREE.Matrix4().compose(
      new THREE.Vector3(cx, -2 + config.yOffset, cz),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0)),
      new THREE.Vector3(1, 1, 1),
    );
    const innerMat = new THREE.Matrix4().makeTranslation(
      -pivotOffsetX,
      -pivotOffsetY,
      -pivotOffsetZ,
    );
    const scaleMat = new THREE.Matrix4().makeScale(
      buildingScale,
      buildingScale,
      buildingScale,
    );

    // Compose: outerMat × innerMat × scaleMat
    // (multiply mutates in place — chain carefully)
    const buildingMatrix = outerMat
      .multiply(innerMat)
      .multiply(scaleMat);

    // Position anchor at building base for label projection.
    const anchor = anchorRef.current;
    anchor.position.set(cx, -2 + config.yOffset, cz);
    anchor.matrixAutoUpdate = false;
    anchor.updateMatrix();
    anchor.updateMatrixWorld(true);

    const matGroups = collectMaterialGroups(c, buildingMatrix);
    return buildBatchedMeshes(matGroups);
  // Scene identity change (new GLB load) and config are the only triggers.
  // cx/cz come from zone which never changes at runtime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, config.model, config.scaleOverride]);

  // Add/remove BatchedMesh nodes and anchor from the Three.js scene graph.
  useEffect(() => {
    const anchor = anchorRef.current;
    threeScene.add(anchor);

    if (!batchedMeshes) {
      return () => { threeScene.remove(anchor); };
    }

    for (const bm of batchedMeshes) threeScene.add(bm);

    return () => {
      threeScene.remove(anchor);
      for (const bm of batchedMeshes) {
        threeScene.remove(bm);
        bm.dispose();
      }
    };
  // batchedMeshes identity changes when the useMemo above re-runs.
  // threeScene is stable (R3F guarantees it for the lifetime of the canvas).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchedMeshes]);

  // Only render the WorldLabel. Geometry is imperatively added to the Three.js scene.
  return theme ? (
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
        <div style={{ color: '#7dd3fc', fontWeight: 'bold', fontSize: 13 }}>
          {theme.label}
        </div>
        <div
          style={{ color: 'rgba(148,163,184,0.7)', fontSize: 10, marginTop: 2 }}
        >
          {theme.category}
        </div>
      </div>
    </WorldLabel>
  ) : null;
}

// ---------------------------------------------------------------------------
// BatchedBuildings — drop-in replacement for the production render path.
// ArenaBuildings (arena-buildings.tsx) renders this instead of its per-building map.
// ---------------------------------------------------------------------------

export default function BatchedBuildings() {
  return (
    <Suspense fallback={null}>
      <>
        {buildingZones.map((zone) => (
          <BatchedBuildingMeshes key={zone.id} zone={zone} />
        ))}
      </>
    </Suspense>
  );
}
