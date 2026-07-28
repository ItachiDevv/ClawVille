import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ParityMirror } from '@/components/cove/CardParityMirror';
import {
  clearFeltParity,
  publishFeltParity,
} from '../card-parity-mirror';
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

  test('terminal action player-turn publishes the bust card with dealer masked', () => {
    const bustSettlement: SettledHandResponse = {
      ...SETTLED,
      outcome: {
        ...SETTLED.outcome,
        playerHands: [{
          ...SETTLED.outcome.playerHands[0]!,
          cards: [
            { suit: 'hearts', rank: 'K' },
            { suit: 'spades', rank: '6' },
            { suit: 'clubs', rank: 'Q' },
          ],
          total: 26,
          isSoft: false,
          isBust: true,
          isBlackjack: false,
          outcome: 'loss',
          payout: '0',
        }],
      },
    };
    const playerTurn = buildBlackjack2dParityRevision({
      liveHand: buildNaturalHoleHand(bustSettlement),
      pendingSettlement: bustSettlement,
      displayStep: 'player-turn',
      activeSlot: 0,
      bannerText: buildBlackjack2dBannerText(bustSettlement.outcome),
    })!;

    expect(playerTurn.dealStep).toBe('player-turn');
    const thirdCard = playerTurn.slots.find(
      (slot) => slot.slot === 'player-0-card-3',
    );
    expect(thirdCard?.facing).toBe('up');
    expect(String(thirdCard?.card)).toBe('Qc');
    const dealerUpcard = playerTurn.slots.find(
      (slot) => slot.slot === 'dealer-card-1',
    );
    expect(dealerUpcard?.facing).toBe('up');
    expect(String(dealerUpcard?.card)).toBe('Ac');
    const dealerHole = playerTurn.slots.find(
      (slot) => slot.slot === 'dealer-card-2',
    );
    expect(dealerHole?.facing).toBe('down');
    expect(String(dealerHole?.card)).toBe('');
    expect(playerTurn.meta['player-0-total']).toBe('26');
    expect(playerTurn.meta['dealer-total']).toBeUndefined();
    expect(playerTurn.meta['outcome-0']).toBeUndefined();
    expect(playerTurn.meta['banner-text']).toBeUndefined();
    expect(playerTurn.meta.net).toBeUndefined();
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

  test('mounted mirror exposes the published 2D correlation and settled contract', () => {
    const instanceId = 'blackjack-2d-test-owner';
    publishFeltParity(
      instanceId,
      buildBlackjack2dParityRevision(snapshot('settled'))!,
    );
    const html = renderToStaticMarkup(createElement(ParityMirror, {
      surface: 'blackjack-2d',
      instanceId,
    }));
    expect(html).toContain('data-cv-parity="blackjack-2d"');
    expect(html).toContain('data-cv-correlation-hand="hand-7"');
    expect(html).toContain('data-cv-hand-number="7"');
    expect(html).toContain('data-cv-deal-step="settled"');
    expect(html).toContain('data-banner-text="BLACKJACK!"');
    expect(html).toContain('data-active-slot="0"');
    clearFeltParity(instanceId);
  });

  test('modal schedules each reveal from its committed display step', () => {
    const source = readFileSync(
      new URL(
        '../../../components/cove/blackjack/BlackjackModal.tsx',
        import.meta.url,
      ),
      'utf8',
    );
    expect(source).toContain('return epoch.scheduleCommittedStep(');
    expect(source).not.toContain('window.setTimeout');
    expect(source).not.toContain(
      "setDisplayStep('settled');\n        setLiveHand(null);",
    );
    expect(source).toContain(
      "setDisplayStep(sourceAction === 'split' ? 'split' : 'player-turn')",
    );
  });

  test('browser timer defaults are lexical wrappers, not illegally rebound globals', () => {
    const publisherSource = readFileSync(
      new URL('../blackjack-2d-publisher.ts', import.meta.url),
      'utf8',
    );
    expect(publisherSource).toContain(
      'private readonly setTimer: SetTimer = (callback, delayMs)',
    );
    expect(publisherSource).toContain(
      'private readonly clearTimer: ClearTimer = (handle)',
    );
    expect(publisherSource).not.toContain(
      'private readonly setTimer: SetTimer = setTimeout',
    );
  });

  test('stale-decision resync cannot clear a settlement being staged', () => {
    const source = readFileSync(
      new URL(
        '../../../components/cove/blackjack/BlackjackModal.tsx',
        import.meta.url,
      ),
      'utf8',
    );
    expect(source).toContain(
      '} else if (allowClear && !pendingSettlement) {',
    );
    expect(source).not.toContain('} else if (allowClear) {');
    expect(source).toContain(
      '}, [pendingSettlement, resetHand]);',
    );
  });
});

