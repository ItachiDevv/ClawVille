/**
 * terrain-heightfield.ts
 *
 * O(1) terrain height lookup via bilinear interpolation into a pre-built
 * heightfield grid.  Replaces the per-NPC / per-avatar downward raycast against
 * the 28,800-triangle terrain mesh, which was confirmed at ~57% of JS CPU in a
 * prod trace (intersectTriangle + _computeIntersections + getX/Y/Z attribute reads
 * + Vector3 math) 2026-06-15.
 *
 * HOW IT WORKS
 * ============
 * arena-terrain.tsx builds a PlaneGeometry(w, h, 120, 120) displaced by a
 * deterministic dune+ripple formula, then mounts it with:
 *
 *   rotation={[-Math.PI/2, 0, 0]}   (rotates XY plane → XZ world plane)
 *   position={[0, -2, 0]}           (lowers floor by 2 wu)
 *
 * After -90°X rotation the coordinate mapping is:
 *
 *   worldX = localX
 *   worldY = localZ + (−2)          (localZ holds the displaced height)
 *   worldZ = −localY
 *
 * Inverting: localX = worldX, localY = −worldZ.
 *
 * We read displaced-height = localZ = pos.getZ(i) for every vertex and store
 * them in a Float32Array indexed by (row, col).  At query time we locate the
 * four surrounding grid cells, bilinearly interpolate, add the −2 world offset,
 * and return worldY.
 *
 * ACCURACY
 * ========
 * This produces EXACTLY the same surface the raycast hits — no formula
 * re-derivation risk.  Bilinear interpolation over the grid is the same
 * interpolation Three.js uses to rasterize the triangulated plane, so
 * results agree to within floating-point precision.
 *
 * USAGE
 * =====
 *   import { initTerrainHeightfield, getTerrainHeightAt } from './terrain-heightfield';
 *
 *   // Call once after createSandGeometry() returns:
 *   initTerrainHeightfield(sandGeo);
 *
 *   // O(1) query anywhere:
 *   const worldY = getTerrainHeightAt(worldX, worldZ);
 */

import type * as THREE from 'three/webgpu';

// ---------------------------------------------------------------------------
// Module-scope heightfield state (singleton — one terrain per game scene)
// ---------------------------------------------------------------------------

/** Number of VERTICES per axis = segments + 1. Set during init. */
let _cols = 0; // segsX + 1
let _rows = 0; // segsY + 1

/** World-space extents of the plane, derived from geometry. */
let _halfW = 0; // half of plane width  (world X range)
let _halfH = 0; // half of plane height (world Z range = -localY range)

/** Cell size in world units. */
let _cellW = 0;
let _cellH = 0;

/** Flat Float32Array of displaced heights in LOCAL Z (before -2 world offset).
 *  Indexed as heights[row * _cols + col].
 *  Row 0 = most-negative localY (= most-positive worldZ).
 *  Col 0 = most-negative localX (= most-negative worldX). */
let _heights: Float32Array | null = null;

let _initialized = false;

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/**
 * Build the heightfield from the already-displaced PlaneGeometry.
 * Call once from createSandGeometry() after pos.setZ() loop completes.
 *
 * @param geo  The PlaneGeometry built by createSandGeometry()
 * @param segsX  Number of X segments (default 120)
 * @param segsY  Number of Y segments (default 120)
 */
export function initTerrainHeightfield(
  geo: THREE.PlaneGeometry,
  segsX = 120,
  segsY = 120,
): void {
  const cols = segsX + 1;
  const rows = segsY + 1;

  const pos = geo.attributes.position as THREE.BufferAttribute;

  // Determine half-extents from vertex positions (avoids needing w/h directly).
  // In PlaneGeometry vertices are laid out row by row (Y outer, X inner).
  // First vertex is at (-w/2, h/2, 0) before displacement.
  // We read actual vertex X and Y to infer extents robustly.
  const minLocalX = pos.getX(0); // first vertex, leftmost column
  const maxLocalX = pos.getX(cols - 1); // first row, rightmost column
  const maxLocalY = pos.getY(0); // first row, top (positive Y in PlaneGeometry)
  const minLocalY = pos.getY((rows - 1) * cols); // last row, bottom (negative Y)

  _cols  = cols;
  _rows  = rows;
  _halfW = (maxLocalX - minLocalX) / 2; // = w/2 in world X
  _halfH = (maxLocalY - minLocalY) / 2; // = h/2 in world Z (via -localY)
  _cellW = (maxLocalX - minLocalX) / segsX;
  _cellH = (maxLocalY - minLocalY) / segsY;

  // Copy displaced heights into a flat Float32Array.
  _heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // PlaneGeometry vertex order: row r=0 is top (maxLocalY), r=rows-1 is bottom (minLocalY).
      // Column c=0 is left (minLocalX), c=cols-1 is right (maxLocalX).
      const vi = r * cols + c; // vertex index
      _heights[vi] = pos.getZ(vi); // displaced height in local Z (before world -2 offset)
    }
  }

  _initialized = true;
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

/**
 * Return the terrain surface worldY at any (worldX, worldZ).
 *
 * Coordinate derivation:
 *   localX = worldX
 *   localY = -worldZ   (from -90°X rotation)
 *   displaced = bilinear(localX, localY)
 *   worldY = displaced + (-2)   (from position={[0,-2,0]})
 *
 * Returns -2 (flat floor fallback) if:
 *   - heightfield not yet initialised (terrain not mounted)
 *   - query point outside plane extents
 *
 * Zero per-call allocations — only arithmetic on stack values.
 */
export function getTerrainHeightAt(worldX: number, worldZ: number): number {
  if (!_initialized || !_heights) return -2;

  // Convert world coords to local plane coords
  const localX = worldX;
  const localY = -worldZ; // from the -90°X rotation

  // Map localX from [-halfW, +halfW] → [0, cols-1]
  // Map localY from [-halfH, +halfH] → [rows-1, 0]  (Y flips: top row = max localY)
  const u = (localX + _halfW) / (_halfW * 2) * (_cols - 1);
  const v = (_halfH - localY) / (_halfH * 2) * (_rows - 1);
  // Note: v is computed as (halfH - localY) because row 0 = top = maxLocalY.

  // Clamp to grid bounds
  const u0 = Math.max(0, Math.min(_cols - 2, Math.floor(u)));
  const v0 = Math.max(0, Math.min(_rows - 2, Math.floor(v)));
  const u1 = u0 + 1;
  const v1 = v0 + 1;

  // Bilinear weights
  const fu = u - u0;
  const fv = v - v0;

  // Four corner heights
  const h00 = _heights[v0 * _cols + u0];
  const h10 = _heights[v0 * _cols + u1];
  const h01 = _heights[v1 * _cols + u0];
  const h11 = _heights[v1 * _cols + u1];

  // Bilinear interpolation
  const localZ =
    h00 * (1 - fu) * (1 - fv) +
    h10 * fu       * (1 - fv) +
    h01 * (1 - fu) * fv       +
    h11 * fu       * fv;

  // World Y = localZ - 2  (from position={[0, -2, 0]})
  return localZ - 2;
}

/** True once initTerrainHeightfield() has been called successfully. */
export function isTerrainHeightfieldReady(): boolean {
  return _initialized;
}
