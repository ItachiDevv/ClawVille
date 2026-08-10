/**
 * Kit-piece MATERIAL payment rail (P5b).
 *
 * Two things are load-bearing here and both are tested against real behaviour
 * rather than a source grep:
 *   1. A SHOP yard can never be built with materials. Materials have no exit
 *      rail; a shop earns vCLAW back through listings and featured slots, so
 *      allowing it would convert a non-cashable currency into a revenue stream.
 *   2. A material spend that cannot be afforded writes NOTHING, and a placement
 *      that fails after the debit rolls the debit back with it. Anything less
 *      and a player loses materials for a piece they did not get.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { db, sql } from '@clawville/database';
import {
  KIT_CATALOG,
  KIT_PAYMENT_RAILS,
  KIT_PIECE_FEE_MATERIALS,
  isKitPaymentRailAllowed,
  kitPieceFeeCt,
  kitPieceFeeMaterials,
  type KitPieceKey,
} from '@clawville/shared';
import {
  railFromPlacementAudit,
  materialsCostFromPlacementAudit,
} from '../land';
import {
  creditMaterials,
  debitMaterials,
  readMaterialBalance,
  InsufficientMaterialsError,
} from '../../services/material-ledger';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Assert a promise rejects and hand back the error.
 *
 * Deliberately NOT `expect(promise).rejects` — under bun 1.3.14 that matcher
 * hangs forever when it is not the first `await` in the test body.
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

describe('the rail gate', () => {
  it('allows both rails on a HOME yard', () => {
    expect(isKitPaymentRailAllowed('vclaw', 'home')).toBe(true);
    expect(isKitPaymentRailAllowed('materials', 'home')).toBe(true);
  });

  it('REFUSES materials on a SHOP yard, and only materials', () => {
    expect(isKitPaymentRailAllowed('vclaw', 'shop')).toBe(true);
    expect(isKitPaymentRailAllowed('materials', 'shop')).toBe(false);
  });

  it('is total over the declared rail set', () => {
    for (const rail of KIT_PAYMENT_RAILS) {
      for (const type of ['home', 'shop'] as const) {
        expect(typeof isKitPaymentRailAllowed(rail, type)).toBe('boolean');
      }
    }
  });
});

describe('material pricing', () => {
  it('prices small below large, for every catalog piece', () => {
    expect(KIT_PIECE_FEE_MATERIALS.small).toBeLessThan(KIT_PIECE_FEE_MATERIALS.large);
    for (const key of Object.keys(KIT_CATALOG) as KitPieceKey[]) {
      const cost = kitPieceFeeMaterials(KIT_CATALOG[key].size);
      expect(Number.isInteger(cost)).toBe(true);
      expect(cost).toBeGreaterThan(0);
    }
  });

  it('matches the design sizing (8 small / 30 large)', () => {
    expect(kitPieceFeeMaterials('small')).toBe(8);
    expect(kitPieceFeeMaterials('large')).toBe(30);
  });

  it('keeps the vCLAW ladder untouched — this slice added a rail, it did not reprice', () => {
    expect(kitPieceFeeCt('home', 'small')).toBe(5);
    expect(kitPieceFeeCt('home', 'large')).toBe(20);
    expect(kitPieceFeeCt('shop', 'small')).toBe(15);
    expect(kitPieceFeeCt('shop', 'large')).toBe(60);
  });

  it('paces a full Lv3 home yard at roughly a week of salvage', () => {
    // 28 small + 2 large, against ~40 materials per avatar-day at expectation.
    const yardCost = 28 * kitPieceFeeMaterials('small') + 2 * kitPieceFeeMaterials('large');
    expect(yardCost).toBe(284);
    expect(yardCost / 40).toBeGreaterThan(6);
    expect(yardCost / 40).toBeLessThan(8);
  });
});

describe('placement-audit readers', () => {
  it('reads back a material placement', () => {
    const meta = { operation: 'kit_piece_placement', paymentRail: 'materials', costMaterials: 8 };
    expect(railFromPlacementAudit(meta)).toBe('materials');
    expect(materialsCostFromPlacementAudit(meta)).toBe(8);
  });

  it('treats a PRE-P5b audit row as vCLAW, which is what it factually was', () => {
    // Rows written before this slice carry no `paymentRail`, and every one of
    // them was a vCLAW placement because that was the only rail.
    const legacy = { operation: 'kit_piece_placement', size: 'small' };
    expect(railFromPlacementAudit(legacy)).toBe('vclaw');
    expect(materialsCostFromPlacementAudit(legacy)).toBe(0);
  });

  it('refuses to invent a rail or a cost from junk', () => {
    for (const junk of [null, undefined, 'string', 42, { paymentRail: 'gold' }]) {
      expect(railFromPlacementAudit(junk)).toBe('vclaw');
    }
    for (const junk of [{ costMaterials: -5 }, { costMaterials: 1.5 }, { costMaterials: 'x' }]) {
      expect(materialsCostFromPlacementAudit(junk)).toBe(0);
    }
  });
});

describeIfDb('material spend conservation (real DB)', () => {
  const tag = `krail${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  let userId = '';
  let avatarId = '';

  beforeAll(async () => {
    const users = await db.execute<{ id: string }>(
      sql`INSERT INTO users (email, password_hash, name)
          VALUES (${`${tag}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Kit Rail Test')
          RETURNING id`,
    );
    userId = first(users).id;
    const avatars = await db.execute<{ id: string }>(
      sql`INSERT INTO avatars
            (user_id, name, species, color, gender, archetype, personality, stats,
             claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
          VALUES
            (${userId}, ${tag}, 'cat', 'green', 'male', 'brave-adventurer',
             '{}'::jsonb, '{}'::jsonb, 0, 0, 0, 0, false, false)
          RETURNING id`,
    );
    avatarId = first(avatars).id;
  });

  afterAll(async () => {
    if (!userId) return;
    await db.execute(sql`DELETE FROM avatar_material_balances WHERE avatar_id = ${avatarId}`).catch(() => {});
    await db.execute(sql`DELETE FROM avatars WHERE id = ${avatarId}`).catch(() => {});
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`).catch(() => {});
  });

  it('charges exactly the piece price and nothing more', async () => {
    await creditMaterials({ avatarId, amount: 100, reason: 'test_seed', source: 'admin' });
    const before = await readMaterialBalance(avatarId);

    await debitMaterials({
      avatarId,
      amount: kitPieceFeeMaterials('small'),
      reason: 'land_kit_piece_fee',
      source: 'build',
    });
    expect(await readMaterialBalance(avatarId)).toBe(before - 8);

    await debitMaterials({
      avatarId,
      amount: kitPieceFeeMaterials('large'),
      reason: 'land_kit_piece_fee',
      source: 'build',
    });
    expect(await readMaterialBalance(avatarId)).toBe(before - 38);
  });

  it('refuses a spend at balance MINUS ONE without writing', async () => {
    const balance = await readMaterialBalance(avatarId);
    const err = await rejection(
      debitMaterials({
        avatarId,
        amount: balance + 1,
        reason: 'land_kit_piece_fee',
        source: 'build',
      }),
    );
    expect(err).toBeInstanceOf(InsufficientMaterialsError);
    // The decisive assertion: nothing moved.
    expect(await readMaterialBalance(avatarId)).toBe(balance);
  });

  it('rolls the debit back when the placement fails after it', async () => {
    // This is the route's real failure shape: materials are debited, then the
    // piece INSERT trips a constraint (cell already occupied, catalog drift, a
    // 503 from a later step). The player must not be charged for a piece that
    // does not exist.
    const before = await readMaterialBalance(avatarId);
    const err = await rejection(
      db.transaction(async (tx) => {
        await debitMaterials(
          { avatarId, amount: 8, reason: 'land_kit_piece_fee', source: 'build' },
          tx,
        );
        // Prove the debit is visible INSIDE the transaction before it unwinds.
        expect(await readMaterialBalance(avatarId, tx)).toBe(before - 8);
        throw new Error('placement failed after the debit');
      }),
    );
    expect((err as Error).message).toContain('placement failed');
    expect(await readMaterialBalance(avatarId)).toBe(before);
  });

  it('never lets the pooled balance go negative under concurrent spends', async () => {
    // Fund exactly five small pieces, then try to buy eight at once.
    await db.execute(
      sql`UPDATE avatar_material_balances SET quantity = 40 WHERE avatar_id = ${avatarId}`,
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        debitMaterials({ avatarId, amount: 8, reason: 'land_kit_piece_fee', source: 'build' })
          .then(() => true)
          .catch(() => false),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await readMaterialBalance(avatarId)).toBe(0);
  });
});
