import type { MapLocation } from '../types/location';

// Building zones derived from tilemap-data buildingZones (160x160 grid, 32px tiles = 5120x5120 world)
// Pixel coords = tile coords * 32, dimensions = tile dims * 32
// 10 OpenClaw integration-themed sea landmarks arranged in 4 neighborhood clusters
//
// Development Quarter (North): canvas-studio, skill-forge, tool-workshop
// Communications Hub (East):   channel-bridge, webhook-gateway, voice-tower
// Infrastructure District (South): cron-hub, config-citadel, security-fortress
// Knowledge Center (NW solo):  memory-vault
//
// 2026-04-16 proportions pass: footprint expanded from 10×10 to 14×14 tiles (320→448 px).
// positionX/Y adjusted by -64px (-2 tiles) to keep building centers at the same world coords.
export const MAP_LOCATIONS: MapLocation[] = [
  // === Development Quarter (North) ===
  {
    id: 'canvas-studio',
    name: 'Biolume Studio',
    description: 'Query SQL, build data pipelines, scrape the web, and process analytics.',
    icon: '🎨',
    positionX: 2240, // tile x=70 * 32  (center tile 77 unchanged)
    positionY: 832,  // tile y=26 * 32
    width: 448,      // 14 tiles * 32
    height: 448,     // 14 tiles * 32
  },
  {
    id: 'skill-forge',
    name: 'Hydrothermal Forge',
    description: 'Practice code generation, debugging, testing, and git workflows.',
    icon: '🌋',
    positionX: 2752, // tile x=86 * 32  (center tile 93 unchanged)
    positionY: 832,  // tile y=26 * 32
    width: 448,      // 14 tiles * 32
    height: 448,     // 14 tiles * 32
  },
  {
    id: 'tool-workshop',
    name: 'Salvage Workshop',
    description: 'Build function calling, MCP servers, tool chains, and agentic loops.',
    icon: '⚓',
    positionX: 2496, // tile x=78 * 32  (center tile 85 unchanged)
    positionY: 1280, // tile y=40 * 32
    width: 448,      // 14 tiles * 32
    height: 448,     // 14 tiles * 32
  },
  // === Communications Hub (East) ===
  {
    id: 'channel-bridge',
    name: 'Coral Bridge',
    description: 'Connect via Slack, Discord, Telegram, email, and multi-channel messaging.',
    icon: '🪸',
    positionX: 3840, // tile x=120 * 32  (center tile 127 unchanged)
    positionY: 2240, // tile y=70 * 32
    width: 448,      // 14 tiles * 32
    height: 448,     // 14 tiles * 32
  },
  {
    id: 'webhook-gateway',
    name: 'Current Gateway',
    description: 'Master REST APIs, GraphQL, webhooks, OAuth, and integrations.',
    icon: '🌊',
    positionX: 3840, // tile x=120 * 32  (center tile 127 unchanged)
    positionY: 2752, // tile y=86 * 32
    width: 448,      // 14 tiles * 32
    height: 448,     // 14 tiles * 32
  },
  {
    id: 'voice-tower',
    name: 'Echo Spire',
    description: 'Search the web, verify facts, summarize documents, and run research.',
    icon: '🐋',
    positionX: 3392, // tile x=106 * 32  (center tile 113 unchanged)
    positionY: 2496, // tile y=78 * 32
    width: 448,      // 14 tiles * 32
    height: 448,     // 14 tiles * 32
  },
  // === Infrastructure District (South) ===
  {
    id: 'cron-hub',
    name: 'Tide Clock Grotto',
    description: 'Learn automation, cron jobs, task queues, and workflow orchestration.',
    icon: '🐚',
    positionX: 2240, // tile x=70 * 32  (center tile 77 unchanged)
    positionY: 3776, // tile y=118 * 32
    width: 448,      // 14 tiles * 32
    height: 448,     // 14 tiles * 32
  },
  {
    id: 'config-citadel',
    name: 'Nautilus Citadel',
    description: 'Manage projects, invoices, documents, scheduling, and deployments.',
    icon: '🐙',
    positionX: 2752, // tile x=86 * 32  (center tile 93 unchanged)
    positionY: 3776, // tile y=118 * 32
    width: 448,      // 14 tiles * 32
    height: 448,     // 14 tiles * 32
  },
  {
    id: 'security-fortress',
    name: 'Shell Fortress',
    description: 'Explore Solana, wallets, DeFi protocols, and smart contracts.',
    icon: '🛡️',
    positionX: 2496, // tile x=78 * 32  (center tile 85 unchanged)
    positionY: 3328, // tile y=104 * 32
    width: 448,      // 14 tiles * 32
    height: 448,     // 14 tiles * 32
  },
  // === Knowledge Center (NW solo) ===
  {
    id: 'memory-vault',
    name: 'Abyssal Vault',
    description: 'Study RAG pipelines, vector databases, embeddings, and context management.',
    icon: '🧠',
    positionX: 1280, // tile x=40 * 32  (center tile 47 unchanged)
    positionY: 832,  // tile y=26 * 32
    width: 448,      // 14 tiles * 32
    height: 448,     // 14 tiles * 32
  },
];

export const LOCATION_IDS = MAP_LOCATIONS.map((l) => l.id);
