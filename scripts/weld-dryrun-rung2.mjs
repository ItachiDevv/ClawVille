#!/usr/bin/env bun
/**
 * weld-dryrun-rung2.mjs — READ-ONLY exact-tuple weld dry-run (rung-2 census).
 * Loads a VRM/GLB (meshopt decoded), runs gltf-transform weld() in memory,
 * reports vert counts before/after per primitive. Writes NOTHING to disk.
 *
 * Usage: bun scripts/weld-dryrun-rung2.mjs <file> [...more]
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
});

for (const file of process.argv.slice(2)) {
  const doc = await io.read(file);
  const counts = () => {
    let verts = 0, tris = 0;
    for (const mesh of doc.getRoot().listMeshes())
      for (const prim of mesh.listPrimitives()) {
        verts += prim.getAttribute('POSITION')?.getCount() ?? 0;
        const idx = prim.getIndices();
        tris += Math.floor((idx ? idx.getCount() : prim.getAttribute('POSITION')?.getCount() ?? 0) / 3);
      }
    return { verts, tris };
  };
  const before = counts();
  await doc.transform(weld());
  const after = counts();
  const pct = ((1 - after.verts / before.verts) * 100).toFixed(1);
  console.log(`${file}\n  before: ${before.verts} verts / ${before.tris} tris\n  after exact weld: ${after.verts} verts / ${after.tris} tris  (verts -${pct}%)`);
}
