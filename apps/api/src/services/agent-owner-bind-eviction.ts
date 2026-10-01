/**
 * Owner-bind eviction with verify and quarantine (connect-sec round 4, Codex
 * round-2 BLOCK, 2026-10-01). Fully synchronous: no await anywhere in this file.
 *
 * WHY: an unowned-to-owned bind must remove every live in-memory session of the
 * agent from the unowned period. The bind UPDATE already rotated or burned the
 * row hash, so the REST gate (`validateLiveAgentSession`, present-and-mismatch)
 * refuses those bearers. Map-only readers do not run that gate: the simulation
 * tick (cognition client by body, ambient conversations), [ACTION:] dispatch,
 * the public roster, and route helpers that look a client up by agentId. The old
 * `fenceAndEvictOnOwnerBind` in `routes/agent-gateway.ts` caught an eviction
 * throw and continued to later awaits, so a stray could stay readable there.
 *
 * RULE (one call, before the caller's next await):
 *   1. Two eviction passes. A throw on one session never skips the others; the
 *      second pass retries what the first left. `unregisterAgentBot` removes the
 *      session from the Map before any hook runs, so a throw cannot leave it.
 *   2. VERIFY: enumerate again. A session other than the keeper that is still in
 *      the Map is a stray.
 *   3. QUARANTINE (`agent-owner-fence.ts`) when a stray is left, when the verify
 *      enumeration threw, or when any enumeration threw. An eviction call that
 *      threw but whose session the verify proves gone is not a failure (the Map
 *      is proven clean). Every Map-only reader then skips the agent until the
 *      next registration of the agent evicts the rest, verifies, and releases it.
 *
 * Never logs a session id, bearer or digest. The agentId is a public handle.
 */

import { markAgentOwnedNow, quarantineAgent } from './agent-owner-fence';
import { npcSimulation } from './npc-simulation';

export interface OwnerBindEvictionResult {
  /** Sessions this call removed from the Map. */
  evicted: number;
  /** Non-keeper sessions still in the Map after both passes; -1 when the verify threw. */
  strays: number;
  /** TRUE when a session enumeration threw (pass or verify). */
  enumerationFailed: boolean;
  /** TRUE when this call quarantined the agent. */
  quarantined: boolean;
}

/**
 * Evict every live session of `agentId` except a keeper, verify, and quarantine
 * the agent when the result is not proven clean. Never throws.
 */
export function evictAgentSessionsOrQuarantine(
  agentId: string,
  options: { keep?: (sessionId: string) => boolean; source: string },
): OwnerBindEvictionResult {
  const { source } = options;
  const keep = options.keep;
  // A keeper check that throws counts as "not the keeper": that session is
  // evicted (fail closed).
  const isKeeper = (sessionId: string): boolean => {
    if (!keep) return false;
    try {
      return keep(sessionId);
    } catch {
      return false;
    }
  };

  let evicted = 0;
  let enumerationFailed = false;
  for (let pass = 1; pass <= 2; pass++) {
    let sessionIds: string[];
    try {
      sessionIds = npcSimulation.findActiveSessionsByAgentIds([agentId]);
    } catch (err) {
      enumerationFailed = true;
      console.error(`[OwnerBindEviction] ${source}: session enumeration pass ${pass} threw for agentId=${agentId}:`, err);
      continue;
    }
    for (const sessionId of sessionIds) {
      if (isKeeper(sessionId)) continue;
      try {
        if (npcSimulation.unregisterAgentBot(sessionId)) evicted++;
      } catch (err) {
        console.error(`[OwnerBindEviction] ${source}: eviction pass ${pass} threw for agentId=${agentId}:`, err);
      }
    }
  }

  let strays = -1;
  try {
    strays = npcSimulation.findActiveSessionsByAgentIds([agentId]).filter((sessionId) => !isKeeper(sessionId)).length;
  } catch (err) {
    enumerationFailed = true;
    console.error(`[OwnerBindEviction] ${source}: verify enumeration threw for agentId=${agentId}:`, err);
  }

  const quarantined = strays !== 0 || enumerationFailed;
  if (quarantined) {
    quarantineAgent(agentId);
    console.error(
      `[OwnerBindEviction] SECURITY: ${source}: eviction not proven complete for agentId=${agentId} (strays=${strays}, enumerationFailed=${enumerationFailed}); agent quarantined until a new session registers`,
    );
  }
  return { evicted, strays, enumerationFailed, quarantined };
}

/**
 * Unowned -> owned bind on `/connect` and the hosted mint (connect-sec round 4,
 * Codex C1 and round-2 BLOCK). Marks the owner fence, then evicts every live
 * in-memory session of the agent, verifies, and quarantines the agent when the
 * eviction is not proven complete. Fully synchronous and never throws: the
 * caller runs it right after its bind UPDATE returns and before any other await.
 */
export function fenceAndEvictOnOwnerBind(agentId: string): void {
  markAgentOwnedNow(agentId);
  evictAgentSessionsOrQuarantine(agentId, { source: 'owner-bind' });
}
