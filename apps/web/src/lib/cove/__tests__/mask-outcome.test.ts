import { describe, expect, test } from 'bun:test';
import type { SerializedBaccaratCoup } from '@clawville/shared';
import { buildDealSteps, maskOutcomeToStep } from '../baccarat-room-controller';

const COUP: SerializedBaccaratCoup = {
  kind: 'baccarat',
  bet: 'banker',
  stake: '25',
  player: {
    cards: [
      { suit: 'clubs', rank: '2' },
      { suit: 'hearts', rank: 'A' },
      { suit: 'spades', rank: '9' },
    ],
    total: 2,
    isNatural: false,
  },
  banker: {
    cards: [
      { suit: 'diamonds', rank: 'K' },
      { suit: 'clubs', rank: '7' },
      { suit: 'hearts', rank: '4' },
    ],
    total: 1,
    isNatural: false,
  },
  winner: 'player',
  payout: '0',
  net: '-25',
  commission: '0',
  cursorBefore: 0,
  cursorAfter: 6,
  dealtBefore: 0,
  dealtAfter: 6,
  nonce: 0,
  engineVersion: 'bac-v1',
};

describe('maskOutcomeToStep', () => {
  test('implements the reveal truth table from zero through both third cards', () => {
    const observed = Array.from({ length: 7 }, (_, revealedStep) => {
      const masked = maskOutcomeToStep(COUP, revealedStep);
      return [
        masked.player.cards.map((card) => `${card.rank}${card.suit[0]}`),
        masked.banker.cards.map((card) => `${card.rank}${card.suit[0]}`),
      ];
    });
    expect(observed).toEqual([
      [[], []],
      [['2c'], []],
      [['2c'], ['Kd']],
      [['2c', 'Ah'], ['Kd']],
      [['2c', 'Ah'], ['Kd', '7c']],
      [['2c', 'Ah', '9s'], ['Kd', '7c']],
      [['2c', 'Ah', '9s'], ['Kd', '7c', '4h']],
    ]);
  });

  test('full reveal is value-equal to the authoritative wire coup', () => {
    expect(maskOutcomeToStep(COUP, buildDealSteps(COUP).length)).toEqual(COUP);
  });

  test('negative and oversized step values clamp safely', () => {
    expect(maskOutcomeToStep(COUP, -4).player.cards).toEqual([]);
    expect(maskOutcomeToStep(COUP, 99)).toEqual(COUP);
  });
});
