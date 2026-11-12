import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { MoneyOperatorContext } from '../../middleware/money-operator-only';
import type { ArenaPeriodRecord } from '../../services/floor-arena/period';
import {
  ARENA_PERIOD_RESET_MIN_GAP_MS,
  adminFloorArenaRoutes,
  arenaPeriodId,
  createAdminArenaPeriodRoutes,
  type AdminArenaPeriodDeps,
} from '../admin-floor-arena';

/**
 * D35 period reset routes (docs/trading-floor-arena.md §5). Fake deps only: the route inserts a period row and
 * writes no position (the engine leader closes the old positions with exit reason 'reset').
 */

const NOW = new Date('2026-11-12T04:35:07.123Z');

function periodAt(startsAt: Date, id = arenaPeriodId(startsAt)): ArenaPeriodRecord {
  return { id, name: 'Season 2', startsAt, reason: 'fresh board', createdBy: 'admin:op-1', createdAt: startsAt };
}

function harness(opts: { active?: ArenaPeriodRecord | null; insertError?: unknown; openBefore?: number } = {}) {
  const calls: string[] = [];
  const inserts: Array<{ id: string; name: string; reason: string; createdBy: string }> = [];
  const counts: Date[] = [];
  let active = opts.active ?? null;
  const deps: AdminArenaPeriodDeps = {
    readActive: async (now?: Date) => { calls.push(`read:${now?.toISOString() ?? 'none'}`); return active; },
    insert: async (input) => {
      calls.push('insert');
      inserts.push(input);
      if (opts.insertError) throw opts.insertError;
      active = periodAt(NOW, input.id);
      return active;
    },
    invalidateCache: () => { calls.push('invalidate'); },
    countOpenBefore: async (startsAt) => { calls.push('count'); counts.push(startsAt); return opts.openBefore ?? 3; },
    now: () => NOW,
  };
  const app = new Hono<MoneyOperatorContext>();
  app.use('*', async (c, next) => { c.set('moneyOperatorId', 'op-1'); await next(); });
  app.route('/', createAdminArenaPeriodRoutes(deps));
  const post = async (body: unknown, raw?: string) => app.request('/period/reset', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body),
  });
  return { app, post, calls, inserts, counts };
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
    // the cache is cleared before the 60 s check and after the insert; the count uses the inserted start
    expect(calls).toEqual(['invalidate', `read:${NOW.toISOString()}`, 'insert', 'invalidate', 'count']);
    expect(counts).toEqual([NOW]);
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
