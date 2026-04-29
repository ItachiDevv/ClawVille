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
 *   - Module-scope shared geometry + material — 0 extra allocations per mount
 *   - 6 draw calls total (one plain Mesh per ramp)
 *
 * Placement:
 *   Each ramp sits at clientSpline.centerlineAt(t) + lateral offset.
 *   rotationY aligns the wedge's high-end (+Z of local geometry) to the
 *   spline tangent direction so players hit the slope face-on.
 *
 * Iris Xe invariants:
 *   - Plain Mesh + plain MeshStandardMaterial — safe.
 *   - No InstancedMesh + ShaderMaterial (crash gotcha).
 *   - No drei Text/Billboard (crash gotcha).
 *   - matrixAutoUpdate=false on all 6 meshes (static after mount).
 *   - Module-scope geo/mat never disposed (page-lifetime, shared).
 */

import { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { buildSplineRampsClient } from './reef-race-config';
import { clientSpline } from './reef-race-spline-instance';

// ─── Wedge geometry constants ─────────────────────────────────────────────────

const RAMP_VIS_LENGTH = 300;  // wu along tangent (halfLength × 2)
const RAMP_VIS_WIDTH  = 400;  // wu perpendicular (halfWidth × 2)
const RAMP_VIS_HEIGHT = 60;   // wu vertical rise at high end

/**
 * Build a triangle-prism (wedge) BufferGeometry.
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
 *
 * DoubleSide material handles any winding issues on interior faces.
 * computeVertexNormals() produces shading-correct normals for each face.
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

// ─── Module-scope shared geometry + material ──────────────────────────────────
// Created once at module load — never disposed (page-lifetime).
// Shared across all 6 ramp meshes (zero extra allocations per mount).

const _wedgeGeo = buildWedgeGeometry();

const _rampMat = new THREE.MeshStandardMaterial({
  color:     new THREE.Color('#c9884a'), // warm coral/wood — pops against blue river
  roughness: 0.85,
  metalness: 0.0,
  side:      THREE.DoubleSide,
});

// ─── Ramp mesh component ─────────────────────────────────────────────────────

interface RampMeshProps {
  id: string;
  t: number;
  lateralOffset: number;
}

/**
 * Single static ramp wedge placed at a specific spline t-value.
 * matrixAutoUpdate=false because ramps never move after mount.
 */
function RampMesh({ id, t, lateralOffset }: RampMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  // Compute world position + rotation from spline at module level (pure math,
  // no allocations — called exactly once per mount inside useMemo).
  const transform = useMemo(() => {
    const pt   = clientSpline.centerlineAt(t);  // {x, z}
    const tang = clientSpline.tangentAt(t);      // {x, z} unit

    // Lateral offset: normal = 90° CCW of tangent.
    const nx = -tang.z;
    const nz =  tang.x;
    const wx = pt.x + nx * lateralOffset;
    const wz = pt.z + nz * lateralOffset;

    // rotY aligns the wedge's local +Z axis with the tangent direction.
    // atan2(tang.x, tang.z) gives the Three.js Y-rotation for a +Z-forward model.
    const rotY = Math.atan2(tang.x, tang.z);

    return { wx, wz, rotY };
  }, [t, lateralOffset]);

  // Disable matrix auto-update — static mesh, matrix set once.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, []);

  return (
    <mesh
      ref={meshRef}
      key={id}
      geometry={_wedgeGeo}
      material={_rampMat}
      position={[transform.wx, 0, transform.wz]}
      rotation={[0, transform.rotY, 0]}
      castShadow
      receiveShadow
    />
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

/**
 * Renders all 6 ramp wedge meshes along the spline track.
 * Import and render once inside <RiverScene />.
 *
 * Draw calls: 6 (one plain Mesh per ramp).
 * Triangles: 6 × 8 = 48 tris (negligible).
 * Iris Xe: safe — plain Mesh + MeshStandardMaterial, no instancing with shaders.
 */
export function Ramps() {
  const rampDefs = useMemo(() => buildSplineRampsClient(), []);

  return (
    <>
      {rampDefs.map((ramp) => (
        <RampMesh
          key={ramp.id}
          id={ramp.id}
          t={ramp.t}
          lateralOffset={ramp.lateralOffset}
        />
      ))}
    </>
  );
}
