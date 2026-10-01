/**
 * D33: the Trading Arena code tuner (`searchFilterChange` + the tick that runs
 * it). Every tick test here gets a model reply with `suggestion: null`: the
 * tuner must decide on its own (TUNER_CHECK_2026-10-01: since D27 the model
 * proposed nothing, so the old tuner never ran).
 */
import { describe, expect, test } from 'bun:test';
import { cloneFloorArenaParams, floorArenaTemplateById } from '@clawville/shared';
import {
  EVIDENCE_MAX_SEARCH_P,
  EVIDENCE_MIN_EDGE,
  EVIDENCE_MIN_PER_SIDE,
  MIN_CLOSED_FOR_AUTO_APPLY,
  checkHouseDrift,
  houseLeafInBand,
  roundTunerCandidate,
  runArenaAnalysisTickWith,
  searchFilterChange,
  type ArenaAnalysisAgent,
  type ArenaAnalysisCandidate,
  type ArenaAnalysisStore,
  type ArenaClosedTrade,
  type ArenaInferenceMessage,
  type ArenaParamChangeWrite,
  type ArenaReportWrite,
} from '../floor-arena/analysis';

const NOW = new Date('2026-10-01T12:00:00Z');
const MIN = 60_000;
const genesis = floorArenaTemplateById('genesis')!;

/** One closed trade on params version 1 whose pair was `ageS` old when the
 *  engine judged it. Every feature passes Genesis's template filters unless
 *  `extra` says otherwise. */
function arenaTrade(i: number, pnlMult: number, ageS: number, extra: Record<string, unknown> = {}): ArenaClosedTrade {
  const openedAt = new Date(NOW.getTime() - 20 * MIN);
  return {
    openedAt,
    closedAt: new Date(NOW.getTime() - (i + 1) * 10_000),
    paramsVersion: 1,
    exitReason: pnlMult >= 1.1 ? 'tp' : 'time',
    pnlUsd: 20 * pnlMult - 20,
    pnlMult,
    source: 'ds:token-profiles',
    features: {
      priceUsd: 0.001, mcap: 50_000, liqUsd: 20_000, chg5m: 1.5, chg1h: 10, volOverMcap: 0.8,
      ageS, pairCreatedAt: openedAt.getTime() - ageS * 1000, ...extra,
    },
  };
}

/** `half` young pairs (2000 s) at 0.5x and `half` older ones (`keptAge`) at 1.1x. */
function clearSplit(half: number, keptAge = 3_000): ArenaClosedTrade[] {
  return [
    ...Array.from({ length: half }, (_, i) => arenaTrade(i, 0.5, 2_000)),
    ...Array.from({ length: half }, (_, i) => arenaTrade(half + i, 1.1, keptAge)),
  ];
}

/** Seeded test RNG (independent of the one in analysis.ts). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * `n` trades whose outcomes have NO relation to their features: features
 * spread across Genesis's whole filter range, multiples heavy-tailed like
 * Genesis's own (about 20% deaths at 0.3x, half +10% take-profits, the rest
 * time exits between 0.8x and 1.05x).
 */
function noiseTrades(n: number, seed: number): ArenaClosedTrade[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const u = r();
    const pnl = u < 0.2 ? 0.3 : u < 0.7 ? 1.1 : 0.8 + 0.25 * r();
    return arenaTrade(i, pnl, Math.round(1_800 + r() * 19_800), {
      mcap: Math.round(10_000 + r() * 240_000),
      liqUsd: Math.round(15_000 + r() * 185_000),
    });
  });
}

function agent(partial: Partial<ArenaAnalysisAgent> = {}): ArenaAnalysisAgent {
  return {
    id: 'house:genesis',
    kind: 'house',
    name: 'Genesis',
    templateId: 'genesis',
    params: cloneFloorArenaParams(genesis.params),
    paramsVersion: 1,
    status: 'active',
    seated: true,
    autoApplySuggestions: false,
    avatarId: null,
    createdAt: new Date(NOW.getTime() - 24 * 60 * MIN),
    ...partial,
  };
}

function candidate(a: ArenaAnalysisAgent, partial: Partial<ArenaAnalysisCandidate> = {}): ArenaAnalysisCandidate {
  return {
    agent: a,
    lastReportAt: new Date(NOW.getTime() - 31 * MIN),
    lastReportPeriodEnd: new Date(NOW.getTime() - 31 * MIN),
    closedSince: 3,
    openedSince: 2,
    ...partial,
  };
}

