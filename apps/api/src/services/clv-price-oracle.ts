/**
 * CLV PRICE ORACLE (Tokenomics T0, 2026-07-07) — READ-ONLY on-chain price feed.
 *
 * Polls the USD price of the ClawVille token (CLV, Token-2022, 6 decimals,
 * ~$0.00007 today on a thin ~$22k LP) roughly every 60s and exposes a
 * house-favorable quote for downstream pricing. This service NEVER touches
 * `avatars.clawTokens` or the ClawToken ledger — every value here is a USD
 * DECIMAL, never a ClawToken amount.
 *
 * DATA SOURCES (mirroring the existing repo patterns):
 *   1. Helius (primary when configured) — DAS `getAsset` RPC →
 *      `result.token_info.price_info.price_per_token`. Uses ONLY the
 *      `HELIUS_API_KEY` environment variable; when it is unset, or when a thin
 *      token returns no `price_info`, Helius is skipped/treated as failed and
 *      the poll falls through to DexScreener.
 *   2. DexScreener (fallback, KEYLESS — the dependable path) — mirrors
 *      `apps/web/src/app/dash/tabs/token-economy.tsx`: `GET .../dex/tokens/<mint>`
 *      → highest-liquidity `pairs[].priceUsd`.
 *
 * FLOW: every poll fetches spot (Helius → DexScreener). On success it writes one
 * `clv_price_snapshots` row (durable history) and refreshes an in-memory cache
 * (latest spot + a rolling 30-min sample window for the TWAP). On boot it seeds
 * the window from the last ~30 min of rows so a restart doesn't lose the TWAP.
 * A fetch or DB failure is caught + logged and NEVER crashes boot — the feed
 * degrades to last-known.
 *
 * QUOTE — `getClvPrice()` (sync, off the cache):
 *   - `spotUsd`     = latest snapshot price.
 *   - `twap30mUsd`  = simple mean of snapshots in the last 30 min (= spot if 1).
 *   - `quoteUsd`    = min(spot, twap30m) — HOUSE-FAVORABLE (anti-wick on the thin
 *                     LP). null when the quote is refused/unavailable.
 *   - `stale`       = true when serving a cached value because the latest poll
 *                     failed (still within the max-stale grace window).
 *   - `available`   = false (and `quoteUsd` null) when there is no data yet OR
 *                     the latest snapshot is older than the max-stale window
 *                     (`CLV_ORACLE_MAX_STALE_MS`, default 10 min) — a >10-min
 *                     price is NEVER served as a usable quote.
 *
 * LP DEPTH (Tokenomics C3, 2026-07-07) — `poolLiquidityUsd`:
 *   The highest-liquidity DexScreener pair's `liquidity.usd` (BOTH sides of the
 *   pool, USD). Previously fetched into a local `bestLiq` and DISCARDED; now
 *   surfaced through the cache for dry-run/advisory planning. DexScreener is
 *   the oracle's LAST-RESORT depth observation (Helius DAS carries no pool
 *   liquidity), but it is NOT a live-execution dependency: `clv-swap-live.ts`
 *   caps the first candidate at $25 and gates the exact Jupiter quote's own
 *   `priceImpactPct`, shrinking/re-quoting before any signing. No heterogeneous
 *   Jupiter route is extrapolated into constant-product depth. `fetchSpot`
 *   still runs both price feeds in parallel: PRICE preference is configured
 *   Helius primary → keyless DexScreener fallback; Dex depth refreshes when it
 *   responds. Depth is memory-only (NOT persisted to `clv_price_snapshots` —
 *   no schema change), so it re-warms within one poll (~60s) of boot; it goes
 *   `null` when the reading is missing or older than the same max-stale window
 *   as the price (a stale depth must never size a clip plan).
 */

import { db, clvPriceSnapshots } from '@clawville/database';
import { asc, desc, gte } from 'drizzle-orm';

/** CLV token mint (Token-2022). Same constant as the /dash token-economy tab. */
export const CLV_MINT = 'Epht7Fw4Sgh6fdcJj6afWXuNcAUmLLMc3MSthUqELiZA';

const DEFAULT_POLL_MS = 60_000;
const MIN_POLL_MS = 15_000;
const DEFAULT_MAX_STALE_MS = 600_000; // 10 min
/** Rolling window the TWAP averages over. */
const TWAP_WINDOW_MS = 30 * 60 * 1000; // 30 min
/** Per-request outbound fetch timeout so a hung upstream can't stall the poll. */
const FETCH_TIMEOUT_MS = 10_000;
/** Cap the boot-seed + history reads so a huge table can't blow up memory. */
const MAX_HISTORY = 500;

type ClvStoredSource = 'helius' | 'dexscreener';
export type ClvQuoteSource = ClvStoredSource | 'last_known';

