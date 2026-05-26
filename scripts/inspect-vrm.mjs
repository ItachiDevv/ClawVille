/**
 * inspect-vrm.mjs
 * Dumps key structural info from a VRM file to understand node hierarchy vs skinning.
 * Usage: bun run scripts/inspect-vrm.mjs <input.vrm>
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import fs from 'fs';

const [, , inputPath] = process.argv;
if (!inputPath) {
  console.error('Usage: bun scripts/inspect-vrm.mjs <input.vrm>');
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

const document = await io.read(inputPath);
const root = document.getRoot();

// Enumerate nodes with their names, parents, meshes, and skin
console.log('\n=== NODE HIERARCHY ===');
function printNode(node, indent = 0) {
  const mesh = node.getMesh();
  const skin = node.getSkin();
  const children = node.listChildren();
  const prefix = '  '.repeat(indent);

  const meshInfo = mesh ? ` [mesh: ${mesh.getName() || '(unnamed)'}]` : '';
  const skinInfo = skin ? ` [skin: ${skin.getName() || '(unnamed)'}]` : '';
  const t = node.getTranslation();
  const s = node.getScale();
  const r = node.getRotation();
  const tStr = `T=[${t.map(v=>v.toFixed(3)).join(',')}]`;
  const sStr = `S=[${s.map(v=>v.toFixed(3)).join(',')}]`;

  console.log(`${prefix}${node.getName()}${meshInfo}${skinInfo} ${tStr} ${sStr}`);

  for (const child of children) {
    printNode(child, indent + 1);
  }
}

const scene = root.listScenes()[0];
for (const node of scene.listChildren()) {
  printNode(node);
}

// List all skins
console.log('\n=== SKINS ===');
for (const skin of root.listSkins()) {
  console.log(`Skin: ${skin.getName()}`);
  const joints = skin.listJoints();
  console.log(`  Joints (${joints.length}): ${joints.map(j => j.getName()).join(', ')}`);
}

// Find hair/hat nodes specifically
console.log('\n=== HAIR/HAT NODES DEEP SEARCH ===');
function findAll(node, results = []) {
  results.push(node);
  for (const child of node.listChildren()) {
    findAll(child, results);
  }
  return results;
}

const allNodes = [];
for (const node of scene.listChildren()) {
  findAll(node, allNodes);
}

for (const node of allNodes) {
  const name = node.getName().toLowerCase();
  if (name.includes('hair') || name.includes('hat') || name.includes('head')) {
    const mesh = node.getMesh();
    const skin = node.getSkin();
    const parent = allNodes.find(n => n.listChildren().includes(node));
    console.log(`\nNode: ${node.getName()}`);
    console.log(`  Parent: ${parent ? parent.getName() : 'scene root'}`);
    console.log(`  Has mesh: ${!!mesh}`);
    console.log(`  Has skin: ${!!skin}`);
    console.log(`  Translation: [${node.getTranslation().map(v=>v.toFixed(4)).join(', ')}]`);
    console.log(`  Scale: [${node.getScale().map(v=>v.toFixed(4)).join(', ')}]`);
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const posAttr = prim.getAttribute('POSITION');
        const jointsAttr = prim.getAttribute('JOINTS_0');
        const weightsAttr = prim.getAttribute('WEIGHTS_0');
        console.log(`  Primitive: POSITION=${posAttr ? posAttr.getCount() + ' verts' : 'none'}, JOINTS_0=${jointsAttr ? 'yes' : 'no'}, WEIGHTS_0=${weightsAttr ? 'yes' : 'no'}`);
      }
    }
  }
}
