import { db, sql } from '@clawville/database';
import { FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES } from '@clawville/shared';
import type { FloorArenaSnapshot } from './filters';
import { finiteOrNull } from './filters';
import { CHAIN_UNIVERSE } from './chain-checks';
import {
  ArenaHttpError, arenaFetchJson, clawpumpBackend, dexscreenerBudgetLeft, noteDexscreenerCall,
  noteDexscreenerRateLimited, rememberSolPrice, USDC_MINT, WSOL_MINT, type ArenaFetch,
} from './pricing';

/**
 * Shared discovery for the Trading Floor Arena (docs/trading-floor-arena.md D2): ONE poller per free source,
 * each called once per interval, every agent reads the same `floor_discovery_mints` table. A failing source
 * never blocks the others (index.ts gives each its own timer and jittered backoff).
 * Enrichment: DexScreener `/tokens/v1/solana/<30 mints>` snapshots for every live mint, every open-position
 * mint and every private (add-on) mint, inside a DexScreener budget of 114 calls/min (limit 300).
 */

const DS = 'https://api.dexscreener.com';
const GECKO = 'https://api.geckoterminal.com';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS: ReadonlySet<string> = new Set([USDC_MINT, WSOL_MINT, USDT_MINT]);
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const DISCOVERY_FIRST_TTL_MS = 24 * 3_600_000;
export const DISCOVERY_SEEN_TTL_MS = 6 * 3_600_000;
const ENRICH_BATCH = 30;
/** At most 36 enrichment calls per 20 s tick, and never the last 8 of the minute's budget (pollers 6/min + SOL 1/min). */
export const ENRICH_MAX_CALLS_PER_TICK = 36;
export const POLLER_RESERVE_PER_MIN = 8;
const SOL_PRICE_EVERY_MS = 60_000;

export type DiscoverySourceId =
  | 'ds:token-profiles' | 'ds:token-boosts-latest' | 'ds:token-boosts-top'
  | 'clawpump:signals' | 'clawpump:anomalies' | 'gecko:new-pools' | 'gecko:trending_5m';

export interface Sighting { mint: string; source: DiscoverySourceId; symbol: string | null; name: string | null }

export interface DiscoverySource {
  id: DiscoverySourceId;
  intervalMs: number;
  /** Counts against the DexScreener budget. */
  dexscreener: boolean;
  fetch(fetchImpl?: ArenaFetch): Promise<Sighting[]>;
}

export function isTradableMint(mint: unknown): mint is string {
  return typeof mint === 'string' && MINT_RE.test(mint) && !QUOTE_MINTS.has(mint);
}

export const VENDOR_SYMBOL_MAX = 16;
export const VENDOR_NAME_MAX = 48;
/** Control / format / private-use / unassigned chars (bidi overrides, zero-width joiners) and emoji. */
const VENDOR_STRIP = /[\p{C}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{FE0E}\u{FE0F}\u{20E3}]/gu;
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEX_ID_RE = /^[a-z0-9_-]{1,32}$/;
const LABEL_RE = /^[A-Za-z0-9_.-]{1,16}$/;

/**
 * Vendor symbols and names are the ONLY free text the arena stores from a vendor (Codex r2 #7): NFKC, strip
 * control / format / emoji characters, collapse spaces, cap by code points. Empty -> null.
 */
export function cleanVendorText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').replace(/\s+/gu, ' ').replace(VENDOR_STRIP, '').replace(/\s+/gu, ' ').trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, max).join('').trim() || null;
}

function address(value: unknown): string | null {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? value : null;
}

function dexIdOf(value: unknown): string | null {
  const id = typeof value === 'string' ? value.toLowerCase() : '';
  return DEX_ID_RE.test(id) ? id : null;
}

// ---------------------------------------------------------------- source parsers (pure)

export function parseDexscreenerList(body: unknown, source: DiscoverySourceId): Sighting[] {
  if (!Array.isArray(body)) throw new ArenaHttpError('schema_invalid');
  const out: Sighting[] = [];
  for (const row of body as Array<Record<string, unknown>>) {
    if (row?.chainId !== 'solana' || !isTradableMint(row.tokenAddress)) continue;
    out.push({ mint: row.tokenAddress, source, symbol: null, name: null });
  }
  return out;
}

