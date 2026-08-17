/**
 * Poker CASH GAMES — house AUTO-SCALER unit test.
 *
 * Drives the REAL `cashHouseScalerPass()` with a STUBBED manager + seeder + db so
 * NO live DB / singleton is touched. Asserts the scaler's contract:
 *
 *   - Creates EXACTLY the per-tier deficit `(N_tier - openCount)` and no more.
 *   - NEVER exceeds the per-tier target `N` (the always-on invariant): a second
 *     pass over an already-satisfied state creates ZERO new tables (idempotent).
 *   - Every created table is `source='house'` + `visibility='public'` + the
 *     HOUSE-BANK avatar as the `created_by` creator subject, carries the locked
 *     per-tier stakes, and `seededAgentSlots > 0` so the fill path can run.
 *   - A tier with target 0 (env-zeroed) is skipped — creates nothing for it.
 *   - One tier's failure never stops the others (per-tier try/catch).
 *
 * The COUNT query the scaler issues for "open house tables of tier X" reads from
 * the SAME in-memory table store the stubbed `createTable` writes into, so the
 * deficit math, the never-exceed-N cap, and idempotency across passes are all
 * exercised end-to-end against a faithful state model.
 *
 * NOTE: this file mocks the singleton/db modules BEFORE importing the scaler, so
 * the scaler's module-level `import { cashTableManager }` / `db as realDb` /
 * `cashHouseSeeder` bind to the stubs. The env knobs (`CASH_HOUSE_TABLES_*`,
 * `CASH_HOUSE_SCALER_ENABLED`) are read fresh each pass, so we set them per-test.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { randomUUID } from 'crypto';

// Capture the REAL @clawville/database module BEFORE registering the mock, so the
// mock can spread every real export (events, schemas, etc.) and override ONLY `db`.
// Without this spread, `mock.module` would replace the module with an incomplete
// stub and, because bun runs all test files in ONE process with a shared module
// registry (this file sorts alphabetically BEFORE the real-importing poker test
// files), every later `import { events, ... }` would fail "Export not found".
import * as realDatabase from '@clawville/database';

// ── In-memory state shared by the stubbed manager + the stubbed db COUNT ──────
interface FakeTableRow {
  id: string;
  source: string;
  visibility: string;
  tierKey: string | null;
  buyInCt: number;
  smallBlindCt: number;
  bigBlindCt: number;
  maxSeats: number;
  seededAgentSlots: number;
  status: string;
  createdBy: string;
  tableEscrowCt: number;
}

interface FakeSeatRow {
  id: string;
  tableId: string;
  isSeeded: 'true' | 'false';
  status: 'sitting_in' | 'sitting_out' | 'left';
  currentStackCt: number;
  updatedAt: Date;
}

const APPROVED_STAKES = {
  low: { buyInCt: 200, smallBlindCt: 10, bigBlindCt: 20 },
  mid: { buyInCt: 1000, smallBlindCt: 50, bigBlindCt: 100 },
  high: { buyInCt: 5000, smallBlindCt: 250, bigBlindCt: 500 },
} as const;

const state = {
  tables: [] as FakeTableRow[],
  createCalls: [] as Array<{ config: Record<string, unknown>; creator: Record<string, unknown> }>,
  /** tableIds passed to the eager-seat path (Option B) — one per created table. */
  seatHouseBotsCalls: [] as string[],
  retireHouseTableCalls: [] as string[],
  releaseBustedSeatCalls: [] as Array<{ tableId: string; seatId: string }>,
  seats: [] as FakeSeatRow[],
  liveTableIds: new Set<string>(),
  houseBankBalance: 1_000_000,
  /** When set, createTable throws for this tierKey (per-tier failure isolation). */
  failTier: null as string | null,
  houseBankId: 'house-bank-scaler-1',
  /** When true, houseBankAvatarId() throws (seeder not ensured yet). */
  bankNotReady: false,
};

