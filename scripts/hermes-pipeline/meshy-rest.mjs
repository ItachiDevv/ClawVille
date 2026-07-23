#!/usr/bin/env node
// meshy-rest.mjs — Meshy subscription REST driver for the character pipeline
// (replaces the dead fal.ai meshy-i2m.ts path; mirrors the MCP params from
// packages/database/character-pipeline.md step 3).
//
// Usage:
//   node scripts/hermes-pipeline/meshy-rest.mjs submit <slug>            # multi-image-to-3d from openai/{front,back,3q,face}.png
//   node scripts/hermes-pipeline/meshy-rest.mjs status <slug>            # poll last submitted task
//   node scripts/hermes-pipeline/meshy-rest.mjs download <slug>          # download GLB when SUCCEEDED
//   node scripts/hermes-pipeline/meshy-rest.mjs rig <slug>               # rig the downloaded mesh (height 1.85m)
//   node scripts/hermes-pipeline/meshy-rest.mjs rig-status <slug>
//   node scripts/hermes-pipeline/meshy-rest.mjs rig-download <slug>
//   node scripts/hermes-pipeline/meshy-rest.mjs animate <slug> <slot> <action_id>
//   node scripts/hermes-pipeline/meshy-rest.mjs anim-status <slug>
//
// MESHY_API_KEY from env or ~/.itachi-api-keys. Task ids persisted to
// apps/web/public/models/<slug>-mesh/meshy-openai/tasks.json.

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

const meshDir = resolve(`apps/web/public/models/${slug}-mesh/meshy-openai`);
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

async function download(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  console.log(`saved ${outPath} (${(readFileSync(outPath).length / 1024 / 1024).toFixed(1)} MB)`);
}

if (cmd === 'submit') {
  const dir = resolve(`apps/web/public/models/${slug}-turnaround/openai`);
  const views = ['front.png', 'back.png', '3q.png', 'face.png'].map((f) => join(dir, f));
  for (const v of views) if (!existsSync(v)) throw new Error(`missing view ${v}`);
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
  saveTasks();
  console.log(`submitted multi-image-to-3d task: ${JSON.stringify(tasks.mesh)}`);
} else if (cmd === 'status') {
  const r = await req('GET', `/multi-image-to-3d/${tasks.mesh}`);
  console.log(JSON.stringify({ status: r.status, progress: r.progress, error: r.task_error }, null, 2));
} else if (cmd === 'download') {
  const r = await req('GET', `/multi-image-to-3d/${tasks.mesh}`);
  if (r.status !== 'SUCCEEDED') throw new Error(`not ready: ${r.status} ${r.progress ?? ''}`);
  await download(r.model_urls.glb, join(meshDir, 'mesh.glb'));
  if (r.texture_urls?.length) {
    const t = r.texture_urls[0];
    for (const [k, u] of Object.entries(t)) if (typeof u === 'string') await download(u, join(meshDir, `tex_${k}.png`)).catch((e) => console.warn(`tex ${k}: ${e.message}`));
  }
} else if (cmd === 'rig') {
  const r = await req('POST', '/rigging', { input_task_id: tasks.mesh, height_meters: 1.85 });
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
