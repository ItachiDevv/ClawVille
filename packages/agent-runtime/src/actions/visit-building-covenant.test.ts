import { describe, expect, it } from 'bun:test';
import { visitBuildingAction } from './visit-building';
import type { ClawvilleServices } from './types';

function harness() {
  const calls: string[] = [];
  const tx = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          calls.push('position.update');
          expect(values).toEqual(expect.objectContaining({
            positionX: expect.any(Number),
            positionY: expect.any(Number),
            lastActiveAt: expect.any(Date),
          }));
        },
      }),
    }),
  };
  const db = {
    transaction: async (work: (transaction: typeof tx) => Promise<void>) => {
      calls.push('tx.begin');
      await work(tx);
      calls.push('tx.commit');
    },
  };
  return { db, tx, calls };
}

function baseServices(db: ClawvilleServices['db']): ClawvilleServices {
  return {
    db,
    creditClawTokens: async () => ({ balanceAfter: 0 }),
    debitClawTokens: async () => ({ balanceAfter: 0 }),
  };
}

const message = {
  content: {
    text: 'visit the Chum Bucket',
    parameters: { buildingId: 'code-development' },
  },
};

describe('VISIT_BUILDING covenant transaction', () => {
  it('updates position and records agent.visit inside the same tx', async () => {
    const h = harness();
    const services = baseServices(h.db);
    services.recordCovenantAction = async (input, tx) => {
      expect(tx).toBe(h.tx);
      expect(input).toEqual({
        action: 'agent.visit',
        subjectType: 'avatar',
        subjectId: 'avatar-1',
        payload: { destination: 'code-development' },
      });
      h.calls.push('covenant.record');
      return { id: 'visit-record', deduped: false };
    };

    const result = await visitBuildingAction.handler(
      null,
      message,
      { avatarId: 'avatar-1', userId: 'user-1', services },
    );

    expect(result.success).toBe(true);
    expect(h.calls).toEqual([
      'tx.begin',
      'position.update',
      'covenant.record',
      'tx.commit',
    ]);
  });

  it('keeps visit functional when the optional recorder is absent', async () => {
    const h = harness();
    const result = await visitBuildingAction.handler(
      null,
      message,
      { avatarId: 'avatar-1', userId: 'user-1', services: baseServices(h.db) },
    );

    expect(result.success).toBe(true);
    expect(h.calls).toEqual(['tx.begin', 'position.update', 'tx.commit']);
  });
});
