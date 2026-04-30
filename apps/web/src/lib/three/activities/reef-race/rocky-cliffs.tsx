'use client';

/**
 * rocky-cliffs.tsx — Real CC0 GLB rock assets tiled along the Reef Race canyon.
 *
 * Visual target: a continuous cliff wall of overlapping boulder clusters
 * flanking both sides of the river canyon — matching the Quaternius stylized
 * low-poly aesthetic already used for the canyon trees.
 *
 * Strategy: SCATTERED ROCK CLUSTERS (not a single cliff wall slab)
 * —————————————————————————————————————————————————
 * A "perfect cliff wall" GLB would need to be a custom-designed tile. Using
 * scattered Quaternius boulders (222–342 tris each) at large scale + random
 * Y-rotation is far more realistic than a procedural ribbon and matches the
 * existing tree asset approach that the user approved.
 *
 * Assets (CC0, Quaternius via poly.pizza):
 *   cliff-rock-1.glb  — Rock Large   (222 tris, 12.5 KB, y_min=0)
 *   cliff-rock-2.glb  — Rock Medium A (342 tris, 14.5 KB, y_min=0)
 *   cliff-rock-3.glb  — Rock Medium B (244 tris, 10.6 KB, y_min=0)
 *
 * Heights at scale=1: Rock-1 3.29wu, Rock-2 2.26wu, Rock-3 1.90wu.
 * Canyon depth: ground=0, water=-200, riverbed=-250.
 *
 * Placement layout (2 rows per cross-section side):
 *   ROW A (top):    base y=0   — rock juts ABOVE ground, forms rocky cliff rim
 *   ROW B (bottom): base y=-CANYON_HALF_H — sits at mid-cliff, overlaps row A
 *
 * Scaled to ROCK_SCALE ≈ 60:
 *   Rock-1 height = 3.29 × 60 = 197wu  → row A: y=[0,+197], row B: y=[-197,0]
 *   Combined: continuous wall y=-197..+197, canyon water at -200 just below.
 *
 * Performance — draw calls:
 *   All left-bank rocks merged → 1 BufferGeometry, 1 draw call.
 *   All right-bank rocks merged → 1 BufferGeometry, 1 draw call.
 *   Total: 2 draw calls for the entire cliff system.
 *
 * Total tri count:
 *   N_SECTIONS=36 × 2 sides × 2 rows × avg_tris≈269 = ~38,736 tris
 *   (within the ≤80k scene budget — adds ~39k tris but replaces 1264-tri ribbon)
 *
 * Iris Xe invariants:
 *   - import from 'three' only
 *   - MeshStandardMaterial (NOT ShaderMaterial, NOT InstancedMesh)
 *   - All work in one-time useEffect — zero per-frame allocations
 *   - frustumCulled=false + matrixAutoUpdate=false on output meshes
 *   - mergeGeometries from three/examples/jsm (safe on WebGL + WebGPU canvas)
 *
 * Wire-up: replace <RockyBanks /> with <RockyCliffs /> in river-scene.tsx.
 * Orchestrator handles the swap after this component validates in build.
 */

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clientSpline } from './reef-race-spline-instance';

// ─── Asset paths ──────────────────────────────────────────────────────────────

const CLIFF_ROCK_PATHS = [
  '/models/reef-race/scenery/cliff-rock-1.glb',  // Rock Large  — 222 tris
  '/models/reef-race/scenery/cliff-rock-2.glb',  // Rock Medium A — 342 tris
  '/models/reef-race/scenery/cliff-rock-3.glb',  // Rock Medium B — 244 tris
] as const;

// Preload all 3 variants at module scope
for (const path of CLIFF_ROCK_PATHS) {
  try { useGLTF.preload(path); } catch { /* not yet available during SSR */ }
}

// ─── Layout constants ─────────────────────────────────────────────────────────

/**
 * Number of evenly-spaced cross-sections along the spline.
 * 2026-04-30 density bump: 36 → 60 sections + 2 rocks per (section, side, row).
 * 60 × 2 sides × 3 rows × 2 copies = 720 rock instances before merging.
 * Estimated tris: 720 × ~269 = ~194k (under 220k scene budget).
 */
const N_SECTIONS = 60;
const ROCKS_PER_CELL = 2;

