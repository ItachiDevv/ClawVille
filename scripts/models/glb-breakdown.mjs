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
    console.log(`total ${d.bytes.toLocaleString('en-US')} bytes (${(d.bytes / 1e6).toFixed(3)} MB) | textures ${(d.textureBytes / 1e6).toFixed(3)} MB (${d.textures.length}) | other ${((d.bytes - d.textureBytes) / 1e6).toFixed(3)} MB`);
    console.log(`meshes ${d.meshes} primitives ${d.primitives} materials ${d.materials} verts ${d.verts} tris ${d.tris}`);
    console.log(`extensions: ${d.extensions.join(', ')}`);
    console.log(`attributes: ${Object.entries(d.attributes).map(([k, v]) => `${k}x${v}`).join(' ')}`);
    for (const t of [...d.textures].sort((x, y) => y.bytes - x.bytes)) console.log(`  ${String(Math.round(t.bytes / 1024)).padStart(5)} KB ${t.mime} ${t.codec ?? ''} ${t.w}x${t.h} ${t.name ?? ''}`);
  }
}

// Numeric geometry check. Decodes both files, puts every vertex in world space
// (so KHR_mesh_quantization node transforms are included) and, per node and
// primitive (same order in both files), matches each AFTER vertex to the BEFORE
// vertex that best fits position, normal and UV together. Reports:
//   pos   : largest position error / bounding-box diagonal
//   normal: largest normal angle (degrees)
//   uv    : largest TEXCOORD_0 error (UV units; 1/2048 = one texel of a 2048 map)
//   triangleMismatch: triangles (and line / point elements) whose matched
//     corners differ from BEFORE: a lost or moved vertex, a collapsed or
//     re-wound triangle. BEFORE vertices within a tenth of every limit count as
//     one, so dedup and quantization do not cause a mismatch.
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
        const I = p.getIndices(); const idx = I ? Array.from(I.getArray()) : Array.from({ length: n }, (_, k) => k);
        out.push({ key: `${node.getName() || ''}#${pi}`, mode: p.getMode(), n, pos, nor, uv, idx });
      });
    }
    return out;
  };
  const A = collect(da), B = collect(db);
  if (A.length !== B.length) return { error: `primitive instance count ${A.length} -> ${B.length}` };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of A) for (let k = 0; k < p.n; k++) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p.pos[k * 3 + c]); hi[c] = Math.max(hi[c], p.pos[k * 3 + c]); }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const cell = diag * 1e-3;
  // maxPos is already a fraction of the diagonal (dd below is divided by diag).
  let maxPos = 0, maxAng = 0, maxUv = 0, triangleMismatch = 0, unmatched = 0, nonTriangle = 0;
  const angOf = (a, i, b, k) => (a.nor && b.nor ? Math.acos(Math.max(-1, Math.min(1, a.nor[i * 3] * b.nor[k * 3] + a.nor[i * 3 + 1] * b.nor[k * 3 + 1] + a.nor[i * 3 + 2] * b.nor[k * 3 + 2]))) * 180 / Math.PI : 0);
  const uvOf = (a, i, b, k) => (a.uv && b.uv ? Math.max(Math.abs(a.uv[i * 2] - b.uv[k * 2]), Math.abs(a.uv[i * 2 + 1] - b.uv[k * 2 + 1])) : 0);
  for (let q = 0; q < A.length; q++) {
    const a = A[q], b = B[q];
    const grid = new Map(); const keyOf = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (let k = 0; k < a.n; k++) { const kk = keyOf(a.pos[k * 3], a.pos[k * 3 + 1], a.pos[k * 3 + 2]); let l = grid.get(kk); if (!l) grid.set(kk, (l = [])); l.push(k); }
    // BEFORE vertices within a tenth of each limit of one representative vertex
    // form one class (quantization can make such near-copies identical, so
    // matching either one is correct). Members must be close to the
    // representative itself, not to another member, so a class can never chain:
    // its diameter stays under two tenths of each limit.
    const cls = new Int32Array(a.n).fill(-1);
    for (let k = 0; k < a.n; k++) {
      const cx = Math.floor(a.pos[k * 3] / cell), cy = Math.floor(a.pos[k * 3 + 1] / cell), cz = Math.floor(a.pos[k * 3 + 2] / cell);
      let rep = k;
      for (let i = -1; i <= 1 && rep === k; i++) for (let j = -1; j <= 1 && rep === k; j++) for (let l = -1; l <= 1 && rep === k; l++) for (const o of grid.get(`${cx + i},${cy + j},${cz + l}`) ?? []) {
        if (o >= k || cls[o] !== o) continue; // only earlier representatives
        const dd = Math.hypot(a.pos[o * 3] - a.pos[k * 3], a.pos[o * 3 + 1] - a.pos[k * 3 + 1], a.pos[o * 3 + 2] - a.pos[k * 3 + 2]) / diag;
        if (dd < 1e-5 && angOf(a, o, a, k) < 0.01 && uvOf(a, o, a, k) < 1 / 81920) { rep = o; break; }
      }
      cls[k] = rep;
    }
    const match = new Int32Array(b.n).fill(-1);
    for (let k = 0; k < b.n; k++) {
      const x = b.pos[k * 3], y = b.pos[k * 3 + 1], z = b.pos[k * 3 + 2];
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      let bestScore = Infinity, bi = -1, bd = 0, ba = 0, bu = 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let l = -1; l <= 1; l++) for (const ai of grid.get(`${cx + i},${cy + j},${cz + l}`) ?? []) {
        const dd = Math.hypot(a.pos[ai * 3] - x, a.pos[ai * 3 + 1] - y, a.pos[ai * 3 + 2] - z) / diag, an = angOf(a, ai, b, k), du = uvOf(a, ai, b, k);
        // One score for all three errors, each scaled by its limit.
        const sc = Math.max(dd / 1e-4, an / 0.1, du * 8192);
        if (sc < bestScore) { bestScore = sc; bi = ai; bd = dd; ba = an; bu = du; }
      }
      if (bi < 0) { unmatched++; continue; }
      match[k] = cls[bi]; maxPos = Math.max(maxPos, bd); maxAng = Math.max(maxAng, ba); maxUv = Math.max(maxUv, bu);
    }
    if (a.mode !== b.mode) { triangleMismatch++; continue; }
    // Primitive elements as matched BEFORE classes. Triangles keep their winding
    // (rotated to the smallest class); lines are unordered pairs; points single.
    // Elements whose corners share a class have zero size and draw nothing, so
    // they are skipped on both sides.
    const arity = { 0: 1, 1: 2, 4: 3 }[a.mode];
    if (!arity) { nonTriangle++; continue; }
    const elem = (c) => {
      if (new Set(c).size !== c.length) return null;
      if (arity === 3) { const r = c.indexOf(Math.min(...c)); return `${c[r]},${c[(r + 1) % 3]},${c[(r + 2) % 3]}`; }
      return [...c].sort((x, y) => x - y).join(',');
    };
    const count = new Map();
    for (let t = 0; t + arity - 1 < a.idx.length; t += arity) { const kk = elem(Array.from({ length: arity }, (_, r) => cls[a.idx[t + r]])); if (kk) count.set(kk, (count.get(kk) ?? 0) + 1); }
    for (let t = 0; t + arity - 1 < b.idx.length; t += arity) {
      const c = Array.from({ length: arity }, (_, r) => match[b.idx[t + r]]);
      if (c.some((x) => x < 0)) { triangleMismatch++; continue; }
      const kk = elem(c); if (!kk) continue;
      const n = count.get(kk) ?? 0;
      if (n > 0) count.set(kk, n - 1); else triangleMismatch++;
    }
    for (const n of count.values()) triangleMismatch += n;
  }
  return { posErrOfDiag: unmatched ? Infinity : maxPos, normalDeg: maxAng, uvErr: maxUv, triangleMismatch, unmatchedVertices: unmatched, nonTrianglePrimitives: nonTriangle };
}

