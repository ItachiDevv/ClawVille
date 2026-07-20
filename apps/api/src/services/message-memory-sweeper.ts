/**
 * Prunes stale ElizaOS conversation transcripts from plugin-sql's `memories`
 * table. Conversation messages are only the live coherence window; durable
 * agent knowledge is stored under a different memory type and is never touched.
 */

import { db, sql } from '@clawville/database';

const DEFAULT_RETENTION_DAYS = 7;
const MIN_RETENTION_DAYS = 1;
const MAX_BATCHES_PER_SWEEP = 50;
const BATCH_PAUSE_MS = 250;
const SETTLE_DELAY_MS = 2 * 60 * 1000;
const SWEEP_PERIOD_MS = 24 * 60 * 60 * 1000;

/** Resolve once at module initialization for the process lifetime. */
export function resolveMessageMemoryRetentionDays(
  raw: string | undefined = process.env.MESSAGE_MEMORY_RETENTION_DAYS,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RETENTION_DAYS;
  if (parsed === 0) return 0;
  if (parsed < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS;
  if (!Number.isInteger(parsed)) return DEFAULT_RETENTION_DAYS;
  return parsed;
}

const configuredRetentionDays = resolveMessageMemoryRetentionDays();

/** Narrow injectable seams keep the batch loop unit-testable without Postgres. */
export const messageMemorySweeperSeams = {
  retentionDays: configuredRetentionDays,
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

export type MessageMemorySweepResult = {
  pruned: number;
  batches: number;
};

/**
 * Run one bounded prune pass. Fail-soft by design: a database/pooler failure is
 * logged and the next daily sweep retries.
 */
export async function sweepMessageMemories(): Promise<MessageMemorySweepResult> {
  const retentionDays = messageMemorySweeperSeams.retentionDays;
  if (retentionDays === 0) return { pruned: 0, batches: 0 };

  const startedAt = Date.now();
  let pruned = 0;
  let batches = 0;

  try {
    while (batches < MAX_BATCHES_PER_SWEEP) {
      // REGRESSION-FROZEN: the type filter is load-bearing. `type='knowledge'`
      // holds teacher-corpus, earned-skill, protocol-knowledge, and book rows;
      // deleting any of those lobotomizes agents. Every DELETE must retain the
      // literal `type = 'messages'` predicate below.
      //
      // `embeddings.memory_id -> memories.id` is ON DELETE CASCADE (message rows
      // have no embeddings anyway), so no manual embeddings cleanup belongs here.
      const deleteQuery = sql`
        DELETE FROM memories
        WHERE id IN (
          SELECT id FROM memories
          WHERE type = 'messages'
            AND created_at < now() - make_interval(days => ${retentionDays})
          LIMIT 2000
        )
      `;

      batches += 1;
      const deleted = await messageMemorySweeperSeams.executeBatch(deleteQuery);
      pruned += deleted;
      if (deleted === 0) break;

      if (batches === MAX_BATCHES_PER_SWEEP) {
        console.warn(
          `[MessageMemorySweeper] batch cap hit (${MAX_BATCHES_PER_SWEEP}); remaining rows roll to the next sweep`,
        );
        break;
      }

      await messageMemorySweeperSeams.pause(BATCH_PAUSE_MS);
    }
  } catch (err) {
    console.error('[MessageMemorySweeper] sweep failed:', err);
    return { pruned, batches };
  }

  console.log(
    `[MessageMemorySweeper] pruned ${pruned} message rows older than ${retentionDays}d in ${Date.now() - startedAt}ms (${batches} batches)`,
  );
  return { pruned, batches };
}

let started = false;
let settleTimeout: ReturnType<typeof setTimeout> | null = null;
let sweepInterval: ReturnType<typeof setInterval> | null = null;

/** Start after the boot settle window, then sweep once per day. Idempotent. */
export function startMessageMemorySweeper(): void {
  if (started) return;
  started = true;

  if (messageMemorySweeperSeams.retentionDays === 0) {
    console.log('[MessageMemorySweeper] disabled (MESSAGE_MEMORY_RETENTION_DAYS=0)');
    return;
  }

  settleTimeout = setTimeout(() => {
    settleTimeout = null;
    void sweepMessageMemories();
    sweepInterval = setInterval(() => {
      void sweepMessageMemories();
    }, SWEEP_PERIOD_MS);
  }, SETTLE_DELAY_MS);
}

/** Stop pending/recurring timers during graceful shutdown. Idempotent. */
export function stopMessageMemorySweeper(): void {
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
