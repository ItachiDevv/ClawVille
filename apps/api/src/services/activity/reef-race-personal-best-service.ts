/**
 * Reef Race Phase 4 — personal-best lap persistence service.
 *
 * Sole writer of the `reef_race_personal_bests` table. Reward pipeline
 * AWAITS `maybeUpdatePersonalBest` per non-bot Reef Race participant; the
 * per-avatar `Promise.all` is bounded by 8 (the pod's per-room participant
 * cap). Total wall-clock <50 ms even when every avatar improves.
 *
 * Critical invariants (from `.claude/plans/reef-race-phase4-detailed.md`):
 *
 * - **C2** — `dailyRank` is computed via a single indexed scan in the SAME
 *   async chain as the upsert (no cache dependency, no race window). The
 *   public 60s daily-leaderboard cache is invalidated on every successful
 *   write so subsequent public reads see the fresh row.
 * - **S4** — the in-memory PB ghost cache is invalidated on every successful
 *   upsert; reconnects within the 5-min TTL see the freshly-set ghost.
 * - **S7** — this module returns the GhostFrame[] verbatim; the caller
 *   (reward pipeline) is responsible for per-recipient gating when
 *   embedding into `event.match_ended.pbDelta.newGhostFrames`.
 *
 * Bots are skipped at the call site (`participant.subjectType === 'bot'`).
 * Anti-cheat-flagged matches are also skipped (any avatar with `flagCount > 0`
 * gets PB write skipped even if the lap was sub-PB).
 */

import { sql } from 'drizzle-orm';
import {
  db,
  reefRacePersonalBests,
  type ReefRacePersonalBest,
} from '@clawville/database';
import type { GhostFrame } from '@clawville/shared';

