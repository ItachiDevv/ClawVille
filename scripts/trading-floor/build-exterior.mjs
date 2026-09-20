#!/usr/bin/env node
// build-exterior.mjs — turn the raw Meshy text-to-3d hall into a shippable
// ClawVille building GLB.
//
// Meshy returns ONE merged primitive that includes a large ground slab, and
// three 2048x2048 JPEG maps (7.3 MB). The ring pipeline in arena-buildings.tsx
// normalises a building by its post-strip bbox, and its runtime
// stripGroundPlanes() works per-MESH-NODE, so it CANNOT remove a slab that is
// fused into the same primitive as the walls. The slab therefore has to be cut
// here or every scale calculation downstream is measured against the slab.
//
// Pipeline:
//   1. cut  — drop triangles fully below --ycut (the slab) and any whose
//             centroid XZ radius exceeds --rcut (outlying coral islands)
//   2. compact — rebuild the vertex stream over surviving triangles only
//   3. simplify — meshoptimizer decimation to --tris
//   4. place — recentre XZ on the bbox, ground so min.y = 0
//   5. sign — append two baked unlit sign quads (lintel wordmark + roof claw)
//   6. slim — drop normal + metallicRoughness maps, resize baseColor
//
// KTX2 + meshopt are applied afterwards by build-exterior.sh, using the repo's
// proven `@gltf-transform/cli etc1s` + meshopt recipe (texture commands decode
// meshopt, so geometry compression must come last).
//
// Usage:
//   node scripts/trading-floor/build-exterior.mjs <in.glb> <out.glb> [--dry] [...]

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { simplify, prune, dedup } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const [input, output] = argv;
if (!input) throw new Error('usage: build-exterior.mjs <in.glb> <out.glb> [--dry]');
const DRY = argv.includes('--dry');
const num = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const str = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

// The slab reaches X +/-0.93 and Z +0.75, while the hall itself measures
// X[-0.677, 0.613] Z[-0.810, 0.215] (measured from the y>-0.30 slice, where the
// footprint stops changing with height = walls only). A radius cut cannot
// separate them because the slab corners sit at r~0.93, inside the hall's own
// diagonal. An explicit AABB can.
const Y_CUT = num('ycut', -0.425);
const KEEP_X0 = num('x0', -0.72);
const KEEP_X1 = num('x1', 0.66);
const KEEP_Z0 = num('z0', -0.86);
const KEEP_Z1 = num('z1', 0.45);
const TARGET_TRIS = num('tris', 11000);
const BASECOLOR_PX = num('tex', 1024);
const CLAW_PNG = str('claw', 'apps/web/public/assets/slot-symbols/claw.png');

// Sign placement, expressed as fractions of the post-cut model so the numbers
// survive a re-roll of the Meshy mesh at a different absolute size.
const LINTEL_W = num('lintel-w', 0.46);   // fraction of model width
const LINTEL_H = num('lintel-h', 0.085);  // fraction of model height
const LINTEL_Y = num('lintel-y', 0.585);  // fraction of model height
const CLAW_W = num('claw-w', 0.46);
const CLAW_H = num('claw-h', 0.38);
// Measured ridge profile at |x|<0.12: the dome apex is y~0.995 around z 0..0.14
// and the crab finial on the front slope tops out level with it. Seating the
// plaque so its lower edge sinks just under that apex reads as mounted; any
// higher and it reads as a floating error.
const CLAW_Y = num('claw-y', 1.12);
const CLAW_Z = num('claw-z', -0.06);

