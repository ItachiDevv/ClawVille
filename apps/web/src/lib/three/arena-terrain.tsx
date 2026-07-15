'use client';

import { Suspense, useEffect, useRef, useMemo, type ReactElement } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, buildingZones } from '@/lib/pixi/tilemap-data';
import { makeGeometryWebGPUSafe, makeObject3DWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { initTerrainHeightfield } from '@/lib/three/terrain-heightfield';
import { preloadKTX2Bytes, useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';

// ---------------------------------------------------------------------------
// Terrain: Bikini Bottom GLB + sand floor + coral/kelp decorations
// ---------------------------------------------------------------------------

export const TERRAIN_LAYER = 1;

// bikini-bottom.glb REMOVED — it contained duplicate buildings (Krusty Krab,
// Pineapple, Squidward's, Patrick's Rock) baked into one scene, overlapping
// with our individual building GLBs. Sand floor + individual buildings is cleaner.
//
// Decoration preloads have been MOVED to DeferredTerrainPreloads (exported below).
// They are fired via requestAnimationFrame after first paint from the game page,
// so they don't delay the initial scene mount.  The Suspense fallback={null} wrapper
// on ArenaTerrain means decorations simply render nothing until the assets resolve.

// Sand colors — GRAPHIC high-contrast palette, visible from any camera distance
const SAND_RIDGE  = new THREE.Color(0xfff0d4); // Bright white-sand peaks
const SAND_HIGH   = new THREE.Color(0xe8d0a8); // Warm sand
const SAND_MID    = new THREE.Color(0xc4a878); // Golden mid-tone
const SAND_VALLEY = new THREE.Color(0x8a7050); // Dark moody valleys
const SAND_DEEP   = new THREE.Color(0x5c4a32); // Deep brown-black troughs

/** Seeded PRNG for deterministic terrain */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Build subdivided sand plane with LARGE visible dunes and strong per-vertex colors */
function createSandGeometry(): THREE.PlaneGeometry {
  const w = MAP_WIDTH * 3;
  const h = MAP_HEIGHT * 3;
  const segsX = 120;
  const segsY = 120;
  const geo = new THREE.PlaneGeometry(w, h, segsX, segsY);

  const pos = geo.attributes.position;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const rng = seededRandom(42);
  const tmpColor = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);

    // Large dramatic dunes with multiple octaves
    const dune1 = Math.sin(x * 0.004 + 1.3) * Math.cos(y * 0.006 + 0.7) * 14;
    const dune2 = Math.sin(x * 0.01 + 3.1) * Math.sin(y * 0.013 + 2.4) * 8;
    const dune3 = Math.sin(x * 0.025 + 0.5) * Math.cos(y * 0.03 + 1.2) * 4;
    // Visible sand ripple pattern — tighter frequency, adds texture detail
    const ripple = Math.sin(x * 0.08 + y * 0.06) * 2;
    const ripple2 = Math.sin(x * 0.12 - y * 0.09) * 1;
    const noise = (rng() - 0.5) * 1.5;
    const totalHeight = dune1 + dune2 + dune3 + ripple + ripple2 + noise;
    pos.setZ(i, totalHeight);

    // GRAPHIC color bands — sharp contrast between heights
    // Heights range roughly -28 to +28, normalize to 0..1
    const t = Math.max(0, Math.min(1, (totalHeight + 28) / 56));

    if (t < 0.15) {
      tmpColor.lerpColors(SAND_DEEP, SAND_VALLEY, t / 0.15);
    } else if (t < 0.35) {
      tmpColor.lerpColors(SAND_VALLEY, SAND_MID, (t - 0.15) / 0.2);
    } else if (t < 0.55) {
      tmpColor.lerpColors(SAND_MID, SAND_HIGH, (t - 0.35) / 0.2);
    } else if (t < 0.8) {
      tmpColor.lerpColors(SAND_HIGH, SAND_RIDGE, (t - 0.55) / 0.25);
    } else {
      tmpColor.copy(SAND_RIDGE);
    }

    // Scattered dark wet patches for visual interest
    if (rng() < 0.1) {
      tmpColor.lerp(SAND_DEEP, 0.5);
    }
    // Occasional bright spots
    if (rng() < 0.05) {
      tmpColor.lerp(SAND_RIDGE, 0.3);
    }

    colors[i * 3] = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  // Build the O(1) heightfield for NPC / avatar terrain-Y queries.
  // Must be called AFTER pos.setZ() loop above so displaced positions are baked.
  // segsX=120, segsY=120 must match the PlaneGeometry constructor above.
  initTerrainHeightfield(geo, 120, 120);

  return geo;
}

function SandFloor() {
  const ref = useRef<THREE.Mesh>(null);
  const sandGeo = useMemo(() => createSandGeometry(), []);
  const sandMat = useMemo(
    () => new THREE.MeshBasicMaterial({ vertexColors: true, fog: true }),
    [],
  );

  useEffect(() => {
    if (ref.current) {
      ref.current.layers.enable(TERRAIN_LAYER);
      // PERF: terrain never moves after mount. Disable matrixAutoUpdate so
      // Three.js skips the per-frame matrix re-multiply for this mesh
      // (was contributing to the 9.9% updateMatrixWorld cost in the profile).
      ref.current.matrixAutoUpdate = false;
      ref.current.updateMatrix();
    }
    // Dispose both geometry and material on unmount to prevent GPU memory leaks.
    return () => {
      sandGeo.dispose();
      sandMat.dispose();
    };
  }, [sandGeo, sandMat]);

  return (
    <mesh
      ref={ref}
      geometry={sandGeo}
      material={sandMat}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -2, 0]}
    />
  );
}

