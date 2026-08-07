#!/usr/bin/env bun
/**
 * diet-dryrun-rung2.mjs — READ-ONLY diet byte estimator (rung-2 census).
 * In-memory only: reads an asset, applies the candidate transform chain, and
 * measures io.writeBinary().length. NOTHING is written to disk. For VRMs the
 * VRMC_vrm block is stripped by gltf-transform in this estimate — its ~1-3KB
 * JSON re-inject cost is noted but immaterial to the estimate.
 *
 * Modes:
 *   --meshopt          weld + meshopt (the B4/B2 "mechanical" diet)
 *   --simplify=N       weld + simplify to ~N tris (ratio vs current) + meshopt (B1 ladder)
 *
 * Usage: bun scripts/diet-dryrun-rung2.mjs --meshopt file1 [file2...]
 *        bun scripts/diet-dryrun-rung2.mjs --simplify=60000,45000,38000 file.vrm
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, meshopt, simplify } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const draco3d = await import('draco3d');
const dracoDecoder = await draco3d.createDecoderModule();

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
  'draco3d.decoder': dracoDecoder,
});

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const doMeshopt = args.includes('--meshopt');
const simplifyArg = args.find((a) => a.startsWith('--simplify='));
const simplifyTargets = simplifyArg ? simplifyArg.split('=')[1].split(',').map(Number) : [];

const mb = (b) => (b / 1048576).toFixed(3);

function dropDraco(doc) {
  // geometry is decoded on read; the extension marker would demand a draco
  // ENCODER at write time — remove it so output is plain/meshopt.
  for (const ext of doc.getRoot().listExtensionsUsed())
    if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();
}

function triCount(doc) {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      tris += Math.floor((idx ? idx.getCount() : prim.getAttribute('POSITION')?.getCount() ?? 0) / 3);
    }
  return tris;
}

for (const file of files) {
  const srcBytes = (await import('fs')).statSync(file).size;
  console.log(`\n### ${file} — src ${mb(srcBytes)}MB`);

  if (doMeshopt) {
    const doc = await io.read(file);
    await doc.transform(weld(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
    dropDraco(doc);
    const out = await io.writeBinary(doc);
    console.log(`  weld+meshopt(high): ${mb(out.length)}MB  (save ${mb(srcBytes - out.length)}MB, -${((1 - out.length / srcBytes) * 100).toFixed(1)}%)`);
  }

  for (const target of simplifyTargets) {
    const doc = await io.read(file);
    const tris = triCount(doc);
    const ratio = Math.min(1, target / tris);
    await doc.transform(
      weld(),
      // shipping params from scripts/decimate-vrm.ts:466
      simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: true }),
      meshopt({ encoder: MeshoptEncoder, level: 'high' }),
    );
    const outTris = triCount(doc);
    dropDraco(doc);
    const out = await io.writeBinary(doc);
    console.log(`  simplify→${target} (got ${outTris}) + meshopt: ${mb(out.length)}MB  (save ${mb(srcBytes - out.length)}MB, -${((1 - out.length / srcBytes) * 100).toFixed(1)}%)`);
  }
}
