/**
 * Studios sign-in (OAuth) for the human's own Studios account, MCP hub phase
 * 3c (migration 0094, services/vendors/studios-oauth.ts).
 *
 *   POST   /api/vendors/studios/oauth/challenge human only, body `{ action: 'link' | 'unlink' }`
 *          -> `{ nonce, expiresAt, messageToSign, walletPubkey }` for the linked wallet
 *   POST   /api/vendors/studios/oauth/start     human only + `{ proof }` -> `{ authorizeUrl }`
 *   GET    /api/vendors/studios/oauth/callback  browser return from Studios;
 *          always a 302 to `<web>/game?studios=linked` or
 *          `<web>/game?studios=error&reason=<code>`
 *   GET    /api/vendors/studios/oauth           `{ linked, status, scope, linkedAt }`
 *          (human session, or an agent session for the same avatar; never tokens)
 *   DELETE /api/vendors/studios/oauth           human only + `{ proof }`: cancel open
 *          sign-ins, remove the link, revoke at Studios
 *
 * The Client ID Metadata Document is served by `index.ts` at
 * `/.well-known/oauth-client/studios.json` (public, cached 5 minutes).
 *
 * Human only = no agent session header, a Lucia session made by a human sign-in
 * (sessions.created_via), not a guest, AND a fresh signature from the user's
 * linked wallet (services/vendors/studios-oauth-proof.ts). An agent can mint
 * its owner's magic-link session, so the session alone does not prove a human;
 * the agent does not hold the linked wallet key.
 *
 * PARITY (Rule E5): the link itself is human-only by design (the human chooses
 * whose Studios account pays). Agents read the link status here; the agent
 * paths that USE the link (the MCP tool and hosted verb) are wired in a later
 * task through the same spend rules.
 */

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { and, avatars, db, eq, users } from '@clawville/database';
import type { SessionCreatedVia } from '../lib/auth';
import { requireAuth, sessionMiddleware } from '../middleware/auth';
import { noStorePrivate } from '../middleware/no-store';
import { createRateLimiter } from '../middleware/rate-limit';
import {
  AGENT_SESSION_HEADER,
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { isGuestUser, requireNonGuestUser } from '../middleware/require-non-guest';
import {
  HUMAN_SESSION_ORIGINS,
  refuseAgentHeader,
  requireHumanSessionOrigin,
  type HumanGateCopy,
} from '../middleware/require-human-session';
import {
  completeStudiosSignIn,
  readStudiosOAuthStatus,
  startStudiosSignIn,
  studiosWebOrigin,
  unlinkStudiosOAuth,
  type StudiosCallbackReason,
} from '../services/vendors/studios-oauth';
import {
  issueStudiosSignInChallenge,
  verifyStudiosSignInProof,
  type StudiosSignInAction,
} from '../services/vendors/studios-oauth-proof';

export const vendorStudiosOAuthRoutes = new Hono<ActivityAuthContext>();

// The callback URL carries the authorization `code`, `state` and `iss`. The
// global request logger prints the path with its query, so index.ts passes
// every log line through this before printing (path only for this route).
const CALLBACK_QUERY_IN_LOG = /(\/api\/vendors\/studios\/oauth\/callback[^?\s]*)\?\S*/g;

export function redactStudiosOAuthCallbackQuery(line: string): string {
  if (typeof line !== 'string' || line.length === 0) return line;
  return line.replace(CALLBACK_QUERY_IN_LOG, '$1?<redacted>');
}

// Each start writes a row and each callback can call Studios once, so both are
// limited per human.
const startRateLimiter = createRateLimiter({ maxPerWindow: 10, windowMs: 10 * 60_000 });
const callbackRateLimiter = createRateLimiter({ maxPerWindow: 10, windowMs: 10 * 60_000 });
const challengeRateLimiter = createRateLimiter({ maxPerWindow: 20, windowMs: 10 * 60_000 });

/** Test-only: reset the limiters between cases. */
export function resetStudiosOAuthRateLimit(): void {
  startRateLimiter.reset();
  callbackRateLimiter.reset();
  challengeRateLimiter.reset();
}

const SIGNIN_GATE: HumanGateCopy = {
  humanOnlyCode: 'studios_signin_human_only',
  humanOnlyMessage: 'Only the human owner can sign in with Studios or sign out.',
  needsLoginCode: 'studios_signin_needs_human_login',
  needsLoginMessage: 'Sign in again in your browser, then sign in with Studios.',
};

const emptyBody = bodyLimit({
  maxSize: 1024,
  onError: (c) => c.json({ error: 'payload_too_large', code: 'payload_too_large' }, 413),
});

const proofSchema = z.object({ nonce: z.string().min(1).max(128), signature: z.string().min(1).max(128) }).strict();
const proofBodySchema = z.object({ proof: proofSchema.optional() }).strict();
const challengeBodySchema = z.object({ action: z.enum(['link', 'unlink']) }).strict();

const NEEDS_WALLET_LINK = {
  error: 'studios_signin_needs_wallet_link',
  code: 'studios_signin_needs_wallet_link',
  message: 'Link your own wallet in the wallet panel first. It signs to approve a Studios sign-in change.',
} as const;
const NEEDS_WALLET_PROOF = {
  error: 'studios_signin_needs_wallet_proof',
  code: 'studios_signin_needs_wallet_proof',
  message: 'Signing in with Studios or signing out needs a signature from your linked wallet. Ask POST /api/vendors/studios/oauth/challenge first.',
} as const;
const INVALID_WALLET_PROOF = {
  error: 'studios_signin_invalid_wallet_proof',
  code: 'studios_signin_invalid_wallet_proof',
  message: 'The wallet signature did not match. Ask for a new challenge and sign again.',
} as const;

/**
 * Parse the JSON body. Malformed or empty JSON gives `fallback`; any other
 * read error (the body limit's BodyLimitError) is thrown, so `bodyLimit`
 * answers 413 instead of the handler treating the body as missing.
 */
async function readJsonBody(c: Context, fallback: unknown): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (err) {
    if (err instanceof SyntaxError) return fallback;
    throw err;
  }
}

