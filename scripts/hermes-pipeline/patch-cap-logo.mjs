#!/usr/bin/env node
// patch-cap-logo.mjs — paste the EXACT Solana logo into the cap-front UV region
// of a Meshy GLB's embedded base-color texture (biggie pipeline, 2026-07-22).
// Multi-view texture baking always smears a small embroidered mark; this
// deterministically replaces the smeared area with the real logo PNG.
//
// Approach: find cap-front triangles geometrically (top ~12% of the model,
// front-facing, near x=0), take their UV bounding box, paste the circle-crop
// logo (black disc blends into the black cap and covers the smear) centered
// in that rect, re-embed the PNG at the end of the BIN chunk.
//
// Usage: node patch-cap-logo.mjs <in.glb> <logo.png> <out.glb> [--scale 0.9] [--report]

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const [inPath, logoPath, outPath] = process.argv.slice(2);
const sFlag = process.argv.indexOf('--scale');
const SCALE = sFlag >= 0 ? Number(process.argv[sFlag + 1]) : 0.9;
if (!inPath || !logoPath || !outPath) { console.error('usage: patch-cap-logo.mjs <in.glb> <logo.png> <out.glb>'); process.exit(1); }

const buf = readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const binLen = buf.readUInt32LE(20 + jsonLen);
const bin = buf.slice(binStart, binStart + binLen);

const acc = (i) => {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const compCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const CT = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[a.componentType];
  return { arr: new CT(bin.buffer, bin.byteOffset + off, a.count * compCount), n: compCount, count: a.count };
};

// gather all skinned primitives (assume single mesh/material as Meshy emits)
let allTris = [];
let minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const mesh of json.meshes) for (const prim of mesh.primitives) {
  const pos = acc(prim.attributes.POSITION);
  const uv = acc(prim.attributes.TEXCOORD_0);
  const idx = acc(prim.indices);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.arr[i * 3 + 1], z = pos.arr[i * 3 + 2];
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  allTris.push({ pos, uv, idx });
}
const H = maxY - minY;
console.log(`model yRange=[${minY.toFixed(3)},${maxY.toFixed(3)}] h=${H.toFixed(3)} zRange=[${minZ.toFixed(3)},${maxZ.toFixed(3)}]`);

// cap-front region: top 12% of height, front half, |x| < 0.09*H.
// The atlas is fragmented, so collect candidate triangles then CLUSTER them in
// UV space and use only the cluster nearest the cap-front center — a global
// bbox spans unrelated islands and would wipe the whole texture.
const yCut = maxY - 0.12 * H;
const cands = [];
for (const { pos, uv, idx } of allTris) {
  for (let t = 0; t < idx.count; t += 3) {
    let ok = true, wx = 0, wy = 0, wz = 0, cu = 0, cv = 0;
    for (let k = 0; k < 3; k++) {
      const vi = idx.arr[t + k];
      const x = pos.arr[vi * 3], y = pos.arr[vi * 3 + 1], z = pos.arr[vi * 3 + 2];
      if (!(y > yCut && z > 0.03 * H && Math.abs(x) < 0.09 * H)) { ok = false; break; }
      wx += x / 3; wy += y / 3; wz += z / 3;
      cu += uv.arr[vi * 2] / 3; cv += uv.arr[vi * 2 + 1] / 3;
    }
    if (!ok) continue;
    const uvs = [], p3 = [];
    for (let k = 0; k < 3; k++) {
      const vi = idx.arr[t + k];
      uvs.push([uv.arr[vi * 2], uv.arr[vi * 2 + 1]]);
      p3.push([pos.arr[vi * 3], pos.arr[vi * 3 + 1], pos.arr[vi * 3 + 2]]);
    }
    cands.push({ w: [wx, wy, wz], c: [cu, cv], uvs, p3 });
  }
}
if (!cands.length) throw new Error('no cap-front triangles found — adjust region thresholds');

// union-find cluster by UV-center proximity
const EPS = 0.03;
const parent = cands.map((_, i) => i);
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
for (let i = 0; i < cands.length; i++)
  for (let j = i + 1; j < cands.length; j++) {
    const du = cands[i].c[0] - cands[j].c[0], dv = cands[i].c[1] - cands[j].c[1];
    if (du * du + dv * dv < EPS * EPS) parent[find(i)] = find(j);
  }
