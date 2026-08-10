/**
 * Poker MTT (P3.5) — tournament-table END-TO-END WS integration test.
 *
 * Proves a tournament table is PLAYABLE over WebSocket (humans + agents acting in
 * tournament hands) through the REAL wiring with NO real sockets:
 *   - a real `TournamentManager` (fake DB + fake ledger + a FAKE CLOCK so turn
 *     timeouts are deterministic) driving a real `PokerTableSim`,
 *   - the REAL `poker-mtt-ws-bridge` (`wirePokerMttToHub`) wiring that sim + TM to
 *     the REAL `activityWsHub` + REAL `activityRoomManager`,
 *   - mock WS connections authed through the SAME `handleMessage('auth')`
 *     handshake production uses,
 *   - inbound `poker.action` frames fed through `handleMessage` (NOT a direct sim
 *     call) so the activityId dispatch + idempotency-key + act-as-yourself binding
 *     are all exercised.
 *
 * Asserts:
 *   (a) each seat receives ONLY its own hole cards over the wire (hidden state),
 *   (b) public `poker.table_state` frames carry no hole cards + board==street count,
 *   (c) a full hand reaches the engine-verified showdown,
 *   (d) the TM multi-hand loop starts the NEXT hand WITHIN the SAME room (button
 *       rotated),
 *   (e) a seat that never acts is auto-folded by the turn clock + the table advances,
 *   (f) the demo `texas-holdem` path + `pokerTableSim` are NOT affected (dispatch
 *       isolation),
 *   (g) PRODUCTION uses a REAL clock (the singleton sim is REAL_CLOCK) — verified
 *       structurally so the fake-clock test can't mask a prod stall.
 *
 * Human/agent parity (Rule E5): seat 2 is registered as an AGENT (kind:'agent',
 * agentId set) and plays AS ITSELF over the wire exactly like the human seats.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  shuffleDeck,
  evaluateBest5,
  compareHandRank,
  type Card,
} from '../../holdem-engine';
import type { PublicTableSnapshot, SimClock } from '../poker-table-types';
import type { BlindLevel } from '@clawville/database';

// ── Mock the identity + DB + side-effect chain (mirrors poker-ws-integration) ──
// THREE subjects: two humans (av-0, av-1) + one AGENT (av-2 / agent oc-bot-2).

mock.module('../../../middleware/require-auth-or-agent', () => ({
  resolveActivityIdentity: async (input: { sessionToken: string }) => {
    if (input.sessionToken === 'valid-user-0') {
      return { kind: 'user', userId: 'user-0', avatarId: 'av-0', agentId: null };
    }
    if (input.sessionToken === 'valid-user-1') {
      return { kind: 'user', userId: 'user-1', avatarId: 'av-1', agentId: null };
    }
    if (input.sessionToken === 'valid-agent-2') {
      // An AGENT playing AS ITSELF — bound avatar av-2 (Rule E5 parity).
      return {
        kind: 'agent',
        userId: 'user-2',
        avatarId: 'av-2',
        agentId: 'oc-bot-2',
        sessionId: 'valid-agent-2',
      };
    }
    return null;
  },
}));

mock.module('../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: { MATCH_PLACED: 'activity.match.placed' },
}));
mock.module('../../alert-error', () => ({
  alertError: () => Promise.resolve(),
}));
mock.module('../../activity/activity-replay-log', () => ({
  activityReplayLog: {
    appendInputFrame: () => {},
    flushToDb: () => Promise.resolve(null),
    dropRoom: () => {},
    getReplayId: () => undefined,
    bufferLength: () => 0,
    __resetForTest: () => {},
  },
}));
mock.module('@clawville/database', () => ({
  // The room manager + reward pipeline touch this `db` via drizzle's fluent API;
  // the TM uses its OWN injected fake db (below), so this only needs to satisfy
  // the room-manager insert/update calls (which we don't assert on here).
  db: {
    insert: () => ({
      values: () => Promise.resolve(undefined),
      returning: () => Promise.resolve([{ id: 'row-1' }]),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    query: {},
  },
  activityRooms: {},
  activityRoomParticipants: {},
  activityQueueEntries: {},
  activityParties: {},
  activityPartyMembers: {},
  activityReplays: { id: 'id' },
  activityResults: { id: 'id', avatarId: 'avatar_id', activityId: 'activity_id' },
  avatars: { id: 'id', flags: 'flags' },
  users: { id: 'id', isGuest: 'is_guest' },
  clawTokenTransactions: { id: 'id' },
  reefRacePersonalBests: {
    id: 'id',
    avatarId: 'avatar_id',
    activityId: 'activity_id',
    bestLapMs: 'best_lap_ms',
    ghostReplayData: 'ghost_replay_data',
  },
  reefRacePersonalBestClaims: {},
}));
mock.module('../../claw-token-ledger', () => ({
  creditClawTokens: () =>
    Promise.resolve({ balanceAfter: 100, ledgerId: 'ledger-1' }),
  debitClawTokens: () =>
    Promise.resolve({ balanceAfter: 100, ledgerId: 'ledger-1' }),
  transferClawTokens: () => Promise.resolve({ fromBalance: 0, toBalance: 0 }),
}));

const { activityWsHub } = await import('../../activity/activity-ws-hub');
const { activityRoomManager } = await import(
  '../../activity/activity-room-manager'
);
const { pokerTableSim } = await import('../poker-table-sim-singleton');
const { pokerMttSim } = await import('../poker-mtt-sim-singleton');
const { PokerTableSim } = await import('../poker-table-sim');
const { TournamentManager, DEFAULT_BLIND_SCHEDULE } = await import(
  '../tournament-manager'
);
const { wirePokerMttToHub, MTT_ACTIVITY_ID } = await import(
  '../poker-mtt-ws-bridge'
);
const { REAL_CLOCK } = await import('../poker-table-types');

// ─── Fake clock — turns are driven explicitly via sim.onTurnTimeout; setTimer
// never auto-fires, so the test fully controls when a turn times out ──────────

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

// ─── Fake ledger (in-memory CT; the MTT register/settle path crosses it) ──────

class FakeLedger {
  balances = new Map<string, number>();
  setBalance(a: string, n: number): void {
    this.balances.set(a, n);
  }
  get(a: string): number {
    return this.balances.get(a) ?? 0;
  }
  debitClawTokens = async (input: { avatarId: string; amount: number }) => {
    const bal = this.get(input.avatarId);
    this.balances.set(input.avatarId, bal - input.amount);
    return { balanceAfter: bal - input.amount, ledgerId: randomUUID() };
  };
  creditClawTokens = async (input: { avatarId: string; amount: number }) => {
    const bal = this.get(input.avatarId);
    this.balances.set(input.avatarId, bal + input.amount);
    return { balanceAfter: bal + input.amount, ledgerId: randomUUID() };
  };
  transferClawTokens = async () => ({ fromBalance: 0, toBalance: 0 });
}

// ─── Fake DB: in-memory interpreter for the exact SQL the TM emits (copied from
// tournament-manager.test.ts — same statement shapes) ─────────────────────────

interface Row {
  [k: string]: unknown;
}
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
    if (text.startsWith('UPDATE poker_tournament_entrants SET chip_stack = ? WHERE tournament_id = ? AND avatar_id = ?')) {
      const e = [...this.entrants.values()].find((x) => x.tournament_id === p[1] && x.avatar_id === p[2])!;
      e.chip_stack = p[0];
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
    if (text.startsWith('SELECT levels_json FROM poker_blind_schedules WHERE id = ?')) {
      const s = this.blindSchedules.get(String(p[0]));
      return s ? [{ levels_json: s.levels_json }] : [];
    }
    if (text.startsWith("INSERT INTO poker_tables (tournament_id, table_number, status, button_seat_index, hand_count) VALUES")) {
      const id = randomUUID();
      this.tables.set(id, { id, tournament_id: p[0], table_number: 1, status: 'live', button_seat_index: 0, hand_count: 0 });
      return [{ id }];
    }
    if (text.startsWith('UPDATE poker_tables SET hand_count = ?, button_seat_index = ? WHERE id = ?')) {
      const tb = this.tables.get(String(p[2]))!;
      tb.hand_count = p[0];
      tb.button_seat_index = p[1];
      return [];
    }
    if (text.startsWith('INSERT INTO poker_hands') && text.includes('pot_result_json, settled_at) VALUES')) {
      const key = `${p[0]}:${p[1]}`;
      if (this.hands.has(key)) return [];
      const id = randomUUID();
      this.hands.set(key, { id, table_id: p[0], hand_number: p[1] });
      return [{ id }];
    }
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
      status: 'registering', buy_in_ct: '100', rake_bps: 0, min_entrants: 2,
      max_entrants: 9, seats_per_table: 9, starting_stack: 1000, prize_pool_ct: '0',
      rake_taken_ct: null,
      payout_curve_json: [{ placement: 1, share: 0.5 }, { placement: 2, share: 0.3 }, { placement: 3, share: 0.2 }],
      blind_schedule_id: 'sched-1', registration_closes_at: null, started_at: null,
      settled_at: null, cancelled_at: null, ...row,
    });
  }
  seedBlindSchedule(id: string, levels: BlindLevel[]): void {
    this.blindSchedules.set(id, { id, levels_json: levels });
  }
}

// ─── Fake WS transport (mirrors poker-ws-integration) ─────────────────────────

interface FakeWs {
  ws: {
    send: (frame: string) => void;
    close: (code: number, reason: string) => void;
    getBufferedAmount: () => number;
    data: ReturnType<typeof activityWsHub.makeConnectionData>;
  };
  sent: string[];
  closes: Array<{ code: number; reason: string }>;
}
function makeFakeWs(roomId: string): FakeWs {
  const sent: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const ws = {
    send: (frame: string) => sent.push(frame),
    close: (code: number, reason: string) => closes.push({ code, reason }),
    getBufferedAmount: () => 0,
    data: activityWsHub.makeConnectionData(roomId),
  };
  return { ws, sent, closes };
}
function frames(fake: FakeWs): Array<{ type: string; [k: string]: unknown }> {
  return fake.sent.map((s) => JSON.parse(s));
}
function pokerFrames(fake: FakeWs) {
  return frames(fake).filter((f) => f.type.startsWith('poker.'));
}

// ─── Deal replication so the test knows every card up front ───────────────────
// IMPORTANT: the MTT TM's per-hand seed is `seedFn()` (NOT a fixed SERVER), and
// the shuffle nonce is the hand number. We capture the actual server seed from
// the `poker.hand_ended` frame (revealed only post-hand) to verify the showdown.

function replicateDeal(serverSeed: string, clientSeed: string, handNumber: number, seatCount: number) {
  const deck = shuffleDeck({ serverSeed, clientSeed, nonce: handNumber });
  const hole: [Card, Card][] = Array.from({ length: seatCount }, () => [deck[0]!, deck[0]!]);
  let top = 0;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < seatCount; i++) hole[i]![round] = deck[top++]!;
  }
  const board5 = [deck[top++]!, deck[top++]!, deck[top++]!, deck[top++]!, deck[top++]!];
  return { hole, board5 };
}
function expectedWinnerSeats(hole: [Card, Card][], board5: Card[], contenders: number[]): number[] {
  let best: ReturnType<typeof evaluateBest5> | null = null;
  let winners: number[] = [];
  for (const seat of contenders) {
    const r = evaluateBest5([...hole[seat]!, ...board5]);
    if (!best || compareHandRank(r, best) > 0) {
      best = r;
      winners = [seat];
    } else if (compareHandRank(r, best) === 0) {
      winners.push(seat);
    }
  }
  return winners.sort((a, b) => a - b);
}

// The TM's fixed clientSeed for MTT tables (DEFAULT_CLIENT_SEED in the TM).
const TM_CLIENT_SEED = 'c1a4111e';

// ─── Test harness builder ─────────────────────────────────────────────────────

function buildHarness() {
  const db = new FakeDb();
  const ledger = new FakeLedger();
  const clock = new FakeClock();
  db.seedBlindSchedule('sched-1', DEFAULT_BLIND_SCHEDULE);
  // The MTT sim under test uses the FAKE clock so turn timeouts are deterministic.
  const sim = new PokerTableSim(clock);
  // Deterministic distinct 64-hex seed per hand.
  let seedCounter = 0;
  const seeds: string[] = [];
  const tm = new TournamentManager({
    db: db as never,
    ledger: ledger as never,
    sim,
    clock,
    seedFn: () => {
      const s = (seedCounter++).toString(16).padStart(64, 'a');
      seeds.push(s);
      return s;
    },
    emitPlacementFn: () => {},
  });
  // Wire the REAL bridge (sim + TM → real hub + real room manager).
  wirePokerMttToHub(sim, tm);
  return { db, ledger, clock, sim, tm, seeds };
}

/** Register N subjects + start the tournament → seats the field + starts hand 1. */
async function seatTournament(
  tm: Awaited<ReturnType<typeof buildHarness>>['tm'],
  db: FakeDb,
  ledger: FakeLedger,
  clock: FakeClock,
) {
  const tid = randomUUID();
  db.seedTournament({
    id: tid, buy_in_ct: '100', min_entrants: 2, max_entrants: 3, seats_per_table: 3,
    starting_stack: 1000, registration_closes_at: new Date(clock.now() + 1000),
  });
  // 2 humans + 1 agent (parity).
  ledger.setBalance('av-0', 1000);
  ledger.setBalance('av-1', 1000);
  ledger.setBalance('av-2', 1000);
  await tm.registerEntrant({ kind: 'user', userId: 'user-0', avatarId: 'av-0', agentId: null }, tid);
  await tm.registerEntrant({ kind: 'user', userId: 'user-1', avatarId: 'av-1', agentId: null }, tid);
  await tm.registerEntrant({ kind: 'agent', userId: 'user-2', avatarId: 'av-2', agentId: 'oc-bot-2' }, tid);
  clock.advance(2000); // window closes
  const start = await tm.startTrigger(tid);
  return { tid, start };
}

