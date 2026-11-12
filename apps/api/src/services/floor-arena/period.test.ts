import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { type SQL } from 'drizzle-orm';
import { FLOOR_ARENA_EXIT_REASONS } from '@clawville/shared';
import {
  ARENA_PERIOD_CACHE_MS,
  insertArenaPeriod,
  invalidateArenaPeriodCache,
  mapArenaPeriodRow,
  readActiveArenaPeriod,
  resetArenaPeriod,
  toPublicPeriod,
  type ArenaPeriodTransact,
} from './period';

// Real PostgreSQL (in-memory PGlite, the existing plugin dependency); never reads DATABASE_URL.
const require = createRequire(import.meta.url);
const plugin = require.resolve('@elizaos/plugin-sql', { paths: [resolve(import.meta.dir, '../../..')] });
const { PGlite } = require(createRequire(plugin).resolve('@electric-sql/pglite'));
const database = new PGlite();
const dialect = new PgDialect();
const readRows = async (statement: SQL): Promise<Record<string, unknown>[]> => {
  const query = dialect.sqlToQuery(statement);
  return (await database.query(query.sql, query.params)).rows;
};
const executor = { execute: async (statement: SQL) => readRows(statement) } as unknown as Parameters<typeof insertArenaPeriod>[1];

const repoRoot = resolve(import.meta.dir, '../../../../..');
const MIGRATION = readFileSync(resolve(repoRoot, 'packages/database/migrations/0122_floor_arena_periods.sql'), 'utf8');
const SCHEMA = readFileSync(resolve(repoRoot, 'packages/database/src/schema/floor-arena.ts'), 'utf8');

function inList(text: string): string[] {
  const match = /IN \(([^)]*)\)/.exec(text);
  if (!match) throw new Error('no exit_reason IN list');
  return match[1]!.split(',').map((item) => item.trim().replace(/^'|'$/g, ''));
}

beforeAll(async () => {
  // The 0070 shape of the CHECK, so the migration's DROP + ADD runs against a real old constraint.
  await database.exec(`CREATE TABLE floor_arena_positions (
    id serial PRIMARY KEY, exit_reason text,
    CONSTRAINT floor_arena_positions_exit_reason_valid CHECK (exit_reason IS NULL OR exit_reason IN ('tp','stop','trail','time','manual','unresolved'))
  );`);
  // migrate-ci runs a file as one implicit transaction; SET LOCAL needs one here too.
  await database.exec(`BEGIN; ${MIGRATION} COMMIT;`);
});
afterAll(async () => { await database.close(); });
beforeEach(() => { invalidateArenaPeriodCache(); });

describe('migration 0122 shape', () => {
  test('idempotent style, lock_timeout, no seed row, the exact table', () => {
    expect(MIGRATION).toContain("SET LOCAL lock_timeout = '5s';");
    expect(MIGRATION).toContain('CREATE TABLE IF NOT EXISTS "floor_arena_periods"');
    expect(MIGRATION).toContain('DROP CONSTRAINT IF EXISTS "floor_arena_positions_exit_reason_valid"');
    expect(MIGRATION).not.toMatch(/INSERT INTO/i);
    expect(MIGRATION).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|DROP TABLE/i);
  });

  test('the exit_reason CHECK equals FLOOR_ARENA_EXIT_REASONS in the migration and the Drizzle mirror', () => {
    expect(inList(MIGRATION.slice(MIGRATION.indexOf('ADD CONSTRAINT "floor_arena_positions_exit_reason_valid"')))).toEqual([...FLOOR_ARENA_EXIT_REASONS]);
    expect(inList(SCHEMA.slice(SCHEMA.indexOf('floor_arena_positions_exit_reason_valid')))).toEqual([...FLOOR_ARENA_EXIT_REASONS]);
    expect(FLOOR_ARENA_EXIT_REASONS.at(-1)).toBe('reset');
  });

  test('applied twice it is a no-op; the widened CHECK takes reset and refuses other text', async () => {
    await database.exec(`BEGIN; ${MIGRATION} COMMIT;`);
    await database.query(`INSERT INTO floor_arena_positions (exit_reason) VALUES ('reset'), ('unresolved'), (NULL)`);
    await expect(database.query(`INSERT INTO floor_arena_positions (exit_reason) VALUES ('wiped')`)).rejects.toThrow();
    const columns = (await database.query(`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'floor_arena_periods' ORDER BY ordinal_position`)).rows;
    expect(columns).toEqual([
      { column_name: 'id', is_nullable: 'NO' }, { column_name: 'name', is_nullable: 'NO' },
      { column_name: 'starts_at', is_nullable: 'NO' }, { column_name: 'reason', is_nullable: 'NO' },
      { column_name: 'created_by', is_nullable: 'NO' }, { column_name: 'created_at', is_nullable: 'NO' },
    ]);
  });
});

