'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

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
 * `fetchAuthMe` NEVER throws: a 401 (no session) or a transient network
 * failure both resolve to `null` (resolved-anonymous), so the query settles
 * to `success` with `data: null` rather than `error` with `data: undefined`.
 * Consumers branch on `data?.user?.…`; `null` and `undefined` are both falsy
 * there, so existing optional-chaining reads are unaffected. The one belt
 * that still reads `isError` (`use-is-guest.ts`) keeps working — `isError`
 * simply never fires now.
 */

/** The shared cache key. Keep IDENTICAL so existing invalidate/remove/cache
 *  call sites keep hitting the same query. */
export const AUTH_ME_QUERY_KEY = ['auth-me'] as const;

/** Resolved auth-me payload, or `null` for anonymous / transient failure. */
export type AuthMe = Awaited<ReturnType<typeof api.me>> | null;

/**
 * The one shared fetcher. Catches so the query settles to `success(null)`
 * instead of `error(undefined)` — see the module header for why that matters.
 */
export async function fetchAuthMe(): Promise<AuthMe> {
  try {
    return await api.me();
  } catch {
    // 401 (no session) or network failure → resolved-anonymous.
    return null;
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
