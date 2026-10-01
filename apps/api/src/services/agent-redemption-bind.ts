/**
 * Bind-at-redemption (security 2026-09-30): the agent-row half of
 * `GET /api/auth/enter` (magic-link onboarding D1), moved out of `routes/auth.ts`.
 *
 * WHY: the old inline bind ran one guarded UPDATE (`user_id IS NULL OR
 * user_id = <redeemer>`), evicted nothing, and `bindAgentOwner` stamped the
 * redeemer on EVERY live session for the agent. A session that displaced the
 * agent while the row was unbound then resolved as the owner on non-ledger
 * routes (`resolveAgentSession` then returned the ROW owner for any live
 * session). Since connect-sec round 4 (C10) it returns the owner only to a
 * session whose `boundUserId` equals the row's current `userId`; the agent
 * wallet read and world presence apply the same check (C12).
 * Map eviction alone is not enough: `agent-session-restore.ts` rebuilds a
 * session from the row by `session_key_hash = sha256Hex(bearer)`, so a stray
 * whose hash is still on the row would restore itself.
 *
 * RULE:
 *   - First bind (row unowned): one UPDATE sets `user_id` to the redeemer. It
 *     keeps `session_key_hash` and `session_expires_at` only when the row still
 *     names the session the ticket was issued to (its 16-hex digest prefix
 *     matches). Else it writes a burned hash that no bearer maps to and ends
 *     the TTL now, so status surfaces stop calling the row connected. It never
 *     writes a session's hash: a keeper still in the Map whose hash a later
 *     connect rotated away stays dead (the rotation-stale rule). Only the
 *     session the row names AND the ticket names survives. Never NULL: a NULL
 *     hash is the not-yet-persisted state the liveness gate lets through
 *     (present && mismatch rule). Then, with no await in between, it marks the
 *     agent in the owner fence (`agent-owner-fence.ts`), evicts every live
 *     session except a kept keeper (every session when the hash was burned),
 *     and stamps the owner on what is left.
 *   - Incomplete eviction (round 4, Codex r3 C3): eviction runs two passes and
 *     a throw on one session never skips the rest. If a stray is still live
 *     after both, the bind burns the row hash, ends the TTL (the owner stays)
 *     and throws `RedemptionEvictionIncompleteError` instead of returning
 *     success. Every bearer path also checks the row hash at use time
 *     (`validateLiveAgentSession`, present && mismatch), so a stray left in the
 *     Map cannot act; the burn makes the failure visible and kills the keeper too.
 *   - Re-affirm (row already owned by the redeemer): unchanged behavior, no
 *     hash change, no eviction.
 *   - Skipped: no row, or a DIFFERENT owner, which is never clobbered.
 *
 * Never logs the ticket, a bearer or a digest. The agentId is a public handle.
 */

import { randomBytes } from 'crypto';
import { db, agentBots, and, eq, isNull, sql } from '@clawville/database';
import { markAgentOwnedNow } from './agent-owner-fence';
import { npcSimulation } from './npc-simulation';
import { sessionDigest, sha256Hex } from './session-digest';

export type RedemptionBindOutcome = 'first-bind' | 'reaffirm' | 'skipped';

/**
 * A first bind could not evict every stray live session (an eviction call
 * threw on both passes). Before this is thrown the row hash was burned and the
 * TTL ended, so no bearer for the agent can act; the owner bind stays. The
 * agent must reconnect with owner proof. Carries no ticket, bearer or digest.
 */
export class RedemptionEvictionIncompleteError extends Error {
  constructor(readonly agentId: string, readonly remainingSessions: number) {
    super(`redemption bind for agentId=${agentId} left ${remainingSessions} stray live session(s); row hash burned`);
    this.name = 'RedemptionEvictionIncompleteError';
  }
}

