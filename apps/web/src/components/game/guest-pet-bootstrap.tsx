'use client';

/**
 * Listens for the `clawville:ensure-guest-pet` window event (dispatched
 * from `useGameStore.setControlMode('npc')`) and bootstraps a guest
 * pet for un-authenticated visitors so they can play activity games +
 * chat with NPCs without going through the signup flow.
 *
 * Mounted once at the /game and /activity pages. Has no UI — it's a
 * pure side-effect component.
 *
 * The actual single-flight + network call lives in
 * `lib/guest-bootstrap.ts`; this component owns the React-side
 * concerns: invalidating the pet query so the avatar appears, and
 * showing a welcome toast.
 *
 * Why a window event vs. calling api directly from the store?
 *   - The Zustand store has no QueryClient access — react-query is a
 *     React-tree concern, not a global one.
 *   - The window event keeps the store free of "do I have a pet
 *     already?" branches; this component checks the cache itself.
 *   - It's also useful as a debug hook (`window.dispatchEvent(new
 *     CustomEvent('clawville:ensure-guest-pet'))` from devtools).
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ensureGuestPet } from '@/lib/guest-bootstrap';
import { useGameStore } from '@/stores/game';

export function GuestPetBootstrap() {
  const queryClient = useQueryClient();
  const addToast = useGameStore((s) => s.addToast);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    async function handle(): Promise<void> {
      // Skip if we already have a pet in the cache — no need to bootstrap.
      const cached = queryClient.getQueryData<{ pet: unknown } | undefined>(['pet']);
      if (cached?.pet) return;

      const result = await ensureGuestPet();
      if (!result) return; // 429 or network error — silent
      // Force a refetch so the player-pet 3D component picks up the new pet.
      await queryClient.invalidateQueries({ queryKey: ['pet'] });
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

    window.addEventListener('clawville:ensure-guest-pet', listener);
    return () => {
      window.removeEventListener('clawville:ensure-guest-pet', listener);
    };
  }, [queryClient, addToast]);

  return null;
}
