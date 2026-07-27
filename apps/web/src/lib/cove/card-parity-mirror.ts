import type {
  CashSettledHandSnapshot,
  HoldemSettledResponse,
  SerializedBaccaratCoup,
  SerializedBlackjackHandResult,
} from '@clawville/shared';

export type CardFacing = 'up' | 'down' | 'empty';
export type SlotStatus = 'active' | 'folded' | 'allin' | 'busted' | 'resolved';
export type CardCode = string & { readonly __brand: 'CardCode' };
export type CardParitySlot =
  | { slot: string; facing: 'up'; card: CardCode; status?: SlotStatus }
  | { slot: string; facing: 'down'; card: ''; status?: SlotStatus }
  | { slot: string; facing: 'empty'; card: ''; status?: SlotStatus };

export type Surface =
  | 'holdem-felt-3d'
  | 'holdem-tray-3d'
  | 'holdem-felt-practice'
  | 'holdem-tray-practice'
  | 'blackjack-2d'
  | 'blackjack-3d'
  | 'baccarat-2d'
  | 'baccarat-3d';

export interface Correlation {
  hand: string;
  handNumber: number | null;
  shoe?: string;
}

export interface CardParityPayload {
  surface: Surface;
  version: 2;
  correlation: Correlation;
  dealStep: string;
  phase: string;
  transition: 'idle' | 'revealing' | 'muck-fading';
  slots: CardParitySlot[];
  meta: Record<string, string>;
}

export interface CardParityRoot extends CardParityPayload {
  instanceId: string;
  renderRevision: number;
}

export interface ParityRenderCard {
  suit: 'clubs' | 'diamonds' | 'hearts' | 'spades';
  rank: string;
  hidden?: boolean;
}

export type CardFacingAndCode =
  | { facing: 'up'; card: CardCode }
  | { facing: 'down'; card: '' }
  | { facing: 'empty'; card: '' };

const RANK_CODE: Readonly<Record<string, string>> = Object.freeze({
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
  J: 'J',
  Q: 'Q',
  K: 'K',
});
const SUIT_CODE: Readonly<Record<ParityRenderCard['suit'], string>> = Object.freeze({
  clubs: 'c',
  diamonds: 'd',
  hearts: 'h',
  spades: 's',
});

/** Security-critical sanitizer and the only producer of a branded card code. */
export function encodeCardCode(
  card: ParityRenderCard | null | undefined,
): CardFacingAndCode {
  if (!card) return { facing: 'empty', card: '' };
  if (card.hidden === true) return { facing: 'down', card: '' };
  const rank = RANK_CODE[card.rank];
  const suit = SUIT_CODE[card.suit];
  if (!rank || !suit) {
    throw new Error(`Invalid parity render card: ${card.rank} of ${card.suit}`);
  }
  return { facing: 'up', card: `${rank}${suit}` as CardCode };
}

export type HoldemFeltInput =
  | {
      kind: 'practice';
      board: (ParityRenderCard | null)[];
      opponents: {
        seatIndex: number;
        status: SlotStatus;
        cards: [ParityRenderCard, ParityRenderCard] | null;
        count: number;
        peek: boolean;
      }[];
      correlation: Correlation;
      dealStep: string;
      phase: string;
      transition: CardParityPayload['transition'];
      settled: HoldemSettledResponse | null;
      bannerText?: string;
      pot?: string;
    }
  | {
      kind: 'cash';
      board: ParityRenderCard[];
      opponents: {
        seatIndex: number;
        status: SlotStatus;
        count: number;
        peek: boolean;
      }[];
      settled: CashSettledHandSnapshot | null;
      correlation: Correlation;
      dealStep: string;
      phase: string;
      transition: CardParityPayload['transition'];
      ownSeatIndex: number;
      bannerText?: string;
      pot?: string;
    };

export type HoldemTrayInput =
  | {
      kind: 'practice';
      hole: ParityRenderCard[];
      narratedBoard: (ParityRenderCard | null)[];
      publicSeats: { folded: boolean }[];
      settled: HoldemSettledResponse | null;
      correlation: Correlation;
      dealStep: string;
      phase: string;
      transition: CardParityPayload['transition'];
      bannerText?: string;
      pot?: string;
    }
  | {
      kind: 'cash';
      hole: ParityRenderCard[];
      board: ParityRenderCard[];
      settled: CashSettledHandSnapshot | null;
      correlation: Correlation;
      dealStep: string;
      phase: string;
      transition: CardParityPayload['transition'];
      bannerText?: string;
      pot?: string;
    };

