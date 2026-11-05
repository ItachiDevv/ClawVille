/**
 * Human-session gates for owner-only writes (spend rules, wallet link).
 *
 * `refuseAgentHeader` runs BEFORE `requireAuth`: any request that carries an
 * agent session header is an agent request, also when it sends a cookie.
 *
 * `requireHumanSessionOrigin` runs AFTER `requireAuth`. It accepts only login
 * origins that a human sign-in produces (`sessions.created_via`, migration
 * 0089). An agent can trade its live session for its owner's cookie
 * ('agent_exchange'), so that origin is refused; a guest session and a
 * pre-0089 session (NULL) must sign in again.
 *
 * Known limit: a magic link passes through the agent, so a 'magic_link'
 * session is not proof of a human. Writes that let an agent spend more also
 * need a signature from the human's linked wallet (spend-policy-proof.ts).
 */

import type { MiddlewareHandler } from 'hono';
import type { SessionCreatedVia } from '../lib/auth';
import { AGENT_SESSION_HEADER } from './require-auth-or-agent';

export const HUMAN_SESSION_ORIGINS: ReadonlySet<SessionCreatedVia> = new Set<SessionCreatedVia>([
  'password',
  'magic_link',
  'avatar_create',
]);

export interface HumanGateCopy {
  /** Code for an agent request (`<prefix>_human_only`). */
  humanOnlyCode: string;
  humanOnlyMessage: string;
  /** Code for a session that must sign in again (`<prefix>_needs_human_login`). */
  needsLoginCode: string;
  needsLoginMessage: string;
}

export function refuseAgentHeader(copy: HumanGateCopy): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header(AGENT_SESSION_HEADER)) {
      return c.json({ error: copy.humanOnlyCode, code: copy.humanOnlyCode, message: copy.humanOnlyMessage }, 403);
    }
    return next();
  };
}

export function requireHumanSessionOrigin(copy: HumanGateCopy): MiddlewareHandler {
  return async (c, next) => {
    const session = c.get('session') as { createdVia?: SessionCreatedVia | null } | null | undefined;
    const createdVia = session?.createdVia ?? null;
    if (createdVia === 'agent_exchange') {
      return c.json({ error: copy.humanOnlyCode, code: copy.humanOnlyCode, message: copy.humanOnlyMessage }, 403);
    }
    if (createdVia === null || !HUMAN_SESSION_ORIGINS.has(createdVia)) {
      return c.json({ error: copy.needsLoginCode, code: copy.needsLoginCode, message: copy.needsLoginMessage }, 403);
    }
    return next();
  };
}
