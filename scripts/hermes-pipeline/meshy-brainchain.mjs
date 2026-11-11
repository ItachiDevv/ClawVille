#!/usr/bin/env node
// meshy-brainchain.mjs - Meshy subscription driver for the BrainChain Office
// building shell and its robot resident (founder 2026-11-11: up to 1,000 credits).
//
// Spend guard (owner rule: the cap is enforced in code):
//   - MESHY_CREDIT_CAP is REQUIRED. No default; the script refuses without it.
//   - The first paid call records the account balance in ledger.json as the start.
//   - Before every paid POST the script reads the live balance and refuses when
//     (start - live) + this job's estimate > cap.
//
// Usage (run from the repo root):
//   MESHY_CREDIT_CAP=1000 node scripts/hermes-pipeline/meshy-brainchain.mjs balance
//   MESHY_CREDIT_CAP=1000 node scripts/hermes-pipeline/meshy-brainchain.mjs mesh <building|robot> <viewsDir>
//   MESHY_CREDIT_CAP=1000 node scripts/hermes-pipeline/meshy-brainchain.mjs rig robot
//   MESHY_CREDIT_CAP=1000 node scripts/hermes-pipeline/meshy-brainchain.mjs anim robot <slot> <action_id>
//
// Output: apps/web/public/models/brainchain-candidates/<target>/ (candidates only;
// nothing is wired into the world until the founder signs off).

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

const API = 'https://api.meshy.ai/openapi/v1';
// Per-job estimates from Meshy's price list (multi-image textured = 30, rig = 5,
// animation = 3). The live balance check is the real guard; the estimate only
// refuses a job that would cross the cap.
const ESTIMATE = { mesh: 30, rig: 5, anim: 3 };

const CAP = Number(process.env.MESHY_CREDIT_CAP);
if (!Number.isFinite(CAP) || CAP <= 0) {
  console.error('refused: set MESHY_CREDIT_CAP to the founder-approved credit cap');
  process.exit(2);
}

