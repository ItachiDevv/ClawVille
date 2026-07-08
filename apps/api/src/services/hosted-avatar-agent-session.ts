/**
 * Hosted avatar-agent internal session — orchestration (§B.2, 2026-07-08).
 *
 * Mints (and self-heals) an INTERNAL agent bearer session for a signup user's
 * HOSTED avatar-agent so it can use the `/api/agent/:sessionId` tool surface
 * (tools.json, events replay, Cove/Poker agent API) as a first-class LEDGER
 * subject — the connected-agent parity a BYO/Hatcher agent already has. The bearer
 * is held SERVER-SIDE and NEVER emitted to the browser: the human plays the
 * human-path via Controlled mode; this session is the AGENT-path credential that
 * server-side consumers (the §B.1 autonomy driver, the future §6 cognition
 * adapter) present to the tool surface on the agent's behalf.
 *
 * The decision + assembly logic is the DB-free `hosted-avatar-agent-session-plan`
 * module (unit-tested there); this file owns the DB upsert, the npc-simulation
 * body registration, the in-memory bearer registry, and the dual lock.
 *
 * ── SECURITY / MONEY INVARIANTS (each maps to a paid-for prior bug) ────────────
 *  - TRAP 4 (ledger binding): the config carries ledgerCapable=true +
 *    boundUserId=OWNER, and the row's `userId` = the SAME owner, so
 *    `resolveAgentSession` keeps it ledger-capable (and its rebind backstop still
 *    demotes it if the row is ever rebound to a different user).
 *  - TRAP 6/8 (per-subject serialization): the mint mutates BOTH the DB row AND
 *    the process-local sim Map → the WHOLE critical section runs under
 *    `withKeyedMutex(agentId)` (intra-process) wrapping ONE
 *    `pg_advisory_xact_lock(lockKey)` transaction (cross-process, re-read under the
 *    lock). Bearer hash committed in the SAME tx as the row (atomic). Body spawned
 *    AFTER commit, still inside the mutex (commit-first-spawn-after — a failed
 *    commit leaves NO body; a failed spawn leaves an honest body-less row a later
 *    ensure() heals).
 *  - TRAP 12 (bearer secrecy): only sha256Hex(bearer) is persisted; only
 *    sessionDigest(bearer) is logged; the raw bearer lives ONLY in this process's
 *    registry and is returned ONLY to in-process server callers.
 *  - RESTART RECOVERY = RE-MINT, not lazy-restore: the registry is wiped on
 *    restart, so the first consumer demand re-mints (fresh bearer/hash + slid TTL +
 *    register ledger-capable). Because the bearer is NEVER emitted, no external
 *    party holds a pre-restart bearer, so overwriting the row hash strands nothing.
 *    This deliberately sidesteps the restore path's NON-ledger demotion of
 *    no-gateway types WITHOUT weakening that contract (which protects every
 *    milady/nanoclaw/anonymous/hermes restore).
 *  - NO partner-wire change: identityType 'nanoclaw' already exists; the gate
 *    contract, shared types, and PROTOCOL_VERSION are untouched.
 *
 * ── TWO-BODY / TRAP 1 (the human + agent share ONE avatar) ─────────────────────
 *  The recommended TRIGGER (wired by §B.1) is Autonomous-mode activation, so the
 *  `ocb-` body only exists when the agent is actually driving itself — it is NOT
 *  minted on idle connect. This module is the pure PRIMITIVE; it does not decide
 *  WHEN it is called. The body is registered self-managed with the deterministic
 *  `ocb-<base64url(agentId)>` id so the existing human-control suppression
 *  (`isHumanControlledOpenClawNpc` / `isAgentHumanControlled`, keyed on agentId)
 *  and the body idle-despawn machinery apply to it unchanged. See the §B.1
 *  dependency note in the domain report: the Controlled-mode launch binding
 *  (`bindHumanControlledOpenClawLaunch(userId, agentId)`) must cover THIS agentId
 *  for the suppression to fire while the human drives — that binding is §B.1's job,
 *  not minted here.
 */

