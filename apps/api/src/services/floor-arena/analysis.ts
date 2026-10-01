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
 *   2. A SUMMARY and at most ONE suggested param change from the LLM on the
 *      shared InferenceRouter `default` route (the route the NPC banter engine
 *      uses; no provider key of our own). The prompt carries the template
 *      thesis, the live params, the hard rules, the stats and the last three
 *      reports, so each report sees what the previous suggestions did.
 *   3. VALIDATION of the suggestion in code, never trusted from the model: the
 *      path must be a known leaf, never `limits.position_usd`, the result must
 *      pass `validateFloorArenaParams` and differ from the live params in
 *      exactly one leaf. A house agent must also stay near its template (see
 *      `checkHouseDrift`). A failed check stores NO suggestion, state
 *      `rejected`, and the reason in `stats.suggestionCheck`.
 *   4. APPLY: a house agent applies a valid suggestion itself (source
 *      `house-tuner`); a user agent keeps it `pending` for one click, unless
 *      the owner turned on `auto_apply_suggestions` (source `suggestion`).
 *      An AUTOMATIC apply (D27, after the tuner halved Runner's chg5m_max on
 *      a 46% vs 43% death split) needs `MIN_CLOSED_FOR_AUTO_APPLY` closed
 *      trades on the current params AND a deterministic split check on those
 *      trades (`evaluateSuggestionEvidence`); only filter changes can pass it.
 *      At most one automatic change per agent per 30 minutes.
 *   5. MEMORY (D29): every user agent's report is stored as an earned-skill
 *      lesson of the owner's avatar, in its warm hosted ElizaOS runtime or
 *      else the avatar-keyed keyword store (`writeArenaReportMemory`; never
 *      lazy-starts a runtime, never throws).
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
  FLOOR_ARENA_HARD_RULES,
  FLOOR_ARENA_PARAM_BOUNDS,
  FLOOR_ARENA_PARAM_PATHS,
  applyFloorArenaParamChange,
  diffFloorArenaParams,
  floorArenaTemplateById,
  validateFloorArenaParams,
  type FloorArenaAgentKind,
  type FloorArenaParamChangeSource,
  type FloorArenaParamDiff,
  type FloorArenaParams,
  type FloorArenaSuggestion,
  type FloorArenaSuggestionState,
  type FloorArenaTemplate,
} from '@clawville/shared';
import {
  EVIDENCE_MIN_EDGE,
  EVIDENCE_MIN_PER_SIDE,
  MIN_CLOSED_FOR_AUTO_APPLY,
  MIN_CLOSED_ON_CURRENT_PARAMS,
} from './analysis-rules';
import { passesFilters, type FloorArenaFeatures } from './filters';
import { redactArenaText } from './queries';

// ── Tuning constants ──────────────────────────────────────────────────────────

/** A report is due when the last one is at least this old. */
export const ARENA_REPORT_INTERVAL_MS = 30 * 60_000;
/** An agent with no trade in the period gets a short "no trades" report at
 *  most this often, so the stream shows the analysis still runs. */
export const ARENA_QUIET_REPORT_INTERVAL_MS = 2 * 60 * 60_000;
/** A period never reaches further back than this (after an outage the older
 *  trades still count in the lifetime stats). */
export const ARENA_MAX_PERIOD_MS = 6 * 60 * 60_000;
/** At most one automatic param change per agent in this window. */
export const ARENA_AUTO_CHANGE_MIN_GAP_MS = 30 * 60_000;
export const ARENA_LLM_TIMEOUT_MS = 20_000;
export const ARENA_LLM_CONCURRENCY = 2;
/** LLM reports per tick. With the timeout and concurrency above, a tick
 *  spends at most about 12 / 2 * 20 s = 2 minutes waiting on the model. */
export const ARENA_MAX_LLM_REPORTS_PER_TICK = 12;
export const ARENA_MAX_QUIET_REPORTS_PER_TICK = 40;
/** Newest closed trades loaded for the lifetime stats. */
export const ARENA_LIFETIME_TRADE_LIMIT = 5_000;
export {
  EVIDENCE_MIN_EDGE,
  EVIDENCE_MIN_PER_SIDE,
  MIN_CLOSED_FOR_AUTO_APPLY,
  MIN_CLOSED_ON_CURRENT_PARAMS,
} from './analysis-rules';
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
  /** The model's raw proposal, kept for the record when it was rejected. */
  proposed?: { path: string; to: unknown };
  /** The D27 split check on the current params' closed trades. */
  evidence?: ArenaSuggestionEvidence;
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
   *  records `reason` in `stats.suggestionCheck.reason`. */
  rejectPendingReport(reportId: string, agentId: string, reason: string): Promise<void>;
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
 * D27: the deterministic check an AUTOMATIC change must pass. Only a filter
 * change can be judged from closed trades: each trade is re-run through the
 * engine's own `passesFilters` on its entry features (at its entry time) under
 * the current and the new filters. A trade is EXCLUDED when the new value adds
 * a fail code the current filters did not have, else KEPT. The change is
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
    const before = new Set(passesFilters(features, input.current.filters, trade.openedAt));
    const after = passesFilters(features, input.next.filters, trade.openedAt);
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
  suggestionAllowed: boolean;
  /** True when a valid suggestion would be applied without a click (house
   *  agent, or an owner who turned on auto-apply): the D27 rules apply. */
  autoApply: boolean;
}

