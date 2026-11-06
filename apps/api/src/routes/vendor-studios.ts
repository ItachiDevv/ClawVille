/**
 * Studios image generation (MCP hub step 2, phases 2a and 2b).
 *
 *   POST   /api/vendors/studios/images  body `{ prompt, model? }`, header
 *          `Idempotency-Key`. Mode A (the human saved a Studios key): Studios
 *          bills the human's own account. Mode B (no key): the avatar wallet
 *          pays with x402 inside the spend rules. Returns the stored image path.
 *   GET    /api/vendors/studios/images  the avatar's newest images.
 *   POST   /api/vendors/studios/videos      video (wallet or key mode), 202 running
 *   POST   /api/vendors/studios/characters  character shots (key mode only)
 *   POST   /api/vendors/studios/recasts     recast (key mode only), 202 running
 *          (phase 3b; same headers, rate limit and approval flow as images;
 *          bodies = `vendors/studios-operations.ts` schemas).
 *   GET    /api/vendors/studios/options/:menu  a free Studios menu (ids,
 *          prices, option values only), cached 10 minutes.
 *   GET    /api/vendors/studios/requests/:id  one Studios request of this
 *          avatar (agent or human): status, and the media paths when done.
 *   GET    /api/vendors/studios/approvals  the requests that wait for the
 *          human ("ask me before each payment"). Human only.
 *   POST   /api/vendors/studios/approvals/:id/challenge  the message for
 *          the human's linked wallet to sign for ONE waiting request. Human only.
 *   POST   /api/vendors/studios/approvals/:id/approve  body `{ proof }`: run
 *          one waiting request now (every cap and limit checked again). Human
 *          only, and only with the linked wallet's signature over the challenge.
 *   POST   /api/vendors/studios/approvals/:id/decline  decline it; nothing
 *          is called or paid. Human only.
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
 * panel, Studios card); agent path = the same routes with the agent session
 * header (ledger-capable for POST), the MCP tools `clawville_studios_image`,
 * `clawville_studios_video`, `clawville_studios_character`,
 * `clawville_studios_recast`, `clawville_studios_options` and the hosted
 * `[ACTION:]` verbs `generate_image`, `generate_video`, `make_character`,
 * `recast_character`, all through `services/studios-images.ts`. The key routes are human-only by
 * design: the human chooses whose account pays, and the linked wallet signs
 * each change (a magic-link session alone does not prove a human).
 * "Ask me before each payment": every image request (the human's web form
 * too) answers 202 `awaiting_approval` and the agent reads `GET /requests/:id`;
 * approve needs the linked wallet's signature (a magic link passes through the
 * agent, so a cookie alone never approves); decline needs only the human
 * session (it spends nothing). Both are human-only by design (the owner
 * decides each payment), like the
 * spend-rules write.
 */

import { Hono, type Context } from 'hono';
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
  HUMAN_SESSION_ORIGINS,
  refuseAgentHeader,
  requireHumanSessionOrigin,
  type HumanGateCopy,
} from '../middleware/require-human-session';
import type { SessionCreatedVia } from '../lib/auth';
import { noStorePrivate } from '../middleware/no-store';
import {
  issueApprovalChallenge,
  issueVendorKeyChallenge,
  vendorKeyRef,
  verifyApprovalProof,
  verifyVendorKeyProof,
} from '../services/spend-policy-proof';
import {
  approveStudiosRequest,
  declineStudiosRequest,
  generateStudiosImage,
  listAwaitingApprovals,
  listMedia,
  readApprovalTerms,
  readStudiosRequest,
  requestStudiosOperation,
  type StudiosImageResult,
  type StudiosOperationResult,
} from '../services/studios-images';
import { readStudiosMenu } from '../services/studios-menus';
import { STUDIOS_KEY_PATTERN, deleteVendorKey, readVendorKeyStatus, saveVendorKey } from '../services/vendor-credentials';
import {
  STUDIOS_MENU_IDS,
  characterParamsSchema,
  imageParamsSchema,
  recastParamsSchema,
  videoParamsSchema,
  type StudiosMenuId,
  type StudiosParams,
} from '../services/vendors/studios-operations';

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
const smallBody = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.json({ error: 'payload_too_large', code: 'payload_too_large' }, 413),
});

type PaidContext = Context<ActivityAuthContext>;

/**
 * The checks every paid Studios POST shares: a ledger-capable session, an
 * Idempotency-Key header, a valid body and the per-avatar rate limit. Returns
 * the refusal response, or what the call needs.
 */
