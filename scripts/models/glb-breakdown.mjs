// Describe a GLB: where the bytes go (textures vs geometry), counts, extensions,
// attribute component types and texture sizes. Used by glb-compare.mjs for the
// structural before/after check.
// Usage: node scripts/models/glb-breakdown.mjs <file.glb> [...]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const COMPONENT = { 5126: 'f32', 5122: 'i16', 5120: 'i8', 5123: 'u16', 5121: 'u8', 5125: 'u32' };

function ktx2Info(buf) {
  // KTX2 header: pixelWidth @20, pixelHeight @24, supercompressionScheme @44.
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const scheme = dv.getUint32(44, true);
  return { w: dv.getUint32(20, true), h: dv.getUint32(24, true), codec: scheme === 1 ? 'etc1s' : scheme === 0 ? 'uastc' : 'uastc-zstd' };
}

function glbJson(file) {
  const b = readFileSync(file);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
}

export async function describeGlb(file) {
  const json = glbJson(file);
  const doc = await io.read(file);
  const root = doc.getRoot();
  const textures = root.listTextures().map((t) => {
    const img = t.getImage();
    if (t.getMimeType() === 'image/ktx2' && img) { const k = ktx2Info(img); return { name: t.getName(), mime: 'ktx2', codec: k.codec, w: k.w, h: k.h, bytes: img.byteLength }; }
    const s = t.getSize();
    return { name: t.getName(), mime: t.getMimeType().replace('image/', ''), codec: null, w: s?.[0] ?? 0, h: s?.[1] ?? 0, bytes: img?.byteLength ?? 0 };
  });
  let verts = 0, tris = 0;
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
    const n = p.getAttribute('POSITION')?.getCount() ?? 0; verts += n;
    const idx = p.getIndices(); tris += (idx ? idx.getCount() : n) / 3;
  }
  const attributes = {};
  for (const m of json.meshes ?? []) for (const p of m.primitives) for (const [k, i] of Object.entries(p.attributes)) {
    const a = json.accessors[i]; const key = `${k}:${COMPONENT[a.componentType] ?? a.componentType}${a.normalized ? 'n' : ''}`;
    attributes[key] = (attributes[key] ?? 0) + 1;
  }
  return {
    file, bytes: statSync(file).size,
    meshes: root.listMeshes().length, primitives: (json.meshes ?? []).reduce((s, m) => s + m.primitives.length, 0),
    materials: root.listMaterials().length, verts, tris: Math.round(tris),
    extensions: [...(json.extensionsUsed ?? [])].sort(),
    attributes, textures, textureBytes: textures.reduce((s, t) => s + t.bytes, 0),
  };
}

// Attribute semantic -> list of component types, e.g. { NORMAL: ['i16n', 'i16n'] }.
function typesBySemantic(attrs) {
  const out = {};
  for (const [k, n] of Object.entries(attrs)) { const [sem, ty] = k.split(':'); (out[sem] ??= []).push(...Array(n).fill(ty)); }
  for (const s in out) out[s].sort();
  return out;
}
const BITS = { f32: 32, u32: 32, i16: 16, u16: 16, i8: 8, u8: 8 };
const bits = (t) => BITS[t.replace(/n$/, '')] ?? 0;