export function parseClawpumpRows(body: unknown, key: 'signals' | 'gems', source: DiscoverySourceId): Sighting[] {
  const rows = (body as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(rows)) throw new ArenaHttpError('schema_invalid');
  const out: Sighting[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    if (row?.chain !== 'sol' || !isTradableMint(row.contract)) continue;
    out.push({ mint: row.contract, source, symbol: cleanVendorText(row.symbol, VENDOR_SYMBOL_MAX), name: cleanVendorText(row.name, VENDOR_NAME_MAX) });
  }
  return out;
}

/** GeckoTerminal pool lists (new_pools, trending_pools): same JSON:API shape. */
export function parseGeckoPools(body: unknown, source: 'gecko:new-pools' | 'gecko:trending_5m'): Sighting[] {
  const rows = (body as Record<string, unknown> | null)?.data;
  if (!Array.isArray(rows)) throw new ArenaHttpError('schema_invalid');
  const out: Sighting[] = [];
  const mintOf = (rel: unknown): string | null => {
    const id = (rel as { data?: { id?: unknown } } | null)?.data?.id;
    return typeof id === 'string' && id.startsWith('solana_') ? id.slice('solana_'.length) : null;
  };
  for (const row of rows as Array<Record<string, unknown>>) {
    const rel = (row?.relationships ?? {}) as Record<string, unknown>;
    const base = mintOf(rel.base_token);
    const quote = mintOf(rel.quote_token);
    const pick = isTradableMint(base) ? base : isTradableMint(quote) ? quote : null;
    if (!pick) continue;
    const pairName = (row.attributes as Record<string, unknown> | undefined)?.name;
    const symbol = pick === base && typeof pairName === 'string' ? cleanVendorText(pairName.split(' / ')[0], VENDOR_SYMBOL_MAX) : null;
    out.push({ mint: pick, source, symbol, name: null });
  }
  return out;
}

async function dexscreenerGet(path: string, fetchImpl?: ArenaFetch): Promise<unknown> {
  noteDexscreenerCall();
  try {
    return await arenaFetchJson(new URL(path, DS), {}, fetchImpl);
  } catch (error) {
    if (error instanceof ArenaHttpError && error.code === 'rate_limited') noteDexscreenerRateLimited();
    throw error;
  }
}

async function clawpumpGet(path: string, fetchImpl?: ArenaFetch): Promise<unknown> {
  const backend = clawpumpBackend();
  return arenaFetchJson(new URL(path, backend.origin), {
    headers: backend.apiKey ? { Authorization: `Bearer ${backend.apiKey}` } : {},
    timeoutMs: Math.min(backend.timeoutMs, 15_000),
  }, fetchImpl);
}

export const DISCOVERY_SOURCES: readonly DiscoverySource[] = [
  { id: 'ds:token-profiles', intervalMs: 30_000, dexscreener: true,
    fetch: async (f) => parseDexscreenerList(await dexscreenerGet('/token-profiles/latest/v1', f), 'ds:token-profiles') },
  { id: 'ds:token-boosts-latest', intervalMs: 30_000, dexscreener: true,
    fetch: async (f) => parseDexscreenerList(await dexscreenerGet('/token-boosts/latest/v1', f), 'ds:token-boosts-latest') },
  { id: 'ds:token-boosts-top', intervalMs: 30_000, dexscreener: true,
    fetch: async (f) => parseDexscreenerList(await dexscreenerGet('/token-boosts/top/v1', f), 'ds:token-boosts-top') },
  // The signals set turns over ~1 mint per 15 min (R2 research): never poll faster than 60 s.
  { id: 'clawpump:signals', intervalMs: 60_000, dexscreener: false,
    fetch: async (f) => parseClawpumpRows(await clawpumpGet('/intelligence/signals?chain=sol&limit=50', f), 'signals', 'clawpump:signals') },
  { id: 'clawpump:anomalies', intervalMs: 60_000, dexscreener: false,
    fetch: async (f) => parseClawpumpRows(await clawpumpGet('/signals/anomalies', f), 'gems', 'clawpump:anomalies') },
  // GeckoTerminal keyless limit is 30/min; the two gecko pollers use 2/min (lead cap: <= 20/min).
  { id: 'gecko:new-pools', intervalMs: 60_000, dexscreener: false,
    fetch: async (f) => parseGeckoPools(await arenaFetchJson(new URL('/api/v2/networks/solana/new_pools?page=1', GECKO), {}, f), 'gecko:new-pools') },
  { id: 'gecko:trending_5m', intervalMs: 60_000, dexscreener: false,
    fetch: async (f) => parseGeckoPools(await arenaFetchJson(new URL('/api/v2/networks/solana/trending_pools?duration=5m&page=1', GECKO), {}, f), 'gecko:trending_5m') },
];

