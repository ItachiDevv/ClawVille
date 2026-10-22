/**
 * 14-day retention prune for `activity_replays`.
 *
 * `activity-replay-log.ts` writes one row per finished match (up to ~1.7 MB
 * of jsonb frames). Rooms are never deleted, so the room_id ON DELETE CASCADE
 * never fires, and without this sweep the table grows forever.
 *
 * Nothing reads `activity_replays` today (Reef Race ghosts live in
 * `reef_race_personal_bests.ghost_replay_data`) and no table has a foreign
 * key into `activity_replays.id`, so a DELETE has no dependants.
 *
 * Shape mirrors `services/message-memory-sweeper.ts`: bounded batches with a
 * short pause, a per-sweep batch cap, a boot settle delay, then once a day.
 * Fail-soft: an error is logged and the next sweep retries.
 */

import { db, sql } from '@clawville/database';

export const ACTIVITY_REPLAY_RETENTION_DAYS = 14;
/** Rows per DELETE. Small because each row can carry ~1.7 MB of jsonb. */
export const ACTIVITY_REPLAY_PRUNE_BATCH_SIZE = 200;
export const ACTIVITY_REPLAY_PRUNE_MAX_BATCHES = 50;
const BATCH_PAUSE_MS = 250;
const SETTLE_DELAY_MS = 3 * 60 * 1000;
const SWEEP_PERIOD_MS = 24 * 60 * 60 * 1000;

/** Build one bounded DELETE batch. Exported for tests. */
export function buildActivityReplayPruneQuery(
  retentionDays: number = ACTIVITY_REPLAY_RETENTION_DAYS,
  batchSize: number = ACTIVITY_REPLAY_PRUNE_BATCH_SIZE,
) {
  return sql`
    DELETE FROM activity_replays
    WHERE id IN (
      SELECT id FROM activity_replays
      WHERE created_at < now() - make_interval(days => ${retentionDays})
      LIMIT ${batchSize}
    )
  `;
}

/** Injectable seams keep the batch loop unit-testable without Postgres. */
export const activityReplayPruneSeams = {
  executeBatch: async (query: ReturnType<typeof sql>): Promise<number> => {
    const result = await db.execute(query);
    const metadata = result as unknown as { count?: number; rowCount?: number };
    return metadata.count ?? metadata.rowCount ?? 0;
  },
  pause: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export type ActivityReplayPruneResult = {
  pruned: number;
  batches: number;
};

/** Run one bounded prune pass. */
export async function pruneActivityReplays(): Promise<ActivityReplayPruneResult> {
  let pruned = 0;
  let batches = 0;

  try {
    while (batches < ACTIVITY_REPLAY_PRUNE_MAX_BATCHES) {
      batches += 1;
      const deleted = await activityReplayPruneSeams.executeBatch(
        buildActivityReplayPruneQuery(),
      );
      pruned += deleted;
      // A short batch means nothing older is left.
      if (deleted < ACTIVITY_REPLAY_PRUNE_BATCH_SIZE) break;

      if (batches === ACTIVITY_REPLAY_PRUNE_MAX_BATCHES) {
        console.warn(
          `[ActivityReplayPrune] batch cap hit (${ACTIVITY_REPLAY_PRUNE_MAX_BATCHES}); remaining rows roll to the next sweep`,
        );
        break;
      }

      await activityReplayPruneSeams.pause(BATCH_PAUSE_MS);
    }
  } catch (err) {
    console.error('[ActivityReplayPrune] sweep failed:', err);
    return { pruned, batches };
  }

  if (pruned > 0) {
    console.log(
      `[ActivityReplayPrune] pruned ${pruned} replay rows older than ${ACTIVITY_REPLAY_RETENTION_DAYS}d (${batches} batches)`,
    );
  }
  return { pruned, batches };
}

let started = false;
let settleTimeout: ReturnType<typeof setTimeout> | null = null;
let sweepInterval: ReturnType<typeof setInterval> | null = null;

/** Start after the boot settle window, then sweep once per day. Idempotent. */
export function startActivityReplayPrune(): void {
  if (started) return;
  started = true;

  settleTimeout = setTimeout(() => {
    settleTimeout = null;
    void pruneActivityReplays();
    sweepInterval = setInterval(() => {
      void pruneActivityReplays();
    }, SWEEP_PERIOD_MS);
  }, SETTLE_DELAY_MS);
}

/** Stop pending/recurring timers during graceful shutdown. Idempotent. */
export function stopActivityReplayPrune(): void {
  started = false;
  if (settleTimeout) {
    clearTimeout(settleTimeout);
    settleTimeout = null;
  }
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
