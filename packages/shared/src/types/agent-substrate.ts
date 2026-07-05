export type AgentAutonomyMode = 'server-managed' | 'self-managed';

/**
 * Wire protocols ClawVille's AgentSubstrateClient can speak to an external gateway.
 *
 * 'openai-compat' — POST /v1/chat/completions, OpenAI JSON shape (default).
 * 'anthropic'     — POST /v1/messages, Anthropic JSON shape.
 * 'custom-webhook'— POST / with a generic {messages,context} envelope.
 * 'nanoclaw'      — No outbound gateway at all. The agent is self-managed:
 *                   it registers via POST /api/agent/connect, then pulls
 *                   world state from GET /api/agent/:sessionId/events (SSE)
 *                   and pushes actions via POST /api/agent/:sessionId/*.
 *                   The client stub exists only so the DB row is consistent.
 * 'hatcher-proxy' — Cognition routed through a Hatcher-managed per-agent
 *                   proxy (partner #2, Phase A). POST to
 *                   {proxyBaseUrl}/integrations/clawville/agents/{agentId}/chat
 *                   with an OpenAI chat-completions body + DUAL auth (Hatcher's
 *                   scoped Bearer token + our ed25519 X-Clawville-* signature).
 *                   Transport selector only — the agent's brain lives on
 *                   Hatcher; ClawVille assembles the orientation + world-state
 *                   system message and parses [ACTION: ...] tags from the reply
 *                   server-side. See `.claude/plans/hatcher-integration.md` §14.
 */
export type AgentWireProtocol =
  | 'openai-compat'
  | 'anthropic'
  | 'custom-webhook'
  | 'nanoclaw'
  | 'hatcher-proxy';

/**
 * Identity framework an agent is connecting as. Influences how the /connect
 * endpoint resolves the agentId and whether outbound chat routing is used.
 *
 * - 'openclaw' / 'ironclaw' — classic chat-routing agents with a reachable HTTP gateway
 * - 'nanoclaw'              — self-managed pull-based agents (no HTTP server required)
 * - 'milady'                — running inside a Milady app plugin (runtime-trust,
 *                             no external verification; agentId derived from the
 *                             Milady runtime's agentId)
 * - 'custom'                — any other framework with a compatible gateway
 * - 'anonymous'             — one-off test agents with no persistent identity
 */
export type AgentIdentityType =
  | 'openclaw'
  | 'ironclaw'
  | 'nanoclaw'
  | 'milady'
  | 'custom'
  | 'anonymous';

/**
 * Structured, PUBLIC-ONLY world-state snapshot handed to a Hatcher proxy in the
 * top-level `clawville` block of a cognition request (Phase A++, 2026-06-02).
 *
 * Hatcher owns the root/system prompt for its agent's brain; ClawVille stops
 * forcing a `role:'system'` message on the proxy path and instead ships this
 * structured object so the partner builds their OWN prompt from it. The shape
 * mirrors `buildPerception` (apps/api/src/routes/agent-gateway.ts) reduced to
 * the public fields a partner is allowed to see.
 *
 * SECURITY: this object MUST contain ONLY public world-state. NEVER include the
 * scoped token, wallet secret, identity secret, session id, userId, or any
 * internal id beyond public npc/building ids.
 */
export interface HatcherWorldState {
  self: {
    name: string;
    /** 'avatar' = own body, 'override' = possessing a roaming NPC. */
    mode: 'avatar' | 'override';
    x: number;
    y: number;
    hp: number;
    activity: string;
  };
  nearbyPlayers: Array<{ name: string; distance: number }>;
  nearbyNpcs: Array<{
    id: string;
    name: string;
    isAgent: boolean;
    distance: number;
  }>;
  nearbyBuildings: Array<{ id: string; name: string; cryptoFocus: string }>;
  gameMode: string;
}

/**
 * Response contract for `POST /api/partner/hatcher/launch/exchange` (the
 * owner-side Hatcher launch entry). The web `/game` page consumes this to decide
 * whether to focus the camera on the agent's in-world body or show an error
 * banner. A discriminated union on `ok` so the consumer cannot read `agent`
 * without first proving success.
 *
 * SECURITY: the success shape carries ONLY public values (the partner-supplied
 * agentId echoed back, a display name, public world coordinates). It NEVER
 * carries the launchToken, the Lucia session id (raw or hashed), the userId, or
 * any Hatcher response body. The failure shape carries ONLY a small internal
 * error enum + (for an upstream rejection) the upstream HTTP status — never
 * Hatcher's raw body.
 */
