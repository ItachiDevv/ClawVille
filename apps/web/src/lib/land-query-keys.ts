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
