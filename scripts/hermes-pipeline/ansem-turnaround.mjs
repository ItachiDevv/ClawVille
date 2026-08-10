#!/usr/bin/env node
/**
 * ansem-turnaround.mjs — Ansem exclusive-avatar turnaround generator.
 *
 * Same recipe as the Biggie build (character-pipeline.md lessons 1-4) but
 * ANIME-styled to match the source art, and driven on gpt-image-2 (holds
 * identity refs distinctly better than gpt-image-1 — binding lesson #4).
 *
 * Character views (front/back/3q/face) are generated CLEAN — no sword, no
 * floating glass, no lightning aura. The greatsword is a SEPARATE asset
 * (sword view) so Meshy's auto-rig can never skin blade verts to arm bones.
 *
 * Usage:
 *   node scripts/hermes-pipeline/ansem-turnaround.mjs front
 *   node scripts/hermes-pipeline/ansem-turnaround.mjs back,3q,face   # anchored to approved front
 *   node scripts/hermes-pipeline/ansem-turnaround.mjs sword
 *   [--quality high] [--suffix -v2]  (suffix keeps re-rolls side by side)
 *
 * Env: OPENAI_API_KEY (read from .env.local FIRST — the project key — then env).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

function loadKey() {
  for (const f of ['.env.local', 'apps/api/.env.local']) {
    try {
      const line = readFileSync(f, 'utf8').split(/\r?\n/).find((l) => l.startsWith('OPENAI_API_KEY='));
      if (line) return line.slice('OPENAI_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
    } catch {}
  }
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  throw new Error('OPENAI_API_KEY not found in .env.local or env');
}

const args = process.argv.slice(2);
const views = (args[0] || 'front').split(',').map((v) => v.trim()).filter(Boolean);
const qFlag = args.indexOf('--quality');
const quality = qFlag >= 0 ? args[qFlag + 1] : 'high';
const sFlag = args.indexOf('--suffix');
const SUFFIX = sFlag >= 0 ? args[sFlag + 1] : '';
const MODEL = 'gpt-image-2';

const turnDir = resolve('apps/web/public/models/ansem-turnaround');
const outDir = join(turnDir, 'openai');
mkdirSync(outDir, { recursive: true });

// Identity block repeated verbatim in every view prompt — cross-view
// consistency beats per-view beauty (binding lesson #1).
const IDENTITY = [
  'The character: a young Black man with dark brown skin and short black afro-textured hair with tight curls.',
  'Two glowing neon yellow-green demon horns curve upward and outward from his front hairline, one on each side, smooth and emissive like green-hot metal.',
  'His eyes glow bright green.',
  'He wears: a black high-collar zip-up techwear jacket zipped to the chin; over it a long open BLACK trench coat with a ragged tattered hem that falls to mid-calf; baggy black cargo pants; black leather gloves; chunky black lace-up combat boots (CLOSED footwear, never sandals).',
  'All clothing is matte black. The only colors on the character are his skin, the glowing green horns, and the glowing green eyes.',
  'He carries NOTHING: no sword, no weapon, no props. There are NO floating objects, NO glass shards, NO lightning, NO aura, NO energy effects.',
].join(' ');

const STYLE = [
  'Clean high-detail ANIME character art style with crisp cel shading, matching the reference art style exactly.',
  'PURE SOLID WHITE background (#FFFFFF), flat even studio lighting, NO cast shadow, no floor, no text, no watermark.',
  'Character-reference sheet quality, suitable for multi-view image-to-3D reconstruction.',
].join(' ');

// Strict T-pose language — binding lesson #2 (armspan/height >= 0.95 HARD GATE).
const TPOSE = [
  'He stands in a STRICT, RIGID T-POSE: legs straight and slightly apart, BOTH arms fully extended straight out to the sides,',
  'PERFECTLY HORIZONTAL at exact shoulder height, elbows locked, palms facing down, fingers straight and together.',
  'The arms must form one perfectly horizontal line with the shoulders — never angled downward.',
  'The trench coat hangs from the shoulders but the arms and sleeves stay perfectly horizontal.',
  'Centered, full body visible head to feet with a small margin, neutral face, no motion.',
].join(' ');

const VIEW_PROMPT = {
  front: `${IDENTITY} ${TPOSE} Orthographic FRONT view: the character faces the camera directly. ${STYLE}`,
  back: `${IDENTITY} ${TPOSE} Orthographic BACK view: the SAME character as the reference images, facing directly away from the camera; we see the back of his head, the back of the trench coat, and the back of both horizontal arms. The two green horns are still visible poking up from behind his head, and both horns curve upward with their TIPS pointing INWARD toward each other (toward the centerline of the head), exactly the same horn shape and direction as the front reference image. ${STYLE}`,
  '3q': `${IDENTITY} ${TPOSE} Three-quarter (3/4) DIAGONAL view of the SAME character as the reference images, rotated about 45 degrees between front and left side, full body still visible. Keep the strict horizontal T-pose arms. ${STYLE}`,
  face: [
    'Head-and-shoulders close-up PORTRAIT of the SAME character shown in the reference image(s) — identical face, hair, skin tone, horns and colors.',
    'A young Black man with dark brown skin, short black afro-textured hair with tight curls, two glowing neon yellow-green demon horns curving upward from his front hairline, and glowing bright green eyes.',
    'Front-facing, neutral confident expression, eyes open looking at the camera, mouth closed. High black jacket collar visible at the bottom of frame.',
    'The horns are SMOOTH glossy crescents with clean sharp edges (NOT flame-textured, no fire), tips curving inward toward each other, the same modest size as in the reference.',
    'His facial skin is completely CLEAN: NO lightning marks, NO glowing cracks, NO tattoos, NO energy effects anywhere on the face or around the eyes.',
    'HEAD AND SHOULDERS ONLY — no full body, face fully in frame and centered.',
    STYLE,
  ].join(' '),
  sword: [
    'A single massive anime greatsword, isolated on a PURE SOLID WHITE background (#FFFFFF), shown in perfect SIDE PROFILE, blade pointing straight down, grip at the top.',
    'The sword from the reference image: a huge dark gunmetal-black cleaver-like blade with an angular clipped tip, subtle battle-worn texture, and a thin glowing green energy line running down the center of the blade.',
    'Ornate dark cross-guard with angular flared quillons and a small glowing green gem at its center. Long two-handed grip wrapped in dark leather cord, ending in a heavy dark disc pommel.',
    'The blade is very wide and nearly as tall as a person. The only colors are dark gunmetal, black, and the glowing green accents.',
    'NO character, NO hands, NO floating glass, NO lightning, no text.',
    'Clean high-detail anime weapon concept art with crisp cel shading, flat even lighting, no cast shadow. Game asset reference sheet quality, suitable for image-to-3D reconstruction.',
  ].join(' '),
};

// Refs: front anchors to the source art; all later views ALSO anchor to the
// approved front (binding lesson #4). Face uses the source art only (full-body
// front ref would overpower portrait framing). Sword uses the source art only.
function refsFor(view) {
  const src = ['source-ref.jpg', 'source-ref.png'].map((f) => join(turnDir, f)).filter(existsSync);
  const front = join(outDir, 'front.png');
  if ((view === 'back' || view === '3q') && existsSync(front)) return [...src, front];
  return src;
}

const VIEW_SIZE = (v) => (v === 'face' ? '1024x1024' : '1024x1536');
const key = loadKey();

async function genView(view) {
  const prompt = VIEW_PROMPT[view];
  if (!prompt) { console.error(`unknown view '${view}'`); return null; }
  const refs = refsFor(view);
  if (refs.length === 0) { console.error('no reference images found'); return null; }
  const form = new FormData();
  form.append('model', MODEL);
  form.append('prompt', prompt);
  form.append('size', VIEW_SIZE(view));
  form.append('quality', quality);
  form.append('n', '1');
  for (const ref of refs) {
    const buf = readFileSync(ref);
    const mime = ref.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
    form.append('image[]', new Blob([buf], { type: mime }), ref.split(/[\\/]/).pop());
  }
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const txt = await res.text();
  if (!res.ok) { console.error(`[${view}] HTTP ${res.status}: ${txt.slice(0, 600)}`); return null; }
  const b64 = JSON.parse(txt)?.data?.[0]?.b64_json;
  if (!b64) { console.error(`[${view}] no image in response: ${txt.slice(0, 300)}`); return null; }
  const outPath = join(outDir, `${view}${SUFFIX}.png`);
  writeFileSync(outPath, Buffer.from(b64, 'base64'));
  console.log(`[${view}] OK -> ${outPath} (${(readFileSync(outPath).length / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s, refs: ${refs.map((r) => r.split(/[\\/]/).pop()).join('+')})`);
  return outPath;
}

console.log(`ansem turnaround: views=${views.join(',')} model=${MODEL} quality=${quality}${SUFFIX ? ` suffix=${SUFFIX}` : ''}\n`);
for (const v of views) await genView(v);
console.log('\ndone.');
