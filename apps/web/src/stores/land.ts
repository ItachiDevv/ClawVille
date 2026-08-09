/**
 * land.ts — Zustand store for land parcel ownership state.
 *
 * Parcel ownership and the public active structure/kit render snapshots share
 * this store. Both are keyed by stable parcelCode, never owner identity.
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

/** Public kit render-feed row. Database and owner identities stay server-side. */
export interface PlacedPiece {
  /** Private owner-only UUID, present for the active editor parcel. */
  id?: string;
  /** Private parcel UUID, present alongside `id`; never returned by the public feed. */
  parcelId?: string;
  parcelCode: string;
  pieceKey: string;
  gridX: number;
  gridY: number;
  rotationStep: number;
  stackLevel: number;
}

export type YardEditorMode = 'place' | 'move' | 'remove';

/**
 * Which currency a NEW placement spends. HOME-only in practice — the server
 * refuses `paymentRail: 'materials'` on a shop (gamification-pass §3.3), and
 * the editor never shows the toggle on a shop. Kept 'vclaw' | 'materials'
 * (not a boolean) to match the wire union in §2.9 KitMutationInput.op.
 */
export type PaymentRail = 'vclaw' | 'materials';

export interface LandBuildMode {
  parcelCode: string;
}

interface LandStore {
  /** Per-parcel state keyed by ParcelSlot.id (= parcelCode, e.g. 'parcel-a-01'). */
  parcels: Map<string, ParcelState>;

  /** Every public active structure keyed by parcelCode, with owner DTO overlays. */
  structures: Map<string, PlacedStructure>;

  /** Every public active kit piece grouped by parcelCode. */
  pieces: Map<string, PlacedPiece[]>;

  /** Active in-world yard editor, or null outside build mode. */
  buildMode: LandBuildMode | null;
  buildParcelId: string | null;
  yardEditorMode: YardEditorMode;
  selectedPieceKey: string;
  rotationStep: number;
  selectedPlacedPieceId: string | null;
  /** Rail for the NEXT placement. Reset to 'vclaw' on every build-mode entry/exit. */
  paymentRail: PaymentRail;

  /** Bulk-set parcel state from an API response. Existing entries not in the
   *  update are left unchanged (patch semantics, not replace). */
  setParcels: (updates: Record<string, ParcelState>) => void;

  /** REPLACE the public structure set (full replace, not patch), so archived or
   *  removed structures disappear rather than linger.
   *  The Map is keyed by PlacedStructure.parcelCode. */
  setStructures: (list: PlacedStructure[]) => void;

  /** REPLACE the public piece set so moved/deleted pieces cannot linger. */
  setPieces: (list: PlacedPiece[]) => void;

  /** Replace one parcel with its owner read, preserving the rest of the public world. */
  setParcelPieces: (parcelCode: string, list: PlacedPiece[]) => void;

  enterBuildMode: (parcelCode: string) => void;
  exitBuildMode: () => void;
  setBuildParcelId: (parcelId: string | null) => void;
  setYardEditorMode: (mode: YardEditorMode) => void;
  setSelectedPieceKey: (pieceKey: string) => void;
  setRotationStep: (rotationStep: number) => void;
  setSelectedPlacedPieceId: (pieceId: string | null) => void;
  setPaymentRail: (rail: PaymentRail) => void;
  addPiece: (piece: PlacedPiece) => void;
  updatePiece: (pieceId: string, piece: PlacedPiece) => void;
  removePiece: (pieceId: string) => void;

  /** Optimistically patch one rendered structure's shell/palette by parcelCode. */
  updateStructureAppearance: (
    parcelCode: string,
    appearance: Pick<PlacedStructure, 'shellKey' | 'paletteKey'>,
  ) => void;

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

  // No pieces until the public render feed hydrates.
  pieces: new Map<string, PlacedPiece[]>(),

