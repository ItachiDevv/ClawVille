import type {
  CardParityRoot,
  ExpectedParity,
  ExpectedSlot,
  ParityGame,
  Surface,
  WireRecord,
} from './types';

type UnknownRecord = Record<string, unknown>;

const SUIT_CODES: Readonly<Record<string, string>> = Object.freeze({
  clubs: 'c',
  diamonds: 'd',
  hearts: 'h',
  spades: 's',
});
const RANK_CODES: Readonly<Record<string, string>> = Object.freeze({
  A: 'A',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  '10': 'T',
  T: 'T',
  J: 'J',
  Q: 'Q',
  K: 'K',
});

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function boolValue(value: unknown): boolean {
  return value === true || value === 'true';
}

function first(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function cardCode(value: unknown): string {
  const card = record(value);
  if (!card || card.hidden === true) return '';
  const suit = SUIT_CODES[stringValue(card.suit)];
  const rank = RANK_CODES[stringValue(card.rank)];
  if (!suit || !rank) return '';
  return `${rank}${suit}`;
}

function up(card: unknown, status?: string): ExpectedSlot {
  const code = cardCode(card);
  return code
    ? { card: code, facing: 'up', ...(status ? { status } : {}) }
    : { card: '', facing: 'empty', ...(status ? { status } : {}) };
}

function down(status?: string): ExpectedSlot {
  return { card: '', facing: 'down', ...(status ? { status } : {}) };
}

function empty(status?: string): ExpectedSlot {
  return { card: '', facing: 'empty', ...(status ? { status } : {}) };
}

function nestedBody(wire: WireRecord): UnknownRecord {
  return record(wire.responseBody) ?? {};
}

function blackjackPayload(body: UnknownRecord): {
  live: UnknownRecord | null;
  outcome: UnknownRecord | null;
} {
  const hand = record(body.hand) ?? body;
  const outcomeCandidate = record(first(body.outcome, hand.outcome, body.result));
  const outcome = outcomeCandidate && (
    Array.isArray(outcomeCandidate.playerHands) || record(outcomeCandidate.dealer)
  ) ? outcomeCandidate : null;
  return { live: hand, outcome };
}

function blackjackTotal(cards: readonly unknown[]): {
  total: number;
  isSoft: boolean;
} {
  let total = 0;
  let aces = 0;
  for (const raw of cards) {
    const card = record(raw);
    if (!card || card.hidden === true) continue;
    const rank = stringValue(card.rank);
    if (rank === 'A') {
      aces += 1;
      total += 1;
    } else if (['10', 'J', 'Q', 'K'].includes(rank)) {
      total += 10;
    } else {
      total += Number(rank);
    }
  }
  const isSoft = aces > 0 && total + 10 <= 21;
  return { total: total + (isSoft ? 10 : 0), isSoft };
}

function blackjackBanner(outcome: UnknownRecord): string {
  const label = (value: unknown): string => {
    switch (stringValue(value)) {
      case 'blackjack': return 'BLACKJACK!';
      case 'win': return 'YOU WIN';
      case 'push': return 'PUSH';
      case 'surrender': return 'SURRENDER';
      default: return 'YOU LOSE';
    }
  };
  const hands = array(outcome.playerHands);
  return hands.length > 1
    ? hands.map((raw, index) => (
        `Hand ${index + 1}: ${label(record(raw)?.outcome)}`
      )).join(' · ')
    : label(record(hands[0])?.outcome);
}

function blackjackExpected(body: UnknownRecord, dealStep: string): ExpectedParity {
  const { live, outcome } = blackjackPayload(body);
  const playerHands = array(outcome?.playerHands ?? live?.playerHands ?? live?.playerHand);
  const normalizedHands = playerHands.length > 0 && record(playerHands[0])
    && Array.isArray(record(playerHands[0])?.cards)
    ? playerHands
    : playerHands.length > 0
      ? [{ cards: playerHands }]
      : [];
  const slots: Record<string, ExpectedSlot> = {};
  const meta: Record<string, string> = {};
  normalizedHands.forEach((rawHand, handIndex) => {
    const hand = record(rawHand) ?? {};
    const cards = array(hand.cards);
    const derived = blackjackTotal(cards);
    cards.forEach((card, cardIndex) => {
      slots[`player-${handIndex}-card-${cardIndex + 1}`] = up(card);
    });
    const total = first(hand.total, derived.total);
    meta[`player-${handIndex}-total`] = stringValue(total);
    meta[`player-${handIndex}-soft`] = String(
      hand.isSoft === undefined ? derived.isSoft : boolValue(hand.isSoft),
    );
    meta[`player-${handIndex}-bust`] = String(
      hand.isBust === undefined ? Number(total) > 21 : boolValue(hand.isBust),
    );
    meta[`player-${handIndex}-blackjack`] = String(
      boolValue(hand.isBlackjack) || (cards.length === 2 && Number(hand.total) === 21),
    );
    meta[`player-${handIndex}-resolved`] = String(
      outcome !== null || boolValue(hand.isResolved),
    );
    if (dealStep === 'settled' && hand.outcome !== undefined) {
      meta[`outcome-${handIndex}`] = stringValue(hand.outcome);
    }
  });

  const visibleDealerUpcard = first(
    live?.dealerUpcard,
    array(live?.dealerCards)[0],
  );
  const dealer = (dealStep === 'dealer-reveal' || dealStep === 'settled')
    ? record(outcome?.dealer)
    : null;
  if (dealer) {
    array(dealer.cards).forEach((card, index) => {
      slots[`dealer-card-${index + 1}`] = up(card);
    });
    meta['dealer-total'] = stringValue(dealer.total);
  } else {
    const dealerUpcard = first(
      visibleDealerUpcard,
      array(record(outcome?.dealer)?.cards)[0],
    );
    slots['dealer-card-1'] = up(dealerUpcard);
    slots['dealer-card-2'] = down();
  }
  meta['active-slot'] = stringValue(first(live?.activeSlot, body.activeSlot, 0));
  const terminalInsurance = (
    dealStep === 'dealer-reveal' || dealStep === 'settled'
  ) && outcome !== null && Object.hasOwn(outcome, 'insurance')
    // blackjack-engine.ts:966-980,1001-1024 emits null when insurance was not
    // taken and a non-null settlement object when it was.
    ? outcome.insurance !== null
    : false;
  const settledDealerCards = array(record(outcome?.dealer)?.cards);
  const dealerUpcardIsAce = (
    dealStep === 'dealer-reveal' || dealStep === 'settled'
  ) && settledDealerCards.length > 0
    && stringValue(record(settledDealerCards[0])?.rank) === 'A';
  const inProgressInsuranceStep = (
    dealStep === 'hole' || dealStep === 'player-turn' || dealStep === 'split'
  );
  const everyPlayerHandHasTwoCards = normalizedHands.length > 0
    && normalizedHands.every((rawHand) => (
      array(record(rawHand)?.cards).length === 2
    ));
  // cove-blackjack.ts:2432-2435 and :2683-2685 define an offer as an
  // Ace upcard before any main decision. On the resolved wire, exactly two
  // cards in every hand plus didSplit !== true is the noDecisionsYet proxy.
  const inProgressInsuranceOffered = inProgressInsuranceStep
    && stringValue(record(visibleDealerUpcard)?.rank) === 'A'
    && everyPlayerHandHasTwoCards
    && live?.didSplit !== true;
  meta['insurance-offered'] = String(boolValue(first(
    live?.insuranceOffered,
    body.insuranceOffered,
    inProgressInsuranceStep
      ? inProgressInsuranceOffered
      // blackjack-engine.ts:966-980 emits the settled dealer row; an Ace upcard
      // is the authoritative fallback when the terminal shape omits live flags.
      : dealerUpcardIsAce,
  )));
  meta['insurance-taken'] = String(boolValue(first(
    live?.tookInsurance,
    body.tookInsurance,
    terminalInsurance,
  )));
  if (dealStep === 'settled' && outcome) {
    meta['banner-text'] = stringValue(
      first(body.bannerText, outcome.bannerText, blackjackBanner(outcome)),
    );
    // Credited raked net: apps/api/src/services/blackjack-engine.ts:1032.
    meta.net = stringValue(outcome.rakedNet);
  }
  return { slots, meta };
}

const BACCARAT_STEPS = Object.freeze([
  'deal',
  'player-1',
  'banker-1',
  'player-2',
  'banker-2',
  'player-3',
  'banker-3',
  'settled',
] as const);

function baccaratOutcome(body: UnknownRecord): UnknownRecord {
  const lastCoup = record(body.lastCoup);
  return record(first(lastCoup?.outcome, body.outcome, body.coup, body.result)) ?? body;
}

function baccaratExpected(body: UnknownRecord, dealStep: string): ExpectedParity {
  const outcome = baccaratOutcome(body);
  const player = record(outcome.player) ?? {};
  const banker = record(outcome.banker) ?? {};
  const playerCards = array(player.cards);
  const bankerCards = array(banker.cards);
  const stepIndex = BACCARAT_STEPS.indexOf(
    dealStep as (typeof BACCARAT_STEPS)[number],
  );
  const final = dealStep === 'settled';
  const revealed = (side: 'player' | 'banker', index: number): boolean => {
    if (final) return true;
    const named = `${side}-${index + 1}`;
    return stepIndex >= BACCARAT_STEPS.indexOf(
      named as (typeof BACCARAT_STEPS)[number],
    );
  };
  const slots: Record<string, ExpectedSlot> = {};
  for (const [side, cards] of [
    ['player', playerCards],
    ['banker', bankerCards],
  ] as const) {
    for (let index = 0; index < 3; index += 1) {
      slots[`${side}-${index + 1}`] = cards[index] && revealed(side, index)
        ? up(cards[index])
        : empty();
    }
  }
  const meta: Record<string, string> = {
    bet: stringValue(first(outcome.bet, body.bet)),
    stake: stringValue(first(outcome.stake, body.stake)),
  };
  if (final) {
    meta['player-total'] = stringValue(player.total);
    meta['player-natural'] = String(boolValue(player.isNatural));
    meta['banker-total'] = stringValue(banker.total);
    meta['banker-natural'] = String(boolValue(banker.isNatural));
    meta.winner = stringValue(outcome.winner);
    meta.commission = stringValue(outcome.commission);
    meta.net = stringValue(outcome.net);
    const winner = outcome.winner === 'player'
      ? 'PLAYER WINS'
      : outcome.winner === 'banker'
        ? 'BANKER WINS'
        : 'TIE';
    const net = Number(outcome.net);
    const result = net > 0 ? 'YOU WIN' : net === 0 ? 'PUSH' : 'YOU LOSE';
    meta['banner-text'] = stringValue(
      first(outcome.bannerText, body.bannerText, `${winner} · ${result}`),
    );
  }
  const selected = first(
    body.betzoneSelected,
    outcome.betzoneSelected,
    outcome.bet,
    body.bet,
  );
  if (selected !== undefined) meta['betzone-selected'] = stringValue(selected);
  return { slots, meta };
}

function normalizeStatus(value: unknown): string {
  const raw = stringValue(value);
  if (raw === 'out') return 'busted';
  if (raw === 'sitting_out') return 'resolved';
  return raw || 'active';
}

function holdemExpected(
  body: UnknownRecord,
  surface: Surface,
  dealStep: string,
  ba1Snapshot?: unknown,
  root?: CardParityRoot,
  records: readonly WireRecord[] = [],
): ExpectedParity {
  const snapshot = record(ba1Snapshot);
  const directView = record(body.view);
  const viewTable = record(directView?.table);
  const hand = record(first(
    body.hand,
    body.snapshot,
    body.state,
    viewTable,
    body.live,
  )) ?? body;
  const outcome = record(first(body.outcome, hand.outcome, snapshot)) ?? null;
  const terminalIsShowdown = stringValue((snapshot ?? outcome)?.endedAt) === 'showdown';
  let board = array(first(
    snapshot?.board,
    outcome?.board,
    hand.communityCards,
    hand.board,
    body.communityCards,
    body.board,
  ));
  if (surface.includes('-tray-')) {
    const visibleCount = dealStep === 'hole'
      ? 0
      : dealStep === 'flop'
        ? 3
        : dealStep === 'turn'
          ? 4
          : 5;
    board = board.slice(0, visibleCount);
  }
  const slots: Record<string, ExpectedSlot> = {};
  for (let index = 0; index < 5; index += 1) {
    slots[`board-${index + 1}`] = board[index] ? up(board[index]) : empty();
  }

  const tray = surface.includes('-tray-');
  if (tray) {
    const self = record(first(hand.self, body.self));
    const matchingPrivateView = [
      directView,
      ...records.map((candidate) => record(record(candidate.responseBody)?.view)),
    ].find((view) => (
      view
      && Number(view.handNumber) === root?.correlation.handNumber
      && array(view.holeCards).length === 2
    ));
    const terminalSelf = array(outcome?.seats)
      .map(record)
      .find((seat) => seat?.isHuman === true);
    const hole = array(first(
      directView?.holeCards,
      matchingPrivateView?.holeCards,
      self?.holeCards,
      terminalSelf?.holeCards,
      hand.humanHole,
      hand.playerHoleCards,
      hand.holeCards,
      body.playerHoleCards,
      body.holeCards,
    ));
    slots['hole-1'] = hole[0] ? up(hole[0]) : empty();
    slots['hole-2'] = hole[1] ? up(hole[1]) : empty();
    // Keep the tray's frozen order independent of object insertion order.
    const ordered: Record<string, ExpectedSlot> = {
      'hole-1': slots['hole-1']!,
      'hole-2': slots['hole-2']!,
    };
    for (let index = 0; index < 5; index += 1) {
      ordered[`board-${index + 1}`] = slots[`board-${index + 1}`]!;
    }
    return {
      slots: ordered,
      meta: holdemMeta(body, outcome, snapshot, hole),
    };
  }

  let seats = array(first(
    snapshot?.seats,
    outcome?.seats,
    viewTable?.seats,
    hand.seats,
    record(body.live)?.seats,
    body.seats,
  ));
  let selfSeatIndex = surface.endsWith('-practice') ? 0 : Number.NaN;
  if (surface.endsWith('-3d')) {
    const matchingPrivateView = [
      directView,
      ...records.map((candidate) => record(record(candidate.responseBody)?.view)),
    ].find((view) => (
      view
      && Number(view.handNumber) === root?.correlation.handNumber
      && Number.isSafeInteger(Number(view.seatIndex))
    ));
    if (matchingPrivateView) {
      selfSeatIndex = Number(matchingPrivateView.seatIndex);
      const privateTable = record(matchingPrivateView.table);
      if (seats.length === 0) seats = array(privateTable?.seats);
    } else if (snapshot) {
      const self = array(snapshot.seats)
        .map(record)
        .find((seat) => seat?.isHuman === true);
      if (self) selfSeatIndex = Number(first(self.seatIndex, self.seat));
    }
  }
  const bySeat = new Map<number, UnknownRecord>();
  for (const rawSeat of seats) {
    const seat = record(rawSeat);
    const seatIndex = Number(first(seat?.seatIndex, seat?.seat));
    if (seat && Number.isSafeInteger(seatIndex)) bySeat.set(seatIndex, seat);
  }
  const expectedSeatIndices = surface.endsWith('-practice')
    ? [1, 2, 3, 4, 5]
    : [0, 1, 2, 3, 4, 5]
      .filter((seatIndex) => seatIndex !== selfSeatIndex);
  for (const seatIndex of expectedSeatIndices) {
    const occupiedSeat = bySeat.get(seatIndex);
    const seat = occupiedSeat ?? {};
    const status = normalizeStatus(seat.status);
    const cards = array(first(seat.shown, seat.holeCards));
    for (let index = 0; index < 2; index += 1) {
      const key = `opp-${seatIndex}-${index + 1}`;
      if (surface.endsWith('-practice')) {
        slots[key] = terminalIsShowdown && status !== 'folded' && cards[index]
          ? up(cards[index], status)
          : down(status);
      } else if (snapshot) {
        slots[key] = terminalIsShowdown && status !== 'folded' && cards[index]
          ? up(cards[index], status)
          : empty(status);
      } else {
        slots[key] = occupiedSeat
          && (status === 'active' || status === 'allin')
          ? down(status)
          : empty(status);
      }
    }
  }
  if (seats.length === 0 && surface.endsWith('-practice')) {
    const log = array(first(hand.publicActionLog, body.publicActionLog));
    const folded = new Set<number>();
    for (const rawEntry of log) {
      const entry = record(rawEntry);
      if (entry?.type === 'fold') folded.add(Number(entry.seat));
    }
    for (const seatIndex of [1, 2, 3, 4, 5]) {
      const status = folded.has(seatIndex) ? 'folded' : 'active';
      slots[`opp-${seatIndex}-1`] = down(status);
      slots[`opp-${seatIndex}-2`] = down(status);
    }
  }
  const settlementMeta = outcome || snapshot
    ? holdemMeta(
        body,
        outcome,
        snapshot,
        [],
        Number.isSafeInteger(selfSeatIndex) ? selfSeatIndex : undefined,
      )
    : {};
  return {
    slots,
    meta: {
      ...settlementMeta,
      'on-felt': 'true',
      ...(surface.endsWith('-3d') && !Number.isSafeInteger(selfSeatIndex)
        ? { 'wire-self-seat': 'missing' }
        : {}),
    },
  };
}

function holdemMeta(
  body: UnknownRecord,
  outcome: UnknownRecord | null,
  snapshot: UnknownRecord | null,
  ownHole: readonly unknown[],
  ownSeatIndex?: number,
): Record<string, string> {
  if (!outcome && !snapshot) {
    const hand = record(first(
      body.hand,
      record(body.view)?.table,
      body.live,
    )) ?? body;
    const literalPot = first(body.pot, hand.pot);
    const log = array(hand.publicActionLog);
    const bySeatStreet = new Map<string, bigint>();
    for (const rawEntry of log) {
      const entry = record(rawEntry);
      if (!entry) continue;
      const amount = stringValue(entry.amount);
      if (!/^\d+$/.test(amount)) continue;
      bySeatStreet.set(
        `${stringValue(entry.seat)}:${stringValue(entry.street)}`,
        BigInt(amount),
      );
    }
    const derivedPot = [...bySeatStreet.values()]
      .reduce((total, amount) => total + amount, 0n)
      .toString();
    const pot = first(literalPot, log.length > 0 ? derivedPot : undefined);
    return pot === undefined ? {} : { pot: stringValue(pot) };
  }
  const terminal = snapshot ?? outcome ?? {};
  const endedAt = stringValue(terminal.endedAt);
  const winners = new Set<number>();
  for (const rawPot of array(terminal.pots)) {
    const pot = record(rawPot) ?? {};
    for (const winner of array(pot.winners)) winners.add(Number(winner));
    for (const rawAward of array(pot.awards)) {
      const award = record(rawAward);
      if (award) winners.add(Number(award.seatIndex));
    }
  }
  for (const rawSeat of array(terminal.seats)) {
    const seat = record(rawSeat);
    if (seat?.isWinner === true) winners.add(Number(first(seat.seatIndex, seat.seat)));
  }
  const pots = array(terminal.pots);
  const pot = pots.reduce<bigint>((total, rawPot) => {
    const amount = stringValue(record(rawPot)?.amount);
    return total + (amount && /^-?\d+$/.test(amount) ? BigInt(amount) : 0n);
  }, 0n);
  const matchingSeat = array(terminal.seats)
    .map(record)
    .find((seat) => {
      if (!seat) return false;
      if (ownSeatIndex !== undefined) {
        return Number(first(seat.seatIndex, seat.seat)) === ownSeatIndex;
      }
      const shown = array(seat.shown);
      return ownHole.length === 2
        && shown.length === 2
        && shown.every((card, index) => cardCode(card) === cardCode(ownHole[index]));
    });
  const meta: Record<string, string> = {
    outcome: endedAt === 'showdown' ? 'showdown' : 'fold',
    winners: [...winners].filter(Number.isFinite).sort((a, b) => a - b).join(','),
    net: stringValue(first(body.net, terminal.net, matchingSeat?.net)),
    pot: stringValue(first(body.pot, pot.toString())),
  };
  const banner = first(
    body.bannerText,
    terminal.bannerText,
    holdemBanner(terminal, snapshot !== null),
  );
  if (banner !== undefined) meta['banner-text'] = stringValue(banner);
  return meta;
}

function holdemBanner(terminal: UnknownRecord, cash: boolean): string {
  const endedAt = stringValue(terminal.endedAt);
  if (cash) return endedAt === 'showdown' ? 'Showdown' : 'Hand won without showdown';
  const seats = array(terminal.seats).map(record).filter(Boolean) as UnknownRecord[];
  const winnerSeats = new Set<number>();
  for (const rawPot of array(terminal.pots)) {
    const pot = record(rawPot);
    for (const value of array(pot?.winners)) winnerSeats.add(Number(value));
  }
  const winners = seats.filter(
    (seat) => seat.isWinner === true || winnerSeats.has(Number(seat.seat)),
  );
  const name = (seat: number): string => {
    if (seat === 0) return 'YOU';
    return ({ 1: 'Tess', 2: 'Vex', 3: 'Pip', 4: 'Cal', 5: 'Nita' } as const)[
      seat as 1 | 2 | 3 | 4 | 5
    ] ?? `BOT ${seat}`;
  };
  const human = winners.find((seat) => seat.isHuman === true);
  if (endedAt !== 'showdown' && human) {
    return `Everyone folded. You take the pot: +${stringValue(terminal.humanPayout)} vCLAW`;
  }
  if (endedAt !== 'showdown' && winners[0]) {
    return `Everyone else folded. ${name(Number(winners[0].seat))} takes ${stringValue(winners[0].won)} vCLAW`;
  }
  const winnerText = winners.map((winner) => {
    const category = stringValue(winner.handCategoryName);
    const seat = Number(winner.seat);
    const verb = seat === 0 ? 'win' : 'wins';
    return `${name(seat)} ${verb} ${stringValue(winner.won)} vCLAW${category ? ` with ${category}` : ''}`;
  }).join(' · ');
  return `Showdown: ${winnerText || 'pot awarded'}`;
}

export interface ExpectedContext {
  root?: CardParityRoot;
  records?: readonly WireRecord[];
}

export function expectedFromWire(
  game: ParityGame,
  surface: Surface,
  wire: WireRecord,
  ba1Snapshot?: unknown,
  context: ExpectedContext = {},
): ExpectedParity {
  const body = nestedBody(wire);
  const dealStep = context.root?.dealStep ?? 'settled';
  if (game === 'blackjack') return blackjackExpected(body, dealStep);
  if (game === 'baccarat') return baccaratExpected(body, dealStep);
  return holdemExpected(
    body,
    surface,
    dealStep,
    ba1Snapshot,
    context.root,
    context.records,
  );
}

export const cardCodeFromWire = cardCode;
