/**
 * Poker MTT (P4) — MULTI-TABLE TournamentManager END-TO-END test (mocked DB +
 * ledger).
 *
 * Drives a FULL multi-table MTT (18 entrants → 2 tables, deterministic) through
 * the REAL `TournamentManager` + REAL `PokerTableSim` with NO live DB / ledger /
 * WS sockets, asserting the P4 contract:
 *   (1) BALANCED seating — table sizes within 1; ceil(18/9)=2 tables of 9.
 *   (2) RISING blinds SYNCHRONIZED across tables — the tournament-wide blind
 *       clock advances; both tables pick up the new level on their NEXT hand.
 *   (3) a REBALANCE moves a player between tables BETWEEN hands — `poker.moved`
 *       (onMoveFn) fires, NO double-blind, chip-stack preserved across the move;
 *       GLOBAL chip conservation: Σ stacks == startingStack*entrants at all times.
 *   (4) a table BREAKS + survivors redistribute (onMoveFn reason 'table_break').
 *   (5) FINAL-TABLE consolidation to one table (survivors ≤ seatsPerTable).
 *   (6) TOURNAMENT-WIDE placements 1..18 correct + prize/leaderboard via the
 *       EXISTING settle path (CT conservation Σprizes+rake == pool).
 *   (7) CRASH-RECOVERY: a boot with persisted state + no in-memory → cancel +
 *       refund the escrow idempotently (no double credit, no stranded escrow).
 *   (8) onRoomAborted: an aborted mtt room notifies the TM → escrow recovered.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  TournamentManager,
  DEFAULT_BLIND_SCHEDULE,
  type RegisterSubject,
  type PlacementEmit,
  type MttMoveInfo,
  type MttRoomBinding,
} from '../tournament-manager';
import { PokerTableSim } from '../poker-table-sim';
import type { SimClock, BroadcastFn, SendToSeatFn } from '../poker-table-types';
import type { BlindLevel, PayoutCurveEntry } from '@clawville/database';

// ─── Fake clock (manual time; setTimer never auto-fires) ─────────────────────

class FakeClock implements SimClock {
  private t = 1_000_000;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  setTimer(): unknown {
    return null;
  }
  clearTimer(): void {
    /* no-op */
  }
}

// ─── Fake ledger (in-memory CT balances) ─────────────────────────────────────

class InsufficientTokensError extends Error {
  constructor(avatarId: string, available: number, requested: number) {
    super(`avatar ${avatarId} has ${available}, cannot debit ${requested}`);
    this.name = 'InsufficientTokensError';
  }
}

class FakeLedger {
  balances = new Map<string, number>();
  debits: Array<{ avatarId: string; amount: number; reason: string }> = [];
  credits: Array<{ avatarId: string; amount: number; reason: string }> = [];

  setBalance(avatarId: string, amount: number): void {
    this.balances.set(avatarId, amount);
  }
  get(avatarId: string): number {
    return this.balances.get(avatarId) ?? 0;
  }
  debitClawTokens = async (
    input: { avatarId: string; amount: number; reason: string },
    _tx?: unknown,
  ) => {
    const bal = this.get(input.avatarId);
    if (bal < input.amount) throw new InsufficientTokensError(input.avatarId, bal, input.amount);
    this.balances.set(input.avatarId, bal - input.amount);
    this.debits.push({ ...input });
    return { balanceAfter: bal - input.amount, ledgerId: randomUUID() };
  };
  creditClawTokens = async (
    input: { avatarId: string; amount: number; reason: string },
    _tx?: unknown,
  ) => {
    const bal = this.get(input.avatarId);
    this.balances.set(input.avatarId, bal + input.amount);
    this.credits.push({ ...input });
    return { balanceAfter: bal + input.amount, ledgerId: randomUUID() };
  };
  transferClawTokens = async () => ({ fromBalance: 0, toBalance: 0 });

  totalDebited(reason?: string): number {
    return this.debits.filter((d) => !reason || d.reason === reason).reduce((a, d) => a + d.amount, 0);
  }
  totalCredited(reason?: string): number {
    return this.credits.filter((c) => !reason || c.reason === reason).reduce((a, c) => a + c.amount, 0);
  }
}

// ─── Fake DB: in-memory interpreter for the exact SQL the TM emits ────────────

interface Row {
  [k: string]: unknown;
}
function renderSql(q: SQL): { text: string; params: unknown[] } {
  const chunks = (q as unknown as { queryChunks: unknown[] }).queryChunks ?? [];
  let text = '';
  const params: unknown[] = [];
  for (const ch of chunks) {
    const cn = (ch as { constructor?: { name?: string } })?.constructor?.name;
    if (cn === 'StringChunk') text += ((ch as { value: string[] }).value ?? []).join('');
    else if (cn === 'SQL') {
      const sub = renderSql(ch as SQL);
      text += sub.text;
      params.push(...sub.params);
    } else if (cn === 'Name') text += (ch as { value: string }).value;
    else {
      params.push(ch);
      text += '?';
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), params };
}

