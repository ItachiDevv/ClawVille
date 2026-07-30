import { LAND_PARCELS, type ParcelSlot } from '@clawville/shared';

let innerWu = Number.POSITIVE_INFINITY;
let outerWu = Number.NEGATIVE_INFINITY;
const parcelSlotsByCode = new Map<string, ParcelSlot>();

for (let i = 0; i < LAND_PARCELS.length; i++) {
  const parcel = LAND_PARCELS[i]!;
  const frameRadius = Math.max(Math.abs(parcel.cx), Math.abs(parcel.cz));
  const half = parcel.size * 0.5;
  innerWu = Math.min(innerWu, frameRadius - half);
  outerWu = Math.max(outerWu, frameRadius + half);
  parcelSlotsByCode.set(parcel.id, parcel);
}

/** Tight Chebyshev ring bounds, derived at module load from LAND_PARCELS. */
export const LAND_PROXIMITY_INNER_WU: number = innerWu;
export const LAND_PROXIMITY_OUTER_WU: number = outerWu;

/**
 * Return the parcelCode whose square footprint contains the point, or null.
 * @param x centered world X (wu). NOT map-pixel.
 * @param z centered world Z (wu). NOT map-pixel.
 */
export function findParcelAtWorldPos(x: number, z: number): string | null {
  const r = Math.max(Math.abs(x), Math.abs(z));
  if (r < LAND_PROXIMITY_INNER_WU || r > LAND_PROXIMITY_OUTER_WU) return null;

  for (let i = 0; i < LAND_PARCELS.length; i++) {
    const parcel = LAND_PARCELS[i]!;
    const half = parcel.size * 0.5;
    if (
      Math.abs(x - parcel.cx) <= half
      && Math.abs(z - parcel.cz) <= half
    ) {
      return parcel.id;
    }
  }

  return null;
}

/** O(1) lookup of the geometry slot for a parcelCode, or null. */
export function getParcelSlotByCode(code: string): ParcelSlot | null {
  return parcelSlotsByCode.get(code) ?? null;
}
