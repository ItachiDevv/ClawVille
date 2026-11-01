#!/usr/bin/env node
// hydra-face-fix.mjs — one-off asset repair for the Hydra NPC source GLB (2026-11-01).
//
// Usage: node scripts/hermes-pipeline/hydra-face-fix.mjs <rigged-glow.glb> <rigged-face.glb> apps/web/public/avatars
// (the third argument is the folder for the two halo mask files, step 5)
// Runs AFTER glow-map-from-basecolor.mjs and BEFORE inject-vrm-meshy.mjs (gltf-transform would drop
// the VRMC_vrm block, so it must never run on a .vrm).
//
// Founder review of the round-2 rig (2026-10-31 / 11-01):
//   1. Her right eye (mesh -X) is split over small UV fragments that hold dark and grey texels, so it
//      renders distorted. Her left eye (+X) is clean. Fix: give every -X eye triangle its own corner
//      vertices whose UVs are looked up at the X-mirrored point on the +X eye (main face UV island
//      only), so the -X eye shows a mirror copy of the clean eye. Positions, normals, skin weights and
//      tangents are copied unchanged; only TEXCOORD_0 differs.
//   2. The earpiece cups show skin-colored and grey texels. Fix: inside each cup volume, skin-toned,
//      mid-grey and isolated light texels become suit black (the blue glow ring is kept).
//   3. The glow mask misses the chest H strokes (near-white, low saturation) and the eyes. Fix: add
//      them to the emissive mask at full neon, selected by 3D position so every UV fragment is covered.
//   4. The normal map has noisy texels around the eyes that shade the face dark. Fix: flatten it
//      (tangent-space +Z) around both eyes. The mirrored UVs make the tangent frame irrelevant there.
//
// All regions are in the rest-pose model space measured on this mesh (metres, +Z = front, +Y = up).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const [inPath, outPath, haloDir] = process.argv.slice(2);
if (!inPath || !outPath || !haloDir || /\.vrm$/i.test(inPath) || /\.vrm$/i.test(outPath)) {
  console.error('usage: node hydra-face-fix.mjs <rigged-glow.glb> <rigged-face.glb> <halo-out-dir>  (never a .vrm)');
  process.exit(1);
}

// ── regions (measured on the Hydra round-2 mesh) ───────────────────────────
const EYE = { x: 0.0355, y: 1.6125 };          // eye centres at +-x
const EYE_REMAP = { rx: 0.0225, ry: 0.014, minZ: 0.09, maxAbsX: 0.053 };
// main face UV island (holds the clean +X eye); lookups never leave it
const FACE_ISLAND = { u0: 0.28, u1: 0.40, v0: 0.10, v1: 0.22 };
const EYE_GLOW = { rx: 0.0135, ry: 0.0092, minZ: 0.10 };
const H_REGION = { maxAbsX: 0.06, y0: 1.285, y1: 1.415, minZ: 0.12 };
const CUPS = [[-0.100, 1.610, 0.052], [0.098, 1.608, 0.046]];
const NEON = [48, 168, 255];
const SUIT_BLACK = [14, 16, 22];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inPath);
const root = doc.getRoot();
if (root.listExtensionsUsed().some((e) => e.extensionName.startsWith('VRMC'))) throw new Error('input is a VRM');
const meshes = root.listMeshes();
if (meshes.length !== 1 || meshes[0].listPrimitives().length !== 1) throw new Error('expected one mesh with one primitive');
const prim = meshes[0].listPrimitives()[0];
const node = root.listNodes().find((n) => n.getMesh() === meshes[0]);
const skin = node.getSkin();
if (!skin) throw new Error('mesh is not skinned');

