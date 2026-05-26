/**
 * Slot icon optimizer (Phase 6.1.12) — buffer-based for predictability.
 *
 *   1. Knock near-white pixels to transparent (alpha 0..255 ramp).
 *   2. Trim transparent edges.
 *   3. Pad to a centered square.
 *   4. Resize to 512×512.
 *   5. PNG-encode with palette compression.
 *
 * Each step writes to a Buffer so the pipeline is observable and
 * sharp's chained-state quirks don't accumulate.
 */

import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SRC_DIR = path.join(os.homedir(), 'Downloads', 'clawville-new');
const OUT_DIR = path.resolve(import.meta.dir, 'slot-icons-optimized');

const TARGET = 512;
const PAD_FRACTION = 0.06;
const WHITE_THRESHOLD = 230;
const DROP_NEAR_THRESHOLD = 250;

async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }

async function knockOutBackground(inputBuf) {
  const { data, info } = await sharp(inputBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 4) throw new Error('expected 4 channels');

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const minRgb = Math.min(r, g, b);
    if (minRgb >= DROP_NEAR_THRESHOLD) {
      data[i + 3] = 0;
    } else if (minRgb >= WHITE_THRESHOLD) {
      const t = (minRgb - WHITE_THRESHOLD) / (DROP_NEAR_THRESHOLD - WHITE_THRESHOLD);
      data[i + 3] = Math.round(255 * (1 - t));
    }
  }

  // Re-encode raw → PNG
  return await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

async function trimToFigure(buf) {
  return await sharp(buf).trim({ threshold: 10 }).png().toBuffer();
}

async function padToSquare(buf) {
  const m = await sharp(buf).metadata();
  const w = m.width;
  const h = m.height;
  const side = Math.round(Math.max(w, h) * (1 + 2 * PAD_FRACTION));
  const padTop    = Math.floor((side - h) / 2);
  const padBottom = side - h - padTop;
  const padLeft   = Math.floor((side - w) / 2);
  const padRight  = side - w - padLeft;
  return await sharp(buf)
    .extend({
      top: padTop, bottom: padBottom, left: padLeft, right: padRight,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function resizeAndEncode(buf, outPath) {
  await sharp(buf)
    .resize(TARGET, TARGET, { kernel: 'lanczos3' })
    .png({ quality: 92, compressionLevel: 9, palette: true, colours: 192 })
    .toFile(outPath);
}

async function processOne(srcPath, outPath) {
  const inputBuf = await fs.readFile(srcPath);
  const meta = await sharp(inputBuf).metadata();
  console.log(`  ${path.basename(srcPath)}: ${meta.width}×${meta.height} ${meta.format}, ${(inputBuf.length / 1024).toFixed(0)} KB`);

  const knocked = await knockOutBackground(inputBuf);
  const trimmed = await trimToFigure(knocked);
  const trimMeta = await sharp(trimmed).metadata();
  const squared = await padToSquare(trimmed);
  const squareMeta = await sharp(squared).metadata();
  await resizeAndEncode(squared, outPath);
  const finalMeta = await sharp(outPath).metadata();
  const finalSize = (await fs.stat(outPath)).size;

  console.log(`    trim → ${trimMeta.width}×${trimMeta.height}   square → ${squareMeta.width}×${squareMeta.height}   final → ${finalMeta.width}×${finalMeta.height}, ${(finalSize/1024).toFixed(1)} KB`);
}

async function main() {
  await ensureDir(OUT_DIR);
  const files = (await fs.readdir(SRC_DIR)).filter(f => /\.(png|jpe?g|webp)$/i.test(f));
  console.log(`Optimizing ${files.length} icons → ${OUT_DIR}\n`);
  for (const f of files) {
    const stem = path.basename(f, path.extname(f)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    await processOne(path.join(SRC_DIR, f), path.join(OUT_DIR, `${stem}.png`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
