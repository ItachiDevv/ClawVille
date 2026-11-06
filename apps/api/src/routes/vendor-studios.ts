/**
 * Studios image generation (MCP hub step 2, phases 2a and 2b).
 *
 *   POST   /api/vendors/studios/images  body `{ prompt, model? }`, header
 *          `Idempotency-Key`. Mode A (the human saved a Studios key): Studios
 *          bills the human's own account. Mode B (no key): the avatar wallet
 *          pays with x402 inside the spend rules. Returns the stored image path.
 *   GET    /api/vendors/studios/images  the avatar's newest images.
 *   GET    /api/vendors/studios/key     whether a key is saved (last 4 only).
 *   POST   /api/vendors/studios/key/challenge  a message for the human's
 *          linked wallet to sign (`{ action: 'save', last4, sha256 }` or
 *          `{ action: 'remove' }`). Human only.
 *   PUT    /api/vendors/studios/key     save the human's own key, with the
 *          wallet `proof`. Human only.
 *   DELETE /api/vendors/studios/key     remove it (back to mode B), with the
 *          wallet `proof`. Human only.
 *
 * PARITY (Rule E5): human path = these routes with a Lucia session (wallet
 * panel, Studios card); agent path = the same image routes with the agent
 * session header (ledger-capable for POST), the MCP tool
 * `clawville_studios_image` and the hosted `[ACTION:] generate_image` verb,
 * all through `services/studios-images.ts`. The key routes are human-only by
 * design: the human chooses whose account pays, and the linked wallet signs
 * each change (a magic-link session alone does not prove a human).
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { and, avatars, db, eq, users } from '@clawville/database';
import { requireAuth, sessionMiddleware } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity, requireNonGuestUser } from '../middleware/require-non-guest';
import {
  refuseAgentHeader,
  requireHumanSessionOrigin,
  type HumanGateCopy,
} from '../middleware/require-human-session';
import { noStorePrivate } from '../middleware/no-store';
import { issueVendorKeyChallenge, vendorKeyRef, verifyVendorKeyProof } from '../services/spend-policy-proof';
import { generateStudiosImage, listMedia } from '../services/studios-images';
import { STUDIOS_KEY_PATTERN, deleteVendorKey, readVendorKeyStatus, saveVendorKey } from '../services/vendor-credentials';
import { STUDIOS_IMAGE_MODELS, STUDIOS_PROMPT_MAX } from '../services/vendors/studios';

export const vendorStudiosRoutes = new Hono<ActivityAuthContext>();
vendorStudiosRoutes.use('*', sessionMiddleware, noStorePrivate);

// Each call costs an unpaid request to Studios and a ledger transaction, so a
// looping agent is slowed down per avatar before any of that happens.
const studiosRateLimiter = createRateLimiter({ maxPerWindow: 6, windowMs: 60_000 });

/** Test-only: reset the per-avatar limiter between cases. */
export function resetStudiosRateLimit(): void {
  studiosRateLimiter.reset();
}

const idempotencyKeySchema = z.string().trim().regex(/^[A-Za-z0-9._:-]{8,64}$/);
const bodySchema = z.object({
  prompt: z.string().trim().min(1).max(STUDIOS_PROMPT_MAX),
  model: z.enum(STUDIOS_IMAGE_MODELS).optional(),
}).strict();
const smallBody = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.json({ error: 'payload_too_large', code: 'payload_too_large' }, 413),
});

vendorStudiosRoutes.post('/images', smallBody, requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const identity = c.get('identity');
  if (identity.kind === 'agent' && identity.ledgerCapable !== true) {
    return c.json({ error: 'agent_session_not_ledger_authorized', code: 'agent_session_not_ledger_authorized' }, 403);
  }
  const idempotencyKey = idempotencyKeySchema.safeParse(c.req.header('Idempotency-Key'));
  if (!idempotencyKey.success) {
    return c.json({
      error: 'idempotency_key_required',
      code: 'idempotency_key_required',
      message: 'Send an Idempotency-Key header: 8-64 letters, digits, dots, underscores, colons or hyphens.',
    }, 400);
  }
  const body = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: 'invalid_request', code: 'invalid_request', issues: body.error.issues }, 400);
  }
  if (!studiosRateLimiter.check(identity.avatarId)) {
    return c.json({ error: 'rate_limited', code: 'rate_limited', message: 'Too many image calls. Wait one minute.' }, 429);
  }

  const result = await generateStudiosImage({
    avatarId: identity.avatarId,
    actor: identity.kind === 'agent' ? 'agent' : 'human',
    prompt: body.data.prompt,
    model: body.data.model,
    idempotencyKey: idempotencyKey.data,
  });
  if (!result.ok) {
    return c.json({ error: result.code, code: result.code, message: result.message, ledgerId: result.ledgerId }, result.httpStatus);
  }
  return c.json(result);
});

vendorStudiosRoutes.get('/images', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  return c.json({ images: await listMedia(identity.avatarId) });
});

vendorStudiosRoutes.get('/key', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  return c.json(await readVendorKeyStatus(identity.avatarId, 'studios'));
});

