import { describe, expect, it } from 'bun:test';
import { chooseBlackjackBasicStrategyAction } from '../blackjack-basic-strategy';
import type { Card, Rank } from '../blackjack-engine';

const card = (rank: Rank): Card => ({ rank, suit: 'hearts' });
const options = { canDouble: true, canSplit: true, canSurrender: true } as const;

describe('blackjack basic strategy — six-deck S17/DAS late surrender', () => {
  it('uses the pair table before hard/soft totals', () => {
    expect(chooseBlackjackBasicStrategyAction([card('A'), card('A')], card('10'), options)).toBe('split');
    expect(chooseBlackjackBasicStrategyAction([card('8'), card('8')], card('10'), options)).toBe('split');
    expect(chooseBlackjackBasicStrategyAction([card('9'), card('9')], card('7'), options)).toBe('stand');
    expect(chooseBlackjackBasicStrategyAction([card('5'), card('5')], card('9'), options)).toBe('double');
  });

  it('uses late surrender only on the textbook hard totals', () => {
    expect(chooseBlackjackBasicStrategyAction([card('10'), card('6')], card('A'), options)).toBe('surrender');
    expect(chooseBlackjackBasicStrategyAction([card('10'), card('5')], card('10'), options)).toBe('surrender');
    expect(chooseBlackjackBasicStrategyAction(
      [card('10'), card('6')],
      card('10'),
      { ...options, canSurrender: false },
    )).toBe('hit');
  });

  it('covers soft doubling and fallback behavior', () => {
    expect(chooseBlackjackBasicStrategyAction([card('A'), card('8')], card('6'), options)).toBe('stand');
    expect(chooseBlackjackBasicStrategyAction([card('A'), card('7')], card('2'), options)).toBe('stand');
    expect(chooseBlackjackBasicStrategyAction([card('A'), card('7')], card('6'), options)).toBe('double');
    expect(chooseBlackjackBasicStrategyAction([card('A'), card('7')], card('9'), options)).toBe('hit');
    expect(chooseBlackjackBasicStrategyAction(
      [card('A'), card('6')],
      card('4'),
      { ...options, canDouble: false },
    )).toBe('hit');
    expect(chooseBlackjackBasicStrategyAction(
      [card('A'), card('7')],
      card('4'),
      { ...options, canDouble: false },
    )).toBe('stand');
  });

  it('falls back to legal non-double and non-split actions', () => {
    const noExtras = { canDouble: false, canSplit: false, canSurrender: false };
    expect(chooseBlackjackBasicStrategyAction([card('A'), card('A')], card('10'), noExtras)).toBe('hit');
    expect(chooseBlackjackBasicStrategyAction([card('A'), card('A')], card('4'), noExtras)).toBe('hit');
    expect(chooseBlackjackBasicStrategyAction([card('A'), card('A')], card('5'), noExtras)).toBe('hit');
    expect(chooseBlackjackBasicStrategyAction([card('A'), card('A')], card('6'), noExtras)).toBe('hit');
    expect(chooseBlackjackBasicStrategyAction([card('8'), card('8')], card('10'), noExtras)).toBe('hit');
    expect(chooseBlackjackBasicStrategyAction([card('5'), card('5')], card('9'), noExtras)).toBe('hit');
    expect(chooseBlackjackBasicStrategyAction([card('6'), card('5')], card('6'), noExtras)).toBe('hit');
    expect(chooseBlackjackBasicStrategyAction([card('A'), card('7')], card('6'), noExtras)).toBe('stand');
  });

  it('handles split-subhand capability flags without attempting a second split or surrender', () => {
    const splitHand = { canDouble: true, canSplit: false, canSurrender: false };
    expect(chooseBlackjackBasicStrategyAction([card('9'), card('9')], card('6'), splitHand)).toBe('stand');
    expect(chooseBlackjackBasicStrategyAction([card('6'), card('5')], card('6'), splitHand)).toBe('double');
    expect(chooseBlackjackBasicStrategyAction([card('10'), card('6')], card('10'), splitHand)).toBe('hit');
  });

  it('covers the hard-total stand, double, and hit boundaries', () => {
    expect(chooseBlackjackBasicStrategyAction([card('10'), card('3')], card('6'), options)).toBe('stand');
    expect(chooseBlackjackBasicStrategyAction([card('7'), card('4')], card('10'), options)).toBe('double');
    expect(chooseBlackjackBasicStrategyAction([card('10'), card('2')], card('3'), options)).toBe('hit');
    expect(chooseBlackjackBasicStrategyAction([card('5'), card('4')], card('4'), options)).toBe('double');
  });
});
