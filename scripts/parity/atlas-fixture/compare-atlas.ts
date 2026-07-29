import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATLAS_BACK_CELL,
  ATLAS_RANKS,
  ATLAS_SUITS,
  atlasCellForFixtureCard,
  writeContactSheet,
} from './contact-sheet';
import { normalizeAtlasFile } from './normalize-atlas';
import { assertFrozenWindingUv, renderAtlasFile } from './render-atlas';

const SOURCES = Object.freeze({
  holdem: 'apps/web/src/lib/three/cove-table-cards.tsx',
  blackjack: 'apps/web/src/lib/three/blackjack-table-cards.tsx',
  baccarat: 'apps/web/src/lib/three/baccarat-table-cards.tsx',
});

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function compareAtlasCopies(): Promise<{
  pass: boolean;
  hashes: Record<keyof typeof SOURCES, string>;
  imageDataEqual: boolean;
  rgbaHashes: Record<keyof typeof SOURCES, string>;
}> {
  const [normalized, rendered] = await Promise.all([
    Promise.all(
      Object.values(SOURCES).map((path) => normalizeAtlasFile(resolve(path))),
    ),
    Promise.all(
      Object.values(SOURCES).map((path) => renderAtlasFile(resolve(path))),
    ),
  ]);
  const hashes = {
    holdem: sha(normalized[0]!),
    blackjack: sha(normalized[1]!),
    baccarat: sha(normalized[2]!),
  };
  const rgbaHashes = {
    holdem: createHash('sha256').update(rendered[0]!.rgba).digest('hex'),
    blackjack: createHash('sha256').update(rendered[1]!.rgba).digest('hex'),
    baccarat: createHash('sha256').update(rendered[2]!.rgba).digest('hex'),
  };
  const imageDataEqual = rendered[0]!.rgba.equals(rendered[1]!.rgba)
    && rendered[0]!.rgba.equals(rendered[2]!.rgba);
  for (const atlas of rendered) assertFrozenWindingUv(atlas);
  return {
    pass: hashes.holdem === hashes.blackjack
      && hashes.holdem === hashes.baccarat
      && imageDataEqual,
    hashes,
    imageDataEqual,
    rgbaHashes,
  };
}

export function assert53CellMapping(): void {
  const cells = new Set<number>();
  for (const suit of ATLAS_SUITS) {
    for (const rank of ATLAS_RANKS) {
      cells.add(atlasCellForFixtureCard(suit, rank));
    }
  }
  cells.add(ATLAS_BACK_CELL);
  if (cells.size !== 53 || Math.min(...cells) !== 0 || Math.max(...cells) !== 52) {
    throw new Error(`Atlas mapping is not exactly cells 0..52: ${[...cells].join(',')}`);
  }
}

export async function currentApprovalMatches(
  sheetSha: string,
  approvalPath = 'scripts/parity/out/atlas/APPROVED.md',
): Promise<boolean> {
  try {
    const approval = await readFile(resolve(approvalPath), 'utf8');
    return new RegExp(`\\b${sheetSha}\\b`, 'i').test(approval);
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert53CellMapping();
  const comparison = await compareAtlasCopies();
  const sheet = await writeContactSheet();
  const approved = await currentApprovalMatches(sheet.sha256);
  console.log(`ATLAS normalized copies: ${comparison.pass ? 'PASS' : 'FAIL'}`);
  console.log(`ATLAS holdem sha256: ${comparison.hashes.holdem}`);
  console.log(`ATLAS blackjack sha256: ${comparison.hashes.blackjack}`);
  console.log(`ATLAS baccarat sha256: ${comparison.hashes.baccarat}`);
  console.log(`ATLAS rendered ImageData: ${comparison.imageDataEqual ? 'PASS' : 'FAIL'}`);
  console.log(`ATLAS rendered rgba sha256: ${comparison.rgbaHashes.holdem}`);
  console.log('ATLAS winding/UV sequence: PASS');
  console.log('ATLAS mapping: PASS (52 faces + back = 53 unique cells)');
  console.log(`ATLAS approval: ${approved ? 'PASS' : 'UNPROVEN (human APPROVED.md required)'}`);
  if (!comparison.pass || !approved) process.exitCode = 1;
}
