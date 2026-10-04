/**
 * Owner attribution for the agent events the connected-agent gateway emits
 * (security pass 2026-10-04).
 *
 * The durable agent event history (replay, SSE catch-up, autonomy wake-seed;
 * `agent-event-query.ts`) returns a row only when `events.user_id` equals the
 * agent row's CURRENT owner, inside that owner's period. A row with a NULL
 * `user_id` is never returned. So a gateway emit records the owner that THIS
 * session proved, or NULL:
 *   - `provenUserId` given: the handler already resolved the session's owner
 *     through `resolveAgentSession` (for example the CT reward subject). It is
 *     used as is, with no read.
 *   - otherwise connect-sec's use-time owner proof (C10, the rule that
 *     `resolveAgentSession` and `botKnowledgeAccessible` apply): the session
 *     config's `boundUserId` must equal the row's current `user_id`. A session
 *     with no `boundUserId` (unproven, the house agent) costs no read and logs
 *     NULL. A session with one costs one indexed `openclaw_bots.agent_id`
 *     lookup (unique index).
 *
 * Why this never attributes a row to the wrong owner: the `user_id` written is
 * always a user this session proved. If the row is rebound before the insert
 * lands, the new owner does not see it (`user_id` mismatch) and the prior owner
 * does not either (no longer the owner; a later re-bind moves `owner_since`
 * past the row). Never throws: a failed owner lookup logs the event with NULL,
 * which stays hidden (fail closed).
 */
import { agentBots, db, eq } from '@clawville/database';
import { npcSimulation } from './npc-simulation';
import { logEventFromContext, type EventInput } from './event-logger';

type EventContext = Parameters<typeof logEventFromContext>[0];

/** The two session-config fields the owner proof reads. */
export type GatewaySessionOwnerConfig = { agentId: string; boundUserId?: string | null };

/**
 * The owner to record on a gateway event: `provenUserId` when the handler
 * already proved it, else the C10 owner proof against the live row, else null.
 */
export async function resolveGatewayEventOwner(
  config: GatewaySessionOwnerConfig | null | undefined,
  provenUserId: string | null = null,
): Promise<string | null> {
  if (provenUserId) return provenUserId;
  const boundUserId = config?.boundUserId ?? null;
  if (!config || !boundUserId) return null;
  try {
    const row = await db.query.agentBots.findFirst({
      where: eq(agentBots.agentId, config.agentId),
      columns: { userId: true },
    });
    return row?.userId === boundUserId ? boundUserId : null;
  } catch {
    return null;
  }
}

/**
 * `logEventFromContext` for a gateway agent event, with `userId` set to the
 * session's proven owner (see the module comment). The session config is read
 * NOW (synchronously), so a session that ends while the owner lookup runs
 * still resolves against the config that performed the action. Same
 * never-throws contract as `logEventFromContext`; callers fire and forget.
 */
export function logGatewayAgentEvent(
  c: EventContext,
  sessionId: string,
  input: Omit<EventInput, 'userId'>,
  provenUserId: string | null = null,
): Promise<void> {
  const config = npcSimulation.getAgentBotConfig(sessionId);
  return resolveGatewayEventOwner(config, provenUserId).then((userId) =>
    logEventFromContext(c, { ...input, userId }),
  );
}
