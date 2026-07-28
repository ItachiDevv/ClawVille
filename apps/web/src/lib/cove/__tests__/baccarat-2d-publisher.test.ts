import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import type {
  BaccaratCoupResponse,
  SerializedBaccaratCoup,
} from '@clawville/shared';
import { ParityMirror } from '@/components/cove/CardParityMirror';
import {
  clearFeltParity,
  publishFeltParity,
} from '../card-parity-mirror';
import {
  Baccarat2dRevealEpoch,
  buildBaccarat2dBannerText,
  buildBaccarat2dDealSteps,
  buildBaccarat2dParityRevision,
  maskBaccarat2dOutcome,
  type Baccarat2dDisplaySnapshot,
} from '../baccarat-2d-publisher';

const OUTCOME: SerializedBaccaratCoup = {
  kind: 'baccarat',
  bet: 'banker',
  stake: '25',
  player: {
    cards: [
      { suit: 'clubs', rank: '2' },
      { suit: 'diamonds', rank: '3' },
      { suit: 'hearts', rank: '4' },
    ],
    total: 9,
    isNatural: false,
  },
  banker: {
    cards: [
      { suit: 'spades', rank: '5' },
      { suit: 'hearts', rank: '2' },
      { suit: 'clubs', rank: 'A' },
    ],
    total: 8,
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
  nonce: 4,
  engineVersion: 'bac-v1',
};

const RESPONSE: BaccaratCoupResponse = {
  coupId: 'coup-4',
  shoeId: 'shoe-2',
  coupIndex: 4,
  status: 'settled',
  outcome: OUTCOME,
  balance: 75,
  totalBet: '25',
  totalPayout: '0',
  net: '-25',
  dealtCount: 6,
  reshuffleSuggested: false,
  idempotencyReplay: false,
};

function snapshot(
  phase: Baccarat2dDisplaySnapshot['phase'],
  revealedStep: number,
): Baccarat2dDisplaySnapshot {
  return {
    pendingSettlement: RESPONSE,
    revealedStep,
    phase,
    selectedBet: 'banker',
    selectedStake: 25,
    bannerText: phase === 'settled'
      ? buildBaccarat2dBannerText(OUTCOME)
      : null,
  };
}

describe('baccarat 2D publisher', () => {
  test('reveals the wire-derived P/B/P/B/P3/B3 sequence one real card at a time', () => {
    const steps = buildBaccarat2dDealSteps(OUTCOME);
    expect(steps.map((step) => step.token)).toEqual([
      'player-1',
      'banker-1',
      'player-2',
      'banker-2',
      'player-3',
      'banker-3',
    ]);
    const revisions = steps.map((_, index) =>
      buildBaccarat2dParityRevision(snapshot('revealing', index + 1))!);
    expect(revisions.map((revision) => revision.dealStep)).toEqual(
      steps.map((step) => step.token),
    );
    expect(revisions[0]!.slots.filter((slot) => slot.facing === 'up')).toHaveLength(1);
    expect(revisions[5]!.slots.filter((slot) => slot.facing === 'up')).toHaveLength(6);
    expect(revisions.every((revision) =>
      revision.meta.winner === undefined
      && revision.meta.net === undefined
      && revision.meta['banner-text'] === undefined
      && revision.meta['player-total'] === undefined
    )).toBe(true);
  });

  test('partial visible totals are derived only from already-painted cards', () => {
    const first = maskBaccarat2dOutcome(OUTCOME, 1, false);
    const fourth = maskBaccarat2dOutcome(OUTCOME, 4, false);
    const final = maskBaccarat2dOutcome(OUTCOME, 6, true);
    expect(first.player).toMatchObject({ total: 2, isNatural: false });
    expect(first.banker).toMatchObject({ cards: [], total: 0, isNatural: false });
    expect(fourth.player).toMatchObject({ total: 5, isNatural: false });
    expect(fourth.banker).toMatchObject({ total: 7, isNatural: false });
    expect(final).toEqual(OUTCOME);
  });

  test('third-card slots exist only when the response contains them', () => {
    const natural = {
      ...OUTCOME,
      player: { ...OUTCOME.player, cards: OUTCOME.player.cards.slice(0, 2) },
      banker: { ...OUTCOME.banker, cards: OUTCOME.banker.cards.slice(0, 2) },
    };
    expect(buildBaccarat2dDealSteps(natural).map((step) => step.token)).toEqual([
      'player-1',
      'banker-1',
      'player-2',
      'banker-2',
    ]);
  });

  test('all nine frozen banner strings are canonical', () => {
    const winners = ['player', 'banker', 'tie'] as const;
    const nets = [10, 0, -10] as const;
    expect(winners.flatMap((winner) => nets.map((net) =>
      buildBaccarat2dBannerText({
        ...OUTCOME,
        winner,
        net: String(net),
      })))).toEqual([
      'PLAYER WINS · YOU WIN',
      'PLAYER WINS · PUSH',
      'PLAYER WINS · YOU LOSE',
      'BANKER WINS · YOU WIN',
      'BANKER WINS · PUSH',
      'BANKER WINS · YOU LOSE',
      'TIE · YOU WIN',
      'TIE · PUSH',
      'TIE · YOU LOSE',
    ]);
  });

  test('the visible banner uses the canonical bytes and keeps PUSH explanation separate', () => {
    const modalSource = readFileSync(
      new URL(
        '../../../components/cove/baccarat/BaccaratModal.tsx',
        import.meta.url,
      ),
      'utf8',
    );
    expect(modalSource).toContain('data-banner-text={bannerText}');
    expect(modalSource).toContain('{bannerText}');
    expect(modalSource).toContain('Stake returned');
    expect(modalSource).not.toContain('PUSH (stake returned)');
  });

  test('settled revision publishes correlation, result, net, and selected zone', () => {
    const settled = buildBaccarat2dParityRevision(snapshot('settled', 6))!;
    expect(settled).toMatchObject({
      dealStep: 'settled',
      phase: 'settled',
      transition: 'idle',
      correlation: { hand: 'coup-4', handNumber: 4, shoe: 'shoe-2' },
    });
    expect(settled.meta).toMatchObject({
      winner: 'player',
      net: '-25',
      'banner-text': 'PLAYER WINS · YOU LOSE',
      'betzone-selected': 'banker',
    });
  });

  test('mounted mirror exposes the baccarat 2D settled contract', () => {
    const instanceId = 'baccarat-2d-test-owner';
    publishFeltParity(
      instanceId,
      buildBaccarat2dParityRevision(snapshot('settled', 6))!,
    );
    const html = renderToStaticMarkup(createElement(ParityMirror, {
      surface: 'baccarat-2d',
      instanceId,
    }));
    expect(html).toContain('data-cv-parity="baccarat-2d"');
    expect(html).toContain('data-cv-correlation-hand="coup-4"');
    expect(html).toContain('data-cv-hand-number="4"');
    expect(html).toContain('data-cv-deal-step="settled"');
    expect(html).toContain('data-banner-text="PLAYER WINS · YOU LOSE"');
    clearFeltParity(instanceId);
  });
});

describe('Baccarat2dRevealEpoch', () => {
  function fakeEpoch() {
    const callbacks: Array<() => void> = [];
    const epoch = new Baccarat2dRevealEpoch(
      ((callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      }),
      () => {},
    );
    return { callbacks, epoch };
  }

  test('close invalidates every outstanding staged reveal', () => {
    const { callbacks, epoch } = fakeEpoch();
    const commits: string[] = [];
    epoch.begin('coup-4');
    epoch.scheduleCoup(
      RESPONSE,
      (step) => commits.push(`step-${step}`),
      () => commits.push('settled'),
    );
    epoch.cancel();
    callbacks.forEach((callback) => callback());
    expect(commits).toEqual([]);
  });

  test('Next Coup prevents the prior coup from publishing into a new correlation', () => {
    const { callbacks, epoch } = fakeEpoch();
    const commits: string[] = [];
    epoch.begin('coup-4');
    epoch.scheduleCoup(
      RESPONSE,
      (step) => commits.push(`stale-${step}`),
      () => commits.push('stale-settled'),
    );
    epoch.begin('coup-5');
    const freshStart = callbacks.length;
    epoch.scheduleCoup(
      { ...RESPONSE, coupId: 'coup-5', coupIndex: 5 },
      (step) => commits.push(`fresh-${step}`),
      () => commits.push('fresh-settled'),
    );
    callbacks.forEach((callback, index) => {
      if (index >= freshStart) callback();
      else callback();
    });
    expect(commits.every((commit) => commit.startsWith('fresh-'))).toBe(true);
    expect(commits.at(-1)).toBe('fresh-settled');
  });

  test('fake-timer frames conceal banner, result, and balance until settled', () => {
    const { callbacks, epoch } = fakeEpoch();
    let phase: Baccarat2dDisplaySnapshot['phase'] = 'revealing';
    let step = 1;
    let balance = 100;
    const frames: Array<{
      balance: number;
      payload: NonNullable<ReturnType<typeof buildBaccarat2dParityRevision>>;
    }> = [];
    const render = () => {
      frames.push({
        balance,
        payload: buildBaccarat2dParityRevision(snapshot(phase, step))!,
      });
    };
    epoch.begin('coup-4');
    render();
    epoch.scheduleCoup(
      RESPONSE,
      (nextStep) => {
        step = nextStep;
        render();
      },
      () => {
        phase = 'settled';
        balance = RESPONSE.balance;
        render();
      },
    );
    callbacks.forEach((callback) => callback());

    expect(frames).toHaveLength(7);
    for (const frame of frames.slice(0, -1)) {
      expect(frame.balance).toBe(100);
      expect(frame.payload.meta.winner).toBeUndefined();
      expect(frame.payload.meta.net).toBeUndefined();
      expect(frame.payload.meta['banner-text']).toBeUndefined();
    }
    const terminalCardFrame = frames.at(-2)!;
    expect(
      terminalCardFrame.payload.slots.filter((slot) => slot.facing === 'up'),
    ).toHaveLength(6);
    expect(terminalCardFrame.balance).toBe(100);
    expect(frames.at(-1)?.balance).toBe(75);
    expect(frames.at(-1)?.payload.meta).toMatchObject({
      winner: 'player',
      net: '-25',
      'banner-text': 'PLAYER WINS · YOU LOSE',
    });
  });
});
