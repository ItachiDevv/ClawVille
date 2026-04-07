export type AgentAutonomyMode = 'server-managed' | 'self-managed';

export interface OpenClawBotConfig {
  sessionId: string;
  gatewayUrl: string; // e.g. "https://my-openclaw.example.com"
  authToken: string;
  agentId: string; // used as model: "openclaw:<agentId>" (override with modelName)
  sessionKey: string; // for memory persistence
  protocol?: 'openai-compat' | 'anthropic' | 'custom-webhook';
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
