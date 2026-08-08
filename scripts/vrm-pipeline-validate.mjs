#!/usr/bin/env bun
/**
 * vrm-pipeline-validate.mjs — Gate-1 VRM skin-safety validator (rung 2). v2.
 *
 * Census REV 3 §Gates 1: gltf-transform's meshopt()/quantize() internal cleanup
 * can DELETE a live Skin (proven on the chibi VRMs 2026-08-07). Every VRM that
 * passes through assets-optimize.ts or decimate-vrm.ts MUST pass this validator
 * (source vs output) before shipping.
 *
 * v2 (Codex tooling review findings 4–6) — checks:
 *   S1   skins count identical (and > 0)
 *   S2   per-skin joint node NAMES identical in order
 *   S3   inverse-bind matrices byte-identical + accessor metadata identical
 *        (type/componentType/normalized/count)
 *   S4   node graph signature (name/parent/mesh-ness/skin-ness) identical
 *   S5   root VRM extension JSON identical (VRMC_vrm / VRMC_springBone / VRM),
 *        thumbnail/meta-texture indices excluded (resolved semantically in S13)
 *   S6   humanoid bone map resolves to the SAME node names
 *   S7   per-primitive morph-target count AND per-target attribute semantics
 *   S8   primitive count, attribute semantics, material INDEX + mode per prim
 *   S9   materials array raw-identical (covers per-material VRMC_materials_mtoon,
 *        core PBR props, count and order — catches material dedup/prune)
 *   S10  nodes + scenes raw-identical (covers per-node VRMC_node_constraint,
 *        TRS/matrix, children, mesh/skin indices, scene-root membership)
 *   S11  skins raw-identical modulo the inverseBindMatrices ACCESSOR INDEX
 *        (covers skeleton root + joint index lists)
 *   S12  output JOINTS/WEIGHTS validity: every joint index < joint count;
 *        weights finite, >= 0, per-vertex sum ~1 (or all-zero)
 *   S13  spring-bone joints/colliders and VRM thumbnail resolve to the same
 *        node NAMES / image BYTES on both sides
 *
 * NOTE decimation caveat: after simplify(), JOINTS/WEIGHTS VALUES change with
 * the surviving vertex set — S12 checks VALIDITY, not value equality. S9/S10/
 * S11 raw-equality checks assume the pipeline does not rewrite materials/
 * nodes/skins JSON at all (true for assets-optimize + decimate-vrm by design);
 * if a legitimate pipeline change ever trips them, that is a deliberate
 * decision to make, not a tolerance to widen silently.
 *
 * Usage: bun scripts/vrm-pipeline-validate.mjs <source.vrm> <output.vrm>
 * Exit: 0 all pass · 3 any check failed · 2 usage/read error
 */
import * as fs from 'fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const flagArgs = process.argv.slice(2).filter((a) => a.startsWith('--'));
// --expect-texture-diet: the output came from ktx2-texture-diet (normal-slot
// drop). S9 then compares materials with the INTENDED change normalized out
// (normalTexture / VRM0 _BumpMap removed on the source side; texture .index
// values masked on both sides since the diet remaps them) — every OTHER
// material property must still match exactly. All other checks stay strict.
const expectTextureDiet = flagArgs.includes('--expect-texture-diet');
// --expect-quantize: the output came from the quantizing meshopt chain
// (assets-optimize/decimate-vrm). gltf-transform's quantize() bakes the
// position-quantization volume transform into skinned meshes' IBMs as
// DELIBERATE COMPENSATION (render-equivalent; the live showpiece VRMs shipped
// this way). S3 then replaces byte-equality with a geometric-consistency
// check: every joint's compensation A_j = IBM_old_j^-1 * IBM_new_j must be
// ONE shared affine, scale+translation only (no rotation/shear), within eps.
const expectQuantize = flagArgs.includes('--expect-quantize');
for (const f of flagArgs) {
  if (f !== '--expect-texture-diet' && f !== '--expect-quantize') { console.error(`unknown flag ${f}`); process.exit(2); }
}
const [srcFile, outFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!srcFile || !outFile) { console.error('Usage: bun scripts/vrm-pipeline-validate.mjs <source.vrm> <output.vrm> [--expect-texture-diet] [--expect-quantize]'); process.exit(2); }

function parseGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const totalLen = buf.readUInt32LE(8);
  let off = 12, json = null, bin = Buffer.alloc(0);
  while (off < totalLen) {
    const chunkLen = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + chunkLen).toString('utf8'));
    else if (type === 0x004e4942) bin = buf.subarray(off + 8, off + 8 + chunkLen);
    off += 8 + chunkLen;
  }
  return { json, bin };
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
});

let s, o, sDoc, oDoc;
try {
  s = parseGlb(srcFile); o = parseGlb(outFile);
  sDoc = await io.read(srcFile); oDoc = await io.read(outFile);
} catch (e) {
  console.error(`read error: ${e.message || e}`);
  process.exit(2);
}
const sj = s.json, oj = o.json;

const failures = [];
const check = (id, cond, detail) => {
  if (cond) console.log(`  ${id}  PASS`);
  else { console.log(`  ${id}  FAIL — ${detail}`); failures.push(id); }
};
const jeq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// --- S1/S2/S3 skins via decoded documents -----------------------------------
const sSkins = sDoc.getRoot().listSkins();
const oSkins = oDoc.getRoot().listSkins();
check('S1', sSkins.length === oSkins.length && sSkins.length > 0, `skins ${sSkins.length} -> ${oSkins.length}`);
if (sSkins.length === oSkins.length) {
  for (let i = 0; i < sSkins.length; i++) {
    const sJ = sSkins[i].listJoints().map((n) => n.getName());
    const oJ = oSkins[i].listJoints().map((n) => n.getName());
    check(`S2.${i}`, jeq(sJ, oJ), `joint names differ (${sJ.length} vs ${oJ.length})`);
    const sA = sSkins[i].getInverseBindMatrices();
    const oA = oSkins[i].getInverseBindMatrices();
    const sIbm = sA?.getArray(), oIbm = oA?.getArray();
    const metaEqual = !!sA && !!oA && sA.getType() === oA.getType() && sA.getComponentType() === oA.getComponentType() &&
      sA.getNormalized() === oA.getNormalized() && sA.getCount() === oA.getCount();
    if (!expectQuantize) {
      const bytesEqual = !!sIbm && !!oIbm && sIbm.length === oIbm.length &&
        Buffer.from(sIbm.buffer, sIbm.byteOffset, sIbm.byteLength).equals(Buffer.from(oIbm.buffer, oIbm.byteOffset, oIbm.byteLength));
      check(`S3.${i}`, bytesEqual && metaEqual,
        !metaEqual ? 'IBM accessor metadata differs' : `IBM bytes differ (len ${sIbm?.length} vs ${oIbm?.length})`);
    } else {
      // Geometric-consistency mode v2 (B2 Codex review MAJORs 1-2): the
      // expected compensation Q is DERIVED FROM THE POSITION DATA, not merely
      // assumed shared — a fabricated shared affine (e.g. diag(0,0,0,1))
      // cannot pass because the positions pin Q. Verified in residual form
      // IBM_new ~= IBM_old * Q with NO matrix inversions; every value must be
      // finite; nothing is silently skipped.
      const jc = sA.getCount();
      let problem = null;
      const EPS = 1e-3;
      // 1. Meshes bound to this skin on both sides (paired by node identity;
      //    S10/S11 already pin node/skin structure equality).
      const sNodes = sDoc.getRoot().listNodes();
      const oNodes = oDoc.getRoot().listNodes();
      const meshPairs = [];
      for (let n = 0; n < sNodes.length; n++) {
        if (sNodes[n].getSkin() === sSkins[i] && sNodes[n].getMesh()) {
          if (!(oNodes[n]?.getSkin() === oSkins[i]) || !oNodes[n]?.getMesh()) { problem = `node ${n}: mesh/skin binding drifted`; break; }
          meshPairs.push([sNodes[n].getMesh(), oNodes[n].getMesh()]);
        }
      }
      if (!problem && meshPairs.length === 0) problem = 'skin bound to no mesh';
      // 2. Derive Q per bound mesh from POSITION bounds (dequantized via
      //    getElement) and require the SAME Q across all meshes of this skin
      //    (quantize() computes one volume per mesh; a shared skin cannot
      //    compensate two different volumes — that case must FAIL).
      let Q = null; // {s:[3], t:[3]}
      const el = [0, 0, 0];
      for (const [sm, om] of problem ? [] : meshPairs) {
        const bounds = (mesh) => {
          const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
          for (const prim of mesh.listPrimitives()) {
            const pos = prim.getAttribute('POSITION');
            if (!pos) return null;
            for (let v = 0; v < pos.getCount(); v++) {
              pos.getElement(v, el);
              for (let k = 0; k < 3; k++) {
                if (!Number.isFinite(el[k])) return 'nonfinite';
                if (el[k] < min[k]) min[k] = el[k];
                if (el[k] > max[k]) max[k] = el[k];
              }
            }
          }
          return { min, max };
        };
        const bs = bounds(sm), bo = bounds(om);
        if (bs === null || bo === null) { problem = 'skinned primitive missing POSITION'; break; }
        if (bs === 'nonfinite' || bo === 'nonfinite') { problem = 'non-finite POSITION data'; break; }
        const s = [], t = [];
        for (let k = 0; k < 3; k++) {
          const dOld = bs.max[k] - bs.min[k], dNew = bo.max[k] - bo.min[k];
          if (!(dNew > 1e-12)) { problem = `degenerate quantized extent on axis ${k}`; break; }
          s[k] = dOld / dNew;
          t[k] = bs.min[k] - s[k] * bo.min[k];
          if (!Number.isFinite(s[k]) || !Number.isFinite(t[k]) || s[k] <= 0) { problem = `bad derived scale/offset on axis ${k}`; break; }
        }
        if (problem) break;
        // quantize() uses one uniform scale; allow small anisotropy tolerance.
        const sAvg = (s[0] + s[1] + s[2]) / 3;
        if (Math.abs(s[0] - sAvg) > EPS * sAvg || Math.abs(s[1] - sAvg) > EPS * sAvg || Math.abs(s[2] - sAvg) > EPS * sAvg) {
          problem = `derived scale not uniform (${s.map((v) => v.toFixed(5)).join(',')})`;
          break;
        }
        if (!Q) Q = { s, t };
        else {
          for (let k = 0; k < 3; k++) {
            if (Math.abs(Q.s[k] - s[k]) > EPS * Math.max(Q.s[k], s[k]) || Math.abs(Q.t[k] - t[k]) > EPS * Math.max(1, Math.abs(Q.t[k]))) {
              problem = 'two meshes bound to one skin have DIFFERENT quantization volumes';
              break;
            }
          }
          if (problem) break;
        }
        // 3. ORDER-INDEPENDENT position sanity: meshopt REORDERS vertices, so
        //    indexed pairing is invalid. Instead the per-axis centroid and
        //    mean absolute deviation of the whole cloud must map through Q
        //    (statistics are permutation-invariant; gross position corruption
        //    breaks them, quantization noise does not).
        const stats = (mesh) => {
          const sum = [0, 0, 0]; let n = 0;
          const tmp = [0, 0, 0];
          for (const prim of mesh.listPrimitives()) {
            const pos = prim.getAttribute('POSITION');
            for (let v = 0; v < pos.getCount(); v++) { pos.getElement(v, tmp); for (let k = 0; k < 3; k++) sum[k] += tmp[k]; n++; }
          }
          const mean = sum.map((v) => v / n);
          const mad = [0, 0, 0];
          for (const prim of mesh.listPrimitives()) {
            const pos = prim.getAttribute('POSITION');
            for (let v = 0; v < pos.getCount(); v++) { pos.getElement(v, tmp); for (let k = 0; k < 3; k++) mad[k] += Math.abs(tmp[k] - mean[k]); }
          }
          return { mean, mad: mad.map((v) => v / n), n };
        };
        const stOld = stats(sm), stNew = stats(om);
        if (stOld.n !== stNew.n) { problem = `POSITION vertex count drifted (${stOld.n} vs ${stNew.n})`; break; }
        const posTol = 8 * (sAvg / 32767) + 1e-6;
        for (let k = 0; k < 3; k++) {
          if (Math.abs(stOld.mean[k] - (s[k] * stNew.mean[k] + t[k])) > posTol) { problem = `axis ${k}: position centroid does not map through Q`; break; }
          if (Math.abs(stOld.mad[k] - s[k] * stNew.mad[k]) > posTol) { problem = `axis ${k}: position spread does not map through Q`; break; }
        }
        if (problem) break;
      }
      // 4. Every joint, no skips: IBM_new_j ~= IBM_old_j * Q (residual form,
      //    no inversions). Column-major: right-multiplying by Q (scale s +
      //    translation t) gives: newCol_c = oldCol_c * s[c] for c<3, and
      //    newCol_3 = old * [t,1] = t0*col0 + t1*col1 + t2*col2 + col3.
      if (!problem && (!sIbm || !oIbm || sIbm.length !== jc * 16 || oIbm.length !== jc * 16)) problem = 'IBM accessor missing or wrong length';
      for (let j = 0; j < jc && !problem && Q; j++) {
        const o16 = j * 16;
        for (let idx = 0; idx < 16 && !problem; idx++) {
          if (!Number.isFinite(sIbm[o16 + idx]) || !Number.isFinite(oIbm[o16 + idx])) { problem = `joint ${j}: non-finite IBM value`; break; }
        }
        if (problem) break;
        for (let c = 0; c < 4 && !problem; c++) {
          for (let r = 0; r < 4; r++) {
            const old = (k) => sIbm[o16 + k * 4 + r];
            const expected = c < 3
              ? old(c) * Q.s[c]
              : Q.t[0] * old(0) + Q.t[1] * old(1) + Q.t[2] * old(2) + old(3);
            const got = oIbm[o16 + c * 4 + r];
            const tol = EPS * Math.max(1, Math.abs(expected));
            if (Math.abs(got - expected) > tol) {
              problem = `joint ${j}: IBM col ${c} row ${r} deviates from IBM_old*Q (${expected.toFixed(5)} vs ${got.toFixed(5)})`;
              break;
            }
          }
        }
      }
      check(`S3.${i}`, metaEqual && !problem && !!Q,
        !metaEqual ? 'IBM accessor metadata differs' : (problem ?? 'no Q derivable'));
    }
  }
}

