#!/usr/bin/env node
// components-glb.mjs — split a GLB primitive into connected components (union-find
// over triangle indices, welded by quantised position so Meshy's split UV seams
// do not fragment one solid into many). Prints a bbox/triangle report per part.
//
// Meshy text-to-3d returns ONE merged primitive, so "delete the ground slabs"
// cannot be done by node name. Component analysis is the only handle.
//
// Usage: node scripts/trading-floor/components-glb.mjs <file.glb> [weldEpsilon]

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3d';

const file = process.argv[2];
const EPS = Number(process.argv[3] ?? 1e-4);
if (!file) throw new Error('usage: components-glb.mjs <file.glb> [weldEpsilon]');

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const doc = await io.read(file);
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];

const pos = prim.getAttribute('POSITION');
const idxAcc = prim.getIndices();
const triCount = idxAcc ? idxAcc.getCount() / 3 : pos.getCount() / 3;
const getIdx = (i) => (idxAcc ? idxAcc.getScalar(i) : i);

// Weld: map quantised position -> canonical vertex id.
const key = new Map();
const canon = new Int32Array(pos.getCount());
const v = [0, 0, 0];
const q = (n) => Math.round(n / EPS);
for (let i = 0; i < pos.getCount(); i++) {
  pos.getElement(i, v);
  const k = `${q(v[0])},${q(v[1])},${q(v[2])}`;
  let c = key.get(k);
  if (c === undefined) { c = i; key.set(k, i); }
  canon[i] = c;
}

// Union-find over canonical vertices.
const parent = new Int32Array(pos.getCount());
for (let i = 0; i < parent.length; i++) parent[i] = i;
function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }

for (let t = 0; t < triCount; t++) {
  const a = canon[getIdx(t * 3)], b = canon[getIdx(t * 3 + 1)], c = canon[getIdx(t * 3 + 2)];
  union(a, b); union(b, c);
}

// Group triangles by root.
const groups = new Map();
for (let t = 0; t < triCount; t++) {
  const r = find(canon[getIdx(t * 3)]);
  let g = groups.get(r);
  if (!g) { g = { tris: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; groups.set(r, g); }
  g.tris.push(t);
  for (let k = 0; k < 3; k++) {
    pos.getElement(getIdx(t * 3 + k), v);
    for (let a = 0; a < 3; a++) {
      if (v[a] < g.min[a]) g.min[a] = v[a];
      if (v[a] > g.max[a]) g.max[a] = v[a];
    }
  }
}

const parts = [...groups.values()].sort((a, b) => b.tris.length - a.tris.length);
const f = (n) => n.toFixed(3);
console.log(`weldEps=${EPS} totalTris=${triCount} components=${parts.length}`);
for (const [i, p] of parts.entries()) {
  const size = p.max.map((m, a) => m - p.min[a]);
  const flat = size[1] / Math.max(size[0], size[2]);
  const ctr = p.min.map((m, a) => (m + p.max[a]) / 2);
  console.log(
    `  #${i} tris=${p.tris.length}\tsize=[${size.map(f)}]\tminY=${f(p.min[1])}\tctr=[${ctr.map(f)}]\tflatness=${f(flat)}`
  );
}
