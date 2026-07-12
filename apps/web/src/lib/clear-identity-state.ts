'use client';

/**
 * clearIdentityState — the ONE sweep for identity-bearing client state,
 * called on EVERY auth transition (login, signup, logout, account switch,
 * silent session expiry via IdentityTransitionWatcher).
 *
 * WHY THIS EXISTS (balance-cache audit 2026-07-11): the SPA's Zustand stores
 * are module-global singletons that survive soft navigation and auth
 * changes. `queryClient.clear()` wipes TanStack Query but NOT Zustand, so
 * before this sweep a guest's demo vCLAW balance stayed on screen after
 * login, and a logged-out user's real balance stayed in memory for the next
 * session (`useCoveStore.sessionBalance` was the worst offender — never
 * reset anywhere). One helper, called from every transition point, replaces
 * the drift-prone per-call-site lists.
 *
 * Ordering invariants (load-bearing — do not reorder casually):
 *   1. stopAutonomy() FIRST — resetStore() uses raw set() which bypasses
 *      setControlMode's cleanup, so the autonomy interval would keep ticking
 *      against a reset state (same reason as the old sidebar logout handler).
 *   2. Zustand resets before queryClient.clear() — store resets may fire
 *      fire-and-forget server POSTs (resetStore → Autonomous deactivate)
 *      that should go out before the cache nuke triggers refetch storms.
 *   3. At the LOGOUT call site this whole sweep runs BEFORE api.logout() —
 *      the §B.1 money-path belt: the Autonomous server-deactivate POST must
 *      leave with a still-valid cookie (see sidebar-menu.tsx).
 *
 * Stores are require()d lazily inside try/catch (the proven sidebar-menu
 * pattern): not every store module is loaded on every route, and statically
 * importing them here would pull game-world modules into the login bundle.
 */

import type { QueryClient } from '@tanstack/react-query';

export interface ClearIdentityStateOptions {
  /**
   * Keep local quest progress. Pass true on guest→signup/login: a guest's
   * tutorial progress must survive into the new account so it can claim the
   * rewards it earned ("Sign up to claim tutorial rewards" is a designed
   * flow). Logout / account-switch / expiry omit it so one identity's
   * progress never carries into another.
   */
  preserveQuestProgress?: boolean;
}

export function clearIdentityState(
  queryClient: QueryClient,
  opts?: ClearIdentityStateOptions,
): void {
  try {
    const { useAutonomyStore } = require('@/stores/autonomy') as typeof import('@/stores/autonomy');
    useAutonomyStore.getState().stopAutonomy();
  } catch { /* store not loaded on this route */ }

  try {
    const { useGameStore } = require('@/stores/game') as typeof import('@/stores/game');
    useGameStore.getState().resetStore();
  } catch { /* store not loaded on this route */ }

  try {
    const { useCoveStore } = require('@/stores/cove') as typeof import('@/stores/cove');
    useCoveStore.getState().resetCoveStore();
  } catch { /* store not loaded on this route */ }

  try {
    const { usePokerStore } = require('@/stores/poker') as typeof import('@/stores/poker');
    usePokerStore.getState().reset(null);
  } catch { /* store not loaded on this route */ }

  try {
    const { useActivityStore } = require('@/stores/activity') as typeof import('@/stores/activity');
    useActivityStore.getState().reset(null);
  } catch { /* store not loaded on this route */ }

  try {
    const { usePlayerStore } = require('@/stores/players') as typeof import('@/stores/players');
    usePlayerStore.getState().clear();
  } catch { /* store not loaded on this route */ }

  try {
    const { useResearchStore } = require('@/stores/research') as typeof import('@/stores/research');
    useResearchStore.getState().clearThoughts();
    useResearchStore.getState().clearCollaborationEntries();
  } catch { /* store not loaded on this route */ }

  try {
    // Guest land sandbox persists demoCt (demo vCLAW) to localStorage — it
    // should never be displayed in an authed session.
    const { useGuestLandSandbox } =
      require('@/stores/land-guest-sandbox') as typeof import('@/stores/land-guest-sandbox');
    useGuestLandSandbox.getState().resetSandbox();
  } catch { /* store not loaded on this route */ }

  if (!opts?.preserveQuestProgress) {
    try {
      const { useQuestStore } = require('@/stores/quest') as typeof import('@/stores/quest');
      useQuestStore.getState().resetQuestStore();
    } catch { /* store not loaded on this route */ }
  }

  // LAST: nuke the shared TanStack cache so every query (auth-me, avatar,
  // wallet-balances, wallet-link, agent-session, leaderboards, …) refetches
  // under the new identity. Active observers refetch automatically.
  queryClient.clear();
}
