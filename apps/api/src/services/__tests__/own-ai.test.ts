/**
 * Own AI service (MCP hub step 4 part A). No real DB, no real provider: the
 * database module's `db` is a recording fake (mock.module, real `sql`/`eq`),
 * global fetch is a fake, and the crypto seam is a reversible fake. This file
 * sets no process env.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { OWN_AI_UNKNOWN_MODEL_PRICE } from '@clawville/shared';

// ---------------------------------------------------------------------------
// Fake db: every builder chain is a thenable that records its calls and
// resolves to the next queued result for its op.
// ---------------------------------------------------------------------------

type Op = 'select' | 'insert' | 'update' | 'delete' | 'execute';
interface Recorded {
  op: Op;
  calls: Array<{ name: string; args: unknown[] }>;
}
let recorded: Recorded[] = [];
let queue: Record<Op, unknown[][]> = { select: [], insert: [], update: [], delete: [], execute: [] };

function chain(op: Op): unknown {
  const rec: Recorded = { op, calls: [] };
  recorded.push(rec);
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          const result = queue[op].shift() ?? [];
          return (resolve: (v: unknown) => void) => resolve(result);
        }
        return (...args: unknown[]) => {
          rec.calls.push({ name: String(prop), args });
          return proxy;
        };
      },
    },
  );
  return proxy;
}

const fakeDb = {
  select: (...args: unknown[]) => {
    const c = chain('select') as { _: unknown };
    recorded[recorded.length - 1]!.calls.push({ name: 'select', args });
    return c;
  },
  insert: (...args: unknown[]) => {
    const c = chain('insert');
    recorded[recorded.length - 1]!.calls.push({ name: 'insert', args });
    return c;
  },
  update: (...args: unknown[]) => {
    const c = chain('update');
    recorded[recorded.length - 1]!.calls.push({ name: 'update', args });
    return c;
  },
  execute: async (q: unknown) => {
    recorded.push({ op: 'execute', calls: [{ name: 'execute', args: [q] }] });
    return queue.execute.shift() ?? [];
  },
  transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeDb),
};

const realDatabase = await import('@clawville/database');
mock.module('@clawville/database', () => ({ ...realDatabase, db: fakeDb }));

const own = await import('../own-ai');
const {
  OwnAiError,
  buildOwnAiStatus,
  clearOwnAi,
  computeOwnAiActiveNow,
  ownAiActiveNow,
  decideOwnAiMayCall,
  isUsepodDashboardUrl,
  listProviderModels,
  loadOwnAiRuntimeConfig,
  mapProviderStatus,
  onOwnAiSettingsChanged,
  ownAiMayCall,
  parseUsepodBalance,
  parseUsepodRegisterResponse,
  readUsepodBalance,
  readUsepodDashboardLink,
  recordOwnAiFallback,
  recordOwnAiUsage,
  registerUsepodToken,
  releaseOwnAiReservation,
  ownAiEstimateMicroUsd,
  ownAiTestEstimate,
  reserveOwnAiTestCall,
  runMeteredOwnAiKeyTest,
  resolveOwnAiSave,
  sanitizeModelList,
  saveOwnAiSettings,
  setOwnAiDepsForTest,
  testOwnAiKey,
} = own;

const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as SQL);

const OPENAI_KEY = 'sk-TESTSECRETKEY0123456789abcdef';
const ANTHROPIC_KEY = 'sk-ant-TESTSECRETKEY0123456789abcdef';
const OPENROUTER_KEY = 'sk-or-TESTSECRETKEY0123456789abcdef';
const TOKEN = '550e8400-e29b-41d4-a716-446655440000';
const AVATAR = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONTRACT = 'BBAdcqUkg68JXNiPQ1HR1wujfZuayyK3eQTQSYAh6FSW';

// Reversible fake crypto: no VANITY_ENCRYPTION_KEY needed.
const restoreDeps = setOwnAiDepsForTest({
  encrypt: (p: string) => ({ enc: Buffer.from(p).toString('base64'), iv: 'iv', tag: 'tag' }),
  decrypt: (enc: string) => Buffer.from(enc, 'base64').toString('utf8'),
});
const sealed = (k: string) => Buffer.from(k).toString('base64');

// Fake fetch.
const realFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchReply: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response('{}');
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  fetchCalls.push({ url: String(input), init: init ?? {} });
  return fetchReply(String(input), init ?? {});
}) as typeof fetch;

// Console spies: nothing secret may reach a log.
const logged: string[] = [];
const realWarn = console.warn;
const realError = console.error;
const realLog = console.log;
console.warn = (...a: unknown[]) => logged.push(a.map(String).join(' '));
console.error = (...a: unknown[]) => logged.push(a.map(String).join(' '));
console.log = (...a: unknown[]) => logged.push(a.map(String).join(' '));

afterAll(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.error = realError;
  console.log = realLog;
  restoreDeps();
});

beforeEach(() => {
  recorded = [];
  queue = { select: [], insert: [], update: [], delete: [], execute: [] };
  fetchCalls = [];
  fetchReply = () => new Response('{}');
});

afterEach(() => {
  for (const line of logged) {
    for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, OPENROUTER_KEY, TOKEN]) expect(line.includes(secret)).toBe(false);
  }
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OwnAiError);
    expect(String((e as InstanceType<typeof OwnAiError>).code)).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function expectCodeAsync(p: Promise<unknown>, code: string, secrets: string[] = []) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OwnAiError);
    const err = e as InstanceType<typeof OwnAiError>;
    expect(String(err.code)).toBe(code);
    for (const s of secrets) {
      expect(err.message.includes(s)).toBe(false);
      expect(String(err.stack ?? '').includes(s)).toBe(false);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

// ---------------------------------------------------------------------------

describe('resolveOwnAiSave (CHECK-like validation)', () => {
  const base = { source: 'own_key' as const, provider: 'openai' as const, model: 'gpt-4.1', dailyLimitCents: 100, key: OPENAI_KEY };

  test('a valid first save', () => {
    const r = resolveOwnAiSave(base, null);
    expect(r).toEqual({ source: 'own_key', provider: 'openai', model: 'gpt-4.1', speedSeconds: 25, dailyLimitCents: 100, keyAction: 'set', newKey: OPENAI_KEY });
  });

  test('key pattern refusals per provider', () => {
    expectCode(() => resolveOwnAiSave({ ...base, key: 'sk-short' }, null), 'invalid_key');
    expectCode(() => resolveOwnAiSave({ ...base, key: `${OPENAI_KEY} ` + 'x' }, null), 'invalid_key');
    expectCode(() => resolveOwnAiSave({ ...base, provider: 'anthropic', key: OPENAI_KEY }, null), 'invalid_key');
    expectCode(() => resolveOwnAiSave({ ...base, provider: 'openrouter', key: OPENAI_KEY }, null), 'invalid_key');
    expectCode(() => resolveOwnAiSave({ ...base, source: 'usepod', provider: 'usepod', key: `${TOKEN}/../x` }, null), 'invalid_key');
    expect(resolveOwnAiSave({ ...base, key: `  ${OPENAI_KEY}\n` }, null).newKey).toBe(OPENAI_KEY);
  });

  test('limit bounds', () => {
    expectCode(() => resolveOwnAiSave({ ...base, dailyLimitCents: 9 }, null), 'invalid_daily_limit');
    expectCode(() => resolveOwnAiSave({ ...base, dailyLimitCents: 50_001 }, null), 'invalid_daily_limit');
    expectCode(() => resolveOwnAiSave({ ...base, dailyLimitCents: 10.5 }, null), 'invalid_daily_limit');
    expectCode(() => resolveOwnAiSave({ ...base, dailyLimitCents: undefined }, null), 'invalid_daily_limit');
    expect(resolveOwnAiSave({ ...base, dailyLimitCents: 10 }, null).dailyLimitCents).toBe(10);
    expect(resolveOwnAiSave({ ...base, dailyLimitCents: 50_000 }, null).dailyLimitCents).toBe(50_000);
    const stored = { provider: 'openai', speedSeconds: 15, dailyLimitCents: 300, hasKey: true, usepodRegistered: false };
    expect(resolveOwnAiSave({ ...base, dailyLimitCents: undefined }, stored).dailyLimitCents).toBe(300);
  });

  test('speed must be one of OWN_AI_SPEEDS_SECONDS', () => {
    for (const s of [25, 20, 15, 10]) expect(resolveOwnAiSave({ ...base, speedSeconds: s }, null).speedSeconds).toBe(s);
    for (const s of [5, 9, 12, 30, 0, -10]) expectCode(() => resolveOwnAiSave({ ...base, speedSeconds: s }, null), 'invalid_speed');
  });

  test('source, provider, model checks', () => {
    expectCode(() => resolveOwnAiSave({ ...base, source: 'house' as never }, null), 'invalid_source');
    expectCode(() => resolveOwnAiSave({ ...base, provider: 'groq' as never }, null), 'invalid_provider');
    expectCode(() => resolveOwnAiSave({ ...base, source: 'usepod' }, null), 'provider_source_mismatch');
    expectCode(() => resolveOwnAiSave({ ...base, provider: 'usepod', key: TOKEN }, null), 'provider_source_mismatch');
    expectCode(() => resolveOwnAiSave({ ...base, model: 'a'.repeat(129) }, null), 'invalid_model');
    expectCode(() => resolveOwnAiSave({ ...base, model: 'gpt 4' }, null), 'invalid_model');
  });

  test('key omitted keeps the stored key only for the same provider', () => {
    const noKey = { ...base, key: undefined };
    expect(resolveOwnAiSave(noKey, { provider: 'openai', speedSeconds: 25, dailyLimitCents: 100, hasKey: true, usepodRegistered: false }).newKey).toBeNull();
    expectCode(() => resolveOwnAiSave(noKey, null), 'key_required');
    expectCode(() => resolveOwnAiSave(noKey, { provider: 'anthropic', speedSeconds: 25, dailyLimitCents: 100, hasKey: true, usepodRegistered: false }), 'key_required');
    expectCode(() => resolveOwnAiSave(noKey, { provider: 'openai', speedSeconds: 25, dailyLimitCents: 100, hasKey: false, usepodRegistered: false }), 'key_required');
  });

  test('error messages never echo the key', () => {
    try {
      resolveOwnAiSave({ ...base, provider: 'anthropic', key: OPENAI_KEY }, null);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(OPENAI_KEY);
    }
  });
});

describe('cap math and gate', () => {
  test('one call fits when spent + reserved + estimate <= limit; exactly at the limit still fits', () => {
    const row = { source: 'own_key', dailyLimitCents: 10, fallbackReason: null };
    expect(decideOwnAiMayCall({ ...row, estimatedMicroUsd: 99_999 }, 1)).toEqual({ allow: true, recordDailyLimit: false });
    expect(decideOwnAiMayCall({ ...row, estimatedMicroUsd: 100_000 }, 1)).toEqual({ allow: false, recordDailyLimit: true });
    expect(decideOwnAiMayCall({ ...row, estimatedMicroUsd: null }, 100_000)).toEqual({ allow: true, recordDailyLimit: false });
    expect(decideOwnAiMayCall({ ...row, estimatedMicroUsd: 60_000, reservedMicroUsd: 30_000 }, 10_000)).toEqual({
      allow: true,
      recordDailyLimit: false,
    });
  });

  test('a refusal caused only by in-flight reservations does NOT record daily_limit', () => {
    const row = { source: 'own_key', dailyLimitCents: 10, fallbackReason: null };
    expect(decideOwnAiMayCall({ ...row, estimatedMicroUsd: 50_000, reservedMicroUsd: 40_000 }, 20_000)).toEqual({
      allow: false,
      recordDailyLimit: false,
    });
    expect(decideOwnAiMayCall({ ...row, estimatedMicroUsd: 90_000, reservedMicroUsd: 0 }, 20_000)).toEqual({
      allow: false,
      recordDailyLimit: true,
    });
  });

  test('no own AI, rejected key and empty balance refuse without a daily_limit write', () => {
    expect(decideOwnAiMayCall(null).allow).toBe(false);
    expect(decideOwnAiMayCall({ source: 'clawville', dailyLimitCents: 100, fallbackReason: null, estimatedMicroUsd: 0 }).allow).toBe(false);
    for (const reason of ['key_rejected', 'balance_empty']) {
      expect(decideOwnAiMayCall({ source: 'own_key', dailyLimitCents: 100, fallbackReason: reason, estimatedMicroUsd: 0 })).toEqual({
        allow: false,
        recordDailyLimit: false,
      });
    }
    expect(decideOwnAiMayCall({ source: 'own_key', dailyLimitCents: 100, fallbackReason: 'provider_error', estimatedMicroUsd: 0 }).allow).toBe(true);
  });

  test('the estimate prices prompt and max_tokens with the model price, at least 1 micro-USD', () => {
    // gpt-4o: 2.5 / 10 USD per M tokens -> 2.5 / 10 micro-USD per token.
    expect(ownAiEstimateMicroUsd('openai/gpt-4o', { inputTokens: 1000, outputTokens: 200 })).toBe(4500);
    expect(ownAiEstimateMicroUsd('gpt-4o', { inputTokens: 0, outputTokens: 0 })).toBe(1);
    expect(ownAiEstimateMicroUsd('acme/new', { inputTokens: 10, outputTokens: 10 })).toBe(
      10 * OWN_AI_UNKNOWN_MODEL_PRICE.inputPerM + 10 * OWN_AI_UNKNOWN_MODEL_PRICE.outputPerM,
    );
  });

  test('ownAiMayCall reserves in ONE conditional upsert and returns the reservation', async () => {
    queue.execute.push([{ day: '2026-11-09' }]);
    const res = await ownAiMayCall(AVATAR, 'gpt-4o', { inputTokens: 1000, outputTokens: 200 });
    expect(res).toEqual({ microUsd: 4500, day: '2026-11-09' });
    expect(recorded.length).toBe(1);
    const q = render(recorded[0]!.calls[0]!.args[0]);
    expect(q.sql).toContain('INSERT INTO agent_ai_usage AS u');
    expect(q.sql).toContain('ON CONFLICT (avatar_id, day) DO UPDATE');
    expect(q.sql).toContain('reserved_micro_usd = u.reserved_micro_usd + EXCLUDED.reserved_micro_usd');
    expect(q.sql).toContain('WHERE u.estimated_micro_usd + u.reserved_micro_usd + EXCLUDED.reserved_micro_usd');
    expect(q.sql).toContain(`NOT IN ('key_rejected', 'balance_empty', 'model_unavailable')`);
    expect(q.params).toContain(4500);
    expect(q.params).toContain(AVATAR);
  });

  test('ownAiMayCall refused by the spent estimate records daily_limit once, idempotent per UTC day in SQL', async () => {
    queue.select.push([{ source: 'own_key', dailyLimitCents: 100, fallbackReason: null, estimatedMicroUsd: 1_000_000, reservedMicroUsd: 0 }]);
    expect(await ownAiMayCall(AVATAR, 'gpt-4o', { inputTokens: 10, outputTokens: 10 })).toBeNull();
    const upd = recorded.find((r) => r.op === 'update')!;
    expect(upd.calls.find((c) => c.name === 'set')!.args[0]).toMatchObject({ fallbackReason: 'daily_limit' });
    const where = render(upd.calls.find((c) => c.name === 'where')!.args[0]);
    expect(where.sql).toContain(`IS DISTINCT FROM 'daily_limit'`);
    expect(where.sql).toContain(`AT TIME ZONE 'UTC')::date <> (now() AT TIME ZONE 'UTC')::date`);
    expect(where.sql).toContain(`NOT IN ('key_rejected', 'balance_empty', 'model_unavailable')`);
  });

  test('ownAiMayCall refused only by in-flight reservations writes nothing', async () => {
    queue.select.push([{ source: 'own_key', dailyLimitCents: 100, fallbackReason: null, estimatedMicroUsd: 0, reservedMicroUsd: 999_999 }]);
    expect(await ownAiMayCall(AVATAR, 'gpt-4o', { inputTokens: 10, outputTokens: 10 })).toBeNull();
    expect(recorded.some((r) => r.op === 'update')).toBe(false);
  });

  test('concurrency: N parallel reservations near the limit, only the ones that fit pass', async () => {
    // The fake executes each reservation statement ATOMICALLY in arrival order,
    // the way Postgres serializes ON CONFLICT DO UPDATE on the locked row, and
    // evaluates the statement's own condition (estimated + reserved + estimate
    // <= limit). The rendered SQL is asserted above; this checks the service
    // admits exactly the calls that fit and nothing more.
    const limitMicro = 100 * 10_000; // $1.00
    let spent = 900_000;
    let reservedTotal = 0;
    const origExecute = fakeDb.execute;
    fakeDb.execute = async (q: unknown) => {
      const { params } = render(q);
      const est = params.find((v) => typeof v === 'number') as number;
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)));
      if (spent + reservedTotal + est <= limitMicro) {
        reservedTotal += est;
        return [{ day: '2026-11-09' }];
      }
      return [];
    };
    try {
      // Each call: gpt-4o, 1000 in + 200 out = 4500 micro-USD. Room = 100_000 -> 22 fit.
      for (let i = 0; i < 40; i++) {
        queue.select.push([{ source: 'own_key', dailyLimitCents: 100, fallbackReason: null, estimatedMicroUsd: spent, reservedMicroUsd: reservedTotal }]);
      }
      const results = await Promise.all(
        Array.from({ length: 40 }, () => ownAiMayCall(AVATAR, 'gpt-4o', { inputTokens: 1000, outputTokens: 200 })),
      );
      const passed = results.filter((r) => r !== null);
      expect(passed.length).toBe(Math.floor((limitMicro - spent) / 4500));
      expect(reservedTotal).toBe(passed.length * 4500);
      expect(spent + reservedTotal).toBeLessThanOrEqual(limitMicro);
      // A released reservation frees room for the next call.
      reservedTotal -= 4500;
      expect(await ownAiMayCall(AVATAR, 'gpt-4o', { inputTokens: 1000, outputTokens: 200 })).not.toBeNull();
    } finally {
      fakeDb.execute = origExecute;
    }
  });
});

describe('metered key test call', () => {
  test('the test estimate: 32 input tokens; 8 output, 512 for a reasoning model', () => {
    expect(ownAiTestEstimate('openai', 'gpt-4.1')).toEqual({ inputTokens: 32, outputTokens: 8 });
    expect(ownAiTestEstimate('openai', 'gpt-5.1')).toEqual({ inputTokens: 32, outputTokens: 512 });
  });

  test('reserveOwnAiTestCall: one conditional upsert against the stored limit, else the requested one', async () => {
    queue.execute.push([{ day: '2026-11-09' }]);
    const res = await reserveOwnAiTestCall(AVATAR, 'gpt-4o', { inputTokens: 32, outputTokens: 8 }, 200);
    expect(res).toEqual({ microUsd: 32 * 2.5 + 8 * 10, day: '2026-11-09' });
    expect(recorded.length).toBe(1);
    const q = render(recorded[0]!.calls[0]!.args[0]);
    expect(q.sql).toContain('INSERT INTO agent_ai_usage AS u');
    expect(q.sql).toContain('COALESCE((SELECT s.daily_limit_cents FROM agent_ai_settings s WHERE s.avatar_id = $');
    expect(q.sql).toContain('WHERE u.estimated_micro_usd + u.reserved_micro_usd + EXCLUDED.reserved_micro_usd <=');
    expect(q.params).toContain(200);
    // No source or sticky-fallback condition: a save is how the human fixes those.
    expect(q.sql).not.toContain('NOT IN');
    recorded = [];
    expect(await reserveOwnAiTestCall(AVATAR, 'gpt-4o', { inputTokens: 32, outputTokens: 8 }, 7)).toBeNull();
    expect(render(recorded[0]!.calls[0]!.args[0]).params).not.toContain(7); // an invalid request limit is never used
  });

  test('runMeteredOwnAiKeyTest: no room -> daily_limit_reached and NO provider call', async () => {
    const r = await runMeteredOwnAiKeyTest(AVATAR, 'openai', OPENAI_KEY, 'gpt-4.1', 200);
    expect(r).toEqual({ ok: false, code: 'daily_limit_reached' });
    expect(fetchCalls).toHaveLength(0);
    expect(recorded.filter((x) => x.op !== 'execute')).toHaveLength(0);
  });

  test('runMeteredOwnAiKeyTest: a working key settles the reservation on its day; a refused key releases it', async () => {
    queue.execute.push([{ day: '2026-11-09' }]);
    fetchReply = () => json({ choices: [{ message: { content: 'OK' } }] });
    expect(await runMeteredOwnAiKeyTest(AVATAR, 'openai', OPENAI_KEY, 'gpt-4.1', 200)).toEqual({ ok: true });
    expect(fetchCalls).toHaveLength(1);
    const ins = recorded.find((x) => x.op === 'insert')!;
    const values = ins.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
    expect(values).toMatchObject({ calls: 1, inputTokens: 32, outputTokens: 8 });
    expect(render(values.day).params).toEqual(['2026-11-09']);

    recorded = [];
    fetchCalls = [];
    queue.execute.push([{ day: '2026-11-09' }]);
    fetchReply = () => json({ error: 'bad key' }, 401);
    const bad = await runMeteredOwnAiKeyTest(AVATAR, 'openai', OPENAI_KEY, 'gpt-4.1', 200);
    expect(bad.ok).toBe(false);
    expect(recorded.some((x) => x.op === 'insert')).toBe(false);
    const upd = recorded.find((x) => x.op === 'update')!;
    expect(render((upd.calls.find((c) => c.name === 'set')!.args[0] as Record<string, unknown>).reservedMicroUsd).sql).toContain('GREATEST(');
  });
});

describe('meter', () => {
  test('recordOwnAiUsage settles on the RESERVATION day: one upsert adds the real cost there and subtracts THE reservation', async () => {
    await recordOwnAiUsage(AVATAR, 'openai/gpt-4o', 1_000, 0, { microUsd: 7_000, day: '2026-11-09' });
    const ins = recorded.find((r) => r.op === 'insert')!;
    const values = ins.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
    expect(render(values.day).sql).toBe('$1::date');
    expect(render(values.day).params).toEqual(['2026-11-09']);
    const conflict = ins.calls.find((c) => c.name === 'onConflictDoUpdate')!.args[0] as { set: Record<string, unknown> };
    const reserved = render(conflict.set.reservedMicroUsd);
    expect(reserved.sql).toContain('GREATEST("agent_ai_usage"."reserved_micro_usd" - $');
    expect(reserved.params).toEqual([7_000]);
    expect(render(conflict.set.estimatedMicroUsd).params).toEqual([2_500]);
    expect(recorded.filter((r) => r.op === 'insert').length).toBe(1);
  });

  test('midnight: a call reserved before 00:00 UTC and settled after it is charged to, and released on, the reservation day', async () => {
    try {
      // The DB answers the reservation with its day (RETURNING u.day).
      setSystemTime(new Date('2026-11-09T23:59:59.500Z'));
      queue.execute.push([{ day: '2026-11-09' }]);
      const res = await ownAiMayCall(AVATAR, 'gpt-4o', { inputTokens: 1000, outputTokens: 200 });
      expect(res).toEqual({ microUsd: 4500, day: '2026-11-09' });
      // The clock passes midnight before the call finishes.
      setSystemTime(new Date('2026-11-10T00:00:01.000Z'));
      recorded = [];
      await recordOwnAiUsage(AVATAR, 'gpt-4o', 900, 100, res);
      const values = recorded[0]!.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
      expect(render(values.day).params).toEqual(['2026-11-09']);
      expect(render(values.day).sql).not.toContain('now()');
      recorded = [];
      await releaseOwnAiReservation(AVATAR, res);
      expect(render(recorded[0]!.calls.find((c) => c.name === 'where')!.args[0]).params).toEqual([AVATAR, '2026-11-09']);
    } finally {
      setSystemTime();
    }
  });

  test('a settle without a reservation lands on today (DB clock)', async () => {
    await recordOwnAiUsage(AVATAR, 'gpt-4o', 10, 0);
    const values = recorded[0]!.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
    expect(render(values.day).sql).toContain(`(now() AT TIME ZONE 'UTC')::date`);
  });

  test('recordOwnAiUsage without a reservation subtracts nothing', async () => {
    await recordOwnAiUsage(AVATAR, 'gpt-4o', 10, 0);
    const conflict = recorded[0]!.calls.find((c) => c.name === 'onConflictDoUpdate')!.args[0] as { set: Record<string, unknown> };
    expect(render(conflict.set.reservedMicroUsd).sql).not.toContain('GREATEST');
  });

  test('releaseOwnAiReservation is one clamped UPDATE on the reservation day; a bad reservation writes nothing', async () => {
    await releaseOwnAiReservation(AVATAR, { microUsd: 4_500, day: '2026-11-09' });
    expect(recorded.length).toBe(1);
    const upd = recorded[0]!;
    const set = upd.calls.find((c) => c.name === 'set')!.args[0] as Record<string, unknown>;
    expect(render(set.reservedMicroUsd).sql).toContain('GREATEST(');
    expect(render(set.reservedMicroUsd).params).toEqual([4_500]);
    expect(render(upd.calls.find((c) => c.name === 'where')!.args[0]).params).toEqual([AVATAR, '2026-11-09']);
    recorded = [];
    await releaseOwnAiReservation(AVATAR, { microUsd: -1, day: '2026-11-09' });
    await releaseOwnAiReservation(AVATAR, { microUsd: 5, day: 'nope' });
    await releaseOwnAiReservation(AVATAR, null);
    expect(recorded.length).toBe(0);
  });

  test('recordOwnAiUsage is one atomic upsert-add with integer micro-USD, then clears provider_error only', async () => {
    await recordOwnAiUsage(AVATAR, 'openai/gpt-4o', 1_000_000, 0);
    const ins = recorded.find((r) => r.op === 'insert')!;
    const values = ins.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
    expect(values).toMatchObject({ calls: 1, inputTokens: 1_000_000, outputTokens: 0, estimatedMicroUsd: 2_500_000 });
    const conflict = ins.calls.find((c) => c.name === 'onConflictDoUpdate')!.args[0] as { set: Record<string, unknown> };
    expect(render(conflict.set.calls).sql).toContain('"calls" + 1');
    expect(render(conflict.set.estimatedMicroUsd).sql).toContain('"estimated_micro_usd" +');
    expect(render(conflict.set.estimatedMicroUsd).params).toEqual([2_500_000]);
    const upd = recorded.find((r) => r.op === 'update')!;
    const where = render(upd.calls.find((c) => c.name === 'where')!.args[0]);
    expect(where.params).toContain('provider_error');
  });

  test('unknown model is metered at the conservative price; bad token counts become 0', async () => {
    await recordOwnAiUsage(AVATAR, 'acme/new-model', 1000, 1000);
    const values = recorded[0]!.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
    expect(values.estimatedMicroUsd).toBe(1000 * OWN_AI_UNKNOWN_MODEL_PRICE.inputPerM + 1000 * OWN_AI_UNKNOWN_MODEL_PRICE.outputPerM);
    recorded = [];
    await recordOwnAiUsage(AVATAR, 'gpt-4o', Number.NaN, -3);
    const v2 = recorded[0]!.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
    expect(v2).toMatchObject({ inputTokens: 0, outputTokens: 0, estimatedMicroUsd: 0 });
  });

  test('a passing fallback never replaces a sticky one; a sticky one can', async () => {
    await recordOwnAiFallback(AVATAR, 'provider_error');
    expect(render(recorded[0]!.calls.find((c) => c.name === 'where')!.args[0]).sql).toContain(`NOT IN ('key_rejected', 'balance_empty', 'model_unavailable')`);
    recorded = [];
    await recordOwnAiFallback(AVATAR, 'key_rejected');
    expect(render(recorded[0]!.calls.find((c) => c.name === 'where')!.args[0]).sql).not.toContain('NOT IN');
    recorded = [];
    await recordOwnAiFallback(AVATAR, 'nonsense' as never);
    expect(recorded.length).toBe(0);
  });
});

describe('status', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const row = {
    source: 'own_key',
    provider: 'openai',
    model: 'gpt-4.1',
    speedSeconds: 15,
    dailyLimitCents: 100,
    keyLast4: 'cdef',
    usepodTokenLast4: null as string | null,
    usepodRegistered: false,
    fallbackReason: null as string | null,
    fallbackAt: null as Date | null,
    updatedAt: now,
  };

  test('defaults with no row', () => {
    const s = buildOwnAiStatus(null, null, now);
    expect(s).toMatchObject({ source: 'clawville', activeNow: 'clawville', speedSeconds: 25, keyLast4: null });
  });

  test('activeNow per fallback reason', () => {
    expect(buildOwnAiStatus(row, null, now).activeNow).toBe('own');
    expect(buildOwnAiStatus({ ...row, source: 'clawville' }, null, now).activeNow).toBe('clawville');
    expect(buildOwnAiStatus({ ...row, fallbackReason: 'key_rejected', fallbackAt: now }, null, now).activeNow).toBe('clawville');
    expect(buildOwnAiStatus({ ...row, fallbackReason: 'balance_empty', fallbackAt: now }, null, now).activeNow).toBe('clawville');
    expect(buildOwnAiStatus({ ...row, fallbackReason: 'daily_limit', fallbackAt: now }, null, now).activeNow).toBe('clawville');
    const yesterday = new Date('2026-11-08T23:59:00Z');
    expect(buildOwnAiStatus({ ...row, fallbackReason: 'daily_limit', fallbackAt: yesterday }, null, now).activeNow).toBe('own');
    expect(buildOwnAiStatus({ ...row, fallbackReason: 'provider_error', fallbackAt: now }, null, now).activeNow).toBe('own');
  });

  test('today usage and estimated cents; at the limit = clawville', () => {
    const usage = { calls: 3, inputTokens: 9000, outputTokens: 600, estimatedMicroUsd: 1_000_000 };
    const s = buildOwnAiStatus(row, usage, now);
    expect(s.today).toEqual({ calls: 3, inputTokens: 9000, outputTokens: 600, estimatedCents: 100 });
    expect(s.activeNow).toBe('clawville');
    expect(buildOwnAiStatus(row, { ...usage, estimatedMicroUsd: 999_999 }, now).activeNow).toBe('own');
  });

  test('status never carries a key or a dashboard link', () => {
    const s = JSON.stringify(buildOwnAiStatus({ ...row, provider: 'usepod', source: 'usepod', keyLast4: TOKEN.slice(-4) }, null, now));
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain('dashboard');
  });
});

describe('save and clear', () => {
  test('save encrypts the key under the spend-rules lock and emits after commit', async () => {
    const seen: string[] = [];
    const off = onOwnAiSettingsChanged((id) => seen.push(id));
    queue.select.push([]); // stored row (none)
    queue.select.push([{ ...{ source: 'own_key', provider: 'openai', model: 'gpt-4.1', speedSeconds: 25, dailyLimitCents: 100, keyLast4: 'cdef', usepodRegistered: false, fallbackReason: null, fallbackAt: null, updatedAt: new Date() } }]);
    queue.select.push([]); // usage
    const s = await saveOwnAiSettings(AVATAR, USER, { source: 'own_key', provider: 'openai', model: 'gpt-4.1', dailyLimitCents: 100, key: OPENAI_KEY });
    off();
    expect(recorded[0]!.op).toBe('execute');
    expect(render(recorded[0]!.calls[0]!.args[0]).params).toEqual([`spend-policy:${AVATAR}`]);
    const ins = recorded.find((r) => r.op === 'insert')!;
    const values = ins.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
    expect(values).toMatchObject({ keyEnc: sealed(OPENAI_KEY), keyLast4: 'cdef', fallbackReason: null, updatedByUserId: USER });
    expect(JSON.stringify(values)).not.toContain(OPENAI_KEY);
    expect(seen).toEqual([AVATAR]);
    expect(JSON.stringify(s)).not.toContain(OPENAI_KEY);
  });

  test('a refused save writes nothing and emits nothing', async () => {
    const seen: string[] = [];
    const off = onOwnAiSettingsChanged((id) => seen.push(id));
    queue.select.push([]);
    await expectCodeAsync(
      saveOwnAiSettings(AVATAR, USER, { source: 'own_key', provider: 'openai', model: 'gpt-4.1', dailyLimitCents: 5, key: OPENAI_KEY }),
      'invalid_daily_limit',
      [OPENAI_KEY],
    );
    off();
    expect(recorded.some((r) => r.op === 'insert')).toBe(false);
    expect(seen).toEqual([]);
  });

  test('clear wipes the key and keeps the limit', async () => {
    await clearOwnAi(AVATAR);
    const upd = recorded.find((r) => r.op === 'update')!;
    const set = upd.calls.find((c) => c.name === 'set')!.args[0] as Record<string, unknown>;
    expect(set).toMatchObject({ source: 'clawville', provider: null, model: null, keyEnc: null, keyLast4: null });
    expect('dailyLimitCents' in set).toBe(false);
    for (const k of ['usepodRegistered', 'usepodTokenEnc', 'usepodTokenIv', 'usepodTokenTag', 'usepodTokenLast4']) expect(k in set).toBe(false);
  });
});

describe('runtime config', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    source: 'own_key',
    provider: 'openai',
    model: 'gpt-5.1',
    speedSeconds: 10,
    fallbackReason: null,
    usepodRegistered: false,
    keyEnc: sealed(OPENAI_KEY),
    keyIv: 'iv',
    keyTag: 'tag',
    usepodTokenEnc: null,
    usepodTokenIv: null,
    usepodTokenTag: null,
    ...over,
  });

  test('own key: fixed base URL, reasoning floor and timeout', async () => {
    queue.select.push([stored()]);
    const cfg = await loadOwnAiRuntimeConfig(AVATAR);
    expect(cfg).toMatchObject({
      provider: 'openai',
      protocol: 'openai-compat',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: OPENAI_KEY,
      reasoning: true,
      maxTokensFloor: 2000,
      timeoutMs: 45_000,
      speedSeconds: 10,
    });
  });

  test('usepod: token in the fixed proxy path', async () => {
    queue.select.push([stored({ source: 'usepod', provider: 'usepod', model: 'gpt-oss-120b', keyEnc: sealed(TOKEN) })]);
    const cfg = await loadOwnAiRuntimeConfig(AVATAR);
    expect(cfg?.baseUrl).toBe(`https://api.usepod.ai/proxy/${TOKEN}/v1`);
    expect(cfg?.reasoning).toBe(false);
    expect(cfg?.timeoutMs).toBe(20_000);
  });

  test('null for clawville, a mismatched source, or a key that does not decrypt', async () => {
    queue.select.push([stored({ source: 'clawville' })]);
    expect(await loadOwnAiRuntimeConfig(AVATAR)).toBeNull();
    queue.select.push([stored({ source: 'usepod' })]);
    expect(await loadOwnAiRuntimeConfig(AVATAR)).toBeNull();
    const restore = setOwnAiDepsForTest({ decrypt: () => { throw new Error('bad tag'); } });
    queue.select.push([stored()]);
    expect(await loadOwnAiRuntimeConfig(AVATAR)).toBeNull();
    restore();
    queue.select.push([]);
    expect(await loadOwnAiRuntimeConfig(AVATAR)).toBeNull();
  });
});

describe('provider calls', () => {
  test('status mapping', () => {
    expect(mapProviderStatus(200, 'test')).toBeNull();
    expect(mapProviderStatus(401, 'test')).toBe('key_rejected');
    expect(mapProviderStatus(403, 'models')).toBe('key_rejected');
    expect(mapProviderStatus(402, 'test')).toBe('balance_empty');
    expect(mapProviderStatus(404, 'test')).toBe('model_unavailable');
    expect(mapProviderStatus(400, 'test')).toBe('model_unavailable');
    expect(mapProviderStatus(400, 'models')).toBe('provider_error');
    expect(mapProviderStatus(404, 'balance')).toBe('key_rejected');
    expect(mapProviderStatus(429, 'models')).toBe('rate_limited');
    expect(mapProviderStatus(302, 'models')).toBe('provider_error');
    expect(mapProviderStatus(503, 'test')).toBe('provider_error');
  });

  test('key pattern refused before any fetch', async () => {
    await expectCodeAsync(listProviderModels('openai', 'not-a-key'), 'invalid_key', ['not-a-key']);
    await expectCodeAsync(listProviderModels('usepod', '../../v1/register'), 'invalid_key');
    await expectCodeAsync(listProviderModels('evil' as never, OPENAI_KEY), 'invalid_provider', [OPENAI_KEY]);
    expect(await testOwnAiKey('anthropic', OPENAI_KEY, 'claude-sonnet-4-5')).toEqual({ ok: false, code: 'invalid_key' });
    expect(fetchCalls.length).toBe(0);
  });

  test('models list: fixed host, no redirects, sanitized, capped at 200', async () => {
    const ids = [
      { id: 'gpt-4.1' },
      { id: 'gpt-4.1' },
      { id: 'evil\u0000model' },
      { id: 'x'.repeat(200) },
      { id: 'has space' },
      { id: 42 },
      ...Array.from({ length: 300 }, (_, i) => ({ id: `m-${i}` })),
    ];
    fetchReply = () => json({ data: ids });
    const list = await listProviderModels('openrouter', OPENROUTER_KEY);
    expect(list.length).toBe(200);
    expect(list[0]).toBe('gpt-4.1');
    expect(list[1]).toBe('evilmodel');
    expect(list).not.toContain('has space');
    const call = fetchCalls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/models');
    expect(call.init.redirect).toBe('manual');
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
    expect((call.init.headers as Record<string, string>)['X-Title']).toBe('ClawVille');
  });

  test('anthropic models: x-api-key + version + page size', async () => {
    fetchReply = () => json({ data: [{ id: 'claude-sonnet-4-5' }] });
    expect(await listProviderModels('anthropic', ANTHROPIC_KEY)).toEqual(['claude-sonnet-4-5']);
    expect(fetchCalls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    const h = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(h['anthropic-version']).toBe('2023-06-01');
  });

  test('usepod models: the token is never sent as a header', async () => {
    fetchReply = () => json({ data: [{ id: 'gpt-oss-120b' }] });
    await listProviderModels('usepod', TOKEN);
    expect(fetchCalls[0]!.url).toBe(`https://api.usepod.ai/proxy/${TOKEN}/v1/models`);
    expect(JSON.stringify(fetchCalls[0]!.init.headers)).not.toContain(TOKEN);
  });

  test('provider error bodies that echo the key never reach the error', async () => {
    fetchReply = () => json({ error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } }, 401);
    await expectCodeAsync(listProviderModels('openai', OPENAI_KEY), 'key_rejected', [OPENAI_KEY]);
    const r = await testOwnAiKey('openai', OPENAI_KEY, 'gpt-4.1');
    expect(r).toEqual({ ok: false, code: 'key_rejected' });
    expect(JSON.stringify(r)).not.toContain(OPENAI_KEY);
    fetchReply = () => new Response(`upstream said ${OPENAI_KEY}`, { status: 500 });
    await expectCodeAsync(listProviderModels('openai', OPENAI_KEY), 'provider_error', [OPENAI_KEY]);
    fetchReply = () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } });
    await expectCodeAsync(listProviderModels('openai', OPENAI_KEY), 'provider_error');
    fetchReply = () => { throw new TypeError(`connect failed https://api.usepod.ai/proxy/${TOKEN}/v1/models`); };
    await expectCodeAsync(listProviderModels('usepod', TOKEN), 'provider_error', [TOKEN]);
    fetchReply = () => new Response('not json');
    await expectCodeAsync(listProviderModels('openai', OPENAI_KEY), 'provider_error');
  });

  test('timeout maps to timeout', async () => {
    fetchReply = (_u, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
    try {
      await expectCodeAsync(listProviderModels('openai', OPENAI_KEY), 'timeout');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test('response size cap', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024);
    fetchReply = () => new Response(big);
    await expectCodeAsync(listProviderModels('openai', OPENAI_KEY), 'provider_error');
  });

  test('test call: payload per provider and the error codes', async () => {
    fetchReply = () => json({ ok: true });
    expect(await testOwnAiKey('openai', OPENAI_KEY, 'gpt-4.1')).toEqual({ ok: true });
    expect(fetchCalls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(String(fetchCalls[0]!.init.body))).toMatchObject({ model: 'gpt-4.1', max_completion_tokens: 8 });
    expect(await testOwnAiKey('anthropic', ANTHROPIC_KEY, 'claude-haiku-4-5')).toEqual({ ok: true });
    expect(fetchCalls[1]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.parse(String(fetchCalls[1]!.init.body))).toMatchObject({ max_tokens: 8 });
    expect(await testOwnAiKey('openrouter', OPENROUTER_KEY, 'google/gemini-2.5-pro')).toEqual({ ok: true });
    expect(JSON.parse(String(fetchCalls[2]!.init.body))).toMatchObject({ max_tokens: 512 });
    fetchReply = () => json({ error: 'no such model' }, 404);
    expect(await testOwnAiKey('openai', OPENAI_KEY, 'gpt-9')).toEqual({ ok: false, code: 'model_unavailable' });
    fetchReply = () => json({ error: 'pay' }, 402);
    expect(await testOwnAiKey('usepod', TOKEN, 'gpt-oss-120b')).toEqual({ ok: false, code: 'balance_empty' });
    fetchReply = () => json({}, 429);
    expect(await testOwnAiKey('openai', OPENAI_KEY, 'gpt-4.1')).toEqual({ ok: false, code: 'rate_limited' });
    expect(await testOwnAiKey('openai', OPENAI_KEY, 'bad model')).toEqual({ ok: false, code: 'invalid_model' });
  });

  test('sanitizeModelList refuses a non-list', () => {
    expectCode(() => sanitizeModelList({ models: [] }), 'provider_error');
    expectCode(() => sanitizeModelList(null), 'provider_error');
  });
});

describe('UsePod', () => {
  const goodReply = {
    api_token: TOKEN,
    deposit_code: 'abcdef0123456789',
    status: 'pending_deposit',
    instructions: { contract_address: CONTRACT, dashboard_url: `https://usepod.ai/dashboard/${TOKEN}` },
  };

  test('register response validation', () => {
    expect(parseUsepodRegisterResponse(goodReply)).toEqual({ token: TOKEN, depositCode: 'abcdef0123456789', contractAddress: CONTRACT });
    const bad = (patch: Record<string, unknown>, instr: Record<string, unknown> = {}) =>
      ({ ...goodReply, ...patch, instructions: { ...goodReply.instructions, ...instr } });
    expectCode(() => parseUsepodRegisterResponse(bad({ api_token: '../x' })), 'provider_error');
    expectCode(() => parseUsepodRegisterResponse(bad({ deposit_code: 'a b' })), 'provider_error');
    expect(parseUsepodRegisterResponse(bad({ deposit_code: 'ABCDEF0123456789' })).depositCode).toBe('abcdef0123456789');
    expectCode(() => parseUsepodRegisterResponse(bad({}, { contract_address: '0xabc' })), 'provider_error');
    for (const url of [
      `http://usepod.ai/dashboard/${TOKEN}`,
      `https://usepod.ai.evil.com/dashboard/${TOKEN}`,
      `https://evil.com/usepod.ai/${TOKEN}`,
      `https://user:pw@usepod.ai/dashboard/${TOKEN}`,
      `https://usepod.ai:8443/dashboard/${TOKEN}`,
      `javascript:alert(1)`,
      42,
    ]) {
      expect(isUsepodDashboardUrl(url)).toBe(false);
      expectCode(() => parseUsepodRegisterResponse(bad({}, { dashboard_url: url })), 'provider_error');
    }
    expectCode(() => parseUsepodRegisterResponse(bad({}, { contract_address: '11111111111111111111111111111111' })), 'provider_error');
    expectCode(() => parseUsepodRegisterResponse(null), 'provider_error');
  });

  test('register: POST with no body, token stored encrypted, canonical link returned', async () => {
    const seen: string[] = [];
    const off = onOwnAiSettingsChanged((id) => seen.push(id));
    fetchReply = () => json(goodReply);
    queue.select.push([]); // pre-check
    queue.select.push([]); // in-lock check
    const r = await registerUsepodToken(AVATAR, USER);
    off();
    expect(r).toEqual({ dashboardUrl: `https://usepod.ai/dashboard/${TOKEN}`, depositCode: 'abcdef0123456789', contractAddress: CONTRACT });
    expect(fetchCalls[0]!.url).toBe('https://api.usepod.ai/v1/register');
    expect(fetchCalls[0]!.init.method).toBe('POST');
    expect(fetchCalls[0]!.init.body).toBeUndefined();
    const values = recorded.find((x) => x.op === 'insert')!.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
    expect(values).toMatchObject({ usepodTokenEnc: sealed(TOKEN), usepodTokenLast4: TOKEN.slice(-4), usepodRegistered: true, usepodDepositCode: goodReply.deposit_code });
    // The own-key slot, the source, the provider and the model are never touched by register.
    for (const k of ['keyEnc', 'keyIv', 'keyTag', 'keyLast4', 'source', 'provider', 'model']) expect(k in values).toBe(false);
    expect(seen).toEqual([AVATAR]);
  });

  test('register refused when a registered token exists (no fetch)', async () => {
    queue.select.push([{ usepodRegistered: true }]);
    await expectCodeAsync(registerUsepodToken(AVATAR, USER), 'usepod_already_registered');
    expect(fetchCalls.length).toBe(0);
  });

  test('register with a bad reply stores nothing', async () => {
    fetchReply = () => json({ ...goodReply, instructions: { ...goodReply.instructions, dashboard_url: 'https://evil.com/' } });
    queue.select.push([]);
    await expectCodeAsync(registerUsepodToken(AVATAR, USER), 'provider_error', [TOKEN]);
    expect(recorded.some((x) => x.op === 'insert')).toBe(false);
  });

  test('dashboard link and balance from the stored token', async () => {
    const row = {
      source: 'own_key', provider: 'openai', model: 'gpt-4.1', speedSeconds: 25, fallbackReason: null,
      keyEnc: sealed(OPENAI_KEY), keyIv: 'iv', keyTag: 'tag',
      usepodRegistered: true, usepodTokenEnc: sealed(TOKEN), usepodTokenIv: 'iv', usepodTokenTag: 'tag',
    };
    queue.select.push([row]);
    expect(await readUsepodDashboardLink(AVATAR)).toBe(`https://usepod.ai/dashboard/${TOKEN}`);
    // A pasted token (own-key slot) never yields a dashboard link.
    queue.select.push([{ ...row, provider: 'usepod', keyEnc: sealed(TOKEN), usepodRegistered: false, usepodTokenEnc: null }]);
    expect(await readUsepodDashboardLink(AVATAR)).toBeNull();

    const seen: string[] = [];
    const off = onOwnAiSettingsChanged((id) => seen.push(id));
    queue.select.push([row]);
    queue.update.push([{ avatarId: AVATAR }]);
    fetchReply = () => json({ api_token: TOKEN, usdc_balance: 5_000_000, credit_balance: 0, is_active: true });
    expect(await readUsepodBalance(AVATAR)).toEqual({ usdcMicro: 5_000_000, isActive: true });
    off();
    expect(fetchCalls[0]!.url).toBe(`https://api.usepod.ai/proxy/${TOKEN}/balance`);
    expect(seen).toEqual([AVATAR]);

    queue.select.push([row]);
    fetchReply = () => json({ error: `token ${TOKEN} unknown` }, 401);
    await expectCodeAsync(readUsepodBalance(AVATAR), 'key_rejected', [TOKEN]);
  });

  test('balance reply validation', () => {
    expect(parseUsepodBalance({ usdc_balance: 0, is_active: false })).toEqual({ usdcMicro: 0, isActive: false });
    expectCode(() => parseUsepodBalance({ usdc_balance: '5', is_active: true }), 'provider_error');
    expectCode(() => parseUsepodBalance({ usdc_balance: -1, is_active: true }), 'provider_error');
    expectCode(() => parseUsepodBalance({ usdc_balance: 1.5, is_active: true }), 'provider_error');
    expectCode(() => parseUsepodBalance({ usdc_balance: 1 }), 'provider_error');
  });
});

describe('lead follow-up: sticky reasons, active-now read, raise race, registered UsePod token', () => {
  const stored = { provider: 'openai', speedSeconds: 25, dailyLimitCents: 100, hasKey: true, usepodRegistered: false };
  const save = { source: 'own_key' as const, provider: 'openai' as const, model: 'gpt-4.1' };

  test('model_unavailable is sticky: gate closed, status clawville, never replaced by a passing reason', async () => {
    expect(decideOwnAiMayCall({ source: 'own_key', dailyLimitCents: 100, fallbackReason: 'model_unavailable', estimatedMicroUsd: 0 })).toEqual({
      allow: false,
      recordDailyLimit: false,
    });
    const active = { source: 'own_key', dailyLimitCents: 100, fallbackAt: new Date(), estimatedMicroUsd: 0 };
    for (const r of ['key_rejected', 'balance_empty', 'model_unavailable']) {
      expect(computeOwnAiActiveNow({ ...active, fallbackReason: r })).toBe('clawville');
    }
    expect(computeOwnAiActiveNow({ ...active, fallbackReason: 'provider_error' })).toBe('own');
    expect(computeOwnAiActiveNow({ ...active, fallbackReason: null })).toBe('own');
    expect(computeOwnAiActiveNow({ ...active, fallbackReason: null, estimatedMicroUsd: 1_000_000 })).toBe('clawville');
    expect(computeOwnAiActiveNow(null)).toBe('clawville');
    await recordOwnAiFallback(AVATAR, 'model_unavailable');
    expect(render(recorded[0]!.calls.find((c) => c.name === 'where')!.args[0]).sql).not.toContain('NOT IN');
  });

  test('ownAiActiveNow is one row read', async () => {
    queue.select.push([{ source: 'own_key', dailyLimitCents: 100, fallbackReason: null, fallbackAt: null, estimatedMicroUsd: 0 }]);
    expect(await ownAiActiveNow(AVATAR)).toBe('own');
    queue.select.push([{ source: 'own_key', dailyLimitCents: 100, fallbackReason: 'model_unavailable', fallbackAt: new Date(), estimatedMicroUsd: 0 }]);
    expect(await ownAiActiveNow(AVATAR)).toBe('clawville');
    queue.select.push([]);
    expect(await ownAiActiveNow(AVATAR)).toBe('clawville');
    expect(recorded.filter((r) => r.op === 'select').length).toBe(3);
    expect(recorded.some((r) => r.op !== 'select')).toBe(false);
  });

  test('a limit raise needs limitRaiseProven; lowering, keeping and a first limit do not', () => {
    expectCode(() => resolveOwnAiSave({ ...save, dailyLimitCents: 101 }, stored), 'raise_needs_signature');
    expectCode(() => resolveOwnAiSave({ ...save, dailyLimitCents: 101, limitRaiseProven: false }, stored), 'raise_needs_signature');
    expect(new OwnAiError('raise_needs_signature').httpStatus).toBe(403);
    expect(resolveOwnAiSave({ ...save, dailyLimitCents: 101, limitRaiseProven: true }, stored).dailyLimitCents).toBe(101);
    expect(resolveOwnAiSave({ ...save, dailyLimitCents: 100 }, stored).dailyLimitCents).toBe(100);
    expect(resolveOwnAiSave({ ...save, dailyLimitCents: 50 }, stored).dailyLimitCents).toBe(50);
    expect(resolveOwnAiSave({ ...save }, stored).dailyLimitCents).toBe(100);
    expect(resolveOwnAiSave({ ...save, dailyLimitCents: 50_000, key: OPENAI_KEY }, null).dailyLimitCents).toBe(50_000);
  });

  test('the raise check runs on the row read inside the spend-rules lock', async () => {
    queue.select.push([{ provider: 'openai', speedSeconds: 25, dailyLimitCents: 100, keyEnc: 'x', usepodRegistered: false }]);
    await expectCodeAsync(saveOwnAiSettings(AVATAR, USER, { ...save, dailyLimitCents: 5000 }), 'raise_needs_signature');
    expect(recorded[0]!.op).toBe('execute');
    expect(recorded[1]!.op).toBe('select');
    expect(recorded.some((r) => r.op === 'insert')).toBe(false);
  });

  test('source usepod with a registered token: the key slot is wiped, a pasted key is refused', () => {
    const reg = { provider: 'openai', speedSeconds: 25, dailyLimitCents: 100, hasKey: true, usepodRegistered: true };
    const r = resolveOwnAiSave({ source: 'usepod', provider: 'usepod', model: 'gpt-oss-120b' }, reg);
    expect(r).toMatchObject({ keyAction: 'wipe', newKey: null });
    expectCode(() => resolveOwnAiSave({ source: 'usepod', provider: 'usepod', model: 'gpt-oss-120b', key: TOKEN }, reg), 'usepod_token_registered');
    expect(resolveOwnAiSave({ ...save, key: OPENAI_KEY }, reg).keyAction).toBe('set');
    const pasted = { provider: 'usepod', speedSeconds: 25, dailyLimitCents: 100, hasKey: true, usepodRegistered: false };
    expect(resolveOwnAiSave({ source: 'usepod', provider: 'usepod', model: 'gpt-oss-120b' }, pasted).keyAction).toBe('keep');
    expectCode(() => resolveOwnAiSave({ source: 'usepod', provider: 'usepod', model: 'gpt-oss-120b' }, { ...pasted, hasKey: false }), 'key_required');
  });

  test('a save never writes the registered-token columns', async () => {
    queue.select.push([{ provider: 'openai', speedSeconds: 25, dailyLimitCents: 100, keyEnc: 'x', usepodRegistered: true }]);
    await saveOwnAiSettings(AVATAR, USER, { source: 'usepod', provider: 'usepod', model: 'gpt-oss-120b' });
    const values = recorded.find((r) => r.op === 'insert')!.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
    expect(values).toMatchObject({ source: 'usepod', provider: 'usepod', keyEnc: null, keyLast4: null });
    for (const k of ['usepodRegistered', 'usepodTokenEnc', 'usepodTokenIv', 'usepodTokenTag', 'usepodTokenLast4']) expect(k in values).toBe(false);
    recorded = [];
    queue.select.push([{ provider: 'usepod', speedSeconds: 25, dailyLimitCents: 100, keyEnc: null, usepodRegistered: true }]);
    await saveOwnAiSettings(AVATAR, USER, { ...save, key: OPENAI_KEY });
    const v2 = recorded.find((r) => r.op === 'insert')!.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
    expect(v2).toMatchObject({ keyEnc: sealed(OPENAI_KEY) });
    for (const k of ['usepodRegistered', 'usepodTokenEnc', 'usepodTokenLast4']) expect(k in v2).toBe(false);
  });

  test('runtime config: registered token first, pasted token otherwise, null while sticky', async () => {
    const PASTED = '123e4567-e89b-42d3-a456-426614174000';
    const row = {
      source: 'usepod',
      provider: 'usepod',
      model: 'gpt-oss-120b',
      speedSeconds: 20,
      fallbackReason: null as string | null,
      usepodRegistered: true,
      keyEnc: sealed(PASTED) as string | null,
      keyIv: 'iv',
      keyTag: 'tag',
      usepodTokenEnc: sealed(TOKEN) as string | null,
      usepodTokenIv: 'iv',
      usepodTokenTag: 'tag',
    };
    queue.select.push([row]);
    expect((await loadOwnAiRuntimeConfig(AVATAR))?.baseUrl).toBe(`https://api.usepod.ai/proxy/${TOKEN}/v1`);
    queue.select.push([{ ...row, usepodRegistered: false, usepodTokenEnc: null }]);
    expect((await loadOwnAiRuntimeConfig(AVATAR))?.baseUrl).toBe(`https://api.usepod.ai/proxy/${PASTED}/v1`);
    for (const reason of ['key_rejected', 'balance_empty', 'model_unavailable']) {
      queue.select.push([{ ...row, fallbackReason: reason }]);
      expect(await loadOwnAiRuntimeConfig(AVATAR)).toBeNull();
    }
    queue.select.push([{ ...row, fallbackReason: 'daily_limit' }]);
    expect(await loadOwnAiRuntimeConfig(AVATAR)).not.toBeNull();
  });

  test('status shows the last 4 of the token in use', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    const r = {
      source: 'usepod',
      provider: 'usepod',
      model: 'gpt-oss-120b',
      speedSeconds: 25,
      dailyLimitCents: 100,
      keyLast4: null as string | null,
      usepodTokenLast4: '0000',
      usepodRegistered: true,
      fallbackReason: null,
      fallbackAt: null,
      updatedAt: now,
    };
    expect(buildOwnAiStatus(r, null, now).keyLast4).toBe('0000');
    expect(buildOwnAiStatus({ ...r, source: 'own_key', provider: 'openai', keyLast4: 'cdef' }, null, now).keyLast4).toBe('cdef');
  });
});
