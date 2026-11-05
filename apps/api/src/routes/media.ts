/**
 * GET /api/media/:id - one image made by an avatar's paid tool (MCP hub step 2
 * phase 2b). The id is an unguessable UUID; anyone with the link can view the
 * image, the same as a shared image link. Only stored bytes are served (a
 * checked png, jpeg or webp), with a fixed type, no-sniff and a sandbox CSP;
 * the route never redirects. Each image is immutable, so its id is the ETag
 * and a repeat view answers 304 without a database read. Reads are limited per
 * client IP, because each miss reads up to 8 MB from Postgres.
 */

import { Hono } from 'hono';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { readMedia } from '../services/studios-images';

export const mediaRoutes = new Hono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mediaRateLimiter = createRateLimiter({ maxPerWindow: 120, windowMs: 60_000 });

/** Test-only: reset the per-IP limiter between cases. */
export function resetMediaRateLimit(): void {
  mediaRateLimiter.reset();
}

mediaRoutes.get('/:id', async (c) => {
  const id = c.req.param('id').toLowerCase();
  if (!UUID.test(id)) return c.json({ error: 'not_found', code: 'not_found' }, 404);
  const etag = `"${id}"`;
  if (c.req.header('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'public, max-age=86400, immutable' } });
  }
  if (!mediaRateLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited', code: 'rate_limited' }, 429);
  }
  const media = await readMedia(id);
  if (!media) return c.json({ error: 'not_found', code: 'not_found' }, 404);
  return new Response(new Uint8Array(media.bytes), {
    status: 200,
    headers: {
      'Content-Type': media.mime,
      'Content-Length': String(media.bytes.length),
      'Cache-Control': 'public, max-age=86400, immutable',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});
