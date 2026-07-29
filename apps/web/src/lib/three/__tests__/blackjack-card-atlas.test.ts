import { describe, expect, test } from 'bun:test';
import {
  BLACKJACK_RANKS,
  BLACKJACK_SUITS,
  type BlackjackCard,
} from '@clawville/shared';
import {
  ATLAS_BACK_CELL,
  MAX_CARD_QUADS,
  atlasCellForCard,
} from '../blackjack-table-cards';

describe('blackjack card atlas', () => {
  test('maps all 52 face cards to the Holdem-compatible suit-major atlas cells', () => {
    const seen = new Set<number>();

    for (let suitIndex = 0; suitIndex < BLACKJACK_SUITS.length; suitIndex += 1) {
      for (let rankIndex = 0; rankIndex < BLACKJACK_RANKS.length; rankIndex += 1) {
        const card: BlackjackCard = {
          suit: BLACKJACK_SUITS[suitIndex]!,
          rank: BLACKJACK_RANKS[rankIndex]!,
        };
        const expectedCell = suitIndex * BLACKJACK_RANKS.length + rankIndex;
        const actualCell = atlasCellForCard(card);
        expect(actualCell).toBe(expectedCell);
        seen.add(actualCell);
      }
    }

    expect([...seen].sort((left, right) => left - right))
      .toEqual(Array.from({ length: 52 }, (_, index) => index));
  });

  test('maps every hidden card to the back cell and keeps the blackjack cap at 64', () => {
    for (const suit of BLACKJACK_SUITS) {
      for (const rank of BLACKJACK_RANKS) {
        expect(atlasCellForCard({ suit, rank, hidden: true })).toBe(ATLAS_BACK_CELL);
      }
    }
    expect(ATLAS_BACK_CELL).toBe(52);
    expect(MAX_CARD_QUADS).toBe(64);
  });
});
