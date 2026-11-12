import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { MoneyOperatorContext } from '../../middleware/money-operator-only';
import {
  ARENA_PERIOD_RESET_LOCK_KEY,
  resetArenaPeriod,
  type ArenaPeriodRecord,
  type ArenaPeriodTransact,
} from '../../services/floor-arena/period';
import {
  ARENA_PERIOD_RESET_MIN_GAP_MS,
  adminFloorArenaRoutes,
  arenaPeriodId,
  createAdminArenaPeriodRoutes,
  type AdminArenaPeriodDeps,
} from '../admin-floor-arena';

/**
 * D35 period reset routes (docs/trading-floor-arena.md §5). No DB: the route runs the REAL resetArenaPeriod against a
 * fake transaction seam (a fake table, a fake per-transaction DB now() and a fake advisory lock that blocks like
 * pg_advisory_xact_lock until the holder's transaction ends). The real SQL runs on PGlite in period.test.ts. The route
 * inserts a period row and writes no position (the engine leader closes the old positions with exit reason 'reset').
 */

const NOW = new Date('2026-11-12T04:35:07.123Z');

function periodAt(startsAt: Date, id = arenaPeriodId(startsAt)): ArenaPeriodRecord {
  return { id, name: 'Season 2', startsAt, reason: 'fresh board', createdBy: 'admin:op-1', createdAt: startsAt };
}

const dialect = new PgDialect();
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The fake transaction seam. Each transaction takes its DB now() from `dbNows` (in start order, else NOW), sees the
 * COMMITTED rows plus its own, and commits its inserts only when `fn` resolves. `lock: false` makes the advisory lock
 * a no-op (the code before the fix had no lock at all).
 */
function fakeDb(opts: { rows?: ArenaPeriodRecord[]; dbNows?: Date[]; lock?: boolean; insertError?: unknown } = {}) {
  const committed: ArenaPeriodRecord[] = [...(opts.rows ?? [])];
  const statements: string[] = [];
  const inserts: Array<{ id: string; name: string; reason: string; createdBy: string }> = [];
  const dbNows = [...(opts.dbNows ?? [])];
  let lockTail: Promise<void> = Promise.resolve();
  const transact: ArenaPeriodTransact = async (fn) => {
    const txNow = dbNows.shift() ?? NOW;
    const staged: ArenaPeriodRecord[] = [];
    const held: { release: (() => void) | null } = { release: null };
    const tx = {
      execute: async (statement: SQL) => {
        await tick();
        const query = dialect.sqlToQuery(statement);
        statements.push(query.sql.replace(/\s+/g, ' ').trim());
        if (query.sql.includes('pg_advisory_xact_lock')) {
          expect(query.params).toEqual([String(ARENA_PERIOD_RESET_LOCK_KEY)]);
          if (opts.lock === false) return [];
          const before = lockTail;
          lockTail = new Promise<void>((resolve) => { held.release = resolve; });
          await before;
          return [];
        }
        if (query.sql.includes('SELECT now() AS db_now')) {
          const starts = [...committed, ...staged].map((p) => p.startsAt.getTime());
          return [{ db_now: txNow, newest_start: starts.length > 0 ? new Date(Math.max(...starts)) : null }];
        }
        if (query.sql.includes('INSERT INTO floor_arena_periods')) {
          const [id, name, reason, createdBy] = query.params as string[];
          inserts.push({ id: id!, name: name!, reason: reason!, createdBy: createdBy! });
          if (opts.insertError) throw opts.insertError;
          staged.push({ id: id!, name: name!, startsAt: txNow, reason: reason!, createdBy: createdBy!, createdAt: txNow });
          return [{ id, name, starts_at: txNow, reason, created_by: createdBy, created_at: txNow }];
        }
        throw new Error(`unexpected statement: ${query.sql}`);
      },
    };
    try {
      const result = await fn(tx as never);
      committed.push(...staged);
      return result;
    } finally {
      held.release?.();
    }
  };
  return { transact, committed, statements, inserts };
}

function harness(opts: { active?: ArenaPeriodRecord | null; insertError?: unknown; openBefore?: number; lock?: boolean; dbNows?: Date[] } = {}) {
  const calls: string[] = [];
  const counts: Date[] = [];
  const fake = fakeDb({ rows: opts.active ? [opts.active] : [], insertError: opts.insertError, lock: opts.lock, dbNows: opts.dbNows });
  const deps: AdminArenaPeriodDeps = {
    readActive: async () => { calls.push('read'); return opts.active ?? null; },
    reset: async (input) => {
      calls.push('reset');
      try { return await resetArenaPeriod(input, fake.transact); } finally { calls.push('tx_end'); }
    },
    invalidateCache: () => { calls.push('invalidate'); },
    countOpenBefore: async (startsAt) => { calls.push('count'); counts.push(startsAt); return opts.openBefore ?? 3; },
  };
  const app = new Hono<MoneyOperatorContext>();
  app.use('*', async (c, next) => { c.set('moneyOperatorId', 'op-1'); await next(); });
  app.route('/', createAdminArenaPeriodRoutes(deps));
  const post = async (body: unknown, raw?: string) => app.request('/period/reset', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body),
  });
  return { app, post, calls, inserts: fake.inserts, counts, fake };
}

