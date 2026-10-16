import { db, sql } from '@clawville/database';
import { FLOOR_ARENA_PAPER_COSTS } from '@clawville/shared';
import { entryVerdictStatus } from './chain-checks';
import { buildSnapshot, isTradableMint, pickBestPairs, POLLER_RESERVE_PER_MIN } from './discovery-hub';
import { firstSightRecord } from './engine';
import { ARENA_RESEARCH_PRUNE_BATCH, ARENA_RESEARCH_PRUNE_MAX_BATCHES, ARENA_RESEARCH_RETENTION_DAYS } from './events';
import { firstTradeableSource, hasTradeableSource, type FloorArenaSnapshot } from './filters';
import {
  ARENA_MARK_MAX_AGE_MS, ARENA_POSITION_USD, ArenaHttpError, arenaFetchJson, dexscreenerBudgetLeft, markFallbackProceeds,
  noteDexscreenerCall, noteDexscreenerRateLimited, type ArenaFetch, type PaperCosts,
} from './pricing';

/**
 * COIN LABELS (research, migration 0083, table floor_arena_coin_labels). Labels EVERY coin the shared floor sees from
 * a tradeable source (ds: / clawpump:), traded or skipped, so the report (scripts/floor-arena-label-report.ts) can
 * tell whether a bot's filters block winners or losers. No trade path, money path or payload reads this table.
 *
 * Episode: one row per (mint, first tradeable sighting). Anchor: the first DexScreener snapshot taken at or after that
 * sighting (the row's first_snapshot when it qualifies, else the current snapshot when the loop first sees the coin
 * tradeable). A coin whose tradeable sighting is older than LABEL_ANCHOR_MAX_LAG_MS when the loop first sees it is NOT
 * labelled (no late anchor, so every anchor is within 15 min of the first tradeable sighting).
 *
 * Sampling (one leader-only loop, 60 s): the path is [seconds after anchor, price / anchor price].
 *   - 0-60 min: one point per minute;
 *   - 6 h and 24 h: one checkpoint each;
 *   - between them: a FREE point every 15 min while the enrichment keeps the coin's discovery snapshot fresh.
 * A point is taken from the discovery snapshot when it is <= 60 s old (written by the enrichment tick, zero calls);
 * only a DUE point with no fresh snapshot costs a DexScreener batch call (30 mints per call), at most
 * LABEL_MAX_CALLS_PER_TICK per tick and only while the shared budget has more than the pollers' reserve left, so the
 * enrichment (open positions first) and the pollers keep their share.
 *
 * Single writer: the loop runs inside the arena leader term (index.ts, session advisory lock), like every arena loop.
 * Inserts are ON CONFLICT DO NOTHING; the updates touch only this table.
 */

export type PathPoint = [number, number];

export const LABEL_TICK_MS = 60_000;
export const LABEL_ANCHOR_MAX_LAG_MS = 15 * 60_000;
export const LABEL_MINUTE_PHASE_S = 3_600;
export const LABEL_SAMPLE_EVERY_S = 60;
/** The loop runs every 60 s +/- 5 %; a point 55 s after the last one is the next minute's point. */
const LABEL_SAMPLE_SLACK_S = 5;
export const LABEL_FREE_BUCKET_S = 15 * 60;
export const LABEL_H6_S = 6 * 3_600;
export const LABEL_H6_TOL_S = 3_600;
export const LABEL_H24_S = 24 * 3_600;
export const LABEL_H24_TOL_S = 2 * 3_600;
/** A +5/+15/+30/+60 min markout is the point nearest the target within 2 min (null when none). */
export const LABEL_MARKOUT_TOL_S = 120;
export const LABEL_MAX_CALLS_PER_TICK = 2;
const DS_BATCH = 30;
const DS = 'https://api.dexscreener.com';

