/**
 * Hosted avatar-agent internal session — PURE plan layer (§B.2, 2026-07-08).
 *
 * WHAT THIS CLOSES: a signup user's HOSTED avatar-agent (`platform_agents` type
 * 'avatar-agent', bound to the owner's avatar via `avatars.platformAgentId`,
 * provisioned by `avatar-agent-provisioning.ts`) has NO `openclaw_bots` row and
 * therefore NO agent bearer session — so it cannot use the `/api/agent/:sessionId`
 * tool surface (tools.json, events replay, Cove/Poker agent API) the way a BYO /
 * Hatcher agent can. That is the structural half of the E5 parity gap: the model
 * doc promises the hosted agent is a FULL-SCOPE economic participant. This layer
 * is the DB-free / sim-free decision + assembly logic for the internal session
 * MINT; the orchestration (DB upsert + npc-simulation registration + the
 * server-held bearer registry + the dual lock) lives in
 * `hosted-avatar-agent-session.ts`. Split for the same reason as
 * `agent-reconnect-session.ts`: the money/session LOGIC is unit-testable without a
 * DB and without dragging the FINGERPRINT_SECRET-crashing route graph into the
 * test env.
 *
 * DESIGN (why these choices — the trap map):
 *  - identityType 'nanoclaw': the session is PURELY the tool-surface credential;
 *    cognition for an avatar-agent runs through its `platform_agents` ElizaOS
 *    runtime (the orchestrator), NOT this session's gateway. 'nanoclaw' is the
 *    no-outbound-gateway, self-managed, `isRowRestorableFromIdentity`-TRUE identity
 *    (agent-session-config.ts) — exactly the house-agent precedent
 *    (house-agent-seeder.ts). Its `.chat()` is a no-op stub, so the body never
 *    POSTs anywhere.
 *  - ledgerCapable TRUE + boundUserId = OWNER (BOTH): the mint's whole point is
 *    real-CT play. `resolveAgentSession` demotes to non-ledger unless
 *    `config.boundUserId === live row userId`, so the config AND the row's
 *    `userId` must BOTH be the owner or the Cove 403s (the trap-4 binding).
 *  - self-managed + deterministic `ocb-<base64url(agentId)>` body: so the §B.1
 *    autonomy driver can enroll the SAME body (the 200ms sim planner leaves a
 *    self-managed body alone; the driver is its only mover).
 *  - agentId = the avatar-agent's `platform_agents.id` (an opaque UUID) VERBATIM:
 *    globally-unique, deterministic, NON-reserved (no `hatcher:` prefix). No
 *    schema change / migration — the existing `openclaw_bots.agent_id` UNIQUE
 *    column IS the 1:1 key.
 *
 * NO partner-wire change: 'nanoclaw' already exists; the bearer/TTL gate contract
 * (require-auth-or-agent.ts), the shared openclaw types, and PROTOCOL_VERSION are
 * all untouched. The existing tool surface resolves this session with ZERO gate
 * edits.
 */

import type { AgentSubstrateRegistration } from '@clawville/shared';
import {
  buildAvatarSessionConfig,
  DEFAULT_HATCHER_HOME_X,
  DEFAULT_HATCHER_HOME_Y,
} from './agent-session-config';
import { isReservedPartnerAgentId } from './reserved-agent-namespaces';

/**
 * The identity type for a hosted avatar-agent's internal session. 'nanoclaw' is
 * the no-gateway, self-managed, restorable-from-row identity — the same choice the
 * house agent makes, for the same reasons (cognition is NOT via this session's
 * gateway). Changing this is a keystone decision: a real-gateway type would be
 * NON-restorable AND would arm an outbound POST the body must never make.
 */
export const HOSTED_AVATAR_IDENTITY_TYPE = 'nanoclaw' as const;

/** The persisted `protocol` column value (mirrors identityType; re-derived on
 *  mint/restore from the identity, never trusted from the column). */
export const HOSTED_AVATAR_PROTOCOL = 'nanoclaw' as const;

/** Home = the TRUE 22528-px sim center (shared with the hatcher mint/restore
 *  default so a hosted body spawns in the live world, not a legacy space).
 *  `resolveSafeSpawn` in `registerAgentBot` snaps this to a walkable tile. */
export const HOSTED_AVATAR_HOME_X = DEFAULT_HATCHER_HOME_X;
export const HOSTED_AVATAR_HOME_Y = DEFAULT_HATCHER_HOME_Y;
export const HOSTED_AVATAR_PATROL_RADIUS = 100;
/** Combat/body stats — cosmetic for a self-managed avatar body (never fights). */
export const HOSTED_AVATAR_STATS = { hp: 100, attack: 10, defense: 10, speed: 10 } as const;

/**
 * The stable, opaque in-world/session agent id for a hosted avatar-agent. It is
 * the avatar-agent's `platform_agents.id` VERBATIM — a UUID: globally unique,
 * deterministic (so the deterministic `ocb-` body id + restart recovery are
 * stable), and NON-reserved. Defense-in-depth: refuse if a future platform-agent
 * id ever collided with a reserved partner namespace (it cannot today — a UUID has
 * no `hatcher:` prefix — but the guard makes the invariant loud instead of a
 * silent partner-row hijack).
 */
