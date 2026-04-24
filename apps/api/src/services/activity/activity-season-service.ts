/**
 * Q2 Activity Portals — season catalog (chunk #7).
 *
 * Single in-memory cache for `activity_seasons` reads + a one-shot
 * "ensure first season" helper that lazy-creates `2026-Q2-S1` on first
 * call. Locked decision §3 in the master plan: 30-day duration,
 * activities = ['bumper-shells', 'reef-race'].
 *
 * The helper is idempotent — if any season exists (active or past), the
 * helper does nothing. This avoids needing a boot-time hook AND makes
 * tests trivial (call once → row exists; call twice → no second insert).
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { db, activitySeasons, type ActivitySeason } from '@clawville/database';

const FIRST_SEASON_NAME = '2026-Q2-S1';
const FIRST_SEASON_DAYS = 30;
const FIRST_SEASON_ACTIVITIES = ['bumper-shells', 'reef-race'];

interface SeasonsCache {
  active: ActivitySeason | null;
  past: ActivitySeason[];
  expiresAt: number;
}

const SEASON_CACHE_TTL_MS = 60_000;
let seasonsCache: SeasonsCache | null = null;

/**
 * Ensure at least one season row exists. Auto-creates `2026-Q2-S1` if
 * the table is empty. Safe to call repeatedly + concurrently.
 */
export async function ensureFirstSeason(): Promise<void> {
  // Fast path — cached "any season exists" check.
  if (seasonsCache && (seasonsCache.active || seasonsCache.past.length > 0)) {
    return;
  }

  // Race-safe: if another caller is mid-create the unique-name
  // constraint on `activity_seasons.name` will reject the duplicate
  // INSERT and we silently swallow the error. The next read picks up
  // the row created by the winner.
  const existing = await db
    .select({ id: activitySeasons.id })
    .from(activitySeasons)
    .limit(1);
  if (existing.length > 0) return;

  const now = new Date();
  const endsAt = new Date(now.getTime() + FIRST_SEASON_DAYS * 86_400_000);

  try {
    await db.insert(activitySeasons).values({
      name: FIRST_SEASON_NAME,
      activityIds: FIRST_SEASON_ACTIVITIES,
      startedAt: now,
      endsAt,
      active: true,
    });
    // Bust the cache so the next read pulls the new row.
    seasonsCache = null;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === '23505') {
      // unique_violation — a parallel caller won the race. Ignore.
      return;
    }
    throw err;
  }
}

/**
 * Return active + past seasons. Cache-fronted with a 60s TTL since the
 * catalog rarely changes. Bust via `invalidateSeasonsCache()` after admin
 * mutations (none today; reserved for the future season-rotation path).
 */
export async function getSeasonsCatalog(): Promise<{
  active: ActivitySeason | null;
  past: ActivitySeason[];
}> {
  if (seasonsCache && seasonsCache.expiresAt > Date.now()) {
    return { active: seasonsCache.active, past: seasonsCache.past };
  }

  await ensureFirstSeason();

  const rows = await db
    .select()
    .from(activitySeasons)
    .orderBy(desc(activitySeasons.startedAt));

  const active = rows.find((r) => r.active === true) ?? null;
  const past = rows.filter((r) => r.id !== active?.id);

  seasonsCache = {
    active,
    past,
    expiresAt: Date.now() + SEASON_CACHE_TTL_MS,
  };
  return { active, past };
}

/** Lookup helper for the leaderboard "season" window — returns the active row. */
export async function getActiveSeason(): Promise<ActivitySeason | null> {
  const { active } = await getSeasonsCatalog();
  return active;
}

export function invalidateSeasonsCache(): void {
  seasonsCache = null;
}

// Re-exported for the routes that surface season metadata.
export { activitySeasons };
// Suppress unused-import warnings — kept for future query helpers.
void and;
void eq;
void sql;