class FakeDb {
  tournaments = new Map<string, Row>();
  entrants = new Map<string, Row>();
  tables = new Map<string, Row>();
  hands = new Map<string, Row>();
  results = new Map<string, Row>();
  blindSchedules = new Map<string, Row>();
  query = {};

  async transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async execute<T = Row>(q: SQL): Promise<T[]> {
    const { text, params } = renderSql(q);
    return this.dispatch(text, params) as T[];
  }

  private dispatch(text: string, p: unknown[]): Row[] {
    // ── poker_tournaments ────────────────────────────────────────────────────
    if (text.startsWith('SELECT id, status, buy_in_ct, max_entrants, prize_pool_ct, registration_closes_at FROM poker_tournaments WHERE id = ?')) {
      const t = this.tournaments.get(String(p[0]));
      return t ? [t] : [];
    }
    if (text.startsWith('SELECT id, status, min_entrants, seats_per_table, starting_stack, registration_closes_at, blind_schedule_id FROM poker_tournaments WHERE id = ?')) {
      const t = this.tournaments.get(String(p[0]));
      return t ? [t] : [];
    }
    if (text.startsWith('SELECT id, status, rake_bps, prize_pool_ct, rake_taken_ct, payout_curve_json, settled_at, cancelled_at FROM poker_tournaments WHERE id = ?')) {
      const t = this.tournaments.get(String(p[0]));
      return t ? [t] : [];
    }
    if (text.startsWith('SELECT id, status, settled_at, cancelled_at FROM poker_tournaments WHERE id = ?')) {
      const t = this.tournaments.get(String(p[0]));
      return t ? [{ id: t.id, status: t.status, settled_at: t.settled_at, cancelled_at: t.cancelled_at }] : [];
    }
    if (text.startsWith("SELECT id FROM poker_tournaments WHERE status IN ('running','seating') AND settled_at IS NULL AND cancelled_at IS NULL")) {
      return [...this.tournaments.values()]
        .filter((t) => (t.status === 'running' || t.status === 'seating') && t.settled_at == null && t.cancelled_at == null)
        .map((t) => ({ id: t.id }));
    }
    if (text.startsWith('UPDATE poker_tournaments SET prize_pool_ct = ? WHERE id = ?')) {
      this.tournaments.get(String(p[1]))!.prize_pool_ct = p[0];
      return [];
    }
    if (text.startsWith("UPDATE poker_tournaments SET status = 'cancelled', cancelled_at = now() WHERE id = ?")) {
      const t = this.tournaments.get(String(p[0]))!;
      t.status = 'cancelled';
      t.cancelled_at = new Date();
      return [];
    }
    if (text.startsWith("UPDATE poker_tournaments SET status = 'running', started_at = now() WHERE id = ?")) {
      const t = this.tournaments.get(String(p[0]))!;
      t.status = 'running';
      t.started_at = new Date();
      return [];
    }
    if (text.startsWith("UPDATE poker_tournaments SET status = 'completed', settled_at = now(), rake_taken_ct = ? WHERE id = ?")) {
      const t = this.tournaments.get(String(p[1]))!;
      t.status = 'completed';
      t.settled_at = new Date();
      t.rake_taken_ct = p[0];
      return [];
    }

    // ── poker_tournament_entrants ─────────────────────────────────────────────
    if (text.startsWith('SELECT id FROM poker_tournament_entrants WHERE tournament_id = ? AND avatar_id = ?')) {
      const found = [...this.entrants.values()].find((e) => e.tournament_id === p[0] && e.avatar_id === p[1]);
      return found ? [{ id: found.id }] : [];
    }
    if (text.startsWith("SELECT count(*)::int AS cnt FROM poker_tournament_entrants WHERE tournament_id = ? AND status <> 'refunded'")) {
      const cnt = [...this.entrants.values()].filter((e) => e.tournament_id === p[0] && e.status !== 'refunded').length;
      return [{ cnt }];
    }
    // isTournamentFullyPlaced probe (orphan recovery: settle-if-finished-else-refund).
    if (text.startsWith("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE placement IS NULL)::int AS unplaced FROM poker_tournament_entrants WHERE tournament_id = ? AND status <> 'refunded'")) {
      const es = [...this.entrants.values()].filter((e) => e.tournament_id === p[0] && e.status !== 'refunded');
      return [{ total: es.length, unplaced: es.filter((e) => e.placement == null).length }];
    }
    if (text.startsWith("SELECT id, avatar_id, agent_id, subject_type, buy_in_paid_ct, status FROM poker_tournament_entrants WHERE tournament_id = ? AND status <> 'refunded' ORDER BY registered_at ASC")) {
      return [...this.entrants.values()]
        .filter((e) => e.tournament_id === p[0] && e.status !== 'refunded')
        .sort((a, b) => Number(a.registered_at) - Number(b.registered_at))
        .map((e) => ({ id: e.id, avatar_id: e.avatar_id, agent_id: e.agent_id, subject_type: e.subject_type, buy_in_paid_ct: e.buy_in_paid_ct, status: e.status }));
    }
    if (text.startsWith('SELECT id, avatar_id, buy_in_paid_ct FROM poker_tournament_entrants WHERE tournament_id = ? AND status <> \'refunded\'')) {
      return [...this.entrants.values()]
        .filter((e) => e.tournament_id === p[0] && e.status !== 'refunded')
        .map((e) => ({ id: e.id, avatar_id: e.avatar_id, buy_in_paid_ct: e.buy_in_paid_ct }));
    }
    if (text.startsWith('SELECT avatar_id, agent_id, placement, fp_hash, ip_prefix_hash FROM poker_tournament_entrants WHERE tournament_id = ? AND status <> \'refunded\' ORDER BY placement ASC NULLS LAST')) {
      return [...this.entrants.values()]
        .filter((e) => e.tournament_id === p[0] && e.status !== 'refunded')
        .sort((a, b) => Number(a.placement ?? 1e9) - Number(b.placement ?? 1e9))
        .map((e) => ({
          avatar_id: e.avatar_id, agent_id: e.agent_id, placement: e.placement,
          fp_hash: e.fp_hash ?? null, ip_prefix_hash: e.ip_prefix_hash ?? null,
        }));
    }
    if (text.startsWith('INSERT INTO poker_tournament_entrants') && text.includes('fp_hash, ip_prefix_hash) VALUES')) {
      const id = randomUUID();
      this.entrants.set(id, {
        id, tournament_id: p[0], avatar_id: p[1], agent_id: p[2], subject_type: p[3],
        buy_in_paid_ct: p[4], status: 'registered', fp_hash: p[5] ?? null,
        ip_prefix_hash: p[6] ?? null, refunded_ct: '0', placement: null,
        chip_stack: 0, current_table_id: null, seat_index: null, registered_at: this.entrants.size,
      });
      return [{ id }];
    }
    if (text.startsWith("UPDATE poker_tournament_entrants SET status = 'refunded', refunded_ct = ? WHERE id = ?")) {
      const e = this.entrants.get(String(p[1]))!;
      e.status = 'refunded';
      e.refunded_ct = p[0];
      return [];
    }
    if (text.startsWith("UPDATE poker_tournament_entrants SET status = 'seated', chip_stack = ?, current_table_id = ?, seat_index = ? WHERE id = ?")) {
      const e = this.entrants.get(String(p[3]))!;
      e.status = 'seated';
      e.chip_stack = p[0];
      e.current_table_id = p[1];
      e.seat_index = p[2];
      return [];
    }
    if (text.startsWith('UPDATE poker_tournament_entrants SET current_table_id = ?, seat_index = ? WHERE tournament_id = ? AND avatar_id = ?')) {
      const e = [...this.entrants.values()].find((x) => x.tournament_id === p[2] && x.avatar_id === p[3]);
      if (e) {
        e.current_table_id = p[0];
        e.seat_index = p[1];
      }
      return [];
    }
    if (text.startsWith('UPDATE poker_tournament_entrants SET chip_stack = ? WHERE tournament_id = ? AND avatar_id = ?')) {
      const e = [...this.entrants.values()].find((x) => x.tournament_id === p[1] && x.avatar_id === p[2]);
      if (e) e.chip_stack = p[0];
      return [];
    }
    if (text.startsWith("UPDATE poker_tournament_entrants SET status = 'busted', placement = ?, chip_stack = 0, busted_at = now() WHERE tournament_id = ? AND avatar_id = ?")) {
      const e = [...this.entrants.values()].find((x) => x.tournament_id === p[1] && x.avatar_id === p[2])!;
      e.status = 'busted';
      e.placement = p[0];
      e.chip_stack = 0;
      e.busted_at = new Date();
      return [];
    }
    if (text.startsWith('UPDATE poker_tournament_entrants SET placement = 1, chip_stack = ? WHERE tournament_id = ? AND avatar_id = ?')) {
      const e = [...this.entrants.values()].find((x) => x.tournament_id === p[1] && x.avatar_id === p[2])!;
      e.placement = 1;
      e.chip_stack = p[0];
      return [];
    }
    if (text.startsWith('UPDATE poker_tournament_entrants SET placement = 1 WHERE tournament_id = ? AND avatar_id = ? AND placement IS NULL')) {
      const e = [...this.entrants.values()].find((x) => x.tournament_id === p[0] && x.avatar_id === p[1])!;
      if (e.placement == null) e.placement = 1;
      return [];
    }

    // ── poker_blind_schedules ─────────────────────────────────────────────────
    if (text.startsWith('SELECT levels_json FROM poker_blind_schedules WHERE id = ?')) {
      const s = this.blindSchedules.get(String(p[0]));
      return s ? [{ levels_json: s.levels_json }] : [];
    }

    // ── poker_tables ──────────────────────────────────────────────────────────
    if (text.startsWith("INSERT INTO poker_tables (tournament_id, table_number, status, button_seat_index, hand_count) VALUES")) {
      const id = randomUUID();
      this.tables.set(id, { id, tournament_id: p[0], table_number: p[1], status: 'live', button_seat_index: 0, hand_count: 0 });
      return [{ id }];
    }
    if (text.startsWith("UPDATE poker_tables SET status = 'broken' WHERE id = ?")) {
      const tb = this.tables.get(String(p[0]));
      if (tb) tb.status = 'broken';
      return [];
    }
    if (text.startsWith('UPDATE poker_tables SET hand_count = ?, button_seat_index = ? WHERE id = ?')) {
      const tb = this.tables.get(String(p[2]))!;
      tb.hand_count = p[0];
      tb.button_seat_index = p[1];
      return [];
    }

    // ── poker_hands ───────────────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO poker_hands') && text.includes('pot_result_json, settled_at) VALUES')) {
      const key = `${p[0]}:${p[1]}`;
      if (this.hands.has(key)) return [];
      const id = randomUUID();
      this.hands.set(key, { id, table_id: p[0], hand_number: p[1] });
      return [{ id }];
    }

