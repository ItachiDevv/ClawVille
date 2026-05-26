import fs from 'node:fs';
import path from 'node:path';

const SVG_DIR = 'apps/web/public/assets/slot-symbols';
const SYMBOLS = [
  { id: 0, file: 's0.svg', label: 's0 · Cherry' },
  { id: 1, file: 's1.svg', label: 's1 · Lemon' },
  { id: 2, file: 's2.svg', label: 's2 · Orange' },
  { id: 3, file: 's3.svg', label: 's3 · Plum' },
  { id: 4, file: 's4.svg', label: 's4 · Bell' },
  { id: 5, file: 's5.svg', label: 's5 · BAR' },
  { id: 6, file: 's6.svg', label: 's6 · Seven' },
  { id: 7, file: 's7.svg', label: 's7 · WILD' },
  { id: 8, file: 's8.svg', label: 's8 · BAR×2' },
  { id: 9, file: 's9.svg', label: 's9 · BAR×3' },
];

const COLS = 5;
const ROWS = 2;
const CELL = 280;
const PAD = 20;
const LABEL_H = 36;
const W = COLS * (CELL + PAD) + PAD;
const H = ROWS * (CELL + PAD + LABEL_H) + PAD;

function extractInner(svgText) {
  // Get viewBox + inner content of the root <svg> element
  const vbMatch = svgText.match(/viewBox=["']([^"']+)["']/);
  const viewBox = vbMatch ? vbMatch[1] : '0 0 256 256';
  const inner = svgText
    .replace(/^<\?xml[^>]*\?>/, '')
    .replace(/<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '');
  return { viewBox, inner };
}

const cells = SYMBOLS.map((sym, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = PAD + col * (CELL + PAD);
  const y = PAD + row * (CELL + PAD + LABEL_H);
  const svgText = fs.readFileSync(path.join(SVG_DIR, sym.file), 'utf8');
  const { viewBox, inner } = extractInner(svgText);
  return `
    <g transform="translate(${x},${y})">
      <rect x="0" y="0" width="${CELL}" height="${CELL}" rx="14" fill="#0a1428" stroke="#2a3a55" stroke-width="2"/>
      <svg x="8" y="8" width="${CELL - 16}" height="${CELL - 16}" viewBox="${viewBox}">
        ${inner}
      </svg>
      <text x="${CELL / 2}" y="${CELL + 24}" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="20" font-weight="700" fill="#e2e8f0" letter-spacing="0.5">${sym.label}</text>
    </g>`;
}).join('\n');

const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#06101f"/>
  <text x="${W / 2}" y="${PAD + 4}" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="0" fill="transparent">ClawVille Slot Symbol Sheet — 2026-05-19 round 3</text>
  ${cells}
</svg>
`;

fs.mkdirSync('.tmp', { recursive: true });
fs.writeFileSync('.tmp/slot-symbol-sheet.svg', sheet);
console.log(`Wrote .tmp/slot-symbol-sheet.svg (${sheet.length} bytes, ${W}×${H})`);
