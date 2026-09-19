#!/usr/bin/env node
// Remove the black "screen cover" faces from the cove slot machines.
//
// The source cove asset (every version back to the 2026-05-19 backup) has, on
// each of the 48 slot cabinets, 3-6 faces of material `auto_24` (the cabinet
// atlas Image_6) that sit about 1 unit in front of the screen picture
// (`auto_4`, Image_3). Their UVs fall in the atlas's black top band
// (u 0.49-0.63, v 0.00-0.13, several are near-zero-width slivers), so they
// render as large black triangles over the slot screens.
//
// The same UV band is ALSO used by the real lower door panel of each cabinet.
// That panel is far from any screen face, so the rule is:
//   auto_24 face with all UVs in the band AND its centroid close to an auto_4
//   (screen) triangle (point-to-triangle distance in glTF world space, relative
//   to the cabinet primitive's size) => remove.
// The script prints the distance gap between the two groups and refuses to
// write when the split is not clean.
//
// Usage: node scripts/patch-cove-slot-screen-covers.mjs [--dry] <file.glb>...
// Files are rewritten in place. Bump the `?v=` of every URL that serves them
// (3dStructure.md §6f rule 9: Cloudflare caches the bare path for a week).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3d';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const UV_BOX = { u0: 0.49, u1: 0.626, v0: 0.0, v1: 0.127 };
const CABINET_MAT = 'auto_24';
const SCREEN_MAT = 'auto_4';
const EXPECTED_REMOVE = 150;
const EXPECTED_KEEP = 138;
// Relative distance between the two groups on the original asset: cover faces
// <= 0.00811, door-panel faces >= 0.01434. The midpoint separates them.
const SPLIT_REL = 0.0112;

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const files = args.filter((a) => a !== '--dry');
if (files.length === 0) {
  console.error('usage: node scripts/patch-cove-slot-screen-covers.mjs [--dry] <file.glb>...');
  process.exit(2);
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
});

function applyMat(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** World-space triangles ([a, b, c] vertex triples) for one primitive (one node instance). */
function triangles(prim, matrix) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  const n = idx ? idx.getCount() : pos.getCount();
  const out = [];
  const p = [0, 0, 0];
  for (let i = 0; i < n; i += 3) {
    const tri = [];
    for (let k = 0; k < 3; k++) {
      pos.getElement(idx ? idx.getScalar(i + k) : i + k, p);
      tri.push(applyMat(matrix, p[0], p[1], p[2]));
    }
    out.push(tri);
  }
  return out;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const centroid = ([a, b, c]) => [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];

/** Distance from point p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangleDistance(p, [a, b, c]) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const lerp = (u, v, s) => [u[0] + s * v[0], u[1] + s * v[1], u[2] + s * v[2]];
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(lerp(a, ab, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(lerp(a, ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return at(lerp(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return at([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

function findPrim(doc, matName) {
  const hits = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMaterial()?.getName() === matName) hits.push({ node, prim });
    }
  }
  if (hits.length !== 1) throw new Error(`expected 1 primitive with material ${matName}, found ${hits.length}`);
  return hits[0];
}

let failed = false;
for (const file of files) {
  const doc = await io.read(file);
  const cab = findPrim(doc, CABINET_MAT);
  const scr = findPrim(doc, SCREEN_MAT);
  const cabT = triangles(cab.prim, cab.node.getWorldMatrix());
  const scrT = triangles(scr.prim, scr.node.getWorldMatrix());
  const cabC = cabT.map(centroid);

  const uv = cab.prim.getAttribute('TEXCOORD_0');
  const idx = cab.prim.getIndices();
  if (!idx) throw new Error(`${file}: ${CABINET_MAT} primitive is not indexed`);
  const t = [0, 0];
  const inBand = (tri) => {
    for (let k = 0; k < 3; k++) {
      uv.getElement(idx.getScalar(tri * 3 + k), t);
      if (t[0] < UV_BOX.u0 || t[0] > UV_BOX.u1 || t[1] < UV_BOX.v0 || t[1] > UV_BOX.v1) return false;
    }
    return true;
  };

  // Scale reference: the cabinet primitive's world-space bounding diagonal.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const c of cabC) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], c[a]); hi[a] = Math.max(hi[a], c[a]); }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);

  const band = [];
  for (let tri = 0; tri < cabC.length; tri++) {
    if (!inBand(tri)) continue;
    const c = cabC[tri];
    let best = Infinity;
    for (const s of scrT) best = Math.min(best, pointTriangleDistance(c, s));
    band.push({ tri, rel: best / diag });
  }
  if (band.length === EXPECTED_KEEP) {
    // Already patched only if every remaining band face is a door-panel face
    // (far from all screens), not merely because the count matches.
    const minRel = Math.min(...band.map((x) => x.rel));
    const ok = minRel > SPLIT_REL;
    console.log(JSON.stringify({ file: file.split(/[\\/]/).pop(), cabinetTris: cabC.length, bandTris: band.length, minRel: +minRel.toFixed(5), alreadyPatched: ok }));
    if (!ok) { console.error(`${file}: ${EXPECTED_KEEP} band faces remain but some sit on a screen; unexpected geometry, not writing`); failed = true; }
    continue;
  }
  band.sort((a, b) => a.rel - b.rel);
  // Largest gap in the sorted relative distances splits "over a screen" from "door panel".
  let gapAt = -1, gap = 0;
  for (let i = 1; i < band.length; i++) {
    const g = band[i].rel - band[i - 1].rel;
    if (g > gap) { gap = g; gapAt = i; }
  }
  const near = band.slice(0, gapAt);
  const far = band.slice(gapAt);
  const nearMax = near.at(-1)?.rel ?? 0, farMin = far[0]?.rel ?? 0;
  // Pinned to this asset: 150 cover faces over 48 screens, 138 door-panel faces
  // kept (browser-verified 2026-09-18), with a clear distance gap between them.
  const clean = near.length === EXPECTED_REMOVE && far.length === EXPECTED_KEEP && farMin > 1.5 * nearMax
    && nearMax < SPLIT_REL && farMin > SPLIT_REL;
  console.log(JSON.stringify({
    file: file.split(/[\\/]/).pop(), cabinetTris: cabC.length, bandTris: band.length,
    remove: near.length, keep: far.length, nearMaxRel: +nearMax.toFixed(5), farMinRel: +farMin.toFixed(5), clean,
  }));
  if (!clean) { console.error(`${file}: split is not clean, not writing`); failed = true; continue; }
  if (process.env.PRINT_TRIS) console.log(JSON.stringify(near.map((x) => x.tri).sort((a, b) => a - b)));
  if (dry) continue;

  const drop = new Set(near.map((x) => x.tri));
  const src = idx.getArray();
  const kept = new src.constructor(src.length - drop.size * 3);
  let w = 0;
  for (let tri = 0; tri < src.length / 3; tri++) {
    if (drop.has(tri)) continue;
    kept[w++] = src[tri * 3]; kept[w++] = src[tri * 3 + 1]; kept[w++] = src[tri * 3 + 2];
  }
  idx.setArray(kept);
  await io.write(file, doc);
  console.log(`wrote ${file}`);
}
process.exit(failed ? 1 : 0);