const KEY_GATE: HumanGateCopy = {
  humanOnlyCode: 'studios_key_human_only',
  humanOnlyMessage: 'Only the human owner can save or remove the Studios API key.',
  needsLoginCode: 'studios_key_needs_human_login',
  needsLoginMessage: 'Sign in again in your browser, then save your Studios API key.',
};

async function activeAvatarId(userId: string): Promise<string> {
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
    columns: { id: true },
  });
  if (!avatar) throw new HTTPException(403, { message: 'avatar_required' });
  return avatar.id;
}

const keyBodySchema = z.object({
  apiKey: z.string().trim().regex(STUDIOS_KEY_PATTERN),
  proof: z.object({ nonce: z.string().min(1).max(128), signature: z.string().min(1).max(128) }).strict().optional(),
}).strict();
const removeBodySchema = z.object({
  proof: z.object({ nonce: z.string().min(1).max(128), signature: z.string().min(1).max(128) }).strict().optional(),
}).strict();
const challengeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), last4: z.string().regex(/^[A-Za-z0-9_-]{4}$/), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  z.object({ action: z.literal('remove') }).strict(),
]);

// The key decides whose account pays, and a magic link passes through the
// agent, so a human session alone is not enough: the human's linked wallet
// signs each save or remove (the same proof as a spend-rules raise).
const NEEDS_WALLET_LINK = {
  error: 'studios_key_needs_wallet_link',
  code: 'studios_key_needs_wallet_link',
  message: 'Link your own wallet in the wallet panel first. It signs to approve a Studios key change.',
} as const;
const NEEDS_WALLET_PROOF = {
  error: 'studios_key_needs_wallet_proof',
  code: 'studios_key_needs_wallet_proof',
  message: 'Saving or removing the Studios key needs a signature from your linked wallet. Ask POST /api/vendors/studios/key/challenge first.',
} as const;
const INVALID_WALLET_PROOF = {
  error: 'studios_key_invalid_wallet_proof',
  code: 'studios_key_invalid_wallet_proof',
  message: 'The wallet signature did not match. Ask for a new challenge and sign again.',
} as const;

async function linkedWallet(userId: string): Promise<string | null> {
  const owner = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { linkedWalletPubkey: true } });
  return owner?.linkedWalletPubkey ?? null;
}

vendorStudiosRoutes.post('/key/challenge', smallBody, refuseAgentHeader(KEY_GATE), requireAuth, requireHumanSessionOrigin(KEY_GATE), requireNonGuestUser, async (c) => {
  const user = c.get('user') as { id: string };
  const body = challengeSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_request', code: 'invalid_request' }, 400);
  await activeAvatarId(user.id);
  const wallet = await linkedWallet(user.id);
  if (!wallet) return c.json(NEEDS_WALLET_LINK, 403);
  const key = body.data.action === 'save' ? { last4: body.data.last4, sha256: body.data.sha256 } : null;
  return c.json({ ...issueVendorKeyChallenge(user.id, 'studios', body.data.action, key), walletPubkey: wallet });
});

vendorStudiosRoutes.put('/key', smallBody, refuseAgentHeader(KEY_GATE), requireAuth, requireHumanSessionOrigin(KEY_GATE), requireNonGuestUser, async (c) => {
  const user = c.get('user') as { id: string };
  const body = keyBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: 'invalid_studios_key', code: 'invalid_studios_key', message: 'A Studios API key starts with chk_.' }, 400);
  }
  const avatarId = await activeAvatarId(user.id);
  const wallet = await linkedWallet(user.id);
  if (!wallet) return c.json(NEEDS_WALLET_LINK, 403);
  if (!body.data.proof) return c.json(NEEDS_WALLET_PROOF, 403);
  const verdict = verifyVendorKeyProof({
    userId: user.id,
    vendor: 'studios',
    action: 'save',
    key: vendorKeyRef(body.data.apiKey),
    nonce: body.data.proof.nonce,
    signature: body.data.proof.signature,
    walletPubkey: wallet,
  });
  if (verdict !== 'ok') return c.json(INVALID_WALLET_PROOF, 401);
  return c.json(await saveVendorKey(avatarId, 'studios', user.id, body.data.apiKey));
});

vendorStudiosRoutes.delete('/key', smallBody, refuseAgentHeader(KEY_GATE), requireAuth, requireHumanSessionOrigin(KEY_GATE), requireNonGuestUser, async (c) => {
  const user = c.get('user') as { id: string };
  const body = removeBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: 'invalid_request', code: 'invalid_request' }, 400);
  const avatarId = await activeAvatarId(user.id);
  const wallet = await linkedWallet(user.id);
  if (!wallet) return c.json(NEEDS_WALLET_LINK, 403);
  if (!body.data.proof) return c.json(NEEDS_WALLET_PROOF, 403);
  const verdict = verifyVendorKeyProof({
    userId: user.id,
    vendor: 'studios',
    action: 'remove',
    key: null,
    nonce: body.data.proof.nonce,
    signature: body.data.proof.signature,
    walletPubkey: wallet,
  });
  if (verdict !== 'ok') return c.json(INVALID_WALLET_PROOF, 401);
  await deleteVendorKey(avatarId, 'studios');
  return c.json(await readVendorKeyStatus(avatarId, 'studios'));
});
