#!/usr/bin/env bun
/**
 * census-rung2.mjs — READ-ONLY rung-2 asset census (cold-load diet).
 *
 * Pure raw-GLB parse: no decoders, no gltf-transform document — so byte numbers
 * are TRUE WIRE BYTES (meshopt/draco bufferViews counted at compressed size).
 *
 * Per asset emits:
 *  - total / JSON-chunk / BIN-chunk bytes
 *  - VRM extension flavor (VRM0 "VRM" vs VRM1 "VRMC_vrm") + its JSON size
 *  - geometry: verts, tris, wire bytes grouped by accessor semantic
 *    (POSITION / NORMAL / TANGENT / UV / JOINTS / WEIGHTS / COLOR / indices /
 *     morph targets), meshopt/draco flags
 *  - textures: per image — name, slots used by materials (incl. VRM0 MToon
 *    textureProperties), mime, dimensions, wire bytes, KTX2 codec
 *    (ETC1S / UASTC / UASTC+zstd) from the KTX2 header + DFD colorModel
 *
 * Usage: bun scripts/census-rung2.mjs <file.glb|.vrm> [...more] [--json out.json]
 */
import * as fs from 'fs';
import * as path from 'path';

const args = process.argv.slice(2);
const jsonOutIdx = args.indexOf('--json');
let jsonOut = null;
if (jsonOutIdx !== -1) { jsonOut = args[jsonOutIdx + 1]; args.splice(jsonOutIdx, 2); }

const COMP_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const totalLen = buf.readUInt32LE(8);
  let off = 12;
  let json = null, bin = null, jsonLen = 0, binLen = 0;
  while (off < totalLen) {
    const chunkLen = buf.readUInt32LE(off);
    const chunkType = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + chunkLen);
    if (chunkType === 0x4e4f534a) { json = JSON.parse(body.toString('utf8')); jsonLen = chunkLen; }
    else if (chunkType === 0x004e4942) { bin = body; binLen = chunkLen; }
    off += 8 + chunkLen;
  }
  return { json, bin, jsonLen, binLen, totalLen };
}

function ktx2Info(bytes) {
  // identifier 12B; u32 fields: vkFormat@12, typeSize@16, w@20, h@24, depth@28,
  // layers@32, faces@36, levels@40, scheme@44, dfdByteOffset@48+... (dfd offset is u32 @ 48? spec: index section)
  // KTX2 index: u32 dfdByteOffset @ 48? Actually: after levelCount(@40) and supercompressionScheme(@44):
  //   u32 dfdByteOffset @48, u32 dfdByteLength @52, u32 kvdByteOffset @56, ...
  const id = bytes.subarray(0, 12);
  const KTX2_ID = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!id.equals(KTX2_ID)) return null;
  const w = bytes.readUInt32LE(20), h = bytes.readUInt32LE(24);
  const levels = bytes.readUInt32LE(40);
  const scheme = bytes.readUInt32LE(44); // 0 none, 1 BasisLZ(ETC1S), 2 zstd, 3 zlib
  const dfdOff = bytes.readUInt32LE(48);
  let colorModel = -1;
  if (dfdOff > 0 && dfdOff + 13 <= bytes.length) colorModel = bytes.readUInt8(dfdOff + 12);
  // colorModel: 163 = ETC1S, 166 = UASTC
  let codec = 'unknown';
  if (colorModel === 163 || scheme === 1) codec = 'ETC1S';
  else if (colorModel === 166) codec = scheme === 2 ? 'UASTC+zstd' : scheme === 0 ? 'UASTC' : `UASTC+scheme${scheme}`;
  return { w, h, levels, codec };
}

