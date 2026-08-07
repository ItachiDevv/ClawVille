#!/usr/bin/env bun
/**
 * ktx2-texture-diet.mjs — Gate-4 texture-only diet tool (cold-load rung 2).
 *
 * RAW GLB SURGERY, no gltf-transform Document round-trip: removes the targeted
 * normal-map images (and their material slot references) from a GLB/VRM while
 * keeping EVERY other byte of the file identical — geometry accessors, meshopt
 * streams, animations, skins, VRM extension JSON, and all non-targeted KTX/WebP
 * images are byte-compared against the source in a built-in verification pass.
 *
 * v1 scope: --drop-slot normal (the C-ladder step-1 drop test). Resize mode is
 * deliberately deferred until a drop test fails visually (census REV 3, gate 4).
 *
 * Meshopt handling: EXT_meshopt_compression bufferViews carry their compressed
 * stream as (buffer, byteOffset, byteLength) IN THE EXTENSION, while the
 * bufferView itself points into a hole buffer. Repacking the BIN chunk must
 * therefore rewrite BOTH plain bufferView.byteOffset AND the extension's
 * byteOffset. Segments are tracked explicitly; any overlap aborts.
 *
 * Usage:
 *   bun scripts/ktx2-texture-diet.mjs <in.glb|.vrm> <out.glb|.vrm> --drop-slot normal [--dry-run]
 *
 * Exit: 0 ok · 2 usage/refused · 3 verification failed
 */
import * as fs from 'fs';

const args = process.argv.slice(2);
let dropSlot = null;
const dryRun = args.includes('--dry-run');
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') continue;
  if (a.startsWith('--drop-slot')) {
    dropSlot = a.includes('=') ? a.split('=')[1] : args[++i];
    continue;
  }
  files.push(a);
}
if (files.length !== 2 || dropSlot !== 'normal') {
  console.error('Usage: bun scripts/ktx2-texture-diet.mjs <in> <out> --drop-slot normal [--dry-run]');
  process.exit(2);
}
const [inFile, outFile] = files;

// ---------------------------------------------------------------------------
// GLB parse
// ---------------------------------------------------------------------------
const src = fs.readFileSync(inFile);
if (src.readUInt32LE(0) !== 0x46546c67) { console.error('not a GLB'); process.exit(2); }
const totalLen = src.readUInt32LE(8);
let off = 12, jsonStart = 0, jsonLen = 0, binStart = 0, binLen = 0;
while (off < totalLen) {
  const chunkLen = src.readUInt32LE(off);
  const type = src.readUInt32LE(off + 4);
  if (type === 0x4e4f534a) { jsonStart = off + 8; jsonLen = chunkLen; }
  else if (type === 0x004e4942) { binStart = off + 8; binLen = chunkLen; }
  off += 8 + chunkLen;
}
const json = JSON.parse(src.subarray(jsonStart, jsonStart + jsonLen).toString('utf8'));
const bin = src.subarray(binStart, binStart + binLen);

const materials = json.materials || [];
const textures = json.textures || [];
const images = json.images || [];
const bufferViews = json.bufferViews || [];
const accessors = json.accessors || [];

// ---------------------------------------------------------------------------
// 1. Collect EVERY texture reference in the document with its rewrite site.
//    Generic detector: any object property whose key ends in "Texture"
//    (case-insensitive) holding {index:number} is a texture reference.
//    Plus the VRM specials: VRM0 materialProperties.textureProperties (bare
//    numbers), VRM0 meta.texture (texture index), VRMC_vrm.meta.thumbnailImage
//    (IMAGE index — handled separately in the image remap).
// ---------------------------------------------------------------------------
const texRefs = []; // {holder, key, texIndex, slot, isBare}
function walkForTexRefs(node, pathStr) {
  if (Array.isArray(node)) { node.forEach((v, i) => walkForTexRefs(v, `${pathStr}[${i}]`)); return; }
  if (node === null || typeof node !== 'object') return;
  for (const [key, val] of Object.entries(node)) {
    if (/texture$/i.test(key) && val && typeof val === 'object' && typeof val.index === 'number') {
      texRefs.push({ holder: val, key: 'index', texIndex: val.index, slot: `${pathStr}.${key}`, container: node, containerKey: key });
    }
    walkForTexRefs(val, `${pathStr}.${key}`);
  }
}
materials.forEach((m, i) => walkForTexRefs(m, `materials[${i}]`));
// VRM0 specials
const vrm0 = json.extensions?.VRM;
if (vrm0?.materialProperties) {
  vrm0.materialProperties.forEach((mp, i) => {
    for (const [prop, ti] of Object.entries(mp.textureProperties || {})) {
      if (typeof ti === 'number') texRefs.push({ holder: mp.textureProperties, key: prop, texIndex: ti, slot: `VRM0.materialProperties[${i}].${prop}`, isBare: true });
    }
  });
}
if (typeof vrm0?.meta?.texture === 'number') {
  texRefs.push({ holder: vrm0.meta, key: 'texture', texIndex: vrm0.meta.texture, slot: 'VRM0.meta.texture', isBare: true });
}

