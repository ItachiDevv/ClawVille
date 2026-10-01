/**
 * In-process owner fence for the credentialless connect race (security
 * 2026-09-30, round 2b). Dependency-free.
 *
 * WHY: a credentialless connect (`POST /api/agent/connect` with no owned token
 * and no resolved identityKey, or the legacy `POST /api/openclaw/register`)
 * writes the row under a `user_id IS NULL` CAS. That write can commit while the
 * row is still unowned, and the route can see its UPDATE response AFTER an
 * owner bind (a magic-link first bind at `GET /api/auth/enter`, or an owned
 * token / identityKey bind on `/connect`) already evicted the agent's live
 * sessions. Continuation order across pool connections is not guaranteed. The
 * owner bind's hash write kills that late session's REST use (the
 * present-and-mismatch gate), but Map-only readers (the cognition client
 * lookup by body, the active roster) would still use it.
 *
 * RULE: every unowned-to-owned bind marks the agentId synchronously, before its
 * eviction loop. A credentialless request takes `ownerBindSnapshot()` BEFORE it
 * reads or writes the row, and checks `agentOwnerBoundSince(agentId, snapshot)`
 * right before it registers its body, with no await in between. A late session
 * then either registered before the eviction (and was evicted) or sees the
 * mark (and is refused with `409 owner_credential_required`).
 *
 * NO EXPIRY (connect-sec round 4, 2026-10-01): the check compares a bind
 * sequence number, not a clock. A request that stalls for any length of time
 * between its row write and its registration is still refused. A bind that
 * landed BEFORE the request started never refuses it (that request reads the
 * owned row, or the row was unbound again later and the anonymous model holds).
 *
 * MEMORY: `lastOwnerBindSeq` keeps one entry per agentId bound in this process.
 * Its size is bounded by the `openclaw_bots` row count, not by time.
 *
 * SCOPE: this state is per process. That holds under the single-API-replica
 * invariant; the DB CAS stays the cross-process enforcement.
 *
 * CALLERS (round 4): `POST /api/agent/connect`, the legacy
 * `POST /api/openclaw/register` and session restore all use the snapshot
 * check. The five-minute clock reader (`agentOwnedRecently`) is deleted.
 */

/** Monotonic count of owner-bind marks in this process. Never reset. */
let ownerBindSeq = 0;

/** agentId -> the `ownerBindSeq` value of its latest owner-bind mark. */
const lastOwnerBindSeq = new Map<string, number>();

/**
 * Mark `agentId` as bound to an owner now. `_now` is ignored: the fence keeps
 * no clock. Tests pass a stale time to prove that a mark never expires.
 */
export function markAgentOwnedNow(agentId: string, _now?: number): void {
  ownerBindSeq += 1;
  lastOwnerBindSeq.set(agentId, ownerBindSeq);
}

/**
 * Take this BEFORE the request reads or writes the agent row. Pass the value
 * to `agentOwnerBoundSince` right before body registration.
 */
export function ownerBindSnapshot(): number {
  return ownerBindSeq;
}

/** TRUE when an owner bind of `agentId` was marked after `snapshot` was taken. */
export function agentOwnerBoundSince(agentId: string, snapshot: number): boolean {
  return (lastOwnerBindSeq.get(agentId) ?? 0) > snapshot;
}

/**
 * QUARANTINE (connect-sec round 4, Codex round-2 BLOCK, 2026-10-01).
 *
 * WHY: an owner bind evicts the agent's live in-memory sessions. When that
 * eviction cannot be proven complete (a stray session is still in the session
 * Map after both passes, or a session enumeration threw), the stray could still
 * drive the owner's body or receive cognition through a Map-only reader (a path
 * that reads the Map without `validateLiveAgentSession`).
 *
 * RULE: the eviction (`agent-owner-bind-eviction.ts`) quarantines the agentId
 * synchronously, before its caller's next await. Every Map-only reader in
 * `npc-simulation.ts` skips a quarantined agent: no cognition client (by body or
 * by session), no [ACTION:] dispatch, no ambient conversation, no public roster
 * entry. Validated paths (REST and the agent SSE loop run
 * `validateLiveAgentSession` every call or tick) already refuse a stray bearer by
 * its row hash and unregister it, so the session config stays readable for them.
 * The next `registerAgentBot` for the agent (after an owner bind, the fence and
 * the owned-row check let only an owner-proven session register: connect proof,
 * the /enter keeper, signed /reconnect, Hatcher register or patch, hosted, or a
 * restore of the hash the bind wrote) evicts every other session of the agent,
 * verifies that none is left, and only then releases the quarantine.
 *
 * SCOPE: per process, like the fence (single-API-replica invariant). The set
 * holds at most one entry per agentId; a release removes it.
 */
const quarantinedAgents = new Set<string>();

/** Quarantine `agentId` for every Map-only reader. Pure Set write, never throws. */
export function quarantineAgent(agentId: string): void {
  quarantinedAgents.add(agentId);
}

/** TRUE while `agentId` is quarantined. */
export function isAgentQuarantined(agentId: string): boolean {
  return quarantinedAgents.has(agentId);
}

/**
 * Release the quarantine. Only `npcSimulation.registerAgentBot` calls this,
 * after it verified that no other session of the agent is left in the Map.
 * Returns TRUE when the agent was quarantined.
 */
export function releaseAgentQuarantine(agentId: string): boolean {
  return quarantinedAgents.delete(agentId);
}

/**
 * Test seam: clear every mark and every quarantine. Never called by runtime
 * code. The sequence itself stays monotonic, so an earlier snapshot never
 * matches a later mark by accident.
 */
export function __resetAgentOwnerFenceForTests(): void {
  lastOwnerBindSeq.clear();
  quarantinedAgents.clear();
}
