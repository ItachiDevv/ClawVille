import { describe, expect, test } from 'bun:test';
import { LAND_PARCELS } from './land-parcels';
import { LAND_SHOWROOM, SHOWROOM_PARCEL_IDS } from './land-showroom';
import { getTierMaxLevel } from './land-economy';

// 2026-09-18, founder: "land activity has also severely regressed. there's
// empty lots". The founder asked for every plot to be filled on 2026-06-18; the
// outer c ring arrived six days later and was never added, so its 20 lots were
// bare sand. Lock the invariant, not the count, so the next new ring cannot
// repeat it.

describe('the land showroom fills every rendered plot', () => {
  test('every parcel has exactly one showroom entry', () => {
    const missing = LAND_PARCELS.filter((p) => !SHOWROOM_PARCEL_IDS.has(p.id)).map((p) => p.id);
    expect(missing).toEqual([]);
    expect(LAND_SHOWROOM.length).toBe(LAND_PARCELS.length);
    expect(SHOWROOM_PARCEL_IDS.size).toBe(LAND_SHOWROOM.length);
  });

  test('no entry points at a parcel that does not render', () => {
    const ids = new Set(LAND_PARCELS.map((p) => p.id));
    expect(LAND_SHOWROOM.filter((e) => !ids.has(e.parcelId))).toEqual([]);
  });

  test('each model home stays inside its tier level ceiling', () => {
    const tierOf = new Map(LAND_PARCELS.map((p) => [p.id, p.tier]));
    for (const e of LAND_SHOWROOM) {
      const tier = tierOf.get(e.parcelId)!;
      expect(e.level).toBeGreaterThanOrEqual(1);
      expect(e.level).toBeLessThanOrEqual(getTierMaxLevel(tier));
    }
  });

  test('the outer ring reads one step above starter and advertises rent', () => {
    const tierOf = new Map(LAND_PARCELS.map((p) => [p.id, p.tier]));
    const outer = LAND_SHOWROOM.filter((e) => tierOf.get(e.parcelId) === 'c');
    expect(outer.length).toBe(LAND_PARCELS.filter((p) => p.tier === 'c').length);
    expect(outer.every((e) => e.signLabel === 'rent')).toBe(true);
    expect(new Set(outer.map((e) => e.level))).toEqual(new Set([2, 3]));
    expect(new Set(outer.map((e) => e.style)).size).toBe(3);
  });
});
