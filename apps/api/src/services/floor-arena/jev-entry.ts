// FEATURE_GATE: jev_arena_entry_shadow
// Status: shadow + virtual twin (no trade effect)
// Metric to graduate: virtual-twin net pnl beats actual across bots after >=1 day, founder go
// Current reading: none (new)
// Review deadline: 2026-10-17
// On deadline: delete, or enforce the gate on paper twins (founder decision)
// Reference: docs/trading-floor-arena.md

/**
 * jev-entry.ts — Jev ENTRY SHADOW for the Trading Floor arena paper bots.
 *
 * Every coin that reaches the buy-quote step of `runAgentEntries` (engine.ts) is also sent to Jev (a fast probability
 * model) with six questions built from the bot's own exits. The answers and a verdict computed in code (v0) are
 * STORED in `floor_arena_jev_entry` (migration 0082). NOTHING in the trade path reads them: the engine fires this
 * without awaiting, every error is caught here, and the report `apps/api/scripts/floor-arena-jev-report.ts` builds a
 * "virtual twin" per bot (real paper trades minus the ones the verdict would have refused).
 *
 * Enabled only when `JEV_API_KEY` is set (never under `bun test`). The key is never logged or stored; error text is
 * redacted of it. Spend caps are code constants with their own ledger (this table) and their own advisory lock key:
 * production $0.90 total / $0.45 per UTC day, any other env $0.10 / $0.05. The reservation is an UPPER BOUND (UTF-8
 * bytes of state + questions JSON + 256 envelope tokens), kept when usage is missing or the call failed.
 */

import { createHash } from 'node:crypto';
import { db, sql } from '@clawville/database';
import type { FloorArenaExits } from '@clawville/shared';
import { JEV_ENDPOINT, JEV_ENVELOPE_TOKENS, JEV_USD_PER_MTOK } from '../jev-decide-shadow';
import { pairAgeSeconds, type FloorArenaFeatures } from './filters';

export const JEV_ARENA_MODEL = 'jev-1.13.0'; // pinned: a new jev-latest can shift every probability (resolved 2026-10-14)
export const JEV_ARENA_TIMEOUT_MS = 2_000;
/** Fixed advisory-lock key for THIS ledger (the decide shadow uses 7_413_008_101). */
export const JEV_ARENA_CAP_LOCK_KEY = 7_413_008_202;
export const JEV_ARENA_MAX_IN_FLIGHT = 4;
export const JEV_ARENA_DEDUPE_MS = 10 * 60_000;
export const JEV_ARENA_DEDUPE_MAX = 5_000;
/** Probabilities must sum to 1 within this tolerance (TypeSafe wire contract). */
export const JEV_PROBABILITY_SUM_TOLERANCE = 0.01;

export interface JevArenaCaps { totalUsd: number; dailyUsd: number }

/** Founder $1 for this test: production $0.90 / $0.45 per UTC day; any other env $0.10 / $0.05. */
export function jevArenaCaps(clawvilleEnv: string | undefined): JevArenaCaps {
  return clawvilleEnv === 'production' ? { totalUsd: 0.9, dailyUsd: 0.45 } : { totalUsd: 0.1, dailyUsd: 0.05 };
}

// ---------------------------------------------------------------- state (banded, no raw floats)

/** The coin facts the engine has at the quote step (a structural subset of ArenaCandidate). */
export interface JevArenaCoin {
  mint: string;
  source: string;
  features: FloorArenaFeatures;
  verdict: string;
}

export interface JevArenaBot {
  agentId: string;
  /** Template id (house) or agent name. */
  strategy: string;
  positionUsd: number;
  exits: FloorArenaExits;
}

const STEPS = [1, 2.5, 5];

