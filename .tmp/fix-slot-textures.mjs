/**
 * Replace the two flipped slot-machine textures (img03 + img04) in the
 * current casino-interior.glb with the correctly-oriented PNG sources
 * from the DAE archive. Preserves everything else: KHR_materials_unlit,
 * BC/FC delete, dealer translate, all other textures.
 *
 * Map (verified earlier):
 *   material `auto_4`  → texture#3 → image#3 = anime reel strips
 *   material `auto_16` → texture#4 → image#4 = CUSTOM MAID 3D2 backboard
 */

import fs from 'node:fs';
import path from 'node:path';

const GLTF_BASE = 'C:/Users/newma/AppData/Local/npm-cache/_npx/a6797f7ff67bb1f2/node_modules/@gltf-transform';
const { NodeIO } = await import(`file:///${GLTF_BASE}/core/dist/index.cjs`);
const { KHRONOS_EXTENSIONS, EXTTextureWebP } = await import(`file:///${GLTF_BASE}/extensions/dist/index.cjs`);

const IN_GLB   = 'apps/web/public/models/casino/casino-interior.glb';
const OUT_GLB  = '.tmp/casino-flipped-fix-uncompressed.glb';
const PNG_4    = '.tmp/casino-source-dae/source/model/__auto_4.png';
const PNG_16   = '.tmp/casino-source-dae/source/model/__auto_16.png';

// We need to decode Draco first — gltf-transform's NodeIO fails on Draco
// without explicit registration. Use the CLI to copy/decode → temp file.
const TMP_DECODED = '.tmp/casino-undraco-for-texture-fix.glb';

const { execSync } = await import('node:child_process');
console.log('Decoding Draco via CLI…');
execSync(`npx --yes @gltf-transform/cli copy "${IN_GLB}" "${TMP_DECODED}"`, { stdio: 'inherit' });

const io = new NodeIO().registerExtensions([...KHRONOS_EXTENSIONS, EXTTextureWebP]);
const doc = await io.read(TMP_DECODED);

// Find textures by walking materials
const root = doc.getRoot();
const mats = root.listMaterials();
console.log(`Found ${mats.length} materials.`);

let texReels = null;
let texMaid = null;
for (const mat of mats) {
  const name = mat.getName();
  const bct = mat.getBaseColorTexture();
  if (!bct) continue;
  if (name === 'auto_4')  texReels = bct;
  if (name === 'auto_16') texMaid  = bct;
}

if (!texReels) { console.error('FATAL: material auto_4 (reel strips) not found'); process.exit(1); }
if (!texMaid)  { console.error('FATAL: material auto_16 (maid art) not found');   process.exit(1); }

console.log('Replacing texture for auto_4 (reels)…');
const pngReels = fs.readFileSync(PNG_4);
texReels.setImage(pngReels);
texReels.setMimeType('image/png');
texReels.setURI('');
console.log(`  ${pngReels.length} bytes → texture#${root.listTextures().indexOf(texReels)}`);

console.log('Replacing texture for auto_16 (maid art)…');
const pngMaid = fs.readFileSync(PNG_16);
texMaid.setImage(pngMaid);
texMaid.setMimeType('image/png');
texMaid.setURI('');
console.log(`  ${pngMaid.length} bytes → texture#${root.listTextures().indexOf(texMaid)}`);

// Verify unlit extension survives
let unlitCount = 0;
for (const m of mats) {
  if (m.getExtension('KHR_materials_unlit')) unlitCount++;
}
console.log(`Materials with KHR_materials_unlit after edit: ${unlitCount} / ${mats.length}`);

// Drop Draco extension so we can write uncompressed (will re-compress via CLI)
for (const ext of root.listExtensionsUsed()) {
  if (ext.extensionName === 'KHR_draco_mesh_compression') {
    ext.dispose();
    console.log('Disposed KHR_draco_mesh_compression — will re-encode via CLI');
  }
}

console.log(`Writing → ${OUT_GLB}`);
await io.write(OUT_GLB, doc);
const sz = fs.statSync(OUT_GLB).size;
console.log(`  ${(sz / 1024 / 1024).toFixed(2)} MB`);
console.log('\nNext: npx @gltf-transform/cli draco <in> <out>');