async function linkedWallet(userId: string): Promise<string | null> {
  const owner = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { linkedWalletPubkey: true } });
  return owner?.linkedWalletPubkey ?? null;
}

/**
 * Check the linked-wallet proof for this action. Returns a refusal response,
 * or null when the proof is valid (the nonce is consumed either way).
 */
async function refuseWithoutProof(c: Context, userId: string, avatarId: string, action: StudiosSignInAction) {
  const body = proofBodySchema.safeParse(await readJsonBody(c, {}));
  if (!body.success) return c.json({ error: 'invalid_request', code: 'invalid_request' }, 400);
  const wallet = await linkedWallet(userId);
  if (!wallet) return c.json(NEEDS_WALLET_LINK, 403);
  if (!body.data.proof) return c.json(NEEDS_WALLET_PROOF, 403);
  const verdict = verifyStudiosSignInProof({
    userId,
    avatarId,
    vendor: 'studios',
    action,
    nonce: body.data.proof.nonce,
    signature: body.data.proof.signature,
    walletPubkey: wallet,
  });
  return verdict === 'ok' ? null : c.json(INVALID_WALLET_PROOF, 401);
}

async function activeAvatarId(userId: string): Promise<string> {
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
    columns: { id: true },
  });
  if (!avatar) throw new HTTPException(403, { message: 'avatar_required' });
  return avatar.id;
}

vendorStudiosOAuthRoutes.post(
  '/challenge',
  noStorePrivate,
  emptyBody,
  refuseAgentHeader(SIGNIN_GATE),
  requireAuth,
  requireHumanSessionOrigin(SIGNIN_GATE),
  requireNonGuestUser,
  async (c) => {
    const user = c.get('user') as { id: string };
    const body = challengeBodySchema.safeParse(await readJsonBody(c, null));
    if (!body.success) return c.json({ error: 'invalid_request', code: 'invalid_request' }, 400);
    if (!challengeRateLimiter.check(user.id)) {
      return c.json({ error: 'rate_limited', code: 'rate_limited', message: 'Too many requests. Wait ten minutes.' }, 429);
    }
    const avatarId = await activeAvatarId(user.id);
    const wallet = await linkedWallet(user.id);
    if (!wallet) return c.json(NEEDS_WALLET_LINK, 403);
    return c.json({
      ...issueStudiosSignInChallenge({ userId: user.id, avatarId, vendor: 'studios', action: body.data.action }),
      walletPubkey: wallet,
    });
  },
);

