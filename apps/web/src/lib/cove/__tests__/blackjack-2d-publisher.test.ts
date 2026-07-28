import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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

  test('all frozen single-hand labels are canonical', () => {
    expect([
      'blackjack',
      'win',
      'push',
      'surrender',
      'loss',
    ].map((outcome) => buildBlackjack2dBannerText({
      ...SETTLED.outcome,
      playerHands: [{
        ...SETTLED.outcome.playerHands[0]!,
        outcome: outcome as 'blackjack' | 'win' | 'push' | 'surrender' | 'loss',
      }],
    }))).toEqual([
      'BLACKJACK!',
      'YOU WIN',
      'PUSH',
      'SURRENDER',
      'YOU LOSE',
    ]);
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

  test('new correlation cancels every outstanding handle before scheduling', () => {
    const cleared: number[] = [];
    let nextHandle = 0;
    const epoch = new BlackjackRevealEpoch(
      (() => {
        nextHandle += 1;
        return nextHandle as unknown as ReturnType<typeof setTimeout>;
      }),
      ((handle) => {
        cleared.push(handle as unknown as number);
      }),
    );
    epoch.begin('hand-a');
    epoch.schedule(100, () => {});
    epoch.schedule(200, () => {});
    expect(epoch.isCurrent('hand-a')).toBe(true);
    epoch.begin('hand-b');
    expect(cleared).toEqual([1, 2]);
    expect(epoch.isCurrent('hand-a')).toBe(false);
    expect(epoch.isCurrent('hand-b')).toBe(true);
  });

  test('fake-timer DOM frames conceal settlement and bankroll until settled', () => {
    const callbacks: Array<() => void> = [];
    const epoch = new BlackjackRevealEpoch(
      ((callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      }),
      () => {},
    );
    let step: Blackjack2dDisplaySnapshot['displayStep'] = 'hole';
    let displayedBalance = 100;
    const frames: string[] = [];
    const renderFrame = () => {
      const payload = buildBlackjack2dParityRevision(snapshot(step))!;
      frames.push(renderToStaticMarkup(createElement('div', {
        'data-step': payload.dealStep,
        'data-balance': String(displayedBalance),
        'data-dealer-total': payload.meta['dealer-total'] ?? '',
        'data-outcome': payload.meta['outcome-0'] ?? '',
        'data-banner': payload.meta['banner-text'] ?? '',
        'data-net': payload.meta.net ?? '',
      })));
    };

    epoch.begin('hand-7');
    renderFrame();
    epoch.schedule(420, () => {
      step = 'dealer-reveal';
      renderFrame();
    });
    epoch.schedule(970, () => {
      step = 'settled';
      displayedBalance = SETTLED.balance;
      renderFrame();
    });
    callbacks[0]!();
    callbacks[1]!();

    expect(frames).toHaveLength(3);
    expect(frames[0]).toContain('data-balance="100"');
    expect(frames[0]).not.toContain('136');
    expect(frames[0]).not.toContain('BLACKJACK!');
    expect(frames[0]).toContain('data-dealer-total=""');
    expect(frames[1]).toContain('data-balance="100"');
    expect(frames[1]).toContain('data-dealer-total="20"');
    expect(frames[1]).toContain('data-outcome=""');
    expect(frames[1]).toContain('data-banner=""');
    expect(frames[1]).toContain('data-net=""');
    expect(frames[2]).toContain('data-balance="136"');
    expect(frames[2]).toContain('data-outcome="blackjack"');
    expect(frames[2]).toContain('data-banner="BLACKJACK!"');
    expect(frames[2]).toContain('data-net="36"');
  });
});