interface FakeStore extends ArenaAnalysisStore {
  reports: ArenaReportWrite[];
  changes: ArenaParamChangeWrite[];
}

/** In-memory store with the SQL contract: insert, claim a PENDING report on
 *  apply, reject a still-pending one (reason + tuner in one update). */
function fakeStore(opts: { candidates: ArenaAnalysisCandidate[]; trades?: Record<string, ArenaClosedTrade[]> }): FakeStore {
  const byId = new Map<string, ArenaReportWrite>();
  const store: FakeStore = {
    reports: [],
    changes: [],
    async listCandidates() { return opts.candidates; },
    async loadClosedTrades(agentId) { return opts.trades?.[agentId] ?? []; },
    async countOpened() { return 2; },
    async countOpen() { return 1; },
    async loadRecentReports() { return []; },
    async lastParamChangeAt() { return null; },
    async insertReport(report) {
      const row = { ...report };
      store.reports.push(row);
      const reportId = `r${store.reports.length}`;
      byId.set(reportId, row);
      return { reportId };
    },
    async applyParamChange(change) {
      store.changes.push(change);
      const row = byId.get(change.reportId);
      if (!row || row.suggestionState !== 'pending') return { ok: false as const, reason: 'report_not_pending' as const };
      row.suggestionState = 'auto_applied';
      return { ok: true as const, paramsVersion: change.expectedParamsVersion + 1 };
    },
    async rejectPendingReport(reportId, _agentId, reason, tuner) {
      const row = byId.get(reportId);
      if (!row || row.suggestionState !== 'pending') return;
      row.suggestionState = 'rejected';
      row.suggestion = null;
      row.stats = { ...row.stats, suggestionCheck: { ...row.stats.suggestionCheck, reason, ...(tuner ? { tuner } : {}) } };
    },
  };
  return store;
}

/** The model proposes NOTHING, as on staging since D27. */
function nullModel() {
  const calls: ArenaInferenceMessage[][] = [];
  const llm = async (messages: ArenaInferenceMessage[]) => {
    calls.push(messages);
    return JSON.stringify({ summary: 'x', observations: [], suggestion: null });
  };
  return { llm, calls };
}

const quietLog = () => {};

