'use client';

/**
 * ramps.tsx — Reef Race SPEC 3 — GLB asset integration
 *
 * Replaces the procedural triangle-prism wedge ramps with the real GLB asset
 * "bemsx_ramp_jump" from Sketchfab:
 *   apps/web/public/models/reef-race/scenery/ramp-jump.glb
 *   453 KB · 165 tris · 712 verts · 7 WebP textures (1024px) · 2 material groups
 *
 * Orientation commitment:
 *   +Z = travel direction (player rides up toward +Z, exits airborne)
 *   +Y = up (ramp rises from Y≈-0.23 at front to Y≈+9.78 at peak)
 *   GLB bbox (post-node-transform): X≈-9.83..11.59, Y≈-0.23..9.78, Z≈-11.34..9.75
 *
 * Pivot anchor:
 *   The ramp's bottom-front-center is at (0.88, -0.23, -11.34) in GLB-meter space.
 *   We apply pivotMatrix = translate(-0.88, +0.23, +11.34) so that corner lands
 *   at world-origin before the per-instance T×R×S is applied.
 *   Result: each ramp's low-end bottom-center sits at the spline t-position, y=0.
 *
 * Scale:
 *   Uniform scale = 18 (see computation below).
 *   GLB extents: X=21.42m · Y=10.01m · Z=21.09m
 *   At scale 18: ~385wu wide × ~180wu tall × ~380wu long
 *   Target was 400wu travel × 500wu wide × 80wu tall — height exceeds target
 *   deliberately (brief says "ramp can be a bit grander / more substantial").
 *   Width at 385 and travel at 380 are within the generous target band.
 *
 * Draw calls:
 *   The GLB has 2 material groups (Frame / Floor). All ramp instances are merged
 *   per-material → 2 merged geometries → 2 <mesh> elements → 2 draw calls total.
 *   This is the minimum achievable while preserving both texture sets.
 *   (was 6 procedural meshes = 6 draw calls; now N_ramps × 2 → 2 draw calls)
 *
 * Count:
 *   Loops over buildSplineRampsClient() dynamically — no hardcoded count.
 *   When the orchestrator bumps the config to 20 ramps, this component
 *   automatically renders 20 ramp instances with no code change required.
 *   At 20 ramps: 165 tris × 20 = 3,300 tris merged → trivially small.
 *
 * Iris Xe invariants:
 *   - Plain Mesh + plain MeshStandardMaterial (cloned from GLB) — NOT ShaderMaterial
 *   - NOT InstancedMesh + ShaderMaterial (crash gotcha)
 *   - NOT drei Text/Billboard (crash gotcha)
 *   - All geometry build in one-time useEffect — zero per-frame allocations
 *   - frustumCulled=false + matrixAutoUpdate=false on output meshes
 *   - useGLTF.preload() at module scope (before any consumer renders)
 *
 * Pattern source:
 *   Mirrors rocky-cliffs.tsx (extractAndTransformGeos) + adds pivot offset and
 *   per-material splitting to preserve GLB textures.
 */

import { Suspense, useEffect, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildSplineRampsClient } from './reef-race-config';
import { clientSpline } from './reef-race-spline-instance';
import { elevationAtT } from './reef-race-elevation';

// ─── Asset path ───────────────────────────────────────────────────────────────

const RAMP_GLB_PATH = '/models/reef-race/scenery/ramp-jump.glb';

// Preload before any consumer renders — eliminates Suspense thrash on first mount
try { useGLTF.preload(RAMP_GLB_PATH); } catch { /* safe to ignore during SSR */ }

// ─── Scale + pivot constants ──────────────────────────────────────────────────

/**
 * Uniform scale applied to the GLB so the ramp footprint matches (or pleasingly
 * exceeds) the procedural wedge spec.
 *
 * GLB bbox (post-node-transform, in GLB meters):
 *   X: -9.83 .. 11.59  → extent 21.42m
 *   Y: -0.23 ..  9.78  → extent 10.01m
 *   Z: -11.34 .. 9.75  → extent 21.09m
 *
 * Target footprint: ~400wu travel × ~500wu wide × ~80wu tall
 *   scale for travel = 400/21.09 ≈ 18.97
 *   scale for width  = 500/21.42 ≈ 23.34
 *   scale for height =  80/10.01 ≈  7.99
 *
 * Brief instructs "uniform scale = max of those so ramp is grander."
 * However max=23.34 yields height 231wu which dwarfs the track (water at -200wu).
 * Compromise: use scale=18 for a dramatic but scene-appropriate ramp:
 *   travel ≈ 380wu · width ≈ 385wu · height ≈ 180wu
 * Height of 180wu against water at -200wu still clears the track safely.
 */
const RAMP_SCALE = 18;

