/**
 * decompress-vrm.mjs
 * Decompresses a meshopt-compressed VRM into a plain GLB Blender can import.
 * Usage: bun run scripts/decompress-vrm.mjs <input.vrm> <output.glb>
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { flatten } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [, , inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  console.error('Usage: bun scripts/decompress-vrm.mjs <input.vrm> <output.glb>');
  process.exit(1);
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;

// Register ALL_EXTENSIONS so we can read the VRM (ignoring unknown VRM ext gracefully)
// Also provide encoder so write doesn't throw — but we'll strip the ext before write
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });

console.log(`Reading: ${inputPath}`);
const document = await io.read(inputPath);

console.log('Stripping EXT_meshopt_compression from output...');
// Remove the meshopt compression extension so output is plain
const root = document.getRoot();
const usedExtensions = root.listExtensionsUsed();
for (const ext of usedExtensions) {
  if (ext.extensionName === 'EXT_meshopt_compression') {
    console.log('  Disposing EXT_meshopt_compression');
    ext.dispose();
  }
}

// Flatten hierarchy to ease Blender import
// await document.transform(flatten());

console.log(`Writing decompressed GLB: ${outputPath}`);
// Write with encoder available but extension stripped — encoder won't be invoked
await io.write(outputPath, document);

const fs = await import('fs');
const inSize = fs.statSync(inputPath).size;
const outSize = fs.statSync(outputPath).size;
console.log(`Done. ${(inSize / 1024).toFixed(1)}KB → ${(outSize / 1024).toFixed(1)}KB`);
