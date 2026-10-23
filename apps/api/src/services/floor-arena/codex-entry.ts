// FEATURE_GATE: codex_arena_entry_shadow
// Status: shadow + virtual twin (no trade effect)
// Metric to graduate: codex twin net $ and profit factor beat actual across bots after >=1 day, founder go
// Current reading: none (new)
// Review deadline: 2026-10-22
// On deadline: delete, or enforce the decision on paper twins (founder decision)
// Reference: docs/trading-floor-arena.md, infra/codex-decider/README.md

/**
 * codex-entry.ts - Codex DECIDER SHADOW for the Trading Floor arena paper bots.
 *
 * Every coin that reaches the buy-quote step of `runAgentEntries` (engine.ts) is also sent to the host sidecar
 * `infra/codex-decider` (Codex CLI on the founder's ChatGPT plan: a flat subscription, not per-call spend), which
 * answers enter/skip + confidence + exit_room + rug_risk + reasons. Every call is STORED in `floor_arena_codex_entry`
 * (migration 0085). NOTHING in the trade path reads it: the engine fires this without awaiting, every error is
 * caught here, and `apps/api/scripts/floor-arena-codex-report.ts` builds a "codex twin" per bot (real paper trades
 * minus the ones Codex would have skipped).
 *
 * Off unless FLOOR_ARENA_CODEX_DECIDER_URL and FLOOR_ARENA_CODEX_DECIDER_TOKEN are set (never under `bun test`).
 * Plan usage is limited by a calls-per-hour cap (FLOOR_ARENA_CODEX_MAX_PER_HOUR, default 60; in memory, so a restart
 * starts a new window), a 10-minute dedupe per agent+mint and an in-flight cap. The token is never logged or stored.
 */

import { db, sql } from '@clawville/database';
import { floorArenaTemplateById, type FloorArenaExits } from '@clawville/shared';
import { pairAgeSeconds, type FloorArenaFeatures } from './filters';
import { pumpFlowForMint, type PumpFlowFacts } from './pumpportal-feed';

/** Sidecar default deadline is 90 s (queue wait included); the client waits a little longer. */
export const CODEX_ENTRY_TIMEOUT_MS = 95_000;
export const CODEX_ENTRY_DEDUPE_MS = 10 * 60_000;
export const CODEX_ENTRY_DEDUPE_MAX = 5_000;
/** Sidecar concurrency 2 + 2 waiting; more would only be dropped there. */
export const CODEX_ENTRY_MAX_IN_FLIGHT = 4;
export const CODEX_ENTRY_DEFAULT_MAX_PER_HOUR = 60;
const HOUR_MS = 60 * 60_000;

export function codexMaxPerHour(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return CODEX_ENTRY_DEFAULT_MAX_PER_HOUR;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : CODEX_ENTRY_DEFAULT_MAX_PER_HOUR;
}

// ---------------------------------------------------------------- packet (compact numeric facts)

export interface CodexArenaBot {
  agentId: string;
  /** Template id (house) or agent name. */
  strategy: string;
  positionUsd: number;
  exits: FloorArenaExits;
}

export interface CodexArenaCoin {
  mint: string;
  source: string;
  features: FloorArenaFeatures;
  verdict: string;
  firstSeenAtMs?: number | null;
}

export interface CodexArenaEntryInput {
  bot: CodexArenaBot;
  coin: CodexArenaCoin;
}