const clusters = new Map();
cands.forEach((c, i) => {
  const r = find(i);
  if (!clusters.has(r)) clusters.set(r, []);
  clusters.get(r).push(c);
});

// target: cap-front PANEL center — above the brim root, at panel depth.
// The brim tip is the max-z candidate; the panel sits higher (y toward crown)
// and about half the brim's protrusion in z. Do NOT target the brim tip —
// that selects the brim/forehead island and the decal lands on skin.
let zFront = -Infinity, brimY = 0;
for (const c of cands) if (c.w[2] > zFront) { zFront = c.w[2]; brimY = c.w[1]; }
const panelY = brimY + 0.66 * (maxY - brimY);
const target = [0, panelY, 0.5 * zFront];
// The cap front panel is often split into left/right UV islands — take the
// UNION of every cluster that comes within 5cm of the panel target so both
// halves get the pre-pass erase AND their geometric share of the decal.
const NEAR = 0.05;
let best = [], picked = 0, bestD = Infinity;
for (const members of clusters.values()) {
  let d = Infinity;
  for (const m of members) {
    const dd = (m.w[0] - target[0]) ** 2 + (m.w[1] - target[1]) ** 2 + (m.w[2] - target[2]) ** 2;
    if (dd < d) d = dd;
  }
  if (d < bestD) bestD = d;
  if (Math.sqrt(d) < NEAR) { best.push(...members); picked++; }
}
if (!best.length) throw new Error(`no cluster within ${NEAR}m of panel target (closest ${Math.sqrt(bestD).toFixed(3)}m)`);
console.log(`picked ${picked} island(s) near panel target`);
let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
for (const m of best) for (const [u, v] of m.uvs) {
  if (u < uMin) uMin = u; if (u > uMax) uMax = u;
  if (v < vMin) vMin = v; if (v > vMax) vMax = v;
}
console.log(`clusters: ${clusters.size}, best cluster tris=${best.length} distToTarget=${Math.sqrt(bestD).toFixed(3)}`);
console.log(`cap-front UV rect u=[${uMin.toFixed(4)},${uMax.toFixed(4)}] v=[${vMin.toFixed(4)},${vMax.toFixed(4)}]`);

// base color image
const mat = json.materials[0];
const texIdx = mat.pbrMetallicRoughness.baseColorTexture.index;
const imgIdx = json.textures[texIdx].source;
const img = json.images[imgIdx];
const ibv = json.bufferViews[img.bufferView];
const pngBytes = bin.slice(ibv.byteOffset || 0, (ibv.byteOffset || 0) + ibv.byteLength);
const tmpPng = resolve(process.env.TEMP || '/tmp', 'cap-basecolor.png');
writeFileSync(tmpPng, pngBytes);

// read PNG dims from IHDR
const texW = pngBytes.readUInt32BE(16), texH = pngBytes.readUInt32BE(20);
// UV v axis: glTF v=0 is TOP of image
const rectX = uMin * texW, rectY = vMin * texH;
const rectW = (uMax - uMin) * texW, rectH = (vMax - vMin) * texH;
const side = Math.min(rectW, rectH) * SCALE;
const px = Math.round(rectX + (rectW - side) / 2);
const py = Math.round(rectY + (rectH - side) / 2);
console.log(`texture ${texW}x${texH}, paste rect (${px},${py}) side=${Math.round(side)}`);

// Masked paste: rasterize the chosen island's triangles in UV-pixel space and
// only write logo pixels inside them — neighboring atlas islands (hands etc.)
// must not receive disc corners. Pixel work via ffmpeg raw RGBA round-trip.
const raw = resolve(process.env.TEMP || '/tmp', 'cap-base.rgba');
const lraw = resolve(process.env.TEMP || '/tmp', 'cap-logo.rgba');
const sideI = Math.round(side);
execSync(`ffmpeg -y -loglevel error -i "${tmpPng}" -f rawvideo -pix_fmt rgba "${raw}"`);
execSync(`ffmpeg -y -loglevel error -i "${resolve(logoPath)}" -vf scale=${sideI}:${sideI} -f rawvideo -pix_fmt rgba "${lraw}"`);
const base = readFileSync(raw);
const logo = readFileSync(lraw);