describe('D33 tuner in the analysis tick (model reply: suggestion null)', () => {
  test('(1) an eligible house agent with a clear 12/12 age split is tuned by code', async () => {
    const a = agent();
    const store = fakeStore({ candidates: [candidate(a)], trades: { [a.id]: clearSplit(12) } });
    const { llm, calls } = nullModel();
    const result = await runArenaAnalysisTickWith({ store, llm, log: quietLog }, NOW);

    expect(result.applied).toBe(1);
    expect(calls).toHaveLength(1);
    expect(store.changes).toHaveLength(1);
    const change = store.changes[0]!;
    expect(change.source).toBe('house-tuner');
    expect(change.reportId).toBe('r1');
    expect(change.changes).toEqual([{ path: 'filters.age_min_s', from: 1_800, to: 3_000 }]);
    expect(change.params.limits.position_usd).toBe(20);
    expect(checkHouseDrift(genesis.params, genesis.params, change.params)).toBeNull();
    expect(change.eventSummary.startsWith('Tuner changed filters.age_min_s from 1800 to 3000: Code tuner:')).toBe(true);
    const report = store.reports[0]!;
    expect(report.suggestionState).toBe('auto_applied');
    expect(report.stats.suggestionCheck.tuner).toEqual({
      decision: 'changed',
      reason: 'changed',
      n: 24,
      needed: MIN_CLOSED_FOR_AUTO_APPLY,
      best: { path: 'filters.age_min_s', from: 1_800, to: 3_000, kept: 12, excluded: 12, edge: 0.6 },
      // No shuffle reaches an edge of 0.6: p = 1 / 2001.
      p: 0.0005,
    });
    expect(report.stats.suggestionCheck.evidence).toMatchObject({ method: 'filter_split', confirmed: true });
  });

  test('(2) 51 heavy-tailed noise trades never change a house agent: not_significant', async () => {
    const a = agent();
    const trades = noiseTrades(51, 7);
    const store = fakeStore({ candidates: [candidate(a)], trades: { [a.id]: trades } });
    const { llm } = nullModel();
    const result = await runArenaAnalysisTickWith({ store, llm, log: quietLog }, NOW);

    expect(result.applied).toBe(0);
    expect(store.changes).toHaveLength(0);
    const report = store.reports[0]!;
    expect(report.suggestionState).toBe('none');
    const tuner = report.stats.suggestionCheck.tuner!;
    expect(tuner.decision).toBe('none');
    expect(tuner.reason).toBe('not_significant');
    expect(tuner.n).toBe(51);
    expect(tuner.p!).toBeGreaterThan(EVIDENCE_MAX_SEARCH_P);
    // The naive fix (code search + D27 as written) WOULD have applied this
    // noise: its best split passes the raw D27 check. The shuffle test is what
    // refuses it.
    expect(tuner.best!.kept).toBeGreaterThanOrEqual(EVIDENCE_MIN_PER_SIDE);
    expect(tuner.best!.excluded).toBeGreaterThanOrEqual(EVIDENCE_MIN_PER_SIDE);
    expect(tuner.best!.edge).toBeGreaterThanOrEqual(EVIDENCE_MIN_EDGE);
    // No suggestion is stored, so no raw `evidence` (with confirmed: true) is either.
    expect(report.stats.suggestionCheck.evidence).toBeUndefined();
  });

  test('(3) a house agent with 16 trades states below_sample, n 16, needed 20', async () => {
    const a = agent();
    const store = fakeStore({ candidates: [candidate(a)], trades: { [a.id]: clearSplit(8) } });
    const { llm } = nullModel();
    const result = await runArenaAnalysisTickWith({ store, llm, log: quietLog }, NOW);

    expect(result.applied).toBe(0);
    expect(store.reports[0]!.stats.suggestionCheck.tuner).toEqual({
      decision: 'none',
      reason: 'below_sample',
      n: 16,
      needed: 20,
      best: null,
      p: null,
    });
  });

  test('(4) a click-to-apply user agent gets a PENDING suggestion with evidence, never an apply', async () => {
    const a = agent({ id: 'u1', kind: 'user', name: 'My Trader', avatarId: 'avatar-1' });
    const store = fakeStore({ candidates: [candidate(a)], trades: { u1: clearSplit(12) } });
    const { llm } = nullModel();
    const memories: string[] = [];
    const result = await runArenaAnalysisTickWith(
      { store, llm, log: quietLog, writeMemory: async (m) => { memories.push(m.text); } },
      NOW,
    );

    expect(result).toMatchObject({ applied: 0, pending: 1 });
    expect(store.changes).toHaveLength(0);
    const report = store.reports[0]!;
    expect(report.suggestionState).toBe('pending');
    expect(report.suggestion).toMatchObject({ path: 'filters.age_min_s', from: 1_800, to: 3_000 });
    expect(report.suggestion!.reason.startsWith('Code tuner:')).toBe(true);
    expect(report.stats.suggestionCheck.tuner).toMatchObject({ decision: 'suggested', reason: 'suggested', n: 24 });
    expect(report.stats.suggestionCheck.evidence).toMatchObject({ method: 'filter_split', confirmed: true });
    // D29: the owner's memory carries the tuner line.
    expect(memories).toHaveLength(1);
    expect(memories[0]).toContain('\nTuner decision: suggested (reason: suggested); 24 closed trades on the current params, 20 needed.');
  });
});

