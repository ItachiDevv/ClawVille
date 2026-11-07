/**
 * Market and trust reads through ClawVille (MCP hub, 2026-11-07, migration 0098).
 *
 *   ClawPump: price, token search, top movers, anomalies, macro, on ClawVille's
 *   own key (`clawpump-client.ts`; only that client holds the key).
 *   SAID: the free trust check on a wallet.
 *
 * Order of one read: shared cache (free), the avatar's daily budget (one atomic
 * upsert), then the vendor. A failed vendor call keeps its budget unit: the
 * call was made.
 *
 * Vendor replies are untrusted (a token can be named as a prompt injection).
 * Only the fields below leave this file: numbers are finite or null, mints are
 * base58 of 32 bytes, labels are stripped and capped, and they stay under a key
 * named `vendorData`. `signal`, `source`, `meta` and vendor error text are never
 * read. These replies never enter a decide or chat prompt, and no hosted
 * [ACTION:] verb reaches them.
 */

import { db, ecosystemReadUsage, sql } from '@clawville/database';
import {
  ECOSYSTEM_MACRO_ASSETS,
  ECOSYSTEM_READS_PER_AVATAR_PER_DAY,
  ECOSYSTEM_READ_LIMIT_DEFAULT,
  ECOSYSTEM_READ_LIMIT_MAX,
  ECOSYSTEM_SEARCH_QUERY_MAX,
  type EcosystemMacroAsset,
  type EcosystemMacroRow,
  type EcosystemMarketOp,
  type EcosystemMarketReply,
  type EcosystemReadMeta,
  type EcosystemTokenMatch,
  type EcosystemTokenPrice,
  type EcosystemTokenSignal,
  type EcosystemTokenVendorData,
  type EcosystemTrustReply,
} from '@clawville/shared';
import { ClawPumpClientError, getClawPumpJson, resolveClawPumpConfig } from './clawpump-client';
import { isBase58Of, readJsonCapped } from './outbound-x402';

export const SAID_API_ORIGIN = 'https://api.saidprotocol.com';
const SAID_READ_TIMEOUT_MS = 10_000;
const SAID_READ_MAX_BYTES = 16 * 1024;

/** How long each kind of reply stays in the shared cache. */
export const ECOSYSTEM_READ_CACHE_TTL_MS = {
  price: 15_000,
  search: 60_000,
  top_movers: 30_000,
  anomalies: 30_000,
  macro: 30_000,
  trust: 60_000,
} as const;
/** The cache key holds caller text (a search query), so the cache has a size limit. */
export const ECOSYSTEM_READ_CACHE_MAX_ENTRIES = 1_000;
/** Rows ClawVille reads from one vendor list. */
const VENDOR_ROWS_MAX = 200;
const SYMBOL_MAX = 16;
const NAME_MAX = 48;

export interface EcosystemReadFailure {
  ok: false;
  code:
    | 'invalid_request'
    | 'read_budget_exhausted'
    | 'read_budget_unavailable'
    | 'vendor_not_configured'
    | 'token_not_found'
    | 'vendor_unreachable'
    | 'vendor_reply_unreadable';
  httpStatus: 400 | 404 | 429 | 502 | 503;
  message: string;
}

const FAILURES: { [K in EcosystemReadFailure['code']]: Omit<EcosystemReadFailure, 'ok' | 'code'> } = {
  invalid_request: { httpStatus: 400, message: 'Check the input and try again.' },
  read_budget_exhausted: {
    httpStatus: 429,
    message: `This avatar used its ${ECOSYSTEM_READS_PER_AVATAR_PER_DAY} market and trust reads for today. Try again after 00:00 UTC.`,
  },
  read_budget_unavailable: { httpStatus: 503, message: 'ClawVille could not check the read budget. Nothing was called. Try again later.' },
  vendor_not_configured: { httpStatus: 503, message: 'This read is not available on this server right now.' },
  token_not_found: { httpStatus: 404, message: 'The vendor does not know this token.' },
  vendor_unreachable: { httpStatus: 502, message: 'The vendor did not answer. Try again later.' },
  vendor_reply_unreadable: { httpStatus: 502, message: 'The vendor sent a reply ClawVille cannot read. Try again later.' },
};

