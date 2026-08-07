#!/usr/bin/env bun
/**
 * vrm-pipeline-validate.test.mjs — fixtures for the Gate-1 validator
 * (Codex round-2: two-skins joint bounds, aggregated multi-set weights,
 * thumbnails differing after byte 48).
 *
 * Builds minimal synthetic VRM1-shaped GLBs and asserts validator exit codes.
 * Run: bun scripts/vrm-pipeline-validate.test.mjs   (exit 0 = all pass)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const TOOL = path.join(import.meta.dir, 'vrm-pipeline-validate.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrm-validate-test-'));
let failures = 0;

function buildGlb(json, binParts) {
  const parts = [];
  for (const p of binParts) {
    parts.push(p);
    const pad = (4 - (p.length % 4)) % 4;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  const bin = Buffer.concat(parts);
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const chunk = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32LE(body.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, body]); };
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  const out = Buffer.concat([header, chunk(0x4e4f534a, jsonBuf), chunk(0x004e4942, bin)]);
  out.writeUInt32LE(out.length, 8);
  return out;
}

// Binary pieces (each 4-aligned by builder):
const POS = Buffer.alloc(36);                       // 3 verts float32 VEC3
const f32 = (vals) => { const b = Buffer.alloc(vals.length * 4); vals.forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; };
const u8 = (vals) => Buffer.from(vals);
const IBM1 = f32([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);            // 1 joint
const IBM2 = Buffer.concat([IBM1, IBM1]);                                       // 2 joints
const THUMB_A = Buffer.concat([Buffer.alloc(48, 0xaa), Buffer.alloc(16, 0x01)]); // 64B: shared header + tail 01
const THUMB_B = Buffer.concat([Buffer.alloc(48, 0xaa), Buffer.alloc(16, 0x02)]); // differs only after byte 48

/**
 * Build a minimal VRM: nodes [root, hips(joint), body(mesh+skin)], one skin.
 * opts: { joints0, weights0, joints1?, weights1?, twoSkins?, meshSkin?, thumb }
 */
function vrmJson(opts) {
  const binParts = [];
  const bufferViews = [];
  const accessors = [];
  const addAcc = (bytes, componentType, count, type, normalized) => {
    const offset = binParts.reduce((s, p) => s + p.length + ((4 - (p.length % 4)) % 4), 0);
    binParts.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    accessors.push({ bufferView: bufferViews.length - 1, componentType, count, type, ...(normalized ? { normalized: true } : {}) });
    return accessors.length - 1;
  };
  const posAcc = addAcc(POS, 5126, 3, 'VEC3');
  accessors[posAcc].min = [0, 0, 0]; accessors[posAcc].max = [0, 0, 0];
  const j0Acc = addAcc(u8(opts.joints0), 5121, 3, 'VEC4');
  const w0Acc = addAcc(f32(opts.weights0), 5126, 3, 'VEC4');
  const attrs = { POSITION: posAcc, JOINTS_0: j0Acc, WEIGHTS_0: w0Acc };
  if (opts.joints1) {
    attrs.JOINTS_1 = addAcc(u8(opts.joints1), 5121, 3, 'VEC4');
    attrs.WEIGHTS_1 = addAcc(f32(opts.weights1), 5126, 3, 'VEC4');
  }
  const ibmAcc = addAcc(opts.twoSkins ? IBM2 : IBM1, 5126, opts.twoSkins ? 2 : 1, 'MAT4');
  const ibmAccA = opts.twoSkins ? addAcc(IBM1, 5126, 1, 'MAT4') : ibmAcc;
  // thumbnail image
  const thumbOffset = binParts.reduce((s, p) => s + p.length + ((4 - (p.length % 4)) % 4), 0);
  binParts.push(opts.thumb);
  bufferViews.push({ buffer: 0, byteOffset: thumbOffset, byteLength: opts.thumb.length });
  const thumbBv = bufferViews.length - 1;

  const nodes = [
    { name: 'root', children: [1, 2, 3] },
    { name: 'hips' },
    { name: 'spine' },
    { name: 'body', mesh: 0, skin: opts.meshSkin ?? 0 },
  ];
  const skins = opts.twoSkins
    ? [{ joints: [1], inverseBindMatrices: ibmAccA }, { joints: [1, 2], inverseBindMatrices: ibmAcc }]
    : [{ joints: [1], inverseBindMatrices: ibmAcc }];
  const binLen = binParts.reduce((s, p) => s + p.length + ((4 - (p.length % 4)) % 4), 0);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    skins,
    meshes: [{ primitives: [{ attributes: attrs, mode: 4 }] }],
    images: [{ mimeType: 'image/png', bufferView: thumbBv }],
    buffers: [{ byteLength: binLen }],
    bufferViews,
    accessors,
    extensionsUsed: ['VRMC_vrm'],
    extensions: {
      VRMC_vrm: {
        specVersion: '1.0',
        humanoid: { humanBones: { hips: { node: 1 } } },
        meta: { name: 'fixture', thumbnailImage: 0 },
      },
    },
  };
  return { json, binParts };
}

function write(name, opts) {
  const { json, binParts } = vrmJson(opts);
  const f = path.join(tmp, `${name}.vrm`);
  fs.writeFileSync(f, buildGlb(json, binParts));
  return f;
}

function run(name, a, b, expectExit, mustMention) {
  const r = spawnSync('bun', [TOOL, a, b], { encoding: 'utf8', timeout: 120_000 });
  const out = r.stdout + r.stderr;
  const ok = r.status === expectExit && (!mustMention || out.includes(mustMention));
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} (exit ${r.status}, want ${expectExit}${mustMention ? `, mentions ${mustMention}` : ''})`);
  if (!ok) { failures++; console.log(out.split('\n').filter((l) => /FAIL|error/.test(l)).slice(0, 6).map((l) => `        ${l}`).join('\n')); }
}

console.log('vrm-pipeline-validate fixtures:');

const W1 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];   // full weight on influence 0
const J0 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// 1. Identity on a healthy single-skin VRM => PASS.
const base = write('base', { joints0: J0, weights0: W1, thumb: THUMB_A });
run('identity-pass', base, base, 0);

// 2. Thumbnail differs ONLY after byte 48 => S13 must FAIL.
const thumbTail = write('thumb-tail', { joints0: J0, weights0: W1, thumb: THUMB_B });
run('thumbnail-tail-drift', base, thumbTail, 3, 'S13');

// 3. Two skins with different joint counts; mesh bound to the 1-joint skin but
//    JOINTS references joint 1 => S12 must FAIL (a global-max check would pass).
const twoSkinsBad = write('two-skins-bad', {
  joints0: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], weights0: W1,
  twoSkins: true, meshSkin: 0, thumb: THUMB_A,
});
run('two-skins-joint-bounds', twoSkinsBad, twoSkinsBad, 3, 'S12');

// 4. Two weight sets each summing 0.5 (aggregate 1.0) => S12 must PASS
//    (a per-set sum check would fail this valid asset).
const half = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0];
const multiSet = write('multi-set', { joints0: J0, weights0: half, joints1: J0, weights1: half, thumb: THUMB_A });
run('multi-set-aggregate-weights', multiSet, multiSet, 0);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nRESULT: FAIL (${failures})` : '\nRESULT: PASS');
process.exit(failures ? 1 : 0);
