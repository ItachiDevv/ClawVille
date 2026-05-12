#!/usr/bin/env node
/**
 * Read a GLB file's JSON chunk directly to get raw POSITION accessor
 * min/max bounds without needing any compression decoder. The bounds
 * are encoded in the glTF spec for every POSITION accessor.
 *
 * Then chase the mesh→node tree to figure out which node each primitive
 * is on, accumulate node transforms, and compute world-space bbox.
 */

import fs from 'node:fs';

const FILES = process.argv.slice(2);
if (FILES.length === 0) FILES.push('apps/web/public/models/sandy-treedome-v2.glb');

function readGlbJson(filePath) {
  const buf = fs.readFileSync(filePath);
  // GLB header: 12 bytes magic + version + length
  // First chunk: 4 byte length + 4 byte type (0x4E4F534A = 'JSON')
  const chunkLen = buf.readUInt32LE(12);
  const chunkType = buf.readUInt32LE(16);
  if (chunkType !== 0x4E4F534A) throw new Error('Not a JSON chunk');
  const jsonStr = buf.subarray(20, 20 + chunkLen).toString('utf8').replace(/\0+$/, '');
  return JSON.parse(jsonStr);
}

// Multiply a 4x4 matrix into a vec3 (treats vec3 as point, adds translation)
function transformPoint(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0]*x + m[4]*y + m[8]*z  + m[12],
    m[1]*x + m[5]*y + m[9]*z  + m[13],
    m[2]*x + m[6]*y + m[10]*z + m[14],
  ];
}

// Compose translation, rotation (quaternion), scale into a 4x4 matrix
function compose(t = [0,0,0], r = [0,0,0,1], s = [1,1,1]) {
  const m = new Array(16).fill(0); m[15] = 1;
  const x = r[0], y = r[1], z = r[2], w = r[3];
  const x2 = x+x, y2 = y+y, z2 = z+z;
  const xx = x*x2, xy = x*y2, xz = x*z2;
  const yy = y*y2, yz = y*z2, zz = z*z2;
  const wx = w*x2, wy = w*y2, wz = w*z2;
  const [sx, sy, sz] = s;
  m[0]  = (1 - (yy + zz)) * sx;
  m[1]  = (xy + wz)       * sx;
  m[2]  = (xz - wy)       * sx;
  m[4]  = (xy - wz)       * sy;
  m[5]  = (1 - (xx + zz)) * sy;
  m[6]  = (yz + wx)       * sy;
  m[8]  = (xz + wy)       * sz;
  m[9]  = (yz - wx)       * sz;
  m[10] = (1 - (xx + yy)) * sz;
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}

// Multiply two 4x4 matrices
function matMul(a, b) {
  const out = new Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k*4 + j] * b[i*4 + k];
      out[i*4 + j] = s;
    }
  }
  return out;
}

function nodeMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  return compose(node.translation, node.rotation, node.scale);
}

