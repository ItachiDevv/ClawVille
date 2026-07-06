/**
 * Shared durable-event replay query (P3 slice 1 primitive, reused by slice 2).
 *
 * The SQL that reads an agent's OWN whitelisted durable history from the
 * append-only `events` spine, since a bigint cursor, ascending. Extracted from
 * `agent-gateway.ts` (the `/events/replay` endpoint) so the P3 slice-2 autonomy
 * driver can seed its wake-up context from the SAME query instead of duplicating
 * the SQL (plan §1 slice 2: "factor/share, don't duplicate SQL").
 *
 * SAFE COLUMNS ONLY — selects id/eventType/ts/payload and nothing else (no
 * fp_hash / ip_prefix_hash / session_id / user_id / agent_id). Payloads were
 * sanitized WRITE-side by `event-logger.ts`; consumers never re-expose more.
 */

import { db, events as eventsTable, and, asc, desc, eq, gt, inArray } from '@clawville/database';
import { AGENT_STREAM_EVENT_TYPES, type DurableEventRow } from './agent-stream-config';

/**
 * Read the whitelisted durable events for ONE canonical `agentId`, with
 * `events.id > afterId`, ascending, capped at `limit`. The `agentId` is the
 * canonical grouping handle (openclaw_bots.agent_id) — the caller resolves it
 * the same way the emit sites key their rows, so a row written for a real agent
 * carries that id and is returned; a digest-fallback row can never match.
 */
export async function queryDurableAgentEvents(
  agentId: string,
  afterId: bigint,
  limit: number,
): Promise<DurableEventRow[]> {
  return db
    .select({
      id: eventsTable.id,
      eventType: eventsTable.eventType,
      ts: eventsTable.ts,
      payload: eventsTable.payload,
    })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.agentId, agentId),
        inArray(eventsTable.eventType, [...AGENT_STREAM_EVENT_TYPES]),
        gt(eventsTable.id, afterId),
      ),
    )
    .orderBy(asc(eventsTable.id))
    .limit(limit);
}

/**
 * Same filter as `queryDurableAgentEvents` but returns the NEWEST rows first
 * (`id DESC LIMIT n`). Used by the P3 slice-2 autonomy driver's wake-seed: it
 * wants the recent TAIL (seasoning, not a transcript), and — critically —
 * `rows[0].id` is then the TRUE max id since the cursor, so advancing the cursor
 * to it means a restart with a huge backlog does NOT re-walk the skipped older
 * gap event-by-event. Caller re-sorts ascending for a readable summary.
 */
export async function queryDurableAgentEventsNewest(
  agentId: string,
  afterId: bigint,
  limit: number,
): Promise<DurableEventRow[]> {
  return db
    .select({
      id: eventsTable.id,
      eventType: eventsTable.eventType,
      ts: eventsTable.ts,
      payload: eventsTable.payload,
    })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.agentId, agentId),
        inArray(eventsTable.eventType, [...AGENT_STREAM_EVENT_TYPES]),
        gt(eventsTable.id, afterId),
      ),
    )
    .orderBy(desc(eventsTable.id))
    .limit(limit);
}
