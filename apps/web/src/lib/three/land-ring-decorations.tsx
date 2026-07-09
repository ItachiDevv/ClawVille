'use client';

/**
 * land-ring-decorations.tsx — Ambient decoration density pass for the three
 * land parcel rings (founder / starter / c-tier).
 *
 * PURPOSE:
 *   The ring gaps between player-built parcels read as void. This component
 *   fills the IN-BETWEEN space with sea-themed ambient props (coral, kelp,
 *   barrels, lanterns, anchors, shells) and a flat ring-path strip so the
 *   rings read as inhabited neighbourhoods rather than isolated signposts.
 *
 * SCOPE — FIRST REPRESENTATIVE PASS (founder + starter + c-ring, one section
 *   each, ~1/4 of each ring). Proves the template. Scale to full rings later.
 *
 * PERF CONTRACT:
 *   - ZERO InstancedMesh (WebGPU crash with ShaderMaterial).
 *   - ZERO drei <Text>/<Billboard> (Iris Xe hard crash).
 *   - ZERO per-frame new Vector3/Matrix4 — all scratch is module-scope.
 *   - Pure mergeGeometries() — all GLB props baked into ONE BufferGeometry
 *     per unique material. Expected draw-call budget: ~10-14 additional draws
 *     for all props (bounded by unique material count across the 6 model types,
 *     not prop count). Path ribbons: +2 draw calls (one mat per ring group).
 *   - matrixAutoUpdate=false + computeBoundingBox/Sphere on every merged mesh
 *     so Three.js frustum-culls correctly and skips meshes not in view.
 *   - Fog near=5000 / far=10500 naturally hides c-ring props at distance,
 *     making them cost ~0 fill-rate when not approached.
 *
 * GLB MODELS — reuse assets already preloaded by DeferredTerrainPreloads:
 *   coral-reef1/2/3.glb, kelp.glb, building-barrel.glb, building-lantern-ktx.glb,
 *   building-anchor.glb, building-shell-ktx.glb
 *
 * Iris Xe / WebGPU invariants:
 *   - NO ShaderMaterial / NodeMaterial on any merged mesh
 *   - NO SkinnedMesh merge (decoration GLBs are static)
 *   - NO per-frame allocations in useFrame
 *   - All MeshStandardMaterial (from GLBs) or MeshStandardMaterial (path mat)
 *
 * Draw-call estimate per section pass:
 *   Props: 6 model types × ~2 unique materials each = ~12 merged draw calls.
 *   Path ribbons: 3 ring groups × 1 merged plane = 3, but all share one mat
 *   so it collapses to 1 draw call. Total: ~13 additional draw calls.
 *
 * (2026-06-24 — land-builder-economics density pass, first representative
 *  section: north-side starter ring gap + east-side founder ring gap + south
 *  side of c-ring stretch. Scales to full rings once founder approves the look.)
 */

import { Suspense, useMemo, useEffect } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeGeometryWebGPUSafe } from '@/lib/three/webgpu-geometry';
import { preloadKTX2Bytes, useGLTFWithKTX2 } from '@/lib/three/use-gltf-ktx2';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Y of the sand floor — matches arena-terrain.tsx. */
const FLOOR_Y = -2;

/**
 * Prop-placement Y — props sit just at floor level.
 * Each prop's geometry is baked at floor Y using the same formula as
 * MergedDecorationsInner: entry Y = FLOOR_Y so origin-at-floor GLBs sit flat.
 * GLBs with center-origin (e.g. kelp) sit partially buried — acceptable
 * at this scale since the large parcel context dwarfs them.
 */
const PROP_FLOOR_Y = FLOOR_Y; // -2

// ---------------------------------------------------------------------------
// Parcel ring geometry — copied from land-parcels.ts constants so this file
// has zero dep on shared (pure render component). Keep in sync if tier configs
// change.
// ---------------------------------------------------------------------------

const TILE_SIZE = 32;

/** Founder ring half-side (tiles). */
const FOUNDER_H = 190; // tiles → 6080wu
/** Starter ring half-side (tiles). */
const STARTER_H = 258; // tiles → 8256wu
/** C-ring half-side (tiles). */
const C_H = 305;       // tiles → 9760wu

/** Footprint size per tier (tiles). Used to compute exclusion radii. */
const FOUNDER_FOOT = 38; // tiles → 1216wu
const STARTER_FOOT = 34; // tiles → 1088wu
const C_FOOT       = 34; // tiles → 1088wu

