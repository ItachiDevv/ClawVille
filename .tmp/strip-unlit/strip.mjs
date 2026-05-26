import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsUnlit, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const IN_PATH = 'C:/Users/newma/Documents/Crypto/ClawVille/apps/web/public/models/casino/casino-interior.glb';
const OUT_PATH = IN_PATH;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const doc = await io.read(IN_PATH);
const root = doc.getRoot();

console.log('Materials before:', root.listMaterials().length);
console.log('Extensions before:', doc.getRoot().listExtensionsUsed().map(e => e.extensionName));

// Detach the KHR_materials_unlit extension from every material that uses it
let stripped = 0;
for (const mat of root.listMaterials()) {
  const unlit = mat.getExtension('KHR_materials_unlit');
  if (unlit) {
    mat.setExtension('KHR_materials_unlit', null);
    stripped++;
  }
}
console.log(`Stripped KHR_materials_unlit from ${stripped} materials`);

// Now find + dispose the doc-level extension object
const unlitExt = doc.getRoot().listExtensionsUsed().find(e => e.extensionName === 'KHR_materials_unlit');
if (unlitExt) {
  unlitExt.dispose();
  console.log('Disposed doc-level KHR_materials_unlit extension');
}

// Bump roughness on every material so the now-PBR materials feel less plasticky
for (const mat of root.listMaterials()) {
  mat.setRoughnessFactor(0.85);
  mat.setMetallicFactor(0);
}

console.log('Extensions after:', doc.getRoot().listExtensionsUsed().map(e => e.extensionName));

await io.write(OUT_PATH, doc);
console.log('Wrote', OUT_PATH);
