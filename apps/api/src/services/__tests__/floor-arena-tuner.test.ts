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
  TUNER_CHECKPOINT_ALPHA,
  TUNER_CHECKPOINTS,
  checkHouseDrift,
  houseLeafInBand,
  roundTunerCandidate,
  runArenaAnalysisTickWith,
  searchFilterChange,
  tunerCheckpointStep,
  tunerMemoryLine,
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
    // The SQL reads max(stats.suggestionCheck.tuner.checkpoint) over this
    // agent's reports whose stats.paramsVersion is the version asked.
    async maxTestedCheckpoint(agentId, paramsVersion) {
      let max: number | null = null;
      for (const r of store.reports) {
        if (r.agentId !== agentId || r.stats.paramsVersion !== paramsVersion) continue;
        const c = r.stats.suggestionCheck.tuner?.checkpoint;
        if (typeof c === 'number' && (max === null || c > max)) max = c;
      }
      return max;
    },
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
      const { evidence: _dropped, ...check } = row.stats.suggestionCheck;
      row.stats = { ...row.stats, suggestionCheck: { ...check, reason, ...(tuner ? { tuner } : {}) } };
    },
    async setReportTuner(reportId, _agentId, tuner) {
      const row = byId.get(reportId);
      if (!row) return null;
      if (row.suggestionState !== 'auto_applied') row.stats = { ...row.stats, suggestionCheck: { ...row.stats.suggestionCheck, tuner } };
      return row.suggestionState;
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

/** Shuffles per look in the multi-look test (production: 2000). 400 keeps
 *  every checkpoint reachable (the smallest p is 1/401, below 0.0025) and the
 *  test under 20 s; at 2000 the first 100 streams gave 6/100. */
const MULTI_LOOK_SHUFFLES = 400;

/** A pure-noise stream in closing order: trade j closes j seconds after the
 *  stream starts, so the first m trades are the oldest m. */
function noiseStream(n: number, seed: number): ArenaClosedTrade[] {
  const start = NOW.getTime() - 10 * 24 * 60 * MIN;
  return noiseTrades(n, seed).map((t, j) => ({ ...t, closedAt: new Date(start + j * 1_000) }));
}

/**
 * Runs the REAL tick (`runArenaAnalysisTickWith`) on one house agent over a
 * growing noise stream: one due report every `step` closed trades from `from`
 * to `to`. The store keeps every report, so the tick reads which checkpoints
 * this params version already tested. Returns true at the first change.
 */
async function streamEverChanges(seed: number, opts: { from: number; to: number; step: number; shuffles: number }): Promise<boolean> {
  const all = noiseStream(opts.to, seed);
  const a = agent();
  let visible: ArenaClosedTrade[] = [];
  let tickAt = NOW;
  const store = fakeStore({ candidates: [] });
  // A quiet report (no model call): the tuner runs on it all the same.
  store.listCandidates = async () => [
    candidate(a, { closedSince: 0, openedSince: 0, lastReportAt: new Date(tickAt.getTime() - 3 * 60 * MIN) }),
  ];
  store.loadClosedTrades = async () => visible;
  const { llm } = nullModel();
  for (let m = opts.from, k = 0; m <= opts.to; m += opts.step, k += 1) {
    visible = all.slice(0, m).reverse();
    tickAt = new Date(NOW.getTime() + k * 3 * 60 * MIN);
    await runArenaAnalysisTickWith({ store, llm, log: quietLog, tunerShuffles: opts.shuffles }, tickAt);
    if (store.changes.length > 0) return true;
  }
  return false;
}

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
      checkpoint: 20,
      alpha: 0.01,
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
    // 51 trades: the largest untested checkpoint is 40 (20 is forfeited).
    expect(tuner).toMatchObject({ checkpoint: 40, alpha: 0.01, needed: 40 });
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
      checkpoint: null,
      alpha: null,
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
  // One look at the 0.05 family budget: these tests check one search, not the schedule.
  const alpha = EVIDENCE_MAX_SEARCH_P;
  const house = (trades: ArenaClosedTrade[], seed = 's', shuffles?: number) =>
    searchFilterChange({ template: genesis.params, current: genesis.params, trades, house: true, seed, alpha, shuffles });

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
    const u = await searchFilterChange({ template: genesis.params, current: genesis.params, trades, house: false, seed: 's', alpha });
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
    const dec = await searchFilterChange({ template: runner.params, current: runner.params, trades: decimals, house: false, seed: 's', alpha });
    expect(dec.best!.summary).toMatchObject({ path: 'filters.chg5m_max', from: 41.48, to: 12.4, kept: 12, excluded: 12 });

    // Across noise data, every value a house or user search proposes has at
    // most 3 significant figures.
    let checked = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      for (const isHouse of [true, false]) {
        const result = await searchFilterChange({
          template: genesis.params, current: genesis.params, trades: noiseTrades(51, seed), house: isHouse, seed: `r-${seed}`, alpha, shuffles: 20,
        });
        if (!result.best) continue;
        const to = result.best.summary.to;
        expect(Number(to.toPrecision(3))).toBe(to);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test('(10) the band check runs BEFORE the 64-value cap: an in-band split is never cut away by out-of-band values', async () => {
    // Genesis mcap_min 10000 (band 5000 to 20000). Values in order: 10500,
    // 12000, then 150 values from 30000 up (out of band). Cut first, the even
    // spacing over 152 values keeps index 0 and then index 2, so 12000 (the
    // only in-band split) was lost and the search found nothing to change.
    const trades = [
      ...Array.from({ length: 12 }, (_, i) => arenaTrade(i, 0.5, 3_000, { mcap: 10_500 })),
      ...Array.from({ length: 12 }, (_, i) => arenaTrade(12 + i, 1.1, 3_000, { mcap: 12_000 })),
      ...Array.from({ length: 150 }, (_, i) => arenaTrade(24 + i, 1.1, 3_000, { mcap: 30_000 + i * 1_400 })),
    ];
    const result = await house(trades);
    expect(result.outcome).toBe('confirmed');
    expect(result.best!.summary).toMatchObject({ path: 'filters.mcap_min', from: 10_000, to: 12_000, kept: 162, excluded: 12 });
    expect(houseLeafInBand('filters.mcap_min', 10_000, 12_000)).toBe(true);
  });
});

