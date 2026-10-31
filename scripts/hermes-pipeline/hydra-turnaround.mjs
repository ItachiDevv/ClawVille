#!/usr/bin/env node
/**
 * hydra-turnaround.mjs — Hydra NPC turnaround generator (round 2, 2026-10-31).
 *
 * Why round 2: the owner's first reference set hid the eyes under the bangs and
 * Meshy's remesh smoothed them away; the suit glow did not read in 3D. These
 * views anchor to (a) the round-1 front T-pose (body, armor, proportions) and
 * (b) the owner's site key art (`source/site-ref.png`, LOCAL ONLY and git-ignored: partner art is never committed; eyes, ring earpieces,
 * mask-to-earpiece glow line, chest H). gpt-image-2 (holds refs best — lesson #4).
 *
 * Usage:
 *   OPENAI_IMAGE_CAP_USD=3 node scripts/hermes-pipeline/hydra-turnaround.mjs front
 *   OPENAI_IMAGE_CAP_USD=3 node scripts/hermes-pipeline/hydra-turnaround.mjs back,3q,face   # anchored to the new front
 *   [--quality high] [--suffix -v2]
 *
 * SPEND CAP (owner rule 2026-10-04): refuses to run without OPENAI_IMAGE_CAP_USD.
 * Every call is booked at EST_USD_PER_CALL (cautious upper bound) in
 * `hydra-turnaround/openai/spend.json` BEFORE it is sent; a call that would
 * push the booked total past the cap is refused. The real token usage the API
 * returns is stored next to each booking.
 *
 * Env: OPENAI_API_KEY (env first — the owner supplied the key for this job).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const EST_USD_PER_CALL = 0.4;

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
const views = (args[0] || 'front').split(',').map((v) => v.trim()).filter(Boolean);
const qFlag = args.indexOf('--quality');
const quality = qFlag >= 0 ? args[qFlag + 1] : 'high';
const sFlag = args.indexOf('--suffix');
const SUFFIX = sFlag >= 0 ? args[sFlag + 1] : '';
const MODEL = 'gpt-image-2';

const CAP = Number(process.env.OPENAI_IMAGE_CAP_USD);
if (!Number.isFinite(CAP) || CAP <= 0) {
  console.error('refusing: set OPENAI_IMAGE_CAP_USD=<owner-approved dollars>');
  process.exit(1);
}

const turnDir = resolve('apps/web/public/models/hydra-turnaround');
const outDir = join(turnDir, 'openai-v2');
mkdirSync(outDir, { recursive: true });
const spendPath = join(outDir, 'spend.json');
const spend = existsSync(spendPath) ? JSON.parse(readFileSync(spendPath, 'utf8')) : { bookedUsd: 0, calls: [] };
const saveSpend = () => writeFileSync(spendPath, JSON.stringify(spend, null, 2));

// Identity block repeated verbatim in every view (cross-view consistency — lesson #1).
const IDENTITY = [
  'The character: a young woman cyber-guardian android in polished anime style.',
  'Very long straight silver-white hair with a soft blue sheen that falls to her waist. Her bangs are parted and swept to the sides so they NEVER cover her eyes.',
  'LARGE, clear, striking anime eyes with bright glowing ice-blue irises and light catchlights, fully visible and glowing softly cyan.',
  'A matte black segmented tactical face mask covers her nose and mouth; a thin glowing cyan line runs along the mask edge from the mask back to each earpiece.',
  'Round glowing cyan ring earpieces (headphone discs) sit over both ears, joined to the mask by that glowing line.',
  'She wears a sleek glossy black segmented armored bodysuit with glowing electric-blue light lines along the seams of the torso, waist, arms and legs.',
  'A glowing cyan hexagon emblem with a bold capital letter H sits in the center of her upper chest.',
  'Curvy hourglass figure with a VERY LARGE, heavy, prominent bust, about one and a half times the size shown in the reference images, fully covered by the bodysuit.',
  'Black armored knee plates and chunky FLAT-SOLED black armored combat boots with NO heels (CLOSED footwear, never high heels or platforms).',
  'The only colors are black armor, silver-white hair, and glowing cyan-blue light lines, emblem, earpieces and eyes. She holds nothing: no weapons, no props, no floating effects, no dragons.',
].join(' ');

const STYLE = [
  'Clean high-detail anime character art with crisp cel shading; the blue lights glow like neon.',
  'PURE SOLID WHITE background (#FFFFFF), flat even studio lighting, NO cast shadow, no floor, no text, no watermark, no background art.',
  'Character-reference sheet quality, suitable for multi-view image-to-3D reconstruction.',
].join(' ');

// Strict T-pose (lesson #2: armspan/height >= 0.95 hard gate).
const TPOSE = [
  'She stands in a STRICT, RIGID T-POSE: legs straight and slightly apart, BOTH arms fully extended straight out to the sides,',
  'PERFECTLY HORIZONTAL at exact shoulder height, elbows locked, palms facing down, fingers straight and together.',
  'The arms form one perfectly horizontal line with the shoulders, never angled downward.',
  'Her long hair hangs straight down behind her back and shoulders, NOT draped over the arms or the chest.',
  'Centered, full body visible head to feet with a small margin, calm neutral expression, no motion.',
].join(' ');

const VIEW_PROMPT = {
  front: `${IDENTITY} ${TPOSE} Orthographic FRONT view: she faces the camera directly; both large glowing blue eyes are clearly visible above the mask, both ring earpieces visible. ${STYLE}`,
  back: `${IDENTITY} ${TPOSE} Orthographic BACK view of the SAME character as the reference images, facing directly away from the camera: we see the back of her head and her long silver-white hair, the glowing ring earpieces at both sides of the head, the glowing blue lines on the back of the suit, and the back of both horizontal arms. ${STYLE}`,
  '3q': `${IDENTITY} ${TPOSE} Three-quarter (3/4) DIAGONAL view of the SAME character as the reference images, rotated about 45 degrees between front and her left side, full body visible; the near glowing earpiece and the glowing line to the mask are clearly visible, and both eyes are visible. ${STYLE}`,
  face: [
    'Head-and-shoulders close-up PORTRAIT of the SAME character as the reference image: same eyes, mask, earpieces and hair.',
    'She faces the camera directly. Her LARGE, clear, striking anime eyes have bright glowing ice-blue irises with catchlights; both eyes are fully visible and open, with NO hair over them.',
    'Matte black segmented face mask over the nose and mouth; a thin glowing cyan line runs from the mask edge to the round glowing cyan ring earpieces over both ears.',
    'Silver-white hair parted with the bangs swept to the sides, long hair falling behind the shoulders. Top of the black armored collar and the edge of the glowing H emblem at the bottom of the frame.',
    'The earpieces are simple round discs with a glowing cyan ring. NO hair ornaments, NO crests, NO spikes, NO fins or antennae on the head.',
    'HEAD AND SHOULDERS ONLY, face centered and fully in frame.',
    STYLE,
  ].join(' '),
};

function refsFor(view) {
  const site = join(turnDir, 'source', 'site-ref.png');
  // Round-2 body anchor when present (owner-picked view), else the round-1 front.
  const bodyR2 = join(outDir, 'front-body-ref.png');
  const body = existsSync(bodyR2) ? bodyR2 : join(turnDir, 'source', 'Silver-haired armored android in T-pose-1.png');
  const front = join(outDir, 'front.png');
  if (view === 'face') return [site].filter(existsSync);
  if ((view === 'back' || view === '3q') && existsSync(front)) return [front, site].filter(existsSync);
  return [body, site].filter(existsSync);
}

const VIEW_SIZE = (v) => (v === 'face' ? '1024x1024' : '1024x1536');
const key = loadKey();

async function genView(view) {
  const prompt = VIEW_PROMPT[view];
  if (!prompt) { console.error(`unknown view '${view}'`); return null; }
  const refs = refsFor(view);
  if (refs.length === 0) { console.error('no reference images found'); return null; }
  if (spend.bookedUsd + EST_USD_PER_CALL > CAP) {
    console.error(`[${view}] refused: booked $${spend.bookedUsd.toFixed(2)} + est $${EST_USD_PER_CALL} > cap $${CAP}`);
    return null;
  }
  const entry = { view: `${view}${SUFFIX}`, at: new Date().toISOString(), estUsd: EST_USD_PER_CALL, usage: null, ok: false };
  spend.bookedUsd = Number((spend.bookedUsd + EST_USD_PER_CALL).toFixed(2));
  spend.calls.push(entry);
  saveSpend();

  const form = new FormData();
  form.append('model', MODEL);
  form.append('prompt', prompt);
  form.append('size', VIEW_SIZE(view));
  form.append('quality', quality);
  form.append('n', '1');
  for (const ref of refs) {
    form.append('image[]', new Blob([readFileSync(ref)], { type: 'image/png' }), ref.split(/[\\/]/).pop());
  }
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  const txt = await res.text();
  if (!res.ok) { console.error(`[${view}] HTTP ${res.status}: ${txt.slice(0, 600)}`); saveSpend(); return null; }
  const json = JSON.parse(txt);
  entry.usage = json.usage ?? null;
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) { console.error(`[${view}] no image in response`); saveSpend(); return null; }
  const outPath = join(outDir, `${view}${SUFFIX}.png`);
  writeFileSync(outPath, Buffer.from(b64, 'base64'));
  entry.ok = true;
  saveSpend();
  console.log(`[${view}] OK -> ${outPath} (${((Date.now() - t0) / 1000).toFixed(1)}s, refs: ${refs.map((r) => r.split(/[\\/]/).pop()).join(' + ')}, usage ${JSON.stringify(entry.usage)})`);
  return outPath;
}

console.log(`hydra turnaround: views=${views.join(',')} model=${MODEL} quality=${quality} cap=$${CAP} booked=$${spend.bookedUsd.toFixed(2)}\n`);
for (const v of views) await genView(v);
console.log(`\nbooked total $${spend.bookedUsd.toFixed(2)} of cap $${CAP}`);