// ---------------------------------------------------------------- upsert merge (pure + SQL mirror)

export interface MergedSighting { mint: string; firstSource: DiscoverySourceId; sources: DiscoverySourceId[]; symbol: string | null; name: string | null }

/** One row per mint; sources in order of appearance; the first sighting names first_source. */
export function mergeSightings(sightings: readonly Sighting[]): MergedSighting[] {
  const byMint = new Map<string, MergedSighting>();
  for (const s of sightings) {
    const prior = byMint.get(s.mint);
    if (!prior) {
      byMint.set(s.mint, { mint: s.mint, firstSource: s.source, sources: [s.source], symbol: s.symbol, name: s.name });
      continue;
    }
    if (!prior.sources.includes(s.source)) prior.sources.push(s.source);
    prior.symbol ??= s.symbol;
    prior.name ??= s.name;
  }
  return [...byMint.values()];
}

export interface DiscoveryRowState {
  mint: string; firstSeenAt: Date; firstSource: string; sources: string[]; lastSeenAt: Date;
  symbol: string | null; name: string | null; expiresAt: Date;
  /** D25: first sighting per source ({source: ISO}); a key, once set, never changes. */
  sourceFirstSeen: Record<string, string>;
}

/**
 * The upsert rule (mirrored by `upsertSightings` SQL): first_seen_at / first_source only on insert; sources is a
 * set in order of appearance; last_seen_at moves forward; symbol / name keep the first non-null;
 * expires_at = max(previous, first_seen + 24 h, last_seen + 6 h).
 * source_first_seen (D25), per sighted source: an existing key is never overwritten > a source the row already lists
 * WITHOUT a key (a row written before D25, or by the old code during a deploy flip) gets the row's first_seen_at,
 * never now (Codex r12: "now" would make a coin DexScreener saw hours ago look fresh to a tradeable clock) > a source
 * NEW to the row gets now. The reader (`tradeableFirstSeenMs`: missing key -> first_seen_at) agrees, so the window
 * can only close sooner, never open later.
 */
export function mergeDiscoveryRow(existing: DiscoveryRowState | null, sighting: MergedSighting, now: Date): DiscoveryRowState {
  if (!existing) {
    return {
      mint: sighting.mint, firstSeenAt: now, firstSource: sighting.firstSource, sources: [...sighting.sources],
      lastSeenAt: now, symbol: sighting.symbol, name: sighting.name, expiresAt: new Date(now.getTime() + DISCOVERY_FIRST_TTL_MS),
      sourceFirstSeen: Object.fromEntries(sighting.sources.map((source) => [source, now.toISOString()])),
    };
  }
  const sourceFirstSeen = { ...existing.sourceFirstSeen };
  for (const source of sighting.sources) {
    if (sourceFirstSeen[source] !== undefined) continue;
    sourceFirstSeen[source] = existing.sources.includes(source) ? existing.firstSeenAt.toISOString() : now.toISOString();
  }
  const sources = [...existing.sources];
  for (const s of sighting.sources) if (!sources.includes(s)) sources.push(s);
  const lastSeenAt = now.getTime() > existing.lastSeenAt.getTime() ? now : existing.lastSeenAt;
  const expiresMs = Math.max(
    existing.expiresAt.getTime(),
    existing.firstSeenAt.getTime() + DISCOVERY_FIRST_TTL_MS,
    lastSeenAt.getTime() + DISCOVERY_SEEN_TTL_MS,
  );
  return {
    ...existing, sources, lastSeenAt, symbol: existing.symbol ?? sighting.symbol, name: existing.name ?? sighting.name,
    expiresAt: new Date(expiresMs),
    sourceFirstSeen,
  };
}

