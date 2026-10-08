/**
 * Phase 1 anti-farm — browser visitor-ID generator.
 *
 * Wraps `@fingerprintjs/fingerprintjs` (OSS) in a load-once / cache-forever
 * shim. Returns a stable per-browser identifier that we ship to the API as
 * the `X-CV-Fingerprint` header.
 *
 * The server NEVER persists this raw value — middleware/fingerprint.ts hashes
 * it with `FINGERPRINT_SECRET` before writing to `events.fp_hash`. The hash
 * is ClawVille-scoped (no third party can re-derive it) and permanent (no
 * daily rotation), which makes multi-day farm detection possible while keeping
 * the identifier non-portable.
 *
 * Load-path cache (web-load T4, 2026-10-06): FingerprintJS's canvas sources
 * do a synchronous GPU readback (one 0.47-0.58 s main-thread task on a cold
 * /game load, measured on prod) and every fingerprinted API call awaits it.
 * The computed visitorId is therefore persisted in localStorage
 * (`cv:fp:v1`) and served immediately on later loads, so a returning browser
 * never runs FingerprintJS on the load path. The value stays a FingerprintJS
 * visitorId (32 lowercase hex chars, validated on read); this adds no trust,
 * because the header was always client-supplied. A background re-compute,
 * deferred well past the loader, refreshes the stored value; a changed value
 * takes effect on the NEXT page load, so one page keeps one identity (no
 * mid-session header switch that would orphan a guest's fp-keyed state).
 * A first visit (no valid cache) keeps the old behavior: compute on the
 * first call, shared by concurrent callers.
 * Two tabs with no cache compute in parallel and the last storage write wins
 * for the next load. Tabs on one display get the same visitorId; FingerprintJS
 * hashes `screen` (screenResolution, screenFrame), so windows on displays
 * with different sizes can get different values. Each tab also computed its
 * own value before this cache, so this is not a regression; after the write,
 * every tab of the browser sends one value.
 *
 * Failure modes:
 *   - SSR / non-browser: returns '' (server middleware falls back to UA+IP)
 *   - FingerprintJS load error: console.warn + returns '' (same fallback);
 *     '' is never written to storage
 *   - localStorage missing / throwing / corrupt: ignored, live compute
 *
 * Either way the event row never lands NULL — fallback chain in middleware
 * guarantees a hashed value is always written.
 */

import FingerprintJS from '@fingerprintjs/fingerprintjs';

/** localStorage key for the persisted visitorId. Bump the suffix to invalidate. */
export const FINGERPRINT_STORAGE_KEY = 'cv:fp:v1';

/** FingerprintJS v4 visitorId = x64hash128 → exactly 32 lowercase hex chars. */
const VISITOR_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Delay before the background refresh. The measured cold /game loader ends
 * at 7.7-8.5 s on a desktop GPU and by its 10 s fallback fuse at 23 s on a
 * 4x-CPU proxy, so 30 s keeps the canvas pass off the load path on both.
 */
const REFRESH_DELAY_MS = 30_000;
const REFRESH_IDLE_TIMEOUT_MS = 30_000;

let cachedVisitorId: string | null = null;
let loadPromise: Promise<string> | null = null;
let refreshScheduled = false;

function readStoredVisitorId(): string | null {
  try {
    const stored = window.localStorage?.getItem(FINGERPRINT_STORAGE_KEY);
    return stored && VISITOR_ID_PATTERN.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

function storeVisitorId(visitorId: string): void {
  if (!VISITOR_ID_PATTERN.test(visitorId)) return;
  try {
    window.localStorage?.setItem(FINGERPRINT_STORAGE_KEY, visitorId);
  } catch {
    // Storage full / disabled: the next load computes live, as before.
  }
}

async function computeVisitorId(): Promise<string> {
  const fp = await FingerprintJS.load();
  const result = await fp.get();
  return result.visitorId;
}

async function refreshStoredVisitorId(): Promise<void> {
  try {
    const visitorId = await computeVisitorId();
    if (visitorId && visitorId !== cachedVisitorId) storeVisitorId(visitorId);
  } catch {
    // Keep the stored value; this page already sends it.
  }
}

function scheduleBackgroundRefresh(): void {
  if (refreshScheduled) return;
  refreshScheduled = true;
  window.setTimeout(() => {
    const run = () => {
      void refreshStoredVisitorId();
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: REFRESH_IDLE_TIMEOUT_MS });
    } else {
      run();
    }
  }, REFRESH_DELAY_MS);
}

export async function getFingerprint(): Promise<string> {
  // SSR / Node / SSG render — no `window`, skip.
  if (typeof window === 'undefined') return '';

  if (cachedVisitorId !== null) return cachedVisitorId;
  if (loadPromise) return loadPromise;

  const stored = readStoredVisitorId();
  if (stored) {
    cachedVisitorId = stored;
    scheduleBackgroundRefresh();
    return stored;
  }

  loadPromise = (async () => {
    try {
      const visitorId = await computeVisitorId();
      cachedVisitorId = visitorId;
      if (visitorId) storeVisitorId(visitorId);
      return visitorId;
    } catch (err) {
      // Surface once, then degrade quietly. Server middleware will compute
      // a UA+IP-based hash so the row still gets a non-NULL fp_hash.
      console.warn(
        '[fingerprint] failed to compute visitor ID — server falls back to UA+IP hash',
        err,
      );
      cachedVisitorId = '';
      return '';
    }
  })();

  return loadPromise;
}
