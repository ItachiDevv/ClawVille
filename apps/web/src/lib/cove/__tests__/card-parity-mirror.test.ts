import { afterEach, describe, expect, test } from 'bun:test';
import type {
  HoldemSettledResponse,
  SerializedBaccaratCoup,
  SerializedBlackjackHandResult,
} from '@clawville/shared';
import {
  buildBaccaratParity,
  buildBlackjackParity,
  buildHoldemFeltParity,
  buildHoldemTrayParity,
  clearFeltParity,
  encodeCardCode,
  getParitySnapshot,
  publishFeltParity,
  type CardParitySlot,
  type ParityRenderCard,
} from '../card-parity-mirror';

const INSTANCE_ID = 'card-parity-mirror-builders';

afterEach(() => {
  clearFeltParity(INSTANCE_ID);
});

describe('encodeCardCode', () => {
  test('encodes every card in the 52-card deck and normalizes rank 10 to T', () => {
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const suits = [
      ['clubs', 'c'],
      ['diamonds', 'd'],
      ['hearts', 'h'],
      ['spades', 's'],
    ] as const;

    for (const [suit, suitCode] of suits) {
      for (const rank of ranks) {
        const encoded = encodeCardCode({ suit, rank });
        expect(encoded.facing).toBe('up');
        expect(String(encoded.card)).toBe(`${rank === '10' ? 'T' : rank}${suitCode}`);
      }
    }
  });

  test('structurally blanks hidden and absent cards', () => {
    expect(encodeCardCode({ suit: 'spades', rank: 'A', hidden: true }))
      .toEqual({ facing: 'down', card: '' });
    expect(encodeCardCode(null)).toEqual({ facing: 'empty', card: '' });
    expect(encodeCardCode(undefined)).toEqual({ facing: 'empty', card: '' });
    expect(() => encodeCardCode({ suit: 'clubs', rank: '1' })).toThrow();
  });

  test('makes a card code on a non-up slot a compile-time error', () => {
    // @ts-expect-error The discriminated union forbids card data on a down slot.
    const invalidDownSlot: CardParitySlot = { slot: 'hole-1', facing: 'down', card: 'As' };
    // @ts-expect-error The discriminated union also forbids card data on an empty slot.
    const invalidEmptySlot: CardParitySlot = { slot: 'board-1', facing: 'empty', card: 'Kh' };
    expect(String(invalidDownSlot.card)).toBe('As');
    expect(String(invalidEmptySlot.card)).toBe('Kh');
  });
});

