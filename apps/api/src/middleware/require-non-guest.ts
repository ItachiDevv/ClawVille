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
/** After requireAuthOrAgentSession: 403 a guest user; agents (kind:'agent') + non-guest users pass. */
export const requireNonGuestIdentity = createMiddleware<ActivityAuthContext>(async (c, next) => {
  const identity = c.get('identity');
  if (identity && identity.kind === 'user' && (await isGuestUser(identity.userId))) return c.json(GUEST_BLOCKED, 403);
  return next();
});
