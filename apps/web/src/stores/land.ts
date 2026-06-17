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

/**
 * A placed structure (home or shop) on an owned parcel, narrowed to exactly the
 * fields the 3D render layer needs. Keyed by `parcelId` in the store (one
 * structure per parcel by the backend contract). `catalogKey` selects the GLB
 * (e.g. `home-cottage`, `shop-market`); `level` (1..5) drives the scale ramp.
 */
export interface PlacedStructure {
  parcelId: string;
  catalogKey: string;
  structureType: 'home' | 'shop';
  level: number;
}

interface LandStore {
  /** Per-parcel state keyed by ParcelSlot.id (= parcelCode(tier, index)). */
  parcels: Map<string, ParcelState>;

  /** Placed structures keyed by parcelId. Populated by the render layer's
   *  self-hydration (`api.getMyLand()`) and by the Land Office modal on edit. */
  structures: Map<string, PlacedStructure>;

  /** Bulk-set parcel state from an API response. Existing entries not in the
   *  update are left unchanged (patch semantics, not replace). */
  setParcels: (updates: Record<string, ParcelState>) => void;

  /** REPLACE the visible owner's structure set (full replace, not patch) — the
   *  list is the authoritative snapshot of one avatar's placed structures, so a
   *  removed/swapped structure must disappear rather than linger. */
  setStructures: (list: PlacedStructure[]) => void;

  /** Reset a single parcel to 'available'. */
  release: (parcelId: string) => void;
}

export const useLandStore = create<LandStore>()((set) => ({
  // All parcels start as available. The render layer reads this default so
  // even before the API resolves the 3D scene shows correct for-sale state.
  parcels: new Map<string, ParcelState>(),

  // No structures until an owner's land hydrates. The structure render layer
  // reads this empty default so the world has nothing to draw pre-hydration.
  structures: new Map<string, PlacedStructure>(),

  setParcels: (updates) =>
    set((state) => {
      const next = new Map(state.parcels);
      for (const [id, ps] of Object.entries(updates)) {
        next.set(id, ps);
      }
      return { parcels: next };
    }),

  setStructures: (list) =>
    set(() => {
      const next = new Map<string, PlacedStructure>();
      for (const s of list) next.set(s.parcelId, s);
      return { structures: next };
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

/** Helper — get the placed structure for a parcel, or null if none placed. */
export function getStructure(
  structures: Map<string, PlacedStructure>,
  parcelId: string,
): PlacedStructure | null {
  return structures.get(parcelId) ?? null;
}
