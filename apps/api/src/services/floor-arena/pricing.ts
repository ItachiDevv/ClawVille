import { z } from 'zod';
import { and, db, gte, inArray, isNotNull } from '@clawville/database';
import { floorArenaPrivateMints, floorDiscoveryMints } from '@clawville/database';
import { FLOOR_ARENA_PAPER_COSTS, TRADE_MINTS } from '@clawville/shared';
import {
  CLAWPUMP_ALLOWED_API_HOSTS, CLAWPUMP_DEFAULT_API_BASE_URL, ClawPumpClientError, resolveClawPumpConfig,
} from '../clawpump-client';
import type { FloorArenaSnapshot } from './filters';

/**
 * Paper fills and marks for the Trading Floor Arena (docs/trading-floor-arena.md D3, D4).
 *
 * Fills: ClawPump backend `POST /swap/quote` (Enterprise key) — the same quote a live buy would take, with the
 * refusals of the paper runner's `quote_refusal` (echo, venue price impact > 3 %, drift > 35 % from DexScreener).
 * Costs on top of the quote: FLOOR_ARENA_PAPER_COSTS (2.5 % buy haircut on tokens, 1.0 % sell haircut on USD).
 * Marks: the latest DexScreener snapshot, at most 60 s old. No Jupiter call anywhere (D3).
 *
 * Every outbound call goes through `arenaFetchJson`, which refuses any host outside the allowlist.
 */

export const USDC_MINT = TRADE_MINTS.USDC;
export const WSOL_MINT = TRADE_MINTS.WSOL;
export const USDC_DECIMALS = 6;
export const ARENA_QUOTE_SLIPPAGE_BPS = 300;
export const ARENA_MAX_IMPACT_PCT = 3;
export const ARENA_MAX_DRIFT_PCT = 35;
export const ARENA_MARK_MAX_AGE_MS = 60_000;
/** One paper position is always $20 (D6). The engine never sizes differently. */
export const ARENA_POSITION_USD = 20;

export const ARENA_DATA_HOSTS: ReadonlySet<string> = new Set(['api.dexscreener.com', 'api.geckoterminal.com']);
const HTTP_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 2_000_000;

export interface PaperCosts { buy_haircut_pct: number; sell_haircut_pct: number }
export const DEFAULT_PAPER_COSTS: PaperCosts = FLOOR_ARENA_PAPER_COSTS;

// ---------------------------------------------------------------- allowlisted HTTP

export class ArenaHttpError extends Error {
  constructor(readonly code: 'host_not_allowed' | 'timeout' | 'network_error' | 'http_error' | 'rate_limited'
    | 'response_too_large' | 'schema_invalid', readonly status: number | null = null) {
    // Code and status only: never a URL query (it can carry a key) or a vendor body.
    super(`arena_${code}${status === null ? '' : `_${status}`}`);
    this.name = 'ArenaHttpError';
  }
}

export type ArenaFetch = typeof fetch;

function hostAllowed(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && (ARENA_DATA_HOSTS.has(host) || CLAWPUMP_ALLOWED_API_HOSTS.has(host));
}

export async function arenaFetchJson(
  url: URL,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
  fetchImpl: ArenaFetch = fetch,
): Promise<unknown> {
  if (!hostAllowed(url)) throw new ArenaHttpError('host_not_allowed');
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      body: init.body,
      redirect: 'error',
      signal: AbortSignal.timeout(init.timeoutMs ?? HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    throw new ArenaHttpError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error');
  }
  if (response.status === 429) throw new ArenaHttpError('rate_limited', 429);
  if (!response.ok) throw new ArenaHttpError('http_error', response.status);
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_CHARS) {
    throw new ArenaHttpError('response_too_large', response.status);
  }
  let text: string;
  try { text = await response.text(); } catch { throw new ArenaHttpError('timeout', response.status); }
  if (text.length > MAX_RESPONSE_CHARS) throw new ArenaHttpError('response_too_large', response.status);
  try { return JSON.parse(text); } catch { throw new ArenaHttpError('schema_invalid', response.status); }
}

