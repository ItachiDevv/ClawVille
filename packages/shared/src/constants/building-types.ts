/** Buildings that offer services (knowledge, tools, etc.) */
export const SHOP_BUILDINGS = [
  'cron-hub',
  'webhook-gateway',
  'memory-vault',
  'skill-forge',
  'tool-workshop',
  'canvas-studio',
  'config-citadel',
] as const;

export type ShopBuildingId = (typeof SHOP_BUILDINGS)[number];

/** Check if a building is a shop (has items for sale) */
export function isShopBuilding(buildingId: string): boolean {
  return (SHOP_BUILDINGS as readonly string[]).includes(buildingId);
}

/** OpenClaw-themed building mappings for location agents */
export const BUILDING_OPENCLAW_THEMES: Record<string, { label: string; focus: string }> = {
  'cron-hub': { label: 'Cron Hub', focus: 'cron jobs, task scheduling, and automated agent workflows' },
  'webhook-gateway': { label: 'Webhook Gateway', focus: 'webhooks, HTTP endpoints, and event-driven communication' },
  'memory-vault': { label: 'Memory Vault', focus: 'memory systems, LanceDB vectors, and knowledge retrieval' },
  'skill-forge': { label: 'Skill Forge', focus: 'skill creation, ClawHub marketplace, and agent capabilities' },
  'channel-bridge': { label: 'Channel Bridge', focus: 'multi-channel messaging across Discord, Telegram, and Twitter' },
  'tool-workshop': { label: 'Tool Workshop', focus: 'tool and plugin development for AI agents' },
  'canvas-studio': { label: 'Canvas Studio', focus: 'live canvas visualization and data rendering' },
  'voice-tower': { label: 'Voice Tower', focus: 'voice and speech integration for agents' },
  'security-fortress': { label: 'Security Fortress', focus: 'security, permissions, and access control' },
  'config-citadel': { label: 'Config Citadel', focus: 'configuration, deployment, and environment management' },
};