function usdLabel(v: number): string {
  if (v >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  return String(v);
}

/** 1-2.5-5 log bands from $1k to $1B, e.g. "$25k-50k". */
export function usdBand(v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  if (v < 1_000) return '<$1k';
  if (v >= 1e9) return '>=$1B';
  let lo = 1_000;
  for (let decade = 1_000; decade < 1e9; decade *= 10) {
    for (const s of STEPS) {
      const edge = decade * s;
      if (edge > v) return `$${usdLabel(lo)}-${usdLabel(edge)}`;
      lo = edge;
    }
  }
  return `$${usdLabel(lo)}-1B`;
}

const AGE_EDGES_MIN = [5, 15, 30, 60, 120, 240, 720, 1440];
export function ageBand(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const min = seconds / 60;
  let lo = 0;
  for (const edge of AGE_EDGES_MIN) {
    if (min < edge) return `${lo}-${edge}min`;
    lo = edge;
  }
  return `>=${lo}min`;
}

function signed(n: number): string { return n > 0 ? `+${n}` : String(n); }

/** Percent change in 5-point bands, e.g. "+10..+15%"; capped at >=+500%. */
export function pctChangeBand(v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  if (v >= 500) return '>=+500%';
  const lo = Math.floor(v / 5) * 5;
  return `${signed(lo)}..${signed(lo + 5)}%`;
}

const TXN_EDGES = [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];
export function txnsBand(v: number | null): string | null {
  if (v === null || !Number.isFinite(v) || v < 0) return null;
  let lo = 0;
  for (const edge of TXN_EDGES) {
    if (v < edge) return `${lo}-${edge}`;
    lo = edge;
  }
  return `>=${lo}`;
}

/** Volume over market cap in 0.25 bands, e.g. "0.50-0.75"; capped at >=5.00. */
export function ratioBand(v: number | null): string | null {
  if (v === null || !Number.isFinite(v) || v < 0) return null;
  if (v >= 5) return '>=5.00';
  const lo = Math.floor(v / 0.25) * 0.25;
  return `${lo.toFixed(2)}-${(lo + 0.25).toFixed(2)}`;
}

/** Top-10 holder share (percent 0..100) in 5-point bands, e.g. "20-25%". */
export function top10Band(v: number | null): string | null {
  if (v === null || !Number.isFinite(v) || v < 0) return null;
  if (v >= 100) return '100%';
  const lo = Math.floor(v / 5) * 5;
  return `${lo}-${lo + 5}%`;
}

function fin(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Stable JSON: object keys sorted at every level, arrays kept in order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function botExitView(exits: FloorArenaExits) {
  const firstTp = exits.tp[0]?.[0];
  return {
    tpMult: typeof firstTp === 'number' && Number.isFinite(firstTp) ? firstTp : null,
    stopMult: fin(exits.stop_mult),
    trailFromPeak: fin(exits.trail_from_peak),
    maxHoldMin: Math.max(1, Math.round(exits.max_hold_s / 60)),
  };
}

/** The compact state string (sorted keys). Bot settings are config values; every coin number is banded. */
export function buildJevArenaState(bot: JevArenaBot, coin: JevArenaCoin, nowMs: number): string {
  const f = coin.features;
  const exits = botExitView(bot.exits);
  const ageS = pairAgeSeconds(f, nowMs) ?? fin(f.ageS);
  const facts: Record<string, string | null> = {
    mcap: usdBand(fin(f.mcap)),
    liq: usdBand(fin(f.liqUsd)),
    vol1h: usdBand(fin(f.vol1h)),
    age: ageBand(ageS),
    chg5m: pctChangeBand(fin(f.chg5m)),
    chg1h: pctChangeBand(fin(f.chg1h)),
    chg6h: pctChangeBand(fin(f.chg6h)),
    chg24h: pctChangeBand(fin(f.chg24h)),
    txns1h: txnsBand(fin(f.txns1h)),
    volOverMcap: ratioBand(fin(f.volOverMcap)),
    top10Pct: top10Band(fin(f.top10Pct)),
    dexId: typeof f.dexId === 'string' && f.dexId ? f.dexId.slice(0, 32) : null,
  };
  const unmeasured = Object.keys(facts).filter((k) => facts[k] === null).sort();
  const labels = Array.isArray(f.labels) ? f.labels.filter((l) => typeof l === 'string').slice(0, 10).map((l) => l.slice(0, 32)) : [];
  return stableStringify({
    bot: {
      strategy: bot.strategy.slice(0, 64),
      position_usd: bot.positionUsd,
      tp_mult: exits.tpMult,
      stop_mult: exits.stopMult,
      trail_from_peak: exits.trailFromPeak,
      max_hold_min: exits.maxHoldMin,
    },
    coin: {
      ...facts,
      source: coin.source.slice(0, 48),
      labels,
      chain_verdict: coin.verdict,
    },
    unmeasured,
  });
}

// ---------------------------------------------------------------- questions

export const JEV_ARENA_CONTEXT = 'The state describes one Solana token that a fast paper-trading bot is about to buy with '
  + 'its strategy settings. Judge only from the state. Null values and names in `unmeasured` are missing facts, not '
  + 'good or bad facts.';

export type JevArenaQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export const JEV_MOMENTUM_CHOICES = ['starting', 'running', 'peaking', 'fading', 'unclear'] as const;

function multText(n: number): string { return `${+n.toFixed(3)}x`; }

/** All six questions for one bot, built from its exits (no tp leg -> 1.3x; no stop -> 0.7x). */
export function buildJevArenaQuestions(bot: Pick<JevArenaBot, 'positionUsd' | 'exits'>): Record<string, JevArenaQuestion> {
  const exits = botExitView(bot.exits);
  const tp = multText(exits.tpMult ?? 1.3);
  const stop = multText(exits.stopMult ?? 0.7);
  const hold = exits.maxHoldMin;
  const pre = `${JEV_ARENA_CONTEXT} `;
  return {
    hits_tp: {
      type: 'noul',
      instructions: `${pre}Statement: from the current price this token reaches ${tp} before it falls to ${stop}, within ${hold} minutes.`,
      criteria: {
        true: `The price touches ${tp} of the current price first, inside ${hold} minutes.`,
        false: `The price falls to ${stop} first, or reaches neither level inside ${hold} minutes.`,
      },
    },
    dumps: {
      type: 'noul',
      instructions: `${pre}Statement: this token falls 30% or more from the current price within ${hold} minutes.`,
      criteria: {
        true: `At some point inside ${hold} minutes the price is 0.7x of the current price or lower.`,
        false: `The price stays above 0.7x of the current price for all ${hold} minutes.`,
      },
    },
    exit_room: {
      type: 'score',
      instructions: `${pre}Could the market absorb this bot's buy of $${bot.positionUsd} and its sell without heavy price impact?`,
      criteria: [
        'No: the buy or the sell would move the price heavily, or the pool could not take it.',
        'Barely: the trade fits but with clear price impact on the way in or out.',
        'Yes: the buy and the sell fit with small price impact.',
        'Easily: the trade is tiny against liquidity and volume.',
      ],
    },
    demand: {
      type: 'score',
      instructions: `${pre}How genuine is the buying interest?`,
      criteria: [
        'Inorganic: the activity looks wash-traded, botted or self-funded.',
        'Thin: few real buyers; small activity.',
        'Real: a fair number of real buyers.',
        'Broad: many independent buyers and steady volume.',
      ],
    },
    momentum: {
      type: 'choice',
      instructions: `${pre}Where is this token in its move?`,
      criteria: {
        starting: 'The move up has just begun.',
        running: 'The price is rising steadily mid-move.',
        peaking: 'The move is near its top and stalling.',
        fading: 'The move is over and the price is falling back.',
        unclear: 'The state does not show a clear phase.',
      },
    },
    holder_risk: {
      type: 'score',
      instructions: `${pre}How risky is the holder distribution?`,
      criteria: [
        'Low: supply is widely spread.',
        'Moderate: some concentration in a few wallets.',
        'High: a few wallets hold enough to crash the price.',
        'Severe: one or a few wallets control most of the supply.',
      ],
    },
  };
}

// ---------------------------------------------------------------- answers + verdict

export type JevArenaAnswer =
  | { p: number }
  | { choice: string; probs: Record<string, number> }
  /** `score` = the most probable level (integer); `expected` = Jev's own decimal score (its probability-weighted
   *  mean; live 2026-10-14 jev-1.13.0 returned e.g. 2.77, never an integer). */
  | { score: number; expected: number; probs: Record<string, number> };

function validProbs(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  let sum = 0;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null;
    out[k] = v;
    sum += v;
    n += 1;
  }
  if (n === 0 || Math.abs(sum - 1) > JEV_PROBABILITY_SUM_TOLERANCE) return null;
  return out;
}

/** One answer checked against its question; null when invalid (wrong type, out of range, bad probabilities). */
export function validateJevAnswer(raw: unknown, question: JevArenaQuestion): JevArenaAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (a.type !== undefined && a.type !== question.type) return null;
  if (question.type === 'noul') {
    const p = a.noul;
    return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 ? { p } : null;
  }
  if (question.type === 'choice') {
    const choice = a.choice;
    if (typeof choice !== 'string' || !Object.prototype.hasOwnProperty.call(question.criteria, choice)) return null;
    const probs = validProbs(a.probabilities);
    return probs ? { choice, probs } : null;
  }
  const expected = a.score;
  const top = question.criteria.length - 1;
  if (typeof expected !== 'number' || !Number.isFinite(expected) || expected < 0 || expected > top) return null;
  const probs = validProbs(a.probabilities);
  if (!probs) return null;
  // The level is the most probable one (ties keep the lower level); every key must be a level of this question.
  let level = -1;
  let best = -1;
  for (const [k, v] of Object.entries(probs)) {
    const lv = Number(k);
    if (!Number.isInteger(lv) || lv < 0 || lv > top) return null;
    if (v > best || (v === best && lv < level)) { best = v; level = lv; }
  }
  return level >= 0 ? { score: level, expected, probs } : null;
}

