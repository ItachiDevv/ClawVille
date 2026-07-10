import { createMiddleware } from 'hono/factory';
import { db, users } from '@clawville/database';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../types';
import type { ActivityAuthContext } from './require-auth-or-agent';

/** Guest all-demo economy (founder ruling 2026-07-06). A guest is a real Lucia
 * user + avatar + 100-CT DEMO soft balance, so every real-CT write surface treats
 * a guest as real unless blocked. ONLY guests blocked — non-guest users AND
 * connected/hosted agents (an agent is NEVER a guest, E5) keep real settlement. */
export async function isGuestUser(userId: string): Promise<boolean> {
  const row = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { isGuest: true } });
  return !!row?.isGuest;
}
const GUEST_BLOCKED = { error: 'Guests run a demo economy — create a free account to use real ClawTokens.', code: 'guest_not_allowed' as const };
/** After requireAuth OR any sessionMiddleware route: 403 a guest; non-guest users + agent (null Lucia user) pass. */
export const requireNonGuestUser = createMiddleware<AppContext>(async (c, next) => {
  const user = c.get('user');
  if (user && (await isGuestUser(user.id))) return c.json(GUEST_BLOCKED, 403);
  return next();
});
/**
 * After requireAuthOrAgentSession: 403 a guest — whether they arrive as a human
 * (`kind:'user'`) OR as the OWNER of a connected agent (`kind:'agent'` whose bound
 * `userId` is a guest). A guest can mint a connect-token bound to its own guest
 * userId (`/api/agent/connect-token` has no is_guest gate), so gating only
 * `kind:'user'` let a guest-owned agent settle REAL CT on land/bounties. An agent
 * is never itself a guest, but its OWNER can be — and a guest must be demo-only on
 * every real-economy surface, as a human or via an agent it owns (founder ruling
 * 2026-07-06). Non-guest users + agents bound to non-guest owners (E5, the only
 * legit agents) pass. Belt-and-suspenders with the resolveAgentSession guest
 * demotion; land gates on identity/kind here, not on ledgerCapable.
 */
export const requireNonGuestIdentity = createMiddleware<ActivityAuthContext>(async (c, next) => {
  const identity = c.get('identity');
  if (
    identity &&
    (identity.kind === 'user' || identity.kind === 'agent') &&
    identity.userId &&
    (await isGuestUser(identity.userId))
  ) {
    return c.json(GUEST_BLOCKED, 403);
  }
  return next();
});
