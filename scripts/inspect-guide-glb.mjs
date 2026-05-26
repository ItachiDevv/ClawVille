#!/usr/bin/env bun
// Deeper GLB inspection: per-mesh bbox + material state to tell whether
// "cloth" meshes actually render as visible geometry or are degenerate/hidden.

import { NodeIO } from '@gltf-transform/core';

const io = new NodeIO();
const doc = await io.read('apps/web/public/models/guide.glb');
const root = doc.getRoot();

const meshes = root.listMeshes();
const mats = root.listMaterials();

function bboxFromMesh(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    if (!pos) continue;
    const arr = pos.getArray();
    if (!arr) continue;
    for (let i = 0; i < arr.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = arr[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

console.log('--- PER-MESH BBOX + MATERIAL ---');
for (const m of meshes) {
  const bb = bboxFromMesh(m);
  const sizeStr = bb.size.map((v) => v.toFixed(2)).join('×');
  const minStr = bb.min.map((v) => v.toFixed(2)).join(',');
  const prims = m.listPrimitives();
  const matInfo = prims.map((p) => {
    const mat = p.getMaterial();
    if (!mat) return '(no mat)';
    return `${mat.getName() || '(unnamed)'} alpha=${mat.getAlphaMode()} opacity=${mat.getAlpha().toFixed(2)}`;
  }).join(' | ');
  console.log(`  ${m.getName() || '(unnamed)'}`);
  console.log(`    size=${sizeStr}  min=[${minStr}]`);
  console.log(`    mat: ${matInfo}`);
}

console.log('\n--- MATERIALS ---');
for (const m of mats) {
  const tex = m.getBaseColorTexture();
  console.log(`  ${m.getName() || '(unnamed)'}`);
  console.log(`    alphaMode=${m.getAlphaMode()}  opacity=${m.getAlpha().toFixed(2)}  doubleSided=${m.getDoubleSided()}`);
  console.log(`    baseColorFactor=[${m.getBaseColorFactor().map((v) => v.toFixed(2))}]`);
  console.log(`    baseColorTexture=${tex ? tex.getName() || '(has)' : '(none)'}`);
}

// Root scene total bbox (approximate — node transforms not fully applied, but GLB is flat)
const allMin = [Infinity, Infinity, Infinity];
const allMax = [-Infinity, -Infinity, -Infinity];
for (const m of meshes) {
  const bb = bboxFromMesh(m);
  for (let k = 0; k < 3; k++) {
    if (bb.min[k] < allMin[k]) allMin[k] = bb.min[k];
    if (bb.max[k] > allMax[k]) allMax[k] = bb.max[k];
  }
}
console.log('\n--- OVERALL BBOX (union of all meshes, local space) ---');
console.log(`  min=[${allMin.map((v) => v.toFixed(2))}]`);
console.log(`  max=[${allMax.map((v) => v.toFixed(2))}]`);
console.log(`  size=[${allMax.map((v, i) => (v - allMin[i]).toFixed(2))}]`);
