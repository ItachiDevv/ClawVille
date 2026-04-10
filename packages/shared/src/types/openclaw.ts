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
 */
export type AgentWireProtocol =
  | 'openai-compat'
  | 'anthropic'
  | 'custom-webhook'
  | 'nanoclaw';

/**
 * Identity framework an agent is connecting as. Influences how the /connect
 * endpoint resolves the agentId and whether outbound chat routing is used.
 *
 * - 'openclaw' / 'ironclaw' — classic chat-routing agents with a reachable HTTP gateway
 * - 'nanoclaw'              — self-managed pull-based agents (no HTTP server required)
 * - 'moltbook'              — identity comes from a Moltbook token/key (any gateway)
 * - 'custom'                — any other framework with a compatible gateway
 * - 'anonymous'             — one-off test agents with no persistent identity
 */
export type AgentIdentityType =
  | 'openclaw'
  | 'ironclaw'
  | 'nanoclaw'
  | 'moltbook'
  | 'custom'
  | 'anonymous';

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
