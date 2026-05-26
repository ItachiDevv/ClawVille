/**
 * bake-hair-to-skin.mjs
 *
 * Converts Hairmodel and Hatmodel from GLTF node-parented meshes (no JOINTS_0/WEIGHTS_0)
 * to proper skinned meshes weighted 100% to mixamorig:Head.
 *
 * The root cause of the bald-spot bug: these meshes were children of the Head node
 * but had no skin weights. @pixiv/three-vrm renders them at incorrect world positions.
 *
 * Fix:
 * 1. Compute hair vertex positions in GLTF world space (by accumulating parent node transforms)
 * 2. Transform to skin bind-space: bind_pos = head_inverse_bind_matrix * world_pos
 * 3. Add JOINTS_0=[headBoneIdx] and WEIGHTS_0=[1.0] to all primitives
 * 4. Assign the Body's skin (same 30-joint skin Body uses)
 * 5. Clear node transforms and move to scene root
 *
 * Usage: bun run scripts/bake-hair-to-skin.mjs <input.vrm> <output.vrm>
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: bun scripts/bake-hair-to-skin.mjs <input.vrm> <output.vrm>');
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

// --- Helper: enumerate all nodes ---
function findAllNodes(scene) {
  const result = [];
  function traverse(node) { result.push(node); node.listChildren().forEach(traverse); }
  scene.listChildren().forEach(traverse);
  return result;
}

const allNodes = findAllNodes(scene);

// Build parent map
const parentMap = new Map();
for (const node of allNodes) {
  for (const child of node.listChildren()) {
    parentMap.set(child, node);
  }
}

// --- Helper: row-major 4x4 matrix math ---
function makeIdentity() {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}

function makeTRS(t, r, s) {
  // t=[tx,ty,tz], r=[rx,ry,rz,rw] quaternion, s=[sx,sy,sz]
  const [rx, ry, rz, rw] = r;
  const x2 = rx+rx, y2 = ry+ry, z2 = rz+rz;
  const xx = rx*x2, xy = rx*y2, xz = rx*z2;
  const yy = ry*y2, yz = ry*z2, zz = rz*z2;
  const wx = rw*x2, wy = rw*y2, wz = rw*z2;
  const [sx, sy, sz] = s;
  const [tx, ty, tz] = t;
  // Row-major
  return [
    (1-(yy+zz))*sx,  (xy+wz)*sy,  (xz-wy)*sz, tx,
    (xy-wz)*sx, (1-(xx+zz))*sy,  (yz+wx)*sz, ty,
    (xz+wy)*sx,  (yz-wx)*sy, (1-(xx+yy))*sz, tz,
    0, 0, 0, 1,
  ];
}

function mul4x4(a, b) {
  // Row-major multiply: result[r][c] = sum_k a[r][k] * b[k][c]
  const res = new Array(16).fill(0);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 4; k++)
        res[r*4+c] += a[r*4+k] * b[k*4+c];
  return res;
}

function applyMat4Point(m, x, y, z) {
  // Apply row-major 4x4 matrix to point (w=1)
  const w = m[12]*x + m[13]*y + m[14]*z + m[15];
  return [
    (m[0]*x + m[1]*y + m[2]*z + m[3]) / w,
    (m[4]*x + m[5]*y + m[6]*z + m[7]) / w,
    (m[8]*x + m[9]*y + m[10]*z + m[11]) / w,
  ];
}

function invertMat4(m) {
  // General 4x4 matrix inverse
  const inv = new Array(16);
  inv[0] =  m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
  inv[8] =  m[4]*m[9]*m[15]  - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
  inv[12]= -m[4]*m[9]*m[14]  + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];

  inv[1] = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
  inv[5] =  m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15]  + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
  inv[13]=  m[0]*m[9]*m[14]  - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];

  inv[2] =  m[1]*m[6]*m[15]  - m[1]*m[7]*m[14]  - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7]  - m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15]  + m[0]*m[7]*m[14]  + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7]  + m[12]*m[3]*m[6];
  inv[10]=  m[0]*m[5]*m[15]  - m[0]*m[7]*m[13]  - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7]  - m[12]*m[3]*m[5];
  inv[14]= -m[0]*m[5]*m[14]  + m[0]*m[6]*m[13]  + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6]  + m[12]*m[2]*m[5];

  inv[3] = -m[1]*m[6]*m[11]  + m[1]*m[7]*m[10]  + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7]   + m[9]*m[3]*m[6];
  inv[7] =  m[0]*m[6]*m[11]  - m[0]*m[7]*m[10]  - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7]   - m[8]*m[3]*m[6];
  inv[11]= -m[0]*m[5]*m[11]  + m[0]*m[7]*m[9]   + m[4]*m[1]*m[11] - m[4]*m[3]*m[9]  - m[8]*m[1]*m[7]   + m[8]*m[3]*m[5];
  inv[15]=  m[0]*m[5]*m[10]  - m[0]*m[6]*m[9]   - m[4]*m[1]*m[10] + m[4]*m[2]*m[9]  + m[8]*m[1]*m[6]   - m[8]*m[2]*m[5];

  const det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
  if (Math.abs(det) < 1e-16) throw new Error('Matrix is not invertible');
  for (let i = 0; i < 16; i++) inv[i] /= det;
  return inv;
}

// GLTF skin inverse bind matrices are COLUMN-MAJOR.
// Convert from column-major to row-major for our math.
function colMajorToRowMajor(m) {
  return [
    m[0], m[4], m[8],  m[12],
    m[1], m[5], m[9],  m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15],
  ];
}

// --- 1. Find the skin Body uses (the "world-scale" skin) ---
const skins = root.listSkins();
console.log(`Found ${skins.length} skin(s)`);

let bodySkin = null;
for (const node of allNodes) {
  if (node.getName() === 'Body') {
    bodySkin = node.getSkin();
    break;
  }
}
if (!bodySkin) {
  throw new Error('Could not find Body node or its skin');
}

const skin = bodySkin;
const joints = skin.listJoints();

// Get the inverse bind matrix accessor
const ibmAccessor = skin.getInverseBindMatrices();
if (!ibmAccessor) throw new Error('Skin has no inverse bind matrices');

const headJointIndex = joints.findIndex(j => j.getName() === 'mixamorig:Head');
if (headJointIndex === -1) throw new Error('mixamorig:Head not found in skin joints');
console.log(`Using Body's skin. mixamorig:Head is joint index ${headJointIndex}`);

// Read the head IBM (column-major in GLTF, convert to row-major for our math)
const headIBMColMaj = new Array(16);
ibmAccessor.getElement(headJointIndex, headIBMColMaj);
const headIBM = colMajorToRowMajor(headIBMColMaj);
console.log('Head IBM (row-major) translation part: ' +
  `[${headIBM[3].toFixed(4)}, ${headIBM[7].toFixed(4)}, ${headIBM[11].toFixed(4)}]`);

// The head bone's bind-pose world position = inverse(headIBM) * origin
const headBindMat = invertMat4(headIBM); // = global head transform at bind time
const headBindPos = applyMat4Point(headBindMat, 0, 0, 0);
console.log(`Head bone bind-pose world pos (Y-up): [${headBindPos.map(v=>v.toFixed(4)).join(', ')}]`);

// --- 2. Compute each hair node's GLTF world transform ---
// The hair vertices need to go through: world_space -> head_bind_space (via IBM)
// Since GLTF skin equation: final = sum(w * joint_mat * ibm * vert)
// For rest pose (joint_mat = inverse(ibm)):  final = sum(w * vert) = vert (identity)
// But we want the hair to appear at its pre-baked world position in rest pose.
// So: vert_in_bind_space = ibm * world_pos_of_hair_vert

function computeNodeWorldMat(node) {
  // Build chain from scene root down to this node
  const chain = [];
  let cur = node;
  while (cur && !scene.listChildren().includes(cur)) {
    chain.push(cur);
    cur = parentMap.get(cur);
  }
  // chain[0] = node, chain[last] = direct child of scene (or at scene)
  // Apply from outermost to innermost
  let mat = makeIdentity();
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i];
    const t = n.getTranslation();
    const r = n.getRotation();
    const s = n.getScale();
    const nodeMat = makeTRS(t, r, s);
    mat = mul4x4(mat, nodeMat);
  }
  return mat;
}

// --- 3. Process each hair mesh node ---
const hairNodeNames = ['Hairmodel', 'Hatmodel'];

for (const hairNodeName of hairNodeNames) {
  const hairNode = allNodes.find(n => n.getName() === hairNodeName);
  if (!hairNode) {
    console.warn(`WARNING: Node ${hairNodeName} not found, skipping`);
    continue;
  }

  console.log(`\nProcessing ${hairNodeName}...`);
  const mesh = hairNode.getMesh();
  if (!mesh) {
    console.warn(`  No mesh found on ${hairNodeName}, skipping`);
    continue;
  }

  // Compute full world matrix for this hair node
  const worldMat = computeNodeWorldMat(hairNode);
  const hairOriginWorld = applyMat4Point(worldMat, 0, 0, 0);
  console.log(`  Hair origin in GLTF world space: [${hairOriginWorld.map(v=>v.toFixed(4)).join(', ')}]`);

  // Combined transform: headIBM @ worldMat
  // This converts: local_hair_vert -> world -> head_bind_space
  const toBindSpace = mul4x4(headIBM, worldMat);

  // Process each primitive
  const primitives = mesh.listPrimitives();
  console.log(`  Primitives: ${primitives.length}`);

  for (let pi = 0; pi < primitives.length; pi++) {
    const prim = primitives[pi];
    const posAttr = prim.getAttribute('POSITION');
    if (!posAttr) {
      console.log(`    Prim ${pi}: no POSITION, skipping`);
      continue;
    }

    const vertCount = posAttr.getCount();
    console.log(`    Prim ${pi}: ${vertCount} vertices`);

    // Transform vertices from hair-local to head bind-space
    const newPositions = new Float32Array(vertCount * 3);
    const tmp3 = [0, 0, 0];
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < vertCount; i++) {
      posAttr.getElement(i, tmp3);
      const [bx, by, bz] = applyMat4Point(toBindSpace, tmp3[0], tmp3[1], tmp3[2]);
      newPositions[i * 3 + 0] = bx;
      newPositions[i * 3 + 1] = by;
      newPositions[i * 3 + 2] = bz;
      if (by < minY) minY = by;
      if (by > maxY) maxY = by;
    }
    console.log(`    Prim ${pi}: bind-space Y range [${minY.toFixed(4)}, ${maxY.toFixed(4)}]`);

    // Replace position accessor
    const newPosAccessor = document.createAccessor()
      .setType('VEC3')
      .setArray(newPositions)
      .setBuffer(root.listBuffers()[0]);
    prim.setAttribute('POSITION', newPosAccessor);

    // Transform normals: for normals, apply inverse-transpose of rotation part
    // Since the IBM may have scale, normals need inverse-transpose
    // For unit normals, just apply the 3x3 rotation part of toBindSpace
    const normalAttr = prim.getAttribute('NORMAL');
    if (normalAttr) {
      // Extract 3x3 inverse-transpose for normals
      // For a matrix M, normals transform by inverse-transpose of M
      // Since we're converting to bind-space and IBM contains scale,
      // we need to be careful. A simple approximation: re-normalize after transform.
      const newNormals = new Float32Array(vertCount * 3);
      const tmpN = [0, 0, 0];
      // Use 3x3 part of toBindSpace (no translation for normals, no perspective divide)
      for (let i = 0; i < vertCount; i++) {
        normalAttr.getElement(i, tmpN);
        const [nx, ny, nz] = tmpN;
        // Apply 3x3 part of toBindSpace (row-major)
        let bnx = toBindSpace[0]*nx + toBindSpace[1]*ny + toBindSpace[2]*nz;
        let bny = toBindSpace[4]*nx + toBindSpace[5]*ny + toBindSpace[6]*nz;
        let bnz = toBindSpace[8]*nx + toBindSpace[9]*ny + toBindSpace[10]*nz;
        // Normalize
        const len = Math.sqrt(bnx*bnx + bny*bny + bnz*bnz);
        if (len > 1e-6) { bnx/=len; bny/=len; bnz/=len; }
        newNormals[i*3+0] = bnx;
        newNormals[i*3+1] = bny;
        newNormals[i*3+2] = bnz;
      }
      const newNormAccessor = document.createAccessor()
        .setType('VEC3')
        .setArray(newNormals)
        .setBuffer(root.listBuffers()[0]);
      prim.setAttribute('NORMAL', newNormAccessor);
    }

    // Add JOINTS_0: all vertices → head joint
    const jointsData = new Uint8Array(vertCount * 4);
    for (let i = 0; i < vertCount; i++) {
      jointsData[i * 4 + 0] = headJointIndex;
      // [1], [2], [3] stay 0
    }
    const jointsAccessor = document.createAccessor()
      .setType('VEC4')
      .setArray(jointsData)
      .setBuffer(root.listBuffers()[0]);
    prim.setAttribute('JOINTS_0', jointsAccessor);

    // Add WEIGHTS_0: weight 1.0 to head joint
    const weightsData = new Float32Array(vertCount * 4);
    for (let i = 0; i < vertCount; i++) {
      weightsData[i * 4 + 0] = 1.0;
    }
    const weightsAccessor = document.createAccessor()
      .setType('VEC4')
      .setArray(weightsData)
      .setBuffer(root.listBuffers()[0]);
    prim.setAttribute('WEIGHTS_0', weightsAccessor);
  }

  // Assign Body's skin to the hair node
  hairNode.setSkin(skin);

  // Clear the hair node's local transform (baked into vertices)
  hairNode.setTranslation([0, 0, 0]);
  hairNode.setRotation([0, 0, 0, 1]);
  hairNode.setScale([1, 1, 1]);

  // Move to scene root (detach from Head node)
  const currentParent = hairNode.getParentNode();
  if (currentParent) {
    currentParent.removeChild(hairNode);
    console.log(`  Detached from parent: ${currentParent.getName()}`);
  }
  scene.addChild(hairNode);

  console.log(`  Done: ${hairNodeName} skinned to joint ${headJointIndex} (mixamorig:Head), at scene root`);
}

// --- 4. Write output (plain GLB, no meshopt) ---
const usedExtensions = root.listExtensionsUsed();
for (const ext of usedExtensions) {
  if (ext.extensionName === 'EXT_meshopt_compression') {
    ext.dispose();
  }
}

console.log(`\nWriting: ${outputPath}`);
await io.write(outputPath, document);

const fs = await import('fs');
const inSize = fs.statSync(inputPath).size;
const outSize = fs.statSync(outputPath).size;
console.log(`Done. ${(inSize / 1024).toFixed(1)}KB → ${(outSize / 1024).toFixed(1)}KB`);
console.log('\nSummary:');
console.log('  Hairmodel: node-parented → properly skinned to mixamorig:Head');
console.log('  Hatmodel: node-parented → properly skinned to mixamorig:Head');
console.log('  Vertex positions: transformed to head bind-space (IBM applied)');
console.log('  Both nodes moved to scene root with identity transform');
