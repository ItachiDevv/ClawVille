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
      return {
        sessionId: `a:${live.config.agentId}`,
        kind: 'agent',
        userId: live.bot.userId ?? null,
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