describe('BlackjackRevealEpoch', () => {
  function fakeEpoch() {
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const cleared: number[] = [];
    const epoch = new BlackjackRevealEpoch(
      ((callback: () => void, delayMs: number) => {
        callbacks.push(callback);
        delays.push(delayMs);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      }),
      ((handle) => cleared.push(handle as unknown as number)),
    );
    return { callbacks, cleared, delays, epoch };
  }

  test('close invalidates the real committed-step callback', () => {
    const { callbacks, epoch } = fakeEpoch();
    const commits: string[] = [];
    epoch.begin('hand-a');
    epoch.scheduleCommittedStep(
      'hand-a',
      'player-turn',
      true,
      (step) => commits.push(step),
    );
    epoch.cancel();
    callbacks[0]!();
    expect(commits).toEqual([]);
  });

  test('Next Hand invalidates the prior settlement callback', () => {
    const { callbacks, epoch } = fakeEpoch();
    const commits: string[] = [];
    epoch.begin('hand-a');
    epoch.scheduleCommittedStep(
      'hand-a',
      'dealer-reveal',
      true,
      (step) => commits.push(step),
    );
    epoch.cancel();
    callbacks[0]!();
    expect(commits).toEqual([]);
  });

  test('a new deal cannot receive the prior hand timer', () => {
    const { callbacks, epoch } = fakeEpoch();
    const commits: string[] = [];
    epoch.begin('hand-a');
    epoch.scheduleCommittedStep(
      'hand-a',
      'hole',
      false,
      (step) => commits.push(`stale-${step}`),
    );
    epoch.begin('hand-b');
    epoch.scheduleCommittedStep(
      'hand-b',
      'hole',
      false,
      (step) => commits.push(`fresh-${step}`),
    );
    callbacks[0]!();
    callbacks[1]!();
    expect(commits).toEqual(['fresh-player-turn']);
  });

  test('a mismatched correlation cannot arm a committed-step timer', () => {
    const { callbacks, epoch } = fakeEpoch();
    epoch.begin('hand-a');
    const cleanup = epoch.scheduleCommittedStep(
      'hand-b',
      'hole',
      false,
      () => {},
    );
    expect(cleanup).toBeUndefined();
    expect(callbacks).toHaveLength(0);
  });

  test('new correlation clears the effect-owned handle before scheduling', () => {
    const { cleared, epoch } = fakeEpoch();
    epoch.begin('hand-a');
    epoch.scheduleCommittedStep('hand-a', 'hole', false, () => {});
    expect(epoch.isCurrent('hand-a')).toBe(true);
    epoch.begin('hand-b');
    expect(cleared).toEqual([1]);
    expect(epoch.isCurrent('hand-a')).toBe(false);
    expect(epoch.isCurrent('hand-b')).toBe(true);
  });

  test('effect cleanup clears only its scheduled committed step', () => {
    const { callbacks, cleared, epoch } = fakeEpoch();
    const commits: string[] = [];
    epoch.begin('hand-a');
    const cleanup = epoch.scheduleCommittedStep(
      'hand-a',
      'hole',
      false,
      (step) => commits.push(step),
    );
    cleanup?.();
    callbacks[0]!();
    expect(cleared).toEqual([1]);
    expect(commits).toEqual([]);
    expect(epoch.isCurrent('hand-a')).toBe(true);
  });

  test('terminal action uses the 120ms masked beat then a 420ms dealer beat', () => {
    const { callbacks, delays, epoch } = fakeEpoch();
    const commits: string[] = [];
    let step: Blackjack2dDisplaySnapshot['displayStep'] = 'player-turn';
    epoch.begin('hand-a');
    const schedule = () => epoch.scheduleCommittedStep(
      'hand-a',
      step,
      true,
      (nextStep) => {
        step = nextStep;
        commits.push(nextStep);
        schedule();
      },
    );
    schedule();
    for (let index = 0; index < callbacks.length; index += 1) {
      callbacks[index]!();
    }
    expect(delays).toEqual([120, 420]);
    expect(commits).toEqual(['dealer-reveal', 'settled']);
  });

  test('fake-timer DOM frames conceal settlement and bankroll until settled', () => {
    const { callbacks, delays, epoch } = fakeEpoch();
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
    const schedule = () => epoch.scheduleCommittedStep(
      'hand-7',
      step,
      true,
      (nextStep) => {
        step = nextStep;
        if (nextStep === 'settled') displayedBalance = SETTLED.balance;
        renderFrame();
        schedule();
      },
    );
    schedule();
    for (let index = 0; index < callbacks.length; index += 1) {
      callbacks[index]!();
    }

    expect(delays).toEqual([420, 550]);
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
