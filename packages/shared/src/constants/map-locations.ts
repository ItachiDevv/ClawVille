import type { MapLocation } from '../types/location';

// 12-building TRUE CIRCULAR ring layout — Phase 6.1 (2026-05-18).
// Grid expanded 160→240 tiles; ring expanded R=72→100 tiles for more breathing room.
//
// Circle geometry (240×240 tile grid, center tile 120,120 = world origin):
//   Radius: 100 tiles (= 3200 wu) from center (120,120)
//   Angular spacing: 30° (π/6 rad) between slots — 12 equidistant slots
//   Slot 0 starts at North (top), angles increase clockwise
//   cx_tile = 120 + 100*cos(θ), cy_tile = 120 + 100*sin(θ), θ = -π/2 + slot*(π/6)
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
//   Slot  0 (  0°/N)   visual-creation    cx=120, cy=20   zone=(113,13)  posX=3616, posY=416
//   Slot  1 ( 30°/NNE) code-development   cx=170, cy=33   zone=(163,26)  posX=5216, posY=832
//   Slot  2 ( 60°/ENE) mcp-tool-use       cx=207, cy=70   zone=(200,63)  posX=6400, posY=2016
//   Slot  3 ( 90°/E)   messaging-channels cx=220, cy=120  zone=(213,113) posX=6816, posY=3616
//   Slot  4 (120°/ESE) api-integrations   cx=207, cy=170  zone=(200,163) posX=6400, posY=5216
//   Slot  5 (150°/SSE) app-publishing     cx=170, cy=207  zone=(163,200) posX=5216, posY=6400
//   Slot  6 (180°/S)   cron-automation    cx=120, cy=220  zone=(113,213) posX=3616, posY=6816
//   Slot  7 (210°/SSW) deployment-ops     cx=70,  cy=207  zone=(63,200)  posX=2016, posY=6400
//   Slot  8 (240°/WSW) agent-security     cx=33,  cy=170  zone=(26,163)  posX=832,  posY=5216
//   Slot  9 (270°/W)   casino             cx=20,  cy=120  zone=(13,113)  posX=416,  posY=3616  ← entertainment
//   Slot 10 (300°/WNW) claw-arcade        cx=33,  cy=70   zone=(26,63)   posX=832,  posY=2016  ← adjacent
//   Slot 11 (330°/NNW) memory-rag         cx=70,  cy=33   zone=(63,26)   posX=2016, posY=832
export const MAP_LOCATIONS: MapLocation[] = [
  // Slot 0 — N (cx=120, cy=20) → zone(113,13) → posX=113*32=3616, posY=13*32=416
  {
    id: 'visual-creation',
    name: 'Pineapple House',
    description: 'Generate AI images, video, and 3D — and master Photoshop, After Effects, Premiere Pro, DaVinci Resolve, CapCut, Blender, and TouchDesigner.',
    icon: '🎨',
    positionX: 3616,
    positionY: 416,
    width: 448,
    height: 448,
  },
  // Slot 1 — NNE (cx=170, cy=33) → zone(163,26) → posX=163*32=5216, posY=26*32=832
  {
    id: 'code-development',
    name: 'Chum Bucket',
    description: 'Practice code generation, debugging, testing, and git workflows.',
    icon: '🌋',
    positionX: 5216,
    positionY: 832,
    width: 448,
    height: 448,
  },
  // Slot 2 — ENE (cx=207, cy=70) → zone(200,63) → posX=200*32=6400, posY=63*32=2016
  {
    id: 'mcp-tool-use',
    name: 'Krusty Krab',
    description: 'Build function calling, MCP servers, tool chains, and agentic loops.',
    icon: '⚓',
    positionX: 6400,
    positionY: 2016,
    width: 448,
    height: 448,
  },
  // Slot 3 — E (cx=220, cy=120) → zone(213,113) → posX=213*32=6816, posY=113*32=3616
  {
    id: 'messaging-channels',
    name: "Sandy's Treedome",
    description: 'Connect via Slack, Discord, Telegram, email, and multi-channel messaging.',
    icon: '🪸',
    positionX: 6816,
    positionY: 3616,
    width: 448,
    height: 448,
  },
  // Slot 4 — ESE (cx=207, cy=170) → zone(200,163) → posX=200*32=6400, posY=163*32=5216
  {
    id: 'api-integrations',
    name: 'Salty Spitoon',
    description: 'Master REST APIs, GraphQL, webhooks, OAuth, and integrations.',
    icon: '🌊',
    positionX: 6400,
    positionY: 5216,
    width: 448,
    height: 448,
  },
  // Slot 5 — SSE (cx=170, cy=207) → zone(163,200) → posX=163*32=5216, posY=200*32=6400
  {
    id: 'app-publishing',
    name: 'Boating School',
    description: 'Ship apps to Apple App Store, Google Play, Microsoft Store, Steam, and alt stores. Cross-platform frameworks and code signing.',
    icon: '🐋',
    positionX: 5216,
    positionY: 6400,
    width: 448,
    height: 448,
  },
  // Slot 6 — S (cx=120, cy=220) → zone(113,213) → posX=113*32=3616, posY=213*32=6816
  {
    id: 'cron-automation',
    name: 'Downtown Building',
    description: 'Learn automation, cron jobs, task queues, and workflow orchestration.',
    icon: '🐚',
    positionX: 3616,
    positionY: 6816,
    width: 448,
    height: 448,
  },
  // Slot 7 — SSW (cx=70, cy=207) → zone(63,200) → posX=63*32=2016, posY=200*32=6400
  {
    id: 'deployment-ops',
    name: 'Lighthouse',
    description: 'Manage agent fleets, blue-green deployments, Docker containers, and observability.',
    icon: '🐙',
    positionX: 2016,
    positionY: 6400,
    width: 448,
    height: 448,
  },
  // Slot 8 — WSW (cx=33, cy=170) → zone(26,163) → posX=26*32=832, posY=163*32=5216
  {
    id: 'agent-security',
    name: "Patrick's Rock",
    description: 'Defend against prompt injection, design agent permissions, and threat-model autonomous systems.',
    icon: '🛡️',
    positionX: 832,
    positionY: 5216,
    width: 448,
    height: 448,
  },
  // Slot 9 — W (cx=20, cy=120) → zone(13,113) → posX=13*32=416, posY=113*32=3616
  // Entertainment district: casino (slot 9) + claw-arcade (slot 10) are adjacent.
  {
    id: 'casino',
    name: 'Predictive Gaming Cove',
    description: 'Try your luck at the slot machines. ClawTokens welcome — real money coming soon.',
    icon: '🎰',
    positionX: 416,
    positionY: 3616,
    width: 448,
    height: 448,
  },
  // Slot 10 — WNW (cx=33, cy=70) → zone(26,63) → posX=26*32=832, posY=63*32=2016
  // Entertainment district (adjacent to casino at slot 9).
  {
    id: 'claw-arcade',
    name: 'Arcade City',
    description: 'Skill-based crane game and arcade fun. Phase 6.3 coming soon.',
    icon: '🕹️',
    positionX: 832,
    positionY: 2016,
    width: 448,
    height: 448,
  },
  // Slot 11 — NNW (cx=70, cy=33) → zone(63,26) → posX=63*32=2016, posY=26*32=832
  {
    id: 'memory-rag',
    name: "Squidward's House",
    description: 'Study RAG pipelines, vector databases, embeddings, and context management.',
    icon: '🧠',
    positionX: 2016,
    positionY: 832,
    width: 448,
    height: 448,
  },
];

export const LOCATION_IDS = MAP_LOCATIONS.map((l) => l.id);