// ── rest-pose positions and normals (joint world * inverse bind) ───────────
const mul = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let v = 0; for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = v; } return o; };
const xf = (m, p, w) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + w * m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + w * m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + w * m[14]];
const IBM = skin.getInverseBindMatrices();
const jointM = skin.listJoints().map((j, k) => mul(j.getWorldMatrix(), IBM.getElement(k, [])));
const aPos = prim.getAttribute('POSITION'), aNrm = prim.getAttribute('NORMAL'), aUV = prim.getAttribute('TEXCOORD_0');
const aJ = prim.getAttribute('JOINTS_0'), aW = prim.getAttribute('WEIGHTS_0');
if (aPos.getNormalized() || aUV.getNormalized()) throw new Error('quantized input not supported (run before assets-optimize)');
const nV = aPos.getCount();
const rest = new Float64Array(nV * 3), restN = new Float64Array(nV * 3);
{
  const p = [], q = [], j = [], w = [];
  for (let i = 0; i < nV; i++) {
    aPos.getElement(i, p); aNrm.getElement(i, q); aJ.getElement(i, j); aW.getElement(i, w);
    const a = [0, 0, 0], b = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      if (!w[k]) continue;
      const t = xf(jointM[j[k]], p, 1), s = xf(jointM[j[k]], q, 0);
      for (let c = 0; c < 3; c++) { a[c] += t[c] * w[k]; b[c] += s[c] * w[k]; }
    }
    const L = Math.hypot(b[0], b[1], b[2]) || 1;
    for (let c = 0; c < 3; c++) { rest[i * 3 + c] = a[c]; restN[i * 3 + c] = b[c] / L; }
  }
}
const idxArr = Array.from(prim.getIndices().getArray());
const nT = idxArr.length / 3;
const uvArr = aUV.getArray();

