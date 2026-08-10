#!/usr/bin/env bun
/**
 * ktx2-texture-diet.test.mjs — adversarial fixtures for the Gate-4 drop tool
 * (Codex tooling review: "adversarial fixture tests required before first
 * asset mutation"). Builds synthetic mini-GLBs in a temp dir and asserts the
 * tool's refusal / success behavior via its exit codes and output bytes.
 *
 * Run: bun scripts/ktx2-texture-diet.test.mjs   (exit 0 = all pass)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const TOOL = path.join(import.meta.dir, 'ktx2-texture-diet.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktx2-diet-test-'));
let failures = 0;

function buildGlb(json, binParts) {
  const bin = Buffer.concat(binParts.map((p) => {
    const pad = (4 - (p.length % 4)) % 4;
    return pad ? Buffer.concat([p, Buffer.alloc(pad)]) : p;
  }));
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const chunk = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32LE(body.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, body]); };
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  const out = Buffer.concat([header, chunk(0x4e4f534a, jsonBuf), chunk(0x004e4942, bin)]);
  out.writeUInt32LE(out.length, 8);
  return out;
}

// A minimal valid base: 2 images (normal png @bv0, color png @bv1), 2 textures,
// 1 material using them, 1 position accessor @bv2.
const IMG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const IMG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
const GEO = Buffer.alloc(36, 0x11);
function baseJson() {
  return {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 8 + 8 + 36 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 8 },
      { buffer: 0, byteOffset: 8, byteLength: 8 },
      { buffer: 0, byteOffset: 16, byteLength: 36 },
    ],
    images: [
      { mimeType: 'image/png', bufferView: 0 },
      { mimeType: 'image/png', bufferView: 1 },
    ],
    textures: [{ source: 0 }, { source: 1 }],
    materials: [{
      pbrMetallicRoughness: { baseColorTexture: { index: 1 } },
      normalTexture: { index: 0 },
    }],
    accessors: [{ bufferView: 2, componentType: 5126, count: 3, type: 'VEC3' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  };
}
const baseBinParts = () => [IMG_A, IMG_B, GEO];

function run(name, json, binParts, expectExit, extraCheck) {
  const inF = path.join(tmp, `${name}.glb`);
  const outF = path.join(tmp, `${name}.out.glb`);
  fs.writeFileSync(inF, buildGlb(json, binParts));
  const r = spawnSync('bun', [TOOL, inF, outF, '--drop-slot=normal'], { encoding: 'utf8', timeout: 60_000 });
  const ok = r.status === expectExit;
  let extraMsg = '';
  let extraOk = true;
  if (ok && extraCheck) { try { extraCheck(outF); } catch (e) { extraOk = false; extraMsg = ` | ${e.message}`; } }
  const pass = ok && extraOk;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} (exit ${r.status}, want ${expectExit})${extraMsg}`);
  if (!pass) { failures++; console.log((r.stdout + r.stderr).split('\n').slice(0, 6).map((l) => `        ${l}`).join('\n')); }
}

console.log('ktx2-texture-diet adversarial fixtures:');

// 1. Unsupported extension in extensionsUsed => refuse.
{ const j = baseJson(); j.extensionsUsed = ['MSFT_texture_dds']; run('refuse-unsupported-extension', j, baseBinParts(), 2); }

// 2. Meshopt parent bufferView on buffer 0 => refuse.
{
  const j = baseJson();
  j.extensionsUsed = ['EXT_meshopt_compression'];
  j.bufferViews[2].extensions = { EXT_meshopt_compression: { buffer: 0, byteOffset: 16, byteLength: 36, byteStride: 12, mode: 'ATTRIBUTES', count: 3 } };
  run('refuse-meshopt-fallback-buffer0', j, baseBinParts(), 2);
}

// 3. Unknown texture-ish key in material => refuse.
{ const j = baseJson(); j.materials[0].fooTexture = { index: 0 }; run('refuse-unknown-texture-key', j, baseBinParts(), 2); }

// 4. Normal image shared with a baseColor texture => refuse.
{ const j = baseJson(); j.textures[1].source = 0; run('refuse-shared-image', j, baseBinParts(), 2); }

// 5. Texture with BOTH core source and basisu source => both images dropped.
{
  const j = baseJson();
  j.extensionsUsed = ['KHR_texture_basisu'];
  j.images.push({ mimeType: 'image/ktx2', bufferView: 1 }); // pretend basisu variant shares bv1? No — give it its own bv
  j.bufferViews.push({ buffer: 0, byteOffset: 52, byteLength: 8 });
  j.images[2].bufferView = 3;
  j.buffers[0].byteLength = 60;
  j.textures[0] = { source: 0, extensions: { KHR_texture_basisu: { source: 2 } } };
  run('drop-all-source-variants', j, [...baseBinParts(), IMG_A], 0, (outF) => {
    const buf = fs.readFileSync(outF);
    const vj = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
    if (vj.images.length !== 1) throw new Error(`expected 1 surviving image, got ${vj.images.length}`);
    if (vj.textures.length !== 1) throw new Error(`expected 1 surviving texture, got ${vj.textures.length}`);
  });
}

// 6. extras containing a texture-shaped object => NOT refused, NOT mutated.
{
  const j = baseJson();
  j.materials[0].extras = { legacyTexture: { index: 99 }, note: 'app metadata' };
  run('extras-untouched', j, baseBinParts(), 0, (outF) => {
    const buf = fs.readFileSync(outF);
    const vj = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
    const ex = vj.materials[0].extras;
    if (!ex || ex.legacyTexture?.index !== 99 || ex.note !== 'app metadata') throw new Error('extras were mutated');
  });
}

// 6b. KNOWN slot key at a WRONG path => refuse (round-2 F1: exact-path check).
{
  const j = baseJson();
  j.extensionsUsed = ['KHR_materials_transmission'];
  j.materials[0].extensions = { KHR_materials_transmission: { baseColorTexture: { index: 1 } } };
  run('refuse-known-key-wrong-path', j, baseBinParts(), 2);
}

// 6b2. ARRAY along a schema-known path (round-3): pbrMetallicRoughness as an
//      array must NOT collapse to the known path string => refuse.
{
  const j = baseJson();
  j.materials[0].pbrMetallicRoughness = [{ baseColorTexture: { index: 1 } }];
  delete j.materials[0].normalTexture;
  j.materials.push({ normalTexture: { index: 0 } }); // keep a valid normal target
  run('refuse-array-along-known-path', j, baseBinParts(), 2);
}

// 6c. Extension object present but not declared/allowed => refuse.
{
  const j = baseJson();
  j.materials[0].extensions = { MSFT_fancy_material: { foo: 1 } };
  run('refuse-undeclared-extension-object', j, baseBinParts(), 2);
}

// 6d. Plain bufferView on a secondary buffer => refuse.
{
  const j = baseJson();
  j.buffers.push({ byteLength: 8 });
  j.bufferViews.push({ buffer: 1, byteOffset: 0, byteLength: 8 });
  run('refuse-secondary-buffer-view', j, baseBinParts(), 2);
}

// 7. No normal map => refuse.
{ const j = baseJson(); delete j.materials[0].normalTexture; run('refuse-no-normal', j, baseBinParts(), 2); }

// 8. Happy path: normal dropped, color image + geometry bytes preserved at declared offsets.
{
  run('happy-drop', baseJson(), baseBinParts(), 0, (outF) => {
    const buf = fs.readFileSync(outF);
    const jl = buf.readUInt32LE(12);
    const vj = JSON.parse(buf.subarray(20, 20 + jl).toString());
    const bin = buf.subarray(20 + jl + 8, 20 + jl + 8 + buf.readUInt32LE(20 + jl));
    if (vj.images.length !== 1 || vj.textures.length !== 1) throw new Error('wrong survivor counts');
    const imgBv = vj.bufferViews[vj.images[0].bufferView];
    if (!bin.subarray(imgBv.byteOffset, imgBv.byteOffset + imgBv.byteLength).equals(IMG_B)) throw new Error('color image bytes wrong');
    const geoBv = vj.bufferViews[vj.accessors[0].bufferView];
    if (!bin.subarray(geoBv.byteOffset, geoBv.byteOffset + geoBv.byteLength).equals(GEO)) throw new Error('geometry bytes wrong');
    if (vj.materials[0].normalTexture) throw new Error('normalTexture survived');
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nRESULT: FAIL (${failures})` : '\nRESULT: PASS');
process.exit(failures ? 1 : 0);
