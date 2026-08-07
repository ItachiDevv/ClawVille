#!/usr/bin/env bun
/**
 * ktx2-texture-diet.mjs — Gate-4 texture-only diet tool (cold-load rung 2). v2.
 *
 * RAW GLB SURGERY: removes the targeted normal-map images (and their material
 * slot references) from a GLB/VRM while keeping every other byte identical.
 *
 * v2 (Codex tooling review, findings 1–3 + 8):
 *  - FAIL CLOSED on any extension outside the ALLOW-LIST (no generic walker
 *    mutation; unknown texture-ish keys in materials are a REFUSAL, and
 *    `extras` subtrees are never scanned or touched).
 *  - Texture SOURCE VARIANTS: dropping a texture drops core `source` AND
 *    KHR_texture_basisu / EXT_texture_webp sources (no orphaned fallbacks).
 *  - Meshopt: a bufferView whose PARENT buffer is 0 while carrying
 *    EXT_meshopt_compression is REFUSED (its fallback bytes would be lost);
 *    only the parent-hole (buffer 1) layout is accepted, and only the
 *    extension's compressed range (buffer 0) is repacked.
 *  - Verification v2 (independent of the transform):
 *      V1 content-addressing — every kept accessor/image/meshopt stream's bytes
 *         at the offsets DECLARED IN THE OUTPUT JSON equal the bytes at the
 *         offsets declared in the source JSON;
 *      V2 range/alignment — every declared range fits the new BIN, 4-aligned;
 *      V3 reference closure — every texture/image/bufferView index in the
 *         output JSON is in range (schema-known sites);
 *      V4 whole-JSON determinism — output JSON equals an expected JSON built
 *         by re-running the transform on a fresh copy of the source;
 *      V5 no surviving normal-slot references.
 *
 * Usage:
 *   bun scripts/ktx2-texture-diet.mjs <in.glb|.vrm> <out.glb|.vrm> --drop-slot=normal [--dry-run]
 *
 * Exit: 0 ok · 2 usage/refused · 3 verification failed
 */
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// CLI (exact flags only; duplicates rejected)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let dropSlot = null, dryRun = false;
const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') { if (dryRun) usage('duplicate --dry-run'); dryRun = true; continue; }
  if (a === '--drop-slot' || a.startsWith('--drop-slot=')) {
    if (dropSlot !== null) usage('duplicate --drop-slot');
    dropSlot = a.includes('=') ? a.slice('--drop-slot='.length) : argv[++i];
    continue;
  }
  if (a.startsWith('--')) usage(`unknown flag ${a}`);
  files.push(a);
}
function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('Usage: bun scripts/ktx2-texture-diet.mjs <in> <out> --drop-slot=normal [--dry-run]');
  process.exit(2);
}
if (files.length !== 2 || dropSlot !== 'normal') usage();
const [inFile, outFile] = files;
const refuse = (msg) => { console.error(`REFUSED: ${msg}`); process.exit(2); };

// ---------------------------------------------------------------------------
// Extension allow-list (fail closed — finding 1)
// ---------------------------------------------------------------------------
const ALLOWED_EXTENSIONS = new Set([
  'KHR_texture_basisu', 'EXT_texture_webp', 'KHR_texture_transform',
  'EXT_meshopt_compression', 'KHR_mesh_quantization', 'KHR_draco_mesh_compression',
  'KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_specular',
  'KHR_materials_unlit', 'KHR_materials_emissive_strength',
  'VRMC_vrm', 'VRMC_springBone', 'VRMC_materials_mtoon', 'VRMC_node_constraint', 'VRM',
]);

// Schema-known material texture slots: [path, isNormalSlot]
const MATERIAL_TEXTURE_SLOTS = [
  [['pbrMetallicRoughness', 'baseColorTexture'], false],
  [['pbrMetallicRoughness', 'metallicRoughnessTexture'], false],
  [['normalTexture'], true],
  [['occlusionTexture'], false],
  [['emissiveTexture'], false],
  [['extensions', 'KHR_materials_specular', 'specularTexture'], false],
  [['extensions', 'KHR_materials_specular', 'specularColorTexture'], false],
  [['extensions', 'KHR_materials_transmission', 'transmissionTexture'], false],
  [['extensions', 'VRMC_materials_mtoon', 'shadeMultiplyTexture'], false],
  [['extensions', 'VRMC_materials_mtoon', 'shadingShiftTexture'], false],
  [['extensions', 'VRMC_materials_mtoon', 'matcapTexture'], false],
  [['extensions', 'VRMC_materials_mtoon', 'rimMultiplyTexture'], false],
  [['extensions', 'VRMC_materials_mtoon', 'outlineWidthMultiplyTexture'], false],
  [['extensions', 'VRMC_materials_mtoon', 'uvAnimationMaskTexture'], false],
];
const KNOWN_SLOT_PATHS = new Set(MATERIAL_TEXTURE_SLOTS.map((s) => s[0].join('.')));