function resetState(): void {
  state.tables = [];
  state.createCalls = [];
  state.seatHouseBotsCalls = [];
  state.retireHouseTableCalls = [];
  state.releaseBustedSeatCalls = [];
  state.seats = [];
  state.liveTableIds = new Set<string>();
  state.houseBankBalance = 1_000_000;
  state.failTier = null;
  state.houseBankId = 'house-bank-scaler-1';
  state.bankNotReady = false;
}

// ── Mock the manager singleton: createTable writes into the in-memory store ────
mock.module('../cash-table-manager-singleton', () => ({
  cashTableManager: {
    async createTable(config: Record<string, unknown>, creator: Record<string, unknown>) {
      if (state.failTier && config.tierKey === state.failTier) {
        throw new Error(`forced failure for tier ${String(config.tierKey)}`);
      }
      state.createCalls.push({ config, creator });
      const row: FakeTableRow = {
        id: randomUUID(),
        source: config.source as string,
        visibility: config.visibility as string,
        tierKey: (config.tierKey as string | null) ?? null,
        buyInCt: config.buyInCt as number,
        smallBlindCt: config.smallBlindCt as number,
        bigBlindCt: config.bigBlindCt as number,
        maxSeats: config.maxSeats as number,
        seededAgentSlots: config.seededAgentSlots as number,
        status: 'open',
        createdBy: creator.avatarId as string,
        tableEscrowCt: 0,
      };
      state.tables.push(row);
      return row;
    },
    // OPTION B (2026-06-22): the scaler eager-seats bots right after createTable so
    // the lobby shows ~seededAgentSlots seated bots WITHOUT dealing. The scaler-
    // contract test doesn't model seats/ledger — it only asserts the deficit/create
    // math — so this is a no-op stub. Its presence is REQUIRED: the scaler now calls
    // it, and an undefined method would throw into the per-tier try/catch and
    // silently zero out `created`. Record the call so a test could assert it fires.
    async seatHouseBots(tableId: string) {
      state.seatHouseBotsCalls.push(tableId);
    },
    async retireHouseTable(tableId: string) {
      state.retireHouseTableCalls.push(tableId);
      const table = state.tables.find((candidate) => candidate.id === tableId);
      if (!table || table.source !== 'house' || table.status !== 'open') return false;
      if (state.liveTableIds.has(tableId)) return false;

      const activeSeats = state.seats.filter(
        (seat) => seat.tableId === tableId && seat.status !== 'left',
      );
      if (
        activeSeats.some(
          (seat) => seat.isSeeded === 'false' && seat.currentStackCt !== 0,
        )
      ) {
        return false;
      }

      for (const seat of activeSeats) {
        if (seat.isSeeded === 'true') {
          state.houseBankBalance += seat.currentStackCt;
          table.tableEscrowCt -= seat.currentStackCt;
        }
        seat.currentStackCt = 0;
        seat.status = 'left';
      }
      if (table.tableEscrowCt > 0) return false;
      table.status = 'closed';
      return true;
    },
    async releaseBustedSeat(tableId: string, seatId: string) {
      state.releaseBustedSeatCalls.push({ tableId, seatId });
      if (state.liveTableIds.has(tableId)) return false;
      const seat = state.seats.find(
        (candidate) => candidate.id === seatId && candidate.tableId === tableId,
      );
      if (
        !seat ||
        seat.status === 'left' ||
        seat.isSeeded !== 'false' ||
        seat.currentStackCt !== 0
      ) {
        return false;
      }
      seat.status = 'left';
      return true;
    },
  },
}));

