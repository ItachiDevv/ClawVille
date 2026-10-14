import { describe, expect, test } from 'bun:test';
import type { FloorArenaExits } from '@clawville/shared';
import {
  buildJevArenaQuestions, buildJevArenaState, createJevArenaEntry, jevArenaCaps, jevArenaVerdict, parseJevArenaAnswers,
  validateJevAnswer, JEV_ARENA_CAP_LOCK_KEY, JEV_ARENA_CONTEXT, JEV_ARENA_MAX_IN_FLIGHT, JEV_ARENA_MODEL,
  type JevArenaCaps, type JevArenaEntryInput, type JevArenaFinishPatch, type JevArenaLedger, type JevArenaReserveRow,
} from './jev-entry';
import { JEV_CAP_LOCK_KEY, JEV_ENDPOINT } from '../jev-decide-shadow';
import type { FloorArenaFeatures } from './filters';

const KEY = 'jev-arena-test-key-SECRET-4b3a2c';
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

function features(over: Partial<FloorArenaFeatures> = {}): FloorArenaFeatures {
  return {
    priceUsd: 0.000123456, mcap: 37_812.4, liqUsd: 14_201.7, liqBase: 1e8, liqQuote: 50.3, pairAddress: 'PAIR',
    dexId: 'raydium', quoteMint: 'So11111111111111111111111111111111111111112', labels: ['CLMM'],
    pairCreatedAt: T0 - 22 * 60_000, ageS: 1320, chg5m: 12.7, chg1h: -3.2, chg6h: 47.9, chg24h: null,
    txns1h: 412, vol1h: 9_876.5, volOverMcap: 0.2612, symbol: 'TEST', name: 'Test Coin', top10Pct: 23.4, ...over,
  };
}

function exits(over: Partial<FloorArenaExits> = {}): FloorArenaExits {
  return { tp: [[1.2, 1]], stop_mult: 0.85, trail_from_peak: null, trail_arm_mult: null, max_hold_s: 900, ...over };
}

function input(over: { agentId?: string; mint?: string; ex?: FloorArenaExits } = {}): JevArenaEntryInput {
  return {
    bot: { agentId: over.agentId ?? 'house:momentum', strategy: 'momentum', positionUsd: 20, exits: over.ex ?? exits() },
    coin: { mint: over.mint ?? 'MINT1', source: 'dexscreener', features: features(), verdict: 'pass' },
  };
}

function goodAnswers() {
  return {
    hits_tp: { type: 'noul', noul: 0.55 },
    dumps: { type: 'noul', noul: 0.2 },
    exit_room: { type: 'score', score: 2, probabilities: { 0: 0.05, 1: 0.15, 2: 0.6, 3: 0.2 }, confidence: 0.6 },
    demand: { type: 'score', score: 1, probabilities: { 0: 0.1, 1: 0.5, 2: 0.3, 3: 0.1 }, confidence: 0.5 },
    momentum: { type: 'choice', choice: 'running', probabilities: { starting: 0.1, running: 0.6, peaking: 0.2, fading: 0.05, unclear: 0.05 }, confidence: 0.6 },
    holder_risk: { type: 'score', score: 1, probabilities: { 0: 0.2, 1: 0.5, 2: 0.2, 3: 0.1 }, confidence: 0.5 },
  };
}

interface FakeRow { id: string; status: string; usd: number; patch?: JevArenaFinishPatch; error?: string }

function fakeLedger(seedUsd = 0) {
  const rows: FakeRow[] = seedUsd > 0 ? [{ id: 'seed', status: 'ok', usd: seedUsd }] : [];
  const reserves: Array<{ row: JevArenaReserveRow; caps: JevArenaCaps }> = [];
  let n = 0;
  const ledger: JevArenaLedger = {
    async reserve(row, caps) {
      reserves.push({ row, caps });
      const total = rows.reduce((s, r) => s + r.usd, 0);
      if (total + row.estimateUsd > caps.totalUsd) return { ok: false, reason: 'total' };
      if (total + row.estimateUsd > caps.dailyUsd) return { ok: false, reason: 'daily' };
      const id = `row-${++n}`;
      rows.push({ id, status: 'reserved', usd: row.estimateUsd });
      return { ok: true, id };
    },
    async finish(id, patch) {
      const r = rows.find((x) => x.id === id)!;
      r.status = patch.status;
      r.patch = patch;
      if (patch.usd !== null) r.usd = patch.usd;
    },
    async recordSkippedCap(_row, reason) {
      rows.push({ id: `skip-${++n}`, status: 'skipped_cap', usd: 0, error: `cap_${reason}` });
    },
  };
  return { ledger, rows, reserves };
}

