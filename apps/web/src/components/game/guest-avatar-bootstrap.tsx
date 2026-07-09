'use client';

/**
 * Listens for the `clawville:ensure-guest-avatar` window event (dispatched
 * from `useGameStore.setControlMode('npc')`) and bootstraps a guest
 * avatar for un-authenticated visitors so they can play activity games +
 * chat with NPCs without going through the signup flow.
 *
 * Mounted once at the /game and /activity pages. Has no UI — it's a
 * pure side-effect component.
 *
 * The actual single-flight + network call lives in
 * `lib/guest-bootstrap.ts`; this component owns the React-side
 * concerns: invalidating the avatar query so the avatar appears, and
 * showing a welcome toast.
 *
 * Why a window event vs. calling api directly from the store?
 *   - The Zustand store has no QueryClient access — react-query is a
 *     React-tree concern, not a global one.
 *   - The window event keeps the store free of "do I have an avatar
 *     already?" branches; this component checks the cache itself.
 *   - It's also useful as a debug hook (`window.dispatchEvent(new
 *     CustomEvent('clawville:ensure-guest-avatar'))` from devtools).
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AUTH_ME_QUERY_KEY } from '@/hooks/use-auth-me';
import { ensureGuestAvatar } from '@/lib/guest-bootstrap';
import { useGameStore } from '@/stores/game';

export function GuestAvatarBootstrap() {
  const queryClient = useQueryClient();
  const addToast = useGameStore((s) => s.addToast);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    async function handle(): Promise<void> {
      // Skip if we already have an avatar in the cache — no need to bootstrap.
      const cached = queryClient.getQueryData<{ avatar: unknown } | undefined>(['avatar']);
      if (cached?.avatar) return;

      const result = await ensureGuestAvatar();
      if (!result) return; // 429 or network error — silent
      // Force a refetch so the player-avatar 3D component picks up the new avatar.
      // ALSO refetch auth-me (2026-06-10, Codex finding): the guest mint creates
      // a guest user server-side, but a previously-cached `null` auth-me left
      // `isGuest` reading false on /game — so the explore→player promotion
      // gate (`!isGuest`) didn't see the guest and still hijacked the mode.
      // Both caches must agree before the avatar-sync effect runs.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['avatar'] }),
        queryClient.invalidateQueries({ queryKey: AUTH_ME_QUERY_KEY }),
      ]);
      // Welcome toast — only show when we ACTUALLY minted a guest (not when
      // the server reused an existing session).
      if (!result.reused && result.user.isGuest) {
        addToast(
          '🎮',
          'Welcome! You are playing as a guest — no account needed.',
          5000,
        );
      }
    }

    function listener(): void {
      void handle();
    }

    window.addEventListener('clawville:ensure-guest-avatar', listener);
    return () => {
      window.removeEventListener('clawville:ensure-guest-avatar', listener);
    };
  }, [queryClient, addToast]);

  return null;
}
