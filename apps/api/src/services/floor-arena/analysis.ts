/**
 * Trading Floor Arena: the 30-minute analysis and house tuner
 * (docs/trading-floor-arena.md D10).
 *
 * Every arena agent with activity gets one report about every 30 minutes:
 *   1. STATS, computed here in plain code (no LLM): trades, exits by reason,
 *      deaths (pnl_mult <= 0.5), severe (<= 0.6, deaths included), win rate,
 *      realised USD, mean multiple, best/worst, and per-feature cuts on the
 *      closed trades (pair age, 5-minute change sign, 1-hour volume over market
 *      cap, discovery source). Three windows: the period, the trades opened
 *      under the CURRENT params version, and the whole life of the agent.
 *   2. A SUMMARY (commentary only) from the LLM on the shared InferenceRouter
 *      `default` route (the route the NPC banter engine uses; no provider key
 *      of our own). The prompt carries the template thesis, the live params,
 *      the hard rules, the stats and the last three reports. The model is told
 *      to set `suggestion` to null, and code ignores any proposal (D33: since
 *      D27 the model proposed nothing, so the tuner never ran).
 *   3. THE CODE TUNER (D33, `searchFilterChange`) on EVERY due report, quiet
 *      ones included, whatever the model replied: one-filter tightenings of
 *      the filters the template sets, at values observed in the entry
 *      features (never from outcomes), inside the house band for a house agent
 *      and inside the validation bounds for a user agent, judged on the closed
 *      trades of the CURRENT params version. The best split must pass D27
 *      (`MIN_CLOSED_FOR_AUTO_APPLY` trades, `EVIDENCE_MIN_PER_SIDE` per side,
 *      `EVIDENCE_MIN_EDGE` raw mean edge) AND a max-statistic shuffle test over
 *      the whole search family (p <= `EVIDENCE_MAX_SEARCH_P`). The outcome is
 *      always in `stats.suggestionCheck.tuner`.
 *   4. APPLY: a house agent applies a confirmed change itself (source
 *      `house-tuner`), and so does a user agent whose owner turned on
 *      `auto_apply_suggestions` (source `suggestion`); at most one automatic
 *      change per agent per 30 minutes, and an automatic agent never gets a
 *      pending suggestion. Any other user agent gets the confirmed change as a
 *      `pending` suggestion with its evidence; the owner's click is the only
 *      write.
 *   5. MEMORY (D29): every FULL report of a user agent (never a short
 *      no-trade report, which is not a useful lesson) is stored as an
 *      earned-skill lesson of the owner's avatar, in its warm hosted ElizaOS
 *      runtime or else the avatar-keyed keyword store (`writeArenaReportMemory`;
 *      never lazy-starts a runtime, never throws).
 *
 * If the LLM fails or times out the report is still written, with a
 * deterministic summary and no suggestion. Nothing here moves money: the arena
 * is paper only.
 *
 * Shape: pure functions first (stats, prompt, parsing, validation), then
 * `runArenaAnalysisTickWith(deps, now)` over an injectable store, LLM and
 * memory writer, so the tests run with no database and no network. The
 * production wiring is `runArenaAnalysisTick(now)` at the bottom.
 */

import {
  FLOOR_ARENA_EVENT_SUMMARY_MAX,
  FLOOR_ARENA_FILTER_KEYS,
  FLOOR_ARENA_HARD_RULES,
  FLOOR_ARENA_PARAM_BOUNDS,
  FLOOR_ARENA_PARAM_PATHS,
  applyFloorArenaParamChange,
  diffFloorArenaParams,
  floorArenaTemplateById,
  validateFloorArenaParams,
  type FloorArenaAgentKind,
  type FloorArenaFilters,
  type FloorArenaParamChangeSource,
  type FloorArenaParamDiff,
  type FloorArenaParams,
  type FloorArenaSuggestion,
  type FloorArenaSuggestionState,
  type FloorArenaTemplate,
} from '@clawville/shared';
import {
  ARENA_AUTO_CHANGE_MIN_GAP_MS,
  ARENA_QUIET_REPORT_INTERVAL_MS,
  ARENA_REPORT_INTERVAL_MS,
  EVIDENCE_MAX_SEARCH_P,
  EVIDENCE_MIN_EDGE,
  EVIDENCE_MIN_PER_SIDE,
  EVIDENCE_PERMUTATIONS,
  MIN_CLOSED_FOR_AUTO_APPLY,
} from './analysis-rules';
import { finiteOrNull, pairAgeSeconds, passesFilters, volOverMcap, type FloorArenaFeatures } from './filters';
import { redactArenaText } from './queries';

// ── Tuning constants ──────────────────────────────────────────────────────────

/** A period never reaches further back than this (after an outage the older
 *  trades still count in the lifetime stats). */
export const ARENA_MAX_PERIOD_MS = 6 * 60 * 60_000;
export const ARENA_LLM_TIMEOUT_MS = 20_000;
export const ARENA_LLM_CONCURRENCY = 2;
/** LLM reports per tick. With the timeout and concurrency above, a tick
 *  spends at most about 12 / 2 * 20 s = 2 minutes waiting on the model. */
export const ARENA_MAX_LLM_REPORTS_PER_TICK = 12;
export const ARENA_MAX_QUIET_REPORTS_PER_TICK = 40;
/** Newest closed trades loaded for the lifetime stats. */
export const ARENA_LIFETIME_TRADE_LIMIT = 5_000;
export {
  ARENA_AUTO_CHANGE_MIN_GAP_MS,
  ARENA_QUIET_REPORT_INTERVAL_MS,
  ARENA_REPORT_INTERVAL_MS,
  EVIDENCE_MAX_SEARCH_P,
  EVIDENCE_MIN_EDGE,
  EVIDENCE_MIN_PER_SIDE,
  EVIDENCE_PERMUTATIONS,
  MIN_CLOSED_FOR_AUTO_APPLY,
  MIN_CLOSED_ON_CURRENT_PARAMS,
} from './analysis-rules';
/** D33: the tuner judges at most this many closed trades of the current
 *  params (the newest), so its CPU cost has a ceiling however long a version
 *  lives. */
export const TUNER_MAX_TRADES = 200;
/** D33: at most this many candidate values per filter leaf (evenly spaced by
 *  rank when there are more); chosen from entry features only. */
export const TUNER_MAX_VALUES_PER_LEAF = 64;
/** D33: the search yields the event loop after at most this much CPU time. */
export const TUNER_SLICE_MS = 15;
/** A house agent may differ from its template in at most this many leaves. */
export const HOUSE_MAX_DRIFT_FIELDS = 4;
/** Allowed range for a template leaf of 0 (the percent-change filters). */
export const HOUSE_ZERO_BAND = 10;
/** A second report inside this window is a duplicate (two leaders during a
 *  failover run the same tick); shorter than ARENA_REPORT_INTERVAL_MS. */
export const ARENA_DUPLICATE_WINDOW_MS = 25 * 60_000;

export const ARENA_DEATH_MULT = 0.5;
export const ARENA_SEVERE_MULT = 0.6;

const SUMMARY_MAX = 500;
const OBSERVATIONS_MAX = 4;
const OBSERVATION_CHARS = 200;
const REASON_CHARS = 200;
const PRIOR_REPORTS = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

/** One closed position, as the analysis reads it. */
export interface ArenaClosedTrade {
  openedAt: Date;
  closedAt: Date;
  paramsVersion: number;
  exitReason: string | null;
  pnlUsd: number;
  pnlMult: number;
  source: string | null;
  /** `floor_arena_positions.entry_features` (the engine's filter features). */
  features: Record<string, unknown> | null;
}

export interface ArenaBucketStats {
  n: number;
  wins: number;
  deaths: number;
  realisedUsd: number;
  meanMult: number | null;
}

export interface ArenaTradeStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  exits: { tp: number; stop: number; trail: number; time: number; manual: number; other: number };
  deaths: number;
  /** pnl_mult <= 0.6, deaths included. */
  severe: number;
  realisedUsd: number;
  meanMult: number | null;
  bestMult: number | null;
  worstMult: number | null;
  bestUsd: number | null;
  worstUsd: number | null;
  cuts: {
    age: Record<string, ArenaBucketStats>;
    chg5m: Record<string, ArenaBucketStats>;
    volOverMcap: Record<string, ArenaBucketStats>;
    source: Record<string, ArenaBucketStats>;
  };
}

export type ArenaLlmOutcome = 'ok' | 'failed' | 'skipped';

export interface ArenaSuggestionCheck {
  llm: ArenaLlmOutcome;
  /** Why no suggestion was stored, or why it stayed pending. */
  reason?: string;
  /** Validation errors, when the reason is `invalid_params`. */
  errors?: string[];
  /** The model's raw proposal, kept for the record when it was rejected
   *  (reports written before D33; the model proposes nothing since). */
  proposed?: { path: string; to: unknown };
  /** The D27 split check of the stored suggestion on the current params'
   *  closed trades (only when the report stores a suggestion or a change). */
  evidence?: ArenaSuggestionEvidence;
  /** D33: the code tuner's decision. Written on every report since D33. */
  tuner?: ArenaTunerCheck;
}

