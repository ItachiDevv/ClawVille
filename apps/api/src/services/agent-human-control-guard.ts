import type { Context } from 'hono';

/**
 * Every external agent POST transport that can mutate the shared body, world,
 * progression, or Cove state. Route declarations consume these exact literals
 * so the enforcement inventory and the mounted paths cannot drift.
 */
export const HUMAN_CONTROLLED_MUTATING_AGENT_ROUTE_PATTERNS = [
  '/:sessionId/move',
  '/:sessionId/chat',
  '/:sessionId/visit-building',
  '/:sessionId/building/:buildingId/chat',
  '/:sessionId/combat-action',
  '/:sessionId/emote',
  '/:sessionId/cove/blackjack/:tool',
  '/:sessionId/cove/poker/:tool',
] as const;

export const HUMAN_CONTROLLED_AGENT_ERROR =
  'Agent actions are paused while a human controls this avatar';

interface AgentHumanControlState {
  getAgentBotConfig(sessionId: string): { agentId: string } | null | undefined;
  isAgentHumanControlled(agentId: string): boolean;
}

/** Poker's uniform POST tool transport wraps both router GET reads and POST writes. */
export function isMutatingCovePokerForward(forward: { method: 'GET' | 'POST' }): boolean {
  return forward.method === 'POST';
}

/**
 * Build the rejection for an external mutation while the human-control lease
 * is active.
 *
 * IMPORTANT: callers invoke this only AFTER their existing authoritative
 * session-liveness and known-tool checks. Both collaborators here are
 * deliberately synchronous in-memory lookups, so suppression adds no DB query
 * and cannot shadow an invalid/expired bearer or unknown-tool 404.
 */
export function agentHumanControlConflictResponse(
  c: Context,
  state: AgentHumanControlState,
): Response | null {
  // Defensive: a future accidental GET call must never suppress perception.
  if (c.req.method !== 'POST') return null;

  const sessionId = c.req.param('sessionId');
  if (!sessionId) return null;
  const config = state.getAgentBotConfig(sessionId);
  if (!config || !state.isAgentHumanControlled(config.agentId)) return null;

  return c.json(
    {
      error: HUMAN_CONTROLLED_AGENT_ERROR,
      code: 'human_controlled' as const,
      retryAfterSeconds: 15,
    },
    409,
  );
}