/**
 * The ONE fixed reference exit applied to every labelled coin: $20 (ARENA_POSITION_USD), take profit at +20 %,
 * stop at -20 %, time exit at 60 min, all judged like the engine: mark / entry price, entry price = size / tokens.
 * Costs match a real paper round trip (FLOOR_ARENA_PAPER_COSTS, pricing.ts) priced at DexScreener prices:
 *   buy  - a real entry fills on a ClawPump quote, whose token output already holds the pool fee, then
 *          evaluateBuyQuote takes the 1.0 % buy haircut. A DexScreener price holds no pool fee, so the buy leg pays
 *          the per-leg pool fee (mark_fallback_pool_fee_pct, 1.25 %) and then the 1.0 % haircut:
 *          tokens = size / anchor x (1 - 1.25 %) x (1 - 1.0 %)  (commonEntryTokens);
 *   sell - markFallbackProceeds: tokens x price x (1 - (0.5 % + 1.25 %)), the engine's D4 DexScreener exit fill.
 * Price impact and quote drift are not modelled (DexScreener prices only). The fill is the sampled price that
 * triggered the exit (not the threshold): a gap through the stop books the gap.
 */
export const COMMON_EXIT = { sizeUsd: ARENA_POSITION_USD, tpMult: 1.2, stopMult: 0.8, maxHoldS: 3_600, timeTolS: 300 } as const;

export type Fate = 'rug' | 'runner' | 'bleed' | 'flat' | 'unknown';

/**
 * Fate over the 24 h after the anchor (multiples of the anchor price):
 *   rug    = the lowest point is <= 0.2x (assigned even without a 24 h point);
 *   runner = the highest point is >= 2x, not a rug, and a 24 h point exists (so "not a rug" was observed);
 *   bleed  = not rug / runner and the 24 h multiple is <= 0.7x;
 *   flat   = everything else with a 24 h point;
 *   unknown = no 24 h point and no rug (for example the price vanished from DexScreener).
 */
export function classifyFate(input: { min24h: number | null; max24h: number | null; mult24h: number | null }): Fate {
  if (input.min24h !== null && input.min24h <= 0.2) return 'rug';
  if (input.mult24h === null) return 'unknown';
  if (input.max24h !== null && input.max24h >= 2) return 'runner';
  if (input.mult24h <= 0.7) return 'bleed';
  return 'flat';
}

function lastT(path: readonly PathPoint[]): number {
  return path.length > 0 ? path[path.length - 1]![0] : Number.NEGATIVE_INFINITY;
}

export type SampleNeed = 'minute' | 'h6' | 'h24' | null;

/** Which scheduled point is due at `ageS` seconds after the anchor (null = nothing due). */
export function sampleNeed(path: readonly PathPoint[], ageS: number): SampleNeed {
  if (ageS <= LABEL_MINUTE_PHASE_S + LABEL_SAMPLE_EVERY_S) {
    return ageS - lastT(path) >= LABEL_SAMPLE_EVERY_S - LABEL_SAMPLE_SLACK_S ? 'minute' : null;
  }
  if (ageS >= LABEL_H6_S && ageS <= LABEL_H6_S + LABEL_H6_TOL_S && !path.some(([t]) => t >= LABEL_H6_S)) return 'h6';
  if (ageS >= LABEL_H24_S && ageS <= LABEL_H24_S + LABEL_H24_TOL_S && !path.some(([t]) => t >= LABEL_H24_S)) return 'h24';
  return null;
}

/** Whether a FREE observation at `tS` (from a fresh discovery snapshot) is stored. */
export function shouldRecord(path: readonly PathPoint[], tS: number, ageS: number): boolean {
  const last = lastT(path);
  if (!(tS > last) || tS < 0 || tS > LABEL_H24_S + LABEL_H24_TOL_S) return false;
  if (sampleNeed(path, ageS) !== null) return true;
  return tS > LABEL_MINUTE_PHASE_S && Math.floor(tS / LABEL_FREE_BUCKET_S) > Math.floor(last / LABEL_FREE_BUCKET_S);
}

/** The path point nearest `targetS` within `tolS` (a tie takes the later point); null when none. */
export function markoutAt(path: readonly PathPoint[], targetS: number, tolS: number): number | null {
  let best: PathPoint | null = null;
  for (const point of path) {
    const d = Math.abs(point[0] - targetS);
    if (d > tolS) continue;
    if (best === null || d < Math.abs(best[0] - targetS) || (d === Math.abs(best[0] - targetS) && point[0] > best[0])) best = point;
  }
  return best ? best[1] : null;
}

export interface CommonExitResult { pnlUsd: number; reason: 'tp' | 'stop' | 'time'; atS: number; mult: number }