export type ArenaTunerDecision = 'changed' | 'suggested' | 'none';
export type ArenaTunerReason =
  | 'below_sample'
  | 'no_candidate'
  | 'not_significant'
  | 'rate_limited'
  | 'changed'
  | 'suggested'
  | 'params_changed'
  | 'not_tunable';

/** The best one-filter change the search found (display values). */
export interface ArenaTunerBest {
  path: string;
  from: number;
  to: number;
  /** Closed trades the new value keeps / excludes. */
  kept: number;
  excluded: number;
  /** Kept mean pnl_mult minus excluded mean pnl_mult, rounded to 4 places
   *  (the decision used the raw value). */
  edge: number;
}

/** `stats.suggestionCheck.tuner` (D33). Other code renders this exact shape. */
export interface ArenaTunerCheck {
  decision: ArenaTunerDecision;
  /** below_sample: fewer than `needed` closed trades; no_candidate: no legal
   *  one-filter split (>= EVIDENCE_MIN_PER_SIDE per side); not_significant:
   *  the best split failed the D27 edge or the shuffle test; rate_limited: an
   *  automatic change happened less than 30 minutes ago; params_changed: the
   *  params moved between the read and the apply; not_tunable: the stored
   *  params fail validation or the template is unknown. */
  reason: ArenaTunerReason;
  /** Closed trades on the current params version the search judged. */
  n: number;
  needed: number;
  best: ArenaTunerBest | null;
  /** Max-statistic shuffle p of the best edge (4 places); null when no
   *  shuffle test ran. */
  p: number | null;
}

export interface ArenaEvidenceSide {
  n: number;
  meanMult: number | null;
  deaths: number;
}

export interface ArenaSuggestionEvidence {
  /** `filter_split`: judged on the closed trades; `not_evaluable`: the leaf
   *  cannot be judged honestly from closed trades (exits, entry, limits). */
  method: 'filter_split' | 'not_evaluable';
  confirmed: boolean;
  /** Why the check did not confirm the change. */
  reason?: string;
  kept?: ArenaEvidenceSide;
  excluded?: ArenaEvidenceSide;
  /** kept.meanMult - excluded.meanMult. */
  edge?: number | null;
}

/** `floor_arena_reports.stats`. */
export interface ArenaReportStats {
  version: 1;
  periodMinutes: number;
  status: string;
  seated: boolean;
  openPositions: number;
  paramsVersion: number;
  period: ArenaTradeStats & { entries: number; paramsVersions: number[] };
  currentParams: ArenaTradeStats;
  lifetime: ArenaTradeStats & { truncated: boolean };
  observations: string[];
  suggestionCheck: ArenaSuggestionCheck;
}

/** The agent row fields the analysis needs. */
export interface ArenaAnalysisAgent {
  id: string;
  kind: FloorArenaAgentKind;
  name: string;
  templateId: string;
  params: unknown;
  paramsVersion: number;
  status: string;
  seated: boolean;
  autoApplySuggestions: boolean;
  avatarId: string | null;
  createdAt: Date;
}

export interface ArenaAnalysisCandidate {
  agent: ArenaAnalysisAgent;
  lastReportAt: Date | null;
  lastReportPeriodEnd: Date | null;
  /** Positions closed after the last report's period end (or since creation). */
  closedSince: number;
  /** Positions opened after the last report's period end (or since creation). */
  openedSince: number;
}

export interface ArenaPriorReport {
  createdAt: Date;
  summary: string;
  suggestion: FloorArenaSuggestion | null;
  suggestionState: FloorArenaSuggestionState;
}

export interface ArenaReportWrite {
  agentId: string;
  periodStart: Date;
  periodEnd: Date;
  stats: ArenaReportStats;
  summary: string;
  suggestion: FloorArenaSuggestion | null;
  suggestionState: FloorArenaSuggestionState;
  /** The `report` event line (<= 280 chars). */
  eventSummary: string;
}

export interface ArenaParamChangeWrite {
  agentId: string;
  /** The PENDING report whose suggestion this applies; it moves to `auto_applied`. */
  reportId: string;
  /** The params the change was computed from; the write aborts if the row moved on. */
  expectedParamsVersion: number;
  params: FloorArenaParams;
  changes: FloorArenaParamDiff[];
  source: Extract<FloorArenaParamChangeSource, 'house-tuner' | 'suggestion'>;
  reason: string;
  /** The `param_change` event line (<= 280 chars). */
  eventSummary: string;
}

export interface ArenaAnalysisStore {
  /** Agents that are due or nearly due; the tick applies the exact rules. */
  listCandidates(now: Date): Promise<ArenaAnalysisCandidate[]>;
  /** Newest closed trades first, at most `limit`. */
  loadClosedTrades(agentId: string, limit: number): Promise<ArenaClosedTrade[]>;
  countOpened(agentId: string, from: Date, to: Date): Promise<number>;
  countOpen(agentId: string): Promise<number>;
  loadRecentReports(agentId: string, limit: number): Promise<ArenaPriorReport[]>;
  lastParamChangeAt(agentId: string): Promise<Date | null>;
  /**
   * Inserts the report and its `report` event in one transaction, under a
   * per-agent lock. Returns `{ duplicate: true }` and writes nothing when the
   * agent already has a report from the last ARENA_DUPLICATE_WINDOW_MS (two
   * leaders during a failover).
   */
  insertReport(report: ArenaReportWrite): Promise<{ reportId: string } | { duplicate: true }>;
  /**
   * The ONE arena params writer (`updateArenaAgentParams`): claims the pending
   * report as `auto_applied`, re-checks `params_version`, updates the params and
   * writes the `floor_arena_param_changes` row and the `param_change` event, in
   * one transaction.
   */
  applyParamChange(change: ArenaParamChangeWrite): Promise<
    { ok: true; paramsVersion: number } | { ok: false; reason: 'version_conflict' | 'report_not_pending' }
  >;
  /** Moves a still-pending report to `rejected`, drops its suggestion, and
   *  records `reason` in `stats.suggestionCheck.reason` and, when given,
   *  `tuner` in `stats.suggestionCheck.tuner`, in ONE update. */
  rejectPendingReport(reportId: string, agentId: string, reason: string, tuner?: ArenaTunerCheck): Promise<void>;
}

export interface ArenaInferenceMessage {
  role: 'system' | 'user';
  content: string;
}

/** Returns the raw model text. May throw; the tick time-boxes it. */
export type ArenaLlm = (messages: ArenaInferenceMessage[]) => Promise<string>;

export interface ArenaReportMemoryInput {
  agentId: string;
  agentName: string;
  avatarId: string;
  text: string;
}

export interface ArenaAnalysisDeps {
  store: ArenaAnalysisStore;
  llm: ArenaLlm;
  /** Best effort; errors are logged, never thrown. */
  writeMemory?: (input: ArenaReportMemoryInput) => Promise<unknown>;
  log?: (line: string) => void;
  /** Defaults to ARENA_LLM_TIMEOUT_MS; tests shorten it. */
  llmTimeoutMs?: number;
}

export interface ArenaTickResult {
  reports: number;
  llmCalls: number;
  llmFailures: number;
  applied: number;
  pending: number;
  rejected: number;
  deferred: number;
}

// ── Stats (pure) ──────────────────────────────────────────────────────────────

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function ageBucket(ageS: number | null): string {
  if (ageS === null) return 'unknown';
  if (ageS < 1_800) return '<30m';
  if (ageS < 7_200) return '30m-2h';
  if (ageS < 21_600) return '2h-6h';
  if (ageS < 86_400) return '6h-24h';
  return '>=24h';
}

export function chg5mBucket(chg: number | null): string {
  if (chg === null) return 'unknown';
  if (chg < 0) return 'down';
  if (chg > 0) return 'up';
  return 'flat';
}

export function volOverMcapBucket(ratio: number | null): string {
  if (ratio === null) return 'unknown';
  if (ratio < 0.1) return '<0.1';
  if (ratio < 0.5) return '0.1-0.5';
  if (ratio < 1) return '0.5-1';
  if (ratio < 3) return '1-3';
  return '>=3';
}

const SOURCE_KEY = /^[a-z0-9][a-z0-9:_.-]{0,39}$/i;

export function sourceBucket(source: string | null): string {
  if (!source) return 'unknown';
  return SOURCE_KEY.test(source) ? source : 'other';
}

interface BucketAccumulator {
  n: number;
  wins: number;
  deaths: number;
  usd: number;
  multSum: number;
}

function addToBucket(map: Map<string, BucketAccumulator>, key: string, trade: ArenaClosedTrade): void {
  const acc = map.get(key) ?? { n: 0, wins: 0, deaths: 0, usd: 0, multSum: 0 };
  acc.n += 1;
  if (trade.pnlUsd > 0) acc.wins += 1;
  if (trade.pnlMult <= ARENA_DEATH_MULT) acc.deaths += 1;
  acc.usd += trade.pnlUsd;
  acc.multSum += trade.pnlMult;
  map.set(key, acc);
}

function finishBuckets(map: Map<string, BucketAccumulator>): Record<string, ArenaBucketStats> {
  const out: Record<string, ArenaBucketStats> = {};
  for (const key of [...map.keys()].sort()) {
    const acc = map.get(key)!;
    out[key] = {
      n: acc.n,
      wins: acc.wins,
      deaths: acc.deaths,
      realisedUsd: round(acc.usd, 2),
      meanMult: acc.n > 0 ? round(acc.multSum / acc.n, 4) : null,
    };
  }
  return out;
}