export async function upsertSightings(merged: readonly MergedSighting[], now: Date = new Date()): Promise<number> {
  if (merged.length === 0) return 0;
  const at = now.toISOString();
  const payload = JSON.stringify(merged.map((m) => ({
    mint: m.mint, first_source: m.firstSource, sources: m.sources, symbol: m.symbol, name: m.name,
    source_first_seen: Object.fromEntries(m.sources.map((source) => [source, at])),
  })));
  await db.execute(sql`
    INSERT INTO floor_discovery_mints (mint, first_seen_at, first_source, sources, last_seen_at, symbol, name, expires_at, source_first_seen)
    SELECT r.mint, ${at}::timestamptz, r.first_source, ARRAY(SELECT jsonb_array_elements_text(r.sources)),
           ${at}::timestamptz, r.symbol, r.name, ${at}::timestamptz + interval '24 hours', r.source_first_seen
    FROM jsonb_to_recordset(${payload}::jsonb) AS r(mint text, first_source text, sources jsonb, symbol text, name text, source_first_seen jsonb)
    ON CONFLICT (mint) DO UPDATE SET
      -- D25 (mergeDiscoveryRow mirror; every SET expression reads the OLD row): a sighted source the row already
      -- lists gets the row's first_seen_at (same UTC ISO format as 0072 and toISOString), a new source gets now;
      -- jsonb || keeps the RIGHT side on a key clash, so an existing key is never overwritten.
      source_first_seen = COALESCE((
        SELECT jsonb_object_agg(e.key, CASE
          WHEN e.key = ANY(floor_discovery_mints.sources)
            THEN to_jsonb(to_char(floor_discovery_mints.first_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
          ELSE e.value END)
        FROM jsonb_each(EXCLUDED.source_first_seen) AS e(key, value)
      ), '{}'::jsonb) || floor_discovery_mints.source_first_seen,
      sources = ARRAY(
        SELECT s FROM unnest(floor_discovery_mints.sources || EXCLUDED.sources) WITH ORDINALITY AS t(s, i)
        GROUP BY s ORDER BY min(i)
      ),
      last_seen_at = GREATEST(floor_discovery_mints.last_seen_at, EXCLUDED.last_seen_at),
      symbol = COALESCE(floor_discovery_mints.symbol, EXCLUDED.symbol),
      name = COALESCE(floor_discovery_mints.name, EXCLUDED.name),
      expires_at = GREATEST(
        floor_discovery_mints.expires_at,
        floor_discovery_mints.first_seen_at + interval '24 hours',
        EXCLUDED.last_seen_at + interval '6 hours'
      )
  `);
  return merged.length;
}

/** One poll of one source: fetch, merge, upsert. Throws on a source failure (the caller backs off). */
export async function runDiscoveryPoll(source: DiscoverySource, now: Date = new Date(), fetchImpl?: ArenaFetch): Promise<{ seen: number; skipped: boolean }> {
  if (source.dexscreener && dexscreenerBudgetLeft(now.getTime()) <= 0) {
    return { seen: 0, skipped: true };
  }
  const merged = mergeSightings(await source.fetch(fetchImpl));
  await upsertSightings(merged, now);
  return { seen: merged.length, skipped: false };
}

// ---------------------------------------------------------------- DexScreener snapshots

type Pair = Record<string, unknown>;
const VERIFIABLE_DEX = new Set(['pumpswap', 'pumpfun', 'raydium', 'launchlab', 'meteoradbc']);

/** Pool types the LP-lock check can verify win over any other; then the deepest (runner `key_of`). */
export function pairRank(pair: Pair): [number, number] {
  const dex = String(pair.dexId ?? '');
  const labels = Array.isArray(pair.labels) ? pair.labels.map(String) : [];
  const verifiable = VERIFIABLE_DEX.has(dex) || (dex === 'meteora' && (labels.includes('DYN2') || labels.includes('DYN')));
  const liq = finiteOrNull(Number((pair.liquidity as Record<string, unknown> | undefined)?.usd)) ?? 0;
  return [verifiable ? 1 : 0, liq];
}