describe('active period', () => {
  test('no row: null, and toPublicPeriod(null) is null', async () => {
    expect(await readActiveArenaPeriod(new Date(), readRows)).toBeNull();
    expect(toPublicPeriod(null)).toBeNull();
  });

  test('insert stamps the DB now(); the active period is the greatest starts_at <= now; the cache holds 10 s', async () => {
    await database.query(`INSERT INTO floor_arena_periods (id, name, starts_at, reason, created_by)
      VALUES ('period-20261001T000000Z', 'Old', '2026-10-01T00:00:00Z', 'first', 'admin')`);
    const before = Date.now();
    const inserted = await insertArenaPeriod({ id: 'period-new', name: 'Week 2', reason: 'founder reset', createdBy: 'user:1' }, executor);
    expect(inserted).toMatchObject({ id: 'period-new', name: 'Week 2', reason: 'founder reset', createdBy: 'user:1' });
    expect(Math.abs(inserted.startsAt.getTime() - before)).toBeLessThan(60_000);
    // A time before the new start sees the old period.
    const old = await readActiveArenaPeriod(new Date('2026-10-02T00:00:00Z'), readRows);
    expect(old?.id).toBe('period-20261001T000000Z');
    invalidateArenaPeriodCache();
    const now = new Date(inserted.startsAt.getTime() + 1_000);
    const active = await readActiveArenaPeriod(now, readRows);
    expect(active?.id).toBe('period-new');
    expect(toPublicPeriod(active)).toEqual({ id: 'period-new', name: 'Week 2', startsAt: inserted.startsAt.toISOString() });
    // Cached: a later row is not seen inside 10 s, and is seen after the cache expires or is invalidated.
    await database.query(`INSERT INTO floor_arena_periods (id, name, starts_at, reason, created_by)
      VALUES ('period-later', 'Week 3', $1::timestamptz, 'r', 'admin')`, [new Date(now.getTime() + 500).toISOString()]);
    expect((await readActiveArenaPeriod(new Date(now.getTime() + 1_000), readRows))?.id).toBe('period-new');
    expect((await readActiveArenaPeriod(new Date(now.getTime() + ARENA_PERIOD_CACHE_MS), readRows))?.id).toBe('period-later');
  });

  test('starts_at is UNIQUE', async () => {
    await database.query(`INSERT INTO floor_arena_periods (id, name, starts_at, reason, created_by)
      VALUES ('dup-a', 'A', '2026-09-01T00:00:00Z', 'r', 'admin')`);
    await expect(database.query(`INSERT INTO floor_arena_periods (id, name, starts_at, reason, created_by)
      VALUES ('dup-b', 'B', '2026-09-01T00:00:00Z', 'r', 'admin')`)).rejects.toThrow();
  });

  test('a half-read row maps to null, never a partial period', () => {
    expect(mapArenaPeriodRow(undefined)).toBeNull();
    expect(mapArenaPeriodRow({ id: 'x', name: 'n', starts_at: 'not a date', reason: 'r', created_by: 'a', created_at: new Date() })).toBeNull();
    expect(mapArenaPeriodRow({ id: 'x', name: null, starts_at: new Date(), reason: 'r', created_by: 'a', created_at: new Date() })).toBeNull();
  });
});

describe('resetArenaPeriod on real SQL (PGlite: one connection, so the lock is not contended here; the concurrent case is the fake-lock test in admin-floor-arena-period.test.ts)', () => {
  // One real transaction per call, like db.transaction.
  const transact: ArenaPeriodTransact = async (fn) => {
    await database.exec('BEGIN');
    try {
      const result = await fn(executor!);
      await database.exec('COMMIT');
      return result;
    } catch (error) {
      await database.exec('ROLLBACK');
      throw error;
    }
  };
  const input = (name: string, minGapMs = 60_000) => ({
    name, reason: 'r', createdBy: 'admin:op', minGapMs, idFor: (at: Date) => `period-${at.getTime()}`,
  });

  test('locks, checks the newest start against the DB now(), inserts at now(); a second reset inside 60 s is period_too_recent', async () => {
    await database.query('DELETE FROM floor_arena_periods');
    const first = await resetArenaPeriod(input('A'), transact);
    if (!first.ok) throw new Error('expected the first reset to insert');
    expect(first.period.id).toBe(`period-${first.period.startsAt.getTime()}`); // the id comes from the DB now()
    expect(await resetArenaPeriod(input('B'), transact)).toEqual({ ok: false, code: 'period_too_recent' });
    expect((await database.query('SELECT count(*)::int AS n FROM floor_arena_periods')).rows).toEqual([{ n: 1 }]);
    // a row that starts AFTER the DB now() (a negative gap) is too recent too
    await database.query(`INSERT INTO floor_arena_periods (id, name, starts_at, reason, created_by)
      VALUES ('future', 'F', now() + interval '1 hour', 'r', 'admin')`);
    expect(await resetArenaPeriod(input('C', 0), transact)).toEqual({ ok: false, code: 'period_too_recent' });
    await database.query(`DELETE FROM floor_arena_periods WHERE id = 'future'`);
    const later = await resetArenaPeriod(input('D', 0), transact);
    expect(later.ok).toBe(true);
  });
});
