#!/usr/bin/env node
/**
 * Inspect each broken building GLB to find the "blue dome" hemisphere mesh.
 * Lists every mesh: name, material name, material color, vertex count, bbox,
 * and whether the geometry is sphere-like (XZ aspect ~1, low height/width).
 */

import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { MeshoptDecoder } from 'meshoptimizer';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const FILES = [
  'apps/web/public/models/krusty-krab.glb',
  'apps/web/public/models/chum-bucket.glb',
  'apps/web/public/models/patricks-rock.glb',
  'apps/web/public/models/sandy-treedome-v2.glb',
  'apps/web/public/models/pineapple-house.glb', // reference (this one looks right)
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
});

for (const filePath of FILES) {
  if (!fs.existsSync(filePath)) {
    console.log(`\n=== ${filePath} ===\nMISSING`);
    continue;
  }
  console.log(`\n=== ${filePath} (${(fs.statSync(filePath).size / 1024).toFixed(0)} KB) ===`);
  try {
    const doc = await io.read(filePath);
    const root = doc.getRoot();
    const meshes = root.listMeshes();
    console.log(`Meshes: ${meshes.length}`);
    let row = 0;
    for (const mesh of meshes) {
      for (const prim of mesh.listPrimitives()) {
        const posAttr = prim.getAttribute('POSITION');
        const indices = prim.getIndices();
        const mat = prim.getMaterial();
        const verts = posAttr?.getCount() ?? 0;
        const triCount = (indices?.getCount() ?? verts) / 3;
        // Compute local bbox
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        if (posAttr) {
          const arr = posAttr.getArray();
          for (let i = 0; i < arr.length; i += 3) {
            if (arr[i] < minX) minX = arr[i];
            if (arr[i+1] < minY) minY = arr[i+1];
            if (arr[i+2] < minZ) minZ = arr[i+2];
            if (arr[i] > maxX) maxX = arr[i];
            if (arr[i+1] > maxY) maxY = arr[i+1];
            if (arr[i+2] > maxZ) maxZ = arr[i+2];
          }
        }
        const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
        const maxXZ = Math.max(sx, sz);
        const minXZ = Math.min(sx, sz);
        const aspectXZ = maxXZ > 0 ? minXZ / maxXZ : 0;
        const heightRatio = maxXZ > 0 ? sy / maxXZ : 0;
        const isDomeLike = aspectXZ > 0.7 && heightRatio > 0.2 && heightRatio < 1.1 && verts < 5000 && maxXZ > 50;
        const matName = mat?.getName() ?? '<no-mat>';
        const matColor = mat?.getBaseColorFactor()?.slice(0, 3).map(c => Math.round(c * 255)).join(',') ?? '?';
        const hasTexture = !!mat?.getBaseColorTexture();
        row++;
        console.log(
          `  [${String(row).padStart(2)}] ${mesh.getName()?.slice(0,28).padEnd(28)} | ` +
          `verts=${String(verts).padStart(6)} tris=${String(Math.round(triCount)).padStart(6)} | ` +
          `bbox ${sx.toFixed(0).padStart(5)} x ${sy.toFixed(0).padStart(5)} x ${sz.toFixed(0).padStart(5)} | ` +
          `aspectXZ=${aspectXZ.toFixed(2)} hRatio=${heightRatio.toFixed(2)}${isDomeLike ? ' DOME' : ''} | ` +
          `mat="${matName.slice(0,20)}" color=(${matColor}) tex=${hasTexture}`
        );
      }
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }
}