function fail(code: EcosystemReadFailure['code'], message?: string): EcosystemReadFailure {
  return { ok: false, code, ...FAILURES[code], ...(message ? { message } : {}) };
}

/** Thrown inside a vendor fetch; turned into a failure result at the top. */
class ReadFailure extends Error {
  constructor(readonly code: EcosystemReadFailure['code']) {
    super(code);
  }
}

// ---------------------------------------------------------------------------
// Untrusted fields
// ---------------------------------------------------------------------------

/** Control, format and line-separator characters, and the brackets prompts and actions use. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}[\]<>{}`]/gu;
/** A plain decimal number. Nothing else is read from a string. */
const NUMERIC_TEXT = /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i;

/** A vendor label as plain text, or null. */
export function cleanVendorText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(UNSAFE_TEXT, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, maxLength).join('').trim() || null;
}

/** A finite number, or null. */
export function finiteOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.length <= 40 && NUMERIC_TEXT.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isoTimeOrNull(unixSeconds: unknown, text: unknown): string | null {
  const seconds = finiteOrNull(unixSeconds);
  const ms = seconds !== null ? seconds * 1000 : typeof text === 'string' && text.length <= 40 ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}

function vendorLabels(row: Record<string, unknown>): EcosystemTokenVendorData {
  return { symbol: cleanVendorText(row.symbol, SYMBOL_MAX), name: cleanVendorText(row.name, NAME_MAX) };
}

function vendorRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new ReadFailure('vendor_reply_unreadable');
  return value.slice(0, VENDOR_ROWS_MAX).map(asRecord).filter((row): row is Record<string, unknown> => row !== null);
}

export function parsePriceReply(body: unknown, mint: string): EcosystemTokenPrice {
  const row = asRecord(body);
  // The vendor must answer for the token that was asked. We echo our own mint.
  if (!row || row.mint !== mint) throw new ReadFailure('vendor_reply_unreadable');
  const currency = typeof row.currency === 'string' ? row.currency.toUpperCase() : '';
  const isUsd = currency === 'USD' || currency === 'USDC';
  return {
    mint,
    priceUsd: isUsd ? finiteOrNull(row.price) : null,
    change24h: finiteOrNull(row.change24h),
    volume24hUsd: isUsd ? finiteOrNull(row.volume24h) : null,
    marketCapUsd: isUsd ? finiteOrNull(row.marketCap) : null,
    liquidityUsd: isUsd ? finiteOrNull(row.liquidity) : null,
    updatedAt: isoTimeOrNull(row.updateUnixTime, row.updatedAt),
    vendorData: vendorLabels(row),
  };
}

export function parseSearchReply(body: unknown): EcosystemTokenMatch[] {
  const rows = vendorRows(asRecord(body)?.tokens);
  const out: EcosystemTokenMatch[] = [];
  for (const row of rows) {
    if (!isBase58Of(row.mint, 32)) continue;
    const decimals = finiteOrNull(row.decimals);
    const confidence = row.confidence;
    out.push({
      mint: row.mint,
      decimals: decimals !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null,
      verified: booleanOrNull(row.verified),
      confidence: confidence === 'high' || confidence === 'medium' || confidence === 'low' ? confidence : finiteOrNull(confidence),
      vendorData: vendorLabels(row),
    });
  }
  return out;
}

/** Top movers (`signals`) and anomalies (`gems`) use the same row. `signal` is never read. */
export function parseSignalReply(body: unknown, key: 'signals' | 'gems'): EcosystemTokenSignal[] {
  const rows = vendorRows(asRecord(body)?.[key]);
  const out: EcosystemTokenSignal[] = [];
  for (const row of rows) {
    // A row on another chain has no 32-byte base58 contract, so it drops here.
    if (!isBase58Of(row.contract, 32)) continue;
    out.push({
      mint: row.contract,
      priceUsd: finiteOrNull(row.price_usd),
      change24h: finiteOrNull(row.change_24h),
      marketCapUsd: finiteOrNull(row.market_cap_usd),
      vendorData: vendorLabels(row),
    });
  }
  return out;
}

