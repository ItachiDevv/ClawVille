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
  const { data, isError } = useQuery({
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
  // ~10 components share this queryKey with DIFFERENT hand-rolled queryFns,
  // six of which do NOT catch — react-query's setOptions means whichever
  // sibling rendered last owns the fetcher, so a refocus refetch can settle
  // the shared query into `error` (data undefined) instead of our caught
  // `null` (Codex review f3286668). For THIS key a settled error means "no
  // valid session" regardless of which fetcher ran → guest tier. Long-term
  // fix is one shared exported queryFn; out of scope here.
  if (isError) return true;
  // undefined = still loading (NOT guest yet); null = resolved anonymous
  // (guest tier); object = branch on the server's isGuest flag.
  if (data === undefined) return false;
  if (data === null) return true;
  return !!(data as { user?: { isGuest?: boolean } }).user?.isGuest;
}
