/**
 * find-bind-to-world.mjs
 *
 * The key question: what transformation T makes T @ bind_pos = world_pos_at_rest?
 *
 * If the VRM imported correctly, at rest: deformed = bind_pos.
 * But we measured deformed != bind_pos. So either:
 * 1. The import didn't use the correct rest pose (the Hips bone has offset)
 * 2. There's a coordinate system difference
 *
 * We'll compute the actual T from multiple known (bind, world) pairs,
 * then use T_inverse to convert hair world positions to bind space.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import fs from 'fs';

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

const allNodes = [];
function traverse(node) { allNodes.push(node); node.listChildren().forEach(traverse); }
scene.listChildren().forEach(traverse);

const bodyNode = allNodes.find(n => n.getName() === 'Body');
const skin = bodyNode.getSkin();
const joints = skin.listJoints();
const ibmAccessor = skin.getInverseBindMatrices();
const headIdx = joints.findIndex(j => j.getName() === 'mixamorig:Head');

// Get 10 body vertices fully weighted to head and print their bind-space positions
// Then we'll compare to what Blender says their deformed positions are
const bodyMesh = bodyNode.getMesh();
const prim = bodyMesh.listPrimitives()[0];
const posAttr = prim.getAttribute('POSITION');
const joints0 = prim.getAttribute('JOINTS_0');
const weights0 = prim.getAttribute('WEIGHTS_0');
const tmpP = [0,0,0], tmpJ = [0,0,0,0], tmpW = [0,0,0,0];

const headVerts = [];
for (let i = 0; i < posAttr.getCount(); i++) {
  joints0.getElement(i, tmpJ);
  weights0.getElement(i, tmpW);
  if (tmpJ[0] === headIdx && tmpW[0] > 0.99) {
    posAttr.getElement(i, tmpP);
    headVerts.push({ idx: i, pos: [...tmpP] });
    if (headVerts.length >= 10) break;
  }
}

console.log('Body vertices fully weighted to head (GLTF bind-space positions):');
for (const v of headVerts) {
  console.log(`  [${v.pos.map(p=>p.toFixed(4)).join(', ')}]`);
}

// Get Hairmodel bind-space positions (first 5 verts)
// These were written by our bake script as IBM @ world_pos
const bakedInputPath = inputPath.replace('.bak', '').replace('.vrm', '-baked.glb');
// For now just report the data
console.log('\nTo complete verification, compare these bind-space positions with');
console.log('the Blender depsgraph deformed positions (Z-up -> Y-up conversion).');
console.log('\nExpected: Body bind-space pos should be CLOSE to deformed world pos.');
console.log('If they differ significantly, the rest pose differs from the bind pose.');