// --- S4 node graph signature ------------------------------------------------
const nodeSig = (doc) => doc.getRoot().listNodes().map((n) => ({
  name: n.getName(), parent: n.getParentNode()?.getName() ?? null, hasMesh: !!n.getMesh(), hasSkin: !!n.getSkin(),
}));
check('S4', jeq(nodeSig(sDoc), nodeSig(oDoc)), 'node graph signature drifted');

// --- S5 root VRM extensions (raw) -------------------------------------------
// In texture-diet mode the VRM0 root extension legitimately changes
// (_BumpMap removal + texture-index remap) — it is validated exactly by
// S9.VRM0 below instead of raw equality here.
const s5Exts = expectTextureDiet ? ['VRMC_vrm', 'VRMC_springBone'] : ['VRMC_vrm', 'VRMC_springBone', 'VRM'];
for (const extName of s5Exts) {
  const a = sj.extensions?.[extName], b = oj.extensions?.[extName];
  if (a === undefined && b === undefined) continue;
  if (a === undefined || b === undefined) { check(`S5.${extName}`, false, `${extName} ${a === undefined ? 'appeared in' : 'MISSING from'} output`); continue; }
  const norm = (x) => {
    const c = JSON.parse(JSON.stringify(x));
    if (c?.meta && 'thumbnailImage' in c.meta) delete c.meta.thumbnailImage;
    if (c?.meta && 'texture' in c.meta) delete c.meta.texture;
    return c;
  };
  check(`S5.${extName}`, jeq(norm(a), norm(b)), `${extName} JSON differs beyond the thumbnail carve-out`);
}