/**
 * The ClawPump backend origin (allowlisted by clawpump-client) and the key when one is configured.
 * Market routes (signals, anomalies) answer without a key; /swap/quote needs it.
 */
export function clawpumpBackend(env: Record<string, string | undefined> = process.env): { origin: string; apiKey: string | null; timeoutMs: number } {
  try {
    const config = resolveClawPumpConfig(env);
    return { origin: config.origin, apiKey: config.apiKey, timeoutMs: config.timeoutMs };
  } catch (error) {
    if (error instanceof ClawPumpClientError && error.code === 'not_configured') {
      return { origin: new URL(CLAWPUMP_DEFAULT_API_BASE_URL).origin, apiKey: null, timeoutMs: 15_000 };
    }
    throw error;
  }
}

// ---------------------------------------------------------------- DexScreener budget (300/min limit, we use <= 114)

export const DEXSCREENER_BUDGET_PER_MIN = 114;
const dexscreenerCalls: number[] = [];
let dexscreenerBlockedUntil = 0;

export function dexscreenerBudgetLeft(nowMs = Date.now(), limit = DEXSCREENER_BUDGET_PER_MIN): number {
  while (dexscreenerCalls.length > 0 && nowMs - dexscreenerCalls[0]! >= 60_000) dexscreenerCalls.shift();
  if (nowMs < dexscreenerBlockedUntil) return 0;
  return Math.max(0, limit - dexscreenerCalls.length);
}

export function noteDexscreenerCall(nowMs = Date.now()): void {
  dexscreenerCalls.push(nowMs);
}

/** After a 429, spend nothing for 30 s. */
export function noteDexscreenerRateLimited(nowMs = Date.now()): void {
  dexscreenerBlockedUntil = nowMs + 30_000;
}

export function dexscreenerCallsLastMinute(nowMs = Date.now()): number {
  dexscreenerBudgetLeft(nowMs);
  return dexscreenerCalls.length;
}

// ---------------------------------------------------------------- latest snapshots (leader memory)

interface RememberedSnapshot { snapshot: FloorArenaSnapshot; at: number }
const latestSnapshots = new Map<string, RememberedSnapshot>();
const LATEST_SNAPSHOT_MAX = 20_000;

/** The enrichment loop records every snapshot here as well as in the DB (open-position mints may have no row). */
export function rememberSnapshot(mint: string, snapshot: FloorArenaSnapshot, atMs: number): void {
  latestSnapshots.delete(mint);
  latestSnapshots.set(mint, { snapshot, at: atMs });
  if (latestSnapshots.size > LATEST_SNAPSHOT_MAX) {
    const oldest = latestSnapshots.keys().next().value;
    if (oldest !== undefined) latestSnapshots.delete(oldest);
  }
}

export function rememberedSnapshot(mint: string): RememberedSnapshot | null {
  return latestSnapshots.get(mint) ?? null;
}

/** SOL in USD (DexScreener WSOL/USDC pair, refreshed by the enrichment loop); the pool reserve check needs it. */
let solPrice: { usd: number; at: number } | null = null;
const SOL_PRICE_MAX_AGE_MS = 15 * 60_000;

export function rememberSolPrice(usd: number, atMs: number): void {
  if (Number.isFinite(usd) && usd > 0) solPrice = { usd, at: atMs };
}

export function currentSolPriceUsd(nowMs = Date.now()): number | null {
  return solPrice && nowMs - solPrice.at <= SOL_PRICE_MAX_AGE_MS ? solPrice.usd : null;
}

export function resetPricingStateForTest(): void {
  solPrice = null;
  latestSnapshots.clear();
  dexscreenerCalls.length = 0;
  dexscreenerBlockedUntil = 0;
  buyQuoteCache.clear();
  breaker.failures = 0;
  breaker.openUntil = 0;
}

export interface ArenaMark { priceUsd: number; at: Date; snapshot: FloorArenaSnapshot }

