import {
  and, db, eq, floorArenaAgents, floorArenaPositions, inArray, or, sql,
  type FloorArenaAgentRow, type FloorArenaPositionRow,
} from '@clawville/database';
import {
  cloneFloorArenaParams, FLOOR_ARENA_HOUSE_AGENTS, FLOOR_ARENA_RANK_BY_LABELS, floorArenaTemplateById,
  validateFloorArenaParams, type FloorArenaExitRun, type FloorArenaExits, type FloorArenaParams,
} from '@clawville/shared';
import {
  FLOOR_ARENA_LIQ_FLOOR_USD, hardFloorFails, passesFilters, rankCandidates, withinDiscoveryWindow,
  type FloorArenaFeatures, type FloorArenaSnapshot,
} from './filters';
import {
  ARENA_MARK_MAX_AGE_MS, ARENA_POSITION_USD, lastRememberedPrice, markFallbackProceeds, markPrices, quoteBuy,
  quoteSell, rememberedSnapshot, type BuyQuoteResult, type SellQuoteResult,
} from './pricing';
import type { ArenaChainVerdict } from './chain-checks';
import {
  formatAge, formatPrice, formatSignedUsd, formatUsdCompact, tokenLabel, writeArenaEvent, writeArenaEvents,
  type ArenaEventInput,
} from './events';

/**
 * The paper engine (docs/trading-floor-arena.md D3, D4, D6, D7; §6).
 * Entry tick (15 s): agents that are active, paper, and seated (house agents are always seated) enter the best
 * ranked candidates of the shared feed plus their private add-on mints, $20 each, at a ClawPump quote.
 * Exit tick (10 s): EVERY open position (seated or not) is marked on DexScreener and exits on TP legs, stop,
 * trail or the time cap, filled at a ClawPump sell quote; after 3 failed quotes over >= 45 s at the mark (D4).
 * Restart-safe: all position state is in the DB; per-agent errors never stop other agents.
 */

const EPS = 1e-6;
const EVENT_DEDUPE_MS = 5 * 60_000;
const SCAN_EVERY_MS = 5 * 60_000;
const PASS_EVENTS_PER_TICK = 10;
const REFUSAL_COOLDOWN_MS = 30 * 60_000;
const TRANSIENT_COOLDOWN_MS = 2 * 60_000;
export const EXIT_FALLBACK_AFTER_FAILURES = 3;
export const EXIT_FALLBACK_AFTER_MS = 45_000;

