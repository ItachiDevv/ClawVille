/**
 * `backfillPlatformAgentForAvatar(userId, avatarId, beforeWrite)`: the operator hook runs as
 * the FIRST statement of the write transaction, and its refusal rolls back and propagates
 * (never fail-soft), so repair-provisioning-pending stops instead of counting a skip.
 * DB-free: `db.transaction` is a recording fake.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realDatabase from '@clawville/database';

const calls: string[] = [];
let selectFails = false;
const fakeTx = {
  select: () => {
    calls.push('select');
    if (selectFails) throw new Error('driver error');
    return { from: () => ({ where: () => ({ for: async () => [] }) }) };
  },
};
const fakeDb = {
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    calls.push('begin');
    try {
      const result = await fn(fakeTx);
      calls.push('commit');
      return result;
    } catch (error) {
      calls.push('rollback');
      throw error;
    }
  },
};
mock.module('@clawville/database', () => ({ ...realDatabase, db: fakeDb }));
const { backfillPlatformAgentForAvatar, BackfillTargetRefusedError } = await import('../avatar-agent-provisioning');

describe('backfillPlatformAgentForAvatar beforeWrite hook', () => {
  beforeEach(() => {
    calls.length = 0;
    selectFails = false;
  });

  test('a refusing hook rolls back before any read or write and propagates', async () => {
    const refusal = new Error('marker changed');
    const hook = async () => { calls.push('hook'); throw refusal; };
    const error = await backfillPlatformAgentForAvatar('user', 'avatar', hook).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackfillTargetRefusedError);
    expect((error as Error).cause).toBe(refusal);
    expect(calls).toEqual(['begin', 'hook', 'rollback']);
  });

  test('a passing hook runs first, then the locked read, in the same transaction', async () => {
    const hook = async () => { calls.push('hook'); };
    expect(await backfillPlatformAgentForAvatar('user', 'avatar', hook)).toBeNull();
    expect(calls).toEqual(['begin', 'hook', 'select', 'commit']);
  });

  test('without a hook the live path is unchanged, and other errors stay fail-soft', async () => {
    expect(await backfillPlatformAgentForAvatar('user', 'avatar')).toBeNull();
    expect(calls).toEqual(['begin', 'select', 'commit']);
    calls.length = 0;
    selectFails = true;
    expect(await backfillPlatformAgentForAvatar('user', 'avatar', async () => {})).toBeNull();
    expect(calls).toEqual(['begin', 'select', 'rollback']);
  });

  test('the live no-hook path still returns null on a driver error (fail-soft)', async () => {
    selectFails = true;
    expect(await backfillPlatformAgentForAvatar('user', 'avatar')).toBeNull();
    expect(calls).toEqual(['begin', 'select', 'rollback']);
  });
});