async function readPaidRequest<T>(c: PaidContext, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<
  Response | { avatarId: string; actor: 'human' | 'agent'; idempotencyKey: string; body: T }
> {
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
  const body = schema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: 'invalid_request', code: 'invalid_request', issues: body.error.issues }, 400);
  }
  if (!studiosRateLimiter.check(identity.avatarId)) {
    return c.json({ error: 'rate_limited', code: 'rate_limited', message: 'Too many Studios calls. Wait one minute.' }, 429);
  }
  // The recorded actor: a cookie counts as the human only when a human
  // sign-in made it ('agent_exchange' and pre-0089 sessions count as the
  // agent). It does not decide the wait: with "ask me before each payment" on,
  // every request waits for the linked wallet's signature.
  const createdVia = (c.get('session') as { createdVia?: SessionCreatedVia | null } | null | undefined)?.createdVia ?? null;
  const humanPressed = identity.kind === 'user' && createdVia !== null && HUMAN_SESSION_ORIGINS.has(createdVia);
  return { avatarId: identity.avatarId, actor: humanPressed ? 'human' : 'agent', idempotencyKey: idempotencyKey.data, body: body.data };
}

/** The HTTP answer for a Studios result: 202 while it waits or runs. */
function answer(c: Context, result: StudiosOperationResult | StudiosImageResult): Response {
  if (!result.ok && result.code === 'awaiting_approval') {
    return c.json({ status: 'awaiting_approval', requestId: result.requestId, expiresAt: result.expiresAt, message: result.message }, 202);
  }
  if (!result.ok && result.code === 'running') {
    return c.json({ status: 'running', requestId: result.requestId, message: result.message }, 202);
  }
  if (!result.ok) {
    return c.json({ error: result.code, code: result.code, message: result.message, ledgerId: result.ledgerId }, result.httpStatus);
  }
  return c.json(result);
}

vendorStudiosRoutes.post('/images', smallBody, requireAuthOrAgentSession, requireNonGuestIdentity, async (c) => {
  const read = await readPaidRequest(c, imageParamsSchema);
  if (read instanceof Response) return read;
  return answer(c, await generateStudiosImage({
    avatarId: read.avatarId,
    actor: read.actor,
    prompt: read.body.prompt,
    model: read.body.model,
    idempotencyKey: read.idempotencyKey,
  }));
});

/** One paid Studios operation route (phase 3b). */
function operationHandler<T extends StudiosParams>(operation: 'video' | 'character_shots' | 'recast', schema: z.ZodType<T, z.ZodTypeDef, unknown>) {
  return async (c: PaidContext) => {
    const read = await readPaidRequest(c, schema);
    if (read instanceof Response) return read;
    return answer(c, await requestStudiosOperation({
      avatarId: read.avatarId,
      actor: read.actor,
      operation,
      params: read.body,
      idempotencyKey: read.idempotencyKey,
    }));
  };
}

vendorStudiosRoutes.post('/videos', smallBody, requireAuthOrAgentSession, requireNonGuestIdentity, operationHandler('video', videoParamsSchema));
vendorStudiosRoutes.post('/characters', smallBody, requireAuthOrAgentSession, requireNonGuestIdentity, operationHandler('character_shots', characterParamsSchema));
vendorStudiosRoutes.post('/recasts', smallBody, requireAuthOrAgentSession, requireNonGuestIdentity, operationHandler('recast', recastParamsSchema));

vendorStudiosRoutes.get('/options/:menu', requireAuthOrAgentSession, async (c) => {
  const menu = c.req.param('menu');
  if (!(STUDIOS_MENU_IDS as readonly string[]).includes(menu)) {
    return c.json({ error: 'unknown_menu', code: 'unknown_menu', menus: STUDIOS_MENU_IDS }, 400);
  }
  const data = await readStudiosMenu(menu as StudiosMenuId);
  if (!data) return c.json({ error: 'vendor_unreachable', code: 'vendor_unreachable', message: 'Studios did not answer. Try again later.' }, 502);
  return c.json({ menu, ...data });
});

vendorStudiosRoutes.get('/images', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  return c.json({ images: await listMedia(identity.avatarId) });
});

const requestIdSchema = z.string().uuid();