  buildMode: null,
  buildParcelId: null,
  yardEditorMode: 'place',
  selectedPieceKey: 'fence-picket',
  rotationStep: 0,
  selectedPlacedPieceId: null,
  paymentRail: 'vclaw',

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

  setPieces: (list) =>
    set((state) => {
      const next = new Map<string, PlacedPiece[]>();
      for (const piece of list) {
        // The public feed intentionally omits UUIDs. Preserve a session-known
        // private UUID across its immediate post-mutation refresh by matching
        // the complete public placement tuple.
        const known = state.pieces.get(piece.parcelCode)?.find((candidate) =>
          candidate.pieceKey === piece.pieceKey
          && candidate.gridX === piece.gridX
          && candidate.gridY === piece.gridY
          && candidate.rotationStep === piece.rotationStep
          && candidate.stackLevel === piece.stackLevel
        );
        const merged = known?.id
          ? { ...piece, id: known.id, parcelId: known.parcelId }
          : piece;
        const parcelPieces = next.get(piece.parcelCode);
        if (parcelPieces) parcelPieces.push(merged);
        else next.set(piece.parcelCode, [merged]);
      }
      return { pieces: next };
    }),

  setParcelPieces: (parcelCode, list) =>
    set((state) => {
      const next = new Map(state.pieces);
      if (list.length === 0) next.delete(parcelCode);
      else next.set(parcelCode, list);
      return { pieces: next };
    }),

  enterBuildMode: (parcelCode) => set({
    buildMode: { parcelCode },
    buildParcelId: null,
    yardEditorMode: 'place',
    selectedPlacedPieceId: null,
    rotationStep: 0,
    // Always start a build session on the vCLAW rail — never carry a
    // materials selection from a previous (possibly shop) yard into this one.
    paymentRail: 'vclaw',
  }),

  exitBuildMode: () => set({
    buildMode: null,
    buildParcelId: null,
    selectedPlacedPieceId: null,
    paymentRail: 'vclaw',
  }),

  setBuildParcelId: (buildParcelId) => set({ buildParcelId }),
  setYardEditorMode: (yardEditorMode) => set({
    yardEditorMode,
    selectedPlacedPieceId: null,
  }),
  setSelectedPieceKey: (selectedPieceKey) => set({ selectedPieceKey }),
  setRotationStep: (rotationStep) => set({ rotationStep }),
  setSelectedPlacedPieceId: (selectedPlacedPieceId) => set({ selectedPlacedPieceId }),
  setPaymentRail: (paymentRail) => set({ paymentRail }),

  addPiece: (piece) => set((state) => {
    const next = new Map(state.pieces);
    next.set(piece.parcelCode, [...(next.get(piece.parcelCode) ?? []), piece]);
    return { pieces: next };
  }),

  updatePiece: (pieceId, piece) => set((state) => {
    const next = new Map(state.pieces);
    for (const [parcelCode, parcelPieces] of next) {
      const index = parcelPieces.findIndex((candidate) => candidate.id === pieceId);
      if (index < 0) continue;
      const updated = [...parcelPieces];
      updated[index] = piece;
      next.set(parcelCode, updated);
      break;
    }
    return { pieces: next };
  }),

  removePiece: (pieceId) => set((state) => {
    const next = new Map(state.pieces);
    for (const [parcelCode, parcelPieces] of next) {
      const filtered = parcelPieces.filter((candidate) => candidate.id !== pieceId);
      if (filtered.length === parcelPieces.length) continue;
      if (filtered.length === 0) next.delete(parcelCode);
      else next.set(parcelCode, filtered);
      break;
    }
    return { pieces: next, selectedPlacedPieceId: null };
  }),

  updateStructureAppearance: (parcelCode, appearance) =>
    set((state) => {
      const current = state.structures.get(parcelCode);
      if (!current) return state;
      const next = new Map(state.structures);
      next.set(parcelCode, { ...current, ...appearance });
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