// Lazy import to avoid a circular service↔service dependency at module
// load time (daily-best-lap service also imports this file's types via
// `ReefRacePersonalBest`).
async function invalidateDailyCacheLazy(): Promise<void> {
  const mod = await import('./reef-race-daily-best-service');
  mod.invalidateDailyBestLapCache();
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface GhostReplayPayload {
  /** Captured frames at GHOST_CAPTURE_HZ. Lap-relative `t`. */
  frames: GhostFrame[];
}

export interface PbWriteInput {
  avatarId: string;
  /** Always 'reef-race' today. Carved out for forward-compat parity. */
  activityId: 'reef-race';
  newBestLapMs: number;
  ghostReplayData: GhostReplayPayload;
  sourceRoomId: string;
}

export interface PbWriteResult {
  /** True only when the PB was actually replaced (newBestLapMs < existing). */
  improved: boolean;
  /**
   * True when this room owns the persisted PB claim. This remains true on
   * an idempotent settlement retry where the PB write succeeded before the
   * reward transaction rolled back.
   */
  claimedBySourceRoom: boolean;
  /** Previous best in ms; null when no prior PB row existed. */
  previousMs: number | null;
  /**
   * 1-indexed daily rank for the PB claim owned by this room. null when the
   * rank scan returned a count >= 100 (off-board) or another room owns it.
   */
  dailyRank: number | null;
  /**
   * The captured frames that were just persisted. Echoed back so the
   * reward pipeline can embed them into `event.match_ended.pbDelta
   * .newGhostFrames` without an extra DB read. Undefined when another room
   * owns the PB claim.
   */
  newGhostFrames?: GhostFrame[];
}

// ─── 5-min in-memory PB ghost cache ───────────────────────────────────────

interface GhostCacheEntry {
  frames: GhostFrame[] | undefined;
  expiresAt: number;
}

const GHOST_CACHE_TTL_MS = 5 * 60_000;
const ghostCache = new Map<string, GhostCacheEntry>();

/**
 * Invalidate the in-memory PB ghost cache for a single avatar. Called from
 * `maybeUpdatePersonalBest` on successful upsert (S4 fix) so a reconnect
 * within the 5-min TTL sees the freshly-set ghost.
 *
 * Exported for tests + the daily-best-lap service to call after any
 * out-of-band mutation (e.g. support tooling backfill).
 */
export function invalidatePbGhostCache(avatarId: string): void {
  ghostCache.delete(avatarId);
}

// Soft eviction so the cache doesn't grow unboundedly across long uptimes.
function pruneExpired(now: number): void {
  for (const [id, entry] of ghostCache) {
    if (entry.expiresAt < now) ghostCache.delete(id);
  }
}

// ─── DB writers ────────────────────────────────────────────────────────────

/**
 * Atomic compare-and-set:
 *   INSERT ... ON CONFLICT (avatar_id, activity_id) DO UPDATE
 *     SET best_lap_ms = EXCLUDED.best_lap_ms,
 *         ghost_replay_data = EXCLUDED.ghost_replay_data,
 *         best_lap_recorded_at = EXCLUDED.best_lap_recorded_at,
 *         source_room_id = EXCLUDED.source_room_id,
 *         updated_at = now()
 *     WHERE EXCLUDED.best_lap_ms < reef_race_personal_bests.best_lap_ms
 *   RETURNING *;
 *
 * If the WHERE predicate fails (existing PB is faster or equal), the row
 * is NOT updated and `RETURNING *` yields zero rows — that's the signal
 * for `improved=false`.
 *
 * On `improved=true`, the function executes a follow-up indexed scan to
 * compute `dailyRank` and invalidates BOTH caches (PB-ghost + daily-best-
 * lap). Both side effects are bounded — the indexed scan is sub-2ms
 * against `idx_reef_race_pb_recorded_lap`; cache invalidation is O(1).
 */
export async function maybeUpdatePersonalBest(
  input: PbWriteInput,
): Promise<PbWriteResult> {
  // Read previous best inside the same connection so we can return it on
  // both improved and no-op paths. Could be folded into the upsert via a
  // CTE, but the explicit two-step reads cleaner and the cost is one
  // indexed point lookup (the unique key).
  const priorRows = await db
    .select({
      bestLapMs: reefRacePersonalBests.bestLapMs,
      sourceRoomId: reefRacePersonalBests.sourceRoomId,
    })
    .from(reefRacePersonalBests)
    .where(
      sql`${reefRacePersonalBests.avatarId} = ${input.avatarId}::uuid AND ${reefRacePersonalBests.activityId} = ${input.activityId}`,
    )
    .limit(1);
  const previousMs = priorRows[0]?.bestLapMs ?? null;
  const previousSourceRoomId = priorRows[0]?.sourceRoomId ?? null;

  // PB persistence intentionally precedes the reward transaction. Preserve
  // the same-room claim on a settlement retry; an equal lap from any other
  // room is only a tie and earns no PB reward.
  if (
    previousMs === input.newBestLapMs &&
    previousSourceRoomId === input.sourceRoomId
  ) {
    return {
      improved: false,
      claimedBySourceRoom: true,
      previousMs,
      dailyRank: await computeDailyRank(input.newBestLapMs),
      newGhostFrames: input.ghostReplayData.frames,
    };
  }

  // No prior row OR improved — INSERT or UPDATE.
  if (previousMs === null || input.newBestLapMs < previousMs) {
    // Single-statement upsert. The WHERE predicate guards against a TOCTOU
    // race where another concurrent write landed a faster lap between our
    // read above and this upsert — in that race, our update is a no-op
    // and we return improved=false.
    const upsertRows = await db.execute<{ best_lap_ms: number }>(
      sql`
        INSERT INTO reef_race_personal_bests
          (avatar_id, activity_id, best_lap_ms, ghost_replay_data, source_room_id)
        VALUES
          (${input.avatarId}::uuid,
           ${input.activityId},
           ${input.newBestLapMs},
           ${sql`${JSON.stringify(input.ghostReplayData)}::jsonb`},
           ${input.sourceRoomId}::uuid)
        ON CONFLICT (avatar_id, activity_id) DO UPDATE
          SET best_lap_ms = EXCLUDED.best_lap_ms,
              ghost_replay_data = EXCLUDED.ghost_replay_data,
              best_lap_recorded_at = now(),
              source_room_id = EXCLUDED.source_room_id,
              updated_at = now()
          WHERE EXCLUDED.best_lap_ms < reef_race_personal_bests.best_lap_ms
        RETURNING best_lap_ms
      `,
    );
    const upserted = Array.isArray(upsertRows)
      ? (upsertRows as Array<{ best_lap_ms: number }>)
      : [];
    if (upserted.length === 0) {
      // Predicate-blocked update (concurrent faster write landed). Still
      // counts as no-op from our perspective.
      return {
        improved: false,
        claimedBySourceRoom: false,
        previousMs,
        dailyRank: null,
      };
    }
    // Compute dailyRank in the same async chain via a single indexed scan
    // against idx_reef_race_pb_recorded_lap (C2 fix — never the cache).
    const dailyRank = await computeDailyRank(input.newBestLapMs);

    // S4 fix — flush PB ghost cache for this avatar so a reconnect within
    // the 5-min TTL sees the freshly-set ghost. C2 fix — flush the public
    // daily-best-lap cache so the next /leaderboard read sees the new row.
    invalidatePbGhostCache(input.avatarId);
    try {
      await invalidateDailyCacheLazy();
    } catch (err) {
      // Cache invalidation failure is non-fatal — at worst the public
      // surface lags one round-trip. Log + continue.
      console.warn(
        '[reef-race-personal-best] daily cache invalidation failed:',
        err,
      );
    }

    return {
      improved: true,
      claimedBySourceRoom: true,
      previousMs,
      dailyRank,
      newGhostFrames: input.ghostReplayData.frames,
    };
  }

  return {
    improved: false,
    claimedBySourceRoom: false,
    previousMs,
    dailyRank: null,
  };
}

async function computeDailyRank(bestLapMs: number): Promise<number | null> {
  const rankRows = await db.execute<{ rank: number }>(sql`
    SELECT count(*)::int + 1 AS rank
    FROM reef_race_personal_bests
    WHERE activity_id = 'reef-race'
      AND best_lap_recorded_at > now() - interval '24 hours'
      AND best_lap_ms < ${bestLapMs}
  `);
  const rank =
    Array.isArray(rankRows) && rankRows.length > 0
      ? Number((rankRows[0] as { rank: number }).rank) || 1
      : 1;
  return rank > 100 ? null : rank;
}

/**
 * Read the latest PB row for an avatar. Hot path on snapshot.init for self avatar.
 * Returns null when the avatar has no PB yet (the common case for fresh avatars).
 */
export async function loadPersonalBest(
  avatarId: string,
): Promise<ReefRacePersonalBest | null> {
  const rows = await db
    .select()
    .from(reefRacePersonalBests)
    .where(
      sql`${reefRacePersonalBests.avatarId} = ${avatarId}::uuid AND ${reefRacePersonalBests.activityId} = 'reef-race'`,
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Read just the captured ghost frames for an avatar. 5-min TTL in-memory cache
 * keyed by avatarId; invalidated by `maybeUpdatePersonalBest` on successful
 * upsert (S4 fix).
 *
 * Returns `undefined` on any error or when no PB exists. Logged via
 * console.warn (NOT alertError — missing PB is common for fresh avatars).
 */
export async function loadPersonalBestGhostFrames(
  avatarId: string,
): Promise<GhostFrame[] | undefined> {
  const now = Date.now();
  pruneExpired(now);
  const cached = ghostCache.get(avatarId);
  if (cached && cached.expiresAt > now) {
    return cached.frames;
  }
  let frames: GhostFrame[] | undefined;
  try {
    const row = await loadPersonalBest(avatarId);
    if (row) {
      const blob = row.ghostReplayData as unknown as {
        frames?: GhostFrame[];
      };
      if (Array.isArray(blob?.frames)) {
        frames = blob.frames as GhostFrame[];
      }
    }
  } catch (err) {
    console.warn(
      `[reef-race-personal-best] loadPersonalBestGhostFrames failed for avatar ${avatarId}:`,
      err,
    );
    // Cache the miss briefly so a transient DB error doesn't pile up
    // retries on every WS reconnect.
    ghostCache.set(avatarId, { frames: undefined, expiresAt: now + 30_000 });
    return undefined;
  }
  ghostCache.set(avatarId, { frames, expiresAt: now + GHOST_CACHE_TTL_MS });
  return frames;
}

/** Test hook — clear the in-memory ghost cache. */
export function __resetPbGhostCacheForTest(): void {
  ghostCache.clear();
}
