import { describe, expect, test } from 'bun:test';
import type {
  CashHandActionLogEntry,
  CashPokerCard,
  CashSettledSeatView,
  CashSettledView,
} from '../cash-poker';
import {
  EMPTY_CASH_FEED,
  buildCashFeedLines,
  formatCashActionLine,
  formatNet,
  humanizeHandRank,
  lastCashActionBySeat,
  mergeCashHandFeed,
  ownTimeoutNotice,
  pickSpectatorPovSeat,
  secondsUntilMs,
  summarizeCashSettled,
} from '../holdem-cash-feed';

function act(
  seq: number,
  seatIndex: number,
  kind: CashHandActionLogEntry['kind'],
  extra: Partial<CashHandActionLogEntry> = {},
): CashHandActionLogEntry {
  return {
    seq,
    seatIndex,
    street: 'preflop',
    kind,
    chips: 0,
    streetBetAfter: 0,
    allIn: false,
    timeout: false,
    atMs: 1_000 + seq,
    ...extra,
  };
}

const NAMES: Record<number, string> = { 0: 'Alex', 1: 'Bo', 2: 'Cy' };
const nameOf = (seat: number) => NAMES[seat] ?? `Seat ${seat + 1}`;
const c = (rank: CashPokerCard['rank'], suit: CashPokerCard['suit']): CashPokerCard => ({ rank, suit });
const BOARD: CashPokerCard[] = [c('J', 'clubs'), c('Q', 'diamonds'), c('4', 'clubs'), c('9', 'hearts'), c('A', 'spades')];

describe('formatCashActionLine', () => {
  test('third person for others, base verb for You, all-in and timeout copy', () => {
    expect(formatCashActionLine(act(0, 0, 'post-sb', { chips: 10, streetBetAfter: 10 }), nameOf, null))
      .toBe('Alex posts small blind 10');
    expect(formatCashActionLine(act(1, 1, 'post-bb', { chips: 20, streetBetAfter: 20 }), nameOf, 1))
      .toBe('You post big blind 20');
    expect(formatCashActionLine(act(2, 1, 'call', { chips: 20, streetBetAfter: 20 }), nameOf, 1))
      .toBe('You call 20');
    expect(formatCashActionLine(act(3, 1, 'raise', { chips: 60, streetBetAfter: 60, allIn: true }), nameOf, 2))
      .toBe('Bo raises to 60 (all in)');
    expect(formatCashActionLine(act(4, 2, 'check'), nameOf, 0)).toBe('Cy checks');
    expect(formatCashActionLine(act(5, 2, 'bet', { chips: 40, streetBetAfter: 40 }), nameOf, 0)).toBe('Cy bets 40');
    expect(formatCashActionLine(act(6, 0, 'fold', { timeout: true }), nameOf, 0)).toBe('You timed out. Auto-folded');
    expect(formatCashActionLine(act(7, 2, 'check', { timeout: true }), nameOf, 0)).toBe('Cy timed out. Auto-checked');
  });

  test('copy never contains an em dash or the word CT', () => {
    const kinds: CashHandActionLogEntry['kind'][] = ['post-sb', 'post-bb', 'fold', 'check', 'call', 'bet', 'raise'];
    for (const kind of kinds) {
      for (const timeout of [false, true]) {
        const text = formatCashActionLine(act(0, 1, kind, { timeout, chips: 5, streetBetAfter: 5 }), nameOf, 0);
        expect(text).not.toContain('—');
        expect(text).not.toMatch(/\bCT\b/);
      }
    }
  });
});