/** Deterministic stats for a set of closed trades. Order does not matter. A
 *  trade without a finite P&L (an 'unresolved' exit) counts nowhere. */
export function computeArenaTradeStats(input: readonly ArenaClosedTrade[]): ArenaTradeStats {
  const trades = input.filter((t) => Number.isFinite(t.pnlUsd) && Number.isFinite(t.pnlMult));
  const exits = { tp: 0, stop: 0, trail: 0, time: 0, manual: 0, other: 0 };
  const age = new Map<string, BucketAccumulator>();
  const chg5m = new Map<string, BucketAccumulator>();
  const vol = new Map<string, BucketAccumulator>();
  const source = new Map<string, BucketAccumulator>();
  let wins = 0;
  // The leaderboard's rule: a break-even close is neither a win nor a loss.
  let losses = 0;
  let deaths = 0;
  let severe = 0;
  let usd = 0;
  let multSum = 0;
  let bestMult: number | null = null;
  let worstMult: number | null = null;
  let bestUsd: number | null = null;
  let worstUsd: number | null = null;

  for (const trade of trades) {
    const reason = trade.exitReason;
    if (reason === 'tp' || reason === 'stop' || reason === 'trail' || reason === 'time' || reason === 'manual') {
      exits[reason] += 1;
    } else {
      exits.other += 1;
    }
    if (trade.pnlUsd > 0) wins += 1;
    if (trade.pnlUsd < 0) losses += 1;
    if (trade.pnlMult <= ARENA_DEATH_MULT) deaths += 1;
    if (trade.pnlMult <= ARENA_SEVERE_MULT) severe += 1;
    usd += trade.pnlUsd;
    multSum += trade.pnlMult;
    bestMult = bestMult === null ? trade.pnlMult : Math.max(bestMult, trade.pnlMult);
    worstMult = worstMult === null ? trade.pnlMult : Math.min(worstMult, trade.pnlMult);
    bestUsd = bestUsd === null ? trade.pnlUsd : Math.max(bestUsd, trade.pnlUsd);
    worstUsd = worstUsd === null ? trade.pnlUsd : Math.min(worstUsd, trade.pnlUsd);

    const f = trade.features ?? {};
    addToBucket(age, ageBucket(finite(f.ageS)), trade);
    addToBucket(chg5m, chg5mBucket(finite(f.chg5m)), trade);
    addToBucket(vol, volOverMcapBucket(finite(f.volOverMcap)), trade);
    addToBucket(source, sourceBucket(trade.source), trade);
  }

  const n = trades.length;
  return {
    trades: n,
    wins,
    losses,
    winRate: n > 0 ? round(wins / n, 4) : null,
    exits,
    deaths,
    severe,
    realisedUsd: round(usd, 2),
    meanMult: n > 0 ? round(multSum / n, 4) : null,
    bestMult: bestMult === null ? null : round(bestMult, 4),
    worstMult: worstMult === null ? null : round(worstMult, 4),
    bestUsd: bestUsd === null ? null : round(bestUsd, 2),
    worstUsd: worstUsd === null ? null : round(worstUsd, 2),
    cuts: {
      age: finishBuckets(age),
      chg5m: finishBuckets(chg5m),
      volOverMcap: finishBuckets(vol),
      source: finishBuckets(source),
    },
  };
}

// ── Suggestion validation (pure) ──────────────────────────────────────────────

