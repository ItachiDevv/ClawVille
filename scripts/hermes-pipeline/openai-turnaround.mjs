#!/usr/bin/env node
/**
 * openai-turnaround.mjs — generate fresh, character-consistent turnaround views
 * for a Hatcher avatar using OpenAI's image model (gpt-image-1).
 *
 * Uses the existing source-ref + front as REFERENCE images (images/edits) so the
 * new views stay the SAME character / outfit / proportions. Writes to a NEW
 * subdir (never overwrites the originals).
 *
 * Usage:
 *   node scripts/hermes-pipeline/openai-turnaround.mjs <character> <view[,view...]> [--quality high] [--out <dir>]
 *   e.g. node scripts/hermes-pipeline/openai-turnaround.mjs cronus front,side,back
 *
 * Env: OPENAI_API_KEY (read from .env.local if not in process env).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ---- key load (don't print it) ----
function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  for (const f of ['.env.local', 'apps/api/.env.local']) {
    try {
      const line = readFileSync(f, 'utf8').split(/\r?\n/).find((l) => l.startsWith('OPENAI_API_KEY='));
      if (line) return line.slice('OPENAI_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
    } catch {}
  }
  throw new Error('OPENAI_API_KEY not found in env or .env.local');
}

const args = process.argv.slice(2);
const character = args[0];
const views = (args[1] || 'front,back,3q,face').split(',').map((v) => v.trim()).filter(Boolean);
const qFlag = args.indexOf('--quality');
const quality = qFlag >= 0 ? args[qFlag + 1] : 'high';
const oFlag = args.indexOf('--out');
const eFlag = args.indexOf('--extra');
const EXTRA = eFlag >= 0 ? args[eFlag + 1] : '';
const MODEL = 'gpt-image-1';
const SIZE = '1024x1536'; // portrait — full standing body

if (!character) {
  console.error('usage: node openai-turnaround.mjs <character> <front,side,back> [--quality high]');
  process.exit(1);
}

const turnDir = resolve(`apps/web/public/models/${character}-turnaround`);
const outDir = oFlag >= 0 ? resolve(args[oFlag + 1]) : join(turnDir, 'openai');
mkdirSync(outDir, { recursive: true });

// reference images that lock identity (use whatever exists)
const refCandidates = ['source-ref.png', 'front.png'].map((f) => join(turnDir, f)).filter(existsSync);
if (refCandidates.length === 0) {
  console.error(`no reference images (source-ref.png/front.png) found in ${turnDir}`);
  process.exit(1);
}

// Full-body T-pose base (front / back / 3-4 diagonal)
const BODY_BASE = [
  'Full-body character art of the SAME character shown in the reference image(s) — identical face, hair, beard, skin tone, outfit, armor, jewelry, sandals and colors.',
  'The character stands in a STRICT, RIGID T-POSE: legs straight and slightly apart, BOTH arms fully extended straight out to the sides, perfectly horizontal at shoulder height, palms facing down, fingers straight and together.',
  'Centered, full body head-to-feet with a small margin, neutral face, no motion.',
  'PURE SOLID WHITE background (#FFFFFF), flat even studio lighting, NO cast shadow on the ground, no floor, no props, no text.',
  'Clean photorealistic 3D-character-reference style, high detail, suitable for photogrammetry / image-to-3D.',
].join(' ');

// Head-and-shoulders portrait base (face)
const FACE_BASE = [
  'Head-and-shoulders close-up PORTRAIT of the SAME character shown in the reference image(s) — identical face, hair, beard, skin tone, jewelry and colors.',
  'Front-facing, neutral expression, eyes open looking at the camera, mouth closed.',
  'PURE SOLID WHITE background (#FFFFFF), flat even studio lighting, NO cast shadow, no props, no text.',
  'Sharp, high-detail photorealistic character-reference style, face fully in frame and centered.',
].join(' ');

const VIEW_PROMPT = {
  front: 'Orthographic FRONT view: the character faces the camera directly.',
  back:  'Orthographic BACK view: the character faces directly away from the camera; we see the back of the head, body and arms.',
  '3q':  'Three-quarter (3/4) DIAGONAL view, rotated about 45 degrees between front and left side, full body still visible. Keep the strict horizontal T-pose arms.',
  face:  '', // FACE_BASE carries the framing
};

// per-view base + canvas size
const VIEW_BASE = (v) => (v === 'face' ? FACE_BASE : BODY_BASE);
const VIEW_SIZE = (v) => (v === 'face' ? '1024x1024' : SIZE);

const key = loadKey();

async function genView(view) {
  const prompt = `${VIEW_BASE(view)} ${VIEW_PROMPT[view] ?? ''} ${EXTRA}`.trim();
  const form = new FormData();
  form.append('model', MODEL);
  form.append('prompt', prompt);
  form.append('size', VIEW_SIZE(view));
  form.append('quality', quality);
  form.append('n', '1');
  for (const ref of refCandidates) {
    const buf = readFileSync(ref);
    form.append('image[]', new Blob([buf], { type: 'image/png' }), ref.split(/[\\/]/).pop());
  }
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const txt = await res.text();
  if (!res.ok) {
    console.error(`[${view}] HTTP ${res.status}: ${txt.slice(0, 600)}`);
    return null;
  }
  const json = JSON.parse(txt);
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) { console.error(`[${view}] no image in response: ${txt.slice(0, 300)}`); return null; }
  const outPath = join(outDir, `${view}.png`);
  writeFileSync(outPath, Buffer.from(b64, 'base64'));
  const kb = (existsSync(outPath) ? readFileSync(outPath).length : 0) / 1024;
  console.log(`[${view}] OK -> ${outPath} (${kb.toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return outPath;
}

console.log(`character=${character} views=${views.join(',')} model=${MODEL} size=${SIZE} quality=${quality}`);
console.log(`refs: ${refCandidates.map((r) => r.split(/[\\/]/).pop()).join(', ')}`);
console.log(`out:  ${outDir}\n`);

for (const v of views) {
  await genView(v); // sequential — keep it gentle + readable
}
console.log('\ndone.');
