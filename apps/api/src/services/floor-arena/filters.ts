import type { FloorArenaFilters, FloorArenaRankBy } from '@clawville/shared';

/**
 * Pure entry filters and ranking for the Trading Floor Arena (docs/trading-floor-arena.md §2, §6).
 *
 * Port of the paper runner v42p.1 semantics (`paper_vars_filters`, `paper_vars_max_fails`,
 * `paper_rule_fails`, `paper_vars_rank` in ops/house-traders/paper-agents/build/runner_v42p1.py), with ONE
 * rule for every bound so the form, the analysis and the engine agree:
 *   - a min fails when value < min, a max fails when value > max (both bounds inclusive, as C1);
 *   - null turns that bound off;
 *   - a SET bound whose value is missing or not a finite number FAILS (fail closed; the runner read an
 *     absent DexScreener field as 0, which passed any max cap);
 *   - top10_max_pct >= 100 is off like null; a lower cap fails an unmeasured coin as `top10_unknown`.
 * No I/O here. `now` is always passed in.
 */

/** The DexScreener pair fields stored in `floor_discovery_mints.snapshot` (spec §4, plus the pool-side fields). */
export interface FloorArenaSnapshot {
  priceUsd: number | null;
  mcap: number | null;
  liqUsd: number | null;
  /** Base-token amount in the pool (DexScreener `liquidity.base`); the top-10 check removes the pool account. */
  liqBase: number | null;
  liqQuote: number | null;
  pairAddress: string | null;
  dexId: string | null;
  quoteMint: string | null;
  labels: string[];
  /** Epoch ms of the pair creation (DexScreener `pairCreatedAt`). */
  pairCreatedAt: number | null;
  /** Pair age in seconds at snapshot time. Filters recompute it from `pairCreatedAt` at evaluation time. */
  ageS: number | null;
  chg5m: number | null;
  chg1h: number | null;
  chg6h: number | null;
  chg24h: number | null;
  txns1h: number | null;
  vol1h: number | null;
  volOverMcap: number | null;
  symbol: string | null;
  name: string | null;
}

/** What the filters judge: the snapshot plus the chain-check top-10 holder share. */
export interface FloorArenaFeatures extends FloorArenaSnapshot {
  top10Pct: number | null;
}

/** Every fail code the filters and the engine emit (the analysis groups by these). */
export const FLOOR_ARENA_FAIL_CODES = [
  'price', 'mcap', 'liq', 'age', 'age_stale', 'vol_ratio', 'vol_ratio_max',
  'chg5m', 'chg5m_max', 'chg1h', 'chg1h_max', 'chg6h', 'chg6h_max', 'chg24h', 'chg24h_max',
  'txns', 'txns_max', 'top10', 'top10_unknown',
  // engine codes (never from passesFilters)
  'window', 'hard_rules', 'chain_pending', 'liq_floor', 'cooldown',
] as const;
export type FloorArenaFailCode = (typeof FLOOR_ARENA_FAIL_CODES)[number];

/** D5: the liquidity floor is a hard rule, not a parameter. */
export const FLOOR_ARENA_LIQ_FLOOR_USD = 5_000;

export function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function pairAgeSeconds(features: Pick<FloorArenaSnapshot, 'pairCreatedAt' | 'ageS'>, nowMs: number): number | null {
  const created = finiteOrNull(features.pairCreatedAt);
  if (created !== null && created > 0) return Math.max(0, (nowMs - created) / 1000);
  return null;
}

/** 1-h volume over market cap, or null when either side is not a positive finite number. */
export function volOverMcap(features: Pick<FloorArenaSnapshot, 'vol1h' | 'mcap'>): number | null {
  const vol = finiteOrNull(features.vol1h);
  const mcap = finiteOrNull(features.mcap);
  if (vol === null || mcap === null || mcap <= 0 || vol < 0) return null;
  return vol / mcap;
}

function nowMsOf(now: Date | number): number {
  return typeof now === 'number' ? now : now.getTime();
}

function checkRange(
  fails: string[],
  value: number | null,
  min: number | null,
  max: number | null,
  minCode: string,
  maxCode: string,
): void {
  if (min !== null && (value === null || value < min)) fails.push(minCode);
  if (max !== null && (value === null || value > max)) fails.push(maxCode);
}