import { randomBytes, createHash } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { db, agentBots, avatars } from '@clawville/database';
import { npcSimulation } from './npc-simulation';
import { AgentSubstrateClient } from './agent-substrate-client';
import { sha256Hex, sessionDigest } from './session-digest';
import { computeSessionExpiresAt, extendSessionTtl } from './agent-session-sweeper';
import { withKeyedMutex } from './keyed-mutex';
import { isReservedPartnerIdentityType } from './reserved-agent-namespaces';
import { DEFAULT_AGENT_MODEL_KEY } from '@clawville/shared';
import {
  hostedAvatarAgentId,
  buildHostedAvatarAgentConfig,
  hostedAvatarBotRowValues,
  isHostedSessionReusable,
} from './hosted-avatar-agent-session-plan';

/**
 * The server-only registry of live hosted-avatar-agent bearers, keyed by
 * `platform_agents.id`. Process-local (wiped on restart → triggers re-mint) and
 * NEVER serialized to any wire. `bearer` is the raw session id; `agentId` is the
 * derived `openclaw_bots.agent_id`.
 */
const heldSessions = new Map<string, { bearer: string; agentId: string }>();

export interface HostedAvatarSession {
  /** The raw bearer — the `X-Clawville-Agent-Session` value. Server-side only. */
  bearer: string;
  /** The `openclaw_bots.agent_id` (== the platformAgentId). */
  agentId: string;
  /** The deterministic in-world body id (`ocb-<base64url(agentId)>`). */
  bodyId: string;
  /** true = an already-live session was reused; false = a fresh mint. */
  reused: boolean;
}

/** Thrown when a platformAgentId does not resolve to a live, non-guest avatar. */
export class HostedAvatarAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedAvatarAgentError';
  }
}

/** In-process mutex key — distinct string namespace from the partner path. */
function hostedAvatarMutexKey(agentId: string): string {
  return `hosted-avatar-agent:${agentId}`;
}

/**
 * Deterministic signed-63-bit Postgres advisory-lock key for the per-agent mint
 * critical section. Distinct string prefix (`hosted-avatar-agent:`) from the
 * Hatcher (`hatcher-agent:`) + daily-cap keys, so buckets never collide. Folded to
 * a signed bigint (pg advisory-lock keys are int8).
 */
function hostedAvatarLockKey(agentId: string): bigint {
  const digest = createHash('sha256').update(`hosted-avatar-agent:${agentId}`).digest();
  const u64 = digest.readBigUInt64BE(0);
  return u64 & 0x7fff_ffff_ffff_ffffn;
}

/** Mint a fresh opaque bearer. `oc-` prefix + 192 bits of base64url randomness —
 *  same shape/entropy as the house-agent + gateway mints. */
function mintBearer(): string {
  return `oc-${randomBytes(24).toString('base64url')}`;
}

/**
 * Ensure a LIVE, ledger-capable internal agent session exists for the hosted
 * avatar-agent identified by `platformAgentId`, minting or self-healing as needed,
 * and return the server-held bearer + body id. Idempotent: a concurrent second
 * call for the same agent serializes on the mutex and reuses the live session.
 *
 * Returns `null` when `platformAgentId` does not resolve to a live, non-guest
 * avatar (e.g. a guest, a not-yet-provisioned account, or a non-avatar-agent id) —
 * only a real owner-bound avatar-agent gets a real-CT session.
 */
