/**
 * debug-ibm.mjs
 * Verifies that our IBM math is correct by checking a known body vertex.
 * The GLTF skinning equation: deformed = sum_i(w_i * joint_i_mat * IBM_i * bind_pos)
 * At rest (T-pose): joint_i_mat * IBM_i = identity
 * So: deformed = bind_pos (at rest)
 *
 * But if the "rest pose" baked into the bones differs from the original bind pose,
 * we need to use the actual bone world transforms.
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

const allNodes = [];
function traverse(node) { allNodes.push(node); node.listChildren().forEach(traverse); }
scene.listChildren().forEach(traverse);

// Find Body node
const bodyNode = allNodes.find(n => n.getName() === 'Body');
if (!bodyNode) throw new Error('No Body node');

const skin = bodyNode.getSkin();
const joints = skin.listJoints();
const ibmAccessor = skin.getInverseBindMatrices();

const headIdx = joints.findIndex(j => j.getName() === 'mixamorig:Head');
console.log(`Head joint index: ${headIdx}`);

// Read head IBM (column-major in GLTF)
const headIBMRaw = new Array(16);
ibmAccessor.getElement(headIdx, headIBMRaw);
console.log('Head IBM (column-major as read from accessor):');
console.log('  col0:', headIBMRaw.slice(0,4).map(v=>v.toFixed(4)));
console.log('  col1:', headIBMRaw.slice(4,8).map(v=>v.toFixed(4)));
console.log('  col2:', headIBMRaw.slice(8,12).map(v=>v.toFixed(4)));
console.log('  col3:', headIBMRaw.slice(12,16).map(v=>v.toFixed(4)));

// GLTF column-major: m[col*4 + row] = M[row][col]
// So the standard matrix access is: element[row][col] = raw[col*4 + row]
// Translation = last column = col3 = [row0][col3], [row1][col3], [row2][col3], [row3][col3]
// = raw[12], raw[13], raw[14], raw[15]
console.log(`\nIBM translation (col3): [${headIBMRaw[12].toFixed(4)}, ${headIBMRaw[13].toFixed(4)}, ${headIBMRaw[14].toFixed(4)}]`);

// Get a body vertex with JOINTS_0=[headIdx] and WEIGHTS_0=[1.0]
const bodyMesh = bodyNode.getMesh();
const prim = bodyMesh.listPrimitives()[0];
const posAttr = prim.getAttribute('POSITION');
const joints0Attr = prim.getAttribute('JOINTS_0');
const weights0Attr = prim.getAttribute('WEIGHTS_0');

const tmpP = [0,0,0];
const tmpJ = [0,0,0,0];
const tmpW = [0,0,0,0];

let sampleIdx = -1;
for (let i = 0; i < posAttr.getCount(); i++) {
  joints0Attr.getElement(i, tmpJ);
  weights0Attr.getElement(i, tmpW);
  if (tmpJ[0] === headIdx && tmpW[0] > 0.99) {
    sampleIdx = i;
    break;
  }
}

if (sampleIdx < 0) {
  console.log('No pure-head-weighted body vertex found');
  process.exit(0);
}

posAttr.getElement(sampleIdx, tmpP);
console.log(`\nSample body vertex (bind-space pos, GLTF Y-up): [${tmpP.map(v=>v.toFixed(4)).join(', ')}]`);

// Expected deformed world pos (from Blender: we measured a head vertex at ~(-0.124, -0.028, 1.696))
// In GLTF Y-up: (x, z_blender, -y_blender) — reverse the rotation
// Actually the Blender import rotates by 90° around X: GLTF(x,y,z) → Blender(x,-z,y)
// Inverse: Blender(x,y,z) → GLTF(x,z,-y)
const blender_deformed_x = -0.1242;
const blender_deformed_y = -0.0281;
const blender_deformed_z = 1.6964;
const gltf_expected_x = blender_deformed_x;
const gltf_expected_y = blender_deformed_z;   // Blender Z → GLTF Y
const gltf_expected_z = -blender_deformed_y;  // Blender -Y → GLTF Z
console.log(`\nExpected GLTF world pos: [${gltf_expected_x.toFixed(4)}, ${gltf_expected_y.toFixed(4)}, ${gltf_expected_z.toFixed(4)}]`);

// At rest pose, deformed = bind_pos
console.log(`Bind-space pos: [${tmpP.map(v=>v.toFixed(4)).join(', ')}]`);
console.log(`Match: ${Math.abs(tmpP[0]-gltf_expected_x)<0.05 && Math.abs(tmpP[1]-gltf_expected_y)<0.05 && Math.abs(tmpP[2]-gltf_expected_z)<0.05}`);

// This will tell us if the body's bind-space IS the GLTF world space,
// or if the IBM has been applied to move it to a different space