function rankGreater(a: [number, number], b: [number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
}

/** Best Solana pair per requested mint (the mint must be the BASE token). */
export function pickBestPairs(pairs: unknown, requested: ReadonlySet<string>): Map<string, Pair> {
  const out = new Map<string, Pair>();
  if (!Array.isArray(pairs)) return out;
  for (const pair of pairs as Pair[]) {
    if (!pair || pair.chainId !== 'solana') continue;
    const mint = (pair.baseToken as Record<string, unknown> | undefined)?.address;
    if (typeof mint !== 'string' || !requested.has(mint)) continue;
    const prior = out.get(mint);
    if (!prior || !rankGreater(pairRank(prior), pairRank(pair))) out.set(mint, pair);
  }
  return out;
}

function numField(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return finiteOrNull(typeof value === 'number' ? value : Number(value));
}

export function buildSnapshot(pair: Pair, nowMs: number): FloorArenaSnapshot {
  const liquidity = (pair.liquidity ?? {}) as Record<string, unknown>;
  const change = (pair.priceChange ?? {}) as Record<string, unknown>;
  const volume = (pair.volume ?? {}) as Record<string, unknown>;
  const tx = (((pair.txns ?? {}) as Record<string, unknown>).h1 ?? {}) as Record<string, unknown>;
  const base = (pair.baseToken ?? {}) as Record<string, unknown>;
  const quote = (pair.quoteToken ?? {}) as Record<string, unknown>;
  const mcapRaw = numField(pair.marketCap);
  const mcap = mcapRaw !== null && mcapRaw > 0 ? mcapRaw : numField(pair.fdv);
  const createdRaw = numField(pair.pairCreatedAt);
  const pairCreatedAt = createdRaw !== null && createdRaw > 0 ? createdRaw : null;
  const buys = numField(tx.buys);
  const sells = numField(tx.sells);
  const vol1h = numField(volume.h1);
  return {
    priceUsd: numField(pair.priceUsd),
    mcap,
    liqUsd: numField(liquidity.usd),
    liqBase: numField(liquidity.base),
    liqQuote: numField(liquidity.quote),
    pairAddress: address(pair.pairAddress),
    dexId: dexIdOf(pair.dexId),
    quoteMint: address(quote.address),
    labels: Array.isArray(pair.labels) ? pair.labels.filter((l): l is string => typeof l === 'string' && LABEL_RE.test(l)).slice(0, 8) : [],
    pairCreatedAt,
    ageS: pairCreatedAt === null ? null : Math.max(0, Math.round((nowMs - pairCreatedAt) / 1000)),
    chg5m: numField(change.m5),
    chg1h: numField(change.h1),
    chg6h: numField(change.h6),
    chg24h: numField(change.h24),
    txns1h: buys === null || sells === null ? null : buys + sells,
    vol1h,
    volOverMcap: vol1h !== null && mcap !== null && mcap > 0 ? vol1h / mcap : null,
    symbol: cleanVendorText(base.symbol, VENDOR_SYMBOL_MAX),
    name: cleanVendorText(base.name, VENDOR_NAME_MAX),
  };
}

/** Last enrichment attempt per mint in this process (a mint DexScreener does not know must not starve the rest). */
const lastAttempt = new Map<string, number>();
let lastSolPriceAt = 0;

export function resetDiscoveryStateForTest(): void {
  lastAttempt.clear();
  lastSolPriceAt = 0;
}

export interface EnrichCandidate { mint: string; tier: number; firstSeenMs: number; lastMs: number }

/**
 * Enrichment order: 0 open positions, 1 private mints, 2 never priced (newest first), 3 coins in the chain
 * universe or first seen < 2 h ago, 4 the rest; inside a tier the least recently priced first. Tiers 2 and 3 are
 * for TRADEABLE shared coins only (D28, see enrichTier).
 */
/**
 * Tier of a shared discovery row (D28). A GeckoTerminal-only coin (no ds:/clawpump: source) is never bought (D25), so
 * it always gets the last tier and is priced only with leftover budget: on staging 95 % of the in-universe rows were
 * GeckoTerminal-only and crowded the tradeable coins out of tiers 2 and 3.
 */
export function enrichTier(row: { lastMs: number; tradeable: boolean; inUniverse: boolean; firstSeenMs: number }, nowMs: number): number {
  if (!row.tradeable) return 4;
  if (row.lastMs === 0) return 2;
  return row.inUniverse || nowMs - row.firstSeenMs < 2 * 3_600_000 ? 3 : 4;
}

export function orderEnrichment(candidates: readonly EnrichCandidate[], slots: number): string[] {
  const seen = new Set<string>();
  const sorted = [...candidates].sort((a, b) => a.tier - b.tier
    || (a.tier === 2 ? b.firstSeenMs - a.firstSeenMs : a.lastMs - b.lastMs)
    || b.firstSeenMs - a.firstSeenMs
    || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
  const out: string[] = [];
  for (const c of sorted) {
    if (seen.has(c.mint)) continue;
    seen.add(c.mint);
    out.push(c.mint);
    if (out.length >= slots) break;
  }
  return out;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result as Array<Record<string, unknown>> : ((result as { rows?: Array<Record<string, unknown>> })?.rows ?? []);
}

function msOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

async function refreshSolPrice(nowMs: number, fetchImpl?: ArenaFetch): Promise<void> {
  if (nowMs - lastSolPriceAt < SOL_PRICE_EVERY_MS || dexscreenerBudgetLeft(nowMs) <= 0) return;
  lastSolPriceAt = nowMs;
  const pairs = await dexscreenerGet(`/tokens/v1/solana/${WSOL_MINT}`, fetchImpl);
  if (!Array.isArray(pairs)) return;
  let best: { price: number; liq: number } | null = null;
  for (const pair of pairs as Pair[]) {
    const base = (pair.baseToken as Record<string, unknown> | undefined)?.address;
    const quote = (pair.quoteToken as Record<string, unknown> | undefined)?.address;
    const price = numField(pair.priceUsd);
    const liq = numField((pair.liquidity as Record<string, unknown> | undefined)?.usd) ?? 0;
    if (pair.chainId === 'solana' && base === WSOL_MINT && quote === USDC_MINT && price !== null && price > 0 && (!best || liq > best.liq)) {
      best = { price, liq };
    }
  }
  if (best) rememberSolPrice(best.price, nowMs);
}

export interface EnrichTickResult { requested: number; priced: number; calls: number; rateLimited: boolean }

export async function runEnrichmentTick(now: Date = new Date(), fetchImpl?: ArenaFetch): Promise<EnrichTickResult> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  try {
    await refreshSolPrice(nowMs, fetchImpl);
  } catch {
    // The pool reserve check fails closed without a SOL price; the next minute retries.
  }
  const open = rowsOf(await db.execute(sql`SELECT DISTINCT mint FROM floor_arena_positions WHERE status = 'open'`));
  const privateRows = rowsOf(await db.execute(sql`
    SELECT mint, min(first_seen_at) AS first_seen_at, max(snapshot_at) AS snapshot_at
    FROM floor_arena_private_mints GROUP BY mint
  `));
  const tradeablePrefixes = JSON.stringify(FLOOR_ARENA_TRADEABLE_SOURCE_PREFIXES);
  const shared = rowsOf(await db.execute(sql`
    SELECT mint, first_seen_at, snapshot_at,
      COALESCE((snapshot->>'priceUsd')::double precision > 0
        AND (snapshot->>'mcap')::double precision BETWEEN ${CHAIN_UNIVERSE.mcapMin} AND ${CHAIN_UNIVERSE.mcapMax}, false) AS in_universe,
      EXISTS (
        SELECT 1 FROM unnest(sources) AS src(s), jsonb_array_elements_text(${tradeablePrefixes}::jsonb) AS p(prefix)
        WHERE starts_with(src.s, p.prefix)
      ) AS tradeable
    FROM floor_discovery_mints WHERE expires_at > ${nowIso}::timestamptz
  `));
  const candidates: EnrichCandidate[] = [];
  const last = (mint: string, snapshotAt: unknown) => Math.max(lastAttempt.get(mint) ?? 0, msOf(snapshotAt) ?? 0);
  for (const row of open) candidates.push({ mint: String(row.mint), tier: 0, firstSeenMs: 0, lastMs: last(String(row.mint), null) });
  for (const row of privateRows) {
    const mint = String(row.mint);
    candidates.push({ mint, tier: 1, firstSeenMs: msOf(row.first_seen_at) ?? 0, lastMs: last(mint, row.snapshot_at) });
  }
  for (const row of shared) {
    const mint = String(row.mint);
    const firstSeenMs = msOf(row.first_seen_at) ?? 0;
    const lastMs = last(mint, row.snapshot_at);
    const inUniverse = row.in_universe === true || row.in_universe === 't';
    const tradeable = row.tradeable === true || row.tradeable === 't';
    candidates.push({ mint, tier: enrichTier({ lastMs, tradeable, inUniverse, firstSeenMs }, nowMs), firstSeenMs, lastMs });
  }
  const live = new Set(candidates.map((c) => c.mint));
  for (const mint of lastAttempt.keys()) if (!live.has(mint)) lastAttempt.delete(mint);

  const calls = Math.max(0, Math.min(ENRICH_MAX_CALLS_PER_TICK, dexscreenerBudgetLeft(nowMs) - POLLER_RESERVE_PER_MIN));
  const ordered = orderEnrichment(candidates.filter((c) => isTradableMint(c.mint)), calls * ENRICH_BATCH);
  const snapshots: Array<{ mint: string; snapshot: FloorArenaSnapshot; symbol: string | null; name: string | null }> = [];
  let made = 0;
  let rateLimited = false;
  for (let i = 0; i < ordered.length; i += ENRICH_BATCH) {
    const batch = ordered.slice(i, i + ENRICH_BATCH);
    if (dexscreenerBudgetLeft(Date.now()) <= POLLER_RESERVE_PER_MIN) break;
    for (const mint of batch) lastAttempt.set(mint, nowMs);
    made += 1;
    let body: unknown;
    try {
      body = await dexscreenerGet(`/tokens/v1/solana/${batch.join(',')}`, fetchImpl);
    } catch (error) {
      if (error instanceof ArenaHttpError && error.code === 'rate_limited') { rateLimited = true; break; }
      continue;
    }
    const best = pickBestPairs(body, new Set(batch));
    for (const [mint, pair] of best) {
      const snapshot = buildSnapshot(pair, nowMs);
      snapshots.push({ mint, snapshot, symbol: snapshot.symbol, name: snapshot.name });
    }
  }
  await storeSnapshots(snapshots, now);
  return { requested: ordered.length, priced: snapshots.length, calls: made, rateLimited };
}

export async function storeSnapshots(
  rows: ReadonlyArray<{ mint: string; snapshot: FloorArenaSnapshot; symbol: string | null; name: string | null }>,
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  const at = now.toISOString();
  for (let offset = 0; offset < rows.length; offset += 500) {
    const payload = JSON.stringify(rows.slice(offset, offset + 500));
    await db.execute(sql`
      UPDATE floor_discovery_mints AS d
      SET snapshot = r.snapshot, snapshot_at = ${at}::timestamptz,
          symbol = COALESCE(d.symbol, r.symbol), name = COALESCE(d.name, r.name)
      FROM jsonb_to_recordset(${payload}::jsonb) AS r(mint text, snapshot jsonb, symbol text, name text)
      WHERE d.mint = r.mint
    `);
    await db.execute(sql`
      UPDATE floor_arena_private_mints AS p
      SET snapshot = r.snapshot, snapshot_at = ${at}::timestamptz, symbol = COALESCE(p.symbol, r.symbol)
      FROM jsonb_to_recordset(${payload}::jsonb) AS r(mint text, snapshot jsonb, symbol text, name text)
      WHERE p.mint = r.mint
    `);
  }
}

/** Removes expired shared rows and stale private rows, never one that backs an open position. */
export async function runDiscoveryExpiryTick(now: Date = new Date()): Promise<{ shared: number; private: number }> {
  const at = now.toISOString();
  const shared = rowsOf(await db.execute(sql`
    DELETE FROM floor_discovery_mints AS d
    WHERE d.expires_at < ${at}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM floor_arena_positions p WHERE p.mint = d.mint AND p.status = 'open')
    RETURNING d.mint
  `));
  const priv = rowsOf(await db.execute(sql`
    DELETE FROM floor_arena_private_mints AS m
    WHERE GREATEST(m.first_seen_at + interval '24 hours', COALESCE(m.last_seen_at, m.first_seen_at) + interval '6 hours') < ${at}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM floor_arena_positions p WHERE p.mint = m.mint AND p.agent_id = m.agent_id AND p.status = 'open'
      )
    RETURNING m.mint
  `));
  return { shared: shared.length, private: priv.length };
}