/** Flattens params to leaf paths. `exits.tp` legs become `exits.tp.<i>.<0|1>`. */
export function flattenArenaParams(params: FloorArenaParams): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const path of FLOOR_ARENA_PARAM_PATHS) {
    const [section, key] = path.split('.') as [keyof FloorArenaParams, string];
    const value = (params[section] as unknown as Record<string, unknown>)[key];
    if (path === 'exits.tp' && Array.isArray(value)) {
      value.forEach((leg, i) => {
        if (Array.isArray(leg)) leg.forEach((part, j) => out.set(`exits.tp.${i}.${j}`, part));
      });
      out.set('exits.tp.legs', value.length);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

const EPS = 1e-9;

function inBand(value: number, lo: number, hi: number): boolean {
  return value >= Math.min(lo, hi) - EPS && value <= Math.max(lo, hi) + EPS;
}

/**
 * Whether a house-agent leaf may move from the template value `base` to
 * `value`. The band is "half to double" of the quantity the leaf controls:
 *   - a take-profit or trail-arm multiple: the gain above 1 (1.10 -> 1.05..1.20);
 *   - the stop multiple: the loss below 1 (0.90 -> 0.80..0.95);
 *   - any other positive or negative number: the value itself, same sign;
 *   - a template value of 0: within +/- HOUSE_ZERO_BAND (percent filters).
 */
export function houseLeafInBand(path: string, base: number, value: number): boolean {
  if (/^exits\.tp\.\d+\.0$/.test(path) || path === 'exits.trail_arm_mult') {
    const gain = base - 1;
    return gain > 0 && inBand(value - 1, gain / 2, gain * 2);
  }
  if (path === 'exits.stop_mult') {
    const loss = 1 - base;
    return loss > 0 && inBand(1 - value, loss / 2, loss * 2);
  }
  if (base === 0) return Math.abs(value) <= HOUSE_ZERO_BAND + EPS;
  return inBand(value, base / 2, base * 2);
}

/**
 * The house-agent identity guard. A house agent IS its template on the public
 * board, so the tuner may only adjust what the template already uses:
 *   - no filter or exit may be switched on or off (null stays null, a set
 *     value stays set), `entry.rank_by` and every take-profit fraction stay as
 *     the template has them, and the number of take-profit legs is fixed;
 *   - a leaf the change moves must land inside `houseLeafInBand` of the
 *     template value;
 *   - at most HOUSE_MAX_DRIFT_FIELDS leaves may differ from the template, and
 *     a change never raises that count above the cap.
 * Only the leaves the change moves are judged, so an admin edit on another
 * leaf does not block the tuner. Returns null when allowed, else the reason.
 */
export function checkHouseDrift(
  template: FloorArenaParams,
  current: FloorArenaParams,
  next: FloorArenaParams,
): string | null {
  const base = flattenArenaParams(template);
  const now = flattenArenaParams(current);
  const cand = flattenArenaParams(next);
  if (now.get('exits.tp.legs') !== cand.get('exits.tp.legs')) return 'exits.tp: the number of legs is locked for house agents';
  for (const [path, c] of cand) {
    if (Object.is(now.get(path), c)) continue;
    const b = base.get(path);
    if (path === 'limits.position_usd') return `${path}: locked`;
    if (b === undefined || b === null || c === null) return `${path}: cannot be switched on or off`;
    if (typeof b !== 'number' || typeof c !== 'number') return `${path}: locked for house agents`;
    if (/^exits\.tp\.\d+\.1$/.test(path)) return `${path}: take-profit fraction is locked for house agents`;
    if (!houseLeafInBand(path, b, c)) return `${path}: ${c} is outside the house band around the template value ${b}`;
  }
  const drift = (params: Map<string, unknown>) =>
    [...base].filter(([path, b]) => !Object.is(params.get(path), b)).length;
  const after = drift(cand);
  if (after > HOUSE_MAX_DRIFT_FIELDS && after > drift(now)) {
    return `more than ${HOUSE_MAX_DRIFT_FIELDS} fields would differ from the template`;
  }
  return null;
}

export type ArenaSuggestionEvaluation =
  | { ok: true; next: FloorArenaParams; change: FloorArenaParamDiff }
  | { ok: false; reason: string; errors?: string[] };

/**
 * Checks one proposed change against the live params. Used by the tick for
 * the model's proposal, and exported so the one-click apply route re-checks a
 * stored suggestion against the params as they are NOW:
 *   - `path` must be a leaf in FLOOR_ARENA_PARAM_PATHS, never `limits.position_usd`;
 *   - the result must pass `validateFloorArenaParams`;
 *   - exactly one leaf may differ from `current`;
 *   - for a house agent (`template` given) the result must pass `checkHouseDrift`.
 */
export function evaluateArenaSuggestion(input: {
  current: FloorArenaParams;
  path: string;
  to: unknown;
  template?: FloorArenaParams | null;
}): ArenaSuggestionEvaluation {
  const path = input.path.trim();
  if (path === 'limits.position_usd') return { ok: false, reason: 'position_usd_locked' };
  if (!FLOOR_ARENA_PARAM_PATHS.includes(path)) return { ok: false, reason: 'unknown_path' };
  const to = input.to;
  const shapeOk =
    to === null ||
    typeof to === 'string' ||
    (typeof to === 'number' && Number.isFinite(to)) ||
    Array.isArray(to);
  if (!shapeOk) return { ok: false, reason: 'invalid_value' };

  const candidate = applyFloorArenaParamChange(input.current, path, to);
  const checked = validateFloorArenaParams(candidate);
  if (!checked.ok) return { ok: false, reason: 'invalid_params', errors: checked.errors.slice(0, 5) };

  const diff = diffFloorArenaParams(input.current, checked.params);
  if (diff.length === 0) return { ok: false, reason: 'no_change' };
  if (diff.length !== 1) return { ok: false, reason: 'not_one_change' };

  if (input.template) {
    const drift = checkHouseDrift(input.template, input.current, checked.params);
    if (drift) return { ok: false, reason: 'identity_drift', errors: [drift] };
  }
  return { ok: true, next: checked.params, change: diff[0]! };
}

/** The UNROUNDED mean pnl_mult; the decision uses this, never a display value. */
function rawMeanMult(trades: readonly ArenaClosedTrade[]): number | null {
  return trades.length > 0 ? trades.reduce((total, t) => total + t.pnlMult, 0) / trades.length : null;
}

/** The side as stored in the report: means rounded for display only. */
function evidenceSide(trades: readonly ArenaClosedTrade[], mean: number | null): ArenaEvidenceSide {
  return {
    n: trades.length,
    meanMult: mean === null ? null : round(mean, 4),
    deaths: trades.filter((t) => t.pnlMult <= ARENA_DEATH_MULT).length,
  };
}

/**
 * The instant the engine judged a trade's filters: `entry_features.judgedAt`
 * (the entry tick's time). `openedAt` is the later insert time, so a pair-age
 * filter replayed at it can flip a trade near a bound. Rows written before
 * `judgedAt` existed (or with an unreadable value) fall back to `openedAt`.
 */
export function tradeJudgedAt(trade: ArenaClosedTrade): Date {
  const raw = trade.features?.judgedAt;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return trade.openedAt;
}

/**
 * D27: the deterministic check an AUTOMATIC change must pass. Only a filter
 * change can be judged from closed trades: each trade is re-run through the
 * engine's own `passesFilters` on its entry features, at the instant the engine
 * judged them (`tradeJudgedAt`), under the current and the new filters. A
 * trade is EXCLUDED when the new value adds a fail code the current filters
 * did not have, else KEPT. The change is
 * confirmed only when both sides hold at least EVIDENCE_MIN_PER_SIDE trades and
 * the kept side's mean pnl_mult beats the excluded side's by at least
 * EVIDENCE_MIN_EDGE. A looser filter excludes nothing, so it can never be
 * confirmed: the coins it would add have no track record here.
 *
 * Exit, entry and limit changes are `not_evaluable`: closed trades do not show
 * what a different take-profit, stop, hold time or rank would have done
 * without the price path, so they are never applied automatically.
 *
 * `trades` must be the closed trades opened under the CURRENT params.
 */
export function evaluateSuggestionEvidence(input: {
  change: FloorArenaParamDiff;
  current: FloorArenaParams;
  next: FloorArenaParams;
  trades: readonly ArenaClosedTrade[];
}): ArenaSuggestionEvidence {
  if (!input.change.path.startsWith('filters.')) {
    return {
      method: 'not_evaluable',
      confirmed: false,
      reason: 'only a filter change can be checked against closed trades',
    };
  }
  const kept: ArenaClosedTrade[] = [];
  const excluded: ArenaClosedTrade[] = [];
  for (const trade of input.trades) {
    if (!Number.isFinite(trade.pnlMult)) continue;
    const features = (trade.features ?? {}) as unknown as FloorArenaFeatures;
    const judgedAt = tradeJudgedAt(trade);
    const before = new Set(passesFilters(features, input.current.filters, judgedAt));
    const after = passesFilters(features, input.next.filters, judgedAt);
    if (after.some((code) => !before.has(code))) excluded.push(trade);
    else kept.push(trade);
  }
  // Decide on the RAW means and raw counts (Codex r12): rounding each mean to 4
  // places first can lift a real 0.02992 edge to 0.03 and confirm it. The
  // rounded values are for the stored report only. EPS absorbs float noise
  // (1e-9), far below any edge the rounding could have moved.
  const keptMean = rawMeanMult(kept);
  const excludedMean = rawMeanMult(excluded);
  const rawEdge = keptMean !== null && excludedMean !== null ? keptMean - excludedMean : null;
  const base = {
    method: 'filter_split' as const,
    kept: evidenceSide(kept, keptMean),
    excluded: evidenceSide(excluded, excludedMean),
    edge: rawEdge === null ? null : round(rawEdge, 4),
  };
  if (excluded.length === 0) {
    return { ...base, confirmed: false, reason: 'the new value excludes no traded coin, so nothing shows it helps' };
  }
  if (kept.length < EVIDENCE_MIN_PER_SIDE || excluded.length < EVIDENCE_MIN_PER_SIDE) {
    return { ...base, confirmed: false, reason: `each side needs at least ${EVIDENCE_MIN_PER_SIDE} closed trades` };
  }
  if (rawEdge === null || rawEdge < EVIDENCE_MIN_EDGE - EPS) {
    return { ...base, confirmed: false, reason: `the kept trades must beat the excluded ones by at least ${EVIDENCE_MIN_EDGE} mean multiple` };
  }
  return { ...base, confirmed: true };
}

// ── D33 code tuner: one-filter search + max-statistic shuffle test ────────────

/** The entry feature each filter judges, exactly as `passesFilters` reads it. */
const FILTER_FEATURE: Readonly<Record<keyof FloorArenaFilters, (f: FloorArenaFeatures, judgedAtMs: number) => number | null>> = {
  mcap_min: (f) => finiteOrNull(f.mcap),
  mcap_max: (f) => finiteOrNull(f.mcap),
  liq_min: (f) => finiteOrNull(f.liqUsd),
  liq_max: (f) => finiteOrNull(f.liqUsd),
  age_min_s: (f, t) => pairAgeSeconds(f, t),
  age_max_s: (f, t) => pairAgeSeconds(f, t),
  vol1h_over_mcap_min: (f) => volOverMcap(f),
  vol1h_over_mcap_max: (f) => volOverMcap(f),
  chg5m_min: (f) => finiteOrNull(f.chg5m),
  chg5m_max: (f) => finiteOrNull(f.chg5m),
  chg1h_min: (f) => finiteOrNull(f.chg1h),
  chg1h_max: (f) => finiteOrNull(f.chg1h),
  chg6h_min: (f) => finiteOrNull(f.chg6h),
  chg6h_max: (f) => finiteOrNull(f.chg6h),
  chg24h_min: (f) => finiteOrNull(f.chg24h),
  chg24h_max: (f) => finiteOrNull(f.chg24h),
  txns1h_min: (f) => finiteOrNull(f.txns1h),
  txns1h_max: (f) => finiteOrNull(f.txns1h),
  top10_max_pct: (f) => finiteOrNull(f.top10Pct),
};

/** 32-bit FNV-1a of the seed text. */
function seedHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small seeded PRNG (mulberry32): the same seed gives the same shuffles. */
function seededRandom(seed: number): () => number {
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
 * D33: a candidate value cut to 3 significant figures, toward keeping the
 * trade it came from (down for a min filter, up for a max filter), so the
 * public param log reads 215000, not 215447. It sees the entry feature only,
 * never an outcome, so the shuffle test stays valid.
 */
export function roundTunerCandidate(x: number, down: boolean): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const scale = 10 ** (Math.floor(Math.log10(Math.abs(x))) - 2);
  const q = x / scale;
  const near = Math.round(q);
  // A value already on the 3-figure grid stays there: float noise in `q`
  // (0.123 / 0.001 = 122.99999999999999) must not move it one step.
  const steps = Math.abs(q - near) <= 1e-12 * Math.abs(q) ? near : down ? Math.floor(q) : Math.ceil(q);
  return Number((steps * scale).toPrecision(3));
}

/** The trades the tuner judges: finite P&L, newest first, at most TUNER_MAX_TRADES. */
export function tunerTrades(trades: readonly ArenaClosedTrade[]): ArenaClosedTrade[] {
  return trades
    .filter((t) => Number.isFinite(t.pnlMult))
    .sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime())
    .slice(0, TUNER_MAX_TRADES);
}

export interface ArenaFilterSearchInput {
  /** The template's params: only a filter the template sets is searched. */
  template: FloorArenaParams;
  current: FloorArenaParams;
  /** Closed trades opened under the CURRENT params version. */
  trades: readonly ArenaClosedTrade[];
  /** A house agent must stay inside its house band (`checkHouseDrift`); a
   *  user agent inside the validation bounds. */
  house: boolean;
  /** `agentId:paramsVersion:n`: the shuffles depend on it only. */
  seed: string;
  /** Defaults to EVIDENCE_PERMUTATIONS. */
  shuffles?: number;
}

export interface ArenaFilterSearchResult {
  /** The trades judged (`tunerTrades`). */
  n: number;
  outcome: 'below_sample' | 'no_candidate' | 'not_significant' | 'confirmed';
  best: {
    change: FloorArenaParamDiff;
    next: FloorArenaParams;
    evidence: ArenaSuggestionEvidence;
    summary: ArenaTunerBest;
  } | null;
  /** Raw max-statistic p; null when no shuffle test ran. */
  p: number | null;
  /** Distinct legal splits in the search family. */
  splits: number;
}

interface TunerSplit {
  change: FloorArenaParamDiff;
  next: FloorArenaParams;
  /** Trade indices the new value excludes, ascending. */
  excluded: Int32Array;
  /** An earlier split of the same leaf whose excluded set this one contains
   *  (-1: none), so a shuffle sums only `delta` on top of it. */
  base: number;
  delta: Int32Array;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Searches run one at a time: two searches that yield together would run
 *  their slices back to back in one event-loop turn, so the loop could wait
 *  for the SUM of the slices. Serialised, it waits for at most one slice. */
let searchQueue: Promise<unknown> = Promise.resolve();

/**
 * D33: the code tuner's search. Deterministic for a given input and seed, no
 * I/O; async only to yield the event loop every TUNER_SLICE_MS.
 *
 * 1. Sample: fewer than MIN_CLOSED_FOR_AUTO_APPLY judged trades -> `below_sample`.
 * 2. Family: for each filter the TEMPLATE sets and the live params set, every
 *    value observed in the trades' entry features (the feature `passesFilters`
 *    reads, at the judged instant; cut to 3 significant figures by
 *    `roundTunerCandidate`, then whole numbers for an integer leaf, both
 *    rounded toward keeping that trade; duplicates dropped) that TIGHTENS the
 *    live value (a higher min, a lower max) and passes
 *    `evaluateArenaSuggestion` (bounds, one leaf, and
 *    the house band for a house agent). Each value splits the trades exactly
 *    as `evaluateSuggestionEvidence` does; a split with fewer than
 *    EVIDENCE_MIN_PER_SIDE kept or excluded trades is not legal. The family
 *    never looks at outcomes. None legal -> `no_candidate`.
 * 3. Statistic: the max over the family of (kept mean - excluded mean)
 *    pnl_mult; the first split in leaf order, smallest move first, wins a tie.
 * 4. Shuffle test: EVIDENCE_PERMUTATIONS seeded shuffles of pnl_mult across
 *    the trades; each one redoes the max over the WHOLE family, so the search
 *    pays for every split it tried. p = (1 + shuffles whose max >= observed)
 *    / (1 + shuffles).
 * 5. `confirmed` only when the best split passes D27
 *    (`evaluateSuggestionEvidence`) AND p <= EVIDENCE_MAX_SEARCH_P; else
 *    `not_significant`.
 */
export function searchFilterChange(input: ArenaFilterSearchInput): Promise<ArenaFilterSearchResult> {
  const run = searchQueue.then(() => runFilterSearch(input));
  searchQueue = run.catch(() => undefined);
  return run;
}

async function runFilterSearch(input: ArenaFilterSearchInput): Promise<ArenaFilterSearchResult> {
  const trades = tunerTrades(input.trades);
  const n = trades.length;
  if (n < MIN_CLOSED_FOR_AUTO_APPLY) return { n, outcome: 'below_sample', best: null, p: null, splits: 0 };

  // Start on a fresh event-loop turn: the previous queued search may have
  // just used a whole slice.
  await yieldToLoop();
  let sliceStart = performance.now();
  const maybeYield = async () => {
    if (performance.now() - sliceStart < TUNER_SLICE_MS) return;
    await yieldToLoop();
    sliceStart = performance.now();
  };

  const features = trades.map((t) => (t.features ?? {}) as unknown as FloorArenaFeatures);
  const judgedMs = trades.map((t) => tradeJudgedAt(t).getTime());
  const before = trades.map((_, i) => new Set(passesFilters(features[i]!, input.current.filters, judgedMs[i]!)));

  const splits: TunerSplit[] = [];
  const seen = new Set<string>();
  for (const key of FLOOR_ARENA_FILTER_KEYS) {
    const templateValue = input.template.filters[key];
    const from = input.current.filters[key];
    if (templateValue === null || from === null) continue;
    // top10_max_pct >= 100 is "off" (passesFilters); setting it would switch it on.
    if (key === 'top10_max_pct' && from >= 100) continue;
    const path = `filters.${key}`;
    const isMin = key.includes('_min');
    const integer = FLOOR_ARENA_PARAM_BOUNDS.filters[key].integer;
    const values = new Set<number>();
    for (let i = 0; i < n; i += 1) {
      const x = FILTER_FEATURE[key](features[i]!, judgedMs[i]!);
      if (x === null) continue;
      // 3 significant figures, then whole numbers for an integer leaf; both
      // round toward keeping trade i. The Set dedupes; the tighten, band and
      // bounds checks below all see the rounded value.
      const r = roundTunerCandidate(x, isMin);
      const v = integer ? (isMin ? Math.floor(r) : Math.ceil(r)) : r;
      if (isMin ? v > from : v < from) values.add(v);
    }
    // Smallest move first, so a tie keeps the value nearest the live one.
    let ordered = [...values].sort((a, b) => (isMin ? a - b : b - a));
    if (ordered.length > TUNER_MAX_VALUES_PER_LEAF) {
      const all = ordered;
      ordered = Array.from({ length: TUNER_MAX_VALUES_PER_LEAF }, (_, i) =>
        all[Math.round((i * (all.length - 1)) / (TUNER_MAX_VALUES_PER_LEAF - 1))]!);
    }
    let chainTail = -1;
    for (const to of ordered) {
      if (input.house && !houseLeafInBand(path, templateValue, to)) continue;
      const evaluation = evaluateArenaSuggestion({
        current: input.current,
        path,
        to,
        template: input.house ? input.template : null,
      });
      if (!evaluation.ok) continue;
      const excluded: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const after = passesFilters(features[i]!, evaluation.next.filters, judgedMs[i]!);
        if (after.some((code) => !before[i]!.has(code))) excluded.push(i);
      }
      await maybeYield();
      if (excluded.length < EVIDENCE_MIN_PER_SIDE || n - excluded.length < EVIDENCE_MIN_PER_SIDE) continue;
      const signature = excluded.join(',');
      if (seen.has(signature)) continue;
      seen.add(signature);
      let base = -1;
      let delta = excluded;
      if (chainTail >= 0) {
        const prev = splits[chainTail]!.excluded;
        const inThis = new Uint8Array(n);
        for (const i of excluded) inThis[i] = 1;
        if (prev.every((i) => inThis[i] === 1)) {
          const inPrev = new Uint8Array(n);
          for (const i of prev) inPrev[i] = 1;
          base = chainTail;
          delta = excluded.filter((i) => inPrev[i] !== 1);
        }
      }
      splits.push({
        change: evaluation.change,
        next: evaluation.next,
        excluded: Int32Array.from(excluded),
        base,
        delta: Int32Array.from(delta),
      });
      chainTail = splits.length - 1;
    }
  }
  if (splits.length === 0) return { n, outcome: 'no_candidate', best: null, p: null, splits: 0 };

  const pnl = Float64Array.from(trades, (t) => t.pnlMult);
  let total = 0;
  for (const value of pnl) total += value;
  const sums = new Float64Array(splits.length);
  const maxEdge = (values: Float64Array): { edge: number; at: number } => {
    let best = -Infinity;
    let at = -1;
    for (let k = 0; k < splits.length; k += 1) {
      const split = splits[k]!;
      let sum = split.base >= 0 ? sums[split.base]! : 0;
      const delta = split.delta;
      for (let j = 0; j < delta.length; j += 1) sum += values[delta[j]!]!;
      sums[k] = sum;
      const out = split.excluded.length;
      const edge = (total - sum) / (n - out) - sum / out;
      if (edge > best) {
        best = edge;
        at = k;
      }
    }
    return { edge: best, at };
  };

  const observed = maxEdge(pnl);
  const shuffles = input.shuffles ?? EVIDENCE_PERMUTATIONS;
  const rng = seededRandom(seedHash(input.seed));
  const work = Float64Array.from(pnl);
  let hits = 0;
  for (let s = 0; s < shuffles; s += 1) {
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = work[i]!;
      work[i] = work[j]!;
      work[j] = tmp;
    }
    // EPS: a shuffle that ties the observed max (common with repeated
    // multiples like 1.1x and deaths) counts against the change.
    if (maxEdge(work).edge >= observed.edge - EPS) hits += 1;
    if ((s & 31) === 31) await maybeYield();
  }
  const p = (1 + hits) / (1 + shuffles);

  const top = splits[observed.at]!;
  const evidence = evaluateSuggestionEvidence({ change: top.change, current: input.current, next: top.next, trades });
  const summary: ArenaTunerBest = {
    path: top.change.path,
    from: Number(top.change.from),
    to: Number(top.change.to),
    kept: evidence.kept?.n ?? n - top.excluded.length,
    excluded: evidence.excluded?.n ?? top.excluded.length,
    edge: evidence.edge ?? round(observed.edge, 4),
  };
  return {
    n,
    outcome: evidence.confirmed && p <= EVIDENCE_MAX_SEARCH_P ? 'confirmed' : 'not_significant',
    best: { change: top.change, next: top.next, evidence, summary },
    p,
    splits: splits.length,
  };
}