describe('buildCashFeedLines', () => {
  test('street separators list the new board cards, in order', () => {
    const entries = [
      act(0, 0, 'post-sb', { chips: 10, streetBetAfter: 10 }),
      act(1, 1, 'post-bb', { chips: 20, streetBetAfter: 20 }),
      act(2, 0, 'call', { chips: 10, streetBetAfter: 20 }),
      act(3, 1, 'check'),
      act(4, 0, 'check', { street: 'flop' }),
      act(5, 1, 'bet', { street: 'flop', chips: 40, streetBetAfter: 40 }),
      act(6, 0, 'call', { street: 'flop', chips: 40, streetBetAfter: 40 }),
      act(7, 0, 'check', { street: 'turn' }),
    ];
    const lines = buildCashFeedLines(entries, BOARD.slice(0, 4), nameOf, 0);
    expect(lines.map((line) => line.text)).toEqual([
      'You post small blind 10',
      'Bo posts big blind 20',
      'You call 10',
      'Bo checks',
      'Flop: J♣ Q♦ 4♣',
      'You check',
      'Bo bets 40',
      'You call 40',
      'Turn: 9♥',
      'You check',
    ]);
    expect(lines.filter((line) => line.isYou).length).toBe(5);
    expect(lines.filter((line) => line.kind === 'street').length).toBe(2);
  });

  test('appends separators for streets dealt with no action (all-in run-out)', () => {
    const entries = [
      act(0, 0, 'post-sb', { chips: 10 }),
      act(1, 1, 'post-bb', { chips: 20 }),
      act(2, 0, 'raise', { chips: 190, streetBetAfter: 200, allIn: true }),
      act(3, 1, 'call', { chips: 180, streetBetAfter: 200, allIn: true }),
    ];
    const texts = buildCashFeedLines(entries, BOARD, nameOf, null).map((line) => line.text);
    expect(texts.slice(-3)).toEqual(['Flop: J♣ Q♦ 4♣', 'Turn: 9♥', 'River: A♠']);
  });

  test('sorts by seq and marks timeouts', () => {
    const lines = buildCashFeedLines([act(1, 2, 'fold', { timeout: true }), act(0, 1, 'call', { chips: 20 })], [], nameOf, null);
    expect(lines.map((line) => line.text)).toEqual(['Bo calls 20', 'Cy timed out. Auto-folded']);
    expect(lines[1]!.timeout).toBe(true);
  });
});

describe('mergeCashHandFeed', () => {
  test('dedupes by seq across polls and keeps order', () => {
    let store = mergeCashHandFeed(EMPTY_CASH_FEED, 7, [act(0, 0, 'post-sb'), act(1, 1, 'post-bb')]);
    store = mergeCashHandFeed(store, 7, [act(1, 1, 'post-bb'), act(2, 0, 'call'), act(0, 0, 'post-sb')]);
    expect(store.current?.handNumber).toBe(7);
    expect(store.current?.entries.map((entry) => entry.seq)).toEqual([0, 1, 2]);
  });

  test('returns the same store object when nothing changed', () => {
    const store = mergeCashHandFeed(EMPTY_CASH_FEED, 7, [act(0, 0, 'post-sb')], BOARD.slice(0, 3));
    expect(mergeCashHandFeed(store, 7, [act(0, 0, 'post-sb')], BOARD.slice(0, 3))).toBe(store);
    expect(mergeCashHandFeed(store, 8, [])).toBe(store);
    expect(mergeCashHandFeed(store, 3, [act(0, 1, 'fold')])).toBe(store);
  });

  test('keeps the finished hand until the next hand has an action, then rolls over', () => {
    let store = mergeCashHandFeed(EMPTY_CASH_FEED, 7, [act(0, 0, 'post-sb')], BOARD);
    store = mergeCashHandFeed(store, 8, []);
    expect(store.current?.handNumber).toBe(7);
    expect(store.current?.board.length).toBe(5);
    store = mergeCashHandFeed(store, 8, [act(0, 1, 'post-sb')]);
    expect(store.current?.handNumber).toBe(8);
    expect(store.previous?.handNumber).toBe(7);
    // A late settled log for hand 7 merges into previous, not current.
    store = mergeCashHandFeed(store, 7, [act(1, 1, 'fold')]);
    expect(store.current?.handNumber).toBe(8);
    expect(store.previous?.entries.length).toBe(2);
  });

  test('board only grows', () => {
    let store = mergeCashHandFeed(EMPTY_CASH_FEED, 7, [act(0, 0, 'post-sb')], BOARD);
    store = mergeCashHandFeed(store, 7, [act(0, 0, 'post-sb')], []);
    expect(store.current?.board.length).toBe(5);
  });
});

