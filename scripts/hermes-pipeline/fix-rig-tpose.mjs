#!/usr/bin/env node
// fix-rig-tpose.mjs — straighten a Meshy rig's drooped arms to a true T-pose.
//
// WHY (biggie postmortem 2026-07-23): when turnaround images have arms below
// horizontal, Meshy rigs the mesh as-drawn, so the skeleton REST pose has the
// arms angled down. VRM 1.0 (and the game's Mixamo-retarget animator) assume
// rest == T-pose; a drooped rest folds every retargeted arm rotation inward
// (arms inside the body, "swapped shoulders" look). The armspan/height QC
// floor of 0.95 exists to catch this BEFORE rigging — this script repairs a
// rig that slipped through.
//
// HOW: for each side, compute the world-space shoulder→wrist direction at
// rest, find the rotation that maps it onto pure ±X (horizontal), and
// premultiply the upper-arm joint's rest rotation. Inverse bind matrices are
// left UNTOUCHED, so the skinned mesh deforms upward into the corrected pose —
// the rest render becomes a true T-pose.
//
// Usage: node fix-rig-tpose.mjs <in.glb> <out.glb>

import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: fix-rig-tpose.mjs <in.glb> <out.glb>'); process.exit(1); }

const buf = readFileSync(inPath);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const binLen = buf.readUInt32LE(20 + jsonLen);
const bin = buf.slice(binStart, binStart + binLen);

// ---- minimal quat/mat helpers (column-major not needed — we only compose TRS worlds) ----
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qNorm = (q) => { const l = Math.hypot(...q); return q.map((c) => c / l); };
const qRotVec = (q, v) => {
  const p = [v[0], v[1], v[2], 0];
  const r = qMul(qMul(q, p), qConj(q));
  return [r[0], r[1], r[2]];
};
const vNorm = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };
const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// quaternion rotating unit vector a onto unit vector b
function qFromTo(a, b) {
  const d = vDot(a, b);
  if (d > 0.999999) return [0, 0, 0, 1];
  const ax = vCross(a, b);
  const q = [ax[0], ax[1], ax[2], 1 + d];
  return qNorm(q);
}

const nodes = json.nodes;
const parentOf = {};
nodes.forEach((n, i) => (n.children || []).forEach((c) => (parentOf[c] = i)));
const byName = {};
nodes.forEach((n, i) => { if (n.name) byName[n.name] = i; });

// world rotation and position of a node at rest (TRS chains, uniform scale assumed)
function worldRot(i) {
  let q = [0, 0, 0, 1];
  const chain = [];
  for (let cur = i; cur !== undefined; cur = parentOf[cur]) chain.push(cur);
  for (const idx of chain.reverse()) q = qMul(q, nodes[idx].rotation || [0, 0, 0, 1]);
  return qNorm(q);
}
function worldPos(i) {
  // accumulate from root: p = p_parent + R_parent * (s_parent * t_local)
  const chain = [];
  for (let cur = i; cur !== undefined; cur = parentOf[cur]) chain.push(cur);
  chain.reverse();
  let p = [0, 0, 0], q = [0, 0, 0, 1], s = 1;
  for (const idx of chain) {
    const n = nodes[idx];
    const t = (n.translation || [0, 0, 0]).map((c) => c * s);
    const tw = qRotVec(q, t);
    p = [p[0] + tw[0], p[1] + tw[1], p[2] + tw[2]];
    q = qMul(q, n.rotation || [0, 0, 0, 1]);
    s *= n.scale ? n.scale[0] : 1;
  }
  return p;
}

for (const side of ['Left', 'Right']) {
  const armI = byName[`${side}Arm`];
  const handI = byName[`${side}Hand`];
  if (armI === undefined || handI === undefined) throw new Error(`missing ${side}Arm/${side}Hand`);
  const pArm = worldPos(armI), pHand = worldPos(handI);
  const dir = vNorm([pHand[0] - pArm[0], pHand[1] - pArm[1], pHand[2] - pArm[2]]);
  const target = side === 'Left' ? [1, 0, 0] : [-1, 0, 0];
  const droopDeg = (Math.acos(Math.max(-1, Math.min(1, vDot(dir, target)))) * 180) / Math.PI;
  const delta = qFromTo(dir, target);
  // world-premultiply on the upper-arm joint: newWorld = delta * world
  // newLocal = conj(parentWorld) * delta * parentWorld * local
  const pw = worldRot(parentOf[armI]);
  const corr = qMul(qConj(pw), qMul(delta, pw));
  nodes[armI].rotation = qNorm(qMul(corr, nodes[armI].rotation || [0, 0, 0, 1]));
  console.log(`${side}: arm dir [${dir.map((v) => v.toFixed(3))}] → ±X (droop was ${droopDeg.toFixed(1)}°)`);
}

// verify post-fix
for (const side of ['Left', 'Right']) {
  const dir = (() => {
    const pArm = worldPos(byName[`${side}Arm`]), pHand = worldPos(byName[`${side}Hand`]);
    return vNorm([pHand[0] - pArm[0], pHand[1] - pArm[1], pHand[2] - pArm[2]]);
  })();
  console.log(`${side} post-fix arm dir: [${dir.map((v) => v.toFixed(4))}]`);
}

let jsonOut = Buffer.from(JSON.stringify(json));
const jpad = (4 - (jsonOut.length % 4)) % 4;
jsonOut = Buffer.concat([jsonOut, Buffer.alloc(jpad, 0x20)]);
const total = 12 + 8 + jsonOut.length + 8 + bin.length;
const out = Buffer.alloc(total);
out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
out.writeUInt32LE(jsonOut.length, 12); out.writeUInt32LE(0x4e4f534a, 16); jsonOut.copy(out, 20);
out.writeUInt32LE(bin.length, 20 + jsonOut.length); out.writeUInt32LE(0x004e4942, 24 + jsonOut.length); bin.copy(out, 28 + jsonOut.length);
writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${(total / 1024 / 1024).toFixed(1)} MB)`);
