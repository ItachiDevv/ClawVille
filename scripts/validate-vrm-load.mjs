/**
 * validate-vrm-load.mjs
 *
 * Node-side smoke test for Milady VRMs. Loads each file with the same
 * GLTFLoader + VRMLoaderPlugin + MToon plugin stack used by the web app and
 * verifies hair nodes are skinned after baking.
 *
 * Usage:
 *   bun scripts/validate-vrm-load.mjs apps/web/public/avatars/milady-official-1.vrm
 *   bun scripts/validate-vrm-load.mjs .tmp/milady-vrm-bake/*.vrm
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { MeshoptDecoder } from 'meshoptimizer';

const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { GLTFLoader } = await import(pathToFileURL(webRequire.resolve('three/addons/loaders/GLTFLoader.js')).href);
const { VRMLoaderPlugin } = await import(pathToFileURL(webRequire.resolve('@pixiv/three-vrm')).href);
const { MToonMaterialLoaderPlugin } = await import(
  pathToFileURL(webRequire.resolve('@pixiv/three-vrm-materials-mtoon')).href
);

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('Usage: bun scripts/validate-vrm-load.mjs <file.vrm> [...file.vrm]');
  process.exit(1);
}

await MeshoptDecoder.ready;

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
loader.register((parser) => new VRMLoaderPlugin(parser, {
  mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser),
}));

let failed = false;

for (const path of paths) {
  try {
    const bytes = readFileSync(path);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await loader.parseAsync(buffer, '');
    const vrm = gltf.userData?.vrm;
    if (!vrm) throw new Error('No VRM data found after parse');

    const report = {
      hairNodes: 0,
      unskinnedHairNodes: [],
      mtoonMaterials: 0,
      skinnedMeshes: 0,
    };

    vrm.scene.traverse((obj) => {
      if (obj.name === 'Hairmodel' || obj.name === 'Hatmodel' || obj.name === 'Sketchfab_model') {
        report.hairNodes += 1;
        let hasSkinnedMesh = obj.isSkinnedMesh;
        obj.traverse((child) => {
          if (child.isSkinnedMesh) hasSkinnedMesh = true;
        });
        if (!hasSkinnedMesh) report.unskinnedHairNodes.push(obj.name);
      }
      if (obj.isSkinnedMesh) report.skinnedMeshes += 1;
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const mat of mats) {
        if (mat?.isMToonMaterial) report.mtoonMaterials += 1;
      }
    });

    if (report.unskinnedHairNodes.length > 0) {
      throw new Error(`Unskinned hair nodes: ${report.unskinnedHairNodes.join(', ')}`);
    }

    console.log(
      `PASS ${path} hair=${report.hairNodes} skinnedMeshes=${report.skinnedMeshes} mtoon=${report.mtoonMaterials}`,
    );
  } catch (err) {
    failed = true;
    console.error(`FAIL ${path}`);
    console.error(err instanceof Error ? err.message : err);
  }
}

if (failed) process.exit(1);
