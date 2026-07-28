import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  BlackjackCard,
  SerializedBlackjackHandResult,
} from '@clawville/shared';
import {
  advanceBlackjackRoomParity,
  buildBlackjackRoomParity,
} from '../blackjack-room-parity';
import {
  clearFeltParity,
  getParitySnapshot,
  type ParityJournalEntry,
} from '../card-parity-mirror';
import {
  deriveDealerRenderView,
  expireInsuranceOffer,
  type BlackjackRoomState,
} from '../use-blackjack-room-controller';

const OWNERS = [
  'blackjack-action-bust',
  'blackjack-action-stand',
  'blackjack-action-insurance-expiry',
] as const;
let previousWindow: typeof globalThis.window | undefined;

beforeEach(() => {
  previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    value: {} as Window,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  for (const owner of OWNERS) clearFeltParity(owner);
  if (previousWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
  } else {
    Object.defineProperty(globalThis, 'window', {
      value: previousWindow,
      configurable: true,
      writable: true,
    });
  }
});

function outcome(
  cards: BlackjackCard[],
  total: number,
  isBust: boolean,
): SerializedBlackjackHandResult {
  return {
    kind: 'blackjack',
    playerHands: [{
      cards,
      total,
      isSoft: false,
      isBust,
      isBlackjack: false,
      isDoubled: false,
      bet: '25',
      outcome: 'loss',
      payout: '0',
    }],
    dealer: {
      cards: [
        { suit: 'hearts', rank: '8' },
        { suit: 'clubs', rank: '10' },
        { suit: 'diamonds', rank: '2' },
      ],
      total: 20,
      isSoft: false,
      isBust: false,
      isBlackjack: false,
    },
    insurance: null,
    totalBet: '25',
    totalPayout: '0',
    net: '-25',
    rake: '0',
    rakedPayout: '0',
    rakedNet: '-25',
    cursorBefore: 0,
    cursorAfter: cards.length + 3,
    dealtBefore: 0,
    dealtAfter: cards.length + 3,
    nonce: 1,
    engineVersion: 'test',
  };
}

function view(
  handOutcome: SerializedBlackjackHandResult | null,
  dealStep: BlackjackRoomState['dealStep'],
): BlackjackRoomState {
  const liveCards: BlackjackCard[] = [
    { suit: 'spades', rank: '10' },
    { suit: 'diamonds', rank: '7' },
  ];
  const player = handOutcome?.playerHands[0];
  const dealerView = deriveDealerRenderView(
    handOutcome?.dealer.cards[0],
    handOutcome,
    dealStep,
  );
  return {
    phase: dealStep === 'settled' ? 'settled' : 'player-turn',
    ...dealerView,
    playerHands: [{
      cards: player?.cards ?? liveCards,
      total: player?.total ?? 17,
      isSoft: player?.isSoft ?? false,
      isBust: player?.isBust ?? false,
      isResolved: handOutcome !== null,
      ...(player ? {
        outcome: player.outcome,
        payout: player.payout,
        bet: player.bet,
        isBlackjack: player.isBlackjack,
        isDoubled: player.isDoubled,
      } : {}),
    }],
    activeSlot: 0,
    didSplit: false,
    insuranceOffered: false,
    tookInsurance: false,
    dealStep,
    transition: dealStep === 'player-turn' ? 'idle' : 'revealing',
    publishSeq: dealStep === 'player-turn' ? 1 : dealStep === 'dealer-reveal' ? 2 : 3,
    bannerVisible: dealStep === 'settled',
    handId: 'hand-action-settled',
    handIndex: 4,
    bannerText: handOutcome ? 'YOU LOSE · -25 CT' : null,
    balance: 75,
    isRealTier: false,
    bet: 25,
    shoe: null,
    revealedSeed: null,
    settled: handOutcome ? {
      outcome: handOutcome,
      net: '-25',
      balance: 75,
      handId: 'hand-action-settled',
    } : null,
    toast: null,
    inFlight: false,
    canDouble: false,
    canSplit: false,
    canSurrender: false,
    activeResolved: handOutcome !== null,
    agentMode: 'control',
    agentConnected: false,
    agentDriverUnavailable: false,
    agentPendingAction: null,
    advisorMessages: [],
    fairnessSummary: 'test',
  };
}

