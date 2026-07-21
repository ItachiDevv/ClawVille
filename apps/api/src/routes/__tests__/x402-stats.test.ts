import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';

type AggregateRow = {
  total: string | bigint | number | null;
  payments: string | bigint | number;
};

const realDatabase = await import('@clawville/database');
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;
let interceptDatabase = true;
let selectCalls = 0;
let selectResult: AggregateRow[] = [];
let selectError: Error | null = null;
let nowMs = 2_000_000_000_000;
const realDateNow = Date.now;
Date.now = () => nowMs;

const fakeDb = {
  select: (_selection: unknown) => {
    selectCalls += 1;
    return {
      from: async (_table: unknown) => {
        if (selectError) throw selectError;
        return selectResult;
      },
    };
  },
};

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: new Proxy(fakeDb, {
    get: (target, property, receiver) => interceptDatabase
      ? Reflect.get(target, property, receiver)
      : Reflect.get(delegateDb, property, delegateDb),
  }),
}));

const { x402StatsRoutes } = await import('../x402-stats');

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/x402/stats', x402StatsRoutes);
  return app;
}

afterAll(() => {
  interceptDatabase = false;
  Date.now = realDateNow;
});

beforeEach(() => {
  selectCalls = 0;
  selectResult = [];
  selectError = null;
});

describe.serial('GET /api/x402/stats', () => {
  it('returns 503 when the aggregate fails before any snapshot is cached', async () => {
    selectError = new Error('database unavailable');

    const response = await buildApp().request('/api/x402/stats');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'stats_unavailable' });
    expect(selectCalls).toBe(1);
  });

  it('returns the summed all-time x402 volume and payment count', async () => {
    selectResult = [{ total: '12345678900', payments: 42 }];

    const response = await buildApp().request('/api/x402/stats');
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(body).toEqual({
      totalUsd: 12_345.6789,
      totalUsdcAtomic: '12345678900',
      payments: 42,
      updatedAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(body.updatedAt as string))).toBe(false);
    expect(selectCalls).toBe(1);
  });

  it('serves a cache hit without querying the database again', async () => {
    nowMs += 60_001;
    selectResult = [{ total: 987654321, payments: '7' }];
    const app = buildApp();

    const first = await app.request('/api/x402/stats');
    const second = await app.request('/api/x402/stats');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      totalUsd: 987.654321,
      totalUsdcAtomic: '987654321',
      payments: 7,
    });
    expect(selectCalls).toBe(1);
  });
});