// Structural before/after check. Blocks: different vertex or triangle count,
// primitive or material count, or any attribute stored at fewer bits than before.
export function structuralDiff(a, b) {
  const blocks = [], notes = [];
  for (const k of ['verts', 'tris', 'primitives', 'materials']) if (a[k] !== b[k]) blocks.push(`${k} ${a[k]} -> ${b[k]}`);
  const ta = typesBySemantic(a.attributes), tb = typesBySemantic(b.attributes);
  for (const sem of new Set([...Object.keys(ta), ...Object.keys(tb)])) {
    const x = ta[sem] ?? [], y = tb[sem] ?? [];
    if (x.length !== y.length) { (sem.startsWith('TANGENT') ? notes : blocks).push(`${sem} count ${x.length} -> ${y.length}`); continue; }
    const minA = Math.min(...x.map(bits)), minB = Math.min(...y.map(bits));
    if (minB < minA) notes.push(`${sem} stored at fewer bits: ${[...new Set(x)].join(',')} -> ${[...new Set(y)].join(',')} (the geometry check measures the error)`);
    else if (x.join() !== y.join()) notes.push(`${sem} ${[...new Set(x)].join(',')} -> ${[...new Set(y)].join(',')}`);
  }
  const ea = a.extensions.join(), eb = b.extensions.join();
  if (ea !== eb) notes.push(`extensions [${ea}] -> [${eb}]`);
  const dims = (d) => { const m = new Map(); for (const t of d.textures) { const k = `${t.w}x${t.h} ${t.codec ?? t.mime}`; m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort().map(([k, n]) => `${k} x${n}`).join(', '); };
  if (dims(a) !== dims(b)) notes.push(`textures ${dims(a)}  ->  ${dims(b)}`);
  return { blocks, notes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const file of process.argv.slice(2)) {
    const d = await describeGlb(file);
    console.log(`\n== ${file}`);
    console.log(`total ${(d.bytes / 1048576).toFixed(2)} MB | textures ${(d.textureBytes / 1048576).toFixed(2)} MB (${d.textures.length}) | other ${((d.bytes - d.textureBytes) / 1048576).toFixed(2)} MB`);
    console.log(`meshes ${d.meshes} primitives ${d.primitives} materials ${d.materials} verts ${d.verts} tris ${d.tris}`);
    console.log(`extensions: ${d.extensions.join(', ')}`);
    console.log(`attributes: ${Object.entries(d.attributes).map(([k, v]) => `${k}x${v}`).join(' ')}`);
    for (const t of [...d.textures].sort((x, y) => y.bytes - x.bytes)) console.log(`  ${String(Math.round(t.bytes / 1024)).padStart(5)} KB ${t.mime} ${t.codec ?? ''} ${t.w}x${t.h} ${t.name ?? ''}`);
  }
}

// Numeric geometry check. Decodes both files, puts every vertex in world space
// (so KHR_mesh_quantization node transforms are included), matches each AFTER
// vertex to the nearest BEFORE vertex of the same node/primitive, and reports:
//   pos  : largest position error / bounding-box diagonal
//   normal: largest normal angle (degrees)
//   uv   : largest TEXCOORD_0 error (UV units; 1/2048 = one texel of a 2048 map)
export async function geometryDiff(fileA, fileB) {
  const [da, db] = [await io.read(fileA), await io.read(fileB)];
  const collect = (doc) => {
    const out = [];
    for (const node of doc.getRoot().listNodes()) {
      const mesh = node.getMesh(); if (!mesh) continue;
      const m = node.getWorldMatrix();
      // normal matrix = inverse-transpose of the upper 3x3
      const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
      const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
      const inv = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
      mesh.listPrimitives().forEach((p, pi) => {
        const P = p.getAttribute('POSITION'), N = p.getAttribute('NORMAL'), T = p.getAttribute('TEXCOORD_0');
        const n = P.getCount(); const pos = new Float64Array(n * 3), nor = N ? new Float64Array(n * 3) : null, uv = T ? new Float64Array(n * 2) : null;
        const v = [0, 0, 0], w = [0, 0, 0], t = [0, 0];
        for (let k = 0; k < n; k++) {
          P.getElement(k, v);
          pos[k * 3] = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
          pos[k * 3 + 1] = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
          pos[k * 3 + 2] = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
          if (nor) {
            N.getElement(k, w);
            // inverse-transpose: row r of inv^T = column r of inv
            const x = inv[0] * w[0] + inv[1] * w[1] + inv[2] * w[2], y = inv[3] * w[0] + inv[4] * w[1] + inv[5] * w[2], z = inv[6] * w[0] + inv[7] * w[1] + inv[8] * w[2];
            const L = Math.hypot(x, y, z) || 1; nor[k * 3] = x / L; nor[k * 3 + 1] = y / L; nor[k * 3 + 2] = z / L;
          }
          if (uv) { T.getElement(k, t); uv[k * 2] = t[0]; uv[k * 2 + 1] = t[1]; }
        }
        out.push({ key: `${node.getName() || ''}#${pi}`, n, pos, nor, uv });
      });
    }
    return out;
  };
  const A = collect(da), B = collect(db);
  if (A.length !== B.length) return { error: `primitive instance count ${A.length} -> ${B.length}` };
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of A) for (let k = 0; k < p.n; k++) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p.pos[k * 3 + c]); hi[c] = Math.max(hi[c], p.pos[k * 3 + c]); }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const cell = diag * 1e-3; let maxPos = 0, maxAng = 0, maxUv = 0;
  for (let q = 0; q < A.length; q++) {
    const a = A[q], b = B[q];
    if (a.n !== b.n) return { error: `primitive ${q} vertex count ${a.n} -> ${b.n}` };
    const grid = new Map(); const keyOf = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (let k = 0; k < a.n; k++) { const kk = keyOf(a.pos[k * 3], a.pos[k * 3 + 1], a.pos[k * 3 + 2]); let l = grid.get(kk); if (!l) grid.set(kk, (l = [])); l.push(k); }
    for (let k = 0; k < b.n; k++) {
      const x = b.pos[k * 3], y = b.pos[k * 3 + 1], z = b.pos[k * 3 + 2];
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      const cand = []; let best = Infinity;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let l = -1; l <= 1; l++) for (const idx of grid.get(`${cx + i},${cy + j},${cz + l}`) ?? []) {
        const dd = Math.hypot(a.pos[idx * 3] - x, a.pos[idx * 3 + 1] - y, a.pos[idx * 3 + 2] - z); cand.push([idx, dd]); best = Math.min(best, dd);
      }
      if (!cand.length) { maxPos = Math.max(maxPos, cell * 2); continue; }
      maxPos = Math.max(maxPos, best);
      // Among co-located BEFORE vertices (seams share positions), take the best normal + UV match.
      let ang = Infinity, duv = Infinity;
      for (const [idx, dd] of cand) {
        if (dd > best + diag * 1e-5) continue;
        if (a.nor && b.nor) { const dot = a.nor[idx * 3] * b.nor[k * 3] + a.nor[idx * 3 + 1] * b.nor[k * 3 + 1] + a.nor[idx * 3 + 2] * b.nor[k * 3 + 2]; ang = Math.min(ang, Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI); } else ang = 0;
        if (a.uv && b.uv) duv = Math.min(duv, Math.max(Math.abs(a.uv[idx * 2] - b.uv[k * 2]), Math.abs(a.uv[idx * 2 + 1] - b.uv[k * 2 + 1]))); else duv = 0;
      }
      maxAng = Math.max(maxAng, ang); maxUv = Math.max(maxUv, duv);
    }
  }
  return { posErrOfDiag: maxPos / diag, normalDeg: maxAng, uvErr: maxUv };
}

