/**
 * basis-transcoder-prefetch.ts
 *
 * three r185 KTX2Loader downloads `basis_transcoder.js` + `.wasm` lazily: its
 * `init()` runs on the FIRST KHR_texture_basisu transcode (`_createTexture`),
 * and that transcode waits for both files. On prod the first transcode starts
 * at "core presented" (3.46-4.07 s after navigation), so the 248 KB (gzip)
 * wasm download (0.44-0.65 s, Cloudflare DYNAMIC) sat on the critical path.
 *
 * `prefetchBasisTranscoder()` warms the browser HTTP cache at /game boot
 * (`preloadWorldAssets()`), in parallel with the JS and world chunks:
 * - SAME URLs as the loader (`BASIS_TRANSCODER_PATH` is also the path
 *   `<KTX2LoaderSetup />` passes to `setTranscoderPath`);
 * - SAME request shape as three's FileLoader `Request` (default mode 'cors',
 *   credentials 'same-origin', cache 'default'), so both share one HTTP-cache
 *   entry. Origin sends `Cache-Control: public, max-age=31536000, immutable`
 *   (next.config.mjs `/basis/:path*`);
 * - the body is read to the end, because an unread body does not complete
 *   the cache entry;
 * - raw `fetch`, NOT a FileLoader: THREE.DefaultLoadingManager (the loading
 *   bar) does not see it, and the loader keeps its own lazy `init()`.
 * - `priority: 'low'`: it must not delay the boot JS chunks or the locomotion
 *   clips; it is needed only when phase D starts.
 *
 * When the service worker controls the page, both requests are served
 * cache-first from Cache Storage (`sw.js` `isBasisRequest`). The SW's own
 * post-first-paint roster pass revalidates these unversioned URLs with
 * `cache: 'no-cache'` (a conditional request), the same as before this file.
 *
 * Failure is silent: the loader fetches the files itself, as before.
 *
 * These files are NOT content-hashed. A three upgrade that changes the
 * transcoder MUST move them to a new directory (e.g. `/basis/r186/`) by
 * changing BASIS_TRANSCODER_PATH here AND sw.js PRECACHE_BASIS. A `?v=N`
 * query does not work: KTX2Loader appends the fixed file names to the path.
 * Otherwise browsers and the Cloudflare edge keep the old copy for up to a
 * year (immutable, max-age=31536000).
 */

/** Directory passed to `KTX2Loader.setTranscoderPath`. */
export const BASIS_TRANSCODER_PATH = '/basis/';

/** The two URLs KTX2Loader.init() requests (path + its fixed file names). */
export const BASIS_TRANSCODER_URLS: readonly string[] = [
  `${BASIS_TRANSCODER_PATH}basis_transcoder.js`,
  `${BASIS_TRANSCODER_PATH}basis_transcoder.wasm`,
];

let _prefetchStarted = false;

/** Fire-and-forget; runs once per page load. */
export function prefetchBasisTranscoder(): void {
  if (_prefetchStarted) return;
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  _prefetchStarted = true;
  for (const url of BASIS_TRANSCODER_URLS) {
    fetch(url, { priority: 'low' })
      .then((res) => res.arrayBuffer())
      .catch(() => undefined);
  }
}
