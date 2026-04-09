/** Thinking effort levels for extended-thinking API calls */
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max';

/** Budget tokens per thinking effort level */
export const THINKING_BUDGET: Record<ThinkingEffort, number> = {
  low: 2048,
  medium: 4096,
  high: 8192,
  max: 16384,
};

/** A single specialist building's response to a cross-domain question */
export interface ConsultationInsight {
  buildingId: string;
  buildingName: string;
  response: string;
}

/** Request payload for the collaboration service */
export interface CollaborationRequest {
  message: string;
  sourceBuildingId: string;
  dynamicContext?: string;
  maxExperts?: number;
  timeoutMs?: number;
}

/** Result of a multi-agent collaboration query */
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
