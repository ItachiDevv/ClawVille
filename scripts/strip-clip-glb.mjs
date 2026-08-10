#!/usr/bin/env bun
/**
 * strip-clip-glb.mjs — animation-clip-only GLB stripper (cold-load diet).
 *
 * PROBLEM: our per-state sea-creature clip GLBs (e.g. lobster idle/swim/hit)
 * each re-ship the FULL rigged mesh + a ~261KB KTX2 base-colour texture that the
 * runtime never reads. `sea-creature-animator.ts` loads each clip file and uses
 * ONLY `gltf.animations[0]`, binding the clip onto the BASE file's skeleton by
 * NODE NAME. Every mesh/material/texture/image/skin byte in a clip file is
 * downloaded, decoded and thrown away.
 *
 * WHAT THIS DOES — RAW GLB SURGERY (same discipline as ktx2-texture-diet.mjs:
 * parse chunks, edit JSON, repack BIN with 4-byte alignment, rewrite offsets):
 *
 *   REMOVED   meshes · materials · textures · images · (texture) samplers ·
 *             skins (incl. their inverseBindMatrices accessor + bufferView) ·
 *             the `mesh` / `skin` / `weights` keys on every node ·
 *             every accessor + bufferView orphaned by the above.
 *
 *   RETAINED  the FULL node array — names, hierarchy, TRS — byte-identical
 *             except the three removed keys (clips target nodes by NAME, and
 *             channel `target.node` indices stay valid because NO node is
 *             dropped and NO node index is remapped) ·
 *             every animation with all channels + samplers and their accessor
 *             DATA byte-identical · scenes · scene · asset.
 *
 * FAIL-CLOSED. The tool refuses (exit 2) rather than guessing on:
 *   - any extension outside the allow-list, declared OR present as an
 *     `extensions` object anywhere in the document (`extras` never scanned);
 *   - a document with no animations (nothing to keep);
 *   - an animation channel with `target.path === "weights"` (morph-target
 *     animation is meaningless once meshes are gone — it would bind to nothing);
 *   - a RETAINED bufferView that is EXT_meshopt_compression-compressed or sits
 *     on a secondary buffer (its bytes cannot be sliced/repacked safely);
 *   - any dangling accessor / bufferView / sampler / node index in the source.
 *
 * VERIFICATION (V1..V8, run on the ASSEMBLED OUTPUT BYTES, independent of the
 * transform — a re-parse of what actually gets written):
 *   V1 animation structure identical modulo remapped accessor indices
 *      (channels untouched; samplers mapped BACK through the inverse remap must
 *      reproduce the source animations array exactly);
 *   V2 retained accessor BYTES at OUTPUT-declared offsets == bytes at
 *      SOURCE-declared offsets, and accessor JSON identical modulo
 *      bufferView/byteOffset;
 *   V3 node array JSON byte-identical to the source node array with only
 *      {mesh, skin, weights} deleted;
 *   V4 no meshes/materials/textures/images/skins/samplers survive;
 *   V5 reference closure — every accessor.bufferView, sampler.input/output,
 *      channel.sampler, channel.target.node and scene node index in range;
 *      every bufferView range inside the BIN, 4-aligned, on buffer 0;
 *   V6 scenes / scene / asset byte-identical to source;
 *   V7 determinism — output JSON equals an expected JSON built by re-running
 *      the whole transform + repack on a FRESH copy of the source;
 *   V8 extensionsUsed/Required only name extensions that still appear as an
 *      `extensions` object in the output.
 *
 * Usage:
 *   bun scripts/strip-clip-glb.mjs <in.glb> <out.glb> [--dry-run]
 *
 * Exit: 0 ok · 2 usage/refused · 3 verification failed
 */
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// CLI (exact flags only; duplicates rejected)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let dryRun = false;
const files = [];
for (const a of argv) {
  if (a === '--dry-run') { if (dryRun) usage('duplicate --dry-run'); dryRun = true; continue; }
  if (a.startsWith('--')) usage(`unknown flag ${a}`);
  files.push(a);
}
function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('Usage: bun scripts/strip-clip-glb.mjs <in.glb> <out.glb> [--dry-run]');
  process.exit(2);
}
if (files.length !== 2) usage();
const [inFile, outFile] = files;
const refuse = (msg) => { console.error(`REFUSED: ${msg}`); process.exit(2); };

