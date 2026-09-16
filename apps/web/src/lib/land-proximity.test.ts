import { describe, expect, test } from 'bun:test';
import { LAND_PARCELS } from '@clawville/shared';
import {
  findParcelAtWorldPos,
  getParcelSlotByCode,
  LAND_PROXIMITY_INNER_WU,
  LAND_PROXIMITY_OUTER_WU,
} from './land-proximity';

describe('land parcel proximity', () => {
  test('pins the derived ring bounds to the current parcel supply', () => {
    // Re-pinned 2026-09-16 after bfdd1f31 (scale up plots + shells: founder/starter
    // 52t, fraction 0.68, corner-inset layout) moved the derived ring.
    expect(LAND_PROXIMITY_INNER_WU).toBe(5312);
    expect(LAND_PROXIMITY_OUTER_WU).toBe(11136);
  });

  test('rejects the town center and positions far outside the world', () => {
    expect(findParcelAtWorldPos(0, 0)).toBeNull();
    expect(findParcelAtWorldPos(20000, 20000)).toBeNull();
  });

  test('finds every parcel center without swapping axes', () => {
    for (const parcel of LAND_PARCELS) {
      expect(findParcelAtWorldPos(parcel.cx, parcel.cz)).toBe(parcel.id);
    }
  });

  test('uses inclusive square footprint bounds', () => {
    for (const parcel of LAND_PARCELS) {
      const half = parcel.size * 0.5;
      expect(findParcelAtWorldPos(parcel.cx + half - 1, parcel.cz)).toBe(parcel.id);
      expect(findParcelAtWorldPos(parcel.cx + half + 1, parcel.cz)).not.toBe(parcel.id);
      expect(findParcelAtWorldPos(parcel.cx + half, parcel.cz + half)).toBe(parcel.id);
    }
  });

  test('looks up geometry slots by parcelCode', () => {
    expect(getParcelSlotByCode('parcel-c-00')?.id).toBe('parcel-c-00');
    expect(getParcelSlotByCode('nope')).toBeNull();
  });

  test('returns only string or null primitives', () => {
    for (const parcel of LAND_PARCELS) {
      const result = findParcelAtWorldPos(parcel.cx, parcel.cz);
      expect(result === null || typeof result === 'string').toBe(true);
      expect(typeof result).not.toBe('object');
    }
    const missing = findParcelAtWorldPos(0, 0);
    expect(missing === null || typeof missing === 'string').toBe(true);
  });
});