// v2 landmark: a SOLID 3D claw replaces the flat plaque. Pass --claw3d <glb>.
// The plaque read as a floating poster from the side and its crossed quad
// showed a seam line; a real prop has volume from every ring approach.
// Sized so its TOP lands on the same Y the plaque topped out at, which keeps
// the scene bbox (and therefore every targetMaxDim number already handed to
// the scene code) byte-for-byte valid.
const CLAW3D = str('claw3d', null);
const CLAW3D_TRIS = num('claw3d-tris', 2200);
const CLAW3D_BASE_Y = num('claw3d-base-y', 0.88); // fraction of model height
const CLAW3D_TOP_Y = num('claw3d-top-y', 1.3046); // = old plaque top edge
const CLAW3D_Z = num('claw3d-z', 0.02);
// The claw is broadly planar (0.351 wide x 0.186 deep once fitted), so at yaw 0
// the side-on ring approach sees one finger edge and it reads as a green blade.
// A 30deg yaw keeps ~87% of the width facing the entrance (+Z, where players
// approach slot 6 from the village centre) while giving the side view real
// silhouette. Rotated AABB is ~0.397 x 0.337, still far inside the building
// footprint, so the scene bbox does not move.
const CLAW3D_ROT_Y = num('claw3d-rot-y', 0.52);

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const doc = await io.read(input);
const root = doc.getRoot();
const mesh = root.listMeshes()[0];
const prim = mesh.listPrimitives()[0];

// ---------------------------------------------------------------- 1. cut ----
const pos = prim.getAttribute('POSITION');
const idxAcc = prim.getIndices();
const triCount = idxAcc ? idxAcc.getCount() / 3 : pos.getCount() / 3;
const gi = (i) => (idxAcc ? idxAcc.getScalar(i) : i);

const P = new Float32Array(pos.getCount() * 3);
{
  const v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); P[i * 3] = v[0]; P[i * 3 + 1] = v[1]; P[i * 3 + 2] = v[2]; }
}

const keptTris = [];
for (let t = 0; t < triCount; t++) {
  const a = gi(t * 3), b = gi(t * 3 + 1), c = gi(t * 3 + 2);
  const ay = P[a * 3 + 1], by = P[b * 3 + 1], cy = P[c * 3 + 1];
  if (ay <= Y_CUT && by <= Y_CUT && cy <= Y_CUT) continue;          // slab
  const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3;
  const cz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
  if (cx < KEEP_X0 || cx > KEEP_X1 || cz < KEEP_Z0 || cz > KEEP_Z1) continue; // outliers
  keptTris.push(t);
}
console.log(`cut: ${triCount} -> ${keptTris.length} tris (ycut=${Y_CUT} keep X[${KEEP_X0},${KEEP_X1}] Z[${KEEP_Z0},${KEEP_Z1}])`);

// ------------------------------------------------------------ 2. compact ----
const semantics = prim.listSemantics();
const srcAttrs = Object.fromEntries(semantics.map((s) => [s, prim.getAttribute(s)]));
const remap = new Map();
const order = [];
const newIdx = new Uint32Array(keptTris.length * 3);
for (const [n, t] of keptTris.entries()) {
  for (let k = 0; k < 3; k++) {
    const o = gi(t * 3 + k);
    let m = remap.get(o);
    if (m === undefined) { m = order.length; remap.set(o, m); order.push(o); }
    newIdx[n * 3 + k] = m;
  }
}
for (const s of semantics) {
  const src = srcAttrs[s];
  const comps = src.getElementSize();
  const arr = new Float32Array(order.length * comps);
  const el = new Array(comps).fill(0);
  for (const [m, o] of order.entries()) { src.getElement(o, el); for (let c = 0; c < comps; c++) arr[m * comps + c] = el[c]; }
  prim.setAttribute(s, doc.createAccessor(s).setType(src.getType()).setArray(arr));
}
prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(newIdx));
console.log(`compact: ${pos.getCount()} -> ${order.length} verts`);

// ----------------------------------------------------------- 3. simplify ----
const preTris = keptTris.length;
if (preTris > TARGET_TRIS) {
  await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: TARGET_TRIS / preTris, error: 0.0012, lockBorder: false }));
}
const afterPrim = root.listMeshes()[0].listPrimitives()[0];
console.log(`simplify: ${preTris} -> ${afterPrim.getIndices().getCount() / 3} tris`);