export interface JevArenaParsed {
  answers: Record<string, JevArenaAnswer | null>;
  hitsTp: number | null;
  dumps: number | null;
  exitRoom: number | null;
  demand: number | null;
  momentum: string | null;
  holderRisk: number | null;
}

export function parseJevArenaAnswers(raw: unknown, questions: Record<string, JevArenaQuestion>): JevArenaParsed {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const answers: Record<string, JevArenaAnswer | null> = {};
  for (const [name, q] of Object.entries(questions)) answers[name] = validateJevAnswer(src[name], q);
  const p = (k: string) => { const a = answers[k]; return a && 'p' in a ? a.p : null; };
  const s = (k: string) => { const a = answers[k]; return a && 'score' in a ? a.score : null; };
  const m = answers.momentum;
  return {
    answers,
    hitsTp: p('hits_tp'),
    dumps: p('dumps'),
    exitRoom: s('exit_room'),
    demand: s('demand'),
    momentum: m && 'choice' in m ? m.choice : null,
    holderRisk: s('holder_risk'),
  };
}

export const JEV_ARENA_VERDICT_V0 = { hitsTpFloor: 0.35, dumpsCeiling: 0.6 } as const;

/** Verdict v0 (stored only): veto on exit_room No, holder_risk Severe, dumps >= 0.6, hits_tp < 0.35. Null never vetoes. */
export function jevArenaVerdict(a: Pick<JevArenaParsed, 'hitsTp' | 'dumps' | 'exitRoom' | 'holderRisk'>): {
  verdict: 'pass' | 'veto'; reasons: string[];
} {
  const reasons: string[] = [];
  if (a.exitRoom === 0) reasons.push('exit_room_no');
  if (a.holderRisk === 3) reasons.push('holder_risk_severe');
  if (a.dumps !== null && a.dumps >= JEV_ARENA_VERDICT_V0.dumpsCeiling) reasons.push('dumps_ge_0.6');
  if (a.hitsTp !== null && a.hitsTp < JEV_ARENA_VERDICT_V0.hitsTpFloor) reasons.push('hits_tp_lt_0.35');
  return { verdict: reasons.length > 0 ? 'veto' : 'pass', reasons };
}

