// Shrink a GLB's geometry without touching its textures.
// Usage: node scripts/models/glb-geometry-pack.mjs <in.glb> <out.glb>
// Steps: dedup + prune, reorder for meshopt, quantize float attributes to 16 bits
// (position, normal, texcoord), then EXT_meshopt_compression in QUANTIZE mode (FILTER mode would re-store
// normals at 8 bits: about 1 degree of error, which glb-compare.mjs blocks).
// Already-quantized attributes keep their component type. Check every output
// with glb-compare.mjs before it ships.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, quantize, reorder } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('usage: glb-geometry-pack.mjs <in.glb> <out.glb>'); process.exit(2); }
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(inFile);
await doc.transform(
  dedup(),
  prune(),
  reorder({ encoder: MeshoptEncoder }),
  quantize({ quantizePosition: 16, quantizeNormal: 16, quantizeTexcoord: 16, quantizeColor: 16, quantizeWeight: 16, quantizeGeneric: 16 }),
);
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
await io.write(outFile, doc);
console.log('ok');
