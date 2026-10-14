import { describe, expect, it } from 'bun:test';
import { HATCHER_ACTION_MENU } from '@clawville/shared';
import {
  createJevDecideShadow,
  estimateJevUsd,
  jevSpendCaps,
  JEV_ENDPOINT,
  type JevFinishPatch,
  type JevReserveRow,
  type JevShadowInput,
  type JevShadowLedger,
  type JevSpendCaps,
} from '../jev-decide-shadow';

const KEY = 'jev-test-key-SECRET-9f8e7d';

interface FakeRow {
  id: string;
  status: string;
  usd: number;
  day: string;
  patch?: JevFinishPatch;
  error?: string;
}

/** In-memory ledger with the same cap rule as the DB ledger. */
function fakeLedger(day = '2026-10-13', seed: FakeRow[] = []) {
  const rows: FakeRow[] = [...seed];
  const reserveCalls: Array<{ row: JevReserveRow; caps: JevSpendCaps }> = [];
  let n = 0;
  const ledger: JevShadowLedger = {
    async reserve(row, caps) {
      reserveCalls.push({ row, caps });
      const total = rows.reduce((s, r) => s + r.usd, 0);
      const today = rows.filter((r) => r.day === day).reduce((s, r) => s + r.usd, 0);
      if (total + row.estimateUsd > caps.totalUsd) return { ok: false, reason: 'total' };
      if (today + row.estimateUsd > caps.dailyUsd) return { ok: false, reason: 'daily' };
      const id = `row-${++n}`;
      rows.push({ id, status: 'reserved', usd: row.estimateUsd, day });
      return { ok: true, id };
    },
    async finish(id, patch) {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error('missing row');
      r.status = patch.status;
      r.patch = patch;
      if (patch.usd !== null) r.usd = patch.usd;
    },
    async recordSkippedCap(_row, reason) {
      rows.push({ id: `skip-${++n}`, status: 'skipped_cap', usd: 0, day, error: `cap_${reason}` });
    },
  };
  return { ledger, rows, reserveCalls };
}

