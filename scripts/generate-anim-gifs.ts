import sharp from 'sharp';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';

const FRAME_W = 128;
const FRAME_H = 128;
const SPECIES = 'cat';
const SCALE = 3; // 384x384 output for nice viewing

const ANIMS = [
  { name: 'idle',       row: 0, startCol: 0, frames: 8, delay: 167, label: 'Idle - breathing + blink' },
  { name: 'walk-down',  row: 1, startCol: 0, frames: 8, delay: 100, label: 'Walk Down' },
  { name: 'walk-up',    row: 2, startCol: 0, frames: 8, delay: 100, label: 'Walk Up' },
  { name: 'walk-left',  row: 3, startCol: 0, frames: 8, delay: 100, label: 'Walk Left' },
  { name: 'walk-right', row: 4, startCol: 0, frames: 8, delay: 100, label: 'Walk Right' },
  { name: 'attack',     row: 5, startCol: 0, frames: 8, delay: 71,  label: 'Attack' },
  { name: 'hurt',       row: 6, startCol: 0, frames: 8, delay: 83,  label: 'Hurt' },
  { name: 'death',      row: 7, startCol: 0, frames: 8, delay: 167, label: 'Death' },
  { name: 'block',      row: 8, startCol: 0, frames: 4, delay: 167, label: 'Block' },
  { name: 'dodge',      row: 8, startCol: 4, frames: 4, delay: 83,  label: 'Dodge' },
  { name: 'special',    row: 9, startCol: 0, frames: 8, delay: 83,  label: 'Special' },
];

async function extractFrames(
  sheetPath: string,
  row: number,
  startCol: number,
  numFrames: number,
): Promise<{ data: Uint8Array; width: number; height: number }[]> {
  const outW = FRAME_W * SCALE;
  const outH = FRAME_H * SCALE;
  const frames: { data: Uint8Array; width: number; height: number }[] = [];

  for (let i = 0; i < numFrames; i++) {
    const col = startCol + i;
    const raw = await sharp(sheetPath)
      .extract({ left: col * FRAME_W, top: row * FRAME_H, width: FRAME_W, height: FRAME_H })
      .resize(outW, outH, { kernel: 'nearest' })
      .ensureAlpha()
      .raw()
      .toBuffer();

    const pixels = new Uint8Array(outW * outH * 4);
    for (let p = 0; p < outW * outH; p++) {
      const srcR = raw[p * 4];
      const srcG = raw[p * 4 + 1];
      const srcB = raw[p * 4 + 2];
      const srcA = raw[p * 4 + 3] / 255;
      pixels[p * 4]     = Math.round(srcR * srcA + 255 * (1 - srcA));
      pixels[p * 4 + 1] = Math.round(srcG * srcA + 255 * (1 - srcA));
      pixels[p * 4 + 2] = Math.round(srcB * srcA + 255 * (1 - srcA));
      pixels[p * 4 + 3] = 255;
    }
    frames.push({ data: pixels, width: outW, height: outH });
  }
  return frames;
}

async function main() {
  const sheetPath = path.join(process.cwd(), `apps/web/public/sprites/pets/${SPECIES}-sheet.png`);
  const outDir = path.join(process.cwd(), 'apps/web/public/sprites/pets/gifs/anims');
  mkdirSync(outDir, { recursive: true });

  console.log(`Generating per-animation GIFs (${SPECIES}, ${FRAME_W * SCALE}px)...\n`);

  for (const anim of ANIMS) {
    const frames = await extractFrames(sheetPath, anim.row, anim.startCol, anim.frames);
    const encoder = GIFEncoder();
    for (const frame of frames) {
      const palette = quantize(frame.data, 256);
      const index = applyPalette(frame.data, palette);
      encoder.writeFrame(index, frame.width, frame.height, { palette, delay: anim.delay, repeat: 0 });
    }
    encoder.finish();
    const outPath = path.join(outDir, `${anim.name}.gif`);
    writeFileSync(outPath, encoder.bytes());
    console.log(`  ${anim.name}.gif (${anim.frames} frames, ${Math.round(encoder.bytes().length / 1024)}KB) — ${anim.label}`);
  }

  // Also generate an HTML preview
  const html = `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #111; color: #fff; font-family: 'Segoe UI', sans-serif; padding: 24px; display: flex; flex-wrap: wrap; gap: 24px; justify-content: center; }
  .card { background: #1a1a2e; border: 2px solid #e94560; border-radius: 16px; padding: 16px; text-align: center; }
  .card img { width: 192px; height: 192px; image-rendering: pixelated; }
  .name { color: #e94560; font-size: 20px; font-weight: bold; margin-top: 8px; }
  .desc { color: #888; font-size: 14px; margin-top: 4px; }
</style></head><body>
${ANIMS.map(a => `<div class="card"><img src="${a.name}.gif"><div class="name">${a.name}</div><div class="desc">${a.label}</div></div>`).join('\n')}
</body></html>`;
  writeFileSync(path.join(outDir, 'preview.html'), html);

  console.log(`\nDone! ${ANIMS.length} GIFs saved to apps/web/public/sprites/pets/gifs/anims/`);
}

main().catch(console.error);
