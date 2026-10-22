/**
 * Shared-table baccarat: `BaccaratTableManager` test (2026-10-22 port).
 *
 * Drives the REAL manager + the REAL provably-fair engine with NO live DB and NO real
 * ledger:
 *   - `FakeDb`: a generic in-memory Drizzle double. It reads the real table objects
 *     (`getTableColumns`), stores rows by SQL column name, applies the column defaults,
 *     enforces the partial unique indexes of the real schema (23505 + constraint_name),
 *     evaluates the real `and/or/eq/lte/inArray/isNull` SQL chunk trees, serializes
 *     top-level transactions, rolls a transaction (or a savepoint) back on throw, and
 *     answers only the two raw SQL statements the manager issues (advisory lock + the
 *     autonomous daily usage query). Any other raw SQL throws.
 *   - `FakeLedger`: debits/credits the avatar row inside the caller's tx (so a rollback
 *     also undoes the ledger), records actorKind + metadata, throws the REAL
 *     `InsufficientTokensError`, and can inject failures.
 *   - `FakeClock`: tests move time explicitly.
 *
 * Ported from 93abbbb20 (20 cases: 5 pure conservation, 11 round loop, 4 BLOCKING),
 * adapted to the persisted round state (round_seq / round_phase on the table row), the
 * void status, and the new error codes; then the spec 2 + 5 additions.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { createHash, randomUUID } from 'crypto';
import { Column, Param, SQL, StringChunk, getTableColumns, getTableName, is } from 'drizzle-orm';
import {
  avatars,
  baccaratCoups,
  baccaratShoes,
  baccaratTableBets,
  baccaratTableSeats,
  baccaratTables,
  coveGameEvents,
} from '@clawville/database';
import {
  BaccaratTableManager,
  assertRoundConservation,
  type BaccaratSeededBotPool,
  type BaccaratSettledSeatEvent,
  type ClaimedBaccaratBot,
  type CreateBaccaratTableConfig,
  type ResolvedBaccaratAgent,
} from '../baccarat/baccarat-table-manager';
import { BaccaratTableError, type BaccaratTableSubject } from '../baccarat/baccarat-table-types';
import {
  RESHUFFLE_CARD_THRESHOLD,
  playCoup,
  playCoupWithState,
  serializeCoupResult,
  settleBet,
  type BaccaratBet,
  type CoupWinner,
  type SerializedCoupResult,
} from '../baccarat-engine';
import { InsufficientTokensError } from '../claw-token-ledger';
import type { AlertErrorParams } from '../alert-error';

beforeAll(() => {
  // The daily cap tests assume the default 10000 vCLAW cap.
  delete process.env.AGENT_COVE_PLAY_DAILY_WAGER_VCLAW;
});

// ── Fake clock ───────────────────────────────────────────────────────────────

class FakeClock {
  t = 1_800_000_000_000;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

// ── Fake Drizzle DB ──────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type AnyTable = Parameters<typeof getTableColumns>[0];

const LEDGER_STORE = '__ledger';

interface UniqueDef {
  name: string;
  cols: string[];
  where: (r: Row) => boolean;
}

/** The partial unique indexes of the real schema the manager relies on. */
const UNIQUES: Record<string, UniqueDef[]> = {
  baccarat_table_seats: [
    {
      name: 'baccarat_table_seats_active_index_unique',
      cols: ['table_id', 'seat_index'],
      where: (r) => r.status === 'seated',
    },
    {
      name: 'baccarat_table_seats_active_avatar_unique',
      cols: ['avatar_id'],
      where: (r) => r.status === 'seated',
    },
  ],
  baccarat_table_bets: [
    {
      name: 'baccarat_table_bets_pending_round_seat_unique',
      cols: ['table_id', 'round_seq', 'seat_index'],
      where: (r) => r.status === 'pending',
    },
    {
      name: 'baccarat_table_bets_round_avatar_unique',
      cols: ['table_id', 'round_seq', 'avatar_id'],
      where: (r) => r.status === 'pending' || r.status === 'settled',
    },
    {
      name: 'baccarat_table_bets_coup_seat_unique',
      cols: ['coup_id', 'seat_index'],
      where: (r) => r.coup_id != null && r.status === 'settled',
    },
  ],
  baccarat_shoes: [
    {
      name: 'baccarat_shoes_table_open_unique',
      cols: ['table_id'],
      where: (r) => r.status === 'open' && r.table_id != null,
    },
  ],
  baccarat_coups: [
    { name: 'baccarat_coups_shoe_coup_unique', cols: ['shoe_id', 'coup_index'], where: () => true },
  ],
};

function norm(v: unknown): unknown {
  if (v instanceof Date) return v.getTime();
  return v;
}
function same(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  return String(norm(a)) === String(norm(b));
}
function cmp(a: unknown, b: unknown): number {
  const x = norm(a);
  const y = norm(b);
  if (x == null && y == null) return 0;
  if (x == null) return -1;
  if (y == null) return 1;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
}

function chunkText(c: unknown): string {
  return (c as StringChunk).value.join('').trim().toLowerCase();
}
function isBlank(c: unknown): boolean {
  return is(c, StringChunk) && chunkText(c) === '';
}
function chunksOf(node: SQL): unknown[] {
  return (node as unknown as { queryChunks: unknown[] }).queryChunks.filter((c) => !isBlank(c));
}

/** The DB clock `clock_timestamp()` reads (the fake clock + an optional DB skew). */
interface EvalCtx {
  dbNow(): number;
}

function rawText(node: SQL): string {
  const out = { text: '', params: [] as unknown[] };
  flattenRaw(node, out);
  return out.text.trim().toLowerCase();
}

/** Evaluate one real Drizzle condition tree against a stored (snake-keyed) row. */
function evalCond(node: unknown, row: Row, ctx: EvalCtx): boolean {
  if (!is(node, SQL)) throw new Error('FakeDb: unsupported condition node');
  const ch = chunksOf(node);
  if (ch.length === 1 && is(ch[0], SQL)) return evalCond(ch[0], row, ctx);
  if (ch.length === 1 && is(ch[0], StringChunk)) {
    const t = chunkText(ch[0]);
    if (t === 'false') return false;
    if (t === 'true') return true;
  }
  if (
    ch.length === 3 &&
    is(ch[0], StringChunk) &&
    chunkText(ch[0]) === '(' &&
    is(ch[2], StringChunk) &&
    chunkText(ch[2]) === ')'
  ) {
    return evalCond(ch[1], row, ctx);
  }
  if (ch.length >= 3 && is(ch[0], SQL) && is(ch[1], StringChunk)) {
    const op = chunkText(ch[1]);
    if (op === 'and' || op === 'or') {
      const conds = ch.filter((_, i) => i % 2 === 0);
      return op === 'and'
        ? conds.every((c) => evalCond(c, row, ctx))
        : conds.some((c) => evalCond(c, row, ctx));
    }
  }
  if (is(ch[0], Column) && is(ch[1], StringChunk)) {
    const lhs = row[(ch[0] as Column).name];
    const op = chunkText(ch[1]);
    if (op === 'is null') return lhs == null;
    if (op === 'is not null') return lhs != null;
    const val = (x: unknown): unknown => {
      if (is(x, Param)) return (x as Param).value;
      if (is(x, Column)) return row[(x as Column).name];
      if (is(x, SQL)) {
        // The only raw SQL value the manager compares against: the DB wall clock.
        if (rawText(x as SQL) === 'clock_timestamp()') return ctx.dbNow();
        throw new Error(`FakeDb: unsupported SQL operand ${rawText(x as SQL)}`);
      }
      return x;
    };
    if (op === 'in') return (ch[2] as unknown[]).map(val).some((v) => same(lhs, v));
    const rhs = val(ch[2]);
    switch (op) {
      case '=':
        return same(lhs, rhs);
      case '<>':
        return lhs != null && rhs != null && !same(lhs, rhs);
      case '<':
        return lhs != null && rhs != null && cmp(lhs, rhs) < 0;
      case '<=':
        return lhs != null && rhs != null && cmp(lhs, rhs) <= 0;
      case '>':
        return lhs != null && rhs != null && cmp(lhs, rhs) > 0;
      case '>=':
        return lhs != null && rhs != null && cmp(lhs, rhs) >= 0;
    }
  }
  throw new Error(`FakeDb: unsupported SQL condition shape (${ch.length} chunks)`);
}

function orderKeys(args: unknown[]): Array<{ col: string; dir: 1 | -1 }> {
  return args.map((a) => {
    if (is(a, Column)) return { col: (a as Column).name, dir: 1 as const };
    if (is(a, SQL)) {
      const ch = chunksOf(a as SQL);
      if (is(ch[0], Column)) {
        const dir = ch[1] && chunkText(ch[1]) === 'desc' ? (-1 as const) : (1 as const);
        return { col: (ch[0] as Column).name, dir };
      }
    }
    throw new Error('FakeDb: unsupported orderBy');
  });
}

function flattenRaw(node: SQL, out: { text: string; params: unknown[] }): void {
  for (const c of (node as unknown as { queryChunks: unknown[] }).queryChunks) {
    if (is(c, StringChunk)) out.text += (c as StringChunk).value.join('');
    else if (is(c, SQL)) flattenRaw(c as SQL, out);
    else if (is(c, Param)) out.params.push((c as Param).value);
    else if (is(c, Column)) out.text += (c as Column).name;
    else out.params.push(c);
  }
}

function defaultFor(col: Column): unknown {
  const c = col as unknown as {
    defaultFn?: () => unknown;
    hasDefault: boolean;
    default: unknown;
    columnType: string;
  };
  if (typeof c.defaultFn === 'function') return c.defaultFn();
  if (!c.hasDefault) return null;
  if (is(c.default, SQL)) {
    if (c.columnType === 'PgUUID') return randomUUID();
    if (c.columnType === 'PgTimestamp' || c.columnType === 'PgTimestampString') return new Date();
    return null;
  }
  return c.default;
}