// ---------------------------------------------------------------------------
// Extension allow-list (fail closed)
// ---------------------------------------------------------------------------
const ALLOWED_EXTENSIONS = new Set([
  'KHR_texture_basisu',
  'EXT_texture_webp',
  'EXT_meshopt_compression',
  'KHR_mesh_quantization',
  'KHR_draco_mesh_compression',
]);

/** Top-level arrays this tool deletes outright. */
const DROPPED_ARRAYS = ['meshes', 'materials', 'textures', 'images', 'skins', 'samplers'];
/** Node keys this tool deletes (mesh/skin refs + the mesh-only morph weights). */
const DROPPED_NODE_KEYS = ['mesh', 'skin', 'weights'];

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

const align4 = (n) => (n + 3) & ~3;

/** Byte span an accessor occupies inside its bufferView, honouring byteStride. */
function accessorByteLength(acc, bv) {
  const cb = COMPONENT_BYTES[acc.componentType];
  const nc = TYPE_COMPONENTS[acc.type];
  if (cb == null || nc == null) refuse(`unknown accessor componentType/type ${acc.componentType}/${acc.type}`);
  const elem = cb * nc;
  const stride = bv?.byteStride;
  if (stride) return (acc.count - 1) * stride + elem;
  return acc.count * elem;
}

// ---------------------------------------------------------------------------
// GLB parse
// ---------------------------------------------------------------------------
function parseGlb(buf, label) {
  if (buf.length < 12) refuse(`${label}: too short to be a GLB`);
  if (buf.readUInt32LE(0) !== 0x46546c67) refuse(`${label}: not a GLB`);
  if (buf.readUInt32LE(4) !== 2) refuse(`${label}: unsupported GLB container version`);
  const totalLen = buf.readUInt32LE(8);
  let off = 12, json = null, bin = Buffer.alloc(0);
  while (off + 8 <= totalLen) {
    const chunkLen = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + chunkLen);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) bin = body;
    off += 8 + chunkLen;
  }
  if (!json) refuse(`${label}: no JSON chunk`);
  return { json, bin };
}

const src = fs.readFileSync(inFile);
const { json: srcJson, bin } = parseGlb(src, inFile);

// ---------------------------------------------------------------------------
// Source validation (fail closed before any transform)
// ---------------------------------------------------------------------------
for (const e of [...(srcJson.extensionsUsed || []), ...(srcJson.extensionsRequired || [])]) {
  if (!ALLOWED_EXTENSIONS.has(e)) refuse(`unsupported extension ${e} (allow-list is fail-closed)`);
}
/** Collect every `extensions` object key in a document. `extras` is never scanned. */
function extensionObjectNames(node, out = new Set()) {
  if (Array.isArray(node)) { node.forEach((v) => extensionObjectNames(v, out)); return out; }
  if (node === null || typeof node !== 'object') return out;
  for (const [key, val] of Object.entries(node)) {
    if (key === 'extras') continue;
    if (key === 'extensions' && val && typeof val === 'object' && !Array.isArray(val)) {
      for (const name of Object.keys(val)) out.add(name);
    }
    extensionObjectNames(val, out);
  }
  return out;
}
for (const name of extensionObjectNames(srcJson)) {
  if (!ALLOWED_EXTENSIONS.has(name)) refuse(`unsupported extension object "${name}" present in document`);
}

const srcAnimations = srcJson.animations || [];
if (srcAnimations.length === 0) refuse('no animations in source — nothing to keep');
if ((srcJson.buffers || []).length > 2) refuse('more than 2 buffers');

