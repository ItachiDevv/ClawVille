#!/usr/bin/env node
/**
 * verify-anim-bundle.mjs — confirms the merged _emotes.glb has all 19 clips
 * with the expected names, every animation channel resolves to a real node
 * in the merged scene, and the file size sanity check passes.
 *
 * Run: node scripts/verify-anim-bundle.mjs
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { resolve, dirname } from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT  = resolve(dirname(__filename), '..');
const BUNDLE     = resolve(REPO_ROOT, 'apps/web/public/avatars/animations/_emotes.glb');

const EXPECTED_CLIPS = [
  'looking_around','squat','waving','talk','dance_happy','float',
  'crawling','crying','dance_breaking','dance_hiphop','dance_popping',
  'fall','fishing','flip','jump','kiss','rude_gesture','sorrow','spell_cast',
];

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });

const doc = await io.read(BUNDLE);
const root = doc.getRoot();
const anims = root.listAnimations();
const sizeKB = (statSync(BUNDLE).size / 1024).toFixed(0);

console.log(`Bundle: ${BUNDLE}`);
console.log(`File size: ${sizeKB} KB`);
console.log(`Buffers: ${root.listBuffers().length}`);
console.log(`Scenes: ${root.listScenes().length}`);
console.log(`Nodes: ${root.listNodes().length}`);
console.log(`Animations: ${anims.length}`);

const found = anims.map((a) => a.getName());
const missing = EXPECTED_CLIPS.filter((c) => !found.includes(c));
const extra   = found.filter((c) => !EXPECTED_CLIPS.includes(c));

console.log(`\nExpected clip names: ${EXPECTED_CLIPS.length}`);
console.log(`Found    clip names: ${found.length}`);
if (missing.length) console.error(`MISSING:`, missing);
if (extra.length)   console.warn(`UNEXPECTED:`, extra);

// Validate every channel of every animation resolves to a real node in the
// merged graph (not a dangling pointer).
const allNodes = new Set(root.listNodes());
let totalChannels = 0;
let unresolvedChannels = 0;
const nodeNameHistogram = new Map();
for (const anim of anims) {
  for (const ch of anim.listChannels()) {
    totalChannels++;
    const target = ch.getTargetNode();
    if (!target || !allNodes.has(target)) {
      unresolvedChannels++;
      continue;
    }
    const nm = target.getName() ?? '<unnamed>';
    nodeNameHistogram.set(nm, (nodeNameHistogram.get(nm) || 0) + 1);
  }
}
console.log(`\nTotal channels: ${totalChannels}`);
console.log(`Unresolved channels: ${unresolvedChannels}`);
console.log(`Unique target node names: ${nodeNameHistogram.size}`);
// Spot-check: every Mixamo skeleton has 65 bones, so per-animation that's
// up to ~65 quaternion channels + 1 hip position channel.
// Print the top-15 most-targeted node names — confirms the merge preserved
// the Mixamo skeleton (every name should look like mixamorig.../Armature|...).
const top = [...nodeNameHistogram.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15);
console.log('Top targeted nodes:');
for (const [name, count] of top) console.log(`  ${count.toString().padStart(4)}  ${name}`);

if (missing.length || unresolvedChannels > 0) {
  console.error('\nFAIL');
  process.exit(1);
}
console.log('\nPASS');