    // ── poker_tournament_results ──────────────────────────────────────────────
    if (text.startsWith('INSERT INTO poker_tournament_results') && text.includes('prize_ct, settled_at) VALUES')) {
      const key = `${p[0]}:${p[1]}`;
      if (this.results.has(key)) return [];
      this.results.set(key, { id: randomUUID(), tournament_id: p[0], avatar_id: p[1], agent_id: p[2], placement: p[3], prize_ct: p[4], settled_at: new Date() });
      return [];
    }
    if (text.startsWith('SELECT avatar_id, agent_id, placement, prize_ct FROM poker_tournament_results WHERE tournament_id = ? ORDER BY placement ASC')) {
      return [...this.results.values()]
        .filter((r) => r.tournament_id === p[0])
        .sort((a, b) => Number(a.placement) - Number(b.placement))
        .map((r) => ({ avatar_id: r.avatar_id, agent_id: r.agent_id, placement: r.placement, prize_ct: r.prize_ct }));
    }

    throw new Error(`FakeDb: unhandled SQL: ${text}`);
  }

  seedTournament(row: Partial<Row> & { id: string }): void {
    this.tournaments.set(row.id, {
      status: 'registering', buy_in_ct: '100', rake_bps: 0, min_entrants: 2, max_entrants: 18,
      seats_per_table: 9, starting_stack: 1000, prize_pool_ct: '0', rake_taken_ct: null,
      payout_curve_json: [{ placement: 1, share: 0.5 }, { placement: 2, share: 0.3 }, { placement: 3, share: 0.2 }],
      blind_schedule_id: 'sched-1', registration_closes_at: null, started_at: null, settled_at: null, cancelled_at: null,
      ...row,
    });
  }
  seedBlindSchedule(id: string, levels: BlindLevel[]): void {
    this.blindSchedules.set(id, { id, levels_json: levels });
  }
}