// ---------------------------------------------------------------------------
// Procedural decoration placement across the full map
// Uses seeded RNG for deterministic placement, avoids building zones
// ---------------------------------------------------------------------------
interface DecoEntry {
  model: string;
  x: number;
  z: number;
  scale: number;
  rotY: number;
}

// Decoration models — scale ranges capped to keep max dimension ≤ 150 world units.
// Rationale: at perspective from origin, a 600-unit wide coral cluster at distance
// 3000-5000 dominates the view even though it's outside the village ring.
// Coral/kelp native bboxes are ~5-10 units wide/tall; cap at 15 → max ~150 wu.
// Shell/seashell native bboxes ~3-5 units; cap at 15 → max ~75 wu.
// Small props (anchor, barrel, chest, lantern, tower2) already safe at their caps.
const DECO_TYPES = [
  // Coral — moderate presence, capped at 15 to prevent 500+ wu wide clusters
  { model: '/models/coral-reef1-ktx.glb?v=2', weight: 3, minScale: 4,   maxScale: 15  },
  { model: '/models/coral-reef2-ktx.glb?v=2', weight: 3, minScale: 3,   maxScale: 13  },
  { model: '/models/coral-reef3-ktx.glb?v=2', weight: 3, minScale: 3,   maxScale: 12  },
  // Kelp — tall accent, capped at 15 (was 30; was producing 600+ wu wide blades)
  { model: '/models/kelp.glb',        weight: 3, minScale: 6,   maxScale: 15  },
  // Shells — clusters of tiny to medium (was maxScale 18-20, now 12)
  { model: '/models/building-shell-ktx.glb?v=2',    weight: 5, minScale: 2,   maxScale: 12  },
  { model: '/models/building-seashell-ktx.glb?v=2', weight: 5, minScale: 2,   maxScale: 12  },
  // Anchors — scattered singles, small to moderate
  { model: '/models/building-anchor.glb', weight: 4, minScale: 3,   maxScale: 14  },
  // Barrels — common ocean-floor clutter
  { model: '/models/building-barrel.glb', weight: 4, minScale: 3,   maxScale: 10  },
  // Chests — treasure accents
  { model: '/models/building-chest.glb',  weight: 4, minScale: 3,   maxScale: 12  },
  // Lanterns — ambient glow props, small to medium
  { model: '/models/building-lantern-ktx.glb?v=2', weight: 3, minScale: 4,  maxScale: 12  },
  // Crayfish — scattered critters, small
  { model: '/models/crayfish-ktx.glb?v=2',         weight: 3, minScale: 3,  maxScale: 10  },
  // Tower2 — distinctive landmark towers, rare
  { model: '/models/building-tower2.glb',  weight: 2, minScale: 4,  maxScale: 14  },
  // Shipwrecks and submarines are placed as FIXED LANDMARKS below (not scattered)
  // so they always appear in visually meaningful spots rather than random.
];

