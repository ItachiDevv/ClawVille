import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import { readArenaTrades, readArenaEquity } from './queries';
import { arenaAggregatesSql, resolveLeaderboardBounds, toCents } from './leaderboard';
import { FLOOR_ARENA_CONTEST } from '@clawville/shared';

const now = new Date('2026-10-01T12:00:00.001001Z');
const allBounds = resolveLeaderboardBounds('all', now);

// Use the existing plugin dependency. This database is in-memory and never reads DATABASE_URL.
const require = createRequire(import.meta.url);
const plugin = require.resolve('@elizaos/plugin-sql', { paths: [resolve(import.meta.dir, '../../..')] });
const { PGlite } = require(createRequire(plugin).resolve('@electric-sql/pglite'));
const database = new PGlite();
const dialect = new PgDialect();
const readRows = async (statement: SQL): Promise<Record<string, unknown>[]> => {
  const query = dialect.sqlToQuery(statement);
  return (await database.query(query.sql, query.params)).rows;
};

beforeAll(async () => {
  await database.exec(`CREATE TABLE floor_arena_positions (
    id uuid PRIMARY KEY, agent_id text, status text, closed_at timestamptz, opened_at timestamptz,
    pnl_usd numeric, pnl_mult numeric, realised_usd numeric DEFAULT 0, size_usd numeric DEFAULT 20, remaining_fraction numeric DEFAULT 0,
    last_mark_mult numeric, source text, symbol text, mint text, exit_reason text
  );
  INSERT INTO floor_arena_positions (id,agent_id,status,closed_at,pnl_usd,exit_reason)
  SELECT ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid, 'many', 'closed',
    '2026-10-01 12:00:00+00'::timestamptz + i * interval '1 microsecond', 1, 'tp'
  FROM generate_series(1,1001) i;
  INSERT INTO floor_arena_positions (id,agent_id,status,closed_at,pnl_usd,exit_reason) VALUES
    ('00000000-0000-4000-8000-000000002001','ties','closed','2026-10-01 12:00:00.123456+00',3,'tp'),
    ('00000000-0000-4000-8000-000000002002','ties','closed','2026-10-01 12:00:00.123456+00',-2,'stop'),
    ('00000000-0000-4000-8000-000000002003','ties','closed','2026-10-01 12:00:00.123455+00',NULL,'unresolved');
  INSERT INTO floor_arena_positions (id,agent_id,status,size_usd,realised_usd,remaining_fraction,last_mark_mult) VALUES
    ('00000000-0000-4000-8000-000000003001','marked','open',20,30,0.5,0.8),
    ('00000000-0000-4000-8000-000000003002','unmarked','open',20,0,1,NULL);
  `);
});
afterAll(async () => { await database.close(); });