function expectActionSettledSequence(
  owner: (typeof OWNERS)[number],
  handOutcome: SerializedBlackjackHandResult,
): void {
  const live = view(null, 'player-turn');
  expect(advanceBlackjackRoomParity(owner, live, null)).toBeNull();

  const dealerReveal = view(handOutcome, 'dealer-reveal');
  const actionSettled = view(handOutcome, 'player-turn');
  expect(actionSettled.dealerCards).toEqual([
    handOutcome.dealer.cards[0],
    { suit: 'spades', rank: 'A', hidden: true },
  ]);
  expect(actionSettled.dealerTotalLabel).toBe('8+?');
  expect(dealerReveal.dealerCards).toEqual(handOutcome.dealer.cards);
  expect(dealerReveal.dealerTotalLabel).toBe('20');
  const settledView = view(handOutcome, 'settled');
  expect(settledView.dealerCards).toEqual(handOutcome.dealer.cards);
  expect(settledView.dealerTotalLabel).toBe('20');
  const terminalPlayerTruth = buildBlackjackRoomParity(
    actionSettled,
    'player-turn',
    'idle',
  );
  expect(terminalPlayerTruth.slots.filter((slot) => slot.slot.startsWith('player-')))
    .toHaveLength(handOutcome.playerHands[0]!.cards.length);
  const dealerUpcard = terminalPlayerTruth.slots.find(
    (slot) => slot.slot === 'dealer-card-1',
  );
  expect({
    ...dealerUpcard,
    card: String(dealerUpcard?.card),
  }).toEqual({ slot: 'dealer-card-1', facing: 'up', card: '8h' });
  expect(terminalPlayerTruth.slots.find((slot) => slot.slot === 'dealer-card-2'))
    .toEqual({ slot: 'dealer-card-2', facing: 'down', card: '' });
  expect(terminalPlayerTruth.meta['player-0-bust'])
    .toBe(String(handOutcome.playerHands[0]!.isBust));
  expect(terminalPlayerTruth.meta['player-0-resolved']).toBe('true');
  expect(terminalPlayerTruth.meta['dealer-total']).toBeUndefined();
  expect(terminalPlayerTruth.meta['outcome-0']).toBeUndefined();
  expect(terminalPlayerTruth.meta['banner-text']).toBeUndefined();

  expect(advanceBlackjackRoomParity(
    owner,
    view(handOutcome, 'player-turn'),
    null,
  )).toBeNull();

  const revealSpan = advanceBlackjackRoomParity(owner, dealerReveal, null);
  expect(revealSpan).not.toBeNull();
  expect(advanceBlackjackRoomParity(
    owner,
    view(handOutcome, 'settled'),
    revealSpan,
  )).toBeNull();

  const journal = globalThis.window.__CV_PARITY_JOURNAL?.('blackjack-3d')
    .filter((entry: ParityJournalEntry) => entry.instanceId === owner);
  expect(journal?.map((entry: ParityJournalEntry) => [
    entry.dealStep,
    entry.transition,
  ])).toEqual([
    ['player-turn', 'idle'],
    ['player-turn', 'idle'],
    ['player-turn', 'revealing'],
    ['dealer-reveal', 'revealing'],
    ['settled', 'revealing'],
    ['settled', 'idle'],
  ]);

  const settled = getParitySnapshot('blackjack-3d');
  expect(settled).toMatchObject({
    instanceId: owner,
    dealStep: 'settled',
    transition: 'idle',
    meta: {
      'player-0-bust': String(handOutcome.playerHands[0]!.isBust),
      'player-0-resolved': 'true',
      'outcome-0': 'loss',
      'dealer-total': '20',
      'banner-text': 'YOU LOSE · -25 CT',
      net: '-25',
    },
  });
  expect(settled?.slots.filter((slot) => slot.slot.startsWith('player-')))
    .toHaveLength(handOutcome.playerHands[0]!.cards.length);
  expect(settled?.slots.filter((slot) => slot.slot.startsWith('dealer-')))
    .toHaveLength(handOutcome.dealer.cards.length);
}

describe('Blackjack 3D action-settled parity cadence', () => {
  test('publishes insurance offered before a dealer-Ace hit and false after its action response', () => {
    const owner = 'blackjack-action-insurance-expiry';
    const dealerCards: BlackjackCard[] = [
      { suit: 'spades', rank: 'A' },
      { suit: 'spades', rank: 'A', hidden: true },
    ];
    const before = {
      ...view(null, 'player-turn'),
      dealerCards,
      insuranceOffered: true,
    };
    expect(advanceBlackjackRoomParity(owner, before, null)).toBeNull();
    expect(getParitySnapshot('blackjack-3d')?.meta['insurance-offered']).toBe('true');

    const insuranceState = expireInsuranceOffer({ offered: true, took: false });
    const after = {
      ...before,
      playerHands: [{
        ...before.playerHands[0]!,
        cards: [
          ...before.playerHands[0]!.cards,
          { suit: 'clubs', rank: '2' } as const,
        ],
        total: 19,
      }],
      insuranceOffered: insuranceState.offered,
      tookInsurance: insuranceState.took,
      publishSeq: before.publishSeq + 1,
    };
    expect(advanceBlackjackRoomParity(owner, after, null)).toBeNull();
    expect(getParitySnapshot('blackjack-3d')?.meta['insurance-offered']).toBe('false');
  });

  test('publishes an upcard-safe terminal player-turn truth before a hit bust reveal', () => {
    expectActionSettledSequence(
      'blackjack-action-bust',
      outcome([
        { suit: 'spades', rank: '10' },
        { suit: 'diamonds', rank: '7' },
        { suit: 'hearts', rank: '9' },
      ], 26, true),
    );
  });

  test('publishes an upcard-safe terminal player-turn truth before a stand reveal', () => {
    expectActionSettledSequence(
      'blackjack-action-stand',
      outcome([
        { suit: 'spades', rank: '10' },
        { suit: 'diamonds', rank: '7' },
      ], 17, false),
    );
  });
});