// Parcel center half-footprint in wu — used as the prop exclusion buffer
// around each parcel. Buffer = half-footprint + a small gap (0.6 tiles).
const FOUNDER_EXCL_R = (FOUNDER_FOOT / 2 + 0.6) * TILE_SIZE; // ~634wu
const STARTER_EXCL_R = (STARTER_FOOT / 2 + 0.6) * TILE_SIZE; // ~582wu
const C_EXCL_R       = (C_FOOT       / 2 + 0.6) * TILE_SIZE; // ~582wu

// ---------------------------------------------------------------------------
// Deterministic parcel centers per ring (matches generateParcels() exactly)
// This is a local re-computation so we avoid importing the full shared package
// in a pure render module. The generator is pure math — result identical.
// ---------------------------------------------------------------------------

function squarePerimeterPoint(s: number, h: number): { xt: number; zt: number } {
  const sideLen = 2 * h;
  const side = Math.floor(s / sideLen);
  const local = s - side * sideLen;
  switch (side) {
    case 0: return { xt: -h + local, zt: -h };
    case 1: return { xt: +h, zt: -h + local };
    case 2: return { xt: +h - local, zt: +h };
    case 3: return { xt: -h, zt: +h - local };
    default: return { xt: -h, zt: -h };
  }
}

interface ParcelCenter { cx: number; cz: number; exclR: number; }

function buildRingCenters(h: number, count: number, exclR: number): ParcelCenter[] {
  const perimeter = 8 * h;
  const step = perimeter / count;
  const result: ParcelCenter[] = [];
  for (let i = 0; i < count; i++) {
    const { xt, zt } = squarePerimeterPoint(i * step, h);
    result.push({ cx: Math.round(xt * TILE_SIZE), cz: Math.round(zt * TILE_SIZE), exclR });
  }
  return result;
}

// All parcel centers for exclusion-zone checks
const FOUNDER_CENTERS = buildRingCenters(FOUNDER_H, 10, FOUNDER_EXCL_R);
const STARTER_CENTERS = buildRingCenters(STARTER_H, 26, STARTER_EXCL_R);
const C_CENTERS       = buildRingCenters(C_H, 20, C_EXCL_R);
const ALL_CENTERS     = [...FOUNDER_CENTERS, ...STARTER_CENTERS, ...C_CENTERS];