describe('lastCashActionBySeat', () => {
  test('latest action on the street, blinds excluded, earlier folds kept', () => {
    const entries = [
      act(0, 0, 'post-sb', { chips: 10, streetBetAfter: 10 }),
      act(1, 1, 'post-bb', { chips: 20, streetBetAfter: 20 }),
      act(2, 2, 'fold'),
      act(3, 0, 'call', { chips: 10, streetBetAfter: 20 }),
      act(4, 1, 'check'),
      act(5, 0, 'bet', { street: 'flop', chips: 40, streetBetAfter: 40 }),
      act(6, 1, 'raise', { street: 'flop', chips: 120, streetBetAfter: 120 }),
      act(7, 0, 'check', { street: 'turn', timeout: true }),
    ];
    const pre = lastCashActionBySeat(entries, 'preflop');
    expect(pre.get(0)?.label).toBe('Called');
    expect(pre.get(1)?.label).toBe('Checked');
    expect(pre.get(2)?.label).toBe('Folded');
    const flop = lastCashActionBySeat(entries, 'flop');
    expect(flop.get(0)?.label).toBe('Bet 40');
    expect(flop.get(0)?.statesAmount).toBe(true);
    expect(flop.get(1)?.label).toBe('Raised to 120');
    expect(flop.get(2)?.label).toBe('Folded');
    const turn = lastCashActionBySeat(entries, 'turn');
    expect(turn.get(0)).toEqual({ label: 'Timed out', timeout: true, statesAmount: false });
    expect(turn.has(1)).toBe(false);
    expect(lastCashActionBySeat([act(0, 0, 'post-sb')], 'preflop').size).toBe(0);
  });
});

describe('ownTimeoutNotice', () => {
  test('fold and check copy, null when not a timeout', () => {
    expect(ownTimeoutNotice(act(0, 0, 'fold', { timeout: true }))).toBe('Time ran out. You were auto-folded');
    expect(ownTimeoutNotice(act(0, 0, 'check', { timeout: true }))).toBe('Time ran out. You were auto-checked');
    expect(ownTimeoutNotice(act(0, 0, 'fold'))).toBeNull();
  });
});

function seat(seatIndex: number, extra: Partial<CashSettledSeatView> = {}): CashSettledSeatView {
  return {
    seatIndex,
    avatarId: `avatar-${seatIndex}`,
    startStack: '200',
    endStack: '200',
    totalCommitted: '0',
    grossWon: '0',
    rakeAttributed: '0',
    net: '0',
    stackDelta: '0',
    status: 'active',
    shown: null,
    mucked: false,
    ...extra,
  };
}

function settledFixture(extra: Partial<CashSettledView> = {}): CashSettledView {
  return {
    handId: 't:8275',
    handNumber: 8275,
    tableId: 't',
    board: BOARD,
    endedAt: 'showdown',
    pots: [{ amount: '40', eligibleSeatIndices: [0, 1], awards: [{ seatIndex: 0, amount: '40' }], winningRank: { category: 2, categoryName: 'Two Pair', tiebreakers: [] } }],
    seats: [
      seat(0, { name: 'Alex', net: '20', endStack: '220', shown: [c('J', 'hearts'), c('Q', 'spades')], handRank: { category: 2, categoryName: 'two_pair' } }),
      seat(1, { net: '-20', endStack: '180', shown: [c('2', 'hearts'), c('3', 'spades')], handRank: { category: 0, categoryName: 'High Card' } }),
      seat(2, { status: 'folded', mucked: true }),
    ],
    settledAtMs: 10_000,
    displayExpiresAtMs: 18_000,
    nextHandAtMs: 18_000,
    ...extra,
  };
}

const settledNamer = (s: CashSettledSeatView) => s.name ?? nameOf(s.seatIndex);

