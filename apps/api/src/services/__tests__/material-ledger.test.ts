/**
 * Material ledger — REAL DB concurrency + conservation suite (gate G-I).
 *
 * Money-grade paths get executed database tests, not source greps. Every case
 * below runs against the configured Postgres (staging in local dev, the CI DB
 * in CI) and is skipped only when `DATABASE_URL` is absent.
 *
 * The properties under test are the ones a build-currency must never violate:
 *   - a debit that cannot be afforded writes NOTHING (conditional decrement),
 *   - a composed debit rolls back with the caller's transaction,
 *   - concurrent writers conserve the total (no lost update),
 *   - the balance can never go negative, even under a concurrent oversubscribe.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { db, sql } from '@clawville/database';
import {
  creditMaterials,
  debitMaterials,
  readMaterialBalance,
  InsufficientMaterialsError,
  UnknownMaterialSubjectError,
} from '../material-ledger';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Assert a promise rejects and hand back the error for further assertions.
 *
 * Deliberately NOT `expect(promise).rejects` — under bun 1.3.14 that matcher
 * hangs forever when it is not the first `await` in the test body. Reproduced
 * against this exact suite: the identical rejecting call settles in ~300ms with
 * try/catch and never settles with `.rejects`. Do not "simplify" this back.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

function first<T>(rows: Iterable<T>): T {
  const [row] = Array.from(rows);
  if (!row) throw new Error('expected at least one row');
  return row;
}

describeIfDb('material-ledger (real DB)', () => {
  // Collision-proof fixture tag so parallel runs never share rows.
  const tag = `mat${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  let userId = '';
  let avatarId = '';

  beforeAll(async () => {
    const users = await db.execute<{ id: string }>(
      sql`INSERT INTO users (email, password_hash, name)
                VALUES (${`${tag}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Material Ledger Test')
                RETURNING id`,
    );
    userId = first(users).id;

    const avatars = await db.execute<{ id: string }>(
      sql`INSERT INTO avatars
                  (user_id, name, species, color, gender, archetype, personality, stats,
                   claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
                VALUES
                  (${userId}, ${tag}, 'cat', 'green', 'male', 'brave-adventurer', '{}'::jsonb, '{}'::jsonb,
                   0, 0, 0, 0, false, false)
                RETURNING id`,
    );
    avatarId = first(avatars).id;
  });

  afterAll(async () => {
    if (!avatarId) return;
    // avatar_material_balances cascades from avatars, but delete explicitly so a
    // failed cascade never leaves a stray balance behind.
    await db
      .execute(sql`DELETE FROM avatar_material_balances WHERE avatar_id = ${avatarId}`)
      .catch(() => {});
    await db
      .execute(sql`DELETE FROM salvage_claim_receipts WHERE avatar_id = ${avatarId}`)
      .catch(() => {});
    await db.execute(sql`DELETE FROM avatars WHERE id = ${avatarId}`).catch(() => {});
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`).catch(() => {});
  });

  it('reads zero for an avatar that has never earned a material', async () => {
    expect(await readMaterialBalance(avatarId)).toBe(0);
  });

  it('credits lazily create the balance row and accumulate', async () => {
    const first1 = await creditMaterials({
      avatarId,
      amount: 12,
      reason: 'land_quest',
      source: 'quest',
    });
    expect(first1.balanceAfter).toBe(12);

    const second = await creditMaterials({
      avatarId,
      amount: 8,
      reason: 'land_quest',
      source: 'quest',
    });
    expect(second.balanceAfter).toBe(20);
    expect(await readMaterialBalance(avatarId)).toBe(20);
  });

  it('debits decrement the pooled balance', async () => {
    const res = await debitMaterials({
      avatarId,
      amount: 8,
      reason: 'land_kit_piece',
      source: 'build',
    });
    expect(res.balanceAfter).toBe(12);
    expect(await readMaterialBalance(avatarId)).toBe(12);
  });

  it('a spend at balance + 1 refuses and writes NOTHING', async () => {
    const before = await readMaterialBalance(avatarId);
    let thrown: unknown;
    try {
      await debitMaterials({
        avatarId,
        amount: before + 1,
        reason: 'land_kit_piece',
        source: 'build',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InsufficientMaterialsError);
    expect((thrown as InsufficientMaterialsError).available).toBe(before);
    expect((thrown as InsufficientMaterialsError).requested).toBe(before + 1);
    // The decisive assertion: the refusal did not partially debit.
    expect(await readMaterialBalance(avatarId)).toBe(before);
  });

  it('a spend of the ENTIRE balance succeeds and lands exactly on zero', async () => {
    const before = await readMaterialBalance(avatarId);
    const res = await debitMaterials({
      avatarId,
      amount: before,
      reason: 'land_kit_piece',
      source: 'build',
    });
    expect(res.balanceAfter).toBe(0);
    // Then one more material must refuse — the boundary is closed, not off-by-one.
    expect(
      await rejection(
        debitMaterials({ avatarId, amount: 1, reason: 'land_kit_piece', source: 'build' }),
      ),
    ).toBeInstanceOf(InsufficientMaterialsError);
  });

  it('a composed debit rolls back with the caller transaction', async () => {
    await creditMaterials({ avatarId, amount: 30, reason: 'land_quest', source: 'quest' });
    const before = await readMaterialBalance(avatarId);

    const rollbackErr = await rejection(
      db.transaction(async (tx) => {
        await debitMaterials(
          { avatarId, amount: 30, reason: 'land_kit_piece', source: 'build' },
          tx,
        );
        // The placement this debit paid for fails AFTER the money moved. Rollback
        // is the refund; there is no compensating credit anywhere in the codebase.
        throw new Error('simulated placement failure');
      }),
    );
    expect((rollbackErr as Error).message).toBe('simulated placement failure');

    expect(await readMaterialBalance(avatarId)).toBe(before);
  });

  it('concurrent credits conserve the total (no lost update)', async () => {
    const before = await readMaterialBalance(avatarId);
    const CONCURRENCY = 20;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        creditMaterials({ avatarId, amount: 3, reason: 'salvage_claim', source: 'salvage' }),
      ),
    );
    expect(await readMaterialBalance(avatarId)).toBe(before + CONCURRENCY * 3);
  });

  it('concurrent oversubscribed debits admit exactly the affordable count and never go negative', async () => {
    // Reset to an exact, known balance so the arithmetic below is unambiguous.
    const current = await readMaterialBalance(avatarId);
    if (current > 0) {
      await debitMaterials({
        avatarId,
        amount: current,
        reason: 'test_reset',
        source: 'admin',
      });
    }
    await creditMaterials({ avatarId, amount: 50, reason: 'land_quest', source: 'quest' });

    // 15 concurrent spends of 10 against a balance of 50: exactly 5 may win.
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () =>
        debitMaterials({ avatarId, amount: 10, reason: 'land_kit_piece', source: 'build' }),
      ),
    );
    const admitted = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof InsufficientMaterialsError,
    ).length;

    expect(admitted).toBe(5);
    expect(refused).toBe(10);
    expect(await readMaterialBalance(avatarId)).toBe(0);
  });

  it('rejects a credit for an avatar that does not exist', async () => {
    expect(
      await rejection(
        creditMaterials({
          avatarId: '00000000-0000-4000-8000-000000000000',
          amount: 1,
          reason: 'land_quest',
          source: 'quest',
        }),
      ),
    ).toBeInstanceOf(UnknownMaterialSubjectError);
  });

  it('rejects non-positive and non-integer amounts on both primitives', async () => {
    for (const amount of [0, -5, 1.5, Number.NaN]) {
      const creditErr = await rejection(
        creditMaterials({ avatarId, amount, reason: 'land_quest', source: 'quest' }),
      );
      expect((creditErr as Error).message).toBe(
        'creditMaterials amount must be a positive integer',
      );
      const debitErr = await rejection(
        debitMaterials({ avatarId, amount, reason: 'land_kit_piece', source: 'build' }),
      );
      expect((debitErr as Error).message).toBe(
        'debitMaterials amount must be a positive integer',
      );
    }
  });
});