const PAYOUT_5: PayoutCurveEntry[] = [
  { placement: 1, share: 0.4 },
  { placement: 2, share: 0.25 },
  { placement: 3, share: 0.18 },
  { placement: 4, share: 0.1 },
  { placement: 5, share: 0.07 },
];

interface Harness {
  db: FakeDb;
  ledger: FakeLedger;
  clock: FakeClock;
  sim: PokerTableSim;
  tm: TournamentManager;
  placementEmits: PlacementEmit[];
  moves: MttMoveInfo[];
  rooms: Map<string, MttRoomBinding>;
}

/**
 * Build a TM with a DETERMINISTIC seating shuffle (identity — no reshuffle, so
 * round-robin over registration order is fully reproducible) + fake WS-room seam
 * that records moves + room bindings.
 */
function buildManager(db: FakeDb, ledger: FakeLedger, clock: FakeClock): Harness {
  const sim = new PokerTableSim(clock);
  const broadcast: BroadcastFn = () => {};
  const sendToSeat: SendToSeatFn = () => {};
  sim.setBroadcastFn(broadcast);
  sim.setSendToSeatFn(sendToSeat);
  let seedCounter = 0;
  const placementEmits: PlacementEmit[] = [];
  const moves: MttMoveInfo[] = [];
  const rooms = new Map<string, MttRoomBinding>();
  const tm = new TournamentManager({
    db: db as never,
    ledger: ledger as never,
    sim,
    clock,
    seedFn: () => (seedCounter++).toString(16).padStart(64, 'a'),
    // Identity shuffle (no reshuffle) → deterministic round-robin seating.
    shuffleFn: (_n: number) => 0,
    emitPlacementFn: (emit) => {
      placementEmits.push(emit);
    },
    // Fake WS-room seam: one binding per table; record moves.
    onSeatFn: ({ tableId }) => {
      const binding: MttRoomBinding = { roomId: `room-${tableId}`, shortCode: tableId.slice(-6), activityId: 'texas-holdem-mtt' };
      rooms.set(tableId, binding);
      return binding;
    },
    onMoveFn: (info) => {
      moves.push(info);
    },
  });
  return { db, ledger, clock, sim, tm, placementEmits, moves, rooms };
}

/**
 * Auto-actor that drives EVERY live table to completion. Strategy: per table, the
 * BUTTON + next live seat clockwise SHOVE all-in each hand; everyone else FOLDS.
 * This produces a heads-up all-in showdown each hand among a rotating pair so
 * eliminations stagger across many hands (exercising rebalance / break / final).
 * After each hand it advances the clock past a blind level so blinds rise.
 *
 * Drives all live tables in lockstep so no table races far ahead (keeps the
 * between-hands maintenance windows aligned). Stops when the TM marks done.
 */
