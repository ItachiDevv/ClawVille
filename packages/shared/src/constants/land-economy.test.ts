import { describe, expect, it } from 'bun:test';
import {
  STRUCTURE_UPGRADE_COSTS,
  STRUCTURE_UPGRADE_COSTS_BY_TYPE,
  structureUpgradeCostCt,
  MAX_STRUCTURE_LEVEL,
} from './land-economy';

describe('structure upgrade ladder', () => {
  it('locks both ladders exactly', () => {
    // Founder ruling Q3 (2026-08-09), HOME LADDER ONLY: Lv2 is free and Lv3 is
    // halved. Lv4/Lv5 stay aspirational. The SHOP ladder is untouched.
    expect(STRUCTURE_UPGRADE_COSTS_BY_TYPE).toEqual({
      home: [0, 0, 0, 900, 4500, 11000],
      shop: [0, 0, 600, 1800, 4500, 11000],
    });
  });

  it('prices a home to Lv3 at 900 and a shop at the unchanged 2,400', () => {
    const homeToLv3 = structureUpgradeCostCt('home', 2) + structureUpgradeCostCt('home', 3);
    const shopToLv3 = structureUpgradeCostCt('shop', 2) + structureUpgradeCostCt('shop', 3);
    expect(homeToLv3).toBe(900);
    expect(shopToLv3).toBe(2400);
  });

  it('makes a home Lv2 genuinely free, not merely cheap', () => {
    // The upgrade route skips the debit and the treasury credit entirely when
    // the cost is 0, so this exact value is what makes the first capacity bump
    // reachable without saving.
    expect(structureUpgradeCostCt('home', 2)).toBe(0);
    expect(structureUpgradeCostCt('shop', 2)).toBe(600);
  });

  it('leaves the aspirational Lv4/Lv5 rungs identical for both types', () => {
    for (const level of [4, 5]) {
      expect(structureUpgradeCostCt('home', level)).toBe(
        structureUpgradeCostCt('shop', level),
      );
    }
    expect(structureUpgradeCostCt('home', 4)).toBe(4500);
    expect(structureUpgradeCostCt('home', 5)).toBe(11000);
  });

  it('returns 0 outside the ladder rather than undefined', () => {
    // The route relies on this: a level past the ceiling must never reach the
    // ledger as NaN or undefined.
    for (const level of [0, 1, MAX_STRUCTURE_LEVEL + 1, 99, -1]) {
      expect(structureUpgradeCostCt('home', level)).toBe(0);
      expect(structureUpgradeCostCt('shop', level)).toBe(0);
    }
  });

  it('keeps the deprecated flat export pointing at the unchanged shop ladder', () => {
    expect(STRUCTURE_UPGRADE_COSTS).toEqual([0, 0, 600, 1800, 4500, 11000]);
    expect(STRUCTURE_UPGRADE_COSTS).toBe(STRUCTURE_UPGRADE_COSTS_BY_TYPE.shop);
  });

  it('covers every level up to the DB ceiling for both types', () => {
    for (const type of ['home', 'shop'] as const) {
      expect(STRUCTURE_UPGRADE_COSTS_BY_TYPE[type]).toHaveLength(
        MAX_STRUCTURE_LEVEL + 1,
      );
      for (let level = 2; level <= MAX_STRUCTURE_LEVEL; level += 1) {
        expect(Number.isInteger(structureUpgradeCostCt(type, level))).toBe(true);
        expect(structureUpgradeCostCt(type, level)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