/**
 * Tokens a $sizeUsd paper entry books at a DexScreener price `priceUsd` (see COMMON_EXIT): the venue quote's pool fee
 * (mark_fallback_pool_fee_pct per leg), then evaluateBuyQuote's buy haircut.
 */
export function commonEntryTokens(sizeUsd: number, priceUsd: number, costs: PaperCosts = FLOOR_ARENA_PAPER_COSTS): number {
  return (sizeUsd / priceUsd) * (1 - costs.mark_fallback_pool_fee_pct / 100) * (1 - costs.buy_haircut_pct / 100);
}

/** The fixed reference exit (COMMON_EXIT) over a path; null when the path has no exit point. */
export function simulateCommonExit(path: readonly PathPoint[], costs: PaperCosts = FLOOR_ARENA_PAPER_COSTS): CommonExitResult | null {
  // Price units of the anchor (anchor price = 1): tokens at entry, proceeds at multiple m = markFallbackProceeds(tokens, m).
  const tokens = commonEntryTokens(COMMON_EXIT.sizeUsd, 1, costs);
  const entryPrice = COMMON_EXIT.sizeUsd / tokens;
  for (const [t, m] of path) {
    if (t <= 0) continue;
    if (t > COMMON_EXIT.maxHoldS + COMMON_EXIT.timeTolS) break;
    // The engine's multiple: mark / entry price (entry price = size / booked tokens).
    const engineMult = m / entryPrice;
    const reason = engineMult >= COMMON_EXIT.tpMult ? 'tp' : engineMult <= COMMON_EXIT.stopMult ? 'stop'
      : t >= COMMON_EXIT.maxHoldS ? 'time' : null;
    if (reason === null) continue;
    return { pnlUsd: markFallbackProceeds(tokens, m, costs) - COMMON_EXIT.sizeUsd, reason, atS: t, mult: m };
  }
  return null;
}

export interface DerivedLabel {
  mult5m: number | null; mult15m: number | null; mult30m: number | null; mult60m: number | null;
  maxMult60m: number | null; maxMult60mAtS: number | null; minMult60m: number | null; minMult60mAtS: number | null;
  mult6h: number | null; mult24h: number | null; maxMult24h: number | null; minMult24h: number | null;
  fate24h: Fate; commonExit: CommonExitResult | null; done: boolean;
}

/** Every derived column from the path. `ageS` = seconds since the anchor now. */
export function deriveLabel(path: readonly PathPoint[], ageS: number): DerivedLabel {
  let max60: PathPoint | null = null;
  let min60: PathPoint | null = null;
  let max24: number | null = null;
  let min24: number | null = null;
  for (const point of path) {
    const [t, m] = point;
    if (t <= 0) continue;
    if (t <= LABEL_MINUTE_PHASE_S + LABEL_SAMPLE_EVERY_S) {
      if (max60 === null || m > max60[1]) max60 = point;
      if (min60 === null || m < min60[1]) min60 = point;
    }
    if (t <= LABEL_H24_S + LABEL_H24_TOL_S) {
      max24 = max24 === null ? m : Math.max(max24, m);
      min24 = min24 === null ? m : Math.min(min24, m);
    }
  }
  const mult24h = markoutAt(path, LABEL_H24_S, LABEL_H24_TOL_S);
  const done = ageS >= LABEL_H24_S + LABEL_H24_TOL_S || path.some(([t]) => t >= LABEL_H24_S);
  return {
    mult5m: markoutAt(path, 300, LABEL_MARKOUT_TOL_S),
    mult15m: markoutAt(path, 900, LABEL_MARKOUT_TOL_S),
    mult30m: markoutAt(path, 1_800, LABEL_MARKOUT_TOL_S),
    mult60m: markoutAt(path, 3_600, LABEL_MARKOUT_TOL_S),
    maxMult60m: max60?.[1] ?? null, maxMult60mAtS: max60?.[0] ?? null,
    minMult60m: min60?.[1] ?? null, minMult60mAtS: min60?.[0] ?? null,
    mult6h: markoutAt(path, LABEL_H6_S, LABEL_H6_TOL_S),
    mult24h, maxMult24h: max24, minMult24h: min24,
    fate24h: done ? classifyFate({ min24h: min24, max24h: max24, mult24h }) : 'unknown',
    commonExit: simulateCommonExit(path),
    done,
  };
}

