import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import {
  AGENT_SESSION_HEADER,
  validateLiveAgentSession,
} from '../middleware/require-auth-or-agent';
import type { AppContext } from '../types';
import {
  deriveGuestPresenceKey,
  verifyGuestBinding,
  WORLD_GUEST_COOKIE_NAME,
} from './world-guest-binding';

export type PresenceKind = 'human' | 'guest' | 'agent';

export interface ResolvedPresence {
  /** Raw internal session key. Never leaves the server. */
  sessionId: string;
  kind: PresenceKind;
  userId: string | null;
  /** Guest-only key used so /join can commit to the exact registered identity. */
  guestPresenceKey?: string;
  /** Whether the guest key came from a verified binding cookie. */
  guestBindingFromCookie?: boolean;
}

/**
 * Resolve world identity with the existing precedence:
 * Lucia user > validated agent session > guest fingerprint/binding cookie.
 */
export async function resolveWorldPresence(
  c: Context<AppContext>,
): Promise<ResolvedPresence> {
  const session = c.get('session');
  if (session?.id) {
    const user = c.get('user');
    return { sessionId: session.id, kind: 'human', userId: user?.id ?? null };
  }

  const agentSessionId = c.req.header(AGENT_SESSION_HEADER);
  if (agentSessionId) {
    const live = await validateLiveAgentSession(agentSessionId);
    if (live) {
      // Owner proof at use time (connect-sec round 4, C12). The row owner goes
      // only to a session whose config `boundUserId` equals the row's CURRENT
      // `userId`: the same rule `resolveAgentSession` applies
      // (middleware/require-auth-or-agent.ts). A stray live session joins as
      // a Visitor with no owner identity, so it cannot load the owner's avatar
      // or displace the owner's body through the room identity dedup.
      // Inline, not `resolveAgentSession`: agents post /position at ~5 Hz and
      // that resolver adds avatar and user queries. The owner-proof world
      // presence test pins this check against `resolveAgentSession`.
      const rowUserId = live.bot.userId ?? null;
      const ownerUserId =
        rowUserId !== null && (live.config.boundUserId ?? null) === rowUserId
          ? rowUserId
          : null;
      return {
        sessionId: `a:${live.config.agentId}`,
        kind: 'agent',
        userId: ownerUserId,
      };
    }
  }

  const fpHash = c.get('fpHash');
  if (!fpHash) {
    throw new HTTPException(500, { message: 'No session or fingerprint available' });
  }

  const committedKey = verifyGuestBinding(getCookie(c, WORLD_GUEST_COOKIE_NAME));
  const guestPresenceKey = committedKey ?? deriveGuestPresenceKey(fpHash);
  return {
    sessionId: `g:${guestPresenceKey}`,
    kind: 'guest',
    userId: null,
    guestPresenceKey,
    guestBindingFromCookie: committedKey !== null,
  };
}
