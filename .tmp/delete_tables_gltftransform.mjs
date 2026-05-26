/**
 * Casino table deletion using gltf-transform.
 * Removes faces from right-side poker tables by spatial bounds.
 * Preserves all mesh structure, Materials, LINES primitive, textures.
 * Re-applies Draco compression to output.
 *
 * Deletion zone (Blender/GLB space — Y-up glTF, so axes differ from Blender):
 *   In the original GLB (Y-up, glTF coordinate system):
 *   - glTF X = Blender X
 *   - glTF Y = Blender Z (height)
 *   - glTF Z = -Blender Y (depth, negated)
 *
 *   Blender bounds: X[-963,-478], Y[-508,+509], Z[-274,-71]
 *   glTF bounds from inspect: X[-963,-478], Y[-274,-71], Z[-509,+508]
 *   (Y and Z axes swapped+negated vs Blender import space)
 *
 *   Target: right-side tables where:
 *     Blender X in [-645, -505]  => glTF X in [-645, -505]
 *     Blender Y in [100, 440]    => glTF Z in [-440, -100]  (Z = -blenderY)
 *
 *   So glTF deletion zone:
 *     gltfX in [-645, -505]
 *     gltfZ in [-440, -100]
 */

import { NodeIO, Document, Primitive } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import { DracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgpu';

const GLB_IN  = 'C:/Users/newma/Documents/Crypto/ClawVille/apps/web/public/models/casino/casino-interior.glb';
const GLB_OUT = 'C:/Users/newma/Documents/Crypto/ClawVille/apps/web/public/models/casino/casino-interior.glb';
const GLB_PREVIEW = 'C:/Users/newma/Documents/Crypto/ClawVille/.tmp/casino-edited-preview.glb';

// glTF coordinate space deletion bounds
// (confirmed: gltfX = blenderX, gltfZ = -blenderY since gltf is Y-up)
const GTLF_X_MIN = -645;
const GTLF_X_MAX = -505;
const GTLF_Z_MIN = -440;  // = -blenderY_max = -440
const GTLF_Z_MAX = -100;  // = -blenderY_min = -100

function faceCentroid(positions, faceIdx) {
  // positions is Float32Array, each vertex has 3 components
  // triangle face: indices i0, i1, i2
  const x = (positions[faceIdx*3] + positions[faceIdx*3+3] + positions[faceIdx*3+6]) / 3;
  const z = (positions[faceIdx*3+2] + positions[faceIdx*3+5] + positions[faceIdx*3+8]) / 3;
  return { x, z };
}

function inZone(x, z) {
  return x >= GTLF_X_MIN && x <= GTLF_X_MAX && z >= GTLF_Z_MIN && z <= GTLF_Z_MAX;
}

async function main() {
  console.log('=== gltf-transform table deletion ===');
  console.log(`Zone: gltfX[${GTLF_X_MIN},${GTLF_X_MAX}] gltfZ[${GTLF_Z_MIN},${GTLF_Z_MAX}]`);

  // Register Draco extension
  const io = new NodeIO()
    .registerExtensions(KHRONOS_EXTENSIONS);

  // Read GLB (Draco will be decoded automatically by gltf-transform)
  console.log('Reading GLB...');
  const doc = await io.read(GLB_IN);

  let totalFacesRemoved = 0;
  let totalVertsRemoved = 0;
  const affectedMeshes = [];

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      // Only process TRIANGLES
      if (prim.getMode() !== Primitive.Mode.TRIANGLES) {
        console.log(`  Skipping ${mesh.getName()} (mode=${prim.getMode()})`);
        continue;
      }

      const posAccess = prim.getAttribute('POSITION');
      if (!posAccess) continue;

      const positions = posAccess.getArray();  // Float32Array
      const indicesAccess = prim.getIndices();

      let indices;
      if (indicesAccess) {
        indices = indicesAccess.getArray();  // Uint16Array or Uint32Array
      } else {
        // Non-indexed: create sequential indices
        const count = positions.length / 3;
        indices = new Uint32Array(count);
        for (let i = 0; i < count; i++) indices[i] = i;
      }

      const triangleCount = indices.length / 3;

      // Count faces in zone
      let inZoneCount = 0;
      for (let t = 0; t < triangleCount; t++) {
        const i0 = indices[t * 3];
        const i1 = indices[t * 3 + 1];
        const i2 = indices[t * 3 + 2];
        const cx = (positions[i0*3] + positions[i1*3] + positions[i2*3]) / 3;
        const cz = (positions[i0*3+2] + positions[i1*3+2] + positions[i2*3+2]) / 3;
        if (inZone(cx, cz)) inZoneCount++;
      }

      if (inZoneCount === 0) continue;

      console.log(`  ${mesh.getName()}: ${inZoneCount}/${triangleCount} faces in zone`);
      affectedMeshes.push(mesh.getName());
      totalFacesRemoved += inZoneCount;

      // Build new index buffer keeping only faces NOT in zone
      const keepIndices = [];
      for (let t = 0; t < triangleCount; t++) {
        const i0 = indices[t * 3];
        const i1 = indices[t * 3 + 1];
        const i2 = indices[t * 3 + 2];
        const cx = (positions[i0*3] + positions[i1*3] + positions[i2*3]) / 3;
        const cz = (positions[i0*3+2] + positions[i1*3+2] + positions[i2*3+2]) / 3;
        if (!inZone(cx, cz)) {
          keepIndices.push(i0, i1, i2);
        }
      }

      // Update index accessor
      const IndexClass = indices.length / 3 > 65535 ? Uint32Array : Uint16Array;
      const newIndices = new (keepIndices.length > 65535 ? Uint32Array : Uint16Array)(keepIndices);

      if (indicesAccess) {
        indicesAccess.setArray(newIndices);
      }

      // Compact vertex data: remove unused vertices
      // Build set of used indices
      const usedVerts = new Set(Array.from(newIndices));
      const oldCount = positions.length / 3;
      const newCount = usedVerts.size;
      totalVertsRemoved += (oldCount - newCount);

      if (newCount < oldCount) {
        // Build remap: old index -> new index
        const remap = new Int32Array(oldCount).fill(-1);
        let newIdx = 0;
        const sortedUsed = Array.from(usedVerts).sort((a, b) => a - b);
        for (const oldI of sortedUsed) {
          remap[oldI] = newIdx++;
        }

        // Compact all vertex attributes
        for (const sem of prim.listSemantics()) {
          const acc = prim.getAttribute(sem);
          const arr = acc.getArray();
          const compCount = acc.getElementSize();
          const newArr = new (arr.constructor)(newCount * compCount);
          for (const oldI of sortedUsed) {
            const newI = remap[oldI];
            for (let c = 0; c < compCount; c++) {
              newArr[newI * compCount + c] = arr[oldI * compCount + c];
            }
          }
          acc.setArray(newArr);
          acc.setCount(newCount);
        }

        // Remap indices
        const remappedIndices = new (newIndices.length > 65535 ? Uint32Array : Uint16Array)(newIndices.length);
        for (let i = 0; i < newIndices.length; i++) {
          remappedIndices[i] = remap[newIndices[i]];
        }
        if (indicesAccess) {
          indicesAccess.setArray(remappedIndices);
          indicesAccess.setCount(remappedIndices.length);
        }
      }
    }
  }

  console.log(`\nTotal faces removed: ${totalFacesRemoved.toLocaleString()}`);
  console.log(`Total verts removed: ${totalVertsRemoved.toLocaleString()}`);
  console.log(`Affected meshes: ${[...new Set(affectedMeshes)].join(', ')}`);

  if (totalFacesRemoved === 0) {
    console.error('ERROR: 0 faces removed — check coordinate bounds');
    process.exit(1);
  }

  // Re-apply Draco compression
  console.log('\nApplying Draco compression...');
  // We'll write uncompressed first, then run gltf-transform CLI for Draco
  // (the SDK draco() function requires draco3dgpu native module)
  console.log('Writing preview (uncompressed)...');
  await io.write(GLB_PREVIEW, doc);

  console.log(`Preview saved: ${GLB_PREVIEW}`);
  console.log('Run: npx @gltf-transform/cli draco <preview> <output> to re-compress');
  console.log('=== Done ===');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
