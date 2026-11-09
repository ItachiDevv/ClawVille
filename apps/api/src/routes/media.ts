/**
 * GET /api/media/:id - one image or video made by an avatar's paid tool (MCP
 * hub step 2 phase 2b; video since phase 3b). The id is an unguessable UUID;
 * anyone with the link can view the item, the same as a shared image link.
 * Only stored bytes are served (a checked png, jpeg, webp, mp4 or webm), with
 * the stored type, no-sniff and a sandbox CSP; the route never redirects.
 * Each item is immutable, so its id is the ETag and a repeat view answers 304
 * without a database read. A single `Range: bytes=` request answers 206 with
 * only that slice (an open-ended range gets at most 8 MB); several ranges
 * answer the whole item (200); a range past the end answers 416. Reads are
 * limited per client IP, because each miss reads from Postgres.
 *
 * POST /api/media/:id/delete-challenge, then DELETE /api/media/:id with
 * `{ proof: { nonce, signature } }` - the human owner deletes one item of their
 * own active avatar (frees media quota). Human session only (an agent session
 * is refused), AND a fresh signature from the owner's linked wallet: a magic
 * link passes through the agent, so the cookie alone never deletes.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { and, avatars, db, eq, users } from '@clawville/database';
import { requireAuth, sessionMiddleware } from '../middleware/auth';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { requireNonGuestUser } from '../middleware/require-non-guest';
import { refuseAgentHeader, requireHumanSessionOrigin, type HumanGateCopy } from '../middleware/require-human-session';
import { readMedia } from '../services/studios-images';
import { deleteOwnMedia, readMediaHead, readMediaRange } from '../services/studios-media';
import { issueMediaDeleteChallenge, verifyMediaDeleteProof } from '../services/spend-policy-proof';

export const mediaRoutes = new Hono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mediaRateLimiter = createRateLimiter({ maxPerWindow: 120, windowMs: 60_000 });
/** The largest slice an open-ended range ('bytes=N-') gets in one answer. */
export const OPEN_RANGE_MAX_BYTES = 8 * 1024 * 1024;

/** Test-only: reset the per-IP limiter between cases. */
export function resetMediaRateLimit(): void {
  mediaRateLimiter.reset();
}

function baseHeaders(etag: string, mime: string): Record<string, string> {
  return {
    'Content-Type': mime,
    'Cache-Control': 'public, max-age=86400, immutable',
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
}

export type ParsedRange = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * One `bytes=` range against an item of `size` bytes: the inclusive slice,
 * 'unsatisfiable' (416), or null (no single valid range: answer the whole item).
 */
export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (!header) return null;
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return 'unsatisfiable';
  if (last === '') return { start, end: Math.min(size - 1, start + OPEN_RANGE_MAX_BYTES - 1) };
  const end = Number(last);
  if (end < start) return null;
  return { start, end: Math.min(end, size - 1) };
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
  const rangeHeader = c.req.header('range');
  if (rangeHeader) {
    const head = await readMediaHead(id);
    if (!head) return c.json({ error: 'not_found', code: 'not_found' }, 404);
    const range = parseRange(rangeHeader, head.size);
    if (range === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { ...baseHeaders(etag, head.mime), 'Content-Range': `bytes */${head.size}` } });
    }
    if (range) {
      const slice = await readMediaRange(id, range.start, range.end - range.start + 1);
      if (!slice) return c.json({ error: 'not_found', code: 'not_found' }, 404);
      return new Response(new Uint8Array(slice.bytes), {
        status: 206,
        headers: {
          ...baseHeaders(etag, slice.mime),
          'Content-Length': String(slice.bytes.length),
          'Content-Range': `bytes ${range.start}-${range.start + slice.bytes.length - 1}/${slice.size}`,
        },
      });
    }
  }
  const media = await readMedia(id);
  if (!media) return c.json({ error: 'not_found', code: 'not_found' }, 404);
  return new Response(new Uint8Array(media.bytes), {
    status: 200,
    headers: { ...baseHeaders(etag, media.mime), 'Content-Length': String(media.bytes.length) },
  });
});

