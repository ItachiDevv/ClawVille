import { describe, expect, test } from 'bun:test';
import { expectedFromWire } from '../expected-from-wire';
import type { CardParityRoot, WireRecord } from '../types';

const wire: WireRecord = {
  seq: 1,
  method: 'POST',
  url: 'http://api.test/api/cove/blackjack/action',
  urlSuffix: 'blackjack/action',
  status: 200,
  requestBody: { action: 'stand' },
  responseBody: {
    handId: 'insurance-hand',
    status: 'settled',
    outcome: {
      playerHands: [{
        cards: [
          { rank: '10', suit: 'spades' },
          { rank: '9', suit: 'hearts' },
        ],
        total: 19,
        outcome: 'lose',
      }],
      dealer: {
        cards: [
          { rank: 'A', suit: 'clubs' },
          { rank: 'K', suit: 'diamonds' },
        ],
        total: 21,
      },
      insurance: { stake: '5', payout: '15' },
      rakedNet: '0',
    },
  },
  handId: 'insurance-hand',
  handNumber: 1,
  coupId: null,
  shoeId: 'shoe',
  idempotencyKey: null,
};

function root(
  dealStep: 'hole' | 'player-turn' | 'split' | 'dealer-reveal' | 'settled',
  surface: 'blackjack-2d' | 'blackjack-3d' = 'blackjack-2d',
): CardParityRoot {
  return {
    surface,
    version: 2,
    instanceId: 'test',
    renderRevision: 1,
    correlation: { hand: 'insurance-hand', handNumber: 1, shoe: 'shoe' },
    dealStep,
    phase: dealStep,
    transition: 'idle',
    slots: [],
    meta: {},
  };
}

function actionWire({
  cards = [
    { rank: '10', suit: 'spades' },
    { rank: '5', suit: 'hearts' },
  ],
  didSplit = false,
  insuranceOffered,
}: {
  cards?: Array<{ rank: string; suit: string }>;
  didSplit?: boolean;
  insuranceOffered?: boolean;
} = {}): WireRecord {
  return {
    ...wire,
    requestBody: { action: 'hit', handSlot: 0 },
    responseBody: {
      handId: 'insurance-hand',
      status: 'in_progress',
      playerHands: [{
        cards,
        total: 15,
        isSoft: false,
        isBust: false,
        isResolved: false,
      }],
      dealerUpcard: { rank: 'A', suit: 'diamonds' },
      didSplit,
      ...(insuranceOffered === undefined ? {} : { insuranceOffered }),
      tookInsurance: false,
    },
  };
}

describe('in-progress blackjack insurance oracle', () => {
  test('post-Hit Ace-upcard wire without flags is not offered', () => {
    const expected = expectedFromWire(
      'blackjack',
      'blackjack-3d',
      actionWire({
        cards: [
          { rank: '10', suit: 'spades' },
          { rank: '5', suit: 'hearts' },
          { rank: '2', suit: 'clubs' },
        ],
      }),
      undefined,
      { root: root('player-turn', 'blackjack-3d') },
    );
    expect(expected.meta['insurance-offered']).toBe('false');
  });

  test('fresh two-card Ace-upcard wire without flags is offered', () => {
    const expected = expectedFromWire(
      'blackjack',
      'blackjack-3d',
      actionWire(),
      undefined,
      { root: root('hole', 'blackjack-3d') },
    );
    expect(expected.meta['insurance-offered']).toBe('true');
  });

  test('split hands are not offered', () => {
    const action = actionWire({ didSplit: true });
    action.responseBody = {
      ...(action.responseBody as object),
      playerHands: [
        {
          cards: [
            { rank: '8', suit: 'spades' },
            { rank: '3', suit: 'hearts' },
          ],
        },
        {
          cards: [
            { rank: '8', suit: 'clubs' },
            { rank: '4', suit: 'diamonds' },
          ],
        },
      ],
    };
    const expected = expectedFromWire(
      'blackjack',
      'blackjack-3d',
      action,
      undefined,
      { root: root('split', 'blackjack-3d') },
    );
    expect(expected.meta['insurance-offered']).toBe('false');
  });

  test('explicit live flags win in both boolean directions', () => {
    for (const [cards, insuranceOffered] of [
      [[
        { rank: '10', suit: 'spades' },
        { rank: '5', suit: 'hearts' },
        { rank: '2', suit: 'clubs' },
      ], true],
      [[
        { rank: '10', suit: 'spades' },
        { rank: '5', suit: 'hearts' },
      ], false],
    ] as const) {
      const expected = expectedFromWire(
        'blackjack',
        'blackjack-3d',
        actionWire({
          cards: [...cards],
          insuranceOffered,
        }),
        undefined,
        { root: root('player-turn', 'blackjack-3d') },
      );
      expect(expected.meta['insurance-offered']).toBe(String(insuranceOffered));
    }
  });
});

describe('terminal blackjack insurance oracle', () => {
  test('derives taken insurance and Ace offer from terminal outcome truth', () => {
    for (const dealStep of ['dealer-reveal', 'settled'] as const) {
      const expected = expectedFromWire(
        'blackjack',
        'blackjack-2d',
        wire,
        undefined,
        { root: root(dealStep) },
      );
      expect(expected.meta['insurance-taken']).toBe('true');
      expect(expected.meta['insurance-offered']).toBe('true');
    }
  });

  test('top-level live flags remain authoritative when present', () => {
    const expected = expectedFromWire(
      'blackjack',
      'blackjack-2d',
      {
        ...wire,
        responseBody: {
          ...(wire.responseBody as object),
          insuranceOffered: false,
          tookInsurance: false,
        },
      },
      undefined,
      { root: root('settled') },
    );
    expect(expected.meta['insurance-taken']).toBe('false');
    expect(expected.meta['insurance-offered']).toBe('false');
  });

  test('Ace upcard without settled insurance stays offered but not taken', () => {
    const responseBody = wire.responseBody as {
      outcome: Record<string, unknown>;
    };
    const expected = expectedFromWire(
      'blackjack',
      'blackjack-2d',
      {
        ...wire,
        responseBody: {
          ...responseBody,
          outcome: {
            ...responseBody.outcome,
            insurance: null,
          },
        },
      },
      undefined,
      { root: root('settled') },
    );
    expect(expected.meta['insurance-taken']).toBe('false');
    expect(expected.meta['insurance-offered']).toBe('true');
  });

  test('non-Ace settled upcard without live flags stays not offered', () => {
    const responseBody = wire.responseBody as {
      outcome: Record<string, unknown> & {
        dealer: Record<string, unknown> & {
          cards: Array<Record<string, unknown>>;
        };
      };
    };
    const expected = expectedFromWire(
      'blackjack',
      'blackjack-2d',
      {
        ...wire,
        responseBody: {
          ...responseBody,
          outcome: {
            ...responseBody.outcome,
            dealer: {
              ...responseBody.outcome.dealer,
              cards: [
                { rank: '9', suit: 'clubs' },
                ...responseBody.outcome.dealer.cards.slice(1),
              ],
            },
            insurance: null,
          },
        },
      },
      undefined,
      { root: root('settled') },
    );
    expect(expected.meta['insurance-offered']).toBe('false');
  });
});