function emptySlot(slot: string, status?: SlotStatus): CardParitySlot {
  return status
    ? { slot, facing: 'empty', card: '', status }
    : { slot, facing: 'empty', card: '' };
}

function downSlot(slot: string, status?: SlotStatus): CardParitySlot {
  return status
    ? { slot, facing: 'down', card: '', status }
    : { slot, facing: 'down', card: '' };
}

function encodedSlot(
  slot: string,
  card: ParityRenderCard | null | undefined,
  status?: SlotStatus,
): CardParitySlot {
  const encoded = encodeCardCode(card);
  if (encoded.facing === 'up') {
    return status
      ? { slot, facing: 'up', card: encoded.card, status }
      : { slot, facing: 'up', card: encoded.card };
  }
  return encoded.facing === 'down' ? downSlot(slot, status) : emptySlot(slot, status);
}

function holdemSurface(kind: HoldemFeltInput['kind'], layer: 'felt' | 'tray'): Surface {
  return kind === 'practice' ? `holdem-${layer}-practice` : `holdem-${layer}-3d`;
}

export function buildHoldemFeltParity(i: HoldemFeltInput): CardParityPayload {
  const slots: CardParitySlot[] = [];
  for (let index = 0; index < 5; index += 1) {
    slots.push(encodedSlot(`board-${index + 1}`, i.board[index]));
  }

  const opponents = [...i.opponents].sort((a, b) => a.seatIndex - b.seatIndex);
  for (const opponent of opponents) {
    const cashShown = i.kind === 'cash'
      ? i.settled?.seats.find((seat) => seat.seatIndex === opponent.seatIndex)?.shown ?? null
      : null;
    for (let cardIndex = 0; cardIndex < 2; cardIndex += 1) {
      const slot = `opp-${opponent.seatIndex}-${cardIndex + 1}`;
      if (
        i.kind === 'practice'
        && 'cards' in opponent
        && opponent.cards
        && opponent.status !== 'folded'
        && !opponent.peek
      ) {
        slots.push(encodedSlot(slot, opponent.cards[cardIndex], opponent.status));
      } else if (
        i.kind === 'cash'
        && cashShown
        && opponent.status !== 'folded'
        && !opponent.peek
      ) {
        slots.push(encodedSlot(slot, cashShown[cardIndex], opponent.status));
      } else if (opponent.count > cardIndex || opponent.peek) {
        slots.push(downSlot(slot, opponent.status));
      } else {
        slots.push(emptySlot(slot, opponent.status));
      }
    }
  }
  const meta = i.settled
    ? settledHoldemMeta(
        i.settled,
        i.bannerText,
        i.pot,
        undefined,
        i.kind === 'cash' ? i.ownSeatIndex : undefined,
      )
    : {
        ...(i.pot === undefined ? {} : { pot: i.pot }),
        ...(i.bannerText === undefined ? {} : { 'banner-text': i.bannerText }),
      };

  return {
    surface: holdemSurface(i.kind, 'felt'),
    version: 2,
    correlation: i.correlation,
    dealStep: i.dealStep,
    phase: i.phase,
    transition: i.transition,
    slots,
    meta,
  };
}

function settledHoldemMeta(
  settled: HoldemSettledResponse | CashSettledHandSnapshot,
  bannerText?: string,
  potOverride?: string,
  ownHole?: ParityRenderCard[],
  ownSeatIndex?: number,
): Record<string, string> {
  if ('outcome' in settled) {
    const winners = new Set<number>();
    for (const pot of settled.outcome.pots) {
      for (const winner of pot.winners) winners.add(winner);
    }
    for (const seat of settled.outcome.seats) {
      if (seat.isWinner) winners.add(seat.seat);
    }
    const pot = potOverride ?? settled.outcome.pots
      .reduce((total, item) => total + BigInt(item.amount), 0n)
      .toString();
    return {
      outcome: settled.outcome.endedAt === 'showdown' ? 'showdown' : 'fold',
      winners: [...winners].sort((a, b) => a - b).join(','),
      net: settled.net,
      pot,
      ...(bannerText === undefined ? {} : { 'banner-text': bannerText }),
    };
  }

  const winners = new Set<number>();
  for (const pot of settled.pots) {
    for (const award of pot.awards) winners.add(award.seatIndex);
  }
  const matchingSeat = ownSeatIndex === undefined
    ? ownHole?.length === 2
      ? settled.seats.find((seat) => seat.shown?.every((card, index) => (
          card.suit === ownHole[index]?.suit && card.rank === ownHole[index]?.rank
        )))
      : undefined
    : settled.seats.find((seat) => seat.seatIndex === ownSeatIndex);
  return {
    outcome: settled.endedAt === 'showdown' ? 'showdown' : 'fold',
    winners: [...winners].sort((a, b) => a - b).join(','),
    net: matchingSeat?.net ?? '',
    pot: potOverride ?? settled.pots
      .reduce((total, item) => total + BigInt(item.amount), 0n)
      .toString(),
    ...(bannerText === undefined ? {} : { 'banner-text': bannerText }),
  };
}