/**
 * Lateral offset of rock cluster CENTER beyond the spline halfWidth.
 *
 * German River reference (Jeffrey Tuhtan, Sketchfab scan): cliff borders are NOT
 * uniform width — they bulge IN and OUT along the river length, creating an organic,
 * irregular silhouette. This is the key realism feature the user requested.
 *
 * Instead of a constant LATERAL_MAX, we use a per-section seeded hash (mulberry32)
 * to vary the cliff band width between [LATERAL_BAND_MIN, LATERAL_BAND_MAX].
 * Some sections will have FAT cliff bands (600wu), others THIN (180wu) — intentional.
 *
 * Bounds-check at narrowest corridor (coral, hw=880):
 *   fattest band: rock center = 880+600 = 1480wu, body half ±135 → inner edge 1345 > 880. SAFE.
 *   thinnest band: rock center = 880+180 = 1060wu, body half ±135 → inner edge 925 > 880. SAFE (45wu margin).
 */
const LATERAL_MIN = 0;           // wu beyond halfWidth (inward edge flush with corridor)
const LATERAL_BAND_MIN = 180;    // minimum cliff-band width (wu)
const LATERAL_BAND_MAX = 600;    // maximum cliff-band width (wu)

/**
 * Deterministic per-section lateral maximum using mulberry32 hash.
 * Pure function — no time, no random state. Identical result every render.
 *
 * @param sectionIdx  Integer section index along spline.
 * @returns  lateralMax in [LATERAL_BAND_MIN, LATERAL_BAND_MAX].
 */
function mulberry32(seed: number): number {
  let s = (seed >>> 0) + 0x6D2B79F5;
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}

function lateralMax(sectionIdx: number): number {
  return LATERAL_BAND_MIN + (LATERAL_BAND_MAX - LATERAL_BAND_MIN) * mulberry32(sectionIdx + 7919);
}

/**
 * Rock scale range. Widened vs iter-5 (50-70) for more height variation, matching
 * the German River reference where some cliff sections have tall jagged ridges and
 * others are lower. Rock-large at scale=90 gives ~296wu height (fills canyon easily);
 * at scale=40 gives ~132wu (lower ridge, more variation in silhouette).
 */
const SCALE_MIN = 40;
const SCALE_MAX = 90;

/**
 * Y positions for the two rows (base of each rock stack).
 * Row A base at y=CANYON_TOP so rocks extend upward from ground level.
 * Row B base at y=-(SCALE_MAX × avgHeight) so rocks extend down to water.
 */
const CANYON_TOP    =    0;   // ground / cliff top
/**
 * ROW_B_BASE_Y = -200 (water level).
 * The GLBs have y_min=0, so the rock BASE SITS AT water level and the body
 * extends UPWARD toward ground (y=0). Combined with ROW A (base=0, body up)
 * and ROW C (base=-100, body up/down), all three rows stack to cover the full
 * canyon face from y≈-200 to y≈+197.
 *
 * LATERAL_BAND_MAX=600wu behavior at narrow chokepoints (hw=880, iter-8):
 *   fat band: rock center = 880 + 600 = 1480wu from centerline.
 *   rock inner edge ≈ 1480 − (3.85wu × SCALE_MAX=90) ≈ 1480 − 347 = 1133wu (outside 880 corridor).
 *   thin band (min=180): center=880+180=1060, inner edge=1060−347=713wu.
 *   713 < 880 → rock body intrudes ~167wu INTO the corridor at the narrowest sections.
 *   This is INTENTIONAL canyon press-in (German River reference): thin-band sections
 *   feel walled, fat-band sections feel open. Server sim uses halfWidth, not visual cliffs,
 *   so racing line is unaffected — pure visual realism.
 */
const ROW_B_BASE_Y  = -200;

// ─── Seeded RNG ───────────────────────────────────────────────────────────────

function seededRandCl(seed: number) {
  let s = (seed * 1664525 + 1013904223) | 0;
  return {
    next(): number {
      s = ((s ^ (s << 13)) ^ (s >>> 17) ^ (s << 5)) | 0;
      return ((s >>> 0) / 0xffffffff);
    },
  };
}

// ─── Geometry extraction helper ───────────────────────────────────────────────

/**
 * Extract all BufferGeometry primitives from a THREE.Group (loaded GLB scene),
 * apply a world transform (position, rotation, scale), and return an array of
 * transformed BufferGeometry objects ready for merging.
 *
 * This avoids cloning the full scene hierarchy and instead creates flat,
 * standalone geometries — essential for mergeGeometries.
 *
 * Assumption: our cliff GLBs have identity node transforms (transforms were baked
 * into vertex positions during the asset-optimization pipeline). So child.matrix
 * is identity and we only need to apply the instance transform m.
 */
