import type { ParityGame, WireRecord } from './types';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function bigint(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

function initialBalance(
  game: 'blackjack' | 'baccarat',
  records: readonly WireRecord[],
  beforeSeq: number,
): bigint | null {
  for (const candidate of records
    .filter((record) => record.seq < beforeSeq)
    .sort((left, right) => right.seq - left.seq)) {
    const body = record(candidate.responseBody);
    const isSessionOpen = candidate.urlSuffix === `${game}/session/open`;
    const isPriorSettlement = record(body?.outcome) !== null;
    if (!isSessionOpen && !isPriorSettlement) continue;
    const value = bigint(body?.walletBalance ?? body?.balance);
    if (value !== null) return value;
  }
  return null;
}

export function assertMoneyFromWire(
  game: ParityGame,
  wire: WireRecord,
  relatedRecords: readonly WireRecord[],
  ba1Snapshot?: unknown,
): {
  equation: string;
  values: Record<string, string>;
  pass: boolean;
  reason?: string;
} {
  const body = record(wire.responseBody) ?? {};
  if (game === 'holdem' && ba1Snapshot) {
    const snapshot = record(ba1Snapshot) ?? {};
    const seats = Array.isArray(snapshot.seats)
      ? snapshot.seats.map(record).filter(Boolean) as UnknownRecord[]
      : [];
    let conservation = 0n;
    let pass = seats.length > 0;
    for (const seat of seats) {
      const start = bigint(seat.startStack);
      const end = bigint(seat.endStack);
      const committed = bigint(seat.totalCommitted);
      const won = bigint(seat.grossWon);
      const net = bigint(seat.net);
      const delta = bigint(seat.stackDelta);
      const rake = bigint(seat.rakeAttributed);
      if ([start, end, committed, won, net, delta, rake].includes(null)) {
        pass = false;
        continue;
      }
      pass &&= end === start! - committed! + won!;
      pass &&= net === won! - committed!;
      pass &&= delta === end! - start!;
      pass &&= rake === 0n;
      conservation += delta!;
    }
    pass &&= conservation === 0n;
    return {
      equation: 'endStack = startStack - totalCommitted + grossWon; Σ stackDelta = 0',
      values: { seats: String(seats.length), conservation: conservation.toString() },
      pass,
      ...(pass ? {} : { reason: 'BA-1 per-seat conservation mismatch' }),
    };
  }

  const outcome = record(body.outcome);
  if (!outcome) {
    return {
      equation: 'settlement wire required',
      values: {},
      pass: false,
      reason: 'no settled outcome in resolved WireRecord',
    };
  }
  const initial = game === 'blackjack' || game === 'baccarat'
    ? initialBalance(game, relatedRecords, wire.seq)
    : null;
  const final = bigint(body.balance ?? body.walletBalance ?? body.playerStack);
  if (game === 'blackjack') {
    const totalBet = bigint(outcome.totalBet);
    const payout = bigint(outcome.rakedPayout ?? outcome.totalPayout);
    const net = bigint(outcome.rakedNet ?? outcome.net);
    const arithmetic = totalBet !== null && payout !== null && net === payout - totalBet;
    const full = initial !== null && final !== null
      && final === initial - totalBet! + payout!;
    return {
      equation: 'final = initial - totalBet + rakedPayout',
      values: {
        initial: initial?.toString() ?? '',
        totalBet: totalBet?.toString() ?? '',
        rakedPayout: payout?.toString() ?? '',
        final: final?.toString() ?? '',
      },
      pass: arithmetic && full,
      ...(!arithmetic || !full
        ? { reason: initial === null ? 'initial balance capture missing' : 'blackjack money mismatch' }
        : {}),
    };
  }
  if (game === 'baccarat') {
    const stake = bigint(outcome.stake);
    const payout = bigint(outcome.payout);
    const net = bigint(outcome.net);
    const commission = bigint(outcome.commission);
    const bet = String(outcome.bet ?? body.bet ?? '');
    const winner = String(outcome.winner ?? '');
    const expectedCommission = stake === null
      ? null
      : bet === 'banker' && winner === 'banker'
        ? stake - (stake * 95n / 100n)
        : 0n;
    const arithmetic = stake !== null && payout !== null && net === payout - stake;
    const commissionExact = commission !== null
      && expectedCommission !== null
      && commission === expectedCommission;
    const full = initial !== null && final !== null && final === initial + net!;
    return {
      equation: 'final = initial + net; net = payout - stake; commission exact integer floor',
      values: {
        initial: initial?.toString() ?? '',
        stake: stake?.toString() ?? '',
        payout: payout?.toString() ?? '',
        net: net?.toString() ?? '',
        commission: commission?.toString() ?? '',
        expectedCommission: expectedCommission?.toString() ?? '',
        final: final?.toString() ?? '',
      },
      pass: arithmetic && commissionExact && full,
      ...(!arithmetic || !commissionExact || !full
        ? { reason: initial === null ? 'initial balance capture missing' : 'baccarat money mismatch' }
        : {}),
    };
  }
  const totalBet = bigint(body.betAmount ?? outcome.humanBet);
  const payout = bigint(outcome.humanRakedPayout ?? body.payout);
  const net = bigint(outcome.humanRakedNet ?? body.net);
  const arithmetic = totalBet !== null && payout !== null && net === payout - totalBet;
  return {
    equation: 'playerStack = startingStack - betAmount + rakedPayout',
    values: {
      betAmount: totalBet?.toString() ?? '',
      rakedPayout: payout?.toString() ?? '',
      net: net?.toString() ?? '',
    },
    pass: arithmetic,
    ...(arithmetic ? {} : { reason: 'holdem settlement money mismatch' }),
  };
}
