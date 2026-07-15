import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realDatabase from '@clawville/database';
import * as realLedger from '../claw-token-ledger';

interface XpRow {
  id: string;
  xp: number;
  level: number;
  total_xp: number;
}

const AVATAR_ID = '00000000-0000-4000-8000-000000000001';

let row: XpRow;
let lockTail: Promise<void>;
let creditShouldFail: boolean;
let lockQueries: string[];
let creditCalls: Array<{
  input: Parameters<typeof realLedger.creditClawTokens>[0];
  tx: unknown;
}>;
const activeTransactions = new Set<unknown>();

function renderSql(query: unknown): { text: string; params: unknown[] } {
  const rendered = { text: '', params: [] as unknown[] };
  const walk = (node: unknown): void => {
    for (const chunk of (node as { queryChunks?: unknown[] })?.queryChunks ?? []) {
      const name = (chunk as { constructor?: { name?: string } })?.constructor?.name;
      if (name === 'StringChunk') {
        const value = (chunk as { value: unknown }).value;
        rendered.text += Array.isArray(value) ? value.join('') : String(value);
      } else if (name === 'SQL') {
        walk(chunk);
      } else if (name === 'Param') {
        rendered.params.push((chunk as { value: unknown }).value);
        rendered.text += '?';
      } else if (name === 'String' || name === 'Number' || name === 'BigInt') {
        rendered.params.push((chunk as { valueOf(): unknown }).valueOf());
        rendered.text += '?';
      }
    }
  };
  walk(query);
  return rendered;
}

function makeTx() {
  let releaseLock: (() => void) | null = null;
  let lockedRowId: string | null = null;
  let snapshot: XpRow | null = null;

  const tx = {
    async execute(query: unknown) {
      const rendered = renderSql(query);
      const normalized = rendered.text.replace(/\s+/g, ' ').trim();
      lockQueries.push(normalized);
      if (!normalized.includes('FROM avatars') || !normalized.includes('FOR UPDATE')) {
        throw new Error(`expected avatar SELECT FOR UPDATE, got: ${normalized}`);
      }

      const avatarId = String(rendered.params[0]);
      const previousLock = lockTail;
      lockTail = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      await previousLock;

      lockedRowId = avatarId;
      snapshot = avatarId === row.id ? { ...row } : null;
      return snapshot ? [{ ...snapshot }] : [];
    },
    update(_table: unknown) {
      return {
        set(values: { xp: number; level: number; totalXp: number }) {
          return {
            async where(_condition: unknown) {
              if (lockedRowId !== row.id) {
                throw new Error('XP update attempted without the avatar row lock');
              }
              row = {
                ...row,
                xp: values.xp,
                level: values.level,
                total_xp: values.totalXp,
              };
            },
          };
        },
      };
    },
  };

  return {
    tx,
    rollback() {
      if (snapshot) row = snapshot;
    },
    release() {
      releaseLock?.();
    },
  };
}

const fakeDb = {
  async transaction<T>(run: (tx: ReturnType<typeof makeTx>['tx']) => Promise<T>): Promise<T> {
    const transaction = makeTx();
    activeTransactions.add(transaction.tx);
    try {
      return await run(transaction.tx);
    } catch (error) {
      transaction.rollback();
      throw error;
    } finally {
      activeTransactions.delete(transaction.tx);
      transaction.release();
    }
  },
};

mock.module('@clawville/database', () => ({
  ...realDatabase,
  db: fakeDb,
}));

mock.module('../claw-token-ledger', () => ({
  ...realLedger,
  creditClawTokens: async (
    input: Parameters<typeof realLedger.creditClawTokens>[0],
    tx?: unknown,
  ) => {
    if (!tx || !activeTransactions.has(tx)) {
      throw new Error('creditClawTokens must receive the active XP transaction');
    }
    creditCalls.push({ input, tx });
    if (creditShouldFail) throw new Error('simulated ledger failure');
    return { balanceAfter: input.amount, ledgerId: 'ledger-test-id' };
  },
}));

const { awardXp } = await import('../xp-service');

beforeEach(() => {
  row = { id: AVATAR_ID, xp: 95, level: 1, total_xp: 95 };
  lockTail = Promise.resolve();
  creditShouldFail = false;
  lockQueries = [];
  creditCalls = [];
  activeTransactions.clear();
});

describe('awardXp concurrency', () => {
  it('serializes threshold-crossing awards and mints one level-up bonus', async () => {
    const results = await Promise.all([
      awardXp(AVATAR_ID, 5, 'npc-chat'),
      awardXp(AVATAR_ID, 5, 'npc-chat'),
    ]);

    expect(row).toEqual({ id: AVATAR_ID, xp: 5, level: 2, total_xp: 105 });
    expect(results.map((result) => result.tokensAwarded).sort((a, b) => a - b)).toEqual([0, 50]);
    expect(results.map((result) => result.levelsGained).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(creditCalls).toHaveLength(1);
    expect(creditCalls[0]!.input).toMatchObject({
      avatarId: AVATAR_ID,
      amount: 50,
      reason: 'level_up',
      source: 'system',
      metadata: { levelsGained: 1, newLevel: 2, xpSource: 'npc-chat' },
    });
    expect(lockQueries).toHaveLength(2);
    expect(lockQueries.every((query) => query.includes('FOR UPDATE'))).toBe(true);
  });

  it('rolls back XP metadata when the ledger mint fails', async () => {
    creditShouldFail = true;

    await expect(awardXp(AVATAR_ID, 5, 'npc-chat')).rejects.toThrow(
      'simulated ledger failure',
    );

    expect(row).toEqual({ id: AVATAR_ID, xp: 95, level: 1, total_xp: 95 });
    expect(creditCalls).toHaveLength(1);
    expect(lockQueries).toHaveLength(1);
    expect(lockQueries[0]).toContain('FOR UPDATE');
  });
});
