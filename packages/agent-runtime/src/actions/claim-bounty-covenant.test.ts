import { describe, expect, it } from 'bun:test';
import { claimBountyAction } from './claim-bounty';
import type { ClawvilleServices } from './types';

interface Harness {
  db: ClawvilleServices['db'];
  tx: object;
  calls: string[];
}

function harness(): Harness {
  const calls: string[] = [];
  const selected = [
    [{
      id: 'bounty-1',
      title: 'Test bounty',
      description: 'Do the thing',
      requirements: null,
      difficulty: 'easy',
      status: 'open',
      tokenReward: 10,
      maxAttempts: 3,
      currentAttempts: 0,
      tags: [],
      expiresAt: null,
      creatorId: 'another-avatar',
    }],
    [],
  ];
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: async () => selected.shift() ?? [],
      }),
    }),
  });
  const tx = {
    insert: () => ({
      values: () => ({
        returning: async () => {
          calls.push('attempt.insert');
          return [{ id: 'attempt-1' }];
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          calls.push('bounty.update');
        },
      }),
    }),
  };
  const db = {
    select,
    transaction: async (work: (transaction: typeof tx) => Promise<unknown>) => {
      calls.push('tx.begin');
      const result = await work(tx);
      calls.push('tx.commit');
      return result;
    },
  };
  return { db, tx, calls };
}

function services(db: ClawvilleServices['db']): ClawvilleServices {
  return {
    db,
    creditClawTokens: async () => ({ balanceAfter: 0 }),
    debitClawTokens: async () => ({ balanceAfter: 0 }),
  };
}

const message = {
  content: {
    text: 'claim bounty',
    parameters: { bountyId: 'bounty-1' },
  },
};

describe('CLAIM_BOUNTY covenant transaction', () => {
  it('wraps attempt + bounty update + uniform bounty.claim record in one tx', async () => {
    const h = harness();
    const injected = services(h.db);
    injected.recordCovenantAction = async (input, tx) => {
      expect(tx).toBe(h.tx);
      expect(input).toEqual({
        action: 'bounty.claim',
        subjectType: 'avatar',
        subjectId: 'avatar-1',
        payload: { bountyId: 'bounty-1', attemptId: 'attempt-1' },
      });
      h.calls.push('covenant.record');
      return { id: 'record-1', deduped: false };
    };

    const result = await claimBountyAction.handler(
      null,
      message,
      { avatarId: 'avatar-1', userId: 'user-1', services: injected },
    );

    expect(result.success).toBe(true);
    expect(h.calls).toEqual([
      'tx.begin',
      'attempt.insert',
      'bounty.update',
      'covenant.record',
      'tx.commit',
    ]);
  });

  it('keeps the native action working when the optional recorder is absent', async () => {
    const h = harness();
    const result = await claimBountyAction.handler(
      null,
      message,
      { avatarId: 'avatar-1', userId: 'user-1', services: services(h.db) },
    );

    expect(result.success).toBe(true);
    expect(h.calls).toEqual([
      'tx.begin',
      'attempt.insert',
      'bounty.update',
      'tx.commit',
    ]);
  });
});
