#!/usr/bin/env node
/**
 * strip-meshy-anim-mesh.mjs
 *
 * Strips mesh/material/texture/skin data from a Meshy animation-library GLB,
 * keeping ONLY the node hierarchy (skeleton) + animation channels.
 *
 * Meshy's /animations endpoint bakes the FULL rigged character (mesh +
 * textures) into every clip export — verified on the cove sit-flow clips:
 * 13.5MB each, vs ~100-150KB for a comparable Mixamo animation-only bake.
 * The retargeter (mixamo-retarget.ts) never reads geometry/materials — only
 * named Object3D nodes (findNode) for rest-pose lookups and animation
 * tracks. Stripping mesh data before bundling is required, not optional:
 * bundling N un-stripped clips scales the payload by N × ~13.5MB, a hard
 * violation of the web-perf-first mandate (CLAUDE.md Priority #1).
 *
 * Run once per raw Meshy animation clip, BEFORE build-cove-sit-bundle.mjs
 * (or any future Meshy-sourced anim bundle script) merges them.
 *
 * Usage:
 *   node scripts/strip-meshy-anim-mesh.mjs <in.glb> <out.glb>
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup } from '@gltf-transform/functions';
import { statSync } from 'node:fs';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: strip-meshy-anim-mesh.mjs <in.glb> <out.glb>');
  process.exit(1);
}

const doc = await io.read(inPath);
const root = doc.getRoot();

for (const mesh of root.listMeshes()) mesh.dispose();
for (const material of root.listMaterials()) material.dispose();
for (const texture of root.listTextures()) texture.dispose();
for (const skin of root.listSkins()) skin.dispose();

await doc.transform(prune(), dedup());

await io.write(outPath, doc);

const before = statSync(inPath).size;
const after = statSync(outPath).size;
console.log(`${inPath} -> ${outPath}`);
console.log(`  ${(before / 1024).toFixed(0)}KB -> ${(after / 1024).toFixed(0)}KB (${(100 * after / before).toFixed(1)}%)`);
console.log(`  nodes=${root.listNodes().length} animations=${root.listAnimations().length} meshes=${root.listMeshes().length} skins=${root.listSkins().length}`);
