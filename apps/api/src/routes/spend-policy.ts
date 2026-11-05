/**
 * Spend rules for paid third-party tools (MCP hub step 2, phases 1 and 1b).
 *
 *   GET  /api/wallet/spend-policy            - the avatar's rules. A human
 *                                              session OR the avatar's agent
 *                                              session may read.
 *   POST /api/wallet/spend-policy/challenge  - a wallet-signing challenge for
 *                                              the exact new values. Human only.
 *   PUT  /api/wallet/spend-policy            - set the rules. Human only. A
 *                                              raise (a cap set or raised, or a
 *                                              vendor added) also needs a
 *                                              signature from the linked wallet.
 *
 * PARITY (Rule E5): the WRITE is human-only by design (the owner controls what
 * the agent may spend). Agent path: read the rules here, and the paid tools of
 * phase 2 enforce them. Both settle to the same avatar row.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { and, avatars, db, eq, users } from '@clawville/database';
import { requireAuth, sessionMiddleware } from '../middleware/auth';
import { requireNonGuestUser } from '../middleware/require-non-guest';
import {
  requireAuthOrAgentSession,
  type ActivityAuthContext,
} from '../middleware/require-auth-or-agent';
import {
  refuseAgentHeader,
  requireHumanSessionOrigin,
  type HumanGateCopy,
} from '../middleware/require-human-session';
import { noStorePrivate } from '../middleware/no-store';
import {
  applySpendPolicyChange,
  readSpendPolicy,
  resolveSpendPolicyValues,
  spendPolicyInputSchema,
} from '../services/spend-policy';
import { issueSpendProofChallenge } from '../services/spend-policy-proof';
import type { AppContext } from '../types';

export const spendPolicyRoutes = new Hono<AppContext & ActivityAuthContext>();

spendPolicyRoutes.use('*', sessionMiddleware, noStorePrivate);

spendPolicyRoutes.get('/', requireAuthOrAgentSession, async (c) => {
  const identity = c.get('identity');
  if (!identity?.avatarId) throw new HTTPException(403, { message: 'avatar_required' });
  return c.json(await readSpendPolicy(identity.avatarId));
});

const GATE: HumanGateCopy = {
  humanOnlyCode: 'spend_policy_human_only',
  humanOnlyMessage: 'Only the human owner can change spend rules. Ask your human to set them in the ClawVille wallet panel.',
  needsLoginCode: 'spend_policy_needs_human_login',
  needsLoginMessage: 'Sign in again in your browser, then change your spend rules.',
};

const NEEDS_WALLET_LINK = {
  error: 'spend_policy_needs_wallet_link',
  code: 'spend_policy_needs_wallet_link',
  message: 'Link your own wallet first. Your linked wallet must approve higher caps.',
} as const;

async function activeAvatarId(userId: string): Promise<string> {
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
    columns: { id: true },
  });
  if (!avatar) throw new HTTPException(403, { message: 'avatar_required' });
  return avatar.id;
}

// 32-byte base58 nonce: 43-44 chars; 64-byte base58 signature: 86-88 chars.
const proofSchema = z.object({
  nonce: z.string().min(32).max(64),
  signature: z.string().min(80).max(100),
}).strict();

function splitBody(body: unknown): { policy: unknown; proof: unknown } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { policy: body, proof: undefined };
  const { proof, ...policy } = body as Record<string, unknown>;
  return { policy, proof };
}

spendPolicyRoutes.post(
  '/challenge',
  refuseAgentHeader(GATE),
  requireAuth,
  requireHumanSessionOrigin(GATE),
  requireNonGuestUser,
  async (c) => {
    const user = c.get('user') as { id: string };
    const parsed = spendPolicyInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_spend_policy', code: 'invalid_spend_policy', issues: parsed.error.issues }, 400);
    }
    const avatarId = await activeAvatarId(user.id);
    // The message names every value the PUT will save, the own-key image
    // count included (an absent one keeps the saved value).
    const values = resolveSpendPolicyValues(parsed.data, await readSpendPolicy(avatarId));
    const owner = await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { linkedWalletPubkey: true },
    });
    if (!owner?.linkedWalletPubkey) return c.json(NEEDS_WALLET_LINK, 403);
    return c.json({ ...issueSpendProofChallenge(user.id, values), walletPubkey: owner.linkedWalletPubkey });
  },
);

spendPolicyRoutes.put(
  '/',
  refuseAgentHeader(GATE),
  requireAuth,
  requireHumanSessionOrigin(GATE),
  requireNonGuestUser,
  async (c) => {
    const user = c.get('user') as { id: string };
    const { policy, proof } = splitBody(await c.req.json().catch(() => null));
    const parsed = spendPolicyInputSchema.safeParse(policy);
    const parsedProof = proof === undefined ? null : proofSchema.safeParse(proof);
    if (!parsed.success || (parsedProof && !parsedProof.success)) {
      return c.json({
        error: 'invalid_spend_policy',
        code: 'invalid_spend_policy',
        issues: parsed.success ? [] : parsed.error.issues,
      }, 400);
    }
    const result = await applySpendPolicyChange(
      await activeAvatarId(user.id),
      user.id,
      parsed.data,
      parsedProof?.success ? parsedProof.data : null,
    );
    switch (result.kind) {
      case 'saved':
        return c.json(result.view);
      case 'needs_wallet_link':
        return c.json(NEEDS_WALLET_LINK, 403);
      case 'needs_wallet_proof':
        return c.json({
          error: 'spend_policy_needs_wallet_proof',
          code: 'spend_policy_needs_wallet_proof',
          message: 'Higher caps need a signature from your linked wallet.',
        }, 403);
      case 'invalid_proof':
        return c.json({
          error: 'spend_policy_invalid_wallet_proof',
          code: 'spend_policy_invalid_wallet_proof',
          detail: result.reason,
          message: 'The wallet signature did not match. Try again.',
        }, 401);
    }
  },
);
