// ClawVille Service Worker
// Cache-first for static 3D assets (GLB + VRM + basis WASM); SWR for Next.js
// JS chunks. Bump CACHE_VERSION whenever the asset matcher or layout changes.
//
// 2026-05-17 v3:
//   - isGlbRequest used to match ONLY /models/*.glb, which silently bypassed
//     the entire /avatars/animations/** tree (22 Mixamo GLBs) and the
//     /cosmetics/** tree. Repeat visitors paid full network cost for every
//     animation on every page load — the bug behind the 80+ animation-GLB
//     fan-out in the network panel even after the v2 SW shipped.
//   - Renamed isGlbRequest -> isAssetRequest. Now matches any .glb or .vrm
//     under the static-asset roots we serve (/models, /avatars, /cosmetics,
//     /skins). VRMs go through the same cache-first path so returning
//     visitors don't re-download a 1–2 MB avatar on every load.
//   - Bumped MAX_GLB_CACHE_BYTES 20 -> 60 MB. The active /game working set
//     (player VRM + 10 buildings + a few decorations + 3 locomotion clips +
//     the player's equipped emotes) fits in well under 30 MB but headroom
//     prevents eviction churn when a player wanders into a new building.
//
// 2026-05-20 v4:
//   - Bumped version to bust v3 stale-while-revalidate chunks after cc26908
//     (forceWebGL iOS fix). v3 clients would receive the pre-fix JS bundle
//     from the static cache on first load, causing a double-load appearance
//     on iOS Safari as the SW update cycle completed in the background.
//
// 2026-05-22 v5 (Phase 2 perf):
//   - Updated PRECACHE_GLBS to match the current 12-building roster
//     (all 12 now point to *-opt1.glb variants, 142→133 materials saved).
//   - Previous roster (chum-bucket.glb, downtown-building.glb, etc.) was
//     stale — those assets are no longer loaded by arena-buildings.tsx.
//
// 2026-05-25 v6 (world perf):
//   - Removed sandy-treedome-v3-opt1.glb from install-time precache. /game now
//     renders Sandy's Treedome procedurally because the GLB contributed ~1.13M
//     live triangles after material merge.
//
// 2026-06-06 v7 (CPU frame-budget perf wave):
//   - Removed underwater-decorations.glb (~1 MB) from install-time precache.
//     Its only consumer, UnderwaterDecorationsGlb in arena-terrain.tsx, was
//     un-rendered dead code (removed from the render tree 2026-04-16) — the
//     scene draws decorations procedurally via <UnderwaterDecorations/>. The
//     SW was fetching ~1 MB on every install for an asset nothing loads.
//   - Version bump evicts the v6 asset+static caches on activate.
//
// 2026-06-06 v8 (perf asset wave — building texture compression):
//   - 6 live buildings recompressed (slot-aware WebP + meshopt): arcade
//     4.2MB→734K, chum/krusty/squidward/patricks/cove. PRECACHE_GLBS ?v=
//     bumped to match (arcade/chum/krusty/cove →v3, patricks/squidward →v4).
//     Version bump re-precaches the new building versions + evicts v7.
//
// 2026-07-07 v9 (P1 texture memory):
//   - Precache points at KTX2 ETC1S world texture variants for the converted
//     player lobster + converted building GLBs. New filenames bust Cloudflare.
//
// 2026-07-14 v10 (P1b texture memory):
//   - Re-precached regenerated KTX2 assets with versioned URLs after extending
//     compression to non-color slots (UASTC normals, ETC1S data maps).
//
// 2026-08-11 v11 (cold-load rung-4 slice B — precache stand-down):
//   - INSTALL NO LONGER FETCHES. The old install handler downloaded all 22
//     roster URLs with cache:'no-store' at window.load — racing the boot's
//     own tier-1 fetches for the SAME files and re-paying ~7.8 MB of wire on
//     every SW version bump (staging real-network reveal measured seconds
//     slower from the contention; localhost hides it).
//   - The roster now precaches when the PAGE signals `clawville:precache`
//     (sw-register sends it after the world's first paint, or after a 30 s
//     fallback on pages that never boot the world). Fetches use the default
//     cache mode, so files the boot just downloaded are served from the HTTP
//     cache at ~zero wire cost — the ?v= query discipline makes every asset
//     URL immutable, which is what made 'no-store' over-defensive.
//   - Already-cached roster entries are skipped, so repeat signals are cheap.
//   - Offline coverage is UNCHANGED in steady state: same roster, same
//     runtime cache-first population via ASSET_PATH_PREFIXES.

const CACHE_VERSION = 'v11';
const GLB_CACHE = `clawville-assets-${CACHE_VERSION}`;
const STATIC_CACHE = `clawville-static-${CACHE_VERSION}`;

