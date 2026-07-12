'use client';

/**
 * IdentityTransitionWatcher — null-rendering belt behind the explicit
 * login/logout sweeps. Watches the canonical ['auth-me'] query and runs
 * `clearIdentityState` whenever the RESOLVED identity changes, catching the
 * transitions no button handler sees:
 *
 *   - silent session expiry mid-session (user → null): before this, the
 *     global ['avatar'] cache kept the expired user's avatar+balance on
 *     screen, and GuestAvatarBootstrap refused to guest-bootstrap while
 *     that cached avatar existed;
 *   - account switch in another tab (user A → user B);
 *   - any auth change that bypassed the login/logout call sites.
 *
 * Mounted ONCE in providers.tsx (inside QueryClientProvider) so it survives
 * soft navigation for the whole SPA session.
 *
 * Semantics (each rule is load-bearing):
 *   - `data === undefined` = query loading/unresolved → do nothing. Note
 *     fetchAuthMe resolves null ONLY on a confirmed 401 and RE-THROWS
 *     transient errors, so react-query keeps the last successful payload on
 *     a blip — `data` never flaps to undefined/null mid-session from a
 *     network error (see use-auth-me.ts module header).
 *   - First RESOLUTION only records the identity (cold load is not a
 *     transition).
 *   - The ref updates BEFORE the sweep: clearIdentityState wipes ['auth-me']
 *     itself, which triggers a refetch that resolves the SAME identity —
 *     ref already equal, so no clear-refetch loop.
 *   - Explicit login/logout call sites still sweep first themselves; the
 *     watcher firing again right after is one redundant refetch cycle per
 *     auth change, accepted for the guarantee that NO transition path is
 *     ever missed.
 *   - Quest progress survives ONLY an upgrade-into-account transition
 *     (guest→user or anonymous→user): a guest's local tutorial progress
 *     must stay claimable by the account it just created ("Sign up to
 *     claim" is a designed flow — same reason the login page passes
 *     preserveQuestProgress). Logout/expiry (→ null) and real-account
 *     switches (non-guest A → B) wipe it, so one identity's progress never
 *     carries into another.
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthMe } from '@/hooks/use-auth-me';
import { clearIdentityState } from '@/lib/clear-identity-state';

interface SeenIdentity {
  id: string | null;
  isGuest: boolean;
}

export function IdentityTransitionWatcher() {
  const queryClient = useQueryClient();
  const { data } = useAuthMe();
  // null = not yet resolved (cold load); distinct from a resolved-anonymous
  // identity, which is { id: null, isGuest: false }.
  const lastRef = useRef<SeenIdentity | null>(null);

  useEffect(() => {
    if (data === undefined) return; // loading / not yet resolved
    const next: SeenIdentity = {
      id: data?.user?.id ?? null,
      isGuest: data?.user?.isGuest === true,
    };

    const prev = lastRef.current;
    if (prev === null) {
      lastRef.current = next; // cold load — record, never clear
      return;
    }
    if (prev.id !== next.id) {
      lastRef.current = next; // update BEFORE the sweep — loop guard
      const upgradeIntoAccount = next.id !== null && (prev.id === null || prev.isGuest);
      clearIdentityState(queryClient, { preserveQuestProgress: upgradeIntoAccount });
    } else {
      lastRef.current = next; // same identity — track isGuest drift only
    }
  }, [data, queryClient]);

  return null;
}
