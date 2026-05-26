import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import fs from 'node:fs';

const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

// Use the decompressed copy (meshopt already decoded), avoids decoder issues.
const doc = await io.read('.tmp/hermes-textures/female-raw-copy.glb');
const tex = doc.getRoot().listTextures()[0];
const img = tex.getImage();
const mime = tex.getMimeType();
const ext = mime === 'image/webp' ? 'webp' : 'png';
const path = `.tmp/hermes-textures/female-base-color.${ext}`;
fs.writeFileSync(path, img);
console.log('wrote', path, img.length, 'bytes', mime);