describe('summarizeCashSettled', () => {
  test('showdown: winner, amount, hand name, per-seat cards and net', () => {
    const summary = summarizeCashSettled(settledFixture(), settledNamer, 1, null);
    expect(summary.showdown).toBe(true);
    expect(summary.headline).toBe('Showdown');
    expect(summary.totalPot).toBe(40);
    expect(summary.pots[0]!.text).toBe('Pot: Alex wins 40 vCLAW with Two pair');
    const [alex, you, cy] = summary.seats;
    expect(alex).toMatchObject({ name: 'Alex', isWinner: true, rankLabel: 'Two pair', net: 20, folded: false });
    expect(you).toMatchObject({ name: 'You', isYou: true, rankLabel: 'High card', net: -20 });
    expect(you!.cards?.length).toBe(2);
    expect(cy).toMatchObject({ name: 'Cy', folded: true, cards: null, rankLabel: null });
  });

  test('a folded owner sees own cached cards on own row only', () => {
    const own = [c('K', 'clubs'), c('K', 'hearts')];
    const summary = summarizeCashSettled(settledFixture(), settledNamer, 2, own);
    expect(summary.seats[2]).toMatchObject({ name: 'You', folded: true });
    expect(summary.seats[2]!.cards).toEqual(own);
    const spectator = summarizeCashSettled(settledFixture(), settledNamer, null, own);
    expect(spectator.seats.every((row) => !row.isYou)).toBe(true);
    expect(spectator.seats[2]!.cards).toBeNull();
  });

  test('no showdown: "<name> wins <amount> vCLAW. Everyone else folded"', () => {
    const settled = settledFixture({
      endedAt: 'preflop',
      pots: [{ amount: '30', eligibleSeatIndices: [1], awards: [{ seatIndex: 1, amount: '30' }], winningRank: null }],
      seats: [seat(0, { status: 'folded', mucked: true, net: '-10' }), seat(1, { net: '10' })],
    });
    expect(summarizeCashSettled(settled, settledNamer, null).summaryText).toBe('Bo wins 30 vCLAW. Everyone else folded');
    expect(summarizeCashSettled(settled, settledNamer, 1).summaryText).toBe('You win 30 vCLAW. Everyone else folded');
    expect(summarizeCashSettled(settled, settledNamer, 1).headline).toBe('Hand won without showdown');
  });

  test('side pots and split pots', () => {
    const settled = settledFixture({
      pots: [
        { amount: '60', eligibleSeatIndices: [0, 1, 2], awards: [{ seatIndex: 0, amount: '30' }, { seatIndex: 1, amount: '30' }], winningRank: { category: 4, categoryName: 'Straight', tiebreakers: [] } },
        { amount: '40', eligibleSeatIndices: [0, 1], awards: [{ seatIndex: 0, amount: '40' }], winningRank: null },
      ],
    });
    const summary = summarizeCashSettled(settled, settledNamer, null);
    expect(summary.pots.map((pot) => pot.text)).toEqual([
      'Main pot: Alex and Bo split 60 vCLAW with Straight',
      'Side pot 1: Alex wins 40 vCLAW',
    ]);
    expect(summary.totalPot).toBe(100);
  });

  test('older rows without name or handRank still render', () => {
    const settled = settledFixture({ seats: [seat(0), seat(1)] });
    const summary = summarizeCashSettled(settled, settledNamer, null);
    expect(summary.seats.map((row) => row.name)).toEqual(['Alex', 'Bo']);
    expect(summary.seats[0]!.rankLabel).toBeNull();
  });
});

describe('small helpers', () => {
  test('humanizeHandRank', () => {
    expect(humanizeHandRank('two_pair')).toBe('Two pair');
    expect(humanizeHandRank('Three of a Kind')).toBe('Three of a kind');
    expect(humanizeHandRank('STRAIGHT_FLUSH')).toBe('Straight flush');
    expect(humanizeHandRank(undefined)).toBe('');
  });

  test('formatNet and secondsUntilMs', () => {
    expect(formatNet('20')).toBe('+20');
    expect(formatNet(-1500)).toBe('-1,500');
    expect(formatNet('0')).toBe('0');
    expect(secondsUntilMs(18_000, 10_100)).toBe(8);
    expect(secondsUntilMs(1_000, 5_000)).toBe(0);
    expect(secondsUntilMs(undefined, 0)).toBeNull();
  });
});

describe('pickSpectatorPovSeat', () => {
  test('first empty seat, so every occupied seat gets a badge slot', () => {
    expect(pickSpectatorPovSeat([0, 2], 6)).toBe(1);
    expect(pickSpectatorPovSeat([], 6)).toBe(0);
    expect(pickSpectatorPovSeat([1, 2, 3], 4)).toBe(0);
    // Full 4-seat table: use a free chair beyond maxSeats.
    expect(pickSpectatorPovSeat([0, 1, 2, 3], 4)).toBe(4);
    // Full 6-seat table: no free chair, fall back to 0.
    expect(pickSpectatorPovSeat([0, 1, 2, 3, 4, 5], 6)).toBe(0);
  });

  test('the chosen seat is never occupied when a free chair exists', () => {
    for (let mask = 0; mask < 63; mask += 1) {
      const occupied = [0, 1, 2, 3, 4, 5].filter((index) => mask & (1 << index));
      const pov = pickSpectatorPovSeat(occupied, 6);
      expect(occupied.includes(pov)).toBe(false);
      const slots = Array.from({ length: 5 }, (_, slot) => (pov + slot + 1) % 6);
      for (const index of occupied) expect(slots.includes(index)).toBe(true);
    }
  });
});