for (const filePath of FILES) {
  if (!fs.existsSync(filePath)) {
    console.log(`\n=== ${filePath}: MISSING`);
    continue;
  }
  console.log(`\n=== ${filePath} ===`);
  const gltf = readGlbJson(filePath);
  const accessors = gltf.accessors || [];
  const meshes = gltf.meshes || [];
  const nodes = gltf.nodes || [];

  // Build parent map + accumulate world matrices from scene root nodes
  const parentMap = new Map(); // childIdx → parentIdx
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.children) for (const c of n.children) parentMap.set(c, i);
  }
  const worldMat = new Array(nodes.length);
  function computeWorldMatrix(idx) {
    if (worldMat[idx]) return worldMat[idx];
    const local = nodeMatrix(nodes[idx]);
    const parent = parentMap.get(idx);
    if (parent === undefined) {
      worldMat[idx] = local;
    } else {
      worldMat[idx] = matMul(computeWorldMatrix(parent), local);
    }
    return worldMat[idx];
  }

  // Collect every primitive's world-space bbox
  let sceneMin = [Infinity, Infinity, Infinity];
  let sceneMax = [-Infinity, -Infinity, -Infinity];
  const meshRows = [];
  for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
    const node = nodes[nodeIdx];
    if (node.mesh === undefined) continue;
    const mesh = meshes[node.mesh];
    const m = computeWorldMatrix(nodeIdx);
    for (const prim of mesh.primitives || []) {
      const posAccessor = accessors[prim.attributes?.POSITION];
      if (!posAccessor || !posAccessor.min || !posAccessor.max) continue;
      // Bbox corners → 8 points → world
      const [a, b, c] = posAccessor.min;
      const [d, e, f] = posAccessor.max;
      const corners = [[a,b,c],[a,b,f],[a,e,c],[a,e,f],[d,b,c],[d,b,f],[d,e,c],[d,e,f]];
      let xmin = Infinity, ymin = Infinity, zmin = Infinity;
      let xmax = -Infinity, ymax = -Infinity, zmax = -Infinity;
      for (const cn of corners) {
        const w = transformPoint(m, cn);
        if (w[0] < xmin) xmin = w[0]; if (w[0] > xmax) xmax = w[0];
        if (w[1] < ymin) ymin = w[1]; if (w[1] > ymax) ymax = w[1];
        if (w[2] < zmin) zmin = w[2]; if (w[2] > zmax) zmax = w[2];
      }
      if (xmin < sceneMin[0]) sceneMin[0] = xmin;
      if (ymin < sceneMin[1]) sceneMin[1] = ymin;
      if (zmin < sceneMin[2]) sceneMin[2] = zmin;
      if (xmax > sceneMax[0]) sceneMax[0] = xmax;
      if (ymax > sceneMax[1]) sceneMax[1] = ymax;
      if (zmax > sceneMax[2]) sceneMax[2] = zmax;
      meshRows.push({
        nodeName: node.name || `node[${nodeIdx}]`,
        meshName: mesh.name || `mesh[${node.mesh}]`,
        minY: ymin, maxY: ymax,
        sizeX: xmax - xmin, sizeY: ymax - ymin, sizeZ: zmax - zmin,
        verts: posAccessor.count,
      });
    }
  }

  meshRows.sort((a, b) => a.minY - b.minY);
  console.log(`Mesh count: ${meshRows.length}`);
  console.log(`Scene world bbox: min(${sceneMin[0].toFixed(2)},${sceneMin[1].toFixed(2)},${sceneMin[2].toFixed(2)}) max(${sceneMax[0].toFixed(2)},${sceneMax[1].toFixed(2)},${sceneMax[2].toFixed(2)})`);
  const size = [sceneMax[0]-sceneMin[0], sceneMax[1]-sceneMin[1], sceneMax[2]-sceneMin[2]];
  console.log(`Scene size: ${size[0].toFixed(2)} x ${size[1].toFixed(2)} x ${size[2].toFixed(2)}`);

  const TARGET = 800;
  const MAX_FOOTPRINT = 1000;
  let scale = size[1] === 0 ? 1 : TARGET / size[1];
  const maxXZ = Math.max(size[0], size[2]);
  if (maxXZ * scale > MAX_FOOTPRINT) scale *= MAX_FOOTPRINT / (maxXZ * scale);
  console.log(`Scale: ${scale.toFixed(4)}`);
  console.log(`pivotOffsetY = bbox.min.y * scale = ${sceneMin[1].toFixed(2)} × ${scale.toFixed(4)} = ${(sceneMin[1] * scale).toFixed(2)}`);
  // With yOffset=0, render formula: -2 + 0 + (-pivotOffsetY) + (bbox.min.y * scale)
  // For sceneMin (full bbox) this = -2 + 0 = -2 (= ground). So bbox-min IS at ground.
  // Floating means some VISIBLE mesh sits well above the bbox.min.y after scale.
  console.log(`\nMeshes sorted by minY (lowest first — these touch ground after pivot offset):`);
  for (const r of meshRows.slice(0, Math.min(meshRows.length, 12))) {
    const renderedMinY = -2 - sceneMin[1] * scale + r.minY * scale;
    console.log(`  ${r.meshName.padEnd(38)} | minY=${r.minY.toFixed(2).padStart(8)} (rendered y=${renderedMinY.toFixed(1).padStart(7)}) | sz ${r.sizeX.toFixed(0)}×${r.sizeY.toFixed(0)}×${r.sizeZ.toFixed(0)} | verts=${r.verts}`);
  }

  // Pick the LARGEST mesh by footprint — that's the platform/dome
  const largest = [...meshRows].sort((a,b) => (b.sizeX*b.sizeZ) - (a.sizeX*a.sizeZ))[0];
  if (largest) {
    const platformBottomRendered = -2 - sceneMin[1] * scale + largest.minY * scale;
    console.log(`\nLargest-footprint mesh "${largest.meshName}":`);
    console.log(`  Its rendered bottom (yOffset=0) is at y = ${platformBottomRendered.toFixed(1)}`);
    console.log(`  → To ground IT specifically, yOffset should be ${(-platformBottomRendered).toFixed(1)}`);
  }
}