class SelectBuilder implements PromiseLike<Row[]> {
  private cond: unknown;
  private order: unknown[] = [];
  private lim: number | undefined;
  private locked = false;
  private strength = '';
  constructor(
    private readonly db: FakeDb,
    private readonly table: AnyTable,
    private readonly proj: Record<string, unknown> | undefined,
  ) {}
  where(c: unknown): this {
    this.cond = c;
    return this;
  }
  orderBy(...o: unknown[]): this {
    this.order = o;
    return this;
  }
  limit(n: number): this {
    this.lim = n;
    return this;
  }
  for(strength: string): this {
    this.locked = true;
    this.strength = strength;
    return this;
  }
  private run(): Row[] {
    const name = getTableName(this.table);
    const root = this.db.root;
    if (this.locked && (name === 'avatars' || name === 'baccarat_tables')) {
      root.lockTrace.push(`${name}:${this.strength}`);
    }
    if (name === 'baccarat_tables' && this.locked && root.onTableLockOnce) {
      // Time passes while this tx waits for the table row lock.
      const fn = root.onTableLockOnce;
      root.onTableLockOnce = null;
      fn();
    }
    if (name === 'baccarat_table_bets' && this.locked && root.hidePendingBetsForUpdateOnce) {
      root.hidePendingBetsForUpdateOnce = false;
      return [];
    }
    let rows = this.db
      .rows(this.table)
      .filter((r) => (this.cond === undefined ? true : evalCond(this.cond, r, root)));
    if (this.order.length > 0) {
      const keys = orderKeys(this.order);
      rows = [...rows].sort((a, b) => {
        for (const k of keys) {
          const d = cmp(a[k.col], b[k.col]) * k.dir;
          if (d !== 0) return d;
        }
        return 0;
      });
    }
    if (this.lim !== undefined) rows = rows.slice(0, this.lim);
    if (this.proj) {
      return rows.map((r) => {
        const o: Row = {};
        for (const [k, col] of Object.entries(this.proj!)) o[k] = r[(col as Column).name];
        return o;
      });
    }
    return rows.map((r) => this.db.toCamel(this.table, r));
  }
  then<A = Row[], B = never>(
    ok?: ((v: Row[]) => A | PromiseLike<A>) | null,
    bad?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    let p: Promise<Row[]>;
    try {
      p = Promise.resolve(this.run());
    } catch (e) {
      p = Promise.reject(e);
    }
    return p.then(ok, bad);
  }
}

class FakeDb {
  root: FakeDb;
  inTx = false;
  stores: Record<string, Row[]> = {};
  private mutex: Promise<void> = Promise.resolve();
  hidePendingBetsForUpdateOnce = false;
  /** Runs once when the next `baccarat_tables ... FOR UPDATE` read executes (a lock-wait seam). */
  onTableLockOnce: (() => void) | null = null;
  /** Row locks (`<table>:<strength>`) and advisory locks (`advisory:<key>`) in execution order. */
  lockTrace: string[] = [];
  /** The raw SQL text of every advisory lock statement. */
  advisorySql: string[] = [];
  /** The app clock the DB clock follows; the harness wires the fake clock. */
  clockNow: () => number = () => Date.now();
  /** DB clock minus app clock (ms): models a second process with a skewed app clock. */
  dbSkewMs = 0;
  advisoryKeys: string[] = [];
  /** Settled autonomous usage today from outside this test's ledger, per avatar. */
  autoUsageBase = new Map<string, number>();
  txCount = 0;

  constructor() {
    this.root = this;
  }

  dbNow(): number {
    return this.root.clockNow() + this.root.dbSkewMs;
  }

  rows(table: AnyTable | string): Row[] {
    const name = typeof table === 'string' ? table : getTableName(table);
    const s = this.root.stores;
    return (s[name] ??= []);
  }

  toCamel(table: AnyTable, r: Row): Row {
    const o: Row = {};
    for (const [k, col] of Object.entries(getTableColumns(table))) o[k] = r[(col as Column).name];
    return o;
  }

  private toSnake(table: AnyTable, v: Row, fill: boolean): Row {
    const cols = getTableColumns(table) as Record<string, Column>;
    for (const k of Object.keys(v)) {
      if (!cols[k]) throw new Error(`FakeDb: unknown column ${getTableName(table)}.${k}`);
    }
    const out: Row = {};
    for (const [k, col] of Object.entries(cols)) {
      const val = v[k];
      if (val !== undefined) {
        if (is(val, SQL)) throw new Error(`FakeDb: SQL value for ${k} not supported`);
        out[col.name] = val;
      } else if (fill) {
        out[col.name] = defaultFor(col);
      }
    }
    return out;
  }

  private checkUniques(name: string, rows: Row[]): void {
    for (const u of UNIQUES[name] ?? []) {
      const seen = new Set<string>();
      for (const r of rows) {
        if (!u.where(r)) continue;
        if (u.cols.some((c) => r[c] == null)) continue;
        const key = u.cols.map((c) => String(norm(r[c]))).join('|');
        if (seen.has(key)) {
          const e = new Error(`duplicate key value violates unique constraint "${u.name}"`) as Error & {
            code: string;
            constraint_name: string;
          };
          e.code = '23505';
          e.constraint_name = u.name;
          throw e;
        }
        seen.add(key);
      }
    }
  }

  async transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    const root = this.root;
    if (this.inTx) {
      // Savepoint: undo only this inner block on throw.
      const snap = structuredClone(root.stores);
      try {
        return await fn(this);
      } catch (e) {
        root.stores = snap;
        throw e;
      }
    }
    const prior = root.mutex;
    let release!: () => void;
    root.mutex = new Promise<void>((r) => (release = r));
    await prior;
    const tx = Object.create(root) as FakeDb;
    tx.inTx = true;
    root.txCount++;
    const snap = structuredClone(root.stores);
    try {
      return await fn(tx);
    } catch (e) {
      root.stores = snap;
      throw e;
    } finally {
      release();
    }
  }

  select(proj?: Record<string, unknown>) {
    return { from: (table: AnyTable) => new SelectBuilder(this, table, proj) };
  }

  insert(table: AnyTable) {
    return {
      values: (v: Row | Row[]) => {
        const list = Array.isArray(v) ? v : [v];
        let done: Row[] | null = null;
        const run = (): Row[] => {
          if (done) return done;
          const name = getTableName(table);
          const added = list.map((x) => this.toSnake(table, x, true));
          const next = [...this.rows(table), ...added];
          this.checkUniques(name, next);
          this.root.stores[name] = next;
          done = added;
          return added;
        };
        const project = (rows: Row[], proj?: Record<string, unknown>) =>
          rows.map((r) => {
            if (!proj) return this.toCamel(table, r);
            const o: Row = {};
            for (const [k, col] of Object.entries(proj)) o[k] = r[(col as Column).name];
            return o;
          });
        return {
          returning: (proj?: Record<string, unknown>) => {
            try {
              return Promise.resolve(project(run(), proj));
            } catch (e) {
              return Promise.reject(e);
            }
          },
          then: (ok?: (x: unknown) => unknown, bad?: (e: unknown) => unknown) => {
            let p: Promise<unknown>;
            try {
              run();
              p = Promise.resolve(undefined);
            } catch (e) {
              p = Promise.reject(e);
            }
            return p.then(ok, bad);
          },
        };
      },
    };
  }

  update(table: AnyTable) {
    return {
      set: (patch: Row) => ({
        where: (cond: unknown) => {
          let done: Row[] | null = null;
          const run = (): Row[] => {
            if (done) return done;
            const name = getTableName(table);
            const snakePatch = this.toSnake(table, patch, false);
            const touched: Row[] = [];
            const next = this.rows(table).map((r) => {
              if (!evalCond(cond, r, this.root)) return r;
              const u = { ...r, ...snakePatch };
              touched.push(u);
              return u;
            });
            this.checkUniques(name, next);
            this.root.stores[name] = next;
            done = touched;
            return touched;
          };
          return {
            returning: (proj?: Record<string, unknown>) => {
              try {
                const rows = run();
                return Promise.resolve(
                  rows.map((r) => {
                    if (!proj) return this.toCamel(table, r);
                    const o: Row = {};
                    for (const [k, col] of Object.entries(proj)) o[k] = r[(col as Column).name];
                    return o;
                  }),
                );
              } catch (e) {
                return Promise.reject(e);
              }
            },
            then: (ok?: (x: unknown) => unknown, bad?: (e: unknown) => unknown) => {
              let p: Promise<unknown>;
              try {
                run();
                p = Promise.resolve(undefined);
              } catch (e) {
                p = Promise.reject(e);
              }
              return p.then(ok, bad);
            },
          };
        },
      }),
    };
  }

  async execute(node: SQL): Promise<Row[]> {
    const raw = { text: '', params: [] as unknown[] };
    flattenRaw(node, raw);
    const text = raw.text.toLowerCase();
    if (text.includes('pg_advisory_xact_lock')) {
      if (!this.inTx) throw new Error('FakeDb: advisory xact lock outside a tx');
      this.root.advisoryKeys.push(String(raw.params[0]));
      this.root.advisorySql.push(raw.text);
      this.root.lockTrace.push(`advisory:${String(raw.params[0])}`);
      return [];
    }
    if (text.includes('claw_token_transactions') && text.includes('autonomouscove')) {
      const avatarId = String(raw.params[0]);
      let used = this.root.autoUsageBase.get(avatarId) ?? 0;
      for (const l of this.rows(LEDGER_STORE)) {
        const meta = l.metadata as Record<string, unknown>;
        if (l.avatarId === avatarId && (l.amount as number) < 0 && meta?.autonomousCove === true) {
          used += -(l.amount as number);
        }
      }
      return [{ used_vclaw: String(used) }];
    }
    throw new Error(`FakeDb: unsupported raw SQL: ${raw.text.slice(0, 80)}`);
  }
}

// ── Fake ledger (writes inside the caller's tx; rolls back with it) ─────────────

interface LedgerInput {
  avatarId: string;
  amount: number;
  reason: string;
  source: string;
  actorKind?: string;
  metadata?: Record<string, unknown>;
}

