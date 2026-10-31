#!/usr/bin/env node
// meshy-rest.mjs — Meshy subscription REST driver for the character pipeline
// (replaces the dead fal.ai meshy-i2m.ts path; mirrors the MCP params from
// packages/database/character-pipeline.md step 3).
//
// Usage:
//   node scripts/hermes-pipeline/meshy-rest.mjs submit <slug>            # multi-image-to-3d from openai/{front,back,3q}.png (+ face.png if present)
//   node scripts/hermes-pipeline/meshy-rest.mjs status <slug>            # poll last submitted task
//   node scripts/hermes-pipeline/meshy-rest.mjs download <slug>          # download GLB when SUCCEEDED
//   node scripts/hermes-pipeline/meshy-rest.mjs rig <slug> [height_m]    # rig the downloaded mesh (default height 1.85m)
//   node scripts/hermes-pipeline/meshy-rest.mjs rig-status <slug>
//   node scripts/hermes-pipeline/meshy-rest.mjs rig-download <slug>
//   node scripts/hermes-pipeline/meshy-rest.mjs animate <slug> <slot> <action_id>
//   node scripts/hermes-pipeline/meshy-rest.mjs anim-status <slug>
//
// MESHY_API_KEY from env or ~/.itachi-api-keys. Task ids persisted to
// apps/web/public/models/<slug>-mesh/meshy-openai/tasks.json.
//
// CREDIT CAP (owner rule 2026-10-04): every paid command (submit, rig, animate)
// REFUSES to run without MESHY_CREDIT_CAP=<credits> (the owner-approved cap for
// this slug). The first paid call records the account balance in tasks.json;
// each later paid call refuses when (credits spent since then + this call's
// estimate) would exceed the cap.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const API = 'https://api.meshy.ai/openapi/v1';

function loadKey() {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY;
  const p = join(process.env.USERPROFILE || process.env.HOME, '.itachi-api-keys');
  const line = readFileSync(p, 'utf8').split(/\r?\n/).find((l) => l.startsWith('MESHY_API_KEY='));
  if (!line) throw new Error('MESHY_API_KEY not found');
  return line.slice('MESHY_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
}
const KEY = loadKey();
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const [cmd, slug, arg3, arg4] = process.argv.slice(2);
if (!cmd || !slug) { console.error('usage: meshy-rest.mjs <submit|status|download|rig|rig-status|rig-download|animate|anim-status> <slug> [...]'); process.exit(1); }

// MESHY_VARIANT=v2 reads <slug>-turnaround/openai-v2 and writes <slug>-mesh/meshy-openai-v2
// (its own tasks.json, so its own credit-cap ledger); unset keeps the round-1 paths.
const VARIANT = process.env.MESHY_VARIANT ? `-${process.env.MESHY_VARIANT.replace(/[^a-z0-9]/gi, '')}` : '';
const meshDir = resolve(`apps/web/public/models/${slug}-mesh/meshy-openai${VARIANT}`);
mkdirSync(meshDir, { recursive: true });
mkdirSync(join(meshDir, 'anim'), { recursive: true });
const tasksPath = join(meshDir, 'tasks.json');
const tasks = existsSync(tasksPath) ? JSON.parse(readFileSync(tasksPath, 'utf8')) : {};
const saveTasks = () => writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));