// ---------------------------------------------------------------------------
// GLB parse
// ---------------------------------------------------------------------------
function parseGlb(buf, label) {
  if (buf.readUInt32LE(0) !== 0x46546c67) refuse(`${label}: not a GLB`);
  const totalLen = buf.readUInt32LE(8);
  let off = 12, json = null, jsonRaw = null, bin = Buffer.alloc(0);
  while (off < totalLen) {
    const chunkLen = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + chunkLen);
    if (type === 0x4e4f534a) { jsonRaw = body; json = JSON.parse(body.toString('utf8')); }
    else if (type === 0x004e4942) bin = body;
    off += 8 + chunkLen;
  }
  return { json, jsonRaw, bin };
}
const src = fs.readFileSync(inFile);
const { json: srcJson, bin } = parseGlb(src, inFile);

for (const e of srcJson.extensionsUsed || []) {
  if (!ALLOWED_EXTENSIONS.has(e)) refuse(`unsupported extension ${e} (allow-list is fail-closed)`);
}
// Round-2 F1: also validate the ACTUAL extension object names document-wide
// (extensionsUsed can under-declare). `extras` subtrees are skipped.
{
  const scanExtNames = (node) => {
    if (Array.isArray(node)) { node.forEach(scanExtNames); return; }
    if (node === null || typeof node !== 'object') return;
    for (const [key, val] of Object.entries(node)) {
      if (key === 'extras') continue;
      if (key === 'extensions' && val && typeof val === 'object') {
        for (const name of Object.keys(val)) {
          if (!ALLOWED_EXTENSIONS.has(name)) refuse(`unsupported extension object "${name}" present in document`);
        }
      }
      scanExtNames(val);
    }
  };
  scanExtNames(srcJson);
}
if ((srcJson.buffers || []).length > 2) refuse('more than 2 buffers');
// Round-2 F3/V2: a plain (non-meshopt) bufferView on a nonzero buffer is an
// unsupported secondary-buffer layout — refuse up front rather than skipping.
(srcJson.bufferViews || []).forEach((bv, i) => {
  if (!bv.extensions?.EXT_meshopt_compression && (bv.buffer ?? 0) !== 0) {
    refuse(`bufferView ${i} on secondary buffer ${bv.buffer} without meshopt — unsupported layout`);
  }
});

// ---------------------------------------------------------------------------
// The transform, as a pure function of a parsed JSON copy. Returns the new
// json + drop sets; used once for the real output and once for the expected-
// JSON verification copy (V4).
// ---------------------------------------------------------------------------
function getPath(obj, path) { let c = obj; for (const k of path) { if (c == null) return undefined; c = c[k]; } return c; }
function deleteAtPath(obj, path) {
  const parent = getPath(obj, path.slice(0, -1));
  if (parent) delete parent[path[path.length - 1]];
}