type Responder = (body: string, signal: AbortSignal) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function harness(opts: { key?: string | undefined; seedUsd?: number; respond?: Responder; timeoutMs?: number } = {}) {
  const { ledger, rows, reserves } = fakeLedger(opts.seedUsd);
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const logs: string[] = [];
  let clock = T0;
  const respond: Responder = opts.respond ?? (async () => ({
    ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: goodAnswers(), usage: { input_tokens: 900, output_tokens: 6 } }),
  }));
  const entry = createJevArenaEntry({
    fetch: async (url, init) => { calls.push({ url, headers: init.headers, body: init.body }); return respond(init.body, init.signal); },
    ledger,
    getApiKey: () => ('key' in opts ? opts.key : KEY),
    getEnv: () => 'staging',
    now: () => clock,
    log: { warn: (line) => logs.push(line) },
    timeoutMs: opts.timeoutMs,
  });
  return { entry, rows, reserves, calls, logs, advance: (ms: number) => { clock += ms; } };
}

describe('jev arena entry: enablement + caps', () => {
  test('disabled without a key: no fetch, no ledger row', async () => {
    const h = harness({ key: undefined });
    expect(h.entry.start(input())).toBeNull();
    h.entry.fire(input());
    await Bun.sleep(0);
    expect(h.calls).toHaveLength(0);
    expect(h.rows).toHaveLength(0);
  });

  test('caps are code constants with their own lock key', () => {
    expect(jevArenaCaps('production')).toEqual({ totalUsd: 0.9, dailyUsd: 0.45 });
    expect(jevArenaCaps('staging')).toEqual({ totalUsd: 0.1, dailyUsd: 0.05 });
    expect(jevArenaCaps(undefined)).toEqual({ totalUsd: 0.1, dailyUsd: 0.05 });
    expect(JEV_ARENA_CAP_LOCK_KEY).not.toBe(JEV_CAP_LOCK_KEY);
  });

  test('cap refusal happens before fetch, records skipped_cap once, then latches', async () => {
    const h = harness({ seedUsd: 0.0999999 });
    await h.entry.start(input());
    expect(h.calls).toHaveLength(0);
    expect(h.rows.filter((r) => r.status === 'skipped_cap')).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('spend cap reached'))).toBe(true);
    expect(h.entry.start(input({ mint: 'MINT2' }))).toBeNull();
    expect(h.entry.stats().skippedCapLatched).toBe(1);
    expect(h.calls).toHaveLength(0);
  });
});

describe('jev arena entry: state', () => {
  test('banded state has no raw floats and lists unmeasured facts', () => {
    const state = buildJevArenaState(input().bot, { ...input().coin, features: features({ top10Pct: null }) }, T0);
    const parsed = JSON.parse(state);
    expect(parsed.coin.mcap).toBe('$25k-50k');
    expect(parsed.coin.liq).toBe('$10k-25k');
    expect(parsed.coin.age).toBe('15-30min');
    expect(parsed.coin.chg5m).toBe('+10..+15%');
    expect(parsed.coin.chg1h).toBe('-5..0%');
    expect(parsed.coin.volOverMcap).toBe('0.25-0.50');
    expect(parsed.coin.txns1h).toBe('250-500');
    expect(parsed.unmeasured).toEqual(['chg24h', 'top10Pct']);
    expect(parsed.bot).toEqual({ max_hold_min: 15, position_usd: 20, stop_mult: 0.85, strategy: 'momentum', tp_mult: 1.2, trail_from_peak: null });
    // No coin number leaks: no raw price, mcap, liq, change, ratio or symbol/name.
    for (const raw of ['0.000123456', '37812', '14201', '12.7', '0.2612', '9876', '412', 'Test Coin']) expect(state).not.toContain(raw);
    const coinNumbers = Object.values(parsed.coin).filter((v) => typeof v === 'number');
    expect(coinNumbers).toHaveLength(0);
  });

  test('keys are sorted (stable state hash input)', () => {
    const state = buildJevArenaState(input().bot, input().coin, T0);
    const keys = Object.keys(JSON.parse(state));
    expect(keys).toEqual([...keys].sort());
    expect(Object.keys(JSON.parse(state).coin)).toEqual(Object.keys(JSON.parse(state).coin).sort());
  });
});

