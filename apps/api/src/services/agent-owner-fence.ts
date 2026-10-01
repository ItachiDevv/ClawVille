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
 * RULE: every owner bind marks the agentId synchronously, before its eviction
 * loop. A credentialless connect checks the mark right before it registers its
 * body, with no await in between, and refuses with
 * `409 owner_credential_required`. A late session then either registered
 * before the eviction (and was evicted) or sees the mark (and is refused).
 *
 * SCOPE: this Map is per process. That holds under the single-API-replica
 * invariant; the DB CAS stays the cross-process enforcement. The mark expires
 * after RECENT_OWNER_BIND_MS, far longer than any one connect request.
 */

const RECENT_OWNER_BIND_MS = 5 * 60_000;

/** agentId -> expiry (epoch ms) of its recent-owner-bind mark. */
const recentOwnerBinds = new Map<string, number>();

/** Mark `agentId` as bound to an owner now. Prunes expired marks. */
export function markAgentOwnedNow(agentId: string, now = Date.now()): void {
  for (const [id, expiresAt] of recentOwnerBinds) {
    if (expiresAt <= now) recentOwnerBinds.delete(id);
  }
  recentOwnerBinds.set(agentId, now + RECENT_OWNER_BIND_MS);
}

/** TRUE while `agentId` carries an unexpired recent-owner-bind mark. */
export function agentOwnedRecently(agentId: string, now = Date.now()): boolean {
  const expiresAt = recentOwnerBinds.get(agentId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    recentOwnerBinds.delete(agentId);
    return false;
  }
  return true;
}

/** Test seam: clear every mark. Never called by runtime code. */
export function __resetAgentOwnerFenceForTests(): void {
  recentOwnerBinds.clear();
}
