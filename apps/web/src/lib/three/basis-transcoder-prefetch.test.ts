/**
 * Basis transcoder boot prefetch (web-load T3, 2026-10-06).
 *
 * three r185 KTX2Loader fetches `basis_transcoder.js` + `.wasm` lazily, inside
 * `init()`, which the FIRST `_createTexture` (first KHR_texture_basisu parse)
 * calls. Prod measured that request at "core presented" (3.46-4.07 s), so the
 * first KTX2 transcode waited 0.44-0.65 s for the wasm. The fix warms the
 * browser HTTP cache at /game boot with the SAME URLs and the same request
 * mode/credentials, so the loader's later request is a cache hit.
 *
 * Pins:
 *  1. the prefetch fires once, low priority, with exactly the loader URLs, and
 *     reads each body to the end (an unread body does not complete the cache
 *     entry);
 *  2. the app's shared KTX2Loader (the factory `<KTX2LoaderSetup />` uses)
 *     requests exactly those URLs, with the default mode and same-origin
 *     credentials a plain `fetch(url)` also uses;
 *  3. the boot chain: /game first mount effect -> preloadWorldAssets() ->
 *     prefetchBasisTranscoder();
 *  4. the service-worker precache roster names the same two URLs.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASIS_TRANSCODER_PATH,
  BASIS_TRANSCODER_URLS,
  prefetchBasisTranscoder,
} from './basis-transcoder-prefetch';
import { createKTX2Loader } from './ktx2-loader-setup';

const WEB_ROOT = join(import.meta.dir, '..', '..', '..');
const originalFetch = globalThis.fetch;
const originalRequest = globalThis.Request;
const hadWindow = 'window' in globalThis;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.Request = originalRequest;
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

describe('basis transcoder boot prefetch', () => {
  test('the transcoder path and file names are unchanged', () => {
    expect(BASIS_TRANSCODER_PATH).toBe('/basis/');
    expect([...BASIS_TRANSCODER_URLS]).toEqual([
      '/basis/basis_transcoder.js',
      '/basis/basis_transcoder.wasm',
    ]);
  });

  test('fires once, low priority, exact URLs, default mode/credentials, body read', async () => {
    if (!hadWindow) (globalThis as { window?: unknown }).window = globalThis;
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses: Response[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const res = new Response(new Uint8Array([0, 97, 115, 109]), { status: 200 });
      responses.push(res);
      return res;
    }) as typeof fetch;

    prefetchBasisTranscoder();
    prefetchBasisTranscoder(); // second boot call (StrictMode / remount) is a no-op

    expect(calls.map((c) => c.url)).toEqual([...BASIS_TRANSCODER_URLS]);
    for (const { init } of calls) {
      expect(init?.priority).toBe('low');
      // No mode / credentials / cache override: the request must share the
      // HTTP-cache entry with KTX2Loader's FileLoader Request (mode 'cors',
      // credentials 'same-origin', cache 'default').
      expect(init?.mode).toBeUndefined();
      expect(init?.credentials).toBeUndefined();
      expect(init?.cache).toBeUndefined();
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(responses).toHaveLength(2);
    for (const res of responses) expect(res.bodyUsed).toBe(true);
  });

  test('the shared KTX2Loader requests exactly the prefetched URLs', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    // Bun rejects relative URLs in `new Request`; record what FileLoader asks for.
    globalThis.Request = class {
      url: string;
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        this.url = String(input);
        requests.push({ url: this.url, init });
      }
    } as unknown as typeof Request;
    // Reject so FileLoader clears its module-level in-flight map (no leak into
    // other test files in the same process).
    globalThis.fetch = (async () => {
      throw new TypeError('offline in test');
    }) as unknown as typeof fetch;

    const fakeWebGPURenderer = { isWebGPURenderer: true, hasFeature: () => false };
    const loader = createKTX2Loader(fakeWebGPURenderer);
    expect(loader.transcoderPath).toBe(BASIS_TRANSCODER_PATH);
    expect(loader.workerConfig).not.toBeNull(); // detectSupport ran

    await loader.init().catch(() => undefined);
    loader.dispose();

    expect(requests.map((r) => r.url).sort()).toEqual([...BASIS_TRANSCODER_URLS].sort());
    for (const { init } of requests) {
      expect(init?.credentials).toBe('same-origin'); // fetch(url) default for same-origin
      expect(init?.mode).toBeUndefined(); // Request default 'cors' == fetch(url) default
    }
  });

  test('boot chain: /game mount effect -> preloadWorldAssets -> prefetchBasisTranscoder', () => {
    const page = readFileSync(join(WEB_ROOT, 'src/app/(world)/game/page.tsx'), 'utf8');
    expect(page).toMatch(/useEffect\(\(\) => \{[^}]*preloadWorldAssets\(\);[^}]*\}, \[\]\);/);

    const manifest = readFileSync(join(WEB_ROOT, 'src/lib/three/asset-preload-manifest.ts'), 'utf8');
    const body = manifest.match(/export function preloadWorldAssets\(\): void \{([\s\S]*?)\n\}/);
    expect(body).not.toBeNull();
    expect(body![1]).toContain('prefetchBasisTranscoder();');
    expect(manifest).toContain("from '@/lib/three/basis-transcoder-prefetch'");
  });

  test('the service-worker precache roster names the same transcoder URLs', () => {
    const sw = readFileSync(join(WEB_ROOT, 'public/sw.js'), 'utf8');
    const roster = sw.match(/const PRECACHE_BASIS = \[([\s\S]*?)\];/);
    expect(roster).not.toBeNull();
    const urls = [...roster![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(urls).toEqual([...BASIS_TRANSCODER_URLS]);
  });
});
