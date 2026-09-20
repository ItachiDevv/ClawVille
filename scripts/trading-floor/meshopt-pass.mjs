#!/usr/bin/env node
// meshopt-pass.mjs — final geometry compression for the trading-floor GLBs.
//
// Runs AFTER KTX2 encoding on purpose: @gltf-transform/cli's texture commands
// decode EXT_meshopt_compression to do their work, so a meshopt pass placed
// before them is silently thrown away (same ordering constraint documented in
// scripts/compress-ktx2.ts).
//
// Usage: node scripts/trading-floor/meshopt-pass.mjs <in.glb> <out.glb>

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt, dedup, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3d';
import { statSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: meshopt-pass.mjs <in.glb> <out.glb>');

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const doc = await io.read(input);
await doc.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(output, doc);

const root = doc.getRoot();
let tris = 0;
for (const m of root.listMeshes()) {
  for (const p of m.listPrimitives()) {
    const i = p.getIndices();
    tris += i ? i.getCount() / 3 : p.getAttribute('POSITION').getCount() / 3;
  }
}
const texBytes = root.listTextures().reduce((n, t) => n + (t.getImage()?.byteLength ?? 0), 0);
console.log(
  `${output}\n  ${(statSync(output).size / 1024).toFixed(0)} KB total | ${tris} tris | ` +
    `${root.listMeshes().length} meshes | ${root.listMaterials().length} materials (= draw calls) | ` +
    `${root.listTextures().length} textures ${(texBytes / 1024).toFixed(0)} KB`
);
for (const t of root.listTextures()) {
  console.log(`  texture "${t.getName()}" ${t.getMimeType()} ${t.getSize()?.join('x')} ${((t.getImage()?.byteLength ?? 0) / 1024).toFixed(0)} KB`);
}
console.log(`  extensions: ${root.listExtensionsUsed().map((e) => e.extensionName).join(', ')}`);