function isNearParcel(x: number, z: number): boolean {
  for (const p of ALL_CENTERS) {
    const dx = x - p.cx;
    const dz = z - p.cz;
    if (dx * dx + dz * dz < p.exclR * p.exclR) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Prop placement definitions — first representative section
//
// Strategy: scatter props in the gap segments between parcels along specific
// ring sides. Each prop has: x, z (world wu), scale, rotY (radians).
// Props are placed by hand-seeded deterministic RNG so the pattern is stable
// across reloads. All positions verified to be in the inter-parcel gaps on
// the specified ring section.
// ---------------------------------------------------------------------------

interface PropEntry {
  model: string;
  x: number;
  z: number;
  scale: number;
  rotY: number;
}

// Seeded RNG for deterministic placement
function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Model paths — all already preloaded by DeferredTerrainPreloads in arena-terrain.tsx
const PROP_MODELS_RING = [
  '/models/coral-reef1-ktx.glb',
  '/models/coral-reef2-ktx.glb',
  '/models/coral-reef3-ktx.glb',
  '/models/kelp.glb',
  '/models/building-barrel.glb',
  '/models/building-lantern-ktx.glb',
  '/models/building-anchor.glb',
  '/models/building-shell-ktx.glb',
] as const;
type PropModel = typeof PROP_MODELS_RING[number];

// Model config: scale range and weight for random selection
const MODEL_CFG: Array<{ model: PropModel; minS: number; maxS: number; weight: number }> = [
  { model: '/models/coral-reef1-ktx.glb',      minS: 6,  maxS: 18, weight: 4 },
  { model: '/models/coral-reef2-ktx.glb',      minS: 5,  maxS: 14, weight: 3 },
  { model: '/models/coral-reef3-ktx.glb',      minS: 4,  maxS: 12, weight: 3 },
  { model: '/models/kelp.glb',             minS: 7,  maxS: 16, weight: 3 },
  { model: '/models/building-barrel.glb',  minS: 4,  maxS: 8,  weight: 3 },
  { model: '/models/building-lantern-ktx.glb', minS: 5,  maxS: 9,  weight: 3 },
  { model: '/models/building-anchor.glb',  minS: 4,  maxS: 10, weight: 2 },
  { model: '/models/building-shell-ktx.glb',   minS: 3,  maxS: 8,  weight: 3 },
];
const TOTAL_WEIGHT = MODEL_CFG.reduce((s, m) => s + m.weight, 0);

function pickModel(r: number): typeof MODEL_CFG[number] {
  let t = r * TOTAL_WEIGHT;
  for (const m of MODEL_CFG) {
    t -= m.weight;
    if (t <= 0) return m;
  }
  return MODEL_CFG[0];
}

/**
 * Generate ambient props scattered in the inter-parcel gaps of a ring section.
 *
 * @param centers     Parcel centers for this ring.
 * @param fromIdx     First parcel index in the gap range (inclusive).
 * @param toIdx       Last parcel index in the gap range (exclusive).
 * @param propsPerGap How many props to attempt per gap segment.
 * @param spread      Lateral scatter width (wu) around the ring frame.
 * @param rng         Seeded RNG.
 */
function generateRingSectionProps(
  centers: ParcelCenter[],
  fromIdx: number,
  toIdx: number,
  propsPerGap: number,
  spread: number,
  rng: () => number,
): PropEntry[] {
  const props: PropEntry[] = [];
  for (let i = fromIdx; i < toIdx; i++) {
    const a = centers[i % centers.length];
    const b = centers[(i + 1) % centers.length];
    // Midpoint of the gap between a and b
    const midX = (a.cx + b.cx) / 2;
    const midZ = (a.cz + b.cz) / 2;
    // Gap vector and length
    const dx = b.cx - a.cx;
    const dz = b.cz - a.cz;
    const gapLen = Math.sqrt(dx * dx + dz * dz);
    if (gapLen < 100) continue; // too short a gap — skip
    const nx = dz / gapLen;  // normal pointing outward (perp to gap direction)
    const nz = -dx / gapLen;

    // Scatter propsPerGap props in this gap
    for (let k = 0; k < propsPerGap; k++) {
      // t ∈ [0.15, 0.85] so we stay clear of the parcel borders
      const t = 0.15 + rng() * 0.7;
      // Along-gap position
      const ax = a.cx + dx * t;
      const az = a.cz + dz * t;
      // Lateral scatter: outward/inward from the ring frame
      const lat = (rng() - 0.5) * 2 * spread;
      const x = ax + nx * lat;
      const z = az + nz * lat;

      if (isNearParcel(x, z)) continue; // inside parcel exclusion zone — skip

      const modelSpec = pickModel(rng());
      const scale = modelSpec.minS + rng() * (modelSpec.maxS - modelSpec.minS);
      const rotY = rng() * Math.PI * 2;
      props.push({ model: modelSpec.model, x, z, scale, rotY });
    }
  }
  return props;
}

/**
 * Build all prop placements for the first representative pass.
 * Sections:
 *   1. Starter ring — north side, parcels 0-6 (top edge of the square)
 *   2. Founder ring — east side, parcels 2-4 (right edge)
 *   3. C-ring — south side, parcels 14-17
 */
function buildAllProps(): PropEntry[] {
  const rng1 = seededRng(7331);
  const rng2 = seededRng(8192);
  const rng3 = seededRng(9901);

  const starterProps = generateRingSectionProps(
    STARTER_CENTERS, 0, 6,
    4,    // props per gap
    320,  // lateral spread wu (320 = about 10 tiles each side of ring line)
    rng1,
  );
  const founderProps = generateRingSectionProps(
    FOUNDER_CENTERS, 2, 4,
    5,    // slightly denser inside the premium founder ring
    280,
    rng2,
  );
  const cRingProps = generateRingSectionProps(
    C_CENTERS, 14, 17,
    3,    // lighter on the outer ring — simpler ambient
    300,
    rng3,
  );

  return [...starterProps, ...founderProps, ...cRingProps];
}

// Computed once at module load — pure math, no side effects
const RING_PROPS: PropEntry[] = buildAllProps();

// ---------------------------------------------------------------------------
// Path ribbons — flat PlaneGeometry strips connecting adjacent parcels on
// each ring section. One merged plane per ring group = 1 draw call each.
// Material: MeshStandardMaterial warm sandy tan to match the sand floor but
// slightly distinct (low roughness, slight emissive for readability in fog).
// ---------------------------------------------------------------------------

/** Build a rectangular strip (one row of quads) between two world positions.
 *  Returns a BufferGeometry (untransformed, centered at origin, XZ plane). */
function buildPathStrip(
  ax: number, az: number,
  bx: number, bz: number,
  width: number,
  y: number,
): THREE.BufferGeometry {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1) return new THREE.PlaneGeometry(1, 1);

  const geo = new THREE.PlaneGeometry(width, len, 1, 2);
  geo.rotateX(-Math.PI / 2); // lie flat in XZ

  // Rotate to align with the gap direction
  const angle = Math.atan2(dx, dz);
  geo.rotateY(angle);

  // Translate to midpoint
  geo.translate((ax + bx) / 2, y, (az + bz) / 2);
  return geo;
}

function buildRingSectionPaths(
  centers: ParcelCenter[],
  fromIdx: number,
  toIdx: number,
  pathWidth: number,
  y: number,
): THREE.BufferGeometry[] {
  const geos: THREE.BufferGeometry[] = [];
  for (let i = fromIdx; i < toIdx; i++) {
    const a = centers[i % centers.length];
    const b = centers[(i + 1) % centers.length];
    geos.push(buildPathStrip(a.cx, a.cz, b.cx, b.cz, pathWidth, y));
  }
  return geos;
}

// ---------------------------------------------------------------------------
// Module-scope scratch matrix (no per-frame, no GC)
// ---------------------------------------------------------------------------
const _ringDecoMatrix = new THREE.Matrix4();

// ---------------------------------------------------------------------------
// LandRingDecorationsInner — loaded inside Suspense; all model scenes loaded
// via hooks before running the merge.
// ---------------------------------------------------------------------------

function LandRingDecorationsInner() {
  // Fixed-count hook calls — one per unique model path. React rules: never
  // change hook count. Count = PROP_MODELS_RING.length = 8 (constant).
  const { scene: m0 } = useGLTFWithKTX2(PROP_MODELS_RING[0]);
  const { scene: m1 } = useGLTFWithKTX2(PROP_MODELS_RING[1]);
  const { scene: m2 } = useGLTFWithKTX2(PROP_MODELS_RING[2]);
  const { scene: m3 } = useGLTFWithKTX2(PROP_MODELS_RING[3]);
  const { scene: m4 } = useGLTFWithKTX2(PROP_MODELS_RING[4]);
  const { scene: m5 } = useGLTFWithKTX2(PROP_MODELS_RING[5]);
  const { scene: m6 } = useGLTFWithKTX2(PROP_MODELS_RING[6]);
  const { scene: m7 } = useGLTFWithKTX2(PROP_MODELS_RING[7]);

  const sceneMap = useMemo<Map<string, THREE.Object3D>>(() => {
    const scenes = [m0, m1, m2, m3, m4, m5, m6, m7];
    const map = new Map<string, THREE.Object3D>();
    PROP_MODELS_RING.forEach((p, i) => map.set(p, scenes[i]));
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m0, m1, m2, m3, m4, m5, m6, m7]);

  // -------------------------------------------------------------------------
  // Build merged prop geometry buckets — runs once when all scenes are loaded.
  // Pattern mirrors MergedDecorationsInner in arena-terrain.tsx exactly.
  // -------------------------------------------------------------------------
  const propBuckets = useMemo<Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }>>(() => {
    const bucketMap = new Map<string, {
      geometries: THREE.BufferGeometry[];
      material: THREE.Material;
    }>();
    const tempGeos: THREE.BufferGeometry[] = [];

    for (const entry of RING_PROPS) {
      const sourceScene = sceneMap.get(entry.model);
      if (!sourceScene) continue;

      sourceScene.updateMatrixWorld(true);

      sourceScene.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return; // no skinned mesh
        if (!mesh.geometry) return;

        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (!mat) return;
        // Guard: never merge ShaderMaterial or NodeMaterial (WebGPU crash)
        if ((mat as any).isShaderMaterial || (mat as any).isNodeMaterial) return;

        const cosY = Math.cos(entry.rotY);
        const sinY = Math.sin(entry.rotY);
        const s = entry.scale;
        const ex = entry.x, ey = PROP_FLOOR_Y, ez = entry.z;
        // prettier-ignore
        _ringDecoMatrix.set(
          s * cosY,  0, s * sinY, ex,
          0,         s, 0,        ey,
          -s * sinY, 0, s * cosY, ez,
          0,         0, 0,        1,
        );
        const combinedMatrix = _ringDecoMatrix.clone().multiply(mesh.matrixWorld);

        const geo = makeGeometryWebGPUSafe(mesh.geometry.clone());
        geo.applyMatrix4(combinedMatrix);
        tempGeos.push(geo);

        const key = mat.uuid;
        if (!bucketMap.has(key)) {
          bucketMap.set(key, { geometries: [], material: mat });
        }
        bucketMap.get(key)!.geometries.push(geo);
      });
    }

    const result: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> = [];
    for (const { geometries, material } of bucketMap.values()) {
      if (geometries.length === 0) continue;
      const merged = mergeGeometries(geometries, false);
      if (!merged) {
        geometries.forEach((g) => g.dispose());
        continue;
      }
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      result.push({ geometry: merged, material });
    }

    // Dispose temp per-mesh clones
    tempGeos.forEach((g) => g.dispose());
    return result;
  }, [sceneMap]);

  // -------------------------------------------------------------------------
  // Build path ribbon geometry — one merged PlaneGeometry for each ring section.
  // Three sections → three groups → but all share one MeshStandardMaterial
  // so they collapse to 1 draw call.
  // -------------------------------------------------------------------------
  const pathGeo = useMemo<THREE.BufferGeometry | null>(() => {
    const PATH_Y = PROP_FLOOR_Y + 0.4; // slightly above sand to avoid z-fight
    const PATH_WIDTH = 120; // wu — roughly a cart-path width at these scales

    const allPathGeos: THREE.BufferGeometry[] = [
      // Starter ring: north side parcels 0-5 (6 gaps)
      ...buildRingSectionPaths(STARTER_CENTERS, 0, 5, PATH_WIDTH, PATH_Y),
      // Founder ring: east side parcels 2-4 (3 gaps)
      ...buildRingSectionPaths(FOUNDER_CENTERS, 2, 4, PATH_WIDTH * 1.2, PATH_Y),
      // C-ring: south side parcels 14-17 (4 gaps)
      ...buildRingSectionPaths(C_CENTERS, 14, 17, PATH_WIDTH * 0.9, PATH_Y),
    ];

    if (allPathGeos.length === 0) return null;
    const merged = mergeGeometries(allPathGeos, false);
    allPathGeos.forEach((g) => g.dispose());
    if (!merged) return null;
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }, []);

  // Dispose merged geometries on unmount
  useEffect(() => {
    return () => {
      propBuckets.forEach(({ geometry }) => geometry.dispose());
      pathGeo?.dispose();
    };
  }, [propBuckets, pathGeo]);

  // Path material — warm sandy tan, slightly lighter than the sand floor,
  // MeshStandardMaterial (no ShaderMaterial), fog-aware.
  const pathMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xb09060), // warm sandy tan
      roughness: 0.88,
      metalness: 0,
      // fog: handled by Three.js default (materials respect scene fog)
    });
    return m;
  }, []);

  useEffect(() => {
    return () => { pathMat.dispose(); };
  }, [pathMat]);

  return (
    <>
      {/* Ambient prop merged meshes — each bucket = one material = one draw call */}
      {propBuckets.map(({ geometry, material }, i) => (
        <mesh
          key={i}
          geometry={geometry}
          material={material}
          // All transforms baked into vertex positions; matrix stays identity.
          matrixAutoUpdate={false}
          // frustumCulled stays true (default) — tight AABB from computeBoundingBox().
          receiveShadow={false}
          castShadow={false}
        />
      ))}
      {/* Path ribbons — all ring sections merged into a single draw call */}
      {pathGeo && (
        <mesh
          geometry={pathGeo}
          material={pathMat}
          matrixAutoUpdate={false}
          receiveShadow={false}
          castShadow={false}
        />
      )}
    </>
  );
}

// Preload all prop models so they are warm when the component mounts.
// These overlap with arena-terrain's DeferredTerrainPreloads for the 8 shared
// model paths — useGLTF caches by URL so there is NO double-parse cost.
PROP_MODELS_RING.forEach((path) => {
  if (path.includes('-ktx.glb')) preloadKTX2Bytes(path);
  else useGLTF.preload(path);
});

// ---------------------------------------------------------------------------
// Public export — wrapped in Suspense; null fallback avoids layout shift.
// ---------------------------------------------------------------------------
export default function LandRingDecorations() {
  return (
    <Suspense fallback={null}>
      <LandRingDecorationsInner />
    </Suspense>
  );
}
