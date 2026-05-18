import type { MapLocation } from '../types/location';

// 12-building square ring layout (3 buildings per side, corners empty as plaza space).
// Phase 6.0.1 (2026-05-17): expanded from 10-building circular ring to 12-building square.
// Two new buildings: casino (E2 slot) and claw-arcade (S3 slot).
//
// Square ring geometry (160×160 tile grid, center tile 80,80 = world origin):
//   Side distance from center: 72 tiles (= 2304 wu)
//   Slot centers along each side: center ± 0 and ± 48 tiles
//   Zone footprint: 14×14 tiles (448×448 wu)
//
// positionX/Y = zone upper-left tile × 32 (game-space pixel coords).
// IMPORTANT: buildingZones in tilemap-data.ts is the authoritative source for
// building positions in all gameplay + 3D code. positionX/Y here are metadata
// kept in sync for data completeness — do NOT use them for proximity checks.
//
// All 10 existing building IDs are PRESERVED — only positions updated to match
// new square ring slots. User data (inventory, quests, leaderboard events)
// references building IDs by string; geometry is repositioned safely.
export const MAP_LOCATIONS: MapLocation[] = [
  // === NORTH SIDE ===
  // N1 center=(32,8)  zone upper-left=(25,1) → 25*32=800, 1*32=32
  {
    id: 'visual-creation',
    name: 'Pineapple House',
    description: 'Generate AI images, video, and 3D — and master Photoshop, After Effects, Premiere Pro, DaVinci Resolve, CapCut, Blender, and TouchDesigner.',
    icon: '🎨',
    positionX: 800,
    positionY: 32,
    width: 448,
    height: 448,
  },
  // N2 center=(80,8)  zone upper-left=(73,1) → 73*32=2336, 1*32=32
  {
    id: 'memory-rag',
    name: "Squidward's House",
    description: 'Study RAG pipelines, vector databases, embeddings, and context management.',
    icon: '🧠',
    positionX: 2336,
    positionY: 32,
    width: 448,
    height: 448,
  },
  // N3 center=(128,8) zone upper-left=(121,1) → 121*32=3872, 1*32=32
  {
    id: 'api-integrations',
    name: 'Salty Spitoon',
    description: 'Master REST APIs, GraphQL, webhooks, OAuth, and integrations.',
    icon: '🌊',
    positionX: 3872,
    positionY: 32,
    width: 448,
    height: 448,
  },

  // === EAST SIDE ===
  // E1 center=(152,32) zone upper-left=(145,25) → 145*32=4640, 25*32=800
  {
    id: 'cron-automation',
    name: 'Downtown Building',
    description: 'Learn automation, cron jobs, task queues, and workflow orchestration.',
    icon: '🐚',
    positionX: 4640,
    positionY: 800,
    width: 448,
    height: 448,
  },
  // E2 center=(152,80) zone upper-left=(145,73) → 145*32=4640, 73*32=2336
  {
    id: 'casino',
    name: 'Pyramid Casino',
    description: 'Try your luck at the slot machines. ClawTokens welcome — real money coming soon.',
    icon: '🎰',
    positionX: 4640,
    positionY: 2336,
    width: 448,
    height: 448,
  },
  // E3 center=(152,128) zone upper-left=(145,121) → 145*32=4640, 121*32=3872
  {
    id: 'app-publishing',
    name: 'Boating School',
    description: 'Ship apps to Apple App Store, Google Play, Microsoft Store, Steam, and alt stores. Cross-platform frameworks and code signing.',
    icon: '🐋',
    positionX: 4640,
    positionY: 3872,
    width: 448,
    height: 448,
  },

  // === SOUTH SIDE ===
  // S1 center=(32,152) zone upper-left=(25,145) → 25*32=800, 145*32=4640
  {
    id: 'deployment-ops',
    name: 'Lighthouse',
    description: 'Manage agent fleets, blue-green deployments, Docker containers, and observability.',
    icon: '🐙',
    positionX: 800,
    positionY: 4640,
    width: 448,
    height: 448,
  },
  // S2 center=(80,152) zone upper-left=(73,145) → 73*32=2336, 145*32=4640
  {
    id: 'agent-security',
    name: "Patrick's Rock",
    description: 'Defend against prompt injection, design agent permissions, and threat-model autonomous systems.',
    icon: '🛡️',
    positionX: 2336,
    positionY: 4640,
    width: 448,
    height: 448,
  },
  // S3 center=(128,152) zone upper-left=(121,145) → 121*32=3872, 145*32=4640
  {
    id: 'claw-arcade',
    name: 'Arcade City',
    description: 'Skill-based crane game and arcade fun. Phase 6.3 coming soon.',
    icon: '🕹️',
    positionX: 3872,
    positionY: 4640,
    width: 448,
    height: 448,
  },

  // === WEST SIDE ===
  // W1 center=(8,32)  zone upper-left=(1,25) → 1*32=32, 25*32=800
  {
    id: 'messaging-channels',
    name: "Sandy's Treedome",
    description: 'Connect via Slack, Discord, Telegram, email, and multi-channel messaging.',
    icon: '🪸',
    positionX: 32,
    positionY: 800,
    width: 448,
    height: 448,
  },
  // W2 center=(8,80)  zone upper-left=(1,73) → 1*32=32, 73*32=2336
  {
    id: 'mcp-tool-use',
    name: 'Krusty Krab',
    description: 'Build function calling, MCP servers, tool chains, and agentic loops.',
    icon: '⚓',
    positionX: 32,
    positionY: 2336,
    width: 448,
    height: 448,
  },
  // W3 center=(8,128) zone upper-left=(1,121) → 1*32=32, 121*32=3872
  {
    id: 'code-development',
    name: 'Chum Bucket',
    description: 'Practice code generation, debugging, testing, and git workflows.',
    icon: '🌋',
    positionX: 32,
    positionY: 3872,
    width: 448,
    height: 448,
  },
];

export const LOCATION_IDS = MAP_LOCATIONS.map((l) => l.id);