// 3D decal projection: rasterize each island triangle in UV space; for every
// texel, invert barycentrics to get its 3D bind-pose position, project onto the
// cap-front plane, and sample the logo there. Seam-proof: the two half-panel
// UV islands receive geometrically consistent halves of the logo.
// NOTE: `best` members need 3D verts alongside UVs — captured in cands as .w3.
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };
// plane basis from average front normal (approx +Z), world-up
let cx = 0, cy = 0, cz = 0;
for (const m of best) { cx += m.w[0] / best.length; cy += m.w[1] / best.length; cz += m.w[2] / best.length; }
const N = norm([0, 0, 1]);
const R = norm([1, 0, 0]);          // right on the cap seen from front (+X)
const UP = norm([0, 1, 0]);
// Decal anchor: the island can fuse cap + forehead, so DON'T center on its
// bbox. The brim tip is the max-z candidate; the front panel sits between the
// brim root and the crown top. Center the logo there.
const decalSide = SCALE * 0.13; // cap front panel is ~0.13m wide on a 1.85m model
const C = [0, panelY, cz];
console.log(`decal center=(${C.map((v) => v.toFixed(3)).join(',')}) side=${decalSide.toFixed(3)}m brimY=${brimY.toFixed(3)} zFront=${zFront.toFixed(3)}`);

// PRE-PASS: erase the smeared bake logo. UV charts can fuse cap AND face
// triangles, so a texel is only erased when its reconstructed 3D position is
// actually ON the cap panel (above brim height, front half) — never by UV
// membership alone (that blackened a cheek in v1).
// fill color = the cap's own average dark tone (flat constant reads as a patch)
let fr = 0, fg = 0, fb = 0, fn = 0;
for (const m of best) {
  for (const [u, v] of m.uvs) {
    const bo = ((Math.min(texH - 1, Math.round(v * texH))) * texW + Math.min(texW - 1, Math.round(u * texW))) * 4;
    const mx = Math.max(base[bo], base[bo + 1], base[bo + 2]);
    const mn = Math.min(base[bo], base[bo + 1], base[bo + 2]);
    const bright = 0.299 * base[bo] + 0.587 * base[bo + 1] + 0.114 * base[bo + 2];
    if (bright < 70 && mx - mn < 25) { fr += base[bo]; fg += base[bo + 1]; fb += base[bo + 2]; fn++; }
  }
}
const fill = fn ? [Math.round(fr / fn), Math.round(fg / fn), Math.round(fb / fn)] : [18, 18, 22];
console.log(`cap fill tone rgb(${fill.join(',')}) from ${fn} samples`);
let erased = 0;
for (const m of best) {
  const [A, B, D] = m.uvs.map(([u, v]) => [u * texW, v * texH]);
  const [P0, P1, P2] = m.p3;
  const minX = Math.max(0, Math.floor(Math.min(A[0], B[0], D[0]))), maxX = Math.min(texW - 1, Math.ceil(Math.max(A[0], B[0], D[0])));
  const minYp = Math.max(0, Math.floor(Math.min(A[1], B[1], D[1]))), maxYp = Math.min(texH - 1, Math.ceil(Math.max(A[1], B[1], D[1])));
  const den = (B[1] - D[1]) * (A[0] - D[0]) + (D[0] - B[0]) * (A[1] - D[1]);
  if (Math.abs(den) < 1e-12) continue;
  for (let ty = minYp; ty <= maxYp; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      const qx = tx + 0.5, qy = ty + 0.5;
      const w0 = ((B[1] - D[1]) * (qx - D[0]) + (D[0] - B[0]) * (qy - D[1])) / den;
      const w1 = ((D[1] - A[1]) * (qx - D[0]) + (A[0] - D[0]) * (qy - D[1])) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
      const Py = w0 * P0[1] + w1 * P1[1] + w2 * P2[1];
      const Pz = w0 * P0[2] + w1 * P1[2] + w2 * P2[2];
      if (!(Py > brimY + 0.005 && Pz > 0.02)) continue; // cap panel only
      const bo = (ty * texW + tx) * 4;
      const mx = Math.max(base[bo], base[bo + 1], base[bo + 2]);
      const mn = Math.min(base[bo], base[bo + 1], base[bo + 2]);
      const bright = 0.299 * base[bo] + 0.587 * base[bo + 1] + 0.114 * base[bo + 2];
      if (mx - mn > 30 || bright > 70) {
        base[bo] = fill[0]; base[bo + 1] = fill[1]; base[bo + 2] = fill[2];
        erased++;
      }
    }
  }
}
console.log(`erased ${erased} smear px on cap panel`);