class FakeLedger {
  failNext = 0;
  failAlways = false;
  missingTx = 0;
  /** Runs inside the caller's tx before each debit (a concurrent-writer seam). */
  onDebit: ((tx: FakeDb, input: LedgerInput) => void) | null = null;
  private apply(sign: 1 | -1, input: LedgerInput, tx: unknown): Record<string, never> {
    const ex = tx as FakeDb | undefined;
    if (!ex || !ex.inTx) {
      this.missingTx++;
      throw new Error('FakeLedger: called outside a transaction');
    }
    if (this.failAlways || this.failNext > 0) {
      if (!this.failAlways) this.failNext--;
      throw new Error('injected ledger failure');
    }
    if (sign < 0 && this.onDebit) this.onDebit(ex, input);
    const av = ex.rows(avatars).find((r) => r.id === input.avatarId);
    if (!av) throw new Error(`FakeLedger: no avatar ${input.avatarId}`);
    const bal = Number(av.claw_tokens);
    if (sign < 0 && bal < input.amount) throw new InsufficientTokensError(input.avatarId, bal, input.amount);
    av.claw_tokens = bal + sign * input.amount;
    ex.rows(LEDGER_STORE).push({
      avatarId: input.avatarId,
      amount: sign * input.amount,
      reason: input.reason,
      source: input.source,
      actorKind: input.actorKind ?? null,
      metadata: input.metadata ?? {},
    });
    return {};
  }
  debitClawTokens = async (input: LedgerInput, tx?: unknown) => this.apply(-1, input, tx);
  creditClawTokens = async (input: LedgerInput, tx?: unknown) => this.apply(1, input, tx);
}

// ── Fake bot pool ────────────────────────────────────────────────────────────

class FakeBotPool implements BaccaratSeededBotPool {
  bots: ClaimedBaccaratBot[] = [];
  bySeat = new Map<string, string>();
  released: string[] = [];
  claim(tableId: string, seatIndex: number): ClaimedBaccaratBot | null {
    const key = `${tableId}:${seatIndex}`;
    const used = new Set(this.bySeat.values());
    const existing = this.bySeat.get(key);
    if (existing) return this.bots.find((b) => b.avatarId === existing) ?? null;
    const free = this.bots.find((b) => !used.has(b.avatarId));
    if (!free) return null;
    this.bySeat.set(key, free.avatarId);
    return free;
  }
  release(tableId: string, seatIndex: number): void {
    const key = `${tableId}:${seatIndex}`;
    this.released.push(key);
    this.bySeat.delete(key);
  }
  isBot(avatarId: string): boolean {
    return this.bots.some((b) => b.avatarId === avatarId);
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

const WINDOW_MS = 12_000;
const REVEAL_MS = 4_000;
const CLIENT_SEED = 'a1b2c3d4e5f60718';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface Harness {
  db: FakeDb;
  ledger: FakeLedger;
  clock: FakeClock;
  bots: FakeBotPool;
  alerts: AlertErrorParams[];
  events: BaccaratSettledSeatEvent[];
  sessions: Map<string, ResolvedBaccaratAgent>;
  houseAgents: Set<string>;
  mgr: BaccaratTableManager;
  newManager(): BaccaratTableManager;
}

function makeHarness(): Harness {
  const db = new FakeDb();
  const ledger = new FakeLedger();
  const clock = new FakeClock();
  db.clockNow = () => clock.now();
  const bots = new FakeBotPool();
  const alerts: AlertErrorParams[] = [];
  const events: BaccaratSettledSeatEvent[] = [];
  const sessions = new Map<string, ResolvedBaccaratAgent>();
  const houseAgents = new Set<string>();
  let seedN = 0;
  const newManager = () =>
    new BaccaratTableManager({
      db: db as never,
      ledger: ledger as never,
      clock,
      seedFn: () => {
        const serverSeed = sha256(`server-seed-${++seedN}`);
        return { serverSeed, serverSeedHash: sha256(serverSeed) };
      },
      clientSeedFn: () => CLIENT_SEED,
      bettingWindowMs: WINDOW_MS,
      revealPauseMs: REVEAL_MS,
      botPool: bots,
      alert: (a) => {
        alerts.push(a);
      },
      emitSettled: (evs) => {
        events.push(...evs);
      },
      resolveAgent: async (id) => sessions.get(id) ?? null,
      isHouseAgent: async (id) => houseAgents.has(id),
      publicCacheMs: 0,
    });
  return { db, ledger, clock, bots, alerts, events, sessions, houseAgents, mgr: newManager(), newManager };
}

const LOW: CreateBaccaratTableConfig = {
  source: 'house',
  visibility: 'public',
  tierKey: 'low',
  minBetCt: 5,
  maxBetCt: 50,
  maxSeats: 6,
  seededAgentSlots: 3,
};
const MID: CreateBaccaratTableConfig = { ...LOW, tierKey: 'mid', minBetCt: 20, maxBetCt: 200 };
const HIGH: CreateBaccaratTableConfig = { ...LOW, tierKey: 'high', minBetCt: 50, maxBetCt: 500 };

function addAvatar(h: Harness, id: string, tokens: number, userId: string | null = `u-${id}`): void {
  h.db.rows(avatars).push({ id, user_id: userId, name: `Name ${id}`, model_key: 'lobster', claw_tokens: tokens });
}
function human(h: Harness, id: string, tokens = 1_000): BaccaratTableSubject {
  addAvatar(h, id, tokens);
  return { kind: 'user', userId: `u-${id}`, avatarId: id, agentId: null };
}
function agent(h: Harness, id: string, tokens = 1_000): BaccaratTableSubject & { session: string } {
  addAvatar(h, id, tokens);
  const s = { kind: 'agent' as const, userId: `u-${id}`, avatarId: id, agentId: `agent-${id}` };
  h.sessions.set(`sess-${id}`, { userId: s.userId, avatarId: id, agentId: s.agentId, ledgerCapable: true });
  return { ...s, session: `sess-${id}` };
}
function addBots(h: Harness, n: number): void {
  for (let i = 1; i <= n; i++) {
    addAvatar(h, `bot-${i}`, 0);
    h.bots.bots.push({ avatarId: `bot-${i}`, agentId: `bac-bot-00${i}`, name: `Bac-Bot-00${i}` });
  }
}
function auto(s: { session: string; agentId: string | null; avatarId: string; userId: string }, bet: BaccaratBet, wager: number) {
  return {
    agentSessionId: s.session,
    expectedAgentId: s.agentId!,
    expectedAvatarId: s.avatarId,
    expectedUserId: s.userId,
    bet,
    wager,
  };
}

const tableRow = (h: Harness, id: string) => h.db.rows(baccaratTables).find((r) => r.id === id)!;
const bets = (h: Harness) => h.db.rows(baccaratTableBets);
const ledgerRows = (h: Harness) => h.db.rows(LEDGER_STORE);
const ledgerOf = (h: Harness, avatarId: string) => ledgerRows(h).filter((l) => l.avatarId === avatarId);
const netOf = (h: Harness, avatarId: string) => ledgerOf(h, avatarId).reduce((a, l) => a + (l.amount as number), 0);
const tokens = (h: Harness, avatarId: string) => Number(h.db.rows(avatars).find((r) => r.id === avatarId)!.claw_tokens);

async function settleWindow(h: Harness, tableId: string, mgr = h.mgr) {
  h.clock.advance(WINDOW_MS);
  return mgr.tickRound(tableId);
}
async function endReveal(h: Harness, tableId: string, mgr = h.mgr) {
  h.clock.advance(REVEAL_MS);
  return mgr.tickRound(tableId);
}
async function expectCode(p: Promise<unknown>, code: string, status?: number): Promise<BaccaratTableError> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(BaccaratTableError);
  expect((thrown as BaccaratTableError).code).toBe(code);
  if (status !== undefined) expect((thrown as BaccaratTableError).httpStatus).toBe(status);
  return thrown as BaccaratTableError;
}
function lastCoup(h: Harness) {
  const coups = h.db.rows(baccaratCoups);
  return coups[coups.length - 1]!;
}

// ── Pure conservation (ported, 5) ──────────────────────────────────────────────

describe('assertRoundConservation: the pure no-mint identity', () => {
  const s = (w: CoupWinner) => (bet: BaccaratBet, stake: bigint) => {
    const { payout, commission } = settleBet(bet, stake, w);
    return { stake, payout, commission, net: payout - stake };
  };

  it('balances Σstake == Σpayout + houseEdge across P/B/T (banker win)', () => {
    const f = s('banker');
    const { totalStake, totalPayout, houseEdge } = assertRoundConservation([
      f('banker', 100n),
      f('player', 50n),
      f('tie', 20n),
    ]);
    expect(totalStake).toBe(170n);
    expect(totalPayout).toBe(195n);
    expect(houseEdge).toBe(-25n);
  });

  it('keeps the edge positive on a player win where B and T lose', () => {
    const f = s('player');
    const { totalStake, totalPayout, houseEdge } = assertRoundConservation([
      f('player', 40n),
      f('banker', 100n),
      f('tie', 10n),
    ]);
    expect(totalStake).toBe(150n);
    expect(totalPayout).toBe(80n);
    expect(houseEdge).toBe(70n);
  });

  it('a tie pushes P/B (stake back) and pays the tie 8:1', () => {
    const f = s('tie');
    const { totalPayout, houseEdge } = assertRoundConservation([f('player', 30n), f('banker', 30n), f('tie', 10n)]);
    expect(totalPayout).toBe(150n);
    expect(houseEdge).toBe(-80n);
  });

  it('throws conservation_violation when net != payout - stake', () => {
    expect(() => assertRoundConservation([{ stake: 10n, payout: 20n, commission: 0n, net: 5n }])).toThrow(
      BaccaratTableError,
    );
    try {
      assertRoundConservation([{ stake: 10n, payout: 20n, commission: 0n, net: 5n }]);
    } catch (e) {
      expect((e as BaccaratTableError).code).toBe('conservation_violation');
      expect((e as BaccaratTableError).httpStatus).toBe(500);
    }
  });

  it('throws conservation_violation on a negative stake', () => {
    try {
      assertRoundConservation([{ stake: -1n, payout: 0n, commission: 0n, net: 1n }]);
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BaccaratTableError);
      expect((e as BaccaratTableError).code).toBe('conservation_violation');
    }
  });
});

