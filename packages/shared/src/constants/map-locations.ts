import type { MapLocation } from '../types/location';

// 12-building TRUE CIRCULAR ring layout (Phase 6.0.1 circle revert — 2026-05-17).
// Was briefly a square ring (3 per side) in commit cdc8011 / 1433589; reverted because
// the 4 empty corners created visual rhythm gaps and mismatched the minimap dashed circle.
//
// Circle geometry (160×160 tile grid, center tile 80,80 = world origin):
//   Radius: 72 tiles (= 2304 wu) from center (80,80)
//   Angular spacing: 30° (π/6 rad) between slots — 12 equidistant slots
//   Slot 0 starts at North (top), angles increase clockwise
//   cx_tile = 80 + 72*cos(θ), cy_tile = 80 + 72*sin(θ), θ = -π/2 + slot*(π/6)
//   Zone footprint: 14×14 tiles (448×448 wu)
//   Zone upper-left = (round(cx_tile) − 7, round(cy_tile) − 7)
//
// positionX/Y = zone upper-left tile × 32 (game-space pixel coords).
// IMPORTANT: buildingZones in tilemap-data.ts is the authoritative source for
// building positions in all gameplay + 3D code. positionX/Y here are metadata
// kept in sync for data completeness — do NOT use them for proximity checks.
//
// All 10 original building IDs are PRESERVED — only positions updated.
// Casino (slot 9, W) + claw-arcade (slot 10, WNW) remain adjacent.
//
// Slot assignment (clockwise from North):
//   Slot  0 (  0°/N)   visual-creation    cx=80,  cy=8
//   Slot  1 ( 30°/NNE) code-development   cx=116, cy=18
//   Slot  2 ( 60°/ENE) mcp-tool-use       cx=142, cy=44
//   Slot  3 ( 90°/E)   messaging-channels cx=152, cy=80
//   Slot  4 (120°/ESE) api-integrations   cx=142, cy=116
//   Slot  5 (150°/SSE) app-publishing     cx=116, cy=142
//   Slot  6 (180°/S)   cron-automation    cx=80,  cy=152
//   Slot  7 (210°/SSW) deployment-ops     cx=44,  cy=142
//   Slot  8 (240°/WSW) agent-security     cx=18,  cy=116
//   Slot  9 (270°/W)   casino             cx=8,   cy=80   ← entertainment district
//   Slot 10 (300°/WNW) claw-arcade        cx=18,  cy=44   ← entertainment district (adjacent)
//   Slot 11 (330°/NNW) memory-rag         cx=44,  cy=18
export const MAP_LOCATIONS: MapLocation[] = [
  // Slot 0 — N (cx=80, cy=8) → zone upper-left=(73,1) → posX=73*32=2336, posY=1*32=32
  {
    id: 'visual-creation',
    name: 'Pineapple House',
    description: 'Generate AI images, video, and 3D — and master Photoshop, After Effects, Premiere Pro, DaVinci Resolve, CapCut, Blender, and TouchDesigner.',
    icon: '🎨',
    positionX: 2336,
    positionY: 32,
    width: 448,
    height: 448,
  },
  // Slot 1 — NNE (cx=116, cy=18) → zone upper-left=(109,11) → posX=109*32=3488, posY=11*32=352
  {
    id: 'code-development',
    name: 'Chum Bucket',
    description: 'Practice code generation, debugging, testing, and git workflows.',
    icon: '🌋',
    positionX: 3488,
    positionY: 352,
    width: 448,
    height: 448,
  },
  // Slot 2 — ENE (cx=142, cy=44) → zone upper-left=(135,37) → posX=135*32=4320, posY=37*32=1184
  {
    id: 'mcp-tool-use',
    name: 'Krusty Krab',
    description: 'Build function calling, MCP servers, tool chains, and agentic loops.',
    icon: '⚓',
    positionX: 4320,
    positionY: 1184,
    width: 448,
    height: 448,
  },
  // Slot 3 — E (cx=152, cy=80) → zone upper-left=(145,73) → posX=145*32=4640, posY=73*32=2336
  {
    id: 'messaging-channels',
    name: "Sandy's Treedome",
    description: 'Connect via Slack, Discord, Telegram, email, and multi-channel messaging.',
    icon: '🪸',
    positionX: 4640,
    positionY: 2336,
    width: 448,
    height: 448,
  },
  // Slot 4 — ESE (cx=142, cy=116) → zone upper-left=(135,109) → posX=135*32=4320, posY=109*32=3488
  {
    id: 'api-integrations',
    name: 'Salty Spitoon',
    description: 'Master REST APIs, GraphQL, webhooks, OAuth, and integrations.',
    icon: '🌊',
    positionX: 4320,
    positionY: 3488,
    width: 448,
    height: 448,
  },
  // Slot 5 — SSE (cx=116, cy=142) → zone upper-left=(109,135) → posX=109*32=3488, posY=135*32=4320
  {
    id: 'app-publishing',
    name: 'Boating School',
    description: 'Ship apps to Apple App Store, Google Play, Microsoft Store, Steam, and alt stores. Cross-platform frameworks and code signing.',
    icon: '🐋',
    positionX: 3488,
    positionY: 4320,
    width: 448,
    height: 448,
  },
  // Slot 6 — S (cx=80, cy=152) → zone upper-left=(73,145) → posX=73*32=2336, posY=145*32=4640
  {
    id: 'cron-automation',
    name: 'Downtown Building',
    description: 'Learn automation, cron jobs, task queues, and workflow orchestration.',
    icon: '🐚',
    positionX: 2336,
    positionY: 4640,
    width: 448,
    height: 448,
  },
  // Slot 7 — SSW (cx=44, cy=142) → zone upper-left=(37,135) → posX=37*32=1184, posY=135*32=4320
  {
    id: 'deployment-ops',
    name: 'Lighthouse',
    description: 'Manage agent fleets, blue-green deployments, Docker containers, and observability.',
    icon: '🐙',
    positionX: 1184,
    positionY: 4320,
    width: 448,
    height: 448,
  },
  // Slot 8 — WSW (cx=18, cy=116) → zone upper-left=(11,109) → posX=11*32=352, posY=109*32=3488
  {
    id: 'agent-security',
    name: "Patrick's Rock",
    description: 'Defend against prompt injection, design agent permissions, and threat-model autonomous systems.',
    icon: '🛡️',
    positionX: 352,
    positionY: 3488,
    width: 448,
    height: 448,
  },
  // Slot 9 — W (cx=8, cy=80) → zone upper-left=(1,73) → posX=1*32=32, posY=73*32=2336
  // Entertainment district: casino (slot 9) + claw-arcade (slot 10) are adjacent.
  {
    id: 'casino',
    name: 'Predictive Gaming Cove',
    description: 'Try your luck at the slot machines. ClawTokens welcome — real money coming soon.',
    icon: '🎰',
    positionX: 32,
    positionY: 2336,
    width: 448,
    height: 448,
  },
  // Slot 10 — WNW (cx=18, cy=44) → zone upper-left=(11,37) → posX=11*32=352, posY=37*32=1184
  // Entertainment district (adjacent to casino at slot 9).
  {
    id: 'claw-arcade',
    name: 'Arcade City',
    description: 'Skill-based crane game and arcade fun. Phase 6.3 coming soon.',
    icon: '🕹️',
    positionX: 352,
    positionY: 1184,
    width: 448,
    height: 448,
  },
  // Slot 11 — NNW (cx=44, cy=18) → zone upper-left=(37,11) → posX=37*32=1184, posY=11*32=352
  {
    id: 'memory-rag',
    name: "Squidward's House",
    description: 'Study RAG pipelines, vector databases, embeddings, and context management.',
    icon: '🧠',
    positionX: 1184,
    positionY: 352,
    width: 448,
    height: 448,
  },
];

export const LOCATION_IDS = MAP_LOCATIONS.map((l) => l.id);