export function estimateJevArenaUsd(stateBytes: number, questionBytes: number): number {
  return (stateBytes + questionBytes + JEV_ENVELOPE_TOKENS) * JEV_USD_PER_MTOK / 1_000_000;
}

export function stateHash(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- ledger + runner

export type JevArenaStatus = 'reserved' | 'ok' | 'error' | 'timeout' | 'skipped_cap';

export interface JevArenaReserveRow {
  agentId: string;
  mint: string;
  decidedAtMs: number;
  stateHash: string;
  estimateUsd: number;
}

export type JevArenaReserveResult = { ok: true; id: string } | { ok: false; reason: 'total' | 'daily' };

export interface JevArenaFinishPatch {
  status: 'ok' | 'error' | 'timeout';
  model: string | null;
  parsed: JevArenaParsed | null;
  verdict: 'pass' | 'veto' | null;
  vetoReasons: string[] | null;
  jevMs: number;
  inputTokens: number | null;
  /** null = keep the reserved upper bound. */
  usd: number | null;
  error: string | null;
}

export interface JevArenaLedger {
  reserve(row: JevArenaReserveRow, caps: JevArenaCaps): Promise<JevArenaReserveResult>;
  finish(id: string, patch: JevArenaFinishPatch): Promise<void>;
  recordSkippedCap(row: Omit<JevArenaReserveRow, 'estimateUsd'>, reason: 'total' | 'daily'): Promise<void>;
}

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface JevArenaDeps {
  fetch: FetchLike;
  ledger: JevArenaLedger;
  getApiKey: () => string | undefined;
  getEnv: () => string | undefined;
  now: () => number;
  log: { warn: (line: string) => void };
  timeoutMs?: number;
}

export interface JevArenaEntryInput {
  bot: JevArenaBot;
  coin: JevArenaCoin;
}

export interface JevArenaStats {
  started: number;
  deduped: number;
  skippedInFlight: number;
  skippedCapLatched: number;
}

function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

function redact(text: string, key: string): string {
  return (key.length > 0 ? text.split(key).join('[redacted]') : text).slice(0, 200);
}

export function createJevArenaEntry(deps: JevArenaDeps) {
  const lastFired = new Map<string, number>();
  let inFlight = 0;
  let totalCapHit = false;
  let dailyCapDay: string | null = null;
  let capWarned = false;
  const stats: JevArenaStats = { started: 0, deduped: 0, skippedInFlight: 0, skippedCapLatched: 0 };

  async function call(input: JevArenaEntryInput, apiKey: string, decidedAtMs: number): Promise<void> {
    const state = buildJevArenaState(input.bot, input.coin, decidedAtMs);
    const questions = buildJevArenaQuestions(input.bot);
    const questionsJson = JSON.stringify(questions);
    const base = { agentId: input.bot.agentId, mint: input.coin.mint, decidedAtMs, stateHash: stateHash(state) };
    const estimateUsd = estimateJevArenaUsd(Buffer.byteLength(state, 'utf8'), Buffer.byteLength(questionsJson, 'utf8'));
    const reserved = await deps.ledger.reserve({ ...base, estimateUsd }, jevArenaCaps(deps.getEnv()));
    if (!reserved.ok) {
      if (reserved.reason === 'total') totalCapHit = true;
      else dailyCapDay = utcDay(deps.now());
      if (!capWarned) {
        capWarned = true;
        deps.log.warn(`[JevArena] spend cap reached (${reserved.reason}); entry shadow calls refused`);
      }
      await deps.ledger.recordSkippedCap(base, reserved.reason);
      return;
    }

    const started = deps.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? JEV_ARENA_TIMEOUT_MS);
    let patch: JevArenaFinishPatch;
    try {
      const res = await deps.fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: `{"model":${JSON.stringify(JEV_ARENA_MODEL)},"state":${JSON.stringify(state)},"questions":${questionsJson}}`,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const body = (await res.json()) as { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } } | null;
      const rawTokens = body?.usage?.input_tokens;
      const inputTokens = typeof rawTokens === 'number' && Number.isFinite(rawTokens) && rawTokens >= 0 ? Math.round(rawTokens) : null;
      const usd = inputTokens === null ? null : inputTokens * JEV_USD_PER_MTOK / 1_000_000;
      const model = typeof body?.model === 'string' && body.model ? body.model.slice(0, 64) : null;
      const parsed = parseJevArenaAnswers(body?.answers, questions);
      const anyValid = Object.values(parsed.answers).some((a) => a !== null);
      const jevMs = deps.now() - started;
      if (anyValid) {
        const v = jevArenaVerdict(parsed);
        patch = { status: 'ok', model, parsed, verdict: v.verdict, vetoReasons: v.reasons, jevMs, inputTokens, usd, error: null };
      } else {
        patch = { status: 'error', model, parsed: null, verdict: null, vetoReasons: null, jevMs, inputTokens, usd, error: 'no_valid_answers' };
      }
    } catch (err) {
      const timedOut = controller.signal.aborted;
      const message = redact(err instanceof Error ? err.message : String(err), apiKey);
      patch = {
        status: timedOut ? 'timeout' : 'error', model: null, parsed: null, verdict: null, vetoReasons: null,
        jevMs: deps.now() - started, inputTokens: null, usd: null, error: timedOut ? 'timeout' : message,
      };
      deps.log.warn(`[JevArena] call ${timedOut ? 'timed out' : `failed: ${message}`}`);
    } finally {
      clearTimeout(timer);
    }
    await deps.ledger.finish(reserved.id, patch);
  }

  /** Synchronous gate (dedupe, in-flight, cap latches); returns the started promise or null when skipped. */
  function start(input: JevArenaEntryInput): Promise<void> | null {
    const apiKey = deps.getApiKey()?.trim();
    if (!apiKey) return null;
    const nowMs = deps.now();
    if (totalCapHit || dailyCapDay === utcDay(nowMs)) {
      stats.skippedCapLatched += 1;
      return null;
    }
    const key = `${input.bot.agentId}|${input.coin.mint}`;
    const last = lastFired.get(key);
    if (last !== undefined && nowMs - last < JEV_ARENA_DEDUPE_MS) {
      stats.deduped += 1;
      return null;
    }
    if (inFlight >= JEV_ARENA_MAX_IN_FLIGHT) {
      stats.skippedInFlight += 1;
      return null;
    }
    lastFired.delete(key);
    lastFired.set(key, nowMs);
    while (lastFired.size > JEV_ARENA_DEDUPE_MAX) {
      const oldest = lastFired.keys().next().value;
      if (oldest === undefined) break;
      lastFired.delete(oldest);
    }
    inFlight += 1;
    stats.started += 1;
    return call(input, apiKey, nowMs)
      .catch((err: unknown) => {
        deps.log.warn(`[JevArena] shadow failed: ${redact(err instanceof Error ? err.message : String(err), apiKey)}`);
      })
      .finally(() => { inFlight -= 1; });
  }

  /** Fire-and-forget: never throws, never rejects, never awaited by the engine. */
  function fire(input: JevArenaEntryInput): void {
    let key = '';
    try {
      key = deps.getApiKey()?.trim() ?? '';
      void start(input);
    } catch (err) {
      deps.log.warn(`[JevArena] shadow failed: ${redact(err instanceof Error ? err.message : String(err), key)}`);
    }
  }

  return {
    start,
    fire,
    stats: (): JevArenaStats => ({ ...stats }),
    inFlight: () => inFlight,
    dedupeSize: () => lastFired.size,
  };
}