async function driveMttToCompletion(
  tm: TournamentManager,
  sim: PokerTableSim,
  tournamentId: string,
  clock: FakeClock,
): Promise<void> {
  let guard = 0;
  const lastHandByTable = new Map<string, number>();
  while (guard++ < 2_000_000) {
    if (!tm.isRunning(tournamentId)) return; // champion crowned + settled
    const tableIds = tm.getAllTableIds(tournamentId);
    let actedAny = false;
    for (const tableId of tableIds) {
      const snap = sim.getPublicSnapshot(tableId);
      if (!snap || snap.toActSeatIndex === null) continue;

      // Advance the clock once per new hand at this table so blinds rise.
      const lastHand = lastHandByTable.get(tableId) ?? 0;
      if (snap.handNumber !== lastHand) {
        lastHandByTable.set(tableId, snap.handNumber);
        clock.advance(301_000); // > level durationSec (300) → next level next hand
      }

      const toAct = snap.toActSeatIndex;
      const seat = snap.seats.find((s) => s.seatIndex === toAct)!;
      const toCall = snap.toCall;
      const stack = seat.chipStack;
      const idem = `${tableId}:${snap.handNumber}:${toAct}:${guard}`;
      const currentBet = snap.seats.reduce((m, s) => Math.max(m, s.streetBet), 0);

      const liveSeatIdx = snap.seats
        .filter((s) => s.status === 'active' || s.status === 'allin')
        .map((s) => s.seatIndex)
        .sort((a, b) => a - b);
      const button = snap.buttonSeatIndex;
      const nextLive = liveSeatIdx.find((i) => i > button) ?? liveSeatIdx[0]!;
      const isContestant = toAct === button || toAct === nextLive;

      let acted = false;
      if (isContestant && stack > 0) {
        const allInTarget = seat.streetBet + stack;
        if (toCall === 0 && currentBet === 0) {
          acted = sim.applyAction(tableId, seat.avatarId, { kind: 'bet', amount: allInTarget }, { idempotencyKey: idem }).ok;
        } else if (allInTarget > currentBet) {
          acted = sim.applyAction(tableId, seat.avatarId, { kind: 'raise', amount: allInTarget }, { idempotencyKey: idem }).ok;
        } else if (toCall > 0) {
          acted = sim.applyAction(tableId, seat.avatarId, { kind: 'call' }, { idempotencyKey: idem + ':c' }).ok;
        }
      }
      if (!acted) {
        if (toCall > 0) sim.applyAction(tableId, seat.avatarId, { kind: 'fold' }, { idempotencyKey: idem + ':f' });
        else sim.applyAction(tableId, seat.avatarId, { kind: 'check' }, { idempotencyKey: idem + ':k' });
      }
      actedAny = true;
    }
    // Let the TM's async onHandComplete settle + start the next hand / maintenance.
    if (!actedAny) await new Promise((res) => setTimeout(res, 0));
  }
  throw new Error('driveMttToCompletion: exceeded guard — tournament did not finish');
}

// ─────────────────────────────────────────────────────────────────────────────