function positivePrice(snapshot: FloorArenaSnapshot | null | undefined): number | null {
  const price = snapshot?.priceUsd;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}

/** Marks from snapshots at most 60 s old: leader memory first, then the two snapshot tables. */
export async function markPrices(mints: readonly string[], now: Date = new Date()): Promise<Map<string, ArenaMark>> {
  const out = new Map<string, ArenaMark>();
  const cutoff = now.getTime() - ARENA_MARK_MAX_AGE_MS;
  const missing: string[] = [];
  for (const mint of new Set(mints)) {
    const remembered = latestSnapshots.get(mint);
    const price = positivePrice(remembered?.snapshot);
    if (remembered && price !== null && remembered.at >= cutoff) {
      out.set(mint, { priceUsd: price, at: new Date(remembered.at), snapshot: remembered.snapshot });
    } else {
      missing.push(mint);
    }
  }
  if (missing.length === 0) return out;
  const since = new Date(cutoff);
  const shared = await db.select({ mint: floorDiscoveryMints.mint, snapshot: floorDiscoveryMints.snapshot, at: floorDiscoveryMints.snapshotAt })
    .from(floorDiscoveryMints)
    .where(and(inArray(floorDiscoveryMints.mint, missing), gte(floorDiscoveryMints.snapshotAt, since)));
  const privateRows = await db.select({ mint: floorArenaPrivateMints.mint, snapshot: floorArenaPrivateMints.snapshot, at: floorArenaPrivateMints.snapshotAt })
    .from(floorArenaPrivateMints)
    .where(and(inArray(floorArenaPrivateMints.mint, missing), isNotNull(floorArenaPrivateMints.snapshotAt), gte(floorArenaPrivateMints.snapshotAt, since)));
  for (const row of [...shared, ...privateRows]) {
    const snapshot = row.snapshot as FloorArenaSnapshot | null;
    const price = positivePrice(snapshot);
    if (!snapshot || price === null || !row.at) continue;
    const prior = out.get(row.mint);
    if (prior && prior.at.getTime() >= row.at.getTime()) continue;
    out.set(row.mint, { priceUsd: price, at: row.at, snapshot });
  }
  return out;
}

/**
 * Any-age last price in leader memory WITH its snapshot time (Codex r8 #2): the D4 fallback compares it with the
 * stored mark and uses the newer one, so a running process and a restarted one choose the same price.
 */
export function lastRememberedMark(mint: string): { priceUsd: number; atMs: number } | null {
  const remembered = latestSnapshots.get(mint);
  const price = positivePrice(remembered?.snapshot);
  return remembered && price !== null ? { priceUsd: price, atMs: remembered.at } : null;
}

// ---------------------------------------------------------------- ClawPump quote wire

const sideWire = z.object({
  mint: z.string().min(1).max(64),
  amount: z.union([z.string(), z.number()]),
  rawAmount: z.union([z.string(), z.number()]),
  decimals: z.number().int().min(0).max(18),
}).passthrough();
const quoteWire = z.object({
  status: z.string(),
  input: sideWire,
  output: sideWire,
  slippageBps: z.number().optional(),
  priceImpactPct: z.union([z.string(), z.number()]).nullish(),
  venue: z.string().nullish(),
  route: z.array(z.string()).nullish(),
}).passthrough();
export type ClawPumpQuote = z.infer<typeof quoteWire>;

export type BuyRefusal = 'quote_failed' | 'quote_breaker' | 'quote_echo_mismatch' | 'impact_unknown' | 'impact'
  | 'quote_output_bad' | 'drift_unknown' | 'drift' | 'not_configured';
export type SellRefusal = 'quote_failed' | 'quote_echo_mismatch' | 'quote_output_bad' | 'drift' | 'quote_far_below_mark'
  | 'quote_far_below_reference' | 'not_configured';
/**
 * A sell quote under half the fresh mark (Codex r2 #5) or, with no fresh mark, under half the reference price
 * (last known mark, else the entry price; Codex r3 #5) is treated as a failed quote, so D4 decides the fill.
 */
