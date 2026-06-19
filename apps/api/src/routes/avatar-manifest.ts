/**
 * GET /api/avatar/:id/manifest.json — signed ClawVille Avatar Manifest (CAM v1).
 *
 * Emits the portable, content-addressed, ed25519-signed manifest for an avatar
 * the authenticated user owns: body URI + sha256, equipped cosmetics, owner
 * wallet pubkey, identity pubkey, embedded ElizaOS character + skillPack, and a
 * service-issuer signature over `canonicalize(manifest \ signature)`.
 *
 * Spec: `.claude/plans/agent-export-portability.md` (P1).
 *
 * Security:
 *   - Auth: Lucia session cookie (`requireAuth`), same as `agent-export.ts`.
 *   - Authz: 403 if the avatar exists but belongs to a different user.
 *   - Rate limit: 20/IP/min (manifest build does a body fetch + sign, heavier
 *     than a plain read; kept above export-character's 10 since a user may
 *     legitimately re-pull). Limiter runs BEFORE `requireAuth` so junk-cookie
 *     spam never reaches Lucia.
 *   - NO secret ever leaves: the manifest carries pubkeys only (enforced in the
 *     service + core), `wallet.secretKey` is never read.
 *
 * Human-only for now (`requireAuth`). The agent-parity path (resolve
 * `X-Clawville-Agent-Session` → bound avatar via `validateLiveAgentSession`) is
 * a follow-up phase (P4) — see the plan; it BINDS the protected-partner-surface
 * rule, so it ships separately with the mock-Hatcher harness + Codex pass.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, avatars } from '@clawville/database';
import { requireAuth } from '../middleware/auth';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import type { AuthenticatedContext } from '../types';
import {
  buildSignedAvatarManifest,
  NoExportableBodyError,
} from '../services/avatar-manifest-service';

export const avatarManifestRoutes = new Hono<AuthenticatedContext>();

const manifestRateLimiter = createRateLimiter({ maxPerWindow: 20, windowMs: 60_000 });

const idSchema = z.string().uuid();

/** Sanitise an avatar name for a Content-Disposition filename. */
function safeFilename(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'avatar';
  return `${base}-clawville-manifest.json`;
}

avatarManifestRoutes.get(
  '/:id/manifest.json',
  // Rate-limit BEFORE requireAuth so unauthenticated spam never reaches Lucia.
  async (c, next) => {
    const ip = getClientIp({ get: (name) => c.req.header(name) ?? null });
    if (!manifestRateLimiter.check(ip)) {
      throw new HTTPException(429, {
        message: 'Too many manifest requests. Try again in 1 minute.',
      });
    }
    return next();
  },
  requireAuth,
  async (c) => {
    const user = c.get('user');

    const parsedId = idSchema.safeParse(c.req.param('id'));
    if (!parsedId.success) {
      throw new HTTPException(400, { message: 'Invalid avatar id' });
    }
    const avatarId = parsedId.data;

    const avatar = await db.query.avatars.findFirst({ where: eq(avatars.id, avatarId) });
    if (!avatar) {
      throw new HTTPException(404, { message: 'Avatar not found' });
    }
    if (avatar.userId !== user.id) {
      throw new HTTPException(403, { message: 'You do not own this avatar' });
    }

    let manifest;
    try {
      manifest = await buildSignedAvatarManifest(avatar, new Date().toISOString());
    } catch (err) {
      if (err instanceof NoExportableBodyError) {
        // This avatar's model has no exportable body asset (e.g. an unknown
        // modelKey). 422 = the request was valid but cannot be fulfilled. The
        // message names only the (non-sensitive) modelKey.
        throw new HTTPException(422, { message: err.message });
      }
      // Most likely the body asset fetch failed (CDN/network) or the issuer key
      // is unconfigured. NEVER echo err.message to the caller — for a BYO body
      // it would contain the internal URL/host/status and turn this into a blind-
      // SSRF response oracle. Log server-side, return a generic 502.
      console.error(`[avatar-manifest] build failed for avatar ${avatarId}:`, err);
      throw new HTTPException(502, {
        message: 'Failed to build the avatar manifest. Please try again later.',
      });
    }

    c.header('Content-Type', 'application/json; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${safeFilename(avatar.name)}"`);
    // Pretty-printed so a downloaded file is human-inspectable. Verification
    // re-canonicalises (whitespace-insensitive), so formatting is cosmetic.
    return c.body(JSON.stringify(manifest, null, 2));
  },
);
