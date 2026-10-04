/**
 * In-memory per-IP rate limiter — extracted from agent-gateway.ts in Phase 3
 * so multiple routes can share the same token-bucket pattern without each
 * one duplicating the Map + cleanup scaffolding.
 *
 * Usage:
 *   const limiter = createRateLimiter({ maxPerWindow: 10, windowMs: 60_000 });
 *   if (!limiter.check(ip)) return c.json({ error: '...' }, 429);
 *
 * Each call to `createRateLimiter` produces an isolated bucket map — use one
 * per route so that bursts against `/connect` don't eat the budget for
 * `/export-character` or vice versa.
 */

import { isCloudflareIp, isValidIp } from '../lib/cloudflare-ips';

export interface RateLimiterOptions {
  /** Max requests per IP per window. Default: 10. */
  maxPerWindow?: number;
  /** Window length in ms. Default: 60_000 (1 minute). */
  windowMs?: number;
  /** Threshold at which lazy cleanup sweeps expired entries. Default: 10_000. */
  cleanupThreshold?: number;
}

export interface RateLimiter {
  /** Returns true if the request is allowed, false if the IP is over budget. */
  check(ip: string): boolean;
  /** Forcibly clear the bucket — useful for tests. */
  reset(): void;
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const maxPerWindow = options.maxPerWindow ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const cleanupThreshold = options.cleanupThreshold ?? 10_000;
  // Phase 3 audit C6 — sweep expired entries every N checks regardless
  // of bucket size. The size-gated cleanup above only fires when
  // `bucket.size > cleanupThreshold`, so a steady stream of unique IPs
  // under that threshold (each one expires after `windowMs`) would leak
  // entries forever because their lifetime is bounded by window expiry,
  // not by total population. Periodic sweeping amortizes O(n) work at
  // 1-per-N requests (default 1-per-500), which is negligible overhead.
  const periodicCleanupInterval = 500;
  let checkCount = 0;

  const bucket = new Map<string, { count: number; resetAt: number }>();

  function cleanupSize() {
    if (bucket.size <= cleanupThreshold) return;
    const now = Date.now();
    for (const [k, v] of bucket) {
      if (now > v.resetAt) bucket.delete(k);
    }
  }

  function cleanupPeriodic() {
    const now = Date.now();
    for (const [k, v] of bucket) {
      if (now > v.resetAt) bucket.delete(k);
    }
  }

  return {
    check(ip: string): boolean {
      cleanupSize();
      checkCount++;
      if (checkCount % periodicCleanupInterval === 0) {
        cleanupPeriodic();
      }
      const now = Date.now();
      const entry = bucket.get(ip);
      if (!entry || now > entry.resetAt) {
        bucket.set(ip, { count: 1, resetAt: now + windowMs });
        return true;
      }
      entry.count++;
      return entry.count <= maxPerWindow;
    },
    reset() {
      bucket.clear();
      checkCount = 0;
    },
  };
}

/**
 * Client IP resolver for every per-IP control (rate limits, fingerprint
 * ip-prefix keys, guest caps, ws upgrade caps, the Covenant IP allowlist).
 *
 * Trust model (H2, security pass 2026-10-04). The deploy chain is
 * Cloudflare -> Traefik -> Hono. A staging probe on the Traefik -> api
 * docker network (2026-10-04) showed:
 *   - Traefik REWRITES `x-real-ip` and `x-forwarded-for` to the TCP peer,
 *     whatever the client sent. So `x-real-ip` is the true peer address.
 *   - Traefik passes `cf-connecting-ip` through UNCHANGED. A caller that
 *     reaches the origin without Cloudflare can send any value and pick
 *     its own rate-limit key.
 *   - Through Cloudflare, the peer is a Cloudflare edge address and
 *     `cf-connecting-ip` holds the true client (Cloudflare overwrites it).
 *
 * Order:
 *   1. peer = first valid IP in `x-real-ip` (set by Traefik).
 *   2. No valid `x-real-ip` (local dev, tests, no proxy): peer = LAST
 *      `x-forwarded-for` entry (Phase 3 audit C3: the entry a proxy
 *      appended; the leading entries are client-set), ONLY when that entry
 *      is a valid IP (Codex round 2: a garbage token must not become a
 *      caller-chosen key). An invalid last entry gives no peer; the earlier,
 *      client-set entries are never tried. Without a proxy the caller
 *      controls this header anyway, so step 3 adds no exposure here.
 *   3. If the peer is a Cloudflare edge (`lib/cloudflare-ips.ts`) and
 *      `cf-connecting-ip` is a valid IP, return `cf-connecting-ip`. This
 *      keeps real users on their own key, never on a shared edge address.
 *      A Cloudflare peer with a missing or invalid `cf-connecting-ip` is an
 *      anomaly (Cloudflare always sets it): the peer is returned and ONE
 *      warning is logged per process (no per-request log spam).
 *   4. Else return the peer. `cf-connecting-ip` is NEVER used unless the
 *      peer is Cloudflare.
 *   5. No peer at all -> `'unknown'` (one shared, collectively limited
 *      bucket, the safe default).
 *
 * History: FIX-18 (2026-06-13) dropped `x-real-ip` on the belief that
 * Traefik passes a client value through; the 2026-10-04 probe showed the
 * reverse (Traefik overwrites `x-real-ip`, passes `cf-connecting-ip`).
 * The box firewalls also drop non-Cloudflare 80/443 (staging 2026-10-04,
 * prod scheduled next); this check is defense in depth. A different edge
 * must re-audit which headers it sets and overwrites before this function
 * is trusted behind it.
 *
 * Accepts any `{ get(name) }`: a `Headers` object (`c.req.raw.headers`) or
 * a wrapper such as `{ get: (n) => c.req.header(n) ?? null }`.
 */
export function getClientIp(headers: {
  get(name: string): string | null | undefined;
}): string {
  const peer = firstValidIp(headers.get('x-real-ip')) ?? lastValidXffEntry(headers.get('x-forwarded-for'));
  if (!peer) return 'unknown';

  if (isCloudflareIp(peer)) {
    const cf = headers.get('cf-connecting-ip')?.trim();
    if (cf && isValidIp(cf)) return cf;
    warnCloudflarePeerWithoutClientIpOnce();
  }
  return peer;
}

let cloudflarePeerAnomalyWarned = false;

/**
 * One warning per process when a Cloudflare peer arrives without a valid
 * `cf-connecting-ip`. Logs no header values (the caller controls them).
 */
function warnCloudflarePeerWithoutClientIpOnce(): void {
  if (cloudflarePeerAnomalyWarned) return;
  cloudflarePeerAnomalyWarned = true;
  console.warn(
    '[rate-limit] Cloudflare peer without a valid cf-connecting-ip; keying on the edge address. '
      + 'Logged once per process.',
  );
}

/** Test hook: re-arm the once-per-process anomaly warning. */
export function resetClientIpAnomalyWarningForTests(): void {
  cloudflarePeerAnomalyWarned = false;
}

function firstValidIp(value: string | null | undefined): string | null {
  if (!value) return null;
  for (const part of value.split(',')) {
    const candidate = part.trim();
    if (isValidIp(candidate)) return candidate;
  }
  return null;
}

/** The LAST `x-forwarded-for` entry when it is a valid IP, else null. */
function lastValidXffEntry(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  const last = parts.length > 0 ? parts[parts.length - 1]! : null;
  return last !== null && isValidIp(last) ? last : null;
}