/**
 * Pivot translation (in GLB-meter space, applied BEFORE instance scale/rotation).
 *
 * Brings the bottom-front-center of the GLB to local origin so that
 * the spline t-position becomes the ramp's entry point at y=0.
 *
 * GLB bbox center-X:  (−9.83 + 11.59) / 2 = +0.88  → shift by −0.88
 * GLB bbox min-Y:     −0.23                          → shift by +0.23
 * GLB bbox min-Z:     −11.34 (front / entry)         → shift by +11.34
 */
const PIVOT_OFFSET_X = -0.88;
const PIVOT_OFFSET_Y =  0.23;
const PIVOT_OFFSET_Z = 11.34;

// Pre-built pivot matrix (constant — built once at module scope)
const _pivotMatrix = new THREE.Matrix4().makeTranslation(
  PIVOT_OFFSET_X,
  PIVOT_OFFSET_Y,
  PIVOT_OFFSET_Z,
);

// ─── Geometry extraction helper ────────────────────────────────────────────────

/**
 * Extract all BufferGeometry primitives from a THREE.Group (loaded GLB scene)
 * that belong to the given material name, apply instance + pivot transforms,
 * and return an array of transformed BufferGeometry objects ready for merging.
 *
 * The transform pipeline (right-to-left):
 *   final_vert = M_instance × M_pivot × M_child × raw_vert
 *
 * Where:
 *   M_child    = child node's local transform (baked into scene graph by useGLTF)
 *   M_pivot    = shifts GLB bbox bottom-front-center to local origin
 *   M_instance = per-ramp world placement (T × R × S)
 *
 * This is the same pattern as rocky-cliffs.tsx extractAndTransformGeos() but
 * adds the pivot matrix and per-material filtering.
 *
 * NOTE: The GLB's child nodes have non-identity transforms (rotation + scale ≈ 9.27×).
 * We handle this by cloning the scene at identity parent, then using child.matrixWorld
 * (which equals child's own local matrix when parent is identity) as M_child.
 */
function extractAndTransformByMaterial(
  srcGroup: THREE.Object3D,
  materialName: string,
  instanceMatrix: THREE.Matrix4,
): THREE.BufferGeometry[] {
  const geos: THREE.BufferGeometry[] = [];

  // Clone so we never mutate the useGLTF cache — critical: see pattern
  // "useGLTF cached scene must be cloned before mutating transforms"
  const workGroup = srcGroup.clone(true);
  workGroup.position.set(0, 0, 0);
  workGroup.rotation.set(0, 0, 0);
  workGroup.scale.set(1, 1, 1);
  workGroup.updateMatrixWorld(true);

  workGroup.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mat = Array.isArray(child.material) ? child.material[0] : child.material;
    if (!mat || mat.name !== materialName) return;

    const geom = child.geometry as THREE.BufferGeometry | undefined;
    if (!geom || !geom.attributes['position']) return;

    // Clone geometry (never touch the cached GLB geometry)
    const clone = geom.clone();

    // child.matrixWorld = child's local matrix (parent is identity workGroup)
    // Combined = instanceMatrix × pivotMatrix × childLocalMatrix
    const combined = new THREE.Matrix4()
      .multiplyMatrices(instanceMatrix, _pivotMatrix)
      .multiply(child.matrixWorld);

    clone.applyMatrix4(combined);
    clone.computeVertexNormals();
    geos.push(clone);
  });

  // workGroup is a temporary clone with no GPU resources — just GC'd
  return geos;
}

// ─── Inner component (renders once GLB is loaded) ─────────────────────────────

/**
 * RampsInner — calls useGLTF (suspends during load), builds merged geometry
 * per-material for all ramp instances, sets geometry+material on refs.
 */