export interface ClvPriceQuote {
  /** Latest spot price in USD (last successful snapshot). null when no data. */
  spotUsd: number | null;
  /** Simple mean of the last-30-min snapshots (= spot when a single sample). */
  twap30mUsd: number | null;
  /** min(spot, twap) — house-favorable. null when refused/unavailable. */
  quoteUsd: number | null;
  /** ISO time of the latest snapshot backing this quote. null when no data. */
  asOf: string | null;
  /** Feed backing the quote; 'last_known' when serving a stale cache. */
  source: ClvQuoteSource | null;
  /** true = serving a cached value because the latest live poll failed. */
  stale: boolean;
  /** false = no data yet OR latest snapshot > max-stale (quoteUsd is null). */
  available: boolean;
  /**
   * LP depth (Tokenomics C3): the highest-liquidity DexScreener pair's
   * `liquidity.usd` — BOTH sides of the pool, in USD. null when never fetched
   * OR when the last reading is older than the max-stale window (a stale depth
   * must never size a swap clip plan). Memory-only; not persisted.
   */
  poolLiquidityUsd: number | null;
  /** ISO time of the liquidity reading backing `poolLiquidityUsd`. */
  liquidityAsOf: string | null;
}

interface SpotResult {
  priceNum: number;
  /** Full-precision decimal string for storage in numeric(20,12). */
  priceStr: string;
  source: ClvStoredSource;
  /** DexScreener pool depth (USD, both sides) when it responded; else null. */
  liquidityUsd: number | null;
}

// ── In-memory cache (the poller keeps it fresh; getClvPrice reads it sync) ──
let latestQuote: { price: number; source: ClvStoredSource; at: number } | null = null;
/** Latest DexScreener pool depth (USD, both sides) + when it was read. */
let latestLiquidity: { usd: number; at: number } | null = null;
/** Rolling 30-min window of { price, at(ms) } in ascending time order. */
const twapSamples: Array<{ price: number; at: number }> = [];
/** Did the MOST RECENT poll attempt get a live price? false → serving cache. */
let lastFetchOk = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── Env resolvers (floored so a mis-set value can't thrash / mis-refuse) ──
function resolvePollMs(): number {
  const raw = process.env.CLV_ORACLE_POLL_MS;
  if (!raw) return DEFAULT_POLL_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_POLL_MS) return DEFAULT_POLL_MS;
  return n;
}

function resolveMaxStaleMs(): number {
  const raw = process.env.CLV_ORACLE_MAX_STALE_MS;
  if (!raw) return DEFAULT_MAX_STALE_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_STALE_MS;
  return n;
}

// ── Precision helpers ──
/**
 * Render a JS number as a plain (non-scientific) decimal string at the column
 * scale (12). Safe for numeric(20,12): our prices are sub-dollar so the integer
 * part is a single 0, far under the 8-digit precision headroom.
 */
function numberToPlainDecimal(n: number): string {
  return n.toFixed(12);
}

/**
 * Keep a plain decimal source string verbatim (full precision; Postgres rounds
 * to the column scale). Normalize any exponent / unusual form via Number.
 */
function normalizeDecimalString(s: string): string {
  const t = s.trim();
  if (/^\d*\.?\d+$/.test(t)) return t;
  return numberToPlainDecimal(Number(t));
}

// ── Data sources ──
interface HeliusGetAssetResponse {
  result?: {
    token_info?: {
      price_info?: {
        price_per_token?: number;
      };
    };
  };
}

/**
 * Helius DAS `getAsset` price. Returns a positive finite price or null (any
 * transport error, non-200, or missing `price_info` — all treated as failure).
 */
async function fetchHeliusPrice(): Promise<number | null> {
  const key = process.env.HELIUS_API_KEY?.trim();
  // Helius is optional and env-only. DexScreener remains the keyless fallback,
  // so a local environment never needs a committed or placeholder API key.
  if (!key) return null;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'clv-price-oracle',
        method: 'getAsset',
        params: { id: CLV_MINT },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as HeliusGetAssetResponse;
    const price = json?.result?.token_info?.price_info?.price_per_token;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
    return price;
  } catch {
    return null;
  }
}

interface DexScreenerPair {
  priceUsd?: string;
  liquidity?: { usd?: number };
}

/**
 * DexScreener spot (keyless). Returns the highest-liquidity pair's `priceUsd`
 * (full-precision string) PLUS that pair's `liquidity.usd` (Tokenomics C3 —
 * previously computed into `bestLiq` and discarded), or null. Mirrors the /dash
 * token-economy fetch, but picks by liquidity rather than blindly `pairs[0]`.
 * `liquidityUsd` is null when the winning pair carried no finite depth field.
 */