function fin(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 4 significant digits keeps the packet short without hiding the size of a number. */
function r4(v: unknown): number | null {
  const n = fin(v);
  return n === null ? null : Number(n.toPrecision(4));
}

const FLOW_WINDOW_KEYS = ['coveredS', 'buys', 'sells', 'buySol', 'sellSol', 'uniqueBuyers', 'uniqueSellers', 'topBuyerShare'] as const;
const FLOW_TOP_KEYS = ['creatorBuySol', 'creatorSellSol', 'earlyBuyers', 'earlyHeldPct', 'lastMarketCapSol', 'lastVSol'] as const;

/** PumpPortal flow facts flattened to numbers/booleans (e.g. `w5m_buys`). Every string (mint, pool, creator wallet,
 *  timestamps) is dropped: the model needs flow numbers, not addresses. */
export function pumpFlowPacket(flow: PumpFlowFacts | null | undefined): Record<string, number | boolean | null> | null {
  if (!flow || typeof flow !== 'object') return null;
  const out: Record<string, number | boolean | null> = {};
  if (typeof flow.tradeFlow === 'boolean') out.tradeFlow = flow.tradeFlow;
  if (typeof flow.creatorSold === 'boolean') out.creatorSold = flow.creatorSold;
  for (const k of FLOW_TOP_KEYS) out[k] = r4(flow[k]);
  for (const w of ['w1m', 'w5m', 'w15m'] as const) {
    const win = flow[w];
    if (!win || typeof win !== 'object') continue;
    for (const k of FLOW_WINDOW_KEYS) out[`${w}_${k}`] = r4(win[k]);
  }
  return out;
}

/** Live flow lookup (the engine puts pumpFlow on entry_features only, not on candidate features). */
export type PumpFlowLookup = (mint: string, nowMs: number) => PumpFlowFacts | null;

export function strategySummary(strategy: string): string {
  const t = floorArenaTemplateById(strategy);
  return t ? `${t.displayName}: ${t.thesis} Risk: ${t.risk}`.slice(0, 400) : `custom strategy "${strategy.slice(0, 48)}"`;
}

/** The packet sent to the sidecar. Numbers only for the coin (no symbol/name: those are attacker-chosen text). */
export function buildCodexPacket(
  input: CodexArenaEntryInput,
  nowMs: number,
  lookupPumpFlow: PumpFlowLookup = pumpFlowForMint,
): Record<string, unknown> {
  const { bot, coin } = input;
  const f = coin.features;
  let flow: PumpFlowFacts | null = f.pumpFlow ?? null;
  if (!flow) {
    try { flow = lookupPumpFlow(coin.mint, nowMs); } catch { flow = null; }
  }
  const firstTp = bot.exits.tp[0]?.[0];
  const firstSeen = fin(coin.firstSeenAtMs);
  return {
    strategy: {
      summary: strategySummary(bot.strategy),
      positionUsd: bot.positionUsd,
      tpMult: fin(firstTp),
      tpLegs: bot.exits.tp.length,
      stopMult: fin(bot.exits.stop_mult),
      trailFromPeak: fin(bot.exits.trail_from_peak),
      maxHoldMin: Math.max(1, Math.round(bot.exits.max_hold_s / 60)),
    },
    coin: {
      mcap: r4(f.mcap),
      liqUsd: r4(f.liqUsd),
      chg5m: r4(f.chg5m),
      chg1h: r4(f.chg1h),
      chg6h: r4(f.chg6h),
      chg24h: r4(f.chg24h),
      vol1h: r4(f.vol1h),
      volOverMcap: r4(f.volOverMcap),
      txns1h: r4(f.txns1h),
      top10Pct: r4(f.top10Pct),
      ageS: r4(pairAgeSeconds(f, nowMs) ?? f.ageS),
      firstSeenAgoS: firstSeen === null ? null : Math.max(0, Math.round((nowMs - firstSeen) / 1000)),
      source: coin.source.slice(0, 48),
      chainVerdict: coin.verdict.slice(0, 16),
      // Pre-quote call site: quote impact/drift and the first-sight deltas are not known yet.
      pumpFlow: pumpFlowPacket(flow),
    },
  };
}

// ---------------------------------------------------------------- response

export interface CodexDecision {
  decision: 'enter' | 'skip';
  confidence: number;
  exitRoom: 'yes' | 'no';
  rugRisk: 'low' | 'med' | 'high';
  reasons: string[];
  model: string | null;
}

export function parseCodexResponse(raw: unknown): CodexDecision | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.decision !== 'enter' && o.decision !== 'skip') return null;
  const c = fin(o.confidence);
  if (c === null || c < 0 || c > 1) return null;
  if (o.exit_room !== 'yes' && o.exit_room !== 'no') return null;
  if (o.rug_risk !== 'low' && o.rug_risk !== 'med' && o.rug_risk !== 'high') return null;
  if (!Array.isArray(o.reasons)) return null;
  return {
    decision: o.decision,
    confidence: c,
    exitRoom: o.exit_room,
    rugRisk: o.rug_risk,
    reasons: o.reasons.filter((r): r is string => typeof r === 'string').slice(0, 3).map((r) => r.slice(0, 200)),
    model: typeof o.model === 'string' && o.model ? o.model.slice(0, 64) : null,
  };
}

