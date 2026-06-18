#!/usr/bin/env node
// Poll a set of Meshy animation tasks to completion and download each GLB.
// Usage: node fetch-meshy-anims.mjs   (task map + key are inline/below)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = (() => {
  for (const f of [join(homedir(), '.itachi-api-keys'), join(homedir(), '.mcp.json')]) {
    try { const m = readFileSync(f, 'utf8').match(/msy_[A-Za-z0-9_-]+/); if (m) return m[0]; } catch {}
  }
  throw new Error('MESHY key not found');
})();

// slot -> animation task_id
const TASKS = {
  idle:        '019edc84-1823-76b3-8a4d-64f1102bc052',
  swimming:    '019edc84-4755-751f-a61d-2d6fbfe49e2b',
  jump:        '019edc84-4d3d-76c2-8708-249cbf4dcc44',
  cheering:    '019edc84-6b6c-762a-8eeb-d5c11fb58cb3',
  wipeout:     '019edc84-719c-76d7-ae8d-e01341062694',
  wave:        '019edc84-76e0-76d9-bdcb-ca0a3781cc79',
  talk:        '019edc84-7cff-7630-bf46-14b80e094fd2',
  dance:       '019edc84-827d-76da-a9c5-db2178eaed92',
  surf_balance:'019edc84-877e-730a-8582-70a41382b60c',
  surf_slide:  '019edc84-8d89-7530-a61f-df9077bc46cd',
};

const OUT = 'C:/Users/newma/Documents/Crypto/ClawVille/apps/web/public/models/cronus-mesh/meshy-openai/anim';
mkdirSync(OUT, { recursive: true });

const hdr = { Authorization: `Bearer ${KEY}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTask(id) {
  const res = await fetch(`https://api.meshy.ai/openapi/v1/animations/${id}`, { headers: hdr });
  if (!res.ok) return { status: `HTTP_${res.status}` };
  return res.json();
}

async function run() {
  const pending = new Map(Object.entries(TASKS));
  const done = {};
  let round = 0;
  while (pending.size && round < 60) {
    round++;
    for (const [slot, id] of [...pending]) {
      const t = await getTask(id);
      const st = t.status;
      if (st === 'SUCCEEDED') {
        const url = t.animation_glb_url || t.result?.animation_glb_url;
        if (!url) { console.log(`[${slot}] SUCCEEDED but no glb url -> ${JSON.stringify(t).slice(0,200)}`); pending.delete(slot); continue; }
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        writeFileSync(join(OUT, `${slot}.glb`), buf);
        console.log(`[${slot}] OK -> ${slot}.glb (${(buf.length/1048576).toFixed(1)} MB)`);
        done[slot] = true; pending.delete(slot);
      } else if (st === 'FAILED' || st === 'CANCELED' || String(st).startsWith('HTTP_')) {
        console.log(`[${slot}] ${st} :: ${JSON.stringify(t.task_error||t).slice(0,200)}`);
        pending.delete(slot);
      }
    }
    if (pending.size) { console.log(`round ${round}: ${pending.size} pending (${[...pending.keys()].join(',')})`); await sleep(6000); }
  }
  console.log(`\nDONE. downloaded: ${Object.keys(done).join(', ')} | still-pending: ${[...pending.keys()].join(',')||'none'}`);
}
run().catch((e) => { console.error(e); process.exit(1); });