/** The public reason of a tuner change or suggestion (code text, <= 200 chars). */
export function tunerChangeReason(best: ArenaTunerBest, p: number): string {
  const edge = `${best.edge >= 0 ? '+' : ''}${best.edge.toFixed(3)}`;
  return cleanText(
    `Code tuner: keeps ${best.kept} closed trades and excludes ${best.excluded}; kept mean multiple ${edge} vs excluded, shuffle p ${round(p, 4)}.`,
    REASON_CHARS,
  );
}

// ── LLM prompt + reply (pure) ─────────────────────────────────────────────────

/** The validation bound for a flattened leaf path, or null for a locked or
 *  unknown leaf. */
function boundForLeaf(path: string): { min: number; max: number } | null {
  const B = FLOOR_ARENA_PARAM_BOUNDS;
  if (/^exits\.tp\.\d+\.0$/.test(path)) return B.exits.tp_multiple;
  const [section, key] = path.split('.');
  if (section === 'filters') return B.filters[key as keyof typeof B.filters] ?? null;
  if (section === 'entry' && (key === 'discovered_within_s' || key === 'entries_per_tick')) return B.entry[key];
  if (section === 'exits' && (key === 'stop_mult' || key === 'trail_from_peak' || key === 'trail_arm_mult' || key === 'max_hold_s')) {
    return B.exits[key];
  }
  if (section === 'limits' && (key === 'max_open' || key === 'reentry_cooldown_s')) return B.limits[key];
  return null;
}

