'use client';

/**
 * rocky-banks.tsx — Rocky cliff banks that turn the Reef Race river into
 * a sunken canyon.
 *
 * Visual target: the river channel sits below the surrounding land,
 * enclosed by stepped rocky cliffs on both sides.  A player inside the
 * canyon sees rock walls rising above the water line on left and right.
 *
 * Y-coordinate contract (iter-6 — WATER_Y=-200 deep ravine):
 *
 *   y =  +30   outer rock outcrop (taller rim above ground for dramatic silhouette)
 *   y =    0   ground / grass level (unchanged anchor)
 *   y = -180   water-line cliff top (most of the 180wu drop from ground happens here)
 *   y = -220   mid cliff face (underwater rock)
 *   y = -250   channel floor / river bed (matches river bed mesh position-y)
 *
 * The 180wu vertical drop from v1→v2 is the cliff face visible from above.
 * Significant visual mass — player looks DOWN into the ravine.
 *
 * Geometry details:
 *   • N=80 cross-sections along clientSpline (t=0…1, inclusive)
 *   • 5-vertex profile per side per cross-section:
 *       v0 outer-top (hw+250, y=  +30) — rock outcrop, tall rim above ground
 *       v1 outer-mid (hw+100, y=    0) — at ground level (anchor)
 *       v2 inner-top (hw,     y= -180) — water-line cliff top (180wu drop from v1)
 *       v3 inner-mid (hw-100, y= -220) — mid cliff face, underwater
 *       v4 inner-bot (hw- 50, y= -250) — channel floor (matches river bed)
 *   • Left bank: normal direction +1 (normalAt result is LEFT of travel)
 *   • Right bank: normal direction -1
 *   • Both sides merged into ONE BufferGeometry — single draw call
 *   • Triangle count: 79 pairs × 4 quads × 2 sides × 2 tris = 1264 tris
 *
 * Material:
 *   MeshStandardMaterial, flatShading: true (low-poly faceted rock look)
 *   Vertex colors baked at module load for tonal variation
 *   Color palette: base #8a7a6b, light #9c8a78, dark #6e5e52
 *
 * Performance:
 *   • Geometry built ONCE at module scope (zero per-frame work)
 *   • frustumCulled=false, matrixAutoUpdate=false
 *   • Single draw call (merged both sides)
 *   • receiveShadow=true, castShadow=false
 *
 * Iris Xe invariants:
 *   • import from 'three' only — never 'three/webgpu'
 *   • MeshStandardMaterial — NOT ShaderMaterial, NOT InstancedMesh
 *   • module-scope geo + mat — no per-frame allocations
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clientSpline } from './reef-race-spline-instance';

// ─── Cross-section constants ──────────────────────────────────────────────────

/** Number of cross-sections along the spline (inclusive, so N-1 strips). */
const N_SECTIONS = 80;

/**
 * 5-vertex lateral profile per side, relative to the spline centerline.
 * Each entry: [lateralOffsetFactor, yWorld]
 *   lateralOffset = hw * factor + addend (see PROFILE_OFFSETS_ABS)
 * Using absolute wu offsets added to hw makes the profile independent of hw.
 */
// 2026-04-29 iter-7d: pulled v0 outer-top from +30 to 0. The +30 protrusion
// dominated the top-down view at narrow chokepoint sections (kelp/shipwreck/
// coral halfWidth 420-525), covering the cyan water with brown cliff stripe.
// At y=0 it's flush with ground — the cliff's lateral protrusion still
// blocks the water at 1050 corridor, but from top-down the cliff "rim" is
// invisible and water dominates the visible canyon channel. Cliff face
// drops from y=0 → y=-180 (water-line) inside the corridor, so cinematic
// player POV still sees cliff walls on each side.
const PROFILE_Y: readonly number[] = [0, 0, -180, -220, -250];

/**
 * Absolute wu added to halfWidth for each profile vertex.
 * v0: hw+250  v1: hw+100  v2: hw+0  v3: hw-100  v4: hw-50
 * Wider inset at v3/v4 for cliff thickness proportional to the deeper canyon.
 * Note v4 < v3 in lateral offset — toe-in at channel floor (natural rock undercut).
 */