export async function bindAgentOwnerAtRedemption(input: {
  agentId: string;
  redeemerUserId: string;
  /** The ticket's stored 16-hex `sessionDigest` of its minting session, or null. */
  issuedSessionDigest: string | null;
}): Promise<RedemptionBindOutcome> {
  const { agentId, redeemerUserId, issuedSessionDigest } = input;

  // Every CASE reads the OLD row, so both columns follow one decision.
  const burnedHash = sha256Hex(`revoked:${randomBytes(32).toString('base64url')}`);
  const rowNamesIssuedSession = issuedSessionDigest
    ? sql`left(${agentBots.sessionKeyHash}, 16) = ${issuedSessionDigest}`
    : null;
  const sessionKeyHash = rowNamesIssuedSession
    ? sql`CASE WHEN ${rowNamesIssuedSession} THEN ${agentBots.sessionKeyHash} ELSE ${burnedHash} END`
    : burnedHash;
  // The column is `timestamp` (no time zone) and the app stores UTC wall time.
  const sessionExpiresAt = rowNamesIssuedSession
    ? sql`CASE WHEN ${rowNamesIssuedSession} THEN ${agentBots.sessionExpiresAt} ELSE (now() AT TIME ZONE 'UTC') END`
    : sql`(now() AT TIME ZONE 'UTC')`;

  const firstBind = await db
    .update(agentBots)
    .set({ userId: redeemerUserId, sessionKeyHash, sessionExpiresAt, updatedAt: new Date() })
    .where(and(eq(agentBots.agentId, agentId), isNull(agentBots.userId)))
    .returning({ id: agentBots.id, sessionKeyHash: agentBots.sessionKeyHash });

  if (firstBind.length > 0) {
    // Synchronous from here to the owner stamp: no connect can register
    // between the fence mark, the eviction scan and the stamp. Only the
    // fail-closed branch below awaits, and it never stamps.
    markAgentOwnedNow(agentId);
    const rowHash = firstBind[0].sessionKeyHash;
    const keptKeeper =
      issuedSessionDigest !== null
      && typeof rowHash === 'string'
      && rowHash.startsWith(issuedSessionDigest);
    // A burned hash kills every bearer, so nothing is kept.
    const isKeeper = (sid: string) => keptKeeper && sessionDigest(sid) === issuedSessionDigest;
    const keeperSid = keptKeeper
      ? npcSimulation.findActiveSessionsByAgentIds([agentId]).find(isKeeper) ?? null
      : null;
    const bodyId = keeperSid ? npcSimulation.getNpcIdForSession(keeperSid) : null;
    const bodyBefore = bodyId ? npcSimulation.getNpcById(bodyId) : null;
    // Two passes, and a throw on one session never skips the others: the
    // second pass retries what the first left behind.
    let evicted = 0;
    for (let pass = 1; pass <= 2; pass++) {
      for (const sid of npcSimulation.findActiveSessionsByAgentIds([agentId])) {
        if (isKeeper(sid)) continue;
        try {
          if (npcSimulation.unregisterAgentBot(sid)) evicted++;
        } catch (err) {
          console.error(`[AgentRedemptionBind] eviction pass ${pass} threw for agentId=${agentId}:`, err);
        }
      }
    }
    const strays = npcSimulation.findActiveSessionsByAgentIds([agentId]).filter((sid) => !isKeeper(sid)).length;
    if (strays > 0) {
      // FAIL CLOSED (Codex r3 C3): a stray is still in the Map after the
      // ownership change. Burn the row hash and end the TTL, so no bearer
      // (the keeper included) passes `validateLiveAgentSession` or restores.
      // The owner stays: the row is never left bound to nobody. The guard on
      // the hash this bind wrote keeps a newer rotation (whose hash already
      // fails every stray) untouched. No owner stamp, no success outcome.
      await db
        .update(agentBots)
        .set({
          sessionKeyHash: sha256Hex(`revoked:${randomBytes(32).toString('base64url')}`),
          sessionExpiresAt: sql`(now() AT TIME ZONE 'UTC')`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(agentBots.agentId, agentId),
          eq(agentBots.userId, redeemerUserId),
          rowHash === null ? isNull(agentBots.sessionKeyHash) : eq(agentBots.sessionKeyHash, rowHash),
        ));
      throw new RedemptionEvictionIncompleteError(agentId, strays);
    }
    npcSimulation.bindAgentOwner(agentId, redeemerUserId);
    // An avatar body is shared per agentId. A stray that owned it took it
    // down on eviction, so respawn it for the keeper at the same position.
    if (keeperSid && bodyId && bodyBefore && !npcSimulation.getNpcById(bodyId)) {
      const config = npcSimulation.getAgentBotConfig(keeperSid);
      const client = npcSimulation.getAgentBotClientBySession(keeperSid);
      if (config && client) {
        try {
          npcSimulation.registerAgentBot(config, client, { lastX: bodyBefore.x, lastY: bodyBefore.y });
        } catch (err) {
          console.error(`[AgentRedemptionBind] keeper body respawn failed for agentId=${agentId} (non-fatal):`, err);
        }
      }
    }
    console.log(
      `[AgentRedemptionBind] first bind for agentId=${agentId}; issuing session ${keptKeeper ? 'kept' : 'not kept'}; evicted ${evicted} live session(s)`,
    );
    return 'first-bind';
  }

  const reaffirmed = await db
    .update(agentBots)
    .set({ updatedAt: new Date() })
    .where(and(eq(agentBots.agentId, agentId), eq(agentBots.userId, redeemerUserId)))
    .returning({ id: agentBots.id });
  if (reaffirmed.length > 0) {
    npcSimulation.bindAgentOwner(agentId, redeemerUserId);
    return 'reaffirm';
  }
  return 'skipped';
}