// ── Round loop (ported, 11) ──────────────────────────────────────────────────

describe('BaccaratTableManager: round loop, conservation, idempotency, parity (ported)', () => {
  it('IDLE GATE: no pending bet -> no coup, shoe untouched, round_seq advances, window re-opens', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p1 = human(h, 'p1');
    await h.mgr.sitDown(t.id, p1);
    expect(tableRow(h, t.id).round_phase).toBe('betting');

    expect(await settleWindow(h, t.id)).toBe('idle_gate');
    expect(h.db.rows(baccaratCoups).length).toBe(0);
    const shoe = h.db.rows(baccaratShoes)[0]!;
    expect(shoe.coup_counter).toBe(0);
    expect(shoe.dealt_count).toBe(0);
    expect(ledgerRows(h).length).toBe(0);
    const st = await h.mgr.getTableState(t.id, p1);
    expect(st!.phase).toBe('betting');
    expect(st!.roundSeq).toBe(1);
    expect(st!.lastRound).toBeNull();
  });

  it('betting -> settle -> reveal -> betting; every seat settles vs the shared winner; conserves', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const pl = human(h, 'pl');
    const bk = human(h, 'bk');
    const ti = human(h, 'ti');
    const plan: Array<[BaccaratTableSubject, BaccaratBet, number]> = [
      [pl, 'player', 10],
      [bk, 'banker', 20],
      [ti, 'tie', 5],
    ];
    for (const [s, bet, stake] of plan) {
      await h.mgr.sitDown(t.id, s);
      await h.mgr.placeBet(t.id, s, { roundSeq: 0, bet, stake });
    }
    expect(await settleWindow(h, t.id)).toBe('settled');

    expect(h.db.rows(baccaratCoups).length).toBe(1);
    const winner = (lastCoup(h).outcome_json as SerializedCoupResult).winner;
    let sumStake = 0;
    let sumPayout = 0;
    for (const [s, bet, stake] of plan) {
      const { payout } = settleBet(bet, BigInt(stake), winner);
      expect(netOf(h, s.avatarId)).toBe(Number(payout) - stake);
      expect(tokens(h, s.avatarId)).toBe(1_000 + Number(payout) - stake);
      sumStake += stake;
      sumPayout += Number(payout);
    }
    const debits = ledgerRows(h).filter((l) => (l.amount as number) < 0);
    const credits = ledgerRows(h).filter((l) => (l.amount as number) > 0);
    expect(-debits.reduce((a, l) => a + (l.amount as number), 0)).toBe(sumStake);
    expect(credits.reduce((a, l) => a + (l.amount as number), 0)).toBe(sumPayout);
    expect(debits.every((l) => l.reason === 'cove_baccarat_table_stake')).toBe(true);
    expect(credits.every((l) => l.reason === 'cove_baccarat_table_payout')).toBe(true);

    const st = await h.mgr.getTableState(t.id, pl);
    expect(st!.phase).toBe('reveal');
    expect(st!.roundSeq).toBe(1);
    expect(st!.nextBettingOpensAt).toBe(h.clock.now() + REVEAL_MS);
    expect(st!.lastRound!.roundSeq).toBe(0);
    expect(st!.lastRound!.winner).toBe(winner);
    expect(st!.lastRound!.seatResults.length).toBe(3);
    expect(st!.me!.lastResult!.avatarId).toBe('pl');

    expect(await endReveal(h, t.id)).toBe('reveal_ended');
    expect((await h.mgr.getTableState(t.id))!.phase).toBe('betting');
    await h.mgr.placeBet(t.id, pl, { roundSeq: 1, bet: 'banker', stake: 5 });
    expect(await settleWindow(h, t.id)).toBe('settled');
    expect(lastCoup(h).coup_index).toBe(1);
    expect(bets(h).find((b) => b.round_seq === 1)!.coup_index).toBe(1);
  });

  it('IDEMPOTENCY: a re-tick, a second process and a stale settle call never pay twice', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    expect(await settleWindow(h, t.id)).toBe('settled');
    const ledgerAfter = ledgerRows(h).length;

    expect(await h.mgr.tickRound(t.id)).toBe('noop'); // reveal not over
    expect(await h.newManager().tickRound(t.id)).toBe('noop');
    // Stale settle for the already-settled round: the row lock re-check skips it.
    const stale = await (h.mgr as unknown as { settleRound: (a: string, b: number, c: number) => Promise<{ kind: string }> }).settleRound(
      t.id,
      0,
      0,
    );
    expect(stale.kind).toBe('skipped');
    expect(ledgerRows(h).length).toBe(ledgerAfter);
    expect(h.db.rows(baccaratCoups).length).toBe(1);
  });

  it('PARITY: an agent subject settles real vCLAW through the same path as a user', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const u = human(h, 'u1');
    const a = agent(h, 'a1');
    for (const s of [u, a]) {
      await h.mgr.sitDown(t.id, s);
      await h.mgr.placeBet(t.id, s, { roundSeq: 0, bet: 'banker', stake: 10 });
    }
    expect(await settleWindow(h, t.id)).toBe('settled');
    expect(ledgerOf(h, 'u1').every((l) => l.actorKind === 'human')).toBe(true);
    expect(ledgerOf(h, 'a1').every((l) => l.actorKind === 'agent')).toBe(true);
    expect(netOf(h, 'u1')).toBe(netOf(h, 'a1'));
    expect(ledgerOf(h, 'a1').length).toBeGreaterThan(0);
    const seat = h.db.rows(baccaratTableSeats).find((s) => s.avatar_id === 'a1')!;
    expect(seat.subject_type).toBe('agent');
  });

  it('NO BOARD LEAK: betting before any settle shows no cards and never the open seed', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'tie', stake: 5 });
    const st = await h.mgr.getTableState(t.id, p);
    expect(st!.lastRound).toBeNull();
    expect(st!.previousShoe).toBeNull();
    const openSeed = h.db.rows(baccaratShoes)[0]!.server_seed as string;
    expect(JSON.stringify(st)).not.toContain(openSeed);
    expect(st!.shoe!.serverSeedHash).toBe(sha256(openSeed));
    expect(st!.me!.currentBet).toEqual({ roundSeq: 0, bet: 'tie', stake: 5 });
  });

  it('rejects an unaffordable bet (402) and out-of-bounds stakes (400)', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p', 15);
    await h.mgr.sitDown(t.id, p);
    await expectCode(h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 20 }), 'insufficient_clawtokens', 402);
    for (const stake of [4, 51, 10.5]) {
      await expectCode(h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake }), 'stake_out_of_bounds', 400);
    }
    expect(bets(h).length).toBe(0);
  });

  it('rejects a bet from a subject who is not seated (409) and a stale round (409 + roundSeq)', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    const q = human(h, 'q');
    await h.mgr.sitDown(t.id, p);
    await expectCode(h.mgr.placeBet(t.id, q, { roundSeq: 0, bet: 'player', stake: 10 }), 'not_seated', 409);
    const err = await expectCode(h.mgr.placeBet(t.id, p, { roundSeq: 7, bet: 'player', stake: 10 }), 'stale_round', 409);
    expect((err.details as { roundSeq: number }).roundSeq).toBe(0);
  });

  it('TRAP 3: placeBet records a pending bet and moves no vCLAW; a replace moves none either', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'banker', stake: 30 });
    expect(ledgerRows(h).length).toBe(0);
    expect(tokens(h, 'p')).toBe(1_000);
    const pending = bets(h).filter((b) => b.status === 'pending');
    expect(pending.length).toBe(1);
    expect(pending[0]!.bet).toBe('banker');
    expect(pending[0]!.stake).toBe('30');
  });

  it('TRAP 6: a subject only acts on its own seat; me shows only its own bet', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const a = human(h, 'a');
    const b = human(h, 'b');
    await h.mgr.sitDown(t.id, a);
    await h.mgr.placeBet(t.id, a, { roundSeq: 0, bet: 'player', stake: 10 });
    await expectCode(h.mgr.leaveTable(t.id, b), 'not_seated', 409);
    await expectCode(h.mgr.cancelBet(t.id, b), 'not_seated', 409);
    const stB = await h.mgr.getTableState(t.id, b);
    expect(stB!.me!.seated).toBe(false);
    expect(stB!.me!.currentBet).toBeNull();
    expect(bets(h).filter((x) => x.status === 'pending').length).toBe(1);
  });

  it('TRAP 5: each settled seat writes a cove_game_events row owned by that seat (nonce = c*100+seat)', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const u = human(h, 'u1');
    const a = agent(h, 'a1');
    await h.mgr.sitDown(t.id, u, { seatIndex: 2 });
    await h.mgr.sitDown(t.id, a, { seatIndex: 4 });
    await h.mgr.placeBet(t.id, u, { roundSeq: 0, bet: 'player', stake: 10 });
    await h.mgr.placeBet(t.id, a, { roundSeq: 0, bet: 'tie', stake: 5 });
    expect(await settleWindow(h, t.id)).toBe('settled');
    const evRows = h.db.rows(coveGameEvents);
    expect(evRows.length).toBe(2);
    const shoeId = h.db.rows(baccaratShoes)[0]!.id;
    const byUser = new Map(evRows.map((e) => [e.user_id, e]));
    expect(byUser.get('u-u1')!.nonce).toBe(2);
    expect(byUser.get('u-a1')!.nonce).toBe(4);
    for (const e of evRows) {
      expect(e.session_id).toBe(shoeId);
      expect(e.game_type).toBe('baccarat');
      expect(e.revealed_server_seed).toBeNull();
    }
    const agentEvent = h.events.find((e) => e.avatarId === 'a1')!;
    expect(agentEvent.agentId).toBe('agent-a1');
    expect(agentEvent.payload.shared).toBe(true);
    expect(h.events.find((e) => e.avatarId === 'u1')!.agentId).toBeNull();
  });

  it('ANTI-FAUCET: a seeded seat is refused at placeBet (403 seeded_seat_cannot_bet)', async () => {
    const h = makeHarness();
    addBots(h, 3);
    const t = await h.mgr.createTable(LOW, null);
    expect(await h.mgr.seatHouseBots(t.id)).toBe(3);
    const bot: BaccaratTableSubject = { kind: 'agent', userId: 'u-bot-1', avatarId: 'bot-1', agentId: 'bac-bot-001' };
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p); // opens the window
    await expectCode(h.mgr.placeBet(t.id, bot, { roundSeq: 0, bet: 'banker', stake: 10 }), 'seeded_seat_cannot_bet', 403);
    expect(bets(h).length).toBe(0);
  });
});

