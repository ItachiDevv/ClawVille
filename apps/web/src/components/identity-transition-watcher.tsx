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
 *   - First RESOLUTION records the identity without a sweep (cold load is
 *     not a transition) but DOES run the quest-owner reconcile below.
 *   - The ref updates BEFORE the sweep: clearIdentityState resets
 *     ['auth-me'] itself, which refetches and resolves the SAME identity —
 *     ref already equal, so no clear-refetch loop. (The sweep uses
 *     resetQueries, not clear(), precisely so this subscription survives —
 *     clear() removes subscriber wiring and would make this watcher
 *     one-shot; Codex review BLOCKING 1.)
 *   - Explicit login/logout call sites still sweep first themselves; the
 *     watcher firing again right after is one redundant refetch cycle per
 *     auth change, accepted for the guarantee that NO transition path is
 *     ever missed.
 *   - Quest progress survives ONLY an upgrade-into-account transition
 *     (guest/anonymous → user): a guest's local tutorial progress must stay
 *     claimable by the account it just created ("Sign up to claim" is a
 *     designed flow). Logout/expiry (→ null) and account switches wipe it.
 *
 * Quest-owner reconcile (Codex review BLOCKING 5): quest progress is
 * localStorage-persisted, so a leftover blob from an EXPIRED session
 * survives cold loads — without an owner check, "anonymous→account" on a
 * shared machine would hand user A's persisted progress to user B. On every
 * resolution: a blob owned by a DIFFERENT account than the resolved one
 * (including guest/anonymous resolutions, ownerId≠null) is reset; a
 * resolved account then stamps itself as owner — unowned (guest-era) blobs
 * stamp without reset, which IS the designed upgrade claim. The quest store
 * uses skipHydration (see quest.ts persist config), so the reconcile runs
 * now if hydrated and re-runs after persist.rehydrate() — reconciling only
 * pre-hydration would be overwritten by the merge when /game rehydrates.
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthMe } from '@/hooks/use-auth-me';
import { clearIdentityState } from '@/lib/clear-identity-state';

interface SeenIdentity {
  id: string | null;
  isGuest: boolean;
}

/** The resolved ACCOUNT id — guests/anonymous resolve to null on purpose. */
function accountId(seen: SeenIdentity): string | null {
  return seen.id !== null && !seen.isGuest ? seen.id : null;
}

export function IdentityTransitionWatcher() {
  const queryClient = useQueryClient();
  const { data } = useAuthMe();
  // null = not yet resolved (cold load); distinct from a resolved-anonymous
  // identity, which is { id: null, isGuest: false }.
  const lastRef = useRef<SeenIdentity | null>(null);
  // Undo handle for a pending post-hydration reconcile so repeated
  // resolutions don't stack listeners.
  const unsubHydrationRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (data === undefined) return; // loading / not yet resolved
    const next: SeenIdentity = {
      id: data?.user?.id ?? null,
      isGuest: data?.user?.isGuest === true,
    };

    const reconcileQuestOwner = () => {
      try {
        const { useQuestStore } = require('@/stores/quest') as typeof import('@/stores/quest');
        const account = accountId(next);
        const run = () => {
          const s = useQuestStore.getState();
          if (s.ownerUserId !== null && s.ownerUserId !== account) {
            s.resetQuestStore(); // another account's (or an expired account's) blob
          }
          if (account !== null) {
            useQuestStore.getState().setQuestOwner(account);
          }
        };
        unsubHydrationRef.current?.();
        unsubHydrationRef.current = null;
        if (useQuestStore.persist.hasHydrated()) {
          run();
        } else {
          run(); // pre-hydration state is defaults — harmless, keeps invariants simple
          unsubHydrationRef.current = useQuestStore.persist.onFinishHydration(run);
        }
      } catch { /* store not loaded on this route */ }
    };

    const prev = lastRef.current;
    if (prev === null) {
      lastRef.current = next; // cold load — record, never sweep
      reconcileQuestOwner();
      return;
    }
    if (prev.id !== next.id) {
      lastRef.current = next; // update BEFORE the sweep — loop guard
      const upgradeIntoAccount = next.id !== null && (prev.id === null || prev.isGuest);
      clearIdentityState(queryClient, { preserveQuestProgress: upgradeIntoAccount });
      reconcileQuestOwner();
    } else {
      lastRef.current = next; // same identity — track isGuest drift only
    }
  }, [data, queryClient]);

  return null;
}
