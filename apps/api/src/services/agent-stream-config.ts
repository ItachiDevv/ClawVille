/**
 * Agent event-stream curation + replay-cursor primitives (P3 slice 1, D7).
 *
 * The `events` table (append-only, monotonic bigserial `id`) is the DURABLE
 * catch-up log for the connected-agent stream; the RAM bus (`skill-event-bus.ts`)
 * is the low-latency LIVE tier. This module is the dependency-light seam between
 * them: the curated whitelist of durable `event_type`s an agent may REPLAY, plus
 * the pure query-param + projection helpers the replay endpoint and the SSE
 * reconnect path share. Kept free of DB/Hono imports so it is unit-tested
 * directly (mirrors `agent-reconnect-session.ts` / `agent-owner-binding.ts`).
 *
 * NOT a leaderboard change: this is a delivery-curation constant. Some entries
 * coincide with leaderboard-scored event names (`building.visited`,
 * `agent.chat.turn`) but NOTHING here alters `AGENT_SCORE_WEIGHTS`/`DAILY_CAPS`
 * or the scoring CTE — it only decides which durable rows are re-delivered to an
 * agent.
 */

import { z } from 'zod';

/**
 * Curated durable `event_type`s a connected agent may replay from its OWN
 * history. INVARIANT for every entry: it is (a) durably written to `events`,
 * and (b) carries a real `agent_id` (so the agent_id-scoped replay query returns
 * it) — verified at the emit sites. Discrete events only; ephemeral
 * perception/ping snapshots are intentionally excluded (replaying a stale world
 * snapshot is pointless — see the P3 plan §1 slice 1).
 *
 * WHY the match is exact (esp. `building.visited` / `agent.chat.turn`, which fall
 * back to a `sessionDigest` when no bot config is present): BOTH the emit side
 * and the replay query resolve the agent id from the SAME source —
 * `npcSimulation.getOpenClawBotConfig(sessionId)?.agentId`. So a row written for a
 * real connected agent carries that canonical `agentId` and is returned; a row
 * written by the `sessionDigest(sessionId)` fallback (no live bot config) carries
 * a 16-hex digest the replay's canonical `agentId` can NEVER equal, so it is
 * unmatched BY DESIGN — never mis-delivered to another agent, never leaked.
 */
export const AGENT_STREAM_EVENT_TYPES = [
  // Cove settlement confirms — already durably logged with clean bet/payout/net
  // payloads (no secrets). The money-bearing catch-up events.
  'cove.blackjack.hand.settled',
  'cove.baccarat.coup.settled',
  'cove.holdem.hand.settled',
  'cove.slots.spin.executed',
  // Knowledge/skill — the agent-scoped, BEARER-FREE durable knowledge event
  // written alongside the RAM `knowledge_added` push (`items.ts`). Distinct from
  // the human-scoped `book.read` analytics row (which carries no `agent_id`).
  'agent.knowledge_added',
  // World + teaching activity the agent itself performed (agent_id-keyed).
  'building.visited',
  'agent.chat.turn',
  // Reserved for slice 2 (chat-bar directive -> goal stream). Listed now so the
  // whitelist is stable before the emitter lands; a not-yet-emitted type simply
  // returns no rows.
  'agent.directive.set',
] as const;

export type AgentStreamEventType = (typeof AGENT_STREAM_EVENT_TYPES)[number];

const AGENT_STREAM_EVENT_TYPE_SET: ReadonlySet<string> = new Set(AGENT_STREAM_EVENT_TYPES);

/** True iff `t` is a durable event_type an agent may replay. */
export function isReplayableEventType(t: string): boolean {
  return AGENT_STREAM_EVENT_TYPE_SET.has(t);
}

export const REPLAY_LIMIT_DEFAULT = 100;
export const REPLAY_LIMIT_MAX = 500;

/**
 * Zod schema for the replay query string. `after` is the EXCLUSIVE cursor (an
 * `events.id`, a non-negative integer serialized as a string to preserve bigint
 * precision); `limit` is clamped to [1, 500], default 100. Both optional.
 * `.strip()` (Zod default) drops any extra query keys.
 */
export const replayQuerySchema = z.object({
  after: z
    .string()
    .regex(/^\d+$/, 'after must be a non-negative integer')
    .optional(),
  limit: z.coerce.number().int().min(1).max(REPLAY_LIMIT_MAX).optional(),
});

export interface ParsedReplayQuery {
  afterId: bigint;
  limit: number;
}

/**
 * Validate + normalize the raw query params into a bigint cursor + clamped
 * limit. Returns `null` on invalid input (caller returns 400) — never throws.
 */
export function parseReplayQuery(raw: unknown): ParsedReplayQuery | null {
  const parsed = replayQuerySchema.safeParse(raw);
  if (!parsed.success) return null;
  let afterId: bigint;
  try {
    afterId = parsed.data.after !== undefined ? BigInt(parsed.data.after) : 0n;
  } catch {
    return null;
  }
  if (afterId < 0n) return null;
  const limit = parsed.data.limit ?? REPLAY_LIMIT_DEFAULT;
  return { afterId, limit };
}

/**
 * The four SAFE columns the replay path selects from `events`. Shaped exactly so
 * the DB query (`select({id, eventType, ts, payload})`) and the projection agree
 * — nothing else is ever read.
 */
export interface DurableEventRow {
  id: bigint;
  eventType: string;
  ts: Date;
  payload: Record<string, unknown> | null;
}

/** The agent-facing wire shape for a replayed durable event. */
export interface ReplayEvent {
  id: string;
  eventType: string;
  ts: string;
  payload: Record<string, unknown> | null;
}

/**
 * Project a durable row to the SAFE agent-facing shape. ONLY id/eventType/ts/
 * payload cross the wire — NEVER fp_hash, ip_prefix_hash, session_id, user_id,
 * or agent_id (the query already selects only these four columns; this rebuilds
 * a fresh object so even a wider row can't leak a column). `id` -> string
 * (bigint JSON-safety + >2^53 precision); `ts` -> ISO-8601. The payload was
 * sanitized WRITE-side by `event-logger.ts` — we consume it, never re-expose
 * beyond what the sanitizer allowed.
 */
export function projectDurableEvent(row: DurableEventRow): ReplayEvent {
  return {
    id: row.id.toString(),
    eventType: row.eventType,
    ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
    payload: row.payload ?? null,
  };
}

/**
 * `nextCursor` = the highest id in this page (pass as `?after=` on the next
 * call), or `null` when the page is empty (already caught up). Rows MUST be
 * ascending by id.
 */
export function computeNextCursor(events: ReplayEvent[]): string | null {
  if (events.length === 0) return null;
  return events[events.length - 1]!.id;
}

/**
 * Parse a `Last-Event-ID` / `?after` cursor value into a bigint id, or `null`
 * if absent/invalid. Never throws — an unparseable cursor just means "no replay,
 * go live" rather than a 500 on a reconnect.
 */
export function parseCursorValue(v: string | null | undefined): bigint | null {
  if (v == null) return null;
  const s = v.trim();
  if (!/^\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}