function applyTransform(json) {
  const materials = json.materials || [];
  const textures = json.textures || [];
  const images = json.images || [];
  const bufferViews = json.bufferViews || [];

  // 1. Texture-ish keys in materials must sit at an EXACT known slot path
  //    (round-2 F1: terminal-key matching accepted wrong-path slots that were
  //    then never remapped). Scan skips `extras`.
  materials.forEach((m, mi) => {
    const scan = (node, pathParts) => {
      if (Array.isArray(node)) { node.forEach((v, i) => scan(v, pathParts)); return; }
      if (node === null || typeof node !== 'object') return;
      for (const [key, val] of Object.entries(node)) {
        if (key === 'extras') continue;
        const childPath = [...pathParts, key];
        if (/texture/i.test(key) && val && typeof val === 'object' && typeof val.index === 'number' &&
            !KNOWN_SLOT_PATHS.has(childPath.join('.'))) {
          refuse(`texture reference at unknown path materials[${mi}].${childPath.join('.')}`);
        }
        scan(val, childPath);
      }
    };
    scan(m, []);
  });

  // 2. Collect texture references from the schema-known sites.
  const refs = []; // {texIndex, isNormal, matIndex, path}
  materials.forEach((m, mi) => {
    for (const [slotPath, isNormal] of MATERIAL_TEXTURE_SLOTS) {
      const info = getPath(m, slotPath);
      if (info && typeof info.index === 'number') refs.push({ texIndex: info.index, isNormal, matIndex: mi, slotPath });
    }
  });
  const vrm0 = json.extensions?.VRM;
  const vrm0Bare = []; // {holder, key, texIndex, isNormal}
  if (vrm0?.materialProperties) {
    for (const mp of vrm0.materialProperties) {
      for (const [prop, ti] of Object.entries(mp.textureProperties || {})) {
        if (typeof ti === 'number') vrm0Bare.push({ holder: mp.textureProperties, key: prop, texIndex: ti, isNormal: /_BumpMap$/.test(prop) });
      }
    }
  }
  if (typeof vrm0?.meta?.texture === 'number') vrm0Bare.push({ holder: vrm0.meta, key: 'texture', texIndex: vrm0.meta.texture, isNormal: false });

  // 3. Target textures = normal-slot refs only; refuse mixed usage.
  const targetTex = new Set([
    ...refs.filter((r) => r.isNormal).map((r) => r.texIndex),
    ...vrm0Bare.filter((r) => r.isNormal).map((r) => r.texIndex),
  ]);
  if (targetTex.size === 0) refuse('no normal-slot texture references found');
  for (const r of [...refs, ...vrm0Bare]) {
    if (targetTex.has(r.texIndex) && !r.isNormal) refuse(`texture ${r.texIndex} also used by a non-normal slot`);
  }

  // 4. Target images = ALL source variants of targeted textures (finding 1c).
  const sourceVariants = (t) => [t.source, t.extensions?.KHR_texture_basisu?.source, t.extensions?.EXT_texture_webp?.source]
    .filter((v) => v != null);
  const targetImg = new Set();
  targetTex.forEach((ti) => sourceVariants(textures[ti]).forEach((s) => targetImg.add(s)));
  textures.forEach((t, ti) => {
    if (targetTex.has(ti)) return;
    for (const s of sourceVariants(t)) if (targetImg.has(s)) refuse(`image ${s} shared with non-targeted texture ${ti}`);
  });
  const vrm1Thumb = json.extensions?.VRMC_vrm?.meta?.thumbnailImage;
  if (vrm1Thumb != null && targetImg.has(vrm1Thumb)) refuse('target image is the VRM thumbnail');

  const targetBv = new Set([...targetImg].map((ii) => images[ii]?.bufferView).filter((v) => v != null));

  // 5. Drop slot references.
  materials.forEach((m) => {
    for (const [slotPath, isNormal] of MATERIAL_TEXTURE_SLOTS) {
      if (isNormal && getPath(m, slotPath)) deleteAtPath(m, slotPath);
    }
  });
  for (const r of vrm0Bare) if (r.isNormal) delete r.holder[r.key];

  // 6. Entry removal + dense order-preserving remaps.
  const remapArray = (arr, dropSet) => {
    const remap = new Map(); const kept = [];
    arr.forEach((v, i) => { if (!dropSet.has(i)) { remap.set(i, kept.length); kept.push(v); } });
    return { remap, kept };
  };
  const texR = remapArray(textures, targetTex);
  const imgR = remapArray(images, targetImg);
  const bvR = remapArray(bufferViews, targetBv);
  const re = (map, v, what) => {
    if (v == null) return v;
    if (!map.has(v)) refuse(`dangling ${what} index ${v} during remap`);
    return map.get(v);
  };

  // 7. Rewrite references (schema-known sites only).
  materials.forEach((m) => {
    for (const [slotPath] of MATERIAL_TEXTURE_SLOTS) {
      const info = getPath(m, slotPath);
      if (info && typeof info.index === 'number') info.index = re(texR.remap, info.index, 'texture');
    }
  });
  for (const r of vrm0Bare) {
    if (!r.isNormal && typeof r.holder[r.key] === 'number') r.holder[r.key] = re(texR.remap, r.holder[r.key], 'texture');
  }
  texR.kept.forEach((t) => {
    if (t.source != null) t.source = re(imgR.remap, t.source, 'image');
    if (t.extensions?.KHR_texture_basisu?.source != null) t.extensions.KHR_texture_basisu.source = re(imgR.remap, t.extensions.KHR_texture_basisu.source, 'image');
    if (t.extensions?.EXT_texture_webp?.source != null) t.extensions.EXT_texture_webp.source = re(imgR.remap, t.extensions.EXT_texture_webp.source, 'image');
  });
  imgR.kept.forEach((img) => { if (img.bufferView != null) img.bufferView = re(bvR.remap, img.bufferView, 'bufferView'); });
  if (vrm1Thumb != null) json.extensions.VRMC_vrm.meta.thumbnailImage = re(imgR.remap, vrm1Thumb, 'image');
  (json.accessors || []).forEach((a) => {
    if (a.bufferView != null) a.bufferView = re(bvR.remap, a.bufferView, 'bufferView');
    if (a.sparse?.indices?.bufferView != null) a.sparse.indices.bufferView = re(bvR.remap, a.sparse.indices.bufferView, 'bufferView');
    if (a.sparse?.values?.bufferView != null) a.sparse.values.bufferView = re(bvR.remap, a.sparse.values.bufferView, 'bufferView');
  });
  (json.meshes || []).forEach((m) => (m.primitives || []).forEach((p) => {
    const dr = p.extensions?.KHR_draco_mesh_compression;
    if (dr?.bufferView != null) dr.bufferView = re(bvR.remap, dr.bufferView, 'bufferView');
  }));
  json.textures = texR.kept; json.images = imgR.kept; json.bufferViews = bvR.kept;
  return { json, targetTex, targetImg, targetBv, texRemap: texR.remap, imgRemap: imgR.remap, bvRemap: bvR.remap };
}

