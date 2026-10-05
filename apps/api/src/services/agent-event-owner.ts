/**
 * Owner attribution for the agent events the connected-agent gateway emits
 * (security pass 2026-10-04).
 *
 * The durable agent event history (replay, SSE catch-up, autonomy wake-seed;
 * `agent-event-query.ts`) returns a row only when `events.user_id` equals the
 * agent row's CURRENT owner, inside that owner's period. A row with a NULL
 * `user_id` is never returned. So a gateway emit CLAIMS the owner this session
 * proved, and the event logger resolves the claim inside the INSERT:
 *   - `provenUserId` given: the handler already resolved the session's owner
 *     through `resolveAgentSession` (for example the CT reward subject);
 *   - otherwise connect-sec's use-time owner proof (C10, the rule that
 *     `resolveAgentSession` and `botKnowledgeAccessible` apply): the session
 *     config's `boundUserId` is the claim, and it counts only while it equals
 *     the row's current `user_id`;
 *   - a session with neither (unproven, the house agent) claims nobody and
 *     logs NULL with no subquery and no lock.
 *
 * Codex round 4: the owner check and the insert are ONE statement
 * (`logOwnedAgentEventFromContext` in `event-logger.ts`: `user_id` = a
 * subquery on `openclaw_bots` with the claimed owner, `owner_since <= actedAt`,
 * FOR SHARE). There is no separate owner read before the insert, so an
 * ownership change can never slip between the check and the write: a change
 * that commits first makes the row NULL, a concurrent change waits for the
 * insert to commit (its owner_since then follows the row's ts), and a complete
 * A -> B -> A round trip after `actedAt` also yields NULL. Never throws: an
 * insert failure goes to event_write_failures.
 */
import { npcSimulation } from './npc-simulation';
import { logOwnedAgentEventFromContext, type EventInput } from './event-logger';

type EventContext = Parameters<typeof logOwnedAgentEventFromContext>[0];

/** The two session-config fields the owner claim reads. */
export type GatewaySessionOwnerConfig = { agentId: string; boundUserId?: string | null };

/**
 * The owner a gateway event claims: `provenUserId` when the handler already
 * proved it, else the session config's `boundUserId`, else null. Pure (no
 * read); the claim is checked against the live row inside the event INSERT.
 */
export function gatewayEventOwnerClaim(
  config: GatewaySessionOwnerConfig | null | undefined,
  provenUserId: string | null = null,
): string | null {
  if (provenUserId) return provenUserId;
  return config?.boundUserId ?? null;
}

/**
 * Log a gateway agent event with the session's owner claim (see the module
 * comment). The session config and `actedAt` are read NOW (synchronously), so
 * a session that ends before the insert still claims the owner of the config
 * that performed the action. Same never-throws contract as
 * `logEventFromContext`; callers fire and forget.
 */
export function logGatewayAgentEvent(
  c: EventContext,
  sessionId: string,
  input: Omit<EventInput, 'userId' | 'agentId'> & { agentId: string },
  provenUserId: string | null = null,
): Promise<void> {
  const actedAt = new Date().toISOString();
  const config = npcSimulation.getAgentBotConfig(sessionId);
  return logOwnedAgentEventFromContext(c, {
    ...input,
    claimedOwnerUserId: gatewayEventOwnerClaim(config, provenUserId),
    actedAt,
  });
}
