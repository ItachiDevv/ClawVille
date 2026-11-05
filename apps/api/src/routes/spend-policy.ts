/**
 * Spend rules for paid third-party tools (MCP hub step 2, phase 1).
 *
 *   GET /api/wallet/spend-policy  - the avatar's rules. A human session OR the
 *                                   avatar's agent session may read.
 *   PUT /api/wallet/spend-policy  - set the rules. Human Lucia session ONLY;
 *                                   an agent session is refused, so an agent
 *                                   can never raise its own cap.
 *
 * PARITY (Rule E5): the WRITE is human-only by design (the owner controls what
 * the agent may spend). Agent path: read the rules here, and the paid tools of
 * phase 2 enforce them. Both settle to the same avatar row.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, avatars, db, eq } from '@clawville/database';
import { requireAuth, sessionMiddleware } from '../middleware/auth';
import { requireNonGuestUser } from '../middleware/require-non-guest';
import {
  AGENT_SESSION_HEADER,
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import { noStorePrivate } from '../middleware/no-store';
import type { SessionCreatedVia } from '../lib/auth';
import { readSpendPolicy, spendPolicyInputSchema, writeSpendPolicy } from '../services/spend-policy';
import type { AppContext } from '../types';

export const spendPolicyRoutes = new Hono<AppContext & ActivityAuthContext>();

spendPolicyRoutes.use('*', sessionMiddleware, noStorePrivate);

spendPolicyRoutes.get('/', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  if (!identity?.avatarId) throw new HTTPException(403, { message: 'avatar_required' });
  return c.json(await readSpendPolicy(identity.avatarId));
});

/**
 * Login origins that only a human sign-in produces. An agent can trade its
 * live session for its owner's cookie ('agent_exchange'), so that origin, a
 * guest session and a pre-0089 session (NULL) cannot write. Known gap: an
 * agent that opens its human's magic link itself gets a 'magic_link' session.
 */
const HUMAN_SESSION_ORIGINS = new Set<SessionCreatedVia>(['password', 'magic_link', 'avatar_create']);

const HUMAN_ONLY = {
  error: 'spend_policy_human_only',
  code: 'spend_policy_human_only',
  message: 'Only the human owner can change spend rules. Ask your human to set them in the ClawVille wallet panel.',
} as const;

spendPolicyRoutes.put(
  '/',
  async (c, next) => {
    // Any request that carries an agent session header is an agent request.
    if (c.req.header(AGENT_SESSION_HEADER)) return c.json(HUMAN_ONLY, 403);
    return next();
  },
  requireAuth,
  async (c, next) => {
    const createdVia = c.get('session')?.createdVia ?? null;
    if (createdVia === 'agent_exchange') return c.json(HUMAN_ONLY, 403);
    if (createdVia === null || !HUMAN_SESSION_ORIGINS.has(createdVia)) {
      return c.json({
        error: 'spend_policy_needs_human_login',
        code: 'spend_policy_needs_human_login',
        message: 'Sign in again in your browser, then change your spend rules.',
      }, 403);
    }
    return next();
  },
  requireNonGuestUser,
  async (c) => {
    const user = c.get('user') as { id: string };
    const body = await c.req.json().catch(() => null);
    const parsed = spendPolicyInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_spend_policy', issues: parsed.error.issues }, 400);
    }
    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
      columns: { id: true },
    });
    if (!avatar) throw new HTTPException(403, { message: 'avatar_required' });
    return c.json(await writeSpendPolicy(avatar.id, user.id, parsed.data));
  },
);