vendorStudiosOAuthRoutes.post(
  '/start',
  noStorePrivate,
  emptyBody,
  refuseAgentHeader(SIGNIN_GATE),
  requireAuth,
  requireHumanSessionOrigin(SIGNIN_GATE),
  requireNonGuestUser,
  async (c) => {
    const user = c.get('user') as { id: string };
    if (!startRateLimiter.check(user.id)) {
      return c.json({ error: 'rate_limited', code: 'rate_limited', message: 'Too many Studios sign-ins. Wait ten minutes.' }, 429);
    }
    const avatarId = await activeAvatarId(user.id);
    const refusal = await refuseWithoutProof(c, user.id, avatarId, 'link');
    if (refusal) return refusal;
    return c.json(await startStudiosSignIn({ userId: user.id, avatarId }));
  },
);

function backToGame(c: Context, outcome: { ok: true } | { ok: false; reason: StudiosCallbackReason }) {
  const target = new URL(`${studiosWebOrigin()}/game`);
  if (outcome.ok) {
    target.searchParams.set('studios', 'linked');
  } else {
    target.searchParams.set('studios', 'error');
    target.searchParams.set('reason', outcome.reason);
  }
  c.header('Referrer-Policy', 'no-referrer');
  return c.redirect(target.toString(), 302);
}

/** One query value, or undefined; a repeated or oversized value counts as absent. */
function singleQuery(c: Context, name: string, max: number): string | undefined {
  const values = c.req.queries(name);
  if (!values || values.length !== 1) return undefined;
  const value = values[0];
  return value.length > 0 && value.length <= max ? value : undefined;
}

vendorStudiosOAuthRoutes.get('/callback', noStorePrivate, sessionMiddleware, async (c) => {
  if (c.req.header(AGENT_SESSION_HEADER)) return backToGame(c, { ok: false, reason: 'human_only' });
  const user = c.get('user') as { id: string } | null;
  const session = c.get('session') as { createdVia?: SessionCreatedVia | null } | null;
  if (!user || !session) return backToGame(c, { ok: false, reason: 'needs_login' });
  const createdVia = session.createdVia ?? null;
  if (createdVia === 'agent_exchange') return backToGame(c, { ok: false, reason: 'human_only' });
  if (createdVia === null || !HUMAN_SESSION_ORIGINS.has(createdVia)) {
    return backToGame(c, { ok: false, reason: 'needs_login' });
  }
  if (await isGuestUser(user.id)) return backToGame(c, { ok: false, reason: 'guest' });
  if (!callbackRateLimiter.check(user.id)) return backToGame(c, { ok: false, reason: 'rate_limited' });

  try {
    const outcome = await completeStudiosSignIn({
      userId: user.id,
      state: singleQuery(c, 'state', 256),
      code: singleQuery(c, 'code', 2048),
      iss: c.req.queries('iss') ? (singleQuery(c, 'iss', 256) ?? '') : undefined,
      error: c.req.queries('error') ? 'present' : undefined,
    });
    return backToGame(c, outcome);
  } catch (err) {
    // A browser navigation always lands back in the game. Log the error name
    // only: the query holds the code and state.
    console.error('[studios-oauth] callback failed:', (err as Error)?.name ?? 'unknown');
    return backToGame(c, { ok: false, reason: 'unavailable' });
  }
});

vendorStudiosOAuthRoutes.get('/', noStorePrivate, sessionMiddleware, requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  return c.json(await readStudiosOAuthStatus(identity.avatarId));
});

vendorStudiosOAuthRoutes.delete(
  '/',
  noStorePrivate,
  emptyBody,
  refuseAgentHeader(SIGNIN_GATE),
  requireAuth,
  requireHumanSessionOrigin(SIGNIN_GATE),
  requireNonGuestUser,
  async (c) => {
    const user = c.get('user') as { id: string };
    const avatarId = await activeAvatarId(user.id);
    const refusal = await refuseWithoutProof(c, user.id, avatarId, 'unlink');
    if (refusal) return refusal;
    await unlinkStudiosOAuth({ userId: user.id, avatarId });
    return c.json(await readStudiosOAuthStatus(avatarId));
  },
);
