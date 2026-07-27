/**
 * Poker CASH GAMES (P1) — CashTableManager LIFECYCLE + CONSERVATION test.
 *
 * Drives the REAL `CashTableManager` + the REAL `PokerTableSim` (fake clock) with
 * NO live DB and NO real ledger:
 *   - an in-memory fake `db` that implements EXACTLY the Drizzle query-builder
 *     chains the manager uses (insert/values/returning, select/from/where/
 *     orderBy/limit, update/set/where) over four poker_cash_* table stores. The
 *     `and/eq/ne/asc/desc` predicate objects the manager passes are interpreted
 *     by a tiny matcher. Rows are stored as the snake_cased column shape Drizzle
 *     maps to/from, so $inferSelect camelCase reads round-trip.
 *   - a fake ledger recording every debit/credit against an in-memory CT balance
 *     (so InsufficientTokensError + conservation are real).
 *   - a deterministic seeded-agent provider so a single human + one seeded agent
 *     fills the table to ≥2 and a hand actually completes.
 *
 * Asserts:
 *   (a) CHIP/CT conservation — sum of stacks is conserved across a settled hand
 *       (rake 0); table_escrow_ct == sum(seat stacks) at rest.
 *   (b) a per-hand row is written with settled_at on settle.
 *   (c) a human leaves → cashes out EXACTLY its current stack (ledger credit ==
 *       stack) → seat freed; net CT across the whole session conserves.
 */

import { describe, it, expect } from 'bun:test';
import { randomUUID } from 'crypto';
import {
  buildCashSettledHandSnapshot,
  CashTableManager,
  type CashSubject,
} from '../cash-table-manager';
import { PokerTableSim } from '../poker-table-sim';
import type { HandResult, SimClock } from '../poker-table-types';

// ── Fake clock (manual; setTimer never auto-fires — turns are driven explicitly) ─
class FakeClock implements SimClock {
  private t = 1_000_000;
  now(): number {
    return this.t;
  }
  setTimer(): unknown {
    return null;
  }
  clearTimer(): void {
    /* no-op */
  }
}

// ── Fake ledger ──────────────────────────────────────────────────────────────
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
    tx?: { onRollback?: (fn: () => void) => void },
  ) => {
    const bal = this.get(input.avatarId);
    if (bal < input.amount) throw new InsufficientTokensError(input.avatarId, bal, input.amount);
    const debitCountBefore = this.debits.length;
    tx?.onRollback?.(() => {
      this.balances.set(input.avatarId, bal);
      this.debits.length = debitCountBefore;
    });
    this.balances.set(input.avatarId, bal - input.amount);
    this.debits.push({ avatarId: input.avatarId, amount: input.amount, reason: input.reason });
    return { balanceAfter: bal - input.amount, ledgerId: randomUUID() };
  };
  creditClawTokens = async (
    input: { avatarId: string; amount: number; reason: string },
    tx?: { onRollback?: (fn: () => void) => void },
  ) => {
    const bal = this.get(input.avatarId);
    const creditCountBefore = this.credits.length;
    tx?.onRollback?.(() => {
      this.balances.set(input.avatarId, bal);
      this.credits.length = creditCountBefore;
    });
    this.balances.set(input.avatarId, bal + input.amount);
    this.credits.push({ avatarId: input.avatarId, amount: input.amount, reason: input.reason });
    return { balanceAfter: bal + input.amount, ledgerId: randomUUID() };
  };
  totalDebited(): number {
    return this.debits.reduce((a, d) => a + d.amount, 0);
  }
  totalCredited(): number {
    return this.credits.reduce((a, c) => a + c.amount, 0);
  }
}

// ── Fake Drizzle-shaped DB ───────────────────────────────────────────────────
//
// Each Drizzle table object carries a Symbol-keyed metadata. We can't read that
// here without importing internals, so we tag the manager's tables by identity:
// the manager imports the real table objects, so we map them to a store by ===.

import {
  pokerCashTables,
  pokerCashSeats,
  pokerCashHands,
  pokerCashLedgerEvents,
  coveGameEvents,
  avatars,
} from '@clawville/database';

type Row = Record<string, unknown>;

/** A predicate captured from drizzle `and/eq/ne`. We re-implement those matchers. */
interface Pred {
  test(row: Row): boolean;
}

// Re-implement eq/ne/and to produce our own Pred — the manager imports the REAL
// drizzle ones, so we can't intercept those. Instead the FakeDb interprets the
// real drizzle SQL predicate by walking its structure. Simpler + robust: we shim
// `where` to accept a function predicate. But the manager passes drizzle objects.
//
// Strategy: we don't interpret drizzle predicates structurally. Instead, the
// FakeDb's query builder collects the table + the predicate, and we ask the
// drizzle predicate to filter by RECONSTRUCTING the comparison from its internal
// queryChunks (column name + bound value), mirroring the tournament test's
// renderSql. eq(col,val) → "col" = ?  ;  ne(col,val) → "col" <> ?  ;
// and(...) → joined with " and ".

import type { SQL } from 'drizzle-orm';

function colName(chunk: unknown): string | null {
  // A drizzle Column chunk exposes `.name` (snake_case db column).
  const c = chunk as { name?: string };
  return typeof c?.name === 'string' ? c.name : null;
}

/** Render a drizzle SQL predicate into {col, op, value} clauses joined by AND. */
function renderPred(q: SQL): Array<{ col: string; op: '=' | '<>'; value: unknown }> {
  const clauses: Array<{ col: string; op: '=' | '<>'; value: unknown }> = [];
  const chunks = (q as unknown as { queryChunks: unknown[] }).queryChunks ?? [];
  // Flatten: walk chunks, find pattern [Column, StringChunk(" = " | " <> "), param].
  let pendingCol: string | null = null;
  let pendingOp: '=' | '<>' | null = null;
  for (const ch of chunks) {
    const cn = (ch as { constructor?: { name?: string } })?.constructor?.name;
    if (cn === 'SQL') {
      clauses.push(...renderPred(ch as SQL));
      continue;
    }
    const maybeCol = colName(ch);
    if (cn === 'Column' || cn === 'PgColumn' || maybeCol) {
      pendingCol = maybeCol;
      continue;
    }
    if (cn === 'StringChunk') {
      const text = ((ch as { value: string[] }).value ?? []).join('');
      if (text.includes('<>')) pendingOp = '<>';
      else if (text.includes('=')) pendingOp = '=';
      continue;
    }
    // A bound param: drizzle wraps it as a Param chunk carrying `.value`.
    if (pendingCol && pendingOp) {
      const raw = cn === 'Param' ? (ch as { value: unknown }).value : ch;
      clauses.push({ col: pendingCol, op: pendingOp, value: raw });
      pendingCol = null;
      pendingOp = null;
    }
  }
  return clauses;
}

function matchRow(row: Row, q: SQL | undefined): boolean {
  if (!q) return true;
  const clauses = renderPred(q);
  for (const cl of clauses) {
    const rv = row[cl.col];
    const lv = cl.value;
    const eq = String(rv) === String(lv);
    if (cl.op === '=' && !eq) return false;
    if (cl.op === '<>' && eq) return false;
  }
  return true;
}

class FakeDb {
  stores = new Map<unknown, Row[]>([
    [pokerCashTables, []],
    [pokerCashSeats, []],
    [pokerCashHands, []],
    [pokerCashLedgerEvents, []],
    [coveGameEvents, []],
    [avatars, []],
  ]);
  private rollbackScopes: Array<Array<() => void>> = [];
  private nextSeatConflict: Row | null = null;
  private committedSeatAfterRollback: Row | null = null;

  private store(table: unknown): Row[] {
    const s = this.stores.get(table);
    if (!s) throw new Error('FakeDb: unknown table');
    return s;
  }

  // ── transaction(fn) — single-threaded test: the "tx" is just this same db.
  // The real Postgres rolls back on throw. This fake snapshots DB rows and lets the
  // ledger register rollback callbacks so the FIX-D 23505 race test can prove the
  // losing debit disappears with the failed seat insert.
  onRollback(fn: () => void): void {
    this.rollbackScopes.at(-1)?.push(fn);
  }

  failNextSeatInsertWithCommittedConflict(row: Row): void {
    this.nextSeatConflict = this.toRow(pokerCashSeats, row);
  }