describe('D33 searchFilterChange (pure)', () => {
  const house = (trades: ArenaClosedTrade[], seed = 's', shuffles?: number) =>
    searchFilterChange({ template: genesis.params, current: genesis.params, trades, house: true, seed, shuffles });

  test('(5) the same seed gives the same result; the best split never depends on the seed', async () => {
    const trades = noiseTrades(51, 11);
    const a = await house(trades, 'house:genesis:2:51');
    const b = await house(trades, 'house:genesis:2:51');
    expect(b).toEqual(a);
    const c = await house(trades, 'another-seed');
    expect(c.best).toEqual(a.best);
    expect(c.splits).toBe(a.splits);
  });

  test('(6) a house agent stays inside its band; a user agent only inside the bounds', async () => {
    // The split sits at 5000 s; the Genesis band for age_min_s is 900 to 3600.
    const trades = clearSplit(12, 5_000);
    const h = await house(trades);
    expect(h.outcome).toBe('no_candidate');
    expect(h.best).toBeNull();
    const u = await searchFilterChange({ template: genesis.params, current: genesis.params, trades, house: false, seed: 's' });
    expect(u.outcome).toBe('confirmed');
    expect(u.best!.summary).toMatchObject({ path: 'filters.age_min_s', from: 1_800, to: 5_000 });

    // Across noise data, every value a house search proposes is inside the
    // band of the template value, and it is always a filter.
    for (let seed = 1; seed <= 20; seed += 1) {
      const result = await house(noiseTrades(51, seed), `band-${seed}`, 50);
      if (!result.best) continue;
      const { path, to } = result.best.summary;
      expect(path.startsWith('filters.')).toBe(true);
      const key = path.slice('filters.'.length) as keyof typeof genesis.params.filters;
      expect(houseLeafInBand(path, genesis.params.filters[key]!, to)).toBe(true);
      expect(checkHouseDrift(genesis.params, genesis.params, result.best.next)).toBeNull();
    }
  });

  test('(7) on 200 pure-noise datasets the tuner changes at most about 6%', async () => {
    let confirmed = 0;
    let naive = 0;
    for (let seed = 1_000; seed < 1_200; seed += 1) {
      const result = await house(noiseTrades(51, seed), `noise-${seed}`);
      if (result.outcome === 'confirmed') confirmed += 1;
      if (result.best?.evidence.confirmed) naive += 1;
    }
    // The raw D27 check alone "confirms" most of these (the defect the
    // shuffle test fixes); the search-adjusted gate holds near alpha.
    expect(naive).toBeGreaterThan(100);
    expect(confirmed).toBeLessThanOrEqual(12);
  }, 120_000);

  test('(8) candidate values are cut to 3 significant figures toward keeping their trade', async () => {
    // Down for a min filter, up for a max filter; grid values and float noise stay put.
    expect(roundTunerCandidate(215_447, true)).toBe(215_000);
    expect(roundTunerCandidate(215_447, false)).toBe(216_000);
    expect(roundTunerCandidate(0.123, true)).toBe(0.123);
    expect(roundTunerCandidate(12.345678, false)).toBe(12.4);
    expect(roundTunerCandidate(-7.777, false)).toBe(-7.77);
    expect(roundTunerCandidate(999.6, false)).toBe(1_000);
    expect(roundTunerCandidate(0, true)).toBe(0);

    // Integer min leaf: pairs 3456 s old give a 3450 s minimum, not 3456.
    const age = await house(clearSplit(12, 3_456));
    expect(age.outcome).toBe('confirmed');
    expect(age.best!.summary).toMatchObject({ path: 'filters.age_min_s', from: 1_800, to: 3_450, kept: 12, excluded: 12 });
    expect(age.best!.change.to).toBe(3_450);
    expect(age.best!.next.filters.age_min_s).toBe(3_450);

    // Max leaf: winners at a 150123 cap and losers at 215447 give a 151000 cap
    // (inside the Genesis band 125000 to 500000), never 150123.
    const caps = [
      ...Array.from({ length: 12 }, (_, i) => arenaTrade(i, 0.5, 3_000, { mcap: 215_447 })),
      ...Array.from({ length: 12 }, (_, i) => arenaTrade(12 + i, 1.1, 3_000, { mcap: 150_123 })),
    ];
    const cap = await house(caps);
    expect(cap.outcome).toBe('confirmed');
    expect(cap.best!.summary).toMatchObject({ path: 'filters.mcap_max', from: 250_000, to: 151_000, kept: 12, excluded: 12 });

    // Decimal max leaf (Runner chg5m_max 41.48): 12.345678 gives 12.4. Nearest
    // rounding (12.3) would exclude the winners that produced it.
    const runner = floorArenaTemplateById('runner')!;
    const decimals = [
      ...Array.from({ length: 12 }, (_, i) => arenaTrade(i, 0.5, 3_000, { chg5m: 33.333333, chg6h: 700 })),
      ...Array.from({ length: 12 }, (_, i) => arenaTrade(12 + i, 1.1, 3_000, { chg5m: 12.345678, chg6h: 700 })),
    ];
    const dec = await searchFilterChange({ template: runner.params, current: runner.params, trades: decimals, house: false, seed: 's' });
    expect(dec.best!.summary).toMatchObject({ path: 'filters.chg5m_max', from: 41.48, to: 12.4, kept: 12, excluded: 12 });

    // Across noise data, every value a house or user search proposes has at
    // most 3 significant figures.
    let checked = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      for (const isHouse of [true, false]) {
        const result = await searchFilterChange({
          template: genesis.params, current: genesis.params, trades: noiseTrades(51, seed), house: isHouse, seed: `r-${seed}`, shuffles: 20,
        });
        if (!result.best) continue;
        const to = result.best.summary.to;
        expect(Number(to.toPrecision(3))).toBe(to);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