// Texture-only file: BEFORE's geometry with AFTER's texture images, matched by
// material (name when names are unique, else index) and slot. Rendering BEFORE
// against this file shows only the texture change, with no geometry noise.
export async function texturesOnto(fileA, fileB, outFile) {
  const { KHRTextureBasisu, EXTTextureWebP, EXTTextureAVIF } = await import('@gltf-transform/extensions');
  const [da, db] = [await io.read(fileA), await io.read(fileB)];
  const ma = da.getRoot().listMaterials(), mb = db.getRoot().listMaterials();
  if (ma.length !== mb.length) throw new Error(`material count ${ma.length} -> ${mb.length}`);
  const names = mb.map((m) => m.getName());
  const unique = names.every((n) => n && names.indexOf(n) === names.lastIndexOf(n));
  const byName = new Map(mb.map((m) => [m.getName(), m]));
  const used = new Set(db.getRoot().listExtensionsUsed().map((e) => e.extensionName));
  if (used.has('KHR_texture_basisu')) da.createExtension(KHRTextureBasisu).setRequired(true);
  if (used.has('EXT_texture_webp')) da.createExtension(EXTTextureWebP).setRequired(true);
  if (used.has('EXT_texture_avif')) da.createExtension(EXTTextureAVIF).setRequired(true);
  const SLOTS = ['BaseColor', 'MetallicRoughness', 'Normal', 'Occlusion', 'Emissive'];
  const copies = new Map();
  ma.forEach((a, i) => {
    const b = unique ? byName.get(a.getName()) : mb[i];
    if (!b) throw new Error(`no AFTER material for "${a.getName()}"`);
    for (const s of SLOTS) {
      const tb = b[`get${s}Texture`]();
      if (!a[`get${s}Texture`]()) { if (tb) throw new Error(`AFTER adds a ${s} texture on "${a.getName()}"`); continue; }
      if (!tb) { a[`set${s}Texture`](null); continue; }
      let t = copies.get(tb);
      if (!t) { t = da.createTexture(tb.getName()).setImage(tb.getImage().slice()).setMimeType(tb.getMimeType()); copies.set(tb, t); }
      a[`set${s}Texture`](t);
    }
  });
  for (const t of da.getRoot().listTextures()) if (!copies.has(t) && ![...copies.values()].includes(t) && t.listParents().every((p) => p.propertyType === 'Root')) t.dispose();
  await io.write(outFile, da);
}