export function hostedAvatarAgentId(platformAgentId: string): string {
  if (!platformAgentId) {
    throw new Error('hostedAvatarAgentId: platformAgentId is required');
  }
  if (isReservedPartnerAgentId(platformAgentId)) {
    throw new Error(
      `hostedAvatarAgentId: platformAgentId '${platformAgentId}' is in a reserved partner namespace — refusing to mint`,
    );
  }
  return platformAgentId;
}

export interface HostedAvatarConfigInput {
  agentId: string;
  /** The freshly-minted bearer — IS the session id (config.sessionId === bearer). */
  sessionId: string;
  /** The avatar OWNER's userId. Bound BOTH here and on the row (trap 4). */
  ownerUserId: string;
  /** Bound avatars.id for internal covenant attribution. */
  avatarId?: string;
  /** The avatar's render model key (what the in-world VRM/GLB loader routes on). */
  modelKey: string;
  /** The avatar's display name. */
  name: string;
  homeX?: number;
  homeY?: number;
}

/**
 * Assemble the in-world `{config}` for a hosted avatar-agent body, via the SHARED
 * builder so mint and (lazy) restore can never drift. ledgerCapable + boundUserId
 * are the trap-4 binding: BOTH set to the owner so `resolveAgentSession` keeps the
 * session ledger-capable. `storedProtocol: 'nanoclaw'` + identityType 'nanoclaw'
 * both force self-managed + the fail-soft 'nanoclaw' wire (no outbound POST).
 */
export function buildHostedAvatarAgentConfig(
  input: HostedAvatarConfigInput,
): AgentSubstrateRegistration {
  return buildAvatarSessionConfig({
    mode: 'avatar',
    agentId: input.agentId,
    sessionId: input.sessionId,
    identityType: HOSTED_AVATAR_IDENTITY_TYPE,
    storedProtocol: HOSTED_AVATAR_PROTOCOL,
    autonomyMode: 'self-managed',
    name: input.name,
    // The render model key IS the `species` field the renderer routes on (matches
    // the /connect convention, where `species` carries a model key).
    species: input.modelKey,
    color: null,
    stats: HOSTED_AVATAR_STATS,
    homeX: input.homeX ?? HOSTED_AVATAR_HOME_X,
    homeY: input.homeY ?? HOSTED_AVATAR_HOME_Y,
    patrolRadius: HOSTED_AVATAR_PATROL_RADIUS,
    personality: '',
    // TRAP 4: real-CT capability requires BOTH the config flag AND the row's
    // userId to equal the owner. The orchestration writes `userId = ownerUserId`.
    ledgerCapable: true,
    boundUserId: input.ownerUserId,
    avatarId: input.avatarId,
  });
}

/** Metadata shape persisted on the row (restore fidelity for the body). */
export interface HostedAvatarRowMetadata {
  personality: string;
  homeX: number;
  homeY: number;
  patrolRadius: number;
  stats: { hp: number; attack: number; defense: number; speed: number };
}

export interface HostedAvatarRowValuesInput {
  ownerUserId: string;
  /** sha256Hex(bearer) — NEVER the raw bearer. */
  sessionKeyHash: string;
  /** Non-null future timestamp (24h). A null TTL is treated as EXPIRED downstream. */
  sessionExpiresAt: Date;
  modelKey: string;
  name: string;
}

/**
 * The `openclaw_bots` column values (minus `agentId`) for a hosted avatar-agent
 * upsert. PURE — the caller supplies the already-computed hash + expiry so this
 * stays crypto-free/clock-free and unit-testable. is_house is FALSE (a real user
 * agent, NOT a fleet fixture) so the body idle-despawn sweeper and the 24h session
 * sweeper treat it like any user session — user agents SHOULD expire + renew.
 */
export function hostedAvatarBotRowValues(input: HostedAvatarRowValuesInput) {
  const metadata: HostedAvatarRowMetadata = {
    personality: '',
    homeX: HOSTED_AVATAR_HOME_X,
    homeY: HOSTED_AVATAR_HOME_Y,
    patrolRadius: HOSTED_AVATAR_PATROL_RADIUS,
    stats: { ...HOSTED_AVATAR_STATS },
  };
  return {
    identityType: HOSTED_AVATAR_IDENTITY_TYPE,
    gatewayUrl: null as string | null,
    protocol: HOSTED_AVATAR_PROTOCOL,
    mode: 'avatar' as const,
    name: input.name,
    species: input.modelKey,
    // Bind to the OWNER (trap 4) — must equal config.boundUserId.
    userId: input.ownerUserId,
    isHouse: false,
    // Non-null future TTL — fail-closed gate treats null as expired.
    sessionExpiresAt: input.sessionExpiresAt,
    // Restart survival: one-way hash of THIS bearer, committed atomically with the
    // row. Never the raw bearer.
    sessionKeyHash: input.sessionKeyHash,
    sessionSweptAt: null as Date | null,
    metadata,
    updatedAt: new Date(),
  };
}

/**
 * Reuse decision for a held session: reuse ONLY when the in-memory Map still holds
 * the session (RAM-live) AND the deterministic body is present. A restart wipes
 * the Map (→ mint fresh); an idle-despawn removes the body (→ mint fresh + respawn
 * body). Trivial by construction, but named + tested so the "reuse vs re-mint"
 * contract is explicit and can't silently regress into serving a bearer whose body
 * was reaped (which would 404 at `resolveSession`).
 */
export function isHostedSessionReusable(observed: {
  mapValid: boolean;
  bodyPresent: boolean;
}): boolean {
  return observed.mapValid && observed.bodyPresent;
}
