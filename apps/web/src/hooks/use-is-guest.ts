'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Canonical client-side "is this viewer a guest?" signal.
 *
 * Guests are REAL Lucia users (avatar + 100-CT DEMO soft balance) — the
 * `isGuest` flag on the auth-me payload is the single source of truth the
 * whole game reads (the DEMO balance chip in avatar-status-bar.tsx uses the
 * exact same read). This hook shares the SAME react-query cache key
 * (`['auth-me']` + `api.me()`) as game/page.tsx and avatar-status-bar, so it
 * adds NO extra network round trip — it just re-reads the cached auth-me.
 *
 * Returns `false` while auth-me is still loading or on error (fail-open to
 * "not a guest"): the real-economy write routes carry the server-side
 * `requireNonGuestIdentity` 403 backstop, so an under-gated optimistic UI can
 * never actually settle real CT for a guest.
 */
export function useIsGuest(): boolean {
  const { data } = useQuery({
    queryKey: ['auth-me'],
    queryFn: async () => {
      try {
        return await api.me();
      } catch {
        return null;
      }
    },
    retry: false,
  });
  return !!(data as { user?: { isGuest?: boolean } } | null)?.user?.isGuest;
}
