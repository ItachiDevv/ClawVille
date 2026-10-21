/**
 * Hold'em CASH table: pure display helpers for the room HUD (2026-10-21,
 * "everything visible on screen"). No React, no fetch, no money logic. The
 * HUD feeds these the public snapshot / settled snapshot and renders the
 * result. Every input is public table info, plus (optionally) the viewer's
 * OWN cached hole cards.
 *
 * Copy rules: currency is "vCLAW", no em dashes, plain hyphen or a period.
 */

import type {
  CashHandActionLogEntry,
  CashPokerCard,
  CashSettledSeatView,
  CashSettledView,
} from './cash-poker';

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

const SUIT_GLYPH: Readonly<Record<CashPokerCard['suit'], string>> = {
  clubs: '♣',
  diamonds: '♦',
  hearts: '♥',
  spades: '♠',
};

/** "J♣", "10♥". */
export function formatCashCard(card: CashPokerCard): string {
  return `${card.rank}${SUIT_GLYPH[card.suit] ?? ''}`;
}

/** Chip count for display. Accepts the wire's number or bigint string. */
export function formatChips(value: number | string): string {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(value);
}

/** Signed net, e.g. "+20" / "-20" / "0". */
export function formatNet(value: number | string): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('en-US')}`;
}

/** "two_pair" / "Two Pair" -> "Two pair". Empty input -> "". */
export function humanizeHandRank(categoryName: string | null | undefined): string {
  if (!categoryName) return '';
  const text = categoryName.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return text ? text[0]!.toUpperCase() + text.slice(1) : '';
}

/** Whole seconds until `atMs` (never negative). Null when `atMs` is absent. */
export function secondsUntilMs(atMs: number | null | undefined, nowMs: number): number | null {
  if (atMs == null || !Number.isFinite(atMs)) return null;
  return Math.max(0, Math.ceil((atMs - nowMs) / 1_000));
}

// ---------------------------------------------------------------------------
// Action log accumulation (dedupe by seq, keyed by handNumber)
// ---------------------------------------------------------------------------

export interface CashHandFeedHand {
  handNumber: number;
  /** Sorted by seq, unique seq. */
  entries: readonly CashHandActionLogEntry[];
  /** Longest board seen for this hand (the board only grows). */
  board: readonly CashPokerCard[];
}

export interface CashHandFeedStore {
  /** The hand the feed shows: the newest hand that has at least one action. */
  current: CashHandFeedHand | null;
  /** The hand before `current`, kept so a late settled log can still merge. */
  previous: CashHandFeedHand | null;
}

export const EMPTY_CASH_FEED: CashHandFeedStore = Object.freeze({ current: null, previous: null });

function sameEntry(a: CashHandActionLogEntry, b: CashHandActionLogEntry): boolean {
  return a.seq === b.seq && a.seatIndex === b.seatIndex && a.street === b.street
    && a.kind === b.kind && a.chips === b.chips && a.streetBetAfter === b.streetBetAfter
    && a.allIn === b.allIn && a.timeout === b.timeout;
}

function mergeHand(
  hand: CashHandFeedHand,
  incoming: readonly CashHandActionLogEntry[],
  board: readonly CashPokerCard[],
): CashHandFeedHand {
  const bySeq = new Map<number, CashHandActionLogEntry>();
  for (const entry of hand.entries) bySeq.set(entry.seq, entry);
  let changed = false;
  for (const entry of incoming) {
    const existing = bySeq.get(entry.seq);
    if (!existing || !sameEntry(existing, entry)) {
      bySeq.set(entry.seq, entry);
      changed = true;
    }
  }
  const nextBoard = board.length > hand.board.length ? board : hand.board;
  if (!changed && nextBoard === hand.board) return hand;
  const entries = changed ? [...bySeq.values()].sort((a, b) => a.seq - b.seq) : hand.entries;
  return { handNumber: hand.handNumber, entries, board: nextBoard };
}

/**
 * Fold one poll's action log into the store. The server log is the full hand,
 * so merging by `seq` only protects against a reordered or partial response.
 *
 * - An empty log never switches hands: the last finished hand stays visible
 *   until the next hand's first action arrives.
 * - A newer hand number moves `current` to `previous`.
 * - An older hand number merges into `previous` when it matches (a settled
 *   log that arrives after the next deal), otherwise it is ignored.
 * - Returns the SAME store object when nothing changed (React state bail-out).
 */
export function mergeCashHandFeed(
  store: CashHandFeedStore,
  handNumber: number,
  incoming: readonly CashHandActionLogEntry[] | null | undefined,
  board: readonly CashPokerCard[] = [],
): CashHandFeedStore {
  const actions = incoming ?? [];
  const { current, previous } = store;
  if (current && current.handNumber === handNumber) {
    const merged = mergeHand(current, actions, board);
    return merged === current ? store : { current: merged, previous };
  }
  if (actions.length === 0) return store;
  if (!current || handNumber > current.handNumber) {
    const fresh = mergeHand({ handNumber, entries: [], board: [] }, actions, board);
    return { current: fresh, previous: current };
  }
  if (previous && previous.handNumber === handNumber) {
    const merged = mergeHand(previous, actions, board);
    return merged === previous ? store : { current, previous: merged };
  }
  return store;
}

// ---------------------------------------------------------------------------
// Feed lines
// ---------------------------------------------------------------------------

export type CashFeedStreet = CashHandActionLogEntry['street'];

const STREET_ORDER: readonly CashFeedStreet[] = ['preflop', 'flop', 'turn', 'river'];
const STREET_TITLE: Readonly<Record<Exclude<CashFeedStreet, 'preflop'>, string>> = {
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
};
/** Board length once a street is dealt. */
const STREET_BOARD_LEN: Readonly<Record<Exclude<CashFeedStreet, 'preflop'>, number>> = {
  flop: 3,
  turn: 4,
  river: 5,
};

export interface CashFeedLine {
  key: string;
  kind: 'action' | 'street';
  text: string;
  /** The viewer's own seat acted. */
  isYou: boolean;
  /** The server turn clock acted for the seat. */
  timeout: boolean;
}

/** Resolve a seat's display name. `youSeatIndex` is null for a spectator. */
export type CashSeatNamer = (seatIndex: number) => string;

function streetLine(street: Exclude<CashFeedStreet, 'preflop'>, board: readonly CashPokerCard[]): CashFeedLine {
  const end = STREET_BOARD_LEN[street];
  const start = street === 'flop' ? 0 : end - 1;
  const cards = board.slice(start, end);
  const text = cards.length > 0
    ? `${STREET_TITLE[street]}: ${cards.map(formatCashCard).join(' ')}`
    : STREET_TITLE[street];
  return { key: `street-${street}`, kind: 'street', text, isYou: false, timeout: false };
}

/** One human-readable line for one action. "You" for the viewer's seat. */
export function formatCashActionLine(
  entry: CashHandActionLogEntry,
  nameOf: CashSeatNamer,
  youSeatIndex: number | null,
): string {
  const you = youSeatIndex != null && entry.seatIndex === youSeatIndex;
  const name = you ? 'You' : nameOf(entry.seatIndex);
  const verb = (base: string, third: string) => (you ? base : third);
  const allIn = entry.allIn ? ' (all in)' : '';
  switch (entry.kind) {
    case 'post-sb':
      return `${name} ${verb('post', 'posts')} small blind ${formatChips(entry.chips)}${allIn}`;
    case 'post-bb':
      return `${name} ${verb('post', 'posts')} big blind ${formatChips(entry.chips)}${allIn}`;
    case 'fold':
      return entry.timeout ? `${name} timed out. Auto-folded` : `${name} ${verb('fold', 'folds')}`;
    case 'check':
      return entry.timeout ? `${name} timed out. Auto-checked` : `${name} ${verb('check', 'checks')}`;
    case 'call':
      return `${name} ${verb('call', 'calls')} ${formatChips(entry.chips)}${allIn}`;
    case 'bet':
      return `${name} ${verb('bet', 'bets')} ${formatChips(entry.streetBetAfter)}${allIn}`;
    case 'raise':
      return `${name} ${verb('raise', 'raises')} to ${formatChips(entry.streetBetAfter)}${allIn}`;
    default:
      return `${name} acts`;
  }
}

/**
 * The feed for one hand: action lines in seq order, with a street separator
 * (listing the new board cards) before the first action of each street, and
 * trailing separators for streets dealt with no action yet (a fresh flop or
 * an all-in run-out).
 */
export function buildCashFeedLines(
  entries: readonly CashHandActionLogEntry[],
  board: readonly CashPokerCard[],
  nameOf: CashSeatNamer,
  youSeatIndex: number | null,
): CashFeedLine[] {
  const lines: CashFeedLine[] = [];
  let streetsShown = 0; // index into STREET_ORDER of the last separator emitted
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  for (const entry of sorted) {
    const streetIndex = Math.max(0, STREET_ORDER.indexOf(entry.street));
    while (streetsShown < streetIndex) {
      streetsShown += 1;
      lines.push(streetLine(STREET_ORDER[streetsShown] as Exclude<CashFeedStreet, 'preflop'>, board));
    }
    lines.push({
      key: `action-${entry.seq}`,
      kind: 'action',
      text: formatCashActionLine(entry, nameOf, youSeatIndex),
      isYou: youSeatIndex != null && entry.seatIndex === youSeatIndex,
      timeout: entry.timeout,
    });
  }
  while (streetsShown < 3) {
    const next = STREET_ORDER[streetsShown + 1] as Exclude<CashFeedStreet, 'preflop'>;
    if (board.length < STREET_BOARD_LEN[next]) break;
    streetsShown += 1;
    lines.push(streetLine(next, board));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Seat badges: last action this street
// ---------------------------------------------------------------------------

export interface CashSeatLastAction {
  label: string;
  timeout: boolean;
  /** True when the label already states the street bet (bet / raise). */
  statesAmount: boolean;
}

/** Badge label for one action. Blind posts return null (the SB/BB chip covers them). */
export function seatActionLabel(entry: CashHandActionLogEntry): CashSeatLastAction | null {
  switch (entry.kind) {
    case 'fold':
      return { label: entry.timeout ? 'Timed out' : 'Folded', timeout: entry.timeout, statesAmount: false };
    case 'check':
      return { label: entry.timeout ? 'Timed out' : 'Checked', timeout: entry.timeout, statesAmount: false };
    case 'call':
      return { label: 'Called', timeout: false, statesAmount: false };
    case 'bet':
      return { label: `Bet ${formatChips(entry.streetBetAfter)}`, timeout: false, statesAmount: true };
    case 'raise':
      return { label: `Raised to ${formatChips(entry.streetBetAfter)}`, timeout: false, statesAmount: true };
    default:
      return null;
  }
}

/**
 * Each seat's latest non-blind action on `street`. A fold on an earlier
 * street is also kept (a folded seat stays "Folded" for the rest of the hand).
 */
export function lastCashActionBySeat(
  entries: readonly CashHandActionLogEntry[],
  street: string,
): Map<number, CashSeatLastAction> {
  const out = new Map<number, CashSeatLastAction>();
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  for (const entry of sorted) {
    if (entry.street !== street && entry.kind !== 'fold') continue;
    const label = seatActionLabel(entry);
    if (label) out.set(entry.seatIndex, label);
  }
  return out;
}

/** Timeout notice copy for the viewer's own seat, or null. */
export function ownTimeoutNotice(entry: CashHandActionLogEntry): string | null {
  if (!entry.timeout) return null;
  if (entry.kind === 'fold') return 'Time ran out. You were auto-folded';
  if (entry.kind === 'check') return 'Time ran out. You were auto-checked';
  return 'Time ran out. The server acted for you';
}

// ---------------------------------------------------------------------------
// Settled result summary
// ---------------------------------------------------------------------------

export interface CashSettledPotWinner {
  seatIndex: number;
  name: string;
  isYou: boolean;
  amount: number;
}

export interface CashSettledPotLine {
  key: string;
  label: string;
  amount: number;
  winners: CashSettledPotWinner[];
  rankLabel: string | null;
  text: string;
  /**
   * True when this pot is one seat's own uncalled excess, returned to it.
   * Nobody won it, so its seat does not count as a winner for this pot.
   */
  refund: boolean;
  /**
   * Chips of this pot that were one seat's uncalled excess, returned to it
   * (0 for a normal pot; equals `amount` when `refund` is true). The engine
   * merges levels with the same eligible seats, so a fold-out pot can hold
   * both won chips and a returned excess.
   */
  returned: number;
}

export interface CashSettledSeatLine {
  seatIndex: number;
  name: string;
  isYou: boolean;
  folded: boolean;
  isWinner: boolean;
  cards: readonly CashPokerCard[] | null;
  rankLabel: string | null;
  /** The five cards that make the shown hand (server order); null when not shown. */
  bestFive: readonly CashPokerCard[] | null;
  net: number;
  endStack: number;
}

export interface CashSettledSummary {
  handNumber: number;
  showdown: boolean;
  headline: string;
  /** One sentence for the compact strip and for the no-showdown case. */
  summaryText: string;
  totalPot: number;
  pots: CashSettledPotLine[];
  seats: CashSettledSeatLine[];
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function parseChipsBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Chips of `pot` that are the uncalled excess of its only eligible seat S:
 * only the LAST pot with exactly one eligible seat can hold them, and the
 * excess is S.totalCommitted minus the largest totalCommitted of every other
 * seat (folded seats included), capped at the pot amount. 0n otherwise, or when
 * a value does not parse. The rest of the pot (other seats' chips) is a win.
 */
function uncalledReturnedChips(
  pot: CashSettledView['pots'][number],
  index: number,
  settled: CashSettledView,
): bigint {
  if (index !== settled.pots.length - 1) return 0n;
  if (pot.eligibleSeatIndices.length !== 1) return 0n;
  const ownerIndex = pot.eligibleSeatIndices[0]!;
  const owner = settled.seats.find((seat) => seat.seatIndex === ownerIndex);
  if (!owner) return 0n;
  const amount = parseChipsBigInt(pot.amount);
  const ownerCommitted = parseChipsBigInt(owner.totalCommitted);
  if (amount == null || ownerCommitted == null || amount <= 0n) return 0n;
  let maxOther = 0n;
  for (const seat of settled.seats) {
    if (seat.seatIndex === ownerIndex) continue;
    const committed = parseChipsBigInt(seat.totalCommitted);
    if (committed == null) return 0n;
    if (committed > maxOther) maxOther = committed;
  }
  const excess = ownerCommitted - maxOther;
  if (excess <= 0n) return 0n;
  return excess < amount ? excess : amount;
}

/** Name resolver for settled seats: wire name, then a caller fallback. */
export type CashSettledSeatNamer = (seat: CashSettledSeatView) => string;

/**
 * Build the result panel's data from the authoritative settled snapshot.
 * `youSeatIndex` is null for a spectator. `ownCards` are the viewer's cached
 * hole cards for this hand (shown only on the viewer's own row, only when the
 * server did not already include them).
 */
export function summarizeCashSettled(
  settled: CashSettledView,
  nameOf: CashSettledSeatNamer,
  youSeatIndex: number | null,
  ownCards: readonly CashPokerCard[] | null = null,
): CashSettledSummary {
  const seatByIndex = new Map(settled.seats.map((seat) => [seat.seatIndex, seat]));
  const isYou = (seatIndex: number) => youSeatIndex != null && seatIndex === youSeatIndex;
  const displayName = (seatIndex: number) => {
    if (isYou(seatIndex)) return 'You';
    const seat = seatByIndex.get(seatIndex);
    return seat ? nameOf(seat) : `Seat ${seatIndex + 1}`;
  };
  const showdown = settled.endedAt === 'showdown';
  const winnerSeats = new Set<number>();
  const returnedNotes: string[] = [];
  const pots: CashSettledPotLine[] = settled.pots.map((pot, index) => {
    const returnedChips = uncalledReturnedChips(pot, index, settled);
    const refund = returnedChips > 0n && returnedChips === parseChipsBigInt(pot.amount);
    const returned = Number(returnedChips);
    const bySeat = new Map<number, number>();
    for (const award of pot.awards) {
      bySeat.set(award.seatIndex, (bySeat.get(award.seatIndex) ?? 0) + Number(award.amount));
      if (!refund) winnerSeats.add(award.seatIndex);
    }
    const winners = [...bySeat.entries()].map(([seatIndex, amount]) => ({
      seatIndex,
      name: displayName(seatIndex),
      isYou: isYou(seatIndex),
      amount,
    }));
    const label = settled.pots.length > 1 ? (index === 0 ? 'Main pot' : `Side pot ${index}`) : 'Pot';
    const amount = Number(pot.amount);
    const returnedText = returned > 0
      ? `${formatChips(returned)} vCLAW returned to ${isYou(pot.eligibleSeatIndices[0]!) ? 'you' : displayName(pot.eligibleSeatIndices[0]!)} (no one called)`
      : '';
    if (returnedText) returnedNotes.push(returnedText);
    if (refund) {
      const text = `${label}: ${returnedText}`;
      return { key: `pot-${index}`, label, amount, winners, rankLabel: null, text, refund, returned };
    }
    const wonAmount = amount - returned;
    const rankLabel = pot.winningRank ? humanizeHandRank(pot.winningRank.categoryName) || null : null;
    const names = joinNames(winners.map((winner) => winner.name));
    const youOnly = winners.length === 1 && winners[0]!.isYou;
    const verb = winners.length > 1 ? 'split' : youOnly ? 'win' : 'wins';
    const text = (winners.length === 0
      ? `${label} ${formatChips(amount)} vCLAW`
      : `${label}: ${names} ${verb} ${formatChips(wonAmount)} vCLAW${rankLabel ? ` with ${rankLabel}` : ''}`)
      + (returnedText ? `. ${returnedText}` : '');
    return { key: `pot-${index}`, label, amount, winners, rankLabel, text, refund, returned };
  });
  const totalPot = pots.reduce((total, pot) => total + pot.amount, 0);

  const seats: CashSettledSeatLine[] = [...settled.seats]
    .sort((a, b) => a.seatIndex - b.seatIndex)
    .map((seat) => {
      const folded = seat.status === 'folded' || seat.mucked;
      const own = isYou(seat.seatIndex);
      const cards = seat.shown ?? (own && ownCards && ownCards.length === 2 ? ownCards : null);
      return {
        seatIndex: seat.seatIndex,
        name: displayName(seat.seatIndex),
        isYou: own,
        folded,
        isWinner: winnerSeats.has(seat.seatIndex),
        cards,
        rankLabel: folded ? null : humanizeHandRank(seat.handRank?.categoryName) || null,
        bestFive: !folded && seat.handRank?.bestFive?.length === 5 ? seat.handRank.bestFive : null,
        net: Number(seat.net),
        endStack: Number(seat.endStack),
      };
    });

  let summaryText: string;
  if (!showdown) {
    const winnerNames = [...winnerSeats].sort((a, b) => a - b).map(displayName);
    const youOnly = winnerSeats.size === 1 && isYou([...winnerSeats][0]!);
    // An uncalled bet is returned, not won: keep it out of the "wins" amount.
    const wonPot = pots.reduce((total, pot) => total + pot.amount - pot.returned, 0);
    const refundText = returnedNotes.map((note) => `. ${note}`).join('');
    summaryText = winnerNames.length > 0
      ? `${joinNames(winnerNames)} ${youOnly ? 'win' : winnerNames.length > 1 ? 'split' : 'wins'} ${formatChips(wonPot)} vCLAW. Everyone else folded${refundText}`
      : `Hand ended before showdown. Pot ${formatChips(totalPot)} vCLAW`;
  } else {
    summaryText = pots.map((pot) => pot.text).join('. ');
  }

  return {
    handNumber: settled.handNumber,
    showdown,
    headline: showdown ? 'Showdown' : 'Hand won without showdown',
    summaryText,
    totalPot,
    pots,
    seats,
  };
}

// ---------------------------------------------------------------------------
// Spectator POV
// ---------------------------------------------------------------------------

/** The room renders 6 chairs; seat N maps to slot (pov + N + 1) % 6. */
export const CASH_ROOM_CHAIRS = 6;

/**
 * POV seat for a viewer who is NOT seated: an EMPTY seat, so every occupied
 * seat lands on a visible badge slot. First free index in 0..maxSeats-1, then
 * any free chair index, then 0 (a full 6-seat table has no free chair).
 */
export function pickSpectatorPovSeat(occupied: Iterable<number>, maxSeats: number): number {
  const taken = new Set(occupied);
  const limit = Math.max(0, Math.min(Math.floor(maxSeats), CASH_ROOM_CHAIRS));
  for (let index = 0; index < limit; index += 1) {
    if (!taken.has(index)) return index;
  }
  for (let index = 0; index < CASH_ROOM_CHAIRS; index += 1) {
    if (!taken.has(index)) return index;
  }
  return 0;
}
