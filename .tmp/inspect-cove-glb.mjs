/** Dump the JSON manifest from cove-interior.glb without decoding meshes.
 *  GLB format = 12-byte header + JSON chunk + BIN chunk. We only need the
 *  JSON chunk to find node names — meshes can stay Draco-compressed. */
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

const GLB_PATH = resolve('apps/web/public/models/cove/cove-interior.glb');
const buf = await fs.readFile(GLB_PATH);

// GLB header: magic (4) + version (4) + length (4) = 12 bytes
const magic = buf.toString('utf8', 0, 4);
if (magic !== 'glTF') throw new Error(`not a GLB file: magic=${magic}`);

// First chunk header: length (4) + type (4)
const jsonChunkLen = buf.readUInt32LE(12);
const jsonChunkType = buf.toString('utf8', 16, 20);
if (jsonChunkType !== 'JSON') throw new Error(`expected JSON chunk, got ${jsonChunkType}`);

const jsonStart = 20;
const jsonEnd = 20 + jsonChunkLen;
const jsonText = buf.toString('utf8', jsonStart, jsonEnd).replace(/\0+$/, '');
const gltf = JSON.parse(jsonText);

console.log(`GLB size: ${(buf.length / 1024).toFixed(0)} KB`);
console.log(`Nodes:    ${gltf.nodes?.length ?? 0}`);
console.log(`Meshes:   ${gltf.meshes?.length ?? 0}`);

// Walk the scene → node tree and collect node-mesh pairs with their transforms.
const nodes = gltf.nodes || [];
const meshes = gltf.meshes || [];

// Build a parent → child map so we can compute world transforms by descent.
function multiplyTRS(parentT, childT) {
  return {
    translation: [
      (parentT.translation?.[0] ?? 0) + (childT.translation?.[0] ?? 0),
      (parentT.translation?.[1] ?? 0) + (childT.translation?.[1] ?? 0),
      (parentT.translation?.[2] ?? 0) + (childT.translation?.[2] ?? 0),
    ],
    scale: [
      (parentT.scale?.[0] ?? 1) * (childT.scale?.[0] ?? 1),
      (parentT.scale?.[1] ?? 1) * (childT.scale?.[1] ?? 1),
      (parentT.scale?.[2] ?? 1) * (childT.scale?.[2] ?? 1),
    ],
  };
}

const ROOT = { translation: [0, 0, 0], scale: [1, 1, 1] };
const rows = [];

function walk(nodeIdx, accTransform) {
  const n = nodes[nodeIdx];
  if (!n) return;
  const myT = {
    translation: n.translation ?? [0, 0, 0],
    scale: n.scale ?? [1, 1, 1],
  };
  const world = multiplyTRS(accTransform, myT);
  if (n.mesh !== undefined) {
    const m = meshes[n.mesh];
    rows.push({
      name: n.name || `(unnamed-node-${nodeIdx})`,
      meshName: m?.name || `(unnamed-mesh-${n.mesh})`,
      pos: world.translation.map(v => v.toFixed(0)).join(','),
      scale: world.scale.map(v => v.toFixed(2)).join(','),
    });
  }
  for (const childIdx of n.children || []) {
    walk(childIdx, world);
  }
}

const scene = gltf.scenes?.[gltf.scene ?? 0];
for (const rootIdx of scene?.nodes ?? []) {
  walk(rootIdx, ROOT);
}

console.log('\n=== Slot-machine candidates (name match) ===');
const slotPattern = /slot|machine|cabinet|pokie|reel/i;
const matches = rows.filter(r => slotPattern.test(r.name) || slotPattern.test(r.meshName));
if (matches.length === 0) {
  console.log('  (no name matches — fall through to size/position heuristic)');
} else {
  for (const r of matches) {
    console.log(`  ${r.name.padEnd(35)} mesh=${r.meshName.padEnd(28)} pos=(${r.pos.padEnd(15)}) scale=(${r.scale})`);
  }
}

console.log('\n=== All nodes-with-meshes (sorted by name) ===');
rows.sort((a, b) => a.name.localeCompare(b.name));
for (const r of rows) {
  console.log(`  ${r.name.padEnd(35)} mesh=${r.meshName.padEnd(28)} pos=(${r.pos})`);
}
console.log(`\nTotal: ${rows.length} node-with-mesh entries`);