// Texture-only file: BEFORE's geometry with AFTER's texture images. Works on
// the glTF JSON so every texture slot counts, including material extensions
// (KHR_materials_specular, clearcoat, ...). Each (material, slot path) in
// BEFORE must exist in AFTER with the same texCoord, scale/strength, texture
// transform and sampler; only the image may differ. A removed core slot is
// removed in the hybrid too. Anything else throws, so the check never scores
// a texture it did not copy.
export async function texturesOnto(fileA, fileB, outFile) {
  const { KHRTextureBasisu, EXTTextureWebP, EXTTextureAVIF } = await import('@gltf-transform/extensions');
  const [ja, jb] = [glbJson(fileA), glbJson(fileB)];
  const [da, db] = [await io.read(fileA), await io.read(fileB)];
  const imageOf = (j, ti) => { const t = j.textures[ti]; return t.source ?? t.extensions?.KHR_texture_basisu?.source ?? t.extensions?.EXT_texture_webp?.source ?? t.extensions?.EXT_texture_avif?.source; };
  const samplerOf = (j, ti) => JSON.stringify(j.samplers?.[j.textures[ti].sampler] ?? {});
  const slots = (j, mi) => {
    const out = new Map();
    const walk = (o, path) => {
      for (const [k, v] of Object.entries(o ?? {})) {
        if (!v || typeof v !== 'object') continue;
        if (/Texture$/.test(k) && typeof v.index === 'number') { const { index, ...info } = v; out.set(`${path}${k}`, { tex: index, info: JSON.stringify(info) }); }
        else walk(v, `${path}${k}.`);
      }
    };
    walk(j.materials[mi], ''); return out;
  };
  const ma = ja.materials ?? [], mb = jb.materials ?? [];
  if (ma.length !== mb.length) throw new Error(`material count ${ma.length} -> ${mb.length}`);
  const na = ma.map((m) => m.name), nb = mb.map((m) => m.name);
  const uniq = (n) => n.every((x) => x && n.indexOf(x) === n.lastIndexOf(x));
  const byName = uniq(na) && uniq(nb);
  const imgMap = new Map(); const drop = [];
  const CORE = { 'pbrMetallicRoughness.baseColorTexture': 'BaseColor', 'pbrMetallicRoughness.metallicRoughnessTexture': 'MetallicRoughness', normalTexture: 'Normal', occlusionTexture: 'Occlusion', emissiveTexture: 'Emissive' };
  ma.forEach((m, i) => {
    const bi = byName ? nb.indexOf(m.name) : i;
    if (bi < 0) throw new Error(`no AFTER material "${m.name}"`);
    const sa = slots(ja, i), sb = slots(jb, bi);
    for (const k of sb.keys()) if (!sa.has(k)) throw new Error(`AFTER adds texture slot ${k} on "${m.name}"`);
    for (const [k, va] of sa) {
      const vb = sb.get(k);
      if (!vb) { if (!CORE[k]) throw new Error(`AFTER removes extension slot ${k} on "${m.name}" (not supported)`); drop.push([i, CORE[k]]); continue; }
      if (va.info !== vb.info) throw new Error(`texture settings changed on "${m.name}" ${k}: ${va.info} -> ${vb.info}`);
      if (samplerOf(ja, va.tex) !== samplerOf(jb, vb.tex)) throw new Error(`sampler changed on "${m.name}" ${k}`);
      const ia = imageOf(ja, va.tex), ib = imageOf(jb, vb.tex);
      if (imgMap.has(ia) && imgMap.get(ia) !== ib) throw new Error(`BEFORE image ${ia} maps to two AFTER images (not supported)`);
      imgMap.set(ia, ib);
    }
  });
  const used = new Set(db.getRoot().listExtensionsUsed().map((e) => e.extensionName));
  if (used.has('KHR_texture_basisu')) da.createExtension(KHRTextureBasisu).setRequired(true);
  if (used.has('EXT_texture_webp')) da.createExtension(EXTTextureWebP).setRequired(true);
  if (used.has('EXT_texture_avif')) da.createExtension(EXTTextureAVIF).setRequired(true);
  // gltf-transform keeps one Texture per glTF image, in image order.
  const ta = da.getRoot().listTextures(), tb = db.getRoot().listTextures();
  if (ta.length !== (ja.images ?? []).length || tb.length !== (jb.images ?? []).length) throw new Error('texture list does not match the glTF image list');
  for (const [ia, ib] of imgMap) ta[ia].setImage(tb[ib].getImage().slice()).setMimeType(tb[ib].getMimeType());
  const mats = da.getRoot().listMaterials();
  for (const [i, slot] of drop) mats[i][`set${slot}Texture`](null);
  await io.write(outFile, da);
  return { images: imgMap.size, droppedSlots: drop.length };
}