// --------------------------------------------------------------- 4. place ---
const fp = afterPrim.getAttribute('POSITION');
const fa = fp.getArray();
let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
for (let i = 0; i < fa.length; i += 3) {
  if (fa[i] < mnx) mnx = fa[i]; if (fa[i] > mxx) mxx = fa[i];
  if (fa[i + 1] < mny) mny = fa[i + 1]; if (fa[i + 1] > mxy) mxy = fa[i + 1];
  if (fa[i + 2] < mnz) mnz = fa[i + 2]; if (fa[i + 2] > mxz) mxz = fa[i + 2];
}
const offX = (mnx + mxx) / 2, offZ = (mnz + mxz) / 2, offY = mny;
for (let i = 0; i < fa.length; i += 3) { fa[i] -= offX; fa[i + 1] -= offY; fa[i + 2] -= offZ; }
fp.setArray(fa);
const W = mxx - mnx, H = mxy - mny, D = mxz - mnz;
console.log(`place: bbox size=[${W.toFixed(3)}, ${H.toFixed(3)}, ${D.toFixed(3)}] (centred XZ, grounded Y)`);

// Probe the front wall plane (+Z face) near the door column so the lintel sign
// sits ON the stone instead of floating in front of or sunk behind it.
let frontZ = -Infinity;
for (let i = 0; i < fa.length; i += 3) {
  const y = fa[i + 1] / H;
  if (Math.abs(fa[i]) < W * 0.14 && y > LINTEL_Y - 0.08 && y < LINTEL_Y + 0.08) {
    if (fa[i + 2] > frontZ) frontZ = fa[i + 2];
  }
}
console.log(`probe: front wall Z at lintel band = ${frontZ.toFixed(4)} (model +Z is the entrance side)`);

// Roof profile along Z at the ridge, so the claw plaque can be sunk far enough
// to look mounted without spearing the crab finial Meshy put on the front slope.
{
  const bands = 8;
  const out = [];
  for (let bi = 0; bi < bands; bi++) {
    const z0 = mnz - offZ + ((mxz - mnz) * bi) / bands;
    const z1 = mnz - offZ + ((mxz - mnz) * (bi + 1)) / bands;
    let top = -Infinity;
    for (let i = 0; i < fa.length; i += 3) {
      if (Math.abs(fa[i]) < W * 0.09 && fa[i + 2] >= z0 && fa[i + 2] < z1 && fa[i + 1] > top) top = fa[i + 1];
    }
    out.push(`z[${z0.toFixed(2)}..${z1.toFixed(2)}]=${Number.isFinite(top) ? top.toFixed(3) : '-'}`);
  }
  console.log(`probe: ridge maxY by Z band (|x|<${(W * 0.09).toFixed(2)}): ${out.join(' ')}`);
}

if (DRY) { console.log('--dry: stopping before sign + texture work'); process.exit(0); }

// ---------------------------------------------------------------- 5. sign ---
const unlitExt = doc.createExtension(KHRMaterialsUnlit);
const buffer = root.listBuffers()[0];

