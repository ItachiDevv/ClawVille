import { describe, expect, test } from 'bun:test';
import type { SerializedBaccaratCoup } from '@clawville/shared';
import { buildDealSteps } from '../baccarat-room-controller';

function coup(
  playerCount: 2 | 3,
  bankerCount: 2 | 3,
): SerializedBaccaratCoup {
  const cards = [
    { suit: 'clubs' as const, rank: '2' as const },
    { suit: 'diamonds' as const, rank: '3' as const },
    { suit: 'hearts' as const, rank: '4' as const },
  ];
  return {
    kind: 'baccarat',
    bet: 'player',
    stake: '25',
    player: { cards: cards.slice(0, playerCount), total: 5, isNatural: false },
    banker: { cards: cards.slice(0, bankerCount), total: 6, isNatural: false },
    winner: 'banker',
    payout: '0',
    net: '-25',
    commission: '0',
    cursorBefore: 0,
    cursorAfter: playerCount + bankerCount,
    dealtBefore: 0,
    dealtAfter: playerCount + bankerCount,
    nonce: 0,
    engineVersion: 'bac-v1',
  };
}

describe('buildDealSteps', () => {
  test('natural/two-card coup keeps canonical P,B,P,B order', () => {
    expect(buildDealSteps(coup(2, 2)).map((step) => step.token)).toEqual([
      'player-1',
      'banker-1',
      'player-2',
      'banker-2',
    ]);
  });

  test('player third card precedes the optional banker third card', () => {
    expect(buildDealSteps(coup(3, 2)).map((step) => step.token)).toEqual([
      'player-1',
      'banker-1',
      'player-2',
      'banker-2',
      'player-3',
    ]);
    expect(buildDealSteps(coup(3, 3)).map((step) => step.token)).toEqual([
      'player-1',
      'banker-1',
      'player-2',
      'banker-2',
      'player-3',
      'banker-3',
    ]);
    expect(buildDealSteps(coup(2, 3)).map((step) => step.token)).toEqual([
      'player-1',
      'banker-1',
      'player-2',
      'banker-2',
      'banker-3',
    ]);
  });

  test('a tie uses the same wire-card-driven order without winner math', () => {
    const tie = { ...coup(2, 2), winner: 'tie' as const, net: '0', payout: '25' };
    expect(buildDealSteps(tie).map((step) => step.token)).toEqual([
      'player-1',
      'banker-1',
      'player-2',
      'banker-2',
    ]);
  });

  test('the final step set names every wire card exactly once', () => {
    const wire = coup(3, 3);
    const steps = buildDealSteps(wire);
    expect(new Set(steps.map((step) => `${step.side}:${step.handCardIndex}`))).toEqual(
      new Set([
        'player:0',
        'banker:0',
        'player:1',
        'banker:1',
        'player:2',
        'banker:2',
      ]),
    );
  });
});