describe('admin arena period routes (D35)', () => {
  test('both routes are 401 without a session (session + moneyOperatorOnly guard)', async () => {
    const json = { 'content-type': 'application/json', origin: 'http://localhost' };
    expect((await adminFloorArenaRoutes.request('/period')).status).toBe(401);
    expect((await adminFloorArenaRoutes.request('/period/reset', {
      method: 'POST', headers: json, body: JSON.stringify({ name: 'x', reason: 'y' }),
    })).status).toBe(401);
  });

  test('POST /period/reset: 400 on a bad body (strict Zod: name 1..60, reason 1..280, no extra key, JSON)', async () => {
    const { post, inserts } = harness();
    const bad: unknown[] = [
      {}, { name: 'x' }, { reason: 'y' }, { name: '', reason: 'y' }, { name: '   ', reason: 'y' }, { name: 'x', reason: '' },
      { name: 'x'.repeat(61), reason: 'y' }, { name: 'x', reason: 'y'.repeat(281) }, { name: 'x', reason: 'y', startsAt: '2020-01-01' },
      { name: 1, reason: 'y' }, null, [],
    ];
    for (const body of bad) {
      const response = await post(body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
      expect(((await response.json()) as { code: string }).code).toBe('invalid_body');
    }
    expect((await post(null, '{not json')).status).toBe(400);
    expect(inserts).toEqual([]);
  });

  test('POST /period/reset: 200 inserts one period, returns it and the count to close; no position write', async () => {
    const { post, calls, inserts, counts } = harness({ openBefore: 7 });
    const response = await post({ name: '  Season 2 ', reason: 'fresh board' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      period: { id: 'period-20261112T043507Z', name: 'Season 2', startsAt: NOW.toISOString() },
      openPositionsToClose: 7,
    });
    expect(inserts).toEqual([{ id: 'period-20261112T043507Z', name: 'Season 2', reason: 'fresh board', createdBy: 'admin:op-1' }]);
    // the cache is cleared after the transaction ends; the count uses the inserted start (the DB now())
    expect(calls).toEqual(['reset', 'tx_end', 'invalidate', 'count']);
    expect(counts).toEqual([NOW]);
  });

  test('Codex fecd02004: the lock, the DB-time check and the insert run in that order, in one transaction', async () => {
    const { post, fake } = harness();
    expect((await post({ name: 'x', reason: 'y' })).status).toBe(200);
    expect(fake.statements.map((q) => q.slice(0, 40))).toEqual([
      'SELECT pg_advisory_xact_lock($1::bigint)',
      'SELECT now() AS db_now, (SELECT max(star',
      'INSERT INTO floor_arena_periods (id, nam',
    ]);
    expect(fake.statements[2]).toContain('now()'); // starts_at = the DB now(), never process time
  });

  test('Codex fecd02004: two concurrent resets across a second boundary -> exactly one 200 and one 409', async () => {
    // The waiter's transaction started EARLIER (DB now 0.5 s before the winner's start): a negative gap is too recent.
    const { post, fake } = harness({ dbNows: [new Date(NOW.getTime() + 500), NOW] });
    const responses = await Promise.all([post({ name: 'a', reason: 'r' }), post({ name: 'b', reason: 'r' })]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const refused = responses.find((r) => r.status === 409)!;
    expect(((await refused.json()) as { code: string }).code).toBe('period_too_recent');
    expect(fake.committed).toHaveLength(1);
    // Without the lock (the code before the fix) both requests read no period and both insert.
    const unlocked = harness({ lock: false, dbNows: [new Date('2026-11-12T04:35:07.900Z'), new Date('2026-11-12T04:35:08.100Z')] });
    const both = await Promise.all([unlocked.post({ name: 'a', reason: 'r' }), unlocked.post({ name: 'b', reason: 'r' })]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(unlocked.fake.committed).toHaveLength(2);
  });

  test('POST /period/reset: 409 period_too_recent while the active period is < 60 s old; allowed at 60 s', async () => {
    const recent = harness({ active: periodAt(new Date(NOW.getTime() - ARENA_PERIOD_RESET_MIN_GAP_MS + 1)) });
    const refused = await recent.post({ name: 'again', reason: 'double click' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('period_too_recent');
    expect(recent.inserts).toEqual([]);
    const old = harness({ active: periodAt(new Date(NOW.getTime() - ARENA_PERIOD_RESET_MIN_GAP_MS)) });
    expect((await old.post({ name: 'next', reason: 'a minute later' })).status).toBe(200);
  });

  test('POST /period/reset: a unique violation (two resets in the same second) is 409, other errors are 500', async () => {
    const dup = harness({ insertError: Object.assign(new Error('duplicate key'), { code: '23505' }) });
    const response = await dup.post({ name: 'x', reason: 'y' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('period_too_recent');
    expect(dup.calls.at(-1)).toBe('invalidate');
    expect(dup.fake.committed).toEqual([]); // the failed transaction committed nothing
    const wrapped = harness({ insertError: Object.assign(new Error('query failed'), { cause: { code: '23505' } }) });
    expect((await wrapped.post({ name: 'x', reason: 'y' })).status).toBe(409);
    const broken = harness({ insertError: new Error('connection lost') });
    expect((await broken.post({ name: 'x', reason: 'y' })).status).toBe(500);
  });

  test('GET /period: the active period and its count to close; none -> null and 0', async () => {
    const start = new Date('2026-11-12T00:00:00Z');
    const withPeriod = harness({ active: periodAt(start), openBefore: 4 });
    const response = await withPeriod.app.request('/period');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      period: { id: 'period-20261112T000000Z', name: 'Season 2', startsAt: start.toISOString() }, openPositionsToClose: 4,
    });
    expect(withPeriod.counts).toEqual([start]);
    const none = harness();
    expect(await (await none.app.request('/period')).json()).toEqual({ period: null, openPositionsToClose: 0 });
    expect(none.calls).not.toContain('count');
  });

  test('period ids are period-<UTC yyyymmddThhmmssZ>', () => {
    expect(arenaPeriodId(new Date('2026-01-02T03:04:05.999Z'))).toBe('period-20260102T030405Z');
  });
});