export function buildHoldemTrayParity(i: HoldemTrayInput): CardParityPayload {
  const slots: CardParitySlot[] = [];
  for (let index = 0; index < 2; index += 1) {
    slots.push(encodedSlot(`hole-${index + 1}`, i.hole[index]));
  }
  const board = i.kind === 'practice' ? i.narratedBoard : i.board;
  for (let index = 0; index < 5; index += 1) {
    slots.push(encodedSlot(`board-${index + 1}`, board[index]));
  }
  const meta = i.settled
    ? settledHoldemMeta(i.settled, i.bannerText, i.pot, i.hole)
    : {
        ...(i.pot === undefined ? {} : { pot: i.pot }),
        ...(i.bannerText === undefined ? {} : { 'banner-text': i.bannerText }),
      };

  return {
    surface: holdemSurface(i.kind, 'tray'),
    version: 2,
    correlation: i.correlation,
    dealStep: i.dealStep,
    phase: i.phase,
    transition: i.transition,
    slots,
    meta,
  };
}

export function buildBlackjackParity(i: {
  hand: {
    playerHands: {
      cards: ParityRenderCard[];
      total: number;
      isSoft: boolean;
      isBust: boolean;
      isResolved: boolean;
    }[];
    dealerUpcard: ParityRenderCard | null;
    insuranceOffered: boolean;
    tookInsurance: boolean;
    didSplit: boolean;
  } | null;
  settled: { outcome: SerializedBlackjackHandResult } | null;
  activeSlot: 0 | 1;
  surface: 'blackjack-2d' | 'blackjack-3d';
  correlation: Correlation;
  dealStep: string;
  phase: string;
  transition: CardParityPayload['transition'];
  bannerText?: string;
}): CardParityPayload {
  const slots: CardParitySlot[] = [];
  const meta: Record<string, string> = {
    'active-slot': String(i.activeSlot),
    'insurance-offered': String(i.hand?.insuranceOffered ?? false),
    'insurance-taken': String(i.hand?.tookInsurance ?? false),
  };
  const playerHands = i.settled?.outcome.playerHands ?? i.hand?.playerHands ?? [];
  for (let handIndex = 0; handIndex < playerHands.length; handIndex += 1) {
    const hand = playerHands[handIndex]!;
    for (let cardIndex = 0; cardIndex < hand.cards.length; cardIndex += 1) {
      slots.push(encodedSlot(`player-${handIndex}-card-${cardIndex + 1}`, hand.cards[cardIndex]));
    }
    meta[`player-${handIndex}-total`] = String(hand.total);
    meta[`player-${handIndex}-soft`] = String(hand.isSoft);
    meta[`player-${handIndex}-bust`] = String(hand.isBust);
    meta[`player-${handIndex}-blackjack`] = String(
      'isBlackjack' in hand ? hand.isBlackjack : hand.cards.length === 2 && hand.total === 21,
    );
    meta[`player-${handIndex}-resolved`] = String(
      'outcome' in hand ? true : hand.isResolved,
    );
    if ('outcome' in hand && i.dealStep === 'settled') {
      meta[`outcome-${handIndex}`] = hand.outcome;
    }
  }

  if (i.settled) {
    for (let cardIndex = 0; cardIndex < i.settled.outcome.dealer.cards.length; cardIndex += 1) {
      slots.push(encodedSlot(
        `dealer-card-${cardIndex + 1}`,
        i.settled.outcome.dealer.cards[cardIndex],
      ));
    }
    meta['dealer-total'] = String(i.settled.outcome.dealer.total);
  } else {
    slots.push(encodedSlot('dealer-card-1', i.hand?.dealerUpcard));
    slots.push(i.hand ? downSlot('dealer-card-2') : emptySlot('dealer-card-2'));
  }
  if (i.dealStep === 'settled' && i.bannerText !== undefined) {
    meta['banner-text'] = i.bannerText;
  }
  if (i.dealStep === 'settled' && i.settled) {
    meta.net = i.settled.outcome.rakedNet ?? '';
  }

  return {
    surface: i.surface,
    version: 2,
    correlation: i.correlation,
    dealStep: i.dealStep,
    phase: i.phase,
    transition: i.transition,
    slots,
    meta,
  };
}

