/**
 * The hosted cosmetic buy cap's DB window and the decide-prompt targets reader.
 * Transport-only stub of `db.execute` (no DB opens): each query is told apart by
 * its own SQL text.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as database from '@clawville/database';

const AVATAR = '00000000-0000-4000-8000-0000000000a1';
const SKU_OWNED = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SKU_BUY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const dialect = new PgDialect();
const queries: Array<{ text: string; params: unknown[] }> = [];
let lastShopCtBuy: Date | string | null = null;
let windowError: Error | null = null;

mock.module('@clawville/database', () => ({
  ...database,
  db: {
    execute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      queries.push({ text, params });
      if (text.includes("acquired_via = 'shop_ct'")) {
        if (windowError) throw windowError;
        return lastShopCtBuy === null ? [] : [{ acquired_at: lastShopCtBuy }];
      }
      if (text.includes('a.equipped = false')) return [{ sku_id: SKU_OWNED, display_name: 'Pixel Shades', category: 'glasses' }];
      if (text.includes('FROM cosmetic_skus s')) return [{ sku_id: SKU_BUY, display_name: 'Kelp Crown', category: 'hat', price_ct: 200 }];
      if (text.includes('FROM avatars')) return [{ claw_tokens: 150 }];
      throw new Error(`unexpected query: ${text}`);
    },
  },
}));
mock.module('../cosmetic-signup-bonus', () => ({ getCosmeticBonusRemaining: async () => 100 }));
const { readAutonomousCosmeticBuyWindow, readAutonomousCosmeticTargets, EMPTY_AUTONOMOUS_COSMETIC_TARGETS } =
  await import('../autonomous-cosmetic-targets');

beforeEach(() => {
  queries.length = 0;
  lastShopCtBuy = null;
  windowError = null;
});

describe('readAutonomousCosmeticBuyWindow', () => {
  test('counts only this avatar and only shop_ct rows of the last 24 hours', async () => {
    expect(await readAutonomousCosmeticBuyWindow(AVATAR)).toEqual({ allowed: true, nextBuyAt: null });
    const query = queries.find((q) => q.text.includes("acquired_via = 'shop_ct'"))!;
    expect(query.params).toEqual([AVATAR]);
    expect(query.text).toContain("acquired_at > now() - interval '24 hours'");
  });

  test('a purchase in the window closes it until 24 hours after that purchase', async () => {
    lastShopCtBuy = new Date('2026-10-22T06:44:16.000Z');
    expect(await readAutonomousCosmeticBuyWindow(AVATAR)).toEqual({
      allowed: false,
      nextBuyAt: '2026-10-23T06:44:16.000Z',
    });
    // The driver may hand back a timestamp string; same answer.
    lastShopCtBuy = '2026-10-22 06:44:16+00';
    expect((await readAutonomousCosmeticBuyWindow(AVATAR)).nextBuyAt).toBe('2026-10-23T06:44:16.000Z');
  });

  test('a DB error throws (the executor fails closed)', async () => {
    windowError = new Error('db down');
    await expect(readAutonomousCosmeticBuyWindow(AVATAR)).rejects.toThrow('db down');
  });
});

describe('readAutonomousCosmeticTargets', () => {
  test('window open: buys are listed and buyLockedUntil is null', async () => {
    const targets = await readAutonomousCosmeticTargets({ avatarId: AVATAR, userId: 'owner' });
    expect(targets.buyLockedUntil).toBeNull();
    expect(targets.purchasable.map((item) => item.skuId)).toEqual([SKU_BUY]);
    expect(targets.ownedUnequipped.map((item) => item.skuId)).toEqual([SKU_OWNED]);
  });

  test('window closed: purchasable is empty, buyLockedUntil is set, equip list stays', async () => {
    lastShopCtBuy = new Date('2026-10-22T06:44:16.000Z');
    const targets = await readAutonomousCosmeticTargets({ avatarId: AVATAR, userId: 'owner' });
    expect(targets.purchasable).toEqual([]);
    expect(targets.buyLockedUntil).toBe('2026-10-23T06:44:16.000Z');
    expect(targets.ownedUnequipped.map((item) => item.skuId)).toEqual([SKU_OWNED]);
    expect(targets.vclawBalance).toBe(150);
    expect(targets.cosmeticCredit).toBe(100);
  });

  test('window unreadable: no buys offered, equip list stays', async () => {
    windowError = new Error('db down');
    const targets = await readAutonomousCosmeticTargets({ avatarId: AVATAR, userId: 'owner' });
    expect(targets.purchasable).toEqual([]);
    expect(targets.buyLockedUntil).toBeNull();
    expect(targets.ownedUnequipped).toHaveLength(1);
  });

  test('the empty constant carries the new field', () => {
    expect(EMPTY_AUTONOMOUS_COSMETIC_TARGETS.buyLockedUntil).toBeNull();
  });
});