/** Ranges the tuner may use for a house agent: the `houseLeafInBand` band
 *  around each template value, clipped to the validation bounds. */
export function houseTunableRanges(template: FloorArenaParams): Array<{ path: string; template: number; min: number; max: number }> {
  const out: Array<{ path: string; template: number; min: number; max: number }> = [];
  for (const [path, value] of flattenArenaParams(template)) {
    if (typeof value !== 'number') continue;
    const bound = boundForLeaf(path);
    if (!bound) continue;
    let lo: number;
    let hi: number;
    if (/^exits\.tp\.\d+\.0$/.test(path) || path === 'exits.trail_arm_mult') {
      lo = 1 + (value - 1) / 2;
      hi = 1 + (value - 1) * 2;
    } else if (path === 'exits.stop_mult') {
      lo = 1 - (1 - value) * 2;
      hi = 1 - (1 - value) / 2;
    } else if (value === 0) {
      lo = -HOUSE_ZERO_BAND;
      hi = HOUSE_ZERO_BAND;
    } else {
      lo = Math.min(value / 2, value * 2);
      hi = Math.max(value / 2, value * 2);
    }
    lo = Math.max(lo, bound.min);
    hi = Math.min(hi, bound.max);
    if (lo > hi) continue;
    out.push({ path, template: value, min: round(lo, 4), max: round(hi, 4) });
  }
  return out;
}

export interface ArenaPromptInput {
  agent: ArenaAnalysisAgent;
  params: FloorArenaParams;
  template: FloorArenaTemplate | null;
  stats: ArenaReportStats;
  priorReports: readonly ArenaPriorReport[];
  /** True when the current params have MIN_CLOSED_FOR_AUTO_APPLY closed
   *  trades, so the code tuner may change or suggest something. */
  suggestionAllowed: boolean;
  /** True when a confirmed tuner change is applied without a click (house
   *  agent, or an owner who turned on auto-apply). */
  autoApply: boolean;
}

export function buildArenaAnalysisMessages(input: ArenaPromptInput): ArenaInferenceMessage[] {
  const { agent, params, template, stats, priorReports, suggestionAllowed, autoApply } = input;
  const isHouse = agent.kind === 'house';
  // D33: the model is commentary only. Code (`searchFilterChange`) makes every
  // param decision and ignores any proposal in the reply.
  const rules = [
    'You analyse ONE paper trading agent in the ClawVille Trading Arena. Paper means every fill is priced from a live quote plus fixed costs, but no swap is sent and no token is bought.',
    'Write a short, plain English report from the stats you are given. State numbers plainly. Never call the agent profitable or winning, never promise results, and never invent a number that is not in the stats.',
    `You do not change parameters. Code decides every change: it tests one-filter tightenings on the closed trades of the current params and changes or suggests one only when at least ${EVIDENCE_MIN_PER_SIDE} trades fall on each side, the kept trades beat the excluded ones by at least ${EVIDENCE_MIN_EDGE} mean multiple, and a shuffle test over every filter it tried gives p of ${EVIDENCE_MAX_SEARCH_P} or less.`,
    'Always set "suggestion" to null; code ignores any proposal. Never claim that this report changes a parameter.',
    'Look at the prior reports and judge whether an applied change helped.',
  ];
  if (!suggestionAllowed) {
    rules.push(`The current params have fewer than ${MIN_CLOSED_FOR_AUTO_APPLY} closed trades, so code changes nothing yet.`);
  }
  rules.push(
    autoApply
      ? 'For this agent code applies a confirmed change itself, at most once per 30 minutes.'
      : 'For this agent the owner applies a confirmed change with one click.',
  );
  if (isHouse) {
    rules.push(
      'This is a HOUSE agent: it must stay recognisably its template, so code only moves a filter value that the template already sets, inside houseRanges.',
    );
  }
  rules.push(
    'Reply with ONE JSON object and nothing else: {"summary": string (at most 500 characters), "observations": string[] (at most 4 items, each at most 200 characters), "suggestion": null}.',
  );

  const allowedPaths = FLOOR_ARENA_PARAM_PATHS.filter((path) => path !== 'limits.position_usd');
  // No player-chosen text (agent name) and no token symbol or mint reaches the
  // prompt: the summary is published on the event stream, so the model only
  // sees our own numbers and our own template copy.
  const context = {
    agent: {
      kind: agent.kind,
      status: agent.status,
      seated: agent.seated,
      paramsVersion: agent.paramsVersion,
    },
    template: template
      ? { id: template.id, name: template.displayName, tagline: template.tagline, thesis: template.thesis, risk: template.risk }
      : { id: agent.templateId },
    hardRules: FLOOR_ARENA_HARD_RULES.map((rule) => rule.label),
    params,
    allowedPaths,
    bounds: FLOOR_ARENA_PARAM_BOUNDS,
    ...(isHouse && template ? { houseRanges: houseTunableRanges(template.params) } : {}),
    stats: {
      periodMinutes: stats.periodMinutes,
      openPositions: stats.openPositions,
      period: stats.period,
      currentParams: stats.currentParams,
      lifetime: stats.lifetime,
    },
    priorReports: priorReports.map((report) => ({
      at: report.createdAt.toISOString(),
      summary: report.summary,
      suggestion: report.suggestion
        ? { path: report.suggestion.path, from: report.suggestion.from, to: report.suggestion.to }
        : null,
      state: report.suggestionState,
    })),
    notes: [
      'A death is a close at 0.5x or lower; severe is 0.6x or lower and includes deaths.',
      'Cuts group closed trades by pair age, 5-minute change sign, 1-hour volume over market cap, and discovery source at entry.',
      'currentParams covers only trades opened under the current params version.',
    ],
  };

  return [
    { role: 'system', content: rules.join('\n') },
    { role: 'user', content: JSON.stringify(context) },
  ];
}

export interface ArenaParsedReply {
  summary: string;
  observations: string[];
  suggestion: { path: string; to: unknown; reason: string } | null;
}