// --- S6 humanoid bone map -> node names -------------------------------------
const boneMapNames = (j) => {
  const out = {};
  const v1 = j.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (v1) for (const [bone, ref] of Object.entries(v1)) out[bone] = j.nodes?.[ref.node]?.name ?? `#${ref.node}`;
  const v0 = j.extensions?.VRM?.humanoid?.humanBones;
  if (Array.isArray(v0)) for (const hb of v0) out[hb.bone] = j.nodes?.[hb.node]?.name ?? `#${hb.node}`;
  return out;
};
const sB = boneMapNames(sj), oB = boneMapNames(oj);
check('S6', Object.keys(sB).length > 0 && jeq(sB, oB), `humanoid bone map drifted (${Object.keys(sB).length} vs ${Object.keys(oB).length} bones)`);

// --- S7/S8 primitive structure (decoded docs) -------------------------------
const primSig = (doc, json) => {
  const matIndexOf = new Map(doc.getRoot().listMaterials().map((m, i) => [m, i]));
  return doc.getRoot().listMeshes().map((m) => m.listPrimitives().map((p) => ({
    attrs: p.listSemantics().sort(),
    mode: p.getMode(),
    material: p.getMaterial() ? matIndexOf.get(p.getMaterial()) : null,
    targets: p.listTargets().map((t) => t.listSemantics().sort()),
  })));
};
check('S7+S8', jeq(primSig(sDoc, sj), primSig(oDoc, oj)), 'primitive structure (attrs/mode/material-index/morph-target semantics) drifted');