export function buildBaccaratParity(i: {
  outcome: SerializedBaccaratCoup | null;
  bet: 'player' | 'banker' | 'tie';
  stake: number;
  surface: 'baccarat-2d' | 'baccarat-3d';
  correlation: Correlation;
  dealStep: string;
  phase: string;
  transition: CardParityPayload['transition'];
  bannerText?: string;
  betzoneSelected?: string;
}): CardParityPayload {
  const slots: CardParitySlot[] = [];
  for (const side of ['player', 'banker'] as const) {
    for (let index = 0; index < 3; index += 1) {
      slots.push(encodedSlot(`${side}-${index + 1}`, i.outcome?.[side].cards[index]));
    }
  }
  const meta: Record<string, string> = {
    bet: i.outcome?.bet ?? i.bet,
    stake: i.outcome?.stake ?? String(i.stake),
  };
  if (i.outcome) {
    meta['player-total'] = String(i.outcome.player.total);
    meta['player-natural'] = String(i.outcome.player.isNatural);
    meta['banker-total'] = String(i.outcome.banker.total);
    meta['banker-natural'] = String(i.outcome.banker.isNatural);
    meta.winner = i.outcome.winner;
    meta.commission = i.outcome.commission;
    meta.net = i.outcome.net;
  }
  if (i.bannerText !== undefined) meta['banner-text'] = i.bannerText;
  if (i.betzoneSelected !== undefined) meta['betzone-selected'] = i.betzoneSelected;

  return {
    surface: i.surface,
    version: 2,
    correlation: i.correlation,
    dealStep: i.dealStep,
    phase: i.phase,
    transition: i.transition,
    slots,
    meta,
  };
}

interface ParityStoreEntry {
  instanceId: string;
  revision: number;
  cachedRoot: CardParityRoot;
  signature: string;
  activeSpan: number | null;
  activeTransition: 'revealing' | 'muck-fading' | null;
}

export interface ParityJournalEntry {
  surface: Surface;
  instanceId: string;
  revision: number;
  dealStep: string;
  transition: CardParityRoot['transition'];
  signature: string;
  ts: number;
}

const STORE = new Map<Surface, ParityStoreEntry>();
const SUBSCRIBERS = new Map<Surface, Set<() => void>>();
const JOURNAL: ParityJournalEntry[] = [];
const JOURNAL_CAP = 256;
let nextRevision = 1;
let nextSpanToken = 1;

const SURFACE_SLOT_CAP: Readonly<Record<Surface, number>> = Object.freeze({
  'holdem-felt-3d': 16,
  'holdem-tray-3d': 7,
  'holdem-felt-practice': 16,
  'holdem-tray-practice': 7,
  'blackjack-2d': 64,
  'blackjack-3d': 64,
  'baccarat-2d': 6,
  'baccarat-3d': 6,
});

function canonicalSignature(payload: CardParityPayload): string {
  const meta = Object.keys(payload.meta)
    .sort()
    .map((key) => [key, payload.meta[key]]);
  return JSON.stringify([
    payload.surface,
    payload.version,
    payload.correlation.hand,
    payload.correlation.handNumber,
    payload.correlation.shoe ?? '',
    payload.dealStep,
    payload.phase,
    payload.transition,
    payload.slots.map((slot) => [slot.slot, slot.facing, slot.card, slot.status ?? '']),
    meta,
  ]);
}

function notify(surface: Surface): void {
  for (const callback of SUBSCRIBERS.get(surface) ?? []) callback();
}

