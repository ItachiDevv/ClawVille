/**
 * land.ts — Zustand store for land parcel ownership state.
 *
 * Phase 1 / Slice A: placeholder store. All 180 parcels default to 'available'.
 * The gameplay turn (GET /api/land/owned) will hydrate this with real ownership.
 * The render reads this store so the wiring exists end-to-end from day 1.
 *
 * ParcelStatus lifecycle:
 *   'available' — for sale (default; shown as for-sale lot in 3D)
 *   'owned'     — claimed by a player/agent
 *   'reserved'  — held back (e.g. founder allocation, future use)
 */
import { create } from 'zustand';

export type ParcelStatus = 'available' | 'owned' | 'reserved';

export interface ParcelState {
  status: ParcelStatus;
  ownerAvatarId: string | null;
}

interface LandStore {
  /** Per-parcel state keyed by ParcelSlot.id (= parcelCode(tier, index)). */
  parcels: Map<string, ParcelState>;

  /** Bulk-set parcel state from an API response. Existing entries not in the
   *  update are left unchanged (patch semantics, not replace). */
  setParcels: (updates: Record<string, ParcelState>) => void;

  /** Reset a single parcel to 'available'. */
  release: (parcelId: string) => void;
}

export const useLandStore = create<LandStore>()((set) => ({
  // All parcels start as available. The render layer reads this default so
  // even before the API resolves the 3D scene shows correct for-sale state.
  parcels: new Map<string, ParcelState>(),

  setParcels: (updates) =>
    set((state) => {
      const next = new Map(state.parcels);
      for (const [id, ps] of Object.entries(updates)) {
        next.set(id, ps);
      }
      return { parcels: next };
    }),

  release: (parcelId) =>
    set((state) => {
      const next = new Map(state.parcels);
      next.set(parcelId, { status: 'available', ownerAvatarId: null });
      return { parcels: next };
    }),
}));

/** Helper — get the status for a parcel, defaulting to 'available'. */
export function getParcelStatus(
  parcels: Map<string, ParcelState>,
  parcelId: string,
): ParcelStatus {
  return parcels.get(parcelId)?.status ?? 'available';
}