const mat = root.listMaterials()[0];
const texBase = mat.getBaseColorTexture(), texEm = mat.getEmissiveTexture(), texN = mat.getNormalTexture();
if (!texBase || !texEm || !texN) throw new Error('expected base color, emissive and normal textures');
const decode = async (t) => sharp(Buffer.from(t.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const base = await decode(texBase), em = await decode(texEm), nm = await decode(texN);
const W = base.info.width, H = base.info.height;
for (const img of [em, nm]) if (img.info.width !== W || img.info.height !== H) throw new Error('texture sizes differ');

// ── 0. mirror the face surface (normals, and positions within a few mm) from +X onto -X ──
// Founder review 2026-11-01: the -X eye "looks pushed back into the face". Measured: the two halves
// differ by only 1-2 mm in depth, but the -X vertex normals around the eye are noisy (many UV-fragment
// splits with inconsistent normals), so the lit surface looks faceted and dented. Each -X face vertex
// takes the X-mirrored position and normal of the closest +X face surface point, feathered to zero at
// the region edge. A vertex whose mirror point is farther than 4 mm from any +X face triangle is a
// hair strand (or has no counterpart) and is left alone.
const FACE_REGION = { maxAbsX: 0.058, y0: 1.575, y1: 1.68, minZ: 0.06, feather: 0.014 };
const inFace = (x, y, z) => Math.abs(x) < FACE_REGION.maxAbsX && y > FACE_REGION.y0 && y < FACE_REGION.y1 && z > FACE_REGION.minZ;
const texelAt = (vi) => {
  const tx = Math.min(W - 1, Math.max(0, Math.floor((((uvArr[vi * 2] % 1) + 1) % 1) * W)));
  const ty = Math.min(H - 1, Math.max(0, Math.floor((((uvArr[vi * 2 + 1] % 1) + 1) % 1) * H)));
  return (ty * W + tx) * 3;
};
const isHairVertex = (vi) => {
  const o = texelAt(vi); const r = base.data[o] / 255, g = base.data[o + 1] / 255, b = base.data[o + 2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx > 0.78 && (mx - mn) / mx < 0.10; // white hair
};
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const faceTargets = [];
for (let t = 0; t < nT; t++) {
  let cx = 0, cy = 0, cz = 0, allHair = true;
  for (let k = 0; k < 3; k++) { const vi = idxArr[t * 3 + k]; cx += rest[vi * 3] / 3; cy += rest[vi * 3 + 1] / 3; cz += rest[vi * 3 + 2] / 3; if (!isHairVertex(vi)) allHair = false; }
  if (inFace(cx, cy, cz) && cx > -0.004 && !allHair) faceTargets.push(t);
}
// 3x3 linear part of the blended skin matrix of a vertex (rest = A * bind)
function blendLinear(vi) {
  const j = [], w = []; aJ.getElement(vi, j); aW.getElement(vi, w);
  const A = new Array(9).fill(0);
  for (let k = 0; k < 4; k++) { if (!w[k]) continue; const m = jointM[j[k]]; for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) A[c * 3 + r] += m[c * 4 + r] * w[k]; }
  return A; // column-major
}
function solve3(A, v) { // A column-major 3x3, returns A^-1 v (Cramer)
  const a = A[0], b = A[3], c = A[6], d = A[1], e = A[4], f = A[7], g = A[2], h = A[5], i = A[8];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-20) throw new Error('singular skin matrix');
  return [
    ((e * i - f * h) * v[0] - (b * i - c * h) * v[1] + (b * f - c * e) * v[2]) / det,
    (-(d * i - f * g) * v[0] + (a * i - c * g) * v[1] - (a * f - c * d) * v[2]) / det,
    ((d * h - e * g) * v[0] - (a * h - b * g) * v[1] + (a * e - b * d) * v[2]) / det,
  ];
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vtx = (i) => [rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]];
{
  const restSnap = Float64Array.from(rest), restNSnap = Float64Array.from(restN); // lookups read the unmodified +X side
  const posArr = aPos.getArray(), nrmArr = aNrm.getArray();
  let moved = 0, skipped = 0, maxMove = 0;
  for (let vi = 0; vi < nV; vi++) {
    const x = restSnap[vi * 3], y = restSnap[vi * 3 + 1], z = restSnap[vi * 3 + 2];
    if (!(x < -0.0015 && inFace(x, y, z))) continue;
    const p = [-x, y, z];
    let best = Infinity, q = null, nq = null;
    for (const t of faceTargets) {
      const i0 = idxArr[t * 3], i1 = idxArr[t * 3 + 1], i2 = idxArr[t * 3 + 2];
      const a = [restSnap[i0 * 3], restSnap[i0 * 3 + 1], restSnap[i0 * 3 + 2]];
      const b = [restSnap[i1 * 3], restSnap[i1 * 3 + 1], restSnap[i1 * 3 + 2]];
      const c = [restSnap[i2 * 3], restSnap[i2 * 3 + 1], restSnap[i2 * 3 + 2]];
      const bc = closestBary(p, a, b, c);
      const pt = [0, 1, 2].map((k) => bc[0] * a[k] + bc[1] * b[k] + bc[2] * c[k]);
      const d = Math.hypot(pt[0] - p[0], pt[1] - p[1], pt[2] - p[2]);
      if (d < best) { best = d; q = pt; nq = [0, 1, 2].map((k) => bc[0] * restNSnap[i0 * 3 + k] + bc[1] * restNSnap[i1 * 3 + k] + bc[2] * restNSnap[i2 * 3 + k]); }
    }
    if (best > 0.004) { skipped++; continue; }
    const w = (1 - smoothstep(FACE_REGION.maxAbsX - FACE_REGION.feather, FACE_REGION.maxAbsX, -x))
      * smoothstep(FACE_REGION.y0, FACE_REGION.y0 + 0.010, y) * (1 - smoothstep(FACE_REGION.y1 - 0.010, FACE_REGION.y1, y));
    const target = [-q[0], q[1], q[2]], targetN = [-nq[0], nq[1], nq[2]];
    const newRest = [0, 1, 2].map((k) => restSnap[vi * 3 + k] * (1 - w) + target[k] * w);
    const nn = [0, 1, 2].map((k) => restNSnap[vi * 3 + k] * (1 - w) + targetN[k] * w);
    const nl = Math.hypot(...nn) || 1;
    const A = blendLinear(vi);
    const dBind = solve3(A, [0, 1, 2].map((k) => newRest[k] - restSnap[vi * 3 + k]));
    for (let k = 0; k < 3; k++) posArr[vi * 3 + k] += dBind[k];
    const nBind = solve3(A, nn.map((v) => v / nl)); const nbl = Math.hypot(...nBind) || 1;
    for (let k = 0; k < 3; k++) nrmArr[vi * 3 + k] = nBind[k] / nbl;
    for (let k = 0; k < 3; k++) { rest[vi * 3 + k] = newRest[k]; restN[vi * 3 + k] = nn[k] / nl; }
    maxMove = Math.max(maxMove, Math.hypot(...newRest.map((v, k) => v - restSnap[vi * 3 + k])));
    moved++;
  }
  aPos.setArray(posArr); aNrm.setArray(nrmArr);
  if (moved < 100) throw new Error(`face mirror moved only ${moved} vertices: region does not match this mesh`);
  if (maxMove > 0.006) throw new Error(`face mirror moved a vertex ${(maxMove * 1000).toFixed(1)} mm: expected a few mm at most`);
  console.log(`face mirror: ${moved} vertices (normals + up to ${(maxMove * 1000).toFixed(1)} mm), ${skipped} skipped as hair/no match, ${faceTargets.length} +X target triangles`);
}
const centroid = (t) => {
  const c = [0, 0, 0];
  for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) c[a] += rest[idxArr[t * 3 + k] * 3 + a] / 3;
  return c;
};

