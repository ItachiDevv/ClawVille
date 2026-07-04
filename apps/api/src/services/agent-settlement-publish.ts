/**
 * Live cove-settlement delivery onto the agent SSE stream (P3 slice 1, D7).
 *
 * DELIVERY-ONLY. The durable `events` row (the source of truth + replay basis)
 * is written by the settle site's own `logEventFromContextReturningId`; this
 * helper only fans a LIVE frame out to the agent's active SSE session(s) so an
 * ONLINE agent gets an immediate settlement-confirm. It is fully isolated:
 *   - fire-and-forget, awaits nothing on the settle path;
 *   - NEVER touches money/control flow;
 *   - a bus/lookup failure can never surface (the settle path already returned).
 * An OFFLINE agent simply catches up later via the replay endpoint / SSE
 * `Last-Event-ID` — the durable row is what makes that lossless.
 *
 * Lives here (not in `skill-event-bus.ts`, which stays dependency-free) so the
 * bus has no `npc-simulation` import; the session lookup is confined to this
 * module.
 */
import { npcSimulation } from './npc-simulation';
import { publishAgentStreamEvent } from './skill-event-bus';

export type CoveGame = 'blackjack' | 'baccarat' | 'holdem' | 'slots';

export interface CoveSettlementPublish {
  /** Canonical agentId (the leaderboard/grouping handle, NEVER a raw bearer). */
  agentId: string;
  game: CoveGame;
  /**
   * The pending durable-write promise from `logEventFromContextReturningId`.
   * Resolves to the `events.id` (or null if the durable write failed / was
   * coalesced) — used as the SSE `id:` cursor. We never block on it.
   */
  eventIdPromise: Promise<bigint | null>;
  /** Bearer-free settlement facts (handId/bet/payout/net …). NEVER a session id. */
  payload: Record<string, unknown>;
}

/**
 * Publish a live `settlement` frame to every active SSE session of `agentId`.
 * No-op (best-effort) when the durable write failed (no id to cite) or the agent
 * is currently offline (no active session) — it replays the durable row instead.
 */
export function publishCoveSettlement(args: CoveSettlementPublish): void {
  void args.eventIdPromise
    .then((eventId) => {
      if (eventId == null) return; // durable write failed/coalesced — nothing to cite live
      const sessionIds = npcSimulation.findActiveSessionsByAgentIds([args.agentId]);
      if (sessionIds.length === 0) return; // agent offline — catches up via replay
      for (const sid of sessionIds) {
        publishAgentStreamEvent(sid, {
          type: 'stream',
          channel: 'settlement',
          eventId: eventId.toString(),
          data: { game: args.game, ...args.payload },
          emittedAt: new Date().toISOString(),
        });
      }
    })
    .catch(() => {
      /* delivery-only — a failure here must NEVER affect settlement */
    });
}