/** Every ledger write runs bounded (Codex r1 2026-10-14): a stalled shadow write must never hold a shared pool
 *  connection that the trading / driver paths need. A timeout throws; the caller's catch logs it. */
async function boundedWrite(query: ReturnType<typeof sql>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    await tx.execute(query);
  });
}

/** Default ledger: `floor_arena_jev_entry` through the shared Drizzle client. */
export const dbJevArenaLedger: JevArenaLedger = {
  async reserve(row, caps) {
    return db.transaction(async (tx) => {
      // Bounded: a stalled lock or sum must never hold a shared pool connection for long.
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${JEV_ARENA_CAP_LOCK_KEY})`);
      const sums = await tx.execute<{ total: string | null; today: string | null }>(sql`
        SELECT COALESCE(SUM(usd), 0)::text AS total,
               COALESCE(SUM(usd) FILTER (
                 WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
               ), 0)::text AS today
        FROM floor_arena_jev_entry`);
      const total = Number(sums[0]?.total ?? 0);
      const today = Number(sums[0]?.today ?? 0);
      if (total + row.estimateUsd > caps.totalUsd) return { ok: false, reason: 'total' } as const;
      if (today + row.estimateUsd > caps.dailyUsd) return { ok: false, reason: 'daily' } as const;
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO floor_arena_jev_entry (agent_id, mint, decided_at, status, state_hash, usd)
        VALUES (${row.agentId}, ${row.mint}, ${new Date(row.decidedAtMs).toISOString()}::timestamptz, 'reserved',
                ${row.stateHash}, ${row.estimateUsd.toFixed(8)}::numeric)
        RETURNING id`);
      const id = inserted[0]?.id;
      if (!id) throw new Error('reserve insert returned no id');
      return { ok: true, id } as const;
    });
  },
  async finish(id, patch) {
    const p = patch.parsed;
    const answers = p === null ? null : JSON.stringify(p.answers);
    const reasons = patch.vetoReasons === null ? null : JSON.stringify(patch.vetoReasons);
    const usd = patch.usd === null ? null : patch.usd.toFixed(8);
    await boundedWrite(sql`
      UPDATE floor_arena_jev_entry SET
        status = ${patch.status},
        model = ${patch.model},
        answers = ${answers}::jsonb,
        hits_tp = ${p?.hitsTp ?? null},
        dumps = ${p?.dumps ?? null},
        exit_room = ${p?.exitRoom ?? null},
        demand = ${p?.demand ?? null},
        momentum = ${p?.momentum ?? null},
        holder_risk = ${p?.holderRisk ?? null},
        verdict = ${patch.verdict},
        veto_reasons = CASE WHEN ${reasons}::jsonb IS NULL THEN NULL
                            ELSE ARRAY(SELECT jsonb_array_elements_text(${reasons}::jsonb)) END,
        jev_ms = ${Math.max(0, Math.round(patch.jevMs))},
        input_tokens = ${patch.inputTokens},
        usd = COALESCE(${usd}::numeric, usd),
        error = ${patch.error}
      WHERE id = ${id}`);
  },
  async recordSkippedCap(row, reason) {
    await boundedWrite(sql`
      INSERT INTO floor_arena_jev_entry (agent_id, mint, decided_at, status, state_hash, usd, error)
      VALUES (${row.agentId}, ${row.mint}, ${new Date(row.decidedAtMs).toISOString()}::timestamptz, 'skipped_cap',
              ${row.stateHash}, 0, ${`cap_${reason}`})`);
  },
};

const defaultEntry = createJevArenaEntry({
  fetch: (url, init) => fetch(url, init),
  ledger: dbJevArenaLedger,
  // Never under `bun test`: a developer key in the environment must not spend from a test run.
  getApiKey: () => (process.env.NODE_ENV === 'test' ? undefined : process.env.JEV_API_KEY),
  getEnv: () => process.env.CLAWVILLE_ENV,
  now: () => Date.now(),
  log: { warn: (line) => console.warn(line) },
});

/** Engine hook (runAgentEntries, right before quoteBuy). Fire-and-forget; its result never reaches the trade path. */
export function fireJevArenaEntry(input: JevArenaEntryInput): void {
  defaultEntry.fire(input);
}

export function jevArenaEntryStats(): JevArenaStats {
  return defaultEntry.stats();
}
