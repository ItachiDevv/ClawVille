/**
 * Casino right-table deletion using gltf-transform v4 SDK (CommonJS, npx cache).
 * Preserves Material4 LINES primitive — only removes TRIANGLES faces by spatial bounds.
 *
 * glTF coordinate system (Y-up):
 *   glTF X = Blender X
 *   glTF Y = Blender Z (height)
 *   glTF Z = -Blender Y (depth, negated)
 *
 * Deletion zone: right-side 2 poker tables
 *   Blender X in [-645, -505]  -> glTF X in [-645, -505]
 *   Blender Y in [100, 440]    -> glTF Z in [-440, -100]
 */

'use strict';

const GLTF_BASE = 'C:/Users/newma/AppData/Local/npm-cache/_npx/a6797f7ff67bb1f2/node_modules/@gltf-transform';

const { NodeIO } = require(`${GLTF_BASE}/core/dist/index.cjs`);
const { KHRONOS_EXTENSIONS, EXTTextureWebP } = require(`${GLTF_BASE}/extensions/dist/index.cjs`);
const draco3d = require(`${GLTF_BASE}/../draco3dgltf`);

const GLB_IN     = 'C:/Users/newma/Documents/Crypto/ClawVille/apps/web/public/models/casino/casino-interior.glb';
const GLB_NODRAC = 'C:/Users/newma/Documents/Crypto/ClawVille/.tmp/casino-edited-nodrac.glb';

// glTF-space deletion bounds
const X_MIN = -645, X_MAX = -505;
const Z_MIN = -440, Z_MAX = -100;

function inZone(x, z) {
  return x >= X_MIN && x <= X_MAX && z >= Z_MIN && z <= Z_MAX;
}

async function main() {
  console.log('=== gltf-transform table deletion v4 ===');
  console.log(`Zone: glTF X[${X_MIN},${X_MAX}] Z[${Z_MIN},${Z_MAX}]`);
  console.log('(= Blender X[-645,-505] Y[100,440])');

  // In gltf-transform v4, draco decoder must be provided as dependency
  console.log('Initializing Draco decoder...');
  const decoder = await draco3d.createDecoderModule();

  const allExts = [...KHRONOS_EXTENSIONS, EXTTextureWebP];
  const io = new NodeIO()
    .registerExtensions(allExts)
    .registerDependencies({
      'draco3d.decoder': decoder,
    });

  console.log('Reading GLB (auto-decodes Draco)...');
  const doc = await io.read(GLB_IN);

  let totalFacesRemoved = 0;
  let totalVertsRemoved = 0;

  for (const mesh of doc.getRoot().listMeshes()) {
    const meshName = mesh.getName();
    for (const prim of mesh.listPrimitives()) {
      const mode = prim.getMode();
      if (mode !== 4) {  // 4 = TRIANGLES
        console.log(`  ${meshName}: skip (mode=${mode}, not TRIANGLES)`);
        continue;
      }

      const posAcc = prim.getAttribute('POSITION');
      if (!posAcc) continue;

      const pos = posAcc.getArray();
      const idxAcc = prim.getIndices();
      const idxArr = idxAcc ? Array.from(idxAcc.getArray()) : Array.from({length: pos.length/3}, (_,i)=>i);
      const triCount = idxArr.length / 3;

      // Count and collect keep/remove faces
      const keepIdx = [];
      let removed = 0;
      for (let t = 0; t < triCount; t++) {
        const i0=idxArr[t*3], i1=idxArr[t*3+1], i2=idxArr[t*3+2];
        const cx = (pos[i0*3]   + pos[i1*3]   + pos[i2*3])   / 3;
        const cz = (pos[i0*3+2] + pos[i1*3+2] + pos[i2*3+2]) / 3;
        if (inZone(cx, cz)) {
          removed++;
        } else {
          keepIdx.push(i0, i1, i2);
        }
      }

      if (removed === 0) continue;
      console.log(`  ${meshName}: removing ${removed}/${triCount} triangles`);
      totalFacesRemoved += removed;

      // Update index buffer — avoid spread for large arrays (stack overflow)
      let maxI = 0;
      for (let i = 0; i < keepIdx.length; i++) { if (keepIdx[i] > maxI) maxI = keepIdx[i]; }
      const newIdxArr = maxI < 65536 ? new Uint16Array(keepIdx) : new Uint32Array(keepIdx);
      if (idxAcc) {
        idxAcc.setArray(newIdxArr);
      }

      // Compact vertices
      const usedSet = new Set(keepIdx);
      const sortedUsed = Array.from(usedSet).sort((a, b) => a - b);
      const oldVCount = pos.length / 3;
      const newVCount = sortedUsed.length;

      if (newVCount < oldVCount) {
        const remap = new Int32Array(oldVCount).fill(-1);
        sortedUsed.forEach((oldI, newI) => { remap[oldI] = newI; });

        for (const sem of prim.listSemantics()) {
          const acc = prim.getAttribute(sem);
          const arr = acc.getArray();
          const stride = acc.getElementSize();
          const newArr = new (arr.constructor)(newVCount * stride);
          sortedUsed.forEach((oldI, newI) => {
            for (let c = 0; c < stride; c++) {
              newArr[newI*stride+c] = arr[oldI*stride+c];
            }
          });
          acc.setArray(newArr);
        }

        // Remap indices
        const remapped = new (newIdxArr.constructor)(keepIdx.length);
        for (let i = 0; i < keepIdx.length; i++) {
          remapped[i] = remap[keepIdx[i]];
        }
        if (idxAcc) {
          idxAcc.setArray(remapped);
        }

        totalVertsRemoved += (oldVCount - newVCount);
      }
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Faces removed: ${totalFacesRemoved.toLocaleString()}`);
  console.log(`  Verts removed: ${totalVertsRemoved.toLocaleString()}`);

  if (totalFacesRemoved === 0) {
    console.error('ERROR: 0 faces removed — coordinate mismatch?');
    process.exit(1);
  }

  // Remove Draco extension so we can write plain GLB
  const extsUsed = doc.getRoot().listExtensionsUsed();
  for (const ext of extsUsed) {
    if (ext.extensionName === 'KHR_draco_mesh_compression') {
      ext.dispose();
      console.log('  Disposed KHR_draco_mesh_compression extension');
    }
  }

  console.log(`\nWriting uncompressed GLB to: ${GLB_NODRAC}`);
  await io.write(GLB_NODRAC, doc);

  const { statSync } = require('fs');
  const sz = statSync(GLB_NODRAC).size;
  console.log(`Written: ${(sz/1024/1024).toFixed(1)} MB`);
  console.log('Next: npx @gltf-transform/cli draco <in> <out>');
  console.log('=== Done ===');
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
