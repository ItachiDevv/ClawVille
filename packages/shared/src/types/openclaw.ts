export type AgentAutonomyMode = 'server-managed' | 'self-managed';

/**
 * Wire protocols ClawVille's OpenClawClient can speak to an external gateway.
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

export interface OpenClawBotConfig {
  sessionId: string;
  gatewayUrl: string; // e.g. "https://my-openclaw.example.com"
  authToken: string;
  agentId: string; // used as model: "openclaw:<agentId>" (override with modelName)
  sessionKey: string; // for memory persistence
  protocol?: AgentWireProtocol;
  autonomyMode?: AgentAutonomyMode;
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

export interface OpenClawBotIdentity {
  botId: string;        // UUID from DB
  agentId: string;      // stable identity
  sessionId: string;    // ephemeral per-connection
  mode: string;
  isReturning: boolean;
  totalSessions: number;
  knowledge: string[];
}

export interface OpenClawOverrideConfig extends OpenClawBotConfig {
  mode: 'override';
  targetNpcId: string; // one of NPC IDs
}

export interface OpenClawAvatarConfig extends OpenClawBotConfig {
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

export type OpenClawRegistration = OpenClawOverrideConfig | OpenClawAvatarConfig;

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
