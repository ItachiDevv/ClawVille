'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Canonical client-side "is this viewer guest-TIER?" signal.
 *
 * Guest tier covers TWO auth states (matching `deriveUserTier` in
 * lib/user-tier.ts, which returns 'guest' whenever there is no non-guest
 * account):
 *   1. ANONYMOUS — no Lucia session at all. A guest session is only minted
 *      lazily (NPC-mode entry / activity-lobby 401 retry — see
 *      lib/guest-bootstrap.ts), so a fresh visitor opening sidebar surfaces
 *      in Explore mode has NO cookie and `api.me()` resolves 401 → `null`.
 *   2. GUEST SESSION — a real Lucia user with `user.isGuest === true`
 *      (avatar + 100-CT DEMO soft balance; the DEMO chip in
 *      avatar-status-bar.tsx reads the same flag).
 *
 * This hook shares the SAME react-query cache key (`['auth-me']` +
 * `api.me()`) as game/page.tsx and avatar-status-bar, so it adds NO extra
 * network round trip — it just re-reads the cached auth-me.
 *
 * Returns `false` ONLY while auth-me is still in flight (data undefined —
 * fail-open so a real user never flashes demo UI) or for a resolved
 * non-guest user. The load-race window is safe: real-economy write routes
 * carry the server-side `requireNonGuestIdentity` 403 (or 401) backstop, so
 * an under-gated optimistic UI can never actually settle real CT.
 */
export function useIsGuest(): boolean {
  const { data } = useQuery({
    queryKey: ['auth-me'],
    queryFn: async () => {
      try {
        return await api.me();
      } catch {
        // 401 (no session) or network failure → resolved-anonymous.
        return null;
      }
    },
    retry: false,
  });
  // undefined = still loading (NOT guest yet); null = resolved anonymous
  // (guest tier); object = branch on the server's isGuest flag.
  if (data === undefined) return false;
  if (data === null) return true;
  return !!(data as { user?: { isGuest?: boolean } }).user?.isGuest;
}