describe('jev arena entry: questions', () => {
  test('every question carries criteria and the context preamble; noul uses the bot exits', () => {
    const q = buildJevArenaQuestions({ positionUsd: 20, exits: exits({ tp: [[1.5, 0.5], [2, 0.5]], stop_mult: 0.8, max_hold_s: 1800 }) });
    expect(Object.keys(q).sort()).toEqual(['demand', 'dumps', 'exit_room', 'hits_tp', 'holder_risk', 'momentum']);
    for (const question of Object.values(q)) {
      expect(question.criteria).toBeDefined();
      expect(question.instructions.startsWith(JEV_ARENA_CONTEXT)).toBe(true);
    }
    expect(q.hits_tp.instructions).toContain('reaches 1.5x before it falls to 0.8x, within 30 minutes');
    expect(q.dumps.instructions).toContain('falls 30% or more from the current price within 30 minutes');
    expect(q.exit_room.instructions).toContain('$20');
    expect(q.exit_room.criteria).toHaveLength(4);
    expect(Object.keys(q.momentum.criteria)).toEqual(['starting', 'running', 'peaking', 'fading', 'unclear']);
  });

  test('defaults: no tp leg -> 1.3x, no stop -> 0.7x', () => {
    const q = buildJevArenaQuestions({ positionUsd: 20, exits: exits({ tp: [], stop_mult: null, trail_from_peak: 0.2 }) });
    expect(q.hits_tp.instructions).toContain('reaches 1.3x before it falls to 0.7x');
  });
});

describe('jev arena entry: answers + verdict', () => {
  const q = buildJevArenaQuestions({ positionUsd: 20, exits: exits() });

  test('validation rejects out-of-range, unoffered and bad probability answers', () => {
    expect(validateJevAnswer({ type: 'noul', noul: 1.2 }, q.hits_tp)).toBeNull();
    expect(validateJevAnswer({ type: 'score', noul: 0.5 }, q.hits_tp)).toBeNull();
    expect(validateJevAnswer({ type: 'noul', noul: 0.4 }, q.hits_tp)).toEqual({ p: 0.4 });
    expect(validateJevAnswer({ type: 'choice', choice: 'mooning', probabilities: { mooning: 1 } }, q.momentum)).toBeNull();
    expect(validateJevAnswer({ type: 'choice', choice: 'running', probabilities: { running: 0.5, fading: 0.3 } }, q.momentum)).toBeNull();
    expect(validateJevAnswer({ type: 'score', score: 4, probabilities: { 4: 1 } }, q.exit_room)).toBeNull();
    // Live jev-1.13.0 returns a decimal expected score; the level is the most probable one.
    expect(validateJevAnswer({ type: 'score', score: 2.77, probabilities: { 0: 0.04, 1: 0.03, 2: 0.05, 3: 0.88 } }, q.exit_room))
      .toEqual({ score: 3, expected: 2.77, probs: { 0: 0.04, 1: 0.03, 2: 0.05, 3: 0.88 } });
    expect(validateJevAnswer({ type: 'score', score: 1.5, probabilities: { 4: 1 } }, q.exit_room)).toBeNull();
    expect(validateJevAnswer({ type: 'score', score: 3, probabilities: { 3: 0.995, 2: 0.005 } }, q.exit_room)).toEqual({ score: 3, expected: 3, probs: { 3: 0.995, 2: 0.005 } });
    const parsed = parseJevArenaAnswers({ ...goodAnswers(), dumps: { type: 'noul', noul: -1 } }, q);
    expect(parsed.dumps).toBeNull();
    expect(parsed.answers.dumps).toBeNull();
    expect(parsed.hitsTp).toBe(0.55);
    expect(parsed.momentum).toBe('running');
  });

  test('verdict v0 rules; null answers never veto', () => {
    expect(jevArenaVerdict({ hitsTp: null, dumps: null, exitRoom: null, holderRisk: null })).toEqual({ verdict: 'pass', reasons: [] });
    expect(jevArenaVerdict({ hitsTp: 0.35, dumps: 0.59, exitRoom: 1, holderRisk: 2 }).verdict).toBe('pass');
    expect(jevArenaVerdict({ hitsTp: 0.34, dumps: null, exitRoom: null, holderRisk: null }).reasons).toEqual(['hits_tp_lt_0.35']);
    expect(jevArenaVerdict({ hitsTp: null, dumps: 0.6, exitRoom: 0, holderRisk: 3 })).toEqual({
      verdict: 'veto', reasons: ['exit_room_no', 'holder_risk_severe', 'dumps_ge_0.6'],
    });
  });
});