// ---------------------------------------------------------------- ledger + runner

export type CodexEntryStatus = 'ok' | 'timeout' | 'error' | 'dropped' | 'capped';

export interface CodexEntryRow {
  agentId: string;
  mint: string;
  decidedAtMs: number;
  status: CodexEntryStatus;
  decision: CodexDecision | null;
  /** Round-trip ms seen by the API (null for a capped row: no call). */
  ms: number | null;
  error: string | null;
}

export interface CodexEntryLedger {
  insert(row: CodexEntryRow): Promise<void>;
}

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CodexEntryDeps {
  fetch: FetchLike;
  ledger: CodexEntryLedger;
  getUrl: () => string | undefined;
  getToken: () => string | undefined;
  getMaxPerHour: () => number;
  now: () => number;
  log: { warn: (line: string) => void };
  timeoutMs?: number;
}

export interface CodexEntryStats {
  started: number;
  deduped: number;
  skippedInFlight: number;
  capped: number;
}

function redact(text: string, token: string): string {
  return (token.length > 0 ? text.split(token).join('[redacted]') : text).slice(0, 200);
}

export function createCodexArenaEntry(deps: CodexEntryDeps) {
  const lastFired = new Map<string, number>();
  const sentAt: number[] = [];
  let inFlight = 0;
  let capWarnedHour = -1;
  const stats: CodexEntryStats = { started: 0, deduped: 0, skippedInFlight: 0, capped: 0 };

  async function call(input: CodexArenaEntryInput, url: string, token: string, decidedAtMs: number): Promise<void> {
    const base = { agentId: input.bot.agentId, mint: input.coin.mint, decidedAtMs };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? CODEX_ENTRY_TIMEOUT_MS);
    const started = deps.now();
    let row: CodexEntryRow;
    try {
      const res = await deps.fetch(`${url.replace(/\/+$/, '')}/decide`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: input.bot.agentId, mint: input.coin.mint, packet: buildCodexPacket(input, decidedAtMs) }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const ms = deps.now() - started;
      if (res.ok) {
        const decision = parseCodexResponse(body);
        row = decision
          ? { ...base, status: 'ok', decision, ms, error: null }
          : { ...base, status: 'error', decision: null, ms, error: 'bad_response' };
      } else {
        const code = typeof body?.error === 'string' ? body.error.slice(0, 32) : `http_${res.status}`;
        const status: CodexEntryStatus = res.status === 429 || code === 'dropped' ? 'dropped'
          : res.status === 504 || code === 'timeout' ? 'timeout' : 'error';
        row = { ...base, status, decision: null, ms, error: code };
      }
    } catch (err) {
      const timedOut = controller.signal.aborted;
      const message = redact(err instanceof Error ? err.message : String(err), token);
      row = { ...base, status: timedOut ? 'timeout' : 'error', decision: null, ms: deps.now() - started, error: timedOut ? 'client_timeout' : message };
      deps.log.warn(`[CodexArena] call ${timedOut ? 'timed out' : `failed: ${message}`}`);
    } finally {
      clearTimeout(timer);
    }
    await deps.ledger.insert(row);
  }

  function markFired(key: string, nowMs: number): void {
    lastFired.delete(key);
    lastFired.set(key, nowMs);
    while (lastFired.size > CODEX_ENTRY_DEDUPE_MAX) {
      const oldest = lastFired.keys().next().value;
      if (oldest === undefined) break;
      lastFired.delete(oldest);
    }
  }

  /** Synchronous gate (kill switch, dedupe, in-flight, hourly cap); returns the started promise or null. */
  function start(input: CodexArenaEntryInput): Promise<void> | null {
    const url = deps.getUrl()?.trim();
    const token = deps.getToken()?.trim();
    if (!url || !token) return null;
    const nowMs = deps.now();
    const key = `${input.bot.agentId}|${input.coin.mint}`;
    const last = lastFired.get(key);
    if (last !== undefined && nowMs - last < CODEX_ENTRY_DEDUPE_MS) {
      stats.deduped += 1;
      return null;
    }
    if (inFlight >= CODEX_ENTRY_MAX_IN_FLIGHT) {
      stats.skippedInFlight += 1;
      return null;
    }
    while (sentAt.length > 0 && nowMs - sentAt[0]! >= HOUR_MS) sentAt.shift();
    markFired(key, nowMs);
    if (sentAt.length >= deps.getMaxPerHour()) {
      stats.capped += 1;
      const hour = Math.floor(nowMs / HOUR_MS);
      if (capWarnedHour !== hour) {
        capWarnedHour = hour;
        deps.log.warn(`[CodexArena] hourly cap reached (${sentAt.length}/h); calls recorded as capped`);
      }
      return deps.ledger
        .insert({ agentId: input.bot.agentId, mint: input.coin.mint, decidedAtMs: nowMs, status: 'capped', decision: null, ms: null, error: null })
        .catch((err: unknown) => {
          deps.log.warn(`[CodexArena] ledger write failed: ${redact(err instanceof Error ? err.message : String(err), token)}`);
        });
    }
    sentAt.push(nowMs);
    inFlight += 1;
    stats.started += 1;
    return call(input, url, token, nowMs)
      .catch((err: unknown) => {
        deps.log.warn(`[CodexArena] shadow failed: ${redact(err instanceof Error ? err.message : String(err), token)}`);
      })
      .finally(() => { inFlight -= 1; });
  }

  /** Fire-and-forget: never throws, never rejects, never awaited by the engine. */
  function fire(input: CodexArenaEntryInput): void {
    let token = '';
    try {
      token = deps.getToken()?.trim() ?? '';
      void start(input);
    } catch (err) {
      deps.log.warn(`[CodexArena] shadow failed: ${redact(err instanceof Error ? err.message : String(err), token)}`);
    }
  }

  return {
    start,
    fire,
    stats: (): CodexEntryStats => ({ ...stats }),
    inFlight: () => inFlight,
    sentLastHour: () => sentAt.length,
  };
}