export const ARENA_SELL_FLOOR_OF_MARK = 0.5;

export interface BuyFill {
  ok: true;
  usd: number;
  /** Tokens booked after the buy haircut. */
  tokens: number;
  entryPriceUsd: number;
  decimals: number;
  /** Tokens the venue quoted, before the haircut. */
  quotedTokens: number;
  impactPct: number;
  driftPct: number;
  venue: string | null;
  route: string[];
}
export type BuyQuoteResult = BuyFill | { ok: false; reason: BuyRefusal; detail?: string };

export interface SellFill {
  ok: true;
  tokens: number;
  /** USD the venue quoted, before the sell haircut. */
  quotedUsd: number;
  /** USD booked after the sell haircut. */
  proceedsUsd: number;
  priceUsd: number;
  venue: string | null;
}
/** `fill` is set only on `quote_far_below_reference`: the engine books it as `quote_confirmed` once D4 is reached. */
export type SellQuoteResult = SellFill | { ok: false; reason: SellRefusal; detail?: string; fill?: SellFill };

export interface SellQuotePrices {
  /** DexScreener mark at most 60 s old, else null. */
  markPriceUsd: number | null;
  /** Used only when markPriceUsd is null: the last known mark, else the entry price. */
  referencePriceUsd: number | null;
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** USD -> USDC smallest units, as the integer string ClawPump expects. */
export function usdToRawUsdc(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) throw new Error('usd must be positive');
  return String(Math.round(usd * 10 ** USDC_DECIMALS));
}

/** Token UI amount -> smallest units (floor), or null when it rounds to nothing. */
export function tokensToRaw(tokens: number, decimals: number): string | null {
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  const scaled = Math.floor(tokens * 10 ** decimals);
  if (!Number.isFinite(scaled) || scaled < 1) return null;
  return BigInt(scaled).toString();
}

/**
 * The paper runner's buy refusals (`quote_refusal`) plus the fill model. Pure; the unit tests pin it.
 * Order: status -> echo -> venue impact -> output sanity -> drift against DexScreener.
 */
export function evaluateBuyQuote(
  body: unknown,
  req: { mint: string; usd: number; amountRaw: string; slippageBps: number; dsPriceUsd: number | null },
  costs: PaperCosts = DEFAULT_PAPER_COSTS,
): BuyQuoteResult {
  const parsed = quoteWire.safeParse(body);
  if (!parsed.success) return { ok: false, reason: 'quote_failed', detail: 'schema' };
  const q = parsed.data;
  if (q.status !== 'quoted') return { ok: false, reason: 'quote_failed', detail: `status ${q.status.slice(0, 40)}` };
  if (q.input.mint !== USDC_MINT || q.output.mint !== req.mint || String(q.input.rawAmount) !== req.amountRaw
    || q.slippageBps !== req.slippageBps) {
    return { ok: false, reason: 'quote_echo_mismatch' };
  }
  // priceImpactPct is a FRACTION ("0.4028" = 40 %); runner v40 lesson: compare in percent.
  const impactFraction = num(q.priceImpactPct);
  if (impactFraction === null) return { ok: false, reason: 'impact_unknown' };
  const impactPct = 100 * Math.abs(impactFraction);
  if (impactPct > ARENA_MAX_IMPACT_PCT) return { ok: false, reason: 'impact', detail: `${impactPct.toFixed(2)}%` };
  const quotedTokens = num(q.output.amount);
  if (quotedTokens === null || quotedTokens <= 0) return { ok: false, reason: 'quote_output_bad' };
  const ds = req.dsPriceUsd;
  if (ds === null || !Number.isFinite(ds) || ds <= 0) return { ok: false, reason: 'drift_unknown' };
  const driftPct = 100 * (1 - (quotedTokens * ds) / req.usd);
  if (!Number.isFinite(driftPct)) return { ok: false, reason: 'drift_unknown' };
  if (Math.abs(driftPct) > ARENA_MAX_DRIFT_PCT) return { ok: false, reason: 'drift', detail: `${driftPct.toFixed(2)}%` };
  const tokens = quotedTokens * (1 - costs.buy_haircut_pct / 100);
  const entryPriceUsd = req.usd / tokens;
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
    return { ok: false, reason: 'quote_output_bad' };
  }
  return {
    ok: true, usd: req.usd, tokens, entryPriceUsd, decimals: q.output.decimals, quotedTokens, impactPct, driftPct,
    venue: q.venue ?? null, route: q.route ?? [],
  };
}