/** Removes control characters, collapses whitespace, and clamps. */
export function cleanText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3).trimEnd()}...`;
}

/** Parses the model reply. Returns null when there is no usable summary. */
export function parseArenaAnalysisReply(text: string): ArenaParsedReply | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== 'string') return null;
  const summary = cleanText(obj.summary, SUMMARY_MAX);
  if (!summary) return null;
  const observations = Array.isArray(obj.observations)
    ? obj.observations
        .filter((line): line is string => typeof line === 'string')
        .map((line) => cleanText(line, OBSERVATION_CHARS))
        .filter((line) => line.length > 0)
        .slice(0, OBSERVATIONS_MAX)
    : [];
  let suggestion: ArenaParsedReply['suggestion'] = null;
  const s = obj.suggestion;
  if (typeof s === 'object' && s !== null && !Array.isArray(s)) {
    const rec = s as Record<string, unknown>;
    if (typeof rec.path === 'string' && 'to' in rec) {
      suggestion = {
        path: cleanText(rec.path, 80),
        to: rec.to,
        reason: typeof rec.reason === 'string' ? cleanText(rec.reason, REASON_CHARS) : '',
      };
    }
  }
  return { summary, observations, suggestion };
}

// ── Deterministic text (pure) ─────────────────────────────────────────────────

export function formatUsd(value: number): string {
  const sign = value < 0 ? '-' : '+';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatLeaf(value: unknown): string {
  if (value === null) return 'off';
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

export function quietSummary(stats: ArenaReportStats): string {
  const parts = [`No trade opened or closed in the last ${stats.periodMinutes} minutes.`];
  if (stats.status !== 'active') parts.push(`The agent is ${stats.status}, so it opens no new positions.`);
  else if (!stats.seated) parts.push('The agent is not seated at a Trading Floor desk, so it opens no new positions.');
  parts.push(`${stats.openPositions} open position${stats.openPositions === 1 ? '' : 's'}.`);
  if (stats.lifetime.trades > 0) {
    parts.push(`Since start: ${stats.lifetime.trades} closed trades, realised ${formatUsd(stats.lifetime.realisedUsd)}.`);
  }
  return parts.join(' ');
}

export function deterministicSummary(stats: ArenaReportStats): string {
  const p = stats.period;
  const parts: string[] = [];
  if (p.trades > 0) {
    parts.push(
      `${p.trades} trade${p.trades === 1 ? '' : 's'} closed in the last ${stats.periodMinutes} minutes: ` +
        `${p.exits.tp} take-profit, ${p.exits.stop} stop, ${p.exits.trail} trail, ${p.exits.time} time, ` +
        `${p.deaths} death${p.deaths === 1 ? '' : 's'}. Realised ${formatUsd(p.realisedUsd)}, ` +
        `win rate ${Math.round((p.winRate ?? 0) * 100)}%.`,
    );
  } else {
    parts.push(`No trade closed in the last ${stats.periodMinutes} minutes.`);
  }
  if (p.entries > 0) parts.push(`${p.entries} new position${p.entries === 1 ? '' : 's'} opened.`);
  parts.push(
    `Since start: ${stats.lifetime.trades} closed trades, realised ${formatUsd(stats.lifetime.realisedUsd)}, ` +
      `${stats.lifetime.deaths} death${stats.lifetime.deaths === 1 ? '' : 's'}.`,
  );
  return cleanText(parts.join(' '), SUMMARY_MAX);
}

function clampEvent(text: string): string {
  return cleanText(text, FLOOR_ARENA_EVENT_SUMMARY_MAX);
}

export function reportEventSummary(summary: string): string {
  return clampEvent(`Report: ${summary}`);
}

export function paramChangeEventSummary(
  source: ArenaParamChangeWrite['source'],
  change: FloorArenaParamDiff,
  reason: string,
): string {
  const who = source === 'house-tuner' ? 'Tuner' : 'Auto-applied suggestion';
  const base = `${who} changed ${change.path} from ${formatLeaf(change.from)} to ${formatLeaf(change.to)}`;
  return clampEvent(reason ? `${base}: ${reason}` : base);
}

export function reportMemoryText(input: {
  agentName: string;
  periodStart: Date;
  periodEnd: Date;
  summary: string;
  suggestion: FloorArenaSuggestion | null;
  suggestionState: FloorArenaSuggestionState;
  tuner: ArenaTunerCheck;
}): string {
  const window = `${input.periodStart.toISOString().slice(0, 16)}Z to ${input.periodEnd.toISOString().slice(0, 16)}Z`;
  let text = `Trading Arena report for my paper trader ${input.agentName} (${window}): ${input.summary}`;
  if (input.suggestion) {
    text += ` Suggested change: ${input.suggestion.path} from ${formatLeaf(input.suggestion.from)} to ${formatLeaf(input.suggestion.to)} (${input.suggestionState}).`;
  }
  return `${text}\n${tunerMemoryLine(input.tuner)}`;
}

/** D29 + D33: the one memory line that says what the code tuner decided and why. */
export function tunerMemoryLine(t: ArenaTunerCheck): string {
  let line = `Tuner decision: ${t.decision} (reason: ${t.reason}); ${t.n} closed trades on the current params, ${t.needed} needed.`;
  if (t.best) {
    const edge = `${t.best.edge >= 0 ? '+' : ''}${t.best.edge.toFixed(3)}`;
    line += ` Best filter idea: ${t.best.path} from ${t.best.from} to ${t.best.to}, keeps ${t.best.kept} and excludes ${t.best.excluded} trades, edge ${edge}`;
    line += t.p === null ? '.' : `, shuffle p ${t.p} (needs ${EVIDENCE_MAX_SEARCH_P} or less).`;
  }
  return line;
}

// ── Scheduling (pure) ─────────────────────────────────────────────────────────

export type ArenaDueKind = 'llm' | 'quiet' | 'none';

/**
 * Decides whether an agent gets a report now:
 *   - `llm`: the last report (or the agent's creation) is at least 30 minutes
 *     old and a position opened or closed since then;
 *   - `quiet`: no activity, the agent is active, and the last report is at
 *     least 2 hours old (or there is none and the agent is 30 minutes old);
 *   - `none`: otherwise. A paused or stopped agent is only reported while its
 *     exits still close positions.
 */
export function arenaReportDue(c: ArenaAnalysisCandidate, now: Date): ArenaDueKind {
  const since = (c.lastReportAt ?? c.agent.createdAt).getTime();
  const age = now.getTime() - since;
  if (age < ARENA_REPORT_INTERVAL_MS) return 'none';
  const active = c.agent.status === 'active';
  if (c.closedSince > 0 || (active && c.openedSince > 0)) return 'llm';
  if (!active) return 'none';
  if (c.lastReportAt && age < ARENA_QUIET_REPORT_INTERVAL_MS) return 'none';
  return 'quiet';
}

export function arenaPeriodStart(c: ArenaAnalysisCandidate, now: Date): Date {
  const from = (c.lastReportPeriodEnd ?? c.agent.createdAt).getTime();
  return new Date(Math.min(now.getTime(), Math.max(from, now.getTime() - ARENA_MAX_PERIOD_MS)));
}

// ── Tick ──────────────────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item!);
    }
  });
  await Promise.all(workers);
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

interface ArenaTunerPlan {
  tuner: ArenaTunerCheck;
  evidence: ArenaSuggestionEvidence | null;
  /** Stored on the report: a click-to-apply suggestion, or the automatic
   *  change the params writer claims. */
  suggestion: FloorArenaSuggestion | null;
  change: Omit<ArenaParamChangeWrite, 'reportId'> | null;
}

/**
 * D33: runs `searchFilterChange` for one agent and turns it into this
 * report's decision. Reads only the last param change time (the 30-minute
 * limit, automatic agents only); writes nothing.
 */
async function planTunerDecision(
  deps: ArenaAnalysisDeps,
  input: {
    agent: ArenaAnalysisAgent;
    template: FloorArenaTemplate | null;
    /** The validated live params; null when they fail validation. */
    params: FloorArenaParams | null;
    currentTrades: readonly ArenaClosedTrade[];
    autoApply: boolean;
    now: Date;
  },
): Promise<ArenaTunerPlan> {
  const { agent, template, params, autoApply, now } = input;
  const needed = MIN_CLOSED_FOR_AUTO_APPLY;
  const n = tunerTrades(input.currentTrades).length;
  if (!params || !template) {
    return {
      tuner: { decision: 'none', reason: 'not_tunable', n, needed, best: null, p: null },
      evidence: null,
      suggestion: null,
      change: null,
    };
  }
  const isHouse = agent.kind === 'house';
  const search = await searchFilterChange({
    template: template.params,
    current: params,
    trades: input.currentTrades,
    house: isHouse,
    seed: `${agent.id}:${agent.paramsVersion}:${n}`,
  });
  const check = (decision: ArenaTunerDecision, reason: ArenaTunerReason): ArenaTunerCheck => ({
    decision,
    reason,
    n: search.n,
    needed,
    best: search.best?.summary ?? null,
    p: search.p === null ? null : round(search.p, 4),
  });
  // `evidence` (with its raw D27 `confirmed`) is stored only beside a stored
  // suggestion; for a no-change report `tuner.best` and `tuner.p` say why.
  if (search.outcome !== 'confirmed' || !search.best || search.p === null) {
    const reason = search.outcome === 'confirmed' ? 'not_significant' : search.outcome;
    return { tuner: check('none', reason), evidence: null, suggestion: null, change: null };
  }
  const top = search.best;
  const evidence = top.evidence;
  const reason = tunerChangeReason(top.summary, search.p);
  const suggestion: FloorArenaSuggestion = { path: top.change.path, from: top.change.from, to: top.change.to, reason };
  if (!autoApply) return { tuner: check('suggested', 'suggested'), evidence, suggestion, change: null };

  const last = await deps.store.lastParamChangeAt(agent.id);
  if (last !== null && now.getTime() - last.getTime() < ARENA_AUTO_CHANGE_MIN_GAP_MS) {
    return { tuner: check('none', 'rate_limited'), evidence: null, suggestion: null, change: null };
  }
  const source = isHouse ? 'house-tuner' : 'suggestion';
  return {
    tuner: check('changed', 'changed'),
    evidence,
    suggestion,
    change: {
      agentId: agent.id,
      expectedParamsVersion: agent.paramsVersion,
      params: top.next,
      changes: [top.change],
      source,
      reason,
      eventSummary: paramChangeEventSummary(source, top.change, reason),
    },
  };
}

/** One agent's report, counted into `tally`. The model call and the memory
 *  write fail soft; a store error throws to the tick, which logs it and moves
 *  on to the next agent. */
async function analyseAgent(
  deps: ArenaAnalysisDeps,
  candidate: ArenaAnalysisCandidate,
  due: Exclude<ArenaDueKind, 'none'>,
  now: Date,
  tally: ArenaTickResult,
): Promise<void> {
  const { store } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const agent = candidate.agent;
  const periodStart = arenaPeriodStart(candidate, now);
  const periodEnd = now;

  const [trades, entries, openPositions] = await Promise.all([
    store.loadClosedTrades(agent.id, ARENA_LIFETIME_TRADE_LIMIT),
    store.countOpened(agent.id, periodStart, periodEnd),
    store.countOpen(agent.id),
  ]);
  const periodTrades = trades.filter(
    (t) => t.closedAt.getTime() > periodStart.getTime() && t.closedAt.getTime() <= periodEnd.getTime(),
  );
  const currentTrades = trades.filter((t) => t.paramsVersion === agent.paramsVersion);
  const stats: ArenaReportStats = {
    version: 1,
    periodMinutes: Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / 60_000)),
    status: agent.status,
    seated: agent.seated,
    openPositions,
    paramsVersion: agent.paramsVersion,
    period: {
      ...computeArenaTradeStats(periodTrades),
      entries,
      paramsVersions: [...new Set(periodTrades.map((t) => t.paramsVersion))].sort((a, b) => a - b),
    },
    currentParams: computeArenaTradeStats(currentTrades),
    lifetime: { ...computeArenaTradeStats(trades), truncated: trades.length >= ARENA_LIFETIME_TRADE_LIMIT },
    observations: [],
    suggestionCheck: { llm: 'skipped' },
  };

  const checkedParams = validateFloorArenaParams(agent.params);
  const template = floorArenaTemplateById(agent.templateId) ?? null;
  const isHouse = agent.kind === 'house';
  const autoApply = isHouse || agent.autoApplySuggestions;
  const suggestionAllowed = checkedParams.ok && stats.currentParams.trades >= MIN_CLOSED_FOR_AUTO_APPLY;

  // D33: the code tuner decides on every due report (quiet ones too), apart
  // from the model and before it, so a model failure never blocks it.
  const plan = await planTunerDecision(deps, {
    agent,
    template,
    params: checkedParams.ok ? checkedParams.params : null,
    currentTrades,
    autoApply,
    now,
  });

  let summary: string;
  if (due === 'quiet') {
    summary = quietSummary(stats);
  } else if (checkedParams.ok) {
    summary = deterministicSummary(stats);
    const priorReports = await store.loadRecentReports(agent.id, PRIOR_REPORTS);
    const messages = buildArenaAnalysisMessages({
      agent,
      params: checkedParams.params,
      template,
      stats,
      priorReports,
      suggestionAllowed,
      autoApply,
    });
    tally.llmCalls += 1;
    try {
      const reply = parseArenaAnalysisReply(
        await withTimeout(deps.llm(messages), deps.llmTimeoutMs ?? ARENA_LLM_TIMEOUT_MS),
      );
      if (!reply) throw new Error('unparseable reply');
      // The summary and observations are published (the report event, the
      // report routes, the owner's memory), so they may never name a player's
      // paid add-on (the source cuts can). Same redaction as the public
      // routes. `reply.suggestion` is IGNORED (D33): code decides every change.
      summary = redactArenaText(reply.summary);
      stats.observations = reply.observations.map(redactArenaText);
      stats.suggestionCheck = { llm: 'ok' };
    } catch (err) {
      tally.llmFailures += 1;
      stats.suggestionCheck = { llm: 'failed', reason: `llm_failed: ${errorText(err)}` };
      log(`[floor-arena/analysis] ${agent.id}: LLM failed, deterministic summary used (${errorText(err)})`);
    }
  } else {
    summary = deterministicSummary(stats);
    stats.suggestionCheck = { llm: 'skipped', reason: 'current_params_invalid', errors: checkedParams.errors.slice(0, 5) };
    log(`[floor-arena/analysis] ${agent.id}: stored params fail validation; no LLM call`);
  }

  let tuner = plan.tuner;
  stats.suggestionCheck = {
    ...stats.suggestionCheck,
    ...(plan.evidence ? { evidence: plan.evidence } : {}),
    tuner,
  };
  let suggestion = plan.suggestion;
  // An automatic change is written `pending` first; the params writer then
  // claims it as `auto_applied` in its own transaction.
  let state: FloorArenaSuggestionState = suggestion ? 'pending' : 'none';

  const written = await store.insertReport({
    agentId: agent.id,
    periodStart,
    periodEnd,
    stats,
    summary,
    suggestion,
    suggestionState: state,
    eventSummary: reportEventSummary(summary),
  });
  if ('duplicate' in written) {
    log(`[floor-arena/analysis] ${agent.id}: recent report exists; duplicate skipped`);
    return;
  }
  tally.reports += 1;

  if (plan.change) {
    const applied = await store.applyParamChange({ ...plan.change, reportId: written.reportId });
    if (applied.ok) {
      state = 'auto_applied';
      log(`[floor-arena/analysis] ${agent.id}: ${plan.change.eventSummary}`);
    } else {
      // The params moved on between the read and the apply (an admin or the
      // owner edited them): the change was computed against the old params,
      // so it is dropped. An automatic agent never keeps a pending suggestion
      // (D33). On `report_not_pending` another writer already moved the row,
      // and the reject below is a no-op there.
      tuner = { ...tuner, decision: 'none', reason: 'params_changed' };
      await store.rejectPendingReport(written.reportId, agent.id, 'params_changed', tuner);
      state = 'rejected';
      suggestion = null;
      log(`[floor-arena/analysis] ${agent.id}: automatic apply refused (${applied.reason}); change dropped`);
    }
  }
  if (state === 'auto_applied') tally.applied += 1;
  else if (state === 'pending') tally.pending += 1;
  else if (state === 'rejected') tally.rejected += 1;

  // D29: only a FULL report becomes a lesson, never a short no-trade one.
  if (due === 'llm' && agent.kind === 'user' && agent.avatarId && deps.writeMemory) {
    try {
      await deps.writeMemory({
        agentId: agent.id,
        agentName: agent.name,
        avatarId: agent.avatarId,
        text: reportMemoryText({ agentName: agent.name, periodStart, periodEnd, summary, suggestion, suggestionState: state, tuner }),
      });
    } catch (err) {
      log(`[floor-arena/analysis] ${agent.id}: memory write skipped (${errorText(err)})`);
    }
  }
}

/**
 * One analysis pass with injected dependencies. Never throws: a failure on one
 * agent is logged and the pass moves on to the next.
 */
export async function runArenaAnalysisTickWith(deps: ArenaAnalysisDeps, now: Date): Promise<ArenaTickResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const tally: ArenaTickResult = { reports: 0, llmCalls: 0, llmFailures: 0, applied: 0, pending: 0, rejected: 0, deferred: 0 };
  let candidates: ArenaAnalysisCandidate[];
  try {
    candidates = await deps.store.listCandidates(now);
  } catch (err) {
    log(`[floor-arena/analysis] candidate query failed: ${errorText(err)}`);
    return tally;
  }

  const oldestFirst = (a: ArenaAnalysisCandidate, b: ArenaAnalysisCandidate) =>
    (a.lastReportAt ?? a.agent.createdAt).getTime() - (b.lastReportAt ?? b.agent.createdAt).getTime();
  const llmDue = candidates.filter((c) => arenaReportDue(c, now) === 'llm').sort(oldestFirst);
  const quietDue = candidates.filter((c) => arenaReportDue(c, now) === 'quiet').sort(oldestFirst);
  const work: Array<{ c: ArenaAnalysisCandidate; due: 'llm' | 'quiet' }> = [
    ...llmDue.slice(0, ARENA_MAX_LLM_REPORTS_PER_TICK).map((c) => ({ c, due: 'llm' as const })),
    ...quietDue.slice(0, ARENA_MAX_QUIET_REPORTS_PER_TICK).map((c) => ({ c, due: 'quiet' as const })),
  ];
  tally.deferred =
    Math.max(0, llmDue.length - ARENA_MAX_LLM_REPORTS_PER_TICK) +
    Math.max(0, quietDue.length - ARENA_MAX_QUIET_REPORTS_PER_TICK);

  await mapPool(work, ARENA_LLM_CONCURRENCY, async ({ c, due }) => {
    try {
      await analyseAgent(deps, c, due, now, tally);
    } catch (err) {
      log(`[floor-arena/analysis] ${c.agent.id}: report failed: ${errorText(err)}`);
    }
  });
  if (tally.reports > 0 || tally.deferred > 0) {
    log(
      `[floor-arena/analysis] tick: ${tally.reports} reports, ${tally.llmCalls} LLM calls (${tally.llmFailures} failed), ` +
        `${tally.applied} applied, ${tally.pending} pending, ${tally.rejected} rejected, ${tally.deferred} deferred`,
    );
  }
  return tally;
}

// ── Production wiring ─────────────────────────────────────────────────────────

/** The shared InferenceRouter `default` route (OpenAI in the baked config). */
export const arenaInferenceLlm: ArenaLlm = async (messages) => {
  const { getInferenceRouter } = await import('@clawville/agent-runtime');
  const { text } = await getInferenceRouter().generateText({
    route: 'default',
    size: 'small',
    messages,
    temperature: 0.2,
    maxTokens: 700,
    timeoutMs: ARENA_LLM_TIMEOUT_MS,
  });
  return text;
};

let tickRunning = false;

/**
 * The engine calls this every 60 s under the arena leader lock
 * (`services/floor-arena/index.ts`). Never throws. A call that arrives while
 * the previous pass still waits on the model returns at once.
 */
export async function runArenaAnalysisTick(now: Date): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const { createArenaAnalysisStore, writeArenaReportMemory } = await import('./analysis-store');
    await runArenaAnalysisTickWith(
      { store: createArenaAnalysisStore(), llm: arenaInferenceLlm, writeMemory: writeArenaReportMemory },
      now,
    );
  } catch (err) {
    console.error('[floor-arena/analysis] tick failed:', errorText(err));
  } finally {
    tickRunning = false;
  }
}
