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
 * Best-effort IP resolver — checks trusted proxy headers before falling
 * back to `'unknown'`.
 *
 * Preference order (Phase 3 audit C3 — defeats X-Forwarded-For spoofing;
 * FIX-18/SEC-6 — drop spoofable `x-real-ip`):
 *
 *   1. `cf-connecting-ip` — authoritative inside a Cloudflare-proxied
 *      deployment. Cloudflare strips any client-set value at the edge
 *      and injects its own, so this header is not user-controllable
 *      inside the proxy chain. ClawVille's prod traffic goes through
 *      Cloudflare → Traefik → Hono, so this is the correct primary and
 *      is ALWAYS present on the documented prod/staging paths.
 *
 *   2. `x-forwarded-for` — take the LAST entry (the one the trusted
 *      proxy appended), not the first. Trusting the first comma-
 *      separated value lets any caller forge the IP by simply setting
 *      `X-Forwarded-For: 1.2.3.4` on the outbound request; the trusted
 *      proxy then appends the real client IP AFTER the forged value,
 *      making the tail authoritative on a direct-to-proxy deployment.
 *
 *   3. Fallback to `'unknown'` — every request without any of the above
 *      shares the same rate-limit bucket, which is the correct safe
 *      default (collectively limited rather than individually
 *      unlimited).
 *
 * FIX-18 (SEC-6) NOTE — `x-real-ip` was REMOVED from the trust order.
 * It used to sit ABOVE `x-forwarded-for`, but unlike `cf-connecting-ip`
 * (which Cloudflare overwrites at the edge) and unlike the LAST XFF entry
 * (which the trusted proxy appends), a client-set `X-Real-IP` is NOT
 * stripped/overwritten by Traefik's defaults — so on ANY path that
 * reaches the API without Cloudflare in front (direct-to-Traefik, a
 * misconfigured route, a staging hostname without the CF proxy), a caller
 * could forge `X-Real-IP` and trivially rotate the rate-limit key to
 * defeat the per-IP limiters (e.g. the partner register/stats caps). On
 * the documented prod path `cf-connecting-ip` is always present, so this
 * header was unreachable there anyway — dropping it costs nothing on prod
 * and closes the spoofable gap on any non-CF path. If a future edge
 * legitimately sets `x-real-ip` and overwrites any client value, re-add
 * it ONLY behind a documented single-trusted-edge assumption (the edge
 * must guarantee it overwrites, never passes through, a client value).
 *
 * Anyone fronting ClawVille with a different edge must audit which header
 * their edge sets and extend this function if neither CF nor Traefik
 * conventions fit.
 */
export function getClientIp(headers: {
  get(name: string): string | null | undefined;
}): string {
  // 1. Cloudflare-authoritative, not user-settable inside the chain.
  const cf = headers.get('cf-connecting-ip');
  if (cf) return cf.trim();

  // 2. XFF — LAST entry is the one the trusted proxy appended. The
  //    leading entries are whatever the client sent; they're attacker-
  //    controlled in the general case. (FIX-18: `x-real-ip` deliberately
  //    NOT consulted here — it is client-spoofable on any non-CF path.)
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }

  return 'unknown';
}
