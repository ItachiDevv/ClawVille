'use client';

import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';

/**
 * Canonical `['auth-me']` query — ONE fetcher, shared by every consumer.
 *
 * WHY THIS EXISTS (Codex finding f3286668): ~10 components each hand-rolled
 * `useQuery({ queryKey: ['auth-me'], queryFn: <their own> })` with DIFFERENT
 * fetchers — some caught `api.me()` and returned `null`, some called it raw
 * and let a 401/network error throw. react-query keys a query by its
 * queryKey, and `QueryObserver.setOptions` hands the SHARED query object the
 * fetcher of whichever observer mounted/rendered LAST. So a window-focus
 * refetch could run through an UNCAUGHT fetcher, settle the one shared query
 * into `error` (data `undefined`), and leave the caught consumers reading a
 * state they never expect — auth consumers then disagreed about whether the
 * viewer was logged-in / guest / anonymous.
 *
 * The fix is that every consumer MUST use the SAME fetcher. Import
 * `useAuthMe()` (or `AUTH_ME_QUERY_KEY` + `fetchAuthMe` when a consumer needs
 * extra per-observer options like `staleTime`). NEVER hand-roll the key with
 * an inline queryFn again — that re-opens the last-writer-wins race.
 *
 * `fetchAuthMe` resolves `null` ONLY on a CONFIRMED 401 (no session) and
 * RE-THROWS everything else (network blip, 5xx). That distinction is
 * load-bearing (Codex round-3 BLOCKING): on a thrown refetch react-query
 * KEEPS the last successful `data`, so a logged-in user whose auth-me
 * refetch transiently fails still reads as logged-in from the cache —
 * `useIsGuest()` cannot flip to guest mid-session and unmount their
 * in-progress work (e.g. a bounty draft). Collapsing transient failures
 * into `null` would erase that distinction and force guest UI onto a real
 * user. Consumers branch on `data?.user?.…`; `null`/`undefined` are both
 * falsy there, so optional-chaining reads are unaffected either way.
 */

/** The shared cache key. Keep IDENTICAL so existing invalidate/remove/cache
 *  call sites keep hitting the same query. */
export const AUTH_ME_QUERY_KEY = ['auth-me'] as const;

/** Resolved auth-me payload, or `null` for CONFIRMED anonymous (401). */
export type AuthMe = Awaited<ReturnType<typeof api.me>> | null;

/**
 * The one shared fetcher. A confirmed 401 settles to `success(null)`
 * (resolved-anonymous); anything else re-throws so react-query preserves
 * the last successful payload — see the module header for why that matters.
 */
export async function fetchAuthMe(): Promise<AuthMe> {
  try {
    return await api.me();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // Confirmed: no valid session → resolved-anonymous.
      return null;
    }
    // Transient (network blip, 5xx): let the query error so the cached
    // last-known payload survives — do NOT masquerade as anonymous.
    throw err;
  }
}

/** Canonical auth-me query. Returns the full react-query result so consumers
 *  can read `data` / `isLoading` / `isFetched` / `isError` as before. */
export function useAuthMe() {
  return useQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: fetchAuthMe,
    retry: false,
  });
}