function extractAndTransformGeos(
  srcGroup: THREE.Object3D,
  pos: THREE.Vector3,
  rotY: number,
  scale: number,
): THREE.BufferGeometry[] {
  const geos: THREE.BufferGeometry[] = [];

  // Build the instance transform matrix (position + yaw + uniform scale)
  const instanceQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0));
  const instanceS = new THREE.Vector3(scale, scale, scale);
  const m = new THREE.Matrix4();
  m.compose(pos, instanceQ, instanceS);

  // Clone the cached group BEFORE mutating transforms so the GLB cache is never
  // touched. The clone is a temporary scratch object — discarded after extraction.
  const workGroup = srcGroup.clone(true);

  // Force workGroup to identity world so child.updateWorldMatrix gives local-only matrix
  workGroup.position.set(0, 0, 0);
  workGroup.rotation.set(0, 0, 0);
  workGroup.scale.set(1, 1, 1);
  workGroup.updateMatrixWorld(true);

  // Traverse work group and extract mesh geometries with baked transforms
  workGroup.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geom = child.geometry;
    if (!geom || !geom.attributes['position']) return;

    // Clone geometry so we don't mutate the cached GLB geometry
    const clone = geom.clone();

    // Child local matrix relative to workGroup (identity for our baked assets)
    const childLocalMat = child.matrixWorld; // workGroup at identity → matrixWorld = local

    // Combined: instance transform × child local transform
    const combined = new THREE.Matrix4().multiplyMatrices(m, childLocalMat);
    clone.applyMatrix4(combined);

    // Recompute normals for correct flat shading after transform
    clone.computeVertexNormals();

    geos.push(clone);
  });

  // workGroup was a temporary clone — no GPU resources allocated on it (geometries
  // were cloned individually above). Nothing to dispose here; the workGroup and its
  // shallow Three.js nodes are just GC'd.

  return geos;
}

// ─── Cliff material (shared, module-scope) ────────────────────────────────────

/**
 * Stone material matching the Quaternius flat-shaded aesthetic.
 * flatShading: true gives the faceted rock look.
 * Color palette: muted sandy gray-brown (#8a7060) — warmer than the old
 * procedural ribbon (#8a7a6b) to contrast with the gray-green spline banks.
 */
const _cliffMat = new THREE.MeshStandardMaterial({
  color:       new THREE.Color('#8a6e5c'),   // warm stone
  roughness:   0.9,
  metalness:   0.0,
  flatShading: true,
  side:        THREE.FrontSide,
  fog:         true,
});

/**
 * Canyon wall backfill material — identical color/roughness to cliff boulders.
 * DoubleSide so the ribbon is visible from the interior of the canyon regardless
 * of winding order. This is the continuous solid wall behind the boulders.
 */
const _wallMat = new THREE.MeshStandardMaterial({
  color:       new THREE.Color('#8a6e5c'),   // same warm stone
  roughness:   0.9,
  metalness:   0.0,
  flatShading: true,
  side:        THREE.DoubleSide,
  fog:         true,
});

// ─── Canyon wall geometry builder ─────────────────────────────────────────────

/**
 * Lateral position of the wall surface relative to the corridor half-width.
 * WALL_INSET=0: wall inner edge is flush with the corridor boundary.
 * Small inset keeps the wall just outside the visible racing corridor.
 */
const WALL_SAMPLES   = 128;  // cross-section count — matches ground ribbon density
const WALL_Y_BOTTOM  = -200; // waterline (world y)
const WALL_Y_TOP     =    0; // ground level (world y)
const WALL_THICKNESS =  150; // radial depth of wall (wu) — wide enough to hide gaps

/**
 * Builds a vertical wall ribbon swept along the spline for one bank.
 *
 * Cross-section per sample:
 *   v0 = (lateralInner, WALL_Y_BOTTOM, z)   — inner bottom
 *   v1 = (lateralInner, WALL_Y_TOP,    z)   — inner top
 *   v2 = (lateralOuter, WALL_Y_BOTTOM, z)   — outer bottom
 *   v3 = (lateralOuter, WALL_Y_TOP,    z)   — outer top
 *
 * Between adjacent samples i and i+1, two quads are built:
 *   inner face: (v0i, v1i, v0i+1) + (v1i, v1i+1, v0i+1)   — faces inward
 *   top cap:    (v1i, v3i, v1i+1) + (v3i, v3i+1, v1i+1)   — faces upward
 *
 * Since we use DoubleSide material, winding order only affects flat-shading
 * normal direction — computeVertexNormals() corrects the shading after.
 *
 * @param side  +1 = left bank (+n direction), -1 = right bank (-n direction)
 */