// --- S9 materials raw --------------------------------------------------------
if (!expectTextureDiet) {
  check('S9', jeq(sj.materials, oj.materials), 'materials JSON drifted (count/order/props/mtoon)');
} else {
  // Asset-batch review MAJOR 1: texture indices are SEMANTIC BINDINGS — never
  // mask them. Build the EXPECTED source->output texture mapping implied by
  // the normal-slot drop (dense, order-preserving over surviving textures),
  // apply it to a source copy, and require EXACT equality with the output.
  const droppedTex = new Set();
  for (const m of sj.materials || []) {
    if (typeof m.normalTexture?.index === 'number') droppedTex.add(m.normalTexture.index);
  }
  for (const mp of sj.extensions?.VRM?.materialProperties || []) {
    for (const [prop, ti] of Object.entries(mp.textureProperties || {})) {
      if (/_BumpMap$/.test(prop) && typeof ti === 'number') droppedTex.add(ti);
    }
  }
  const texRemap = new Map();
  {
    let next = 0;
    for (let i = 0; i < (sj.textures || []).length; i++) if (!droppedTex.has(i)) texRemap.set(i, next++);
  }
  let remapFailure = null;
  const remapRefs = (node) => {
    if (Array.isArray(node)) { node.forEach(remapRefs); return; }
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (/texture$/i.test(k) && v && typeof v === 'object' && typeof v.index === 'number') {
        if (!texRemap.has(v.index)) remapFailure = `surviving slot ${k} referenced dropped texture ${v.index}`;
        else v.index = texRemap.get(v.index);
      }
      remapRefs(v);
    }
  };
  const expectedMats = JSON.parse(JSON.stringify(sj.materials || []));
  for (const m of expectedMats) delete m.normalTexture;
  remapRefs(expectedMats);
  check('S9', !remapFailure && jeq(expectedMats, oj.materials),
    remapFailure ?? 'materials differ from the EXPECTED normal-drop transform (bindings compared exactly)');
  // MAJOR 2: VRM0 materialProperties live under extensions.VRM — apply the
  // same expected transform there (_BumpMap removed, other textureProperties
  // + meta.texture remapped) and require exact equality with the output.
  if (sj.extensions?.VRM || oj.extensions?.VRM) {
    const expVrm0 = JSON.parse(JSON.stringify(sj.extensions?.VRM ?? null));
    let vrm0Failure = null;
    if (expVrm0?.materialProperties) {
      for (const mp of expVrm0.materialProperties) {
        for (const [prop, ti] of Object.entries(mp.textureProperties || {})) {
          if (/_BumpMap$/.test(prop)) { delete mp.textureProperties[prop]; continue; }
          if (typeof ti === 'number') {
            if (!texRemap.has(ti)) vrm0Failure = `VRM0 ${prop} referenced dropped texture ${ti}`;
            else mp.textureProperties[prop] = texRemap.get(ti);
          }
        }
      }
    }
    if (typeof expVrm0?.meta?.texture === 'number') {
      if (!texRemap.has(expVrm0.meta.texture)) vrm0Failure = 'VRM0 meta.texture was dropped';
      else expVrm0.meta.texture = texRemap.get(expVrm0.meta.texture);
    }
    check('S9.VRM0', !vrm0Failure && jeq(expVrm0, oj.extensions?.VRM ?? null),
      vrm0Failure ?? 'VRM0 materialProperties differ from the expected _BumpMap-drop transform');
  }
}