/** Default ledger: `floor_arena_codex_entry`, one bounded INSERT per call (a stalled shadow write must never hold a
 *  shared pool connection the trading paths need). */
export const dbCodexEntryLedger: CodexEntryLedger = {
  async insert(row) {
    const d = row.decision;
    const reasons = d === null ? null : JSON.stringify(d.reasons);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      await tx.execute(sql`
        INSERT INTO floor_arena_codex_entry
          (agent_id, mint, decided_at, status, model, decision, confidence, exit_room, rug_risk, reasons, ms, error)
        VALUES (${row.agentId}, ${row.mint}, ${new Date(row.decidedAtMs).toISOString()}::timestamptz, ${row.status},
                ${d?.model ?? null}, ${d?.decision ?? null}, ${d?.confidence ?? null}, ${d?.exitRoom ?? null},
                ${d?.rugRisk ?? null},
                CASE WHEN ${reasons}::jsonb IS NULL THEN NULL
                     ELSE ARRAY(SELECT jsonb_array_elements_text(${reasons}::jsonb)) END,
                ${row.ms === null ? null : Math.max(0, Math.round(row.ms))}, ${row.error})`);
    });
  },
};

const defaultEntry = createCodexArenaEntry({
  fetch: (url, init) => fetch(url, init),
  ledger: dbCodexEntryLedger,
  // Never under `bun test`: a developer sidecar in the environment must not be called from a test run.
  getUrl: () => (process.env.NODE_ENV === 'test' ? undefined : process.env.FLOOR_ARENA_CODEX_DECIDER_URL),
  getToken: () => process.env.FLOOR_ARENA_CODEX_DECIDER_TOKEN,
  getMaxPerHour: () => codexMaxPerHour(process.env.FLOOR_ARENA_CODEX_MAX_PER_HOUR),
  now: () => Date.now(),
  log: { warn: (line) => console.warn(line) },
});

/** Engine hook (runAgentEntries, right before quoteBuy). Its result never reaches a trade. */
export function fireCodexArenaEntry(input: CodexArenaEntryInput): void {
  defaultEntry.fire(input);
}

export function codexArenaEntryStats(): CodexEntryStats {
  return defaultEntry.stats();
}