// ── 1. eye UV mirror ────────────────────────────────────────────────────────
const inEllipse = (c, cx, rx, ry) => ((c[0] - cx) / rx) ** 2 + ((c[1] - EYE.y) / ry) ** 2 < 1;
const badTris = [], goodTris = [];
for (let t = 0; t < nT; t++) {
  const c = centroid(t);
  if (c[2] > EYE_REMAP.minZ && c[0] > -EYE_REMAP.maxAbsX && inEllipse(c, -EYE.x, EYE_REMAP.rx, EYE_REMAP.ry)) badTris.push(t);
  if (c[2] > EYE_REMAP.minZ && inEllipse(c, EYE.x, EYE_REMAP.rx * 1.5, EYE_REMAP.ry * 1.5)) {
    let u = 0, v = 0;
    for (let k = 0; k < 3; k++) { const vi = idxArr[t * 3 + k]; u += uvArr[vi * 2] / 3; v += uvArr[vi * 2 + 1] / 3; }
    if (u > FACE_ISLAND.u0 && u < FACE_ISLAND.u1 && v > FACE_ISLAND.v0 && v < FACE_ISLAND.v1) goodTris.push(t);
  }
}
if (badTris.length < 20 || goodTris.length < 20) throw new Error(`eye regions look wrong: bad ${badTris.length}, good ${goodTris.length}`);
// closest point on triangle (Ericson, Real-Time Collision Detection 5.1.5) -> barycentric
function closestBary(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [0, 1 - w, w]; }
  const den = 1 / (va + vb + vc); const v = vb * den, w = vc * den;
  return [1 - v - w, v, w];
}
function mirroredUV(vi) {
  const p = [-rest[vi * 3], rest[vi * 3 + 1], rest[vi * 3 + 2]];
  let best = Infinity, uv = null;
  for (const t of goodTris) {
    const i0 = idxArr[t * 3], i1 = idxArr[t * 3 + 1], i2 = idxArr[t * 3 + 2];
    const a = vtx(i0), b = vtx(i1), c = vtx(i2);
    const bc = closestBary(p, a, b, c);
    const q = [0, 1, 2].map((k) => bc[0] * a[k] + bc[1] * b[k] + bc[2] * c[k]);
    const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (d < best) {
      best = d;
      uv = [0, 1].map((k) => bc[0] * uvArr[i0 * 2 + k] + bc[1] * uvArr[i1 * 2 + k] + bc[2] * uvArr[i2 * 2 + k]);
    }
  }
  return { uv, dist: best };
}
// one new vertex per bad-triangle corner (unwelded), copying every attribute of the source vertex
const appended = []; // [sourceVertex, u, v]
let maxMirrorDist = 0;
for (const t of badTris) {
  for (let k = 0; k < 3; k++) {
    const src = idxArr[t * 3 + k];
    const { uv, dist } = mirroredUV(src);
    maxMirrorDist = Math.max(maxMirrorDist, dist);
    idxArr[t * 3 + k] = nV + appended.length;
    appended.push([src, uv[0], uv[1]]);
  }
}
if (maxMirrorDist > 0.02) throw new Error(`mirror lookup ${maxMirrorDist.toFixed(4)} m from the +X eye surface: mesh is not symmetric here`);
for (const sem of prim.listSemantics()) {
  const acc = prim.getAttribute(sem);
  const size = acc.getElementSize(); const old = acc.getArray();
  const next = new old.constructor((nV + appended.length) * size);
  next.set(old);
  appended.forEach(([src], i) => { for (let c = 0; c < size; c++) next[(nV + i) * size + c] = old[src * size + c]; });
  if (sem === 'TEXCOORD_0') appended.forEach(([, u, v], i) => { next[(nV + i) * 2] = u; next[(nV + i) * 2 + 1] = v; });
  acc.setArray(next);
}
for (const target of prim.listTargets()) if (target.listSemantics().length) throw new Error('morph targets not supported');
const newIdx = new Uint32Array(idxArr);
prim.getIndices().setArray(newIdx);
console.log(`eye mirror: ${badTris.length} triangles, ${appended.length} vertices added, max lookup ${(maxMirrorDist * 1000).toFixed(1)} mm`);