async function fetchDexScreenerPrice(): Promise<{
  priceStr: string;
  liquidityUsd: number | null;
} | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${CLV_MINT}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { pairs?: DexScreenerPair[] };
    const pairs = json?.pairs;
    if (!pairs || pairs.length === 0) return null;
    let best: DexScreenerPair | null = null;
    let bestLiq = -1;
    for (const p of pairs) {
      if (!p.priceUsd) continue;
      const n = Number(p.priceUsd);
      if (!Number.isFinite(n) || n <= 0) continue;
      const liq =
        typeof p.liquidity?.usd === 'number' && Number.isFinite(p.liquidity.usd)
          ? p.liquidity.usd
          : 0;
      if (liq > bestLiq) {
        best = p;
        bestLiq = liq;
      }
    }
    const priceStr = best?.priceUsd;
    if (!priceStr) return null;
    // bestLiq is >= 0 whenever a best pair was selected; a 0 means the winning
    // pair reported no (or zero) depth — surface it as a real 0 reading so the
    // swap planner refuses on "no usable depth" rather than seeing stale data.
    return { priceStr, liquidityUsd: bestLiq >= 0 ? bestLiq : null };
  } catch {
    return null;
  }
}

/**
 * One poll round. PRICE preference is unchanged (configured Helius primary →
 * keyless DexScreener fallback; null only when BOTH fail). DEPTH (Tokenomics C3) always comes from
 * DexScreener — the only feed that carries pool liquidity — so both feeds are
 * fetched in PARALLEL every round (one extra keyless request per ~60s poll)
 * instead of DexScreener only running on a Helius failure.
 */
async function fetchSpot(): Promise<SpotResult | null> {
  const [heliusPrice, dex] = await Promise.all([fetchHeliusPrice(), fetchDexScreenerPrice()]);
  const liquidityUsd = dex?.liquidityUsd ?? null;
  if (heliusPrice !== null) {
    return {
      priceNum: heliusPrice,
      priceStr: numberToPlainDecimal(heliusPrice),
      source: 'helius',
      liquidityUsd,
    };
  }
  if (dex !== null) {
    return {
      priceNum: Number(dex.priceStr),
      priceStr: normalizeDecimalString(dex.priceStr),
      source: 'dexscreener',
      liquidityUsd,
    };
  }
  return null;
}

// ── Sample-window maintenance ──
function pruneSamples(now: number): void {
  const cutoff = now - TWAP_WINDOW_MS;
  while (twapSamples.length > 0 && twapSamples[0].at < cutoff) {
    twapSamples.shift();
  }
}

function pushSample(price: number, at: number): void {
  twapSamples.push({ price, at });
  pruneSamples(at);
}

function computeTwap(spot: number, now: number): number {
  pruneSamples(now);
  if (twapSamples.length === 0) return spot;
  let sum = 0;
  for (const s of twapSamples) sum += s.price;
  return sum / twapSamples.length;
}

// ── Poll + boot seed ──
async function pollOnce(): Promise<void> {
  const spot = await fetchSpot();
  if (!spot) {
    // Both feeds failed — keep serving last-known within the grace window.
    lastFetchOk = false;
    console.warn(
      '[clv-price-oracle] poll failed (Helius + DexScreener both unreachable); serving last-known',
    );
    return;
  }
  const at = Date.now();
  // Persist best-effort: a DB failure must not affect the in-memory freshness.
  try {
    await db.insert(clvPriceSnapshots).values({ priceUsd: spot.priceStr, source: spot.source });
  } catch (err) {
    console.error('[clv-price-oracle] snapshot insert failed (non-fatal):', err);
  }
  latestQuote = { price: spot.priceNum, source: spot.source, at };
  // LP depth (C3): refresh only when DexScreener actually answered this round —
  // a Helius-only round keeps the previous reading (aged out by the max-stale
  // window in getClvPrice, never silently served forever).
  if (spot.liquidityUsd !== null) {
    latestLiquidity = { usd: spot.liquidityUsd, at };
  }
  pushSample(spot.priceNum, at);
  lastFetchOk = true;
}

/** Seed the TWAP window + latest quote from the last ~30 min of stored rows. */
async function seedFromDb(): Promise<void> {
  const cutoff = new Date(Date.now() - TWAP_WINDOW_MS);
  const rows = await db
    .select({
      priceUsd: clvPriceSnapshots.priceUsd,
      source: clvPriceSnapshots.source,
      createdAt: clvPriceSnapshots.createdAt,
    })
    .from(clvPriceSnapshots)
    .where(gte(clvPriceSnapshots.createdAt, cutoff))
    .orderBy(asc(clvPriceSnapshots.createdAt))
    .limit(MAX_HISTORY);

  for (const r of rows) {
    const price = Number(r.priceUsd);
    if (!Number.isFinite(price) || price <= 0) continue;
    const at =
      r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt).getTime();
    if (!Number.isFinite(at)) continue;
    twapSamples.push({ price, at });
  }
  pruneSamples(Date.now());

  const lastRow = rows[rows.length - 1];
  const lastSample = twapSamples[twapSamples.length - 1];
  if (lastRow && lastSample) {
    latestQuote = {
      price: lastSample.price,
      // Normalize to the stored-source union; only surfaced once a live poll
      // flips lastFetchOk true (seeded reads keep lastFetchOk=false).
      source: lastRow.source === 'helius' ? 'helius' : 'dexscreener',
      at: lastSample.at,
    };
    lastFetchOk = false;
  }
  if (twapSamples.length > 0) {
    console.log(`[clv-price-oracle] seeded ${twapSamples.length} snapshot(s) from DB for TWAP`);
  }
}