vendorStudiosRoutes.get('/requests/:id', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  const id = requestIdSchema.safeParse(c.req.param('id'));
  const view = id.success ? await readStudiosRequest(identity.avatarId, id.data) : null;
  if (!view) return c.json({ error: 'request_not_found', code: 'request_not_found' }, 404);
  return c.json(view);
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

const APPROVAL_GATE: HumanGateCopy = {
  humanOnlyCode: 'studios_approval_human_only',
  humanOnlyMessage: 'Only your human can approve or decline a payment, in the ClawVille wallet panel (Approvals). Wait for their answer.',
  needsLoginCode: 'studios_approval_needs_human_login',
  needsLoginMessage: 'Sign in again in your browser, then approve or decline the request.',
};
const approvalGate = [refuseAgentHeader(APPROVAL_GATE), requireAuth, requireHumanSessionOrigin(APPROVAL_GATE), requireNonGuestUser] as const;

/**
 * Tell a hosted agent the human's answer: one short line for its next decide
 * (the same slot as the generate_image result). Best effort; the agent can
 * also see the image in its media list.
 */
async function tellHostedAgent(userId: string, avatarId: string, line: string): Promise<void> {
  try {
    const { agentAutonomyDriver } = await import('../services/agent-autonomy-driver');
    const agentId = agentAutonomyDriver.getEnrolledAgentForOwner(userId);
    if (agentId) agentAutonomyDriver.rememberActionResult(agentId, avatarId, line);
  } catch {
    // The human's answer still stands; only the note to the agent is lost.
  }
}

vendorStudiosRoutes.get('/approvals', ...approvalGate, async (c) => {
  const user = c.get('user') as { id: string };
  return c.json({ approvals: await listAwaitingApprovals(await activeAvatarId(user.id)) });
});

const APPROVAL_NEEDS_WALLET_LINK = {
  error: 'studios_approval_needs_wallet_link',
  code: 'studios_approval_needs_wallet_link',
  message: 'Link your own wallet in the wallet panel first. It signs each payment you approve.',
} as const;
const APPROVAL_NEEDS_WALLET_PROOF = {
  error: 'studios_approval_needs_wallet_proof',
  code: 'studios_approval_needs_wallet_proof',
  message: 'Approving a payment needs a signature from your linked wallet. Ask POST /api/vendors/studios/approvals/<id>/challenge first.',
} as const;
const APPROVAL_INVALID_WALLET_PROOF = {
  error: 'studios_approval_invalid_wallet_proof',
  code: 'studios_approval_invalid_wallet_proof',
  message: 'The wallet signature did not match. Ask for a new challenge and sign again.',
} as const;
const approveBodySchema = z.object({
  proof: z.object({ nonce: z.string().min(32).max(64), signature: z.string().min(80).max(100) }).strict(),
}).strict();

vendorStudiosRoutes.post('/approvals/:id/challenge', smallBody, ...approvalGate, async (c) => {
  const user = c.get('user') as { id: string };
  const id = requestIdSchema.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'approval_not_found', code: 'approval_not_found' }, 404);
  const avatarId = await activeAvatarId(user.id);
  const wallet = await linkedWallet(user.id);
  if (!wallet) return c.json(APPROVAL_NEEDS_WALLET_LINK, 403);
  const read = await readApprovalTerms(avatarId, id.data);
  if (!read.ok) return c.json({ error: read.result.code, code: read.result.code, message: read.result.message }, read.result.httpStatus);
  return c.json({ ...issueApprovalChallenge(user.id, read.terms), walletPubkey: wallet });
});

vendorStudiosRoutes.post('/approvals/:id/approve', smallBody, ...approvalGate, async (c) => {
  const user = c.get('user') as { id: string };
  const id = requestIdSchema.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'approval_not_found', code: 'approval_not_found' }, 404);
  const body = approveBodySchema.safeParse(await c.req.json().catch(() => ({})));
  // No per-minute limiter here: the agent's own calls already used it, and
  // at most 5 requests can wait, so the human's clicks are bounded.
  const avatarId = await activeAvatarId(user.id);
  const wallet = await linkedWallet(user.id);
  if (!wallet) return c.json(APPROVAL_NEEDS_WALLET_LINK, 403);
  if (!body.success) return c.json(APPROVAL_NEEDS_WALLET_PROOF, 403);
  // The terms are read again now; the signature must cover exactly these.
  const read = await readApprovalTerms(avatarId, id.data);
  if (!read.ok) return c.json({ error: read.result.code, code: read.result.code, message: read.result.message }, read.result.httpStatus);
  const verdict = verifyApprovalProof({
    userId: user.id,
    terms: read.terms,
    nonce: body.data.proof.nonce,
    signature: body.data.proof.signature,
    walletPubkey: wallet,
  });
  if (verdict !== 'ok') return c.json(APPROVAL_INVALID_WALLET_PROOF, 401);
  const { result, surface, operation } = await approveStudiosRequest({ avatarId, userId: user.id, requestId: id.data, terms: read.terms });
  if (surface === 'hosted') {
    const { formatGeneratedImageResult, formatStudiosJobLine } = await import('../services/npc-simulation');
    await tellHostedAgent(user.id, avatarId, operation === 'image' || operation === null
      ? formatGeneratedImageResult(result as StudiosImageResult)
      : formatStudiosJobLine(operation, result));
  }
  return answer(c, result);
});

vendorStudiosRoutes.post('/approvals/:id/decline', ...approvalGate, async (c) => {
  const user = c.get('user') as { id: string };
  const id = requestIdSchema.safeParse(c.req.param('id'));
  if (!id.success) return c.json({ error: 'approval_not_found', code: 'approval_not_found' }, 404);
  const avatarId = await activeAvatarId(user.id);
  const declined = await declineStudiosRequest({ avatarId, userId: user.id, requestId: id.data });
  if (!declined.ok) {
    const { result } = declined;
    return c.json({ error: result.code, code: result.code, message: result.message }, result.httpStatus);
  }
  if (declined.surface === 'hosted') {
    const { formatGenerateImageDeclined, formatStudiosJobLine } = await import('../services/npc-simulation');
    await tellHostedAgent(user.id, avatarId, declined.operation === 'image'
      ? formatGenerateImageDeclined()
      : formatStudiosJobLine(declined.operation, { ok: false, code: 'approval_declined' }));
  }
  return c.json({ requestId: declined.requestId, status: declined.status });
});

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