// ---------------------------------------------------------------------------
// Segment model of the source BIN (finding 2: refuse meshopt fallback in buf 0)
// ---------------------------------------------------------------------------
function segmentsOf(json) {
  const segs = [];
  (json.bufferViews || []).forEach((bv, i) => {
    const mo = bv.extensions?.EXT_meshopt_compression;
    if (mo) {
      if ((mo.buffer ?? 0) !== 0) refuse(`meshopt view ${i}: compressed stream on buffer ${mo.buffer}`);
      if ((bv.buffer ?? 0) === 0) refuse(`meshopt view ${i}: parent fallback bufferView on buffer 0 — repack would destroy it`);
      segs.push({ kind: 'meshopt', bvIndex: i, offset: mo.byteOffset ?? 0, length: mo.byteLength ?? 0 });
    } else if ((bv.buffer ?? 0) === 0) {
      segs.push({ kind: 'bv', bvIndex: i, offset: bv.byteOffset ?? 0, length: bv.byteLength ?? 0 });
    }
  });
  segs.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].offset < segs[i - 1].offset + segs[i - 1].length) {
      refuse(`overlapping bin segments (bv ${segs[i - 1].bvIndex} / bv ${segs[i].bvIndex})`);
    }
  }
  return segs;
}

const srcSegments = segmentsOf(srcJson); // refusals fire on the SOURCE layout first
const work = JSON.parse(JSON.stringify(srcJson));
const t = applyTransform(work);

// ---------------------------------------------------------------------------
// Repack BIN: keep all segments except targeted image bufferViews.
// ---------------------------------------------------------------------------
const keptSegments = srcSegments.filter((s) => !t.targetBv.has(s.bvIndex));
const align4 = (n) => (n + 3) & ~3;
let cursor = 0;
for (const s of keptSegments) { cursor = align4(cursor); s.newOffset = cursor; cursor += s.length; }
const newBinLen = align4(cursor);
const newBin = Buffer.alloc(newBinLen);
for (const s of keptSegments) bin.copy(newBin, s.newOffset, s.offset, s.offset + s.length);
for (const s of keptSegments) {
  const bv = work.bufferViews[t.bvRemap.get(s.bvIndex)];
  if (s.kind === 'meshopt') bv.extensions.EXT_meshopt_compression.byteOffset = s.newOffset;
  else bv.byteOffset = s.newOffset;
}
if (work.buffers?.length) work.buffers[0].byteLength = newBinLen;

// ---------------------------------------------------------------------------
// Assemble output
// ---------------------------------------------------------------------------
let jsonOut = Buffer.from(JSON.stringify(work), 'utf8');
if (jsonOut.length % 4) jsonOut = Buffer.concat([jsonOut, Buffer.alloc(4 - (jsonOut.length % 4), 0x20)]);
const chunk = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32LE(body.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, body]); };
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
const out = Buffer.concat([header, chunk(0x4e4f534a, jsonOut), chunk(0x004e4942, newBin)]);
out.writeUInt32LE(out.length, 8);