// ── Mock the seeder: houseBankAvatarId() returns the stub id (or throws) ───────
// IMPORTANT: bun's `mock.module` is GLOBAL + persistent across the whole test
// process (this file sorts before cash-table-manager.test.ts). The CashTableManager
// imports `cashHouseSeeder` at module level and calls `release()` inside cashOutSeat,
// so the stub MUST expose EVERY member the manager touches as a safe no-op — else a
// co-running manager test would hit `cashHouseSeeder.release is not a function`.
mock.module('../cash-house-seeder', () => ({
  cashHouseSeeder: {
    houseBankAvatarId() {
      if (state.bankNotReady) throw new Error('seeder.ensure() pending');
      return state.houseBankId;
    },
    // No-op seams the manager calls but the scaler test doesn't exercise. Kept so
    // a co-running manager test (which uses the REAL injected db/ledger/sim but the
    // MODULE-level seeder for bot-pool release) never crashes on a missing method.
    claim: () => null,
    release: () => {},
    releaseTable: () => {},
    isBotAvatar: () => false,
    botAvatarIds: () => [] as string[],
    reservedCount: () => 0,
    async ensure() {},
    __resetForTest() {},
  },
  CashBotPoolExhaustedError: class extends Error {},
}));

// ── Mock @clawville/database: execute() interprets ONLY the scaler's COUNT ─────
// The scaler issues `SELECT COUNT(*)::int AS n FROM poker_cash_tables WHERE
// source='house' AND visibility='public' AND status='open' AND tier_key = ${tier}`.
// Drizzle's `sql` template puts the tierKey as a bound Param chunk; we recover it
// and count matching in-memory rows.
function tierKeyFromCountQuery(q: unknown): string | null {
  const chunks = (q as { queryChunks?: unknown[] }).queryChunks ?? [];
  for (const ch of chunks) {
    const cn = (ch as { constructor?: { name?: string } })?.constructor?.name;
    // A drizzle `${tierKey}` interpolation lands as a Param chunk (`.value`) OR,
    // for a bare string interpolation, a boxed `String` object whose primitive is
    // the value. StringChunk is the static SQL text (skip it).
    if (cn === 'Param') return String((ch as { value: unknown }).value);
    if (cn === 'String') return String(ch);
  }
  return null;
}

function queryText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .filter(
      (chunk) =>
        (chunk as { constructor?: { name?: string } }).constructor?.name === 'StringChunk',
    )
    .flatMap((chunk) => (chunk as { value?: string[] }).value ?? [])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isMismatchedHouseTable(table: FakeTableRow): boolean {
  if (table.source !== 'house' || table.status !== 'open') return false;
  const tier = table.tierKey as keyof typeof APPROVED_STAKES | null;
  if (!tier || !(tier in APPROVED_STAKES)) return true;
  const expected = APPROVED_STAKES[tier];
  return (
    table.buyInCt !== expected.buyInCt ||
    table.smallBlindCt !== expected.smallBlindCt ||
    table.bigBlindCt !== expected.bigBlindCt
  );
}

mock.module('@clawville/database', () => ({
  // Spread EVERY real export (events, all schemas, types) so co-running test files
  // that import named members from @clawville/database still resolve them — only
  // `db` is overridden with a fake whose `execute` interprets the scaler's COUNT.
  ...realDatabase,
  db: {
    async execute(q: unknown) {
      if (queryText(q).includes('from poker_cash_seats')) {
        const cutoff = Date.now() - 10 * 60 * 1_000;
        return state.seats
          .filter(
            (seat) =>
              seat.status !== 'left' &&
              seat.isSeeded === 'false' &&
              seat.currentStackCt === 0 &&
              seat.updatedAt.getTime() < cutoff,
          )
          .map((seat) => ({ seat_id: seat.id, table_id: seat.tableId }));
      }
      if (queryText(q).includes('select id from poker_cash_tables')) {
        return state.tables.filter(isMismatchedHouseTable).map(({ id }) => ({ id }));
      }
      const tierKey = tierKeyFromCountQuery(q);
      const n = state.tables.filter(
        (t) =>
          t.source === 'house' &&
          t.visibility === 'public' &&
          t.status === 'open' &&
          t.tierKey === tierKey,
      ).length;
      return [{ n }];
    },
  },
}));

// Import the scaler + config AFTER the mocks are registered.
const { cashHouseScalerPass } = await import('../cash-house-scaler');
const { HOUSE_TIERS } = await import('../cash-house-config');

