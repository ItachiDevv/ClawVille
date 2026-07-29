import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  BaccaratCoupResponse,
  SerializedBaccaratCoup,
} from '@clawville/shared';
import {
  advanceBaccaratReveal,
  BACCARAT_FINAL_REVEAL_STAGE_MS,
  buildBaccaratRoomParityRevision,
  buildDealSteps,
  getBaccaratVisibleCoup,
  mountBaccaratRuntime,
  type BaccaratRuntimeToken,
  unmountBaccaratRuntime,
  useBaccaratRoomController,
} from '../../../apps/web/src/lib/cove/baccarat-room-controller';

let runtimeToken: BaccaratRuntimeToken | null = null;
let originalWindow: PropertyDescriptor | undefined;

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      clearTimeout,
      setTimeout,
      location: { assign: () => {} },
    },
  });
  runtimeToken = mountBaccaratRuntime(`parity-stage-${crypto.randomUUID()}`);
});

afterEach(() => {
  if (runtimeToken?.valid) unmountBaccaratRuntime(runtimeToken);
  runtimeToken = null;
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
  originalWindow = undefined;
});

function outcome(
  bankerCards: SerializedBaccaratCoup['banker']['cards'],
): SerializedBaccaratCoup {
  return {
    kind: 'baccarat',
    bet: 'player',
    stake: '25',
    player: {
      cards: [
        { suit: 'clubs', rank: '2' },
        { suit: 'diamonds', rank: '3' },
      ],
      total: 5,
      isNatural: false,
    },
    banker: {
      cards: bankerCards,
      total: bankerCards.length === 3 ? 9 : 6,
      isNatural: false,
    },
    winner: 'banker',
    payout: '0',
    net: '-25',
    commission: '0',
    cursorBefore: 0,
    cursorAfter: 2 + bankerCards.length,
    dealtBefore: 0,
    dealtAfter: 2 + bankerCards.length,
    nonce: 0,
    engineVersion: 'bac-v1',
  };
}

function response(coup: SerializedBaccaratCoup): BaccaratCoupResponse {
  return {
    coupId: 'coup-staged-shoe',
    shoeId: 'staged-shoe',
    coupIndex: 0,
    status: 'settled',
    outcome: coup,
    balance: 75,
    totalBet: '25',
    totalPayout: '0',
    net: '-25',
    dealtCount: coup.dealtAfter,
    reshuffleSuggested: false,
    idempotencyReplay: false,
  };
}

async function expectStagedFinalReveal(
  coup: SerializedBaccaratCoup,
  expectedFinalToken: string,
): Promise<void> {
  const token = runtimeToken;
  if (!token) throw new Error('runtime not mounted');
  const steps = buildDealSteps(coup);
  const epoch = useBaccaratRoomController.getState().opEpoch;
  useBaccaratRoomController.setState({
    phase: 'revealing',
    opEpoch: epoch,
    settled: response(coup),
    dealSteps: steps,
    revealedStep: 0,
    correlation: { hand: 'coup-staged-shoe' },
    bannerText: 'BANKER WINS · YOU LOSE',
    betzoneSelected: 'player',
    pending: {
      shoeId: 'staged-shoe',
      bet: 'player',
      stake: 25,
      idempotencyKey: 'staged-key',
    },
    inFlight: false,
  });

  const revisions: Array<[string, string]> = [];
  const unsubscribe = useBaccaratRoomController.subscribe((state) => {
    const tokenAtRevision = state.phase === 'settled'
      ? 'settled'
      : state.dealSteps[
        Math.max(0, Math.min(state.revealedStep, state.dealSteps.length) - 1)
      ]?.token ?? 'deal';
    revisions.push([tokenAtRevision, state.phase]);
  });
  try {
    for (let step = 1; step < steps.length; step += 1) {
      advanceBaccaratReveal(epoch, token);
    }
    advanceBaccaratReveal(epoch, token);

    const staged = useBaccaratRoomController.getState();
    expect(staged).toMatchObject({
      phase: 'revealing',
      revealedStep: steps.length,
      pending: { idempotencyKey: 'staged-key' },
    });
    const stagedPayload = buildBaccaratRoomParityRevision({
      maskedOutcome: getBaccaratVisibleCoup(),
      bet: staged.betType,
      stake: staged.stake,
      correlation: { hand: 'coup-staged-shoe', handNumber: null },
      dealStep: expectedFinalToken,
      phase: staged.phase,
      transition: 'revealing',
      ...(staged.bannerText ? { bannerText: staged.bannerText } : {}),
      ...(staged.betzoneSelected
        ? { betzoneSelected: staged.betzoneSelected }
        : {}),
    });
    expect(stagedPayload.slots.find((slot) => slot.slot === expectedFinalToken))
      .toMatchObject({ facing: 'up' });
    expect(stagedPayload.meta.winner).toBeUndefined();
    expect(stagedPayload.meta.net).toBeUndefined();
    expect(stagedPayload.meta['banner-text']).toBeUndefined();

    await new Promise((resolve) => {
      setTimeout(resolve, BACCARAT_FINAL_REVEAL_STAGE_MS + 40);
    });
    const settled = useBaccaratRoomController.getState();
    expect(settled).toMatchObject({
      phase: 'settled',
      revealedStep: steps.length,
      pending: null,
      inFlight: false,
    });
    const settledPayload = buildBaccaratRoomParityRevision({
      maskedOutcome: getBaccaratVisibleCoup(),
      bet: settled.betType,
      stake: settled.stake,
      correlation: { hand: 'coup-staged-shoe', handNumber: null },
      dealStep: 'settled',
      phase: settled.phase,
      transition: 'revealing',
      ...(settled.bannerText ? { bannerText: settled.bannerText } : {}),
      ...(settled.betzoneSelected
        ? { betzoneSelected: settled.betzoneSelected }
        : {}),
    });
    expect(settledPayload.meta).toMatchObject({
      winner: coup.winner,
      net: coup.net,
      'banner-text': 'BANKER WINS · YOU LOSE',
    });
    expect(revisions.slice(-2)).toEqual([
      [expectedFinalToken, 'revealing'],
      ['settled', 'settled'],
    ]);
  } finally {
    unsubscribe();
  }
}

describe('baccarat 3D final-card reveal cadence', () => {
  test('natural tail stages banker-2 before the settled revision', async () => {
    await expectStagedFinalReveal(outcome([
      { suit: 'hearts', rank: '4' },
      { suit: 'spades', rank: '2' },
    ]), 'banker-2');
  });

  test('third-card tail stages banker-3 before the settled revision', async () => {
    await expectStagedFinalReveal(outcome([
      { suit: 'hearts', rank: '4' },
      { suit: 'spades', rank: '2' },
      { suit: 'clubs', rank: '3' },
    ]), 'banker-3');
  });
});
