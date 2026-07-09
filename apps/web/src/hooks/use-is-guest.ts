'use client';

import { useAuthMe } from '@/hooks/use-auth-me';

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
  const { data, isError } = useAuthMe();
  // ORDER MATTERS (Codex round-3 BLOCKING): fetchAuthMe re-throws transient
  // failures so react-query KEEPS the last successful payload — a logged-in
  // user whose refetch blips has isError=true AND data={user}. Data must win
  // over the error belt, or a network blip would flip a real user to guest
  // mid-session and unmount their in-progress UI (e.g. a bounty draft).
  if (data === null) return true; // confirmed anonymous (401)
  if (data !== undefined) {
    // resolved payload (survives transient refetch errors)
    return !!(data as { user?: { isGuest?: boolean } }).user?.isGuest;
  }
  // Never fetched successfully: still loading → false (fail-open, no demo
  // flash for real users); settled error with no cached payload → guest-tier
  // visitor default (their whole session is degraded anyway; server 401/403
  // backstops hold, and the next successful refetch self-heals).
  return isError;
}
