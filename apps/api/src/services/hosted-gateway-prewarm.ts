/**
 * Fire-and-forget COLD-START PRE-WARM for ClawVille-hosted local runtimes
 * (gate-doc §B.7, 2026-07-08).
 *
 * THE PROBLEM: a hosted hermes/openclaw agent's FIRST-EVER turn through the local
 * gateway pays a cold-start cost that can exceed the sim's per-turn chat leash
 * (openclaw cold session ≈42s vs the 30s-capped `OPENCLAW_LOCAL_TIMEOUT_MS`;
 * hermes cold ~5-7s, same shape) — so that first real turn fails soft to '' once
 * before cognition flows. This module kicks ONE trivial warm-up completion at the
 * moment the agent connects/registers, OFF the user-facing path, with a generous
 * leash, so the model (and for openclaw the pinned gateway session) is warm before
 * the first real turn.
 *
 * WHAT THIS IS NOT: the warm-up is not a chat turn — `AgentSubstrateClient.
 * prewarmLocalGateway` discards the reply, so it credits no CT, emits no
 * leaderboard/event row, and surfaces nowhere. It never blocks or throws into the
 * caller (detached promise, swallowed rejection).
 *
 * TRIGGER PREDICATE (`isPrewarmableProtocol`): ONLY the two server-hosted local
 * wire protocols. Because `resolveInWorldProtocol` yields 'hermes-local' /
 * 'openclaw-local' ONLY when the respective `*_LOCAL_GATEWAY_ENABLED` gate is on
 * (and, for openclaw, ONLY for a GATEWAY-LESS connect), the protocol value ALONE
 * already encodes "gate on AND hosted-local AND not-BYO" — so a BYO/declared-
 * gateway agent (protocol 'openai-compat' / 'anthropic' / 'custom-webhook') and a
 * gate-off agent (protocol 'nanoclaw' or its declared protocol) are never
 * pre-warmed. Reading the protocol (not re-reading env) makes the predicate
 * drift-proof against the gate constants living in agent-session-config.ts.
 *
 * SAFETY BOUNDS:
 *   - IDEMPOTENT per agentId per PROCESS lifetime (`warmedAgents` Set, bounded) so
 *     reconnect storms + connect-then-reconnect for the same agent warm at most
 *     once.
 *   - CONCURRENCY-BOUNDED (`MAX_CONCURRENT_PREWARMS`) via a small FIFO queue so a
 *     burst of connects can't stampede the single-GPU sidecar; the queue itself is
 *     capped (`MAX_QUEUE`) so nothing grows unbounded under load.
 */

import type { AgentSubstrateClient } from './agent-substrate-client';

/**
 * Generous cold-start leash for a single warm-up POST (ms). Sized ABOVE the
 * measured openclaw cold session (~42s) and deliberately longer than the sim's
 * own chat leash (`*_LOCAL_TIMEOUT_MS`, capped 30s) — the too-short chat leash is
 * exactly the fail-soft this warm-up gets ahead of. Off the user-facing path, so
 * a long leash costs nothing but a detached socket.
 */
const PREWARM_TIMEOUT_MS = 60_000;

/**
 * Max warm-ups in flight at once. A burst of new-hosted-agent connects must not
 * stampede the shared single-GPU local runtime, so extra requests queue (2 at a
 * time) rather than fire concurrently.
 */
const MAX_CONCURRENT_PREWARMS = 2;

/**
 * Cap on the waiting FIFO queue. Under extreme connect load we DROP the excess
 * (the dropped agent simply takes its one pre-existing cold first turn — no
 * regression) rather than let the queue grow without bound.
 */
const MAX_QUEUE = 64;

/**
 * Cap on the idempotency Set. A process that outlives 10k distinct hosted agents
 * clears the ledger (a re-warm for a long-since-connected agent is harmless), so
 * the Set can never leak.
 */
const MAX_TRACKED_AGENTS = 10_000;

/** agentIds warmed (or reserved for warming) this process — idempotency ledger. */
const warmedAgents = new Set<string>();

interface PendingWarm {
  agentId: string;
  client: AgentSubstrateClient;
}

const pending: PendingWarm[] = [];
let inFlight = 0;

/**
 * TRUE iff a body speaking `protocol` should be pre-warmed — the two
 * server-hosted LOCAL runtimes only. Exported for unit testing the trigger
 * predicate. FAIL-CLOSED: unknown / undefined / '' → false.
 */
export function isPrewarmableProtocol(protocol?: string | null): boolean {
  return protocol === 'hermes-local' || protocol === 'openclaw-local';
}

/** Drain the queue up to the concurrency ceiling. Re-entrant-safe (async). */
function pump(): void {
  while (inFlight < MAX_CONCURRENT_PREWARMS && pending.length > 0) {
    const next = pending.shift();
    if (!next) break;
    inFlight++;
    // Detached: prewarmLocalGateway never throws (it swallows + logs), but the
    // extra .catch is belt-and-suspenders so a future refactor can't leak a
    // rejection into the process. finally releases the slot + pumps the next.
    void next.client
      .prewarmLocalGateway(PREWARM_TIMEOUT_MS)
      .catch(() => {})
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

/**
 * Kick a fire-and-forget cold-start pre-warm for a freshly-registered hosted
 * agent, IFF its in-world protocol is a server-hosted local runtime. No-op for
 * every other protocol, for an already-warmed agent, and (drop) when the queue is
 * saturated. NEVER blocks or throws — returns immediately after enqueueing.
 *
 * @param agentId the agent's stable id (idempotency key).
 * @param client  the just-constructed substrate client for the session; its
 *                `getProtocol()` is the authoritative trigger signal.
 */
export function maybePrewarmHostedGateway(agentId: string, client: AgentSubstrateClient): void {
  if (!isPrewarmableProtocol(client.getProtocol())) return;
  if (warmedAgents.has(agentId)) return; // idempotent per process

  // Reserve BEFORE enqueue so concurrent duplicate connects (or a reconnect that
  // races a connect) for the same agent can't double-enqueue.
  if (warmedAgents.size >= MAX_TRACKED_AGENTS) warmedAgents.clear();
  warmedAgents.add(agentId);

  if (pending.length >= MAX_QUEUE) {
    // Saturated — drop this warm-up (best-effort; the agent takes its one cold
    // first turn, the pre-existing behavior). Still marked, so we don't spin.
    console.log(
      `[Prewarm] queue saturated (${pending.length}) — skipping warm-up for agent ${agentId}`,
    );
    return;
  }

  pending.push({ agentId, client });
  pump();
}

/**
 * TEST-ONLY reset of module state. Never called in production.
 */
export function __resetPrewarmStateForTests(): void {
  warmedAgents.clear();
  pending.length = 0;
  inFlight = 0;
}