const lpx = (s, t) => {
  const xi = Math.min(sideI - 1, Math.max(0, Math.round(s * (sideI - 1))));
  const yi = Math.min(sideI - 1, Math.max(0, Math.round(t * (sideI - 1))));
  return (yi * sideI + xi) * 4;
};
let painted = 0;
for (const m of best) {
  const [A, B, D] = m.uvs.map(([u, v]) => [u * texW, v * texH]);
  const [P0, P1, P2] = m.p3;
  const minX = Math.max(0, Math.floor(Math.min(A[0], B[0], D[0]))), maxX = Math.min(texW - 1, Math.ceil(Math.max(A[0], B[0], D[0])));
  const minYp = Math.max(0, Math.floor(Math.min(A[1], B[1], D[1]))), maxYp = Math.min(texH - 1, Math.ceil(Math.max(A[1], B[1], D[1])));
  const den = (B[1] - D[1]) * (A[0] - D[0]) + (D[0] - B[0]) * (A[1] - D[1]);
  if (Math.abs(den) < 1e-12) continue;
  for (let ty = minYp; ty <= maxYp; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      const qx = tx + 0.5, qy = ty + 0.5;
      const w0 = ((B[1] - D[1]) * (qx - D[0]) + (D[0] - B[0]) * (qy - D[1])) / den;
      const w1 = ((D[1] - A[1]) * (qx - D[0]) + (A[0] - D[0]) * (qy - D[1])) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
      const P = [
        w0 * P0[0] + w1 * P1[0] + w2 * P2[0],
        w0 * P0[1] + w1 * P1[1] + w2 * P2[1],
        w0 * P0[2] + w1 * P1[2] + w2 * P2[2],
      ];
      const rel = [P[0] - C[0], P[1] - C[1], P[2] - C[2]];
      const s = (rel[0] * R[0] + rel[1] * R[1] + rel[2] * R[2]) / decalSide + 0.5;
      const t = 0.5 - (rel[0] * UP[0] + rel[1] * UP[1] + rel[2] * UP[2]) / decalSide;
      if (s < 0 || s > 1 || t < 0 || t > 1) continue;
      const lo = lpx(s, t);
      const la = logo[lo + 3];
      if (la < 8) continue;
      const bo = (ty * texW + tx) * 4;
      const a = la / 255;
      base[bo] = Math.round(logo[lo] * a + base[bo] * (1 - a));
      base[bo + 1] = Math.round(logo[lo + 1] * a + base[bo + 1] * (1 - a));
      base[bo + 2] = Math.round(logo[lo + 2] * a + base[bo + 2] * (1 - a));
      painted++;
    }
  }
}
console.log(`painted ${painted} px (3D-projected decal)`);
writeFileSync(raw, base);
execSync(`ffmpeg -y -loglevel error -f rawvideo -pix_fmt rgba -s ${texW}x${texH} -i "${raw}" -frames:v 1 "${tmpPng}"`);

// re-embed: append patched PNG to BIN, repoint the image bufferView
const newPng = readFileSync(tmpPng);
const pad = (4 - (bin.length % 4)) % 4;
const appendOff = bin.length + pad;
const newBin = Buffer.concat([bin, Buffer.alloc(pad), newPng, Buffer.alloc((4 - (newPng.length % 4)) % 4)]);
json.bufferViews[img.bufferView] = { buffer: 0, byteOffset: appendOff, byteLength: newPng.length };
json.buffers[0].byteLength = newBin.length;

let jsonOut = Buffer.from(JSON.stringify(json));
const jpad = (4 - (jsonOut.length % 4)) % 4;
jsonOut = Buffer.concat([jsonOut, Buffer.alloc(jpad, 0x20)]);
const total = 12 + 8 + jsonOut.length + 8 + newBin.length;
const out = Buffer.alloc(total);
out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
out.writeUInt32LE(jsonOut.length, 12); out.writeUInt32LE(0x4e4f534a, 16); jsonOut.copy(out, 20);
out.writeUInt32LE(newBin.length, 20 + jsonOut.length); out.writeUInt32LE(0x004e4942, 24 + jsonOut.length); newBin.copy(out, 28 + jsonOut.length);
writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${(total / 1024 / 1024).toFixed(1)} MB)`);