// ── BLOCKING regressions (ported, 4) ───────────────────────────────────────────

describe('BaccaratTableManager: BLOCKING regressions (persisted state)', () => {
  it('BLOCKING-1: after a restart at coup 3, the next bet settles at coup 3 with nonce 3*100+seat', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p, { seatIndex: 1 });
    for (let r = 0; r < 3; r++) {
      await h.mgr.placeBet(t.id, p, { roundSeq: r, bet: 'player', stake: 5 });
      expect(await settleWindow(h, t.id)).toBe('settled');
      await endReveal(h, t.id);
    }
    const restarted = h.newManager();
    const st = await restarted.getTableState(t.id, p);
    expect(st!.roundSeq).toBe(3);
    expect(st!.shoe!.nextCoupIndex).toBe(3);
    await restarted.placeBet(t.id, p, { roundSeq: 3, bet: 'banker', stake: 5 });
    expect(await settleWindow(h, t.id, restarted)).toBe('settled');
    const settled = bets(h).find((b) => b.round_seq === 3)!;
    expect(settled.coup_index).toBe(3);
    const ev = h.db.rows(coveGameEvents);
    expect(ev[ev.length - 1]!.nonce).toBe(301);
  });

  it('BLOCKING-2: a concurrent same-seat insert hits 23505 and the replace path wins (one pending row)', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    h.db.hidePendingBetsForUpdateOnce = true; // the FOR UPDATE read misses the row once
    const res = await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'tie', stake: 25 });
    expect(h.db.hidePendingBetsForUpdateOnce).toBe(false);
    expect(res.stake).toBe(25);
    const pending = bets(h).filter((b) => b.status === 'pending');
    expect(pending.length).toBe(1);
    expect(pending[0]!.bet).toBe('tie');
    expect(pending[0]!.stake).toBe('25');
  });

  it('BLOCKING-3: funded + unfunded seat: the unfunded bet is void, moves no vCLAW, has no event', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const f = human(h, 'funded');
    const u = human(h, 'broke', 50);
    for (const s of [f, u]) {
      await h.mgr.sitDown(t.id, s);
      await h.mgr.placeBet(t.id, s, { roundSeq: 0, bet: 'player', stake: 40 });
    }
    h.db.rows(avatars).find((r) => r.id === 'broke')!.claw_tokens = 10; // spent elsewhere
    expect(await settleWindow(h, t.id)).toBe('settled');
    const broke = bets(h).find((b) => b.avatar_id === 'broke')!;
    expect(broke.status).toBe('void');
    expect(broke.void_reason).toBe('insufficient_at_settle');
    expect(ledgerOf(h, 'broke').length).toBe(0);
    expect(tokens(h, 'broke')).toBe(10);
    expect(h.db.rows(coveGameEvents).length).toBe(1);
    expect(h.events.map((e) => e.avatarId)).toEqual(['funded']);
    const shoe = h.db.rows(baccaratShoes)[0]!;
    expect(shoe.total_bet).toBe('40'); // conservation set = the funded seat only
    const st = await h.mgr.getTableState(t.id, u);
    expect(st!.me!.voidedLastRound).toEqual({ roundSeq: 0, reason: 'insufficient_at_settle' });
    expect(st!.lastRound!.seatResults.map((r) => r.avatarId)).toEqual(['funded']);
  });

  it('BLOCKING-4: getTableState resolves roundSeq and me.currentBet from the DB after a restart', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    await settleWindow(h, t.id);
    await endReveal(h, t.id);
    await h.mgr.placeBet(t.id, p, { roundSeq: 1, bet: 'banker', stake: 15 });
    const st = await h.newManager().getTableState(t.id, p);
    expect(st!.roundSeq).toBe(1);
    expect(st!.phase).toBe('betting');
    expect(st!.me!.currentBet).toEqual({ roundSeq: 1, bet: 'banker', stake: 15 });
    expect(st!.me!.seatIndex).toBe(0);
  });
});

// ── Spec 2 + 5 additions ─────────────────────────────────────────────────────