describe('pure parity builders', () => {
  test('round-trips Holdem felt and tray render state through the store', () => {
    const board: (ParityRenderCard | null)[] = [
      { suit: 'hearts', rank: 'A' },
      { suit: 'clubs', rank: '10' },
      null,
      null,
      null,
    ];
    const felt = buildHoldemFeltParity({
      kind: 'practice',
      board,
      opponents: [
        {
          seatIndex: 2,
          status: 'active',
          cards: [
            { suit: 'diamonds', rank: 'Q' },
            { suit: 'spades', rank: 'J' },
          ],
          count: 2,
          peek: false,
        },
        {
          seatIndex: 4,
          status: 'folded',
          cards: [
            { suit: 'hearts', rank: 'K' },
            { suit: 'diamonds', rank: 'K' },
          ],
          count: 2,
          peek: false,
        },
      ],
      correlation: { hand: 'practice-hand', handNumber: 7 },
      dealStep: 'flop',
      phase: 'flop',
      transition: 'idle',
      settled: null,
    });
    const tray = buildHoldemTrayParity({
      kind: 'practice',
      hole: [
        { suit: 'spades', rank: 'A' },
        { suit: 'spades', rank: 'K' },
      ],
      narratedBoard: board,
      publicSeats: [{ folded: false }, { folded: false }, { folded: true }],
      settled: null,
      correlation: { hand: 'practice-hand', handNumber: 7 },
      dealStep: 'flop',
      phase: 'flop',
      transition: 'idle',
      pot: '12',
    });

    publishFeltParity(INSTANCE_ID, felt);
    publishFeltParity(INSTANCE_ID, tray);

    expect(getParitySnapshot('holdem-felt-practice')).toMatchObject({
      instanceId: INSTANCE_ID,
      surface: 'holdem-felt-practice',
      correlation: { hand: 'practice-hand', handNumber: 7 },
      slots: [
        { slot: 'board-1', facing: 'up', card: 'Ah' },
        { slot: 'board-2', facing: 'up', card: 'Tc' },
        { slot: 'board-3', facing: 'empty', card: '' },
        { slot: 'board-4', facing: 'empty', card: '' },
        { slot: 'board-5', facing: 'empty', card: '' },
        { slot: 'opp-2-1', facing: 'up', card: 'Qd', status: 'active' },
        { slot: 'opp-2-2', facing: 'up', card: 'Js', status: 'active' },
        { slot: 'opp-4-1', facing: 'down', card: '', status: 'folded' },
        { slot: 'opp-4-2', facing: 'down', card: '', status: 'folded' },
      ],
    });
    expect(getParitySnapshot('holdem-tray-practice')).toMatchObject({
      instanceId: INSTANCE_ID,
      surface: 'holdem-tray-practice',
      meta: { pot: '12' },
      slots: [
        { slot: 'hole-1', facing: 'up', card: 'As' },
        { slot: 'hole-2', facing: 'up', card: 'Ks' },
        { slot: 'board-1', facing: 'up', card: 'Ah' },
        { slot: 'board-2', facing: 'up', card: 'Tc' },
        { slot: 'board-3', facing: 'empty', card: '' },
        { slot: 'board-4', facing: 'empty', card: '' },
        { slot: 'board-5', facing: 'empty', card: '' },
      ],
    });
  });

  test('publishes practice felt settlement metadata from the settled snapshot', () => {
    const settled: HoldemSettledResponse = {
      handId: 'practice-settled',
      tableId: 'practice-table',
      handIndex: 8,
      status: 'settled',
      outcome: {
        kind: 'holdem',
        handIndex: 8,
        buttonSeat: 0,
        smallBlindSeat: 1,
        bigBlindSeat: 2,
        board: [
          { suit: 'hearts', rank: 'A' },
          { suit: 'clubs', rank: 'K' },
          { suit: 'diamonds', rank: 'Q' },
          { suit: 'spades', rank: 'J' },
          { suit: 'hearts', rank: '10' },
        ],
        endedAt: 'showdown',
        seats: [
          {
            seat: 0,
            isHuman: true,
            personality: null,
            holeCards: [
              { suit: 'spades', rank: 'A' },
              { suit: 'spades', rank: 'K' },
            ],
            committed: '10',
            won: '24',
            net: '14',
            status: 'active',
            handCategory: 4,
            handCategoryName: 'Straight',
            isWinner: true,
          },
          {
            seat: 2,
            isHuman: false,
            personality: 'lag',
            holeCards: [],
            committed: '14',
            won: '0',
            net: '-14',
            status: 'folded',
            handCategory: null,
            handCategoryName: null,
            isWinner: false,
          },
        ],
        pots: [{
          amount: '24',
          eligibleSeats: [0],
          winners: [0],
          perWinner: '24',
        }],
        actionLog: [],
        humanBet: '10',
        humanPayout: '24',
        humanNet: '14',
        nonce: 1,
        engineVersion: 'test',
      },
      playerStack: '114',
      walletBalance: 100,
      betAmount: '10',
      payout: '24',
      net: '14',
      idempotencyReplay: false,
    };
    const felt = buildHoldemFeltParity({
      kind: 'practice',
      board: settled.outcome.board,
      opponents: [{
        seatIndex: 2,
        status: 'folded',
        cards: null,
        count: 2,
        peek: false,
      }],
      settled,
      bannerText: 'Showdown: YOU win 24 vCLAW with Straight',
      correlation: { hand: settled.handId, handNumber: settled.handIndex },
      dealStep: 'showdown',
      phase: 'settled',
      transition: 'idle',
    });

    expect(felt.meta).toEqual({
      outcome: 'showdown',
      winners: '0',
      net: '14',
      pot: '24',
      'banner-text': 'Showdown: YOU win 24 vCLAW with Straight',
    });
    expect(felt.slots.filter((slot) => slot.slot.startsWith('opp-2')))
      .toEqual([
        { slot: 'opp-2-1', facing: 'down', card: '', status: 'folded' },
        { slot: 'opp-2-2', facing: 'down', card: '', status: 'folded' },
      ]);
  });

  test('round-trips Blackjack render state without exposing the dealer hole card', () => {
    const payload = buildBlackjackParity({
      hand: {
        playerHands: [{
          cards: [
            { suit: 'hearts', rank: '10' },
            { suit: 'clubs', rank: '7' },
          ],
          total: 17,
          isSoft: false,
          isBust: false,
          isResolved: false,
        }],
        dealerUpcard: { suit: 'spades', rank: 'A' },
        insuranceOffered: true,
        tookInsurance: false,
        didSplit: false,
      },
      settled: null,
      activeSlot: 0,
      surface: 'blackjack-2d',
      correlation: { hand: 'blackjack-hand', handNumber: null, shoe: 'shoe-1' },
      dealStep: 'player-turn',
      phase: 'player-turn',
      transition: 'idle',
    });

    publishFeltParity(INSTANCE_ID, payload);

    expect(getParitySnapshot('blackjack-2d')).toMatchObject({
      instanceId: INSTANCE_ID,
      meta: {
        'active-slot': '0',
        'insurance-offered': 'true',
        'insurance-taken': 'false',
        'player-0-total': '17',
      },
      slots: [
        { slot: 'player-0-card-1', facing: 'up', card: 'Th' },
        { slot: 'player-0-card-2', facing: 'up', card: '7c' },
        { slot: 'dealer-card-1', facing: 'up', card: 'As' },
        { slot: 'dealer-card-2', facing: 'down', card: '' },
      ],
    });
  });

  test('keeps Blackjack outcome metadata out of the dealer-reveal revision', () => {
    const outcome: SerializedBlackjackHandResult = {
      kind: 'blackjack',
      playerHands: [{
        cards: [
          { suit: 'hearts', rank: '10' },
          { suit: 'clubs', rank: '7' },
        ],
        total: 17,
        isSoft: false,
        isBust: false,
        isBlackjack: false,
        isDoubled: false,
        bet: '10',
        outcome: 'loss',
        payout: '0',
      }],
      dealer: {
        cards: [
          { suit: 'spades', rank: 'A' },
          { suit: 'diamonds', rank: 'K' },
        ],
        total: 21,
        isSoft: false,
        isBust: false,
        isBlackjack: true,
      },
      insurance: null,
      totalBet: '10',
      totalPayout: '0',
      net: '-10',
      cursorBefore: 0,
      cursorAfter: 4,
      dealtBefore: 0,
      dealtAfter: 4,
      nonce: 1,
      engineVersion: 'test',
    };
    const common = {
      hand: null,
      settled: { outcome },
      activeSlot: 0 as const,
      surface: 'blackjack-3d' as const,
      correlation: { hand: 'blackjack-settled', handNumber: null },
      phase: 'settled',
      transition: 'revealing' as const,
      bannerText: 'Dealer blackjack',
    };
    const dealerReveal = buildBlackjackParity({
      ...common,
      dealStep: 'dealer-reveal',
    });
    const settled = buildBlackjackParity({
      ...common,
      dealStep: 'settled',
    });

    const dealerHole = dealerReveal.slots.find((slot) => slot.slot === 'dealer-card-2');
    expect(dealerHole?.facing).toBe('up');
    expect(String(dealerHole?.card)).toBe('Kd');
    expect(dealerReveal.meta['dealer-total']).toBe('21');
    expect(dealerReveal.meta['outcome-0']).toBeUndefined();
    expect(dealerReveal.meta['banner-text']).toBeUndefined();
    expect(settled.meta['outcome-0']).toBe('loss');
    expect(settled.meta['banner-text']).toBe('Dealer blackjack');
  });

  test('round-trips Baccarat render state including totals and money metadata', () => {
    const outcome: SerializedBaccaratCoup = {
      kind: 'baccarat',
      bet: 'banker',
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
        cards: [
          { suit: 'hearts', rank: '4' },
          { suit: 'spades', rank: '4' },
          { suit: 'clubs', rank: 'A' },
        ],
        total: 9,
        isNatural: false,
      },
      winner: 'banker',
      payout: '47',
      net: '22',
      commission: '1',
      cursorBefore: 0,
      cursorAfter: 5,
      dealtBefore: 0,
      dealtAfter: 5,
      nonce: 1,
      engineVersion: 'test',
    };
    const payload = buildBaccaratParity({
      outcome,
      bet: 'banker',
      stake: 25,
      surface: 'baccarat-2d',
      correlation: { hand: 'coup-1', handNumber: null, shoe: 'shoe-1' },
      dealStep: 'settled',
      phase: 'settled',
      transition: 'idle',
      bannerText: 'Banker wins',
      betzoneSelected: 'banker',
    });

    publishFeltParity(INSTANCE_ID, payload);

    expect(getParitySnapshot('baccarat-2d')).toMatchObject({
      instanceId: INSTANCE_ID,
      meta: {
        bet: 'banker',
        stake: '25',
        'player-total': '5',
        'banker-total': '9',
        winner: 'banker',
        commission: '1',
        net: '22',
        'banner-text': 'Banker wins',
        'betzone-selected': 'banker',
      },
      slots: [
        { slot: 'player-1', facing: 'up', card: '2c' },
        { slot: 'player-2', facing: 'up', card: '3d' },
        { slot: 'player-3', facing: 'empty', card: '' },
        { slot: 'banker-1', facing: 'up', card: '4h' },
        { slot: 'banker-2', facing: 'up', card: '4s' },
        { slot: 'banker-3', facing: 'up', card: 'Ac' },
      ],
    });
  });
});
