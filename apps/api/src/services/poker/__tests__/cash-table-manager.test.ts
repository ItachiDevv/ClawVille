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
import { CashTableManager, type CashSubject } from '../cash-table-manager';
import { PokerTableSim } from '../poker-table-sim';
import type { SimClock } from '../poker-table-types';

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
  debitClawTokens = async (input: { avatarId: string; amount: number; reason: string }) => {
    const bal = this.get(input.avatarId);
    if (bal < input.amount) throw new InsufficientTokensError(input.avatarId, bal, input.amount);
    this.balances.set(input.avatarId, bal - input.amount);
    this.debits.push({ avatarId: input.avatarId, amount: input.amount, reason: input.reason });
    return { balanceAfter: bal - input.amount, ledgerId: randomUUID() };
  };
  creditClawTokens = async (input: { avatarId: string; amount: number; reason: string }) => {
    const bal = this.get(input.avatarId);
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

  private store(table: unknown): Row[] {
    const s = this.stores.get(table);
    if (!s) throw new Error('FakeDb: unknown table');
    return s;
  }

  // ── transaction(fn) — single-threaded test: the "tx" is just this same db.
  // The real Postgres rolls back on throw; here every money mutation body throws
  // BEFORE a partial commit matters for the assertions (the ledger fake is the
  // first money op and throws on insufficient funds before any row write that the
  // tests inspect), mirroring the tournament-manager test's fake transaction.
  async transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
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

describe('CashTableManager — P1 lifecycle + conservation', () => {
  const HOUSE_BANK_AVATAR = 'house-bank-1';

  function makeManager() {
    const db = new FakeDb();
    const ledger = new FakeLedger();
    // House bank holds a real CT bankroll so seeded-agent chips are REAL-CT-backed
    // (CT-supply conservation). Without this debit the seeded chips would be minted.
    ledger.setBalance(HOUSE_BANK_AVATAR, 1_000_000);
    const sim = new PokerTableSim(new FakeClock());
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
    return { db, ledger, sim, mgr, seededAvatarId };
  }

  it('creates a mid table, seats a human + a seeded agent, plays a full hand, conserves chips, writes a settled hand row, and a leave cashes out exactly the stack', async () => {
    const { db, ledger, mgr, seededAvatarId } = makeManager();
    const human = 'human-1';
    ledger.setBalance(human, 1000);

    // Create a Mid public table (100/5/10), seeded-agent fill of 1 slot so a
    // single human reaches the 2-seat minimum.
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
      humanSubject(human),
    );
    expect(table.id).toBeTruthy();

    // Human sits with the buy-in — this triggers seeded-agent fill + hand start.
    const sit = await mgr.sitDown(table.id, humanSubject(human), 100);
    expect(sit.alreadySeated).toBe(false);
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

  it('refuses to seed agents when a houseBankAvatarProvider is missing (faucet guard)', async () => {
    const db = new FakeDb();
    const ledger = new FakeLedger();
    const sim = new PokerTableSim(new FakeClock());
    let seedCounter = 0;
    // seededAgentProvider set but NO houseBankAvatarProvider → must refuse to fill.
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
    const human = 'human-x';
    ledger.setBalance(human, 1000);
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
      humanSubject(human),
    );
    // The sit seats the human, then tries to fill seeded agents → throws (faucet
    // guard). The human's own debit already happened; the throw surfaces the misconfig.
    await expect(mgr.sitDown(table.id, humanSubject(human), 100)).rejects.toThrow(
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
