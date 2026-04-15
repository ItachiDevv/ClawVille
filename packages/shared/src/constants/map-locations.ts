import type { MapLocation } from '../types/location';

// Building zones derived from tilemap-data buildingZones (160x160 grid, 32px tiles = 5120x5120 world)
// Pixel coords = tile coords * 32, dimensions = tile dims * 32
// 10 OpenClaw integration-themed sea landmarks arranged in 4 neighborhood clusters
//
// Development Quarter (North): canvas-studio, skill-forge, tool-workshop
// Communications Hub (East):   channel-bridge, webhook-gateway, voice-tower
// Infrastructure District (South): cron-hub, config-citadel, security-fortress
// Knowledge Center (NW solo):  memory-vault
export const MAP_LOCATIONS: MapLocation[] = [
  // === Development Quarter (North) ===
  {
    id: 'canvas-studio',
    name: 'Biolume Studio',
    description: 'Query SQL, build data pipelines, scrape the web, and process analytics.',
    icon: '🎨',
    positionX: 2304, // tile x=72 * 32
    positionY: 896,  // tile y=28 * 32
    width: 320,      // 10 tiles * 32
    height: 320,     // 10 tiles * 32
  },
  {
    id: 'skill-forge',
    name: 'Hydrothermal Forge',
    description: 'Practice code generation, debugging, testing, and git workflows.',
    icon: '🌋',
    positionX: 2816, // tile x=88 * 32
    positionY: 896,  // tile y=28 * 32
    width: 320,      // 10 tiles * 32
    height: 320,     // 10 tiles * 32
  },
  {
    id: 'tool-workshop',
    name: 'Salvage Workshop',
    description: 'Build function calling, MCP servers, tool chains, and agentic loops.',
    icon: '⚓',
    positionX: 2560, // tile x=80 * 32
    positionY: 1344, // tile y=42 * 32
    width: 320,      // 10 tiles * 32
    height: 320,     // 10 tiles * 32
  },
  // === Communications Hub (East) ===
  {
    id: 'channel-bridge',
    name: 'Coral Bridge',
    description: 'Connect via Slack, Discord, Telegram, email, and multi-channel messaging.',
    icon: '🪸',
    positionX: 3904, // tile x=122 * 32
    positionY: 2304, // tile y=72 * 32
    width: 320,      // 10 tiles * 32
    height: 320,     // 10 tiles * 32
  },
  {
    id: 'webhook-gateway',
    name: 'Current Gateway',
    description: 'Master REST APIs, GraphQL, webhooks, OAuth, and integrations.',
    icon: '🌊',
    positionX: 3904, // tile x=122 * 32
    positionY: 2816, // tile y=88 * 32
    width: 320,      // 10 tiles * 32
    height: 320,     // 10 tiles * 32
  },
  {
    id: 'voice-tower',
    name: 'Echo Spire',
    description: 'Search the web, verify facts, summarize documents, and run research.',
    icon: '🐋',
    positionX: 3456, // tile x=108 * 32
    positionY: 2560, // tile y=80 * 32
    width: 320,      // 10 tiles * 32
    height: 320,     // 10 tiles * 32
  },
  // === Infrastructure District (South) ===
  {
    id: 'cron-hub',
    name: 'Tide Clock Grotto',
    description: 'Learn automation, cron jobs, task queues, and workflow orchestration.',
    icon: '🐚',
    positionX: 2304, // tile x=72 * 32
    positionY: 3840, // tile y=120 * 32
    width: 320,      // 10 tiles * 32
    height: 320,     // 10 tiles * 32
  },
  {
    id: 'config-citadel',
    name: 'Nautilus Citadel',
    description: 'Manage projects, invoices, documents, scheduling, and deployments.',
    icon: '🐙',
    positionX: 2816, // tile x=88 * 32
    positionY: 3840, // tile y=120 * 32
    width: 320,      // 10 tiles * 32
    height: 320,     // 10 tiles * 32
  },
  {
    id: 'security-fortress',
    name: 'Shell Fortress',
    description: 'Explore Solana, wallets, DeFi protocols, and smart contracts.',
    icon: '🛡️',
    positionX: 2560, // tile x=80 * 32
    positionY: 3392, // tile y=106 * 32
    width: 320,      // 10 tiles * 32
    height: 320,     // 10 tiles * 32
  },
  // === Knowledge Center (NW solo) ===
  {
    id: 'memory-vault',
    name: 'Abyssal Vault',
    description: 'Study RAG pipelines, vector databases, embeddings, and context management.',
    icon: '🧠',
    positionX: 1344, // tile x=42 * 32
    positionY: 896,  // tile y=28 * 32
    width: 320,      // 10 tiles * 32
    height: 320,     // 10 tiles * 32
  },
];

export const LOCATION_IDS = MAP_LOCATIONS.map((l) => l.id);
