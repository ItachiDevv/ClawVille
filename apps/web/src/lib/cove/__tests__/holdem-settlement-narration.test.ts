import { describe, expect, test } from 'bun:test';
import type {
  HoldemSettledResponse,
  SerializedHoldemHand,
  SerializedHoldemPot,
} from '@clawville/shared';
import { settlementNarration } from '../holdem-settlement-narration';

interface SettledFixture {
  endedAt: SerializedHoldemHand['endedAt'];
  winners?: readonly number[];
  pots?: readonly SerializedHoldemPot[];
  categories?: Readonly<Record<number, string>>;
  payout?: string;
  net?: string;
}

function settledResponse({
  endedAt,
  winners = [],
  pots = winners.length > 0
    ? [{ amount: '4', eligibleSeats: [...winners], winners: [...winners], perWinner: '4' }]
    : [],
  categories = {},
  payout = winners.includes(0) ? '4' : '0',
  net = winners.includes(0) ? '2' : '-2',
}: SettledFixture): HoldemSettledResponse {
  const wonBySeat = new Map<number, bigint>();
  for (const pot of pots) {
    for (const winner of pot.winners) {
      wonBySeat.set(winner, (wonBySeat.get(winner) ?? 0n) + BigInt(pot.perWinner));
    }
  }
  const seats = Array.from({ length: 6 }, (_, seat) => ({
    seat,
    isHuman: seat === 0,
    personality: seat === 0 ? null : 'tag' as const,
    holeCards: [],
    committed: seat < 2 ? '2' : '0',
    won: (wonBySeat.get(seat) ?? 0n).toString(),
    net: seat === 0 ? net : '0',
    status: 'active' as const,
    handCategory: null,
    handCategoryName: categories[seat] ?? null,
    isWinner: false,
  }));
  return {
    handId: 'hand-1',
    tableId: 'table-1',
    handIndex: 1,
    status: 'settled',
    outcome: {
      kind: 'holdem',
      handIndex: 1,
      buttonSeat: 0,
      smallBlindSeat: 1,
      bigBlindSeat: 2,
      board: [],
      endedAt,
      seats,
      pots: [...pots],
      actionLog: [],
      humanBet: '2',
      humanPayout: payout,
      humanNet: net,
      nonce: 1,
      engineVersion: 'test',
    },
    playerStack: '102',
    walletBalance: 100,
    betAmount: '2',
    payout,
    net,
    idempotencyReplay: false,
  };
}

describe('settlementNarration', () => {
  test('uses the frozen human fold-win copy', () => {
    expect(settlementNarration(settledResponse({
      endedAt: 'preflop',
      winners: [0],
    }))).toEqual({
      headline: 'Everyone folded. You take the pot: +4 vCLAW',
      detail: 'Your net: +2 vCLAW',
    });
  });

  test('uses the frozen bot fold-win copy', () => {
    expect(settlementNarration(settledResponse({
      endedAt: 'turn',
      winners: [2],
    }))).toEqual({
      headline: 'Everyone else folded. Vex takes 4 vCLAW',
      detail: 'Your net: -2 vCLAW',
    });
  });

  test('narrates single and multiple showdown winners with the correct verb', () => {
    expect(settlementNarration(settledResponse({
      endedAt: 'showdown',
      winners: [0],
      categories: { 0: 'Straight' },
    })).headline).toBe('Showdown: YOU win 4 vCLAW with Straight');

    expect(settlementNarration(settledResponse({
      endedAt: 'showdown',
      winners: [0, 2],
      pots: [{
        amount: '8',
        eligibleSeats: [0, 2],
        winners: [0, 2],
        perWinner: '4',
      }],
      categories: { 0: 'Flush', 2: 'Flush' },
    })).headline).toBe(
      'Showdown: YOU win 4 vCLAW with Flush · Vex wins 4 vCLAW with Flush',
    );
  });

  test('narrates split and multiple pots before the signed human net', () => {
    const narration = settlementNarration(settledResponse({
      endedAt: 'showdown',
      winners: [0, 2],
      pots: [
        {
          amount: '8',
          eligibleSeats: [0, 2],
          winners: [0, 2],
          perWinner: '4',
        },
        {
          amount: '3',
          eligibleSeats: [2],
          winners: [2],
          perWinner: '3',
        },
      ],
      net: '+2',
    }));
    expect(narration.detail).toBe(
      'Pot 1: YOU + Vex (8 vCLAW) · Pot 2: Vex (3 vCLAW) · Your net: +2 vCLAW',
    );

    const splitPot = settlementNarration(settledResponse({
      endedAt: 'showdown',
      winners: [0, 2],
      pots: [{
        amount: '8',
        eligibleSeats: [0, 2],
        winners: [0, 2],
        perWinner: '4',
      }],
    }));
    expect(splitPot.detail).toBe('Split pot: YOU + Vex (8 vCLAW) · Your net: +2 vCLAW');
  });

  test('uses the frozen empty-winner fallback', () => {
    expect(settlementNarration(settledResponse({
      endedAt: 'showdown',
      winners: [],
      net: '0',
    }))).toEqual({
      headline: 'Showdown: pot awarded',
      detail: 'Your net: +0 vCLAW',
    });
  });
});