// ── texel position map (rest-pose position at each texel centre, using the NEW UVs) ──
const finalUV = aUV.getArray();
const restAt = (vi) => (vi < nV ? vi : appended[vi - nV][0]);
function positionMap(W, H) {
  const pos = new Float32Array(W * H * 3).fill(NaN);
  const nz = new Float32Array(W * H);
  for (let t = 0; t < nT; t++) {
    const vs = [newIdx[t * 3], newIdx[t * 3 + 1], newIdx[t * 3 + 2]];
    const px = vs.map((v) => finalUV[v * 2] * W), py = vs.map((v) => finalUV[v * 2 + 1] * H);
    const x0 = Math.max(0, Math.floor(Math.min(...px))), x1 = Math.min(W - 1, Math.ceil(Math.max(...px)));
    const y0 = Math.max(0, Math.floor(Math.min(...py))), y1 = Math.min(H - 1, Math.ceil(Math.max(...py)));
    const d = (py[1] - py[2]) * (px[0] - px[2]) + (px[2] - px[1]) * (py[0] - py[2]);
    if (Math.abs(d) < 1e-14) continue;
    const r = vs.map(restAt);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const gx = x + 0.5, gy = y + 0.5;
      const l1 = ((py[1] - py[2]) * (gx - px[2]) + (px[2] - px[1]) * (gy - py[2])) / d;
      const l2 = ((py[2] - py[0]) * (gx - px[2]) + (px[0] - px[2]) * (gy - py[2])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -0.03 || l2 < -0.03 || l3 < -0.03) continue;
      const o = (y * W + x);
      for (let c = 0; c < 3; c++) pos[o * 3 + c] = l1 * rest[r[0] * 3 + c] + l2 * rest[r[1] * 3 + c] + l3 * rest[r[2] * 3 + c];
      nz[o] = l1 * restN[r[0] * 3 + 2] + l2 * restN[r[1] * 3 + 2] + l3 * restN[r[2] * 3 + 2];
    }
  }
  return { pos, nz };
}

const { pos, nz } = positionMap(W, H);
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const hsv = (r, g, b) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn || 1e-6;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return [h, mx > 0 ? (mx - mn) / mx : 0, mx];
};