// Individual file size limit: skip caching files larger than this.
const MAX_INDIVIDUAL_BYTES = 10 * 1024 * 1024; // 10 MB

// Total asset cache size limit. Entries are evicted oldest-first if exceeded.
const MAX_GLB_CACHE_BYTES = 60 * 1024 * 1024; // 60 MB

// Critical-path GLB roster. v11: NOT fetched at install — precached when the
// page sends `clawville:precache` (post-first-paint, ack/retry handshake).
// ?v=-versioned entries are immutable (skip-if-present, default cache mode);
// UNVERSIONED entries (kelp.glb, the 3 locomotion clips, the basis files
// below) always revalidate with cache:'no-cache' so a stale HTTP-cache or
// migrated copy can never live forever.
// Building models (opt1 variants) + terrain decorations; roster last synced
// to arena-buildings.tsx BUILDING_MODELS in the Phase-2 update (2026-05-22).
const PRECACHE_GLBS = [
  '/models/lobster-ktx.glb?v=2',           // player character, P1b KTX2 slot coverage
  '/models/coral-reef1-ktx.glb?v=2',            // 388 KB
  '/models/coral-reef2-ktx.glb?v=2',            // 192 KB
  '/models/coral-reef3-ktx.glb?v=2',            // 260 KB
  '/models/kelp.glb',                   //  25 KB
  '/models/building-seashell-ktx.glb?v=2',      // 108 KB
  // Building models (Phase 2 opt1 variants, ?v= queries busted). Sandy's
  // Treedome is procedural and intentionally not pre-cached.
  '/models/pineapple-house-opt1-mo-ktx.glb?v=3',
  '/models/chum-bucket-v2-opt1-mo-ktx.glb?v=4',
  '/models/krusty-krab-v2-opt1-mo-ktx.glb?v=4',
  '/models/salty-spitoon-opt1-ktx.glb?v=3',
  '/models/boating-school-opt1-ktx.glb?v=3',
  '/models/patty-building-opt1-mo-ktx.glb?v=3',
  '/models/building-lighthouse-opt1-ktx.glb?v=3',
  '/models/arcade/claw-arcade-exterior-opt1-ktx.glb?v=4',
  '/models/cove/cove-exterior-opt1-ktx.glb?v=4',
  '/models/patricks-rock-v2-opt1-mo-ktx.glb?v=5',
  '/models/squidward-house-opt1-ktx.glb?v=5',
  // The 3 locomotion clips every VRM avatar needs to render without a T-pose
  // flash. Loaded eagerly on /game mount by preloadLocomotionClips() —
  // pre-caching them here means the SECOND-visit network panel has 0 anim GLB
  // requests at mount instead of 3.
  '/avatars/animations/idle.glb',
  '/avatars/animations/walk.glb',
  '/avatars/animations/run.glb',
];

// Basis KTX2 WASM transcoder — tiny but needed before any KTX2 texture loads.
const PRECACHE_BASIS = [
  '/basis/basis_transcoder.js',
  '/basis/basis_transcoder.wasm',
];

const ALL_PRECACHE = [...PRECACHE_GLBS, ...PRECACHE_BASIS];

// ─── helpers ─────────────────────────────────────────────────────────────────

// Match any static 3D asset (.glb or .vrm) under our known asset roots.
// We restrict to specific path prefixes so we never accidentally cache,
// say, a user-uploaded GLB served from /api or some future dynamic route.
const ASSET_PATH_PREFIXES = ['/models/', '/avatars/', '/cosmetics/', '/skins/'];

function isAssetRequest(url) {
  const p = url.pathname;
  if (!(p.endsWith('.glb') || p.endsWith('.vrm'))) return false;
  for (const prefix of ASSET_PATH_PREFIXES) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
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
  // v11: install performs NO network work — the roster precache runs on the
  // page-sent `clawville:precache` message (post-first-paint) instead of
  // racing the boot. Activate immediately; don't wait for open tabs to close.
  event.waitUntil(self.skipWaiting());
});

// ─── deferred roster precache (v11) ──────────────────────────────────────────

// Module-scoped singleton (Codex slice-B finding 7): concurrent signals
// (multi-tab, retries) share ONE in-flight roster pass instead of racing the
// per-URL match() checks and double-fetching past the cache budget.
let precacheInFlight = null;

