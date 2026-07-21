'use client';

import type { QueryClient } from '@tanstack/react-query';
import { AUTH_ME_QUERY_KEY, type AuthMe } from '@/hooks/use-auth-me';
import { api } from '@/lib/api';
import { clearIdentityState } from '@/lib/clear-identity-state';

/**
 * Sweep identity-bearing client state while the OLD cookie is still active.
 * This ordering is security-sensitive: resetStore may deactivate an autonomous
 * agent, and doing that after login could aim the request at the new account.
 */
export function prepareForAccountLogin(queryClient: QueryClient): void {
  const prior = queryClient.getQueryData<AuthMe>(AUTH_ME_QUERY_KEY);
  const priorWasAccountUser = !!prior?.user && !prior.user.isGuest;
  clearIdentityState(queryClient, {
    preserveQuestProgress: !priorWasAccountUser,
  });
}

/**
 * Reconcile every identity cache after an auth cookie changes. The broad reset
 * prevents old-account feature data from surviving the swap; the targeted
 * invalidations guarantee the game page's auth/avatar/agent-session observers
 * are stale even when one was disabled during the reset.
 *
 * Cache refresh failures must not turn a successful server login into a false
 * credential error. Active observers retain their normal retry/error UI and
 * will revalidate again on focus.
 */
export async function refreshIdentityAfterAuth(
  queryClient: QueryClient,
): Promise<void> {
  await queryClient.cancelQueries().catch(() => undefined);
  // Preserve the existing all-cache identity sweep without making an in-game
  // login wait for every unrelated active world query to settle. The three
  // auth-critical observers below are awaited explicitly (TanStack dedupes a
  // refetch already started by resetQueries).
  void queryClient.resetQueries().catch(() => undefined);
  await Promise.allSettled([
    queryClient.invalidateQueries({ queryKey: AUTH_ME_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: ['avatar'] }),
    queryClient.invalidateQueries({ queryKey: ['agent-session'] }),
  ]);
}

/**
 * Claim fingerprint-keyed Cove demo history for the newly authenticated user.
 * The API operation is idempotent and intentionally non-blocking for login.
 */
export async function claimGuestCoveHistoryAfterAuth(): Promise<void> {
  try {
    const claim = await api.claimCoveHistory();
    if (claim.claimed > 0 && typeof window !== 'undefined') {
      const plural = claim.claimed === 1 ? '' : 's';
      window.sessionStorage.setItem(
        'cv-cove-claim-toast',
        `Claimed ${claim.claimed} guest play${plural} from your previous session.`,
      );
    }
  } catch {
    // History reconciliation is never load-bearing for authentication.
  }
}