export type HatcherLaunchExchangeResponse =
  | {
      ok: true;
      agent: {
        /** Raw partner agent id (no `hatcher:` namespace prefix). */
        agentId: string;
        /** Display name for the "Watching <name>" banner. */
        name: string;
        /** Public world coordinate (agent's body) — retained for compatibility;
         * controlled launch lands in player follow-camera, not explore focus. */
        x: number;
        y: number;
        /** Launch mode handed to the owner. Controlled = owner drives the
         * agent's avatar via the magic-link session (the shipped deliverable).
         * Hatcher's `/launch/exchange` accepts `controlled`. */
        mode: 'controlled';
      };
    }
  | {
      ok: false;
      /**
       * Internal error enum (never Hatcher's raw error). `launch_requires_session`
       * = no Lucia session (relaunch from the Hatcher dashboard).
       * `agent_not_registered` = unknown agent id (no outbound call was made).
       * `exchange_rejected` = Hatcher returned a non-2xx / was unreachable.
       * `launch_issuer_unconfigured` = OUR service-issuer signing key is missing
       * or invalid (a server config error, NOT an upstream rejection — distinct
       * so the web side can surface "try again later" vs "relaunch").
       * `invalid_request` = malformed params. `rate_limited` = per-IP cap hit.
       * `agent_not_bound` = the agent row has no bound ClawVille user, so there
       * is no avatar for the owner to drive (controlled launch is impossible).
       * `agent_not_owned` = the logged-in session is not the agent's bound user;
       * driving it would leave the autonomous proxy as a second body. Both fail
       * loud rather than silently produce a duplicate body.
       */
      error:
        | 'launch_requires_session'
        | 'agent_not_registered'
        | 'agent_not_bound'
        | 'agent_not_owned'
        | 'exchange_rejected'
        | 'launch_issuer_unconfigured'
        | 'invalid_request'
        | 'rate_limited';
      /** Present only for `exchange_rejected` — the upstream HTTP status. */
      status?: number;
    };

export interface AgentBotConfig {
  sessionId: string;
  gatewayUrl: string; // e.g. "https://my-openclaw.example.com"
  authToken: string;
  agentId: string; // used as model: "openclaw:<agentId>" (override with modelName)
  sessionKey: string; // for memory persistence
  protocol?: AgentWireProtocol;
  autonomyMode?: AgentAutonomyMode;
  /**
   * Security (Codex auth-lens hardening, 2026-06-03): does THIS session prove
   * ownership of the avatar it is bound to, and may it therefore spend that
   * avatar's REAL ClawTokens in the Cove?
   *
   * TRUE only when ownership was proven at registration time:
   *   (a) a valid OWNED Moltbook connection token,
   *   (b) the ed25519 partner-signed Hatcher path (`partner-hatcher.ts`),
   *   (c) genuine first-contact where no existing bound `userId` exists (the
   *       agent self-creates its own avatar), or
   *   (d) the signed-challenge magic-link reconnect.
   *
   * FALSE for an `agentId`-only reconnect to an ALREADY-BOUND bot (the bot
   * already has a `userId` but the caller presented no token/signature) — that
   * caller can perceive/chat but the cove rejects it with 403 rather than
   * granting real-CT play or silently demoting it to the guest demo tier.
   *
   * In-memory only (ephemeral session config) — never persisted; defaults to
   * FALSE when omitted so any path that forgets to set it fails CLOSED.
   */
  ledgerCapable?: boolean;
  /**
   * Security (Codex auth-lens hardening round 2, 2026-06-03): the userId this
   * session PROVED ownership of at registration time. This is the resolve-time
   * backstop for the stale-session rebind theft vector — `ledgerCapable` alone
   * is frozen at registration, but the bound `userId` on the live
   * `openclaw_bots` row can CHANGE underneath it (an unbound/other-user agentId
   * later rebinds to a victim via an owned-token connect). Without this, a stale
   * session registered while the row was unbound would illegitimately authorize
   * real-CT spend against whatever user the row was LATER rebound to.
   *
   * `resolveAgentSession` grants ledger capability ONLY when
   * `boundUserId === liveBot.userId` (and both non-null). A mismatch means the
   * row was rebound after this session was issued → non-ledger (and the stale
   * session is unregistered). Set to the proven owner wherever `ledgerCapable`
   * is set TRUE with a concrete user (owned-token `tokenUserId`, partner-signed
   * Hatcher userId). NULL for first-contact / anonymous sessions — which the
   * cove already rejects for having no bound active avatar, so a null
   * `boundUserId` keeps them non-ledger and consistent.
   *
   * In-memory only; never persisted.
   */
  boundUserId?: string | null;
  /** Override model name sent to the gateway (default: "openclaw:<agentId>") */
  modelName?: string;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Max tokens for chat responses (default: 150) */
  maxTokens?: number;