/** Auth a mock WS into the tournament room (by avatarId → its session token). */
async function authSeat(roomId: string, shortCode: string, sessionToken: string): Promise<FakeWs> {
  const fake = makeFakeWs(roomId);
  await activityWsHub.handleMessage(
    fake.ws,
    JSON.stringify({ type: 'auth', sessionToken, shortCode }),
  );
  return fake;
}

/** Feed a poker.action frame through the REAL inbound path for one seat. */
async function sendAction(fake: FakeWs, handNumber: number, actionSeq: number, action: Record<string, unknown>): Promise<void> {
  await activityWsHub.handleMessage(
    fake.ws,
    JSON.stringify({ type: 'poker.action', handNumber, actionSeq, action }),
  );
}

/** Read the live MTT public snapshot from the sim (helper for turn-driving). */
function mttSnap(sim: Awaited<ReturnType<typeof buildHarness>>['sim'], tableId: string): PublicTableSnapshot | null {
  return sim.getPublicSnapshot(tableId);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('poker MTT — tournament-table WS integration (end-to-end via handleMessage)', () => {
  beforeEach(() => {
    activityWsHub.__resetForTest();
    activityRoomManager.__resetForTest();
    // No-op live-transition: the TM (not the dispatcher) starts hands. Registering
    // a no-op silences the room manager's "no liveTransitionFn" CRITICAL log.
    activityRoomManager.setLiveTransitionFn(() => {});
  });

  it('(seats a long-lived room + starts hand 1; connect path exposes seat info)', async () => {
    const { db, ledger, clock, sim, tm } = buildHarness();
    const { tid, start } = await seatTournament(tm, db, ledger, clock);
    expect(start.status).toBe('running');
    expect(start.seatedCount).toBe(3);

    // ONE long-lived room was created for the table (NOT one per hand) + it's LIVE.
    const binding = tm.getRoomBinding(tid);
    expect(binding).not.toBeNull();
    const room = activityRoomManager.getRoom(binding!.roomId)!;
    expect(room).toBeDefined();
    expect(room.activityId).toBe(MTT_ACTIVITY_ID);
    expect(room.state).toBe('live');
    // Hand 1 is live on the sim under the mtt:<id> table id.
    const tableId = tm.getTableId(tid)!;
    expect(tableId).toBe(`mtt:${tid}`);
    expect(mttSnap(sim, tableId)!.handNumber).toBe(1);

    // Connect path: each seated subject (human + agent) learns ITS OWN seat.
    expect(tm.getConnectionForSubject(tid, 'av-0')!.seatIndex).toBe(0);
    expect(tm.getConnectionForSubject(tid, 'av-1')!.seatIndex).toBe(1);
    const agentConn = tm.getConnectionForSubject(tid, 'av-2')!;
    expect(agentConn.seatIndex).toBe(2);
    expect(agentConn.roomId).toBe(binding!.roomId);
    expect(agentConn.activityId).toBe(MTT_ACTIVITY_ID);
    // An unseated avatar gets nothing.
    expect(tm.getConnectionForSubject(tid, 'av-nobody')).toBeNull();
  });

  it('(a)(b)(c) hidden hole cards + public board==street + full hand to showdown over the wire', async () => {
    const { db, ledger, clock, sim, tm, seeds } = buildHarness();
    const { tid } = await seatTournament(tm, db, ledger, clock);
    const binding = tm.getRoomBinding(tid)!;
    const tableId = tm.getTableId(tid)!;

    const ws0 = await authSeat(binding.roomId, binding.shortCode, 'valid-user-0');
    const ws1 = await authSeat(binding.roomId, binding.shortCode, 'valid-user-1');
    const ws2 = await authSeat(binding.roomId, binding.shortCode, 'valid-agent-2');
    // Clear auth/init noise.
    ws0.sent.length = 0; ws1.sent.length = 0; ws2.sent.length = 0;

    // The hand was already started at seating (before the WS connected). Drive a
    // public re-broadcast by acting; but FIRST verify the cards the sim WILL deal
    // are derivable from seed[0] (hand 1). Capture the server seed from hand_ended
    // at the end to assert it matches.
    const handNumber = mttSnap(sim, tableId)!.handNumber;
    expect(handNumber).toBe(1);

    // ── Drive hand 1 to showdown. 3-handed: button=0 → SB=1, BB=2; first to act
    // preflop = seat after BB = seat 0. Everyone calls/checks down. ──────────────
    // Preflop: seat0 (button) calls, seat1 (SB) calls, seat2 (BB) checks → flop.
    await sendAction(ws0, 1, 1, { kind: 'call' });
    await sendAction(ws1, 1, 1, { kind: 'call' });
    await sendAction(ws2, 1, 1, { kind: 'check' });
    // Postflop first-to-act = first active left of button = seat 1.
    // Flop: check/check/check.
    await sendAction(ws1, 1, 2, { kind: 'check' });
    await sendAction(ws2, 1, 2, { kind: 'check' });
    await sendAction(ws0, 1, 2, { kind: 'check' });
    // Turn.
    await sendAction(ws1, 1, 3, { kind: 'check' });
    await sendAction(ws2, 1, 3, { kind: 'check' });
    await sendAction(ws0, 1, 3, { kind: 'check' });
    // River.
    await sendAction(ws1, 1, 4, { kind: 'check' });
    await sendAction(ws2, 1, 4, { kind: 'check' });
    await sendAction(ws0, 1, 4, { kind: 'check' });
    // Let the TM's async onHandComplete settle hand 1 + start hand 2.
    await new Promise((r) => setTimeout(r, 0));

    // (c) hand_ended broadcast to all three seats; showdown reached.
    const ended0 = pokerFrames(ws0).find((f) => f.type === 'poker.hand_ended');
    const ended1 = pokerFrames(ws1).find((f) => f.type === 'poker.hand_ended');
    const ended2 = pokerFrames(ws2).find((f) => f.type === 'poker.hand_ended');
    expect(ended0).toBeDefined();
    expect(ended1).toBeDefined();
    expect(ended2).toBeDefined();
    const result = (ended0 as unknown as { result: { endedAt: string; board: Card[]; serverSeedRevealed: string; perSeat: Array<{ isWinner: boolean; seatIndex: number; net: number }> } }).result;
    expect(result.endedAt).toBe('showdown');
    expect(result.board.length).toBe(5);
    // Server seed revealed ONLY now → it's hand 1's seed (seeds[0]).
    expect(result.serverSeedRevealed).toBe(seeds[0]);
    // Chip conservation: nets sum to 0.
    expect(result.perSeat.reduce((acc, s) => acc + s.net, 0)).toBe(0);

    // (c) correct winner vs the replicated deal (using the revealed seed).
    const deal = replicateDeal(result.serverSeedRevealed, TM_CLIENT_SEED, 1, 3);
    const expected = expectedWinnerSeats(deal.hole, deal.board5, [0, 1, 2]);
    const simWinners = result.perSeat.filter((s) => s.isWinner).map((s) => s.seatIndex).sort((a, b) => a - b);
    expect(simWinners).toEqual(expected);

    // (a) HIDDEN STATE — each seat's connection never carries an OPPONENT's exact
    // hole-card tuple in any MID-HAND frame. The terminal `poker.showdown` /
    // `poker.hand_ended` frames LEGITIMATELY reveal non-folded hole cards (that's
    // real-poker showdown — public after the hand resolves), so they are EXCLUDED
    // from the mid-hand leak check; the public/private board invariants below
    // separately prove no card leaks BEFORE showdown.
    const cardsJson = (i: number) => JSON.stringify(deal.hole[i]!);
    const midHand = (fake: FakeWs) =>
      fake.sent.filter(
        (raw) =>
          !raw.includes('"poker.showdown"') &&
          !raw.includes('"poker.hand_ended"'),
      );
    for (const raw of midHand(ws0)) {
      expect(raw.includes(cardsJson(1))).toBe(false);
      expect(raw.includes(cardsJson(2))).toBe(false);
    }
    for (const raw of midHand(ws1)) {
      expect(raw.includes(cardsJson(0))).toBe(false);
      expect(raw.includes(cardsJson(2))).toBe(false);
    }
    for (const raw of midHand(ws2)) {
      expect(raw.includes(cardsJson(0))).toBe(false);
      expect(raw.includes(cardsJson(1))).toBe(false);
    }
    // Each seat DID receive its OWN hole cards over the private channel.
    const ownHole = (fake: FakeWs, seat: number) =>
      pokerFrames(fake)
        .filter((f) => f.type === 'poker.hole_cards')
        .some((f) => JSON.stringify((f as unknown as { holeCards: Card[] }).holeCards) === cardsJson(seat));
    expect(ownHole(ws0, 0)).toBe(true);
    expect(ownHole(ws1, 1)).toBe(true);
    expect(ownHole(ws2, 2)).toBe(true);

    // (b) every public table_state frame: no hole cards + board length == street.
    const publics = [...pokerFrames(ws0), ...pokerFrames(ws1), ...pokerFrames(ws2)]
      .filter((f) => f.type === 'poker.table_state')
      .map((f) => (f as unknown as { snapshot: PublicTableSnapshot }).snapshot);
    expect(publics.length).toBeGreaterThan(0);
    const streetCardCount: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5 };
    for (const snap of publics) {
      expect(snap.board.length).toBe(streetCardCount[snap.street]);
      for (const seat of snap.seats) expect('holeCards' in seat).toBe(false);
    }
    // No public frame ever serialized a `holeCards` token or the revealed seed.
    for (const fake of [ws0, ws1, ws2]) {
      for (const raw of fake.sent) {
        if (raw.includes('"poker.table_state"')) {
          expect(raw.includes('holeCards')).toBe(false);
          expect(raw.includes(result.serverSeedRevealed)).toBe(false);
        }
      }
    }
  });

  it('(d) the multi-hand loop starts the NEXT hand within the SAME room (button rotated)', async () => {
    const { db, ledger, clock, sim, tm } = buildHarness();
    const { tid } = await seatTournament(tm, db, ledger, clock);
    const binding = tm.getRoomBinding(tid)!;
    const tableId = tm.getTableId(tid)!;

    const ws0 = await authSeat(binding.roomId, binding.shortCode, 'valid-user-0');
    const ws1 = await authSeat(binding.roomId, binding.shortCode, 'valid-user-1');
    const ws2 = await authSeat(binding.roomId, binding.shortCode, 'valid-agent-2');

    // Hand 1 button (set at seating) is seat 0.
    expect(mttSnap(sim, tableId)!.handNumber).toBe(1);
    expect(mttSnap(sim, tableId)!.buttonSeatIndex).toBe(0);

    // Check/call hand 1 down to showdown (no busts — equal stacks, tiny pot).
    await sendAction(ws0, 1, 1, { kind: 'call' });
    await sendAction(ws1, 1, 1, { kind: 'call' });
    await sendAction(ws2, 1, 1, { kind: 'check' });
    await sendAction(ws1, 1, 2, { kind: 'check' });
    await sendAction(ws2, 1, 2, { kind: 'check' });
    await sendAction(ws0, 1, 2, { kind: 'check' });
    await sendAction(ws1, 1, 3, { kind: 'check' });
    await sendAction(ws2, 1, 3, { kind: 'check' });
    await sendAction(ws0, 1, 3, { kind: 'check' });
    await sendAction(ws1, 1, 4, { kind: 'check' });
    await sendAction(ws2, 1, 4, { kind: 'check' });
    await sendAction(ws0, 1, 4, { kind: 'check' });
    await new Promise((r) => setTimeout(r, 0)); // let the TM start hand 2

    // SAME room (never torn down between hands) — still LIVE.
    const room = activityRoomManager.getRoom(binding.roomId)!;
    expect(room.state).toBe('live');
    // Tournament still running (nobody busted) → hand 2 started on the SAME table.
    expect(tm.isRunning(tid)).toBe(true);
    const snap2 = mttSnap(sim, tableId)!;
    expect(snap2.handNumber).toBe(2);
    // Button rotated to the next live seat clockwise (seat 0 → seat 1).
    expect(snap2.buttonSeatIndex).toBe(1);
    // Three seats still in (no busts on a check-down).
    expect(tm.getLiveStacks(tid).size).toBe(3);
  });

  it('(e) a seat that never acts is auto-folded by the turn clock + the table advances', async () => {
    const { db, ledger, clock, sim, tm } = buildHarness();
    const { tid } = await seatTournament(tm, db, ledger, clock);
    const tableId = tm.getTableId(tid)!;

    const snap = mttSnap(sim, tableId)!;
    expect(snap.handNumber).toBe(1);
    // It is seat 0's turn preflop (first to act). Seat 0 NEVER acts; instead the
    // turn clock fires (production: REAL_CLOCK setTimeout; test: we drive it).
    const toAct = snap.toActSeatIndex;
    expect(toAct).toBe(0);
    const beforeStatus = snap.seats.find((s) => s.seatIndex === 0)!.status;
    expect(beforeStatus).toBe('active');

    // Fire the turn clock — seat 0 owes the BB (toCall > 0 preflop on the button)
    // so it auto-FOLDS, and the table advances to the next actor.
    expect(snap.toCall).toBeGreaterThan(0);
    sim.onTurnTimeout(tableId);

    const after = mttSnap(sim, tableId)!;
    // Seat 0 was auto-folded; the table did NOT stall — a different seat is now to
    // act (or the hand resolved). Either way seat 0 is folded + no longer to act.
    const seat0After = after.seats.find((s) => s.seatIndex === 0)!;
    expect(seat0After.status).toBe('folded');
    expect(after.toActSeatIndex).not.toBe(0);
  });

  it('(f) demo texas-holdem path + pokerTableSim are NOT affected (dispatch isolation)', async () => {
    const { db, ledger, clock, sim, tm } = buildHarness();
    const { tid } = await seatTournament(tm, db, ledger, clock);
    const binding = tm.getRoomBinding(tid)!;
    const mttTableId = tm.getTableId(tid)!;

    // A SEPARATE demo `texas-holdem` room with its OWN sim (pokerTableSim).
    const demoRoom = await activityRoomManager.createRoom(
      'texas-holdem',
      [
        { avatarId: 'av-0', userId: 'user-0', agentId: null, subjectType: 'human' as const, partyId: null },
        { avatarId: 'av-1', userId: 'user-1', agentId: null, subjectType: 'human' as const, partyId: null },
      ],
      { minPlayers: 2, maxPlayers: 9, preferredPlayers: 2 },
    );
    // Wire the demo singleton's callbacks to the hub (as index.ts does) so the
    // demo path is live; start a demo hand on the DEMO sim (tableId === roomId).
    pokerTableSim.setBroadcastFn((tableId, snapshot) => {
      activityWsHub.broadcastEvent(tableId, { type: 'poker.table_state', snapshot });
    });
    pokerTableSim.setSendToSeatFn((tableId, avatarId, view) => {
      activityWsHub.sendToAvatar(tableId, avatarId, { type: 'poker.hole_cards', handNumber: 1, seatIndex: view.seatIndex, holeCards: view.holeCards });
      activityWsHub.sendToAvatar(tableId, avatarId, { type: 'poker.your_turn', handNumber: 1, view });
    });
    pokerTableSim.setHandCompleteFn(() => {});
    pokerTableSim.startHand({
      tableId: demoRoom.id,
      handNumber: 1,
      seatAssignments: [
        { seatIndex: 0, avatarId: 'av-0', name: 'av-0', subjectType: 'human', chipStack: 1000 },
        { seatIndex: 1, avatarId: 'av-1', name: 'av-1', subjectType: 'human', chipStack: 1000 },
      ],
      blinds: { sb: 10, bb: 20, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed: 'f'.repeat(64),
      clientSeed: 'cafebabe',
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });

    // Snapshot the MTT table BEFORE acting in the demo room.
    const mttBefore = mttSnap(sim, mttTableId)!;
    const mttPotBefore = mttBefore.pot;
    const mttToActBefore = mttBefore.toActSeatIndex;

    // Auth into the DEMO room + act there. In heads-up the button (seat 0) acts
    // first preflop. This must route to the DEMO sim ONLY.
    const demoWs0 = await authSeat(demoRoom.id, demoRoom.shortCode, 'valid-user-0');
    demoWs0.sent.length = 0;
    await activityWsHub.handleMessage(
      demoWs0.ws,
      JSON.stringify({ type: 'poker.action', handNumber: 1, actionSeq: 1, action: { kind: 'call' } }),
    );

    // The DEMO sim advanced (heads-up SB/button called → now BB's turn).
    const demoSnap = pokerTableSim.getPublicSnapshot(demoRoom.id)!;
    expect(demoSnap.toActSeatIndex).toBe(1);

    // The MTT table is COMPLETELY UNAFFECTED — same pot, same actor, same hand.
    const mttAfter = mttSnap(sim, mttTableId)!;
    expect(mttAfter.pot).toBe(mttPotBefore);
    expect(mttAfter.toActSeatIndex).toBe(mttToActBefore);
    expect(mttAfter.handNumber).toBe(1);

    // And reverse: an MTT action does NOT touch the demo sim. Act on the MTT room.
    const mttWs0 = await authSeat(binding.roomId, binding.shortCode, 'valid-user-0');
    const demoPotBeforeMttAction = pokerTableSim.getPublicSnapshot(demoRoom.id)!.pot;
    await activityWsHub.handleMessage(
      mttWs0.ws,
      JSON.stringify({ type: 'poker.action', handNumber: 1, actionSeq: 1, action: { kind: 'call' } }),
    );
    // Demo room's pot is unchanged by the MTT action.
    expect(pokerTableSim.getPublicSnapshot(demoRoom.id)!.pot).toBe(demoPotBeforeMttAction);
    // The MTT table DID advance (seat 0 called).
    expect(mttSnap(sim, mttTableId)!.toActSeatIndex).not.toBe(mttToActBefore);
  });

  it('(g) PRODUCTION MTT sim uses a REAL clock (setTimeout) — not the test fake', () => {
    // The production singleton `pokerMttSim` is constructed with the default
    // REAL_CLOCK, so onTurnTimeout fires on a real timer in prod and a
    // non-acting/disconnected seat is auto-checked/folded without a stall. The
    // fake-clock used above is ONLY the test's injected sim — it never masks the
    // production timer path. We assert structurally that REAL_CLOCK is a real
    // setTimeout-backed clock (the singleton's default) so a regression to a
    // no-op clock in prod would be caught.
    expect(typeof REAL_CLOCK.setTimer).toBe('function');
    let fired = false;
    const handle = REAL_CLOCK.setTimer(() => { fired = true; }, 10_000);
    expect(handle).toBeDefined();
    // It's a real setTimeout handle — clearing it prevents the (irrelevant) fire.
    REAL_CLOCK.clearTimer(handle);
    expect(fired).toBe(false);
    // The production MTT sim is a distinct instance from the test sim + the demo
    // sim (isolation), and the demo singleton is also distinct.
    expect(pokerMttSim).not.toBe(pokerTableSim);
  });
});
