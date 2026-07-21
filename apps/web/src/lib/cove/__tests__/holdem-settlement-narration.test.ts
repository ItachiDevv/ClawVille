import { describe, expect, test } from 'bun:test';
import type { HoldemSettledResponse, SerializedHoldemHand } from '@clawville/shared';
import { settlementNarration } from '../holdem-settlement-narration';

function settledResponse(
  winnerSeat: number,
  endedAt: SerializedHoldemHand['endedAt'],
): HoldemSettledResponse {
  const seats = Array.from({ length: 6 }, (_, seat) => ({
    seat,
    isHuman: seat === 0,
    personality: seat === 0 ? null : 'tag' as const,
    holeCards: [],
    committed: seat < 2 ? '2' : '0',
    won: seat === winnerSeat ? '4' : '0',
    net: seat === winnerSeat ? '2' : seat < 2 ? '-2' : '0',
    // Reproduce the live-mapping defect: neither status nor isWinner carries
    // the fold winner. endedAt + pots.winners still identify it authoritatively.
    status: 'active' as const,
    handCategory: null,
    handCategoryName: null,
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
      pots: [{ amount: '4', eligibleSeats: [winnerSeat], winners: [winnerSeat], perWinner: '4' }],
      actionLog: [],
      humanBet: '2',
      humanPayout: winnerSeat === 0 ? '4' : '0',
      humanNet: winnerSeat === 0 ? '2' : '-2',
      nonce: 1,
      engineVersion: 'test',
    },
    playerStack: '102',
    walletBalance: 100,
    betAmount: '2',
    payout: winnerSeat === 0 ? '4' : '0',
    net: winnerSeat === 0 ? '2' : '-2',
    idempotencyReplay: false,
  };
}

describe('settlementNarration', () => {
  test('uses endedAt + pot winners for a human fold win', () => {
    expect(settlementNarration(settledResponse(0, 'preflop'))).toEqual({
      headline: 'Everyone folded — you take the pot: +4 vCLAW',
      detail: 'Your net: +2 vCLAW',
    });
  });

  test('uses endedAt + pot winners for an opponent fold win', () => {
    expect(settlementNarration(settledResponse(2, 'turn'))).toEqual({
      headline: 'Everyone else folded — Vex takes 4 vCLAW',
      detail: 'Your net: -2 vCLAW',
    });
  });

  test('keeps showdown narration when the server says showdown', () => {
    expect(settlementNarration(settledResponse(0, 'showdown')).headline)
      .toBe('Showdown — YOU wins 4 vCLAW');
  });
});