async function makeWordmarkPng(text, w = 1024, h = 256) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#16323f"/><stop offset="100%" stop-color="#0a1d27"/>
  </linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <rect x="10" y="10" width="${w - 20}" height="${h - 20}" fill="none" stroke="#3ddc97" stroke-width="7" rx="18"/>
  <text x="${w / 2}" y="${h / 2 + 2}" font-family="Arial Black, Arial, sans-serif" font-size="104"
        font-weight="bold" letter-spacing="6" fill="#6affb4" text-anchor="middle"
        dominant-baseline="middle">${text}</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function makeClawPlaquePng(size = 512) {
  // Recolour the shipped ClawVille claw sticker red -> brand green. sharp's
  // tint preserves luminance, so the sculpted shading survives the hue change.
  const claw = await sharp(readFileSync(CLAW_PNG))
    .resize(Math.round(size * 0.78), Math.round(size * 0.78), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .tint({ r: 90, g: 255, b: 150 })
    .toBuffer();
  const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${size * 0.12}" fill="#0c2430"/>
  <rect x="${size * 0.035}" y="${size * 0.035}" width="${size * 0.93}" height="${size * 0.93}"
        rx="${size * 0.09}" fill="none" stroke="#3ddc97" stroke-width="${size * 0.022}"/>
</svg>`;
  return sharp(Buffer.from(bg))
    .composite([{ input: claw, gravity: 'centre' }])
    .png()
    .toBuffer();
}

function addSignQuad(name, pngBuffer, w, h, cx, cy, cz, cross = false) {
  const tex = doc.createTexture(name + 'Tex').setImage(pngBuffer).setMimeType('image/png');
  const mat = doc
    .createMaterial(name + 'Mtl')
    .setBaseColorTexture(tex)
    .setRoughnessFactor(1)
    .setMetallicFactor(0)
    .setDoubleSided(true);
  mat.setExtension('KHR_materials_unlit', unlitExt.createUnlit());

  const hw = w / 2, hh = h / 2;
  // Facing +Z. `cross` adds the same quad rotated -90deg about Y ((x,y,z) ->
  // (-z,y,x)) so a rooftop landmark still reads when the ring camera is
  // side-on; a single plane goes edge-on and vanishes from half the approaches.
  const planes = cross
    ? [
        [-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, hh, 0],
        [0, -hh, -hw, 0, -hh, hw, 0, hh, hw, 0, hh, -hw],
      ]
    : [[-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, hh, 0]];
  const normalsFor = [
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    [-1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0],
  ];
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

  const m = doc.createMesh(name);
  for (const [pi, verts] of planes.entries()) {
    const p = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(verts)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(normalsFor[pi])).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uvs.slice()).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices.slice()).setBuffer(buffer))
      .setMaterial(mat);
    m.addPrimitive(p);
  }
  const node = doc.createNode(name).setMesh(m).setTranslation([cx, cy, cz]);
  root.listScenes()[0].addChild(node);
  return node;
}

// Lintel wordmark — flush to the front wall, just proud of the stone.
addSignQuad(
  'TradingFloorLintelSign',
  await makeWordmarkPng('TRADING FLOOR'),
  W * LINTEL_W,
  H * LINTEL_H,
  0,
  H * LINTEL_Y,
  frontZ + 0.004
);

// Roof claw — the long-range landmark.
if (CLAW3D) {
  await addClaw3D(CLAW3D);
} else {
  // Legacy v1 plaque: upright quad above the dome, crossed so it reads from
  // every approach on the ring.
  addSignQuad('TradingFloorClawSign', await makeClawPlaquePng(), W * CLAW_W, H * CLAW_H, 0, H * CLAW_Y, CLAW_Z, true);
}

async function addClaw3D(path) {
  const src = await io.read(path);
  const sprim0 = src.getRoot().listMeshes()[0].listPrimitives()[0];
  const srcTris = sprim0.getIndices().getCount() / 3;
  await src.transform(
    simplify({ simplifier: MeshoptSimplifier, ratio: CLAW3D_TRIS / srcTris, error: 0.02, lockBorder: false })
  );
  const sp = src.getRoot().listMeshes()[0].listPrimitives()[0];
  const arr = sp.getAttribute('POSITION').getArray();

  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < arr.length; i += 3) {
    if (arr[i] < mnx) mnx = arr[i]; if (arr[i] > mxx) mxx = arr[i];
    if (arr[i + 1] < mny) mny = arr[i + 1]; if (arr[i + 1] > mxy) mxy = arr[i + 1];
    if (arr[i + 2] < mnz) mnz = arr[i + 2]; if (arr[i + 2] > mxz) mxz = arr[i + 2];
  }
  const baseY = H * CLAW3D_BASE_Y;
  const topY = H * CLAW3D_TOP_Y;
  const s = (topY - baseY) / (mxy - mny);
  const cx = (mnx + mxx) / 2, cz = (mnz + mxz) / 2;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 3) {
    out[i] = (arr[i] - cx) * s;
    out[i + 1] = (arr[i + 1] - mny) * s;
    out[i + 2] = (arr[i + 2] - cz) * s;
  }

  // Factor-only material: the source art is a flat brand colour, so a texture
  // buys nothing here and the 2048 map would cost more than the whole prop.
  // Emissive carries the "glowing green landmark" read while the PBR term keeps
  // the sculpted form shaded — an unlit material would flatten a 3D object.
  const m = doc
    .createMaterial('TradingFloorClawMtl')
    // glTF baseColorFactor is LINEAR, not sRGB. Brand green #3ddc97 converts to
    // ~[0.046, 0.723, 0.312]; that plus the emissive term rendered pale mint,
    // so this is deliberately a stop deeper to land on emerald.
    .setBaseColorFactor([0.06, 0.58, 0.28, 1])
    // Kept deliberately low. At [0.10, 0.50, 0.26] the prop washed out to pale
    // mint under a bright key; the world it actually ships into is a dark blue
    // underwater scene where a modest emissive term already reads as glowing.
    .setEmissiveFactor([0.04, 0.20, 0.11])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.55);

  const p = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(out).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(sp.getIndices().getArray())).setBuffer(buffer))
    .setMaterial(m);
  const nrm = sp.getAttribute('NORMAL');
  if (nrm) p.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm.getArray())).setBuffer(buffer));

  const mesh3 = doc.createMesh('TradingFloorClawProp').addPrimitive(p);
  const half = CLAW3D_ROT_Y / 2;
  root.listScenes()[0].addChild(
    doc
      .createNode('TradingFloorClawProp')
      .setMesh(mesh3)
      .setTranslation([0, baseY, CLAW3D_Z])
      .setRotation([0, Math.sin(half), 0, Math.cos(half)])
  );
  console.log(
    `claw3d: ${srcTris} -> ${sp.getIndices().getCount() / 3} tris, ` +
      `fitted=[${((mxx - mnx) * s).toFixed(3)}, ${((mxy - mny) * s).toFixed(3)}, ${((mxz - mnz) * s).toFixed(3)}] ` +
      `base y=${baseY.toFixed(3)} top y=${topY.toFixed(3)}`
  );
}

mesh.setName('TradingFloorHall');
for (const n of root.listNodes()) if (!n.getName()) n.setName('TradingFloorHallNode');

// ---------------------------------------------------------------- 6. slim ---
for (const mat of root.listMaterials()) {
  if (mat.getName().startsWith('TradingFloorLintel') || mat.getName().startsWith('TradingFloorClaw')) continue;
  mat.setNormalTexture(null);
  mat.setMetallicRoughnessTexture(null);
  mat.setOcclusionTexture(null);
  mat.setMetallicFactor(0);
  mat.setRoughnessFactor(0.88);
  const bct = mat.getBaseColorTexture();
  if (bct) {
    const img = bct.getImage();
    const resized = await sharp(Buffer.from(img)).resize(BASECOLOR_PX, BASECOLOR_PX, { fit: 'fill' }).png().toBuffer();
    bct.setImage(resized).setMimeType('image/png');
  }
}

await doc.transform(dedup(), prune());

for (const t of root.listTextures()) {
  const meta = await sharp(Buffer.from(t.getImage())).metadata();
  console.log(`texture "${t.getName()}" ${t.getMimeType()} ${meta.width}x${meta.height} ${(t.getImage().byteLength / 1024).toFixed(0)}K`);
}

await io.write(output, doc);
console.log(`wrote ${output}`);