// All decoration preloads have been moved to DeferredTerrainPreloads() below.

// Building exclusion zones (world coords) — no decorations within 80px of building center
const HALF_MW = MAP_WIDTH / 2;
const HALF_MH = MAP_HEIGHT / 2;
// Derive exclusion zones from canonical tilemap-data buildingZones (single source of truth)
const BUILDING_ZONES = buildingZones.map(z => ({
  cx: -HALF_MW + (z.x + z.width / 2) * TILE_SIZE,
  cz: -HALF_MH + (z.y + z.height / 2) * TILE_SIZE,
  radius: Math.max(z.width, z.height) * TILE_SIZE * 2.0,
}));

function isNearBuilding(x: number, z: number): boolean {
  for (const b of BUILDING_ZONES) {
    const dx = x - b.cx;
    const dz = z - b.cz;
    if (dx * dx + dz * dz < b.radius * b.radius) return true;
  }
  return false;
}

// Village center world coordinates: center tile (120, 120) in 240×240 grid (Phase 6.1)
// worldX = -HALF_MW + 120*TILE_SIZE = -3840 + 3840 = 0
// worldZ = -HALF_MH + 120*TILE_SIZE = -3840 + 3840 = 0
const VILLAGE_CX = 0;
const VILLAGE_CZ = 0;
// No decorations within this radius — keeps the immediate town plaza clear.
// Phase 6.2 (2026-05-18): reduced from 1500 to 800 now that props (bazaar stall,
// marketplace stall, auction dome) are spread to 800-1000wu from center. Decorations
// in the 800-3000wu band give the plaza natural context; inside 800wu stays clear for
// the NPC/guide/stall cluster. Building ring is now at R=5120wu so the old 1500wu
// exclusion was unnecessarily tight (props were already spread beyond that radius).
const DECO_INNER_EXCLUSION_R = 800;

/** Generate all decorations with cluster-based organic scatter.
 *
 *  Algorithm (mirrors the merged-seaweed multivariant pattern):
 *  1. Generate N_CLUSTERS cluster centres spread across the full map extents.
 *  2. For each decoration attempt, pick a random cluster centre.
 *  3. Sample distance from that centre using a triangular distribution
 *     (rng() + rng()) * CLUSTER_RADIUS — biases placements toward the centre,
 *     producing Gaussian-like falloff without an actual Gaussian.
 *  4. Reject if inside the inner village exclusion zone or a building zone.
 *
 *  This creates natural dense patches with sparse gaps between them instead of
 *  the uniform "salt-and-pepper" look of pure random placement.
 */