// ── Public API ──
/**
 * The current house-favorable CLV quote. Sync — reads only the in-memory cache
 * the poller maintains. See the ClvPriceQuote fields + the module header for the
 * degrade / refuse semantics.
 */
export function getClvPrice(): ClvPriceQuote {
  const now = Date.now();
  const maxStale = resolveMaxStaleMs();

  // LP depth (C3): same max-stale discipline as the price — a reading older
  // than the window is reported as null (a stale depth must never size clips).
  let poolLiquidityUsd: number | null = null;
  let liquidityAsOf: string | null = null;
  if (latestLiquidity && now - latestLiquidity.at <= maxStale) {
    poolLiquidityUsd = latestLiquidity.usd;
    liquidityAsOf = new Date(latestLiquidity.at).toISOString();
  }

  if (latestQuote === null) {
    return {
      spotUsd: null,
      twap30mUsd: null,
      quoteUsd: null,
      asOf: null,
      source: null,
      stale: true,
      available: false,
      poolLiquidityUsd,
      liquidityAsOf,
    };
  }
  const spot = latestQuote.price;
  const twap = computeTwap(spot, now);
  const asOf = new Date(latestQuote.at).toISOString();
  const ageMs = now - latestQuote.at;

  if (ageMs > maxStale) {
    // REFUSE — never serve a >max-stale price as a usable quote. spot/twap are
    // still reported for admin observability, but quoteUsd is null + available
    // false so a consumer treats it as "no quote, try again".
    return {
      spotUsd: spot,
      twap30mUsd: twap,
      quoteUsd: null,
      asOf,
      source: 'last_known',
      stale: true,
      available: false,
      poolLiquidityUsd,
      liquidityAsOf,
    };
  }

  const stale = !lastFetchOk;
  return {
    spotUsd: spot,
    twap30mUsd: twap,
    quoteUsd: Math.min(spot, twap),
    asOf,
    source: stale ? 'last_known' : latestQuote.source,
    stale,
    available: true,
    poolLiquidityUsd,
    liquidityAsOf,
  };
}

export interface ClvSnapshotRow {
  id: string;
  priceUsd: string;
  source: string;
  createdAt: string;
}

/** Last N stored snapshots, newest first. Backs the admin read route's `history`. */
export async function getRecentSnapshots(limit: number): Promise<ClvSnapshotRow[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), MAX_HISTORY);
  const rows = await db
    .select({
      id: clvPriceSnapshots.id,
      priceUsd: clvPriceSnapshots.priceUsd,
      source: clvPriceSnapshots.source,
      createdAt: clvPriceSnapshots.createdAt,
    })
    .from(clvPriceSnapshots)
    .orderBy(desc(clvPriceSnapshots.createdAt))
    .limit(capped);
  return rows.map((r) => ({
    id: r.id,
    priceUsd: r.priceUsd,
    source: r.source,
    createdAt:
      r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
  }));
}

/**
 * Idempotent boot init: seed the TWAP window from the DB, run one poll now, then
 * start the ~60s interval. Fire-and-forget — a fetch/DB failure logs and
 * degrades to last-known; it NEVER throws to the caller and NEVER crashes boot.
 */
export function startClvPriceOracle(): void {
  if (pollTimer) return;
  const periodMs = resolvePollMs();

  void (async () => {
    try {
      await seedFromDb();
    } catch (err) {
      console.error('[clv-price-oracle] boot seed failed (non-fatal):', err);
    }
    try {
      await pollOnce();
    } catch (err) {
      console.error('[clv-price-oracle] first poll failed (non-fatal):', err);
    }
  })();

  pollTimer = setInterval(() => {
    pollOnce().catch((err) => {
      console.error('[clv-price-oracle] poll error:', err);
    });
  }, periodMs);

  console.log(
    `[clv-price-oracle] started — polling CLV price every ${Math.round(periodMs / 1000)}s ` +
      `(configured Helius primary → keyless DexScreener fallback)`,
  );
}

/** Stop the poll interval (graceful shutdown). Idempotent. */
export function stopClvPriceOracle(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
