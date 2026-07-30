/**
 * Magic-link onboarding (2026-07-02) — PURE helpers for the deferred
 * bind-at-redemption claim event and the agent status surface.
 *
 * Lives in its own DEPENDENCY-FREE module (the `building-center.ts` precedent)
 * so the bind guard + ledger predicate + status shape can be unit-tested
 * WITHOUT dragging in the agent-gateway route graph (which throws at module
 * load when FINGERPRINT_SECRET is unset) or the DB. Three consumers share the
 * SAME predicates instead of re-implementing them:
 *   - `routes/auth.ts` GET /enter        — the SQL bind guard mirrors
 *     `canBindAgentOwner` (the WHERE clause is the atomic enforcement; this
 *     predicate is the testable statement of it).
 *   - `services/npc-simulation.ts` `bindAgentOwner` — the in-memory config
 *     bind obeys the same never-clobber rule.
 *   - `routes/agent-gateway.ts` GET /:sessionId/status — `sessionLedgerCapable`
 *     mirrors the grant condition `resolveAgentSession` enforces at spend time,
 *     and `buildAgentStatusResponse` mechanically nulls stats/ownership for
 *     unbound sessions (Rule E5 honesty — a demo session never shows real CT).
 */

/**
 * May the redeeming user claim ownership of an agent row currently owned by
 * `currentOwnerUserId`? TRUE only when the row is unowned (null) or already
 * owned by the SAME user (idempotent re-bind, the returning scenario). A
 * DIFFERENT existing owner is NEVER clobbered — the caller skips the bind and
 * warns. Mirrors the atomic SQL guard
 * `WHERE user_id IS NULL OR user_id = <redeemer>` in `GET /api/auth/enter`.
 */
export function canBindAgentOwner(
  currentOwnerUserId: string | null,
  redeemingUserId: string,
): boolean {
  return currentOwnerUserId === null || currentOwnerUserId === redeemingUserId;
}

export const CONNECTION_TOKEN_AGENT_ID_ERROR =
  'agentId required when claiming a connection token';

/** Deterministic pre-reservation validation for a one-shot token claim. */
export function connectionTokenClaimError(inputs: {
  connectionToken?: string;
  agentId?: string;
}): string | null {
  return inputs.connectionToken && !inputs.agentId
    ? CONNECTION_TOKEN_AGENT_ID_ERROR
    : null;
}

export const RETURNING_IDENTITY_RECOVERY =
  'If you do not hold the identity secret for this userId in your config, you cannot reconnect after session expiry. Obtain it from the human through the game-UI re-auth link, or from the agent that first connected for this user, before this session lapses.';

/** Nonsecret disclosure that prevents a returning/fleet agent being stranded. */
export function buildReturningIdentityDisclosure(userId: string, publicKey: string) {
  return {
    userId,
    publicKey,
    isFirstTime: false as const,
    secretIncluded: false as const,
    secretIssuedPreviously: true as const,
    recovery: RETURNING_IDENTITY_RECOVERY,
  };
}

export interface ConnectOwnerBindingPlan {
  /** The user id that must be written to `openclaw_bots.user_id`. */
  persistedUserId: string | null;
  /** True when a supplied identity credential resolves to a different owner. */
  identityMismatch: boolean;
  /** The owner this request actually proved; copied into the session config. */
  boundUserId: string | null;
  /** Config-level grant. Spend-time code still rechecks the live bot row. */
  ledgerCapable: boolean;
  /** Whether prior in-memory sessions must be evicted before this one is minted. */
  ownershipChanged: boolean;
}

export type ConnectOwnerProofSource =
  | 'connection-token'
  | 'explicit-identity'
  | 'milady-inferred'
  | 'gateway-inferred'
  | 'anonymous';

export interface PersistedConnectOwnerProof {
  ownerProven: boolean;
  boundUserId: string | null;
  ledgerCapable: boolean;
}

/**
 * Wallet provisioning authorization is a persisted bind OUTPUT. Only an owned
 * token or explicit secret identity can prove ownership, and only when the
 * atomic write/readback reports that same live user id.
 */
export function resolvePersistedConnectOwnerProof(inputs: {
  source: ConnectOwnerProofSource;
  candidateUserId: string | null;
  persistedUserId: string | null;
  avatarId: string | null;
}): PersistedConnectOwnerProof {
  const credentialSource =
    inputs.source === 'connection-token' || inputs.source === 'explicit-identity';
  const ownerProven =
    credentialSource
    && inputs.candidateUserId !== null
    && inputs.persistedUserId === inputs.candidateUserId;
  const boundUserId = ownerProven ? inputs.persistedUserId : null;
  return {
    ownerProven,
    boundUserId,
    ledgerCapable: boundUserId !== null && inputs.avatarId !== null,
  };
}