// ---------------------------------------------------------------------------
// VERIFICATION v2 — independent property checks on the assembled output.
// ---------------------------------------------------------------------------
const errs = [];
{
  const { json: vJson, bin: vBin } = parseGlb(out, 'output');

  // Declared-range reader for a bufferView index in a given (json, bin).
  const declaredBytes = (json, binBuf, bvIndex, label) => {
    const bv = json.bufferViews?.[bvIndex];
    if (!bv) { errs.push(`${label}: bufferView ${bvIndex} out of range`); return null; }
    const mo = bv.extensions?.EXT_meshopt_compression;
    const offset = mo ? (mo.byteOffset ?? 0) : (bv.byteOffset ?? 0);
    const length = mo ? (mo.byteLength ?? 0) : (bv.byteLength ?? 0);
    const onBin = mo ? (mo.buffer ?? 0) === 0 : (bv.buffer ?? 0) === 0;
    if (!onBin) return Buffer.alloc(0); // hole-buffer views own no BIN bytes
    if (offset % 4 !== 0) errs.push(`${label}: bufferView ${bvIndex} offset ${offset} not 4-aligned`);
    if (offset + length > binBuf.length) { errs.push(`${label}: bufferView ${bvIndex} range ${offset}+${length} exceeds bin ${binBuf.length}`); return null; }
    return binBuf.subarray(offset, offset + length);
  };

  // V1a accessors: content at output-declared offsets == content at source-declared offsets.
  const sAcc = srcJson.accessors || [], vAcc = vJson.accessors || [];
  if (sAcc.length !== vAcc.length) errs.push(`accessor count drifted ${sAcc.length} -> ${vAcc.length}`);
  for (let i = 0; i < Math.min(sAcc.length, vAcc.length); i++) {
    for (const [sv, vv, tag] of [
      [sAcc[i].bufferView, vAcc[i].bufferView, `accessor ${i}`],
      [sAcc[i].sparse?.indices?.bufferView, vAcc[i].sparse?.indices?.bufferView, `accessor ${i} sparse.indices`],
      [sAcc[i].sparse?.values?.bufferView, vAcc[i].sparse?.values?.bufferView, `accessor ${i} sparse.values`],
    ]) {
      if (sv == null && vv == null) continue;
      if (sv == null || vv == null) { errs.push(`${tag}: bufferView presence drifted`); continue; }
      const a = declaredBytes(srcJson, bin, sv, `${tag} (src)`);
      const b = declaredBytes(vJson, vBin, vv, `${tag} (out)`);
      if (a && b && !a.equals(b)) errs.push(`${tag}: bytes differ at declared offsets`);
    }
  }
  // V1b draco geometry bufferViews.
  const dracoBvs = (json) => (json.meshes || []).flatMap((m) => (m.primitives || [])
    .map((p) => p.extensions?.KHR_draco_mesh_compression?.bufferView).filter((v) => v != null));
  const sDr = dracoBvs(srcJson), vDr = dracoBvs(vJson);
  if (sDr.length !== vDr.length) errs.push('draco primitive count drifted');
  for (let i = 0; i < Math.min(sDr.length, vDr.length); i++) {
    const a = declaredBytes(srcJson, bin, sDr[i], `draco ${i} (src)`);
    const b = declaredBytes(vJson, vBin, vDr[i], `draco ${i} (out)`);
    if (a && b && !a.equals(b)) errs.push(`draco ${i}: bytes differ at declared offsets`);
  }
  // V1c kept images by identity: source kept-image bytes must appear at the
  // output image's declared range, matched via the independent old->new map.
  const keptImagePairs = [];
  (srcJson.images || []).forEach((img, i) => { if (!t.targetImg.has(i)) keptImagePairs.push([i, t.imgRemap.get(i)]); });
  if ((vJson.images || []).length !== keptImagePairs.length) errs.push(`image count ${vJson.images?.length} != expected ${keptImagePairs.length}`);
  for (const [si, oi] of keptImagePairs) {
    const sImg = srcJson.images[si], oImg = vJson.images?.[oi];
    if (!oImg) { errs.push(`image ${si}->${oi} missing in output`); continue; }
    if (sImg.bufferView == null && oImg.bufferView == null) continue;
    const a = declaredBytes(srcJson, bin, sImg.bufferView, `image ${si} (src)`);
    const b = declaredBytes(vJson, vBin, oImg.bufferView, `image ${oi} (out)`);
    if (a && b && !a.equals(b)) errs.push(`image ${si}->${oi}: bytes differ at declared offsets`);
  }
  // V2 every output bufferView range valid (also covers views not referenced
  // above), and no non-meshopt view may sit on a secondary buffer.
  (vJson.bufferViews || []).forEach((bv, i) => {
    if (!bv.extensions?.EXT_meshopt_compression && (bv.buffer ?? 0) !== 0) {
      errs.push(`output bufferView ${i} on secondary buffer ${bv.buffer} without meshopt`);
      return;
    }
    void declaredBytes(vJson, vBin, i, 'range-scan');
  });
  // V3 reference closure.
  (vJson.textures || []).forEach((tx, i) => {
    for (const s of [tx.source, tx.extensions?.KHR_texture_basisu?.source, tx.extensions?.EXT_texture_webp?.source]) {
      if (s != null && (s < 0 || s >= (vJson.images || []).length)) errs.push(`texture ${i}: image ref ${s} out of range`);
    }
  });
  (vJson.materials || []).forEach((m, mi) => {
    for (const [slotPath] of MATERIAL_TEXTURE_SLOTS) {
      const info = getPath(m, slotPath);
      if (info && typeof info.index === 'number' && (info.index < 0 || info.index >= (vJson.textures || []).length)) {
        errs.push(`material ${mi} ${slotPath.join('.')}: texture ref out of range`);
      }
    }
  });
  const vThumb = vJson.extensions?.VRMC_vrm?.meta?.thumbnailImage;
  if (vThumb != null && (vThumb < 0 || vThumb >= (vJson.images || []).length)) errs.push('VRM thumbnail ref out of range');
  // V3b VRM0 texture references (round-2 F3): bare texture indices must close.
  const vTexCount = (vJson.textures || []).length;
  for (const [mi, mp] of (vJson.extensions?.VRM?.materialProperties || []).entries()) {
    for (const [prop, ti] of Object.entries(mp.textureProperties || {})) {
      if (typeof ti === 'number' && (ti < 0 || ti >= vTexCount)) errs.push(`VRM0 materialProperties[${mi}].${prop}: texture ref ${ti} out of range`);
    }
  }
  const vrm0MetaTex = vJson.extensions?.VRM?.meta?.texture;
  if (typeof vrm0MetaTex === 'number' && (vrm0MetaTex < 0 || vrm0MetaTex >= vTexCount)) errs.push('VRM0 meta.texture ref out of range');
  // V4 whole-JSON determinism: expected = transform re-run on a FRESH copy.
  const fresh = JSON.parse(JSON.stringify(srcJson));
  const t2 = applyTransform(fresh);
  const freshSegs = segmentsOf(srcJson).filter((s) => !t2.targetBv.has(s.bvIndex));
  let c2 = 0;
  for (const s of freshSegs) {
    c2 = align4(c2);
    const bv = fresh.bufferViews[t2.bvRemap.get(s.bvIndex)];
    if (s.kind === 'meshopt') bv.extensions.EXT_meshopt_compression.byteOffset = c2;
    else bv.byteOffset = c2;
    c2 += s.length;
  }
  if (fresh.buffers?.length) fresh.buffers[0].byteLength = align4(c2);
  if (JSON.stringify(fresh) !== JSON.stringify(vJson)) errs.push('output JSON != independently rebuilt expected JSON');
  // V5 no surviving normal-slot refs.
  (vJson.materials || []).forEach((m, mi) => { if (m.normalTexture) errs.push(`material ${mi}: normalTexture survived`); });
  for (const mp of vJson.extensions?.VRM?.materialProperties || []) {
    for (const prop of Object.keys(mp.textureProperties || {})) if (/_BumpMap$/.test(prop)) errs.push('_BumpMap survived');
  }
}

const mb = (b) => (b / 1048576).toFixed(3);
console.log(`${inFile}: ${mb(src.length)}MB -> ${mb(out.length)}MB  (save ${mb(src.length - out.length)}MB)`);
console.log(`dropped: ${t.targetTex.size} texture(s), ${t.targetImg.size} image(s), ${t.targetBv.size} bufferView(s)`);
if (errs.length) { console.error('VERIFY-FAIL:\n  ' + errs.join('\n  ')); process.exit(3); }
console.log('verification: PASS (V1 content-addressed bytes @ declared offsets, V2 ranges/alignment, V3 ref closure, V4 deterministic expected-JSON, V5 no surviving normal refs)');
if (!dryRun) { fs.writeFileSync(outFile, out); console.log(`wrote ${outFile}`); }
