'use client';

/**
 * land-state-hydrator.tsx — headless component that keeps the 3D world's
 * parcel-ownership state in sync with the database.
 *
 * Mounted once inside World3DCanvas near the LandParcels / LandStructures groups.
 * Fetches ALL parcels (available + owned + reserved + retired) from the public
 * /api/land/parcels endpoint,
 * writes the keyed-by-parcelCode result into useLandStore, and re-fetches whenever
 * a buy/claim/place/upgrade succeeds (TanStack Query invalidation via the shared
 * 'landParcels' query key).
 *
 * Contract:
 *   useLandStore.parcels: Map<parcelCode, { status, ownerAvatarId }>
 *     KEY = parcelCode = LAND_PARCELS[i].id  (e.g. 'parcel-a-01')
 *     Absent key ⇒ render treats the parcel as 'available'.
 *
 * Design:
 *   - Uses useQuery so a single invalidateQueries(['landParcels']) call from the
 *     Land Office modal after buy/claim triggers an automatic refetch here.
 *   - Never throws; all errors are best-effort (the world defaults to all-available
 *     on a fetch failure, which is visually correct and never blocks play).
 *   - Guest-safe: the endpoint is public (no auth), so guests see real ownership.
 *   - Fetches all four statuses in parallel so every reachable state is hydrated.
 */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLandStore, type ParcelState } from '@/stores/land';
import type { LandParcelDTO } from '@/components/game/land/types';
import { LAND_PARCELS_QUERY_KEY } from '@/lib/land-query-keys';

// The query key now lives in a dependency-light shared module (`@/lib/land-query-keys`)
// so the world SSE hook can invalidate it on a live `land` event WITHOUT importing
// this three-pulling file. Re-export keeps existing importers (the Land Office
// modal) working unchanged.
export { LAND_PARCELS_QUERY_KEY };

// ---------------------------------------------------------------------------
// mapToParcelState — collapse a DTO status to the store's narrower ParcelState.
// The API may return 'retired' (new in this slice) — pass it through as-is so
// the render layer can hide retired lots.
// ---------------------------------------------------------------------------
function mapStatus(status: LandParcelDTO['status']): ParcelState['status'] {
  switch (status) {
    case 'owned':    return 'owned';
    case 'reserved': return 'reserved';
    case 'retired':  return 'retired';
    default:         return 'available';
  }
}

// ---------------------------------------------------------------------------
// Fetch helper — combines all four status lists into one Record<parcelCode, ParcelState>
// ---------------------------------------------------------------------------
async function fetchAllParcelStates(): Promise<Record<string, ParcelState>> {
  // Fetch all statuses in parallel; ignore individual errors gracefully.
  const [availableResult, ownedResult, reservedResult, retiredResult] =
    await Promise.allSettled([
      api.getLandParcels({ status: 'available' }),
      api.getLandParcels({ status: 'owned' }),
      api.getLandParcels({ status: 'reserved' }),
      api.getLandParcels({ status: 'retired' }),
    ]);

  const rec: Record<string, ParcelState> = {};

  const merge = (parcels: LandParcelDTO[]) => {
    for (const p of parcels) {
      rec[p.parcelCode] = {
        status: mapStatus(p.status),
        ownerAvatarId: p.ownerAvatarId,
      };
    }
  };

  if (availableResult.status === 'fulfilled') merge(availableResult.value);
  if (ownedResult.status   === 'fulfilled') merge(ownedResult.value);
  if (reservedResult.status === 'fulfilled') merge(reservedResult.value);
  if (retiredResult.status  === 'fulfilled') merge(retiredResult.value);

  return rec;
}

// ---------------------------------------------------------------------------
// LandStateHydrator — headless component (returns null)
// ---------------------------------------------------------------------------

export default function LandStateHydrator() {
  const setParcels = useLandStore((s) => s.setParcels);

  const { data } = useQuery({
    queryKey: LAND_PARCELS_QUERY_KEY,
    queryFn: fetchAllParcelStates,
    // 60 s stale time — matches the server's 60s cache; won't hammer the API on
    // every re-mount. The modal's explicit invalidation is the fast-update path.
    staleTime: 60_000,
    // Retry once on failure (transient network blip), then give up silently.
    retry: 1,
    // Never throw; a failed fetch leaves the store at its current state (empty
    // = all-available by default, which is visually correct).
    throwOnError: false,
  });

  // Push the fetched state into the land store whenever the query resolves.
  // useQuery re-runs this effect when `data` identity changes (new fetch result).
  useEffect(() => {
    if (!data) return;
    setParcels(data);
  }, [data, setParcels]);

  return null;
}
