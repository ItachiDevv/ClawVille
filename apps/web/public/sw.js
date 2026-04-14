// ClawVille Service Worker
// Cache-first for GLBs + basis WASM; network-first for Next.js JS chunks.
// Bump CACHE_VERSION whenever GLB content changes to bust the GLB cache.

const CACHE_VERSION = 'v2';
const GLB_CACHE = `clawville-glb-${CACHE_VERSION}`;
const STATIC_CACHE = `clawville-static-${CACHE_VERSION}`;

// Individual file size limit: skip caching files larger than this.
const MAX_INDIVIDUAL_BYTES = 10 * 1024 * 1024; // 10 MB

// Total GLB cache size limit. Entries are evicted oldest-first if exceeded.
const MAX_GLB_CACHE_BYTES = 20 * 1024 * 1024; // 20 MB

// Critical-path GLBs pre-cached at install time.
// All 10 building models + player + terrain decorations (~6.2 MB total).
const PRECACHE_GLBS = [
  '/models/lobster.glb',               // 196 KB — player character
  '/models/underwater-decorations.glb', // 1.0 MB — terrain decoration layer
  '/models/coral-reef1.glb',            // 388 KB
  '/models/coral-reef2.glb',            // 192 KB
  '/models/coral-reef3.glb',            // 260 KB
  '/models/kelp.glb',                   //  25 KB
  '/models/building-seashell.glb',      // 108 KB
  // All 10 building models — visible from any camera angle
  '/models/pineapple-house.glb',        // 544 KB
  '/models/salty-spitoon.glb',          // 380 KB
  '/models/chum-bucket.glb',            // 608 KB
  '/models/downtown-building.glb',      // 289 KB
  '/models/bb-building.glb',            // 209 KB
  '/models/building-cave.glb',          // 309 KB
  '/models/patty-building.glb',         // 506 KB
  '/models/boating-school.glb',         // 548 KB
  '/models/building-submarine.glb',     // 363 KB
  '/models/building-lighthouse.glb',    // 197 KB
];

// Basis KTX2 WASM transcoder — tiny but needed before any KTX2 texture loads.
const PRECACHE_BASIS = [
  '/basis/basis_transcoder.js',
  '/basis/basis_transcoder.wasm',
];

const ALL_PRECACHE = [...PRECACHE_GLBS, ...PRECACHE_BASIS];

// ─── helpers ─────────────────────────────────────────────────────────────────

function isGlbRequest(url) {
  return url.pathname.startsWith('/models/') && url.pathname.endsWith('.glb');
}

function isBasisRequest(url) {
  return url.pathname.startsWith('/basis/');
}

function isNextChunk(url) {
  return url.pathname.startsWith('/_next/static/');
}

function isApiRequest(url) {
  // Skip our own API path and the separate api subdomain.
  return (
    url.pathname.startsWith('/api/') ||
    url.hostname === 'api.clawville.world'
  );
}

function isHtmlNavigation(request) {
  return request.mode === 'navigate';
}

// Returns the total byte size stored in a cache.
async function cacheByteSize(cache) {
  const responses = await cache.matchAll();
  let total = 0;
  for (const res of responses) {
    const buf = await res.clone().arrayBuffer();
    total += buf.byteLength;
  }
  return total;
}

// Evict the oldest entries from a cache until it fits within maxBytes.
// "Oldest" = entries appended earliest (cache.keys() returns insertion order).
async function evictOldest(cache, maxBytes) {
  const keys = await cache.keys();
  for (const req of keys) {
    const size = await cacheByteSize(cache);
    if (size <= maxBytes) break;
    await cache.delete(req);
  }
}

// ─── install ──────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const glbCache = await caches.open(GLB_CACHE);
      // Pre-cache critical GLBs one by one — ignore individual failures so a
      // single bad URL doesn't block the entire install.
      await Promise.allSettled(
        ALL_PRECACHE.map(async (path) => {
          try {
            const res = await fetch(path, { cache: 'no-store' });
            if (!res.ok) return;
            const contentLength = res.headers.get('content-length');
            if (contentLength && parseInt(contentLength, 10) > MAX_INDIVIDUAL_BYTES) {
              return; // oversized, skip
            }
            await glbCache.put(path, res);
          } catch {
            // Network unavailable — not fatal during install
          }
        })
      );
      // Activate immediately; don't wait for open tabs to close.
      await self.skipWaiting();
    })()
  );
});

// ─── activate ─────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Delete any caches whose name no longer matches our versioned names.
      const allKeys = await caches.keys();
      await Promise.all(
        allKeys
          .filter(
            (key) =>
              (key.startsWith('clawville-glb-') && key !== GLB_CACHE) ||
              (key.startsWith('clawville-static-') && key !== STATIC_CACHE)
          )
          .map((key) => caches.delete(key))
      );
      // Take control of all in-scope clients immediately.
      await self.clients.claim();
    })()
  );
});

// ─── fetch ────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  // Only handle GET requests.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never intercept API calls or HTML navigations.
  if (isApiRequest(url) || isHtmlNavigation(event.request)) return;

  if (isGlbRequest(url) || isBasisRequest(url)) {
    // Cache-first: serve from cache, fall back to network and populate cache.
    event.respondWith(cacheFirstGlb(event.request, url));
    return;
  }

  if (isNextChunk(url)) {
    // Stale-while-revalidate: return cached immediately, refresh in background.
    event.respondWith(staleWhileRevalidate(event.request, STATIC_CACHE));
    return;
  }

  // Everything else: pass through to network unchanged.
});

async function cacheFirstGlb(request, url) {
  const cache = await caches.open(GLB_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  // Not cached — fetch from network.
  try {
    const networkRes = await fetch(request.clone());
    if (!networkRes.ok) return networkRes;

    // Respect individual file size limit.
    const contentLength = networkRes.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_INDIVIDUAL_BYTES) {
      return networkRes;
    }

    // Clone before storing — Response body can only be consumed once.
    const resForCache = networkRes.clone();
    // Store asynchronously; don't block the response.
    (async () => {
      try {
        await cache.put(request, resForCache);
        // Enforce total cache budget after every write.
        await evictOldest(cache, MAX_GLB_CACHE_BYTES);
      } catch {
        // QuotaExceededError or similar — not fatal
      }
    })();

    return networkRes;
  } catch {
    // Offline with no cache entry — return a 503.
    return new Response('Offline — GLB not cached', { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request.clone())
    .then((networkRes) => {
      if (networkRes.ok) {
        cache.put(request, networkRes.clone()).catch(() => {});
      }
      return networkRes;
    })
    .catch(() => cached); // If network fails, fall back to stale cache

  return cached || fetchPromise;
}