// --- S10 nodes + scenes raw --------------------------------------------------
check('S10', jeq(sj.nodes, oj.nodes) && jeq(sj.scenes, oj.scenes) && jeq(sj.scene, oj.scene),
  'nodes/scenes JSON drifted (TRS, children, mesh/skin indices, node extensions, scene roots, default scene)');

// --- S11 skins raw modulo IBM accessor index --------------------------------
const skinsNorm = (j) => (j.skins || []).map((sk) => { const c = { ...sk }; delete c.inverseBindMatrices; return c; });
check('S11', jeq(skinsNorm(sj), skinsNorm(oj)), 'skins JSON drifted (joints list / skeleton root)');

// --- S12 output JOINTS/WEIGHTS validity (round-2 rewrite) -------------------
// Per-MESH actual skin binding (not a global max), joint bounds checked for
// EVERY joint value, weight sums aggregated ACROSS all sets per vertex, and
// accessor shape (VEC4, allowed component types, paired continuous sets)
// validated.
{
  let checked = 0; const problems = [];
  const JOINT_CTYPES = new Set([5121, 5123]);            // u8, u16
  const WEIGHT_CTYPES_NORM = new Set([5121, 5123]);      // u8/u16 normalized
  const say = (msg) => { if (problems.length < 8) problems.push(msg); };
  // mesh -> strictest joint count among the skins of nodes binding it
  const meshJointCount = new Map();
  for (const node of oDoc.getRoot().listNodes()) {
    const mesh = node.getMesh(), skin = node.getSkin();
    if (!mesh || !skin) continue;
    const jc = skin.listJoints().length;
    meshJointCount.set(mesh, Math.min(meshJointCount.get(mesh) ?? Infinity, jc));
  }
  for (const [mesh, jointCount] of meshJointCount) {
    for (const prim of mesh.listPrimitives()) {
      // Round-3: enumerate ALL present JOINTS_n/WEIGHTS_n suffixes first —
      // set numbers must be identical between the two families and
      // consecutive from 0 (sets {0,3} with {1,2} absent is a defect).
      const sems = prim.listSemantics();
      const setNums = (prefix) => sems
        .map((s) => s.match(new RegExp(`^${prefix}_(\\d+)$`)))
        .filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
      const jNums = setNums('JOINTS'), wNums = setNums('WEIGHTS');
      if (JSON.stringify(jNums) !== JSON.stringify(wNums)) say(`JOINTS sets [${jNums}] != WEIGHTS sets [${wNums}]`);
      jNums.forEach((n, i) => { if (n !== i) say(`non-consecutive skin set numbering: JOINTS_${n} at position ${i}`); });
      const sets = [];
      for (const set of jNums) {
        const jAcc = prim.getAttribute(`JOINTS_${set}`);
        const wAcc = prim.getAttribute(`WEIGHTS_${set}`);
        if (!jAcc || !wAcc) { say(`JOINTS_${set}/WEIGHTS_${set} presence mismatch`); continue; }
        if (jAcc.getType() !== 'VEC4' || wAcc.getType() !== 'VEC4') say(`set ${set}: not VEC4`);
        if (!JOINT_CTYPES.has(jAcc.getComponentType())) say(`set ${set}: joints componentType ${jAcc.getComponentType()}`);
        if (jAcc.getNormalized()) say(`set ${set}: JOINTS must not be normalized`);
        const wc = wAcc.getComponentType();
        // spec-allowed forms: float32 non-normalized, or u8/u16 normalized
        if (!((wc === 5126 && !wAcc.getNormalized()) || (WEIGHT_CTYPES_NORM.has(wc) && wAcc.getNormalized()))) {
          say(`set ${set}: weights componentType ${wc} norm=${wAcc.getNormalized()} not a spec-allowed form`);
        }
        const posCount = prim.getAttribute('POSITION')?.getCount();
        if (jAcc.getCount() !== posCount || wAcc.getCount() !== posCount) say(`set ${set}: count mismatch vs POSITION`);
        sets.push([jAcc, wAcc]);
      }
      if (!sets.length) continue;
      checked++;
      const vertCount = sets[0][1].getCount();
      const decoded = sets.map(([jAcc, wAcc]) => {
        const weights = wAcc.getArray();
        const wMax = wAcc.getNormalized() ? (weights instanceof Uint8Array ? 255 : weights instanceof Uint16Array ? 65535 : 1) : 1;
        return { joints: jAcc.getArray(), weights, wMax };
      });
      for (let v = 0; v < vertCount; v++) {
        let sum = 0; let bad = false;
        for (const { joints, weights, wMax } of decoded) {
          for (let k = 0; k < 4; k++) {
            const jv = joints[v * 4 + k];
            const wv = weights[v * 4 + k] / wMax;
            if (jv >= jointCount) { say(`vert ${v}: joint ${jv} >= skin joint count ${jointCount}`); bad = true; break; }
            if (!Number.isFinite(wv) || wv < 0) { say(`vert ${v}: bad weight ${wv}`); bad = true; break; }
            sum += wv;
          }
          if (bad) break;
        }
        if (bad) break;
        // Round-3: a zero aggregate sum is a defect too (an unweighted vertex
        // on a skinned primitive), not a tolerated case.
        if (Math.abs(sum - 1) > 0.02) { say(`vert ${v}: aggregate weight sum ${sum.toFixed(3)}`); break; }
      }
    }
  }
  check('S12', problems.length === 0 && checked > 0, problems[0] ?? 'no skinned primitives found to check');
}

