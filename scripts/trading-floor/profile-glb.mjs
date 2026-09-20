#!/usr/bin/env node
// profile-glb.mjs — per-Y-slice triangle profile of a GLB primitive.
// Reports, for each Y band: triangle count, how many are near-horizontal
// (|n.y|>0.95), and the XZ extent of that band. Used to locate the fused
// ground slab plane in a Meshy text-to-3d building so it can be cut out.
//
// Usage: node scripts/trading-floor/profile-glb.mjs <file.glb> [bins]

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3d';

const file = process.argv[2];
const BINS = Number(process.argv[3] ?? 24);
if (!file) throw new Error('usage: profile-glb.mjs <file.glb> [bins]');

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

let minY = Infinity, maxY = -Infinity;
const v = [0, 0, 0];
for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1]; }

const bins = Array.from({ length: BINS }, () => ({ tris: 0, flat: 0, maxR: 0, flatMaxR: 0, flatMinR: Infinity }));
const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
for (let t = 0; t < triCount; t++) {
  pos.getElement(getIdx(t * 3), a); pos.getElement(getIdx(t * 3 + 1), b); pos.getElement(getIdx(t * 3 + 2), c);
  const cy = (a[1] + b[1] + c[1]) / 3;
  const bi = Math.min(BINS - 1, Math.max(0, Math.floor(((cy - minY) / (maxY - minY)) * BINS)));
  // face normal
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const ny = Math.abs(n[1] / len);
  const r = Math.max(
    Math.hypot(a[0], a[2]), Math.hypot(b[0], b[2]), Math.hypot(c[0], c[2])
  );
  const B = bins[bi];
  B.tris++;
  if (r > B.maxR) B.maxR = r;
  if (ny > 0.95) { B.flat++; if (r > B.flatMaxR) B.flatMaxR = r; if (r < B.flatMinR) B.flatMinR = r; }
}

const f = (n) => (Number.isFinite(n) ? n.toFixed(3) : '-');
console.log(`Y range ${f(minY)} .. ${f(maxY)}  tris=${triCount}  bins=${BINS}`);
console.log('bin  yLo     yHi     tris   flat   maxR   flatR(min..max)');
for (const [i, B] of bins.entries()) {
  const yLo = minY + ((maxY - minY) * i) / BINS;
  const yHi = minY + ((maxY - minY) * (i + 1)) / BINS;
  console.log(
    `${String(i).padStart(3)}  ${f(yLo).padStart(7)} ${f(yHi).padStart(7)} ${String(B.tris).padStart(6)} ${String(B.flat).padStart(6)} ${f(B.maxR).padStart(6)}  ${f(B.flatMinR)}..${f(B.flatMaxR)}`
  );
}
