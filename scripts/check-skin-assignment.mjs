/**
 * check-skin-assignment.mjs
 * Determine which skin Body, Eyes, Hairmodel, Hatmodel are assigned to.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [, , inputPath] = process.argv;
if (!inputPath) { process.exit(1); }

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const document = await io.read(inputPath);
const root = document.getRoot();
const scene = root.listScenes()[0];
const skins = root.listSkins();

console.log(`Total skins: ${skins.length}`);
for (let i = 0; i < skins.length; i++) {
  const s = skins[i];
  const ibm = s.getInverseBindMatrices();
  const joints = s.listJoints();
  const headIdx = joints.findIndex(j => j.getName() === 'mixamorig:Head');
  let scale = 1;
  if (ibm && headIdx >= 0) {
    const m = new Array(16);
    ibm.getElement(headIdx, m);
    scale = m[0]; // scale is on diagonal for pure scale+rotation matrices
  }
  console.log(`  Skin ${i}: head IBM scale=${scale.toFixed(4)}`);
}

// Find which skin each named node uses
const allNodes = [];
function traverse(node) { allNodes.push(node); node.listChildren().forEach(traverse); }
scene.listChildren().forEach(traverse);

const targetNames = ['Body', 'Eyes', 'Hairmodel', 'Hatmodel'];
for (const name of targetNames) {
  const node = allNodes.find(n => n.getName() === name);
  if (!node) { console.log(`${name}: not found`); continue; }
  const skin = node.getSkin();
  if (!skin) { console.log(`${name}: no skin`); continue; }
  const skinIdx = skins.indexOf(skin);
  console.log(`${name}: skin index ${skinIdx}`);
}
