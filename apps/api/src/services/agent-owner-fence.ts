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
 * Test seam: clear every mark. Never called by runtime code. The sequence
 * itself stays monotonic, so an earlier snapshot never matches a later mark
 * by accident.
 */
export function __resetAgentOwnerFenceForTests(): void {
  lastOwnerBindSeq.clear();
}
