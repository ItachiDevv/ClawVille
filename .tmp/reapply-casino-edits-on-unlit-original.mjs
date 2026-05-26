/**
 * Re-apply BC/FC table+chair deletion + dealer-station translation to the
 * TRUE ORIGINAL casino-interior.glb (from commit c0afe4e parent — the file
 * with KHR_materials_unlit still intact on all 13 materials).
 *
 * Bypasses Blender entirely so:
 *   - KHR_materials_unlit extension is preserved → slot machines render
 *     with their Sketchfab-baked colors in Three.js (not the broken PBR
 *     dark cabinets we currently have on prod).
 *   - No mesh round-trip → no extra unweld verts, no normal/UV split,
 *     no shading-seam triangle artifacts.
 *
 * Zones reproduced from the Blender-edit session (Blender axes == glTF
 * axes for this asset — verified via accessor min/max).
 */

import fs from 'node:fs';
import path from 'node:path';

const GLTF_BASE = 'C:/Users/newma/AppData/Local/npm-cache/_npx/a6797f7ff67bb1f2/node_modules/@gltf-transform';
const { NodeIO } = await import(`file:///${GLTF_BASE}/core/dist/index.cjs`);
const { KHRONOS_EXTENSIONS, EXTTextureWebP } = await import(`file:///${GLTF_BASE}/extensions/dist/index.cjs`);

const IN_PATH  = path.resolve('.tmp/casino-undraco.glb');
const OUT_PATH = path.resolve('.tmp/casino-reapplied-unlit.glb');

// ── Edit zones — probe confirmed Blender axes == glTF accessor axes for
//    this asset (the model was authored Z-up; Blender's gltf-import did NOT
//    swap on the way in). Zones below are pasted directly from the Blender
//    edit session in the same axis convention.
const DELETE_ZONES = [
  { label: 'BC table',  xMin: -768, xMax: -672, yMin: -185, yMax: -130, zMin: -Infinity, zMax: Infinity },
  { label: 'FC table',  xMin: -768, xMax: -672, yMin: -330, yMax: -275, zMin: -Infinity, zMax: Infinity },
  { label: 'BC chairs', xMin: -810, xMax: -630, yMin: -245, yMax:  -65, zMin: -270,       zMax: -100 },
  { label: 'FC chairs', xMin: -810, xMax: -630, yMin: -395, yMax: -210, zMin: -270,       zMax: -100 },
];

const TRANSLATE_ZONE = {
  label: 'Dealer station',
  xMin: -780, xMax: -660,
  yMin: -35,  yMax:  35,
  zMin: -274, zMax: -100,
  deltaX: 189,
};

function inZone(x, y, z, z_) {
  return x >= z_.xMin && x <= z_.xMax
      && y >= z_.yMin && y <= z_.yMax
      && z >= z_.zMin && z <= z_.zMax;
}

function inAnyDeleteZone(x, y, z) {
  for (const dz of DELETE_ZONES) if (inZone(x, y, z, dz)) return true;
  return false;
}

