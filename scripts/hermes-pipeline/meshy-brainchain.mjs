#!/usr/bin/env node
// meshy-brainchain.mjs - Meshy subscription driver for the BrainChain Office
// building shell and its robot resident (founder 2026-11-11: up to 1,000 credits).
//
// Spend guard (owner rule: the cap is enforced in code):
//   - MESHY_CREDIT_CAP is REQUIRED. No default; the script refuses without it.
//   - Spend = the sum of the job records in ledger.json. A job is reserved at
//     its estimate BEFORE its POST; after it finishes the record holds the real
//     charge (balance before - after). A job that fails after its POST keeps its
//     reservation, so an uncertain charge still counts.
//   - The cap never uses the raw balance change: a monthly refill or a credit
//     pack would otherwise give back spending room.
//   - Before every paid POST the script refuses when spend + estimate > cap.
//   - One paid job at a time: the lock is created atomically (exclusive create)
//     and only its owner removes it.
//
// Usage (run from the repo root):
//   MESHY_CREDIT_CAP=1000 node scripts/hermes-pipeline/meshy-brainchain.mjs balance
//   MESHY_CREDIT_CAP=1000 node scripts/hermes-pipeline/meshy-brainchain.mjs mesh <building|robot> <viewsDir>
//   MESHY_CREDIT_CAP=1000 node scripts/hermes-pipeline/meshy-brainchain.mjs rig robot
//   MESHY_CREDIT_CAP=1000 node scripts/hermes-pipeline/meshy-brainchain.mjs anim robot <slot> <action_id>
//
// Output: apps/web/public/models/brainchain-candidates/<target>/ (candidates only;
// nothing is wired into the world until the founder signs off).

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, openSync, closeSync, writeSync } from 'node:fs';
import { resolve, join } from 'node:path';

const API = 'https://api.meshy.ai/openapi/v1';
// Per-job estimates from Meshy's price list (multi-image textured = 30, rig = 5,
// animation = 3). The reservation uses these; the record then holds the real charge.
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
const loadLedger = () => (existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { jobs: [] });
let ledger = loadLedger();
const spentOf = (l) => l.jobs.reduce((sum, j) => sum + (j.charged ?? j.reserved ?? 0), 0);
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
const lockPath = join(root, 'job.lock');
const lockTag = `${process.pid} ${Date.now()}`;
async function guard(kind, target) {
  try {
    const fd = openSync(lockPath, 'wx'); // exclusive create: fails if any lock exists
    writeSync(fd, `${lockTag} ${kind}`); closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    console.error(`refused: another paid job holds ${lockPath} (${readFileSync(lockPath, 'utf8')}); delete it only if no job runs`);
    process.exit(4);
  }
  process.on('exit', () => {
    try { if (readFileSync(lockPath, 'utf8').startsWith(lockTag)) unlinkSync(lockPath); } catch {}
  });
  ledger = loadLedger(); // read only after the lock is held
  const spent = spentOf(ledger);
  const est = ESTIMATE[kind];
  const live = await balance();
  console.log(`balance ${live} | spent ${spent} of cap ${CAP} | next ${kind} ~${est}`);
  if (spent + est > CAP) {
    console.error(`refused: ${kind} would take spend to ~${spent + est}, above cap ${CAP}`);
    process.exit(3);
  }
  const job = { kind, target, reserved: est, before: live, at: new Date().toISOString() };
  ledger.cap = CAP; ledger.jobs.push(job); saveLedger();
  return job;
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
async function record(job, id) {
  const after = await balance();
  const delta = job.before - after;
  // A refill during the job makes the delta negative or too small: keep the estimate then.
  job.id = id; job.after = after; job.charged = delta >= job.reserved ? delta : job.reserved;
  delete job.reserved; saveLedger();
  console.log(`charged ${job.charged} credits (estimate ${ESTIMATE[job.kind]}); total spent ${spentOf(ledger)} of ${CAP}`);
}

const dataUri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const MESH = {
  building: { ai_model: 'meshy-6', topology: 'triangle', target_polycount: 30000, symmetry_mode: 'auto', should_remesh: true },
  robot: { ai_model: 'meshy-6', topology: 'quad', target_polycount: 40000, symmetry_mode: 'on', should_remesh: true, pose_mode: 'a-pose' },
};

const [cmd, target, a3, a4] = process.argv.slice(2);
if (cmd === 'balance') {
  const live = await balance();
  console.log(`balance ${live} | spent ${spentOf(ledger)} of cap ${CAP}`);
} else if (cmd === 'mesh') {
  if (!MESH[target] || !a3) throw new Error('usage: mesh <building|robot> <viewsDir>');
  const views = ['front', 'back', 'side', '3q'].map((v) => join(resolve(a3), `${target === 'building' ? 'bldg' : 'robot'}-${v}.png`)).filter(existsSync);
  if (views.length < 2) throw new Error(`need >=2 views in ${a3}, found ${views.length}`);
  const out = join(root, target); mkdirSync(out, { recursive: true });
  const job = await guard('mesh', target);
  const body = { ...MESH[target], image_urls: views.map(dataUri), should_texture: true, enable_pbr: true, image_enhancement: true, remove_lighting: true, target_formats: ['glb'] };
  const r = await req('POST', '/multi-image-to-3d', body);
  const id = r.result; job.id = id; console.log(`mesh task ${id} with ${views.length} views`);
  ledger[`${target}_mesh`] = id; saveLedger();
  const t = await poll(`/multi-image-to-3d/${id}`);
  await dl(t.model_urls.glb, join(out, `mesh-${id.slice(0, 8)}.glb`));
  if (t.thumbnail_url) await dl(t.thumbnail_url, join(out, `thumb-${id.slice(0, 8)}.png`)).catch(() => {});
  await record(job, id);
} else if (cmd === 'rig') {
  const meshId = ledger.robot_mesh; if (!meshId) throw new Error('no robot mesh task in ledger');
  const out = join(root, 'robot'); mkdirSync(join(out, 'anim'), { recursive: true });
  const job = await guard('rig', 'robot');
  const r = await req('POST', '/rigging', { input_task_id: meshId, height_meters: 1.9 });
  const id = r.result; job.id = id; ledger.robot_rig = id; saveLedger();
  const t = await poll(`/rigging/${id}`);
  const o = t.result || {};
  await dl(o.rigged_character_glb_url, join(out, 'rigged.glb'));
  const b = o.basic_animations || {};
  if (b.walking_glb_url) await dl(b.walking_glb_url, join(out, 'anim', 'walk.glb'));
  if (b.running_glb_url) await dl(b.running_glb_url, join(out, 'anim', 'run.glb'));
  await record(job, id);
} else if (cmd === 'anim') {
  const rigId = ledger.robot_rig; const actionId = Number(a4);
  if (!rigId || !a3 || Number.isNaN(actionId)) throw new Error('usage: anim robot <slot> <action_id> (after rig)');
  const out = join(root, 'robot', 'anim'); mkdirSync(out, { recursive: true });
  const job = await guard('anim', `robot:${a3}`);
  const r = await req('POST', '/animations', { rig_task_id: rigId, action_id: actionId });
  const id = r.result; job.id = id; saveLedger();
  const t = await poll(`/animations/${id}`);
  const o = t.result || {};
  await dl(o.animation_glb_url, join(out, `${a3}.glb`));
  await record(job, id);
} else {
  console.error('usage: balance | mesh <building|robot> <viewsDir> | rig robot | anim robot <slot> <action_id>');
  process.exit(1);
}
