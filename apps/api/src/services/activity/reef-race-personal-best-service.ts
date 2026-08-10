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

import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  reefRacePersonalBestClaims,
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
  /** True when this room durably owns an actual best-lap improvement. */
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

type PbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface DurableClaim {
  id: string;
  bestLapMs: number;
  previousBestLapMs: number | null;
  dailyRank: number | null;
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
  let replacedCurrentPb = false;

  const result = await db.transaction(async (tx) => {
    // Append-only ownership survives a later/faster room replacing the current
    // PB row, which makes reward rollback → retry deterministic.
    const existingClaim = await loadDurableClaim(tx, input);
    if (existingClaim) return ownedClaimResult(existingClaim, input);

    const priorRows = await tx
      .select({
        bestLapMs: reefRacePersonalBests.bestLapMs,
        sourceRoomId: reefRacePersonalBests.sourceRoomId,
      })
      .from(reefRacePersonalBests)
      .where(
        and(
          eq(reefRacePersonalBests.avatarId, input.avatarId),
          eq(reefRacePersonalBests.activityId, input.activityId),
        ),
      )
      .limit(1);
    const previousMs = priorRows[0]?.bestLapMs ?? null;
    const previousSourceRoomId = priorRows[0]?.sourceRoomId ?? null;

    // Backfill safety for a PB written before the claim-history migration.
    if (
      previousMs === input.newBestLapMs &&
      previousSourceRoomId === input.sourceRoomId
    ) {
      return createOrReloadClaim(tx, input, null);
    }

    if (previousMs !== null && input.newBestLapMs >= previousMs) {
      return unownedResult(previousMs);
    }

    const upsertRows = await tx.execute<{ best_lap_ms: number }>(sql`
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
    `);
    const upserted = Array.isArray(upsertRows)
      ? (upsertRows as Array<{ best_lap_ms: number }>)
      : [];

    if (upserted.length === 0) {
      // The conditional upsert may lose to an equal concurrent settlement of
      // this same room. Re-read after the wait and recognize its durable claim.
      const concurrentClaim = await loadDurableClaim(tx, input);
      return concurrentClaim
        ? ownedClaimResult(concurrentClaim, input)
        : unownedResult(previousMs);
    }

    replacedCurrentPb = true;
    return createOrReloadClaim(tx, input, previousMs);
  });

  if (replacedCurrentPb) {
    invalidatePbGhostCache(input.avatarId);
    try {
      await invalidateDailyCacheLazy();
    } catch (err) {
      console.warn(
        '[reef-race-personal-best] daily cache invalidation failed:',
        err,
      );
    }
  }

  return result;
}

async function loadDurableClaim(
  tx: PbTransaction,
  input: Pick<PbWriteInput, 'sourceRoomId' | 'avatarId'>,
): Promise<DurableClaim | null> {
  const rows = await tx
    .select({
      id: reefRacePersonalBestClaims.id,
      bestLapMs: reefRacePersonalBestClaims.bestLapMs,
      previousBestLapMs: reefRacePersonalBestClaims.previousBestLapMs,
      dailyRank: reefRacePersonalBestClaims.dailyRank,
    })
    .from(reefRacePersonalBestClaims)
    .where(
      and(
        eq(reefRacePersonalBestClaims.sourceRoomId, input.sourceRoomId),
        eq(reefRacePersonalBestClaims.avatarId, input.avatarId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function createOrReloadClaim(
  tx: PbTransaction,
  input: PbWriteInput,
  previousMs: number | null,
): Promise<PbWriteResult> {
  const dailyRank = await computeDailyRank(tx, input.newBestLapMs);
  const [inserted] = await tx
    .insert(reefRacePersonalBestClaims)
    .values({
      sourceRoomId: input.sourceRoomId,
      avatarId: input.avatarId,
      activityId: input.activityId,
      bestLapMs: input.newBestLapMs,
      previousBestLapMs: previousMs,
      dailyRank,
    })
    .onConflictDoNothing({
      target: [
        reefRacePersonalBestClaims.sourceRoomId,
        reefRacePersonalBestClaims.avatarId,
      ],
    })
    .returning({
      id: reefRacePersonalBestClaims.id,
      bestLapMs: reefRacePersonalBestClaims.bestLapMs,
      previousBestLapMs: reefRacePersonalBestClaims.previousBestLapMs,
      dailyRank: reefRacePersonalBestClaims.dailyRank,
    });
  const claim = inserted ?? (await loadDurableClaim(tx, input));
  if (!claim) {
    throw new Error(
      `PB claim missing after successful write for room ${input.sourceRoomId} avatar ${input.avatarId}`,
    );
  }
  return ownedClaimResult(claim, input);
}

function ownedClaimResult(
  claim: DurableClaim,
  input: PbWriteInput,
): PbWriteResult {
  return {
    improved: true,
    claimedBySourceRoom: true,
    previousMs: claim.previousBestLapMs,
    dailyRank: claim.dailyRank,
    newGhostFrames: input.ghostReplayData.frames,
  };
}

function unownedResult(previousMs: number | null): PbWriteResult {
  return {
    improved: false,
    claimedBySourceRoom: false,
    previousMs,
    dailyRank: null,
  };
}

async function computeDailyRank(
  tx: PbTransaction,
  bestLapMs: number,
): Promise<number | null> {
  const rankRows = await tx.execute<{ rank: number }>(sql`
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