function round9(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** USD amounts are stored to the micro-dollar (no float noise in the public P&L). */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------- pure exit state machine

export interface ExitState {
  entryPriceUsd: number;
  /** Tokens bought (the ORIGINAL position). */
  tokens: number;
  sizeUsd: number;
  openedAtMs: number;
  peakMult: number;
  remainingFraction: number;
  /** Sum of sell proceeds so far (USD after costs). */
  realisedUsd: number;
}

export type ExitReason = 'tp' | 'stop' | 'trail' | 'time';
export type ExitFillSource = 'quote' | 'mark_fallback' | 'quote_confirmed';
export interface ExitTrigger { reason: ExitReason; fraction: number; leg: number | null }

/** TP legs already filled. Only TP legs are partial, so they follow from what is gone (legs ascend, sum <= 1). */
export function tpHitsFromRemaining(remainingFraction: number, legs: FloorArenaExits['tp']): number {
  const consumed = 1 - remainingFraction;
  let cumulative = 0;
  let hits = 0;
  for (const [, fraction] of legs) {
    cumulative += fraction;
    if (cumulative <= consumed + EPS) hits += 1;
    else break;
  }
  return hits;
}

/**
 * One exit decision. markMult = DexScreener mark / entry price (null = no fresh mark: only the time cap can fire).
 * Order: next TP leg, stop, trail (armed once the peak reached trail_arm_mult; null arm = armed from entry),
 * time cap. One trigger per tick; the next TP leg fires on the next tick if the mark still clears it.
 */
export function decideExitTrigger(state: ExitState, exits: FloorArenaExits, markMult: number | null, nowMs: number): ExitTrigger | null {
  if (state.remainingFraction <= EPS) return null;
  if (markMult !== null && Number.isFinite(markMult) && markMult > 0) {
    const peak = Math.max(state.peakMult, markMult);
    const hits = tpHitsFromRemaining(state.remainingFraction, exits.tp);
    const leg = exits.tp[hits];
    if (leg && markMult >= leg[0]) {
      return { reason: 'tp', fraction: Math.min(leg[1], state.remainingFraction), leg: hits + 1 };
    }
    if (exits.stop_mult !== null && markMult <= exits.stop_mult) {
      return { reason: 'stop', fraction: state.remainingFraction, leg: null };
    }
    if (exits.trail_from_peak !== null) {
      const armAt = exits.trail_arm_mult ?? 1;
      if (peak >= armAt && markMult <= peak * (1 - exits.trail_from_peak)) {
        return { reason: 'trail', fraction: state.remainingFraction, leg: null };
      }
    }
  }
  if (nowMs - state.openedAtMs >= exits.max_hold_s * 1000) {
    return { reason: 'time', fraction: state.remainingFraction, leg: null };
  }
  return null;
}

export interface ExitFillResult {
  remainingFraction: number;
  realisedUsd: number;
  closed: boolean;
  pnlUsd: number | null;
  pnlMult: number | null;
}

export function applyExitFill(state: ExitState, trigger: ExitTrigger, proceedsUsd: number): ExitFillResult {
  const remaining = round9(Math.max(0, state.remainingFraction - trigger.fraction));
  const realisedUsd = round6(state.realisedUsd + Math.max(0, proceedsUsd));
  const closed = remaining <= EPS;
  return {
    remainingFraction: closed ? 0 : remaining,
    realisedUsd,
    closed,
    pnlUsd: closed ? round6(realisedUsd - state.sizeUsd) : null,
    pnlMult: closed ? round9(realisedUsd / state.sizeUsd) : null,
  };
}

const FILL_SOURCE_RANK: Record<ExitFillSource, number> = { quote: 0, quote_confirmed: 1, mark_fallback: 2 };

/** A position's exit_fill_source is sticky across legs: the least direct source any leg used wins. */
export function combineFillSource(prior: string | null | undefined, current: ExitFillSource): ExitFillSource {
  const p = prior === 'quote' || prior === 'quote_confirmed' || prior === 'mark_fallback' ? prior : null;
  return p !== null && FILL_SOURCE_RANK[p] > FILL_SOURCE_RANK[current] ? p : current;
}

/**
 * Codex r7: a stored mark (last_mark_mult / last_mark_at) is only ever replaced by a mark that is at least as new.
 * The mark's time is its DexScreener snapshot time, not the tick time, so an older tick (a second leader during a
 * deploy flip, or a slow tick) can never overwrite a newer mark that a restart would reuse for a fallback fill or a
 * low-quote check. Pure rule (tests); `newerMarkSet` / the batch UPDATE are its SQL mirror.
 */
export function keepNewerMark(
  stored: { mult: number | null; atMs: number | null },
  incoming: { mult: number; atMs: number },
): { mult: number | null; atMs: number } {
  if (stored.atMs === null || stored.atMs <= incoming.atMs) return { mult: incoming.mult, atMs: incoming.atMs };
  return { mult: stored.mult, atMs: stored.atMs };
}

/** Drizzle SET values that apply keepNewerMark in SQL (every SET expression reads the OLD row). */
function newerMarkSet(markMult: number | null, markAtMs: number | null) {
  if (markMult === null || markAtMs === null) return {};
  const at = new Date(markAtMs).toISOString();
  return {
    lastMarkMult: sql`CASE WHEN ${floorArenaPositions.lastMarkAt} IS NULL OR ${floorArenaPositions.lastMarkAt} <= ${at}::timestamptz
      THEN ${String(round9(markMult))}::numeric ELSE ${floorArenaPositions.lastMarkMult} END`,
    lastMarkAt: sql`GREATEST(COALESCE(${floorArenaPositions.lastMarkAt}, ${at}::timestamptz), ${at}::timestamptz)`,
  };
}

/** The peak multiple only ever rises, whatever tick writes it. */
function risingPeakSet(peakMult: number) {
  return { peakMult: sql`GREATEST(${floorArenaPositions.peakMult}, ${String(round9(peakMult))}::numeric)` };
}

/**
 * D4 failure history of one position, PERSISTED in floor_arena_positions.exit_run (Codex r5 #2: no leader-memory
 * state decides an exit). Written on every failed sell attempt with compare-and-swap (Codex r6 #2), cleared (null)
 * on every booking.
 *   firstFailureAt   first failure of the history: the 30-min 'unresolved' hard stop counts from it. After a low quote
 *                    was seen, a pause never moves it (Codex r6 #1: gaps cannot extend the clock forever);
 *   runStartedAt     start of the current run: the 3-failures-over-45-s fallback counts from it;
 *   failures         failed attempts in the current run;
 *   streakStartedAt  first low quote of the current low streak: the 45-s confirmation window counts from it;
 *   lowCount         consecutive low QUOTE results (Codex r4 #1; lead decision): an attempt with no quote at all
 *                    (network / ClawPump failure) neither counts nor resets it and is never a fill source; any other
 *                    refused quote (echo mismatch, bad output, above-mark drift) resets it to 0;
 *   lastLowAt        a low quote continues the streak only when the previous low is <= 5 min old, else the streak
 *                    restarts at 1 with a new streakStartedAt (Codex r5 #3);
 *   sawLow           a low quote was seen for this position: the stale-price fallback never books until a usable
 *                    price books the exit or it closes as unresolved; it survives pauses (Codex r6 #1);
 *   lastAttemptAt    a pause of > 5 min since the last attempt (the trigger stopped firing) restarts the run
 *                    (failures, streak). Without a low quote it starts a whole new history.
 */
export type ExitRun = FloorArenaExitRun;
export type ExitAttempt = 'low' | 'no_quote' | 'other_refusal';
export const CONFIRM_LOW_QUOTES = 2;
export const LOW_QUOTE_MAX_GAP_MS = 5 * 60_000;
export const EXIT_RUN_GAP_MS = 5 * 60_000;
/** Codex r5 #1: a run with no bookable price for this long closes the position as 'unresolved' (no P&L). */
export const EXIT_UNRESOLVED_AFTER_MS = 30 * 60_000;

export function classifyExitAttempt(reason: string): ExitAttempt {
  if (reason === 'quote_far_below_reference' || reason === 'quote_far_below_mark') return 'low';
  if (reason === 'quote_failed' || reason === 'not_configured') return 'no_quote';
  return 'other_refusal';
}

function isoMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The stored jsonb, or null when absent or malformed (a malformed run starts over). */
export function parseExitRun(raw: unknown): ExitRun | null {
  const r = raw as Partial<ExitRun> | null;
  if (!r || typeof r !== 'object') return null;
  const okIso = (v: unknown, nullable: boolean) => (v === null ? nullable : typeof v === 'string' && isoMs(v) !== null);
  const okInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (!okIso(r.firstFailureAt, false) || !okIso(r.runStartedAt, false) || !okIso(r.streakStartedAt ?? null, true)
    || !okIso(r.lastLowAt ?? null, true) || !okIso(r.lastAttemptAt, false) || !okInt(r.failures) || !okInt(r.lowCount)
    || typeof r.sawLow !== 'boolean') {
    return null;
  }
  return {
    firstFailureAt: r.firstFailureAt!, runStartedAt: r.runStartedAt!, streakStartedAt: r.streakStartedAt ?? null,
    failures: r.failures!, lowCount: r.lowCount!, sawLow: r.sawLow, lastLowAt: r.lastLowAt ?? null, lastAttemptAt: r.lastAttemptAt!,
  };
}

/** One failed sell attempt applied to the run (pure). */
export function advanceExitRun(prev: ExitRun | null, attempt: ExitAttempt, nowMs: number): ExitRun {
  const nowIso = new Date(nowMs).toISOString();
  const fresh: ExitRun = {
    firstFailureAt: nowIso, runStartedAt: nowIso, streakStartedAt: null, failures: 0, lowCount: 0, sawLow: false,
    lastLowAt: null, lastAttemptAt: nowIso,
  };
  const lastAttemptMs = prev ? isoMs(prev.lastAttemptAt) : null;
  const paused = !prev || lastAttemptMs === null || nowMs - lastAttemptMs > EXIT_RUN_GAP_MS;
  let run: ExitRun;
  if (prev && !paused) run = prev;
  // After a pause the run restarts, but a seen low quote keeps its guard and the history clock (Codex r6 #1).
  else if (prev?.sawLow) run = { ...prev, runStartedAt: nowIso, failures: 0, lowCount: 0, streakStartedAt: null };
  else run = fresh;
  let { streakStartedAt, lowCount, lastLowAt, sawLow } = run;
  if (attempt === 'low') {
    const lastLowMs = isoMs(lastLowAt);
    const continues = lowCount > 0 && lastLowMs !== null && nowMs - lastLowMs <= LOW_QUOTE_MAX_GAP_MS;
    lowCount = continues ? lowCount + 1 : 1;
    streakStartedAt = continues ? streakStartedAt : nowIso;
    lastLowAt = nowIso;
    sawLow = true;
  } else if (attempt === 'other_refusal') {
    lowCount = 0;
    streakStartedAt = null;
  }
  return {
    firstFailureAt: run.firstFailureAt, runStartedAt: run.runStartedAt, streakStartedAt, failures: run.failures + 1,
    lowCount, sawLow, lastLowAt, lastAttemptAt: nowIso,
  };
}

export type D4Outcome = { kind: 'book'; priceUsd: number; source: ExitFillSource } | { kind: 'unresolved' } | null;

/**
 * The D4 decision after a failed sell attempt (pure; exported for tests). null = keep retrying.
 *   fresh mark: 3 failures over >= 45 s of the current run -> the mark (mark_fallback);
 *   no fresh mark: 'quote_confirmed' ONLY when THIS attempt returned a low quote (currentLowQuotePrice), the streak
 *     holds >= 2 lows (each <= 5 min after the previous) and >= 45 s passed since the streak's first low; the fill is
 *     this attempt's quote (never a cached one);
 *   no fresh mark and no low quote for this position (a pure outage): 3 failures over >= 45 s -> the stale price
 *     (mark_fallback); once a low quote was seen, the stale price never books (it would overstate a crash);
 *   no fresh mark and nothing bookable for >= 30 min since the first failure of the history -> 'unresolved'
 *     (slot freed, excluded from P&L; Codex r5 #1). With a fresh mark the mark fallback books within 45 s instead.
 */
export function d4Decision(input: {
  freshMarkPrice: number | null;
  currentLowQuotePrice: number | null;
  run: ExitRun;
  nowMs: number;
  staleFallbackPrice: number | null;
}): D4Outcome {
  const { run, nowMs } = input;
  const firstMs = isoMs(run.firstFailureAt) ?? nowMs;
  const runStartMs = isoMs(run.runStartedAt) ?? nowMs;
  const runSpanOk = nowMs - runStartMs >= EXIT_FALLBACK_AFTER_MS;
  const countOk = run.failures >= EXIT_FALLBACK_AFTER_FAILURES;
  if (input.freshMarkPrice !== null) {
    if (countOk && runSpanOk) return { kind: 'book', priceUsd: input.freshMarkPrice, source: 'mark_fallback' };
  } else {
    const streakMs = isoMs(run.streakStartedAt);
    if (input.currentLowQuotePrice !== null && run.lowCount >= CONFIRM_LOW_QUOTES && streakMs !== null
      && nowMs - streakMs >= EXIT_FALLBACK_AFTER_MS) {
      return { kind: 'book', priceUsd: input.currentLowQuotePrice, source: 'quote_confirmed' };
    }
    if (!run.sawLow && countOk && runSpanOk && input.staleFallbackPrice !== null) {
      return { kind: 'book', priceUsd: input.staleFallbackPrice, source: 'mark_fallback' };
    }
    if (nowMs - firstMs >= EXIT_UNRESOLVED_AFTER_MS) return { kind: 'unresolved' };
  }
  return null;
}

// ---------------------------------------------------------------- candidates (pure)

export interface ArenaCandidate {
  mint: string;
  source: string;
  symbol: string | null;
  firstSeenAtMs: number;
  features: FloorArenaFeatures;
  verdict: 'pass' | 'fail' | 'pending';
  isPrivate: boolean;
}

export interface AgentEvaluation {
  evaluated: number;
  passed: ArenaCandidate[];
  cooling: ArenaCandidate[];
  failCounts: Record<string, number>;
}

/** Filters one agent's view; `passed` is ranked by entry.rank_by. Held mints are not evaluated. */
export function evaluateAgentCandidates(
  params: FloorArenaParams,
  candidates: readonly ArenaCandidate[],
  held: ReadonlySet<string>,
  lastClosedAtMs: ReadonlyMap<string, number>,
  nowMs: number,
): AgentEvaluation {
  const failCounts: Record<string, number> = {};
  const passed: ArenaCandidate[] = [];
  const cooling: ArenaCandidate[] = [];
  let evaluated = 0;
  for (const c of candidates) {
    if (held.has(c.mint)) continue;
    evaluated += 1;
    const fails: string[] = [];
    if (!withinDiscoveryWindow(c.firstSeenAtMs, params.entry.discovered_within_s, nowMs)) fails.push('window');
    if (c.verdict === 'fail') fails.push('hard_rules');
    else if (c.verdict === 'pending') fails.push('chain_pending');
    fails.push(...hardFloorFails(c.features), ...passesFilters(c.features, params.filters, nowMs));
    for (const code of fails) failCounts[code] = (failCounts[code] ?? 0) + 1;
    if (fails.length > 0) continue;
    const closedAt = lastClosedAtMs.get(c.mint);
    if (closedAt !== undefined && nowMs - closedAt < params.limits.reentry_cooldown_s * 1000) {
      failCounts.cooldown = (failCounts.cooldown ?? 0) + 1;
      cooling.push(c);
      continue;
    }
    passed.push(c);
  }
  return { evaluated, passed: rankCandidates(passed, params.entry.rank_by, nowMs), cooling, failCounts };
}

export function topFailCodes(failCounts: Record<string, number>, n = 5): Array<[string, number]> {
  return Object.entries(failCounts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
}

// ---------------------------------------------------------------- summaries

const REASON_WORDS: Record<ExitReason, string> = { tp: 'take profit', stop: 'stop', trail: 'trailing stop', time: 'time cap' };

export function entrySummary(label: string, priceUsd: number, f: FloorArenaFeatures, source: string, nowMs: number): string {
  const age = f.pairCreatedAt ? (nowMs - f.pairCreatedAt) / 1000 : f.ageS;
  return `Bought $${ARENA_POSITION_USD} of ${label} at ${formatPrice(priceUsd)} (mcap ${formatUsdCompact(f.mcap)}, liq ${formatUsdCompact(f.liqUsd)}, age ${formatAge(age)}) via ${source}`;
}

export function exitSummary(input: {
  label: string; trigger: ExitTrigger; legs: number; mult: number | null; proceedsUsd: number;
  fillSource: ExitFillSource; fill: ExitFillResult; sizeUsd: number;
}): string {
  const { label, trigger, legs, mult, proceedsUsd, fillSource, fill, sizeUsd } = input;
  const pct = Math.round(trigger.fraction * 100);
  const at = mult !== null && Number.isFinite(mult) ? ` at ${mult.toFixed(2)}x` : '';
  const why = trigger.reason === 'tp' ? `TP ${trigger.leg} of ${legs}` : REASON_WORDS[trigger.reason];
  const via = fillSource === 'quote' ? 'quote'
    : fillSource === 'quote_confirmed' ? 'confirmed low quote (2+ low quotes over 45 s)' : 'mark fallback (no usable sell quote)';
  const head = `Sold ${pct}% of ${label}${at} (${why}) for $${proceedsUsd.toFixed(2)} via ${via}.`;
  if (!fill.closed || fill.pnlUsd === null) return head;
  const pnlPct = (100 * fill.pnlUsd) / sizeUsd;
  return `${head} Closed: P&L ${formatSignedUsd(fill.pnlUsd)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%).`;
}

const SKIP_WORDS: Record<string, string> = {
  impact: 'price impact over 3%',
  drift: 'quote more than 35% away from the DexScreener price',
  drift_unknown: 'no DexScreener price to check the quote',
  quote_failed: 'no ClawPump quote',
  quote_breaker: 'ClawPump quotes failing, paused for 60 s',
  quote_echo_mismatch: 'the quote did not match the request',
  impact_unknown: 'the quote had no price impact',
  quote_output_bad: 'the quote had no usable output',
  not_configured: 'quotes are not configured',
  max_open: 'all position slots are full',
  cooldown: 'traded recently (re-entry cooldown)',
};

// ---------------------------------------------------------------- in-memory rate limits

const emitted = new Map<string, number>();
const lastScanAt = new Map<string, number>();
const entryRefusalUntil = new Map<string, number>();
const invalidParamsLogged = new Map<string, number>();

function shouldEmit(key: string, nowMs: number): boolean {
  const last = emitted.get(key);
  if (last !== undefined && nowMs - last < EVENT_DEDUPE_MS) return false;
  emitted.set(key, nowMs);
  return true;
}

function pruneMemory(nowMs: number): void {
  for (const [key, at] of emitted) if (nowMs - at > 2 * EVENT_DEDUPE_MS) emitted.delete(key);
  for (const [key, until] of entryRefusalUntil) if (until <= nowMs) entryRefusalUntil.delete(key);
}

export function resetEngineMemoryForTest(): void {
  emitted.clear();
  lastScanAt.clear();
  entryRefusalUntil.clear();
  invalidParamsLogged.clear();
}

// ---------------------------------------------------------------- house agents

/** Inserts the 5 house agents when missing. Existing rows are never touched (the tuner owns their params). */
export async function ensureHouseAgents(): Promise<number> {
  let inserted = 0;
  for (const house of FLOOR_ARENA_HOUSE_AGENTS) {
    const template = floorArenaTemplateById(house.templateId);
    if (!template) continue;
    const rows = await db.insert(floorArenaAgents).values({
      id: house.id,
      kind: 'house',
      ownerUserId: null,
      name: house.name,
      templateId: template.id,
      params: cloneFloorArenaParams(template.params),
      paramsVersion: 1,
      mode: 'paper',
      status: 'active',
      seated: true,
      clawpumpAgentId: house.clawpumpAgentId,
    }).onConflictDoNothing({ target: floorArenaAgents.id }).returning({ id: floorArenaAgents.id });
    inserted += rows.length;
  }
  return inserted;
}

// ---------------------------------------------------------------- DB helpers

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result as Array<Record<string, unknown>> : ((result as { rows?: Array<Record<string, unknown>> })?.rows ?? []);
}

function msOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function verdictOf(raw: unknown, snapshot: FloorArenaSnapshot): { verdict: 'pass' | 'fail' | 'pending'; top10Pct: number | null } {
  const v = raw as Partial<ArenaChainVerdict> | null;
  if (!v || typeof v.pass !== 'boolean') return { verdict: 'pending', top10Pct: null };
  // A verdict for another pair than the one priced now is stale: wait for the re-check.
  if (v.pairAddress !== undefined && v.pairAddress !== snapshot.pairAddress) return { verdict: 'pending', top10Pct: null };
  return { verdict: v.pass ? 'pass' : 'fail', top10Pct: typeof v.top10Pct === 'number' ? v.top10Pct : null };
}

/** Freshest of the row snapshot and the leader memory; null when neither is <= 60 s old. */
function freshSnapshot(mint: string, rowSnapshot: unknown, rowAt: unknown, nowMs: number): FloorArenaSnapshot | null {
  const memory = rememberedSnapshot(mint);
  const rowMs = msOf(rowAt);
  const useMemory = memory && (rowMs === null || memory.at >= rowMs);
  const snapshot = useMemory ? memory!.snapshot : (rowSnapshot as FloorArenaSnapshot | null);
  const at = useMemory ? memory!.at : rowMs;
  if (!snapshot || at === null || nowMs - at > ARENA_MARK_MAX_AGE_MS) return null;
  return snapshot;
}

interface EntryDeps { quoteBuy?: typeof quoteBuy }

export interface EntryTickResult { agents: number; candidates: number; entries: number; skips: number; errors: number }

let enginePaused = false;
export function setEntriesPaused(paused: boolean): void { enginePaused = paused; }
export function entriesPaused(): boolean { return enginePaused; }

export async function runEntryTick(now: Date = new Date(), deps: EntryDeps = {}): Promise<EntryTickResult> {
  const result: EntryTickResult = { agents: 0, candidates: 0, entries: 0, skips: 0, errors: 0 };
  if (enginePaused) return result;
  const nowMs = now.getTime();
  pruneMemory(nowMs);
  const agents = await db.select().from(floorArenaAgents).where(and(
    eq(floorArenaAgents.status, 'active'),
    eq(floorArenaAgents.mode, 'paper'),
    or(eq(floorArenaAgents.kind, 'house'), eq(floorArenaAgents.seated, true)),
  ));
  result.agents = agents.length;
  if (agents.length === 0) return result;

  const freshCutoff = new Date(nowMs - ARENA_MARK_MAX_AGE_MS).toISOString();
  const sharedRows = rowsOf(await db.execute(sql`
    SELECT mint, first_seen_at, first_source, symbol, snapshot, snapshot_at, chain_verdict
    FROM floor_discovery_mints
    WHERE expires_at > ${now.toISOString()}::timestamptz AND snapshot IS NOT NULL AND snapshot_at >= ${freshCutoff}::timestamptz
  `));
  const shared: ArenaCandidate[] = [];
  for (const row of sharedRows) {
    const mint = String(row.mint);
    const snapshot = freshSnapshot(mint, row.snapshot, row.snapshot_at, nowMs);
    if (!snapshot) continue;
    const { verdict, top10Pct } = verdictOf(row.chain_verdict, snapshot);
    shared.push({
      mint, source: String(row.first_source), symbol: (row.symbol as string | null) ?? snapshot.symbol ?? null,
      firstSeenAtMs: msOf(row.first_seen_at) ?? nowMs, features: { ...snapshot, top10Pct }, verdict, isPrivate: false,
    });
  }
  // Deterministic evaluation order before ranking: newest first sight first.
  shared.sort((a, b) => b.firstSeenAtMs - a.firstSeenAtMs || (a.mint < b.mint ? -1 : 1));
  result.candidates = shared.length;

  const agentIds = agents.map((a) => a.id);
  const openRows = await db.select({ agentId: floorArenaPositions.agentId, mint: floorArenaPositions.mint })
    .from(floorArenaPositions)
    .where(and(eq(floorArenaPositions.status, 'open'), inArray(floorArenaPositions.agentId, agentIds)));
  const held = new Map<string, Set<string>>();
  for (const row of openRows) {
    if (!held.has(row.agentId)) held.set(row.agentId, new Set());
    held.get(row.agentId)!.add(row.mint);
  }
  const validParams = new Map<string, FloorArenaParams>();
  for (const agent of agents) {
    const checked = validateFloorArenaParams(agent.params);
    if (checked.ok) {
      validParams.set(agent.id, checked.params);
    } else if (nowMs - (invalidParamsLogged.get(agent.id) ?? 0) >= 3_600_000) {
      invalidParamsLogged.set(agent.id, nowMs);
      await writeArenaEvent({
        agentId: agent.id, type: 'status', summary: 'Not trading: the saved rules are invalid. Edit and save them again.',
        data: { errors: checked.errors.slice(0, 10) },
      }).catch(() => undefined);
    }
  }
  const maxCooldownS = Math.max(0, ...[...validParams.values()].map((p) => p.limits.reentry_cooldown_s));
  const closedRows = maxCooldownS > 0 ? rowsOf(await db.execute(sql`
    SELECT agent_id, mint, max(closed_at) AS closed_at FROM floor_arena_positions
    WHERE status = 'closed' AND closed_at >= ${new Date(nowMs - maxCooldownS * 1000).toISOString()}::timestamptz
    GROUP BY agent_id, mint
  `)) : [];
  const lastClosed = new Map<string, Map<string, number>>();
  for (const row of closedRows) {
    const agentId = String(row.agent_id);
    if (!lastClosed.has(agentId)) lastClosed.set(agentId, new Map());
    lastClosed.get(agentId)!.set(String(row.mint), msOf(row.closed_at) ?? 0);
  }
  const privateByAgent = await loadPrivateCandidates(agentIds, now);

  for (const agent of agents) {
    const params = validParams.get(agent.id);
    if (!params) continue;
    try {
      const outcome = await runAgentEntries(agent, params, [...(privateByAgent.get(agent.id) ?? []), ...shared],
        held.get(agent.id) ?? new Set(), lastClosed.get(agent.id) ?? new Map(), now, deps);
      result.entries += outcome.entries;
      result.skips += outcome.skips;
    } catch (error) {
      result.errors += 1;
      console.warn('[floor-arena] entry failed for agent', agent.id, error instanceof Error ? error.message.slice(0, 200) : 'error');
    }
  }
  return result;
}

async function loadPrivateCandidates(agentIds: readonly string[], now: Date): Promise<Map<string, ArenaCandidate[]>> {
  const out = new Map<string, ArenaCandidate[]>();
  if (agentIds.length === 0) return out;
  const nowMs = now.getTime();
  const rows = rowsOf(await db.execute(sql`
    SELECT agent_id, mint, first_seen_at, source, symbol, snapshot, snapshot_at, chain_verdict
    FROM floor_arena_private_mints
    WHERE agent_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(agentIds)}::jsonb))
  `));
  for (const row of rows) {
    const mint = String(row.mint);
    const snapshot = freshSnapshot(mint, row.snapshot, row.snapshot_at, nowMs);
    if (!snapshot) continue;
    const { verdict, top10Pct } = verdictOf(row.chain_verdict, snapshot);
    const agentId = String(row.agent_id);
    if (!out.has(agentId)) out.set(agentId, []);
    out.get(agentId)!.push({
      mint, source: `private:${String(row.source)}`, symbol: (row.symbol as string | null) ?? snapshot.symbol ?? null,
      firstSeenAtMs: msOf(row.first_seen_at) ?? nowMs, features: { ...snapshot, top10Pct }, verdict, isPrivate: true,
    });
  }
  return out;
}

async function runAgentEntries(
  agent: FloorArenaAgentRow,
  params: FloorArenaParams,
  candidates: ArenaCandidate[],
  held: Set<string>,
  lastClosed: Map<string, number>,
  now: Date,
  deps: EntryDeps,
): Promise<{ entries: number; skips: number }> {
  const nowMs = now.getTime();
  // A private mint also in the shared feed is evaluated once (the private row first).
  const seen = new Set<string>();
  const unique = candidates.filter((c) => (seen.has(c.mint) ? false : (seen.add(c.mint), true)));
  const evaluation = evaluateAgentCandidates(params, unique, held, lastClosed, nowMs);
  const events: ArenaEventInput[] = [];
  const rankLabel = FLOOR_ARENA_RANK_BY_LABELS[params.entry.rank_by] ?? params.entry.rank_by;
  let passEvents = 0;
  evaluation.passed.forEach((c, i) => {
    if (passEvents >= PASS_EVENTS_PER_TICK || !shouldEmit(`${agent.id}|pass|${c.mint}`, nowMs)) return;
    passEvents += 1;
    events.push({
      agentId: agent.id, type: 'pass', mint: c.mint,
      summary: `${tokenLabel(c.symbol, c.mint)} passed every rule (rank ${i + 1} of ${evaluation.passed.length}, ${rankLabel})`,
      data: { rank: i + 1, of: evaluation.passed.length, source: c.source, mcap: c.features.mcap, liqUsd: c.features.liqUsd },
    });
  });
  let skips = 0;
  for (const c of evaluation.cooling) {
    if (!shouldEmit(`${agent.id}|skip|${c.mint}|cooldown`, nowMs)) continue;
    skips += 1;
    events.push({ agentId: agent.id, type: 'skip', mint: c.mint, summary: `Skipped ${tokenLabel(c.symbol, c.mint)}: ${SKIP_WORDS.cooldown}`, data: { reason: 'cooldown' } });
  }
  if (nowMs - (lastScanAt.get(agent.id) ?? 0) >= SCAN_EVERY_MS) {
    lastScanAt.set(agent.id, nowMs);
    const top = topFailCodes(evaluation.failCounts);
    events.push({
      agentId: agent.id, type: 'scan',
      summary: `Scanned ${evaluation.evaluated} coins: ${evaluation.passed.length} passed. Top reasons to skip: ${top.map(([code, n]) => `${code} ${n}`).join(', ') || 'none'}`,
      data: { evaluated: evaluation.evaluated, passed: evaluation.passed.length, held: held.size, failCounts: evaluation.failCounts, top },
    });
  }

  const freeSlots = params.limits.max_open - held.size;
  let entries = 0;
  if (evaluation.passed.length > 0 && freeSlots <= 0 && shouldEmit(`${agent.id}|skip|max_open`, nowMs)) {
    skips += 1;
    events.push({ agentId: agent.id, type: 'skip', summary: `Skipped ${evaluation.passed.length} passing coin(s): ${SKIP_WORDS.max_open}`, data: { reason: 'max_open', open: held.size } });
  }
  let attempts = 0;
  for (const c of evaluation.passed) {
    if (attempts >= params.entry.entries_per_tick || entries >= freeSlots) break;
    const refusalKey = `${agent.id}|${c.mint}`;
    if ((entryRefusalUntil.get(refusalKey) ?? 0) > nowMs) continue;
    attempts += 1;
    const quote: BuyQuoteResult = await (deps.quoteBuy ?? quoteBuy)(c.mint, ARENA_POSITION_USD, c.features.priceUsd);
    if (!quote.ok) {
      const transient = quote.reason === 'quote_failed' || quote.reason === 'quote_breaker' || quote.reason === 'not_configured';
      entryRefusalUntil.set(refusalKey, nowMs + (transient ? TRANSIENT_COOLDOWN_MS : REFUSAL_COOLDOWN_MS));
      if (shouldEmit(`${agent.id}|skip|${c.mint}|${quote.reason}`, nowMs)) {
        skips += 1;
        events.push({
          agentId: agent.id, type: 'skip', mint: c.mint,
          summary: `Skipped ${tokenLabel(c.symbol, c.mint)}: ${SKIP_WORDS[quote.reason] ?? quote.reason}${quote.detail && (quote.reason === 'impact' || quote.reason === 'drift') ? ` (${quote.detail})` : ''}`,
          data: { reason: quote.reason, detail: quote.detail ?? null },
        });
      }
      if (quote.reason === 'quote_breaker' || quote.reason === 'not_configured') break;
      continue;
    }
    const opened = await openPosition(agent, params, c, quote, now);
    if (opened === 'max_open') break;
    if (opened === 'opened') {
      entries += 1;
      held.add(c.mint);
    }
  }
  await writeArenaEvents(events);
  return { entries, skips };
}

async function openPosition(
  agent: FloorArenaAgentRow,
  params: FloorArenaParams,
  c: ArenaCandidate,
  quote: Extract<BuyQuoteResult, { ok: true }>,
  now: Date,
): Promise<'opened' | 'max_open' | 'duplicate'> {
  const nowMs = now.getTime();
  const label = tokenLabel(c.symbol, c.mint);
  return db.transaction(async (tx) => {
    // Per-agent lock: max_open stays exact even if two leaders overlap during a deploy flip.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`floor-arena-agent:${agent.id}`}, 0))`);
    const open = rowsOf(await tx.execute(sql`
      SELECT count(*)::int AS n FROM floor_arena_positions WHERE agent_id = ${agent.id} AND status = 'open'
    `));
    if (Number(open[0]?.n ?? 0) >= params.limits.max_open) return 'max_open' as const;
    const entryFeatures = {
      ...c.features,
      source: c.source,
      firstSeenAt: new Date(c.firstSeenAtMs).toISOString(),
      exits: params.exits,
      decimals: quote.decimals,
      dsEntryPriceUsd: c.features.priceUsd,
      quote: { impactPct: quote.impactPct, driftPct: quote.driftPct, quotedTokens: quote.quotedTokens, venue: quote.venue, route: quote.route },
    };
    const inserted = await tx.insert(floorArenaPositions).values({
      agentId: agent.id,
      mint: c.mint,
      symbol: c.symbol,
      source: c.source,
      openedAt: now,
      sizeUsd: String(ARENA_POSITION_USD),
      tokens: String(quote.tokens),
      entryPriceUsd: String(quote.entryPriceUsd),
      entryFillSource: 'quote',
      entryFeatures,
      paramsVersion: agent.paramsVersion,
      peakMult: '1',
      remainingFraction: '1',
      realisedUsd: '0',
      status: 'open',
    }).onConflictDoNothing({
      target: [floorArenaPositions.agentId, floorArenaPositions.mint],
      where: sql`status = 'open'`,
    }).returning({ id: floorArenaPositions.id });
    const positionId = inserted[0]?.id;
    if (!positionId) return 'duplicate' as const;
    await writeArenaEvent({
      agentId: agent.id, type: 'entry', mint: c.mint,
      summary: entrySummary(label, quote.entryPriceUsd, c.features, c.source, nowMs),
      data: {
        positionId, sizeUsd: ARENA_POSITION_USD, entryPriceUsd: quote.entryPriceUsd, tokens: quote.tokens,
        dsPriceUsd: c.features.priceUsd, impactPct: quote.impactPct, driftPct: quote.driftPct, source: c.source,
        mcap: c.features.mcap, liqUsd: c.features.liqUsd, paramsVersion: agent.paramsVersion,
        liqFloorUsd: FLOOR_ARENA_LIQ_FLOOR_USD,
      },
    }, tx);
    return 'opened' as const;
  });
}

// ---------------------------------------------------------------- exits

interface ExitDeps { quoteSell?: typeof quoteSell }

export interface ExitTickResult {
  open: number; marked: number; exits: number; closed: number; fallbacks: number; confirmedQuotes: number;
  unresolved: number; quoteFailures: number; errors: number;
}

function exitsOf(position: FloorArenaPositionRow, agentParams: FloorArenaParams | null): FloorArenaExits | null {
  const stored = (position.entryFeatures as { exits?: FloorArenaExits } | null)?.exits;
  if (stored && Array.isArray(stored.tp) && typeof stored.max_hold_s === 'number') return stored;
  return agentParams?.exits ?? null;
}

function positiveNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function runExitTick(now: Date = new Date(), deps: ExitDeps = {}): Promise<ExitTickResult> {
  const nowMs = now.getTime();
  const result: ExitTickResult = { open: 0, marked: 0, exits: 0, closed: 0, fallbacks: 0, confirmedQuotes: 0, unresolved: 0, quoteFailures: 0, errors: 0 };
  const positions = await db.select().from(floorArenaPositions).where(eq(floorArenaPositions.status, 'open'));
  result.open = positions.length;
  if (positions.length === 0) return result;
  const agentIds = [...new Set(positions.map((p) => p.agentId))];
  const agentRows = await db.select({ id: floorArenaAgents.id, params: floorArenaAgents.params })
    .from(floorArenaAgents).where(inArray(floorArenaAgents.id, agentIds));
  const agentParams = new Map(agentRows.map((row) => {
    const checked = validateFloorArenaParams(row.params);
    return [row.id, checked.ok ? checked.params : null] as const;
  }));
  const marks = await markPrices(positions.map((p) => p.mint), now);
  const markUpdates: Array<{ id: string; peak: number; mult: number; at: string }> = [];

  for (const position of positions) {
    try {
      const exits = exitsOf(position, agentParams.get(position.agentId) ?? null);
      const entryPriceUsd = positiveNumber(position.entryPriceUsd);
      const tokens = positiveNumber(position.tokens);
      const sizeUsd = positiveNumber(position.sizeUsd) ?? ARENA_POSITION_USD;
      if (!exits || entryPriceUsd === null || tokens === null) {
        result.errors += 1;
        continue;
      }
      const mark = marks.get(position.mint) ?? null;
      const markMult = mark ? mark.priceUsd / entryPriceUsd : null;
      const state: ExitState = {
        entryPriceUsd, tokens, sizeUsd,
        openedAtMs: position.openedAt.getTime(),
        peakMult: Math.max(positiveNumber(position.peakMult) ?? 1, markMult ?? 0),
        remainingFraction: Number(position.remainingFraction),
        realisedUsd: Number(position.realisedUsd),
      };
      if (markMult !== null) {
        result.marked += 1;
        markUpdates.push({ id: position.id, peak: round9(state.peakMult), mult: round9(markMult), at: mark!.at.toISOString() });
      }
      const trigger = decideExitTrigger(state, exits, markMult, nowMs);
      if (!trigger) continue;
      const outcome = await executeExit(position, state, exits, trigger, mark?.priceUsd ?? null, markMult, mark?.at.getTime() ?? null, now, deps);
      if (outcome.kind === 'filled') {
        result.exits += 1;
        if (outcome.closed) result.closed += 1;
        if (outcome.source === 'mark_fallback') result.fallbacks += 1;
        if (outcome.source === 'quote_confirmed') result.confirmedQuotes += 1;
      }
      if (outcome.kind === 'quote_failed') result.quoteFailures += 1;
      if (outcome.kind === 'unresolved') result.unresolved += 1;
    } catch (error) {
      result.errors += 1;
      console.warn('[floor-arena] exit failed for position', position.id, error instanceof Error ? error.message.slice(0, 200) : 'error');
    }
  }
  if (markUpdates.length > 0) {
    await db.execute(sql`
      UPDATE floor_arena_positions AS p
      SET peak_mult = GREATEST(p.peak_mult, r.peak),
          last_mark_mult = CASE WHEN p.last_mark_at IS NULL OR p.last_mark_at <= r.at THEN r.mult ELSE p.last_mark_mult END,
          last_mark_at = GREATEST(COALESCE(p.last_mark_at, r.at), r.at)
      FROM jsonb_to_recordset(${JSON.stringify(markUpdates)}::jsonb) AS r(id uuid, peak numeric, mult numeric, at timestamptz)
      WHERE p.id = r.id AND p.status = 'open'
    `);
  }
  return result;
}

type ExitOutcome = { kind: 'filled'; closed: boolean; source: ExitFillSource } | { kind: 'quote_failed' } | { kind: 'unresolved' }
  | { kind: 'lost_race' };

/**
 * Compare-and-swap guard for every write that replaces exit_run (Codex r6 #2): the row must still hold the run this
 * tick read. A concurrent writer (a second leader during a deploy flip) makes the write a no-op; the next tick
 * re-reads the row and retries. jsonb equality ignores key order.
 */
function exitRunUnchanged(position: FloorArenaPositionRow) {
  const prev = position.exitRun === null || position.exitRun === undefined ? null : JSON.stringify(position.exitRun);
  return sql`${floorArenaPositions.exitRun} IS NOT DISTINCT FROM ${prev}::jsonb`;
}

/** Last known mark (memory, any age), else the last stored mark. Null when the position was never marked. */
function lastKnownMark(position: FloorArenaPositionRow, entryPriceUsd: number): number | null {
  const remembered = lastRememberedPrice(position.mint);
  if (remembered !== null) return remembered;
  const lastMult = positiveNumber(position.lastMarkMult);
  return lastMult !== null ? lastMult * entryPriceUsd : null;
}

/** Stale-mark D4 fallback when no sell quote exists at all: last known mark, else the entry DS price. */
function staleFallbackPrice(position: FloorArenaPositionRow, entryPriceUsd: number): number | null {
  return lastKnownMark(position, entryPriceUsd)
    ?? positiveNumber((position.entryFeatures as { dsEntryPriceUsd?: unknown } | null)?.dsEntryPriceUsd);
}

async function executeExit(
  position: FloorArenaPositionRow,
  state: ExitState,
  exits: FloorArenaExits,
  trigger: ExitTrigger,
  freshMarkPrice: number | null,
  markMult: number | null,
  markAtMs: number | null,
  now: Date,
  deps: ExitDeps,
): Promise<ExitOutcome> {
  const nowMs = now.getTime();
  const tokensToSell = state.tokens * trigger.fraction;
  const decimals = (position.entryFeatures as { decimals?: unknown } | null)?.decimals;
  // With no fresh mark, a sell quote under half the reference (last known mark, else entry price) is a failure.
  const referencePriceUsd = freshMarkPrice === null ? lastKnownMark(position, state.entryPriceUsd) ?? state.entryPriceUsd : null;
  const quote: SellQuoteResult = typeof decimals === 'number'
    ? await (deps.quoteSell ?? quoteSell)(position.mint, tokensToSell, decimals, { markPriceUsd: freshMarkPrice, referencePriceUsd })
    : { ok: false, reason: 'quote_output_bad', detail: 'decimals unknown' };
  let proceedsUsd: number;
  let fillSource: ExitFillSource;
  let fillPrice: number | null;
  if (quote.ok) {
    proceedsUsd = quote.proceedsUsd;
    fillSource = 'quote';
    fillPrice = quote.priceUsd;
  } else {
    const run = advanceExitRun(parseExitRun(position.exitRun), classifyExitAttempt(quote.reason), nowMs);
    const currentLow = quote.reason === 'quote_far_below_reference' && quote.fill ? quote.fill : null;
    const d4 = d4Decision({
      freshMarkPrice,
      currentLowQuotePrice: currentLow?.priceUsd ?? null,
      run,
      nowMs,
      staleFallbackPrice: staleFallbackPrice(position, state.entryPriceUsd),
    });
    if (d4 === null) {
      const written = await db.update(floorArenaPositions)
        .set({ exitQuoteFailures: run.failures, exitRun: run })
        .where(and(eq(floorArenaPositions.id, position.id), eq(floorArenaPositions.status, 'open'), exitRunUnchanged(position)))
        .returning({ id: floorArenaPositions.id });
      return written.length > 0 ? { kind: 'quote_failed' } : { kind: 'lost_race' };
    }
    if (d4.kind === 'unresolved') return closeUnresolved(position, state, trigger, run, markMult, markAtMs, now);
    // quote_confirmed books THIS attempt's quote (after the sell cost); mark_fallback books tokens x price - cost.
    proceedsUsd = d4.source === 'quote_confirmed' && currentLow ? currentLow.proceedsUsd : markFallbackProceeds(tokensToSell, d4.priceUsd);
    fillSource = d4.source;
    fillPrice = d4.priceUsd;
  }
  const fill = applyExitFill(state, trigger, proceedsUsd);
  const stickySource = combineFillSource(position.exitFillSource, fillSource);
  const updated = await db.transaction(async (tx) => {
    const rows = await tx.update(floorArenaPositions).set({
      remainingFraction: String(fill.remainingFraction),
      realisedUsd: String(fill.realisedUsd),
      ...risingPeakSet(state.peakMult),
      exitQuoteFailures: 0,
      exitRun: null,
      exitFillSource: stickySource,
      ...newerMarkSet(markMult, markAtMs),
      ...(fill.closed ? {
        status: 'closed' as const,
        closedAt: now,
        exitReason: trigger.reason,
        pnlUsd: String(fill.pnlUsd),
        pnlMult: String(fill.pnlMult),
      } : {}),
    }).where(and(
      eq(floorArenaPositions.id, position.id),
      eq(floorArenaPositions.status, 'open'),
      // CAS: a second leader (deploy flip) that already booked this leg, or changed the failure run the decision
      // used, makes this a no-op.
      eq(floorArenaPositions.remainingFraction, position.remainingFraction),
      exitRunUnchanged(position),
    )).returning({ id: floorArenaPositions.id });
    if (rows.length === 0) return false;
    const label = tokenLabel(position.symbol, position.mint);
    const fillMult = fillPrice !== null ? fillPrice / state.entryPriceUsd : markMult;
    await writeArenaEvent({
      agentId: position.agentId, type: 'exit', mint: position.mint,
      summary: exitSummary({ label, trigger, legs: exits.tp.length, mult: fillMult, proceedsUsd, fillSource, fill, sizeUsd: state.sizeUsd }),
      data: {
        positionId: position.id, reason: trigger.reason, leg: trigger.leg, fraction: trigger.fraction, proceedsUsd,
        fillSource, fillPriceUsd: fillPrice, markMult, closed: fill.closed, pnlUsd: fill.pnlUsd, pnlMult: fill.pnlMult,
        remainingFraction: fill.remainingFraction, holdS: Math.round((nowMs - state.openedAtMs) / 1000),
      },
    }, tx);
    return true;
  });
  if (!updated) return { kind: 'lost_race' };
  return { kind: 'filled', closed: fill.closed, source: fillSource };
}

/**
 * Codex r5 #1: the failure run lasted >= 30 min with no bookable price. Close the position without booking:
 * exit_reason / exit_fill_source 'unresolved', pnl_usd and pnl_mult NULL. The slot is free again and every
 * leaderboard / stat reader ignores rows with pnl_usd NULL. realised_usd keeps earlier TP-leg proceeds and
 * remaining_fraction keeps the unresolved share, for the record.
 */
async function closeUnresolved(
  position: FloorArenaPositionRow,
  state: ExitState,
  trigger: ExitTrigger,
  run: ExitRun,
  markMult: number | null,
  markAtMs: number | null,
  now: Date,
): Promise<ExitOutcome> {
  const nowMs = now.getTime();
  const updated = await db.transaction(async (tx) => {
    const rows = await tx.update(floorArenaPositions).set({
      status: 'closed',
      closedAt: now,
      exitReason: 'unresolved',
      exitFillSource: 'unresolved',
      pnlUsd: null,
      pnlMult: null,
      exitQuoteFailures: run.failures,
      exitRun: run,
      ...risingPeakSet(state.peakMult),
      ...newerMarkSet(markMult, markAtMs),
    }).where(and(
      eq(floorArenaPositions.id, position.id),
      eq(floorArenaPositions.status, 'open'),
      eq(floorArenaPositions.remainingFraction, position.remainingFraction),
      exitRunUnchanged(position),
    )).returning({ id: floorArenaPositions.id });
    if (rows.length === 0) return false;
    const label = tokenLabel(position.symbol, position.mint);
    await writeArenaEvent({
      agentId: position.agentId, type: 'exit', mint: position.mint,
      summary: `Closed ${label} as unresolved: no usable sell price for 30 min. Not counted in P&L.`,
      data: {
        positionId: position.id, reason: 'unresolved', trigger: trigger.reason, fillSource: 'unresolved', closed: true,
        pnlUsd: null, pnlMult: null, remainingFraction: state.remainingFraction, failures: run.failures, sawLow: run.sawLow,
        holdS: Math.round((nowMs - state.openedAtMs) / 1000),
      },
    }, tx);
    return true;
  });
  return updated ? { kind: 'unresolved' } : { kind: 'lost_race' };
}