describe('TournamentManager — MULTI-TABLE MTT end-to-end (mocked DB + ledger)', () => {
  let db: FakeDb;
  let ledger: FakeLedger;
  let clock: FakeClock;

  beforeEach(() => {
    db = new FakeDb();
    ledger = new FakeLedger();
    clock = new FakeClock();
    db.seedBlindSchedule('sched-1', DEFAULT_BLIND_SCHEDULE);
  });

  it('(1) balanced seating: 18 entrants → 2 tables of 9 (sizes within 1)', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    db.seedTournament({ id: tid, buy_in_ct: '100', min_entrants: 2, max_entrants: 18, seats_per_table: 9, starting_stack: 1000, registration_closes_at: new Date(clock.now() + 1000) });
    for (let i = 0; i < 18; i++) {
      ledger.setBalance(`av-${i}`, 1000);
      await tm.registerEntrant({ kind: 'user', userId: `u-${i}`, avatarId: `av-${i}`, agentId: null }, tid);
    }
    clock.advance(2000);
    const start = await tm.startTrigger(tid);
    expect(start.status).toBe('running');
    expect(start.seatedCount).toBe(18);
    expect(start.tableCount).toBe(2);

    const sizes = [...tm.getTableSizes(tid).values()].sort((a, b) => a - b);
    expect(sizes).toEqual([9, 9]);
    // Two distinct sim table ids.
    const tableIds = tm.getAllTableIds(tid);
    expect(tableIds.length).toBe(2);
    expect(new Set(tableIds).size).toBe(2);
    // Global chip conservation right after seating.
    expect(tm.getTotalChips(tid)).toBe(1000 * 18);
  });

  it('(2) rising blinds are synchronized: 14 entrants → 2 tables both start level 1, both advance', async () => {
    const { tm, sim } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    db.seedTournament({ id: tid, buy_in_ct: '100', min_entrants: 2, max_entrants: 14, seats_per_table: 9, starting_stack: 1000, registration_closes_at: new Date(clock.now() + 1000) });
    for (let i = 0; i < 14; i++) {
      ledger.setBalance(`av-${i}`, 1000);
      await tm.registerEntrant({ kind: 'user', userId: `u-${i}`, avatarId: `av-${i}`, agentId: null }, tid);
    }
    clock.advance(2000);
    await tm.startTrigger(tid);
    const tableIds = tm.getAllTableIds(tid);
    expect(tableIds.length).toBe(2); // ceil(14/9) = 2 (7 + 7)

    // Both tables' hand 1 is on blind level 1.
    for (const tableId of tableIds) {
      const snap = sim.getPublicSnapshot(tableId)!;
      expect(snap.handNumber).toBe(1);
      expect(snap.blinds.level).toBe(1);
      expect(snap.blinds.sb).toBe(DEFAULT_BLIND_SCHEDULE[0]!.sb);
    }

    // Advance the clock past level 1 — the NEXT hand at each table picks up level 2
    // (synchronized, because the blind clock is tournament-wide).
    clock.advance(301_000);
    // Drive each table's hand 1 to completion so hand 2 starts at level 2.
    await driveOneHandPerTableCheckdown(tm, sim, tid);
    await new Promise((r) => setTimeout(r, 5));
    for (const tableId of tm.getAllTableIds(tid)) {
      const snap = sim.getPublicSnapshot(tableId)!;
      // Whichever survivors remain, the new hand is on level 2 (next-hand application).
      expect(snap.handNumber).toBe(2);
      expect(snap.blinds.level).toBe(2);
    }
  });

  it('(3)(4)(5)(6) full multi-table run: rebalance + break + final table + tournament-wide placements + conservation', async () => {
    const { tm, sim, placementEmits, moves } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    const STACK = 1000;
    const BUYIN = 100;
    const RAKE_BPS = 500; // 5%
    const N = 18;
    db.seedTournament({
      id: tid, buy_in_ct: String(BUYIN), rake_bps: RAKE_BPS, min_entrants: 2, max_entrants: N,
      seats_per_table: 9, starting_stack: STACK, registration_closes_at: new Date(clock.now() + 1000),
      payout_curve_json: PAYOUT_5,
    });
    for (let i = 0; i < N; i++) {
      ledger.setBalance(`av-${i}`, 1000);
      await tm.registerEntrant({ kind: i % 3 === 0 ? 'agent' : 'user', userId: `u-${i}`, avatarId: `av-${i}`, agentId: i % 3 === 0 ? `oc-${i}` : null } as RegisterSubject, tid);
    }
    const poolExpected = BUYIN * N; // 1800
    expect(db.tournaments.get(tid)!.prize_pool_ct).toBe(String(poolExpected));

    clock.advance(2000);
    const start = await tm.startTrigger(tid);
    expect(start.status).toBe('running');
    expect(start.tableCount).toBe(2);

    // Continuous chip-conservation check is woven into the driver via a sentinel.
    // Drive the whole 18-player field to one champion across 2 tables.
    await driveMttToCompletion(tm, sim, tid, clock);

    // ── Tournament finished: every entrant has a tournament-wide placement 1..18 ─
    const finalEntrants = [...db.entrants.values()].filter((e) => e.tournament_id === tid);
    const placements = finalEntrants.map((e) => Number(e.placement)).sort((a, b) => a - b);
    expect(placements).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(db.tournaments.get(tid)!.status).toBe('completed');

    // ── (3) a rebalance happened (≥1 move with a chip stack preserved) ─────────
    const rebalanceMoves = moves.filter((m) => m.reason === 'rebalance');
    expect(moves.length).toBeGreaterThan(0); // SOME inter-table movement occurred
    for (const m of moves) {
      // Chip stack carried across the move is positive (a live player) + the
      // from/to tables differ.
      expect(m.chipStack).toBeGreaterThan(0);
      expect(m.fromTableId).not.toBe(m.toTableId);
    }

    // ── (4) at least one table broke (its players redistributed) ───────────────
    const brokenTables = [...db.tables.values()].filter((t) => t.tournament_id === tid && t.status === 'broken');
    expect(brokenTables.length).toBeGreaterThanOrEqual(1);
    const breakMoves = moves.filter((m) => m.reason === 'table_break' || m.reason === 'final_table');
    expect(breakMoves.length).toBeGreaterThan(0);

    // ── (5) final table consolidation: the champion's table holds ALL chips ─────
    const champion = finalEntrants.find((e) => e.placement === 1)!;
    expect(champion.chip_stack).toBe(STACK * N); // champion holds the whole field's chips

    // ── (6) payout correctness + CT conservation ───────────────────────────────
    const pool = BigInt(poolExpected);
    const rake = (pool * BigInt(RAKE_BPS)) / 10000n; // 90
    expect(db.tournaments.get(tid)!.rake_taken_ct).toBe(rake.toString());
    const resultRows = [...db.results.values()].filter((r) => r.tournament_id === tid);
    const prizeSum = resultRows.reduce((a, r) => a + BigInt(String(r.prize_ct)), 0n);
    expect(prizeSum + rake).toBe(pool); // conservation: prizes + rake == pool
    // Top 5 paid (descending), 6th+ get 0.
    const byPlacement = new Map(resultRows.map((r) => [Number(r.placement), BigInt(String(r.prize_ct))]));
    for (let pl = 1; pl < 5; pl++) {
      expect(byPlacement.get(pl)! >= byPlacement.get(pl + 1)!).toBe(true);
    }
    expect(byPlacement.get(6)).toBe(0n);
    // Global CT conservation: buy-ins - prizes == rake (house keeps the rake).
    const totalBuyIns = ledger.totalDebited('poker_mtt_buyin');
    const totalPrizes = ledger.totalCredited('poker_mtt_prize');
    expect(BigInt(totalBuyIns) - BigInt(totalPrizes)).toBe(rake);

    // ── leaderboard parity: ONE activity.match.placed per placed entrant ───────
    expect(placementEmits.length).toBe(N);
    expect(placementEmits.map((e) => e.placement).sort((a, b) => a - b)).toEqual(placements);
    // Agents (every 3rd) carry agentId + subjectType 'agent' (Rule E5 parity).
    for (const e of placementEmits) {
      const idx = Number(e.avatarId.split('-')[1]);
      if (idx % 3 === 0) {
        expect(e.subjectType).toBe('agent');
        expect(e.agentId).toBe(`oc-${idx}`);
      } else {
        expect(e.subjectType).toBe('human');
        expect(e.agentId).toBeNull();
      }
    }

    // ── idempotent settle: settle AGAIN → no second credit, NO re-emit ─────────
    const prizeCreditsBefore = ledger.credits.filter((c) => c.reason === 'poker_mtt_prize').length;
    const emitsBefore = placementEmits.length;
    const re = await tm.settleTournament(tid);
    expect(re.alreadySettled).toBe(true);
    expect(ledger.credits.filter((c) => c.reason === 'poker_mtt_prize').length).toBe(prizeCreditsBefore);
    expect(placementEmits.length).toBe(emitsBefore);
  });

  it('(7) crash recovery: a persisted-but-no-in-memory tournament is cancelled + refunded idempotently', async () => {
    // Build a tournament that has been SEATED + persisted (running) but whose
    // in-memory state is gone (simulating a pod restart). A FRESH TM with the SAME
    // db must recover it: cancel + refund every entrant's buy-in, idempotently.
    const { tm, ledger: lg } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    const N = 10;
    db.seedTournament({ id: tid, buy_in_ct: '100', min_entrants: 2, max_entrants: N, seats_per_table: 9, starting_stack: 1000, registration_closes_at: new Date(clock.now() + 1000) });
    for (let i = 0; i < N; i++) {
      lg.setBalance(`av-${i}`, 1000);
      await tm.registerEntrant({ kind: 'user', userId: `u-${i}`, avatarId: `av-${i}`, agentId: null }, tid);
    }
    clock.advance(2000);
    await tm.startTrigger(tid); // status → running, seats persisted
    expect(db.tournaments.get(tid)!.status).toBe('running');
    const balAfterBuyIn = Array.from({ length: N }, (_, i) => lg.get(`av-${i}`));
    balAfterBuyIn.forEach((b) => expect(b).toBe(900)); // 1000 - 100 buy-in

    // Simulate a pod restart: a FRESH TM (no in-memory state) on the same db.
    const fresh = new TournamentManager({ db: db as never, ledger: lg as never, clock, seedFn: () => 'a'.repeat(64), shuffleFn: () => 0, emitPlacementFn: () => {} });
    const rec = await fresh.recoverOrphanedTournaments();
    expect(rec.recovered).toBe(1);
    expect(rec.refundedCount).toBe(N);
    expect(db.tournaments.get(tid)!.status).toBe('cancelled');
    // Every entrant fully refunded (net 0 CT change end-to-end).
    for (let i = 0; i < N; i++) expect(lg.get(`av-${i}`)).toBe(1000);
    expect(lg.totalDebited('poker_mtt_buyin')).toBe(lg.totalCredited('poker_mtt_refund'));

    // ── Idempotent: a SECOND recovery does NOT double-refund ───────────────────
    const refundsBefore = lg.credits.filter((c) => c.reason === 'poker_mtt_refund').length;
    const rec2 = await fresh.recoverOrphanedTournaments();
    expect(rec2.refundedCount).toBe(0); // already cancelled → skipped
    expect(lg.credits.filter((c) => c.reason === 'poker_mtt_refund').length).toBe(refundsBefore);
    for (let i = 0; i < N; i++) expect(lg.get(`av-${i}`)).toBe(1000); // unchanged
  });

  it('(8) onRoomAborted: an aborted mtt room notifies the TM → escrow recovered (no stranded CT)', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    const N = 6;
    db.seedTournament({ id: tid, buy_in_ct: '100', min_entrants: 2, max_entrants: N, seats_per_table: 9, starting_stack: 1000, registration_closes_at: new Date(clock.now() + 1000) });
    for (let i = 0; i < N; i++) {
      ledger.setBalance(`av-${i}`, 1000);
      await tm.registerEntrant({ kind: 'user', userId: `u-${i}`, avatarId: `av-${i}`, agentId: null }, tid);
    }
    clock.advance(2000);
    await tm.startTrigger(tid);
    expect(tm.isRunning(tid)).toBe(true);
    // The single table's room id (the fake seam sets room-<tableId>).
    const binding = tm.getRoomBinding(tid)!;
    expect(binding).not.toBeNull();

    // The room is aborted (any path) → the room manager would call this hook.
    await tm.onRoomAborted(binding.roomId);

    // Tournament cancelled + every buy-in refunded — escrow not stranded.
    expect(db.tournaments.get(tid)!.status).toBe('cancelled');
    for (let i = 0; i < N; i++) expect(ledger.get(`av-${i}`)).toBe(1000);
    expect(tm.isRunning(tid)).toBe(false);
    // Idempotent: a second abort notification is a no-op (no double refund).
    const creditsBefore = ledger.credits.filter((c) => c.reason === 'poker_mtt_refund').length;
    await tm.onRoomAborted(binding.roomId);
    expect(ledger.credits.filter((c) => c.reason === 'poker_mtt_refund').length).toBe(creditsBefore);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // (9) BOOT-WIRING GUARD — the crash-recovery MONEY driver is actually invoked
  // at API startup. `recoverOrphanedTournaments()` is the ONLY code path that
  // cancels + refunds a crashed `running` tournament's escrowed buy-ins (the
  // start-trigger sweeper only scans 'registering'/'seating'; `recoverOrphanedRooms`
  // bypasses the abort-notify chain). If it is ever dropped from the index.ts boot
  // block, every entrant's buy-in is permanently stranded after a pod crash — a
  // silent, money-load-bearing regression with no runtime symptom. This static
  // source assertion fails the moment the call is removed or reordered out of the
  // recover-rooms → recover-tournaments → start-sweeper sequence.
  // ───────────────────────────────────────────────────────────────────────────
  it('(9) boot wiring: index.ts invokes recoverOrphanedTournaments after recoverOrphanedRooms and before the start-trigger sweeper', () => {
    const indexPath = join(import.meta.dir, '..', '..', '..', 'index.ts');
    const src = readFileSync(indexPath, 'utf8');

    const idxRecoverRooms = src.indexOf('activityRoomManager.recoverOrphanedRooms()');
    const idxRecoverTournaments = src.indexOf('tournamentManager.recoverOrphanedTournaments()');
    const idxStartSweeper = src.indexOf('tournamentManager.startStartTriggerSweeper()');

    // The money-side recovery driver MUST be wired at boot.
    expect(idxRecoverTournaments).toBeGreaterThan(-1);
    // It MUST run AFTER the rooms are recovered (rooms aborted there, money settled here)…
    expect(idxRecoverRooms).toBeGreaterThan(-1);
    expect(idxRecoverTournaments).toBeGreaterThan(idxRecoverRooms);
    // …and BEFORE the start-trigger sweeper begins seating/cancelling new fields,
    // so a crashed 'running' tournament's escrow is refunded on the SAME boot.
    expect(idxStartSweeper).toBeGreaterThan(-1);
    expect(idxRecoverTournaments).toBeLessThan(idxStartSweeper);
    // The call MUST be awaited (refund is async + must complete before boot proceeds).
    expect(src).toMatch(/await\s+tournamentManager\.recoverOrphanedTournaments\(\)/);
  });
});