/** A path multiple, rounded to 6 significant digits (the path is jsonb). */
export function roundMult(mult: number): number {
  return Number(mult.toPrecision(6));
}

export interface DiscoveryRowLite {
  mint: string;
  firstSeenAtMs: number;
  firstSource: string;
  sources: string[];
  sourceFirstSeen: Record<string, string> | null;
  snapshot: FloorArenaSnapshot | null;
  snapshotAtMs: number | null;
  firstSnapshot: FloorArenaSnapshot | null;
  firstSnapshotAtMs: number | null;
  chainVerdict: unknown;
  chainCheckedAtMs: number | null;
}

export interface AnchorPlan {
  mint: string;
  episodeAtMs: number;
  anchorAtMs: number;
  priceUsd: number;
  features: Record<string, unknown>;
  sources: string[];
}

function positivePrice(snapshot: FloorArenaSnapshot | null): number | null {
  const p = snapshot?.priceUsd;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}

/** The label to create for a discovery row now, or null (not tradeable, no qualifying snapshot, or seen too late). */
export function planAnchor(row: DiscoveryRowLite, nowMs: number): AnchorPlan | null {
  if (!isTradableMint(row.mint) || !hasTradeableSource(row.sources)) return null;
  const admitted = firstTradeableSource(row.sources, row.sourceFirstSeen, row.firstSeenAtMs);
  if (!admitted || nowMs - admitted.atMs > LABEL_ANCHOR_MAX_LAG_MS) return null;
  let snapshot: FloorArenaSnapshot | null = null;
  let atMs: number | null = null;
  if (row.firstSnapshotAtMs !== null && row.firstSnapshotAtMs >= admitted.atMs && positivePrice(row.firstSnapshot) !== null) {
    snapshot = row.firstSnapshot;
    atMs = row.firstSnapshotAtMs;
  } else if (row.snapshotAtMs !== null && row.snapshotAtMs >= admitted.atMs && positivePrice(row.snapshot) !== null) {
    snapshot = row.snapshot;
    atMs = row.snapshotAtMs;
  }
  const price = positivePrice(snapshot);
  if (snapshot === null || atMs === null || price === null) return null;
  const status = entryVerdictStatus(row.chainVerdict, row.chainCheckedAtMs, snapshot.pairAddress ?? null, atMs);
  // Same keys as floor_arena_positions.entry_features where they apply (no quote, exits or decimals: nothing was bought).
  const features: Record<string, unknown> = {
    ...snapshot,
    top10Pct: status.top10Pct,
    chainVerdict: status.verdict,
    source: row.firstSource,
    tradeableSource: admitted.source,
    firstSeenAt: new Date(row.firstSeenAtMs).toISOString(),
    judgedAt: new Date(atMs).toISOString(),
    dsEntryPriceUsd: price,
    firstSight: firstSightRecord(row.firstSnapshot, row.firstSnapshotAtMs === null ? null : new Date(row.firstSnapshotAtMs), {
      source: row.firstSource, firstSeenAtMs: row.firstSeenAtMs,
    }),
  };
  return { mint: row.mint, episodeAtMs: admitted.atMs, anchorAtMs: atMs, priceUsd: price, features, sources: row.sources };
}

/** DexScreener calls this tick may make: never the pollers' reserve, never more than the per-tick cap. */
export function ownCallSlots(budgetLeft: number, reserve = POLLER_RESERVE_PER_MIN, cap = LABEL_MAX_CALLS_PER_TICK): number {
  return Math.max(0, Math.min(cap, budgetLeft - reserve));
}

// ---------------------------------------------------------------- the loop

type Row = Record<string, unknown>;
type LabelDatabase = Pick<typeof db, 'execute'>;

function rowsOf(result: unknown): Row[] {
  return Array.isArray(result) ? result as Row[] : ((result as { rows?: Row[] })?.rows ?? []);
}

function msOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function parsePath(raw: unknown): PathPoint[] {
  const value = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown; } catch { return []; } })() : raw;
  if (!Array.isArray(value)) return [];
  const out: PathPoint[] = [];
  for (const p of value) {
    if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
      out.push([p[0], p[1]]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function asObject(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Retention: done label rows are deleted ARENA_RESEARCH_RETENTION_DAYS (90) days after their anchor, in bounded
 * batches, with the AR-1 research-retention constants and batch loop of events.ts pruneArenaResearch (that function
 * is not extended: this table belongs to this module). Open rows are never deleted. Runs at most once per hour.
 */
export const LABEL_PRUNE_EVERY_MS = 60 * 60_000;
let lastPruneMs = 0;

export function resetCoinLabelStateForTest(): void {
  lastPruneMs = 0;
}

export async function pruneCoinLabels(
  now: Date = new Date(),
  database: LabelDatabase = db,
  options: { batch?: number; maxBatches?: number } = {},
): Promise<number> {
  const batch = options.batch ?? ARENA_RESEARCH_PRUNE_BATCH;
  const maxBatches = options.maxBatches ?? ARENA_RESEARCH_PRUNE_MAX_BATCHES;
  const cutoff = new Date(now.getTime() - ARENA_RESEARCH_RETENTION_DAYS * 86_400_000).toISOString();
  let total = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const deleted = rowsOf(await database.execute(sql`
      DELETE FROM floor_arena_coin_labels
      WHERE id IN (
        SELECT id FROM floor_arena_coin_labels WHERE state = 'done' AND anchor_at < ${cutoff}::timestamptz LIMIT ${batch}
      )
      RETURNING 1
    `)).length;
    total += deleted;
    if (deleted < batch) break;
  }
  return total;
}

export function coinLabelsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FLOOR_ARENA_COIN_LABELS_ENABLED?.trim().toLowerCase() !== 'false';
}

export interface CoinLabelTickResult {
  created: number; open: number; updated: number; done: number; freePoints: number; ownPoints: number; calls: number;
  rateLimited: boolean; pruned: number | null;
}

export async function runCoinLabelTick(
  now: Date = new Date(),
  deps: { fetchImpl?: ArenaFetch; database?: LabelDatabase } = {},
): Promise<CoinLabelTickResult> {
  const database = deps.database ?? db;
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const result: CoinLabelTickResult = {
    created: 0, open: 0, updated: 0, done: 0, freePoints: 0, ownPoints: 0, calls: 0, rateLimited: false, pruned: null,
  };

  // 1. New episodes: tradeable rows seen in the last 15 min (a tradeable sighting refreshes last_seen_at).
  const sinceIso = new Date(nowMs - LABEL_ANCHOR_MAX_LAG_MS).toISOString();
  const fresh = rowsOf(await database.execute(sql`
    SELECT mint, first_seen_at, first_source, sources, source_first_seen, snapshot, snapshot_at, first_snapshot,
      first_snapshot_at, chain_verdict, chain_checked_at
    FROM floor_discovery_mints
    WHERE expires_at > ${nowIso}::timestamptz AND snapshot IS NOT NULL AND last_seen_at >= ${sinceIso}::timestamptz
      AND EXISTS (SELECT 1 FROM unnest(sources) AS s WHERE starts_with(s, 'ds:') OR starts_with(s, 'clawpump:'))
  `));
  const plans: AnchorPlan[] = [];
  for (const row of fresh) {
    const plan = planAnchor({
      mint: String(row.mint),
      firstSeenAtMs: msOf(row.first_seen_at) ?? nowMs,
      firstSource: String(row.first_source ?? ''),
      sources: Array.isArray(row.sources) ? row.sources.map(String) : [],
      sourceFirstSeen: (asObject(row.source_first_seen) as Record<string, string> | null) ?? null,
      snapshot: asObject(row.snapshot) as FloorArenaSnapshot | null,
      snapshotAtMs: msOf(row.snapshot_at),
      firstSnapshot: asObject(row.first_snapshot) as FloorArenaSnapshot | null,
      firstSnapshotAtMs: msOf(row.first_snapshot_at),
      chainVerdict: asObject(row.chain_verdict),
      chainCheckedAtMs: msOf(row.chain_checked_at),
    }, nowMs);
    if (plan) plans.push(plan);
  }
  if (plans.length > 0) {
    const payload = JSON.stringify(plans.map((p) => ({
      mint: p.mint, episode_at: new Date(p.episodeAtMs).toISOString(), anchor_at: new Date(p.anchorAtMs).toISOString(),
      anchor_price_usd: p.priceUsd, anchor_features: p.features, sources: p.sources,
    })));
    // One open episode per mint: a mint whose episode key moved (a source time recorded late) is not labelled twice.
    const inserted = rowsOf(await database.execute(sql`
      INSERT INTO floor_arena_coin_labels (mint, episode_at, anchor_at, anchor_price_usd, anchor_features, sources, path)
      SELECT r.mint, r.episode_at, r.anchor_at, r.anchor_price_usd, r.anchor_features,
        ARRAY(SELECT jsonb_array_elements_text(r.sources)), '[[0,1]]'::jsonb
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS r(mint text, episode_at timestamptz, anchor_at timestamptz, anchor_price_usd double precision, anchor_features jsonb, sources jsonb)
      WHERE NOT EXISTS (SELECT 1 FROM floor_arena_coin_labels l WHERE l.mint = r.mint AND l.state = 'open')
      ON CONFLICT (mint, episode_at) DO NOTHING
      RETURNING id
    `));
    result.created = inserted.length;
  }

  // 2. Sample every open label.
  const open = rowsOf(await database.execute(sql`
    SELECT l.id, l.mint, l.anchor_at, l.anchor_price_usd, l.path, l.chain_status, l.own_samples,
      d.snapshot, d.snapshot_at, d.chain_verdict, d.chain_checked_at
    FROM floor_arena_coin_labels l
    LEFT JOIN floor_discovery_mints d ON d.mint = l.mint
    WHERE l.state = 'open'
  `));
  result.open = open.length;
  interface Work { id: string; mint: string; anchorMs: number; anchorPrice: number; path: PathPoint[]; changed: boolean; chainStatus: unknown; ownSamples: number; need: SampleNeed }
  const work: Work[] = [];
  for (const row of open) {
    const anchorMs = msOf(row.anchor_at);
    const anchorPrice = Number(row.anchor_price_usd);
    if (anchorMs === null || !(anchorPrice > 0)) continue;
    const w: Work = {
      id: String(row.id), mint: String(row.mint), anchorMs, anchorPrice, path: parsePath(row.path), changed: false,
      chainStatus: asObject(row.chain_status), ownSamples: Number(row.own_samples ?? 0) || 0, need: null,
    };
    const ageS = (nowMs - anchorMs) / 1000;
    const snapshot = asObject(row.snapshot) as FloorArenaSnapshot | null;
    const snapAtMs = msOf(row.snapshot_at);
    const price = positivePrice(snapshot);
    if (price !== null && snapAtMs !== null && nowMs - snapAtMs <= ARENA_MARK_MAX_AGE_MS) {
      const tS = Math.round((snapAtMs - anchorMs) / 1000);
      if (shouldRecord(w.path, tS, ageS)) {
        w.path.push([tS, roundMult(price / anchorPrice)]);
        w.changed = true;
        result.freePoints += 1;
      }
    }
    // The first resolved chain verdict after the anchor (most anchors are taken before the chain check finishes).
    if (w.chainStatus === null && snapshot) {
      const status = entryVerdictStatus(asObject(row.chain_verdict), msOf(row.chain_checked_at), snapshot.pairAddress ?? null, nowMs);
      if (status.verdict === 'pass' || status.verdict === 'fail') {
        w.chainStatus = { verdict: status.verdict, top10Pct: status.top10Pct, at: nowIso };
        w.changed = true;
      }
    }
    w.need = sampleNeed(w.path, ageS);
    work.push(w);
  }

  // 3. Due points with no fresh snapshot: own DexScreener calls (checkpoints first, then the oldest minute points).
  const rank: Record<Exclude<SampleNeed, null>, number> = { h24: 0, h6: 1, minute: 2 };
  const due = work.filter((w) => w.need !== null && isTradableMint(w.mint))
    .sort((a, b) => rank[a.need!] - rank[b.need!] || a.anchorMs - b.anchorMs);
  const slots = ownCallSlots(dexscreenerBudgetLeft(nowMs));
  for (let i = 0; i < due.length && result.calls < slots; i += DS_BATCH) {
    if (ownCallSlots(dexscreenerBudgetLeft(Date.now())) <= 0) break;
    const batch = due.slice(i, i + DS_BATCH);
    result.calls += 1;
    noteDexscreenerCall();
    let body: unknown;
    try {
      body = await arenaFetchJson(new URL(`/tokens/v1/solana/${batch.map((w) => w.mint).join(',')}`, DS), {}, deps.fetchImpl);
    } catch (error) {
      if (error instanceof ArenaHttpError && error.code === 'rate_limited') {
        noteDexscreenerRateLimited();
        result.rateLimited = true;
        break;
      }
      continue;
    }
    const best = pickBestPairs(body, new Set(batch.map((w) => w.mint)));
    for (const w of batch) {
      const pair = best.get(w.mint);
      if (!pair) continue;
      const price = positivePrice(buildSnapshot(pair, nowMs));
      const tS = Math.round((nowMs - w.anchorMs) / 1000);
      if (price === null || !(tS > lastT(w.path))) continue;
      w.path.push([tS, roundMult(price / w.anchorPrice)]);
      w.ownSamples += 1;
      w.changed = true;
      result.ownPoints += 1;
    }
  }

  // 4. Write changed rows and close finished ones (one statement).
  const updates: Row[] = [];
  for (const w of work) {
    const ageS = (nowMs - w.anchorMs) / 1000;
    const d = deriveLabel(w.path, ageS);
    if (!w.changed && !d.done) continue;
    const at = (s: number | null) => (s === null ? null : new Date(w.anchorMs + s * 1000).toISOString());
    updates.push({
      id: w.id, path: w.path, chain_status: w.chainStatus ?? null, own_samples: w.ownSamples,
      mult_5m: d.mult5m, mult_15m: d.mult15m, mult_30m: d.mult30m, mult_60m: d.mult60m,
      max_mult_60m: d.maxMult60m, max_mult_60m_at: at(d.maxMult60mAtS), min_mult_60m: d.minMult60m, min_mult_60m_at: at(d.minMult60mAtS),
      mult_6h: d.mult6h, mult_24h: d.mult24h, max_mult_24h: d.maxMult24h, min_mult_24h: d.minMult24h,
      fate_24h: d.fate24h, common_exit_pnl_usd: d.commonExit?.pnlUsd ?? null, common_exit_reason: d.commonExit?.reason ?? null,
      state: d.done ? 'done' : 'open',
    });
    if (d.done) result.done += 1;
  }
  for (let offset = 0; offset < updates.length; offset += 500) {
    const chunk = JSON.stringify(updates.slice(offset, offset + 500));
    await database.execute(sql`
      UPDATE floor_arena_coin_labels AS l
      SET path = r.path, chain_status = r.chain_status, own_samples = r.own_samples,
        mult_5m = r.mult_5m, mult_15m = r.mult_15m, mult_30m = r.mult_30m, mult_60m = r.mult_60m,
        max_mult_60m = r.max_mult_60m, max_mult_60m_at = r.max_mult_60m_at, min_mult_60m = r.min_mult_60m,
        min_mult_60m_at = r.min_mult_60m_at, mult_6h = r.mult_6h, mult_24h = r.mult_24h, max_mult_24h = r.max_mult_24h,
        min_mult_24h = r.min_mult_24h, fate_24h = r.fate_24h, common_exit_pnl_usd = r.common_exit_pnl_usd,
        common_exit_reason = r.common_exit_reason, state = r.state, updated_at = ${nowIso}::timestamptz
      FROM jsonb_to_recordset(${chunk}::jsonb) AS r(
        id uuid, path jsonb, chain_status jsonb, own_samples integer, mult_5m double precision, mult_15m double precision,
        mult_30m double precision, mult_60m double precision, max_mult_60m double precision, max_mult_60m_at timestamptz,
        min_mult_60m double precision, min_mult_60m_at timestamptz, mult_6h double precision, mult_24h double precision,
        max_mult_24h double precision, min_mult_24h double precision, fate_24h text, common_exit_pnl_usd double precision,
        common_exit_reason text, state text)
      WHERE l.id = r.id AND l.state = 'open'
    `);
  }
  result.updated = updates.length;

  // 5. Retention, hourly (the labelling above never depends on it).
  if (nowMs - lastPruneMs >= LABEL_PRUNE_EVERY_MS) {
    lastPruneMs = nowMs;
    result.pruned = await pruneCoinLabels(now, database);
  }
  return result;
}
