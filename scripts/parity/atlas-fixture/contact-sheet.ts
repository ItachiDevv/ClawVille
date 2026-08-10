import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAtlasFile } from './render-atlas';

export const ATLAS_SUITS = Object.freeze([
  'clubs',
  'diamonds',
  'hearts',
  'spades',
] as const);
export const ATLAS_RANKS = Object.freeze([
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
] as const);
export const ATLAS_BACK_CELL = 52;

export function atlasCellForFixtureCard(
  suit: (typeof ATLAS_SUITS)[number],
  rank: (typeof ATLAS_RANKS)[number],
): number {
  return ATLAS_SUITS.indexOf(suit) * ATLAS_RANKS.length
    + ATLAS_RANKS.indexOf(rank);
}

export async function contactSheetPng(): Promise<Buffer> {
  // The canonical atlas is itself an 8x7 sheet. Cells 0..52 are the exact
  // 52 face/back pixels drawn by the landed Canvas implementation; cells
  // 53..55 remain intentionally blank.
  return (await renderAtlasFile(
    'apps/web/src/lib/three/cove-table-cards.tsx',
  )).png;
}

export async function writeContactSheet(
  outputPath = 'scripts/parity/out/atlas/contact-sheet.png',
): Promise<{ path: string; sha256: string; cells: 53 }> {
  const target = resolve(outputPath);
  const png = await contactSheetPng();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, png);
  return {
    path: target,
    sha256: createHash('sha256').update(png).digest('hex'),
    cells: 53,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  const result = await writeContactSheet(output);
  console.log(`ATLAS contact sheet: ${result.cells} cells`);
  console.log(`ATLAS contact sheet sha256: ${result.sha256}`);
  console.log(`ATLAS contact sheet path: ${result.path}`);
}