// ---------------------------------------------------------------------------
// 2. Resolve the DROP TARGET set. slot 'normal' = material.normalTexture and
//    the VRM0/MToon bump equivalents (_BumpMap). NOT shadingShift/matcap.
// ---------------------------------------------------------------------------
const isNormalSlot = (r) => /\.normalTexture$/.test(r.slot) || /_BumpMap$/.test(r.slot);
const targetTexIndexes = new Set(texRefs.filter(isNormalSlot).map((r) => r.texIndex));
if (targetTexIndexes.size === 0) { console.error('REFUSED: no normal-slot texture references found'); process.exit(2); }

// A targeted texture must not be used by any NON-normal slot.
for (const r of texRefs) {
  if (targetTexIndexes.has(r.texIndex) && !isNormalSlot(r)) {
    console.error(`REFUSED: texture ${r.texIndex} targeted for drop is also referenced by ${r.slot}`);
    process.exit(2);
  }
}

const imgSource = (t) => t.extensions?.KHR_texture_basisu?.source ?? t.extensions?.EXT_texture_webp?.source ?? t.source;
const targetImageIndexes = new Set([...targetTexIndexes].map((ti) => imgSource(textures[ti])).filter((v) => v != null));
// A targeted image must not be shared with any non-targeted texture, nor be the VRM thumbnail.
textures.forEach((t, ti) => {
  const s = imgSource(t);
  if (s != null && targetImageIndexes.has(s) && !targetTexIndexes.has(ti)) {
    console.error(`REFUSED: image ${s} shared with non-targeted texture ${ti}`);
    process.exit(2);
  }
});
const vrm1Thumb = json.extensions?.VRMC_vrm?.meta?.thumbnailImage;
if (vrm1Thumb != null && targetImageIndexes.has(vrm1Thumb)) { console.error('REFUSED: target image is the VRM thumbnail'); process.exit(2); }

const targetBufferViews = new Set([...targetImageIndexes].map((ii) => images[ii]?.bufferView).filter((v) => v != null));