describe('terminal reads on isolated PostgreSQL', () => {
  test('keyset retains microseconds and UUID ties without duplicates or omissions', async () => {
    const first = await readArenaTrades('ties', { limit: 1, outcome: 'all' }, readRows);
    expect(first).toHaveLength(2);
    expect(first[0]!.id).toEndWith('002002');
    expect(first[0]!.closedAt).toBe('2026-10-01T12:00:00.123456Z');
    const second = await readArenaTrades('ties', { limit: 1, outcome: 'all',
      before: first[0]!.closedAt!, beforeId: first[0]!.id }, readRows);
    expect(second[0]!.id).toEndWith('002001');
    const third = await readArenaTrades('ties', { limit: 1, outcome: 'all',
      before: second[0]!.closedAt!, beforeId: second[0]!.id }, readRows);
    expect(third).toHaveLength(1);
    expect(third[0]!.id).toEndWith('002003');
  });
  test('filters apply before pagination and other agents never enter the page', async () => {
    expect((await readArenaTrades('ties', { limit: 100, outcome: 'win' }, readRows)).map(p => p.pnlUsd)).toEqual([3]);
    expect((await readArenaTrades('ties', { limit: 100, outcome: 'loss', reason: 'stop' }, readRows)).map(p => p.pnlUsd)).toEqual([-2]);
    expect(await readArenaTrades('ties', { limit: 100, outcome: 'win', reason: 'stop' }, readRows)).toEqual([]);
    expect((await readArenaTrades('ties', { limit: 100, outcome: 'all', reason: 'unresolved' }, readRows))[0]!.pnlUsd).toBeNull();
  });
  test('downsampling preserves cumulative total and final bucket endpoint', async () => {
    const result = await readArenaEquity('many', allBounds, readRows);
    expect(result.series).toHaveLength(500);
    expect(result.series[0]!.equityUsd).toBe(3);
    expect(result.series.at(-1)!.equityUsd).toBe(1001);
    expect(result.series.at(-1)!.closedAt).toBe('2026-10-01T12:00:00.001001Z');
    expect(result.openPnlUsd).toBe(0);
  });
  test('windows bound accumulation and ordinary windows exclude unresolved closes', async () => {
    const result = await readArenaEquity('ties', allBounds, readRows);
    expect(result.series.map(p => p.equityUsd)).toEqual([3, 1]);
    const window = await readArenaEquity('many', { ...allBounds, closedFrom: new Date('2026-10-01T12:00:00.001Z') }, readRows);
    expect(window.series).toHaveLength(2);
    expect(window.series[0]!.equityUsd).toBe(1);
  });
  test('final equity equals stats realisedUsd for every window, including unresolved and cross-boundary positions', async () => {
    await database.exec(`CREATE TABLE floor_arena_agents (
      id text PRIMARY KEY, name text, kind text, template_id text, created_at timestamptz, contest_id text
    );
    INSERT INTO floor_arena_agents VALUES ('parity', 'Parity', 'user', 'test', '2026-01-01', NULL);`);
    const start = new Date(FLOOR_ARENA_CONTEST.startsAt);
    const end = new Date(FLOOR_ARENA_CONTEST.endsAt);
    const clock = new Date(end.getTime() + 3_600_000);
    const fixtures = [
      // Opened before contest, closed after its end: excluded only from contest.
      { opened: new Date(start.getTime() - 1), closed: clock, pnl: 11.004, proceeds: 31.004, reason: 'tp' },
      // Opened in contest, closed after end: still scores in contest.
      { opened: start, closed: clock, pnl: 7.004, proceeds: 27.004, reason: 'tp' },
      { opened: end, closed: clock, pnl: null, proceeds: 5, reason: 'unresolved' },
      { opened: start, closed: new Date(clock.getTime() - 2 * 86_400_000), pnl: 3, proceeds: 23, reason: 'tp' },
      { opened: new Date(clock.getTime() - 9 * 86_400_000), closed: new Date(clock.getTime() - 8 * 86_400_000), pnl: 2, proceeds: 22, reason: 'tp' },
    ];
    for (const [index, row] of fixtures.entries()) {
      await readRows(sql`INSERT INTO floor_arena_positions
        (id, agent_id, status, opened_at, closed_at, pnl_usd, realised_usd, exit_reason)
        VALUES (${`00000000-0000-4000-8000-00000000400${index}`}::uuid, 'parity', 'closed',
          ${row.opened.toISOString()}::timestamptz, ${row.closed.toISOString()}::timestamptz,
          ${row.pnl}, ${row.proceeds}, ${row.reason})`);
    }
    for (const window of ['contest', '24h', '7d', 'all'] as const) {
      const equity = await readArenaEquity('parity', resolveLeaderboardBounds(window, clock), readRows);
      const stats = (await readRows(arenaAggregatesSql(window, clock, ['parity'])))[0]!;
      // readArenaAgentStats maps the aggregate through this same whole-cent conversion.
      const realisedUsd = toCents(Number(stats.realised_usd)) / 100;
      expect(realisedUsd).toBe({ contest: -5, '24h': 18.01, '7d': 21.01, all: 23.01 }[window]);
      expect(equity.series.at(-1)!.equityUsd).toBe(realisedUsd);
      expect(equity.series.map(point => point.closedAt)).toEqual(equity.series.map(point => point.closedAt).sort());
    }
  });
  test('open P&L includes partial TP proceeds and missing marks remain null', async () => {
    expect((await readArenaEquity('marked', allBounds, readRows)).openPnlUsd).toBe(18);
    expect((await readArenaEquity('unmarked', allBounds, readRows)).openPnlUsd).toBeNull();
    expect(await readArenaEquity('empty', allBounds, readRows)).toEqual({ series: [], startAt: null, openPnlUsd: 0 });
  });
});
