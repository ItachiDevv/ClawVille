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

/** OpenClaw sea-themed building mappings for location agents */
export const BUILDING_OPENCLAW_THEMES: Record<string, { label: string; focus: string }> = {
  'cron-hub': { label: 'Tide Clock Grotto', focus: 'cron jobs, task scheduling, and automated agent workflows' },
  'webhook-gateway': { label: 'Current Gateway', focus: 'webhooks, HTTP endpoints, and event-driven communication' },
  'memory-vault': { label: 'Abyssal Vault', focus: 'memory systems, LanceDB vectors, and knowledge retrieval' },
  'skill-forge': { label: 'Hydrothermal Forge', focus: 'skill creation, ClawHub marketplace, and agent capabilities' },
  'channel-bridge': { label: 'Coral Bridge', focus: 'multi-channel messaging across Discord, Telegram, and Twitter' },
  'tool-workshop': { label: 'Salvage Workshop', focus: 'tool and plugin development for AI agents' },
  'canvas-studio': { label: 'Biolume Studio', focus: 'live canvas visualization and data rendering' },
  'voice-tower': { label: 'Echo Spire', focus: 'voice and speech integration for agents' },
  'security-fortress': { label: 'Shell Fortress', focus: 'security, permissions, and access control' },
  'config-citadel': { label: 'Nautilus Citadel', focus: 'configuration, deployment, and environment management' },
};
