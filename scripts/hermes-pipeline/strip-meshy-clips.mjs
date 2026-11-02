#!/usr/bin/env bun
// strip-meshy-clips.mjs — make small, portable copies of a Meshy character for
// standalone viewers (artifact pages, QC pages) that cannot load meshopt WASM.
//
//   bun scripts/hermes-pipeline/strip-meshy-clips.mjs <model.vrm|glb> <animDir> <outDir>
//
// Writes:
//   <outDir>/model.glb       — the model with EXT_meshopt_compression decoded
//                              (plain buffers; WebP textures kept; VRMC_vrm dropped).
//   <outDir>/clips/<slot>.glb — each <animDir>/<slot>.glb reduced to the bare node
//                              hierarchy + its animation (renamed to <slot>);
//                              meshes, skins, materials and textures removed.
// Clips bind by node name (Hips, Spine, LeftArm, ...), so they drive the model
// directly with three.js AnimationMixer. Raw Meshy bone names, not mixamorig*.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const [modelPath, animDir, outDir] = process.argv.slice(2);
if (!modelPath || !animDir || !outDir) {
  console.error('usage: strip-meshy-clips.mjs <model.vrm|glb> <animDir> <outDir>');
  process.exit(1);
}

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
mkdirSync(join(outDir, 'clips'), { recursive: true });

// Model: decode meshopt by disposing the extension before write.
const model = await io.read(modelPath);
for (const ext of model.getRoot().listExtensionsUsed()) {
  if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
}
await io.write(join(outDir, 'model.glb'), model);
console.log(`model -> ${join(outDir, 'model.glb')}`);

// Clips: keep nodes + animation only.
for (const f of readdirSync(animDir).filter((n) => n.endsWith('.glb'))) {
  const slot = basename(f, '.glb');
  const doc = await io.read(join(animDir, f));
  const root = doc.getRoot();
  for (const node of root.listNodes()) { node.setMesh(null); node.setSkin(null); }
  for (const m of root.listMeshes()) m.dispose();
  for (const s of root.listSkins()) s.dispose();
  for (const m of root.listMaterials()) m.dispose();
  for (const t of root.listTextures()) t.dispose();
  const anims = root.listAnimations();
  if (anims.length === 0) { console.warn(`${slot}: no animation, skipped`); continue; }
  anims[0].setName(slot);
  for (const extra of anims.slice(1)) extra.dispose();
  for (const ext of root.listExtensionsUsed()) ext.dispose();
  await doc.transform(prune({ keepLeaves: true }));
  await io.write(join(outDir, 'clips', `${slot}.glb`), doc);
  console.log(`clip ${slot} -> ${join(outDir, 'clips', `${slot}.glb`)}`);
}
