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
  'cron-automation': [
    'cron', 'schedule', 'timer', 'scheduled', 'interval', 'recurring',
    'automation', 'workflow', 'pipeline', 'ci/cd', 'task queue', 'job',
    'orchestration', 'trigger', 'periodic', 'heartbeat',
  ],
  'api-integrations': [
    'webhook', 'api', 'rest', 'graphql', 'endpoint', 'http', 'oauth',
    'rate limit', 'integration', 'request', 'response', 'payload',
    'callback', 'event-driven', 'gateway', 'route',
  ],
  'memory-rag': [
    'memory', 'vector', 'embedding', 'rag', 'semantic search', 'context',
    'knowledge base', 'lancedb', 'retrieval', 'chunk', 'index',
    'similarity', 'recall', 'long-term memory', 'store',
  ],
  'code-development': [
    'code', 'debug', 'test', 'git', 'container', 'docker', 'generate',
    'compile', 'build', 'deploy', 'refactor', 'lint', 'typescript',
    'development', 'skill', 'registry',
  ],
  'messaging-channels': [
    'channel', 'slack', 'discord', 'telegram', 'email', 'messaging',
    'notification', 'bridge', 'multi-channel', 'chat', 'bot',
    'communication', 'broadcast', 'relay',
  ],
  'mcp-tool-use': [
    'tool', 'function calling', 'mcp', 'plugin', 'action', 'provider',
    'agentic', 'chain', 'loop', 'custom tool', 'tool use',
    'evaluator', 'service', 'extension',
  ],
  'visual-creation': [
    'data', 'sql', 'query', 'analytics', 'scrape', 'pipeline',
    'visualization', 'dashboard', 'chart', 'report', 'csv',
    'structured data', 'etl', 'transform',
  ],
  'app-publishing': [
    'search', 'research', 'summarize', 'fact-check', 'web search',
    'source', 'citation', 'structured output', 'extract',
    'analysis', 'synthesis', 'verify', 'investigate',
  ],
  'agent-security': [
    'security', 'permission', 'auth', 'wallet', 'solana', 'crypto',
    'defi', 'smart contract', 'blockchain', 'token', 'on-chain',
    'encryption', 'access control', 'key management',
  ],
  'deployment-ops': [
    'config', 'configuration', 'deploy', 'deployment', 'environment',
    'project management', 'invoice', 'document', 'scheduling',
    'settings', 'env', 'infrastructure', 'production', 'staging',
  ],
};
