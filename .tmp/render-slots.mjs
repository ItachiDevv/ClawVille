import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = "apps/web/public/assets/slot-symbols";
const names = [
  "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7",
  "s8", "s9", "s10", "wild", "scatter", "bonus",
];

const cell = 196;
const pad = 12;
const cols = 4;
const rows = Math.ceil(names.length / cols);
const W = cols * cell + (cols + 1) * pad;
const H = rows * cell + (rows + 1) * pad + 40;

const bg = await sharp({
  create: { width: W, height: H, channels: 4, background: { r: 18, g: 26, b: 44, alpha: 1 } },
}).png().toBuffer();

const composites = [];
for (let i = 0; i < names.length; i++) {
  const name = names[i];
  const r = Math.floor(i / cols);
  const c = i % cols;
  const x = pad + c * (cell + pad);
  const y = pad + r * (cell + pad);
  try {
    const svg = readFileSync(join(dir, `${name}.svg`));
    const png = await sharp(svg, { density: 300 }).resize(cell, cell).png().toBuffer();
    composites.push({ input: png, left: x, top: y });
    // Label text via SVG
    const labelSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="22">
         <text x="${cell / 2}" y="16" text-anchor="middle"
               font-family="Arial,sans-serif" font-size="14" fill="#ffc857" font-weight="bold">${name}</text>
       </svg>`
    );
    const labelPng = await sharp(labelSvg).png().toBuffer();
    composites.push({ input: labelPng, left: x, top: y + cell - 2 });
  } catch (e) {
    console.error(`Failed ${name}: ${e.message}`);
  }
}

const out = await sharp(bg).composite(composites).png().toBuffer();
writeFileSync(".tmp/svg-redesign-preview.png", out);
console.log(`wrote .tmp/svg-redesign-preview.png ${W}x${H}`);