// --- S13 spring-bone node names + thumbnail image bytes ----------------------
{
  const springNames = (j) => {
    const sb = j.extensions?.VRMC_springBone;
    if (!sb) return null;
    const nn = (i) => j.nodes?.[i]?.name ?? `#${i}`;
    return {
      joints: (sb.springs || []).map((sp) => (sp.joints || []).map((jt) => nn(jt.node))),
      colliders: (sb.colliders || []).map((c) => nn(c.node)),
    };
  };
  // Full-buffer comparison (round-2 F6: truncated hashes let thumbnails
  // sharing a header pass). Unresolvable-but-declared thumbnails are a FAIL.
  const thumbBytes = (glb, label) => {
    const ti = glb.json.extensions?.VRMC_vrm?.meta?.thumbnailImage;
    if (ti == null) return null; // legitimately absent
    const img = glb.json.images?.[ti];
    const bv = img?.bufferView != null ? glb.json.bufferViews?.[img.bufferView] : null;
    if (!bv) return { unresolvable: label };
    // Round-3: strict range validation — Buffer.subarray clamps, so two
    // out-of-range thumbnails could otherwise compare equal as empty buffers.
    const off = bv.byteOffset ?? 0, len = bv.byteLength;
    if ((bv.buffer ?? 0) !== 0 || !Number.isSafeInteger(off) || off < 0 ||
        !Number.isSafeInteger(len) || len <= 0 || off + len > glb.bin.length) {
      return { unresolvable: label };
    }
    return glb.bin.subarray(off, off + len);
  };
  const springOk = jeq(springNames(sj), springNames(oj));
  const ta = thumbBytes(s, 'source'), tb = thumbBytes(o, 'output');
  let thumbOk, thumbMsg;
  if (ta === null && tb === null) { thumbOk = true; }
  else if (ta?.unresolvable || tb?.unresolvable) { thumbOk = false; thumbMsg = `thumbnail declared but unresolvable in ${ta?.unresolvable ?? tb?.unresolvable}`; }
  else if (ta === null || tb === null) { thumbOk = false; thumbMsg = 'thumbnail presence drifted'; }
  else { thumbOk = ta.equals(tb); thumbMsg = 'thumbnail image bytes drifted'; }
  check('S13', springOk && thumbOk, !springOk ? 'spring-bone node resolution drifted' : thumbMsg);
}

console.log(failures.length ? `\nRESULT: FAIL (${failures.join(', ')})` : '\nRESULT: PASS');
process.exit(failures.length ? 3 : 0);