// darkness fraction around each texel (box radius scales with texture size), for cup specks
const R = Math.round(W / 256);
const dark = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) dark[i] = Math.max(base.data[i * 3], base.data[i * 3 + 1], base.data[i * 3 + 2]) < 77 ? 1 : 0;
const darkFrac = new Float32Array(W * H);
{
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { let s = 0; for (let x = -R; x <= R; x++) s += dark[y * W + Math.min(W - 1, Math.max(0, x))]; for (let x = 0; x < W; x++) { tmp[y * W + x] = s / (2 * R + 1); const a = Math.min(W - 1, x + R + 1), b = Math.max(0, x - R); s += dark[y * W + a] - dark[y * W + b]; } }
  for (let x = 0; x < W; x++) { let s = 0; for (let y = -R; y <= R; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x]; for (let y = 0; y < H; y++) { darkFrac[y * W + x] = s / (2 * R + 1); const a = Math.min(H - 1, y + R + 1), b = Math.max(0, y - R); s += tmp[a * W + x] - tmp[b * W + x]; } }
}

let nCup = 0, nH = 0, nEye = 0, nFlat = 0;
const added = new Uint8Array(W * H); // texels this script lit in the emissive map (for seam padding)
for (let i = 0; i < W * H; i++) {
  const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
  if (Number.isNaN(x)) continue;
  const r = base.data[i * 3] / 255, g = base.data[i * 3 + 1] / 255, b = base.data[i * 3 + 2] / 255;
  const [h, s, v] = hsv(r, g, b);
  const blueGlow = h > 180 && h < 250 && s > 0.35;

  // 2. earpiece cups -> suit black
  let cup = 0;
  for (const [cx, cy, cz] of CUPS) {
    const rr = Math.hypot(y - cy, z - cz);
    cup = Math.max(cup, (1 - smooth(0.056, 0.064, rr)) * smooth(0.066, 0.072, Math.sign(cx) * x));
  }
  if (cup > 0) {
    const skinTone = h > 4 && h < 50 && s > 0.06 && v > 0.35;
    const grey = s < 0.10 && v > 0.35 && v < 0.80;
    const speck = v >= 0.35 && darkFrac[i] > 0.45 && !(blueGlow && v > 0.3);
    if (skinTone || grey || speck) {
      for (let c = 0; c < 3; c++) base.data[i * 3 + c] = Math.round(base.data[i * 3 + c] * (1 - cup) + SUIT_BLACK[c] * cup);
      nCup++;
    }
  }

  // 3a. chest H strokes and hex outline -> full neon emissive
  if (Math.abs(x) < H_REGION.maxAbsX && y > H_REGION.y0 && y < H_REGION.y1 && z > H_REGION.minZ) {
    // Measured across the H: white stroke cores and bright cyan edges read v 0.8-1.0; the blue paint
    // spill between the strokes reads v 0.45-0.65 and must stay dark, or the hex lights up as a blob.
    const stroke = smooth(0.78, 0.92, v);
    if (stroke > 0) {
      for (let c = 0; c < 3; c++) em.data[i * 3 + c] = Math.max(em.data[i * 3 + c], Math.round(NEON[c] * stroke));
      added[i] = 1;
      nH++;
    }
  }
  // 3b. eyes (blue iris texels inside either eye outline) -> full neon emissive
  if (z > EYE_GLOW.minZ) {
    const e = Math.min(...[-EYE.x, EYE.x].map((cx) => Math.hypot((x - cx) / EYE_GLOW.rx, (y - EYE.y) / EYE_GLOW.ry)));
    if (e < 1.15 && blueGlow && v > 0.4) {
      const w = (1 - smooth(0.9, 1.15, e)) * smooth(0.4, 0.6, v);
      for (let c = 0; c < 3; c++) em.data[i * 3 + c] = Math.max(em.data[i * 3 + c], Math.round(NEON[c] * w));
      added[i] = 1;
      nEye++;
    }
  }
  // 4. flatten the normal map around both eyes
  const flat = (z > 0.09 ? 1 : 0) * (1 - smooth(0.055, 0.065, Math.abs(x))) * smooth(1.588, 1.596, y) * (1 - smooth(1.66, 1.675, y));
  if (flat > 0) {
    const n0 = [128, 128, 255];
    for (let c = 0; c < 3; c++) nm.data[i * 3 + c] = Math.round(nm.data[i * 3 + c] * (1 - flat) + n0[c] * flat);
    nFlat++;
  }
}
// Seam padding: bilinear and mip sampling at a UV-island edge reads texels outside the island. Grow
// the lit texels 3 texels into texels no triangle covers, so island edges do not show dark lines.
let nPad = 0;
for (let pass = 0; pass < 3; pass++) {
  const grow = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (added[i] || !Number.isNaN(pos[i * 3])) continue;
    let best = -1, bestV = -1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx;
      if (added[j] && em.data[j * 3 + 2] > bestV) { best = j; bestV = em.data[j * 3 + 2]; }
    }
    if (best >= 0) grow.push([i, best]);
  }
  for (const [i, j] of grow) { for (let c = 0; c < 3; c++) em.data[i * 3 + c] = Math.max(em.data[i * 3 + c], em.data[j * 3 + c]); added[i] = 1; nPad++; }
}
console.log(`texels: cups ${nCup}, H ${nH}, eyes ${nEye}, emissive padding ${nPad}, normal flattened ${nFlat} (texture ${W}x${H})`);
if (nH < 500 || nEye < 50) throw new Error('H or eye glow selection is empty: regions do not match this mesh');

