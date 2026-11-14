// Replace one texture image in a GLB, keeping geometry, materials and samplers.
// Usage: node scripts/models/glb-set-texture.mjs <in.glb> <out.glb> <texture-index> <image.ktx2|.png|.jpg|.webp>
// Texture indexes are listed by glb-breakdown.mjs (in file order). Check every
// output with glb-compare.mjs before it ships.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const [inFile, outFile, index, image] = process.argv.slice(2);
if (!inFile || !outFile || index === undefined || !image) { console.error('usage: glb-set-texture.mjs <in.glb> <out.glb> <texture-index> <image>'); process.exit(2); }
const MIME = { '.ktx2': 'image/ktx2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const mime = MIME[extname(image).toLowerCase()];
if (!mime) { console.error(`unknown image type: ${image}`); process.exit(2); }
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(inFile);
const tex = doc.getRoot().listTextures()[Number(index)];
if (!tex) { console.error(`no texture ${index}`); process.exit(2); }
if (mime === 'image/ktx2') doc.createExtension(KHRTextureBasisu).setRequired(true);
tex.setImage(new Uint8Array(readFileSync(image))).setMimeType(mime);
await io.write(outFile, doc);
console.log(`texture ${index} (${tex.getName() || 'unnamed'}) <- ${image}`);
