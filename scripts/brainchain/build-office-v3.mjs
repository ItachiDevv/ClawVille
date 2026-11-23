#!/usr/bin/env node
// Build the BrainChain Office v3 world assets from the raw Meshy outputs
// (founder 2026-11-11: orbit-sculpture building + brain-head clerk robot).
//
//   node scripts/brainchain/build-office-v3.mjs <building|sculpture|pod|desk> <raw.glb> <out.glb>
//   node scripts/brainchain/build-office-v3.mjs robot <rigged.glb> <animDir> <out.glb>
//
// Both targets:
//   - Keep ONE material with the base color only. Meshy's normal, metal/rough and
//     emissive maps are dropped: the emissive map lights random white patches.
//   - Build a new emissive map from the base color: pixels that are BrainChain
//     pink (#f386a1 family) glow, every other pixel is black. This lights the
//     seams, the vortex spiral, the visor ring and the chest smile with no extra
//     mesh, light or per-frame cost.
//   - Simplify with meshoptimizer to the triangle budget, then UASTC KTX2 with a
//     full mip chain, meshopt geometry compression and quantization.
// Robot only: the clips from <animDir>/{idle,talk,wave,walk}.glb are copied onto
// the rigged skeleton (same Meshy rig task, so joint names match) and renamed
// Idle / Talk / Wave / Walk. The resident loader plays the clip matching /idle/i.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, weld, prune, simplify, meshopt, getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync, statSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const BUDGET = {
  building: { tris: 12_000, bytes: 1.6 * 1024 * 1024 },
  robot: { tris: 12_000, bytes: 1.6 * 1024 * 1024 },
  // Interior props (founder 2026-11-12). Same glow mask: the pink paint glows.
  sculpture: { tris: 8_000, bytes: 1.0 * 1024 * 1024 },
  pod: { tris: 6_000, bytes: 0.9 * 1024 * 1024 },
  desk: { tris: 5_000, bytes: 0.9 * 1024 * 1024 },
};
const CLIPS = [['idle', 'Idle'], ['talk', 'Talk'], ['wave', 'Wave'], ['walk', 'Walk']];

const [target, input, a3, a4] = process.argv.slice(2);
const output = target === 'robot' ? a4 : a3;
if (!BUDGET[target] || !input || !output || (target === 'robot' && !a3)) {
  throw new Error('usage: <building|sculpture|pod|desk> <raw.glb> <out.glb> | robot <rigged.glb> <animDir> <out.glb>');
}
const work = resolve('.brainchain-work/office-v3', target);
mkdirSync(work, { recursive: true });
mkdirSync(dirname(resolve(output)), { recursive: true });
await MeshoptDecoder.ready; await MeshoptEncoder.ready; await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
});
const triCount = (root) => root.listMeshes().reduce((s, m) => s + m.listPrimitives().reduce(
  (n, p) => n + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0), 0);

const doc = await io.read(input);
const root = doc.getRoot();
if (root.listMaterials().length !== 1) throw new Error(`expected 1 material, got ${root.listMaterials().length}`);
const material = root.listMaterials()[0];
const baseTex = material.getBaseColorTexture();
if (!baseTex) throw new Error('no base color texture');

// Robot: replace Meshy's placeholder clip with the four named clips.
if (target === 'robot') {
  if (root.listSkins().length !== 1) throw new Error('expected one skin');
  for (const a of root.listAnimations()) a.dispose();
  const byName = new Map(root.listNodes().map((n) => [n.getName(), n]));
  const buffer = root.listBuffers()[0];
  for (const [file, name] of CLIPS) {
    const path = join(a3, `${file}.glb`);
    if (!existsSync(path)) throw new Error(`missing clip ${path}`);
    const src = (await io.read(path)).getRoot().listAnimations();
    if (src.length !== 1) throw new Error(`${file}: expected 1 clip, got ${src.length}`);
    const anim = doc.createAnimation(name);
    const samplers = new Map();
    for (const ch of src[0].listChannels()) {
      const node = byName.get(ch.getTargetNode()?.getName());
      if (!node) throw new Error(`${file}: joint ${ch.getTargetNode()?.getName()} not in the rigged skeleton`);
      const s = ch.getSampler();
      let copy = samplers.get(s);
      if (!copy) {
        const acc = (a) => doc.createAccessor().setType(a.getType()).setArray(a.getArray().slice()).setBuffer(buffer);
        copy = doc.createAnimationSampler().setInput(acc(s.getInput())).setOutput(acc(s.getOutput())).setInterpolation(s.getInterpolation());
        samplers.set(s, copy);
        anim.addSampler(copy);
      }
      anim.addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(ch.getTargetPath()).setSampler(copy));
    }
  }
}

