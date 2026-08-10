/**
 * Shared TanStack Query key for the land-parcel ownership state that
 * `LandStateHydrator` (lib/three/land-state-hydrator.tsx) fetches and writes
 * into `useLandStore`.
 *
 * Kept in its own dependency-light module (NO `three` / R3F imports) so
 * non-render consumers can invalidate the SAME key without pulling the 3D graph
 * into their bundle:
 *   - the Land Office modal, after a buy/claim (`land-office-modal.tsx`),
 *   - the world SSE stream hook, on a live `land` event (`use-world-stream.ts`).
 *
 * Single source of truth — a drifted key would silently break the live cross-
 * player land-sync (the invalidation would target a query nobody is reading).
 */
export const LAND_PARCELS_QUERY_KEY = ['landParcels'] as const;

/** Lightweight signal for the non-query structure hydrator's immediate refresh. */
export const LAND_STRUCTURES_REFRESH_EVENT = 'clawville:land-structures-refresh';

/** Lightweight signal for the public kit-piece hydrator's immediate refresh. */
export const LAND_PIECES_REFRESH_EVENT = 'clawville:land-pieces-refresh';

/**
 * Lightweight signal for the salvage-state hydrator's immediate refresh
 * (`SalvageStateHydrator`, lib/three/land-salvage-render.tsx). Fired as a
 * reconciliation safety net after a claim — the gather UI already patches
 * `useSalvageStore` optimistically from the claim response, so this is
 * belt-and-suspenders, not the primary update path.
 */
export const LAND_SALVAGE_REFRESH_EVENT = 'clawville:land-salvage-refresh';

export function requestLandStructuresRefresh(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(LAND_STRUCTURES_REFRESH_EVENT));
}

export function requestLandPiecesRefresh(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(LAND_PIECES_REFRESH_EVENT));
}
