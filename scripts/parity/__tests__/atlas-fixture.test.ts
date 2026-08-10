import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';
import {
  assert53CellMapping,
  compareAtlasCopies,
} from '../atlas-fixture/compare-atlas';
import { contactSheetPng } from '../atlas-fixture/contact-sheet';
import { normalizeAtlas } from '../atlas-fixture/normalize-atlas';

describe('shared atlas fixture', () => {
  test('all three landed source copies normalize identically', async () => {
    const comparison = await compareAtlasCopies();
    expect(comparison.pass).toBe(true);
    expect(new Set(Object.values(comparison.hashes)).size).toBe(1);
    expect(comparison.imageDataEqual).toBe(true);
    expect(new Set(Object.values(comparison.rgbaHashes)).size).toBe(1);
  });

  test('normalizer ignores only comments/whitespace/capacity guard deltas', async () => {
    const source = await readFile(
      'apps/web/src/lib/three/cove-table-cards.tsx',
      'utf8',
    );
    const changed = source
      .replace('const MAX_CARD_QUADS = 17;', 'const MAX_CARD_QUADS = 999;')
      .replace('const ATLAS_CELL_WIDTH = 192;', '// comment\nconst  ATLAS_CELL_WIDTH = 192;');
    expect(normalizeAtlas(changed)).toBe(normalizeAtlas(source));
  });

  test('mapping is exactly 52 faces plus back and PNG bytes are deterministic', async () => {
    expect(assert53CellMapping).not.toThrow();
    const first = await contactSheetPng();
    const second = await contactSheetPng();
    expect(first.equals(second)).toBe(true);
    expect(first.subarray(1, 4).toString()).toBe('PNG');
  });
});