  // --- Hatcher proxy-cognition (protocol === 'hatcher-proxy') ---
  /**
   * The RAW partner-supplied agent id (no `hatcher:` namespace prefix). Used
   * verbatim in the cognition-callback URL + model name so Hatcher receives the
   * id IT knows. Internally we namespace the stored/in-world `agentId` as
   * `hatcher:<rawId>` to prevent cross-framework collisions in the shared
   * `openclaw_bots.agent_id` namespace; the proxy must NOT see that prefix.
   * Falls back to `agentId` when unset (non-Hatcher protocols ignore it).
   */
  proxyAgentId?: string;
  /**
   * Hatcher proxy base URL. ClawVille POSTs cognition requests to
   * `{proxyBaseUrl}/integrations/clawville/agents/{proxyAgentId}/chat`. MUST be
   * validated against the SSRF host allowlist before any outbound call.
   */
  proxyBaseUrl?: string;
  /**
   * The Hatcher-issued scoped bearer token, already DECRYPTED in-memory by
   * the caller. Sent as `Authorization: Bearer <scopedToken>` on the
   * cognition callback. NEVER log this value. Optional so the client can be
   * constructed for non-proxy protocols without it.
   */
  scopedToken?: string;
  /**
   * Optional system-message provider for proxy cognition. Returns the
   * "you are inside ClawVille" orientation + a serialized world-state block
   * for THIS agent's body, injected as a `role:'system'` message ahead of the
   * conversation. Bound to the agent's npcId at registration time. Returning
   * null/empty skips system injection (the proxy still gets the user turn).
   *
   * @deprecated For the hatcher-proxy path the partner now owns the root prompt
   * — see `worldStateProvider`. Retained for any non-Hatcher caller that still
   * wants a forced system message; the hatcher-proxy chat no longer reads it.
   */
  systemContextProvider?: () => string | null;
  /**
   * Structured world-state provider for proxy cognition (Phase A++, 2026-06-02).
   * Returns the PUBLIC-ONLY world-state snapshot for THIS agent's body, shipped
   * in the top-level `clawville.worldState` block so the Hatcher proxy builds
   * its own system prompt. Bound to the agent's npcId at registration time.
   * Returning null omits `worldState` from the payload (the proxy still gets the
   * user turn + orientation pointer). Replaces the text `systemContextProvider`
   * on the hatcher-proxy path.
   */
  worldStateProvider?: () => HatcherWorldState | null;
}

export interface AgentBotIdentity {
  botId: string;        // UUID from DB
  agentId: string;      // stable identity
  sessionId: string;    // ephemeral per-connection
  mode: string;
  isReturning: boolean;
  totalSessions: number;
  knowledge: string[];
  /** ISO timestamp the session's sliding 24h TTL expires at. Additive
   *  (2026-06-12) — pull-side expiry visibility. Omitted if the DB upsert
   *  failed (ephemeral-only fallback). */
  sessionExpiresAt?: string;
}

export interface AgentOverrideConfig extends AgentBotConfig {
  mode: 'override';
  targetNpcId: string; // one of NPC IDs
}

export interface AgentAvatarConfig extends AgentBotConfig {
  mode: 'avatar';
  name: string;
  species: string;
  color: number;
  stats: { hp: number; attack: number; defense: number; speed: number };
  personality: string;
  homeX: number;
  homeY: number;
  patrolRadius: number;
}

export type AgentSubstrateRegistration = AgentOverrideConfig | AgentAvatarConfig;

export interface SkillMdOptions {
  customName?: string;
  customDescription?: string;
  customInstructions?: string;
  selectedKnowledge?: string[];
}

export interface MemoryExportResponse {
  avatarId: string;
  avatarName: string;
  dailyLogs: Array<{ date: string; filename: string; content: string }>;
  longTermMemory: string;
  totalMemories: number;
  totalActivities: number;
}
