/**
 * In-memory pub/sub for "knowledge added to a connected agent" events.
 *
 * Used by `/api/items/learn` (book read) to push a notification onto the
 * agent's SSE perception stream so the harness can auto-install the
 * matching SKILL.md without requiring the user to manually re-export
 * their character JSON.
 *
 * Architecture:
 *   - Publishers: `apps/api/src/routes/items.ts` (book read), and any
 *     other code path that grants new knowledge to a avatar whose user has
 *     an active agent session.
 *   - Subscriber: the SSE loop at `agent-gateway.ts:/:sessionId/events`
 *     calls `drain(sessionId)` once per 2s tick and writes any pending
 *     events to the stream.
 *
 * This is single-process in-memory only. If/when ClawVille scales to
 * multiple Bun replicas, this needs a Postgres LISTEN/NOTIFY or Redis
 * pub/sub backing — flag in CLAUDE.md when that day comes.
 */
export type KnowledgeAddedEvent = {
  type: 'knowledge_added';
  /** What pushed this entry — `book` for an /items/learn flow, `chat` for an in-building teach turn. */
  source: 'book' | 'chat';
  /** Building this knowledge belongs to, in current renamed kebab-case (cron-automation, app-publishing, etc.). */
  buildingId: string;
  /** Display name of the source artifact (book name or character name). */
  sourceName: string;
  /** Authed agent-side fetch URL for the matching SKILL.md (relative to api origin). */
  skillUrl: string;
  /** New knowledge entries the agent just received. Capped at 8 — pull SKILL.md for the full body. */
  knowledgeEntries: string[];
  /** Server clock, ISO-8601. Lets the harness dedupe on retry. */
  emittedAt: string;
};

const queues = new Map<string, KnowledgeAddedEvent[]>();

/** Push an event onto a session's pending queue. Idempotent on dropped sessions. */
export function publishKnowledgeAdded(sessionId: string, event: KnowledgeAddedEvent): void {
  const q = queues.get(sessionId) ?? [];
  q.push(event);
  queues.set(sessionId, q);
}

/** Drain any pending events for a session. Returns [] if none. */
export function drainKnowledgeEvents(sessionId: string): KnowledgeAddedEvent[] {
  const q = queues.get(sessionId);
  if (!q || q.length === 0) return [];
  queues.delete(sessionId);
  return q;
}

/** Drop a session's queue entirely on disconnect/expire so we don't leak memory. */
export function clearSessionQueue(sessionId: string): void {
  queues.delete(sessionId);
}

/** Test/debug only — current queue depth across all sessions. */
export function totalQueueDepth(): number {
  let n = 0;
  for (const q of queues.values()) n += q.length;
  return n;
}