/**
 * A sell quote is the exit fill. Exits never refuse on venue impact (a dump must still close), but:
 * with a FRESH mark (snapshot <= 60 s; the caller passes null otherwise)
 *   - more than 35 % ABOVE the mark -> `drift` (a paper exit must not book a price nobody saw);
 *   - below 0.5 x the mark -> `quote_far_below_mark` (Codex r2 #5: a near-zero quote must not book a false loss);
 *   D4 then retries and, after 3 failures over >= 45 s, fills at the mark;
 * with NO fresh mark
 *   - below 0.5 x the reference (last known mark, else entry price) -> `quote_far_below_reference` carrying the
 *     evaluated fill (Codex r3 #5): a one-off glitch is retried, and a real crash is booked at the LATEST quote
 *     (`quote_confirmed`) once D4 is reached, never at a stale mark.
 */
export function evaluateSellQuote(
  body: unknown,
  req: { mint: string; tokens: number; amountRaw: string } & SellQuotePrices,
  costs: PaperCosts = DEFAULT_PAPER_COSTS,
): SellQuoteResult {
  const parsed = quoteWire.safeParse(body);
  if (!parsed.success) return { ok: false, reason: 'quote_failed', detail: 'schema' };
  const q = parsed.data;
  if (q.status !== 'quoted') return { ok: false, reason: 'quote_failed', detail: `status ${q.status.slice(0, 40)}` };
  if (q.input.mint !== req.mint || q.output.mint !== USDC_MINT || String(q.input.rawAmount) !== req.amountRaw) {
    return { ok: false, reason: 'quote_echo_mismatch' };
  }
  const quotedUsd = num(q.output.amount);
  if (quotedUsd === null || quotedUsd <= 0) return { ok: false, reason: 'quote_output_bad' };
  const priceUsd = quotedUsd / req.tokens;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { ok: false, reason: 'quote_output_bad' };
  const fill: SellFill = {
    ok: true, tokens: req.tokens, quotedUsd, proceedsUsd: quotedUsd * (1 - costs.sell_haircut_pct / 100), priceUsd,
    venue: q.venue ?? null,
  };
  const usable = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;
  const mark = req.markPriceUsd;
  if (usable(mark)) {
    if (priceUsd > mark * (1 + ARENA_MAX_DRIFT_PCT / 100)) {
      return { ok: false, reason: 'drift', detail: `${(100 * (priceUsd / mark - 1)).toFixed(2)}% over mark` };
    }
    if (priceUsd < mark * ARENA_SELL_FLOOR_OF_MARK) {
      return { ok: false, reason: 'quote_far_below_mark', detail: `${(priceUsd / mark).toFixed(4)}x of mark` };
    }
    return fill;
  }
  const reference = req.referencePriceUsd;
  if (usable(reference) && priceUsd < reference * ARENA_SELL_FLOOR_OF_MARK) {
    return { ok: false, reason: 'quote_far_below_reference', detail: `${(priceUsd / reference).toFixed(4)}x of reference`, fill };
  }
  return fill;
}

/** D4: after 3 failed sell quotes over >= 45 s, the exit fills at the DexScreener mark minus the sell haircut. */
export function markFallbackProceeds(tokens: number, markPriceUsd: number, costs: PaperCosts = DEFAULT_PAPER_COSTS): number {
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(markPriceUsd) || markPriceUsd <= 0) return 0;
  return tokens * markPriceUsd * (1 - costs.sell_haircut_pct / 100);
}

