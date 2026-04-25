/**
 * Reef Race Phase 4 — daily-best-lap "Lobster of the Day" aggregator.
 *
 * Fetches the top-100 fastest single laps in the last 24 hours from
 * `reef_race_personal_bests`, joins to pets + wallets for display, and
 * caches in-memory for 60s. Cache is invalidated by
 * `maybeUpdatePersonalBest` on every successful PB upsert (C2 fix) so the
 * public surface sees fresh data within one round-trip after any new PB.
 *
 * The route handler is in `apps/api/src/routes/leaderboard.ts` —
 * `/api/leaderboard/reef-race/daily-best-lap`. It uses a separate rate
 * limiter (S5 fix — does NOT share the `/agents` bucket) so multi-tab
 * leaderboard browsing doesn't blow the agents budget.
 *
 * Anti-cheat carve-outs (mirror activity-leaderboard-service.ts §117-120):
 *   - Bots: never have rows (skipped at PB-write site).
 *   - Guests: filtered via `pets.is_guest = false`.
 *   - Sub-MIN_LAP_MS laps: discarded sim-side (validateLapTime), never
 *     reach the PB write.
 *   - Anti-cheat-flagged matches: PB write skipped at reward-pipeline call
 *     site (`body.flagCount > 0`).
 *
 * Spec: `.claude/plans/reef-race-phase4-detailed.md` §4.
 */

import { sql } from 'drizzle-orm';
import { db } from '@clawville/database';

// ─── Types ────────────────────────────────────────────────────────────────

export interface DailyBestLapEntry {
  rank: number;
  petId: string;
  petName: string;
  bestLapMs: number;
  bestLapRecordedAt: string; // ISO
  /** Owner's wallet address — surfaced for "Lobster of the day" cosmetic. */
  walletAddress: string | null;
}

export interface DailyBestLapSnapshot {
  generatedAt: string;
  /** ISO timestamp of the cutoff (now - 24h). */
  windowStart: string;
  totalEntries: number;
  entries: DailyBestLapEntry[];
}

// ─── 60s in-memory cache ──────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
const DEFAULT_LIMIT = 100;

interface CacheEntry {
  snapshot: DailyBestLapSnapshot;
  expiresAt: number;
}

let cached: CacheEntry | null = null;

/**
 * Drop the cached snapshot. Called from `maybeUpdatePersonalBest` on every
 * successful PB upsert (C2 fix) so the next public read sees fresh data
 * within one round-trip.
 */
export function invalidateDailyBestLapCache(): void {
  cached = null;
}

/** Test hook — same as `invalidateDailyBestLapCache`, named for symmetry. */
export function __resetDailyBestLapCacheForTest(): void {
  cached = null;
}

// ─── Aggregator ────────────────────────────────────────────────────────────

/**
 * Build the daily-best-lap snapshot. SQL: index-only scan against
 * `idx_reef_race_pb_recorded_lap` (best_lap_recorded_at DESC,
 * best_lap_ms ASC) WHERE activity_id = 'reef-race'. PG planner picks
 * a sort-merge against `pets` (PK) + LEFT JOIN against `wallets`
 * (subject composite). Sub-millisecond at 1000 PB rows / day.
 */
export async function getDailyBestLapSnapshot(
  limit: number = DEFAULT_LIMIT,
): Promise<DailyBestLapSnapshot> {
  const now = Date.now();
  // Cache hit — slice limit from the cached top-100 (strict prefix is safe
  // because we always order by bestLapMs ASC).
  if (cached && cached.expiresAt > now) {
    return {
      generatedAt: cached.snapshot.generatedAt,
      windowStart: cached.snapshot.windowStart,
      totalEntries: cached.snapshot.totalEntries,
      entries: cached.snapshot.entries.slice(0, limit),
    };
  }

  // Bot rows are excluded by virtue of bots never reaching the PB write
  // (subject_type filter at the call site in reward-pipeline). Guests are
  // excluded via the pets.is_guest = false predicate.
  const rows = await db.execute<{
    pet_id: string;
    best_lap_ms: number;
    best_lap_recorded_at: Date | string;
    pet_name: string;
    wallet_address: string | null;
  }>(sql`
    SELECT
      pb.pet_id,
      pb.best_lap_ms,
      pb.best_lap_recorded_at,
      p.name AS pet_name,
      p.wallet_address AS wallet_address
    FROM reef_race_personal_bests pb
    JOIN pets p ON p.id = pb.pet_id
    WHERE pb.activity_id = 'reef-race'
      AND pb.best_lap_recorded_at > now() - interval '24 hours'
      AND p.is_guest = false
      AND p.is_active = true
    ORDER BY pb.best_lap_ms ASC
    LIMIT 100
  `);
  const list = Array.isArray(rows) ? rows : [];

  const windowStartIso = new Date(now - 24 * 3600_000).toISOString();
  const generatedAtIso = new Date(now).toISOString();

  const entries: DailyBestLapEntry[] = list.map((r, idx) => {
    const recordedAt =
      r.best_lap_recorded_at instanceof Date
        ? r.best_lap_recorded_at.toISOString()
        : new Date(r.best_lap_recorded_at).toISOString();
    return {
      rank: idx + 1,
      petId: r.pet_id,
      petName: r.pet_name,
      bestLapMs: Number(r.best_lap_ms) || 0,
      bestLapRecordedAt: recordedAt,
      walletAddress: r.wallet_address ?? null,
    };
  });

  const snapshot: DailyBestLapSnapshot = {
    generatedAt: generatedAtIso,
    windowStart: windowStartIso,
    totalEntries: entries.length,
    entries,
  };

  cached = { snapshot, expiresAt: now + CACHE_TTL_MS };

  // Honor the caller's limit (the cache always stores the full top-100).
  return {
    ...snapshot,
    entries: snapshot.entries.slice(0, limit),
  };
}
