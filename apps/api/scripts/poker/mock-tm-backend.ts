/**
 * mock-tm-backend.ts — the DRY-RUN in-process backend for multi-agent-stress.ts.
 *
 * Stands up the REAL `TournamentManager` + `PokerTableSim` (the settlement- and
 * hidden-state-owning core the server uses) on an in-memory FakeDb + FakeLedger +
 * FakeClock — the SAME injectable seams the committed unit tests exercise
 * (`tournament-multitable.test.ts`, `tournament-agent-play.test.ts`). It exposes
 * the route-equivalent methods the stress harness calls, so the orchestration +
 * assertions run path-identically with NO live server and NO DB.
 *
 * It is NOT a re-implementation of poker. The only NET-NEW code here is:
 *   1. The FakeDb/FakeLedger/FakeClock seams (copied from the proven tests).
 *   2. A `sessionId → {avatarId, agentId}` registry that mirrors what
 *      `resolveAgentSession` resolves on the live path (session → bound avatar),
 *      so register/state/action bind to the agent's avatar exactly like the route.
 *   3. A `pump()` driver that substitutes for the server event loop: it advances
 *      the blind clock per new hand and, as a stall-safety net, folds/checks any
 *      to-act seat whose owner isn't an orchestration-driven agent. Since the
 *      stress test seats ONLY agents, the agent loops drive every seat; pump only
 *      keeps the clock rising and drains the TM's async maintenance.
 *
 * Everything else (chip deltas, busts, placements, rebalance/break/consolidate,
 * settle, CT conservation, the hidden-state redaction) is the REAL TM + sim.
 */

import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  TournamentManager,
  DEFAULT_BLIND_SCHEDULE,
  type RegisterSubject,
  type PlacementEmit,
  type MttRoomBinding,
  type MttMoveInfo,
} from '../../src/services/poker/tournament-manager';
import { PokerTableSim } from '../../src/services/poker/poker-table-sim';
import type {
  SimClock,
  BroadcastFn,
  SendToSeatFn,
  Action,
} from '../../src/services/poker/poker-table-types';
import type { BlindLevel, PayoutCurveEntry } from '@clawville/database';

// ─── Fake clock (manual advance; no auto-fire) ───────────────────────────────
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

// ─── Fake ledger (in-memory CT; real InsufficientTokensError shape) ──────────
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
  debitClawTokens = async (input: { avatarId: string; amount: number; reason: string }, _tx?: unknown) => {
    const bal = this.get(input.avatarId);
    if (bal < input.amount) throw new InsufficientTokensError(input.avatarId, bal, input.amount);
    this.balances.set(input.avatarId, bal - input.amount);
    this.debits.push({ avatarId: input.avatarId, amount: input.amount, reason: input.reason });
    return { balanceAfter: bal - input.amount, ledgerId: randomUUID() };
  };
  creditClawTokens = async (input: { avatarId: string; amount: number; reason: string }, _tx?: unknown) => {
    const bal = this.get(input.avatarId);
    this.balances.set(input.avatarId, bal + input.amount);
    this.credits.push({ avatarId: input.avatarId, amount: input.amount, reason: input.reason });
    return { balanceAfter: bal + input.amount, ledgerId: randomUUID() };
  };
  transferClawTokens = async () => ({ fromBalance: 0, toBalance: 0 });
}

