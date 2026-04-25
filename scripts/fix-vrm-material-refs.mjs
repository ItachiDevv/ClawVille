#!/usr/bin/env node
/**
 * Trim dangling materialProperties entries in VRM 0.x files.
 *
 * Symptom: console warnings on every VRM load:
 *   VRMMaterialsV0CompatPlugin: Attempt to use materials[N] of glTF
 *   but the material doesn't exist
 *
 * Cause: VRM 0.x stores per-material info in
 *   gltf.extensions.VRM.materialProperties[i]  (parallel array to gltf.materials)
 * If materialProperties is longer than materials, the extra entries reference
 * material indices past the end of gltf.materials → the warning.
 *
 * Fix: trim materialProperties to length(materials).
 *
 * Usage:  node scripts/fix-vrm-material-refs.mjs apps/web/public/avatars/*.vrm
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a; // 'JSON'
const BIN_CHUNK = 0x004e4942; // 'BIN\0'

function fixVrm(path) {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  if (dv.getUint32(0, true) !== GLB_MAGIC) {
    console.error(`${path}: not a GLB`);
    return false;
  }

  const totalLen = dv.getUint32(8, true);
  const jsonLen = dv.getUint32(12, true);
  const jsonChunkType = dv.getUint32(16, true);
  if (jsonChunkType !== JSON_CHUNK) {
    console.error(`${path}: first chunk is not JSON`);
    return false;
  }

  const jsonBytes = buf.subarray(20, 20 + jsonLen);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes));

  const materialsCount = (json.materials ?? []).length;
  const matProps = json?.extensions?.VRM?.materialProperties;
  if (!Array.isArray(matProps)) {
    console.log(`${path}: no VRM.materialProperties — skipping`);
    return false;
  }

  if (matProps.length <= materialsCount) {
    console.log(`${path}: already clean (${matProps.length} props ≤ ${materialsCount} mats)`);
    return false;
  }

  const before = matProps.length;
  json.extensions.VRM.materialProperties = matProps.slice(0, materialsCount);
  const after = json.extensions.VRM.materialProperties.length;
  console.log(`${path}: trimmed materialProperties ${before} → ${after}`);

  // Re-encode JSON. Pad to 4-byte boundary with spaces (GLB spec).
  let newJsonStr = JSON.stringify(json);
  while (newJsonStr.length % 4 !== 0) newJsonStr += ' ';
  const newJsonBytes = new TextEncoder().encode(newJsonStr);

  // Read BIN chunk if present.
  let binChunk = null;
  const afterJsonOffset = 20 + jsonLen;
  if (afterJsonOffset + 8 <= buf.length) {
    const binLen = dv.getUint32(afterJsonOffset, true);
    const binType = dv.getUint32(afterJsonOffset + 4, true);
    if (binType === BIN_CHUNK) {
      binChunk = buf.subarray(afterJsonOffset, afterJsonOffset + 8 + binLen);
    }
  }

  // Rebuild GLB.
  const newJsonChunkLen = newJsonBytes.length;
  const newTotalLen = 12 + 8 + newJsonChunkLen + (binChunk?.length ?? 0);
  const out = Buffer.alloc(newTotalLen);
  const outDv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  outDv.setUint32(0, GLB_MAGIC, true);
  outDv.setUint32(4, 2, true); // version
  outDv.setUint32(8, newTotalLen, true);
  outDv.setUint32(12, newJsonChunkLen, true);
  outDv.setUint32(16, JSON_CHUNK, true);
  out.set(newJsonBytes, 20);
  if (binChunk) {
    out.set(binChunk, 20 + newJsonChunkLen);
  }

  writeFileSync(path, out);
  return true;
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error('usage: node fix-vrm-material-refs.mjs <vrm-file...>');
  process.exit(2);
}

let fixed = 0;
for (const arg of inputs) {
  const p = resolve(arg);
  try {
    if (fixVrm(p)) fixed++;
  } catch (err) {
    console.error(`${p}: ERROR — ${err.message}`);
  }
}
console.log(`\nDone. Fixed ${fixed}/${inputs.length} files.`);
