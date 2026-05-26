/**
 * Casino right-table deletion using gltf-transform SDK.
 * No draco3dgpu needed for deletion — only for re-compression (done via CLI after).
 *
 * Coordinate system (glTF / Y-up):
 *   glTF X = Blender X
 *   glTF Y = Blender Z (height, up)
 *   glTF Z = -Blender Y (depth, negated because glTF is right-handed Y-up)
 *
 * Deletion bounds (from Phase 1 analysis, right-column tables):
 *   Blender X in [-645, -505]  ->  glTF X in [-645, -505]
 *   Blender Y in [100, 440]    ->  glTF Z in [-440, -100]
 */

import { NodeIO, Primitive } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';

const GLB_IN      = 'C:/Users/newma/Documents/Crypto/ClawVille/apps/web/public/models/casino/casino-interior.glb';
const GLB_NODRAC  = 'C:/Users/newma/Documents/Crypto/ClawVille/.tmp/casino-edited-nodrac.glb';

// glTF-space deletion bounds
const X_MIN = -645, X_MAX = -505;
const Z_MIN = -440, Z_MAX = -100;

function inZone(x, z) {
  return x >= X_MIN && x <= X_MAX && z >= Z_MIN && z <= Z_MAX;
}

async function main() {
  console.log('Reading GLB (with Draco decode)...');

  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
  const doc = await io.read(GLB_IN);

  let totalFaces = 0;
  let totalFacesKept = 0;

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mode = prim.getMode();
      if (mode !== 4) { // 4 = TRIANGLES
        console.log(`  ${mesh.getName()}: skipping mode=${mode}`);
        continue;
      }

      const posAcc = prim.getAttribute('POSITION');
      if (!posAcc) continue;

      const pos = posAcc.getArray();         // Float32Array
      const idxAcc = prim.getIndices();

      let indices;
      if (idxAcc) {
        indices = Array.from(idxAcc.getArray());
      } else {
        const n = pos.length / 3;
        indices = Array.from({ length: n }, (_, i) => i);
      }

      const triCount = indices.length / 3;
      totalFaces += triCount;

      const keepIdx = [];
      let removed = 0;

      for (let t = 0; t < triCount; t++) {
        const i0 = indices[t*3], i1 = indices[t*3+1], i2 = indices[t*3+2];
        const cx = (pos[i0*3]   + pos[i1*3]   + pos[i2*3])   / 3;
        const cz = (pos[i0*3+2] + pos[i1*3+2] + pos[i2*3+2]) / 3;
        if (inZone(cx, cz)) {
          removed++;
        } else {
          keepIdx.push(i0, i1, i2);
        }
      }

      if (removed === 0) continue;

      console.log(`  ${mesh.getName()}: removed ${removed}/${triCount} tris`);
      totalFacesKept += (triCount - removed);

      // --- Update index buffer ---
      const MaxI = Math.max(...keepIdx);
      const newIdxArr = MaxI < 65536 ? new Uint16Array(keepIdx) : new Uint32Array(keepIdx);

      if (idxAcc) {
        idxAcc.setArray(newIdxArr);
        idxAcc.setCount(newIdxArr.length);
      }

      // --- Compact vertex attributes (remove unreferenced verts) ---
      const usedSet = new Set(keepIdx);
      const sortedUsed = Array.from(usedSet).sort((a, b) => a - b);
      const oldCount = pos.length / 3;
      const newCount = sortedUsed.length;

      if (newCount < oldCount) {
        const remap = new Int32Array(oldCount).fill(-1);
        sortedUsed.forEach((oldI, newI) => { remap[oldI] = newI; });

        for (const sem of prim.listSemantics()) {
          const acc = prim.getAttribute(sem);
          const arr = acc.getArray();
          const stride = acc.getElementSize();
          const newArr = new (arr.constructor)(newCount * stride);
          sortedUsed.forEach((oldI, newI) => {
            for (let c = 0; c < stride; c++) {
              newArr[newI*stride + c] = arr[oldI*stride + c];
            }
          });
          acc.setArray(newArr);
          acc.setCount(newCount);
        }

        // Remap index buffer
        const remapped = new (newIdxArr.constructor)(keepIdx.length);
        for (let i = 0; i < keepIdx.length; i++) {
          remapped[i] = remap[keepIdx[i]];
        }
        if (idxAcc) {
          idxAcc.setArray(remapped);
          idxAcc.setCount(remapped.length);
        }
      }
    }
  }

  const totalRemoved = totalFaces - totalFacesKept;
  console.log(`\nTotal faces removed: ${totalRemoved.toLocaleString()} of ${totalFaces.toLocaleString()}`);

  if (totalRemoved === 0) {
    console.error('ERROR: 0 faces removed');
    process.exit(1);
  }

  // Remove Draco extension from document (we'll re-add via CLI)
  const dracoExt = doc.getRoot().listExtensionsUsed()
    .find(e => e.extensionName === 'KHR_draco_mesh_compression');
  if (dracoExt) dracoExt.dispose();

  console.log('Writing uncompressed GLB...');
  await io.write(GLB_NODRAC, doc);
  console.log(`Saved: ${GLB_NODRAC}`);
  console.log('Next: apply Draco via gltf-transform CLI');
}

main().catch(e => { console.error(e); process.exit(1); });
