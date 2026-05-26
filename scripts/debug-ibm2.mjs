/**
 * debug-ibm2.mjs
 * Verify: IBM @ bind_pos should return "something" related to world pos
 * And: IBM_inverse @ bind_pos should give world pos at rest
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

const bodyNode = allNodes.find(n => n.getName() === 'Body');
const skin = bodyNode.getSkin();
const joints = skin.listJoints();
const ibmAccessor = skin.getInverseBindMatrices();
const headIdx = joints.findIndex(j => j.getName() === 'mixamorig:Head');

// Read head IBM (GLTF column-major)
const headIBMColMaj = new Array(16);
ibmAccessor.getElement(headIdx, headIBMColMaj);

// GLTF column-major → apply as: result[i] = sum_j M[i][j] * v[j]
// where M[i][j] = headIBMColMaj[j*4 + i]  (column-major: col j, row i = index j*4+i)
function applyColMajMat4(m, x, y, z) {
  // M[row][col] = m[col*4 + row]
  // output[row] = sum_col M[row][col] * v[col]
  const w = m[3]*x + m[7]*y + m[11]*z + m[15];
  return [
    (m[0]*x + m[4]*y + m[8]*z + m[12]) / w,
    (m[1]*x + m[5]*y + m[9]*z + m[13]) / w,
    (m[2]*x + m[6]*y + m[10]*z + m[14]) / w,
  ];
}

// The IBM's INVERSE (= joint world transform at bind) applied to bind_pos should give world_pos
function invertColMajMat4(m) {
  // Convert to row-major first
  const rm = [
    m[0], m[4], m[8],  m[12],
    m[1], m[5], m[9],  m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15],
  ];
  // Compute inverse
  const inv = new Array(16);
  inv[0] =  rm[5]*rm[10]*rm[15] - rm[5]*rm[11]*rm[14] - rm[9]*rm[6]*rm[15] + rm[9]*rm[7]*rm[14] + rm[13]*rm[6]*rm[11] - rm[13]*rm[7]*rm[10];
  inv[4] = -rm[4]*rm[10]*rm[15] + rm[4]*rm[11]*rm[14] + rm[8]*rm[6]*rm[15] - rm[8]*rm[7]*rm[14] - rm[12]*rm[6]*rm[11] + rm[12]*rm[7]*rm[10];
  inv[8] =  rm[4]*rm[9]*rm[15]  - rm[4]*rm[11]*rm[13] - rm[8]*rm[5]*rm[15] + rm[8]*rm[7]*rm[13] + rm[12]*rm[5]*rm[11] - rm[12]*rm[7]*rm[9];
  inv[12]= -rm[4]*rm[9]*rm[14]  + rm[4]*rm[10]*rm[13] + rm[8]*rm[5]*rm[14] - rm[8]*rm[6]*rm[13] - rm[12]*rm[5]*rm[10] + rm[12]*rm[6]*rm[9];

  inv[1] = -rm[1]*rm[10]*rm[15] + rm[1]*rm[11]*rm[14] + rm[9]*rm[2]*rm[15] - rm[9]*rm[3]*rm[14] - rm[13]*rm[2]*rm[11] + rm[13]*rm[3]*rm[10];
  inv[5] =  rm[0]*rm[10]*rm[15] - rm[0]*rm[11]*rm[14] - rm[8]*rm[2]*rm[15] + rm[8]*rm[3]*rm[14] + rm[12]*rm[2]*rm[11] - rm[12]*rm[3]*rm[10];
  inv[9] = -rm[0]*rm[9]*rm[15]  + rm[0]*rm[11]*rm[13] + rm[8]*rm[1]*rm[15] - rm[8]*rm[3]*rm[13] - rm[12]*rm[1]*rm[11] + rm[12]*rm[3]*rm[9];
  inv[13]=  rm[0]*rm[9]*rm[14]  - rm[0]*rm[10]*rm[13] - rm[8]*rm[1]*rm[14] + rm[8]*rm[2]*rm[13] + rm[12]*rm[1]*rm[10] - rm[12]*rm[2]*rm[9];

  inv[2] =  rm[1]*rm[6]*rm[15]  - rm[1]*rm[7]*rm[14]  - rm[5]*rm[2]*rm[15] + rm[5]*rm[3]*rm[14] + rm[13]*rm[2]*rm[7]  - rm[13]*rm[3]*rm[6];
  inv[6] = -rm[0]*rm[6]*rm[15]  + rm[0]*rm[7]*rm[14]  + rm[4]*rm[2]*rm[15] - rm[4]*rm[3]*rm[14] - rm[12]*rm[2]*rm[7]  + rm[12]*rm[3]*rm[6];
  inv[10]=  rm[0]*rm[5]*rm[15]  - rm[0]*rm[7]*rm[13]  - rm[4]*rm[1]*rm[15] + rm[4]*rm[3]*rm[13] + rm[12]*rm[1]*rm[7]  - rm[12]*rm[3]*rm[5];
  inv[14]= -rm[0]*rm[5]*rm[14]  + rm[0]*rm[6]*rm[13]  + rm[4]*rm[1]*rm[14] - rm[4]*rm[2]*rm[13] - rm[12]*rm[1]*rm[6]  + rm[12]*rm[2]*rm[5];

  inv[3] = -rm[1]*rm[6]*rm[11]  + rm[1]*rm[7]*rm[10]  + rm[5]*rm[2]*rm[11] - rm[5]*rm[3]*rm[10] - rm[9]*rm[2]*rm[7]   + rm[9]*rm[3]*rm[6];
  inv[7] =  rm[0]*rm[6]*rm[11]  - rm[0]*rm[7]*rm[10]  - rm[4]*rm[2]*rm[11] + rm[4]*rm[3]*rm[10] + rm[8]*rm[2]*rm[7]   - rm[8]*rm[3]*rm[6];
  inv[11]= -rm[0]*rm[5]*rm[11]  + rm[0]*rm[7]*rm[9]   + rm[4]*rm[1]*rm[11] - rm[4]*rm[3]*rm[9]  - rm[8]*rm[1]*rm[7]   + rm[8]*rm[3]*rm[5];
  inv[15]=  rm[0]*rm[5]*rm[10]  - rm[0]*rm[6]*rm[9]   - rm[4]*rm[1]*rm[10] + rm[4]*rm[2]*rm[9]  + rm[8]*rm[1]*rm[6]   - rm[8]*rm[2]*rm[5];

  const det = rm[0]*inv[0] + rm[1]*inv[4] + rm[2]*inv[8] + rm[3]*inv[12];
  for (let i = 0; i < 16; i++) inv[i] /= det;

  // Convert result back to column-major
  return [
    inv[0], inv[4], inv[8],  inv[12],
    inv[1], inv[5], inv[9],  inv[13],
    inv[2], inv[6], inv[10], inv[14],
    inv[3], inv[7], inv[11], inv[15],
  ];
}

// Get sample body vertex
const bodyMesh = bodyNode.getMesh();
const prim = bodyMesh.listPrimitives()[0];
const posAttr = prim.getAttribute('POSITION');
const joints0 = prim.getAttribute('JOINTS_0');
const weights0 = prim.getAttribute('WEIGHTS_0');
const tmpP = [0,0,0], tmpJ = [0,0,0,0], tmpW = [0,0,0,0];

for (let i = 0; i < posAttr.getCount(); i++) {
  joints0.getElement(i, tmpJ);
  weights0.getElement(i, tmpW);
  if (tmpJ[0] === headIdx && tmpW[0] > 0.99) {
    posAttr.getElement(i, tmpP);
    break;
  }
}

console.log(`Sample body vertex bind-space (GLTF): [${tmpP.map(v=>v.toFixed(4)).join(', ')}]`);

// Apply IBM inverse to get world pos at bind time
const ibmInv = invertColMajMat4(headIBMColMaj);
const [wx, wy, wz] = applyColMajMat4(ibmInv, tmpP[0], tmpP[1], tmpP[2]);
console.log(`IBM_inverse @ bind_pos = world_at_bind: [${wx.toFixed(4)}, ${wy.toFixed(4)}, ${wz.toFixed(4)}]`);
console.log(`  (GLTF Y-up, so Y≈1.7 would be correct for head area)`);

// Apply IBM to world pos → should get back bind_pos
const [bx, by, bz] = applyColMajMat4(headIBMColMaj, wx, wy, wz);
console.log(`IBM @ world = back_to_bind: [${bx.toFixed(4)}, ${by.toFixed(4)}, ${bz.toFixed(4)}]`);
console.log(`Round-trip match: ${Math.abs(bx-tmpP[0])<0.001 && Math.abs(by-tmpP[1])<0.001 && Math.abs(bz-tmpP[2])<0.001}`);

// What does IBM @ (hairmodel_origin) give?
const hairOrigin = [-0.0003, 0.7695, 0.1013]; // GLTF Y-up world pos
const [hbx, hby, hbz] = applyColMajMat4(headIBMColMaj, ...hairOrigin);
console.log(`\nHairmodel origin [${hairOrigin}] → IBM-applied: [${hbx.toFixed(4)}, ${hby.toFixed(4)}, ${hbz.toFixed(4)}]`);

// And IBM_inverse @ (hairmodel_IBM_bind) should give back world pos
const [hwx, hwy, hwz] = applyColMajMat4(ibmInv, hbx, hby, hbz);
console.log(`Round-trip: [${hwx.toFixed(4)}, ${hwy.toFixed(4)}, ${hwz.toFixed(4)}] (should match ${hairOrigin.map(v=>v.toFixed(4))})`);