describe('BaccaratTableManager: settle safety (spec 5)', () => {
  it('CAS: two managers on one DB tick together; exactly one deals and settles', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    const other = h.newManager();
    h.clock.advance(WINDOW_MS);
    const outcomes = await Promise.all([h.mgr.tickRound(t.id), other.tickRound(t.id)]);
    expect(outcomes.filter((o) => o === 'settled').length).toBe(1);
    expect(outcomes.filter((o) => o === 'noop').length).toBe(1);
    expect(h.db.rows(baccaratCoups).length).toBe(1);
    expect(ledgerOf(h, 'p').filter((l) => (l.amount as number) < 0).length).toBe(1);
  });

  it('settle re-reads bets under lock: a bet settled by another writer is not charged again', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const a = human(h, 'a');
    const b = human(h, 'b');
    for (const s of [a, b]) {
      await h.mgr.sitDown(t.id, s);
      await h.mgr.placeBet(t.id, s, { roundSeq: 0, bet: 'banker', stake: 10 });
    }
    bets(h).find((x) => x.avatar_id === 'a')!.status = 'settled';
    expect(await settleWindow(h, t.id)).toBe('settled');
    expect(ledgerOf(h, 'a').length).toBe(0);
    expect(ledgerOf(h, 'b').length).toBeGreaterThan(0);
  });

  it('bet flip checks the row count: a bet no longer pending at flip time aborts the whole settle', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    h.ledger.onDebit = (tx) => {
      // Another writer settles the row between the locked read and the flip.
      for (const b of tx.rows(baccaratTableBets)) b.status = 'settled';
      h.ledger.onDebit = null;
    };
    expect(await settleWindow(h, t.id)).toBe('settle_failed');
    expect(ledgerRows(h).length).toBe(0);
    expect(h.db.rows(baccaratCoups).length).toBe(0);
    expect(h.db.rows(coveGameEvents).length).toBe(0);
    expect(bets(h)[0]!.status).toBe('pending'); // the whole tx rolled back
    expect(tokens(h, 'p')).toBe(1_000);
  });

  it('all seats void: no coup is dealt, the shoe is untouched, no event, round_seq advances', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p', 20);
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 20 });
    h.db.rows(avatars).find((r) => r.id === 'p')!.claw_tokens = 5;
    expect(await settleWindow(h, t.id)).toBe('all_void');
    expect(h.db.rows(baccaratCoups).length).toBe(0);
    expect(h.db.rows(baccaratShoes)[0]!.dealt_count).toBe(0);
    expect(h.db.rows(coveGameEvents).length).toBe(0);
    expect(h.events.length).toBe(0);
    expect(ledgerRows(h).length).toBe(0);
    expect(bets(h)[0]!.status).toBe('void');
    expect(tableRow(h, t.id).round_seq).toBe(1);
    expect(tableRow(h, t.id).round_phase).toBe('betting');
  });

  it('actorKind comes from the bet row; autonomousCove metadata only on autonomous bets', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const u = human(h, 'u1');
    const a = agent(h, 'a1');
    await h.mgr.sitDown(t.id, u);
    await h.mgr.placeBet(t.id, u, { roundSeq: 0, bet: 'player', stake: 10 });
    const res = await h.mgr.placeAutonomousBet(auto(a, 'banker', 10));
    expect(res).toEqual({ tableId: t.id, roundSeq: 0, seatIndex: 1, seated: true });
    expect(bets(h).find((b) => b.avatar_id === 'a1')!.origin).toBe('autonomous');
    expect(await settleWindow(h, t.id)).toBe('settled');
    for (const l of ledgerOf(h, 'a1')) {
      expect(l.actorKind).toBe('agent');
      expect((l.metadata as Record<string, unknown>).autonomousCove).toBe(true);
      expect((l.metadata as Record<string, unknown>).tableId).toBe(t.id);
    }
    for (const l of ledgerOf(h, 'u1')) {
      expect(l.actorKind).toBe('human');
      expect('autonomousCove' in (l.metadata as Record<string, unknown>)).toBe(false);
    }
    const ev = h.events.find((e) => e.avatarId === 'a1')!;
    expect(ev.actorKind).toBe('agent');
    expect(ev.payload.origin).toBe('autonomous');
    expect(h.ledger.missingTx).toBe(0);
  });

  it('per-seat outcomeJson is exactly serializeCoupResult(playCoup(seat bet)); coup row stake is 1', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const plan: Array<[string, BaccaratBet, number]> = [
      ['s0', 'player', 10],
      ['s1', 'banker', 25],
      ['s2', 'tie', 5],
    ];
    for (const [id, bet, stake] of plan) {
      const s = human(h, id);
      await h.mgr.sitDown(t.id, s);
      await h.mgr.placeBet(t.id, s, { roundSeq: 0, bet, stake });
    }
    expect(await settleWindow(h, t.id)).toBe('settled');
    const shoe = h.db.rows(baccaratShoes)[0]!;
    const coup = lastCoup(h);
    expect(coup.bet).toBe('player');
    expect(coup.stake).toBe('1');
    expect(coup.payout).toBe('0');
    expect(coup.status).toBe('settled');
    const evRows = h.db.rows(coveGameEvents);
    plan.forEach(([id, bet, stake], seat) => {
      const expected = serializeCoupResult(
        playCoup({
          serverSeed: shoe.server_seed as string,
          clientSeed: shoe.client_seed as string,
          nonce: 0,
          cursor: 0,
          bet,
          stake: BigInt(stake),
        }),
        { cursorBefore: 0, dealtBefore: 0, nonce: 0 },
      );
      const ev = evRows.find((e) => e.user_id === `u-${id}`)!;
      expect(ev.outcome_json).toEqual(expected);
      expect(Object.keys(ev.outcome_json as object).sort()).toEqual(Object.keys(expected).sort());
      expect(ev.nonce).toBe(seat);
      const bet_ = bets(h).find((b) => b.avatar_id === id)!;
      expect(bet_.payout).toBe(expected.payout);
      expect(bet_.net).toBe(expected.net);
      expect(bet_.commission).toBe(expected.commission);
    });
  });

  it('shoe roll at 312 inside the settle tx (start of settle): old seed revealed, new commit used', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const old = h.db.rows(baccaratShoes)[0]!;
    old.dealt_count = RESHUFFLE_CARD_THRESHOLD;
    h.db.rows(coveGameEvents).push({
      id: randomUUID(),
      user_id: 'u-x',
      game_type: 'baccarat',
      session_id: old.id,
      shoe_id: old.id,
      revealed_server_seed: null,
    });
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    expect(await settleWindow(h, t.id)).toBe('settled');
    const shoes = h.db.rows(baccaratShoes);
    expect(shoes.length).toBe(2);
    const oldNow = shoes.find((s) => s.id === old.id)!;
    const fresh = shoes.find((s) => s.id !== old.id)!;
    expect(oldNow.status).toBe('closed');
    expect(fresh.status).toBe('open');
    expect(fresh.coup_counter).toBe(1);
    for (const e of h.db.rows(coveGameEvents).filter((x) => x.session_id === old.id)) {
      expect(e.revealed_server_seed).toBe(old.server_seed);
    }
    const row = tableRow(h, t.id);
    expect(row.active_shoe_id).toBe(fresh.id);
    expect(row.previous_shoe_id).toBe(old.id);
    expect(bets(h)[0]!.shoe_id).toBe(fresh.id);
    const st = await h.mgr.getTableState(t.id);
    expect(st!.previousShoe!.serverSeed).toBe(old.server_seed as string);
    // The fallback roll picks the seed after the bets are in: it must be visible.
    const rollAlerts = h.alerts.filter((a) => a.severity === 'critical' && /shoe/.test(a.message));
    expect(rollAlerts.length).toBe(1);
    expect(rollAlerts[0]!.source).toBe('baccarat-table-settle');
    expect(rollAlerts[0]!.context).toMatchObject({ tableId: t.id, oldShoeId: old.id, newShoeId: fresh.id });
  });

  it('shoe roll fallback on an empty round (IDLE GATE) also sends the critical alert', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    h.db.rows(baccaratShoes)[0]!.status = 'closed';
    await h.mgr.sitDown(t.id, human(h, 'p'));
    expect(await settleWindow(h, t.id)).toBe('idle_gate');
    expect(h.alerts.filter((a) => a.severity === 'critical' && /shoe/.test(a.message)).length).toBe(1);
  });

  it('shoe roll at the coup that crosses 312: next shoe committed in the same settle tx', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p', 100_000);
    await h.mgr.sitDown(t.id, p);
    const firstShoe = h.db.rows(baccaratShoes)[0]!;
    let rolledAt = -1;
    for (let r = 0; r < 120; r++) {
      await h.mgr.placeBet(t.id, p, { roundSeq: r, bet: 'banker', stake: 5 });
      expect(await settleWindow(h, t.id)).toBe('settled');
      if ((lastCoup(h).dealt_after as number) >= RESHUFFLE_CARD_THRESHOLD) {
        rolledAt = r;
        break;
      }
      await endReveal(h, t.id);
    }
    expect(rolledAt).toBeGreaterThan(0);
    const shoes = h.db.rows(baccaratShoes);
    expect(shoes.length).toBe(2);
    const closed = shoes.find((s) => s.id === firstShoe.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.coup_counter).toBe(rolledAt + 1);
    const evs = h.db.rows(coveGameEvents);
    expect(evs.length).toBe(rolledAt + 1);
    expect(evs.every((e) => e.revealed_server_seed === firstShoe.server_seed)).toBe(true);
    const fresh = shoes.find((s) => s.id !== firstShoe.id)!;
    expect(tableRow(h, t.id).active_shoe_id).toBe(fresh.id);
    expect(fresh.coup_counter).toBe(0);
    // The next round plays on the fresh shoe committed before its window opened.
    await endReveal(h, t.id);
    const st = await h.mgr.getTableState(t.id);
    expect(st!.shoe!.id).toBe(fresh.id as string);
    expect(st!.previousShoe!.id).toBe(firstShoe.id as string);
    await h.mgr.placeBet(t.id, p, { roundSeq: rolledAt + 1, bet: 'player', stake: 5 });
    expect(await settleWindow(h, t.id)).toBe('settled');
    expect(lastCoup(h).shoe_id).toBe(fresh.id);
    expect(lastCoup(h).coup_index).toBe(0);
  });

  it('a settle failure rolls back, keeps dealing, retries after 1 s, then settles', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    h.ledger.failNext = 1;
    expect(await settleWindow(h, t.id)).toBe('settle_failed');
    const row = tableRow(h, t.id);
    expect(row.round_phase).toBe('dealing');
    expect(row.settle_attempts).toBe(1);
    expect((row.phase_ends_at as Date).getTime()).toBe(h.clock.now() + 1_000);
    expect(row.round_seq).toBe(0);
    expect(bets(h)[0]!.status).toBe('pending');
    expect(h.db.rows(baccaratCoups).length).toBe(0);
    expect(h.db.rows(coveGameEvents).length).toBe(0);
    expect(ledgerRows(h).length).toBe(0);
    expect(h.db.rows(baccaratShoes)[0]!.coup_counter).toBe(0);
    // A result is not visible until the settle commits.
    expect((await h.mgr.getTableState(t.id))!.lastRound).toBeNull();

    expect(await h.mgr.tickRound(t.id)).toBe('noop'); // backoff not over
    h.clock.advance(1_000);
    expect(await h.mgr.tickRound(t.id)).toBe('settled');
    expect(bets(h)[0]!.status).toBe('settled');
    expect(tableRow(h, t.id).settle_attempts).toBe(0);
  });

  it('the 5th settle failure voids the round (settle_failed) with a critical alert; backoff 1,2,4,8 s', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    h.ledger.failAlways = true;
    expect(await settleWindow(h, t.id)).toBe('settle_failed');
    for (const [wait, attempts] of [
      [1_000, 2],
      [2_000, 3],
      [4_000, 4],
    ] as const) {
      h.clock.advance(wait);
      expect(await h.mgr.tickRound(t.id)).toBe('settle_failed');
      expect(tableRow(h, t.id).settle_attempts).toBe(attempts);
    }
    h.clock.advance(8_000);
    expect(await h.mgr.tickRound(t.id)).toBe('round_voided');
    const b = bets(h)[0]!;
    expect(b.status).toBe('void');
    expect(b.void_reason).toBe('settle_failed');
    expect(ledgerRows(h).length).toBe(0);
    expect(h.db.rows(coveGameEvents).length).toBe(0);
    const row = tableRow(h, t.id);
    expect(row.round_seq).toBe(1);
    expect(row.round_phase).toBe('betting');
    expect(row.settle_attempts).toBe(0);
    expect(h.alerts.filter((a) => a.severity === 'critical').length).toBe(1);
  });

  it('bot guard at settle: only the pool-bot bet is void (bot_bet_refused, critical alert); real bets settle', async () => {
    const h = makeHarness();
    addBots(h, 1);
    const t = await h.mgr.createTable(LOW, null);
    await h.mgr.seatHouseBots(t.id);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    h.db.rows(baccaratTableBets).push({
      id: randomUUID(),
      table_id: t.id,
      round_seq: 0,
      seat_index: 0,
      avatar_id: 'bot-1',
      actor_kind: 'agent',
      agent_id: 'bac-bot-001',
      origin: 'rest',
      bet: 'banker',
      stake: '10',
      status: 'pending',
    });
    expect(await settleWindow(h, t.id)).toBe('settled');
    const botBet = bets(h).find((b) => b.avatar_id === 'bot-1')!;
    expect(botBet.status).toBe('void');
    expect(botBet.void_reason).toBe('bot_bet_refused');
    expect(bets(h).find((b) => b.avatar_id === 'p')!.status).toBe('settled');
    expect(ledgerOf(h, 'bot-1').length).toBe(0);
    expect(ledgerOf(h, 'p').length).toBeGreaterThan(0);
    expect(h.db.rows(coveGameEvents).every((e) => e.user_id !== 'u-bot-1')).toBe(true);
    expect(h.alerts.filter((a) => a.severity === 'critical' && /bot/.test(a.message)).length).toBe(1);
    expect(tableRow(h, t.id).round_phase).toBe('reveal');

    // A round with ONLY a bot bet: that bet is void, no coup is dealt, the round advances.
    const coupsBefore = h.db.rows(baccaratCoups).length;
    await endReveal(h, t.id);
    h.db.rows(baccaratTableBets).push({
      id: randomUUID(),
      table_id: t.id,
      round_seq: 1,
      seat_index: 0,
      avatar_id: 'bot-1',
      actor_kind: 'agent',
      agent_id: 'bac-bot-001',
      origin: 'rest',
      bet: 'tie',
      stake: '5',
      status: 'pending',
    });
    expect(await settleWindow(h, t.id)).toBe('all_void');
    expect(h.db.rows(baccaratCoups).length).toBe(coupsBefore);
    expect(bets(h).filter((b) => b.void_reason === 'bot_bet_refused').length).toBe(2);
    expect(ledgerOf(h, 'bot-1').length).toBe(0);
  });
});

