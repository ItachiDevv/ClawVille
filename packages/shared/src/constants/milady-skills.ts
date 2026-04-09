export interface MiladyGatewayConfig {
  baseUrl: string;
  authToken: string;
  timeoutMs?: number;
  enabled?: boolean;
}

export interface MiladySkillDefinition {
  skillId: string;
  name: string;
  description: string;
  category: string;
  buildingId: string;
  requiredBooks: number;
}

/** Maps each building to its Milady skill definition (one skill per building) */
export const BUILDING_MILADY_SKILLS: Record<string, MiladySkillDefinition> = {
  'cron-hub': {
    skillId: 'clawville-automation',
    name: 'Automation & Scheduling',
    description: 'Cron jobs, task queues, workflow orchestration, and scheduled automation',
    category: 'Automation & Workflows',
    buildingId: 'cron-hub',
    requiredBooks: 2,
  },
  'webhook-gateway': {
    skillId: 'clawville-apis',
    name: 'APIs & Integrations',
    description: 'REST APIs, GraphQL, webhooks, OAuth, and system integrations',
    category: 'APIs & Integrations',
    buildingId: 'webhook-gateway',
    requiredBooks: 2,
  },
  'memory-vault': {
    skillId: 'clawville-memory',
    name: 'Memory & Knowledge',
    description: 'RAG pipelines, vector databases, text embeddings, and semantic search',
    category: 'Memory & Knowledge',
    buildingId: 'memory-vault',
    requiredBooks: 2,
  },
  'skill-forge': {
    skillId: 'clawville-code',
    name: 'Code & Development',
    description: 'Code generation, debugging, testing, git workflows, and containerized dev',
    category: 'Code & Development',
    buildingId: 'skill-forge',
    requiredBooks: 2,
  },
  'channel-bridge': {
    skillId: 'clawville-comms',
    name: 'Communication',
    description: 'Email automation, Slack, Discord, Telegram bots, and multi-channel messaging',
    category: 'Communication',
    buildingId: 'channel-bridge',
    requiredBooks: 2,
  },
  'tool-workshop': {
    skillId: 'clawville-tools',
    name: 'Tool Use & MCP',
    description: 'Function calling, MCP servers, tool chains, agentic loops, and custom tools',
    category: 'Tool Use & MCP',
    buildingId: 'tool-workshop',
    requiredBooks: 2,
  },
  'canvas-studio': {
    skillId: 'clawville-data',
    name: 'Data & Analytics',
    description: 'SQL queries, data pipelines, web scraping, analytics, and data processing',
    category: 'Data & Analytics',
    buildingId: 'canvas-studio',
    requiredBooks: 2,
  },
  'voice-tower': {
    skillId: 'clawville-research',
    name: 'Research & Analysis',
    description: 'Web search APIs, fact-checking, summarization, and research automation',
    category: 'Research & Analysis',
    buildingId: 'voice-tower',
    requiredBooks: 2,
  },
  'security-fortress': {
    skillId: 'clawville-crypto',
    name: 'Crypto & Web3',
    description: 'Solana development, wallets, DeFi protocols, smart contracts, and on-chain data',
    category: 'Crypto & Web3',
    buildingId: 'security-fortress',
    requiredBooks: 2,
  },
  'config-citadel': {
    skillId: 'clawville-business',
    name: 'Business & Productivity',
    description: 'Project management APIs, invoicing, document automation, and deployment config',
    category: 'Business & Productivity',
    buildingId: 'config-citadel',
    requiredBooks: 2,
  },
};