// Material: base color only, matte, plus the pink glow mask as emissive.
for (const t of [material.getNormalTexture(), material.getMetallicRoughnessTexture(), material.getEmissiveTexture(), material.getOcclusionTexture()]) {
  if (t && t !== baseTex) t.dispose();
}
material.setNormalTexture(null).setMetallicRoughnessTexture(null).setOcclusionTexture(null)
  .setMetallicFactor(0).setRoughnessFactor(0.8);

// toColourspace: Meshy prop JPEGs fail the raw read without an explicit sRGB space
// (libvips "colourspace: parameter space not set").
const { data, info } = await sharp(baseTex.getImage()).toColourspace("srgb").resize(1024, 1024).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const glow = Buffer.alloc(data.length);
let glowPixels = 0;
for (let i = 0; i < data.length; i += 3) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  // BrainChain pink: red high, green clearly lower, blue between. Off-white
  // (r≈g≈b) and charcoal (all low) stay black.
  if (r > 170 && r - g > 55 && b > 80 && b < r) { glow[i] = r; glow[i + 1] = g; glow[i + 2] = b; glowPixels++; }
}
const basePng = join(work, 'base.png');
const glowPng = join(work, 'glow.png');
await sharp(data, { raw: info }).png().toFile(basePng);
await sharp(glow, { raw: info }).resize(512, 512).png().toFile(glowPng);
const glowTex = doc.createTexture('glow').setImage(readFileSync(glowPng)).setMimeType('image/png');
material.setEmissiveTexture(glowTex).setEmissiveFactor([1, 1, 1]);
const glowShare = glowPixels / (info.width * info.height);

const toktx = process.env.KTX2_TOKTX_EXE || resolve(process.env.USERPROFILE, 'scoop/apps/ktx-software/current/bin/toktx.exe');
function ktx(png, size) {
  const out = png.replace(/\.png$/, '.ktx2');
  const r = spawnSync(toktx, ['--t2', '--genmipmap', '--encode', 'uastc', '--uastc_quality', '4', '--uastc_rdo_l', '2', '--zcmp', '18', '--assign_oetf', 'srgb', out, png], { encoding: 'utf8', timeout: 180_000, windowsHide: true });
  if (r.status !== 0) throw new Error(`toktx failed (${toktx}): ${r.error?.message ?? r.stderr}`);
  const bytes = readFileSync(out);
  if (bytes.readUInt32LE(40) !== Math.log2(size) + 1) throw new Error(`expected a full ${size} mip chain`);
  return bytes;
}
baseTex.setImage(ktx(basePng, 1024)).setMimeType('image/ktx2');
glowTex.setImage(ktx(glowPng, 512)).setMimeType('image/ktx2');
doc.createExtension(KHRTextureBasisu).setRequired(true);

const before = getBounds(root.listScenes()[0]);
const rawTris = triCount(root);
const ratio = Math.min(1, BUDGET[target].tris / rawTris);
await doc.transform(
  dedup(), prune(), weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.02, lockBorder: false }),
  prune(),
);
const tris = triCount(root);
if (tris > BUDGET[target].tris * 1.05) throw new Error(`simplify left ${tris} triangles, budget ${BUDGET[target].tris}`);
// Bounds check before quantization: on a skinned mesh, quantization moves the
// position scale into the inverse bind matrices, so raw bounds change by design.
const after = getBounds(root.listScenes()[0]);
for (const side of ['min', 'max']) for (let axis = 0; axis < 3; axis++) {
  const span = before.max[axis] - before.min[axis];
  if (Math.abs(before[side][axis] - after[side][axis]) > span * 0.02) throw new Error(`simplify moved the ${side} bound on axis ${axis}`);
}
await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high', quantizePosition: 14, quantizeTexcoord: 16 }));

const candidate = `${output}.candidate.glb`;
await io.write(candidate, doc);
const check = (await io.read(candidate)).getRoot();
if (target === 'robot') {
  const names = check.listAnimations().map((a) => a.getName());
  if (CLIPS.some(([, n]) => !names.includes(n))) throw new Error(`clips missing: ${names}`);
}
const bytes = statSync(candidate).size;
if (bytes > BUDGET[target].bytes) throw new Error(`asset is ${bytes} bytes, cap ${BUDGET[target].bytes}`);
renameSync(candidate, output);
const report = {
  target, input, output, rawTriangles: rawTris, triangles: tris, bytes,
  sha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
  sourceSha256: createHash('sha256').update(readFileSync(input)).digest('hex'),
  textures: check.listTextures().map((t) => ({ name: t.getName(), mime: t.getMimeType(), size: t.getSize(), bytes: t.getImage().byteLength })),
  glowShare: Number(glowShare.toFixed(4)),
  animations: check.listAnimations().map((a) => ({ name: a.getName(), channels: a.listChannels().length })),
  joints: check.listSkins()[0]?.listJoints().length ?? 0,
  bounds: after,
};
writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