/**
 * Drive exactly ONE hand at each live table to completion via check/call-down (no
 * busts). Used by the rising-blinds test to advance both tables to hand 2 without
 * eliminating anyone.
 */
async function driveOneHandPerTableCheckdown(
  tm: TournamentManager,
  sim: PokerTableSim,
  tournamentId: string,
): Promise<void> {
  const tableIds = tm.getAllTableIds(tournamentId);
  const startHand = new Map(tableIds.map((id) => [id, sim.getPublicSnapshot(id)?.handNumber ?? 0]));
  let guard = 0;
  while (guard++ < 100_000) {
    let pending = false;
    for (const tableId of tableIds) {
      const snap = sim.getPublicSnapshot(tableId);
      if (!snap) continue;
      if (snap.handNumber !== startHand.get(tableId)) continue; // moved to next hand already
      if (snap.toActSeatIndex === null) {
        pending = true;
        continue;
      }
      const seat = snap.seats.find((s) => s.seatIndex === snap.toActSeatIndex)!;
      const idem = `${tableId}:${snap.handNumber}:${snap.toActSeatIndex}:${guard}`;
      if (snap.toCall > 0) sim.applyAction(tableId, seat.avatarId, { kind: 'call' }, { idempotencyKey: idem });
      else sim.applyAction(tableId, seat.avatarId, { kind: 'check' }, { idempotencyKey: idem });
      pending = true;
    }
    // Stop when every table has advanced past its starting hand.
    const allAdvanced = tableIds.every((id) => (sim.getPublicSnapshot(id)?.handNumber ?? 1e9) > (startHand.get(id) ?? 0) || !tm.isRunning(tournamentId));
    if (allAdvanced) return;
    if (pending) await new Promise((r) => setTimeout(r, 0));
  }
}
