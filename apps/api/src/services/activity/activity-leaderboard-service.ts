/**
 * Q2 Activity Portals — per-activity leaderboard aggregator (chunk #7).
 *
 * Live aggregation from `activity_results` (no snapshot table in Q2 per
 * backend §6.2). Bots are excluded via `subject_type != 'bot'`. Reef
 * Race surfaces `bestTimeMs`; other activities omit it.
 *
 * 60s in-memory cache per `{activityId, window, season?}` key (same TTL
 * pattern as `/api/leaderboard/agents`).
 */

import { and, eq, gte, ne, sql } from 'drizzle-orm';
import {
  db,
  activityResults,
  avatars,
  type ActivitySeason,
} from '@clawville/database';
import { getActiveSeason } from './activity-season-service';

export type ActivityLeaderboardWindow = 'daily' | 'weekly' | 'all' | 'season';
export const VALID_WINDOWS: ActivityLeaderboardWindow[] = [
  'daily',
  'weekly',
  'all',
  'season',
];

export interface ActivityLeaderboardEntry {
  rank: number;
  avatarId: string;
  agentId: string | null;
  displayName: string;
  totalPoints: number;
  wins: number;
  matches: number;
  /** Reef Race only — best (lowest) finish time in ms. Omitted otherwise. */
  bestTimeMs?: number | null;
  lastSeen: string;
}

export interface ActivityLeaderboardSnapshot {
  activityId: string;
  window: ActivityLeaderboardWindow;
  season: { id: string; name: string } | null;
  generatedAt: string;
  total: number;
  leaderboard: ActivityLeaderboardEntry[];
}

interface CacheEntry {
  snapshot: ActivityLeaderboardSnapshot;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(
  activityId: string,
  window: ActivityLeaderboardWindow,
  seasonId: string | null,
): string {
  return `${activityId}|${window}|${seasonId ?? 'none'}`;
}

/**
 * Compute the time bound for a given window. Returns `null` for `all`.
 * `season` returns the active season's `started_at` (caller falls back
 * to `all` semantics if no active season exists).
 */
async function windowBound(
  window: ActivityLeaderboardWindow,
): Promise<{ startedAt: Date | null; season: ActivitySeason | null }> {
  const now = Date.now();
  switch (window) {
    case 'daily': {
      const today = new Date(now - 86_400_000);
      return { startedAt: today, season: null };
    }
    case 'weekly': {
      const weekAgo = new Date(now - 7 * 86_400_000);
      return { startedAt: weekAgo, season: null };
    }
    case 'all':
      return { startedAt: null, season: null };
    case 'season': {
      const active = await getActiveSeason();
      if (!active) return { startedAt: null, season: null };
      return { startedAt: active.startedAt, season: active };
    }
  }
}

/**
 * Build a fresh snapshot for `(activityId, window)`. Skips bots,
 * aggregates per avatar, joins avatar names. Reef Race rows include
 * `bestTimeMs` (min of `score_ms`).
 */
export async function buildLeaderboardSnapshot(
  activityId: string,
  window: ActivityLeaderboardWindow,
  limit = 100,
  offset = 0,
): Promise<ActivityLeaderboardSnapshot> {
  const { startedAt, season } = await windowBound(window);

  const conditions = [
    eq(activityResults.activityId, activityId),
    ne(activityResults.subjectType, 'bot'),
    // Guest avatar carve-out (2026-04-23) — un-authed visitors play matches
    // and earn ClawTokens, but their results don't enter per-activity
    // leaderboards. Mirrors the bot exclusion above. The pre-fetch of
    // guest avatarIds is cheap (small index, partial WHERE clause) and lets
    // us keep the existing GROUP BY shape unchanged.
    sql`NOT EXISTS (
      SELECT 1 FROM ${avatars} AS gp
      WHERE gp.id = ${activityResults.avatarId}
        AND gp.is_guest = true
    )`,
  ];
  if (startedAt) conditions.push(gte(activityResults.createdAt, startedAt));

  const rows = await db
    .select({
      avatarId: activityResults.avatarId,
      agentId: activityResults.agentId,
      totalPoints: sql<number>`coalesce(sum(${activityResults.leaderboardPoints}), 0)::int`,
      wins: sql<number>`count(*) filter (where ${activityResults.placement} = 1)::int`,
      matches: sql<number>`count(*)::int`,
      bestTimeMs: sql<number | null>`min(${activityResults.scoreMs})`,
      lastSeen: sql<string>`max(${activityResults.createdAt})::text`,
    })
    .from(activityResults)
    .where(and(...conditions))
    .groupBy(activityResults.avatarId, activityResults.agentId);

  // Join avatar names — single batch lookup.
  const avatarIds = rows.map((r) => r.avatarId);
  const avatarNamesById = new Map<string, string>();
  if (avatarIds.length > 0) {
    const avatarRows = await db
      .select({ id: avatars.id, name: avatars.name })
      .from(avatars)
      .where(avatarInListWhere(avatarIds));
    for (const p of avatarRows) avatarNamesById.set(p.id, p.name);
  }

  // Sort: total points DESC, ties broken by wins DESC, then matches DESC.
  const sorted = [...rows].sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.matches - a.matches;
  });

  const showBestTime = activityId === 'reef-race';
  const sliced = sorted.slice(offset, offset + limit);
  const leaderboard: ActivityLeaderboardEntry[] = sliced.map((r, i) => ({
    rank: offset + i + 1,
    avatarId: r.avatarId,
    agentId: r.agentId,
    displayName: avatarNamesById.get(r.avatarId) ?? r.avatarId.slice(0, 8),
    totalPoints: Number(r.totalPoints) || 0,
    wins: Number(r.wins) || 0,
    matches: Number(r.matches) || 0,
    bestTimeMs: showBestTime ? r.bestTimeMs : undefined,
    lastSeen: r.lastSeen,
  }));

  return {
    activityId,
    window,
    season: season ? { id: season.id, name: season.name } : null,
    generatedAt: new Date().toISOString(),
    total: sorted.length,
    leaderboard,
  };
}

