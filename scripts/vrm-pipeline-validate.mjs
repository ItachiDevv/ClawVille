#!/usr/bin/env bun
/**
 * vrm-pipeline-validate.mjs — Gate-1 VRM skin-safety validator (cold-load rung 2).
 *
 * Census REV 3 §Gates 1: gltf-transform's meshopt()/quantize() internal cleanup
 * can DELETE a live Skin (proven on the chibi VRMs 2026-08-07), and VRMC
 * capture/reinject cannot restore deleted core skins/IBM/nodes. Every VRM that
 * passes through assets-optimize.ts or decimate-vrm.ts MUST pass this validator
 * (source vs output) before shipping.
 *
 * Checks:
 *   S1  skins count identical, and per-skin joint COUNT identical
 *   S2  per-skin joint node NAMES identical in order (index-independent)
 *   S3  inverse-bind matrices byte-identical (decoded float32 arrays compared)
 *   S4  every node: name / parent-name / mesh-ness / skin-ness preserved
 *   S5  raw VRMC_* / VRM root extension JSON byte-identical in the output GLB
 *       chunk (the reinjection contract), except an allowed thumbnail remap
 *   S6  VRM humanoid bone map resolves to the SAME node names on both sides
 *   S7  per-primitive morph-target COUNT identical (VRM0 blendshape indices
 *       bind by position)
 *   S8  primitive count + per-primitive attribute semantics identical
 *
 * Usage: bun scripts/vrm-pipeline-validate.mjs <source.vrm> <output.vrm>
 * Exit: 0 all pass · 3 any check failed · 2 usage/read error
 */
import * as fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [srcFile, outFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!srcFile || !outFile) { console.error('Usage: bun scripts/vrm-pipeline-validate.mjs <source.vrm> <output.vrm>'); process.exit(2); }

function rawJson(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const len = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
});

const failures = [];
const check = (id, cond, detail) => {
  if (cond) console.log(`  ${id}  PASS`);
  else { console.log(`  ${id}  FAIL — ${detail}`); failures.push(id); }
};

let sj, oj, sDoc, oDoc;
try {
  sj = rawJson(srcFile);
  oj = rawJson(outFile);
  sDoc = await io.read(srcFile);
  oDoc = await io.read(outFile);
} catch (e) {
  console.error(`read error: ${e.message || e}`);
  process.exit(2);
}

// --- S1/S2/S3 via decoded documents (index-independent, meshopt-decoded) ----
const sSkins = sDoc.getRoot().listSkins();
const oSkins = oDoc.getRoot().listSkins();
check('S1', sSkins.length === oSkins.length && sSkins.length > 0,
  `skins ${sSkins.length} -> ${oSkins.length}`);

if (sSkins.length === oSkins.length) {
  for (let i = 0; i < sSkins.length; i++) {
    const sJoints = sSkins[i].listJoints().map((n) => n.getName());
    const oJoints = oSkins[i].listJoints().map((n) => n.getName());
    check(`S2.${i}`, JSON.stringify(sJoints) === JSON.stringify(oJoints),
      `joint names differ (${sJoints.length} vs ${oJoints.length})`);
    const sIbm = sSkins[i].getInverseBindMatrices()?.getArray();
    const oIbm = oSkins[i].getInverseBindMatrices()?.getArray();
    const same = !!sIbm && !!oIbm && sIbm.length === oIbm.length &&
      Buffer.from(sIbm.buffer, sIbm.byteOffset, sIbm.byteLength)
        .equals(Buffer.from(oIbm.buffer, oIbm.byteOffset, oIbm.byteLength));
    check(`S3.${i}`, same, `inverse-bind matrices differ (len ${sIbm?.length} vs ${oIbm?.length})`);
  }
}

// --- S4 node graph ----------------------------------------------------------
const nodeSig = (doc) => doc.getRoot().listNodes().map((n) => ({
  name: n.getName(),
  parent: n.getParentNode()?.getName() ?? null,
  hasMesh: !!n.getMesh(),
  hasSkin: !!n.getSkin(),
}));
check('S4', JSON.stringify(nodeSig(sDoc)) === JSON.stringify(nodeSig(oDoc)), 'node graph signature drifted');

// --- S5 raw VRM extension JSON equality (allow thumbnail image-index remap) --
for (const extName of ['VRMC_vrm', 'VRMC_springBone', 'VRMC_node_constraint', 'VRMC_materials_mtoon', 'VRM']) {
  const a = sj.extensions?.[extName];
  const b = oj.extensions?.[extName];
  if (a === undefined && b === undefined) continue;
  if (a === undefined || b === undefined) {
    check(`S5.${extName}`, false, `${extName} ${a === undefined ? 'appeared in' : 'MISSING from'} output`);
    continue;
  }
  const norm = (x) => {
    const c = JSON.parse(JSON.stringify(x));
    if (c?.meta && 'thumbnailImage' in c.meta) delete c.meta.thumbnailImage;
    if (c?.meta && 'texture' in c.meta) delete c.meta.texture;
    return c;
  };
  check(`S5.${extName}`, JSON.stringify(norm(a)) === JSON.stringify(norm(b)),
    `${extName} JSON differs beyond the allowed thumbnail remap`);
}

// --- S6 humanoid bone map resolves to same node names -----------------------
const boneMapNames = (j) => {
  const out = {};
  const v1 = j.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (v1) for (const [bone, ref] of Object.entries(v1)) out[bone] = j.nodes?.[ref.node]?.name ?? `#${ref.node}`;
  const v0 = j.extensions?.VRM?.humanoid?.humanBones;
  if (Array.isArray(v0)) for (const hb of v0) out[hb.bone] = j.nodes?.[hb.node]?.name ?? `#${hb.node}`;
  return out;
};
const sBones = boneMapNames(sj), oBones = boneMapNames(oj);
check('S6', Object.keys(sBones).length > 0 && JSON.stringify(sBones) === JSON.stringify(oBones),
  `humanoid bone map drifted (${Object.keys(sBones).length} vs ${Object.keys(oBones).length} bones)`);

// --- S7/S8 primitives: morph target counts + attribute semantics ------------
const primSig = (doc, withCounts) => doc.getRoot().listMeshes().map((m) => m.listPrimitives().map((p) => ({
  targets: p.listTargets().length,
  attrs: p.listSemantics().sort(),
})));
check('S7+S8', JSON.stringify(primSig(sDoc)) === JSON.stringify(primSig(oDoc)),
  'primitive structure (morph target count / attribute semantics) drifted');

console.log(failures.length ? `\nRESULT: FAIL (${failures.join(', ')})` : '\nRESULT: PASS');
process.exit(failures.length ? 3 : 0);