function buildCanyonWallGeo(side: 1 | -1): THREE.BufferGeometry {
  const SAMPLES = WALL_SAMPLES;
  const vertsPerSection = 4;
  const totalVerts = (SAMPLES + 1) * vertsPerSection;

  const positions = new Float32Array(totalVerts * 3);
  const normals   = new Float32Array(totalVerts * 3);
  const uvs       = new Float32Array(totalVerts * 2);

  // Build vertex positions
  for (let i = 0; i <= SAMPLES; i++) {
    const t   = i / SAMPLES;
    const c   = clientSpline.centerlineAt(t);
    const n   = clientSpline.normalAt(t);
    const hw  = clientSpline.widthAt(t);

    // Wall lateral positions: inner edge = corridor boundary, outer = inner + thickness
    const innerDist = hw;
    const outerDist = hw + WALL_THICKNESS;

    // Normal direction: +side pushes outward from centerline
    const nx = n.x * side;
    const nz = n.z * side;

    const baseV = i * vertsPerSection;

    // v0 — inner bottom
    positions[(baseV + 0) * 3 + 0] = c.x + nx * innerDist;
    positions[(baseV + 0) * 3 + 1] = WALL_Y_BOTTOM;
    positions[(baseV + 0) * 3 + 2] = c.z + nz * innerDist;

    // v1 — inner top
    positions[(baseV + 1) * 3 + 0] = c.x + nx * innerDist;
    positions[(baseV + 1) * 3 + 1] = WALL_Y_TOP;
    positions[(baseV + 1) * 3 + 2] = c.z + nz * innerDist;

    // v2 — outer bottom
    positions[(baseV + 2) * 3 + 0] = c.x + nx * outerDist;
    positions[(baseV + 2) * 3 + 1] = WALL_Y_BOTTOM;
    positions[(baseV + 2) * 3 + 2] = c.z + nz * outerDist;

    // v3 — outer top
    positions[(baseV + 3) * 3 + 0] = c.x + nx * outerDist;
    positions[(baseV + 3) * 3 + 1] = WALL_Y_TOP;
    positions[(baseV + 3) * 3 + 2] = c.z + nz * outerDist;

    // Placeholder normals (will be recomputed below)
    const inwardNx = -nx;
    const inwardNz = -nz;
    for (let vi = 0; vi < vertsPerSection; vi++) {
      normals[(baseV + vi) * 3 + 0] = inwardNx;
      normals[(baseV + vi) * 3 + 1] = 0;
      normals[(baseV + vi) * 3 + 2] = inwardNz;
    }

    // UVs: u = t (spline progress), v = 0/1 for bottom/top
    const u = t;
    uvs[(baseV + 0) * 2 + 0] = u; uvs[(baseV + 0) * 2 + 1] = 0; // inner bottom
    uvs[(baseV + 1) * 2 + 0] = u; uvs[(baseV + 1) * 2 + 1] = 1; // inner top
    uvs[(baseV + 2) * 2 + 0] = u; uvs[(baseV + 2) * 2 + 1] = 0; // outer bottom
    uvs[(baseV + 3) * 2 + 0] = u; uvs[(baseV + 3) * 2 + 1] = 1; // outer top
  }

  // Build index buffer — 2 quads per segment (inner face + top cap)
  // Each quad = 2 triangles = 6 indices.
  // Segments: SAMPLES. Quads per segment: 2. Total indices: SAMPLES * 2 * 6 = SAMPLES * 12.
  const indices = new Uint32Array(SAMPLES * 12);
  let idx = 0;

  for (let i = 0; i < SAMPLES; i++) {
    const base  = i * vertsPerSection;
    const baseN = (i + 1) * vertsPerSection;

    // v0i, v1i, v2i, v3i = inner-bottom, inner-top, outer-bottom, outer-top (this section)
    // v0n, v1n, v2n, v3n = same verts for next section
    const v0i = base + 0; const v1i = base + 1;
    const v2i = base + 2; const v3i = base + 3;
    const v0n = baseN + 0; const v1n = baseN + 1;
    const v2n = baseN + 2; const v3n = baseN + 3;

    // Inner face (the wall face visible from inside the canyon):
    // Quad: (v0i, v1i, v0n, v1n) — two tris
    // Winding: DoubleSide + computeVertexNormals handles direction.
    indices[idx++] = v0i; indices[idx++] = v1i; indices[idx++] = v0n;
    indices[idx++] = v1i; indices[idx++] = v1n; indices[idx++] = v0n;

    // Top cap face (horizontal ledge at ground level, y=WALL_Y_TOP):
    // Quad: (v1i, v3i, v1n, v3n) — two tris
    indices[idx++] = v1i; indices[idx++] = v3i; indices[idx++] = v1n;
    indices[idx++] = v3i; indices[idx++] = v3n; indices[idx++] = v1n;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,       2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals(); // override placeholder normals with correct face normals
  geo.computeBoundingSphere();

  return geo;
}

// Pre-built module-scope wall geometries — built once at module load.
// These are static (spline is static) so no useEffect needed.
const _wallGeoLeft  = buildCanyonWallGeo(+1);
const _wallGeoRight = buildCanyonWallGeo(-1);

// ─── Inner component (renders once GLBs are loaded) ──────────────────────────

interface CliffMeshBuilderProps {
  scenes: THREE.Object3D[];
}

function CliffMeshBuilder({ scenes }: CliffMeshBuilderProps) {
  const leftRef  = useRef<THREE.Mesh>(null);
  const rightRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const leftMesh  = leftRef.current;
    const rightMesh = rightRef.current;
    if (!leftMesh || !rightMesh || scenes.length === 0) return;

    const leftGeos:  THREE.BufferGeometry[] = [];
    const rightGeos: THREE.BufferGeometry[] = [];

    const rng = seededRandCl(42);

    for (let si = 0; si < N_SECTIONS; si++) {
      const t  = si / (N_SECTIONS - 1);
      const c  = clientSpline.centerlineAt(t);
      const n  = clientSpline.normalAt(t);
      const hw = clientSpline.widthAt(t);

      // Pick GLB variant (deterministic per section)
      const variant = si % scenes.length;
      const srcScene = scenes[variant]!;

      for (const sign of [+1, -1] as const) {
        // Per-section cliff band width — organic variation referencing German River photogrammetry.
        const lMax = lateralMax(si);
        const nx = n.x * sign;
        const nz = n.z * sign;

        const allGeos: THREE.BufferGeometry[] = [];

        // 2026-04-30: place ROCKS_PER_CELL copies per (section, side, row).
        // Each copy gets independent lateral jitter, rotation, and scale, so the
        // same row produces a clustered band instead of a single rock per slot.
        for (let copy = 0; copy < ROCKS_PER_CELL; copy++) {
          // ROW A — top row: base at y=CANYON_TOP (cliff rim)
          const lateralJitterA = LATERAL_MIN + rng.next() * (lMax - LATERAL_MIN);
          const lateralDistA   = hw + lateralJitterA;
          const posA = new THREE.Vector3(
            c.x + nx * lateralDistA,
            CANYON_TOP,
            c.z + nz * lateralDistA,
          );
          const rotA   = rng.next() * Math.PI * 2;
          const scaleA = SCALE_MIN + rng.next() * (SCALE_MAX - SCALE_MIN);

          // ROW B — bottom row: base at water level
          const lateralJitterB = LATERAL_MIN + rng.next() * (lMax - LATERAL_MIN);
          const lateralDistB   = hw + lateralJitterB;
          const posB = new THREE.Vector3(
            c.x + nx * lateralDistB,
            ROW_B_BASE_Y,
            c.z + nz * lateralDistB,
          );
          const rotB   = rng.next() * Math.PI * 2;
          const scaleB = SCALE_MIN + rng.next() * (SCALE_MAX - SCALE_MIN);

          // ROW C — mid cliff
          const lateralJitterC = LATERAL_MIN + rng.next() * (lMax - LATERAL_MIN);
          const lateralDistC   = hw + lateralJitterC;
          const posC = new THREE.Vector3(
            c.x + nx * lateralDistC,
            -100,
            c.z + nz * lateralDistC,
          );
          const rotC   = rng.next() * Math.PI * 2;
          const scaleC = SCALE_MIN + rng.next() * (SCALE_MAX - SCALE_MIN);

          allGeos.push(
            ...extractAndTransformGeos(srcScene, posA, rotA, scaleA),
            ...extractAndTransformGeos(srcScene, posB, rotB, scaleB),
            ...extractAndTransformGeos(srcScene, posC, rotC, scaleC),
          );
        }

        if (sign > 0) {
          leftGeos.push(...allGeos);
        } else {
          rightGeos.push(...allGeos);
        }
      }
    }

    // Merge all left-bank geos → single BufferGeometry
    if (leftGeos.length > 0) {
      const merged = mergeGeometries(leftGeos, false);
      if (merged) {
        leftMesh.geometry = merged;
        leftMesh.matrixAutoUpdate = false;
        leftMesh.updateMatrix();
      }
      // Dispose intermediate geos (data was copied into merged)
      leftGeos.forEach(g => g.dispose());
    }

    // Merge all right-bank geos → single BufferGeometry
    if (rightGeos.length > 0) {
      const merged = mergeGeometries(rightGeos, false);
      if (merged) {
        rightMesh.geometry = merged;
        rightMesh.matrixAutoUpdate = false;
        rightMesh.updateMatrix();
      }
      rightGeos.forEach(g => g.dispose());
    }

    // Cleanup: dispose the merged BufferGeometries from GPU memory when the
    // component unmounts (route change, scene teardown) or scenes prop changes.
    return () => {
      if (leftMesh.geometry) leftMesh.geometry.dispose();
      if (rightMesh.geometry) rightMesh.geometry.dispose();
    };
  }, [scenes]);

  return (
    <>
      {/* Continuous wall backfill — renders BEHIND boulders via depth test.
          Module-scope geometries built at load time (static spline). */}
      <mesh
        geometry={_wallGeoLeft}
        material={_wallMat}
        frustumCulled={false}
        matrixAutoUpdate={false}
        receiveShadow
        castShadow={false}
        renderOrder={0}
      />
      <mesh
        geometry={_wallGeoRight}
        material={_wallMat}
        frustumCulled={false}
        matrixAutoUpdate={false}
        receiveShadow
        castShadow={false}
        renderOrder={0}
      />
      {/* Boulder clusters — sit on top of the backfill wall, add silhouette variation */}
      <mesh
        ref={leftRef}
        material={_cliffMat}
        frustumCulled={false}
        matrixAutoUpdate={false}
        receiveShadow
        castShadow={false}
        renderOrder={1}
      />
      <mesh
        ref={rightRef}
        material={_cliffMat}
        frustumCulled={false}
        matrixAutoUpdate={false}
        receiveShadow
        castShadow={false}
        renderOrder={1}
      />
    </>
  );
}

