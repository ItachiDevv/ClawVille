import sharp from 'sharp';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';

const SPECIES = ['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle'] as const;
const FRAME_W = 128;
const FRAME_H = 128;
const COLS = 8;

// Animation rows and their names
const ANIM_ROWS: Record<string, { row: number; frames: number; label: string }> = {
  idle:       { row: 0, frames: 8, label: 'Idle' },
  walkDown:   { row: 1, frames: 8, label: 'Walk Down' },
  walkUp:     { row: 2, frames: 8, label: 'Walk Up' },
  walkLeft:   { row: 3, frames: 8, label: 'Walk Left' },
  walkRight:  { row: 4, frames: 8, label: 'Walk Right' },
  attack:     { row: 5, frames: 8, label: 'Attack' },
  hurt:       { row: 6, frames: 8, label: 'Hurt' },
  death:      { row: 7, frames: 8, label: 'Death' },
  block:      { row: 8, frames: 4, label: 'Block' },
  dodge:      { row: 8, frames: 4, label: 'Dodge' },
  special:    { row: 9, frames: 8, label: 'Special' },
};

// GIFs to generate per species
const GIFS_TO_MAKE = [
  { name: 'idle',    anims: ['idle'],    delay: 167 },       // 6 fps
  { name: 'walk',    anims: ['walkDown', 'walkLeft', 'walkUp', 'walkRight'], delay: 100 }, // 10 fps
  { name: 'combat',  anims: ['attack', 'hurt', 'block', 'special'], delay: 83 },  // 12 fps
  { name: 'all',     anims: ['idle', 'walkDown', 'attack', 'hurt', 'death', 'special'], delay: 100 },
];

async function extractFrames(
  sheetPath: string,
  row: number,
  startCol: number,
  numFrames: number,
  scale: number = 2
): Promise<{ data: Uint8Array; width: number; height: number }[]> {
  const frames: { data: Uint8Array; width: number; height: number }[] = [];
  const outW = FRAME_W * scale;
  const outH = FRAME_H * scale;

  for (let i = 0; i < numFrames; i++) {
    const col = startCol + i;
    const raw = await sharp(sheetPath)
      .extract({ left: col * FRAME_W, top: row * FRAME_H, width: FRAME_W, height: FRAME_H })
      .resize(outW, outH, { kernel: 'nearest' })  // crisp pixel art upscale
      .ensureAlpha()
      .raw()
      .toBuffer();

    // Composite onto white background (GIF doesn't support alpha well)
    const pixels = new Uint8Array(outW * outH * 4);
    for (let p = 0; p < outW * outH; p++) {
      const srcR = raw[p * 4];
      const srcG = raw[p * 4 + 1];
      const srcB = raw[p * 4 + 2];
      const srcA = raw[p * 4 + 3] / 255;
      // Blend onto white
      pixels[p * 4]     = Math.round(srcR * srcA + 255 * (1 - srcA));
      pixels[p * 4 + 1] = Math.round(srcG * srcA + 255 * (1 - srcA));
      pixels[p * 4 + 2] = Math.round(srcB * srcA + 255 * (1 - srcA));
      pixels[p * 4 + 3] = 255;
    }

    frames.push({ data: pixels, width: outW, height: outH });
  }
  return frames;
}

function encodeGif(
  frames: { data: Uint8Array; width: number; height: number }[],
  delay: number
): Uint8Array {
  const encoder = GIFEncoder();

  for (const frame of frames) {
    const palette = quantize(frame.data, 256);
    const index = applyPalette(frame.data, palette);
    encoder.writeFrame(index, frame.width, frame.height, {
      palette,
      delay,
      repeat: 0,  // loop forever
    });
  }

  encoder.finish();
  return encoder.bytes();
}

async function main() {
  const spriteDir = path.join(process.cwd(), 'apps/web/public/sprites/pets');
  const outDir = path.join(process.cwd(), 'apps/web/public/sprites/pets/gifs');
  mkdirSync(outDir, { recursive: true });

  console.log('Generating sprite animation GIFs...\n');

  for (const species of SPECIES) {
    const sheetPath = path.join(spriteDir, `${species}-sheet.png`);
    console.log(`  ${species}:`);

    for (const gifDef of GIFS_TO_MAKE) {
      const allFrames: { data: Uint8Array; width: number; height: number }[] = [];

      for (const animName of gifDef.anims) {
        const anim = ANIM_ROWS[animName];
        const startCol = animName === 'dodge' ? 4 : 0;  // dodge starts at col 4 of row 8
        const frames = await extractFrames(sheetPath, anim.row, startCol, anim.frames, 2);
        allFrames.push(...frames);
      }

      const gifBytes = encodeGif(allFrames, gifDef.delay);
      const outPath = path.join(outDir, `${species}-${gifDef.name}.gif`);
      writeFileSync(outPath, gifBytes);
      console.log(`    ${gifDef.name}.gif (${allFrames.length} frames, ${Math.round(gifBytes.length / 1024)}KB)`);
    }
  }

  console.log('\nDone! GIFs saved to apps/web/public/sprites/pets/gifs/');
}

main().catch(console.error);
