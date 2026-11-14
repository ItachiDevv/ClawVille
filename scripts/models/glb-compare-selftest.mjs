// Self-test for glb-compare.mjs: every broken file below MUST give a BLOCK, and
// the file against itself MUST pass. Run after any change to the check.
// Usage: node scripts/models/glb-compare-selftest.mjs <good.glb> <work-dir>
// Cases (from the Codex review of 8d0d1177e): a lost vertex (one vertex moved
// onto another), all triangles collapsed, triangles re-wound, 8-bit normals,
// and a texture slot whose settings changed.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [good, work] = process.argv.slice(2);
if (!good || !work) { console.error('usage: glb-compare-selftest.mjs <good.glb> <work-dir>'); process.exit(2); }
mkdirSync(work, { recursive: true });
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const here = dirname(fileURLToPath(import.meta.url));

// Largest indexed triangle primitive.
const biggest = (doc) => doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).filter((p) => p.getIndices() && p.getMode() === 4)
  .sort((a, b) => b.getIndices().getCount() - a.getIndices().getCount())[0];

const cases = {
  'lost-vertex': (doc) => {
    // Move the vertex used by the middle triangle onto another vertex of the
    // same triangle: counts and bounds stay, the triangle collapses.
    const p = biggest(doc); const idx = p.getIndices(); const t = Math.floor(idx.getCount() / 6) * 3;
    const from = idx.getScalar(t + 1), to = idx.getScalar(t);
    for (const sem of p.listSemantics()) { const acc = p.getAttribute(sem); const el = acc.getElement(to, []); acc.setElement(from, el); }
  },
  'collapsed-triangles': (doc) => {
    for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const idx = p.getIndices(); if (!idx) continue; const a = idx.getArray().slice(); for (let i = 0; i < a.length; i += 3) { a[i + 1] = a[i]; a[i + 2] = a[i]; } idx.setArray(a); }
  },
  'rewound-triangles': (doc) => {
    const p = biggest(doc); const idx = p.getIndices(); const a = idx.getArray().slice();
    for (let i = 0; i + 2 < a.length; i += 3) { const x = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = x; }
    idx.setArray(a);
  },
  'normals-8bit': (doc) => {
    for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
      const n = p.getAttribute('NORMAL'); if (!n) continue; const el = [0, 0, 0];
      for (let i = 0; i < n.getCount(); i++) { n.getElement(i, el); n.setElement(i, el.map((v) => Math.round(v * 127) / 127 + 0.004)); }
    }
  },
  'texture-settings': (doc) => {
    const m = doc.getRoot().listMaterials().find((x) => x.getBaseColorTexture());
    if (!m) throw new Error('no base colour texture');
    m.getBaseColorTextureInfo().setTexCoord(1);
  },
};

let failed = 0;
const run = (label, after) => spawnSync(process.execPath, [join(here, 'glb-compare.mjs'), good, after, work, '--label', label], { encoding: 'utf8' });
const self = run('self', good);
const selfOk = self.status === 0;
console.log(`self: exit ${self.status} ${selfOk ? 'PASS' : 'FAIL (must pass)'}`); if (!selfOk) { failed++; console.log(self.stdout.slice(-600), self.stderr.slice(-600)); }
for (const [label, mutate] of Object.entries(cases)) {
  const doc = await io.read(good); mutate(doc);
  const out = join(work, `${label}.glb`); await io.write(out, doc);
  const r = run(label, out);
  const blocked = r.status === 1 && /VERDICT: BLOCK/.test(r.stdout);
  console.log(`${label}: ${blocked ? 'BLOCK (correct)' : 'NOT BLOCKED (wrong)'}`);
  const lines = r.stdout.split('\n').filter((l) => /^\s+- /.test(l)).slice(0, 3); for (const l of lines) console.log(`   ${l.trim()}`);
  if (!blocked) { failed++; console.log(r.stdout.slice(-800), r.stderr.slice(-400)); }
}
console.log(failed ? `SELFTEST FAIL (${failed})` : 'SELFTEST PASS');
process.exit(failed ? 1 : 0);