async function main() {
  console.log('=== Re-apply casino edits on UNLIT original ===');

  const allExts = [...KHRONOS_EXTENSIONS, EXTTextureWebP];
  const io = new NodeIO().registerExtensions(allExts);

  console.log('Reading source GLB (auto-decodes Draco)…');
  const doc = await io.read(IN_PATH);
  console.log('  loaded:', IN_PATH);

  // Confirm unlit extension is present pre-process
  const matsBefore = doc.getRoot().listMaterials();
  let unlitCount = 0;
  for (const m of matsBefore) {
    if (m.getExtension('KHR_materials_unlit')) unlitCount++;
  }
  console.log(`  materials: ${matsBefore.length} (${unlitCount} with KHR_materials_unlit)`);
  if (unlitCount === 0) {
    console.error('FATAL: source GLB has no KHR_materials_unlit — wrong file?');
    process.exit(1);
  }

  let totalFacesDropped = 0;
  let totalVertsTranslated = 0;
  let totalVertsCompacted = 0;

  for (const mesh of doc.getRoot().listMeshes()) {
    const meshName = mesh.getName() || '(unnamed)';
    for (const prim of mesh.listPrimitives()) {
      const mode = prim.getMode();
      if (mode !== 4) {  // 4 = TRIANGLES
        continue;
      }
      const posAcc = prim.getAttribute('POSITION');
      if (!posAcc) continue;

      const pos = posAcc.getArray();      // Float32Array, length = vertCount * 3
      const vCount = pos.length / 3;

      // ── Step 1: translate dealer-zone verts (in place) ──────────────
      let translated = 0;
      for (let v = 0; v < vCount; v++) {
        const x = pos[v * 3 + 0];
        const y = pos[v * 3 + 1];
        const z = pos[v * 3 + 2];
        if (inZone(x, y, z, TRANSLATE_ZONE)) {
          pos[v * 3 + 0] = x + TRANSLATE_ZONE.deltaX;
          translated++;
        }
      }
      totalVertsTranslated += translated;
      if (translated > 0) {
        posAcc.setArray(pos);  // commit changes back
      }

      // ── Step 2: mark verts in any delete zone ────────────────────────
      // (Check ORIGINAL positions but we just translated dealer verts.
      //  Dealer verts are now at new X, outside delete zones.)
      const vertDeleted = new Uint8Array(vCount);
      for (let v = 0; v < vCount; v++) {
        const x = pos[v * 3 + 0];
        const y = pos[v * 3 + 1];
        const z = pos[v * 3 + 2];
        if (inAnyDeleteZone(x, y, z)) {
          vertDeleted[v] = 1;
        }
      }

      // ── Step 3: walk faces, drop any face whose verts touch delete ──
      const idxAcc = prim.getIndices();
      const idxArr = idxAcc ? Array.from(idxAcc.getArray()) : Array.from({ length: vCount }, (_, i) => i);
      const triCount = idxArr.length / 3;

      const keepIdx = [];
      let dropped = 0;
      for (let t = 0; t < triCount; t++) {
        const i0 = idxArr[t * 3 + 0];
        const i1 = idxArr[t * 3 + 1];
        const i2 = idxArr[t * 3 + 2];
        if (vertDeleted[i0] || vertDeleted[i1] || vertDeleted[i2]) {
          dropped++;
        } else {
          keepIdx.push(i0, i1, i2);
        }
      }
      totalFacesDropped += dropped;

      if (dropped > 0) {
        // ── Step 4: compact verts ─────────────────────────────────────
        const used = new Set(keepIdx);
        const sortedUsed = Array.from(used).sort((a, b) => a - b);
        const newVCount = sortedUsed.length;
        const remap = new Int32Array(vCount).fill(-1);
        sortedUsed.forEach((oldI, newI) => { remap[oldI] = newI; });

        // Rewrite each attribute (position, normal, uv, etc.)
        for (const sem of prim.listSemantics()) {
          const acc = prim.getAttribute(sem);
          const arr = acc.getArray();
          const stride = acc.getElementSize();
          const newArr = new arr.constructor(newVCount * stride);
          sortedUsed.forEach((oldI, newI) => {
            for (let c = 0; c < stride; c++) {
              newArr[newI * stride + c] = arr[oldI * stride + c];
            }
          });
          acc.setArray(newArr);
        }

        // Rewrite indices with remapped values
        const newIdxArr = newVCount < 65536
          ? new Uint16Array(keepIdx.length)
          : new Uint32Array(keepIdx.length);
        for (let i = 0; i < keepIdx.length; i++) {
          newIdxArr[i] = remap[keepIdx[i]];
        }
        if (idxAcc) {
          idxAcc.setArray(newIdxArr);
        }

        totalVertsCompacted += (vCount - newVCount);
        console.log(`  ${meshName}: dropped ${dropped} tris, compacted ${vCount - newVCount} verts, translated ${translated} verts`);
      } else if (translated > 0) {
        console.log(`  ${meshName}: translated ${translated} verts (no faces dropped)`);
      }
    }
  }

  console.log('\nSummary:');
  console.log(`  Faces dropped:        ${totalFacesDropped.toLocaleString()}`);
  console.log(`  Verts translated:     ${totalVertsTranslated.toLocaleString()}`);
  console.log(`  Verts compacted away: ${totalVertsCompacted.toLocaleString()}`);

  // ── Verify unlit extension survived ────────────────────────────────
  const matsAfter = doc.getRoot().listMaterials();
  let unlitAfter = 0;
  for (const m of matsAfter) {
    if (m.getExtension('KHR_materials_unlit')) unlitAfter++;
  }
  console.log(`  Materials after: ${matsAfter.length} (${unlitAfter} with KHR_materials_unlit)`);
  if (unlitAfter !== unlitCount) {
    console.error('WARNING: unlit count changed — investigate.');
  }

  // ── Drop Draco extension (we'll re-encode via CLI) ─────────────────
  const extsUsed = doc.getRoot().listExtensionsUsed();
  for (const ext of extsUsed) {
    if (ext.extensionName === 'KHR_draco_mesh_compression') {
      ext.dispose();
      console.log('  Disposed KHR_draco_mesh_compression (re-encode via CLI next)');
    }
  }

  console.log(`\nWriting uncompressed GLB → ${OUT_PATH}`);
  await io.write(OUT_PATH, doc);
  const size = fs.statSync(OUT_PATH).size;
  console.log(`  ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log('\nNext step: npx @gltf-transform/cli draco <in> <out>');
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