function imgDims(bytes, mime) {
  if (mime === 'image/png' && bytes.length > 24) return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  if (mime === 'image/webp' && bytes.length > 30) {
    const fourcc = bytes.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') return { w: 1 + bytes.readUIntLE(24, 3), h: 1 + bytes.readUIntLE(27, 3) };
    if (fourcc === 'VP8 ') return { w: bytes.readUInt16LE(26) & 0x3fff, h: bytes.readUInt16LE(28) & 0x3fff };
    if (fourcc === 'VP8L') {
      const b = bytes.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  if (mime === 'image/jpeg') {
    let o = 2;
    while (o < bytes.length - 8) {
      if (bytes[o] !== 0xff) { o++; continue; }
      const marker = bytes[o + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { h: bytes.readUInt16BE(o + 5), w: bytes.readUInt16BE(o + 7) };
      o += 2 + bytes.readUInt16BE(o + 2);
    }
  }
  return null;
}

function semanticGroup(sem) {
  if (sem.startsWith('TEXCOORD')) return 'UV';
  if (sem.startsWith('JOINTS')) return 'JOINTS';
  if (sem.startsWith('WEIGHTS')) return 'WEIGHTS';
  if (sem.startsWith('COLOR')) return 'COLOR';
  return sem; // POSITION NORMAL TANGENT
}

function censusFile(file) {
  const buf = fs.readFileSync(file);
  const { json, bin, jsonLen, binLen } = parseGlb(buf);
  const out = { file, bytes: buf.length, jsonBytes: jsonLen, binBytes: binLen };

  // VRM flavor
  const ext = json.extensions || {};
  if (ext.VRM) { out.vrm = 'VRM0'; out.vrmExtJsonBytes = JSON.stringify(ext.VRM).length; }
  else if (ext.VRMC_vrm) { out.vrm = 'VRM1'; out.vrmExtJsonBytes = JSON.stringify(ext.VRMC_vrm).length; }

  const extsUsed = json.extensionsUsed || [];
  out.meshopt = extsUsed.includes('EXT_meshopt_compression');
  out.draco = extsUsed.includes('KHR_draco_mesh_compression');
  out.basisu = extsUsed.includes('KHR_texture_basisu');

  const accessors = json.accessors || [];
  const bufferViews = json.bufferViews || [];
  const images = json.images || [];
  const textures = json.textures || [];
  const materials = json.materials || [];
  const meshes = json.meshes || [];

  // wire bytes of a bufferView: for meshopt-compressed views the compressed
  // stream length lives in the EXT_meshopt_compression extension; the view's
  // own byteLength is the UNCOMPRESSED size (points at buffer 1, a hole).
  const bvBytes = (i) => {
    if (i == null) return 0;
    const bv = bufferViews[i];
    if (!bv) return 0;
    const mo = bv.extensions?.EXT_meshopt_compression;
    return mo ? (mo.byteLength ?? 0) : (bv.byteLength ?? 0);
  };
  // wire bytes of an accessor = its share of its bufferView. Multiple accessors can
  // share a bufferView (interleaved or packed); attribute count per bv to apportion.
  const bvUsers = new Map(); // bvIndex -> total accessor logical bytes mapped onto it
  const accLogical = (a) => (a.count || 0) * (COMP_BYTES[a.componentType] || 0) * (TYPE_COUNT[a.type] || 0);
  for (const a of accessors) {
    if (a.bufferView == null) continue;
    bvUsers.set(a.bufferView, (bvUsers.get(a.bufferView) || 0) + accLogical(a));
  }
  const accWire = (ai) => {
    const a = accessors[ai];
    if (!a) return 0;
    if (a.bufferView == null) return 0; // draco or sparse-only
    const total = bvUsers.get(a.bufferView) || 1;
    return Math.round(bvBytes(a.bufferView) * (accLogical(a) / total));
  };

  // geometry census
  const geo = { verts: 0, tris: 0, bySemantic: {}, indicesBytes: 0, morphBytes: 0, morphTargetCount: 0, primCount: 0 };
  const seenAcc = new Set();
  const addSem = (group, bytes) => { geo.bySemantic[group] = (geo.bySemantic[group] || 0) + bytes; };
  for (const mesh of meshes) {
    for (const prim of mesh.primitives || []) {
      geo.primCount++;
      const posAcc = accessors[prim.attributes?.POSITION];
      if (posAcc) geo.verts += posAcc.count || 0;
      if (prim.indices != null) {
        const ia = accessors[prim.indices];
        if (ia) geo.tris += Math.floor((ia.count || 0) / 3);
        if (!seenAcc.has(prim.indices)) { seenAcc.add(prim.indices); geo.indicesBytes += accWire(prim.indices); }
      } else if (posAcc) geo.tris += Math.floor((posAcc.count || 0) / 3);
      for (const [sem, ai] of Object.entries(prim.attributes || {})) {
        if (seenAcc.has(ai)) continue;
        seenAcc.add(ai);
        addSem(semanticGroup(sem), accWire(ai));
      }
      for (const tgt of prim.targets || []) {
        geo.morphTargetCount++;
        for (const ai of Object.values(tgt)) {
          if (seenAcc.has(ai)) continue;
          seenAcc.add(ai);
          geo.morphBytes += accWire(ai);
        }
      }
      // draco: geometry bytes live in the extension bufferView
      const dr = prim.extensions?.KHR_draco_mesh_compression;
      if (dr?.bufferView != null) addSem('DRACO', bvBytes(dr.bufferView));
    }
  }
  out.geo = geo;

  // texture slot mapping: image index -> [slot names]
  const texSlots = new Map();
  const noteTex = (texIndex, slot) => {
    if (texIndex == null) return;
    const t = textures[texIndex];
    if (!t) return;
    const img = t.extensions?.KHR_texture_basisu?.source ?? t.extensions?.EXT_texture_webp?.source ?? t.source;
    if (img == null) return;
    if (!texSlots.has(img)) texSlots.set(img, new Set());
    texSlots.get(img).add(slot);
  };
  for (const m of materials) {
    const p = m.pbrMetallicRoughness || {};
    noteTex(p.baseColorTexture?.index, 'baseColor');
    noteTex(p.metallicRoughnessTexture?.index, 'metallicRoughness');
    noteTex(m.normalTexture?.index, 'normal');
    noteTex(m.occlusionTexture?.index, 'occlusion');
    noteTex(m.emissiveTexture?.index, 'emissive');
    const mtoon = m.extensions?.VRMC_materials_mtoon;
    if (mtoon) {
      noteTex(mtoon.shadeMultiplyTexture?.index, 'mtoon:shade');
      noteTex(mtoon.shadingShiftTexture?.index, 'mtoon:shadingShift');
      noteTex(mtoon.matcapTexture?.index, 'mtoon:matcap');
      noteTex(mtoon.rimMultiplyTexture?.index, 'mtoon:rim');
      noteTex(mtoon.outlineWidthMultiplyTexture?.index, 'mtoon:outlineWidth');
      noteTex(mtoon.uvAnimationMaskTexture?.index, 'mtoon:uvAnimMask');
    }
  }
  // VRM0 MToon: extensions.VRM.materialProperties[].textureProperties {_MainTex: texIdx, ...}
  if (ext.VRM?.materialProperties) {
    for (const mp of ext.VRM.materialProperties) {
      for (const [prop, ti] of Object.entries(mp.textureProperties || {})) noteTex(ti, `vrm0:${prop}`);
    }
  }
  if (ext.VRM?.meta?.texture != null) noteTex(ext.VRM.meta.texture, 'vrm0:thumbnail');
  if (ext.VRMC_vrm?.meta?.thumbnailImage != null) {
    const img = ext.VRMC_vrm.meta.thumbnailImage;
    if (!texSlots.has(img)) texSlots.set(img, new Set());
    texSlots.get(img).add('vrm1:thumbnail');
  }

  out.textures = images.map((img, i) => {
    const bytes = img.bufferView != null ? bvBytes(img.bufferView) : 0;
    const raw = img.bufferView != null && bin
      ? bin.subarray(bufferViews[img.bufferView].byteOffset || 0, (bufferViews[img.bufferView].byteOffset || 0) + bytes)
      : null;
    let dims = null, codec = null;
    if (raw) {
      if (img.mimeType === 'image/ktx2') { const k = ktx2Info(raw); if (k) { dims = { w: k.w, h: k.h }; codec = k.codec; } }
      else dims = imgDims(raw, img.mimeType);
    }
    return {
      i, name: img.name || '', mime: img.mimeType || '', bytes,
      dims: dims ? `${dims.w}x${dims.h}` : '?',
      codec: codec || (img.mimeType || '').replace('image/', ''),
      slots: [...(texSlots.get(i) || ['UNREFERENCED'])].join(','),
    };
  });
  out.textureBytesTotal = out.textures.reduce((s, t) => s + t.bytes, 0);
  // "other bin" = bin minus geometry minus textures minus morphs (animation, IBM, etc.)
  const geoBytes = Object.values(geo.bySemantic).reduce((s, b) => s + b, 0) + geo.indicesBytes + geo.morphBytes;
  out.geoBytesTotal = geoBytes;
  out.otherBinBytes = binLen - geoBytes - out.textureBytesTotal;
  return out;
}

const results = [];
for (const f of args) {
  try { results.push(censusFile(f)); }
  catch (e) { results.push({ file: f, error: String(e.message || e) }); }
}

const mb = (b) => (b / 1048576).toFixed(3);
const kb = (b) => (b / 1024).toFixed(1);
for (const r of results) {
  if (r.error) { console.log(`\n### ${r.file}\n  ERROR: ${r.error}`); continue; }
  console.log(`\n### ${r.file}`);
  console.log(`  total ${mb(r.bytes)}MB (json ${kb(r.jsonBytes)}KB, bin ${mb(r.binBytes)}MB)` +
    (r.vrm ? ` | ${r.vrm} ext ${kb(r.vrmExtJsonBytes)}KB` : '') +
    ` | meshopt=${r.meshopt} draco=${r.draco} ktx2=${r.basisu}`);
  const g = r.geo;
  const semStr = Object.entries(g.bySemantic).map(([k, v]) => `${k} ${kb(v)}KB`).join(', ');
  console.log(`  GEO ${mb(r.geoBytesTotal)}MB — ${g.verts} verts, ${g.tris} tris, ${g.primCount} prims | ${semStr} | indices ${kb(g.indicesBytes)}KB | morphs(${g.morphTargetCount}) ${kb(g.morphBytes)}KB`);
  console.log(`  TEX ${mb(r.textureBytesTotal)}MB | otherBin(anim/ibm) ${mb(r.otherBinBytes)}MB`);
  for (const t of r.textures.sort((a, b) => b.bytes - a.bytes)) {
    console.log(`    [${t.i}] ${kb(t.bytes).padStart(8)}KB ${t.dims.padEnd(9)} ${t.codec.padEnd(10)} ${t.slots}${t.name ? '  (' + t.name + ')' : ''}`);
  }
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
