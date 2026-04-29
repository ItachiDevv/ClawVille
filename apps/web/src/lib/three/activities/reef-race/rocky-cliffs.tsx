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
 * Lower than the ribbon's 64 since each section now places 4 rocks (2 rows × 2 sides).
 * 36 sections × 4 = 144 rock instances before merging.
 */
const N_SECTIONS = 36;

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
        // Some sections have FAT bands (up to 600wu), others THIN (180wu min). Deterministic.
        const lMax = lateralMax(si);

        // Lateral offset from centerline (beyond halfWidth into the bank)
        const lateralJitter = LATERAL_MIN + rng.next() * (lMax - LATERAL_MIN);
        const lateralDist   = hw + lateralJitter;
        const nx = n.x * sign;
        const nz = n.z * sign;

        // ROW A — top row: base at y=CANYON_TOP (rock extends upward, forms cliff rim)
        const posA = new THREE.Vector3(
          c.x + nx * lateralDist,
          CANYON_TOP,
          c.z + nz * lateralDist,
        );
        const rotA  = rng.next() * Math.PI * 2;
        const scaleA = SCALE_MIN + rng.next() * (SCALE_MAX - SCALE_MIN);

        // ROW B — bottom row: base at water level so rocks sit at waterline
        // Slightly different lateral position for variety
        const lateralJitter2 = LATERAL_MIN + rng.next() * (lMax - LATERAL_MIN);
        const lateralDist2   = hw + lateralJitter2;
        const posB = new THREE.Vector3(
          c.x + nx * lateralDist2,
          ROW_B_BASE_Y,
          c.z + nz * lateralDist2,
        );
        const rotB   = rng.next() * Math.PI * 2;
        const scaleB = SCALE_MIN + rng.next() * (SCALE_MAX - SCALE_MIN);

        // Row C — mid cliff: base at half-depth to fill the gap between A and B
        const lateralJitter3 = LATERAL_MIN + rng.next() * (lMax - LATERAL_MIN);
        const lateralDist3   = hw + lateralJitter3;
        const posC = new THREE.Vector3(
          c.x + nx * lateralDist3,
          -100,   // mid-cliff
          c.z + nz * lateralDist3,
        );
        const rotC   = rng.next() * Math.PI * 2;
        const scaleC = SCALE_MIN + rng.next() * (SCALE_MAX - SCALE_MIN);

        const geoA = extractAndTransformGeos(srcScene, posA, rotA, scaleA);
        const geoB = extractAndTransformGeos(srcScene, posB, rotB, scaleB);
        const geoC = extractAndTransformGeos(srcScene, posC, rotC, scaleC);

        const allGeos = [...geoA, ...geoB, ...geoC];

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