// ─── Loader component — suspends until all 3 GLBs resolve ────────────────────

function CliffLoader() {
  const { scene: s1 } = useGLTF(CLIFF_ROCK_PATHS[0]);
  const { scene: s2 } = useGLTF(CLIFF_ROCK_PATHS[1]);
  const { scene: s3 } = useGLTF(CLIFF_ROCK_PATHS[2]);

  // Memoize so the array reference is stable across parent re-renders.
  // The deps are individual scene refs from useGLTF — they are stable after
  // initial load and only change if the GLB itself reloads (cache invalidation),
  // which is exactly when we want the geometry to rebuild.
  const scenes = useMemo(() => [s1, s2, s3].filter(Boolean) as THREE.Object3D[], [s1, s2, s3]);

  return <CliffMeshBuilder scenes={scenes} />;
}

// ─── Public component ─────────────────────────────────────────────────────────

/**
 * RockyCliffs — renders CC0 Quaternius boulder clusters along both canyon banks.
 *
 * Wire-up: replace <RockyBanks /> with <RockyCliffs /> in river-scene.tsx.
 * Suspense boundary absorbs the GLB load — scene renders without cliffs until
 * assets arrive (then rebuilds geometry in one useEffect pass).
 *
 * Output:
 *   - 2 draw calls (left bank merged + right bank merged)
 *   - ~38-44k tris (36 sections × 3 rows × 2 sides × avg 269 tris)
 *   - 0 per-frame work after initial build
 */
export function RockyCliffs() {
  return (
    <Suspense fallback={null}>
      <CliffLoader />
    </Suspense>
  );
}
