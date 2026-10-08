/**
 * suspense-cache-warm.ts — resolve a Suspense cache entry OUTSIDE render.
 *
 * Why (web-load T7, staging ac36e4e1 runs A2/B2): a boot-critical member that
 * first renders while its GLB is still loading suspends, and its content can
 * then commit only in a React Suspense RETRY lane. In react-reconciler 0.31
 * (R3F 9.5) retry lanes never expire, render time-sliced, and wait for the
 * 300 ms reveal throttle. The 5 Hz world-stream snapshots re-render the R3F
 * root at SyncLane (Zustand -> useSyncExternalStore), and every sync render
 * discards the retry work. On a slow CPU the retry never commits (> 100 s).
 *
 * The fix: call the consumer's OWN reader (the same loader call, so the same
 * cache key and loader extender) before the release setState. When the read
 * throws a thenable (the cache entry is loading), await it and read again.
 * The release render then reads a resolved entry, never suspends, and commits
 * in the release update's own lane (Default: one uninterrupted pass, expires).
 *
 * Contract:
 * - Never rejects. A thrown Error (a cached load failure) resolves at once:
 *   the render rethrows that error into the existing error boundary, so the
 *   ModelLoadError tagging and the failed-cohort path do not change.
 * - At most MAX_RETRIES re-reads. If the reader keeps throwing NEW thenables
 *   (a cache-key mismatch), the warm gives up and the member mounts as before
 *   (it suspends; its <Suspense> boundary is the safety net). Never worse
 *   than the behaviour without the warm.
 * - `read` must call NO React hook. drei useGLTF and R3F 9.5 useLoader only
 *   read the suspend-react cache (guarded by suspense-cache-warm.test.ts).
 */

/** Re-reads allowed after the first read (so at most 3 reads in total). */
export const SUSPENSE_WARM_MAX_RETRIES = 2;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export async function warmSuspenseRead(read: () => unknown): Promise<void> {
  for (let attempt = 0; attempt <= SUSPENSE_WARM_MAX_RETRIES; attempt += 1) {
    let thrown: unknown;
    try {
      read();
      return; // Resolved entry: the render will not suspend.
    } catch (error) {
      thrown = error;
    }
    // A load failure (Error): the render rethrows it into the boundary.
    if (!isThenable(thrown)) return;
    // No re-read follows the last allowed attempt: release without awaiting.
    if (attempt === SUSPENSE_WARM_MAX_RETRIES) return;
    try {
      await thrown;
    } catch {
      // The cache entry records the failure; the next read throws it.
    }
  }
}