async function precacheRoster() {
  const glbCache = await caches.open(GLB_CACHE);
  // One by one via allSettled — a single bad URL must not block the roster.
  await Promise.allSettled(
    ALL_PRECACHE.map(async (path) => {
      try {
        const versioned = path.includes('?v=');
        // ?v=-VERSIONED URLs are immutable → skip-if-present, and default
        // cache mode reads the HTTP cache the boot just filled at ~zero wire
        // cost. UNVERSIONED roster URLs (kelp.glb, the 3 locomotion clips,
        // both basis files) ALWAYS revalidate — skip-if-present would let a
        // stale migrated/adopted copy live forever (Codex slice-B round-2
        // finding 1) — via 'no-cache' (server revalidation; 304 cheap). On a
        // failed revalidation the existing (e.g. migrated) entry is RETAINED
        // as fallback rather than dropped.
        if (versioned) {
          const existing = await glbCache.match(path);
          if (existing) return;
        }
        const res = await fetch(path, versioned ? undefined : { cache: 'no-cache' });
        if (!res.ok) return; // keep whatever we already have
        const contentLength = res.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_INDIVIDUAL_BYTES) {
          return; // oversized, skip
        }
        await glbCache.put(path, res);
      } catch {
        // Network unavailable — not fatal; existing entries stay; next
        // signal retries.
      }
    })
  );
  // The deferred path must respect the same budget the runtime path enforces
  // (finding 7 — it previously wrote without eviction).
  try { await evictOldest(glbCache, MAX_GLB_CACHE_BYTES); } catch {}
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'clawville:precache') {
    // Versioned ACK (Codex slice-B finding 4): during an upgrade the page's
    // signal can land on the OLD worker (`serviceWorker.ready` resolves with
    // whatever is active), which — pre-v11 — has no handler and silently
    // drops it. The page keeps retrying until it receives an ack from a
    // worker that actually ran the roster.
    if (!precacheInFlight) {
      precacheInFlight = precacheRoster().finally(() => { precacheInFlight = null; });
    }
    const done = precacheInFlight.then(() => {
      try {
        if (event.source) {
          event.source.postMessage({ type: 'clawville:precache-ack', version: CACHE_VERSION });
        }
      } catch {
        // A vanished client is fine — another tab's retry will re-ack.
      }
    });
    event.waitUntil(done);
  }
});

// ─── activate ─────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // v11 (Codex slice-B finding 1): MIGRATE the previous asset cache into
      // the new one BEFORE deleting it — the old activate deleted a populated
      // cache while the new one stayed empty until the deferred precache
      // signal, leaving a returning user with ZERO offline asset coverage in
      // the gap. Migration is local Cache Storage copying (no network); URLs
      // are ?v=-immutable or revalidated by the deferred precache, so adopted
      // entries are safe. Old STATIC (SWR chunk) caches stay delete-only:
      // chunk URLs are content-hashed per deploy and repopulate naturally.
      const allKeys = await caches.keys();
      const oldAssetKeys = allKeys.filter(
        (key) =>
          (key.startsWith('clawville-assets-') || key.startsWith('clawville-glb-')) &&
          key !== GLB_CACHE
      );
      // A legacy asset cache is deleted ONLY when every one of its entries
      // migrated (Codex slice-B round-2 finding 2): a quota/corrupt-entry
      // failure retains the source cache, and the fetch path's
      // `caches.match` fallback can still serve from it.
      const fullyMigrated = [];
      try {
        const newCache = await caches.open(GLB_CACHE);
        for (const oldKey of oldAssetKeys) {
          let sourceClean = true;
          try {
            const oldCache = await caches.open(oldKey);
            for (const req of await oldCache.keys()) {
              try {
                if (await newCache.match(req)) continue;
                const res = await oldCache.match(req);
                if (res) await newCache.put(req, res);
                else sourceClean = false;
              } catch {
                sourceClean = false; // keep this source as fallback
              }
            }
          } catch {
            sourceClean = false;
          }
          if (sourceClean) fullyMigrated.push(oldKey);
        }
        await evictOldest(newCache, MAX_GLB_CACHE_BYTES);
      } catch {
        // Migration is best-effort — activation must never fail on it. An
        // ABORTED pass must delete NOTHING: eviction can throw after
        // partially removing new-cache entries, and deleting the legacy
        // sources then would lose those assets from BOTH caches (Codex
        // slice-B round-3 finding 1).
        fullyMigrated.length = 0;
      }
      await Promise.all(
        allKeys
          .filter(
            (key) =>
              (((key.startsWith('clawville-glb-') || key.startsWith('clawville-assets-')) &&
                key !== GLB_CACHE &&
                fullyMigrated.includes(key)) ||
                (key.startsWith('clawville-static-') && key !== STATIC_CACHE))
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

  if (isAssetRequest(url) || isBasisRequest(url)) {
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

  // Retained-legacy fallback (Codex slice-B round-2 finding 2): a legacy
  // cache that could not fully migrate is kept on activate; caches.match
  // scans every cache, so its entries still serve offline until the runtime
  // path re-fetches and re-homes them in the current cache.
  try {
    const legacy = await caches.match(request);
    if (legacy) return legacy;
  } catch {
    // Fall through to network.
  }

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