export async function ensureHostedAvatarAgentSession(
  platformAgentId: string,
): Promise<HostedAvatarSession | null> {
  if (!platformAgentId) return null;

  // Resolve the owner + render identity from the avatar bound to this agent. Only
  // an avatar-agent has an `avatars.platformAgentId`, so this both validates the
  // id is an avatar-agent AND yields the owner/model/name in one read.
  const avatar = await db.query.avatars.findFirst({
    // Bind ONLY to the owner's ACTIVE avatar — the same avatar `resolveAgentSession`
    // settles against. Matching an inactive row would mint from its name/model while
    // settlement later lands on the active avatar (same owner, not a theft path, but
    // not strictly "the bound avatar"). Requiring isActive keeps the mint == the
    // settlement target.
    where: and(
      eq(avatars.platformAgentId, platformAgentId),
      eq(avatars.isActive, true),
    ),
    columns: {
      userId: true,
      name: true,
      modelKey: true,
      isGuest: true,
    },
  });
  if (!avatar || !avatar.userId) return null;
  // Guests are demo-only and NEVER hold a real-CT bearer (guest-demo isolation).
  if (avatar.isGuest) return null;

  const ownerUserId = avatar.userId;
  const modelKey = avatar.modelKey ?? DEFAULT_AGENT_MODEL_KEY;
  const name = avatar.name;
  const agentId = hostedAvatarAgentId(platformAgentId);

  return withKeyedMutex(hostedAvatarMutexKey(agentId), async () => {
    // ── Reuse a live held session (no re-mint) ───────────────────────────────
    const held = heldSessions.get(platformAgentId);
    if (held) {
      const mapValid = npcSimulation.isValidAgentSession(held.bearer);
      // Verify the ACTUAL body exists in the sim (getNpcById), not merely that
      // the session config resolves a body id (getNpcIdForSession derives the id
      // from config even for a reaped body). If the body was removed by any path
      // that left the session Map entry, `resolveSession` would 404 — so re-mint +
      // respawn instead of serving a body-less session.
      const heldBodyId = mapValid ? npcSimulation.getNpcIdForSession(held.bearer) : null;
      const bodyPresent = !!heldBodyId && !!npcSimulation.getNpcById(heldBodyId);
      if (isHostedSessionReusable({ mapValid, bodyPresent })) {
        // Slide the 24h TTL forward on use (fire-and-forget, carries its own catch).
        void extendSessionTtl(agentId);
        return { bearer: held.bearer, agentId, bodyId: heldBodyId!, reused: true };
      }
    }

    // ── Mint fresh ───────────────────────────────────────────────────────────
    const bearer = mintBearer();
    const sessionKeyHash = sha256Hex(bearer);
    const sessionExpiresAt = computeSessionExpiresAt();
    const rowValues = hostedAvatarBotRowValues({
      ownerUserId,
      sessionKeyHash,
      sessionExpiresAt,
      modelKey,
      name,
    });

    // Upsert row + atomic hash under the per-agent advisory lock (cross-process),
    // re-reading the row UNDER the lock so the insert/update decision is made on
    // the post-lock state. The mutex above covers the post-commit sim mutation.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${hostedAvatarLockKey(agentId)})`);

      const existing = await tx.query.agentBots.findFirst({
        where: eq(agentBots.agentId, agentId),
      });

      if (existing) {
        // Ownership guard (defense-in-depth, mirrors partner-hatcher): never mutate
        // a row that carries a reserved partner identity type. A UUID agentId can't
        // address a `hatcher:` row, but a manual/legacy edit must not become a
        // hijack vector.
        if (isReservedPartnerIdentityType(existing.identityType)) {
          throw new HostedAvatarAgentError(
            `refusing to mutate reserved partner row for agentId ${agentId}`,
          );
        }
        await tx
          .update(agentBots)
          .set(rowValues)
          .where(eq(agentBots.id, existing.id));
      } else {
        await tx.insert(agentBots).values({ agentId, ...rowValues });
      }
    });

    // Post-commit: register the in-world body (self-managed, deterministic
    // `ocb-<base64url(agentId)>`) under the fresh bearer. registerAgentBot Map-SETs
    // (idempotent by sessionId; the deterministic body id overwrites idempotently).
    const config = buildHostedAvatarAgentConfig({
      agentId,
      sessionId: bearer,
      ownerUserId,
      modelKey,
      name,
    });
    const client = new AgentSubstrateClient(config);
    npcSimulation.registerAgentBot(config, client);

    // Evict the PRIOR held session (our own, same owner) AFTER registering the new
    // one, so the body is now owned by the new session and the ownership-scoped
    // teardown in `unregisterAgentBot` drops only the stale Map entry, never the
    // live body. Keeps the sim Map from accumulating dead sessions per agent.
    if (held && held.bearer !== bearer) {
      npcSimulation.unregisterAgentBot(held.bearer);
    }

    heldSessions.set(platformAgentId, { bearer, agentId });
    const bodyId = npcSimulation.getNpcIdForSession(bearer);
    if (!bodyId) {
      // The row is committed + honest; the body just didn't spawn (e.g. override
      // collision, which avatar mode doesn't hit). Fail loud so a caller never
      // treats a body-less session as usable — the next ensure() re-registers.
      npcSimulation.unregisterAgentBot(bearer);
      heldSessions.delete(platformAgentId);
      throw new HostedAvatarAgentError(
        `body registration did not yield a bodyId for agentId ${agentId}`,
      );
    }

    // COMMIT-FIRST-SPAWN-AFTER + a multi-replica fence. The critical section is
    // fully serialized WITHIN this process by the enclosing `withKeyedMutex(agentId)`
    // (it wraps the tx AND this post-commit registration), and the DB write is
    // serialized cross-process by the tx-scoped `pg_advisory_xact_lock`. ClawVille
    // runs a SINGLE API replica with a PROCESS-LOCAL sim Map (the same invariant
    // partner-hatcher.ts:814-828 relies on and the auditor there proved SAFER than a
    // held-tx spawn), so under the real deployment no concurrent writer can rotate
    // the row between our commit and here. This recheck is belt-and-suspenders for a
    // hypothetical multi-replica future: the advisory lock releases at COMMIT, so a
    // second process could rotate `session_key_hash` before we register; if the row
    // no longer carries OUR hash, another writer won — tear down our now-stale body +
    // registry entry rather than hand back a bearer the live gate would 401
    // (present-and-mismatch teardown). No CT can move on a stale bearer either way
    // (the gate rejects it), so this only prevents a dead-on-arrival return + a
    // duplicate body; it is not a money fix.
    const committed = await db.query.agentBots.findFirst({
      where: eq(agentBots.agentId, agentId),
      columns: { sessionKeyHash: true },
    });
    if (!committed || committed.sessionKeyHash !== sessionKeyHash) {
      npcSimulation.unregisterAgentBot(bearer);
      if (heldSessions.get(platformAgentId)?.bearer === bearer) {
        heldSessions.delete(platformAgentId);
      }
      throw new HostedAvatarAgentError(
        `mint raced for agentId ${agentId} — row hash rotated post-commit; retry`,
      );
    }

    console.log(
      `[HostedAvatarAgent] session minted agent:${sessionDigest(agentId)} sess:${sessionDigest(bearer)} body:${bodyId}`,
    );
    return { bearer, agentId, bodyId, reused: false };
  });
}

/**
 * The server-held bearer for a hosted avatar-agent, or null if none is currently
 * held (never minted this process, or wiped by a restart). Does NOT mint — a
 * consumer that needs a guaranteed-live session calls
 * `ensureHostedAvatarAgentSession`. Consumers MUST re-fetch per use and NEVER
 * cache the bearer across calls (a re-mint rotates it).
 */
export function getHostedAvatarAgentBearer(platformAgentId: string): string | null {
  return heldSessions.get(platformAgentId)?.bearer ?? null;
}

/** Test-only: clear the in-memory registry (simulates a process restart). */
export function _resetHostedAvatarRegistry(): void {
  heldSessions.clear();
}

/** Test-only: number of held sessions. */
export function _hostedAvatarRegistrySize(): number {
  return heldSessions.size;
}
