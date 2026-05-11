/**
 * merge-static-meshes.ts — collapses a static GLB sub-tree's draw calls by
 * merging meshes that share a material reference into one BufferGeometry.
 *
 * Use on GLBs that never animate or move (buildings, stalls, signs, props).
 * NOT for SkinnedMesh (skeleton needs per-mesh skin bindings) or
 * InstancedMesh (that's already optimal).
 *
 * What it does
 *   1. Snapshots every descendant Mesh's world matrix relative to `root`.
 *   2. Buckets meshes by material reference.
 *   3. For each bucket of N>=2 meshes, bakes each geometry's
 *      local-to-root matrix into the vertex positions/normals, then calls
 *      mergeGeometries() to produce a single BufferGeometry.
 *   4. Replaces the bucketed meshes with one new Mesh parented directly to
 *      `root` at identity transform.
 *
 * What it preserves
 *   - root's own transform (callers apply scale/rotation to root itself).
 *   - One material per merged mesh — no group-mode merging.
 *   - matrixAutoUpdate=false on merged meshes (buildings never move).
 *   - Skipped multi-material meshes and SkinnedMesh / InstancedMesh stay
 *     intact in the tree.
 *
 * Risks
 *   - Loses per-submesh frustum culling (one mesh = whole bucket).
 *     Fine for buildings — the user already turned all culling off and a
 *     building is small relative to the world.
 *   - Geometry attribute mismatches (one mesh has tangents, another
 *     doesn't) throw inside mergeGeometries — we normalize to a
 *     {position, normal, uv} subset before merging.
 *   - Transparent vs opaque materials shouldn't share a bucket — three.js
 *     sort order matters. We bucket by material *reference*, so a single
 *     transparent material's meshes merge with each other; opaque with
 *     opaque. That's already correct.
 *
 * Returns the number of draw calls saved (informational).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _scratchInv = new THREE.Matrix4();
const _scratchLocal = new THREE.Matrix4();

const ALLOWED_ATTRS = ['position', 'normal', 'uv'] as const;

function normalizeAttributes(g: THREE.BufferGeometry): THREE.BufferGeometry {
  // CRITICAL: every attribute must be CLONED. The caller does
  // applyMatrix4(localToRoot) on the returned geometry, which mutates the
  // position attribute IN PLACE. Sharing the original attribute reference
  // would write the local-to-root transform directly onto the source
  // geometry — every original mesh's positions would be silently shifted
  // even when no merge happened, breaking the scene visually.
  const out = new THREE.BufferGeometry();
  for (const name of ALLOWED_ATTRS) {
    const a = g.attributes[name];
    if (a) out.setAttribute(name, a.clone());
  }
  if (g.index) out.setIndex(g.index.clone());
  return out;
}

export interface MergeResult {
  /** Draw calls before. */
  meshesBefore: number;
  /** Draw calls after (merged + skipped). */
  meshesAfter: number;
  /** Number of material buckets that were merged. */
  buckets: number;
  /** Count of skipped meshes (skinned/instanced/multi-material). */
  skipped: number;
}

export function mergeStaticMeshesByMaterial(root: THREE.Object3D): MergeResult {
  root.updateMatrixWorld(true);
  _scratchInv.copy(root.matrixWorld).invert();

  const buckets = new Map<
    THREE.Material,
    { geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }
  >();

  let meshesBefore = 0;
  let skipped = 0;

  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshesBefore++;
    if ((m as THREE.SkinnedMesh).isSkinnedMesh) { skipped++; return; }
    if ((m as THREE.InstancedMesh).isInstancedMesh) { skipped++; return; }
    if (Array.isArray(m.material) && m.material.length > 1) { skipped++; return; }
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as
      | THREE.Material
      | undefined;
    if (!mat || !m.geometry) { skipped++; return; }

    _scratchLocal.multiplyMatrices(_scratchInv, m.matrixWorld);
    const g = normalizeAttributes(m.geometry);
    g.applyMatrix4(_scratchLocal);

    let bucket = buckets.get(mat);
    if (!bucket) {
      bucket = { geos: [], meshes: [] };
      buckets.set(mat, bucket);
    }
    bucket.geos.push(g);
    bucket.meshes.push(m);
  });

  let mergedBuckets = 0;
  let mergedMeshCount = 0;

  for (const [mat, bucket] of buckets) {
    if (bucket.geos.length === 0) continue;
    // Single-mesh buckets aren't worth merging — leave the original mesh.
    if (bucket.geos.length === 1) {
      // Drop the cloned/normalized geometry; the original is fine.
      bucket.geos[0].dispose?.();
      continue;
    }
    try {
      const merged = mergeGeometries(bucket.geos, false);
      if (!merged) {
        // Attribute mismatch — leave the originals.
        for (const g of bucket.geos) g.dispose?.();
        continue;
      }
      const mergedMesh = new THREE.Mesh(merged, mat);
      mergedMesh.matrixAutoUpdate = false;
      mergedMesh.updateMatrix();
      // Carry over receive/cast-shadow flags from the first source mesh.
      mergedMesh.castShadow = bucket.meshes[0].castShadow;
      mergedMesh.receiveShadow = bucket.meshes[0].receiveShadow;
      mergedMesh.frustumCulled = false;
      root.add(mergedMesh);
      mergedBuckets++;
      mergedMeshCount++;
      // Remove the originals.
      for (const m of bucket.meshes) {
        m.parent?.remove(m);
        // The merged geometry now owns the data — dispose originals.
        m.geometry.dispose();
      }
    } catch {
      for (const g of bucket.geos) g.dispose?.();
    }
  }

  // mergedMeshCount + (skipped original-mesh-count we didn't touch) +
  // (single-mesh buckets that we left alone). Use a fresh traverse for an
  // accurate after-count.
  let meshesAfter = 0;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshesAfter++;
  });

  return { meshesBefore, meshesAfter, buckets: mergedBuckets, skipped };
}