// ---------------------------------------------------------------- ClawPump calls

export interface QuoteDeps { fetchImpl?: ArenaFetch; env?: Record<string, string | undefined>; nowMs?: number }

async function postQuote(body: Record<string, unknown>, deps: QuoteDeps): Promise<{ ok: true; body: unknown } | { ok: false; reason: 'quote_failed' | 'not_configured'; detail: string }> {
  let backend: ReturnType<typeof clawpumpBackend>;
  try {
    backend = clawpumpBackend(deps.env);
  } catch (error) {
    return { ok: false, reason: 'not_configured', detail: error instanceof Error ? error.message : 'invalid_base_url' };
  }
  if (!backend.apiKey) return { ok: false, reason: 'not_configured', detail: 'clawpump_not_configured' };
  try {
    const response = await arenaFetchJson(new URL('/swap/quote', backend.origin), {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: Math.min(backend.timeoutMs, 20_000),
    }, deps.fetchImpl);
    return { ok: true, body: response };
  } catch (error) {
    return { ok: false, reason: 'quote_failed', detail: error instanceof Error ? error.message : 'error' };
  }
}

/** Buy-quote circuit breaker: 5 failed calls in a row pause buy quotes for 60 s (exits never consult it). */
const breaker = { failures: 0, openUntil: 0 };
const BREAKER_THRESHOLD = 5;
const BREAKER_OPEN_MS = 60_000;
/** Agents that want the same $20 of the same coin inside 10 s share one quote. */
const BUY_QUOTE_CACHE_MS = 10_000;
const buyQuoteCache = new Map<string, { at: number; result: Awaited<ReturnType<typeof postQuote>> }>();

export function clawpumpQuoteBreakerState(nowMs = Date.now()): { open: boolean; failures: number; openUntil: number } {
  return { open: nowMs < breaker.openUntil, failures: breaker.failures, openUntil: breaker.openUntil };
}

export async function quoteBuy(mint: string, usd: number, dsPriceUsd: number | null, deps: QuoteDeps = {}): Promise<BuyQuoteResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const amountRaw = usdToRawUsdc(usd);
  const key = `${mint}:${amountRaw}`;
  for (const [cacheKey, entry] of buyQuoteCache) {
    if (nowMs - entry.at > BUY_QUOTE_CACHE_MS) buyQuoteCache.delete(cacheKey);
  }
  let result = buyQuoteCache.get(key)?.result;
  if (!result) {
    if (nowMs < breaker.openUntil) return { ok: false, reason: 'quote_breaker' };
    result = await postQuote({ input_mint: USDC_MINT, output_mint: mint, amount: amountRaw, slippage_bps: ARENA_QUOTE_SLIPPAGE_BPS }, deps);
    if (result.ok) {
      breaker.failures = 0;
    } else if (result.reason === 'quote_failed') {
      breaker.failures += 1;
      if (breaker.failures >= BREAKER_THRESHOLD) breaker.openUntil = nowMs + BREAKER_OPEN_MS;
    }
    buyQuoteCache.set(key, { at: nowMs, result });
  }
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
  return evaluateBuyQuote(result.body, { mint, usd, amountRaw, slippageBps: ARENA_QUOTE_SLIPPAGE_BPS, dsPriceUsd });
}

export async function quoteSell(
  mint: string,
  tokens: number,
  decimals: number,
  prices: SellQuotePrices,
  deps: QuoteDeps = {},
): Promise<SellQuoteResult> {
  const amountRaw = tokensToRaw(tokens, decimals);
  if (!amountRaw) return { ok: false, reason: 'quote_output_bad', detail: 'amount rounds to zero' };
  const result = await postQuote({ input_mint: mint, output_mint: USDC_MINT, amount: amountRaw, slippage_bps: ARENA_QUOTE_SLIPPAGE_BPS }, deps);
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
  return evaluateSellQuote(result.body, { mint, tokens, amountRaw, ...prices });
}