const PROFILE_D_OFFSET: readonly number[] = [+250, +100, 0, -100, -50];

const PROFILE_VERTS = PROFILE_Y.length; // 5

// ─── Colour palette for vertex colours ───────────────────────────────────────

const _COL_BASE  = new THREE.Color('#8a7a6b'); // muted sand-brown
const _COL_LIGHT = new THREE.Color('#9c8a78'); // lighter stone
const _COL_DARK  = new THREE.Color('#6e5e52'); // darker rust-shadow

/** Seeded hash — returns 0–1 deterministically for a given integer seed. */
function hashI(n: number): number {
  let s = ((n ^ 0xdeadbeef) + 0x12345678) | 0;
  s = (s ^ (s >>> 16)) | 0;
  s = Math.imul(s, 0x45d9f3b) | 0;
  s = (s ^ (s >>> 16)) | 0;
  return ((s >>> 0) / 0xffffffff);
}

/**
 * Build vertex colour for cross-section index `si` and profile vertex `vi`.
 * Strategy:
 *   - Slow sine wave (period ~10 sections) drives the base brightness band.
 *   - Small per-section hash perturbation prevents perfect regularity.
 *   - Lower profile vertices (v3, v4) are darkened to simulate shadow.
 * Result: natural horizontal striations with subtle vertical darkening.
 */
function sectionColor(si: number, vi: number): THREE.Color {
  // Slow oscillation: period ~10 cross-sections → bands of similar tone
  const wave = Math.sin(si * 0.63 + 1.7) * 0.5 + 0.5; // 0–1
  // Per-section hash jitter ±0.15
  const jitter = hashI(si * 7 + vi * 13) * 0.30 - 0.15;
  const t = Math.max(0, Math.min(1, wave + jitter));

  // Blend between dark and light palette
  const r = _COL_DARK.r + (_COL_LIGHT.r - _COL_DARK.r) * t;
  const g = _COL_DARK.g + (_COL_LIGHT.g - _COL_DARK.g) * t;
  const b = _COL_DARK.b + (_COL_LIGHT.b - _COL_DARK.b) * t;

  // Shadow factor: lower cliff face (v3=idx3, v4=idx4) is 25% darker
  const shadowFactor = vi >= 3 ? 0.75 : 1.0;

  return new THREE.Color(r * shadowFactor, g * shadowFactor, b * shadowFactor);
}

// ─── Geometry builder ─────────────────────────────────────────────────────────

/**
 * Build a half-canyon cliff ribbon for ONE side of the river.
 *
 * @param sign  +1 = left bank (follow normalAt direction)
 *              -1 = right bank (negate normalAt)
 */
