/** Effort level for Claude's extended thinking */
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max';

/** Thinking budget tokens by effort level */
export const THINKING_BUDGET: Record<ThinkingEffort, number> = {
  low: 2048,
  medium: 5000,
  high: 10000,
  max: 20000,
};

/** Configuration for an agent's thinking capabilities */
export interface AgentThinkingConfig {
  effort: ThinkingEffort;
  enableThinkTool: boolean;
  model: string;
}

/** Default thinking configs per agent type */
export const AGENT_THINKING_DEFAULTS: Record<string, AgentThinkingConfig> = {
  'location-agent': { effort: 'high', enableThinkTool: true, model: 'claude-haiku-4-5-20251001' },
  'avatar-agent': { effort: 'medium', enableThinkTool: false, model: 'claude-haiku-4-5-20251001' },
  'openclaw-bot': { effort: 'medium', enableThinkTool: false, model: 'claude-haiku-4-5-20251001' },
  'npc-ambient': { effort: 'low', enableThinkTool: false, model: 'claude-haiku-4-5-20251001' },
};

/** Result of consulting a specialist building agent */
export interface ConsultationInsight {
  buildingId: string;
  buildingName: string;
  response: string;
}

/** Request for cross-building collaboration */
export interface CollaborationRequest {
  message: string;
  sourceBuildingId: string;
  dynamicContext?: string;
  maxExperts?: number;
  timeoutMs?: number;
}

/** Result of a cross-building collaboration */
export interface CollaborationResult {
  consulted: string[];
  insights: ConsultationInsight[];
  combinedContext: string;
  durationMs: number;
}

/**
 * Keywords that map each building to its area of expertise.
 * Used by detectRelevantExperts to route cross-domain questions.
 */
export const EXPERTISE_KEYWORDS: Record<string, string[]> = {
  'cron-hub': [
    'cron', 'schedule', 'timer', 'scheduled', 'interval', 'recurring',
    'automation', 'workflow', 'pipeline', 'ci/cd', 'task queue', 'job',
    'orchestration', 'trigger', 'periodic', 'heartbeat',
  ],
  'webhook-gateway': [
    'webhook', 'api', 'rest', 'graphql', 'endpoint', 'http', 'oauth',
    'rate limit', 'integration', 'request', 'response', 'payload',
    'callback', 'event-driven', 'gateway', 'route',
  ],
  'memory-vault': [
    'memory', 'vector', 'embedding', 'rag', 'semantic search', 'context',
    'knowledge base', 'lancedb', 'retrieval', 'chunk', 'index',
    'similarity', 'recall', 'long-term memory', 'store',
  ],
  'skill-forge': [
    'code', 'debug', 'test', 'git', 'container', 'docker', 'generate',
    'compile', 'build', 'deploy', 'refactor', 'lint', 'typescript',
    'development', 'skill', 'marketplace',
  ],
  'channel-bridge': [
    'channel', 'slack', 'discord', 'telegram', 'email', 'messaging',
    'notification', 'bridge', 'multi-channel', 'chat', 'bot',
    'communication', 'broadcast', 'relay',
  ],
  'tool-workshop': [
    'tool', 'function calling', 'mcp', 'plugin', 'action', 'provider',
    'agentic', 'chain', 'loop', 'custom tool', 'tool use',
    'evaluator', 'service', 'extension',
  ],
  'canvas-studio': [
    'data', 'sql', 'query', 'analytics', 'scrape', 'pipeline',
    'visualization', 'dashboard', 'chart', 'report', 'csv',
    'structured data', 'etl', 'transform',
  ],
  'voice-tower': [
    'search', 'research', 'summarize', 'fact-check', 'web search',
    'source', 'citation', 'structured output', 'extract',
    'analysis', 'synthesis', 'verify', 'investigate',
  ],
  'security-fortress': [
    'security', 'permission', 'auth', 'wallet', 'solana', 'crypto',
    'defi', 'smart contract', 'blockchain', 'token', 'on-chain',
    'encryption', 'access control', 'key management',
  ],
  'config-citadel': [
    'config', 'configuration', 'deploy', 'deployment', 'environment',
    'project management', 'invoice', 'document', 'scheduling',
    'settings', 'env', 'infrastructure', 'production', 'staging',
  ],
};