describe('jev arena entry: runner', () => {
  test('ok call: one request, model reported, verdict + actual cost stored', async () => {
    const h = harness();
    await h.entry.start(input());
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(JEV_ENDPOINT);
    const body = JSON.parse(h.calls[0]!.body);
    expect(body.model).toBe(JEV_ARENA_MODEL);
    expect(typeof body.state).toBe('string');
    expect(Object.keys(body.questions)).toHaveLength(6);
    const row = h.rows.find((r) => r.id === 'row-1')!;
    expect(row.status).toBe('ok');
    expect(row.patch!.model).toBe('jev-1.13.0');
    expect(row.patch!.verdict).toBe('pass');
    expect(row.usd).toBeCloseTo(900 * 0.042 / 1e6, 12);
    // Reservation is an upper bound on the billed cost.
    expect(h.reserves[0]!.row.estimateUsd).toBeGreaterThan(row.usd);
    expect(h.reserves[0]!.row.stateHash).toMatch(/^[0-9a-f]{16}$/);
  });

  test('dedupe per (agent, mint) for 10 minutes', async () => {
    const h = harness();
    await h.entry.start(input());
    expect(h.entry.start(input())).toBeNull();
    await h.entry.start(input({ agentId: 'house:other' }));
    h.advance(10 * 60_000);
    await h.entry.start(input());
    expect(h.calls).toHaveLength(3);
    expect(h.entry.stats().deduped).toBe(1);
  });

  test('at most 4 in flight; extra calls are skipped and counted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness({
      respond: async () => { await gate; return { ok: true, status: 200, json: async () => ({ answers: goodAnswers() }) }; },
    });
    const started = [];
    for (let i = 0; i < JEV_ARENA_MAX_IN_FLIGHT + 2; i++) started.push(h.entry.start(input({ mint: `M${i}` })));
    expect(started.filter((p) => p === null)).toHaveLength(2);
    expect(h.entry.stats().skippedInFlight).toBe(2);
    expect(h.entry.inFlight()).toBe(JEV_ARENA_MAX_IN_FLIGHT);
    release();
    await Promise.all(started);
    expect(h.entry.inFlight()).toBe(0);
    // A skipped coin was not marked as deduped: it can run later.
    expect(h.entry.start(input({ mint: 'M5' }))).not.toBeNull();
  });

  test('HTTP error and timeout are recorded; the key never reaches logs or rows', async () => {
    const h = harness({ respond: async () => { throw new Error(`boom with ${KEY} inside`); } });
    await h.entry.start(input());
    const errRow = h.rows.find((r) => r.id === 'row-1')!;
    expect(errRow.status).toBe('error');
    expect(errRow.patch!.error).toContain('[redacted]');
    expect(errRow.usd).toBeGreaterThan(0); // reserved upper bound kept

    const t = harness({
      timeoutMs: 5,
      respond: (_body, signal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
    });
    await t.entry.start(input());
    const toRow = t.rows.find((r) => r.id === 'row-1')!;
    expect(toRow.status).toBe('timeout');
    expect(toRow.patch!.error).toBe('timeout');

    const all = JSON.stringify([h.logs, h.rows, t.logs, t.rows]);
    expect(all).not.toContain(KEY);
    expect(h.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  test('no valid answer -> error row; fire never throws even when the ledger throws', async () => {
    const h = harness({ respond: async () => ({ ok: true, status: 200, json: async () => ({ answers: { hits_tp: { noul: 7 } } }) }) });
    await h.entry.start(input());
    expect(h.rows.find((r) => r.id === 'row-1')!.patch!.error).toBe('no_valid_answers');

    const logs: string[] = [];
    const broken = createJevArenaEntry({
      fetch: async () => { throw new Error('unreachable'); },
      ledger: {
        reserve: async () => { throw new Error(`db down ${KEY}`); },
        finish: async () => {},
        recordSkippedCap: async () => {},
      },
      getApiKey: () => KEY, getEnv: () => 'staging', now: () => T0, log: { warn: (l) => logs.push(l) },
    });
    expect(() => broken.fire(input())).not.toThrow();
    await Bun.sleep(5);
    expect(logs.join('\n')).toContain('[redacted]');
    expect(logs.join('\n')).not.toContain(KEY);
    expect(broken.inFlight()).toBe(0);
  });
});
