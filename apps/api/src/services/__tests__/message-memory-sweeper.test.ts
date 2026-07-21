import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  messageMemorySweeperSeams,
  resolveMessageMemoryRetentionDays,
  startMessageMemorySweeper,
  stopMessageMemorySweeper,
  sweepMessageMemories,
} from '../message-memory-sweeper';

const originalExecutor = messageMemorySweeperSeams.executeBatch;
const originalPause = messageMemorySweeperSeams.pause;
const originalRetentionDays = messageMemorySweeperSeams.retentionDays;
const originalRetentionEnv = process.env.MESSAGE_MEMORY_RETENTION_DAYS;

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
  stopMessageMemorySweeper();
  messageMemorySweeperSeams.retentionDays = 7;
  messageMemorySweeperSeams.pause = async () => {};
});

afterEach(() => {
  stopMessageMemorySweeper();
  messageMemorySweeperSeams.executeBatch = originalExecutor;
  messageMemorySweeperSeams.pause = originalPause;
  messageMemorySweeperSeams.retentionDays = originalRetentionDays;
  if (originalRetentionEnv === undefined) {
    delete process.env.MESSAGE_MEMORY_RETENTION_DAYS;
  } else {
    process.env.MESSAGE_MEMORY_RETENTION_DAYS = originalRetentionEnv;
  }
});

describe('message-memory retention parsing', () => {
  it('defaults to 7 days when the env var is unset or invalid', () => {
    delete process.env.MESSAGE_MEMORY_RETENTION_DAYS;
    expect(resolveMessageMemoryRetentionDays()).toBe(7);
    expect(resolveMessageMemoryRetentionDays('not-a-number')).toBe(7);
    expect(resolveMessageMemoryRetentionDays('-2')).toBe(7);
    expect(resolveMessageMemoryRetentionDays('1.9')).toBe(7);
  });

  it('clamps positive values below the 1-day floor to 1', () => {
    expect(resolveMessageMemoryRetentionDays('0.5')).toBe(1);
  });
});

describe('message-memory sweep', () => {
  it("deletes only type='messages' rows and binds the retention days", async () => {
    const queries: unknown[] = [];
    messageMemorySweeperSeams.executeBatch = async (query) => {
      queries.push(query);
      return 0;
    };

    await sweepMessageMemories();

    expect(queries).toHaveLength(1);
    const { text, params } = flattenSql(queries[0]);
    const normalized = text.replace(/\s+/g, ' ').trim();
    expect(normalized).toContain('DELETE FROM memories');
    expect(normalized).toMatch(/WHERE type = 'messages' AND created_at/);
    expect(normalized).toContain('LIMIT 2000');
    expect(normalized.match(/type\s*=\s*'[^']+'/g)).toEqual(["type = 'messages'"]);
    expect(params).toEqual([7]);
  });

  it('disables all execution when retention is 0 and logs boot once', async () => {
    const execute = mock(async () => 0);
    const log = mock(() => {});
    const originalLog = console.log;
    console.log = log;
    messageMemorySweeperSeams.retentionDays = 0;
    messageMemorySweeperSeams.executeBatch = execute;
    try {
      startMessageMemorySweeper();
      startMessageMemorySweeper();
      expect(await sweepMessageMemories()).toEqual({ pruned: 0, batches: 0 });
      expect(execute).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        '[MessageMemorySweeper] disabled (MESSAGE_MEMORY_RETENTION_DAYS=0)',
      );
    } finally {
      console.log = originalLog;
    }
  });

  it('continues batch deletes until a batch reports 0 rows', async () => {
    const results = [2000, 3, 0];
    const execute = mock(async () => results.shift() ?? 0);
    messageMemorySweeperSeams.executeBatch = execute;

    expect(await sweepMessageMemories()).toEqual({ pruned: 2003, batches: 3 });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('stops and warns at the 50-batch runaway cap', async () => {
    const execute = mock(async () => 2000);
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    messageMemorySweeperSeams.executeBatch = execute;
    try {
      expect(await sweepMessageMemories()).toEqual({ pruned: 100_000, batches: 50 });
      expect(execute).toHaveBeenCalledTimes(50);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('catches executor failures without rejecting the sweep', async () => {
    const failure = new Error('pool unavailable');
    const error = mock(() => {});
    const originalError = console.error;
    console.error = error;
    messageMemorySweeperSeams.executeBatch = async () => {
      throw failure;
    };
    try {
      await expect(sweepMessageMemories()).resolves.toEqual({ pruned: 0, batches: 1 });
      expect(error).toHaveBeenCalledWith('[MessageMemorySweeper] sweep failed:', failure);
    } finally {
      console.error = originalError;
    }
  });
});