function loadKey() {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY;
  const p = join(process.env.USERPROFILE || process.env.HOME, '.itachi-api-keys');
  const line = readFileSync(p, 'utf8').split(/\r?\n/).find((l) => l.startsWith('MESHY_API_KEY='));
  if (!line) throw new Error('MESHY_API_KEY not found');
  return line.slice('MESHY_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
}
const H = { Authorization: `Bearer ${loadKey()}`, 'Content-Type': 'application/json' };

const root = resolve('apps/web/public/models/brainchain-candidates');
mkdirSync(root, { recursive: true });
const ledgerPath = join(root, 'ledger.json');
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { jobs: [] };
const saveLedger = () => writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${txt.slice(0, 400)}`);
  return txt ? JSON.parse(txt) : {};
}
async function balance() {
  const r = await req('GET', '/balance');
  if (typeof r.balance !== 'number') throw new Error(`unexpected balance shape: ${Object.keys(r)}`);
  return r.balance;
}
// One paid job at a time: two concurrent runs both rewrite ledger.json and one
// record is lost (seen 2026-11-11). The lock is removed when the process exits.
const lockPath = join(root, 'job.lock');
async function guard(kind) {
  if (existsSync(lockPath)) {
    console.error(`refused: another paid job holds ${lockPath} (${readFileSync(lockPath, 'utf8')}); delete it only if no job runs`);
    process.exit(4);
  }
  writeFileSync(lockPath, `${process.pid} ${kind} ${new Date().toISOString()}`);
  process.on('exit', () => { try { unlinkSync(lockPath); } catch {} });
  const live = await balance();
  if (ledger.start === undefined) { ledger.start = live; ledger.cap = CAP; saveLedger(); }
  const spent = ledger.start - live;
  const est = ESTIMATE[kind];
  console.log(`balance ${live} | spent ${spent} of cap ${CAP} | next ${kind} ~${est}`);
  if (spent + est > CAP) {
    console.error(`refused: ${kind} would take spend to ~${spent + est}, above cap ${CAP}`);
    process.exit(3);
  }
  return live;
}
async function poll(path) {
  for (let i = 0; i < 200; i++) {
    const t = await req('GET', path);
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`${path} ${t.status}: ${JSON.stringify(t.task_error || '').slice(0, 300)}`);
    if (i % 6 === 0) console.log(`  ${path} ${t.status} ${t.progress ?? ''}%`);
    await sleep(8000);
  }
  throw new Error(`${path} poll timeout`);
}
async function dl(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  console.log(`saved ${dest} (${(buf.length / 1048576).toFixed(2)} MB)`);
}
async function record(kind, target, before, id) {
  const after = await balance();
  ledger.jobs.push({ kind, target, id, before, after, charged: before - after, at: new Date().toISOString() });
  saveLedger();
  console.log(`charged ${before - after} credits (estimate ${ESTIMATE[kind]}); total spent ${ledger.start - after} of ${CAP}`);
}

const dataUri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const MESH = {
  building: { ai_model: 'meshy-6', topology: 'triangle', target_polycount: 30000, symmetry_mode: 'auto', should_remesh: true },
  robot: { ai_model: 'meshy-6', topology: 'quad', target_polycount: 40000, symmetry_mode: 'on', should_remesh: true, pose_mode: 'a-pose' },
};

const [cmd, target, a3, a4] = process.argv.slice(2);
if (cmd === 'balance') {
  const live = await balance();
  console.log(`balance ${live}${ledger.start !== undefined ? ` | spent ${ledger.start - live} of cap ${CAP}` : ''}`);
} else if (cmd === 'mesh') {
  if (!MESH[target] || !a3) throw new Error('usage: mesh <building|robot> <viewsDir>');
  const views = ['front', 'back', 'side', '3q'].map((v) => join(resolve(a3), `${target === 'building' ? 'bldg' : 'robot'}-${v}.png`)).filter(existsSync);
  if (views.length < 2) throw new Error(`need >=2 views in ${a3}, found ${views.length}`);
  const out = join(root, target); mkdirSync(out, { recursive: true });
  const before = await guard('mesh');
  const body = { ...MESH[target], image_urls: views.map(dataUri), should_texture: true, enable_pbr: true, image_enhancement: true, remove_lighting: true, target_formats: ['glb'] };
  const r = await req('POST', '/multi-image-to-3d', body);
  const id = r.result; console.log(`mesh task ${id} with ${views.length} views`);
  ledger[`${target}_mesh`] = id; saveLedger();
  const t = await poll(`/multi-image-to-3d/${id}`);
  await dl(t.model_urls.glb, join(out, `mesh-${id.slice(0, 8)}.glb`));
  if (t.thumbnail_url) await dl(t.thumbnail_url, join(out, `thumb-${id.slice(0, 8)}.png`)).catch(() => {});
  await record('mesh', target, before, id);
} else if (cmd === 'rig') {
  const meshId = ledger.robot_mesh; if (!meshId) throw new Error('no robot mesh task in ledger');
  const out = join(root, 'robot'); mkdirSync(join(out, 'anim'), { recursive: true });
  const before = await guard('rig');
  const r = await req('POST', '/rigging', { input_task_id: meshId, height_meters: 1.9 });
  const id = r.result; ledger.robot_rig = id; saveLedger();
  const t = await poll(`/rigging/${id}`);
  const o = t.result || {};
  await dl(o.rigged_character_glb_url, join(out, 'rigged.glb'));
  const b = o.basic_animations || {};
  if (b.walking_glb_url) await dl(b.walking_glb_url, join(out, 'anim', 'walk.glb'));
  if (b.running_glb_url) await dl(b.running_glb_url, join(out, 'anim', 'run.glb'));
  await record('rig', 'robot', before, id);
} else if (cmd === 'anim') {
  const rigId = ledger.robot_rig; const actionId = Number(a4);
  if (!rigId || !a3 || Number.isNaN(actionId)) throw new Error('usage: anim robot <slot> <action_id> (after rig)');
  const out = join(root, 'robot', 'anim'); mkdirSync(out, { recursive: true });
  const before = await guard('anim');
  const r = await req('POST', '/animations', { rig_task_id: rigId, action_id: actionId });
  const id = r.result;
  const t = await poll(`/animations/${id}`);
  const o = t.result || {};
  await dl(o.animation_glb_url, join(out, `${a3}.glb`));
  await record('anim', `robot:${a3}`, before, id);
} else {
  console.error('usage: balance | mesh <building|robot> <viewsDir> | rig robot | anim robot <slot> <action_id>');
  process.exit(1);
}
