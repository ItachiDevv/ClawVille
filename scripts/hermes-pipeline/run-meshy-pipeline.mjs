#!/usr/bin/env node
// Full Meshy pipeline for a batch of avatars: multi-image mesh -> rig -> core anims,
// downloading every GLB. Runs avatars concurrently. VRM inject is a separate step.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = (() => {
  for (const f of [join(homedir(), '.itachi-api-keys'), join(homedir(), '.mcp.json')]) {
    try { const m = readFileSync(f, 'utf8').match(/msy_[A-Za-z0-9_-]+/); if (m) return m[0]; } catch {}
  }
  throw new Error('MESHY key not found');
})();
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const API = 'https://api.meshy.ai/openapi/v1';
const ROOT = 'C:/Users/newma/Documents/Crypto/ClawVille/apps/web/public/models';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// avatar -> {viewsDir (relative to <slug>-turnaround), height}
const AVATARS = [
  { slug: 'helen',        viewsDir: 'openai-v2', height: 1.7 },
  { slug: 'clytemnestra', viewsDir: 'openai-v2', height: 1.7 },
  { slug: 'phanes',       viewsDir: 'openai',    height: 1.8 },
];
const ACTIONS = { idle: 0, swimming: 569, jump: 86, cheering: 59, wipeout: 187, wave: 28, talk: 313, dance: 64 };

const MESH_BODY = {
  ai_model: 'meshy-6', pose_mode: 't-pose', symmetry_mode: 'on',
  should_remesh: true, topology: 'quad', target_polycount: 60000,
  should_texture: true, enable_pbr: true, image_enhancement: true,
  remove_lighting: true, target_formats: ['glb'],
};

function dataUri(p) { return `data:image/png;base64,${readFileSync(p).toString('base64')}`; }
function glbUrls(obj) {
  const s = JSON.stringify(obj);
  return [...s.matchAll(/https:\/\/assets\.meshy\.ai\/[^"\\]+?\.glb[^"\\]*/g)].map((m) => m[0]);
}
async function postRetry(path, body, tag) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${API}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    if (res.ok) return (await res.json()).result;
    const txt = await res.text();
    if (res.status === 429 || res.status >= 500) { console.log(`  [${tag}] ${res.status} retry ${i + 1}`); await sleep(8000 * (i + 1)); continue; }
    throw new Error(`[${tag}] POST ${path} ${res.status}: ${txt.slice(0, 200)}`);
  }
  throw new Error(`[${tag}] POST ${path} exhausted retries`);
}
async function poll(path, tag, maxRounds = 80) {
  for (let i = 0; i < maxRounds; i++) {
    const res = await fetch(`${API}${path}`, { headers: H });
    if (res.ok) {
      const t = await res.json();
      if (t.status === 'SUCCEEDED') return t;
      if (t.status === 'FAILED' || t.status === 'CANCELED') throw new Error(`[${tag}] ${t.status}: ${JSON.stringify(t.task_error || '').slice(0, 200)}`);
    }
    await sleep(7000);
  }
  throw new Error(`[${tag}] poll timeout`);
}
async function dl(url, dest) {
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(dest, buf);
  return (buf.length / 1048576).toFixed(1);
}

async function runAvatar(av) {
  const turn = `${ROOT}/${av.slug}-turnaround/${av.viewsDir}`;
  const out = `${ROOT}/${av.slug}-mesh/meshy-openai`;
  const animOut = `${out}/anim`;
  mkdirSync(animOut, { recursive: true });
  const views = ['front', 'back', '3q', 'face'].map((v) => `${turn}/${v}.png`);
  for (const v of views) if (!existsSync(v)) throw new Error(`[${av.slug}] missing view ${v}`);

  console.log(`[${av.slug}] mesh: posting…`);
  const meshTask = await postRetry('/multi-image-to-3d', { ...MESH_BODY, image_urls: views.map(dataUri) }, `${av.slug}/mesh`);
  const mesh = await poll(`/multi-image-to-3d/${meshTask}`, `${av.slug}/mesh`);
  const meshGlb = glbUrls(mesh).find((u) => /model\.glb/.test(u)) || glbUrls(mesh)[0];
  console.log(`[${av.slug}] mesh OK -> ${await dl(meshGlb, `${out}/mesh.glb`)} MB`);

  console.log(`[${av.slug}] rig: posting…`);
  const rigTask = await postRetry('/rigging', { input_task_id: meshTask, height_meters: av.height }, `${av.slug}/rig`);
  const rig = await poll(`/rigging/${rigTask}`, `${av.slug}/rig`);
  const ru = glbUrls(rig);
  const rigged = ru.find((u) => /Character_output\.glb/.test(u));
  const walk = ru.find((u) => /Walking_withSkin\.glb/.test(u));
  const run = ru.find((u) => /Running_withSkin\.glb/.test(u));
  if (rigged) console.log(`[${av.slug}] rigged OK -> ${await dl(rigged, `${out}/rigged.glb`)} MB`);
  if (walk) await dl(walk, `${out}/walk.glb`);
  if (run) await dl(run, `${out}/run.glb`);
  console.log(`[${av.slug}] walk/run downloaded`);

  // fire 8 anims (small stagger), then poll+download each
  const animTasks = {};
  for (const [slot, action_id] of Object.entries(ACTIONS)) {
    animTasks[slot] = await postRetry('/animations', { rig_task_id: rigTask, action_id }, `${av.slug}/anim:${slot}`);
    await sleep(1200);
  }
  for (const [slot, id] of Object.entries(animTasks)) {
    const t = await poll(`/animations/${id}`, `${av.slug}/anim:${slot}`);
    const url = glbUrls(t).find((u) => !/_armature/.test(u)) || glbUrls(t)[0];
    if (url) console.log(`[${av.slug}] anim ${slot} OK -> ${await dl(url, `${animOut}/${slot}.glb`)} MB`);
    else console.log(`[${av.slug}] anim ${slot} NO GLB`);
  }
  console.log(`[${av.slug}] === DONE ===`);
  return av.slug;
}

const results = await Promise.allSettled(AVATARS.map(runAvatar));
console.log('\n==== SUMMARY ====');
results.forEach((r, i) => console.log(`${AVATARS[i].slug}: ${r.status === 'fulfilled' ? 'OK' : 'FAILED — ' + r.reason?.message}`));
