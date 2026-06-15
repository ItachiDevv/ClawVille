/**
 * Poker MTT (P5) — AGENT socket-less play, end-to-end through the TournamentManager
 * (mocked DB + ledger, real PokerTableSim with a fake clock).
 *
 * This proves the P5 contract the agent REST/tool surface depends on, at the layer
 * that owns settlement (`applyAgentAction` → `sim.applyAction`, the SAME path the
 * WS hub uses). The route + agent-gateway are thin in-process forwarders over these
 * exact methods, so locking them here locks the surface's economic + hidden-state
 * behavior without standing up Lucia / agent-session DB rows.
 *
 * Asserts:
 *   (A) Rule E5 PARITY: an AGENT subject (kind:'agent') registers + seats on the
 *       SAME real-CT buy-in path a human uses; the buy-in debits its BOUND avatar
 *       (NOT a guest). It then reaches a live hand and can read + act AS ITSELF.
 *   (B) `getActiveTableForAvatar` / `getSeatViewForAgent` resolve the agent's live
 *       table WITHOUT a WS room (socket-less), and the view shows ONLY its own
 *       hole cards.
 *   (C) `applyAgentAction` SETTLES into the sim (chips move) and is IDEMPOTENT on
 *       (handNumber, actionSeq) — a retransmit is a stable no-op (no double action).
 *   (D) OUT-OF-TURN is rejected (`not_your_turn`), and an unseated avatar gets
 *       `no_live_table`.
 *   (E) ADVISOR is NON-STAKING: `getActionAdvice` returns a recommendation and
 *       moves NO chips (ledger + chip stacks unchanged).
 *   (F) CONTROLLED-MODE suppression: while the agent's avatar is marked controlled,
 *       an `actor:'agent'` action is rejected (`human_controlled`) but an
 *       `actor:'human'` action (the human driver) and an advisor read still work.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  TournamentManager,
  DEFAULT_BLIND_SCHEDULE,
  type RegisterSubject,
  type PlacementEmit,
} from '../tournament-manager';
import { PokerTableSim } from '../poker-table-sim';
import type { SimClock, BroadcastFn, SendToSeatFn } from '../poker-table-types';
import type { BlindLevel } from '@clawville/database';

// ─── Fake clock (no auto-fire; turns driven explicitly) ──────────────────────
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
  debitClawTokens = async (input: { avatarId: string; amount: number; reason: string }, _tx?: unknown) => {
    const bal = this.get(input.avatarId);
    if (bal < input.amount) throw new InsufficientTokensError(input.avatarId, bal, input.amount);
    this.balances.set(input.avatarId, bal - input.amount);
    this.debits.push({ ...input });
    return { balanceAfter: bal - input.amount, ledgerId: randomUUID() };
  };
  creditClawTokens = async (input: { avatarId: string; amount: number; reason: string }, _tx?: unknown) => {
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

// ─── Fake DB: an in-memory interpreter for the exact SQL the TM emits ─────────
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
    if (text.startsWith('SELECT avatar_id, agent_id, placement FROM poker_tournament_entrants WHERE tournament_id = ? AND status <> \'refunded\' ORDER BY placement ASC NULLS LAST')) {
      return [...this.entrants.values()]
        .filter((e) => e.tournament_id === p[0] && e.status !== 'refunded')
        .sort((a, b) => Number(a.placement ?? 1e9) - Number(b.placement ?? 1e9))
        .map((e) => ({ avatar_id: e.avatar_id, agent_id: e.agent_id, placement: e.placement }));
    }
    if (text.startsWith('INSERT INTO poker_tournament_entrants') && text.includes('buy_in_paid_ct, status) VALUES')) {
      const id = randomUUID();
      this.entrants.set(id, {
        id,
        tournament_id: p[0],
        avatar_id: p[1],
        agent_id: p[2],
        subject_type: p[3],
        buy_in_paid_ct: p[4],
        status: 'registered',
        refunded_ct: '0',
        placement: null,
        chip_stack: 0,
        current_table_id: null,
        seat_index: null,
        registered_at: this.entrants.size,
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

    if (text.startsWith('INSERT INTO poker_tables (tournament_id, table_number, status, button_seat_index, hand_count) VALUES')) {
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

function buildManager(db: FakeDb, ledger: FakeLedger, clock: FakeClock) {
  const sim = new PokerTableSim(clock);
  const broadcast: BroadcastFn = () => {};
  const sendToSeat: SendToSeatFn = () => {};
  sim.setBroadcastFn(broadcast);
  sim.setSendToSeatFn(sendToSeat);
  let seedCounter = 0;
  const placementEmits: PlacementEmit[] = [];
  const tm = new TournamentManager({
    db: db as never,
    ledger: ledger as never,
    sim,
    clock,
    seedFn: () => (seedCounter++).toString(16).padStart(64, 'a'),
    emitPlacementFn: (emit) => {
      placementEmits.push(emit);
    },
  });
  return { tm, sim, placementEmits };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('TournamentManager — agent socket-less play (P5; mocked DB + ledger)', () => {
  let db: FakeDb;
  let ledger: FakeLedger;
  let clock: FakeClock;

  beforeEach(() => {
    db = new FakeDb();
    ledger = new FakeLedger();
    clock = new FakeClock();
    db.seedBlindSchedule('sched-1', DEFAULT_BLIND_SCHEDULE);
  });

  /** Register 3 subjects (one AGENT) + seat the tournament. Returns the live tableId. */
  async function seatThree(tm: TournamentManager): Promise<{ tid: string; agentAvatar: string }> {
    const tid = randomUUID();
    db.seedTournament({
      id: tid,
      buy_in_ct: '100',
      min_entrants: 2,
      max_entrants: 3,
      seats_per_table: 3,
      starting_stack: 1000,
      registration_closes_at: new Date(clock.now() + 1000),
    });

    // Two humans + ONE agent (Rule E5: the agent plays AS ITSELF on the same path).
    const subjects: RegisterSubject[] = [
      { kind: 'user', userId: 'u-h1', avatarId: 'av-h1', agentId: null },
      { kind: 'agent', userId: 'u-ag', avatarId: 'av-agent', agentId: 'agent-X' },
      { kind: 'user', userId: 'u-h2', avatarId: 'av-h2', agentId: null },
    ];
    for (const s of subjects) {
      ledger.setBalance(s.avatarId, 1000);
      await tm.registerEntrant(s, tid);
    }
    // The AGENT's buy-in debited ITS BOUND avatar (real CT) — NOT a guest tier.
    expect(ledger.get('av-agent')).toBe(900);
    expect(ledger.totalDebited('poker_mtt_buyin')).toBe(300);

    clock.advance(2000);
    const start = await tm.startTrigger(tid);
    expect(start.status).toBe('running');
    expect(start.seatedCount).toBe(3);

    return { tid, agentAvatar: 'av-agent' };
  }

  it('(A)(B) agent registers, seats, and reads its OWN view socket-lessly', async () => {
    const { tm } = buildManager(db, ledger, clock);
    const { tid, agentAvatar } = await seatThree(tm);

    // socket-less table resolution works WITHOUT a WS room (onSeatFn returns null
    // in the unit-test path — getConnectionForSubject would be null, but the agent
    // table resolver reads liveSeats directly).
    const tableId = tm.getActiveTableForAvatar(tid, agentAvatar);
    expect(tableId).not.toBeNull();

    const view = tm.getSeatViewForAgent(tid, agentAvatar);
    expect(view).not.toBeNull();
    expect(view!.holeCards.length).toBe(2);
    // Public table carries no hole cards (type + structural guarantee).
    const publicJson = JSON.stringify(view!.table);
    expect(publicJson.includes('"hole')).toBe(false);
  });

  it('(C)(D) applyAgentAction settles into the sim, is idempotent, and rejects out-of-turn', async () => {
    const { tm, sim } = buildManager(db, ledger, clock);
    const { tid, agentAvatar } = await seatThree(tm);
    const tableId = tm.getActiveTableForAvatar(tid, agentAvatar)!;

    // Find whoever is to act first; act AS that subject (could be the agent or a
    // human — the test drives the to-act seat so the action is legal in-turn).
    let snap = sim.getPublicSnapshot(tableId)!;
    const toActAvatar = snap.seats.find((s) => s.seatIndex === snap.toActSeatIndex)!.avatarId;

    // An OUT-OF-TURN action (a non-to-act seat) is rejected.
    const offTurnAvatar = ['av-h1', 'av-agent', 'av-h2'].find((a) => a !== toActAvatar)!;
    const offTurn = tm.applyAgentAction({
      tournamentId: tid,
      avatarId: offTurnAvatar,
      action: { kind: 'fold' },
      idempotencyKey: `${snap.handNumber}:0:${offTurnAvatar}`,
      actor: 'agent',
    });
    expect(offTurn.ok).toBe(false);
    expect(offTurn.reason).toBe('not_your_turn');

    // An UNSEATED avatar gets no_live_table.
    const noTable = tm.applyAgentAction({
      tournamentId: tid,
      avatarId: 'av-ghost',
      action: { kind: 'fold' },
      idempotencyKey: 'x:0:av-ghost',
      actor: 'agent',
    });
    expect(noTable.ok).toBe(false);
    expect(noTable.reason).toBe('no_live_table');

    // The to-act seat FOLDS in-turn → settles into the sim (its status flips folded
    // / the action pointer advances).
    const handNumber = snap.handNumber;
    const idem = `${handNumber}:0:${toActAvatar}`;
    const r1 = tm.applyAgentAction({
      tournamentId: tid,
      avatarId: toActAvatar,
      action: { kind: 'fold' },
      idempotencyKey: idem,
      actor: 'agent',
    });
    expect(r1.ok).toBe(true);

    // IDEMPOTENT: replaying the SAME (handNumber, actionSeq, avatar) is a stable
    // no-op returning the prior result — no double-fold, no extra advance.
    const r2 = tm.applyAgentAction({
      tournamentId: tid,
      avatarId: toActAvatar,
      action: { kind: 'fold' },
      idempotencyKey: idem,
      actor: 'agent',
    });
    expect(r2.ok).toBe(true);
    // The to-act pointer is past the folded seat now (or the hand ended) — the
    // folded seat is no longer to act.
    snap = sim.getPublicSnapshot(tableId)!;
    if (snap.toActSeatIndex !== null) {
      const stillToAct = snap.seats.find((s) => s.seatIndex === snap.toActSeatIndex)!.avatarId;
      expect(stillToAct).not.toBe(toActAvatar);
    }
  });

  it('(E) advisor returns a recommendation WITHOUT staking (no chip / ledger movement)', async () => {
    const { tm, sim } = buildManager(db, ledger, clock);
    const { tid, agentAvatar } = await seatThree(tm);
    const tableId = tm.getActiveTableForAvatar(tid, agentAvatar)!;

    const ledgerBefore = ledger.get(agentAvatar);
    const snapBefore = JSON.stringify(sim.getPublicSnapshot(tableId));

    // Ask for advice for the to-act seat (recommendation present) and an off-turn
    // seat (recommendation null but strength present).
    const snap = sim.getPublicSnapshot(tableId)!;
    const toActAvatar = snap.seats.find((s) => s.seatIndex === snap.toActSeatIndex)!.avatarId;
    const advice = tm.getActionAdvice(tid, toActAvatar)!;
    expect(advice.recommended).not.toBeNull();
    expect(advice.strength).toBeGreaterThanOrEqual(0);

    // Calling advice MANY times moves nothing.
    for (let i = 0; i < 50; i++) tm.getActionAdvice(tid, agentAvatar);

    expect(ledger.get(agentAvatar)).toBe(ledgerBefore); // no debit/credit
    expect(JSON.stringify(sim.getPublicSnapshot(tableId))).toBe(snapBefore); // no state change
  });

  it('(F) controlled-mode suppresses the agent autonomous action; human + advisor still work', async () => {
    const { tm, sim } = buildManager(db, ledger, clock);
    const { tid, agentAvatar } = await seatThree(tm);
    const tableId = tm.getActiveTableForAvatar(tid, agentAvatar)!;

    // Drive the action to the AGENT's seat so we can test suppression on a legal
    // in-turn spot: fold every non-agent seat until the agent is to act, OR the
    // agent is already to act.
    let snap = sim.getPublicSnapshot(tableId)!;
    let guard = 0;
    while (snap.toActSeatIndex !== null && guard++ < 10) {
      const toActAvatar = snap.seats.find((s) => s.seatIndex === snap.toActSeatIndex)!.avatarId;
      if (toActAvatar === agentAvatar) break;
      // Fold the non-agent to-act seat (human driver path — never suppressed).
      const res = tm.applyAgentAction({
        tournamentId: tid,
        avatarId: toActAvatar,
        action: { kind: 'fold' },
        idempotencyKey: `${snap.handNumber}:${guard}:${toActAvatar}`,
        actor: 'human',
      });
      expect(res.ok).toBe(true);
      snap = sim.getPublicSnapshot(tableId)!;
    }

    // If the hand didn't end and the agent is to act, test suppression there.
    if (snap.toActSeatIndex !== null) {
      const toActAvatar = snap.seats.find((s) => s.seatIndex === snap.toActSeatIndex)!.avatarId;
      if (toActAvatar === agentAvatar) {
        // Mark the agent's avatar human-controlled.
        tm.setAvatarControlled(agentAvatar, true);
        expect(tm.isAvatarControlled(agentAvatar)).toBe(true);

        // An autonomous (actor:'agent') action is SUPPRESSED.
        const suppressed = tm.applyAgentAction({
          tournamentId: tid,
          avatarId: agentAvatar,
          action: { kind: 'fold' },
          idempotencyKey: `${snap.handNumber}:ctrl1:${agentAvatar}`,
          actor: 'agent',
        });
        expect(suppressed.ok).toBe(false);
        expect(suppressed.reason).toBe('human_controlled');

        // Advisor still works while controlled (advice never stakes).
        const advice = tm.getActionAdvice(tid, agentAvatar);
        expect(advice).not.toBeNull();

        // The HUMAN driver's action (actor:'human') is NOT suppressed.
        const human = tm.applyAgentAction({
          tournamentId: tid,
          avatarId: agentAvatar,
          action: { kind: 'fold' },
          idempotencyKey: `${snap.handNumber}:ctrl2:${agentAvatar}`,
          actor: 'human',
        });
        expect(human.ok).toBe(true);

        // Clearing control re-enables autonomous play.
        tm.setAvatarControlled(agentAvatar, false);
        expect(tm.isAvatarControlled(agentAvatar)).toBe(false);
      }
    }
  });
});