// ─── Fake DB: an in-memory interpreter for the EXACT SQL the TM emits ─────────
// Mirrors `tournament-multitable.test.ts`'s FakeDb (it drives a full 18-player
// multi-table tournament to champion), PLUS the 3 SELECTs the status route emits.
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
    // The status route's tournament SELECT (a different column list than above).
    if (text.startsWith('SELECT id, name, status, buy_in_ct, rake_bps, min_entrants, max_entrants, seats_per_table, starting_stack, prize_pool_ct, rake_taken_ct, registration_closes_at, started_at, settled_at FROM poker_tournaments WHERE id = ?')) {
      const t = this.tournaments.get(String(p[0]));
      return t ? [t] : [];
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
    // The CREATE path (admin POST /create → TM.createTournament). The column list
    // ends with `special_event_id` (the special-event parent FK) per the 2026-06-16
    // architecture: poker_tournaments.special_event_id → special_events.id. We don't
    // model the parent table here (the stress harness creates a standalone tournament),
    // so we just persist the nullable column and RETURN the inserted row.
    if (text.startsWith('INSERT INTO poker_tournaments') && text.includes('VALUES') && text.includes('RETURNING id')) {
      const id = randomUUID();
      // VALUES order: name, status('registering' literal), buy_in_ct, rake_bps,
      // min_entrants, max_entrants, seats_per_table, starting_stack, prize_pool_ct,
      // payout_curve_json, blind_schedule_id, registration_closes_at, created_by,
      // [special_event_id]. The 'registering' status is a SQL literal (not a param),
      // so the param indices skip it.
      const hasSpecialEvent = text.includes('special_event_id');
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
        payout_curve_json: typeof p[8] === 'string' ? JSON.parse(String(p[8])) : p[8],
        blind_schedule_id: p[9],
        registration_closes_at: p[10] ?? null,
        created_by: p[11] ?? null,
        special_event_id: hasSpecialEvent ? (p[12] ?? null) : null,
        rake_taken_ct: null,
        started_at: null,
        settled_at: null,
        cancelled_at: null,
        created_at: new Date(),
      };
      this.tournaments.set(id, row);
      return [row];
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
    // The status route's entrants SELECT.
    if (text.startsWith('SELECT avatar_id, agent_id, subject_type, status, chip_stack, seat_index, placement FROM poker_tournament_entrants WHERE tournament_id = ? ORDER BY placement ASC NULLS LAST, chip_stack DESC')) {
      return [...this.entrants.values()]
        .filter((e) => e.tournament_id === p[0])
        .sort((a, b) => {
          const pa = a.placement == null ? Number.POSITIVE_INFINITY : Number(a.placement);
          const pb = b.placement == null ? Number.POSITIVE_INFINITY : Number(b.placement);
          if (pa !== pb) return pa - pb;
          return Number(b.chip_stack) - Number(a.chip_stack);
        })
        .map((e) => ({
          avatar_id: e.avatar_id, agent_id: e.agent_id, subject_type: e.subject_type,
          status: e.status, chip_stack: e.chip_stack, seat_index: e.seat_index, placement: e.placement,
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
    if (text.startsWith('INSERT INTO poker_blind_schedules')) {
      // ON CONFLICT DO NOTHING — idempotent seed of the default ladder.
      const id = String(p[0]);
      if (!this.blindSchedules.has(id)) {
        this.blindSchedules.set(id, { id, name: p[1], levels_json: JSON.parse(String(p[2])) });
      }
      return [];
    }

    // ── poker_tables ──────────────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO poker_tables (tournament_id, table_number, status, button_seat_index, hand_count) VALUES')) {
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
    // The status route's results SELECT (avatar_id, placement, prize_ct only).
    if (text.startsWith('SELECT avatar_id, placement, prize_ct FROM poker_tournament_results WHERE tournament_id = ? ORDER BY placement ASC')) {
      return [...this.results.values()]
        .filter((r) => r.tournament_id === p[0])
        .sort((a, b) => Number(a.placement) - Number(b.placement))
        .map((r) => ({ avatar_id: r.avatar_id, placement: r.placement, prize_ct: r.prize_ct }));
    }

    throw new Error(`FakeDb (mock-tm-backend): unhandled SQL: ${text}`);
  }

  seedTournament(row: Partial<Row> & { id: string }): void {
    this.tournaments.set(row.id, {
      name: 'stress', status: 'registering', buy_in_ct: '0', rake_bps: 0, min_entrants: 2,
      max_entrants: 10, seats_per_table: 4, starting_stack: 1500, prize_pool_ct: '0',
      rake_taken_ct: null,
      payout_curve_json: DEFAULT_PAYOUT_CURVE_LOCAL,
      blind_schedule_id: 'sched-1', registration_closes_at: null, started_at: null,
      settled_at: null, cancelled_at: null,
      ...row,
    });
  }
  seedBlindSchedule(id: string, levels: BlindLevel[]): void {
    this.blindSchedules.set(id, { id, levels_json: levels });
  }
}

const DEFAULT_PAYOUT_CURVE_LOCAL: PayoutCurveEntry[] = [
  { placement: 1, share: 0.5 },
  { placement: 2, share: 0.3 },
  { placement: 3, share: 0.2 },
];

// ─── Response shapes the harness expects (subset; mirror cove-poker-mtt.ts) ──
interface RegisterResult {
  ok: boolean;
  status: number;
  entrantId?: string;
  prizePoolCt?: string;
  alreadyRegistered?: boolean;
  errorMessage?: string;
}
interface StateForAgentResult {
  status: number;
  view: unknown | null;
}
interface ActionResult {
  ok: boolean;
  status: number;
  reason?: string;
  handComplete?: boolean;
  advancedStreet?: boolean;
}
interface StatusResult {
  status: number;
  tournament: { status: string; prizePoolCt: string; rakeTakenCt: string | null; buyInCt: string } | null;
  entrants: Array<{ avatarId: string; agentId: string | null; subjectType: string; status: string; chipStack: number; placement: number | null }>;
  results: Array<{ avatarId: string; placement: number; prizeCt: string }>;
}

export interface MockBackend {
  connect(name: string): Promise<{ sessionId: string; agentId: string }>;
  createTournament(cfg: {
    name: string;
    buyInCt: number;
    minEntrants: number;
    maxEntrants: number;
    seatsPerTable: number;
    startingStack: number;
  }): Promise<{ id: string }>;
  forceStart(tournamentId: string): Promise<void>;
  register(tournamentId: string, sessionId: string): Promise<RegisterResult>;
  stateForAgent(tournamentId: string, sessionId: string): Promise<StateForAgentResult>;
  advice(tournamentId: string, sessionId: string): Promise<unknown | null>;
  action(
    tournamentId: string,
    sessionId: string,
    handNumber: number,
    actionSeq: number,
    action: Action,
  ): Promise<ActionResult>;
  status(tournamentId: string): Promise<StatusResult>;
  pump(tournamentId: string): boolean;
  dispose(): Promise<void>;
}

interface SessionBinding {
  avatarId: string;
  agentId: string;
}

/**
 * Build the in-process backend. Funds every connected agent with enough CT so a
 * (free-or-paid) buy-in always succeeds. The TM is wired with a deterministic seed
 * + a real seating shuffle (Math.random-free) so a dry-run is reproducible-ish.
 */
export async function createMockBackend(opts: {
  seatsPerTable: number;
  startingStack: number;
  buyInCt: number;
}): Promise<MockBackend> {
  const db = new FakeDb();
  const ledger = new FakeLedger();
  const clock = new FakeClock();
  db.seedBlindSchedule('sched-1', DEFAULT_BLIND_SCHEDULE);

  const sim = new PokerTableSim(clock);
  const broadcast: BroadcastFn = () => {};
  const sendToSeat: SendToSeatFn = () => {};
  sim.setBroadcastFn(broadcast);
  sim.setSendToSeatFn(sendToSeat);

  let seedCounter = 0;
  const placementEmits: PlacementEmit[] = [];
  const moves: MttMoveInfo[] = [];
  const tm = new TournamentManager({
    db: db as never,
    ledger: ledger as never,
    sim,
    clock,
    seedFn: () => (seedCounter++).toString(16).padStart(64, 'a'),
    // Deterministic round-robin seating (identity shuffle).
    shuffleFn: (_n: number) => 0,
    emitPlacementFn: (emit) => {
      placementEmits.push(emit);
    },
    // A fake WS-room seam so the route's getConnectionForSubject path is exercised
    // too (not used by the socket-less stress loop, but keeps the bindings real).
    onSeatFn: ({ tableId }) => {
      const binding: MttRoomBinding = {
        roomId: `room-${tableId}`,
        shortCode: tableId.slice(-6),
        activityId: 'texas-holdem-mtt',
      };
      return binding;
    },
    onMoveFn: (info) => {
      moves.push(info);
    },
  });

  // sessionId → bound avatar/agent (mirrors resolveAgentSession on the live path).
  const sessions = new Map<string, SessionBinding>();
  const avatarToSession = new Map<string, string>();
  // Per (tournament, table) bookkeeping for the pump's blind-clock advance.
  const lastHandByTable = new Map<string, number>();

  function resolve(sessionId: string): SessionBinding | null {
    return sessions.get(sessionId) ?? null;
  }

  const backend: MockBackend = {
    async connect(name: string) {
      const sessionId = `ag-mock-${randomUUID()}`;
      const avatarId = `av-${name}-${randomUUID().slice(0, 8)}`;
      const agentId = `nanoclaw-stress-${name}-${randomUUID().slice(0, 8)}`;
      sessions.set(sessionId, { avatarId, agentId });
      avatarToSession.set(avatarId, sessionId);
      // Fund the avatar so the buy-in (free or paid) always succeeds.
      ledger.setBalance(avatarId, Math.max(opts.buyInCt * 4, 1_000_000));
      return { sessionId, agentId };
    },

    async createTournament(cfg) {
      // Mirror the admin route: validate + insert via the REAL TM.createTournament.
      const created = await tm.createTournament(
        {
          name: cfg.name,
          buyInCt: cfg.buyInCt,
          minEntrants: cfg.minEntrants,
          maxEntrants: cfg.maxEntrants,
          seatsPerTable: cfg.seatsPerTable,
          startingStack: cfg.startingStack,
          // A near-future close so forceStart's window check passes; we also force.
          registrationClosesAt: new Date(clock.now() + 60_000),
          // Free-entry test tournaments use prepaid mode so buyInCt 0 is accepted.
          ...(cfg.buyInCt === 0 ? { prepaid: { seedPrizePoolCt: 0 } } : {}),
        },
        null,
      );
      return { id: created.id };
    },

    async forceStart(tournamentId: string) {
      // Idempotent: if the cap-hit auto-seat (on the last register) already flipped
      // the tournament to 'running', do NOT seat again. The live path relies on the
      // DB `FOR UPDATE` row lock to serialize concurrent startTriggers; the FakeDb
      // has no real lock, so we guard on the running flag here to avoid a
      // double-start (which would throw "table already has a live hand").
      if (tm.isRunning(tournamentId)) return;
      const t = db.tournaments.get(tournamentId);
      if (t && (t.status === 'running' || t.status === 'completed' || t.status === 'cancelled')) return;
      // Advance the clock past the registration close so the window check passes,
      // then force-seat.
      clock.advance(61_000);
      await tm.startTrigger(tournamentId, { force: true });
    },

    async register(tournamentId: string, sessionId: string): Promise<RegisterResult> {
      const b = resolve(sessionId);
      if (!b) return { ok: false, status: 401, errorMessage: 'invalid_or_expired_agent_session' };
      const subject: RegisterSubject = {
        kind: 'agent',
        userId: `u-${b.avatarId}`,
        avatarId: b.avatarId,
        agentId: b.agentId,
        fpHash: null,
        ipPrefixHash: null,
      };
      try {
        const result = await tm.registerEntrant(subject, tournamentId);
        // Mirror the route's cap-hit auto-seat. The route fires it FORGET-style only
        // to not block the HTTP response; in-process we AWAIT it so seating is
        // deterministic (no register/forceStart race against an in-flight seat).
        if (result.capReached && !tm.isRunning(tournamentId)) {
          await tm.startTrigger(tournamentId, { force: true }).catch(() => {});
        }
        return {
          ok: true,
          status: result.alreadyRegistered ? 200 : 201,
          entrantId: result.entrantId,
          prizePoolCt: result.prizePoolCt,
          alreadyRegistered: result.alreadyRegistered,
        };
      } catch (err) {
        return { ok: false, status: 400, errorMessage: (err as Error).message };
      }
    },

    async stateForAgent(tournamentId: string, sessionId: string): Promise<StateForAgentResult> {
      const b = resolve(sessionId);
      if (!b) return { status: 401, view: null };
      const view = tm.getSeatViewForAgent(tournamentId, b.avatarId);
      return view ? { status: 200, view } : { status: 409, view: null };
    },

    async advice(tournamentId: string, sessionId: string) {
      const b = resolve(sessionId);
      if (!b) return null;
      return tm.getActionAdvice(tournamentId, b.avatarId);
    },

    async action(tournamentId, sessionId, handNumber, actionSeq, action): Promise<ActionResult> {
      const b = resolve(sessionId);
      if (!b) return { ok: false, status: 401, reason: 'invalid_or_expired_agent_session' };
      const idempotencyKey = `${handNumber}:${actionSeq}:${b.avatarId}`;
      const result = tm.applyAgentAction({
        tournamentId,
        avatarId: b.avatarId,
        action,
        idempotencyKey,
        actor: 'agent',
      });
      if (!result.ok) {
        const reason = result.reason ?? 'illegal_action';
        const status409 = new Set(['no_live_table', 'human_controlled', 'not_your_turn', 'hand_over', 'not_seated', 'no_such_table']);
        return { ok: false, status: status409.has(reason) ? 409 : 422, reason };
      }
      return {
        ok: true,
        status: 200,
        handComplete: result.handComplete ?? false,
        advancedStreet: result.advancedStreet ?? false,
      };
    },

    async status(tournamentId: string): Promise<StatusResult> {
      const t = db.tournaments.get(tournamentId);
      if (!t) return { status: 404, tournament: null, entrants: [], results: [] };
      const entrants = [...db.entrants.values()]
        .filter((e) => e.tournament_id === tournamentId)
        .map((e) => ({
          avatarId: String(e.avatar_id),
          agentId: e.agent_id == null ? null : String(e.agent_id),
          subjectType: String(e.subject_type),
          status: String(e.status),
          chipStack: Number(e.chip_stack) || 0,
          placement: e.placement == null ? null : Number(e.placement),
        }));
      const results = [...db.results.values()]
        .filter((r) => r.tournament_id === tournamentId)
        .sort((a, b) => Number(a.placement) - Number(b.placement))
        .map((r) => ({ avatarId: String(r.avatar_id), placement: Number(r.placement), prizeCt: String(r.prize_ct) }));
      return {
        status: 200,
        tournament: {
          status: String(t.status),
          prizePoolCt: String(t.prize_pool_ct),
          rakeTakenCt: t.rake_taken_ct == null ? null : String(t.rake_taken_ct),
          buyInCt: String(t.buy_in_ct),
        },
        entrants,
        results,
      };
    },

    /**
     * Dry-run event-loop substitute. For every live table:
     *   - advance the blind clock once per new hand (so blinds rise as in prod);
     *   - if a to-act seat's owner is NOT an orchestration-driven agent (defensive —
     *     in the stress test every seat IS an agent, so this rarely fires), fold/check
     *     it so the table never stalls.
     * Returns true while the tournament is still running (progress possible).
     */
    pump(tournamentId: string): boolean {
      if (!tm.isRunning(tournamentId)) return false;
      const tableIds = tm.getAllTableIds(tournamentId);
      for (const tableId of tableIds) {
        const snap = sim.getPublicSnapshot(tableId);
        if (!snap || snap.toActSeatIndex === null) continue;

        // Advance the clock once per new hand at this table so blinds rise.
        const last = lastHandByTable.get(tableId) ?? 0;
        if (snap.handNumber !== last) {
          lastHandByTable.set(tableId, snap.handNumber);
          clock.advance(301_000); // > level durationSec (300) → next level next hand
        }

        // Safety net only: drive a to-act seat that has no orchestration agent.
        const toAct = snap.toActSeatIndex;
        const seat = snap.seats.find((s) => s.seatIndex === toAct);
        if (!seat) continue;
        const hasAgent = avatarToSession.has(seat.avatarId);
        if (!hasAgent) {
          const idem = `pump:${tableId}:${snap.handNumber}:${toAct}`;
          if (snap.toCall > 0) {
            sim.applyAction(tableId, seat.avatarId, { kind: 'fold' }, { idempotencyKey: idem });
          } else {
            sim.applyAction(tableId, seat.avatarId, { kind: 'check' }, { idempotencyKey: idem });
          }
        }
      }
      return true;
    },

    async dispose() {
      // FakeDb/FakeLedger hold no resources. Nothing to close.
    },
  };

  return backend;
}