function generateDecorations(): DecoEntry[] {
  const rng = seededRandom(12345);
  const totalWeight = DECO_TYPES.reduce((s, d) => s + d.weight, 0);
  const entries: DecoEntry[] = [];
  // 2026-05-13: bumped 30 → 60. With DECO_INNER_EXCLUSION_R reduced to 1500
  // the visible annulus is now ~1500–3800wu (3300wu band) instead of the old
  // 2700–4500wu (1800wu band) — close to 2× the visible area, so 2× props.
  // Update WorldContent.md §5 when you change.
  const TARGET_COUNT = 60;

  // Hard distance cap — any prop beyond this radius from world origin is
  // rejected. 3800wu chosen so decorations sit fully inside the fog-free zone
  // (fog.near=4500wu). Lateral placement at +1300 Z camera still lands ≤5100wu
  // from camera — below the 22% fog factor threshold at 5493wu far-ring.
  const MAX_VISIBLE_DIST = 3800;
  const MAX_VISIBLE_DIST_SQ = MAX_VISIBLE_DIST * MAX_VISIBLE_DIST;

  // Map extents — narrowed further (1.76 → 1.4) on 2026-05-13 so cluster
  // centres land inside the new closer visible annulus (1500–3800wu) rather
  // than the old 2700–4500wu band.
  const EXTENT_X = MAP_WIDTH  * 1.4;
  const EXTENT_Z = MAP_HEIGHT * 1.4;

  // ---- Cluster centres ----
  // 12 clusters (down from 24) — fewer entries to spread across, so fewer
  // cluster centres keeps each cluster meaningfully dense.
  const N_CLUSTERS    = 12;
  const CLUSTER_RADIUS = 280; // world-space units; controls patch spread
  const clusters: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < N_CLUSTERS; i++) {
    clusters.push({
      x: (rng() - 0.5) * EXTENT_X,
      z: (rng() - 0.5) * EXTENT_Z,
    });
  }

  // Pick a model based on weighted random
  function pickModel() {
    let r = rng() * totalWeight;
    for (const dt of DECO_TYPES) {
      r -= dt.weight;
      if (r <= 0) return dt;
    }
    return DECO_TYPES[0];
  }

  // Minimum spacing between decorations — tighter than before for denser look
  const MIN_SPACING_SQ = 35 * 35;

  let attempts = 0;
  while (entries.length < TARGET_COUNT && attempts < 1200) {
    attempts++;

    // Pick a random cluster centre
    const cluster = clusters[Math.floor(rng() * N_CLUSTERS)];

    // Triangular distribution for distance: (rng()+rng()) biases toward 0
    const dist  = (rng() + rng()) * CLUSTER_RADIUS;
    const angle = rng() * Math.PI * 2;
    const x = cluster.x + Math.cos(angle) * dist;
    const z = cluster.z + Math.sin(angle) * dist;

    // Clamp to map extents so nothing spawns off the sand plane
    if (Math.abs(x) > EXTENT_X * 0.5 || Math.abs(z) > EXTENT_Z * 0.5) continue;

    // Skip if inside the inner village plaza — keep the town center clear
    const dcx = x - VILLAGE_CX;
    const dcz = z - VILLAGE_CZ;
    const radiusSq = dcx * dcx + dcz * dcz;
    if (radiusSq < DECO_INNER_EXCLUSION_R * DECO_INNER_EXCLUSION_R) continue;

    // 2026-05-12: hard cap on outer distance. Anything past MAX_VISIBLE_DIST is
    // above the fog.near=4500wu threshold (Phase 6.2.1). Audited via
    // scripts/audit-decorations.mjs.
    if (radiusSq > MAX_VISIBLE_DIST_SQ) continue;

    // Skip if inside a building exclusion zone
    if (isNearBuilding(x, z)) continue;

    // Minimum spacing check
    const tooClose = entries.some(e => {
      const dx = e.x - x;
      const dz = e.z - z;
      return dx * dx + dz * dz < MIN_SPACING_SQ;
    });
    if (tooClose) continue;

    const dt    = pickModel();
    const scale = dt.minScale + rng() * (dt.maxScale - dt.minScale);
    entries.push({ model: dt.model, x, z, scale, rotY: rng() * Math.PI * 2 });
  }

  return entries;
}

const DECORATIONS: DecoEntry[] = generateDecorations();

