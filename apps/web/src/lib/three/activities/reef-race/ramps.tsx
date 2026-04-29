'use client';

/**
 * ramps.tsx — Reef Race SPEC 3
 *
 * Six procedural wedge meshes placed at the ramp trigger volume positions
 * along the v2 spline track. Each wedge is a triangle-prism BufferGeometry
 * aligned to the spline tangent direction, rising from the water surface at
 * the front to a peak at the back (in the direction of travel).
 *
 * Visual spec:
 *   - 300wu long × 400wu wide × 60wu tall
 *   - Warm coral/wood colour (#c9884a) — pops against the blue river water
 *   - MeshStandardMaterial (NOT ShaderMaterial — Iris Xe safe)
 *   - DoubleSide so the underside renders if the camera dips below the ramp
 *   - Module-scope merged geometry — ALL 6 ramps in 1 draw call
 *   - matrixAutoUpdate=false (static geometry)
 *
 * PERF FIX (2026-04-29):
 *   Previously: 6 separate Mesh instances = 6 draw calls.
 *   Now: all 6 wedge geometries transformed and merged at module scope
 *        → 1 merged BufferGeometry, 1 draw call.
 *   Reduction: 6 → 1 draw call.
 *
 * Iris Xe invariants:
 *   - Plain Mesh + plain MeshStandardMaterial — safe.
 *   - No InstancedMesh + ShaderMaterial (crash gotcha).
 *   - No drei Text/Billboard (crash gotcha).
 *   - matrixAutoUpdate=false (static after mount).
 *   - Module-scope geo/mat never disposed (page-lifetime, shared).
 */

import { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildSplineRampsClient } from './reef-race-config';
import { clientSpline } from './reef-race-spline-instance';

// ─── Wedge geometry constants ─────────────────────────────────────────────────

const RAMP_VIS_LENGTH = 300;  // wu along tangent (halfLength × 2)
const RAMP_VIS_WIDTH  = 400;  // wu perpendicular (halfWidth × 2)
const RAMP_VIS_HEIGHT = 60;   // wu vertical rise at high end

/**
 * Build a single triangle-prism (wedge) BufferGeometry in local space.
 *
 * Local coordinate orientation:
 *   - Low end at -Z (front of ramp, where players enter)
 *   - High end at +Z (back of ramp, where players exit airborne)
 *   - Rises from Y=0 at the front to Y=RAMP_VIS_HEIGHT at the back
 *   - Symmetric in X (−hw … +hw)
 *
 * 6 vertices:
 *   0: front-L-bottom  (-hw, 0,   -hl)
 *   1: front-R-bottom  (+hw, 0,   -hl)
 *   2: back-L-bottom   (-hw, 0,   +hl)
 *   3: back-R-bottom   (+hw, 0,   +hl)
 *   4: back-L-top      (-hw, h,   +hl)
 *   5: back-R-top      (+hw, h,   +hl)
 *
 * 5 faces (8 triangles):
 *   floor:      0,2,1  / 1,2,3
 *   slope:      2,4,3  / 3,4,5
 *   left wall:  0,4,2
 *   right wall: 1,3,5
 *   back wall:  4,0,5  / 0,1,5   (triangulated quad — closes the prism)
 */
function buildWedgeGeometry(): THREE.BufferGeometry {
  const hw = RAMP_VIS_WIDTH  / 2;
  const hl = RAMP_VIS_LENGTH / 2;
  const h  = RAMP_VIS_HEIGHT;

  // 6 vertices × 3 components
  const positions = new Float32Array([
    -hw, 0, -hl,  // 0 front-L-bottom
     hw, 0, -hl,  // 1 front-R-bottom
    -hw, 0,  hl,  // 2 back-L-bottom
     hw, 0,  hl,  // 3 back-R-bottom
    -hw, h,  hl,  // 4 back-L-top
     hw, h,  hl,  // 5 back-R-top
  ]);

  // 8 triangles × 3 indices
  const indices = new Uint16Array([
    // Floor (bottom face)
    0, 2, 1,
    1, 2, 3,
    // Slope face (rises from front-bottom to back-top)
    2, 4, 3,
    3, 4, 5,
    // Left triangular wall
    0, 4, 2,
    // Right triangular wall
    1, 3, 5,
    // Back vertical wall (closes the open end of the prism)
    4, 0, 5,
    0, 1, 5,
  ]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  return geo;
}

// ─── Module-scope merged geometry ────────────────────────────────────────────
// All 6 ramps baked into one BufferGeometry at module load time.
// clientSpline is available synchronously at module scope (same as rocky-cliffs wall geo).
// Result: 1 draw call instead of 6.

function buildAllRampsGeo(): THREE.BufferGeometry {
  const rampDefs = buildSplineRampsClient();
  const templateGeo = buildWedgeGeometry();
  const parts: THREE.BufferGeometry[] = [];

  for (const ramp of rampDefs) {
    const pt   = clientSpline.centerlineAt(ramp.t);
    const tang = clientSpline.tangentAt(ramp.t);

    // Lateral normal: 90° CCW of tangent
    const nx = -tang.z;
    const nz =  tang.x;
    const wx = pt.x + nx * ramp.lateralOffset;
    const wz = pt.z + nz * ramp.lateralOffset;

    // rotY aligns the wedge's local +Z axis with the tangent direction
    const rotY = Math.atan2(tang.x, tang.z);

    // Build transform matrix for this ramp instance
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0));
    const mat = new THREE.Matrix4();
    mat.compose(
      new THREE.Vector3(wx, 0, wz),
      q,
      new THREE.Vector3(1, 1, 1),
    );

    // Clone template, apply transform, add to parts list
    const instanceGeo = templateGeo.clone();
    instanceGeo.applyMatrix4(mat);
    instanceGeo.computeVertexNormals();
    parts.push(instanceGeo);
  }

  // Merge all 6 into one geometry
  const merged = mergeGeometries(parts, false)!;

  // Dispose the individual part geometries (data was copied into merged)
  templateGeo.dispose();
  parts.forEach(g => g.dispose());

  return merged;
}

// Built once at module load — never disposed (page-lifetime, 1 draw call)
const _allRampsGeo = buildAllRampsGeo();

const _rampMat = new THREE.MeshStandardMaterial({
  color:     new THREE.Color('#c9884a'), // warm coral/wood — pops against blue river
  roughness: 0.85,
  metalness: 0.0,
  side:      THREE.DoubleSide,
});

// ─── Public component ─────────────────────────────────────────────────────────

/**
 * Renders all 6 ramp wedge meshes as a SINGLE merged draw call.
 *
 * Draw calls: 1 (was 6 — merged at module load via mergeGeometries).
 * Triangles: 6 × 8 = 48 tris (negligible).
 * Iris Xe: safe — plain Mesh + MeshStandardMaterial, no instancing with shaders.
 */
export function Ramps() {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, []);

  return (
    <mesh
      ref={meshRef}
      geometry={_allRampsGeo}
      material={_rampMat}
      castShadow
      receiveShadow
      frustumCulled={false}
      matrixAutoUpdate={false}
    />
  );
}
