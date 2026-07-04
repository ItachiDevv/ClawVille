/**
 * In-memory pub/sub for the connected-agent LIVE event tier (P3 slice 1, D7).
 *
 * Originally carried only `knowledge_added` (book-read auto-install push); it is
 * now the typed AGENT event bus, additionally carrying `stream` frames
 * (settlement confirms + future whitelisted agent events). The knowledge surface
 * is UNCHANGED on the wire — `publishKnowledgeAdded` / `drainKnowledgeEvents`
 * keep their exact shapes for the existing consumers (the `/events` SSE loop and
 * the `/pending-installs` poller).
 *
 * DURABILITY lives in the `events` table, NOT here. This queue is the
 * low-latency live tier only: an event dropped from RAM (disconnect, cap) is
 * still replayable via `GET /api/agent/:sid/events/replay` and the SSE
 * `Last-Event-ID` catch-up. So the queue is bounded (drop OLDEST past the cap)
 * and cleared on SSE disconnect — it can never leak.
 *
 * Architecture:
 *   - Publishers: `routes/items.ts` (book read -> knowledge_added),
 *     `services/agent-settlement-publish.ts` (cove settle -> stream), and any
 *     other code granting a live event to a session with an active agent.
 *   - Subscribers: the SSE loop at `agent-gateway.ts:/:sessionId/events` drains
 *     `drainKnowledgeEvents` + `drainAgentStreamEvents` once per 2s tick; the
 *     `/:sessionId/pending-installs` poller drains `drainKnowledgeEvents`.
 *
 * This is single-process in-memory only. If/when ClawVille scales to multiple
 * Bun replicas, the LIVE tier needs a Postgres LISTEN/NOTIFY or Redis pub/sub
 * backing (the DURABLE tier already survives a replica bounce via the table).
 */
export type KnowledgeAddedEvent = {
  type: 'knowledge_added';
  /** What pushed this entry — `book` for an /items/learn flow, `chat` for an in-building teach turn. */
  source: 'book' | 'chat';
  /** Building this knowledge belongs to, in current renamed kebab-case (cron-automation, app-publishing, etc.). */
  buildingId: string;
  /**
   * Canonical skill name matching the YAML frontmatter `name:` field of the
   * resolved SKILL.md (`clawville-<buildingId>`). Harnesses should use this
   * as the key when registering the skill in their internal config.
   */
  skillName: string;
  /**
   * Suggested filename for harnesses that drop the .md into a folder.
   * Resolves the ambiguity of `skill.md` (which is just the SKILL.md spec
   * convention for the URL endpoint, not a useful local filename).
   */
  suggestedFilename: string;
  /** Display name of the source artifact (book name or character name). */
  sourceName: string;
  /** Authed agent-side fetch URL for the matching SKILL.md (relative to api origin). */
  skillUrl: string;
  /**
   * Authed agent-side fetch URL for the matching tools.json — declares the
   * callable function schemas the harness should register with its LLM
   * tool dispatcher. Same auth + gating as skillUrl.
   */
  toolsUrl: string;
  /** Suggested filename for the tools.json drop. */
  toolsFilename: string;
  /** New knowledge entries the agent just received. Capped at 8 — pull SKILL.md for the full body. */
  knowledgeEntries: string[];
  /** Server clock, ISO-8601. Lets the harness dedupe on retry. */
  emittedAt: string;
};

/**
 * A generic durable-backed live frame (settlement confirms today; other
 * whitelisted agent events later). `eventId` is the backing `events.id` so the
 * SSE loop can emit a standard `id:` line and the agent's `Last-Event-ID` cursor
 * advances. `data` is the BEARER-FREE frame body — it MUST NOT contain a raw
 * session id or any secret (settlement facts only).
 */
export type AgentStreamEvent = {
  type: 'stream';
  /** SSE event name to emit (e.g. `settlement`). */
  channel: string;
  /** The durable `events.id` this frame is backed by (string; the SSE `id:` line). */
  eventId: string;
  /** Bearer-free frame body — NEVER a raw session id / secret. */
  data: Record<string, unknown>;
  /** Server clock, ISO-8601. */
  emittedAt: string;
};

type BusEvent = KnowledgeAddedEvent | AgentStreamEvent;

const queues = new Map<string, BusEvent[]>();

/**
 * Per-session queue cap. The DURABLE tier (events table + replay endpoint) is
 * authoritative, so the live queue is best-effort: past the cap we drop the
 * OLDEST frames rather than leak for a session that opens no SSE / never
 * disconnects. Generous enough that a normally-drained session (every 2s via
 * SSE, or 30-60s via the poller) never approaches it.
 */
const MAX_QUEUE_PER_SESSION = 512;

function pushEvent(sessionId: string, ev: BusEvent): void {
  const q = queues.get(sessionId) ?? [];
  q.push(ev);
  if (q.length > MAX_QUEUE_PER_SESSION) {
    q.splice(0, q.length - MAX_QUEUE_PER_SESSION);
  }
  queues.set(sessionId, q);
}

/** Drain (and remove) only the events of `type`, leaving the rest queued. */
function drainByType<T extends BusEvent['type']>(
  sessionId: string,
  type: T,
): Extract<BusEvent, { type: T }>[] {
  const q = queues.get(sessionId);
  if (!q || q.length === 0) return [];
  const matched: BusEvent[] = [];
  const rest: BusEvent[] = [];
  for (const ev of q) (ev.type === type ? matched : rest).push(ev);
  if (matched.length === 0) return [];
  if (rest.length === 0) queues.delete(sessionId);
  else queues.set(sessionId, rest);
  return matched as Extract<BusEvent, { type: T }>[];
}

/** Push a knowledge-added event onto a session's pending queue. Idempotent on dropped sessions. */
export function publishKnowledgeAdded(sessionId: string, event: KnowledgeAddedEvent): void {
  pushEvent(sessionId, event);
}

/** Push a generic durable-backed stream event (settlement confirm, etc.) onto a session's queue. */
export function publishAgentStreamEvent(sessionId: string, event: AgentStreamEvent): void {
  pushEvent(sessionId, event);
}

/** Drain any pending knowledge-added events for a session. Returns [] if none. Leaves stream events queued. */
export function drainKnowledgeEvents(sessionId: string): KnowledgeAddedEvent[] {
  return drainByType(sessionId, 'knowledge_added');
}

/** Drain any pending stream events (settlement confirms, etc.) for a session. Returns [] if none. Leaves knowledge events queued. */
export function drainAgentStreamEvents(sessionId: string): AgentStreamEvent[] {
  return drainByType(sessionId, 'stream');
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
