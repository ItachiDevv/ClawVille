/**
 * land.ts — Zustand store for land parcel ownership state.
 *
 * Parcel ownership and the public active-structure render snapshot share this
 * store. Structures are keyed by stable parcelCode, never owner identity.
 *
 * ParcelStatus lifecycle:
 *   'available' — for sale (default; shown as for-sale lot in 3D)
 *   'owned'     — claimed by a player/agent
 *   'reserved'  — held back (e.g. founder allocation, future use)
 *   'retired'   — permanently removed from the economy (API may return this)
 */
import { create } from 'zustand';

export type ParcelStatus = 'available' | 'owned' | 'reserved' | 'retired';

export interface ParcelState {
  status: ParcelStatus;
  ownerAvatarId: string | null;
}

/**
 * A placed structure (home or shop) on an owned parcel, narrowed to exactly the
 * fields the 3D render layer needs. Keyed by `parcelCode` in the store (one
 * structure per parcel by the backend contract). `shellKey` selects the GLB,
 * `paletteKey` selects baked vertex colors, and `level` drives the scale ramp.
 *
 * `parcelCode` — the render-key, equals `LAND_PARCELS[i].id` (e.g. `parcel-a-01`).
 *   The 3D layer joins on this, NOT on the DB UUID.
 * `parcelId` — DB UUID for the owner's DTO, parcelCode sentinel for public rows.
 */
export interface PlacedStructure {
  /** DB UUID of the parcel row — kept for backward-compat. */
  parcelId: string;
  /** Render key — matches LAND_PARCELS[i].id (e.g. 'parcel-a-01'). Use this for 3D lookup. */
  parcelCode: string;
  catalogKey: string;
  structureType: 'home' | 'shop';
  level: number;
  shellKey: string;
  paletteKey: string;
}

interface LandStore {
  /** Per-parcel state keyed by ParcelSlot.id (= parcelCode, e.g. 'parcel-a-01'). */
  parcels: Map<string, ParcelState>;

  /** Every public active structure keyed by parcelCode, with owner DTO overlays. */
  structures: Map<string, PlacedStructure>;

  /** Bulk-set parcel state from an API response. Existing entries not in the
   *  update are left unchanged (patch semantics, not replace). */
  setParcels: (updates: Record<string, ParcelState>) => void;

  /** REPLACE the public structure set (full replace, not patch), so archived or
   *  removed structures disappear rather than linger.
   *  The Map is keyed by PlacedStructure.parcelCode. */
  setStructures: (list: PlacedStructure[]) => void;

  /** Reset a single parcel (by parcelCode) to 'available'. */
  release: (parcelCode: string) => void;

  /**
   * Drop the OWNER's structure snapshot (auth-transition sweep,
   * `clearIdentityState`). structures is ONE avatar's placed set — it must
   * not stay rendered for the next identity. `parcels` (public world state)
   * is deliberately untouched: wiping it would blank the world's
   * for-sale/owned display until the next hydrator remount.
   */
  clearOwnerStructures: () => void;
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
      // Key by parcelCode (= LAND_PARCELS[i].id) so the render layer's
      // parcelById.get(structure.parcelCode) join resolves correctly.
      for (const s of list) next.set(s.parcelCode, s);
      return { structures: next };
    }),

  release: (parcelId) =>
    set((state) => {
      const next = new Map(state.parcels);
      next.set(parcelId, { status: 'available', ownerAvatarId: null });
      return { parcels: next };
    }),

  clearOwnerStructures: () =>
    set(() => ({ structures: new Map<string, PlacedStructure>() })),
}));

/** Helper — get the status for a parcel, defaulting to 'available'. */
export function getParcelStatus(
  parcels: Map<string, ParcelState>,
  parcelId: string,
): ParcelStatus {
  return parcels.get(parcelId)?.status ?? 'available';
}

/** Helper — get the placed structure for a parcel (by parcelCode), or null if none placed. */
export function getStructure(
  structures: Map<string, PlacedStructure>,
  parcelCode: string,
): PlacedStructure | null {
  return structures.get(parcelCode) ?? null;
}