// ── 5. halo masks for the in-game glow shells (hydra-halo.ts) ──────────────
// Founder review 2026-11-01 approved the bench halo: blurred copies of the glow mask drawn on skinned
// shells pushed out along the normal. The emissive map is ONE neon colour times a mask, so each halo
// layer is stored as one grey channel (the shader multiplies by the neon colour):
//   hydra-halo-suit.webp (512, RGB = 3 suit layers): the whole emissive mask, blurred in UV space by
//     8 / 22 / 48 px at 1024 (CSS blur px = gaussian sigma), then added onto itself (x2, clamped).
//   hydra-halo-hot.webp (1024, RGB = 3 hot layers): only the chest H and the eyes, blurred in a FRONT
//     VIEW (sigma 1.0 / 2.5 / 5.5 mm) and projected back onto the texels, because the eyes are split
//     over small UV fragments that a UV-space blur would tear apart.
// Lossless WebP: lossy WebP is YUV 4:2:0 and would mix the packed channels.
{
  const emv = (i) => Math.max(em.data[i * 3], em.data[i * 3 + 1], em.data[i * 3 + 2]) / 255;
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = Math.round(emv(i) * 255);
  // sharp promotes 1-channel raw input to 3 channels on output: every grey read uses extractChannel(0).
  const rawGray = (data, w, h) => sharp(data, { raw: { width: w, height: h, channels: 1 } });
  const mask1024 = await rawGray(gray, W, H).resize(1024, 1024, { kernel: 'lanczos3' }).extractChannel(0).raw().toBuffer();
  const suit = [];
  for (const px of [8, 22, 48]) {
    const b = await rawGray(mask1024, 1024, 1024).blur(px).extractChannel(0).raw().toBuffer();
    for (let i = 0; i < b.length; i++) b[i] = Math.min(255, b[i] * 2);
    suit.push(await rawGray(b, 1024, 1024).resize(512, 512, { kernel: 'lanczos3' }).extractChannel(0).raw().toBuffer());
  }

  // hot core: emissive inside the H region and the eye outlines only
  const hot = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (Number.isNaN(x)) continue;
    const inH = Math.abs(x) < H_REGION.maxAbsX && y > H_REGION.y0 && y < H_REGION.y1 && z > H_REGION.minZ;
    const inEye = z > EYE_GLOW.minZ && Math.min(...[-EYE.x, EYE.x].map((cx) => Math.hypot((x - cx) / EYE_GLOW.rx, (y - EYE.y) / EYE_GLOW.ry))) < 1.2;
    if (inH || inEye) hot[i] = emv(i);
  }
  // front view: splat texels (z-buffered, 3 mm tolerance) into a 4000 px/m image of the box
  const FB = { x0: -0.08, x1: 0.08, y0: 1.26, y1: 1.66 }, RES = 4000;
  const FW = Math.round((FB.x1 - FB.x0) * RES), FH = Math.round((FB.y1 - FB.y0) * RES);
  const fpx = (i) => {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (Number.isNaN(x) || z < 0.09 || x < FB.x0 || x >= FB.x1 || y <= FB.y0 || y > FB.y1) return -1;
    return Math.min(FH - 1, Math.floor((FB.y1 - y) * RES)) * FW + Math.min(FW - 1, Math.floor((x - FB.x0) * RES));
  };
  const zbuf = new Float32Array(FW * FH).fill(-Infinity), front = new Uint8Array(FW * FH);
  for (let i = 0; i < W * H; i++) { const f = fpx(i); if (f >= 0) zbuf[f] = Math.max(zbuf[f], pos[i * 3 + 2]); }
  for (let i = 0; i < W * H; i++) {
    const f = fpx(i);
    if (f >= 0 && pos[i * 3 + 2] > zbuf[f] - 0.003) front[f] = Math.max(front[f], Math.round(hot[i] * 255));
  }
  if (process.env.HYDRA_FACE_FIX_DEBUG_DIR) await rawGray(front, FW, FH).png().toFile(`${process.env.HYDRA_FACE_FIX_DEBUG_DIR}/halo-front.png`);
  const hotLayers = [];
  for (const sigma of [0.0010, 0.0025, 0.0055]) {
    const b = await rawGray(front, FW, FH).blur(sigma * RES).extractChannel(0).raw().toBuffer();
    let mx = 1; for (let i = 0; i < b.length; i++) mx = Math.max(mx, b[i]);
    const L = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const f = fpx(i);
      if (f >= 0 && nz[i] > 0.15) L[i] = Math.round((b[f] / mx) * 255);
    }
    // grow 2 texels into texels no triangle covers (seam sampling), like the emissive padding above
    for (let pass = 0; pass < 2; pass++) {
      const grow = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!Number.isNaN(pos[i * 3])) continue;
        let m = L[i];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H) m = Math.max(m, L[yy * W + xx]);
        }
        if (m > L[i]) grow.push([i, m]);
      }
      for (const [i, m] of grow) L[i] = m;
    }
    hotLayers.push(await rawGray(L, W, H).resize(1024, 1024, { kernel: 'lanczos3' }).extractChannel(0).raw().toBuffer());
  }
  const pack = async (layers, size, file) => {
    const rgb = Buffer.alloc(size * size * 3);
    for (let i = 0; i < size * size; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = layers[c][i];
    await sharp(rgb, { raw: { width: size, height: size, channels: 3 } }).webp({ lossless: true, effort: 6 }).toFile(file);
    const lit = layers.map((l) => l.reduce((n, v) => n + (v > 2 ? 1 : 0), 0));
    console.log(`halo ${file}: texels > 2/255 per layer ${lit.join(' / ')}`);
    if (lit.some((n) => n < 200)) throw new Error(`halo layer is empty in ${file}`);
  };
  await pack(suit, 512, `${haloDir}/hydra-halo-suit.webp`);
  await pack(hotLayers, 1024, `${haloDir}/hydra-halo-hot.webp`);
}

const png = async (img) => new Uint8Array(await sharp(img.data, { raw: { width: W, height: H, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer());
texBase.setImage(await png(base)).setMimeType('image/png');
texEm.setImage(await png(em)).setMimeType('image/png');
texN.setImage(await png(nm)).setMimeType('image/png');
await io.write(outPath, doc);
console.log(`wrote ${outPath}`);
if (process.env.HYDRA_FACE_FIX_DEBUG_DIR) {
  const dir = process.env.HYDRA_FACE_FIX_DEBUG_DIR;
  for (const [n, img] of [['base', base], ['emissive', em], ['normal', nm]]) writeFileSync(`${dir}/${n}.png`, await png(img));
}