/** Cache-fronted snapshot accessor. */
export async function getLeaderboardSnapshot(
  activityId: string,
  window: ActivityLeaderboardWindow,
  limit = 100,
  offset = 0,
): Promise<ActivityLeaderboardSnapshot> {
  // We cache the full set (limit=100, offset=0) and slice on read; the
  // cache key omits limit+offset so multiple paginated calls share one
  // cache entry.
  const seasonId = window === 'season' ? (await getActiveSeason())?.id ?? null : null;
  const key = cacheKey(activityId, window, seasonId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return sliceSnapshot(hit.snapshot, limit, offset);
  }

  const fresh = await buildLeaderboardSnapshot(activityId, window, 100, 0);
  cache.set(key, { snapshot: fresh, expiresAt: Date.now() + CACHE_TTL_MS });
  return sliceSnapshot(fresh, limit, offset);
}

function sliceSnapshot(
  snap: ActivityLeaderboardSnapshot,
  limit: number,
  offset: number,
): ActivityLeaderboardSnapshot {
  const sliced = snap.leaderboard.slice(offset, offset + limit);
  return {
    ...snap,
    leaderboard: sliced.map((e, i) => ({ ...e, rank: offset + i + 1 })),
  };
}

/**
 * Compute "my rank" with N above and N below. Used by
 * `GET /api/activities/:id/leaderboard/me`.
 */
export async function getLeaderboardForAvatar(
  activityId: string,
  window: ActivityLeaderboardWindow,
  avatarId: string,
  context = 5,
): Promise<{
  snapshot: ActivityLeaderboardSnapshot;
  myRank: number | null;
  myEntry: ActivityLeaderboardEntry | null;
  context: ActivityLeaderboardEntry[];
}> {
  // Always pull the full ranked set (cap 100) for the slice math.
  const full = await getLeaderboardSnapshot(activityId, window, 100, 0);
  const myIndex = full.leaderboard.findIndex((e) => e.avatarId === avatarId);
  if (myIndex < 0) {
    return {
      snapshot: full,
      myRank: null,
      myEntry: null,
      context: full.leaderboard.slice(0, context),
    };
  }
  const start = Math.max(0, myIndex - context);
  const end = Math.min(full.leaderboard.length, myIndex + context + 1);
  return {
    snapshot: full,
    myRank: full.leaderboard[myIndex].rank,
    myEntry: full.leaderboard[myIndex],
    context: full.leaderboard.slice(start, end),
  };
}

export function invalidateLeaderboardCache(activityId?: string): void {
  if (!activityId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${activityId}|`)) cache.delete(key);
  }
}

/**
 * Tiny helper for the avatarName batch fetch. Drizzle's `inArray` is the
 * canonical path; this thin wrapper exists so the call site reads
 * cleanly + we can unit-test without a real `avatars` table when the test
 * doesn't care about names.
 */
function avatarInListWhere(avatarIds: string[]): ReturnType<typeof sql> {
  if (avatarIds.length === 0) return sql`false`;
  return sql`${avatars.id} in (${sql.join(
    avatarIds.map((id) => sql`${id}`),
    sql.raw(', '),
  )})`;
}
