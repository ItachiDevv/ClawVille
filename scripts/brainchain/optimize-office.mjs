#!/usr/bin/env node
// Targeted static-asset compression. Geometry and proportions remain unchanged.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, weld, prune, meshopt, getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/brainchain/optimize-office.mjs <input.glb> <new-output.glb>');
const work = resolve('.brainchain-work/office-compression');
mkdirSync(work, { recursive: true });
mkdirSync(dirname(output), { recursive: true });
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
});
const doc = await io.read(input);
const root = doc.getRoot();
if (root.listAnimations().length || root.listSkins().length) throw new Error('Expected an unrigged static building');
for (const material of root.listMaterials()) {
  if (material.getNormalTexture()) throw new Error('Unexpected normal map requires visual review');
}
const before = getBounds(root.listScenes()[0]);
const triangles = root.listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((n, primitive) => n + (primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION').getCount()) / 3, 0), 0);
if (triangles > 12_000 || root.listMaterials().length > 2) throw new Error('Source exceeds the reviewed mesh budget');
const toktx = process.env.KTX2_TOKTX_EXE || resolve(process.env.USERPROFILE, 'scoop/apps/ktx-software/current/bin/toktx.exe');
let index = 0;
for (const texture of root.listTextures()) {
  const png = resolve(work, `base-${index}.png`);
  const ktx = resolve(work, `base-${index++}.ktx2`);
  await sharp(texture.getImage()).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toFile(png);
  const result = spawnSync(toktx, ['--t2', '--genmipmap', '--encode', 'uastc', '--uastc_quality', '4', '--uastc_rdo_l', '2', '--zcmp', '18', '--assign_oetf', 'srgb', ktx, png], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`toktx failed: ${result.stderr}`);
  texture.setImage(readFileSync(ktx)).setMimeType('image/ktx2');
}
doc.createExtension(KHRTextureBasisu).setRequired(true);
// Texture processing precedes meshopt; later texture transforms can remove mesh compression.
await doc.transform(dedup(), weld(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'high', quantizePosition: 14, quantizeTexcoord: 16 }));
const candidate = `${output}.candidate.glb`;
await io.write(candidate, doc);
const check = await io.read(candidate);
const after = getBounds(check.getRoot().listScenes()[0]);
for (const texture of check.getRoot().listTextures()) {
  const bytes = Buffer.from(texture.getImage());
  if (bytes.readUInt32LE(40) !== 11) throw new Error('Expected a complete 1024 KTX2 mip chain');
}
for (const side of ['min', 'max']) for (let axis = 0; axis < 3; axis++) {
  if (Math.abs(before[side][axis] - after[side][axis]) > 0.001) throw new Error('Compression changed bounds beyond quantization tolerance');
}
// Provisional 1 MiB exception: ETC1S and 512 UASTC fail atlas fidelity.
// See docs/research/brainchain-2026-11-09/3d/compression-review.md.
if (statSync(candidate).size > 1024 * 1024) throw new Error('Compressed asset exceeds the provisional 1 MiB cap');
renameSync(candidate, output);
const report = { input, output, compression: { texture: 'UASTC', resolution: 1024, quality: 4, rdoLambda: 2, zstd: 18, mipLevels: 11, meshopt: 'high', positionBits: 14, texcoordBits: 16 }, sourceSha256: createHash('sha256').update(readFileSync(input)).digest('hex'), sha256: createHash('sha256').update(readFileSync(output)).digest('hex'), bytes: statSync(output).size, triangles, materials: check.getRoot().listMaterials().length, textures: check.getRoot().listTextures().map((t) => ({ mime: t.getMimeType(), size: t.getSize(), bytes: t.getImage().byteLength })), bounds: after };
writeFileSync(resolve(work, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));