/** The closed-trade minimum before the model may propose anything. */
export function minClosedForSuggestion(autoApply: boolean): number {
  return autoApply ? MIN_CLOSED_FOR_AUTO_APPLY : MIN_CLOSED_ON_CURRENT_PARAMS;
}

export function buildArenaAnalysisMessages(input: ArenaPromptInput): ArenaInferenceMessage[] {
  const { agent, params, template, stats, priorReports, suggestionAllowed, autoApply } = input;
  const isHouse = agent.kind === 'house';
  const rules = [
    'You analyse ONE paper trading agent in the ClawVille Trading Arena. Paper means every fill is priced from a live quote plus fixed costs, but nothing is bought and no money moves.',
    'Write a short, plain English report from the stats you are given. State numbers plainly. Never call the agent profitable or winning, never promise results, and never invent a number that is not in the stats.',
    'You may propose AT MOST ONE parameter change. Propose null when no stat clearly supports a change.',
    'A proposal names one path from allowedPaths and the new value for that whole leaf. For exits.tp the value is the full list of [multiple, fraction] legs.',
    'Never propose limits.position_usd; the position size is fixed.',
    'The new value must stay inside the bounds you are given. Your reason must cite the stat that supports the change (a bucket, an exit count, deaths, the win rate), in 200 characters or less.',
    'Look at the prior reports: do not repeat a suggestion that was rejected or dismissed unless new trades support it, and judge whether an applied change helped.',
  ];
  if (!suggestionAllowed) {
    rules.push(`The current params have fewer than ${minClosedForSuggestion(autoApply)} closed trades, so suggestion MUST be null this time.`);
  }
  if (autoApply) {
    rules.push(
      `This agent applies a suggestion automatically, so code tests it first: only a filter change can pass, and only when the closed trades on the current params split by the new value into at least ${EVIDENCE_MIN_PER_SIDE} kept and ${EVIDENCE_MIN_PER_SIDE} excluded trades, with the kept trades' mean multiple at least ${EVIDENCE_MIN_EDGE} above the excluded trades'. A looser filter, or an exit, entry or limit change, is never applied automatically. Propose null unless a filter change clearly meets that test.`,
    );
  }
  if (isHouse) {
    rules.push(
      'This is a HOUSE agent: it must stay recognisably its template. You may only move a value that the template already sets, inside houseRanges, and you may not switch a filter or exit on or off, change entry.rank_by, change a take-profit fraction, or change the number of take-profit legs.',
    );
  }
  rules.push(
    'Reply with ONE JSON object and nothing else: {"summary": string (at most 500 characters), "observations": string[] (at most 4 items, each at most 200 characters), "suggestion": null or {"path": string, "to": value, "reason": string}}.',
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
}): string {
  const window = `${input.periodStart.toISOString().slice(0, 16)}Z to ${input.periodEnd.toISOString().slice(0, 16)}Z`;
  let text = `Trading Arena report for my paper trader ${input.agentName} (${window}): ${input.summary}`;
  if (input.suggestion) {
    text += ` Suggested change: ${input.suggestion.path} from ${formatLeaf(input.suggestion.from)} to ${formatLeaf(input.suggestion.to)} (${input.suggestionState}).`;
  }
  return text;
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

  if (due === 'quiet') {
    const summary = quietSummary(stats);
    const written = await store.insertReport({
      agentId: agent.id,
      periodStart,
      periodEnd,
      stats,
      summary,
      suggestion: null,
      suggestionState: 'none',
      eventSummary: reportEventSummary(summary),
    });
    if ('duplicate' in written) log(`[floor-arena/analysis] ${agent.id}: recent report exists; duplicate skipped`);
    else tally.reports += 1;
    return;
  }

  const checkedParams = validateFloorArenaParams(agent.params);
  const template = floorArenaTemplateById(agent.templateId) ?? null;
  const isHouse = agent.kind === 'house';
  const autoApply = isHouse || agent.autoApplySuggestions;
  const suggestionAllowed = checkedParams.ok && stats.currentParams.trades >= minClosedForSuggestion(autoApply);

  let summary = deterministicSummary(stats);
  let proposal: ArenaParsedReply['suggestion'] = null;
  if (checkedParams.ok) {
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
      summary = reply.summary;
      stats.observations = reply.observations;
      // The reason becomes public on the param-change log once applied, so it
      // may never name a player's paid add-on (the source cuts can). Same
      // pattern as the public routes' boundary redaction.
      proposal = reply.suggestion ? { ...reply.suggestion, reason: redactArenaText(reply.suggestion.reason) } : null;
      stats.suggestionCheck = { llm: 'ok' };
    } catch (err) {
      tally.llmFailures += 1;
      stats.suggestionCheck = { llm: 'failed', reason: `llm_failed: ${errorText(err)}` };
      log(`[floor-arena/analysis] ${agent.id}: LLM failed, deterministic summary used (${errorText(err)})`);
    }
  } else {
    stats.suggestionCheck = { llm: 'skipped', reason: 'current_params_invalid', errors: checkedParams.errors.slice(0, 5) };
    log(`[floor-arena/analysis] ${agent.id}: stored params fail validation; no LLM call`);
  }

  let suggestion: FloorArenaSuggestion | null = null;
  let state: FloorArenaSuggestionState = 'none';
  let change: Omit<ArenaParamChangeWrite, 'reportId'> | null = null;

  if (proposal && checkedParams.ok) {
    const proposed = { path: proposal.path, to: proposal.to };
    const reject = (reason: string, errors?: string[]) => {
      suggestion = null;
      state = 'rejected';
      stats.suggestionCheck = { ...stats.suggestionCheck, reason, ...(errors ? { errors } : {}), proposed };
    };
    if (!suggestionAllowed) {
      reject('insufficient_sample');
    } else if (isHouse && !template) {
      reject('unknown_template');
    } else {
      const evaluation = evaluateArenaSuggestion({
        current: checkedParams.params,
        path: proposal.path,
        to: proposal.to,
        template: isHouse ? template!.params : null,
      });
      if (!evaluation.ok) {
        reject(evaluation.reason, evaluation.errors);
      } else {
        suggestion = {
          path: evaluation.change.path,
          from: evaluation.change.from,
          to: evaluation.change.to,
          reason: proposal.reason,
        };
        // The report is written `pending` first; an automatic apply then claims
        // it as `auto_applied` in the params writer's own transaction.
        state = 'pending';
        // D27: every suggestion carries the split check on the current params'
        // trades, so an owner deciding by hand sees it too; an automatic apply
        // requires it.
        const evidence = evaluateSuggestionEvidence({
          change: evaluation.change,
          current: checkedParams.params,
          next: evaluation.next,
          trades: currentTrades,
        });
        stats.suggestionCheck = { ...stats.suggestionCheck, evidence };
        if (autoApply && !evidence.confirmed) {
          reject('insufficient_evidence');
        } else if (autoApply) {
          const last = await store.lastParamChangeAt(agent.id);
          const recent = last !== null && now.getTime() - last.getTime() < ARENA_AUTO_CHANGE_MIN_GAP_MS;
          if (recent && isHouse) {
            reject('rate_limited');
          } else if (recent) {
            stats.suggestionCheck = { ...stats.suggestionCheck, reason: 'rate_limited' };
          } else {
            const source = isHouse ? 'house-tuner' : 'suggestion';
            change = {
              agentId: agent.id,
              expectedParamsVersion: agent.paramsVersion,
              params: evaluation.next,
              changes: [evaluation.change],
              source,
              reason: proposal.reason,
              eventSummary: paramChangeEventSummary(source, evaluation.change, proposal.reason),
            };
          }
        }
      }
    }
  }

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

  if (change) {
    const applied = await store.applyParamChange({ ...change, reportId: written.reportId });
    if (applied.ok) {
      state = 'auto_applied';
      log(`[floor-arena/analysis] ${agent.id}: ${change.eventSummary}`);
    } else if (applied.reason === 'version_conflict' && isHouse) {
      // An admin edited the params while the model was thinking. The
      // suggestion was computed against the old params, so it is dropped.
      await store.rejectPendingReport(written.reportId, agent.id, 'params_changed');
      state = 'rejected';
      suggestion = null;
    } else {
      // A user agent keeps the suggestion pending: its owner changed the
      // params meanwhile and decides with one click.
      log(`[floor-arena/analysis] ${agent.id}: automatic apply refused (${applied.reason}); suggestion left pending`);
    }
  }
  if (state === 'auto_applied') tally.applied += 1;
  else if (state === 'pending') tally.pending += 1;
  else if (state === 'rejected') tally.rejected += 1;

  if (agent.kind === 'user' && agent.avatarId && deps.writeMemory) {
    try {
      await deps.writeMemory({
        agentId: agent.id,
        agentName: agent.name,
        avatarId: agent.avatarId,
        text: reportMemoryText({ agentName: agent.name, periodStart, periodEnd, summary, suggestion, suggestionState: state }),
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
