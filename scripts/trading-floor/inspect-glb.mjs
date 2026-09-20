#!/usr/bin/env node
// inspect-glb.mjs — dump node/mesh/primitive structure + per-primitive bbox of a GLB.
// Usage: node scripts/trading-floor/inspect-glb.mjs <file.glb>

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3d';

const file = process.argv[2];
if (!file) throw new Error('usage: inspect-glb.mjs <file.glb>');

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const doc = await io.read(file);
const root = doc.getRoot();

console.log(`extensions: ${root.listExtensionsUsed().map((e) => e.extensionName).join(', ') || '(none)'}`);
console.log(`scenes=${root.listScenes().length} nodes=${root.listNodes().length} meshes=${root.listMeshes().length} materials=${root.listMaterials().length} textures=${root.listTextures().length}`);

for (const tex of root.listTextures()) {
  const img = tex.getImage();
  console.log(`  texture "${tex.getName()}" ${tex.getMimeType()} ${img ? (img.byteLength / 1024).toFixed(0) + 'K' : '?'} size=${tex.getSize()?.join('x')}`);
}

let totalTris = 0;
for (const mesh of root.listMeshes()) {
  for (const [i, prim] of mesh.listPrimitives().entries()) {
    const pos = prim.getAttribute('POSITION');
    const idx = prim.getIndices();
    const tris = idx ? idx.getCount() / 3 : pos.getCount() / 3;
    totalTris += tris;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const v = [0, 0, 0];
    for (let k = 0; k < pos.getCount(); k++) {
      pos.getElement(k, v);
      for (let a = 0; a < 3; a++) {
        if (v[a] < min[a]) min[a] = v[a];
        if (v[a] > max[a]) max[a] = v[a];
      }
    }
    const f = (n) => n.toFixed(3);
    console.log(
      `  mesh "${mesh.getName()}" prim${i} tris=${tris} verts=${pos.getCount()} mat="${prim.getMaterial()?.getName()}"\n` +
        `    bbox min=[${min.map(f)}] max=[${max.map(f)}] size=[${max.map((m, a) => f(m - min[a]))}]`
    );
  }
}
console.log(`TOTAL TRIS: ${totalTris}`);

for (const node of root.listNodes()) {
  console.log(`  node "${node.getName()}" mesh=${node.getMesh()?.getName() ?? '-'} t=${node.getTranslation().map((n) => n.toFixed(2))} s=${node.getScale().map((n) => n.toFixed(3))}`);
}