function answers(probs: Record<string, number>) {
  const out: Record<string, { noul: number }> = {};
  for (const [k, v] of Object.entries(probs)) out[k] = { noul: v };
  return out;
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function setup(opts: {
  key?: string | undefined;
  env?: string;
  ledger?: JevShadowLedger;
  fetchImpl?: (url: string, init: { signal: AbortSignal; headers: Record<string, string>; body: string }) => Promise<unknown>;
  timeoutMs?: number;
}) {
  const logs: string[] = [];
  const fetchCalls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fl = fakeLedger();
  const shadow = createJevDecideShadow({
    fetch: async (url, init) => {
      fetchCalls.push({ url, headers: init.headers, body: init.body });
      const res = opts.fetchImpl
        ? await opts.fetchImpl(url, init)
        : okResponse({ answers: answers({ move: 0.9, emote: 0.2 }), usage: { input_tokens: 1000 } });
      return res as { ok: boolean; status: number; json(): Promise<unknown> };
    },
    ledger: opts.ledger ?? fl.ledger,
    getApiKey: () => ('key' in opts ? opts.key : KEY),
    getEnv: () => opts.env ?? 'staging',
    now: () => Date.parse('2026-10-13T12:00:00Z'),
    log: { warn: (line) => logs.push(line) },
    timeoutMs: opts.timeoutMs,
  });
  return { shadow, logs, fetchCalls, fl };
}

const input = (over: Partial<JevShadowInput> = {}): JevShadowInput => ({
  prompt: 'You are an agent. Choose one [ACTION:].',
  avatarId: '00000000-0000-4000-8000-000000000001',
  isHouse: true,
  localVerb: 'move',
  localEmpty: false,
  localMs: 10_900,
  ...over,
});

describe('jev-decide-shadow', () => {
  it('is disabled without a key: no reserve, no fetch', async () => {
    for (const key of [undefined, '', '   ']) {
      const { shadow, fetchCalls, fl } = setup({ key });
      await shadow.run(input());
      shadow.fire(input());
      expect(fetchCalls.length).toBe(0);
      expect(fl.reserveCalls.length).toBe(0);
    }
  });

  it('sends one noul question per menu verb with the exact prompt as state', async () => {
    const { shadow, fetchCalls } = setup({});
    await shadow.run(input({ prompt: 'EXACT PROMPT' }));
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe(JEV_ENDPOINT);
    const body = JSON.parse(fetchCalls[0].body);
    expect(body.model).toBe('jev-latest');
    expect(body.state).toBe('EXACT PROMPT');
    expect(Object.keys(body.questions).sort()).toEqual(HATCHER_ACTION_MENU.map((m) => m.verb).sort());
    for (const q of Object.values(body.questions) as Array<{ type: string; instructions: string }>) {
      expect(q.type).toBe('noul');
      expect(q.instructions).toContain('single best next action');
    }
  });

  it('picks the argmax verb and records actual usd from usage', async () => {
    const { shadow, fl } = setup({
      fetchImpl: async () => okResponse({
        answers: answers({ move: 0.3, enter_building: 0.81, emote: 0.8, bogus_verb: 0.99 }),
        usage: { input_tokens: 2000 },
      }),
    });
    await shadow.run(input());
    const row = fl.rows[0];
    expect(row.status).toBe('ok');
    expect(row.patch?.jevVerb).toBe('enter_building');
    expect(row.patch?.jevTopProb).toBe(0.81);
    expect(row.patch?.jevProbs).toEqual({ move: 0.3, enter_building: 0.81, emote: 0.8 });
    expect(row.patch?.inputTokens).toBe(2000);
    expect(row.usd).toBeCloseTo(2000 * 0.042 / 1_000_000, 12);
  });

  it('keeps the estimate when usage is missing', async () => {
    const { shadow, fl } = setup({
      fetchImpl: async () => okResponse({ answers: answers({ emote: 0.7 }) }),
    });
    await shadow.run(input());
    expect(fl.rows[0].status).toBe('ok');
    expect(fl.rows[0].patch?.usd).toBeNull();
    expect(fl.rows[0].usd).toBe(fl.reserveCalls[0].row.estimateUsd);
  });

  it('caps are code constants by CLAWVILLE_ENV', () => {
    expect(jevSpendCaps('production')).toEqual({ totalUsd: 0.9, dailyUsd: 0.25 });
    expect(jevSpendCaps('staging')).toEqual({ totalUsd: 0.1, dailyUsd: 0.05 });
    expect(jevSpendCaps(undefined)).toEqual({ totalUsd: 0.1, dailyUsd: 0.05 });
    expect(estimateJevUsd(1_000_000 - 256, 0)).toBeCloseTo(0.042, 12);
  });

  it('total cap refuses before fetch, warns once, then latches', async () => {
    const fl = fakeLedger('2026-10-13', [{ id: 'old', status: 'ok', usd: 0.1, day: '2026-10-01' }]);
    const { shadow, fetchCalls, logs } = setup({ ledger: fl.ledger });
    await shadow.run(input());
    await shadow.run(input());
    expect(fetchCalls.length).toBe(0);
    expect(fl.reserveCalls.length).toBe(1);
    expect(fl.rows.filter((r) => r.status === 'skipped_cap').map((r) => r.error)).toEqual(['cap_total']);
    expect(logs.filter((l) => l.includes('spend cap')).length).toBe(1);
  });

  it('daily cap refuses before fetch', async () => {
    const fl = fakeLedger('2026-10-13', [{ id: 't', status: 'ok', usd: 0.05, day: '2026-10-13' }]);
    const { shadow, fetchCalls, logs } = setup({ ledger: fl.ledger });
    await shadow.run(input());
    expect(fetchCalls.length).toBe(0);
    expect(fl.rows.find((r) => r.status === 'skipped_cap')?.error).toBe('cap_daily');
    expect(logs.length).toBe(1);
    expect(logs[0]).toStartWith('[JevShadow]');
  });

  it('production uses the larger daily cap', async () => {
    const fl = fakeLedger('2026-10-13', [{ id: 't', status: 'ok', usd: 0.05, day: '2026-10-13' }]);
    const { shadow, fetchCalls } = setup({ ledger: fl.ledger, env: 'production' });
    await shadow.run(input());
    expect(fetchCalls.length).toBe(1);
  });

  it('records an HTTP/network error and never throws', async () => {
    const { shadow, fl, logs } = setup({
      fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    await shadow.run(input());
    expect(fl.rows[0].status).toBe('error');
    expect(fl.rows[0].patch?.error).toContain('ECONNREFUSED');
    expect(fl.rows[0].usd).toBe(fl.reserveCalls[0].row.estimateUsd);
    expect(logs.every((l) => l.startsWith('[JevShadow]'))).toBe(true);

    const bad = setup({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    await bad.shadow.run(input());
    expect(bad.fl.rows[0].status).toBe('error');
    expect(bad.fl.rows[0].patch?.error).toBe('http 500');
  });

  it('records a timeout', async () => {
    const { shadow, fl } = setup({
      timeoutMs: 20,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    });
    await shadow.run(input());
    expect(fl.rows[0].status).toBe('timeout');
    expect(fl.rows[0].patch?.error).toBe('timeout');
  });

  it('fire() swallows a ledger failure', async () => {
    const logs: string[] = [];
    const shadow = createJevDecideShadow({
      fetch: async () => okResponse({}),
      ledger: {
        reserve: async () => { throw new Error(`db down ${KEY}`); },
        finish: async () => {},
        recordSkippedCap: async () => {},
      },
      getApiKey: () => KEY,
      getEnv: () => 'staging',
      now: () => 0,
      log: { warn: (line) => logs.push(line) },
    });
    expect(() => shadow.fire(input())).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(logs.length).toBe(1);
    expect(logs[0]).toStartWith('[JevShadow]');
    expect(logs[0]).not.toContain(KEY);
  });

  it('allows one in-flight call per agent and two globally', async () => {
    const releases: Array<() => void> = [];
    const { shadow, fetchCalls } = setup({
      fetchImpl: () => new Promise((resolve) => {
        releases.push(() => resolve(okResponse({ answers: answers({ move: 0.5 }) })));
      }),
    });
    const a1 = shadow.run(input({ avatarId: 'a' }));
    const a2 = shadow.run(input({ avatarId: 'a' }));
    const b = shadow.run(input({ avatarId: 'b' }));
    const c = shadow.run(input({ avatarId: 'c' }));
    await a2;
    await c;
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchCalls.length).toBe(2);
    releases.forEach((release) => release());
    await Promise.all([a1, b]);
    const again = shadow.run(input({ avatarId: 'a' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchCalls.length).toBe(3);
    releases[2]();
    await again;
  });

  it('never puts key text in any log line or stored error', async () => {
    const logs: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    const origErr = console.error;
    console.warn = (...a: unknown[]) => logs.push(a.join(' '));
    console.log = (...a: unknown[]) => logs.push(a.join(' '));
    console.error = (...a: unknown[]) => logs.push(a.join(' '));
    try {
      const s = setup({
        fetchImpl: async () => { throw new Error(`401 bad token Bearer ${KEY}`); },
      });
      await s.shadow.run(input());
      const capped = setup({
        ledger: fakeLedger('2026-10-13', [{ id: 'x', status: 'ok', usd: 1, day: '2026-10-13' }]).ledger,
      });
      await capped.shadow.run(input());
      const all = [...logs, ...s.logs, ...capped.logs, ...s.fl.rows.map((r) => r.patch?.error ?? '')];
      expect(s.logs.length).toBeGreaterThan(0);
      for (const line of all) {
        expect(line).not.toContain(KEY);
        expect(line).not.toContain('SECRET');
      }
      // The key only travels in the outbound Authorization header.
      expect(s.fetchCalls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(s.fetchCalls[0].body).not.toContain(KEY);
    } finally {
      console.warn = origWarn;
      console.log = origLog;
      console.error = origErr;
    }
  });
});
