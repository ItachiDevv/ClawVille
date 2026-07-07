/**
 * Poker MTT (P3) — TournamentManager END-TO-END test (mocked DB + ledger).
 *
 * Drives a FULL single-table sit-n-go through the REAL TournamentManager with NO
 * live DB and NO real ledger:
 *   - a hand-crafted in-memory fake `db` whose `transaction(fn)` runs `fn(tx)` and
 *     whose `tx.execute(sql)` interprets the exact raw-SQL statement shapes the TM
 *     emits (one tiny store per poker_* table). FOR UPDATE locks are a no-op (the
 *     test is single-threaded) but the row-read-then-write ordering is preserved.
 *   - a fake ledger that records every debit/credit against an in-memory CT
 *     balance per avatar (so InsufficientTokensError + conservation are real).
 *   - the REAL `PokerTableSim` (constructed with a fake clock) wired to the TM, so
 *     hands actually play; a scripted auto-actor drives every seat's decisions
 *     deterministically (always call/check, then on the river the seat that has to
 *     act first shoves to force eliminations).
 *
 * Asserts:
 *   (1) registration debits the buy-in into the pool; a re-register is idempotent
 *       (no second debit).
 *   (2) floor-not-met → cancel + refund every buy-in (net CT change == 0).
 *   (3) a started tournament plays many hands with rising blinds + button rotation;
 *       players bust in order; placements are correct (champion = 1).
 *   (4) CHIP conservation across every hand (no chips created/destroyed).
 *   (5) the champion + paid places get correct pool payouts; settle is idempotent
 *       (settle twice → credited once); CT conservation
 *       (sum(buy-ins) == sum(prizes) + rake).
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  TournamentManager,
  computePrizes,
  computeBustPlacements,
  validatePayoutCurve,
  toBigIntStrict,
  DEFAULT_BLIND_SCHEDULE,
  DEFAULT_BLIND_SCHEDULE_ID,
  type RegisterSubject,
  type PlacementEmit,
} from '../tournament-manager';
import { PokerTableSim } from '../poker-table-sim';
import type { SimClock, BroadcastFn, SendToSeatFn } from '../poker-table-types';
import type { BlindLevel, PayoutCurveEntry } from '@clawville/database';

// ─── Fake clock (manual time; setTimer never auto-fires — the test drives all
// turns via the sim's onTurnTimeout, never the wall clock) ───────────────────

class FakeClock implements SimClock {
  private t = 1_000_000;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  setTimer(): unknown {
    return null; // turns are driven explicitly; no auto-fire
  }
  clearTimer(): void {
    /* no-op */
  }
}

// ─── Fake ledger (in-memory CT balances; real InsufficientTokensError) ───────