function appendJournal(root: CardParityRoot, signature: string): void {
  JOURNAL.push({
    surface: root.surface,
    instanceId: root.instanceId,
    revision: root.renderRevision,
    dealStep: root.dealStep,
    transition: root.transition,
    signature,
    ts: Date.now(),
  });
  if (JOURNAL.length > JOURNAL_CAP) JOURNAL.splice(0, JOURNAL.length - JOURNAL_CAP);
}

function acceptRoot(
  entry: ParityStoreEntry | null,
  instanceId: string,
  payload: CardParityPayload,
  force = false,
): number {
  if (payload.slots.length > SURFACE_SLOT_CAP[payload.surface]) {
    throw new Error(
      `${payload.surface} parity slot cap exceeded: ${payload.slots.length} > ${SURFACE_SLOT_CAP[payload.surface]}`,
    );
  }
  const signature = canonicalSignature(payload);
  if (!force && entry?.signature === signature) return entry.revision;
  const revision = nextRevision;
  nextRevision += 1;
  const root: CardParityRoot = { ...payload, instanceId, renderRevision: revision };
  const nextEntry: ParityStoreEntry = entry
    ? { ...entry, revision, cachedRoot: root, signature }
    : {
        instanceId,
        revision,
        cachedRoot: root,
        signature,
        activeSpan: null,
        activeTransition: null,
      };
  STORE.set(payload.surface, nextEntry);
  appendJournal(root, signature);
  installWindowAccessors();
  notify(payload.surface);
  return revision;
}

export function publishFeltParity(instanceId: string, payload: CardParityPayload): number {
  const entry = STORE.get(payload.surface) ?? null;
  if (entry && entry.instanceId !== instanceId) return entry.revision;
  const effectivePayload = entry?.activeTransition
    ? { ...payload, transition: entry.activeTransition }
    : payload;
  return acceptRoot(entry, instanceId, effectivePayload);
}

export function beginTransition(
  instanceId: string,
  surface: Surface,
  kind: 'revealing' | 'muck-fading',
): number {
  const spanToken = nextSpanToken;
  nextSpanToken += 1;
  const entry = STORE.get(surface);
  if (!entry || entry.instanceId !== instanceId) return spanToken;
  entry.activeSpan = spanToken;
  entry.activeTransition = kind;
  acceptRoot(entry, instanceId, { ...entry.cachedRoot, transition: kind }, true);
  return spanToken;
}

export function completeTransition(
  instanceId: string,
  surface: Surface,
  spanToken: number,
): boolean {
  const entry = STORE.get(surface);
  if (!entry || entry.instanceId !== instanceId || entry.activeSpan !== spanToken) return false;
  entry.activeSpan = null;
  entry.activeTransition = null;
  acceptRoot(entry, instanceId, { ...entry.cachedRoot, transition: 'idle' }, true);
  return true;
}

export function clearFeltParity(instanceId: string): void {
  const cleared: Surface[] = [];
  for (const [surface, entry] of STORE) {
    if (entry.instanceId !== instanceId) continue;
    STORE.delete(surface);
    cleared.push(surface);
  }
  for (const surface of cleared) notify(surface);
}

export function subscribeFeltParity(surface: Surface, cb: () => void): () => void {
  installWindowAccessors();
  let callbacks = SUBSCRIBERS.get(surface);
  if (!callbacks) {
    callbacks = new Set();
    SUBSCRIBERS.set(surface, callbacks);
  }
  callbacks.add(cb);
  return () => {
    callbacks?.delete(cb);
    if (callbacks?.size === 0) SUBSCRIBERS.delete(surface);
  };
}

export function getParitySnapshot(surface: Surface): CardParityRoot | null {
  installWindowAccessors();
  return STORE.get(surface)?.cachedRoot ?? null;
}

declare global {
  interface Window {
    __CV_READ_PARITY?: (surface: Surface) => CardParityRoot | null;
    __CV_PARITY_JOURNAL?: (surface: Surface) => ParityJournalEntry[];
  }
}

function installWindowAccessors(): void {
  if (typeof window === 'undefined') return;
  window.__CV_READ_PARITY = getParitySnapshot;
  window.__CV_PARITY_JOURNAL = (surface) => JOURNAL
    .filter((entry) => entry.surface === surface)
    .map((entry) => ({ ...entry }));
}