/** Recursively dispose all geometries and materials in a cloned THREE.Object3D tree. */
function disposeClone(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else {
        mesh.material?.dispose();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// MergedDecorations — replaces 80 × SingleDecoration (~3000+ individual meshes)
// with geometry-merged draw calls bucketed by (spatialCell, materialUUID).
//
// Strategy:
//   1. Load all 12 unique decoration models (fixed hook calls — count never changes).
//   2. For each of the 80 DECORATIONS entries, determine its 3×3 spatial grid cell
//      based on world-space X/Z position.
//   3. For each mesh in that entry's source scene, apply the combined world transform
//      (entry position/scale/rotY × GLB-internal matrixWorld) into a geometry clone.
//   4. Bucket by `${cellIndex}_${materialUUID}`.
//   5. mergeGeometries() per bucket → one Mesh per (cell, material).
//   6. frustumCulled stays at THREE default (true) — each chunk has a tight AABB
//      covering only its grid cell, so off-screen chunks are culled correctly.
//      This restores the pre-merge frustum-cull behaviour that was broken by the
//      single-merged-mesh iteration (which had to use frustumCulled=false because
//      the AABB spanned the whole scene and Three.js would have wrongly culled it
//      based on the spectator cam direction).
//
// Grid: 3×3 = 9 cells covering ±DECO_GRID_HALF (set to 8000wu, generously wrapping
// the scatter extent of MAP_WIDTH * 2.4 = 12288wu half = 6144wu). Each cell is
// ~5333wu wide. With 80 decorations / 9 cells ≈ 9 per cell → ~9×(materials/cell)
// merged meshes total. Spectator cam facing town center: back 4-5 cells are culled,
// leaving only ~40-50 meshes to draw rather than all 80 worth.
//
// Constraints respected:
//   - No SkinnedMesh (decoration GLBs are all static)
//   - No ShaderMaterial / NodeMaterial (guard present; GLBs use MeshStandardMaterial)
//   - matrixAutoUpdate=false on all merged meshes (static, transforms baked in)
//   - Temporary per-mesh geometry clones disposed after merge
//   - computeBoundingBox() called on each merged geometry so Three.js frustum
//     culling uses the actual tight AABB, not the default unset (infinite) box
// ---------------------------------------------------------------------------

// All 12 unique decoration model paths (must match DECO_TYPES exactly)
const DECO_MODEL_PATHS = [
  '/models/coral-reef1-ktx.glb?v=2',
  '/models/coral-reef2-ktx.glb?v=2',
  '/models/coral-reef3-ktx.glb?v=2',
  '/models/kelp.glb',
  '/models/building-shell-ktx.glb?v=2',
  '/models/building-seashell-ktx.glb?v=2',
  '/models/building-anchor.glb',
  '/models/building-barrel.glb',
  '/models/building-chest.glb',
  '/models/building-lantern-ktx.glb?v=2',
  '/models/crayfish-ktx.glb?v=2',
  '/models/building-tower2.glb',
] as const;

// 3×3 spatial grid for chunk-merged frustum culling.
// Half-extent covers the full decoration scatter area: MAP_WIDTH * 2.4 / 2 = 6144wu.
// We use 8000 to give a small margin beyond the scatter boundary.
const DECO_GRID_CELLS = 3;
const DECO_GRID_HALF  = 8000; // ±8000wu total 16000wu; each cell = 16000/3 ≈ 5333wu

function decoGridCell(worldX: number, worldZ: number): number {
  // Map worldX/worldZ from [-HALF, +HALF] → [0, CELLS)
  const col = Math.min(DECO_GRID_CELLS - 1, Math.max(0,
    Math.floor((worldX + DECO_GRID_HALF) / (DECO_GRID_HALF * 2) * DECO_GRID_CELLS)
  ));
  const row = Math.min(DECO_GRID_CELLS - 1, Math.max(0,
    Math.floor((worldZ + DECO_GRID_HALF) / (DECO_GRID_HALF * 2) * DECO_GRID_CELLS)
  ));
  return row * DECO_GRID_CELLS + col;
}

// Scratch matrix for baking world transforms into geometry vertices.
// Module-scope to avoid GC allocations inside the useMemo.
const _decoMatrix = new THREE.Matrix4();

interface MergedBucket {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/** Inner component — loaded inside a Suspense; receives all 12 scenes via hooks. */
function MergedDecorationsInner() {
  // Fixed-count hook calls — one per unique model path. Order is stable (constant array).
  const { scene: s0  } = useGLTFWithKTX2(DECO_MODEL_PATHS[0]);
  const { scene: s1  } = useGLTFWithKTX2(DECO_MODEL_PATHS[1]);
  const { scene: s2  } = useGLTFWithKTX2(DECO_MODEL_PATHS[2]);
  const { scene: s3  } = useGLTFWithKTX2(DECO_MODEL_PATHS[3]);
  const { scene: s4  } = useGLTFWithKTX2(DECO_MODEL_PATHS[4]);
  const { scene: s5  } = useGLTFWithKTX2(DECO_MODEL_PATHS[5]);
  const { scene: s6  } = useGLTFWithKTX2(DECO_MODEL_PATHS[6]);
  const { scene: s7  } = useGLTFWithKTX2(DECO_MODEL_PATHS[7]);
  const { scene: s8  } = useGLTFWithKTX2(DECO_MODEL_PATHS[8]);
  const { scene: s9  } = useGLTFWithKTX2(DECO_MODEL_PATHS[9]);
  const { scene: s10 } = useGLTFWithKTX2(DECO_MODEL_PATHS[10]);
  const { scene: s11 } = useGLTFWithKTX2(DECO_MODEL_PATHS[11]);

  // Build a lookup: model path → GLTF scene
  const sceneMap = useMemo<Map<string, THREE.Object3D>>(() => {
    const m = new Map<string, THREE.Object3D>();
    const scenes = [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11];
    DECO_MODEL_PATHS.forEach((p, i) => m.set(p, scenes[i]));
    return m;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11]);

  // Compute spatially-chunked merged buckets — runs once when all scenes are loaded.
  const buckets = useMemo<MergedBucket[]>(() => {
    // key = `${cellIndex}_${materialUUID}` → { geometries, material }
    const bucketMap = new Map<string, { geometries: THREE.BufferGeometry[]; material: THREE.Material }>();
    const tempGeos: THREE.BufferGeometry[] = [];

    for (const entry of DECORATIONS) {
      const sourceScene = sceneMap.get(entry.model);
      if (!sourceScene) continue;

      // Determine the 3×3 grid cell for this decoration's world position
      const cell = decoGridCell(entry.x, entry.z);

      // Update world matrices of the source scene for correct mesh.matrixWorld
      sourceScene.updateMatrixWorld(true);

      sourceScene.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        // Skip SkinnedMesh (safety — decoration GLBs should not have any)
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
        if (!mesh.geometry) return;

        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (!mat) return;
        // Skip ShaderMaterial / NodeMaterial — merging these causes WebGPU pipeline crashes
        if ((mat as any).isShaderMaterial || (mat as any).isNodeMaterial) return;

        // Build entry's world transform matrix: T(ex,ey,ez) * Ry(rotY) * S(s)
        const cosY = Math.cos(entry.rotY);
        const sinY = Math.sin(entry.rotY);
        const s = entry.scale;
        const ex = entry.x, ey = -2, ez = entry.z;
        // prettier-ignore
        _decoMatrix.set(
          s * cosY,  0, s * sinY, ex,
          0,         s, 0,        ey,
          -s * sinY, 0, s * cosY, ez,
          0,         0, 0,        1,
        );
        // Compose with the mesh's GLB-internal world matrix
        const combinedMatrix = _decoMatrix.clone().multiply(mesh.matrixWorld);

        const geo = makeGeometryWebGPUSafe(mesh.geometry.clone());
        geo.applyMatrix4(combinedMatrix);
        tempGeos.push(geo);

        // Bucket key includes grid cell so each chunk gets its own tight AABB
        const key = `${cell}_${mat.uuid}`;
        if (!bucketMap.has(key)) {
          bucketMap.set(key, { geometries: [], material: mat });
        }
        bucketMap.get(key)!.geometries.push(geo);
      });
    }

    // Merge each bucket and compute a tight bounding box for frustum culling
    const result: MergedBucket[] = [];
    for (const { geometries, material } of bucketMap.values()) {
      if (geometries.length === 0) continue;
      const merged = mergeGeometries(geometries, false);
      if (!merged) {
        console.warn('[MergedDecorations] mergeGeometries returned null for material', material.name);
        geometries.forEach((g) => g.dispose());
        continue;
      }
      // CRITICAL: compute bounding box/sphere so Three.js frustum culling uses
      // the actual tight AABB for this spatial chunk, not the default null box.
      // Without this, frustumCulled=true would behave as always-visible.
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      result.push({ geometry: merged, material });
    }

    // Dispose all temporary per-mesh geometry clones — the merged geometry has
    // independent attribute buffers (mergeGeometries copies data via TypedArray.set)
    tempGeos.forEach((g) => g.dispose());

    return result;
  }, [sceneMap]);

  // Dispose merged geometries on unmount
  useEffect(() => {
    return () => {
      buckets.forEach(({ geometry }) => geometry.dispose());
    };
  }, [buckets]);

  return (
    <>
      {buckets.map(({ geometry, material }, i) => (
        <mesh
          key={i}
          geometry={geometry}
          material={material}
          // matrixAutoUpdate=false: merged meshes sit at world origin with identity
          // matrix — all transforms were baked into vertex positions.
          // frustumCulled: default true — each chunk has a tight cell-local AABB
          // computed above, so off-screen chunks are correctly skipped by the renderer.
          matrixAutoUpdate={false}
        />
      ))}
    </>
  );
}

function UnderwaterDecorations() {
  return (
    <Suspense fallback={null}>
      <MergedDecorationsInner />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// UnderwaterDecorationsGlb — places the 6MB underwater-decorations.glb as a
// single scene primitive. It provides dense sea-floor props in one draw call,
// in addition to the procedurally-scattered individual decorations above.
// Positioned OUTSIDE the village ring so it doesn't clutter the town center.
// ---------------------------------------------------------------------------
function UnderwaterDecorationsGlb() {
  const { scene } = useGLTF('/models/underwater-decorations.glb');
  // Clone once so we own the scene (avoid mutating the cached original)
  const cloned = useMemo(() => {
    const c = scene.clone(true);
    makeObject3DWebGPUSafe(c);
    return c;
  }, [scene]);

  useEffect(() => () => disposeClone(cloned), [cloned]);

  return (
    <primitive
      object={cloned}
      position={[-600, -2, 1900]}
      scale={8}
      rotation={[0, 0, 0]}
    />
  );
}

// ---------------------------------------------------------------------------
// Fixed landmark decorations — shipwreck + submarine placed at world-space
// coordinates chosen to be visually dramatic without cluttering the village.
// These are rendered as single cloned primitives (no instancing) — safe on
// Intel Iris Xe WebGPU.
// ---------------------------------------------------------------------------
function FixedLandmarks() {
  const { scene: shipwreckScene } = useGLTF('/models/building-shipwreck.glb');
  const { scene: submarineScene } = useGLTF('/models/building-submarine.glb');
  const shipwreckClone = useMemo(() => {
    const c = shipwreckScene.clone(true);
    makeObject3DWebGPUSafe(c);
    return c;
  }, [shipwreckScene]);
  const submarineClone = useMemo(() => {
    const c = submarineScene.clone(true);
    makeObject3DWebGPUSafe(c);
    return c;
  }, [submarineScene]);

  useEffect(() => {
    return () => {
      disposeClone(shipwreckClone);
      disposeClone(submarineClone);
    };
  }, [shipwreckClone, submarineClone]);

  return (
    <group>
      {/* Shipwreck — northwest outer zone (scaled out for 5120x5120 map) */}
      <primitive
        object={shipwreckClone}
        position={[-1900, -2, -700]}
        scale={2.5}
        rotation={[0, 0.8, 0]}
      />
      {/* Submarine — southeast outer zone (scaled out for 5120x5120 map) */}
      <primitive
        object={submarineClone}
        position={[1900, -2, 700]}
        scale={2.0}
        rotation={[0, -0.5, 0]}
      />
    </group>
  );
}

export default function ArenaTerrain() {
  return (
    <Suspense fallback={null}>
      <SandFloor />
      {/* Procedurally scattered individual GLB decorations */}
      <UnderwaterDecorations />
      {/*
        REMOVED 2026-04-16: `UnderwaterDecorationsGlb` (underwater-decorations.glb @ scale 8)
        and `FixedLandmarks` (submarine @ scale 2.0 + shipwreck @ scale 2.5). All three were
        authored for the old 2560x2560 world; in the current 5120x5120 world they appeared
        as massive floating silhouettes dominating the scene. The submarine landmark was
        the immediate user complaint ("this massive floating object needs to just be
        removed"). If we want hero-scale landmarks later, they need proper bbox
        normalization + positioning well outside the ring, like the procedural decorations.
      */}
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// DeferredTerrainPreloads
// Render this component OUTSIDE the Canvas (e.g. in the game page HUD layer).
// It fires useGLTF.preload() for all decoration + environment GLBs via
// requestAnimationFrame so the calls land AFTER the first painted frame, not
// at module-evaluation time. The ArenaTerrain Suspense fallback={null} means
// the decorations simply render nothing until each asset resolves — safe.
// ---------------------------------------------------------------------------
export function DeferredTerrainPreloads(): ReactElement | null {
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      // Scatter decoration models
      for (const model of DECO_MODEL_PATHS) {
        if (model.includes('-ktx.glb')) preloadKTX2Bytes(model);
        else useGLTF.preload(model);
      }
      // Note: building-lighthouse.glb is intentionally omitted here — arena-buildings.tsx
      // already preloads it via its module-scope loop over BUILDING_MODELS.
      // REMOVED 2026-04-16: preloads for building-shipwreck, building-submarine, and
      // underwater-decorations.glb. The components that used them (FixedLandmarks +
      // UnderwaterDecorationsGlb) were removed — those landmarks were authored for
      // the old 2560x2560 world and appeared as massive floating silhouettes in the
      // current 5120x5120 world.
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  return null;
}