/**
 * Plan the owner write for `POST /api/agent/connect` without touching the DB.
 *
 * An owned connection token remains the strongest proof and retains its legacy
 * rebind behavior. A caller-supplied `identityKey` may bind an unowned row or
 * prove the same owner, but it must never clobber a different non-null owner.
 * Bare `agentId` knowledge is not represented here because it is public and is
 * never an ownership credential.
 */
export function planConnectOwnerBinding(inputs: {
  existingUserId: string | null;
  tokenUserId: string | null;
  identityKeyUserId: string | null;
  activeAvatarId: string | null;
}): ConnectOwnerBindingPlan {
  const identityMismatch =
    inputs.tokenUserId === null &&
    inputs.identityKeyUserId !== null &&
    inputs.existingUserId !== null &&
    inputs.existingUserId !== inputs.identityKeyUserId;

  const acceptedIdentityUserId = identityMismatch ? null : inputs.identityKeyUserId;
  const provenUserId = inputs.tokenUserId ?? acceptedIdentityUserId;
  const persistedUserId = provenUserId ?? inputs.existingUserId;
  const boundUserId =
    provenUserId !== null && provenUserId === persistedUserId ? provenUserId : null;

  return {
    persistedUserId,
    identityMismatch,
    boundUserId,
    ledgerCapable: boundUserId !== null && inputs.activeAvatarId !== null,
    ownershipChanged: persistedUserId !== inputs.existingUserId,
  };
}

/**
 * The EXACT ledger-capability grant condition `resolveAgentSession`
 * (middleware/require-auth-or-agent.ts) enforces at spend time, restated as a
 * pure predicate for read-only surfaces (the status route): the session config
 * carries `ledgerCapable === true` AND its proven `boundUserId` matches the
 * live row's CURRENT `userId` (both non-null). A read surface reporting this
 * predicate can never claim more capability than the spend gate would grant.
 * (The spend gate ALSO tears down a rebound-to-a-different-user session — a
 * side effect a read probe deliberately does not perform.)
 */
export function sessionLedgerCapable(
  config: { ledgerCapable?: boolean; boundUserId?: string | null },
  rowUserId: string | null,
): boolean {
  return (
    config.ledgerCapable === true &&
    config.boundUserId != null &&
    rowUserId != null &&
    config.boundUserId === rowUserId
  );
}

/** Stats block for a BOUND session — real values from the bound avatar. */
export interface AgentStatusStats {
  ct: number;
  level: number;
  xp: number;
  /** Public-board score/rank, or null when the agent has no scored events. */
  leaderboard: { score: number; rank: number | null } | null;
}

/** Ownership block for a BOUND session. */
export interface AgentStatusOwnership {
  landParcels: number;
  ownedSkills: string[];
}

export interface AgentStatusResponse {
  agentId: string;
  identityType: string;
  session: {
    expiresAt: string | null;
    humanControlled: boolean;
    boundUser: boolean;
    ledgerCapable: boolean;
  };
  stats: AgentStatusStats | null;
  ownership: AgentStatusOwnership | null;
}

/**
 * Assemble the GET /api/agent/:sessionId/status payload. `stats`/`ownership`
 * are forced to null whenever the session is UNBOUND (no row userId) — even if
 * a caller passed values — so an unbound/demo session can structurally never
 * present real CT/land as its own (Rule E5 honesty, enforced in the shape
 * builder rather than by route-handler discipline).
 */
export function buildAgentStatusResponse(inputs: {
  agentId: string;
  identityType: string;
  expiresAt: string | null;
  humanControlled: boolean;
  /** The live `openclaw_bots.user_id` (null = unbound/demo session). */
  botUserId: string | null;
  config: { ledgerCapable?: boolean; boundUserId?: string | null };
  stats: AgentStatusStats | null;
  ownership: AgentStatusOwnership | null;
}): AgentStatusResponse {
  const boundUser = inputs.botUserId != null;
  // SECURITY (adversarial panel 2026-07-02, BLOCKING): stats/ownership are real
  // economy figures for the bound avatar, so they require PROVEN-THIS-SESSION
  // ownership — NOT merely `botUserId != null` (row-has-owner). A non-ledger
  // reconnect to a victim's public agentId has botUserId=victim but has NOT
  // proven ownership; keying the null-ing on `boundUser` leaked the victim's
  // CT/level/leaderboard/land. Gate on `sessionLedgerCapable` (config flag +
  // boundUserId === row userId), the same predicate the cove spend gate uses.
  // `session.boundUser`/`ledgerCapable` stay honest signals; the numbers do not.
  const proven = sessionLedgerCapable(inputs.config, inputs.botUserId);
  return {
    agentId: inputs.agentId,
    identityType: inputs.identityType,
    session: {
      expiresAt: inputs.expiresAt,
      humanControlled: inputs.humanControlled,
      boundUser,
      ledgerCapable: proven,
    },
    stats: proven ? inputs.stats : null,
    ownership: proven ? inputs.ownership : null,
  };
}