describe('D33 checkpoint schedule (bookkeeping)', () => {
  test('(11) the constants: 20 first, ascending, one alpha each, summing to the 0.05 family budget', () => {
    expect([...TUNER_CHECKPOINTS]).toEqual([20, 40, 80, 160, 200, 400, 800]);
    expect([...TUNER_CHECKPOINT_ALPHA]).toEqual([0.01, 0.01, 0.01, 0.01, 0.005, 0.0025, 0.0025]);
    expect(TUNER_CHECKPOINTS[0]).toBe(MIN_CLOSED_FOR_AUTO_APPLY);
    expect(TUNER_CHECKPOINT_ALPHA).toHaveLength(TUNER_CHECKPOINTS.length);
    expect(TUNER_CHECKPOINT_ALPHA.reduce((a, b) => a + b, 0)).toBeCloseTo(EVIDENCE_MAX_SEARCH_P, 12);
  });

  test('(12) tunerCheckpointStep: largest untested checkpoint, forfeits, waiting, budget spent', () => {
    expect(tunerCheckpointStep(0, null)).toEqual({ kind: 'below_sample', needed: 20 });
    expect(tunerCheckpointStep(19, null)).toEqual({ kind: 'below_sample', needed: 20 });
    expect(tunerCheckpointStep(20, null)).toEqual({ kind: 'look', checkpoint: 20, alpha: 0.01 });
    expect(tunerCheckpointStep(25, 20)).toEqual({ kind: 'waiting_checkpoint', needed: 40 });
    // 57 trades, nothing tested: 40 is tested, 20 is forfeited for good.
    expect(tunerCheckpointStep(57, null)).toEqual({ kind: 'look', checkpoint: 40, alpha: 0.01 });
    expect(tunerCheckpointStep(57, 40)).toEqual({ kind: 'waiting_checkpoint', needed: 80 });
    expect(tunerCheckpointStep(199, 160)).toEqual({ kind: 'waiting_checkpoint', needed: 200 });
    expect(tunerCheckpointStep(200, 160)).toEqual({ kind: 'look', checkpoint: 200, alpha: 0.005 });
    // A jump past 200 and 400: 400 is tested at ITS alpha; 200's alpha is not reused.
    expect(tunerCheckpointStep(450, 160)).toEqual({ kind: 'look', checkpoint: 400, alpha: 0.0025 });
    expect(tunerCheckpointStep(450, 400)).toEqual({ kind: 'waiting_checkpoint', needed: 800 });
    expect(tunerCheckpointStep(800, 400)).toEqual({ kind: 'look', checkpoint: 800, alpha: 0.0025 });
    expect(tunerCheckpointStep(5_000, 80)).toEqual({ kind: 'look', checkpoint: 800, alpha: 0.0025 });
    expect(tunerCheckpointStep(800, 800)).toEqual({ kind: 'budget_spent' });
    expect(tunerCheckpointStep(5_000, 800)).toEqual({ kind: 'budget_spent' });
  });

  test('(13) through the tick: each checkpoint once, no search between, budget_spent after 800, restart on a new params version', async () => {
    // Identical entry features: every look ends no_candidate, so nothing
    // changes and the version stays 1 for the whole run.
    const flat = (count: number, version = 1) =>
      Array.from({ length: count }, (_, i) => ({ ...arenaTrade(i, i % 3 === 0 ? 0.4 : 1.1, 3_000), paramsVersion: version }));
    let a = agent();
    let visible: ArenaClosedTrade[] = [];
    let tickAt = NOW;
    let lastChangeReads = 0;
    const store = fakeStore({ candidates: [] });
    store.listCandidates = async () => [candidate(a, { lastReportAt: new Date(tickAt.getTime() - 31 * MIN) })];
    store.loadClosedTrades = async () => visible;
    // An automatic agent reads its last change time only at a look, before the search.
    store.lastParamChangeAt = async () => { lastChangeReads += 1; return null; };
    const { llm } = nullModel();
    const tickWith = async (trades: ArenaClosedTrade[]) => {
      visible = trades;
      tickAt = new Date(tickAt.getTime() + 31 * MIN);
      await runArenaAnalysisTickWith({ store, llm, log: quietLog, tunerShuffles: 50 }, tickAt);
      return store.reports[store.reports.length - 1]!.stats.suggestionCheck.tuner!;
    };

    expect(await tickWith(flat(12))).toMatchObject({ reason: 'below_sample', needed: 20, checkpoint: null, alpha: null });
    expect(await tickWith(flat(20))).toMatchObject({ reason: 'no_candidate', n: 20, needed: 20, checkpoint: 20, alpha: 0.01 });
    expect(await tickWith(flat(30))).toEqual({
      decision: 'none', reason: 'waiting_checkpoint', n: 30, needed: 40, best: null, p: null, checkpoint: null, alpha: null,
    });
    // 90 trades: 80 is tested, 40 is forfeited.
    expect(await tickWith(flat(90))).toMatchObject({ reason: 'no_candidate', n: 90, needed: 80, checkpoint: 80, alpha: 0.01 });
    expect(await tickWith(flat(150))).toMatchObject({ reason: 'waiting_checkpoint', needed: 160, checkpoint: null });
    // 850 trades: 800 is tested; 160, 200 and 400 are forfeited.
    expect(await tickWith(flat(850))).toMatchObject({ reason: 'no_candidate', n: 850, needed: 800, checkpoint: 800, alpha: 0.0025 });
    const spent = await tickWith(flat(900));
    expect(spent).toEqual({
      decision: 'none', reason: 'budget_spent', n: 900, needed: null, best: null, p: null, checkpoint: null, alpha: null,
    });
    expect(tunerMemoryLine(spent)).toBe(
      'Tuner decision: none (reason: budget_spent); 900 closed trades on the current params, every test of these params is used, so code changes nothing until the params change.',
    );
    // Three looks (20, 80, 800): only they read the change time (no search ran between).
    expect(lastChangeReads).toBe(3);

    // A params change starts a new version: the schedule starts again at 20.
    a = agent({ paramsVersion: 2 });
    expect(await tickWith([...flat(900, 1), ...flat(25, 2)])).toMatchObject({
      reason: 'no_candidate', n: 25, needed: 20, checkpoint: 20, alpha: 0.01,
    });
    expect(await tickWith([...flat(900, 1), ...flat(30, 2)])).toMatchObject({ reason: 'waiting_checkpoint', n: 30, needed: 40 });
    expect(lastChangeReads).toBe(4);
    expect(store.changes).toHaveLength(0);
  });
});

describe('D33 checkpoint schedule (repeated looks)', () => {
  test('(9) multi-look: 150 pure-noise streams, a report every 2 trades from 20 to 400: at most 7% ever change', async () => {
    // Every report looks at a growing sample. Testing each look at p <= 0.05
    // is optional stopping: this same test on the 10cd060d code (a search on
    // every report at p <= 0.05, 2000 shuffles) gave 80/150 = 53%. The
    // schedule tests each checkpoint once at its own alpha, 0.05 in total per
    // params version: 6/150 = 4% here.
    const started = performance.now();
    let changed = 0;
    const streams = 150;
    for (let s = 0; s < streams; s += 1) {
      if (await streamEverChanges(5_000 + s, { from: 20, to: 400, step: 2, shuffles: MULTI_LOOK_SHUFFLES })) changed += 1;
    }
    console.log(`[multi-look] ${changed}/${streams} noise streams changed (${Math.round(performance.now() - started)} ms)`);
    expect(changed / streams).toBeLessThanOrEqual(0.07);
  }, 120_000);
});