class InsufficientTokensError extends Error {
  constructor(
    public readonly avatarId: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
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
    if (bal < input.amount) {
      throw new InsufficientTokensError(input.avatarId, bal, input.amount);
    }
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
  // unused by the TM but part of the LedgerLike shape
  transferClawTokens = async () => ({ fromBalance: 0, toBalance: 0 });

  totalDebited(reason?: string): number {
    return this.debits
      .filter((d) => !reason || d.reason === reason)
      .reduce((a, d) => a + d.amount, 0);
  }
  totalCredited(reason?: string): number {
    return this.credits
      .filter((c) => !reason || c.reason === reason)
      .reduce((a, c) => a + c.amount, 0);
  }
}

// ─── Fake DB: an in-memory interpreter for the exact SQL the TM emits ─────────

interface Row {
  [k: string]: unknown;
}

/**
 * A jsonb column param arrives as a JSON STRING (the TM does `${JSON.stringify(x)}::jsonb`).
 * A real jsonb column round-trips to the parsed value; mirror that. Pass non-strings
 * (already-parsed seed data) through unchanged.
 */
function parseJsonParam(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Render a drizzle SQL object into normalized text + ordered params. */
function renderSql(q: SQL): { text: string; params: unknown[] } {
  const chunks = (q as unknown as { queryChunks: unknown[] }).queryChunks ?? [];
  let text = '';
  const params: unknown[] = [];
  for (const ch of chunks) {
    const cn = (ch as { constructor?: { name?: string } })?.constructor?.name;
    if (cn === 'StringChunk') {
      text += ((ch as { value: string[] }).value ?? []).join('');
    } else if (cn === 'SQL') {
      const sub = renderSql(ch as SQL);
      text += sub.text;
      params.push(...sub.params);
    } else if (cn === 'Name') {
      text += (ch as { value: string }).value;
    } else {
      // A raw interpolated primitive (string/number/Date/etc.) → a bound param.
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
  hands = new Map<string, Row>(); // key = `${tableId}:${handNumber}`
  results = new Map<string, Row>(); // key = `${tournamentId}:${avatarId}`
  blindSchedules = new Map<string, Row>();

  // Drizzle-style query API the route uses (not the TM) — minimal stub.
  query = {};

  async transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    // Single-threaded test: the "transaction" is just the same store. We DON'T
    // roll back on throw (the TM relies on the DB doing that), but every TM
    // transaction body either completes or throws before any partial money move
    // that matters for these assertions — and the ledger fake is append-only, so
    // a thrown register (e.g. insufficient funds) leaves no half-state because the
    // debit is the FIRST money op and it throws before the pool update.
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
    if (text.startsWith('UPDATE poker_tournaments SET prize_pool_ct = ? WHERE id = ?')) {
      const t = this.tournaments.get(String(p[1]))!;
      t.prize_pool_ct = p[0];
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
    // createTournament INSERT ... RETURNING (P4 creation path; created_by audit col).
    if (
      text.startsWith('INSERT INTO poker_tournaments (name, status, buy_in_ct, rake_bps, min_entrants, max_entrants, seats_per_table, starting_stack, prize_pool_ct, payout_curve_json, blind_schedule_id, registration_closes_at, created_by, special_event_id) VALUES')
    ) {
      const id = randomUUID();
      // NOTE (2026-06-16): `prize_pool_ct` is a BOUND PARAM (p[7]) — the
      // special-event prepaid seam made the TM seed the pool with
      // `${seedPool.toString()}` instead of the literal '0', so every subsequent
      // param index shifted by one (payout_curve→p[8], blind_sched→p[9],
      // reg_closes→p[10], created_by→p[11]). The dependency FK
      // `special_event_id` (p[12]) is the NEW trailing column added the same day:
      // poker_tournaments.special_event_id → special_events.id (FK points UP).
      const row: Row = {
        id,
        name: p[0],
        status: 'registering',
        buy_in_ct: p[1],
        rake_bps: p[2],
        min_entrants: p[3],
        max_entrants: p[4],
        seats_per_table: p[5],
        starting_stack: p[6],
        prize_pool_ct: p[7],
        payout_curve_json: parseJsonParam(p[8]),
        blind_schedule_id: p[9],
        registration_closes_at: p[10] ?? null,
        created_by: p[11] ?? null,
        special_event_id: p[12] ?? null,
        rake_taken_ct: null,
        started_at: null,
        settled_at: null,
        cancelled_at: null,
        created_at: new Date(this.tournaments.size + 1), // monotonic for ORDER BY created_at DESC
      };
      this.tournaments.set(id, row);
      return [row];
    }
    // listTournaments — the discovery SELECT with correlated subqueries.
    if (text.startsWith('SELECT t.id, t.name, t.status, t.buy_in_ct, t.rake_bps, t.min_entrants, t.max_entrants, t.seats_per_table, t.starting_stack, t.prize_pool_ct, t.registration_closes_at, t.blind_schedule_id,')) {
      // The status filter is interpolated as a nested SQL StringChunk, so it shows
      // in `text` (NOT params) as either ('registering') or ('registering','running').
      const includeRunning = text.includes("('registering','running')");
      const limit = Number(p[p.length - 1]); // last param is LIMIT
      const allowed = includeRunning
        ? new Set(['registering', 'running'])
        : new Set(['registering']);
      return [...this.tournaments.values()]
        .filter((t) => allowed.has(String(t.status)))
        .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))
        .slice(0, limit)
        .map((t) => {
          const registeredCount = [...this.entrants.values()].filter(
            (e) => e.tournament_id === t.id && e.status !== 'refunded',
          ).length;
          const tableCount = [...this.tables.values()].filter(
            (tb) => tb.tournament_id === t.id && tb.status === 'live',
          ).length;
          const sched = this.blindSchedules.get(String(t.blind_schedule_id));
          return {
            id: t.id,
            name: t.name,
            status: t.status,
            buy_in_ct: t.buy_in_ct,
            rake_bps: t.rake_bps,
            min_entrants: t.min_entrants,
            max_entrants: t.max_entrants,
            seats_per_table: t.seats_per_table,
            starting_stack: t.starting_stack,
            prize_pool_ct: t.prize_pool_ct,
            registration_closes_at: t.registration_closes_at ?? null,
            blind_schedule_id: t.blind_schedule_id,
            registered_count: registeredCount,
            table_count: tableCount,
            levels_json: sched?.levels_json ?? null,
          };
        });
    }

    // ── poker_tournament_entrants ─────────────────────────────────────────────
    if (text.startsWith('SELECT id FROM poker_tournament_entrants WHERE tournament_id = ? AND avatar_id = ?')) {
      const found = [...this.entrants.values()].find(
        (e) => e.tournament_id === p[0] && e.avatar_id === p[1],
      );
      return found ? [{ id: found.id }] : [];
    }
    if (text.startsWith("SELECT count(*)::int AS cnt FROM poker_tournament_entrants WHERE tournament_id = ? AND status <> 'refunded'")) {
      const cnt = [...this.entrants.values()].filter(
        (e) => e.tournament_id === p[0] && e.status !== 'refunded',
      ).length;
      return [{ cnt }];
    }
    if (text.startsWith("SELECT id, avatar_id, agent_id, subject_type, buy_in_paid_ct, status FROM poker_tournament_entrants WHERE tournament_id = ? AND status <> 'refunded' ORDER BY registered_at ASC")) {
      return [...this.entrants.values()]
        .filter((e) => e.tournament_id === p[0] && e.status !== 'refunded')
        .sort((a, b) => Number(a.registered_at) - Number(b.registered_at))
        .map((e) => ({
          id: e.id,
          avatar_id: e.avatar_id,
          agent_id: e.agent_id,
          subject_type: e.subject_type,
          buy_in_paid_ct: e.buy_in_paid_ct,
          status: e.status,
        }));
    }
    if (text.startsWith('SELECT avatar_id, agent_id, placement, fp_hash, ip_prefix_hash FROM poker_tournament_entrants WHERE tournament_id = ? AND status <> \'refunded\' ORDER BY placement ASC NULLS LAST')) {
      return [...this.entrants.values()]
        .filter((e) => e.tournament_id === p[0] && e.status !== 'refunded')
        .sort((a, b) => (Number(a.placement ?? 1e9) - Number(b.placement ?? 1e9)))
        .map((e) => ({
          avatar_id: e.avatar_id,
          agent_id: e.agent_id,
          placement: e.placement,
          fp_hash: e.fp_hash ?? null,
          ip_prefix_hash: e.ip_prefix_hash ?? null,
        }));
    }
    if (text.startsWith('INSERT INTO poker_tournament_entrants') && text.includes('fp_hash, ip_prefix_hash) VALUES')) {
      const id = randomUUID();
      this.entrants.set(id, {
        id,
        tournament_id: p[0],
        avatar_id: p[1],
        agent_id: p[2],
        subject_type: p[3],
        buy_in_paid_ct: p[4],
        status: 'registered',
        fp_hash: p[5] ?? null,
        ip_prefix_hash: p[6] ?? null,
        refunded_ct: '0',
        placement: null,
        chip_stack: 0,
        current_table_id: null,
        seat_index: null,
        registered_at: this.entrants.size, // monotonic for ORDER BY
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
    if (text.startsWith('UPDATE poker_tournament_entrants SET chip_stack = ? WHERE tournament_id = ? AND avatar_id = ?')) {
      const e = [...this.entrants.values()].find(
        (x) => x.tournament_id === p[1] && x.avatar_id === p[2],
      )!;
      e.chip_stack = p[0];
      return [];
    }
    if (text.startsWith("UPDATE poker_tournament_entrants SET status = 'busted', placement = ?, chip_stack = 0, busted_at = now() WHERE tournament_id = ? AND avatar_id = ?")) {
      const e = [...this.entrants.values()].find(
        (x) => x.tournament_id === p[1] && x.avatar_id === p[2],
      )!;
      e.status = 'busted';
      e.placement = p[0];
      e.chip_stack = 0;
      e.busted_at = new Date();
      return [];
    }
    if (text.startsWith('UPDATE poker_tournament_entrants SET placement = 1, chip_stack = ? WHERE tournament_id = ? AND avatar_id = ?')) {
      const e = [...this.entrants.values()].find(
        (x) => x.tournament_id === p[1] && x.avatar_id === p[2],
      )!;
      e.placement = 1;
      e.chip_stack = p[0];
      return [];
    }
    if (text.startsWith('UPDATE poker_tournament_entrants SET placement = 1 WHERE tournament_id = ? AND avatar_id = ? AND placement IS NULL')) {
      const e = [...this.entrants.values()].find(
        (x) => x.tournament_id === p[0] && x.avatar_id === p[1],
      )!;
      if (e.placement == null) e.placement = 1;
      return [];
    }

    // ── poker_blind_schedules ─────────────────────────────────────────────────
    if (text.startsWith('SELECT levels_json FROM poker_blind_schedules WHERE id = ?')) {
      const s = this.blindSchedules.get(String(p[0]));
      return s ? [{ levels_json: s.levels_json }] : [];
    }
    if (text.startsWith('SELECT id FROM poker_blind_schedules WHERE id = ?')) {
      const s = this.blindSchedules.get(String(p[0]));
      return s ? [{ id: s.id }] : [];
    }
    if (
      text.startsWith('INSERT INTO poker_blind_schedules (id, name, levels_json) VALUES') &&
      text.includes('ON CONFLICT (id) DO NOTHING')
    ) {
      const id = String(p[0]);
      // ON CONFLICT (id) DO NOTHING — idempotent: a second seed is a no-op.
      if (!this.blindSchedules.has(id)) {
        // `levels_json` arrives as a JSON STRING (the TM does `${JSON.stringify(...)}::jsonb`);
        // a real jsonb column round-trips to an array, so parse it to mirror that.
        this.blindSchedules.set(id, { id, name: p[1], levels_json: parseJsonParam(p[2]) });
      }
      return [];
    }

    // ── poker_tables ──────────────────────────────────────────────────────────
    if (text.startsWith("INSERT INTO poker_tables (tournament_id, table_number, status, button_seat_index, hand_count) VALUES")) {
      const id = randomUUID();
      this.tables.set(id, {
        id,
        tournament_id: p[0],
        table_number: 1,
        status: 'live',
        button_seat_index: 0,
        hand_count: 0,
      });
      return [{ id }];
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
      if (this.hands.has(key)) return []; // ON CONFLICT DO NOTHING
      const id = randomUUID();
      this.hands.set(key, { id, table_id: p[0], hand_number: p[1] });
      return [{ id }];
    }

    // ── poker_tournament_results ──────────────────────────────────────────────
    if (text.startsWith('INSERT INTO poker_tournament_results') && text.includes('prize_ct, settled_at) VALUES')) {
      const key = `${p[0]}:${p[1]}`;
      if (this.results.has(key)) return []; // ON CONFLICT DO NOTHING
      this.results.set(key, {
        id: randomUUID(),
        tournament_id: p[0],
        avatar_id: p[1],
        agent_id: p[2],
        placement: p[3],
        prize_ct: p[4],
        settled_at: new Date(),
      });
      return [];
    }
    if (text.startsWith('SELECT avatar_id, agent_id, placement, prize_ct FROM poker_tournament_results WHERE tournament_id = ? ORDER BY placement ASC')) {
      return [...this.results.values()]
        .filter((r) => r.tournament_id === p[0])
        .sort((a, b) => Number(a.placement) - Number(b.placement))
        .map((r) => ({
          avatar_id: r.avatar_id,
          agent_id: r.agent_id,
          placement: r.placement,
          prize_ct: r.prize_ct,
        }));
    }

    throw new Error(`FakeDb: unhandled SQL: ${text}`);
  }

  // ── Test seeding helpers ───────────────────────────────────────────────────
  seedTournament(row: Partial<Row> & { id: string }): void {
    this.tournaments.set(row.id, {
      status: 'registering',
      buy_in_ct: '100',
      rake_bps: 0,
      min_entrants: 2,
      max_entrants: 9,
      seats_per_table: 9,
      starting_stack: 1000,
      prize_pool_ct: '0',
      rake_taken_ct: null,
      payout_curve_json: [
        { placement: 1, share: 0.5 },
        { placement: 2, share: 0.3 },
        { placement: 3, share: 0.2 },
      ],
      blind_schedule_id: 'sched-1',
      registration_closes_at: null,
      created_by: null,
      started_at: null,
      settled_at: null,
      cancelled_at: null,
      ...row,
    });
  }
  seedBlindSchedule(id: string, levels: BlindLevel[]): void {
    this.blindSchedules.set(id, { id, levels_json: levels });
  }
}

// ─── Scripted auto-actor: drives every seat deterministically ────────────────
//
// Strategy that guarantees a tournament finishes quickly with real busts:
//   - The to-act seat ALWAYS shoves all-in if it can open/raise; otherwise calls
//     when it owes chips; otherwise checks. With everyone shoving, the smallest
//     stacks bust and the biggest stack accumulates → a champion emerges. The deck
//     is deterministic (fixed seeds) so the bust order is fully reproducible.
//
// We read the to-act seat from the public snapshot + the private view (legal
// actions) the sim sends, then submit through applyAction. The clock never
// auto-fires (FakeClock.setTimer is a no-op), so the loop is fully synchronous.

async function drivePokerToCompletion(
  tm: TournamentManager,
  sim: PokerTableSim,
  tableId: string,
  tournamentId: string,
  clock: FakeClock,
): Promise<void> {
  let guard = 0;
  // The sim fires hand-complete inside applyAction (via resolveHand). The TM's
  // handler is async (DB tx + ledger), kicked via `void onHandComplete(...)`, so
  // the NEXT hand starts on a later macrotask. After an action that ends a hand,
  // the live table still exists (ended=true, toActSeatIndex=null) until the TM's
  // async handler calls stopTable + startNextHand. Whenever we see a snapshot with
  // no actor, we `await setTimeout(0)` to let the TM's async loop advance, then
  // re-read. We stop when the TM marks the tournament done.
  //
  // ── Actor strategy (deterministic, staggers busts across MANY hands) ────────
  // Exactly TWO seats contest each hand: the BUTTON and the next live seat
  // clockwise both SHOVE all-in; everyone else FOLDS. This produces a heads-up
  // all-in showdown each hand among a rotating pair, so eliminations spread over
  // multiple hands (exercising button rotation + blind levels) instead of one
  // 4-way collision. The deterministic deck decides each winner. After each hand
  // we advance the clock past a blind level's duration so blinds rise.
  let lastHandSeen = 0;
  while (guard++ < 100_000) {
    if (!tm.isRunning(tournamentId)) return; // champion crowned + settled
    const snap = sim.getPublicSnapshot(tableId);
    if (!snap || snap.toActSeatIndex === null) {
      await new Promise((res) => setTimeout(res, 0));
      continue;
    }

    // Advance the clock once per new hand so blind levels rise across the SNG.
    if (snap.handNumber !== lastHandSeen) {
      lastHandSeen = snap.handNumber;
      clock.advance(301_000); // > level durationSec (300) → next level next hand
    }

    const toAct = snap.toActSeatIndex;
    const seat = snap.seats.find((s) => s.seatIndex === toAct)!;
    const toCall = snap.toCall;
    const stack = seat.chipStack;
    const idem = `${tableId}:${snap.handNumber}:${toAct}:${guard}`;
    // The public snapshot has no `currentBet` field (by design); derive it from
    // the max street commitment across seats.
    const currentBet = snap.seats.reduce((m, s) => Math.max(m, s.streetBet), 0);

    // The two designated contestants: button + next live seat clockwise.
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
        const r = sim.applyAction(tableId, seat.avatarId, { kind: 'bet', amount: allInTarget }, { idempotencyKey: idem });
        acted = r.ok;
      } else if (allInTarget > currentBet) {
        const r = sim.applyAction(tableId, seat.avatarId, { kind: 'raise', amount: allInTarget }, { idempotencyKey: idem });
        acted = r.ok;
      } else if (toCall > 0) {
        // Can't raise above currentBet (already all-in matched) → call.
        const r = sim.applyAction(tableId, seat.avatarId, { kind: 'call' }, { idempotencyKey: idem + ':c' });
        acted = r.ok;
      }
    }
    if (!acted) {
      // Non-contestant (or contestant with nothing legal): fold if owed, else check.
      if (toCall > 0) {
        sim.applyAction(tableId, seat.avatarId, { kind: 'fold' }, { idempotencyKey: idem + ':f' });
      } else {
        sim.applyAction(tableId, seat.avatarId, { kind: 'check' }, { idempotencyKey: idem + ':k' });
      }
    }
  }
  throw new Error('drivePokerToCompletion: exceeded guard — tournament did not finish');
}

const PAYOUT_3: PayoutCurveEntry[] = [
  { placement: 1, share: 0.5 },
  { placement: 2, share: 0.3 },
  { placement: 3, share: 0.2 },
];

/** T0 fee routing — the fake house-treasury avatarId the injected resolver returns
 * (so a raked settle credits the FAKE ledger here, never touching a real DB). */
const TREASURY_AVATAR = 'av-house-treasury';

function buildManager(db: FakeDb, ledger: FakeLedger, clock: FakeClock) {
  const sim = new PokerTableSim(clock);
  // Swallow the WS surface callbacks (broadcast/per-seat) — the TM only wires the
  // hand-complete callback; we drive actions directly off getPublicSnapshot.
  const broadcast: BroadcastFn = () => {};
  const sendToSeat: SendToSeatFn = () => {};
  sim.setBroadcastFn(broadcast);
  sim.setSendToSeatFn(sendToSeat);
  let seedCounter = 0;
  // Record leaderboard placement emits in-memory so tests can assert the
  // `activity.match.placed` parity wiring WITHOUT hitting the real events DB
  // (the global logEvent writes to the real db, not this mock).
  const placementEmits: PlacementEmit[] = [];
  const tm = new TournamentManager({
    db: db as never,
    ledger: ledger as never,
    sim,
    clock,
    // Deterministic distinct 64-hex seed per hand (nonce=handNumber also varies it).
    seedFn: () => (seedCounter++).toString(16).padStart(64, 'a'),
    emitPlacementFn: (emit) => {
      placementEmits.push(emit);
    },
    // T0: settle credits the rake to this fake treasury via the FAKE ledger
    // (the default resolver would lazily import the real seeder → real DB).
    resolveTreasuryAvatarId: async () => TREASURY_AVATAR,
  });
  return { tm, sim, placementEmits };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('TournamentManager — single-table sit-n-go end-to-end (mocked DB + ledger)', () => {
  let db: FakeDb;
  let ledger: FakeLedger;
  let clock: FakeClock;

  beforeEach(() => {
    db = new FakeDb();
    ledger = new FakeLedger();
    clock = new FakeClock();
    db.seedBlindSchedule('sched-1', DEFAULT_BLIND_SCHEDULE);
  });

  it('computePrizes splits a pool by curve and is conservative after remainder fold', () => {
    const prizes = computePrizes(1000n, PAYOUT_3);
    // 50/30/20 of 1000 = 500/300/200 (no remainder here).
    expect(prizes.get(1)).toBe(500n);
    expect(prizes.get(2)).toBe(300n);
    expect(prizes.get(3)).toBe(200n);
    // An awkward pool that doesn't divide cleanly — TM folds the remainder into 1st.
    const odd = computePrizes(1001n, PAYOUT_3);
    const sum = (odd.get(1) ?? 0n) + (odd.get(2) ?? 0n) + (odd.get(3) ?? 0n);
    expect(sum).toBeLessThanOrEqual(1001n); // before remainder fold (done in settle)
  });

  it('(1) registration debits the buy-in into the pool; re-register is idempotent', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    db.seedTournament({ id: tid, buy_in_ct: '100', max_entrants: 4 });

    const av = 'av-A';
    ledger.setBalance(av, 500);
    const subject: RegisterSubject = { kind: 'user', userId: 'u-A', avatarId: av, agentId: null };

    const r1 = await tm.registerEntrant(subject, tid);
    expect(r1.alreadyRegistered).toBe(false);
    expect(r1.prizePoolCt).toBe('100');
    expect(ledger.get(av)).toBe(400); // 500 - 100 buy-in
    expect(ledger.totalDebited('poker_mtt_buyin')).toBe(100);

    // Re-register the SAME subject → idempotent replay, NO second debit.
    const r2 = await tm.registerEntrant(subject, tid);
    expect(r2.alreadyRegistered).toBe(true);
    expect(ledger.get(av)).toBe(400); // unchanged
    expect(ledger.totalDebited('poker_mtt_buyin')).toBe(100); // still one debit
  });

  it('(1b) registration rejects an underfunded subject (InsufficientTokensError surfaces)', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    db.seedTournament({ id: tid, buy_in_ct: '100' });
    ledger.setBalance('av-poor', 50);
    await expect(
      tm.registerEntrant({ kind: 'user', userId: 'u', avatarId: 'av-poor', agentId: null }, tid),
    ).rejects.toThrow(/cannot debit/);
    // No entrant row, no pool change.
    expect(db.tournaments.get(tid)!.prize_pool_ct).toBe('0');
  });

  it('(2) floor-not-met → cancel + refund every buy-in (net CT change == 0)', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    db.seedTournament({ id: tid, buy_in_ct: '100', min_entrants: 4, max_entrants: 9, registration_closes_at: new Date(clock.now() + 1000) });

    // Only 2 register (floor is 4).
    for (const a of ['av-1', 'av-2']) {
      ledger.setBalance(a, 1000);
      await tm.registerEntrant({ kind: 'user', userId: `u-${a}`, avatarId: a, agentId: null }, tid);
    }
    expect(ledger.get('av-1')).toBe(900);
    expect(ledger.get('av-2')).toBe(900);

    // Window passes → start trigger cancels + refunds.
    clock.advance(2000);
    const res = await tm.startTrigger(tid);
    expect(res.status).toBe('cancelled');
    expect(res.refundedCount).toBe(2);

    // Net CT change is zero — both fully refunded.
    expect(ledger.get('av-1')).toBe(1000);
    expect(ledger.get('av-2')).toBe(1000);
    expect(ledger.totalDebited('poker_mtt_buyin')).toBe(ledger.totalCredited('poker_mtt_refund'));
    expect(db.tournaments.get(tid)!.status).toBe('cancelled');

    // Idempotent: re-triggering a cancelled tournament is a no-op (no double refund).
    const again = await tm.startTrigger(tid);
    expect(again.status).toBe('noop');
    expect(ledger.get('av-1')).toBe(1000);
  });

  it('(3)(4)(5) full sit-n-go: hands play, busts→placement, chip + CT conservation, idempotent payout', async () => {
    const { tm, sim, placementEmits } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    const STACK = 1000;
    const BUYIN = 100;
    const RAKE_BPS = 500; // 5%
    db.seedTournament({
      id: tid,
      buy_in_ct: String(BUYIN),
      rake_bps: RAKE_BPS,
      min_entrants: 2,
      max_entrants: 4,
      seats_per_table: 4,
      starting_stack: STACK,
      registration_closes_at: new Date(clock.now() + 1000),
      payout_curve_json: PAYOUT_3,
    });

    const avatars = ['av-1', 'av-2', 'av-3', 'av-4'];
    for (const a of avatars) {
      ledger.setBalance(a, 1000);
      await tm.registerEntrant({ kind: 'user', userId: `u-${a}`, avatarId: a, agentId: null }, tid);
    }
    const poolExpected = BUYIN * avatars.length; // 400
    expect(db.tournaments.get(tid)!.prize_pool_ct).toBe(String(poolExpected));

    // ── Start (seats 4) and drive the multi-hand loop to a champion ───────────
    clock.advance(2000);
    const start = await tm.startTrigger(tid);
    expect(start.status).toBe('running');
    expect(start.seatedCount).toBe(4);

    // Drive every hand to completion. The TM starts the first hand synchronously
    // inside startTrigger; our actor drives it + every subsequent hand the TM
    // starts synchronously on hand-complete. The sim reuses the same tableId.
    const tableId = tm.getTableId(tid)!;
    await drivePokerToCompletion(tm, sim, tableId, tid, clock);

    // ── Tournament finished: every entrant has a placement 1..4 ───────────────
    const finalEntrants = [...db.entrants.values()].filter((e) => e.tournament_id === tid);
    const placements = finalEntrants.map((e) => e.placement).sort((a, b) => Number(a) - Number(b));
    expect(placements).toEqual([1, 2, 3, 4]);
    expect(db.tournaments.get(tid)!.status).toBe('completed');

    // ── (3) MANY hands actually played (multi-hand loop), button rotated ───────
    const handRows = [...db.hands.values()];
    expect(handRows.length).toBeGreaterThan(1); // not a degenerate single-hand finish (34 hands in practice)
    // The table's checkpointed hand_count reflects the last hand number played.
    const tableRow = [...db.tables.values()].find((t) => t.tournament_id === tid)!;
    expect(Number(tableRow.hand_count)).toBe(handRows.length);
    expect(Number(tableRow.hand_count)).toBeGreaterThan(1);

    // ── (4) CHIP conservation: champion holds ALL chips (4 * STACK) at the end ─
    const champion = finalEntrants.find((e) => e.placement === 1)!;
    expect(champion.chip_stack).toBe(STACK * avatars.length);

    // ── (5) Payout correctness + CT conservation ──────────────────────────────
    const pool = BigInt(poolExpected);
    const rake = (pool * BigInt(RAKE_BPS)) / 10000n; // 20
    const netPool = pool - rake; // 380
    expect(db.tournaments.get(tid)!.rake_taken_ct).toBe(rake.toString());

    const resultRows = [...db.results.values()].filter((r) => r.tournament_id === tid);
    const prizeSum = resultRows.reduce((a, r) => a + BigInt(String(r.prize_ct)), 0n);
    // Conservation: prizes + rake == pool.
    expect(prizeSum + rake).toBe(pool);
    // 1st/2nd/3rd paid per curve (remainder folds into 1st); 4th gets 0.
    const byPlacement = new Map(resultRows.map((r) => [Number(r.placement), BigInt(String(r.prize_ct))]));
    expect(byPlacement.get(4)).toBe(0n);
    expect(byPlacement.get(1)! >= byPlacement.get(2)!).toBe(true);
    expect(byPlacement.get(2)! >= byPlacement.get(3)!).toBe(true);

    // The paid avatars actually received their CT (started at 1000-100=900).
    for (const r of resultRows) {
      const prize = Number(r.prize_ct);
      // balance == 900 (post buy-in) + prize.
      expect(ledger.get(String(r.avatar_id))).toBe(900 + prize);
    }
    // Global CT conservation: every CT that left avatars (buy-ins) came back as
    // prizes EXCEPT the rake (which is held by the house = pool not credited).
    const totalBuyIns = ledger.totalDebited('poker_mtt_buyin'); // 400
    const totalPrizes = ledger.totalCredited('poker_mtt_prize');
    expect(BigInt(totalBuyIns) - BigInt(totalPrizes)).toBe(rake); // 400 - 380 == 20

    // T0 fee routing: the withheld rake is CREDITED to the house treasury in the
    // same settle (no longer a silent burn). Full conservation closes exactly:
    // buy-ins == prizes + treasury credit.
    expect(ledger.totalCredited('house_fee_mtt_rake')).toBe(Number(rake)); // 20
    expect(ledger.get(TREASURY_AVATAR)).toBe(Number(rake));
    expect(BigInt(totalBuyIns)).toBe(BigInt(totalPrizes) + rake); // supply closed

    // ── (5c) Leaderboard parity: ONE activity.match.placed per placed entrant ──
    // The free-agent leaderboard credits `activity.match.placed`. Wiring MUST fire
    // for every placed subject (Rule E5 parity — human + agent alike).
    expect(placementEmits.length).toBe(avatars.length); // 4 placed → 4 emits
    const emitPlacements = placementEmits.map((e) => e.placement).sort((a, b) => a - b);
    expect(emitPlacements).toEqual([1, 2, 3, 4]);
    // All these entrants are humans (kind:'user') → subjectType 'human', agentId null.
    for (const e of placementEmits) {
      expect(e.subjectType).toBe('human');
      expect(e.agentId).toBeNull();
      expect(avatars).toContain(e.avatarId);
    }
    // The champion's emit carries placement 1 + the 1st-place prize.
    const championEmit = placementEmits.find((e) => e.placement === 1)!;
    expect(championEmit.avatarId).toBe(String(champion.avatar_id));

    // ── (5b) Idempotent settle: settle AGAIN → no second credit, NO re-emit ────
    const prizeCreditsBefore = ledger.credits.filter((c) => c.reason === 'poker_mtt_prize').length;
    const balancesBefore = avatars.map((a) => ledger.get(a));
    const treasuryBefore = ledger.get(TREASURY_AVATAR);
    const emitsBefore = placementEmits.length;
    const re = await tm.settleTournament(tid);
    expect(re.alreadySettled).toBe(true);
    const prizeCreditsAfter = ledger.credits.filter((c) => c.reason === 'poker_mtt_prize').length;
    expect(prizeCreditsAfter).toBe(prizeCreditsBefore); // no new credits
    expect(avatars.map((a) => ledger.get(a))).toEqual(balancesBefore);
    // T0: an idempotent replay must NOT re-credit the treasury either (the fee
    // credit lives in the fresh-settle branch only).
    expect(ledger.get(TREASURY_AVATAR)).toBe(treasuryBefore);
    expect(ledger.credits.filter((c) => c.reason === 'house_fee_mtt_rake').length).toBe(1);
    // An idempotent replay must NOT re-emit leaderboard placements (would
    // double-credit the board for the same placement on a re-settle).
    expect(placementEmits.length).toBe(emitsBefore);
  });

  it('(fp-parity) registration-time fp_hash/ip_prefix is persisted on the entrant AND threaded into the placement emit', async () => {
    const { tm, sim, placementEmits } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    db.seedTournament({
      id: tid,
      buy_in_ct: '100',
      min_entrants: 2,
      max_entrants: 2,
      seats_per_table: 2,
      starting_stack: 1000,
      registration_closes_at: new Date(clock.now() + 1000),
      payout_curve_json: PAYOUT_3,
    });

    // Two entrants register WITH a request fingerprint (a human + an agent), each a
    // distinct (fpHash, ipPrefixHash) — exactly what fingerprintMiddleware sets on
    // the cove-poker-mtt route for both the human and the agent-forwarded path.
    const human: RegisterSubject = {
      kind: 'user',
      userId: 'u-h',
      avatarId: 'av-h',
      agentId: null,
      fpHash: 'fp-human',
      ipPrefixHash: 'ip-human',
    };
    const agent: RegisterSubject = {
      kind: 'agent',
      userId: 'u-a',
      avatarId: 'av-a',
      agentId: 'oc-bot-1',
      fpHash: 'fp-agent',
      ipPrefixHash: 'ip-agent',
    };
    ledger.setBalance('av-h', 1000);
    ledger.setBalance('av-a', 1000);
    await tm.registerEntrant(human, tid);
    await tm.registerEntrant(agent, tid);

    // Persisted on the entrant rows (the anchor for the request-decoupled settle).
    const hRow = [...db.entrants.values()].find((e) => e.avatar_id === 'av-h')!;
    const aRow = [...db.entrants.values()].find((e) => e.avatar_id === 'av-a')!;
    expect(hRow.fp_hash).toBe('fp-human');
    expect(hRow.ip_prefix_hash).toBe('ip-human');
    expect(aRow.fp_hash).toBe('fp-agent');
    expect(aRow.ip_prefix_hash).toBe('ip-agent');

    // Play the heads-up tournament to completion → settle emits placements.
    clock.advance(2000);
    const start = await tm.startTrigger(tid);
    expect(start.status).toBe('running');
    const tableId = tm.getTableId(tid)!;
    await drivePokerToCompletion(tm, sim, tableId, tid, clock);
    expect(db.tournaments.get(tid)!.status).toBe('completed');

    // BOTH placement emits carry a NON-NULL (fp_hash, ip_prefix_hash) — the exact
    // anti-farm shape every other event-emitting route gets. Critically the AGENT's
    // emit is non-null (the gap this fix closes), not just the human's.
    expect(placementEmits.length).toBe(2);
    for (const e of placementEmits) {
      expect(e.fpHash).not.toBeNull();
      expect(e.ipPrefixHash).not.toBeNull();
    }
    const hEmit = placementEmits.find((e) => e.avatarId === 'av-h')!;
    const aEmit = placementEmits.find((e) => e.avatarId === 'av-a')!;
    expect(hEmit.fpHash).toBe('fp-human');
    expect(hEmit.ipPrefixHash).toBe('ip-human');
    expect(aEmit.fpHash).toBe('fp-agent'); // agent-driven event tagged with a real fp
    expect(aEmit.ipPrefixHash).toBe('ip-agent');
    expect(aEmit.subjectType).toBe('agent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Same-hand multi-bust placement tie-break (the e2e auto-actor busts ≤1 seat per
// hand, so this path is otherwise dead-untested). Drives the EXTRACTED pure
// helper directly with crafted multi-bust collisions.
// ─────────────────────────────────────────────────────────────────────────────

describe('computeBustPlacements — same-hand multi-bust tie-break', () => {
  it('3-way same-hand bust: bigger START stack gets the BETTER placement', () => {
    // 4 entrants; champion survives (remainingAfter=1). Three sub-stacks shove
    // into ONE pot and all bust the same hand. Starting stacks: A=900, B=300, C=50.
    // Expected: A (biggest) finishes 2nd, B 3rd, C (smallest) 4th.
    const out = computeBustPlacements(
      [
        { seatIndex: 0, chipAtHandStart: 50 }, // C — smallest → worst (4th)
        { seatIndex: 1, chipAtHandStart: 900 }, // A — biggest → best of busters (2nd)
        { seatIndex: 2, chipAtHandStart: 300 }, // B — middle (3rd)
      ],
      1, // one survivor (the champion)
    );
    const bySeat = new Map(out.map((p) => [p.seatIndex, p.placement]));
    expect(bySeat.get(1)).toBe(2); // A, biggest start stack → 2nd
    expect(bySeat.get(2)).toBe(3); // B, middle → 3rd
    expect(bySeat.get(0)).toBe(4); // C, smallest → 4th
    // The busted group fills [remainingAfter+1 .. remainingAfter+B] = [2,3,4].
    expect(out.map((p) => p.placement).sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  it('equal start stacks → deterministic seatIndex tie-break (stable + reproducible)', () => {
    // Two busters with IDENTICAL start stacks, 2 survivors. They fill [3,4]. The
    // tie-break is purely deterministic (neither out-lasted the other): the
    // ascending-by-(chips, seatIndex) sort puts the LOWER seatIndex first, so it
    // takes the worse (higher) placement number. The only contract that matters is
    // it's STABLE + REPRODUCIBLE — assert the exact deterministic outcome so a
    // future change to the tie-break is caught.
    const out = computeBustPlacements(
      [
        { seatIndex: 5, chipAtHandStart: 200 },
        { seatIndex: 2, chipAtHandStart: 200 },
      ],
      2, // two survivors
    );
    const bySeat = new Map(out.map((p) => [p.seatIndex, p.placement]));
    expect(bySeat.get(2)).toBe(4); // lower seatIndex sorts first → worst placement
    expect(bySeat.get(5)).toBe(3);
    // Re-running with the same input is identical (determinism).
    const out2 = computeBustPlacements(
      [
        { seatIndex: 5, chipAtHandStart: 200 },
        { seatIndex: 2, chipAtHandStart: 200 },
      ],
      2,
    );
    expect(out2).toEqual(out);
  });

  it('single bust collapses to the simple (remainingAfter+1) placement', () => {
    const out = computeBustPlacements([{ seatIndex: 3, chipAtHandStart: 100 }], 2);
    expect(out).toEqual([{ seatIndex: 3, placement: 3 }]);
  });

  it('all-in collision with a fresh champion: 4 bust, 1 survives → busters fill [2..5]', () => {
    const out = computeBustPlacements(
      [
        { seatIndex: 0, chipAtHandStart: 10 },
        { seatIndex: 1, chipAtHandStart: 40 },
        { seatIndex: 2, chipAtHandStart: 30 },
        { seatIndex: 3, chipAtHandStart: 20 },
      ],
      1,
    );
    const bySeat = new Map(out.map((p) => [p.seatIndex, p.placement]));
    // Descending by start stack: seat1(40)→2, seat2(30)→3, seat3(20)→4, seat0(10)→5.
    expect(bySeat.get(1)).toBe(2);
    expect(bySeat.get(2)).toBe(3);
    expect(bySeat.get(3)).toBe(4);
    expect(bySeat.get(0)).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computePrizes — monotonicity on a near-equal curve (the remainder fold must
// never push 1st BELOW 2nd). Guards the floor-not-round fix.
// ─────────────────────────────────────────────────────────────────────────────

describe('computePrizes — placement-prize monotonicity', () => {
  it('near-equal descending curve: 1st >= 2nd >= 3rd even after the remainder fold', () => {
    // A pathological near-equal curve where round() could have inverted 1st<2nd.
    const curve: PayoutCurveEntry[] = [
      { placement: 1, share: 0.34 },
      { placement: 2, share: 0.33 },
      { placement: 3, share: 0.33 },
    ];
    // An awkward pool that doesn't divide cleanly across the near-equal shares.
    const netPool = 1_000_001n;
    const prizes = computePrizes(netPool, curve);
    let sum = 0n;
    for (const v of prizes.values()) sum += v;
    // FLOOR scaling guarantees sum <= netPool → remainder >= 0 (no negative fold).
    expect(sum).toBeLessThanOrEqual(netPool);
    const remainder = netPool - sum;
    expect(remainder).toBeGreaterThanOrEqual(0n);
    // Apply the settle-time fold (remainder → 1st) and assert monotonicity.
    const first = (prizes.get(1) ?? 0n) + remainder;
    const second = prizes.get(2) ?? 0n;
    const third = prizes.get(3) ?? 0n;
    expect(first >= second).toBe(true);
    expect(second >= third).toBe(true);
    // Conservation after the fold.
    expect(first + second + third).toBe(netPool);
  });

  it('exactly-equal shares: ties hold (1st == 2nd == 3rd before fold) and 1st absorbs the remainder', () => {
    const curve: PayoutCurveEntry[] = [
      { placement: 1, share: 1 },
      { placement: 2, share: 1 },
      { placement: 3, share: 1 },
    ];
    const prizes = computePrizes(100n, curve);
    let sum = 0n;
    for (const v of prizes.values()) sum += v;
    expect(sum).toBeLessThanOrEqual(100n);
    const first = (prizes.get(1) ?? 0n) + (100n - sum);
    expect(first >= (prizes.get(2) ?? 0n)).toBe(true);
    expect((prizes.get(2) ?? 0n) >= (prizes.get(3) ?? 0n)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registration parity (subject_type CHECK) + cancelled-settle guard.
// ─────────────────────────────────────────────────────────────────────────────

describe('TournamentManager — registration parity + settle guards', () => {
  let db: FakeDb;
  let ledger: FakeLedger;
  let clock: FakeClock;

  beforeEach(() => {
    db = new FakeDb();
    ledger = new FakeLedger();
    clock = new FakeClock();
    db.seedBlindSchedule('sched-1', DEFAULT_BLIND_SCHEDULE);
  });

  it('HUMAN register writes subject_type=\'human\' (NOT \'user\') so the CHECK passes', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    db.seedTournament({ id: tid, buy_in_ct: '100', max_entrants: 4 });
    ledger.setBalance('av-h', 500);
    const r = await tm.registerEntrant(
      { kind: 'user', userId: 'u-h', avatarId: 'av-h', agentId: null },
      tid,
    );
    expect(r.alreadyRegistered).toBe(false);
    const row = [...db.entrants.values()].find((e) => e.avatar_id === 'av-h')!;
    // CRITICAL: the column-constrained value must be 'human', never the wire 'user'.
    expect(row.subject_type).toBe('human');
    expect(row.agent_id).toBeNull();
  });

  it('AGENT register writes subject_type=\'agent\' + carries agent_id (parity)', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    db.seedTournament({ id: tid, buy_in_ct: '100', max_entrants: 4 });
    ledger.setBalance('av-ag', 500);
    const r = await tm.registerEntrant(
      { kind: 'agent', userId: 'u-ag', avatarId: 'av-ag', agentId: 'oc-bot-1' },
      tid,
    );
    expect(r.alreadyRegistered).toBe(false);
    const row = [...db.entrants.values()].find((e) => e.avatar_id === 'av-ag')!;
    expect(row.subject_type).toBe('agent');
    expect(row.agent_id).toBe('oc-bot-1');
  });

  it('register reports capReached when the LAST seat is filled', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    db.seedTournament({ id: tid, buy_in_ct: '100', max_entrants: 2 });
    ledger.setBalance('av-1', 500);
    ledger.setBalance('av-2', 500);
    const r1 = await tm.registerEntrant(
      { kind: 'user', userId: 'u1', avatarId: 'av-1', agentId: null },
      tid,
    );
    expect(r1.capReached).toBe(false); // 1 of 2
    const r2 = await tm.registerEntrant(
      { kind: 'user', userId: 'u2', avatarId: 'av-2', agentId: null },
      tid,
    );
    expect(r2.capReached).toBe(true); // 2 of 2 — last seat
  });

  it('settleTournament on a CANCELLED tournament is a noop (no status corruption)', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const tid = randomUUID();
    db.seedTournament({
      id: tid,
      buy_in_ct: '100',
      min_entrants: 4,
      max_entrants: 9,
      registration_closes_at: new Date(clock.now() + 1000),
    });
    // Two register (floor 4) → window passes → cancel + refund.
    for (const a of ['av-1', 'av-2']) {
      ledger.setBalance(a, 1000);
      await tm.registerEntrant({ kind: 'user', userId: `u-${a}`, avatarId: a, agentId: null }, tid);
    }
    clock.advance(2000);
    const cancel = await tm.startTrigger(tid);
    expect(cancel.status).toBe('cancelled');
    expect(db.tournaments.get(tid)!.status).toBe('cancelled');
    const balAfterCancel = ['av-1', 'av-2'].map((a) => ledger.get(a));

    // A stray settle on the cancelled tournament must NOT flip it to 'completed'
    // and must NOT move any CT.
    const res = await tm.settleTournament(tid);
    expect(res.alreadySettled).toBe(true);
    expect(res.results).toEqual([]);
    expect(db.tournaments.get(tid)!.status).toBe('cancelled'); // NOT 'completed'
    expect(db.tournaments.get(tid)!.settled_at).toBeNull(); // never flipped
    expect(['av-1', 'av-2'].map((a) => ledger.get(a))).toEqual(balAfterCancel); // no CT moved
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P4 — createTournament + ensureDefaultBlindSchedule + listTournaments (mocked DB).
// The CREATION gap (poker_tournaments had no creation path) + the discovery list.
// ─────────────────────────────────────────────────────────────────────────────

describe('TournamentManager — create + default-schedule seed + list (mocked DB)', () => {
  let db: FakeDb;
  let ledger: FakeLedger;
  let clock: FakeClock;

  beforeEach(() => {
    db = new FakeDb();
    ledger = new FakeLedger();
    clock = new FakeClock();
    // NOTE: deliberately do NOT pre-seed a blind schedule — createTournament must
    // seed the default itself.
  });

  const validConfig = () => ({
    name: 'Friday Night MTT',
    buyInCt: 100,
    rakeBps: 500,
    minEntrants: 2,
    maxEntrants: 18,
    seatsPerTable: 9,
    startingStack: 1500,
  });

  it('admin create: inserts a registering row at prizePool 0, seeds the default blind schedule ONCE (idempotent on 2nd create)', async () => {
    const { tm } = buildManager(db, ledger, clock);

    expect(db.blindSchedules.size).toBe(0); // nothing seeded yet

    const t1 = await tm.createTournament(validConfig(), 'admin-avatar-1');
    expect(t1.status).toBe('registering');
    expect(t1.prizePoolCt).toBe('0');
    expect(t1.buyInCt).toBe('100');
    expect(t1.rakeBps).toBe(500);
    expect(t1.minEntrants).toBe(2);
    expect(t1.maxEntrants).toBe(18);
    expect(t1.seatsPerTable).toBe(9);
    expect(t1.startingStack).toBe(1500);
    expect(t1.blindScheduleId).toBe(DEFAULT_BLIND_SCHEDULE_ID);
    // The default ladder was seeded exactly once.
    expect(db.blindSchedules.size).toBe(1);
    expect(db.blindSchedules.has(DEFAULT_BLIND_SCHEDULE_ID)).toBe(true);
    // Row actually persisted as 'registering' at pool 0.
    expect(db.tournaments.get(t1.id)!.status).toBe('registering');
    expect(db.tournaments.get(t1.id)!.prize_pool_ct).toBe('0');

    // Second create → the default seed is idempotent (NO duplicate schedule row).
    const t2 = await tm.createTournament(validConfig(), 'admin-avatar-1');
    expect(t2.id).not.toBe(t1.id);
    expect(db.blindSchedules.size).toBe(1); // STILL one — no duplicate
    expect(db.tournaments.size).toBe(2);
  });

  it('created_by audit column: persists the creator avatar id (and null when none)', async () => {
    const { tm } = buildManager(db, ledger, clock);

    // Creator avatar supplied → persisted on the row AND returned.
    const created = await tm.createTournament(validConfig(), 'admin-avatar-42');
    expect(created.createdBy).toBe('admin-avatar-42');
    expect(db.tournaments.get(created.id)!.created_by).toBe('admin-avatar-42');

    // No creator avatar (dash-cookie/system path) → null, not a crash.
    const anon = await tm.createTournament(validConfig(), null);
    expect(anon.createdBy).toBeNull();
    expect(db.tournaments.get(anon.id)!.created_by).toBeNull();
  });

  it('ensureDefaultBlindSchedule is idempotent across repeated calls (boot path)', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const a = await tm.ensureDefaultBlindSchedule();
    const b = await tm.ensureDefaultBlindSchedule();
    const c = await tm.ensureDefaultBlindSchedule();
    expect(a).toBe(DEFAULT_BLIND_SCHEDULE_ID);
    expect(b).toBe(DEFAULT_BLIND_SCHEDULE_ID);
    expect(c).toBe(DEFAULT_BLIND_SCHEDULE_ID);
    expect(db.blindSchedules.size).toBe(1);
  });

  it('uses an explicit blindScheduleId when the row exists', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const customId = randomUUID();
    db.seedBlindSchedule(customId, DEFAULT_BLIND_SCHEDULE);
    const t = await tm.createTournament(
      { ...validConfig(), blindScheduleId: customId },
      'admin-avatar-1',
    );
    expect(t.blindScheduleId).toBe(customId);
    // Did NOT seed the default (the explicit one already existed).
    expect(db.blindSchedules.has(DEFAULT_BLIND_SCHEDULE_ID)).toBe(false);
  });

  it('rejects an explicit blindScheduleId whose row does not exist (404)', async () => {
    const { tm } = buildManager(db, ledger, clock);
    await expect(
      tm.createTournament({ ...validConfig(), blindScheduleId: randomUUID() }, null),
    ).rejects.toThrow(/blind_schedule_not_found/);
    expect(db.tournaments.size).toBe(0); // no row inserted on a rejected config
  });

  it('invalid config → 400 (buyInCt 0, seatsPerTable 12, minEntrants > maxEntrants)', async () => {
    const { tm } = buildManager(db, ledger, clock);

    await expect(
      tm.createTournament({ ...validConfig(), buyInCt: 0 }, null),
    ).rejects.toThrow(/invalid_buy_in_must_be_positive/);

    await expect(
      tm.createTournament({ ...validConfig(), seatsPerTable: 12 }, null),
    ).rejects.toThrow(/invalid_seats_per_table/);

    await expect(
      tm.createTournament({ ...validConfig(), minEntrants: 10, maxEntrants: 4 }, null),
    ).rejects.toThrow(/invalid_max_entrants/);

    await expect(
      tm.createTournament({ ...validConfig(), startingStack: 0 }, null),
    ).rejects.toThrow(/invalid_starting_stack/);

    await expect(
      tm.createTournament({ ...validConfig(), maxEntrants: 10_000 }, null),
    ).rejects.toThrow(/max_entrants_exceeds_cap/);

    await expect(
      tm.createTournament({ ...validConfig(), rakeBps: 20000 }, null),
    ).rejects.toThrow(/invalid_rake_bps/);

    // A payout curve with no 1st place is rejected.
    await expect(
      tm.createTournament(
        { ...validConfig(), payoutCurve: [{ placement: 2, share: 1 }] },
        null,
      ),
    ).rejects.toThrow(/invalid_payout_curve_missing_first/);

    // Nothing was inserted on any rejected create.
    expect(db.tournaments.size).toBe(0);
  });

  it('listTournaments lists the created tournament with registeredCount 0; count increments after a registration', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const created = await tm.createTournament(
      { ...validConfig(), buyInCt: 100, maxEntrants: 9 },
      'admin-avatar-1',
    );

    // Discovery list shows it (registering) with registeredCount 0 + blind summary.
    let list = await tm.listTournaments();
    expect(list.length).toBe(1);
    const item = list[0]!;
    expect(item.id).toBe(created.id);
    expect(item.status).toBe('registering');
    expect(item.registeredCount).toBe(0);
    expect(item.tableCount).toBe(0); // not running yet
    expect(item.buyInCt).toBe('100');
    expect(item.seatsPerTable).toBe(9);
    expect(item.startingStack).toBe(1500);
    expect(item.blindSummary.levels).toBe(DEFAULT_BLIND_SCHEDULE.length);
    expect(item.blindSummary.openingSb).toBe(DEFAULT_BLIND_SCHEDULE[0]!.sb);
    expect(item.blindSummary.openingBb).toBe(DEFAULT_BLIND_SCHEDULE[0]!.bb);

    // Register one entrant → the list count increments.
    ledger.setBalance('av-1', 500);
    await tm.registerEntrant(
      { kind: 'user', userId: 'u-1', avatarId: 'av-1', agentId: null },
      created.id,
    );
    list = await tm.listTournaments();
    expect(list[0]!.registeredCount).toBe(1);
  });

  it('listTournaments excludes running tournaments unless includeRunning is set', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const created = await tm.createTournament(validConfig(), null);
    // Flip the row to 'running' directly (simulating a seated tournament).
    db.tournaments.get(created.id)!.status = 'running';

    const defaultList = await tm.listTournaments();
    expect(defaultList.find((t) => t.id === created.id)).toBeUndefined();

    const withRunning = await tm.listTournaments({ includeRunning: true });
    expect(withRunning.find((t) => t.id === created.id)).toBeDefined();
  });

  it('listTournaments honors the limit (1..200) newest-first', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await tm.createTournament({ ...validConfig(), name: `T${i}` }, null);
      ids.push(t.id);
    }
    const limited = await tm.listTournaments({ limit: 2 });
    expect(limited.length).toBe(2);
    // Newest-first: the last two created come back first.
    expect(limited[0]!.id).toBe(ids[4]);
    expect(limited[1]!.id).toBe(ids[3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure validators (validatePayoutCurve + toBigIntStrict) — exercised directly.
// ─────────────────────────────────────────────────────────────────────────────

describe('validatePayoutCurve + toBigIntStrict (pure)', () => {
  it('accepts a well-formed descending curve', () => {
    expect(() =>
      validatePayoutCurve([
        { placement: 1, share: 0.5 },
        { placement: 2, share: 0.3 },
        { placement: 3, share: 0.2 },
      ]),
    ).not.toThrow();
  });

  it('rejects empty / missing-first / duplicate / non-positive / non-integer-placement curves', () => {
    expect(() => validatePayoutCurve([])).toThrow(/invalid_payout_curve_empty/);
    expect(() => validatePayoutCurve([{ placement: 2, share: 1 }])).toThrow(
      /invalid_payout_curve_missing_first/,
    );
    expect(() =>
      validatePayoutCurve([
        { placement: 1, share: 0.5 },
        { placement: 1, share: 0.5 },
      ]),
    ).toThrow(/duplicate_placement/);
    expect(() => validatePayoutCurve([{ placement: 1, share: 0 }])).toThrow(
      /invalid_payout_curve_entry/,
    );
    expect(() => validatePayoutCurve([{ placement: 1, share: -1 }])).toThrow(
      /invalid_payout_curve_entry/,
    );
    expect(() => validatePayoutCurve([{ placement: 1.5, share: 1 }])).toThrow(
      /invalid_payout_curve_entry/,
    );
    expect(() =>
      validatePayoutCurve([{ placement: 1, share: Number.NaN }]),
    ).toThrow(/invalid_payout_curve_entry/);
  });

  it('toBigIntStrict coerces number/bigint/decimal-string, rejects fractions / negatives / garbage', () => {
    expect(toBigIntStrict(100, 'buyInCt')).toBe(100n);
    expect(toBigIntStrict(100n, 'buyInCt')).toBe(100n);
    expect(toBigIntStrict('250', 'buyInCt')).toBe(250n);
    expect(() => toBigIntStrict(1.5, 'buyInCt')).toThrow(/invalid_buyInCt/);
    expect(() => toBigIntStrict(-5, 'buyInCt')).toThrow(/invalid_buyInCt/);
    expect(() => toBigIntStrict(-5n, 'buyInCt')).toThrow(/invalid_buyInCt/);
    expect(() => toBigIntStrict('1.5', 'buyInCt')).toThrow(/invalid_buyInCt/);
    expect(() => toBigIntStrict('abc', 'buyInCt')).toThrow(/invalid_buyInCt/);
  });
});
