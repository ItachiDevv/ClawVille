import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { dedup, prune, draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const doc = await io.read('apps/web/public/models/casino/casino-interior.glb');
const root = doc.getRoot();

// Find + detach KHR_materials_unlit extension from every material
let stripped = 0;
for (const mat of root.listMaterials()) {
  const unlit = mat.getExtension('KHR_materials_unlit');
  if (unlit) {
    mat.setExtension('KHR_materials_unlit', null);
    stripped++;
  }
}
console.log(`Stripped KHR_materials_unlit from ${stripped} materials`);

// Disable the extension at doc-level
const unlitExt = doc.createExtension(KHRMaterialsUnlit);
unlitExt.dispose();

await doc.transform(prune(), dedup());
// Keep Draco compression
const dracoExt = doc.createExtension((await import('@gltf-transform/extensions')).KHRDracoMeshCompression);
dracoExt.setRequired(true);

await io.write('apps/web/public/models/casino/casino-interior.glb', doc);
console.log('Wrote stripped GLB');