// ── Env helpers ───────────────────────────────────────────────────────────────
const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'CASH_HOUSE_SCALER_ENABLED',
  'CASH_HOUSE_TABLES_LOW',
  'CASH_HOUSE_TABLES_MID',
  'CASH_HOUSE_TABLES_HIGH',
  'CASH_HOUSE_SEEDED_SLOTS_PER_TABLE',
];

beforeEach(() => {
  resetState();
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

describe('cashHouseScaler — deficit creation, never-exceed-N, idempotency', () => {
  it('creates EXACTLY the locked per-tier deficit on a cold start (2 low + 2 mid + 1 high = 5)', async () => {
    const created = await cashHouseScalerPass();

    const expectedTotal =
      HOUSE_TIERS.low.openTables + HOUSE_TIERS.mid.openTables + HOUSE_TIERS.high.openTables;
    expect(created).toBe(expectedTotal); // 2 + 2 + 1 = 5
    expect(state.tables.length).toBe(expectedTotal);

    // Per-tier counts match the locked targets exactly.
    const byTier = (k: string) => state.tables.filter((t) => t.tierKey === k).length;
    expect(byTier('low')).toBe(HOUSE_TIERS.low.openTables);
    expect(byTier('mid')).toBe(HOUSE_TIERS.mid.openTables);
    expect(byTier('high')).toBe(HOUSE_TIERS.high.openTables);

    // OPTION B: the scaler EAGER-SEATS bots once per created table (the populated-
    // lobby look) — one seatHouseBots call per created table id.
    expect(state.seatHouseBotsCalls.length).toBe(expectedTotal);
    expect(new Set(state.seatHouseBotsCalls).size).toBe(expectedTotal); // distinct ids
    for (const id of state.seatHouseBotsCalls) {
      expect(state.tables.some((t) => t.id === id)).toBe(true);
    }
  });

  it('every created table is source=house + visibility=public + house-bank creator + bot slots + locked stakes', async () => {
    await cashHouseScalerPass();

    expect(state.createCalls.length).toBeGreaterThan(0);
    for (const call of state.createCalls) {
      expect(call.config.source).toBe('house');
      expect(call.config.visibility).toBe('public');
      // Bot fill must be possible.
      expect(Number(call.config.seededAgentSlots)).toBeGreaterThan(0);
      // Creator = the house-bank avatar (created_by audit), kind agent.
      expect(call.creator.avatarId).toBe(state.houseBankId);
      expect(call.creator.kind).toBe('agent');

      // Stakes match the locked tier config for that tierKey.
      const tier = HOUSE_TIERS[call.config.tierKey as 'low' | 'mid' | 'high'];
      expect(tier).toBeTruthy();
      expect(call.config.buyInCt).toBe(tier.buyInCt);
      expect(call.config.smallBlindCt).toBe(tier.smallBlindCt);
      expect(call.config.bigBlindCt).toBe(tier.bigBlindCt);
      expect(call.config.maxSeats).toBe(tier.maxSeats);
    }
  });

  it('a SECOND pass over a satisfied state creates ZERO new tables (idempotent — never exceeds N)', async () => {
    const first = await cashHouseScalerPass();
    expect(first).toBeGreaterThan(0);
    const afterFirst = state.tables.length;

    const second = await cashHouseScalerPass();
    expect(second).toBe(0); // nothing to refill
    expect(state.tables.length).toBe(afterFirst); // table count UNCHANGED

    // The always-on invariant: open count == target for every tier.
    const byTier = (k: string) => state.tables.filter((t) => t.tierKey === k).length;
    expect(byTier('low')).toBe(HOUSE_TIERS.low.openTables);
    expect(byTier('mid')).toBe(HOUSE_TIERS.mid.openTables);
    expect(byTier('high')).toBe(HOUSE_TIERS.high.openTables);
  });

  it('refills ONLY the deficit after a table closes (creates 1 when one low table goes non-open)', async () => {
    await cashHouseScalerPass(); // satisfied
    // Close one LOW house table (simulate a table closing).
    const lowTable = state.tables.find((t) => t.tierKey === 'low');
    expect(lowTable).toBeTruthy();
    lowTable!.status = 'closed';

    const created = await cashHouseScalerPass();
    expect(created).toBe(1); // exactly the 1-table low deficit
    const openLow = state.tables.filter((t) => t.tierKey === 'low' && t.status === 'open').length;
    expect(openLow).toBe(HOUSE_TIERS.low.openTables);
  });

  it('respects a per-tier env override and creates nothing for a zeroed tier', async () => {
    process.env.CASH_HOUSE_TABLES_LOW = '0';
    process.env.CASH_HOUSE_TABLES_MID = '3';
    process.env.CASH_HOUSE_TABLES_HIGH = '0';

    const created = await cashHouseScalerPass();
    expect(created).toBe(3); // only mid, target 3
    expect(state.tables.filter((t) => t.tierKey === 'low').length).toBe(0);
    expect(state.tables.filter((t) => t.tierKey === 'mid').length).toBe(3);
    expect(state.tables.filter((t) => t.tierKey === 'high').length).toBe(0);
  });

  it("one tier's createTable failure never stops the other tiers (per-tier try/catch)", async () => {
    state.failTier = 'mid'; // every mid create throws

    const created = await cashHouseScalerPass();
    // low (2) + high (1) still created; mid (0) failed and was swallowed.
    expect(created).toBe(HOUSE_TIERS.low.openTables + HOUSE_TIERS.high.openTables);
    expect(state.tables.filter((t) => t.tierKey === 'mid').length).toBe(0);
    expect(state.tables.filter((t) => t.tierKey === 'low').length).toBe(HOUSE_TIERS.low.openTables);
    expect(state.tables.filter((t) => t.tierKey === 'high').length).toBe(
      HOUSE_TIERS.high.openTables,
    );
  });

  it('creates nothing and does not throw when the house bank is not yet ensured', async () => {
    state.bankNotReady = true;
    const created = await cashHouseScalerPass();
    expect(created).toBe(0);
    expect(state.tables.length).toBe(0);
  });

  it('a re-entrant pass is a no-op while one is in flight (sweepInFlight guard)', async () => {
    // Kick off two passes "concurrently". The guard makes the second return 0
    // immediately (it sees the first in flight), so only ONE pass actually scales.
    const [a, b] = await Promise.all([cashHouseScalerPass(), cashHouseScalerPass()]);
    const total = a + b;
    const expectedTotal =
      HOUSE_TIERS.low.openTables + HOUSE_TIERS.mid.openTables + HOUSE_TIERS.high.openTables;
    // Exactly one full scale happened (5 tables), the other pass was a 0 no-op.
    expect(total).toBe(expectedTotal);
    expect(state.tables.length).toBe(expectedTotal);
    expect(a === 0 || b === 0).toBe(true);
  });
});

describe('cashHouseScaler — mismatched retirement and busted-seat release', () => {
  function isolateLowTier(): void {
    process.env.CASH_HOUSE_TABLES_LOW = '1';
    process.env.CASH_HOUSE_TABLES_MID = '0';
    process.env.CASH_HOUSE_TABLES_HIGH = '0';
  }

  function disableHouseCreation(): void {
    process.env.CASH_HOUSE_TABLES_LOW = '0';
    process.env.CASH_HOUSE_TABLES_MID = '0';
    process.env.CASH_HOUSE_TABLES_HIGH = '0';
  }

  function addLowTable(stakes: { buyInCt: number; smallBlindCt: number; bigBlindCt: number }) {
    const table: FakeTableRow = {
      id: randomUUID(),
      source: 'house',
      visibility: 'public',
      tierKey: 'low',
      ...stakes,
      maxSeats: 6,
      seededAgentSlots: 3,
      status: 'open',
      createdBy: state.houseBankId,
      tableEscrowCt: 0,
    };
    state.tables.push(table);
    return table;
  }

  it('retires seeded-only old stakes and recreates the tier at approved stakes in the same pass', async () => {
    isolateLowTier();
    const oldTable = addLowTable({ buyInCt: 20, smallBlindCt: 1, bigBlindCt: 2 });
    oldTable.tableEscrowCt = 40;
    state.seats.push(
      {
        id: randomUUID(),
        tableId: oldTable.id,
        isSeeded: 'true',
        status: 'sitting_in',
        currentStackCt: 20,
        updatedAt: new Date(),
      },
      {
        id: randomUUID(),
        tableId: oldTable.id,
        isSeeded: 'true',
        status: 'sitting_out',
        currentStackCt: 20,
        updatedAt: new Date(),
      },
    );
    const bankBefore = state.houseBankBalance;

    const created = await cashHouseScalerPass();

    expect(created).toBe(1);
    expect(oldTable.status).toBe('closed');
    expect(oldTable.tableEscrowCt).toBe(0);
    expect(
      state.seats.every((seat) => seat.status === 'left' && seat.currentStackCt === 0),
    ).toBe(true);
    expect(state.houseBankBalance).toBe(bankBefore + 40);

    const openLow = state.tables.filter(
      (table) => table.source === 'house' && table.status === 'open' && table.tierKey === 'low',
    );
    expect(openLow).toHaveLength(1);
    expect(openLow[0]).toMatchObject(APPROVED_STAKES.low);
  });

  it('releases a fresh busted human during retirement, reclaims bots, and recreates approved stakes', async () => {
    isolateLowTier();
    const oldTable = addLowTable({ buyInCt: 20, smallBlindCt: 1, bigBlindCt: 2 });
    oldTable.tableEscrowCt = 40;
    const bustedHuman: FakeSeatRow = {
      id: randomUUID(),
      tableId: oldTable.id,
      isSeeded: 'false',
      status: 'sitting_in',
      currentStackCt: 0,
      updatedAt: new Date(),
    };
    state.seats.push(
      bustedHuman,
      {
        id: randomUUID(),
        tableId: oldTable.id,
        isSeeded: 'true',
        status: 'sitting_in',
        currentStackCt: 20,
        updatedAt: new Date(),
      },
      {
        id: randomUUID(),
        tableId: oldTable.id,
        isSeeded: 'true',
        status: 'sitting_out',
        currentStackCt: 20,
        updatedAt: new Date(),
      },
    );
    const bankBefore = state.houseBankBalance;

    expect(await cashHouseScalerPass()).toBe(1);
    expect(state.releaseBustedSeatCalls).toEqual([]);
    expect(state.retireHouseTableCalls).toEqual([oldTable.id]);
    expect(oldTable).toMatchObject({ status: 'closed', tableEscrowCt: 0 });
    expect(bustedHuman).toMatchObject({ status: 'left', currentStackCt: 0 });
    expect(state.seats.every((seat) => seat.status === 'left')).toBe(true);
    expect(state.houseBankBalance).toBe(bankBefore + 40);
    expect(
      state.tables.find(
        (table) => table.source === 'house' && table.status === 'open' && table.tierKey === 'low',
      ),
    ).toMatchObject(APPROVED_STAKES.low);
  });

  it('keeps a mismatched table with a non-zero human seat open and untouched', async () => {
    isolateLowTier();
    const table = addLowTable({ buyInCt: 20, smallBlindCt: 1, bigBlindCt: 2 });
    table.tableEscrowCt = 20;
    const humanSeat: FakeSeatRow = {
      id: randomUUID(),
      tableId: table.id,
      isSeeded: 'false',
      status: 'sitting_in',
      currentStackCt: 20,
      updatedAt: new Date(),
    };
    state.seats.push(humanSeat);

    expect(await cashHouseScalerPass()).toBe(0);
    expect(state.retireHouseTableCalls).toEqual([table.id]);
    expect(table.status).toBe('open');
    expect(table.tableEscrowCt).toBe(20);
    expect(humanSeat).toMatchObject({ status: 'sitting_in', currentStackCt: 20 });
  });

  it('keeps a mismatched table with a live hand open and untouched', async () => {
    isolateLowTier();
    const table = addLowTable({ buyInCt: 20, smallBlindCt: 1, bigBlindCt: 2 });
    table.tableEscrowCt = 20;
    const seededSeat: FakeSeatRow = {
      id: randomUUID(),
      tableId: table.id,
      isSeeded: 'true',
      status: 'sitting_in',
      currentStackCt: 20,
      updatedAt: new Date(),
    };
    state.seats.push(seededSeat);
    state.liveTableIds.add(table.id);

    expect(await cashHouseScalerPass()).toBe(0);
    expect(state.retireHouseTableCalls).toEqual([table.id]);
    expect(table.status).toBe('open');
    expect(table.tableEscrowCt).toBe(20);
    expect(seededSeat).toMatchObject({ status: 'sitting_in', currentStackCt: 20 });
  });

  it('never sends an approved-stakes table to the retirement path', async () => {
    isolateLowTier();
    const table = addLowTable(APPROVED_STAKES.low);

    expect(await cashHouseScalerPass()).toBe(0);
    expect(state.retireHouseTableCalls).toEqual([]);
    expect(table.status).toBe('open');
  });

  it('releases an idle busted seat older than ten minutes on a player table', async () => {
    disableHouseCreation();
    const table = addLowTable(APPROVED_STAKES.low);
    table.source = 'player-public';
    const seat: FakeSeatRow = {
      id: randomUUID(),
      tableId: table.id,
      isSeeded: 'false',
      status: 'sitting_in',
      currentStackCt: 0,
      updatedAt: new Date(Date.now() - 11 * 60 * 1_000),
    };
    state.seats.push(seat);

    expect(await cashHouseScalerPass()).toBe(0);
    expect(state.releaseBustedSeatCalls).toEqual([{ tableId: table.id, seatId: seat.id }]);
    expect(seat.status).toBe('left');
  });

  it('leaves an old busted seat untouched while its table has a live hand', async () => {
    disableHouseCreation();
    const table = addLowTable(APPROVED_STAKES.low);
    table.source = 'private';
    const seat: FakeSeatRow = {
      id: randomUUID(),
      tableId: table.id,
      isSeeded: 'false',
      status: 'sitting_in',
      currentStackCt: 0,
      updatedAt: new Date(Date.now() - 11 * 60 * 1_000),
    };
    state.seats.push(seat);
    state.liveTableIds.add(table.id);

    expect(await cashHouseScalerPass()).toBe(0);
    expect(state.releaseBustedSeatCalls).toEqual([{ tableId: table.id, seatId: seat.id }]);
    expect(seat.status).toBe('sitting_in');
  });

  it('does not discover a fresh busted seat', async () => {
    disableHouseCreation();
    const table = addLowTable(APPROVED_STAKES.low);
    table.source = 'player-public';
    const seat: FakeSeatRow = {
      id: randomUUID(),
      tableId: table.id,
      isSeeded: 'false',
      status: 'sitting_in',
      currentStackCt: 0,
      updatedAt: new Date(Date.now() - 9 * 60 * 1_000),
    };
    state.seats.push(seat);

    expect(await cashHouseScalerPass()).toBe(0);
    expect(state.releaseBustedSeatCalls).toEqual([]);
    expect(seat.status).toBe('sitting_in');
  });

  it('does not discover an old non-zero seat', async () => {
    disableHouseCreation();
    const table = addLowTable(APPROVED_STAKES.low);
    table.source = 'player-public';
    const seat: FakeSeatRow = {
      id: randomUUID(),
      tableId: table.id,
      isSeeded: 'false',
      status: 'sitting_out',
      currentStackCt: 1,
      updatedAt: new Date(Date.now() - 60 * 60 * 1_000),
    };
    state.seats.push(seat);

    expect(await cashHouseScalerPass()).toBe(0);
    expect(state.releaseBustedSeatCalls).toEqual([]);
    expect(seat.status).toBe('sitting_out');
  });
});
