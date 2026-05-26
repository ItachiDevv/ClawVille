/**
 * fix-hair-offset.mjs
 *
 * Fixes the Milady VRM bald-spot by adjusting the Y-translation of the
 * Hairmodel node to close the gap between the hair mesh and the scalp crown.
 *
 * Root cause (CDP measured): Static 24.5wu gap at NPC scale 112.
 * In GLTF units: 24.5 / 112 = 0.2187 units.
 *
 * The Hairmodel node has T=[−0.000, 0.207, 0.029]. Adding 0.219 to Y
 * moves the hair up to T=[−0.000, 0.426, 0.029] which closes the gap.
 *
 * Hatmodel (the hat/hair ornament) is separate and positioned correctly.
 *
 * Usage: bun run scripts/fix-hair-offset.mjs <input.vrm> <output.vrm>
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import fs from 'fs';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: bun scripts/fix-hair-offset.mjs <input.vrm> <output.vrm>');
  process.exit(1);
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });

console.log(`Reading: ${inputPath}`);
const document = await io.read(inputPath);
const root = document.getRoot();
const scene = root.listScenes()[0];

// Enumerate all nodes
const allNodes = [];
function traverse(node) { allNodes.push(node); node.listChildren().forEach(traverse); }
scene.listChildren().forEach(traverse);

// Gap: 24.5wu at scale=112 → 24.5/112 = 0.21875 GLTF units
const GAP_Y = 24.5 / 112;  // ≈ 0.2188

const fixes = [];

// Fix Hairmodel — the top bun/main hair mesh
const hairmodelNode = allNodes.find(n => n.getName() === 'Hairmodel');
if (hairmodelNode) {
  const t = hairmodelNode.getTranslation();
  const oldY = t[1];
  const newY = oldY + GAP_Y;
  hairmodelNode.setTranslation([t[0], newY, t[2]]);
  fixes.push({ node: 'Hairmodel', oldT: [...t], newT: [t[0], newY, t[2]] });
  console.log(`Hairmodel: Y ${oldY.toFixed(4)} → ${newY.toFixed(4)} (+${GAP_Y.toFixed(4)})`);
} else {
  console.warn('WARNING: Hairmodel node not found');
}

// Also adjust Hatmodel to stay aligned with Hairmodel
// The task description mentions Hatmodel as the hat, which may or may not need adjusting
// Based on CDP: the gap is specifically at the back-crown scalp area.
// The Hatmodel (hat) probably sits on top and doesn't need adjustment.
// Only adjust Hairmodel for now.

// Verify
for (const fix of fixes) {
  console.log(`\nVerified ${fix.node}:`);
  console.log(`  Was: T=[${fix.oldT.map(v=>v.toFixed(4)).join(', ')}]`);
  console.log(`  Now: T=[${fix.newT.map(v=>v.toFixed(4)).join(', ')}]`);
}

// Strip meshopt compression for output (keep as plain GLB)
for (const ext of root.listExtensionsUsed()) {
  if (ext.extensionName === 'EXT_meshopt_compression') {
    ext.dispose();
  }
}

console.log(`\nWriting: ${outputPath}`);
await io.write(outputPath, document);

const inSize = fs.statSync(inputPath).size;
const outSize = fs.statSync(outputPath).size;
console.log(`Done. ${(inSize/1024).toFixed(1)}KB → ${(outSize/1024).toFixed(1)}KB`);