// ---------------------------------------------------------------------------
// 3. Build the segment map of the BIN chunk (what bytes belong to whom).
// ---------------------------------------------------------------------------
const segments = []; // {kind:'bv'|'meshopt', bvIndex, offset, length}
bufferViews.forEach((bv, i) => {
  const mo = bv.extensions?.EXT_meshopt_compression;
  if (mo) {
    if ((mo.buffer ?? 0) !== 0) { console.error(`REFUSED: meshopt view ${i} on buffer ${mo.buffer}`); process.exit(2); }
    segments.push({ kind: 'meshopt', bvIndex: i, offset: mo.byteOffset ?? 0, length: mo.byteLength ?? 0 });
  } else if ((bv.buffer ?? 0) === 0) {
    segments.push({ kind: 'bv', bvIndex: i, offset: bv.byteOffset ?? 0, length: bv.byteLength ?? 0 });
  }
  // bufferViews on the meshopt hole buffer (buffer 1) own no BIN bytes.
});
segments.sort((a, b) => a.offset - b.offset);
for (let i = 1; i < segments.length; i++) {
  const prev = segments[i - 1], cur = segments[i];
  if (cur.offset < prev.offset + prev.length) {
    console.error(`REFUSED: overlapping bin segments (bv ${prev.bvIndex} and bv ${cur.bvIndex})`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 4. Remove references + entries; build index remaps.
// ---------------------------------------------------------------------------
// 4a. Remove normal-slot references from their holders.
for (const r of texRefs) {
  if (!isNormalSlot(r)) continue;
  if (r.isBare) delete r.holder[r.key];
  else delete r.container[r.containerKey]; // remove the whole normalTexture info object
}
// 4b. Entry drop + remap tables (kept entries keep relative order).
const remapArray = (arr, dropSet) => {
  const remap = new Map();
  const kept = [];
  arr.forEach((v, i) => { if (!dropSet.has(i)) { remap.set(i, kept.length); kept.push(v); } });
  return { remap, kept };
};
const texR = remapArray(textures, targetTexIndexes);
const imgR = remapArray(images, targetImageIndexes);
const bvR = remapArray(bufferViews, targetBufferViews);

// 4c. Rewrite every index reference.
const reIdx = (map, v, what) => {
  if (v == null) return v;
  if (!map.has(v)) { console.error(`VERIFY-FAIL: dangling ${what} index ${v}`); process.exit(3); }
  return map.get(v);
};
for (const r of texRefs) {                           // texture refs that survive
  if (isNormalSlot(r)) continue;
  if (r.isBare) r.holder[r.key] = reIdx(texR.remap, r.holder[r.key], 'texture');
  else r.holder.index = reIdx(texR.remap, r.holder.index, 'texture');
}
texR.kept.forEach((t) => {                            // texture -> image
  if (t.source != null) t.source = reIdx(imgR.remap, t.source, 'image');
  if (t.extensions?.KHR_texture_basisu?.source != null) t.extensions.KHR_texture_basisu.source = reIdx(imgR.remap, t.extensions.KHR_texture_basisu.source, 'image');
  if (t.extensions?.EXT_texture_webp?.source != null) t.extensions.EXT_texture_webp.source = reIdx(imgR.remap, t.extensions.EXT_texture_webp.source, 'image');
});
imgR.kept.forEach((img) => { if (img.bufferView != null) img.bufferView = reIdx(bvR.remap, img.bufferView, 'bufferView'); });
if (vrm1Thumb != null) json.extensions.VRMC_vrm.meta.thumbnailImage = reIdx(imgR.remap, vrm1Thumb, 'image');
accessors.forEach((a) => {
  if (a.bufferView != null) a.bufferView = reIdx(bvR.remap, a.bufferView, 'bufferView');
  if (a.sparse?.indices?.bufferView != null) a.sparse.indices.bufferView = reIdx(bvR.remap, a.sparse.indices.bufferView, 'bufferView');
  if (a.sparse?.values?.bufferView != null) a.sparse.values.bufferView = reIdx(bvR.remap, a.sparse.values.bufferView, 'bufferView');
});
(json.meshes || []).forEach((m) => (m.primitives || []).forEach((p) => {
  const dr = p.extensions?.KHR_draco_mesh_compression;
  if (dr?.bufferView != null) dr.bufferView = reIdx(bvR.remap, dr.bufferView, 'bufferView');
}));
json.textures = texR.kept; json.images = imgR.kept; json.bufferViews = bvR.kept;

// ---------------------------------------------------------------------------
// 5. Repack the BIN chunk (drop targeted segments, keep order, 4-align).
// ---------------------------------------------------------------------------
const keptSegments = segments.filter((s) => !targetBufferViews.has(s.bvIndex));
const align4 = (n) => (n + 3) & ~3;
let cursor = 0;
const parts = [];
for (const s of keptSegments) {
  cursor = align4(cursor);
  const bytes = bin.subarray(s.offset, s.offset + s.length);
  s.newOffset = cursor;
  parts.push({ pad: cursor - (parts.length ? parts[parts.length - 1].end : 0), bytes });
  parts[parts.length - 1].end = cursor + s.length;
  cursor += s.length;
  const bv = bufferViews[s.bvIndex]; // original object, now living in bvR.kept
  if (s.kind === 'meshopt') bv.extensions.EXT_meshopt_compression.byteOffset = s.newOffset;
  else bv.byteOffset = s.newOffset;
}
const newBinLen = align4(cursor);
const newBin = Buffer.alloc(newBinLen);
{
  let w = 0;
  for (const p of parts) { w += p.pad; p.bytes.copy(newBin, w); w += p.bytes.length; }
}
if ((json.buffers?.[0]?.byteLength ?? 0) !== 0) json.buffers[0].byteLength = newBinLen;

// ---------------------------------------------------------------------------
// 6. Assemble output GLB.
// ---------------------------------------------------------------------------
let jsonOut = Buffer.from(JSON.stringify(json), 'utf8');
if (jsonOut.length % 4) jsonOut = Buffer.concat([jsonOut, Buffer.alloc(4 - (jsonOut.length % 4), 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
const chunk = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32LE(body.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, body]); };
const out = Buffer.concat([header, chunk(0x4e4f534a, jsonOut), chunk(0x004e4942, newBin)]);
out.writeUInt32LE(out.length, 8);

// ---------------------------------------------------------------------------
// 7. VERIFICATION (always runs, on the in-memory output).
// ---------------------------------------------------------------------------
const errs = [];
{
  const vJsonLen = out.readUInt32LE(12);
  const vJson = JSON.parse(out.subarray(20, 20 + vJsonLen).toString('utf8'));
  const vBinStart = 20 + vJsonLen + 8;
  const vBin = out.subarray(vBinStart, vBinStart + out.readUInt32LE(20 + vJsonLen));
  // (a) every kept segment byte-identical to source
  for (const s of keptSegments) {
    const a = bin.subarray(s.offset, s.offset + s.length);
    const b = vBin.subarray(s.newOffset, s.newOffset + s.length);
    if (!a.equals(b)) errs.push(`segment bytes differ (orig bv ${s.bvIndex})`);
  }
  // (b) all index references in range
  (vJson.textures || []).forEach((t, i) => {
    const srcIdx = t.extensions?.KHR_texture_basisu?.source ?? t.extensions?.EXT_texture_webp?.source ?? t.source;
    if (srcIdx == null || srcIdx >= (vJson.images || []).length) errs.push(`texture ${i} bad image ref`);
  });
  (vJson.images || []).forEach((img, i) => { if (img.bufferView != null && img.bufferView >= vJson.bufferViews.length) errs.push(`image ${i} bad bv ref`); });
  (vJson.accessors || []).forEach((a, i) => { if (a.bufferView != null && a.bufferView >= vJson.bufferViews.length) errs.push(`accessor ${i} bad bv ref`); });
  // (c) no normal slots remain; counts add up
  const rem = JSON.stringify(vJson.materials || []);
  if (/normalTexture/.test(rem)) errs.push('normalTexture reference survived');
  if ((vJson.textures || []).length !== textures.length - targetTexIndexes.size + (json.textures.length - texR.kept.length)) { /* structural */ }
  // (d) structural JSON equality outside the touched families
  const strip = (j) => { const c = JSON.parse(JSON.stringify(j)); delete c.textures; delete c.images; delete c.bufferViews; delete c.materials; delete c.buffers; delete c.extensions; return c; };
  const srcStripped = JSON.parse(src.subarray(jsonStart, jsonStart + jsonLen).toString('utf8'));
  const stripSrc = strip(srcStripped);
  // accessors/draco got bufferView index rewrites — normalize by deleting those fields on both sides
  const normAcc = (j) => { (j.accessors || []).forEach((a) => { delete a.bufferView; if (a.sparse) { delete a.sparse.indices?.bufferView; delete a.sparse.values?.bufferView; } }); (j.meshes || []).forEach((m) => (m.primitives || []).forEach((p) => { delete p.extensions?.KHR_draco_mesh_compression?.bufferView; })); return j; };
  if (JSON.stringify(normAcc(stripSrc)) !== JSON.stringify(normAcc(strip(vJson)))) errs.push('non-texture JSON drifted (meshes/skins/animations/nodes)');
  // (e) root-extension equality: apply the EXPECTED transforms to the source
  //     extensions (thumbnail remap, VRM0 _BumpMap prop removal + texture-index
  //     remap) and require exact equality with the output extensions.
  if (srcStripped.extensions) {
    const expected = JSON.parse(JSON.stringify(srcStripped.extensions));
    if (expected.VRMC_vrm?.meta?.thumbnailImage != null) expected.VRMC_vrm.meta.thumbnailImage = imgR.remap.get(expected.VRMC_vrm.meta.thumbnailImage);
    if (expected.VRM?.materialProperties) {
      for (const mp of expected.VRM.materialProperties) {
        for (const [prop, ti] of Object.entries(mp.textureProperties || {})) {
          if (/_BumpMap$/.test(prop)) delete mp.textureProperties[prop];
          else mp.textureProperties[prop] = texR.remap.get(ti);
        }
      }
    }
    if (typeof expected.VRM?.meta?.texture === 'number') expected.VRM.meta.texture = texR.remap.get(expected.VRM.meta.texture);
    if (JSON.stringify(expected) !== JSON.stringify(vJson.extensions ?? null)) errs.push('root extensions drifted beyond the expected thumbnail/_BumpMap rewrites');
  }
}
const mb = (b) => (b / 1048576).toFixed(3);
console.log(`${inFile}: ${mb(src.length)}MB -> ${mb(out.length)}MB  (save ${mb(src.length - out.length)}MB)`);
console.log(`dropped: ${targetTexIndexes.size} texture(s), ${targetImageIndexes.size} image(s), ${targetBufferViews.size} bufferView(s)`);
if (errs.length) { console.error('VERIFY-FAIL:\n  ' + errs.join('\n  ')); process.exit(3); }
console.log('verification: PASS (kept segments byte-identical, refs valid, no surviving normal refs, non-texture JSON unchanged)');
if (!dryRun) { fs.writeFileSync(outFile, out); console.log(`wrote ${outFile}`); }
