#!/usr/bin/env node
// meshy-building.mjs — Meshy text-to-3d driver for BUILDINGS and static props.
//
// Sibling of meshy-rest.mjs (which is character-oriented: multi-image-to-3d +
// rigging + animations). Buildings need none of that: no rig, no pose_mode, no
// symmetry assumptions from a turnaround sheet. This driver runs the two-stage
// text-to-3d flow (preview mesh -> textured refine) and keeps task ids in a
// scratch json OUTSIDE the repo so raw Meshy downloads never land in git.
//
// Usage:
//   node scripts/hermes-pipeline/meshy-building.mjs submit <slug> <promptFile> [--polycount N] [--style realistic]
//   node scripts/hermes-pipeline/meshy-building.mjs status <slug>
//   node scripts/hermes-pipeline/meshy-building.mjs refine <slug> [--texture-prompt-file F]
//   node scripts/hermes-pipeline/meshy-building.mjs download <slug> [preview|refine]
//   node scripts/hermes-pipeline/meshy-building.mjs balance
//
// MESHY_API_KEY from env or ~/.itachi-api-keys.
// Scratch dir: $MESHY_BUILDING_OUT (default: <os tmp>/meshy-buildings).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const API = 'https://api.meshy.ai/openapi';

function loadKey() {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY;
  const p = join(process.env.USERPROFILE || process.env.HOME, '.itachi-api-keys');
  const line = readFileSync(p, 'utf8').split(/\r?\n/).find((l) => l.startsWith('MESHY_API_KEY='));
  if (!line) throw new Error('MESHY_API_KEY not found');
  return line.slice('MESHY_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
}
const KEY = loadKey();
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const argv = process.argv.slice(2);
const cmd = argv[0];
const slug = argv[1];
function flag(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
}

const OUT_ROOT = process.env.MESHY_BUILDING_OUT || join(tmpdir(), 'meshy-buildings');

async function req(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${txt.slice(0, 800)}`);
  return txt ? JSON.parse(txt) : {};
}

async function download(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  console.log(`saved ${outPath} (${(readFileSync(outPath).length / 1024 / 1024).toFixed(2)} MB)`);
}

if (cmd === 'balance') {
  console.log(JSON.stringify(await req('GET', '/v1/balance')));
  process.exit(0);
}

if (!cmd || !slug) {
  console.error('usage: meshy-building.mjs <submit|status|refine|download|balance> <slug> [...]');
  process.exit(1);
}

const dir = join(OUT_ROOT, slug);
mkdirSync(dir, { recursive: true });
const tasksPath = join(dir, 'tasks.json');
const tasks = existsSync(tasksPath) ? JSON.parse(readFileSync(tasksPath, 'utf8')) : {};
const saveTasks = () => writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));

if (cmd === 'submit-image') {
  // Single-stage image-to-3d. Use this instead of text-to-3d whenever a BRAND
  // asset already exists in 2D: a prompt describing "the ClawVille claw" drifts
  // (the first text-to-3d attempt returned a taloned monster hand, not the
  // two-finger crab pincer), while the real PNG reconstructs the actual shape.
  const imgPath = argv[2];
  if (!imgPath || !existsSync(imgPath)) throw new Error(`missing image: ${imgPath}`);
  const dataUri = `data:image/png;base64,${readFileSync(imgPath).toString('base64')}`;
  const body = {
    image_url: dataUri,
    // meshy-6: `remove_lighting` (strips baked shading from the source art so
    // the mesh is not double-lit in engine) is rejected on meshy-5.
    ai_model: flag('model', 'meshy-6'),
    topology: 'triangle',
    target_polycount: Number(flag('polycount', '12000')),
    symmetry_mode: flag('symmetry', 'off'),
    should_remesh: true,
    should_texture: true,
    enable_pbr: false,
    image_enhancement: true,
    remove_lighting: true,
  };
  const r = await req('POST', '/v1/image-to-3d', body);
  tasks.image = r.result || r.id || r;
  saveTasks();
  console.log(`image-to-3d task: ${tasks.image}\nscratch: ${dir}`);
} else if (cmd === 'image-status') {
  const r = await req('GET', `/v1/image-to-3d/${tasks.image}`);
  console.log(`image ${tasks.image}: ${r.status} ${r.progress ?? ''} ${r.task_error?.message ?? ''}`);
} else if (cmd === 'image-download') {
  const r = await req('GET', `/v1/image-to-3d/${tasks.image}`);
  if (r.status !== 'SUCCEEDED') throw new Error(`not ready: ${r.status} ${r.progress ?? ''}`);
  await download(r.model_urls.glb, join(dir, 'image.glb'));
  if (r.thumbnail_url) await download(r.thumbnail_url, join(dir, 'image-thumb.png')).catch(() => {});
} else if (cmd === 'submit') {
  const promptFile = argv[2];
  if (!promptFile || !existsSync(promptFile)) throw new Error(`missing prompt file: ${promptFile}`);
  const prompt = readFileSync(promptFile, 'utf8').trim();
  const body = {
    mode: 'preview',
    prompt,
    art_style: flag('style', 'realistic'),
    ai_model: flag('model', 'meshy-5'),
    topology: 'triangle',
    target_polycount: Number(flag('polycount', '30000')),
    symmetry_mode: flag('symmetry', 'on'),
    should_remesh: true,
  };
  const r = await req('POST', '/v2/text-to-3d', body);
  tasks.preview = r.result || r.id || r;
  tasks.prompt = prompt;
  saveTasks();
  console.log(`preview task: ${tasks.preview}\nscratch: ${dir}`);
} else if (cmd === 'status') {
  for (const stage of ['preview', 'refine']) {
    if (!tasks[stage]) continue;
    const r = await req('GET', `/v2/text-to-3d/${tasks[stage]}`);
    console.log(`${stage} ${tasks[stage]}: ${r.status} ${r.progress ?? ''} ${r.task_error?.message ?? ''}`);
  }
} else if (cmd === 'refine') {
  if (!tasks.preview) throw new Error('no preview task');
  const tpFile = flag('texture-prompt-file', null);
  const body = { mode: 'refine', preview_task_id: tasks.preview, enable_pbr: true };
  if (tpFile && existsSync(tpFile)) body.texture_prompt = readFileSync(tpFile, 'utf8').trim();
  const r = await req('POST', '/v2/text-to-3d', body);
  tasks.refine = r.result || r.id || r;
  saveTasks();
  console.log(`refine task: ${tasks.refine}`);
} else if (cmd === 'download') {
  const stage = argv[2] === 'preview' ? 'preview' : tasks.refine ? 'refine' : 'preview';
  const r = await req('GET', `/v2/text-to-3d/${tasks[stage]}`);
  if (r.status !== 'SUCCEEDED') throw new Error(`not ready: ${r.status} ${r.progress ?? ''}`);
  await download(r.model_urls.glb, join(dir, `${stage}.glb`));
  if (r.thumbnail_url) await download(r.thumbnail_url, join(dir, `${stage}-thumb.png`)).catch(() => {});
} else {
  throw new Error(`unknown cmd ${cmd}`);
}