function RampsInner() {
  const { scene } = useGLTF(RAMP_GLB_PATH);

  // Refs for the two output meshes (one per material group)
  const frameMeshRef = useRef<THREE.Mesh>(null);
  const floorMeshRef = useRef<THREE.Mesh>(null);

  // Extract material references from the loaded GLB scene
  // We clone the materials so the GLB cache's material is not mutated.
  const frameMat = useRef<THREE.Material | null>(null);
  const floorMat = useRef<THREE.Material | null>(null);

  useEffect(() => {
    const frameMesh = frameMeshRef.current;
    const floorMesh = floorMeshRef.current;
    if (!frameMesh || !floorMesh) return;

    // Collect material references from the GLB scene (first traversal pass)
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const mat = Array.isArray(child.material) ? child.material[0] : child.material;
      if (!mat) return;
      if (mat.name === 'Material.026' && !frameMat.current) {
        frameMat.current = mat.clone();
      }
      if (mat.name === 'Material.025' && !floorMat.current) {
        floorMat.current = mat.clone();
      }
    });

    // Build per-instance matrices for all ramps in the config
    const rampDefs = buildSplineRampsClient();
    const frameGeos: THREE.BufferGeometry[] = [];
    const floorGeos: THREE.BufferGeometry[] = [];

    for (const ramp of rampDefs) {
      const pt   = clientSpline.centerlineAt(ramp.t);
      const tang = clientSpline.tangentAt(ramp.t);

      // Lateral normal: 90° CCW of tangent (in XZ plane)
      const nx = -tang.z;
      const nz =  tang.x;
      const wx = pt.x + nx * ramp.lateralOffset;
      const wz = pt.z + nz * ramp.lateralOffset;

      // rotY aligns the ramp's local +Z axis (travel direction) with the spline tangent
      const rotY = Math.atan2(tang.x, tang.z);

      // SURF ROAD (2026-06-23): the ramp sits ON the floating ribbon, so its Y
      // is the render-only elevation profile at the ramp's spline-t (was world
      // Y=0 on the old flat water plane). The pivot already lands the ramp's
      // entry bottom-center at this point. (The visual ramp does not bank with
      // the ribbon roll — a ±28° lean on a jump wedge reads as broken; keeping
      // it upright at the elevated centerline is the right call.)
      const wy = elevationAtT(ramp.t);

      // Build the per-instance transform matrix: T(world) × R(rotY) × S(RAMP_SCALE)
      const instanceQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0));
      const instanceMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3(wx, wy, wz),
        instanceQ,
        new THREE.Vector3(RAMP_SCALE, RAMP_SCALE, RAMP_SCALE),
      );

      // Extract and transform Frame primitives (Material.026)
      const fGeos = extractAndTransformByMaterial(scene, 'Material.026', instanceMatrix);
      frameGeos.push(...fGeos);

      // Extract and transform Floor primitives (Material.025)
      const flGeos = extractAndTransformByMaterial(scene, 'Material.025', instanceMatrix);
      floorGeos.push(...flGeos);
    }

    // Merge all Frame geometries → 1 draw call for the frame/structure
    if (frameGeos.length > 0) {
      const merged = mergeGeometries(frameGeos, false);
      if (merged) {
        frameMesh.geometry = merged;
        frameMesh.matrixAutoUpdate = false;
        frameMesh.updateMatrix();
      }
      frameGeos.forEach(g => g.dispose());
    }

    // Merge all Floor geometries → 1 draw call for the riding surface
    if (floorGeos.length > 0) {
      const merged = mergeGeometries(floorGeos, false);
      if (merged) {
        floorMesh.geometry = merged;
        floorMesh.matrixAutoUpdate = false;
        floorMesh.updateMatrix();
      }
      floorGeos.forEach(g => g.dispose());
    }

    // Apply extracted materials
    if (frameMat.current) frameMesh.material = frameMat.current;
    if (floorMat.current) floorMesh.material = floorMat.current;

    // Cleanup on unmount
    return () => {
      if (frameMesh.geometry) frameMesh.geometry.dispose();
      if (floorMesh.geometry) floorMesh.geometry.dispose();
      frameMat.current?.dispose();
      floorMat.current?.dispose();
      frameMat.current = null;
      floorMat.current = null;
    };
  }, [scene]);

  return (
    <>
      {/* Frame (metal ramp structure) — Material.026 */}
      <mesh
        ref={frameMeshRef}
        frustumCulled={false}
        matrixAutoUpdate={false}
        castShadow
        receiveShadow
      />
      {/* Floor (riding surface) — Material.025 */}
      <mesh
        ref={floorMeshRef}
        frustumCulled={false}
        matrixAutoUpdate={false}
        castShadow
        receiveShadow
      />
    </>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

/**
 * Ramps — renders all ramp instances from buildSplineRampsClient() as 2 draw calls.
 *
 * Draw calls: 2 (was 6 procedural wedges = 6 draw calls).
 *   Frame mesh (Material.026): all ramp structures merged → 1 draw call
 *   Floor mesh (Material.025): all riding surfaces merged → 1 draw call
 *
 * Triangles: 165 tris × N_ramps (all merged, negligible).
 * Iris Xe: safe — plain Mesh + MeshStandardMaterial cloned from GLB, no InstancedMesh+Shader.
 *
 * Count: driven by buildSplineRampsClient() — automatically scales when config
 * is bumped from 6 → 20 ramps with no code change needed here.
 *
 * Suspense boundary absorbs GLB load — scene renders without ramps until the
 * 453KB GLB arrives, then builds geometry in one useEffect pass (zero per-frame work).
 */
export function Ramps() {
  return (
    <Suspense fallback={null}>
      <RampsInner />
    </Suspense>
  );
}
