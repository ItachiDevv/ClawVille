import { describe, expect, test } from 'bun:test';
import type { SettledHandResponse } from '../blackjack-api-client';
import {
  BlackjackRevealEpoch,
  buildBlackjack2dBannerText,
  buildBlackjack2dParityRevision,
  buildNaturalHoleHand,
  mergeBlackjack2dActionHand,
  type Blackjack2dDisplaySnapshot,
} from '../blackjack-2d-publisher';

const SETTLED: SettledHandResponse = {
  handId: 'hand-7',
  shoeId: 'shoe-3',
  handIndex: 7,
  status: 'settled',
  outcome: {
    kind: 'blackjack',
    playerHands: [{
      cards: [
        { suit: 'hearts', rank: 'A' },
        { suit: 'spades', rank: 'K' },
      ],
      total: 21,
      isSoft: true,
      isBust: false,
      isBlackjack: true,
      isDoubled: false,
      bet: '25',
      outcome: 'blackjack',
      payout: '62',
    }],
    dealer: {
      cards: [
        { suit: 'clubs', rank: 'A' },
        { suit: 'diamonds', rank: '9' },
      ],
      total: 20,
      isSoft: true,
      isBust: false,
      isBlackjack: false,
    },
    insurance: null,
    totalBet: '25',
    totalPayout: '62',
    net: '37',
    rake: '1',
    rakedPayout: '61',
    rakedNet: '36',
    cursorBefore: 0,
    cursorAfter: 4,
    dealtBefore: 0,
    dealtAfter: 4,
    nonce: 7,
    engineVersion: 'test',
  },
  balance: 136,
  totalBet: '25',
  totalPayout: '61',
  net: '36',
  dealtCount: 4,
  reshuffleSuggested: false,
  idempotencyReplay: false,
  dealtImmediately: true,
};

function snapshot(
  step: Blackjack2dDisplaySnapshot['displayStep'],
): Blackjack2dDisplaySnapshot {
  return {
    liveHand: buildNaturalHoleHand(SETTLED),
    pendingSettlement: SETTLED,
    displayStep: step,
    activeSlot: 1,
    bannerText: buildBlackjack2dBannerText(SETTLED.outcome),
  };
}

describe('blackjack 2D publisher', () => {
  test('natural staging publishes only states the display is entitled to paint', () => {
    const hole = buildBlackjack2dParityRevision(snapshot('hole'))!;
    const reveal = buildBlackjack2dParityRevision(snapshot('dealer-reveal'))!;
    const settled = buildBlackjack2dParityRevision(snapshot('settled'))!;

    expect([hole.dealStep, reveal.dealStep, settled.dealStep]).toEqual([
      'hole',
      'dealer-reveal',
      'settled',
    ]);
    expect(hole.slots.find((slot) => slot.slot === 'dealer-card-1')?.facing).toBe('up');
    expect(hole.slots.find((slot) => slot.slot === 'dealer-card-2')?.facing).toBe('down');
    expect(hole.meta['dealer-total']).toBeUndefined();
    expect(hole.meta['outcome-0']).toBeUndefined();
    expect(hole.meta['banner-text']).toBeUndefined();
    expect(hole.meta.net).toBeUndefined();

    expect(reveal.slots.find((slot) => slot.slot === 'dealer-card-2')?.facing).toBe('up');
    expect(reveal.meta['dealer-total']).toBe('20');
    expect(reveal.meta['outcome-0']).toBeUndefined();
    expect(reveal.meta['banner-text']).toBeUndefined();
    expect(reveal.meta.net).toBeUndefined();

    expect(settled.meta['outcome-0']).toBe('blackjack');
    expect(settled.meta['banner-text']).toBe('BLACKJACK!');
    expect(settled.meta.net).toBe('36');
    expect(settled.meta['active-slot']).toBe('0');
  });

  test('correlation carries hand index and shoe through every staged revision', () => {
    for (const step of ['hole', 'dealer-reveal', 'settled'] as const) {
      expect(buildBlackjack2dParityRevision(snapshot(step))?.correlation).toEqual({
        hand: 'hand-7',
        handNumber: 7,
        shoe: 'shoe-3',
      });
    }
  });

  test('partial action merges retain deal-time handIndex correlation', () => {
    const merged = mergeBlackjack2dActionHand(buildNaturalHoleHand(SETTLED), {
      handId: 'hand-7',
      status: 'in_progress',
      playerHands: [{
        cards: [
          { suit: 'hearts', rank: 'A' },
          { suit: 'spades', rank: 'K' },
          { suit: 'clubs', rank: '2' },
        ],
        total: 13,
        isSoft: false,
        isBust: false,
        isResolved: false,
      }],
      dealerUpcard: { suit: 'clubs', rank: 'A' },
      didSplit: false,
    });
    expect(merged.handIndex).toBe(7);
    expect(merged.shoeId).toBe('shoe-3');
    expect(merged.playerHands[0]?.cards).toHaveLength(3);
    expect(merged.insuranceOffered).toBe(false);
  });

  test('mixed split banner uses the frozen full-hand string', () => {
    const split = {
      ...SETTLED.outcome,
      playerHands: [
        SETTLED.outcome.playerHands[0]!,
        {
          ...SETTLED.outcome.playerHands[0]!,
          outcome: 'loss' as const,
          isBlackjack: false,
        },
      ],
    };
    expect(buildBlackjack2dBannerText(split)).toBe(
      'Hand 1: BLACKJACK! · Hand 2: YOU LOSE',
    );
  });
});

describe('BlackjackRevealEpoch', () => {
  test('close invalidates callbacks even if the host scheduler still fires them', () => {
    const callbacks: Array<() => void> = [];
    const epoch = new BlackjackRevealEpoch(
      ((callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      }),
      () => {},
    );
    const commits: string[] = [];
    epoch.begin('hand-a');
    epoch.schedule(10, () => commits.push('dealer-reveal'));
    epoch.cancel();
    callbacks[0]!();
    expect(commits).toEqual([]);
  });

  test('a consecutive hand cannot receive the prior hand timer', () => {
    const callbacks: Array<() => void> = [];
    const epoch = new BlackjackRevealEpoch(
      ((callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      }),
      () => {},
    );
    const commits: string[] = [];
    epoch.begin('hand-a');
    epoch.schedule(10, () => commits.push('stale-a'));
    epoch.begin('hand-b');
    epoch.schedule(10, () => commits.push('fresh-b'));
    callbacks[0]!();
    callbacks[1]!();
    expect(commits).toEqual(['fresh-b']);
  });
});