const DELETE_GATE: HumanGateCopy = {
  humanOnlyCode: 'media_delete_human_only',
  humanOnlyMessage: 'Only the human owner can delete stored media, in the ClawVille wallet panel.',
  needsLoginCode: 'media_delete_needs_human_login',
  needsLoginMessage: 'Sign in again in your browser, then delete the media.',
};

const deleteGate = [
  sessionMiddleware,
  bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'payload_too_large', code: 'payload_too_large' }, 413) }),
  refuseAgentHeader(DELETE_GATE),
  requireAuth,
  requireHumanSessionOrigin(DELETE_GATE),
  requireNonGuestUser,
] as const;

const NEEDS_WALLET_LINK = {
  error: 'media_delete_needs_wallet_link',
  code: 'media_delete_needs_wallet_link',
  message: 'Link your own wallet in the wallet panel first. It signs to delete media.',
} as const;
const NEEDS_WALLET_PROOF = {
  error: 'media_delete_needs_wallet_proof',
  code: 'media_delete_needs_wallet_proof',
  message: 'Deleting media needs a signature from your linked wallet. Ask POST /api/media/<id>/delete-challenge first.',
} as const;
const INVALID_WALLET_PROOF = {
  error: 'media_delete_invalid_wallet_proof',
  code: 'media_delete_invalid_wallet_proof',
  message: 'The wallet signature did not match. Ask for a new challenge and sign again.',
} as const;
const proofBodySchema = z.object({
  proof: z.object({ nonce: z.string().min(32).max(64), signature: z.string().min(80).max(100) }).strict(),
}).strict();

/** The user's active avatar and linked wallet. */
async function ownerOf(userId: string): Promise<{ avatarId: string | null; wallet: string | null }> {
  const [avatar, owner] = await Promise.all([
    db.query.avatars.findFirst({ where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)), columns: { id: true } }),
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { linkedWalletPubkey: true } }),
  ]);
  return { avatarId: avatar?.id ?? null, wallet: owner?.linkedWalletPubkey ?? null };
}

// A ledger-capable agent can redeem its own control link and hold a
// `magic_link` cookie, which the human gate accepts. So a delete also needs a
// fresh signature from the owner's linked wallet over the account, the avatar,
// the media id and the action (single-use nonce, 120 s; Codex review 2026-11-06).
mediaRoutes.post('/:id/delete-challenge', ...deleteGate, async (c) => {
  const user = c.get('user' as never) as { id: string };
  const id = c.req.param('id').toLowerCase();
  if (!UUID.test(id)) return c.json({ error: 'not_found', code: 'not_found' }, 404);
  const { avatarId, wallet } = await ownerOf(user.id);
  if (!avatarId) return c.json({ error: 'not_found', code: 'not_found' }, 404);
  if (!wallet) return c.json(NEEDS_WALLET_LINK, 403);
  return c.json({ ...issueMediaDeleteChallenge(user.id, avatarId, id), walletPubkey: wallet });
});

mediaRoutes.delete('/:id', ...deleteGate, async (c) => {
  const user = c.get('user' as never) as { id: string };
  const id = c.req.param('id').toLowerCase();
  if (!UUID.test(id)) return c.json({ error: 'not_found', code: 'not_found' }, 404);
  const { avatarId, wallet } = await ownerOf(user.id);
  if (!avatarId) return c.json({ error: 'not_found', code: 'not_found' }, 404);
  if (!wallet) return c.json(NEEDS_WALLET_LINK, 403);
  const body = proofBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json(NEEDS_WALLET_PROOF, 403);
  const verdict = verifyMediaDeleteProof({
    userId: user.id,
    avatarId,
    mediaId: id,
    nonce: body.data.proof.nonce,
    signature: body.data.proof.signature,
    walletPubkey: wallet,
  });
  if (verdict !== 'ok') return c.json(INVALID_WALLET_PROOF, 401);
  if (!(await deleteOwnMedia(avatarId, id))) return c.json({ error: 'not_found', code: 'not_found' }, 404);
  return c.json({ deleted: true, mediaId: id });
});
