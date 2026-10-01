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
 *   - Incomplete eviction (round 4, Codex r3 C3 and round-2 BLOCK): eviction
 *     runs two passes and a throw on one session never skips the rest
 *     (`agent-owner-bind-eviction.ts`). If a stray is still live after both, or
 *     a session enumeration threw (the keeper lookup included), the agent is
 *     QUARANTINED synchronously: every Map-only reader (cognition client,
 *     [ACTION:] dispatch, session config, roster, SSE) skips it until a new
 *     session registers. Then the bind burns the row hash, ends the TTL (the
 *     owner stays) and throws `RedemptionEvictionIncompleteError` instead of
 *     returning success; a throw of that burn UPDATE still ends in the same
 *     error (`rowBurned: false`) with the quarantine in place. Every bearer path
 *     also checks the row hash at use time (`validateLiveAgentSession`, present
 *     && mismatch), so a stray left in the Map cannot act on REST.
 *   - Re-affirm (row already owned by the redeemer): unchanged behavior, no
 *     hash change, no eviction.
 *   - Skipped: no row, or a DIFFERENT owner, which is never clobbered.
 *
 * Never logs the ticket, a bearer or a digest. The agentId is a public handle.
 */

import { randomBytes } from 'crypto';
import { db, agentBots, and, eq, isNull, sql } from '@clawville/database';
import { markAgentOwnedNow, quarantineAgent } from './agent-owner-fence';
import { evictAgentSessionsOrQuarantine } from './agent-owner-bind-eviction';
import { npcSimulation } from './npc-simulation';
import { sessionDigest, sha256Hex } from './session-digest';

export type RedemptionBindOutcome = 'first-bind' | 'reaffirm' | 'skipped';

/**
 * A first bind could not prove that every stray live session left the Map (an
 * eviction call threw on both passes, or a session enumeration threw). Before
 * this is thrown the agent was quarantined for every Map-only reader and,
 * when `rowBurned` is true, the row hash was burned and the TTL ended, so no
 * bearer for the agent can act. `rowBurned` is false only when the burn UPDATE
 * itself threw; the quarantine still holds. The owner bind stays. The agent
 * must reconnect with owner proof. `remainingSessions` is -1 when the verify
 * could not count. Carries no ticket, bearer or digest.
 */
export class RedemptionEvictionIncompleteError extends Error {
  constructor(readonly agentId: string, readonly remainingSessions: number, readonly rowBurned: boolean = true) {
    super(
      `redemption bind for agentId=${agentId} left ${remainingSessions < 0 ? 'an unknown number of' : remainingSessions} stray live session(s); agent quarantined; row hash ${rowBurned ? 'burned' : 'NOT burned (burn UPDATE failed)'}`,
    );
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
    // fail-closed branch below awaits, and it quarantines BEFORE that await.
    markAgentOwnedNow(agentId);
    const rowHash = firstBind[0].sessionKeyHash;
    const keptKeeper =
      issuedSessionDigest !== null
      && typeof rowHash === 'string'
      && rowHash.startsWith(issuedSessionDigest);
    // A burned hash kills every bearer, so nothing is kept.
    const isKeeper = (sid: string) => keptKeeper && sessionDigest(sid) === issuedSessionDigest;
    // Keeper lookup (Codex round-2 BLOCK): an enumeration throw here used to
    // escape before any eviction, and `/enter` logged it and went on with the
    // strays still in the Map. Now it fails closed like an incomplete eviction.
    let keeperSid: string | null = null;
    let bodyId: string | null = null;
    let bodyBefore: ReturnType<typeof npcSimulation.getNpcById> = null;
    let keeperLookupFailed = false;
    try {
      keeperSid = keptKeeper
        ? npcSimulation.findActiveSessionsByAgentIds([agentId]).find(isKeeper) ?? null
        : null;
      bodyId = keeperSid ? npcSimulation.getNpcIdForSession(keeperSid) : null;
      bodyBefore = bodyId ? npcSimulation.getNpcById(bodyId) : null;
    } catch (err) {
      keeperLookupFailed = true;
      console.error(`[AgentRedemptionBind] keeper lookup threw for agentId=${agentId}:`, err);
    }
    // Two passes, a throw on one session never skips the others, then a verify.
    // A stray left or an enumeration throw quarantines the agent for every
    // Map-only reader (`agent-owner-bind-eviction.ts`), synchronously.
    const eviction = evictAgentSessionsOrQuarantine(agentId, { keep: isKeeper, source: 'redemption-bind' });
    if (keeperLookupFailed && !eviction.quarantined) quarantineAgent(agentId);
    if (keeperLookupFailed || eviction.quarantined) {
      // FAIL CLOSED (Codex r3 C3, round-2 BLOCK): the eviction is not proven
      // complete after the ownership change. The agent is already quarantined
      // (no await since). Burn the row hash and end the TTL, so no bearer (the
      // keeper included) passes `validateLiveAgentSession` or restores. The
      // owner stays: the row is never left bound to nobody. The guard on the
      // hash this bind wrote keeps a newer rotation (whose hash already fails
      // every stray) untouched. No owner stamp, no success outcome. A throw of
      // the burn UPDATE itself still ends here: the quarantine holds and the
      // caller gets the same error with `rowBurned: false`.
      let rowBurned = false;
      try {
        const burned = await db
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
          ))
          .returning({ id: agentBots.id });
        // Zero rows = a concurrent rotation already replaced the hash this bind
        // wrote (that newer hash fails every stray); do not log a burn that did
        // not happen (Codex r3 should-fix).
        rowBurned = burned.length > 0;
      } catch (err) {
        console.error(`[AgentRedemptionBind] SECURITY: hash-burn UPDATE threw for agentId=${agentId}; agent stays quarantined:`, err);
      }
      throw new RedemptionEvictionIncompleteError(agentId, eviction.strays, rowBurned);
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
      `[AgentRedemptionBind] first bind for agentId=${agentId}; issuing session ${keptKeeper ? 'kept' : 'not kept'}; evicted ${eviction.evicted} live session(s)`,
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
