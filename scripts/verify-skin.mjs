/**
 * verify-skin.mjs
 * Verifies that the baked hair vertices are correctly positioned in skinning space.
 * The inverse bind matrix for mixamorig:Head tells us where the head bone was at bind time.
 * Hair vertex positions (in world/bind space) should cluster around the head crown.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [, , inputPath] = process.argv;
if (!inputPath) {
  console.error('Usage: bun scripts/verify-skin.mjs <file.glb>');
  process.exit(1);
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const document = await io.read(inputPath);
const root = document.getRoot();
const scene = root.listScenes()[0];

// Get the skin
const skins = root.listSkins();
console.log(`Skins: ${skins.length}`);

for (let si = 0; si < skins.length; si++) {
  const skin = skins[si];
  const joints = skin.listJoints();

  // Get the inverse bind matrix accessor
  const ibmAccessor = skin.getInverseBindMatrices();

  const headIdx = joints.findIndex(j => j.getName() === 'mixamorig:Head');
  console.log(`\nSkin ${si}: ${joints.length} joints, mixamorig:Head at index ${headIdx}`);

  if (ibmAccessor && headIdx >= 0) {
    // Read the inverse bind matrix for the head joint
    const ibm = new Array(16);
    ibmAccessor.getElement(headIdx, ibm);
    console.log('Head inverse bind matrix:');
    for (let r = 0; r < 4; r++) {
      console.log(`  [${ibm.slice(r*4, r*4+4).map(v=>v.toFixed(4)).join(', ')}]`);
    }

    // The bind pose position of the head bone = inverse(IBM) * origin
    // Actually IBM = inverse(global_joint_transform_at_bind_time)
    // So the head bone's world position at bind time can be recovered from col 3 of inverse(IBM)
    // For a pure-rotation+translation matrix, inverse is easy
    // Let M = IBM, then global_joint = M^{-1}
    // Translation of global_joint = -(R^T * t) where R is the 3x3 rotation and t is the 3x1 translation column

    // Extract translation from IBM (last column if column-major... but GLTF is column-major)
    // GLTF matrices are column-major: m[0..3] = col0, m[4..7] = col1, m[8..11] = col2, m[12..15] = col3
    // So translation is at [12, 13, 14]
    const ibm_tx = ibm[12];
    const ibm_ty = ibm[13];
    const ibm_tz = ibm[14];
    console.log(`Head IBM translation: [${ibm_tx.toFixed(4)}, ${ibm_ty.toFixed(4)}, ${ibm_tz.toFixed(4)}]`);

    // The head bone's WORLD position at bind time = -(R^T * [ibm_tx, ibm_ty, ibm_tz])
    // Extract rotation from IBM
    const r00 = ibm[0], r10 = ibm[1], r20 = ibm[2];
    const r01 = ibm[4], r11 = ibm[5], r21 = ibm[6];
    const r02 = ibm[8], r12 = ibm[9], r22 = ibm[10];
    // R^T applied to translation:
    const bindX = -(r00*ibm_tx + r10*ibm_ty + r20*ibm_tz);
    const bindY = -(r01*ibm_tx + r11*ibm_ty + r21*ibm_tz);
    const bindZ = -(r02*ibm_tx + r12*ibm_ty + r22*ibm_tz);
    console.log(`Head bone bind-pose world pos (Y-up): [${bindX.toFixed(4)}, ${bindY.toFixed(4)}, ${bindZ.toFixed(4)}]`);
  }
}

// Check hair mesh vertex positions
const allNodes = [];
function traverse(node) { allNodes.push(node); node.listChildren().forEach(traverse); }
scene.listChildren().forEach(traverse);

for (const hairName of ['Hairmodel', 'Hatmodel']) {
  const node = allNodes.find(n => n.getName() === hairName);
  if (!node) { console.log(`\n${hairName}: not found`); continue; }

  const mesh = node.getMesh();
  if (!mesh) { console.log(`\n${hairName}: no mesh`); continue; }

  // Sample some vertices
  const prim = mesh.listPrimitives()[0];
  const pos = prim.getAttribute('POSITION');
  const joints0 = prim.getAttribute('JOINTS_0');
  const weights0 = prim.getAttribute('WEIGHTS_0');

  const count = pos.getCount();
  let minY = Infinity, maxY = -Infinity;
  const tmpP = [0,0,0];
  for (let i = 0; i < count; i++) {
    pos.getElement(i, tmpP);
    if (tmpP[1] < minY) minY = tmpP[1];
    if (tmpP[1] > maxY) maxY = tmpP[1];
  }

  console.log(`\n${hairName}:`);
  console.log(`  Vertices: ${count}`);
  console.log(`  Y range (GLTF Y-up space): [${minY.toFixed(4)}, ${maxY.toFixed(4)}]`);

  // Check first 3 verts joints/weights
  const tmpJ = [0,0,0,0], tmpW = [0,0,0,0];
  pos.getElement(0, tmpP);
  joints0.getElement(0, tmpJ);
  weights0.getElement(0, tmpW);
  console.log(`  Vert[0]: pos=[${tmpP.map(v=>v.toFixed(4)).join(',')}] joint=${tmpJ[0]} weight=${tmpW[0].toFixed(3)}`);

  const hasSkin = !!node.getSkin();
  console.log(`  Has skin assigned: ${hasSkin}`);
}
