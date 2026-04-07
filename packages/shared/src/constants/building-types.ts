/** Buildings that offer services (knowledge, tools, etc.) */
export const SHOP_BUILDINGS = [
  'cron-hub',
  'webhook-gateway',
  'memory-vault',
  'skill-forge',
  'channel-bridge',
  'tool-workshop',
  'canvas-studio',
  'voice-tower',
  'security-fortress',
  'config-citadel',
] as const;

export type ShopBuildingId = (typeof SHOP_BUILDINGS)[number];

/** Check if a building is a shop (has items for sale) */
export function isShopBuilding(buildingId: string): boolean {
  return (SHOP_BUILDINGS as readonly string[]).includes(buildingId);
}

/** Sea-themed building skill categories — 10 domains agents can learn */
export const BUILDING_OPENCLAW_THEMES: Record<string, { label: string; focus: string; category: string }> = {
  'cron-hub': { label: 'Tide Clock Grotto', focus: 'cron jobs, task queues, workflow orchestration, CI/CD pipelines, and scheduled automation', category: 'Automation & Workflows' },
  'webhook-gateway': { label: 'Current Gateway', focus: 'REST APIs, GraphQL, webhooks, OAuth, rate limiting, and system integrations', category: 'APIs & Integrations' },
  'memory-vault': { label: 'Abyssal Vault', focus: 'RAG pipelines, vector databases, text embeddings, semantic search, and context management', category: 'Memory & Knowledge' },
  'skill-forge': { label: 'Hydrothermal Forge', focus: 'code generation, debugging, testing, git workflows, and containerized development', category: 'Code & Development' },
  'channel-bridge': { label: 'Coral Bridge', focus: 'email automation, Slack, Discord, Telegram bots, and multi-channel messaging', category: 'Communication' },
  'tool-workshop': { label: 'Salvage Workshop', focus: 'function calling, MCP servers, tool chains, agentic loops, and custom tool development', category: 'Tool Use & MCP' },
  'canvas-studio': { label: 'Biolume Studio', focus: 'SQL queries, data pipelines, web scraping, analytics, and structured data processing', category: 'Data & Analytics' },
  'voice-tower': { label: 'Echo Spire', focus: 'web search APIs, fact-checking, summarization, structured outputs, and research automation', category: 'Research & Analysis' },
  'security-fortress': { label: 'Shell Fortress', focus: 'Solana development, wallets, DeFi protocols, smart contracts, and on-chain data', category: 'Crypto & Web3' },
  'config-citadel': { label: 'Nautilus Citadel', focus: 'project management APIs, invoicing, document automation, scheduling, and deployment config', category: 'Business & Productivity' },
};
