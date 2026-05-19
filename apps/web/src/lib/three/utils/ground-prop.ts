/**
 * ground-prop.ts — canonical "place this GLB on the sand floor" math.
 *
 * Use this ANY time you mount a new static GLB (stall, decoration, building
 * exterior, prop) directly in the world. Replaces magic-number `yOffset`
 * tuning with a deterministic bbox-derived offset.
 *
 * Pattern (locked 2026-05-19 after bazaar tent shipped half-buried in sand):
 *
 *   1. Clone the GLB scene.
 *   2. Compute uniform scale `s` (your normal `computeScale`/auto-fit).
 *   3. Call `groundedYOffset(cloned, s)` → returns Y such that the LOWEST
 *      vertex of the scaled mesh sits exactly at SAND_BASELINE_Y.
 *   4. Use that Y in `<group position={[x, groundedY, z]} scale={[s,s,s]}>`.
 *
 * Why this is needed:
 *   - Different GLBs author their origin at different heights:
 *     - Some at the FLOOR of the model (origin at base, model extends +Y).
 *     - Some at the CENTER of the model (origin in middle, model extends ±Y).
 *     - Some at the TOP/APEX (model extends -Y from origin).
 *   - A flat `yOffset = -2` only works for floor-origin GLBs.
 *   - Per-prop magic-number tuning is the bug that buried the bazaar tent.
 *
 * Implementation notes:
 *   - Computes bbox at scale=1 from `cloned`, then multiplies by `s`.
 *     (Avoids needing to mount → re-bbox → unmount → re-position.)
 *   - Excludes SkinnedMesh from bbox walk to match the rest of the codebase.
 *   - Adds optional `clearance` (default 0) to lift the prop slightly above
 *     the sand to prevent z-fighting with the terrain plane.
 */

import * as THREE from 'three/webgpu';

/**
 * The sand terrain renders at world Y = -2 (matches `arena-terrain.tsx`).
 * Props grounded to this baseline read as "sitting on the sand floor."
 */
export const SAND_BASELINE_Y = -2;

const _bbox = new THREE.Box3();
const _meshBbox = new THREE.Box3();

/**
 * Compute the world-Y position that puts the LOWEST point of `root`
 * (after applying uniform `scale`) at exactly `SAND_BASELINE_Y + clearance`.
 *
 * Example:
 *   const scale = computeScale(cloned);                  // e.g. 0.025
 *   const y = groundedYOffset(cloned, scale);            // e.g. -1.7
 *   return <group position={[STALL_X, y, STALL_Z]} scale={scale} />;
 *
 * @param root      The cloned GLB scene root (not yet scaled/positioned).
 *                  Must be in its native, untransformed state.
 * @param scale     Uniform scale that will be applied to the group.
 * @param clearance Extra wu above the baseline (anti-z-fight). Default 0.
 *                  Use 0.5–2 if you see flickering at the prop's base.
 * @returns         Y world position for the group.
 */
export function groundedYOffset(
  root: THREE.Object3D,
  scale: number,
  clearance = 0,
): number {
  _bbox.makeEmpty();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh && mesh.geometry) {
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      _meshBbox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _bbox.union(_meshBbox);
    }
  });
  if (_bbox.isEmpty()) {
    _bbox.setFromObject(root);
  }
  // bbox.min.y is in NATIVE units (scale=1). After we apply `scale` to the
  // outer group, the actual world-Y of the lowest vertex relative to the
  // group's position will be `bbox.min.y * scale`. To land it at SAND_BASELINE_Y:
  //   bottomWorldY = position.y + bbox.min.y * scale
  //   SAND_BASELINE_Y + clearance = position.y + bbox.min.y * scale
  //   position.y = SAND_BASELINE_Y + clearance - bbox.min.y * scale
  return SAND_BASELINE_Y + clearance - _bbox.min.y * scale;
}
