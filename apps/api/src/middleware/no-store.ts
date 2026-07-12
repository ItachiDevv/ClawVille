/**
 * noStorePrivate — personalized-response cache guard.
 *
 * Session-derived payloads (balances, wallets, own-view game state) must
 * never be cached by any shared layer: the browser HTTP cache, back-forward
 * cache, or the CDN if a cache rule ever matches /api/* (Cloudflare fronts
 * both prod and staging; today every /api response is CF-DYNAMIC, but the
 * headers make the requirement explicit instead of relying on that default).
 *
 * `Vary` names both auth carriers: the Lucia session cookie AND the
 * connected-agent session header, since several personalized routes resolve
 * either subject (Rule E5 parity).
 *
 * Headers are set AFTER next() so the invariant overrides anything a handler
 * set. Apply per-route (like sessionMiddleware) — NOT via router.use('/'),
 * which Hono prefix-matches over public sibling routes (see the comment
 * above the legacy leaderboard routes for that exact trap).
 */

import type { MiddlewareHandler } from 'hono';

export const noStorePrivate: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Cookie, X-Clawville-Agent-Session');
};
