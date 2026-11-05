/**
 * Studios image generation, paid from the avatar wallet (MCP hub step 2,
 * phase 2, mode B).
 *
 *   POST /api/vendors/studios/images
 *     Body `{ prompt, model? }`, header `Idempotency-Key` (required).
 *     The avatar wallet pays Studios with x402 under the human's spend rules
 *     (`outbound-x402.ts`). Returns the image and our own status only.
 *
 * PARITY (Rule E5): human path = this route with a Lucia session (the web
 * form ships before promotion); agent path = this route with the agent
 * session header (a ledger-capable session only). Both pay from, and count
 * against, the same avatar wallet and the same spend rules.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { createRateLimiter } from '../middleware/rate-limit';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import { callVendorWithAvatarWallet, type VendorCallFailure } from '../services/outbound-x402';
import {
  STUDIOS_IMAGE_MODELS,
  STUDIOS_MAX_CALL_ATOMIC,
  STUDIOS_PAY_TO,
  STUDIOS_PROMPT_MAX,
  buildStudiosImageRequest,
  parseStudiosImage,
} from '../services/vendors/studios';

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

const FAILURE: Record<VendorCallFailure, { status: 400 | 402 | 403 | 409 | 502; message: string }> = {
  duplicate_request: { status: 409, message: 'This Idempotency-Key was already used. Use a new key for a new image.' },
  vendor_unreachable: { status: 502, message: 'Studios did not answer. Nothing was paid. Try again later.' },
  vendor_refused: { status: 502, message: 'Studios refused the request before payment. Nothing was paid.' },
  vendor_quote_invalid: { status: 502, message: 'Studios sent a price ClawVille cannot accept. Nothing was paid.' },
  vendor_pay_to_changed: { status: 502, message: 'Studios asked to be paid at an unknown wallet. Nothing was paid.' },
  spend_rules_not_set: { status: 403, message: 'Spend caps are not set. Ask your human to set them in the wallet panel (Spending).' },
  vendor_not_allowed: { status: 403, message: 'Studios is not an allowed paid tool. Ask your human to allow it in the wallet panel (Spending).' },
  over_per_call_cap: { status: 402, message: 'This call costs more than the per-call cap. Nothing was paid.' },
  over_daily_cap: { status: 402, message: 'This call would pass the daily cap. Nothing was paid.' },
  wallet_missing: { status: 403, message: 'This avatar has no wallet. Nothing was paid.' },
  payment_prepare_failed: { status: 502, message: 'The payment could not be signed. Nothing was paid. Try again later.' },
  payment_ambiguous: { status: 502, message: 'Studios did not confirm the result. The payment may have gone through (for example, the wallet may not hold enough USDC, or the reply was lost). Do not retry; it counts toward the daily cap until it is checked on chain.' },
};

vendorStudiosRoutes.post(
  '/images',
  bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: 'payload_too_large', code: 'payload_too_large' }, 413),
  }),
  requireAuthOrAgentSession,
  requireNonGuestIdentity,
  async (c) => {
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

  const request = buildStudiosImageRequest(body.data);
  const result = await callVendorWithAvatarWallet({
    avatarId: identity.avatarId,
    actor: identity.kind === 'agent' ? 'agent' : 'human',
    pin: { vendor: 'studios', payTo: STUDIOS_PAY_TO, maxCallAtomic: STUDIOS_MAX_CALL_ATOMIC },
    tool: 'images.generations',
    idempotencyKey: idempotencyKey.data,
    url: request.url,
    body: request.body,
  });

  if (!result.ok) {
    const failure = FAILURE[result.code];
    return c.json({ error: result.code, code: result.code, message: failure.message, ledgerId: result.ledgerId ?? null }, failure.status);
  }
  const image = parseStudiosImage(result.responseJson);
  return c.json({
    ok: true,
    ledgerId: result.ledgerId,
    paidUsdcAtomic: result.usdcAtomic,
    paidUsdCents: result.usdCents,
    txSignature: result.txSignature,
    imageUrl: image?.imageUrl ?? null,
    imageBase64: image?.imageBase64 ?? null,
    note: image ? null : 'Studios was paid but sent no readable image. Contact support with the ledgerId.',
  });
  },
);