const dataUri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${txt.slice(0, 500)}`);
  return txt ? JSON.parse(txt) : {};
}

// Upper-bound credit estimates per paid call (Meshy-6 textured mesh, rig, one clip).
const CREDIT_ESTIMATE = { submit: 30, rig: 5, animate: 3 };
async function enforceCap(kind) {
  const cap = Number(process.env.MESHY_CREDIT_CAP);
  if (!Number.isFinite(cap) || cap <= 0) throw new Error(`refusing paid '${kind}': set MESHY_CREDIT_CAP=<owner-approved credits>`);
  const { balance } = await req('GET', '/balance');
  if (typeof balance !== 'number') throw new Error('balance read failed; refusing paid call');
  if (typeof tasks.startBalance !== 'number') { tasks.startBalance = balance; saveTasks(); }
  const spent = tasks.startBalance - balance;
  const next = CREDIT_ESTIMATE[kind];
  if (spent + next > cap) throw new Error(`cap: spent ${spent} + est ${next} > cap ${cap}; refusing '${kind}'`);
  console.log(`cap ok: spent ${spent}, est ${next}, cap ${cap}, balance ${balance}`);
}

async function download(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  console.log(`saved ${outPath} (${(readFileSync(outPath).length / 1024 / 1024).toFixed(1)} MB)`);
}

if (cmd === 'submit') {
  const dir = resolve(`apps/web/public/models/${slug}-turnaround/openai${VARIANT}`);
  const views = ['front.png', 'back.png', '3q.png'].map((f) => join(dir, f));
  for (const v of views) if (!existsSync(v)) throw new Error(`missing view ${v}`);
  if (existsSync(join(dir, 'face.png'))) views.push(join(dir, 'face.png'));
  await enforceCap('submit');
  const body = {
    image_urls: views.map(dataUri),
    ai_model: 'meshy-6',
    topology: 'quad',
    target_polycount: 60000,
    symmetry_mode: 'on',
    should_remesh: true,
    should_texture: true,
    enable_pbr: true,
    pose_mode: 't-pose',
    image_enhancement: true,
    remove_lighting: true,
    target_formats: ['glb'],
  };
  const r = await req('POST', '/multi-image-to-3d', body);
  tasks.mesh = r.result || r.id || r;
  tasks.meshType = 'multi-image-to-3d';
  saveTasks();
  console.log(`submitted multi-image-to-3d task: ${JSON.stringify(tasks.mesh)}`);
} else if (cmd === 'submit-image') {
  // Single-image PROP submission (e.g. the ansem greatsword) — dedicated
  // image-to-3d endpoint, no pose_mode (not a character), symmetry auto
  // (a side-profile prop's mirror plane is the image plane, not image-left/right).
  const imgPath = resolve(arg3 || '');
  if (!arg3 || !existsSync(imgPath)) throw new Error(`usage: submit-image <slug> <imagePath> — missing ${arg3}`);
  const body = {
    image_url: dataUri(imgPath),
    ai_model: 'meshy-6',
    topology: 'quad',
    target_polycount: 20000,
    symmetry_mode: 'auto',
    should_remesh: true,
    should_texture: true,
    enable_pbr: true,
    image_enhancement: true,
    remove_lighting: true,
    target_formats: ['glb'],
  };
  const r = await req('POST', '/image-to-3d', body);
  tasks.mesh = r.result || r.id || r;
  tasks.meshType = 'image-to-3d';
  saveTasks();
  console.log(`submitted image-to-3d task: ${JSON.stringify(tasks.mesh)}`);
} else if (cmd === 'status') {
  const r = await req('GET', `/${tasks.meshType || 'multi-image-to-3d'}/${tasks.mesh}`);
  console.log(JSON.stringify({ status: r.status, progress: r.progress, error: r.task_error }, null, 2));
} else if (cmd === 'download') {
  const r = await req('GET', `/${tasks.meshType || 'multi-image-to-3d'}/${tasks.mesh}`);
  if (r.status !== 'SUCCEEDED') throw new Error(`not ready: ${r.status} ${r.progress ?? ''}`);
  await download(r.model_urls.glb, join(meshDir, 'mesh.glb'));
  if (r.texture_urls?.length) {
    const t = r.texture_urls[0];
    for (const [k, u] of Object.entries(t)) if (typeof u === 'string') await download(u, join(meshDir, `tex_${k}.png`)).catch((e) => console.warn(`tex ${k}: ${e.message}`));
  }
} else if (cmd === 'rig') {
  const height = arg3 ? Number(arg3) : 1.85;
  if (!(height >= 1 && height <= 2.6)) throw new Error(`rig height ${arg3} outside 1.0-2.6 m`);
  await enforceCap('rig');
  const r = await req('POST', '/rigging', { input_task_id: tasks.mesh, height_meters: height });
  tasks.rig = r.result || r.id || r;
  saveTasks();
  console.log(`submitted rigging task: ${JSON.stringify(tasks.rig)}`);
} else if (cmd === 'rig-status') {
  const r = await req('GET', `/rigging/${tasks.rig}`);
  console.log(JSON.stringify({ status: r.status, progress: r.progress, error: r.task_error }, null, 2));
} else if (cmd === 'rig-download') {
  const r = await req('GET', `/rigging/${tasks.rig}`);
  if (r.status !== 'SUCCEEDED') throw new Error(`not ready: ${r.status} ${r.progress ?? ''}`);
  const out = r.result || r;
  const rigUrl = out.rigged_character_glb_url || out.model_urls?.glb;
  if (!rigUrl) throw new Error(`no rigged glb url in: ${JSON.stringify(Object.keys(out))}`);
  await download(rigUrl, join(meshDir, 'rigged.glb'));
  const anims = out.basic_animations || {};
  if (anims.walking_glb_url) await download(anims.walking_glb_url, join(meshDir, 'anim', 'walk.glb'));
  if (anims.running_glb_url) await download(anims.running_glb_url, join(meshDir, 'anim', 'run.glb'));
} else if (cmd === 'animate') {
  const slot = arg3, actionId = Number(arg4);
  if (!slot || Number.isNaN(actionId)) throw new Error('usage: animate <slug> <slot> <action_id>');
  await enforceCap('animate');
  const r = await req('POST', '/animations', { rig_task_id: tasks.rig, action_id: actionId });
  tasks.anims = tasks.anims || {};
  tasks.anims[slot] = r.result || r.id || r;
  saveTasks();
  console.log(`submitted animation ${slot} (action ${actionId}): ${JSON.stringify(tasks.anims[slot])}`);
} else if (cmd === 'anim-status') {
  for (const [slot, id] of Object.entries(tasks.anims || {})) {
    const r = await req('GET', `/animations/${id}`);
    const out = r.result || r;
    console.log(`${slot}: ${r.status} ${r.progress ?? ''}`);
    if (r.status === 'SUCCEEDED') {
      const url = out.animation_glb_url || out.model_urls?.glb || out.glb_url;
      if (url && !existsSync(join(meshDir, 'anim', `${slot}.glb`))) await download(url, join(meshDir, 'anim', `${slot}.glb`));
    }
  }
} else {
  throw new Error(`unknown cmd ${cmd}`);
}