describe('BaccaratTableManager: seats, bots, leave and cancel (spec 2)', () => {
  it('leave inside the window cancels the bet; after the close the bet is kept (lockedBet) and settles', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const a = human(h, 'a');
    const b = human(h, 'b');
    await h.mgr.sitDown(t.id, a);
    await h.mgr.sitDown(t.id, b);
    await h.mgr.placeBet(t.id, a, { roundSeq: 0, bet: 'player', stake: 10 });
    await h.mgr.placeBet(t.id, b, { roundSeq: 0, bet: 'banker', stake: 10 });
    const early = await h.mgr.leaveTable(t.id, a);
    expect(early.lockedBet).toBeNull();
    expect(bets(h).find((x) => x.avatar_id === 'a')!.status).toBe('cancelled');

    h.clock.advance(WINDOW_MS); // window closed, not yet ticked
    const late = await h.mgr.leaveTable(t.id, b);
    expect(late.lockedBet).toEqual({ roundSeq: 0, bet: 'banker', stake: 10 });
    expect(await h.mgr.tickRound(t.id)).toBe('settled');
    expect(bets(h).find((x) => x.avatar_id === 'b')!.status).toBe('settled');
    expect(ledgerOf(h, 'a').length).toBe(0);
    expect(ledgerOf(h, 'b').length).toBeGreaterThan(0);
  });

  it('cancelBet cancels inside the window and refuses after the close (409 betting_closed)', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    expect(await h.mgr.cancelBet(t.id, p)).toEqual({ cancelled: true });
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    h.clock.advance(WINDOW_MS);
    await expectCode(h.mgr.cancelBet(t.id, p), 'betting_closed', 409);
    await expectCode(h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'tie', stake: 5 }), 'betting_closed', 409);
  });

  it('bots yield: a full table frees the lowest bot seat for a real player; all-real -> table_full', async () => {
    const h = makeHarness();
    addBots(h, 3);
    const t = await h.mgr.createTable(LOW, null);
    expect(await h.mgr.seatHouseBots(t.id)).toBe(3);
    expect(await h.mgr.seatHouseBots(t.id)).toBe(0); // idempotent
    const humans = ['h1', 'h2', 'h3'].map((id) => human(h, id));
    for (const s of humans) await h.mgr.sitDown(t.id, s);
    const h4 = human(h, 'h4');
    const r = await h.mgr.sitDown(t.id, h4);
    expect(r.seatIndex).toBe(0);
    expect(h.bots.released).toEqual([`${t.id}:0`]);
    const seated = h.db.rows(baccaratTableSeats).filter((s) => s.status === 'seated');
    expect(seated.length).toBe(6);
    expect(seated.filter((s) => s.is_seeded === true).length).toBe(2);
    await h.mgr.sitDown(t.id, human(h, 'h5'));
    await h.mgr.sitDown(t.id, human(h, 'h6'));
    await expectCode(h.mgr.sitDown(t.id, human(h, 'h7')), 'table_full', 409);
    // A preferred seat held by a real player is refused.
    await expectCode(h.mgr.sitDown(t.id, human(h, 'h8'), { seatIndex: 3 }), 'seat_taken', 409);
  });

  it('one seat per avatar: same table -> alreadySeated; another table -> 409 already_seated_elsewhere + tableId', async () => {
    const h = makeHarness();
    const a = await h.mgr.createTable(LOW, null);
    const b = await h.mgr.createTable(MID, null);
    const p = human(h, 'p');
    const first = await h.mgr.sitDown(a.id, p);
    expect(first.alreadySeated).toBe(false);
    expect((await h.mgr.sitDown(a.id, p)).alreadySeated).toBe(true);
    const err = await expectCode(h.mgr.sitDown(b.id, p), 'already_seated_elsewhere', 409);
    expect((err.details as { tableId: string }).tableId).toBe(a.id);
    const q = human(h, 'q');
    await expectCode(h.mgr.sitDown(a.id, q, { seatIndex: 0 }), 'seat_taken', 409);
    await expectCode(h.mgr.sitDown(a.id, q, { seatIndex: 9 }), 'invalid_sit_body', 400);
  });

  it('idle-seat sweep frees a real seat after 10 min with no pending bet; orphan guard voids old pending bets', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const idle = human(h, 'idle');
    const busy = human(h, 'busy');
    await h.mgr.sitDown(t.id, idle);
    await h.mgr.sitDown(t.id, busy);
    h.clock.advance(10 * 60_000 + 1);
    // An orphaned pending bet (round below round_seq) is voided first; then both seats are idle.
    h.db.rows(baccaratTableBets).push({
      id: 'orphan',
      table_id: t.id,
      round_seq: -1,
      seat_index: 5,
      avatar_id: 'busy',
      actor_kind: 'human',
      origin: 'rest',
      bet: 'player',
      stake: '5',
      status: 'pending',
    });
    const res = await h.mgr.maintainTable(t.id);
    expect(res.orphaned).toBe(1);
    expect(bets(h).find((b) => b.id === 'orphan')!.void_reason).toBe('orphaned');
    expect(h.alerts.some((a) => a.severity === 'warning')).toBe(true);
    expect(res.freedSeats).toBe(2);
    expect(tableRow(h, t.id).round_phase).toBe('idle');
    expect(ledgerRows(h).length).toBe(0);
  });
});

describe('BaccaratTableManager: placeAutonomousBet (spec 6.3)', () => {
  it('targets this round with >= 1 s left, the next round with < 1 s left, and plays both', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const a = agent(h, 'a1');
    const r1 = await h.mgr.placeAutonomousBet(auto(a, 'player', 10));
    expect(r1.roundSeq).toBe(0);
    expect(r1.seated).toBe(true);
    h.clock.advance(WINDOW_MS - 500);
    const r2 = await h.mgr.placeAutonomousBet(auto(a, 'banker', 20));
    expect(r2).toEqual({ tableId: t.id, roundSeq: 1, seatIndex: 0, seated: false });
    h.clock.advance(500);
    expect(await h.mgr.tickRound(t.id)).toBe('settled');
    expect(bets(h).find((b) => b.round_seq === 1)!.status).toBe('pending');
    // In reveal, the bet targets the already-advanced round_seq.
    const b = agent(h, 'b1');
    expect((await h.mgr.placeAutonomousBet(auto(b, 'tie', 5))).roundSeq).toBe(1);
    await endReveal(h, t.id);
    expect(await settleWindow(h, t.id)).toBe('settled');
    expect(bets(h).filter((x) => x.round_seq === 1).every((x) => x.status === 'settled')).toBe(true);
  });

  it('daily cap counts pending autonomous stakes: 9980 used + 10 pending refuses 20, admits 10', async () => {
    const h = makeHarness();
    await h.mgr.createTable(LOW, null);
    const a = agent(h, 'a1', 1_000);
    h.db.autoUsageBase.set('a1', 9_980);
    await h.mgr.placeAutonomousBet(auto(a, 'player', 10)); // round 0
    h.clock.advance(WINDOW_MS - 500);
    await expectCode(h.mgr.placeAutonomousBet(auto(a, 'player', 20)), 'agent_cove_daily_wager_cap_exceeded', 409);
    const ok = await h.mgr.placeAutonomousBet(auto(a, 'player', 10));
    expect(ok.roundSeq).toBe(1);
    expect(h.db.advisoryKeys.every((k) => k === 'agent-cove-play-daily:a1')).toBe(true);
    expect(bets(h).filter((b) => b.status === 'pending').length).toBe(2);
  });

  it('settle-time cap re-check voids an autonomous bet over the cap (daily_cap)', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const a = agent(h, 'a1');
    await h.mgr.placeAutonomousBet(auto(a, 'player', 10));
    h.db.autoUsageBase.set('a1', 9_995); // spent elsewhere after the bet
    expect(await settleWindow(h, t.id)).toBe('all_void');
    expect(bets(h)[0]!.void_reason).toBe('daily_cap');
    expect(ledgerRows(h).length).toBe(0);
  });

  it('picks the lowest tier that admits the wager; refuses a changed binding, a house agent, and a misfit seat', async () => {
    const h = makeHarness();
    const low = await h.mgr.createTable(LOW, null);
    const mid = await h.mgr.createTable(MID, null);
    await h.mgr.createTable(HIGH, null);
    const a = agent(h, 'a1');
    expect((await h.mgr.placeAutonomousBet(auto(a, 'banker', 100))).tableId).toBe(mid.id);
    const b = agent(h, 'b1');
    expect((await h.mgr.placeAutonomousBet(auto(b, 'banker', 10))).tableId).toBe(low.id);
    // a1 sits at mid (20..200); a 10 wager does not fit there.
    const err = await expectCode(h.mgr.placeAutonomousBet(auto(a, 'banker', 10)), 'already_seated_elsewhere', 409);
    expect((err.details as { tableId: string }).tableId).toBe(mid.id);

    const c = agent(h, 'c1');
    await expectCode(
      h.mgr.placeAutonomousBet({ ...auto(c, 'player', 10), expectedAvatarId: 'other' }),
      'live_agent_avatar_binding_changed',
      403,
    );
    h.houseAgents.add('agent-c1');
    await expectCode(h.mgr.placeAutonomousBet(auto(c, 'player', 10)), 'house_agent_cannot_bet', 403);
    await expectCode(
      h.mgr.placeAutonomousBet({ ...auto(c, 'player', 10), agentSessionId: 'nope' }),
      'invalid_or_expired_agent_session',
      401,
    );
    expect(h.db.rows(baccaratTableSeats).some((s) => s.avatar_id === 'c1')).toBe(false);
  });
});