function buildCliffSideGeo(sign: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors:    number[] = [];

  // For each cross-section we push PROFILE_VERTS=5 vertices.
  // Total verts = N_SECTIONS * PROFILE_VERTS
  // Total strips between adjacent cross-sections: (N_SECTIONS - 1) * (PROFILE_VERTS - 1) quads
  // Each quad = 2 tris → indices.length = (N_SECTIONS-1) * (PROFILE_VERTS-1) * 6

  for (let si = 0; si < N_SECTIONS; si++) {
    const t  = si / (N_SECTIONS - 1); // 0 … 1
    const c  = clientSpline.centerlineAt(t);
    const n  = clientSpline.normalAt(t);
    const hw = clientSpline.widthAt(t);

    for (let vi = 0; vi < PROFILE_VERTS; vi++) {
      const d   = hw + PROFILE_D_OFFSET[vi];
      const nx  = n.x * sign;
      const nz  = n.z * sign;

      positions.push(
        c.x + nx * d,
        PROFILE_Y[vi],
        c.z + nz * d,
      );

      const col = sectionColor(si, vi);
      colors.push(col.r, col.g, col.b);
    }
  }

  // Build triangle index buffer.
  // For cross-sections i and i+1:
  //   quad strip between profile vertex vi and vi+1
  //
  //   Row i,    vert vi   → baseA = i*PROFILE_VERTS + vi
  //   Row i,    vert vi+1 → baseA + 1
  //   Row i+1,  vert vi   → baseB = (i+1)*PROFILE_VERTS + vi
  //   Row i+1,  vert vi+1 → baseB + 1
  //
  // Winding order: we want front-face toward the INSIDE of the canyon
  // (i.e. toward the negative-sign side from this bank).
  // For left bank (sign=+1): inner face is toward -X, so looking from inside
  // the canyon, the face should be wound CCW from that viewpoint.
  //
  // A quad from the top-down view (XZ plane):
  //   baseA ─── baseB
  //     |         |
  //   baseA+1 ─ baseB+1
  //
  // For left bank (sign=+1, outer verts at larger X):
  //   We want inner-facing tris. From inside canyon, looking toward +X:
  //   tri1: baseA, baseA+1, baseB    (CCW from inner viewpoint)
  //   tri2: baseA+1, baseB+1, baseB
  //
  // For right bank (sign=-1, outer verts at smaller X):
  //   From inside canyon, looking toward -X:
  //   tri1: baseA, baseB, baseA+1
  //   tri2: baseA+1, baseB, baseB+1

  const indices: number[] = [];
  for (let si = 0; si < N_SECTIONS - 1; si++) {
    const baseA = si * PROFILE_VERTS;
    const baseB = (si + 1) * PROFILE_VERTS;

    for (let vi = 0; vi < PROFILE_VERTS - 1; vi++) {
      const a0 = baseA + vi;
      const a1 = baseA + vi + 1;
      const b0 = baseB + vi;
      const b1 = baseB + vi + 1;

      if (sign > 0) {
        // Left bank — inner face winds CCW when viewed from +X toward -X
        indices.push(a0, a1, b0);
        indices.push(a1, b1, b0);
      } else {
        // Right bank — inner face winds CCW when viewed from -X toward +X
        indices.push(a0, b0, a1);
        indices.push(a1, b0, b1);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors,    3));
  geo.setIndex(indices);
  // Compute vertex normals BEFORE merging — flatShading will override them
  // visually but the buffer needs correct normals for shadow calculations.
  geo.computeVertexNormals();
  return geo;
}

// ─── Module-scope merged geometry + material (built once at module load) ──────

const _leftGeo  = buildCliffSideGeo(+1);
const _rightGeo = buildCliffSideGeo(-1);

/**
 * Merged canyon cliff geometry — both banks in one BufferGeometry.
 * Triangle count: (N_SECTIONS-1) × (PROFILE_VERTS-1) × 2 sides × 2 tris/quad
 *               = 79 × 4 × 2 × 2 = 1264 tris
 * Draw calls: 1
 */
const _cliffGeo = mergeGeometries([_leftGeo, _rightGeo], false);
// Input geos no longer needed after merge
_leftGeo.dispose();
_rightGeo.dispose();

const _cliffMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading:  true,
  roughness:    0.9,
  metalness:    0.05,
  // 2026-04-29: switched from FrontSide → DoubleSide. Iter-5 deploy showed the
  // canyon as solid BLACK from cinematic ground POV — back-face culling was
  // hiding the cliff inner faces from the player perspective. DoubleSide costs
  // ~2× fragment shading on the cliff but the geo is small (1264 tris) so the
  // perf impact is negligible.
  side:         THREE.DoubleSide,
});

// ─── React component ──────────────────────────────────────────────────────────

/**
 * RockyBanks — renders the merged canyon cliff geometry as a single draw call.
 *
 * Wire-up: add <RockyBanks /> inside the ReefRaceScene (or RiverScene) group,
 * at the same level as <SandRibbon /> and <WaterRibbon />.
 *
 * No props needed — all config is baked into the module-scope geometry.
 */
export function RockyBanks() {
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    // Lock matrix — no per-frame transform updates needed
    m.matrixAutoUpdate = false;
    m.updateMatrix();
  }, []);

  return (
    <mesh
      ref={meshRef}
      geometry={_cliffGeo}
      material={_cliffMat}
      frustumCulled={false}
      matrixAutoUpdate={false}
      receiveShadow
      castShadow={false}
      renderOrder={1}
    />
  );
}
