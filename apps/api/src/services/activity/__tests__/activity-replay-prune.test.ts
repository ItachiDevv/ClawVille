import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  ACTIVITY_REPLAY_PRUNE_BATCH_SIZE,
  ACTIVITY_REPLAY_PRUNE_MAX_BATCHES,
  ACTIVITY_REPLAY_RETENTION_DAYS,
  activityReplayPruneSeams,
  buildActivityReplayPruneQuery,
  pruneActivityReplays,
  stopActivityReplayPrune,
} from '../activity-replay-prune';

const originalExecutor = activityReplayPruneSeams.executeBatch;
const originalPause = activityReplayPruneSeams.pause;

/** Flatten the text and bound Param values from a Drizzle SQL fragment. */
function flattenSql(query: unknown): { text: string; params: unknown[] } {
  const out = { text: '', params: [] as unknown[] };
  const walk = (node: unknown): void => {
    const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
    if (!Array.isArray(chunks)) return;
    for (const chunk of chunks) {
      const value = (chunk as { value?: unknown } | null)?.value;
      if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
        out.text += value.join('');
      } else if (
        chunk &&
        typeof chunk === 'object' &&
        Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)
      ) {
        walk(chunk);
      } else {
        out.text += ` $${out.params.length + 1} `;
        out.params.push(value ?? chunk);
      }
    }
  };
  walk(query);
  return out;
}

beforeEach(() => {
  stopActivityReplayPrune();
  activityReplayPruneSeams.pause = async () => {};
});

afterEach(() => {
  stopActivityReplayPrune();
  activityReplayPruneSeams.executeBatch = originalExecutor;
  activityReplayPruneSeams.pause = originalPause;
});

describe('activity replay prune query', () => {
  it('deletes only activity_replays rows past 14 days, bounded by LIMIT', () => {
    const { text, params } = flattenSql(buildActivityReplayPruneQuery());
    const normalized = text.replace(/\s+/g, ' ');
    expect(normalized).toContain('DELETE FROM activity_replays');
    expect(normalized).toContain('SELECT id FROM activity_replays');
    expect(normalized).toContain('created_at < now() - make_interval(days =>');
    expect(normalized).toContain('LIMIT');
    expect(params).toEqual([ACTIVITY_REPLAY_RETENTION_DAYS, ACTIVITY_REPLAY_PRUNE_BATCH_SIZE]);
    expect(ACTIVITY_REPLAY_RETENTION_DAYS).toBe(14);
  });
});

describe('activity replay prune loop', () => {
  it('stops after a short batch', async () => {
    const results = [ACTIVITY_REPLAY_PRUNE_BATCH_SIZE, 7];
    let calls = 0;
    activityReplayPruneSeams.executeBatch = async () => results[calls++] ?? 0;
    expect(await pruneActivityReplays()).toEqual({
      pruned: ACTIVITY_REPLAY_PRUNE_BATCH_SIZE + 7,
      batches: 2,
    });
    expect(calls).toBe(2);
  });

  it('runs one batch when nothing is old enough', async () => {
    let calls = 0;
    activityReplayPruneSeams.executeBatch = async () => {
      calls += 1;
      return 0;
    };
    expect(await pruneActivityReplays()).toEqual({ pruned: 0, batches: 1 });
    expect(calls).toBe(1);
  });

  it('stops at the batch cap and leaves the rest for the next sweep', async () => {
    let calls = 0;
    let pauses = 0;
    activityReplayPruneSeams.executeBatch = async () => {
      calls += 1;
      return ACTIVITY_REPLAY_PRUNE_BATCH_SIZE;
    };
    activityReplayPruneSeams.pause = async () => {
      pauses += 1;
    };
    const result = await pruneActivityReplays();
    expect(calls).toBe(ACTIVITY_REPLAY_PRUNE_MAX_BATCHES);
    expect(result).toEqual({
      pruned: ACTIVITY_REPLAY_PRUNE_BATCH_SIZE * ACTIVITY_REPLAY_PRUNE_MAX_BATCHES,
      batches: ACTIVITY_REPLAY_PRUNE_MAX_BATCHES,
    });
    expect(pauses).toBe(ACTIVITY_REPLAY_PRUNE_MAX_BATCHES - 1);
  });

  it('fails soft and returns the partial count on a DB error', async () => {
    let calls = 0;
    activityReplayPruneSeams.executeBatch = async () => {
      calls += 1;
      if (calls === 2) throw new Error('pool down');
      return ACTIVITY_REPLAY_PRUNE_BATCH_SIZE;
    };
    expect(await pruneActivityReplays()).toEqual({
      pruned: ACTIVITY_REPLAY_PRUNE_BATCH_SIZE,
      batches: 2,
    });
  });
});