describe('BaccaratTableManager: shoe replay parity', () => {
  it('the manager replay equals the solo route reconstructShoeState for the same shoe', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    for (let r = 0; r < 4; r++) {
      await h.mgr.placeBet(t.id, p, { roundSeq: r, bet: 'tie', stake: 5 });
      expect(await settleWindow(h, t.id)).toBe('settled');
      await endReveal(h, t.id);
    }
    const shoe = h.db.rows(baccaratShoes)[0]!;
    const seeds = { serverSeed: shoe.server_seed as string, clientSeed: shoe.client_seed as string };
    const mine = await h.mgr.__reconstructShoeStateForTest(seeds, shoe.id as string, 4);
    const { reconstructShoeState } = await import('../../routes/cove-baccarat');
    const theirs = await reconstructShoeState(seeds, shoe.id as string, 4, h.db as never);
    expect(mine).toEqual(theirs);
    expect(mine.cursor).toBe(shoe.cursor_counter as number);
    expect(mine.dealt).toBe(shoe.dealt_count as number);
    // And both equal a direct replay with the engine.
    let state = { remaining: undefined as ReturnType<typeof playCoupWithState>['remainingAfter'] | undefined, cursor: 0, dealt: 0 };
    for (let c = 0; c < 4; c++) {
      const s = playCoupWithState({
        ...seeds,
        nonce: c,
        cursor: state.cursor,
        bet: 'player',
        stake: 1n,
        dealtBefore: state.dealt,
        remainingShoe: state.remaining,
      });
      state = { remaining: s.remainingAfter, cursor: s.cursorAfter, dealt: s.dealtAfter };
    }
    expect(mine.cursor).toBe(state.cursor);
    expect(mine.remaining).toEqual(state.remaining!);
  });
});

describe('BaccaratTableManager: fix pass FX-A (review findings)', () => {
  const pending = (h: Harness) => bets(h).filter((b) => b.status === 'pending');

  it('F1: the window decision uses time read AFTER the table lock (place, cancel, leave)', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    // 1 ms of window left when the request arrives; the window closes while it waits for the lock.
    h.clock.advance(WINDOW_MS - 1);
    h.db.onTableLockOnce = () => h.clock.advance(2);
    await expectCode(h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'tie', stake: 5 }), 'betting_closed', 409);
    expect(pending(h).map((b) => [b.bet, b.stake])).toEqual([['player', '10']]);

    h.clock.t -= 2;
    h.db.onTableLockOnce = () => h.clock.advance(2);
    await expectCode(h.mgr.cancelBet(t.id, p), 'betting_closed', 409);
    expect(pending(h).length).toBe(1);

    h.clock.t -= 2;
    h.db.onTableLockOnce = () => h.clock.advance(2);
    const left = await h.mgr.leaveTable(t.id, p);
    expect(left.lockedBet).toEqual({ roundSeq: 0, bet: 'player', stake: 10 });
    expect(pending(h).length).toBe(1);
    expect(await h.mgr.tickRound(t.id)).toBe('settled');
  });

  it('F1: the DB clock decides the deadline, so a lagging app clock can not place, cancel or keep a late bet', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'banker', stake: 20 });
    h.clock.advance(WINDOW_MS - 5_000); // the app clock says 5 s left
    h.db.dbSkewMs = 6_000; // the DB clock says the window closed 1 s ago
    await expectCode(h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'tie', stake: 5 }), 'betting_closed', 409);
    await expectCode(h.mgr.cancelBet(t.id, p), 'betting_closed', 409);
    const left = await h.mgr.leaveTable(t.id, p);
    expect(left.lockedBet).toEqual({ roundSeq: 0, bet: 'banker', stake: 20 });
    expect(pending(h).map((b) => [b.bet, b.stake])).toEqual([['banker', '20']]);

    // An autonomous bet with an open app window but a closed DB window plays the NEXT round.
    const a = agent(h, 'a1');
    await h.mgr.sitDown(t.id, a);
    expect((await h.mgr.placeAutonomousBet(auto(a, 'player', 10))).roundSeq).toBe(1);
  });

  it('F2: daily-cap advisory locks use hashtextextended(key, 0) and come BEFORE the avatar row locks', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const a = agent(h, 'a1');
    await h.mgr.placeAutonomousBet(auto(a, 'player', 10));
    h.db.lockTrace.length = 0;
    await h.mgr.placeAutonomousBet(auto(a, 'banker', 10)); // replaces its own autonomous bet
    const key = 'advisory:agent-cove-play-daily:a1';
    let trace = h.db.lockTrace;
    expect(trace.indexOf(key)).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf('avatars:share')).toBeGreaterThan(trace.indexOf(key));

    h.db.lockTrace.length = 0;
    expect(await settleWindow(h, t.id)).toBe('settled');
    trace = h.db.lockTrace;
    expect(trace.indexOf(key)).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf('avatars:update')).toBeGreaterThan(trace.indexOf(key));

    expect(h.db.advisorySql.length).toBeGreaterThanOrEqual(3);
    for (const text of h.db.advisorySql) {
      expect(text).toMatch(/pg_advisory_xact_lock\(hashtextextended\(, 0\)\)/);
      expect(text).not.toMatch(/\bhashtext\(/);
    }
  });

  it('F3: an autonomous bet never overwrites the owner REST bet on the same seat (409 bet_conflict)', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    addAvatar(h, 'o', 1_000);
    const owner: BaccaratTableSubject = { kind: 'user', userId: 'u-o', avatarId: 'o', agentId: null };
    h.sessions.set('sess-o', { userId: 'u-o', avatarId: 'o', agentId: 'agent-o', ledgerCapable: true });
    await h.mgr.sitDown(t.id, owner);
    await h.mgr.placeBet(t.id, owner, { roundSeq: 0, bet: 'banker', stake: 50 });
    await expectCode(
      h.mgr.placeAutonomousBet({
        agentSessionId: 'sess-o',
        expectedAgentId: 'agent-o',
        expectedAvatarId: 'o',
        expectedUserId: 'u-o',
        bet: 'tie',
        wager: 5,
      }),
      'bet_conflict',
      409,
    );
    expect(pending(h).map((b) => [b.bet, b.stake, b.origin, b.actor_kind])).toEqual([['banker', '50', 'rest', 'human']]);
    // The owner keeps the seat (the agent did not sit, so it frees nothing).
    expect(h.db.rows(baccaratTableSeats).filter((s) => s.avatar_id === 'o' && s.status === 'seated').length).toBe(1);
  });

  it('F4: a failed autonomous bet after a NEW sit frees the seat and the table goes idle again', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const poor = agent(h, 'poor', 1);
    await expectCode(h.mgr.placeAutonomousBet(auto(poor, 'player', 10)), 'insufficient_clawtokens', 402);
    expect(h.db.rows(baccaratTableSeats).filter((s) => s.avatar_id === 'poor' && s.status === 'seated').length).toBe(0);
    expect(tableRow(h, t.id).round_phase).toBe('idle');
    expect(bets(h).length).toBe(0);
  });

  it('F5: an agent seated at another tier with NO pending bet there leaves it and sits at the fitting table', async () => {
    const h = makeHarness();
    const low = await h.mgr.createTable(LOW, null);
    const mid = await h.mgr.createTable(MID, null);
    const a = agent(h, 'a1');
    await h.mgr.sitDown(mid.id, a);
    const res = await h.mgr.placeAutonomousBet(auto(a, 'banker', 10));
    expect(res.tableId).toBe(low.id);
    expect(res.seated).toBe(true);
    const seats = h.db.rows(baccaratTableSeats).filter((s) => s.avatar_id === 'a1');
    expect(seats.find((s) => s.table_id === mid.id)!.status).toBe('left');
    expect(seats.find((s) => s.table_id === low.id)!.status).toBe('seated');
    expect(tableRow(h, mid.id).round_phase).toBe('idle');
    expect(pending(h).map((b) => [b.table_id, b.bet, b.origin])).toEqual([[low.id, 'banker', 'autonomous']]);
  });

  it('F5: with a pending bet at the other table (the owner REST bet) the refusal stays and nothing is cancelled', async () => {
    const h = makeHarness();
    await h.mgr.createTable(LOW, null);
    const mid = await h.mgr.createTable(MID, null);
    addAvatar(h, 'o', 1_000);
    const owner: BaccaratTableSubject = { kind: 'user', userId: 'u-o', avatarId: 'o', agentId: null };
    h.sessions.set('sess-o', { userId: 'u-o', avatarId: 'o', agentId: 'agent-o', ledgerCapable: true });
    await h.mgr.sitDown(mid.id, owner);
    await h.mgr.placeBet(mid.id, owner, { roundSeq: 0, bet: 'player', stake: 100 });
    const err = await expectCode(
      h.mgr.placeAutonomousBet({
        agentSessionId: 'sess-o',
        expectedAgentId: 'agent-o',
        expectedAvatarId: 'o',
        expectedUserId: 'u-o',
        bet: 'tie',
        wager: 10,
      }),
      'already_seated_elsewhere',
      409,
    );
    expect((err.details as { tableId: string }).tableId).toBe(mid.id);
    expect(pending(h).map((b) => [b.table_id, b.stake])).toEqual([[mid.id, '100']]);
    expect(h.db.rows(baccaratTableSeats).find((s) => s.avatar_id === 'o')!.status).toBe('seated');
  });

  it('F8: the settle event carries historyEventId = the cove_game_events row id (for /verify)', async () => {
    const h = makeHarness();
    const t = await h.mgr.createTable(LOW, null);
    const p = human(h, 'p');
    const a = agent(h, 'a1');
    await h.mgr.sitDown(t.id, p);
    await h.mgr.sitDown(t.id, a);
    await h.mgr.placeBet(t.id, p, { roundSeq: 0, bet: 'player', stake: 10 });
    await h.mgr.placeBet(t.id, a, { roundSeq: 0, bet: 'banker', stake: 10 });
    expect(await settleWindow(h, t.id)).toBe('settled');
    expect(h.events.length).toBe(2);
    const rows = h.db.rows(coveGameEvents);
    for (const ev of h.events) {
      const row = rows.find((r) => r.nonce === ev.payload.coupIndex * 100 + ev.payload.seatIndex)!;
      expect(typeof ev.payload.historyEventId).toBe('string');
      expect(ev.payload.historyEventId).toBe(row.id as string);
      expect(row.user_id).toBe(ev.ownerUserId);
    }
    expect(new Set(h.events.map((e) => e.payload.historyEventId)).size).toBe(2);
  });

  it('F9: invalid_leave_body and invalid_lobby_query map to 400; bet_conflict to 409', () => {
    expect(new BaccaratTableError('invalid_leave_body').httpStatus).toBe(400);
    expect(new BaccaratTableError('invalid_lobby_query').httpStatus).toBe(400);
    expect(new BaccaratTableError('bet_conflict').httpStatus).toBe(409);
  });
});
