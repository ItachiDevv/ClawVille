/**
 * GET /api/media/:id - one image made by an avatar's paid tool (MCP hub step 2
 * phase 2b). The id is an unguessable UUID; anyone with the link can view the
 * image, the same as a shared image link. Stored bytes are served with a fixed
 * image type and no-sniff; a vendor link is a redirect.
 */

import { Hono } from 'hono';
import { readMedia } from '../services/studios-images';

export const mediaRoutes = new Hono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

mediaRoutes.get('/:id', async (c) => {
  const id = c.req.param('id').toLowerCase();
  if (!UUID.test(id)) return c.json({ error: 'not_found', code: 'not_found' }, 404);
  const media = await readMedia(id);
  if (!media) return c.json({ error: 'not_found', code: 'not_found' }, 404);
  if (media.kind === 'link') return c.redirect(media.url, 302);
  return new Response(new Uint8Array(media.bytes), {
    status: 200,
    headers: {
      'Content-Type': media.mime,
      'Content-Length': String(media.bytes.length),
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});
