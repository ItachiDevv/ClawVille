/**
 * Shared durable-event replay query (P3 slice 1 primitive, reused by slice 2).
 *
 * The SQL that reads an agent's OWN whitelisted durable history from the
 * append-only `events` spine, since a bigint cursor. Extracted from
 * `agent-gateway.ts` (the `/events/replay` endpoint) so the P3 slice-2 autonomy
 * driver can seed its wake-up context from the SAME query instead of duplicating
 * the SQL (plan §1 slice 2: "factor/share, don't duplicate SQL").
 *
 * OWNER PERIOD SCOPE (security pass 2026-10-04, Codex BLOCKING on protocol 83).
 * The history is owner-private (owner directive text `agent.directive.set`, cove
 * settlements, store sales). Every read takes an `AgentHistoryScope` = the
 * agentId plus the owner the CALLER proved, and the ONE statement:
 *   1. joins the agent's `openclaw_bots` row and requires its CURRENT `user_id`
 *      to equal that proven owner. An ownership change after the caller's proof
 *      returns zero rows; the proof and the scope can never disagree (no TOCTOU
 *      between "check owner" and "choose the owner's period");
 *   2. returns only events with `ts >= owner_since` (migration
 *      0079_agent_owner_since.sql: a trigger stamps it on every INSERT and every
 *      `user_id` change), so the new owner never sees the prior owner's period;
 *   3. requires owner ATTRIBUTION for EVERY type (Codex round 3 BLOCKING;
 *      founder rule: event history is owner-only): `events.user_id` must equal
 *      the current owner. A row attributed to another user, and a row with a
 *      NULL `user_id`, is never returned. The timestamp alone cannot prove who
 *      owned a NULL row: a prior owner's fire-and-forget insert can land after
 *      the ownership change, and even a chat turn's payload (target + message
 *      length) tells the new owner what the prior owner did. Since 2026-10-04
 *      every emit site records the proven owner (`agent-event-owner.ts`,
 *      `world-teacher-chat.ts`); rows logged before that without attribution,
 *      or for an unproven session, are not replayed.
 *
 * SAFE COLUMNS ONLY — selects id/eventType/ts/payload and nothing else (no
 * fp_hash / ip_prefix_hash / session_id / user_id / agent_id). Payloads were
 * sanitized WRITE-side by `event-logger.ts`; consumers never re-expose more.
 */

import {
  agentBots,
  and,
  asc,
  db,
  desc,
  eq,
  events as eventsTable,
  gt,
  gte,
  inArray,
} from '@clawville/database';
import { AGENT_STREAM_EVENT_TYPES, type DurableEventRow } from './agent-stream-config';

/**
 * Whose history a read may return: ONE canonical `agentId` (openclaw_bots.agent_id,
 * resolved the same way the emit sites key their rows) and the owner the caller
 * PROVED for it. The gateway takes both from ONE `resolveAgentSession` call (its
 * `agentId` + a non-null `userId`); the autonomy driver takes them from its
 * enrollment entry (`agentId` + `houseUserId`, the row owner it enrolled under).
 */
export interface AgentHistoryScope {
  agentId: string;
  ownerUserId: string;
}

/**
 * The scoped read, shared by both orders. Exported for the SQL-shape unit test
 * (`.toSQL()` without a connection); callers use the two functions below.
 */
export function buildDurableAgentEventsQuery(
  scope: AgentHistoryScope,
  afterId: bigint,
  limit: number,
  order: 'asc' | 'desc',
) {
  return db
    .select({
      id: eventsTable.id,
      eventType: eventsTable.eventType,
      ts: eventsTable.ts,
      payload: eventsTable.payload,
    })
    .from(eventsTable)
    .innerJoin(agentBots, eq(agentBots.agentId, eventsTable.agentId))
    .where(
      and(
        eq(eventsTable.agentId, scope.agentId),
        // (1) the proven owner is STILL the row owner, in this same statement.
        eq(agentBots.userId, scope.ownerUserId),
        // (2) only the current owner's period.
        gte(eventsTable.ts, agentBots.ownerSince),
        // (3) owner attribution, every type: the row names the current owner.
        // Never another user's row, never a NULL-attributed row (fail closed).
        eq(eventsTable.userId, agentBots.userId),
        inArray(eventsTable.eventType, [...AGENT_STREAM_EVENT_TYPES]),
        gt(eventsTable.id, afterId),
      ),
    )
    .orderBy(order === 'asc' ? asc(eventsTable.id) : desc(eventsTable.id))
    .limit(limit);
}

/**
 * Read the whitelisted durable events of the scope's agent in the proven owner's
 * period, with `events.id > afterId`, ascending, capped at `limit`. A row written
 * for a real agent carries the canonical agentId; a digest-fallback row can never
 * match. Zero rows when the row's current owner is not `scope.ownerUserId`.
 */
export async function queryDurableAgentEvents(
  scope: AgentHistoryScope,
  afterId: bigint,
  limit: number,
): Promise<DurableEventRow[]> {
  return buildDurableAgentEventsQuery(scope, afterId, limit, 'asc');
}

/**
 * Same scope as `queryDurableAgentEvents` but returns the NEWEST rows first
 * (`id DESC LIMIT n`). Used by the P3 slice-2 autonomy driver's wake-seed: it
 * wants the recent TAIL (seasoning, not a transcript), and — critically —
 * `rows[0].id` is then the TRUE max id since the cursor, so advancing the cursor
 * to it means a restart with a huge backlog does NOT re-walk the skipped older
 * gap event-by-event. Caller re-sorts ascending for a readable summary.
 */
export async function queryDurableAgentEventsNewest(
  scope: AgentHistoryScope,
  afterId: bigint,
  limit: number,
): Promise<DurableEventRow[]> {
  return buildDurableAgentEventsQuery(scope, afterId, limit, 'desc');
}