srcAnimations.forEach((anim, ai) => {
  const samplers = anim.samplers || [];
  const channels = anim.channels || [];
  if (samplers.length === 0) refuse(`animation ${ai} has no samplers`);
  if (channels.length === 0) refuse(`animation ${ai} has no channels`);
  channels.forEach((ch, ci) => {
    if (typeof ch.sampler !== 'number' || ch.sampler < 0 || ch.sampler >= samplers.length) {
      refuse(`animation ${ai} channel ${ci}: dangling sampler index ${ch.sampler}`);
    }
    const path = ch.target?.path;
    if (path === 'weights') {
      refuse(`animation ${ai} channel ${ci}: target.path "weights" needs morph targets, which live on the meshes this tool removes`);
    }
    const nodeIdx = ch.target?.node;
    if (nodeIdx != null && (nodeIdx < 0 || nodeIdx >= (srcJson.nodes || []).length)) {
      refuse(`animation ${ai} channel ${ci}: dangling target node ${nodeIdx}`);
    }
  });
  samplers.forEach((s, si) => {
    for (const [key, v] of [['input', s.input], ['output', s.output]]) {
      if (typeof v !== 'number' || v < 0 || v >= (srcJson.accessors || []).length) {
        refuse(`animation ${ai} sampler ${si}: dangling ${key} accessor ${v}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The transform, as a pure function of a parsed JSON copy (+ the source BIN).
// Returns the new json, the kept-view repack plan and the index remaps.
// Used once for the real output and once for the V7 expected-JSON rebuild.
// ---------------------------------------------------------------------------
function applyTransform(json) {
  const accessors = json.accessors || [];
  const bufferViews = json.bufferViews || [];
  const animations = json.animations || [];

  // 1. Retained accessors = exactly those an animation sampler reads.
  const keepAcc = new Set();
  for (const anim of animations) for (const s of anim.samplers) { keepAcc.add(s.input); keepAcc.add(s.output); }

  // 2. Retained bufferViews = every view a retained accessor reads (incl. the
  //    two sparse sub-views). A view touched by sparse is never trimmed.
  const keepBv = new Set();
  const noTrim = new Set();
  for (const ai of keepAcc) {
    const a = accessors[ai];
    if (a.bufferView == null) refuse(`accessor ${ai} has no bufferView (zero-filled accessors unsupported for animation data)`);
    keepBv.add(a.bufferView);
    for (const sub of [a.sparse?.indices?.bufferView, a.sparse?.values?.bufferView]) {
      if (sub != null) { keepBv.add(sub); noTrim.add(sub); noTrim.add(a.bufferView); }
    }
  }
  for (const bi of keepBv) {
    const bv = bufferViews[bi];
    if (!bv) refuse(`dangling bufferView index ${bi}`);
    if (bv.extensions?.EXT_meshopt_compression) {
      refuse(`bufferView ${bi} carries animation data but is EXT_meshopt_compression-compressed — sub-range repack would corrupt the stream`);
    }
    if ((bv.buffer ?? 0) !== 0) refuse(`bufferView ${bi} carries animation data on secondary buffer ${bv.buffer} — unsupported layout`);
    if (bv.byteStride) noTrim.add(bi); // stride phase: keep the view whole
  }

  // 3. Trim each retained view down to the span its retained accessors cover
  //    (a view shared with dropped mesh accessors would otherwise keep dead
  //    bytes). `start` rounds DOWN to 4 so accessor byteOffsets stay aligned.
  //    For our clip files this is a no-op (animation data owns its own view).
  const trim = new Map(); // bvIndex -> { start, length }
  for (const bi of keepBv) {
    const bv = bufferViews[bi];
    if (noTrim.has(bi)) { trim.set(bi, { start: 0, length: bv.byteLength }); continue; }
    let min = Infinity, max = 0;
    for (const ai of keepAcc) {
      const a = accessors[ai];
      if (a.bufferView !== bi) continue;
      const off = a.byteOffset ?? 0;
      min = Math.min(min, off);
      max = Math.max(max, off + accessorByteLength(a, bv));
    }
    if (min === Infinity) { trim.set(bi, { start: 0, length: bv.byteLength }); continue; }
    const start = min & ~3;
    const length = Math.min(bv.byteLength, max) - start;
    if (start < 0 || length <= 0 || start + length > bv.byteLength) refuse(`bufferView ${bi}: bad trim span ${start}+${length} of ${bv.byteLength}`);
    trim.set(bi, { start, length });
  }

  // 4. Dense order-preserving remaps.
  const remapArray = (arr, keepSet) => {
    const remap = new Map(); const kept = [];
    arr.forEach((v, i) => { if (keepSet.has(i)) { remap.set(i, kept.length); kept.push(v); } });
    return { remap, kept };
  };
  const accR = remapArray(accessors, keepAcc);
  const bvR = remapArray(bufferViews, keepBv);
  const re = (map, v, what) => {
    if (!map.has(v)) refuse(`dangling ${what} index ${v} during remap`);
    return map.get(v);
  };

  // 5. Rewrite the surviving references.
  for (const anim of animations) {
    for (const s of anim.samplers) {
      s.input = re(accR.remap, s.input, 'accessor');
      s.output = re(accR.remap, s.output, 'accessor');
    }
    // channels are untouched: sampler indices are unchanged (no sampler is
    // dropped) and target.node indices are unchanged (no node is dropped).
  }
  accR.kept.forEach((a) => {
    const srcBv = a.bufferView;
    const delta = trim.get(srcBv).start;
    a.bufferView = re(bvR.remap, srcBv, 'bufferView');
    if (delta !== 0) a.byteOffset = (a.byteOffset ?? 0) - delta;
    if (a.sparse?.indices?.bufferView != null) a.sparse.indices.bufferView = re(bvR.remap, a.sparse.indices.bufferView, 'bufferView');
    if (a.sparse?.values?.bufferView != null) a.sparse.values.bufferView = re(bvR.remap, a.sparse.values.bufferView, 'bufferView');
  });

  // 6. Drop the mesh/material/texture side of the document.
  for (const key of DROPPED_ARRAYS) delete json[key];
  for (const node of json.nodes || []) for (const key of DROPPED_NODE_KEYS) delete node[key];
  json.accessors = accR.kept;
  json.bufferViews = bvR.kept;

  return { json, keepAcc, keepBv, trim, accRemap: accR.remap, bvRemap: bvR.remap };
}

/**
 * Repack the BIN for a transformed json: kept views laid out in source order,
 * 4-byte aligned, byteOffset/byteLength rewritten. Returns the new BIN.
 * `keepBv`/`trim` are in SOURCE index space; `bvRemap` maps them to output.
 */
function repackBin(json, srcBin, { keepBv, trim, bvRemap }) {
  const ordered = [...keepBv].sort((a, b) => a - b);
  const plan = [];
  let cursor = 0;
  for (const bi of ordered) {
    const { start, length } = trim.get(bi);
    cursor = align4(cursor);
    plan.push({ bi, srcOffset: (srcBufferViews[bi].byteOffset ?? 0) + start, length, newOffset: cursor });
    cursor += length;
  }
  const newBinLen = align4(cursor);
  const newBin = Buffer.alloc(newBinLen);
  for (const p of plan) {
    if (p.srcOffset + p.length > srcBin.length) refuse(`bufferView ${p.bi}: source range ${p.srcOffset}+${p.length} exceeds bin ${srcBin.length}`);
    srcBin.copy(newBin, p.newOffset, p.srcOffset, p.srcOffset + p.length);
    const bv = json.bufferViews[bvRemap.get(p.bi)];
    bv.byteOffset = p.newOffset;
    bv.byteLength = p.length;
    bv.buffer = 0;
  }
  json.buffers = [{ byteLength: newBinLen }];

  // extensionsUsed/Required: keep only names that still have an object present.
  const live = extensionObjectNames(json);
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    if (!json[key]) continue;
    const kept = json[key].filter((n) => live.has(n));
    if (kept.length) json[key] = kept; else delete json[key];
  }
  return newBin;
}

const srcBufferViews = srcJson.bufferViews || [];

const work = JSON.parse(JSON.stringify(srcJson));
const t = applyTransform(work);
const newBin = repackBin(work, bin, t);

// ---------------------------------------------------------------------------
// Assemble output
// ---------------------------------------------------------------------------
function assemble(json, binBuf) {
  let jsonOut = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonOut.length % 4) jsonOut = Buffer.concat([jsonOut, Buffer.alloc(4 - (jsonOut.length % 4), 0x20)]);
  const chunk = (type, body) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(body.length, 0); h.writeUInt32LE(type, 4);
    return Buffer.concat([h, body]);
  };
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  const out = Buffer.concat([header, chunk(0x4e4f534a, jsonOut), chunk(0x004e4942, binBuf)]);
  out.writeUInt32LE(out.length, 8);
  return out;
}
const out = assemble(work, newBin);

// ---------------------------------------------------------------------------
// VERIFICATION — property checks on the ASSEMBLED OUTPUT BYTES.
// ---------------------------------------------------------------------------
const errs = [];
{
  const { json: vJson, bin: vBin } = parseGlb(out, 'output');

  /** Bytes an accessor declares, read through its own (json, bin) pair. */
  const accessorBytes = (json, binBuf, ai, label) => {
    const a = json.accessors?.[ai];
    if (!a) { errs.push(`${label}: accessor ${ai} out of range`); return null; }
    const bv = json.bufferViews?.[a.bufferView];
    if (!bv) { errs.push(`${label}: accessor ${ai} bufferView ${a.bufferView} out of range`); return null; }
    const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const len = accessorByteLength(a, bv);
    if (start + len > binBuf.length) { errs.push(`${label}: accessor ${ai} range ${start}+${len} exceeds bin ${binBuf.length}`); return null; }
    return binBuf.subarray(start, start + len);
  };

  // V1 animation structure identical modulo remapped accessor indices.
  const invAcc = new Map([...t.accRemap].map(([s, o]) => [o, s]));
  const backMapped = JSON.parse(JSON.stringify(vJson.animations || []));
  for (const anim of backMapped) {
    for (const s of anim.samplers || []) {
      s.input = invAcc.has(s.input) ? invAcc.get(s.input) : `BAD:${s.input}`;
      s.output = invAcc.has(s.output) ? invAcc.get(s.output) : `BAD:${s.output}`;
    }
  }
  if (JSON.stringify(backMapped) !== JSON.stringify(srcAnimations)) {
    errs.push('V1: animations differ from source after mapping sampler accessor indices back');
  }

  // V2 retained accessor bytes + JSON identical modulo bufferView/byteOffset.
  let bytesVerified = 0;
  for (const si of [...t.keepAcc].sort((a, b) => a - b)) {
    const oi = t.accRemap.get(si);
    const a = accessorBytes(srcJson, bin, si, `V2 accessor ${si} (src)`);
    const b = accessorBytes(vJson, vBin, oi, `V2 accessor ${si}->${oi} (out)`);
    if (a && b) {
      if (a.length !== b.length) errs.push(`V2: accessor ${si}->${oi} length ${a.length} != ${b.length}`);
      else if (!a.equals(b)) errs.push(`V2: accessor ${si}->${oi} bytes differ at declared offsets`);
      else bytesVerified += a.length;
    }
    const strip = (acc) => { const c = { ...acc }; delete c.bufferView; delete c.byteOffset; delete c.sparse; return c; };
    if (JSON.stringify(strip(srcJson.accessors[si])) !== JSON.stringify(strip(vJson.accessors?.[oi] || {}))) {
      errs.push(`V2: accessor ${si}->${oi} JSON drifted (beyond bufferView/byteOffset)`);
    }
  }
  if ((vJson.accessors || []).length !== t.keepAcc.size) {
    errs.push(`V2: output accessor count ${(vJson.accessors || []).length} != retained ${t.keepAcc.size}`);
  }

  // V3 node array identical except the removed keys.
  const expectedNodes = JSON.parse(JSON.stringify(srcJson.nodes || []));
  for (const n of expectedNodes) for (const key of DROPPED_NODE_KEYS) delete n[key];
  if (JSON.stringify(expectedNodes) !== JSON.stringify(vJson.nodes || [])) {
    errs.push('V3: node array is not byte-identical to source-minus-{mesh,skin,weights}');
  }

  // V4 nothing mesh-ish survives.
  for (const key of DROPPED_ARRAYS) if (vJson[key] !== undefined) errs.push(`V4: "${key}" survived in output`);
  (vJson.nodes || []).forEach((n, i) => {
    for (const key of DROPPED_NODE_KEYS) if (n[key] !== undefined) errs.push(`V4: node ${i} kept "${key}"`);
  });

  // V5 reference closure + range/alignment.
  const accCount = (vJson.accessors || []).length;
  const bvCount = (vJson.bufferViews || []).length;
  const nodeCount = (vJson.nodes || []).length;
  (vJson.accessors || []).forEach((a, i) => {
    for (const [v, tag] of [[a.bufferView, 'bufferView'], [a.sparse?.indices?.bufferView, 'sparse.indices'], [a.sparse?.values?.bufferView, 'sparse.values']]) {
      if (v != null && (v < 0 || v >= bvCount)) errs.push(`V5: accessor ${i} ${tag} ref ${v} out of range`);
    }
  });
  (vJson.bufferViews || []).forEach((bv, i) => {
    if ((bv.buffer ?? 0) !== 0) errs.push(`V5: output bufferView ${i} on buffer ${bv.buffer}`);
    if ((bv.byteOffset ?? 0) % 4 !== 0) errs.push(`V5: output bufferView ${i} byteOffset ${bv.byteOffset} not 4-aligned`);
    if ((bv.byteOffset ?? 0) + (bv.byteLength ?? 0) > vBin.length) errs.push(`V5: output bufferView ${i} exceeds bin ${vBin.length}`);
    if (bv.extensions?.EXT_meshopt_compression) errs.push(`V5: output bufferView ${i} is meshopt-compressed`);
  });
  (vJson.animations || []).forEach((anim, ai) => {
    (anim.samplers || []).forEach((s, si) => {
      for (const [v, tag] of [[s.input, 'input'], [s.output, 'output']]) {
        if (typeof v !== 'number' || v < 0 || v >= accCount) errs.push(`V5: animation ${ai} sampler ${si} ${tag} ref ${v} out of range`);
      }
    });
    (anim.channels || []).forEach((ch, ci) => {
      if (ch.sampler < 0 || ch.sampler >= (anim.samplers || []).length) errs.push(`V5: animation ${ai} channel ${ci} sampler ref out of range`);
      if (ch.target?.node != null && (ch.target.node < 0 || ch.target.node >= nodeCount)) errs.push(`V5: animation ${ai} channel ${ci} target node out of range`);
    });
  });
  (vJson.nodes || []).forEach((n, i) => (n.children || []).forEach((c) => {
    if (c < 0 || c >= nodeCount) errs.push(`V5: node ${i} child ref ${c} out of range`);
  }));
  (vJson.scenes || []).forEach((s, i) => (s.nodes || []).forEach((n) => {
    if (n < 0 || n >= nodeCount) errs.push(`V5: scene ${i} node ref ${n} out of range`);
  }));
  if (vJson.buffers?.length !== 1) errs.push(`V5: output buffer count ${vJson.buffers?.length} != 1`);
  else if (vJson.buffers[0].byteLength !== vBin.length) errs.push(`V5: buffer byteLength ${vJson.buffers[0].byteLength} != bin ${vBin.length}`);

  // V6 scenes / scene / asset untouched.
  for (const key of ['scenes', 'scene', 'asset']) {
    if (JSON.stringify(srcJson[key]) !== JSON.stringify(vJson[key])) errs.push(`V6: "${key}" drifted from source`);
  }

  // V7 determinism — rebuild from a fresh copy of the source.
  const fresh = JSON.parse(JSON.stringify(srcJson));
  const t2 = applyTransform(fresh);
  repackBin(fresh, bin, t2);
  if (JSON.stringify(fresh) !== JSON.stringify(vJson)) errs.push('V7: output JSON != independently rebuilt expected JSON');

  // V8 declared extensions still have an object present.
  const live = extensionObjectNames(vJson);
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    for (const name of vJson[key] || []) if (!live.has(name)) errs.push(`V8: ${key} declares "${name}" but no such extension object remains`);
  }

  const kb = (b) => (b / 1024).toFixed(1);
  console.log(`${inFile}: ${kb(src.length)}KB -> ${kb(out.length)}KB  (save ${kb(src.length - out.length)}KB, -${((1 - out.length / src.length) * 100).toFixed(1)}%)`);
  console.log(`kept: ${(vJson.animations || []).length} animation(s), ` +
    `${(vJson.animations || []).reduce((n, a) => n + a.channels.length, 0)} channel(s), ` +
    `${t.keepAcc.size} accessor(s), ${t.keepBv.size} bufferView(s), ${(vJson.nodes || []).length} node(s)`);
  console.log(`dropped: ${(srcJson.meshes || []).length} mesh(es), ${(srcJson.materials || []).length} material(s), ` +
    `${(srcJson.textures || []).length} texture(s), ${(srcJson.images || []).length} image(s), ` +
    `${(srcJson.skins || []).length} skin(s), ${(srcJson.accessors || []).length - t.keepAcc.size} accessor(s), ` +
    `${srcBufferViews.length - t.keepBv.size} bufferView(s)`);
  console.log(`verified ${bytesVerified} accessor byte(s) at declared offsets`);
}

if (errs.length) { console.error('VERIFY-FAIL:\n  ' + errs.join('\n  ')); process.exit(3); }
console.log('verification: PASS (V1 animation structure, V2 accessor bytes@declared offsets, V3 node array, V4 removals, V5 ref closure/ranges, V6 scenes/asset, V7 deterministic rebuild, V8 extension declarations)');
if (!dryRun) { fs.writeFileSync(outFile, out); console.log(`wrote ${outFile}`); }
