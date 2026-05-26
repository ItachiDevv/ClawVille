import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import fs from 'node:fs';

const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const doc = await io.read('apps/web/public/models/hermes-mesh/female-meshy.glb');
const textures = doc.getRoot().listTextures();
console.log(`found ${textures.length} textures`);

for (let i = 0; i < textures.length; i++) {
  const tex = textures[i];
  const img = tex.getImage();
  const mime = tex.getMimeType();
  const ext = mime === 'image/webp' ? 'webp' : mime === 'image/jpeg' ? 'jpg' : 'png';
  const slot = (tex.getName() || `tex${i}`).replace(/[^\w-]/g, '_');
  const path = `.tmp/hermes-textures/female-MESHY-tex-${i}-${slot}.${ext}`;
  fs.writeFileSync(path, img);
  console.log(`  [${i}] ${path}  ${img.length} bytes  ${mime}  name='${tex.getName()}'`);
}