  async transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    const snapshot = new Map<unknown, Row[]>();
    for (const [table, rows] of this.stores) {
      snapshot.set(table, rows.map((row) => ({ ...row })));
    }
    const callbacks: Array<() => void> = [];
    this.rollbackScopes.push(callbacks);
    try {
      return await fn(this);
    } catch (err) {
      for (const [table, rows] of snapshot) {
        this.stores.set(table, rows.map((row) => ({ ...row })));
      }
      for (const callback of callbacks.reverse()) callback();
      if (this.committedSeatAfterRollback) {
        this.store(pokerCashSeats).push(this.committedSeatAfterRollback);
        this.committedSeatAfterRollback = null;
      }
      throw err;
    } finally {
      this.rollbackScopes.pop();
    }
  }

  // ── execute(sql) — interprets ONLY the raw `SELECT … FOR UPDATE` lock reads
  // the manager issues inside its transactions. Walks the drizzle SQL chunks to
  // find the target table name + the bound id, returns matching snake_case rows.
  async execute<T = Row>(q: SQL): Promise<T[]> {
    const chunks = (q as unknown as { queryChunks: unknown[] }).queryChunks ?? [];
    let textJoined = '';
    const params: unknown[] = [];
    for (const ch of chunks) {
      const cn = (ch as { constructor?: { name?: string } })?.constructor?.name;
      if (cn === 'StringChunk') {
        textJoined += ((ch as { value: string[] }).value ?? []).join(' ');
      } else if (cn === 'Param') {
        params.push((ch as { value: unknown }).value);
      } else {
        const nm = (ch as { name?: string }).name;
        if (typeof nm === 'string') {
          // A drizzle Column chunk — its db column name belongs in the text.
          textJoined += ` ${nm} `;
        } else {
          // An inlined primitive bound value (drizzle embeds `${id}` as a
          // String/Number chunk, NOT a Param, in a raw sql`` template). Treat it
          // as a positional parameter.
          params.push(ch);
        }
      }
    }
    const t = textJoined.toLowerCase();
    const id = params[0];
    const matchById = (rows: Row[], key: string) =>
      rows.filter((r) => String(r[key]) === String(id));

    if (t.includes('poker_cash_tables')) {
      return matchById(this.store(pokerCashTables), 'id') as T[];
    }
    if (t.includes('poker_cash_seats')) {
      return matchById(this.store(pokerCashSeats), 'id') as T[];
    }
    if (t.includes('poker_cash_hands')) {
      // WHERE table_id = ? AND hand_number = ? — params: [tableId, handNumber].
      const [tid, hn] = params;
      return this.store(pokerCashHands).filter(
        (r) => String(r.table_id) === String(tid) && String(r.hand_number) === String(hn),
      ) as T[];
    }
    return [] as T[];
  }

  // ── insert(table).values(v).returning() ───────────────────────────────────
  insert(table: unknown) {
    const self = this;
    return {
      values(v: Row) {
        const row = self.toRow(table, v);
        return {
          async returning() {
            if (table === pokerCashSeats && self.nextSeatConflict) {
              self.committedSeatAfterRollback = self.nextSeatConflict;
              self.nextSeatConflict = null;
              throw Object.assign(new Error('duplicate key value violates unique constraint'), {
                code: '23505',
                constraint: 'poker_cash_seats_active_avatar_unique',
              });
            }
            self.store(table).push(row);
            return [self.fromRow(table, row)];
          },
          // .values() with no .returning() (ledger events)
          then(resolve: (x: unknown) => void) {
            self.store(table).push(row);
            resolve(undefined);
          },
        };
      },
    };
  }

  // ── select(...).from(table).where(q).orderBy(o).limit(n) ───────────────────
  select(projection?: Record<string, unknown>) {
    const self = this;
    return {
      from(table: unknown) {
        const ctx: { q?: SQL; order?: { col: string; dir: 'asc' | 'desc' }; lim?: number } = {};
        const builder = {
          where(q: SQL) {
            ctx.q = q;
            return builder;
          },
          orderBy(o: unknown) {
            ctx.order = self.parseOrder(o);
            return builder;
          },
          limit(n: number) {
            ctx.lim = n;
            return builder;
          },
          then(resolve: (rows: Row[]) => void) {
            resolve(self.runSelect(table, ctx, projection));
          },
        };
        return builder;
      },
    };
  }

  private runSelect(
    table: unknown,
    ctx: { q?: SQL; order?: { col: string; dir: 'asc' | 'desc' }; lim?: number },
    projection?: Record<string, unknown>,
  ): Row[] {
    let rows = this.store(table).filter((r) => matchRow(r, ctx.q));
    if (ctx.order) {
      const { col, dir } = ctx.order;
      rows = [...rows].sort((a, b) => {
        const av = a[col] as number;
        const bv = b[col] as number;
        return dir === 'asc' ? av - bv : bv - av;
      });
    }
    if (ctx.lim !== undefined) rows = rows.slice(0, ctx.lim);
    let out = rows.map((r) => this.fromRow(table, r));
    if (projection) {
      // Single-column projection (the manager only projects {handNumber}).
      out = out.map((r) => {
        const o: Row = {};
        for (const key of Object.keys(projection)) o[key] = r[key];
        return o;
      });
    }
    return out;
  }

  // ── update(table).set(v).where(q) ──────────────────────────────────────────
  update(table: unknown) {
    const self = this;
    return {
      set(v: Row) {
        const patch = self.toRow(table, v, /* partial */ true);
        return {
          where(q: SQL) {
            return {
              then(resolve: (x: unknown) => void) {
                for (const row of self.store(table)) {
                  if (matchRow(row, q)) Object.assign(row, patch);
                }
                resolve(undefined);
              },
            };
          },
        };
      },
    };
  }

  // ── camelCase $inferInsert/Select ↔ snake_case row column mapping ───────────
  //
  // The manager reads/writes camelCase (Drizzle $infer types) but matchRow works
  // on db column names. We keep a per-table column map.
  private static COLMAP: Record<string, [string, string]> = {
    // camel -> snake (the ones the manager touches)
    id: ['id', 'id'],
    tableId: ['tableId', 'table_id'],
    avatarId: ['avatarId', 'avatar_id'],
    agentId: ['agentId', 'agent_id'],
    seatId: ['seatId', 'seat_id'],
    source: ['source', 'source'],
    visibility: ['visibility', 'visibility'],
    tierKey: ['tierKey', 'tier_key'],
    buyInCt: ['buyInCt', 'buy_in_ct'],
    smallBlindCt: ['smallBlindCt', 'small_blind_ct'],
    bigBlindCt: ['bigBlindCt', 'big_blind_ct'],
    maxSeats: ['maxSeats', 'max_seats'],
    seededAgentSlots: ['seededAgentSlots', 'seeded_agent_slots'],
    joinCode: ['joinCode', 'join_code'],
    createdBy: ['createdBy', 'created_by'],
    rakeBps: ['rakeBps', 'rake_bps'],
    rakeCapCt: ['rakeCapCt', 'rake_cap_ct'],
    tableEscrowCt: ['tableEscrowCt', 'table_escrow_ct'],
    rakeTakenCt: ['rakeTakenCt', 'rake_taken_ct'],
    status: ['status', 'status'],
    subjectType: ['subjectType', 'subject_type'],
    isSeeded: ['isSeeded', 'is_seeded'],
    seatIndex: ['seatIndex', 'seat_index'],
    currentStackCt: ['currentStackCt', 'current_stack_ct'],
    totalBoughtInCt: ['totalBoughtInCt', 'total_bought_in_ct'],
    totalCashedOutCt: ['totalCashedOutCt', 'total_cashed_out_ct'],
    seatedAt: ['seatedAt', 'seated_at'],
    leftAt: ['leftAt', 'left_at'],
    updatedAt: ['updatedAt', 'updated_at'],
    createdAt: ['createdAt', 'created_at'],
    handNumber: ['handNumber', 'hand_number'],
    serverSeedCommit: ['serverSeedCommit', 'server_seed_commit'],
    serverSeedReveal: ['serverSeedReveal', 'server_seed_reveal'],
    clientSeed: ['clientSeed', 'client_seed'],
    boardJson: ['boardJson', 'board_json'],
    potTotalCt: ['potTotalCt', 'pot_total_ct'],
    potResultJson: ['potResultJson', 'pot_result_json'],
    seatResultJson: ['seatResultJson', 'seat_result_json'],
    endedAt: ['endedAt', 'ended_at'],
    settledAt: ['settledAt', 'settled_at'],
    kind: ['kind', 'kind'],
    amountCt: ['amountCt', 'amount_ct'],
    ledgerTxnId: ['ledgerTxnId', 'ledger_txn_id'],
  };

  /** camelCase input → row keyed by snake_case (matchRow uses snake). Fills defaults. */
  private toRow(table: unknown, v: Row, partial = false): Row {
    const row: Row = {};
    for (const [k, val] of Object.entries(v)) {
      const map = FakeDb.COLMAP[k];
      row[map ? map[1] : k] = val;
    }
    if (!partial) {
      if (row.id === undefined) row.id = randomUUID();
      if (row.created_at === undefined) row.created_at = new Date();
      if (row.updated_at === undefined && this.hasUpdatedAt(table)) row.updated_at = new Date();
    }
    return row;
  }

  private hasUpdatedAt(table: unknown): boolean {
    return table === pokerCashTables || table === pokerCashSeats;
  }

  /** snake_case row → camelCase $inferSelect shape the manager reads. */
  private fromRow(table: unknown, row: Row): Row {
    const out: Row = {};
    for (const [, [camel, snake]] of Object.entries(FakeDb.COLMAP)) {
      if (snake in row) out[camel] = row[snake];
    }
    return out;
  }

  private parseOrder(o: unknown): { col: string; dir: 'asc' | 'desc' } {
    // drizzle asc(col)/desc(col) → SQL with the column + " asc"/" desc".
    const chunks = (o as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
    let col = 'id';
    let dir: 'asc' | 'desc' = 'asc';
    for (const ch of chunks) {
      const cn = (ch as { name?: string }).name;
      if (cn) col = cn;
      const text =
        (ch as { value?: string[] })?.value && Array.isArray((ch as { value: string[] }).value)
          ? (ch as { value: string[] }).value.join('')
          : '';
      if (text.includes('desc')) dir = 'desc';
    }
    return { col, dir };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function humanSubject(avatarId: string): CashSubject {
  return { kind: 'user', userId: `u-${avatarId}`, avatarId, agentId: null };
}

/**
 * The creator subject the house auto-scaler uses to stand up a `source='house'`
 * table: its avatarId IS the house-bank avatar. The manager's house-table scope
 * guard (2026-06-22) only lets the house-bank avatar create house tables, so any
 * test that creates a house table must use THIS as the creator.
 */
function houseCreatorSubject(houseBankAvatarId: string): CashSubject {
  return {
    kind: 'agent',
    userId: houseBankAvatarId,
    avatarId: houseBankAvatarId,
    agentId: 'poker-house-bank',
    name: 'Poker House Bank',
  };
}

describe('CashTableManager — P1 lifecycle + conservation', () => {
  const HOUSE_BANK_AVATAR = 'house-bank-1';

  function makeManager() {
    const db = new FakeDb();
    const ledger = new FakeLedger();
    // House bank holds a real CT bankroll so seeded-agent chips are REAL-CT-backed
    // (CT-supply conservation). Without this debit the seeded chips would be minted.
    ledger.setBalance(HOUSE_BANK_AVATAR, 1_000_000);
    const sim = new PokerTableSim(new FakeClock());
    const completed: HandResult[] = [];
    const installHandComplete = sim.setHandCompleteFn.bind(sim);
    sim.setHandCompleteFn = (handler) => {
      installHandComplete((tableId, result) => {
        completed.push(result);
        handler(tableId, result);
      });
    };
    let seedCounter = 0;
    const seededAvatarId = 'agent-seed-1';
    const mgr = new CashTableManager({
      db: db as never,
      ledger: ledger as never,
      sim,
      clock: new FakeClock(),
      seedFn: () => (seedCounter++).toString(16).padStart(64, '0'),
      seededAgentProvider: () => ({
        avatarId: seededAvatarId,
        agentId: 'agent-seed',
        name: 'Seeded Agent',
      }),
      houseBankAvatarProvider: () => HOUSE_BANK_AVATAR,
    });
    return { db, ledger, sim, mgr, seededAvatarId, completed };
  }

  async function runReconstructionFidelityHand(
    terminal: 'showdown' | 'fold-win',
  ) {
    const { db, ledger, sim, mgr, completed } = makeManager();
    const table = await mgr.createTable(
      {
        source: 'player-public',
        visibility: 'public',
        tierKey: null,
        buyInCt: 100,
        smallBlindCt: 1,
        bigBlindCt: 2,
        maxSeats: 6,
        seededAgentSlots: 0,
      },
      humanSubject('fidelity-creator'),
    );
    const tableId = table.id;
    const sid = `cash:${tableId}`;
    const handNumber = terminal === 'showdown' ? 37 : 38;
    const serverSeed = terminal === 'showdown' ? '42'.repeat(32) : '24'.repeat(32);
    // CashTableManager's production client seed (DEFAULT_CLIENT_SEED).
    const clientSeed = 'c1a4ca54';
    const fundedSeats = [
      { seatIndex: 0, avatarId: 'fidelity-seat-0' },
      { seatIndex: 2, avatarId: 'fidelity-seat-2' },
      { seatIndex: 5, avatarId: 'fidelity-seat-5' },
    ];

    // Seat through the manager's real atomic debit→seat→escrow path, but call the
    // private primitive directly so the normal "start as soon as seat #2 arrives"
    // wrapper cannot deal before all three fixtures are present.
    for (const seat of fundedSeats) {
      ledger.setBalance(seat.avatarId, 100);
      await mgr['seatSubject'](
        table,
        humanSubject(seat.avatarId),
        seat.seatIndex,
        100,
        false,
      );
    }
    // A zero-stack seat may remain durable after busting. It is active in the DB,
    // but manager deal derivation excludes it, and result.perSeat persistence must
    // exclude it too.
    db.stores.get(pokerCashSeats)!.push({
      id: randomUUID(),
      table_id: tableId,
      avatar_id: 'undealt-zero',
      agent_id: null,
      subject_type: 'human',
      is_seeded: 'false',
      seat_index: 4,
      current_stack_ct: '0',
      total_bought_in_ct: '100',
      total_cashed_out_ct: '0',
      status: 'sitting_in',
    });

    // This is the same PokerTableSim.startHand deal entry CashTableManager uses:
    // only funded sitting-in seats, in seatIndex order, fixed seed + hand nonce.
    sim.startHand({
      tableId: sid,
      handNumber,
      seatAssignments: fundedSeats.map((seat) => ({
        ...seat,
        name: `Seat ${seat.seatIndex}`,
        subjectType: 'human' as const,
        chipStack: 100,
      })),
      blinds: { sb: 1, bb: 2, ante: 0 },
      buttonSeatIndex: 0,
      serverSeed,
      clientSeed,
      turnClockMs: 30_000,
      agentTurnGraceMs: 0,
    });

    // Private sim views are the ground truth. Capture BEFORE any fold can muck a
    // seat in the terminal HandResult.
    const actualHoleBySeat = new Map(
      fundedSeats.map((seat) => {
        const view = sim.getSeatViewForAgent(sid, seat.avatarId);
        expect(view).not.toBeNull();
        return [seat.seatIndex, view!.holeCards] as const;
      }),
    );
    let actionSeq = 0;
    const act = (
      avatarId: string,
      action: { kind: 'fold' | 'call' | 'check' },
    ) => {
      const applied = sim.applyAction(sid, avatarId, action, {
        idempotencyKey: `fidelity-${terminal}-${actionSeq++}`,
      });
      expect(applied.ok).toBe(true);
      return applied;
    };

    // Three-way preflop: button folds. In the showdown case SB completes and the
    // two surviving seats check every street; in fold-win SB also folds.
    act('fidelity-seat-0', { kind: 'fold' });
    if (terminal === 'showdown') {
      act('fidelity-seat-2', { kind: 'call' });
      act('fidelity-seat-5', { kind: 'check' });
      for (let street = 0; street < 3; street++) {
        act('fidelity-seat-2', { kind: 'check' });
        act('fidelity-seat-5', { kind: 'check' });
      }
    } else {
      const finalAction = act('fidelity-seat-2', { kind: 'fold' });
      expect(finalAction.handComplete).toBe(true);
    }

    const result = completed.find((candidate) => candidate.handNumber === handNumber);
    expect(result).toBeDefined();
    expect(result!.endedAt).toBe(terminal === 'showdown' ? 'showdown' : 'preflop');

    // Drain the manager-owned pending result through the real production
    // settleHand path. This writes the exact seat_result_json shape BA-1 reads.
    await mgr['settleIfComplete'](tableId);
    const handRow = db.stores.get(pokerCashHands)!.find(
      (row) => row.table_id === tableId && row.hand_number === handNumber,
    );
    expect(handRow).toBeDefined();

    const persistedSeats = handRow!.seat_result_json as Array<{
      seatIndex: number;
      avatarId: string;
      startStack: string;
      endStack: string;
      totalCommitted: string;
      grossWon: string;
      rakeAttributed: string;
      net: string;
      stackDelta: string;
      status: 'active' | 'folded' | 'allin' | 'sitting_out' | 'busted';
      mucked: boolean;
    }>;
    expect(persistedSeats.map((seat) => seat.seatIndex)).toEqual([0, 2, 5]);
    expect(persistedSeats.some((seat) => seat.avatarId === 'undealt-zero')).toBe(false);

    const snapshot = buildCashSettledHandSnapshot({
      tableId: handRow!.table_id as string,
      handNumber: handRow!.hand_number as number,
      board: handRow!.board_json as HandResult['board'],
      endedAt: handRow!.ended_at as HandResult['endedAt'],
      pots: handRow!.pot_result_json as HandResult['settledPots'],
      seats: persistedSeats,
      serverSeed: handRow!.server_seed_reveal as string,
      clientSeed: handRow!.client_seed as string,
      settledAt: handRow!.settled_at as Date,
    });

    return { snapshot, actualHoleBySeat };
  }

  it('creates a mid table, seats a human + a seeded agent, plays a full hand, conserves chips, writes a settled hand row, and a leave cashes out exactly the stack', async () => {
    const { db, ledger, mgr, seededAvatarId, completed } = makeManager();
    const human = 'human-1';
    ledger.setBalance(human, 1000);

    // Create a Mid HOUSE table (100/5/10), seeded-agent fill of 1 slot so a
    // single human reaches the 2-seat minimum. Seeding is HOUSE-ONLY (locked
    // scope), so the seeding/conservation harness uses source='house'.
    const table = await mgr.createTable(
      {
        source: 'house',
        visibility: 'public',
        tierKey: 'mid',
        buyInCt: 100,
        smallBlindCt: 5,
        bigBlindCt: 10,
        maxSeats: 6,
        seededAgentSlots: 1,
      },
      // House tables may only be created by the house-bank avatar (scope guard).
      houseCreatorSubject(HOUSE_BANK_AVATAR),
    );
    expect(table.id).toBeTruthy();

    // Human sits with the buy-in — this triggers seeded-agent fill + hand start.
    const sit = await mgr.sitDown(table.id, humanSubject(human), 100);
    expect(sit.alreadySeated).toBe(false);
    expect(sit.buyInLedgerTxnId).toBeTruthy();
    expect(ledger.get(human)).toBe(900); // 100 debited from the human
    // The seeded agent's chips are REAL-CT-backed: the house bank was ALSO debited
    // 100 (not minted). Total debits = 100 (human) + 100 (house) = 200.
    expect(ledger.totalDebited()).toBe(200);
    expect(ledger.get(HOUSE_BANK_AVATAR)).toBe(1_000_000 - 100);

    // A hand should now be live (human + seeded agent = 2 funded seats).
    const stateAfterSit = await mgr.getTableState(table.id);
    expect(stateAfterSit).not.toBeNull();
    expect(stateAfterSit!.seats.length).toBe(2);
    const seededSeat = stateAfterSit!.seats.find((s) => s.avatarId === seededAvatarId);
    expect(seededSeat?.isSeeded).toBe(true);
    expect(seededSeat?.subjectType).toBe('agent');

    // Conservation at the hand-start escrow level: escrow == 100 (human) + 100
    // (seeded) == 200 == sum of seat stacks.
    const cons0 = await mgr.assertConservation(table.id);
    expect(cons0.escrow).toBe(200);
    expect(cons0.seatSum).toBe(200);
    expect(cons0.ok).toBe(true);

    // Drive hand #1 to completion. The manager auto-drives the seeded agent inside
    // sitDown/submitAction, so when control returns to the test it is ALWAYS the
    // human's turn (or the hand has resolved). The human FOLDS to a bet (ends the
    // hand by fold-around) else CHECKS, until a settled hand #1 row exists. The
    // manager auto-starts the next hand, so we stop once hand #1 has settled.
    const sid = `cash:${table.id}`;
    let guard = 0;
    while (guard++ < 50) {
      const settled = (db.stores.get(pokerCashHands) as Row[]).some(
        (h) => Number(h.hand_number) === 1 && h.settled_at,
      );
      if (settled) break;
      const view = mgr.getSeatViewForAgent(table.id, human);
      if (!view || !view.isYourTurn) {
        // Not the human's turn and hand #1 not yet settled — let the manager finish
        // driving by submitting a no-op-equivalent is impossible; instead the hand
        // must already be resolving. Re-loop to re-check the settled flag.
        if (!mgr['sim'].getPublicSnapshot(sid)) continue;
        // Live hand but not human's turn ⇒ a seeded agent is mid-decision the
        // manager already drove; nothing for the test to do. Break to assert.
        break;
      }
      const action =
        view.toCall > 0 ? ({ kind: 'fold' } as const) : ({ kind: 'check' } as const);
      await mgr.submitAction({
        tableId: table.id,
        subject: humanSubject(human),
        handNumber: view.handNumber,
        actionSeq: guard,
        action,
      });
    }

    // A settled poker_cash_hands row for hand #1 must exist.
    const handRows = (db.stores.get(pokerCashHands) as Row[]).filter(
      (h) => Number(h.hand_number) === 1,
    );
    expect(handRows.length).toBe(1);
    expect(handRows[0]!.settled_at).toBeTruthy();
    expect(Array.isArray(handRows[0]!.pot_result_json)).toBe(true);
    expect(Array.isArray(handRows[0]!.seat_result_json)).toBe(true);
    expect(handRows[0]!.ended_at).toBeTruthy();
    expect(handRows[0]!.pot_result_json).toEqual(
      completed.find((result) => result.handNumber === 1)!.settledPots,
    );
    for (const pot of handRows[0]!.pot_result_json as Array<{
      amount: string;
      awards: Array<{ amount: string }>;
    }>) {
      expect(pot.awards.reduce((sum, award) => sum + BigInt(award.amount), 0n))
        .toBe(BigInt(pot.amount));
    }

    // CONSERVATION after settle: escrow unchanged at 200; sum of active seat
    // stacks still == 200 (chips only moved between the two seats, rake 0).
    const consAfter = await mgr.assertConservation(table.id);
    expect(consAfter.escrow).toBe(200);
    expect(consAfter.seatSum).toBe(200);
    expect(consAfter.ok).toBe(true);

    // The human LEAVES — WITHOUT the test manually stopping the sim (proving the
    // leave path is structurally reachable at a 2-funded-seat table). If a hand
    // auto-started after hand #1 settled, the leave is QUEUED and cashed out at the
    // next between-hands boundary; if the table is idle, it cashes out immediately.
    const balBeforeLeave = ledger.get(human);
    const creditsBeforeLeave = ledger.credits.filter((c) => c.avatarId === human).length;

    const leave = await mgr.leaveTable(table.id, humanSubject(human));

    if (leave.queued) {
      // A hand was live → the stand-up queued. The human is NOT yet cashed out, and
      // its seat is now sitting_out (excluded from the next deal). Drive the live
      // hand to completion so processPendingLeaves cashes it out at the boundary.
      expect(leave.cashedOutCt).toBe(0);
      let g2 = 0;
      while (g2++ < 50) {
        const afterState = await mgr.getTableState(table.id);
        const stillSeated = afterState!.seats.find((s) => s.avatarId === human);
        if (!stillSeated) break; // processed → cashed out + seat freed.
        const view = mgr.getSeatViewForAgent(table.id, human);
        if (view && view.isYourTurn) {
          const action =
            view.toCall > 0 ? ({ kind: 'fold' } as const) : ({ kind: 'check' } as const);
          await mgr.submitAction({
            tableId: table.id,
            subject: humanSubject(human),
            handNumber: view.handNumber,
            actionSeq: 1000 + g2,
            action,
          });
        } else if (!mgr['sim'].getPublicSnapshot(sid)) {
          // No live hand + still seated ⇒ kick the boundary so pending leaves run.
          await mgr.startHandWhenReady(table.id);
        } else {
          break;
        }
      }
    }

    // The human's seat is now 'left' (freed) — no manual sim.stopTable() needed.
    const afterLeave = await mgr.getTableState(table.id);
    const stillHuman = afterLeave!.seats.find((s) => s.avatarId === human);
    expect(stillHuman).toBeUndefined();

    // Exactly ONE cash-out credit fired for the human, and it equals the seat's
    // stack AT CASH-OUT TIME (credit == stack — chips don't appear/vanish). The
    // credited amount is the delta in the human's wallet since the leave request.
    const humanCashOutCredits = ledger.credits.filter(
      (c) => c.avatarId === human && c.reason === 'poker_cash_cash_out',
    );
    expect(humanCashOutCredits.length).toBe(1);
    void creditsBeforeLeave;
    const cashedOut = ledger.get(human) - balBeforeLeave;
    expect(humanCashOutCredits[0]!.amount).toBe(cashedOut);
    expect(cashedOut).toBeGreaterThanOrEqual(0);

    // ── CT-SUPPLY CONSERVATION (concern g) — the faucet is closed ───────────────
    // Across the WHOLE session, real CT is neither minted nor burned: every chip in
    // escrow is backed by a real debit, so total debits == total credits + remaining
    // escrow. A human winning seeded chips did NOT increase total CT supply.
    const finalState = await mgr.getTableState(table.id);
    const escrowNow = Number(finalState!.table.tableEscrowCt);
    expect(ledger.totalDebited()).toBe(ledger.totalCredited() + escrowNow);

    // Concretely: the human's net is exactly what it won/lost at the table, and the
    // house bank's net exactly offsets it (zero-sum, rake 0). Human net + house net
    // (vs their starting balances) sums to 0.
    const humanNet = ledger.get(human) - 1000;
    const houseNet = ledger.get(HOUSE_BANK_AVATAR) - 1_000_000;
    // The only non-house, non-human CT holder is the still-seated seeded agent's
    // escrowed chips. Human + house net + escrow-held-by-seeded == 0.
    expect(humanNet + houseNet + escrowNow).toBe(0);
  });

  it('BA-1 reconstructs every non-folded showdown hole exactly from the actual cash-sim deal', async () => {
    const { snapshot, actualHoleBySeat } =
      await runReconstructionFidelityHand('showdown');

    const folded = snapshot.seats.filter((seat) => seat.status === 'folded');
    const shownDown = snapshot.seats.filter((seat) => seat.status !== 'folded');
    expect(folded).toHaveLength(1);
    expect(shownDown).toHaveLength(2);
    for (const seat of folded) expect(seat.shown).toBeNull();
    for (const seat of shownDown) {
      const actualHole = actualHoleBySeat.get(seat.seatIndex);
      expect(actualHole).toBeDefined();
      expect(seat.shown).toEqual(actualHole!);
    }
  });

  it('BA-1 reveals no actual cash-sim hole cards when the hand ends by folds', async () => {
    const { snapshot } = await runReconstructionFidelityHand('fold-win');

    expect(snapshot.endedAt).not.toBe('showdown');
    expect(snapshot.seats.every((seat) => seat.shown === null)).toBe(true);
  });

  it('rejects a direct /sit to a PRIVATE table UUID — join code is the only way in (concern f)', async () => {
    const { mgr } = makeManager();
    const host = 'host-1';

    const table = await mgr.createTable(
      {
        source: 'private',
        visibility: 'private',
        tierKey: null,
        buyInCt: 100,
        smallBlindCt: 5,
        bigBlindCt: 10,
        maxSeats: 6,
        seededAgentSlots: 0,
        joinCode: 'SECRET1',
      },
      humanSubject(host),
    );

    const intruder = 'intruder-1';
    // A direct /sit to the private UUID (no join code) is rejected 403.
    await expect(mgr.sitDown(table.id, humanSubject(intruder), 100)).rejects.toThrow(
      /can only be joined with their join code/,
    );

    // Joining by the correct code DOES seat them (the legitimate path).
    const { ledger, mgr: mgr2 } = makeManager();
    const t2 = await mgr2.createTable(
      {
        source: 'private',
        visibility: 'private',
        tierKey: null,
        buyInCt: 100,
        smallBlindCt: 5,
        bigBlindCt: 10,
        maxSeats: 6,
        seededAgentSlots: 0,
        joinCode: 'SECRET2',
      },
      humanSubject('host-2'),
    );
    const guest = 'guest-1';
    ledger.setBalance(guest, 500);
    const joined = await mgr2.joinByCode('SECRET2', humanSubject(guest));
    expect(joined.tableId).toBe(t2.id);
    expect(joined.alreadySeated).toBe(false);
    expect(ledger.get(guest)).toBe(400); // 100 buy-in debited via the join path.
  });

  it('refuses to CREATE a house table when a houseBankAvatarProvider is missing (faucet guard, create-time)', async () => {
    const db = new FakeDb();
    const ledger = new FakeLedger();
    const sim = new PokerTableSim(new FakeClock());
    let seedCounter = 0;
    // seededAgentProvider set but NO houseBankAvatarProvider. With no house bank
    // wired, NO house table can even be created — the scope/faucet guard rejects at
    // create time (a house table without a bank would mint bot chips), which is a
    // STRONGER protection than the fill-time guard: there is no house table to sit at.
    const mgr = new CashTableManager({
      db: db as never,
      ledger: ledger as never,
      sim,
      clock: new FakeClock(),
      seedFn: () => (seedCounter++).toString(16).padStart(64, '0'),
      seededAgentProvider: () => ({
        avatarId: 'agent-seed-x',
        agentId: 'agent-seed',
        name: 'Seeded Agent',
      }),
    });
    await expect(
      mgr.createTable(
        {
          source: 'house',
          visibility: 'public',
          tierKey: 'mid',
          buyInCt: 100,
          smallBlindCt: 5,
          bigBlindCt: 10,
          maxSeats: 6,
          seededAgentSlots: 1,
        },
        // Even a would-be house creator can't make a house table with no bank wired.
        humanSubject('would-be-house'),
      ),
    ).rejects.toThrow(/may only be created by the house auto-scaler/);
  });

  it('rejects a NON-house-bank subject creating a source=house table even WITH a bank wired (scope guard)', async () => {
    // The create guard binds the creator IDENTITY, not just bank presence: a normal
    // user/agent (avatarId != house bank) is rejected even though a bank is wired.
    const { mgr } = makeManager();
    await expect(
      mgr.createTable(
        {
          source: 'house',
          visibility: 'public',
          tierKey: 'low',
          buyInCt: 20,
          smallBlindCt: 1,
          bigBlindCt: 2,
          maxSeats: 6,
          seededAgentSlots: 3,
        },
        humanSubject('regular-user'), // NOT the house bank
      ),
    ).rejects.toThrow(/may only be created by the house auto-scaler/);
    // The house-bank creator IS allowed.
    const ok = await mgr.createTable(
      {
        source: 'house',
        visibility: 'public',
        tierKey: 'low',
        buyInCt: 20,
        smallBlindCt: 1,
        bigBlindCt: 2,
        maxSeats: 6,
        seededAgentSlots: 3,
      },
      houseCreatorSubject(HOUSE_BANK_AVATAR),
    );
    expect(ok.source).toBe('house');
  });

  it('refuses to FILL seeded agents if a house table somehow lacks a houseBankAvatarProvider (fill-time faucet guard, defense-in-depth)', async () => {
    // Defense-in-depth: even if a house table existed without a bank (it can't via
    // the create guard, but the fill-time guard must still hold), the fill path
    // refuses to mint. We force this by creating the table WITH a bank, then driving
    // a manager whose provider is missing — proving fillSeededAgents itself guards.
    const db = new FakeDb();
    const ledger = new FakeLedger();
    const sim = new PokerTableSim(new FakeClock());
    let seedCounter = 0;
    // Manager A (with a bank) creates the house table row.
    const mgrWithBank = new CashTableManager({
      db: db as never,
      ledger: ledger as never,
      sim,
      clock: new FakeClock(),
      seedFn: () => (seedCounter++).toString(16).padStart(64, '0'),
      seededAgentProvider: () => ({ avatarId: 'agent-seed-x', agentId: 'agent-seed', name: 'Seeded Agent' }),
      houseBankAvatarProvider: () => HOUSE_BANK_AVATAR,
    });
    ledger.setBalance(HOUSE_BANK_AVATAR, 1_000_000);
    const table = await mgrWithBank.createTable(
      {
        source: 'house',
        visibility: 'public',
        tierKey: 'mid',
        buyInCt: 100,
        smallBlindCt: 5,
        bigBlindCt: 10,
        maxSeats: 6,
        seededAgentSlots: 1,
      },
      houseCreatorSubject(HOUSE_BANK_AVATAR),
    );
    // Manager B shares the same DB/sim but has a seeded provider and NO bank — its
    // fill path must throw rather than mint.
    const mgrNoBank = new CashTableManager({
      db: db as never,
      ledger: ledger as never,
      sim,
      clock: new FakeClock(),
      seedFn: () => (seedCounter++).toString(16).padStart(64, '0'),
      seededAgentProvider: () => ({ avatarId: 'agent-seed-y', agentId: 'agent-seed', name: 'Seeded Agent' }),
    });
    const human = 'human-x';
    ledger.setBalance(human, 1000);
    await expect(mgrNoBank.sitDown(table.id, humanSubject(human), 100)).rejects.toThrow(
      /no houseBankAvatarProvider/,
    );
  });

  it('rejects an over-balance sit with InsufficientTokensError (no seat written)', async () => {
    const { db, ledger, mgr } = makeManager();
    const poor = 'poor-1';
    ledger.setBalance(poor, 50); // less than the 100 buy-in

    const table = await mgr.createTable(
      {
        source: 'player-public',
        visibility: 'public',
        tierKey: 'mid',
        buyInCt: 100,
        smallBlindCt: 5,
        bigBlindCt: 10,
        maxSeats: 6,
        seededAgentSlots: 1,
      },
      humanSubject(poor),
    );

    await expect(mgr.sitDown(table.id, humanSubject(poor), 100)).rejects.toThrow(
      /cannot debit/,
    );
    // No seat row written for the failed sit.
    const seats = (db.stores.get(pokerCashSeats) as Row[]).filter(
      (s) => s.avatar_id === poor,
    );
    expect(seats.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// House auto-scaler + autonomous tick + advisor-policy bots — the always-on
// house-table layer. These cover the NEW actors the scaler/tick/seeder add:
//   (a) ALWAYS-ON MULTI-TABLE CONSERVATION across one shared house bank.
//   (b) advanceTable SELF-DRIVE — a bot acts with NO human poke + next hand auto-starts.
//   (c) ADVISOR POLICY — fixed-deal: nut → bet/raise, trash facing a bet → fold,
//       on-turn-only + never out of turn.
//   (d) BOT-YIELD — a seeded bot stands up (reclaimed to the bank) as reals grow,
//       while ≥2 players remain.
//   (e) HOUSE-ONLY — a player-public / private table is NEVER seeded.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A multi-bot seeded provider: each distinct (tableId, seatIndex) gets its OWN bot
 * avatar (a bot uuid never sits two live seats at once), mirroring the production
 * bot-pool's per-(table,seat) reservation. Idempotent per seat (re-claim returns
 * the same bot). Tracks issued ids so a test can fund / inspect them.
 */
function makeBotProvider() {
  let counter = 0;
  const bySeat = new Map<string, { avatarId: string; agentId: string; name: string }>();
  const reservedAt = new Map<string, string>();
  const slots: Array<{ avatarId: string; agentId: string; name: string }> = [];
  const issued = new Set<string>();
  const provider = (tableId: string, seatIndex: number) => {
    const key = `${tableId}:${seatIndex}`;
    const existing = bySeat.get(key);
    if (existing) return existing;
    let bot = slots.find((slot) => !reservedAt.has(slot.avatarId));
    if (!bot) {
      const n = counter++;
      bot = {
        avatarId: `bot-${String(n).padStart(3, '0')}`,
        agentId: `poker-bot-${String(n).padStart(3, '0')}`,
        name: `Felt-Bot-${String(n).padStart(3, '0')}`,
      };
      slots.push(bot);
    }
    bySeat.set(key, bot);
    reservedAt.set(bot.avatarId, key);
    issued.add(bot.avatarId);
    return bot;
  };
  const controller = {
    bindReservation(tableId: string, seatIndex: number, avatarId: string): boolean {
      const bot = slots.find((slot) => slot.avatarId === avatarId);
      if (!bot) return false;
      const key = `${tableId}:${seatIndex}`;
      const previousSeat = reservedAt.get(avatarId);
      if (previousSeat && previousSeat !== key) bySeat.delete(previousSeat);
      const previousBot = bySeat.get(key);
      if (previousBot && previousBot.avatarId !== avatarId) {
        reservedAt.delete(previousBot.avatarId);
      }
      bySeat.set(key, bot);
      reservedAt.set(avatarId, key);
      return true;
    },
    release(tableId: string, seatIndex: number): void {
      const key = `${tableId}:${seatIndex}`;
      const bot = bySeat.get(key);
      if (!bot) return;
      bySeat.delete(key);
      reservedAt.delete(bot.avatarId);
    },
  };
  return { provider, controller, issued, isBot: (id: string) => issued.has(id) };
}

describe('CashTableManager — house tables: multi-table conservation, self-drive, advisor, yield', () => {
  const HOUSE_BANK_AVATAR = 'house-bank-shared';
  const HOUSE_BANK_START = 1_000_000;

  /** A manager whose seeded provider hands out a DISTINCT bot per (table, seat). */
  function makeHouseManager(opts?: { seedFn?: () => string }) {
    const db = new FakeDb();
    const ledger = new FakeLedger();
    ledger.setBalance(HOUSE_BANK_AVATAR, HOUSE_BANK_START);
    const sim = new PokerTableSim(new FakeClock());
    const bots = makeBotProvider();
    let seedCounter = 0;
    const mgr = new CashTableManager({
      db: db as never,
      ledger: ledger as never,
      sim,
      clock: new FakeClock(),
      seedFn: opts?.seedFn ?? (() => (seedCounter++).toString(16).padStart(64, '0')),
      seededAgentProvider: bots.provider,
      houseBankAvatarProvider: () => HOUSE_BANK_AVATAR,
      seededAgentReservationController: bots.controller,
    });
    return { db, ledger, sim, mgr, bots };
  }

  function houseSubject(): CashSubject {
    return {
      kind: 'agent',
      userId: HOUSE_BANK_AVATAR,
      avatarId: HOUSE_BANK_AVATAR,
      agentId: 'poker-house-bank',
      name: 'Poker House Bank',
    };
  }

  async function createMidHouseTable(mgr: CashTableManager) {
    return mgr.createTable(
      {
        source: 'house',
        visibility: 'public',
        tierKey: 'mid',
        buyInCt: 100,
        smallBlindCt: 5,
        bigBlindCt: 10,
        maxSeats: 6,
        seededAgentSlots: 3,
      },
      houseSubject(),
    );
  }

  function addExistingSeededSeat(
    db: FakeDb,
    tableId: string,
    avatarId: string,
    seatIndex: number,
    stack = 470,
  ): Row {
    const row: Row = {
      id: randomUUID(),
      table_id: tableId,
      avatar_id: avatarId,
      agent_id: avatarId.replace('bot-', 'poker-bot-'),
      subject_type: 'agent',
      is_seeded: 'true',
      seat_index: seatIndex,
      current_stack_ct: String(stack),
      status: 'sitting_in',
      total_bought_in_ct: '100',
      total_cashed_out_ct: '0',
      seated_at: new Date('2026-07-26T00:00:00Z'),
      left_at: null,
      updated_at: new Date('2026-07-26T00:00:00Z'),
    };
    (db.stores.get(pokerCashSeats) as Row[]).push(row);
    const tableRow = (db.stores.get(pokerCashTables) as Row[]).find(
      (candidate) => String(candidate.id) === String(tableId),
    )!;
    tableRow.table_escrow_ct = String(Number(tableRow.table_escrow_ct ?? 0) + stack);
    return row;
  }

  it('FIX-D same-table divergence binds the actual seat before debit and preserves its money fields', async () => {
    const { db, ledger, mgr } = makeHouseManager();
    const table = await createMidHouseTable(mgr);
    const existing = addExistingSeededSeat(db, table.id, 'bot-000', 4);
    const before = { ...existing };

    await mgr.seatHouseBots(table.id);

    const seats = (db.stores.get(pokerCashSeats) as Row[]).filter(
      (seat) => String(seat.table_id) === String(table.id) && seat.status !== 'left',
    );
    expect(seats).toHaveLength(3);
    expect(seats.filter((seat) => seat.avatar_id === 'bot-000')).toHaveLength(1);
    expect(existing).toEqual(before);
    expect(ledger.debits).toHaveLength(2);
    expect(ledger.debits.every((debit) => debit.reason === 'poker_cash_house_seed')).toBe(true);
    expect(
      (db.stores.get(pokerCashLedgerEvents) as Row[]).filter(
        (event) => String(event.table_id) === String(table.id),
      ),
    ).toHaveLength(2);
  });

  it('FIX-D cross-table divergence reserves the actual row, skips that avatar, and claims another bot', async () => {
    const { db, ledger, mgr } = makeHouseManager();
    const occupiedTable = await createMidHouseTable(mgr);
    const fillTable = await createMidHouseTable(mgr);
    const existing = addExistingSeededSeat(db, occupiedTable.id, 'bot-000', 2, 1090);
    const before = { ...existing };

    await mgr.seatHouseBots(fillTable.id);

    const filled = (db.stores.get(pokerCashSeats) as Row[]).filter(
      (seat) => String(seat.table_id) === String(fillTable.id) && seat.status !== 'left',
    );
    expect(filled).toHaveLength(3);
    expect(filled.some((seat) => seat.avatar_id === 'bot-000')).toBe(false);
    expect(new Set(filled.map((seat) => seat.avatar_id)).size).toBe(3);
    expect(existing).toEqual(before);
    expect(ledger.debits).toHaveLength(3);
  });

  it('FIX-D concurrent fill: 23505 rolls back the losing debit, reconciles, and retries once', async () => {
    const { db, ledger, mgr } = makeHouseManager();
    const table = await createMidHouseTable(mgr);
    const bankBefore = ledger.get(HOUSE_BANK_AVATAR);
    db.failNextSeatInsertWithCommittedConflict({
      tableId: table.id,
      avatarId: 'bot-000',
      agentId: 'poker-bot-000',
      subjectType: 'agent',
      isSeeded: 'true',
      seatIndex: 0,
      currentStackCt: '100',
      status: 'sitting_in',
      totalBoughtInCt: '100',
      totalCashedOutCt: '0',
    });

    await mgr.seatHouseBots(table.id);

    const seats = (db.stores.get(pokerCashSeats) as Row[]).filter(
      (seat) => String(seat.table_id) === String(table.id) && seat.status !== 'left',
    );
    expect(seats).toHaveLength(3);
    expect(seats.filter((seat) => seat.avatar_id === 'bot-000')).toHaveLength(1);
    // One concurrent winner + two successful local fills; the failed local debit
    // is absent because its transaction rolled back.
    expect(ledger.debits).toHaveLength(2);
    expect(ledger.get(HOUSE_BANK_AVATAR)).toBe(bankBefore - 200);
    expect(
      (db.stores.get(pokerCashLedgerEvents) as Row[]).filter(
        (event) => String(event.table_id) === String(table.id),
      ),
    ).toHaveLength(2);
  });

  /**
   * Drive a single house table to a between-hands idle boundary: the human
   * checks/folds while the manager auto-drives the bots, settling each hand until
   * `maxHands` have settled or the table goes idle. Returns the settled hand count.
   */
  async function playOutHands(
    mgr: CashTableManager,
    sim: PokerTableSim,
    db: FakeDb,
    tableId: string,
    human: string,
    maxHands: number,
  ): Promise<number> {
    const sid = `cash:${tableId}`;
    let guard = 0;
    while (guard++ < 400) {
      const settledCount = (db.stores.get(pokerCashHands) as Row[]).filter(
        (h) => String(h.table_id) === String(tableId) && h.settled_at,
      ).length;
      if (settledCount >= maxHands) return settledCount;

      const view = mgr.getSeatViewForAgent(tableId, human);
      if (view && view.isYourTurn) {
        const action =
          view.toCall > 0 ? ({ kind: 'fold' } as const) : ({ kind: 'check' } as const);
        await mgr.submitAction({
          tableId,
          subject: humanSubject(human),
          handNumber: view.handNumber,
          actionSeq: guard,
          action,
        });
        continue;
      }
      // Not the human's turn. Either a bot is mid-decision (advanceTable drives it)
      // or the table is between hands — advanceTable both drives bots AND auto-starts.
      await mgr.advanceTable(tableId);
      // If still no live hand and the human isn't seated/your-turn, nothing left.
      if (!sim.getPublicSnapshot(sid)) {
        const stillLive = sim.getPublicSnapshot(sid);
        if (!stillLive) {
          // One more kick to start the next hand; if it can't start, we're idle.
          const started = await mgr.startHandWhenReady(tableId);
          if (!started) {
            const settledNow = (db.stores.get(pokerCashHands) as Row[]).filter(
              (h) => String(h.table_id) === String(tableId) && h.settled_at,
            ).length;
            return settledNow;
          }
        }
      }
    }
    return (db.stores.get(pokerCashHands) as Row[]).filter(
      (h) => String(h.table_id) === String(tableId) && h.settled_at,
    ).length;
  }

  it('(a) keeps Σdebits == Σcredits + Σescrow across SEVERAL house tables (seed + re-buy + human win + cash-out)', async () => {
    const { db, ledger, sim, mgr } = makeHouseManager();

    // Three house tables, one shared house bank. Each gets a human + bot fill.
    const humans = ['h-A', 'h-B', 'h-C'];
    const tables: string[] = [];
    for (const h of humans) {
      ledger.setBalance(h, 1000);
      const t = await createMidHouseTable(mgr);
      tables.push(t.id);
      await mgr.sitDown(t.id, humanSubject(h), 100);
    }

    // Every table now has the human + ≥1 seeded bot (fill target 3, capped by the
    // single human → bots up to fill the small game). The house bank was debited for
    // every seeded buy-in; conservation holds at each table.
    for (const tableId of tables) {
      const cons = await mgr.assertConservation(tableId);
      expect(cons.ok).toBe(true);
    }
    // Conservation invariant across the WHOLE house bank from the very first moment.
    const escrowSum0 = tables.reduce((acc, id) => {
      const t = (db.stores.get(pokerCashTables) as Row[]).find((r) => String(r.id) === String(id))!;
      return acc + Number(t.table_escrow_ct);
    }, 0);
    expect(ledger.totalDebited()).toBe(ledger.totalCredited() + escrowSum0);

    // Force a busted bot at table 0 so the re-buy path runs at the next boundary.
    // A REAL bust moves the busted seat's chips to a WINNER's seat (escrow-neutral),
    // so we simulate that faithfully: zero the bot's stack AND move its chips onto
    // another seat at the same table — escrow is UNCHANGED (no CT created/destroyed),
    // exactly as a real hand would leave it. The busted seat flips to sitting_out so
    // the next-boundary re-buy path (rebuyBustedBots) frees it and re-seats a fresh
    // house-bank-debited bot.
    const t0AllSeats = (db.stores.get(pokerCashSeats) as Row[]).filter(
      (s) => String(s.table_id) === String(tables[0]) && s.status !== 'left',
    );
    const t0Seats = t0AllSeats.filter((s) => s.is_seeded === 'true');
    expect(t0Seats.length).toBeGreaterThan(0);
    const bustSeat = t0Seats[0]!;
    const bustStack = Number(bustSeat.current_stack_ct);
    // The winner = any OTHER active seat at this table (chips move there).
    const winnerSeat = t0AllSeats.find((s) => s !== bustSeat)!;
    expect(winnerSeat).toBeTruthy();
    bustSeat.current_stack_ct = '0';
    bustSeat.status = 'sitting_out';
    winnerSeat.current_stack_ct = String(Number(winnerSeat.current_stack_ct) + bustStack);
    // Escrow is intentionally LEFT UNCHANGED — chips only moved between seats.

    // Between-hands boundary on table 0 → rebuyBustedBots frees the 0-stack bot
    // (no credit) and fillSeededAgents re-seats toward the target with a fresh
    // house-bank-debited bot. This crosses the house bank (debit), so the multi-table
    // bank conservation must STILL hold afterward.
    await mgr.startHandWhenReady(tables[0]);

    // Play out a couple of hands on each table so chips move between human and bots
    // (a human winning bot chips is naturally exercised at showdowns; we assert
    // conservation regardless of who won).
    for (let i = 0; i < humans.length; i++) {
      await playOutHands(mgr, sim, db, tables[i]!, humans[i]!, 2);
    }

    // One human LEAVES + cashes out (escrow → its own wallet). Drive its table to a
    // boundary if the leave queued.
    const leaver = humans[1]!;
    const leave = await mgr.leaveTable(tables[1]!, humanSubject(leaver));
    if (leave.queued) {
      let g = 0;
      while (g++ < 200) {
        const st = await mgr.getTableState(tables[1]!);
        if (!st!.seats.find((s) => s.avatarId === leaver)) break;
        const view = mgr.getSeatViewForAgent(tables[1]!, leaver);
        if (view && view.isYourTurn) {
          await mgr.submitAction({
            tableId: tables[1]!,
            subject: humanSubject(leaver),
            handNumber: view.handNumber,
            actionSeq: 5000 + g,
            action: view.toCall > 0 ? { kind: 'fold' } : { kind: 'check' },
          });
        } else {
          await mgr.advanceTable(tables[1]!);
        }
      }
    }

    // ── GLOBAL CONSERVATION across the house bank ───────────────────────────────
    // Σ real-CT debits == Σ real-CT credits + Σ escrow still held across ALL tables.
    // The seed debits, the re-buy debit, the per-hand chip shuffles (escrow-neutral),
    // the human cash-out credit, and the bot reclaims all net to this identity.
    const escrowSumFinal = tables.reduce((acc, id) => {
      const t = (db.stores.get(pokerCashTables) as Row[]).find((r) => String(r.id) === String(id))!;
      return acc + Number(t.table_escrow_ct);
    }, 0);
    expect(ledger.totalDebited()).toBe(ledger.totalCredited() + escrowSumFinal);

    // Per-table at-rest invariant (escrow == Σ seat stacks) on every IDLE table.
    for (const tableId of tables) {
      if (sim.getPublicSnapshot(`cash:${tableId}`)) continue; // skip a still-live hand
      const cons = await mgr.assertConservation(tableId);
      expect(cons.ok).toBe(true);
    }

    // ── humanNet + houseNet + Σescrow == 0 (zero-sum, rake 0) ────────────────────
    // Every CT holder is: the humans, the house bank, and chips still escrowed (held
    // by seated bots/humans). Their net change from starting balances + the escrow
    // still on the tables must sum to exactly zero — no CT minted or burned.
    const humanNet = humans.reduce((acc, h) => acc + (ledger.get(h) - 1000), 0);
    const houseNet = ledger.get(HOUSE_BANK_AVATAR) - HOUSE_BANK_START;
    expect(humanNet + houseNet + escrowSumFinal).toBe(0);
  });

  it('(b) OPTION B: a BOT-ONLY house table stays IDLE — eager-seated bots, NO hand deals, frozen stacks, NO bank churn across many ticks', async () => {
    // OPTION B (founder-approved 2026-06-22): the OLD behavior — a bot-only table
    // self-dealing bot-vs-bot 24/7 — is the bankroll drain we are REMOVING. This test
    // is the FLIP of the old "(b) advanceTable SELF-DRIVES a bot-only table deals":
    // a table whose only sitting-in seats are seeded bots must NEVER deal a hand and
    // must NEVER churn the house bank, no matter how many ticks fire. The bots ARE
    // seated (the populated-lobby look) but their stacks stay frozen.
    const { db, ledger, sim, mgr } = makeHouseManager();

    const table = await createMidHouseTable(mgr);
    const sid = `cash:${table.id}`;

    // Eager-seat the bots (what the scaler does right after createTable) — the lobby
    // shows ~seededAgentSlots seated bots, but NO hand should deal.
    await mgr.seatHouseBots(table.id);

    // The lobby look: ~3 seeded bots are seated (fill target 3), each is_seeded=true.
    const seatedBots = () =>
      (db.stores.get(pokerCashSeats) as Row[]).filter(
        (s) =>
          String(s.table_id) === String(table.id) &&
          s.status !== 'left' &&
          s.is_seeded === 'true',
      );
    expect(seatedBots().length).toBeGreaterThanOrEqual(2);
    expect(seatedBots().length).toBeLessThanOrEqual(3);
    // No real player is seated → NO hand is live.
    expect(sim.getPublicSnapshot(sid)).toBeNull();

    const handsSettled = () =>
      (db.stores.get(pokerCashHands) as Row[]).filter(
        (h) => String(h.table_id) === String(table.id) && h.settled_at,
      ).length;
    const handRowsTotal = () =>
      (db.stores.get(pokerCashHands) as Row[]).filter(
        (h) => String(h.table_id) === String(table.id),
      ).length;

    // Snapshot the bot stacks + the house-bank balance + total debits after the eager
    // seat. Across MANY self-drive ticks none of these may move (frozen, no churn).
    const botStacksAt = () =>
      seatedBots()
        .map((s) => `${s.seat_index}:${s.current_stack_ct}`)
        .sort()
        .join('|');
    const stacksBefore = botStacksAt();
    const bankBefore = ledger.get(HOUSE_BANK_AVATAR);
    const debitsBefore = ledger.totalDebited();

    // Fire the autonomous tick MANY times — a bot-only table must NOT deal, settle,
    // or re-buy on ANY of them.
    for (let t = 0; t < 50; t++) {
      await mgr.advanceTable(table.id);
    }

    // NO hand was ever dealt (not even an unsettled one) and NO hand settled.
    expect(handRowsTotal()).toBe(0);
    expect(handsSettled()).toBe(0);
    // The live sim never started a hand.
    expect(sim.getPublicSnapshot(sid)).toBeNull();
    // The bot stacks are FROZEN (zero chip movement → zero drain).
    expect(botStacksAt()).toBe(stacksBefore);
    // The house bank did NOT churn: no further debit across the idle ticks (the only
    // debits were the bounded eager-seat buy-ins, already counted before the ticks).
    expect(ledger.get(HOUSE_BANK_AVATAR)).toBe(bankBefore);
    expect(ledger.totalDebited()).toBe(debitsBefore);
    // Conservation still holds at rest: escrow == Σ seat stacks (all bot chips).
    const cons = await mgr.assertConservation(table.id);
    expect(cons.ok).toBe(true);
  });

  it('(b2) OPTION B: a HUMAN sitting at a bot-seated table TRIGGERS dealing (the idle table comes alive)', async () => {
    // The lifecycle: bot-seated idle house table → a human sits → now ≥1 real player
    // → maybeStartHand deals (human + bots). This is the populated-lobby payoff: the
    // bots were already there, and the human's arrival is what starts real play.
    const { db, ledger, sim, mgr } = makeHouseManager();
    const human = 'h-sit';
    ledger.setBalance(human, 1000);

    const table = await createMidHouseTable(mgr);
    const sid = `cash:${table.id}`;

    // Eager-seat bots — idle, no deal yet.
    await mgr.seatHouseBots(table.id);
    expect(sim.getPublicSnapshot(sid)).toBeNull(); // bot-only ⇒ no hand
    expect(
      (db.stores.get(pokerCashHands) as Row[]).filter((h) => String(h.table_id) === String(table.id)).length,
    ).toBe(0);

    // Human sits → real player present → a hand deals immediately (sitDown calls
    // startAndAdvance → maybeStartHand, which now passes the Option B gate).
    await mgr.sitDown(table.id, humanSubject(human), 100);
    // A hand is live OR already settled (the manager may auto-drive bots to showdown).
    const handRows = (db.stores.get(pokerCashHands) as Row[]).filter(
      (h) => String(h.table_id) === String(table.id),
    );
    const live = sim.getPublicSnapshot(sid);
    expect(live !== null || handRows.length > 0).toBe(true);

    // Drive a couple hands to prove dealing CONTINUES while the human is present.
    await playOutHands(mgr, sim, db, table.id, human, 2);
    const settled = (db.stores.get(pokerCashHands) as Row[]).filter(
      (h) => String(h.table_id) === String(table.id) && h.settled_at,
    ).length;
    expect(settled).toBeGreaterThanOrEqual(1);
  });

  it('(b3) OPTION B PARITY (E5): a CONNECTED/HOSTED AGENT (non-seeded) sitting ALSO triggers dealing', async () => {
    // E5 human/agent parity: a "real player" is any sitting-in NON-seeded seat — that
    // INCLUDES a connected/hosted agent (subject_type='agent', is_seeded='false').
    // An agent sitting must trigger dealing exactly like a human, so the agent plays
    // for REAL CT, not as a guest. We seat a NON-seeded AGENT subject and assert a
    // hand deals (vs. a seeded bot, which would NOT).
    const { db, ledger, sim, mgr } = makeHouseManager();
    const agentAvatar = 'connected-agent-1';
    ledger.setBalance(agentAvatar, 1000);
    // A connected/hosted agent subject: kind 'agent' (NOT seeded — it sits via the
    // normal sitDown path, so the seat is written is_seeded='false').
    const agentSubject: CashSubject = {
      kind: 'agent',
      userId: `u-${agentAvatar}`,
      avatarId: agentAvatar,
      agentId: 'hosted-agent-xyz',
      name: 'Hosted Agent',
    };

    const table = await createMidHouseTable(mgr);
    const sid = `cash:${table.id}`;

    await mgr.seatHouseBots(table.id);
    expect(sim.getPublicSnapshot(sid)).toBeNull(); // bot-only ⇒ idle

    // The connected agent sits → a NON-seeded sitting-in seat exists → dealing starts.
    const sit = await mgr.sitDown(table.id, agentSubject, 100);
    expect(sit.alreadySeated).toBe(false);

    // The agent's seat is subject_type='agent' AND is_seeded='false' (a REAL player,
    // not a bot) — so it satisfies the Option B real-player deal gate.
    const agentSeat = (db.stores.get(pokerCashSeats) as Row[]).find(
      (s) => String(s.table_id) === String(table.id) && String(s.avatar_id) === agentAvatar,
    );
    expect(agentSeat).toBeTruthy();
    expect(agentSeat!.subject_type).toBe('agent');
    expect(agentSeat!.is_seeded).toBe('false');

    // A hand dealt (live or already settled) — parity with the human path.
    const handRows = (db.stores.get(pokerCashHands) as Row[]).filter(
      (h) => String(h.table_id) === String(table.id),
    );
    const live = sim.getPublicSnapshot(sid);
    expect(live !== null || handRows.length > 0).toBe(true);
  });

  it('(b4) OPTION B: NO IDLE RE-BUY — a busted bot at a real-player-LESS table is NOT re-bought from the bank', async () => {
    // The drain we are killing: a busted bot re-buying from the house bank with no
    // human present. We force a bot to 0 chips at a table with NO real player, then
    // fire many ticks; the busted bot must NOT be re-bought (no house-bank debit).
    const { db, ledger, sim, mgr } = makeHouseManager();
    void sim;

    const table = await createMidHouseTable(mgr);
    await mgr.seatHouseBots(table.id); // idle bot-only table, bots seated

    // Force one seeded bot to 0 chips (simulate a bust) — with NO real player, this
    // would historically trigger a re-buy on the next boundary. Move its chips to
    // another bot seat so escrow is unchanged (a bust transfers chips, not destroys).
    const botSeats = (db.stores.get(pokerCashSeats) as Row[]).filter(
      (s) => String(s.table_id) === String(table.id) && s.status !== 'left' && s.is_seeded === 'true',
    );
    expect(botSeats.length).toBeGreaterThanOrEqual(2);
    const bust = botSeats[0]!;
    const other = botSeats[1]!;
    const bustStack = Number(bust.current_stack_ct);
    bust.current_stack_ct = '0';
    bust.status = 'sitting_out';
    other.current_stack_ct = String(Number(other.current_stack_ct) + bustStack);

    const debitsBefore = ledger.totalDebited();
    const bankBefore = ledger.get(HOUSE_BANK_AVATAR);
    const seatRowCountBefore = (db.stores.get(pokerCashSeats) as Row[]).filter(
      (s) => String(s.table_id) === String(table.id),
    ).length;

    // Fire many ticks + an explicit start kick — NONE may re-buy the busted bot.
    for (let t = 0; t < 30; t++) await mgr.advanceTable(table.id);
    await mgr.startHandWhenReady(table.id);

    // No NEW house-bank debit (no re-buy of the busted bot). The seatHouseBots
    // self-heal in advanceTable could top up toward the lobby target, but the bust
    // moved chips to ANOTHER bot (occupancy unchanged), so there is no deficit to
    // fill and the bank is untouched.
    expect(ledger.totalDebited()).toBe(debitsBefore);
    expect(ledger.get(HOUSE_BANK_AVATAR)).toBe(bankBefore);
    // No hand was dealt (still no real player).
    expect(
      (db.stores.get(pokerCashHands) as Row[]).filter((h) => String(h.table_id) === String(table.id)).length,
    ).toBe(0);
    void seatRowCountBefore;
  });

  it('(b5) OPTION B: EAGER-SEATING shows ~3 seated bots with a BOUNDED house-bank debit that does NOT grow over idle ticks', async () => {
    // The lobby-look + bounded-lockup guarantee: seatHouseBots seats ~seededAgentSlots
    // bots and debits the house bank a BOUNDED amount (≈ seats × buyIn) ONCE — and
    // that debit total never grows while the table sits idle (no per-tick churn).
    const { db, ledger, mgr } = makeHouseManager();

    const table = await createMidHouseTable(mgr); // mid: buyIn 100, slots 3
    const debitsAtCreate = ledger.totalDebited(); // 0 — createTable writes no ledger row
    expect(debitsAtCreate).toBe(0);

    await mgr.seatHouseBots(table.id);

    const seated = (db.stores.get(pokerCashSeats) as Row[]).filter(
      (s) => String(s.table_id) === String(table.id) && s.status !== 'left' && s.is_seeded === 'true',
    );
    // ~3 bots seated (fill target 3, slots 3).
    expect(seated.length).toBeGreaterThanOrEqual(2);
    expect(seated.length).toBeLessThanOrEqual(3);

    // The eager seat debited the house bank EXACTLY seats × buyIn (bounded, treasury-
    // banked) — not minted.
    const expectedLockup = seated.length * 100;
    const debitsAfterSeat = ledger.totalDebited();
    expect(debitsAfterSeat).toBe(expectedLockup);
    expect(ledger.get(HOUSE_BANK_AVATAR)).toBe(HOUSE_BANK_START - expectedLockup);
    // Escrow == the bounded lockup (every seated bot chip backed by a real debit).
    const escrow = Number(
      (db.stores.get(pokerCashTables) as Row[]).find((r) => String(r.id) === String(table.id))!.table_escrow_ct,
    );
    expect(escrow).toBe(expectedLockup);

    // Re-running the eager seat is IDEMPOTENT — already at target, NO further debit.
    await mgr.seatHouseBots(table.id);
    expect(ledger.totalDebited()).toBe(debitsAfterSeat);

    // And the bounded debit does NOT grow across idle self-drive ticks.
    for (let t = 0; t < 20; t++) await mgr.advanceTable(table.id);
    expect(ledger.totalDebited()).toBe(debitsAfterSeat);
    expect(ledger.get(HOUSE_BANK_AVATAR)).toBe(HOUSE_BANK_START - expectedLockup);
    // Supply conservation across the whole bank.
    const escrowFinal = Number(
      (db.stores.get(pokerCashTables) as Row[]).find((r) => String(r.id) === String(table.id))!.table_escrow_ct,
    );
    expect(ledger.totalDebited()).toBe(ledger.totalCredited() + escrowFinal);
  });

  it('(c) ADVISOR POLICY: a nut hand bets/raises, trash facing a bet folds, advice is on-turn-only', () => {
    // Drive the manager's OWN sim directly (the manager exposes getActionAdvice that
    // delegates to it) with two DETERMINISTIC deals: serverSeed 1 → seat 0 has a nut
    // river (strength 0.760 ≥ 0.72); serverSeed 0 → seat 0 has a trash river
    // (strength 0.412 < 0.45). The advisor's decision mapping is fixed-threshold +
    // pure, so these are reproducible (verified offline against estimateStrength).
    const { sim } = makeHouseManager();
    const CLIENT = 'c1a4ca54';
    const seed = (dec: number) => dec.toString(16).padStart(64, '0');

    function driveHeadsUpToRiver(sid: string, serverSeedDec: number) {
      sim.startHand({
        tableId: sid,
        handNumber: 1,
        seatAssignments: [
          { seatIndex: 0, avatarId: 'h', name: 'H', subjectType: 'human', chipStack: 100 },
          { seatIndex: 1, avatarId: 'b', name: 'B', subjectType: 'agent', chipStack: 100 },
        ],
        blinds: { sb: 5, bb: 10, ante: 0 },
        buttonSeatIndex: 0,
        serverSeed: seed(serverSeedDec),
        clientSeed: CLIENT,
        turnClockMs: 25_000,
        agentTurnGraceMs: 5_000,
      });
    }
    const who = (i: number) => (i === 0 ? 'h' : 'b');
    let key = 0;
    const k = () => `adv-${key++}`;

    // ── NUT: seat 0 to act on the river with the nut → advisor recommends bet/raise.
    {
      const sid = 'cash:adv-nut';
      driveHeadsUpToRiver(sid, 1);
      let guard = 0;
      while (guard++ < 40) {
        const snap = sim.getPublicSnapshot(sid)!;
        if (snap.toActSeatIndex === null) break;
        if (snap.street === 'river' && snap.toActSeatIndex === 0) break;
        const idx = snap.toActSeatIndex;
        const v = sim.getSeatViewForAgent(sid, who(idx))!;
        sim.applyAction(sid, who(idx), v.toCall > 0 ? { kind: 'call' } : { kind: 'check' }, {
          idempotencyKey: k(),
        });
      }
      const snap = sim.getPublicSnapshot(sid)!;
      expect(snap.street).toBe('river');
      expect(snap.toActSeatIndex).toBe(0);
      const advice = sim.getActionAdvice(sid, 'h')!;
      expect(advice.strength).toBeGreaterThanOrEqual(0.72);
      expect(advice.recommended).not.toBeNull();
      // A nut hand value-bets/raises (NOT fold/check).
      expect(['bet', 'raise']).toContain(advice.recommended!.kind);
      // OFF-TURN: the OTHER seat gets no recommendation (advice is on-turn-only).
      const off = sim.getActionAdvice(sid, 'b')!;
      expect(off.recommended).toBeNull();
    }

    // ── TRASH facing a bet: seat 0 weak river, seat 1 bets into it → advisor folds.
    {
      const sid = 'cash:adv-trash';
      driveHeadsUpToRiver(sid, 0);
      let guard = 0;
      // Drive to the river with seat 1 to act first (postflop heads-up).
      while (guard++ < 40) {
        const snap = sim.getPublicSnapshot(sid)!;
        if (snap.toActSeatIndex === null) break;
        if (snap.street === 'river' && snap.toActSeatIndex === 1) break;
        const idx = snap.toActSeatIndex;
        const v = sim.getSeatViewForAgent(sid, who(idx))!;
        sim.applyAction(sid, who(idx), v.toCall > 0 ? { kind: 'call' } : { kind: 'check' }, {
          idempotencyKey: k(),
        });
      }
      // Seat 1 BETS into seat 0.
      const v1 = sim.getSeatViewForAgent(sid, 'b')!;
      expect(v1.legalActions).toContain('bet');
      sim.applyAction(sid, 'b', { kind: 'bet', amount: v1.minRaiseTo }, { idempotencyKey: k() });

      const snap = sim.getPublicSnapshot(sid)!;
      expect(snap.toActSeatIndex).toBe(0); // seat 0 now faces the bet
      const advice = sim.getActionAdvice(sid, 'h')!;
      expect(advice.strength).toBeLessThan(0.45);
      // Trash facing a bet → fold (no bluff in the baseline advisor).
      expect(advice.recommended).toEqual({ kind: 'fold' });
      // OFF-TURN: seat 1 (already acted, not to act) gets no recommendation.
      const off = sim.getActionAdvice(sid, 'b')!;
      expect(off.recommended).toBeNull();
    }
  });

  it('(d) BOT-YIELD: as real players grow, a seeded bot stands up (reclaimed to the bank) while ≥2 players remain', async () => {
    // Fill target 3: a solo human gets bots up to 3 total. When MORE reals join and
    // push total occupancy above the small-game cap, surplus bots yield their seats.
    const { db, ledger, sim, mgr } = makeHouseManager();

    const reals = ['r-1', 'r-2', 'r-3'];
    for (const r of reals) ledger.setBalance(r, 1000);

    const table = await createMidHouseTable(mgr);

    // First human sits → bots fill toward the target (≥1 bot).
    await mgr.sitDown(table.id, humanSubject(reals[0]!), 100);
    const seatsAfter1 = (db.stores.get(pokerCashSeats) as Row[]).filter(
      (s) => String(s.table_id) === String(table.id) && s.status !== 'left',
    );
    const seededAfter1 = seatsAfter1.filter((s) => s.is_seeded === 'true').length;
    expect(seededAfter1).toBeGreaterThanOrEqual(1);

    const seededAtPeak = seededAfter1;

    // Now MORE reals sit (each sit also runs startAndAdvance → queueBotYield). As the
    // real count grows past the small-game cap, surplus bots are queued to yield.
    await mgr.sitDown(table.id, humanSubject(reals[1]!), 100);
    await mgr.sitDown(table.id, humanSubject(reals[2]!), 100);

    // Drive the table through several between-hands boundaries so queued bot-yields
    // are actually processed (processPendingLeaves cashes the yielded bot back to the
    // house bank). The humans fold/check; bots play; we just advance the table.
    let guard = 0;
    while (guard++ < 300) {
      // Act for whichever human is to act; else advance (drives bots + boundaries).
      let acted = false;
      for (const r of reals) {
        const view = mgr.getSeatViewForAgent(table.id, r);
        if (view && view.isYourTurn) {
          await mgr.submitAction({
            tableId: table.id,
            subject: humanSubject(r),
            handNumber: view.handNumber,
            actionSeq: guard * 10 + reals.indexOf(r),
            action: view.toCall > 0 ? { kind: 'fold' } : { kind: 'check' },
          });
          acted = true;
          break;
        }
      }
      if (!acted) await mgr.advanceTable(table.id);

      // Stop once a seeded bot has actually been reclaimed to the house bank.
      const reclaimCredits = ledger.credits.filter(
        (c) => c.avatarId === HOUSE_BANK_AVATAR && c.reason === 'poker_cash_house_reclaim',
      ).length;
      if (reclaimCredits >= 1) break;
    }

    // A seeded bot stood up and its chips returned to the house bank.
    const reclaimCredits = ledger.credits.filter(
      (c) => c.avatarId === HOUSE_BANK_AVATAR && c.reason === 'poker_cash_house_reclaim',
    );
    expect(reclaimCredits.length).toBeGreaterThanOrEqual(1);

    // Fewer seeded bots are in play than at the solo-human peak (a bot yielded).
    const seatsNow = (db.stores.get(pokerCashSeats) as Row[]).filter(
      (s) => String(s.table_id) === String(table.id) && s.status !== 'left',
    );
    const seededNow = seatsNow.filter((s) => s.is_seeded === 'true').length;
    expect(seededNow).toBeLessThanOrEqual(seededAtPeak);

    // ≥2 players remain (the table never went dead): real seats alone already ≥2.
    const inPlay = seatsNow.filter((s) => Number(s.current_stack_ct) > 0).length;
    expect(inPlay).toBeGreaterThanOrEqual(2);

    // Conservation still holds at whatever rest/live state we stopped at.
    if (!sim.getPublicSnapshot(`cash:${table.id}`)) {
      const cons = await mgr.assertConservation(table.id);
      expect(cons.ok).toBe(true);
    }
    const escrowNow = Number(
      (db.stores.get(pokerCashTables) as Row[]).find((r) => String(r.id) === String(table.id))!
        .table_escrow_ct,
    );
    expect(ledger.totalDebited()).toBe(ledger.totalCredited() + escrowNow);
  });

  it('(e) HOUSE-ONLY: a player-public table is NEVER seeded with bots (no house-bank debit)', async () => {
    const { db, ledger, mgr } = makeHouseManager();
    const human = 'pp-human';
    ledger.setBalance(human, 1000);

    // A PLAYER-PUBLIC table with seededAgentSlots > 0 — the fill path MUST still
    // refuse to seed it (scope is locked to source='house').
    const table = await mgr.createTable(
      {
        source: 'player-public',
        visibility: 'public',
        tierKey: 'mid',
        buyInCt: 100,
        smallBlindCt: 5,
        bigBlindCt: 10,
        maxSeats: 6,
        seededAgentSlots: 3,
      },
      humanSubject(human),
    );

    const houseBankBefore = ledger.get(HOUSE_BANK_AVATAR);
    await mgr.sitDown(table.id, humanSubject(human), 100);

    // No seeded seat was written (only the lone human).
    const seats = (db.stores.get(pokerCashSeats) as Row[]).filter(
      (s) => String(s.table_id) === String(table.id) && s.status !== 'left',
    );
    expect(seats.length).toBe(1);
    expect(seats.every((s) => s.is_seeded !== 'true')).toBe(true);

    // The house bank was NOT debited (no seeded buy-in on a non-house table).
    expect(ledger.get(HOUSE_BANK_AVATAR)).toBe(houseBankBefore);
    // And no hand started (a lone human can't reach the 2-seat minimum without bots).
    const sid = `cash:${table.id}`;
    expect((db.stores.get(pokerCashHands) as Row[]).filter(
      (h) => String(h.table_id) === String(table.id),
    ).length).toBe(0);
    void sid;
  });

  it('(e2) HOUSE-ONLY: a PRIVATE table is never seeded even with seededAgentSlots > 0', async () => {
    const { db, ledger, mgr } = makeHouseManager();
    const host = 'priv-host';
    ledger.setBalance(host, 1000);

    const table = await mgr.createTable(
      {
        source: 'private',
        visibility: 'private',
        tierKey: null,
        buyInCt: 100,
        smallBlindCt: 5,
        bigBlindCt: 10,
        maxSeats: 6,
        seededAgentSlots: 3,
        joinCode: 'PRIV01',
      },
      humanSubject(host),
    );

    const houseBankBefore = ledger.get(HOUSE_BANK_AVATAR);
    await mgr.joinByCode('PRIV01', humanSubject(host));

    const seats = (db.stores.get(pokerCashSeats) as Row[]).filter(
      (s) => String(s.table_id) === String(table.id) && s.status !== 'left',
    );
    expect(seats.length).toBe(1);
    expect(seats.every((s) => s.is_seeded !== 'true')).toBe(true);
    expect(ledger.get(HOUSE_BANK_AVATAR)).toBe(houseBankBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TURN-CLOCK timeout settlement (the OPEN HIGH #2 fix). The sim's expired-turn
// auto-fold/auto-check now routes through the manager's `setTurnTimeoutHook` →
// `handleTurnTimeout`, which runs UNDER the per-table lock and SETTLES the hand it
// resolves in the SAME pass — so a timeout-resolved hand is NEVER left as an
// undrained pendingResults entry (escrow stays consistent with Σ seat stacks),
// even on a no-tick player-public/private table.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A clock that CAPTURES the most-recently-armed timer callback so a test can FIRE
 * it on demand (simulating the real `setTimeout` expiry). Unlike `FakeClock`
 * (setTimer = no-op), this exposes `fireLatest()` to drive the turn-timeout path.
 */
class ControllableClock implements SimClock {
  private t = 2_000_000;
  private latest: (() => void) | null = null;
  now(): number {
    return this.t;
  }
  setTimer(cb: () => void): unknown {
    this.latest = cb;
    return { cb };
  }
  clearTimer(handle: unknown): void {
    if (handle && (handle as { cb: () => void }).cb === this.latest) {
      this.latest = null;
    }
  }
  /** Fire the currently-armed timer callback (the to-act seat's turn clock). */
  hasArmed(): boolean {
    return this.latest !== null;
  }
  fireLatest(): void {
    const cb = this.latest;
    this.latest = null;
    if (cb) cb();
  }
}

describe('CashTableManager — turn-clock timeout settles under the lock (OPEN HIGH #2)', () => {
  const HOUSE_BANK_AVATAR = 'house-bank-timeout';

  it('a fired turn timeout on a 2-seat house table auto-resolves the hand AND settles it (escrow == Σ stacks, no stranded escrow)', async () => {
    const db = new FakeDb();
    const ledger = new FakeLedger();
    ledger.setBalance(HOUSE_BANK_AVATAR, 1_000_000);
    const clock = new ControllableClock();
    // The SIM shares the controllable clock so its armed turn timer is captured and
    // fired by the test (the real-timer path the FakeClock never exercised).
    const sim = new PokerTableSim(clock);
    const bots = makeBotProvider();
    let seedCounter = 100;
    const mgr = new CashTableManager({
      db: db as never,
      ledger: ledger as never,
      sim,
      clock,
      seedFn: () => (seedCounter++).toString(16).padStart(64, '0'),
      seededAgentProvider: bots.provider,
      houseBankAvatarProvider: () => HOUSE_BANK_AVATAR,
    });

    const table = await mgr.createTable(
      {
        source: 'house',
        visibility: 'public',
        tierKey: 'low',
        buyInCt: 20,
        smallBlindCt: 1,
        bigBlindCt: 2,
        maxSeats: 6,
        seededAgentSlots: 1,
      },
      {
        kind: 'agent',
        userId: HOUSE_BANK_AVATAR,
        avatarId: HOUSE_BANK_AVATAR,
        agentId: 'poker-house-bank',
        name: 'Poker House Bank',
      },
    );

    const human = 'human-timeout';
    ledger.setBalance(human, 1000);
    // Human sits → seeded bot fills to 2 → a hand starts and the manager drives the
    // bot until it is the HUMAN's turn (the armed clock is on the human's seat).
    await mgr.sitDown(table.id, humanSubject(human), 20);

    const sid = `cash:${table.id}`;

    // Drive the table WITHOUT a single human action: on each step, if a turn clock is
    // armed (the human is to-act — the only seat the bot doesn't auto-drive), FIRE it
    // (auto-check/fold) and let the hook settle + auto-start; otherwise `advanceTable`
    // to start/progress a hand. We require that the human's turn is reached AND
    // timeout-resolved AT LEAST ONCE (timesFired > 0) and that ≥1 hand settles — so
    // the timeout settlement path (not just bot folds) is exercised.
    let timesFired = 0;
    let steps = 0;
    while (steps++ < 200) {
      const settledNow = (db.stores.get(pokerCashHands) as Row[]).filter(
        (h) => String(h.table_id) === String(table.id) && h.settled_at,
      ).length;
      if (timesFired > 0 && settledNow >= 2) break;

      if (clock.hasArmed()) {
        clock.fireLatest();
        timesFired++;
        // The hook runs async (void this.handleTurnTimeout) — yield so it completes.
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        continue;
      }
      await mgr.advanceTable(table.id);
      await new Promise((r) => setTimeout(r, 0));
      if (!clock.hasArmed() && !sim.getPublicSnapshot(sid)) {
        // Idle with no live hand and nothing armed — one more start attempt; if it
        // can't start (e.g. a seat busted below the minimum), stop.
        const started = await mgr.startHandWhenReady(table.id);
        if (!started) break;
      }
    }

    // The human's turn was reached AND resolved by a fired timeout at least once
    // (proving the real-timer auto-fold/check path ran), and hands settled.
    expect(timesFired).toBeGreaterThan(0);
    const settledAfter = (db.stores.get(pokerCashHands) as Row[]).filter(
      (h) => String(h.table_id) === String(table.id) && h.settled_at,
    ).length;
    expect(settledAfter).toBeGreaterThan(0);

    // CONSERVATION at rest: escrow == Σ active seat stacks — NO stranded escrow from
    // an undrained timeout-resolved hand.
    const cons = await mgr.assertConservation(table.id);
    expect(cons.ok).toBe(true);
    expect(cons.escrow).toBe(cons.seatSum);

    // SUPPLY conservation: every chip in escrow traces to a real debit (human + house
    // bank), nothing minted. Σ debits == Σ credits + escrow.
    expect(ledger.totalDebited()).toBe(ledger.totalCredited() + cons.escrow);
  });
});