/** Fail codes of the agent's filters for one coin; [] = passes. */
export function passesFilters(features: FloorArenaFeatures, filters: FloorArenaFilters, now: Date | number): string[] {
  const nowMs = nowMsOf(now);
  const fails: string[] = [];
  const price = finiteOrNull(features.priceUsd);
  if (price === null || price <= 0) fails.push('price');
  const mcap = finiteOrNull(features.mcap);
  if ((filters.mcap_min !== null && (mcap === null || mcap < filters.mcap_min))
    || (filters.mcap_max !== null && (mcap === null || mcap > filters.mcap_max))) {
    fails.push('mcap');
  }
  const liq = finiteOrNull(features.liqUsd);
  if ((filters.liq_min !== null && (liq === null || liq < filters.liq_min))
    || (filters.liq_max !== null && (liq === null || liq > filters.liq_max))) {
    fails.push('liq');
  }
  checkRange(fails, pairAgeSeconds(features, nowMs), filters.age_min_s, filters.age_max_s, 'age', 'age_stale');
  checkRange(fails, volOverMcap(features), filters.vol1h_over_mcap_min, filters.vol1h_over_mcap_max, 'vol_ratio', 'vol_ratio_max');
  checkRange(fails, finiteOrNull(features.chg5m), filters.chg5m_min, filters.chg5m_max, 'chg5m', 'chg5m_max');
  checkRange(fails, finiteOrNull(features.chg1h), filters.chg1h_min, filters.chg1h_max, 'chg1h', 'chg1h_max');
  checkRange(fails, finiteOrNull(features.chg6h), filters.chg6h_min, filters.chg6h_max, 'chg6h', 'chg6h_max');
  checkRange(fails, finiteOrNull(features.chg24h), filters.chg24h_min, filters.chg24h_max, 'chg24h', 'chg24h_max');
  checkRange(fails, finiteOrNull(features.txns1h), filters.txns1h_min, filters.txns1h_max, 'txns', 'txns_max');
  // Lead 2026-09-30: null or >= 100 = off (never fails, even unmeasured); a cap < 100 needs a measurement.
  if (filters.top10_max_pct !== null && filters.top10_max_pct < 100) {
    const top10 = finiteOrNull(features.top10Pct);
    if (top10 === null) fails.push('top10_unknown');
    else if (top10 > filters.top10_max_pct) fails.push('top10');
  }
  return fails;
}

/** D5 liquidity floor, judged on the fresh snapshot at every entry (liquidity moves). */
export function hardFloorFails(features: Pick<FloorArenaSnapshot, 'liqUsd'>): string[] {
  const liq = finiteOrNull(features.liqUsd);
  return liq !== null && liq >= FLOOR_ARENA_LIQ_FLOOR_USD ? [] : ['liq_floor'];
}

/** `entry.discovered_within_s`: null = any age on the radar; else first sight must be at most that old. */
export function withinDiscoveryWindow(firstSeenAt: Date | number, windowS: number | null, now: Date | number): boolean {
  if (windowS === null) return true;
  const first = nowMsOf(firstSeenAt);
  if (!Number.isFinite(first)) return false;
  return nowMsOf(now) - first <= windowS * 1000;
}

/**
 * Entry order of the coins that passed (port of `paper_vars_rank`).
 * Base order: highest vol1h / max(mcap, 1) first, ties in input order (stable). Every other rank_by re-sorts THAT
 * list stably; a coin whose key is missing or not finite goes last.
 *   newest / oldest       smallest / largest pair age first (age <= 0 or unknown = missing)
 *   txns1h                highest 1-h buys + sells first
 *   lowest_vol_over_mcap  lowest usable ratio first (ratio <= 0 or mcap <= 0 = missing)
 *   mid_vol_over_mcap     closest to the mean of ln(ratio) over usable ratios; with none usable the base order stands
 */
export function rankCandidates<T extends { features: FloorArenaFeatures }>(
  list: readonly T[],
  rankBy: FloorArenaRankBy,
  now: Date | number,
): T[] {
  const nowMs = nowMsOf(now);
  const baseKey = (item: T): number => {
    const vol = finiteOrNull(item.features.vol1h) ?? 0;
    const mcap = finiteOrNull(item.features.mcap) ?? 0;
    return vol / Math.max(mcap, 1);
  };
  const base = list
    .map((item, index) => ({ item, index, key: baseKey(item) }))
    .sort((a, b) => (b.key - a.key) || (a.index - b.index))
    .map((entry) => entry.item);
  if (rankBy === 'vol_over_mcap') return base;

  const usableRatio = (item: T): number | null => {
    const ratio = volOverMcap(item.features);
    return ratio !== null && ratio > 0 ? ratio : null;
  };
  let values: Array<number | null>;
  let sign: 1 | -1;
  switch (rankBy) {
    case 'newest':
    case 'oldest': {
      values = base.map((item) => {
        const age = pairAgeSeconds(item.features, nowMs);
        return age !== null && age > 0 ? age : null;
      });
      sign = rankBy === 'newest' ? 1 : -1;
      break;
    }
    case 'txns1h':
      values = base.map((item) => finiteOrNull(item.features.txns1h));
      sign = -1;
      break;
    case 'lowest_vol_over_mcap':
      values = base.map(usableRatio);
      sign = 1;
      break;
    case 'mid_vol_over_mcap': {
      const ratios = base.map(usableRatio);
      const logs = ratios.filter((r): r is number => r !== null).map((r) => Math.log(r));
      if (logs.length === 0) return base;
      const mid = logs.reduce((sum, v) => sum + v, 0) / logs.length;
      values = ratios.map((r) => (r === null ? null : Math.abs(Math.log(r) - mid)));
      sign = 1;
      break;
    }
    default: {
      const unreachable: never = rankBy;
      throw new Error(`rank_by ${String(unreachable)} is unknown`);
    }
  }
  return base
    .map((item, index) => ({ item, index, value: values[index] ?? null }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === null && b.value === null) return a.index - b.index;
        return a.value === null ? 1 : -1;
      }
      return (sign * a.value - sign * b.value) || (a.index - b.index);
    })
    .map((entry) => entry.item);
}