const MACRO_CONTAINER_KEYS = ['assets', 'prices', 'tokens', 'markets', 'data', 'macro', 'spot'];
const MACRO_PRICE_KEYS = ['price', 'priceUsd', 'price_usd', 'spot', 'usd'];
const MACRO_CHANGE_KEYS = ['change24h', 'change_24h', 'change24hPct', 'change_24h_pct', 'usd_24h_change'];

function firstFinite(row: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = finiteOrNull(row[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * The macro reply. ClawVille read only the plan's summary of it (BTC, ETH, SOL,
 * USDC, USDT spot and 24 h), not its exact keys, so this accepts a map or a list
 * of rows. It reads only the fixed assets and only numbers. A reply with no
 * readable asset is `vendor_reply_unreadable`, not an empty success.
 */
export function parseMacroReply(body: unknown): EcosystemMacroRow[] {
  const root = asRecord(body);
  if (!root && !Array.isArray(body)) throw new ReadFailure('vendor_reply_unreadable');
  const candidates: unknown[] = [body, ...(root ? MACRO_CONTAINER_KEYS.map((key) => root[key]) : [])];
  const found = new Map<EcosystemMacroAsset, EcosystemMacroRow>();
  const add = (symbol: unknown, row: Record<string, unknown> | null) => {
    if (typeof symbol !== 'string' || !row) return;
    const asset = ECOSYSTEM_MACRO_ASSETS.find((name) => name === symbol.toUpperCase());
    if (!asset || found.has(asset)) return;
    const priceUsd = firstFinite(row, MACRO_PRICE_KEYS);
    if (priceUsd !== null) found.set(asset, { symbol: asset, priceUsd, change24h: firstFinite(row, MACRO_CHANGE_KEYS) });
  };
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const row of candidate.slice(0, VENDOR_ROWS_MAX)) add(asRecord(row)?.symbol, asRecord(row));
    } else {
      const map = asRecord(candidate);
      if (map) for (const key of Object.keys(map).slice(0, VENDOR_ROWS_MAX)) add(key, asRecord(map[key]));
    }
  }
  if (found.size === 0) throw new ReadFailure('vendor_reply_unreadable');
  return ECOSYSTEM_MACRO_ASSETS.flatMap((asset) => {
    const row = found.get(asset);
    return row ? [row] : [];
  });
}

/** A SAID tier word: lower-case letters and underscores only (seen: `unranked`, `none`). */
function tierWord(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z_]{1,16}$/.test(value) ? value : null;
}

export function parseTrustReply(body: unknown, wallet: string): Omit<EcosystemTrustReply, keyof EcosystemReadMeta> {
  const row = asRecord(body);
  // The vendor must answer for the wallet that was asked. We echo our own wallet.
  if (!row || row.wallet !== wallet) throw new ReadFailure('vendor_reply_unreadable');
  return {
    vendor: 'said',
    wallet,
    registered: booleanOrNull(row.registered),
    verified: booleanOrNull(row.verified),
    scored: booleanOrNull(row.scored),
    compositeScore: finiteOrNull(row.compositeScore),
    vendorData: { tier: tierWord(row.tier), trustTier: tierWord(row.trustTier) },
  };
}

// ---------------------------------------------------------------------------
// Budget and shared cache
// ---------------------------------------------------------------------------

/**
 * One atomic statement checks the budget and counts the call. It returns the
 * new count, or null when the day's budget is used. The day is the database's
 * UTC day, the same rule as the spend ledger.
 */
