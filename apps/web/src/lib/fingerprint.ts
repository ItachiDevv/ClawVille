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
 * Failure modes:
 *   - SSR / non-browser: returns '' (server middleware falls back to UA+IP)
 *   - FingerprintJS load error: console.warn + returns '' (same fallback)
 *
 * Either way the event row never lands NULL — fallback chain in middleware
 * guarantees a hashed value is always written.
 */

import FingerprintJS from '@fingerprintjs/fingerprintjs';

let cachedVisitorId: string | null = null;
let loadPromise: Promise<string> | null = null;

export async function getFingerprint(): Promise<string> {
  // SSR / Node / SSG render — no `window`, skip.
  if (typeof window === 'undefined') return '';

  if (cachedVisitorId !== null) return cachedVisitorId;

  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const fp = await FingerprintJS.load();
        const result = await fp.get();
        cachedVisitorId = result.visitorId;
        return result.visitorId;
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
  }

  return loadPromise;
}
