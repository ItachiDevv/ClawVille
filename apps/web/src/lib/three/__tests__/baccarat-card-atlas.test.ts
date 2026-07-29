import { describe, expect, test } from 'bun:test';
import type { BaccaratCard, BaccaratRank, BaccaratSuit } from '@clawville/shared';
import {
  atlasCellForCard,
  ATLAS_BACK_CELL,
  BACCARAT_CARD_CORNERS,
  BACCARAT_CARD_INDICES,
  baccaratAtlasUvSequence,
} from '../baccarat-table-cards';

const SUITS: readonly BaccaratSuit[] = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANKS: readonly BaccaratRank[] = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
];

describe('baccarat inline 53-cell atlas', () => {
  test('maps all 52 faces suit-major and keeps the dedicated back cell', () => {
    const cells: number[] = [];
    for (let suitIndex = 0; suitIndex < SUITS.length; suitIndex += 1) {
      for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
        const card: BaccaratCard = {
          suit: SUITS[suitIndex]!,
          rank: RANKS[rankIndex]!,
        };
        const expected = suitIndex * RANKS.length + rankIndex;
        expect(atlasCellForCard(card)).toBe(expected);
        cells.push(expected);
      }
    }
    expect(cells).toEqual(Array.from({ length: 52 }, (_, index) => index));
    expect(atlasCellForCard({
      suit: 'clubs',
      rank: '2',
      hidden: true,
    } as BaccaratCard & { hidden: true })).toBe(ATLAS_BACK_CELL);
    expect(ATLAS_BACK_CELL).toBe(52);
  });

  test('freezes the approved quad winding and corner order', () => {
    expect(BACCARAT_CARD_CORNERS).toEqual([
      [-1, -1],
      [-1, 1],
      [1, 1],
      [1, -1],
    ]);
    expect(BACCARAT_CARD_INDICES).toEqual([0, 1, 2, 0, 2, 3]);
  });

  test('keeps the unmirrored high-to-low U sequence', () => {
    const uv = baccaratAtlasUvSequence(0);
    expect(uv[0]).toBe(uv[2]);
    expect(uv[4]).toBe(uv[6]);
    expect(uv[0]!).toBeGreaterThan(uv[4]!);
    expect(uv[1]).toBe(uv[7]);
    expect(uv[3]).toBe(uv[5]);
  });
});