export async function consumeReadBudget(avatarId: string, limit = ECOSYSTEM_READS_PER_AVATAR_PER_DAY): Promise<number | null> {
  const [row] = await db
    .insert(ecosystemReadUsage)
    .values({ avatarId, day: sql`(now() AT TIME ZONE 'UTC')::date`, calls: 1 })
    .onConflictDoUpdate({
      target: [ecosystemReadUsage.avatarId, ecosystemReadUsage.day],
      set: { calls: sql`${ecosystemReadUsage.calls} + 1`, updatedAt: sql`now()` },
      where: sql`${ecosystemReadUsage.calls} < ${limit}`,
    })
    .returning({ calls: ecosystemReadUsage.calls });
  return row?.calls ?? null;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();

/** Test hook. */
export function resetEcosystemReadCache(): void {
  cache.clear();
  inFlight.clear();
}

export interface EcosystemReadDeps {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  consumeBudget: (avatarId: string) => Promise<number | null>;
  now: () => number;
}

function resolveDeps(overrides?: Partial<EcosystemReadDeps>): EcosystemReadDeps {
  return {
    env: process.env,
    fetchImpl: ((input, init) => fetch(input, init)) as typeof fetch,
    consumeBudget: (avatarId) => consumeReadBudget(avatarId),
    now: Date.now,
    ...overrides,
  };
}

type CachedRead<T> = { ok: true; value: T; meta: EcosystemReadMeta } | EcosystemReadFailure;

/**
 * Cache hit and a join on the same running call: free. Otherwise one budget
 * unit, then the vendor. Only a parsed success is cached.
 */
async function readThroughCache<T>(
  avatarId: string,
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  deps: EcosystemReadDeps,
): Promise<CachedRead<T>> {
  const free: EcosystemReadMeta = { cached: true, readsUsedToday: null, readsPerDay: ECOSYSTEM_READS_PER_AVATAR_PER_DAY };
  try {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > deps.now()) return { ok: true, value: hit.value as T, meta: free };
    if (hit) cache.delete(key);
    const running = inFlight.get(key);
    if (running) return { ok: true, value: (await running) as T, meta: free };

    let used: number | null;
    try {
      used = await deps.consumeBudget(avatarId);
    } catch {
      return fail('read_budget_unavailable');
    }
    if (used === null) return fail('read_budget_exhausted');

    let call = inFlight.get(key) as Promise<T> | undefined;
    if (!call) {
      call = fetcher()
        .then((value) => {
          if (cache.size >= ECOSYSTEM_READ_CACHE_MAX_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          cache.set(key, { value, expiresAt: deps.now() + ttlMs });
          return value;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, call);
    }
    return {
      ok: true,
      value: await call,
      meta: { cached: false, readsUsedToday: used, readsPerDay: ECOSYSTEM_READS_PER_AVATAR_PER_DAY },
    };
  } catch (error) {
    if (error instanceof ReadFailure) return fail(error.code);
    if (error instanceof ClawPumpClientError) {
      if (error.code === 'not_found') return fail('token_not_found');
      if (error.code === 'not_configured' || error.code === 'invalid_base_url') return fail('vendor_not_configured');
      if (error.code === 'schema_invalid' || error.code === 'response_too_large') return fail('vendor_reply_unreadable');
    }
    return fail('vendor_unreachable');
  }
}

// ---------------------------------------------------------------------------
// Market reads (ClawPump)
// ---------------------------------------------------------------------------

export interface EcosystemMarketInput {
  op: EcosystemMarketOp;
  mint?: string;
  query?: string;
  limit?: string | number;
}

function parseLimit(value: string | number | undefined): number | null {
  if (value === undefined || value === '') return ECOSYSTEM_READ_LIMIT_DEFAULT;
  const parsed = typeof value === 'number' ? value : /^\d{1,3}$/.test(value) ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= ECOSYSTEM_READ_LIMIT_MAX ? parsed : null;
}

export type EcosystemMarketResult = { ok: true; reply: EcosystemMarketReply } | EcosystemReadFailure;

/**
 * List reads always ask the vendor for the same full list and cut it per caller,
 * so one cache entry serves every `limit`.
 */
export async function readEcosystemMarket(
  avatarId: string,
  input: EcosystemMarketInput,
  overrides?: Partial<EcosystemReadDeps>,
): Promise<EcosystemMarketResult> {
  const deps = resolveDeps(overrides);
  const limit = parseLimit(input.limit);
  if (limit === null) return fail('invalid_request', `limit must be a whole number from 1 to ${ECOSYSTEM_READ_LIMIT_MAX}.`);

  const mint = input.op === 'price' ? input.mint?.trim() ?? '' : '';
  if (input.op === 'price' && !isBase58Of(mint, 32)) return fail('invalid_request', 'mint must be a Solana token address.');
  const query = input.op === 'search' ? (input.query ?? '').replace(/\s+/g, ' ').trim() : '';
  if (input.op === 'search' && (!query || query.length > ECOSYSTEM_SEARCH_QUERY_MAX || /\p{Cc}/u.test(query))) {
    return fail('invalid_request', `query must be 1 to ${ECOSYSTEM_SEARCH_QUERY_MAX} characters.`);
  }

  // Do not charge a budget unit for a call that cannot start.
  try {
    resolveClawPumpConfig(deps.env);
  } catch {
    return fail('vendor_not_configured');
  }

  const options = { env: deps.env, fetchImpl: deps.fetchImpl };
  const read = <T>(key: string, ttlMs: number, fetcher: () => Promise<T>) => readThroughCache(avatarId, key, ttlMs, fetcher, deps);
  const base = { vendor: 'clawpump' as const };

  switch (input.op) {
    case 'price': {
      const result = await read(`price:${mint}`, ECOSYSTEM_READ_CACHE_TTL_MS.price, async () =>
        parsePriceReply(await getClawPumpJson(`/price?${new URLSearchParams({ mint })}`, options), mint));
      return result.ok ? { ok: true, reply: { ...base, ...result.meta, op: 'price', token: result.value } } : result;
    }
    case 'search': {
      const params = new URLSearchParams({ query, limit: String(ECOSYSTEM_READ_LIMIT_MAX) });
      const result = await read(`search:${query}`, ECOSYSTEM_READ_CACHE_TTL_MS.search, async () =>
        parseSearchReply(await getClawPumpJson(`/tokens/search?${params}`, options)));
      return result.ok ? { ok: true, reply: { ...base, ...result.meta, op: 'search', tokens: result.value.slice(0, limit) } } : result;
    }
    case 'top_movers': {
      const result = await read('top_movers', ECOSYSTEM_READ_CACHE_TTL_MS.top_movers, async () =>
        parseSignalReply(await getClawPumpJson(`/signals/top-movers?limit=${ECOSYSTEM_READ_LIMIT_MAX}`, options), 'signals'));
      return result.ok ? { ok: true, reply: { ...base, ...result.meta, op: 'top_movers', tokens: result.value.slice(0, limit) } } : result;
    }
    case 'anomalies': {
      const result = await read('anomalies', ECOSYSTEM_READ_CACHE_TTL_MS.anomalies, async () =>
        parseSignalReply(await getClawPumpJson(`/signals/anomalies?limit=${ECOSYSTEM_READ_LIMIT_MAX}`, options), 'gems'));
      return result.ok ? { ok: true, reply: { ...base, ...result.meta, op: 'anomalies', tokens: result.value.slice(0, limit) } } : result;
    }
    case 'macro': {
      const result = await read('macro', ECOSYSTEM_READ_CACHE_TTL_MS.macro, async () =>
        parseMacroReply(await getClawPumpJson('/signals/macro', options)));
      return result.ok ? { ok: true, reply: { ...base, ...result.meta, op: 'macro', assets: result.value } } : result;
    }
  }
}

// ---------------------------------------------------------------------------
// Trust read (SAID, free)
// ---------------------------------------------------------------------------

export type EcosystemTrustResult = { ok: true; reply: EcosystemTrustReply } | EcosystemReadFailure;

async function fetchSaidTrust(wallet: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${SAID_API_ORIGIN}/api/trust/${wallet}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(SAID_READ_TIMEOUT_MS),
    });
  } catch {
    throw new ReadFailure('vendor_unreachable');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ReadFailure('vendor_unreachable');
  }
  let body: unknown;
  try {
    body = await readJsonCapped(response, SAID_READ_MAX_BYTES);
  } catch {
    throw new ReadFailure('vendor_unreachable');
  }
  if (body === null) throw new ReadFailure('vendor_reply_unreadable');
  return body;
}

export async function readEcosystemTrust(
  avatarId: string,
  rawWallet: string,
  overrides?: Partial<EcosystemReadDeps>,
): Promise<EcosystemTrustResult> {
  const deps = resolveDeps(overrides);
  const wallet = rawWallet.trim();
  if (!isBase58Of(wallet, 32)) return fail('invalid_request', 'wallet must be a Solana wallet address.');
  const result = await readThroughCache(avatarId, `trust:${wallet}`, ECOSYSTEM_READ_CACHE_TTL_MS.trust, async () =>
    parseTrustReply(await fetchSaidTrust(wallet, deps.fetchImpl), wallet), deps);
  return result.ok ? { ok: true, reply: { ...result.value, ...result.meta } } : result;
}
