import type { MapLocation } from '../types/location';

// 12-building TRUE CIRCULAR ring layout — Phase 6.2 (2026-05-18).
// Grid expanded 240→360 tiles; ring expanded R=100→160 tiles.
//
// Circle geometry (360×360 tile grid, center tile 180,180 = world origin):
//   Radius: 160 tiles (= 5120 wu) from center (180,180)
//   Angular spacing: 30° (π/6 rad) between slots — 12 equidistant slots
//   Slot 0 starts at North (top), angles increase clockwise
//   cx_tile = 180 + 160*cos(θ), cy_tile = 180 + 160*sin(θ), θ = -π/2 + slot*(π/6)
//   Zone footprint: 14×14 tiles (448×448 wu)
//   Zone upper-left = (round(cx_tile) − 7, round(cy_tile) − 7)
//
// positionX/Y = zone upper-left tile × 32 (game-space pixel coords).
// IMPORTANT: buildingZones in tilemap-data.ts is the authoritative source for
// building positions in all gameplay + 3D code. positionX/Y here are metadata
// kept in sync for data completeness — do NOT use them for proximity checks.
//
// All 12 building IDs are PRESERVED — only positions updated.
// Casino (slot 9, W) adjacent to Patrick's Rock (slot 10, WNW) — preserved from Phase 6.1.
//
// Slot assignment (clockwise from North):
//   Slot  0 (  0°/N)   visual-creation    cx=180, cy=20   zone=(173,13)  posX=5536,  posY=416
//   Slot  1 ( 30°/NNE) code-development   cx=260, cy=41   zone=(253,34)  posX=8096,  posY=1088
//   Slot  2 ( 60°/ENE) mcp-tool-use       cx=319, cy=100  zone=(312,93)  posX=9984,  posY=2976
//   Slot  3 ( 90°/E)   messaging-channels cx=340, cy=180  zone=(333,173) posX=10656, posY=5536
//   Slot  4 (120°/ESE) api-integrations   cx=319, cy=260  zone=(312,253) posX=9984,  posY=8096
//   Slot  5 (150°/SSE) app-publishing     cx=260, cy=319  zone=(253,312) posX=8096,  posY=9984
//   Slot  6 (180°/S)   cron-automation    cx=180, cy=340  zone=(173,333) posX=5536,  posY=10656
//   Slot  7 (210°/SSW) deployment-ops     cx=100, cy=319  zone=(93,312)  posX=2976,  posY=9984
//   Slot  8 (240°/WSW) claw-arcade        cx=41,  cy=260  zone=(34,253)  posX=1088,  posY=8096
//   Slot  9 (270°/W)   casino             cx=20,  cy=180  zone=(13,173)  posX=416,   posY=5536  ← entertainment
//   Slot 10 (300°/WNW) agent-security     cx=41,  cy=100  zone=(34,93)   posX=1088,  posY=2976
//   Slot 11 (330°/NNW) memory-rag         cx=100, cy=41   zone=(93,34)   posX=2976,  posY=1088
export const MAP_LOCATIONS: MapLocation[] = [
  // Slot 0 — N (cx=180, cy=20) → zone(173,13) → posX=173*32=5536, posY=13*32=416
  {
    id: 'visual-creation',
    name: 'Pineapple House',
    description: 'Generate AI images, video, and 3D — and master Photoshop, After Effects, Premiere Pro, DaVinci Resolve, CapCut, Blender, and TouchDesigner.',
    icon: '🎨',
    positionX: 5536,
    positionY: 416,
    width: 448,
    height: 448,
  },
  // Slot 1 — NNE (cx=260, cy=41) → zone(253,34) → posX=253*32=8096, posY=34*32=1088
  {
    id: 'code-development',
    name: 'Chum Bucket',
    description: 'Practice code generation, debugging, testing, and git workflows.',
    icon: '🌋',
    positionX: 8096,
    positionY: 1088,
    width: 448,
    height: 448,
  },
  // Slot 2 — ENE (cx=319, cy=100) → zone(312,93) → posX=312*32=9984, posY=93*32=2976
  {
    id: 'mcp-tool-use',
    name: 'Krusty Krab',
    description: 'Build function calling, MCP servers, tool chains, and agentic loops.',
    icon: '⚓',
    positionX: 9984,
    positionY: 2976,
    width: 448,
    height: 448,
  },
  // Slot 3 — E (cx=340, cy=180) → zone(333,173) → posX=333*32=10656, posY=173*32=5536
  {
    id: 'messaging-channels',
    name: "Sandy's Treedome",
    description: 'Connect via Slack, Discord, Telegram, email, and multi-channel messaging.',
    icon: '🪸',
    positionX: 10656,
    positionY: 5536,
    width: 448,
    height: 448,
  },
  // Slot 4 — ESE (cx=319, cy=260) → zone(312,253) → posX=312*32=9984, posY=253*32=8096
  {
    id: 'api-integrations',
    name: 'Salty Spitoon',
    description: 'Master REST APIs, GraphQL, webhooks, OAuth, and integrations.',
    icon: '🌊',
    positionX: 9984,
    positionY: 8096,
    width: 448,
    height: 448,
  },
  // Slot 5 — SSE (cx=260, cy=319) → zone(253,312) → posX=253*32=8096, posY=312*32=9984
  {
    id: 'app-publishing',
    name: 'Boating School',
    description: 'Ship apps to Apple App Store, Google Play, Microsoft Store, Steam, and alt stores. Cross-platform frameworks and code signing.',
    icon: '🐋',
    positionX: 8096,
    positionY: 9984,
    width: 448,
    height: 448,
  },
  // Slot 6 — S (cx=180, cy=340) → zone(173,333) → posX=173*32=5536, posY=333*32=10656
  {
    id: 'cron-automation',
    name: 'Downtown Building',
    description: 'Learn automation, cron jobs, task queues, and workflow orchestration.',
    icon: '🐚',
    positionX: 5536,
    positionY: 10656,
    width: 448,
    height: 448,
  },
  // Slot 7 — SSW (cx=100, cy=319) → zone(93,312) → posX=93*32=2976, posY=312*32=9984
  {
    id: 'deployment-ops',
    name: 'Lighthouse',
    description: 'Manage agent fleets, blue-green deployments, Docker containers, and observability.',
    icon: '🐙',
    positionX: 2976,
    positionY: 9984,
    width: 448,
    height: 448,
  },
  // Slot 8 — WSW (cx=41, cy=260) → zone(34,253) → posX=34*32=1088, posY=253*32=8096
  // Phase 6.1 swap preserved: claw-arcade at WSW. Casino is at W (2 slots away).
  {
    id: 'claw-arcade',
    name: 'Arcade City',
    description: 'Skill-based crane game and arcade fun. Phase 6.3 coming soon.',
    icon: '🕹️',
    positionX: 1088,
    positionY: 8096,
    width: 448,
    height: 448,
  },
  // Slot 9 — W (cx=20, cy=180) → zone(13,173) → posX=13*32=416, posY=173*32=5536
  // Entertainment district anchor. Adjacent to Patrick's Rock (slot 10, WNW).
  {
    id: 'casino',
    name: 'Predictive Gaming Cove',
    description: 'Try your luck at the slot machines. ClawTokens welcome — real money coming soon.',
    icon: '🎰',
    positionX: 416,
    positionY: 5536,
    width: 448,
    height: 448,
  },
  // Slot 10 — WNW (cx=41, cy=100) → zone(34,93) → posX=34*32=1088, posY=93*32=2976
  // Phase 6.1 swap preserved: agent-security at WNW. Adjacent to casino (slot 9, W).
  {
    id: 'agent-security',
    name: "Patrick's Rock",
    description: 'Defend against prompt injection, design agent permissions, and threat-model autonomous systems.',
    icon: '🛡️',
    positionX: 1088,
    positionY: 2976,
    width: 448,
    height: 448,
  },
  // Slot 11 — NNW (cx=100, cy=41) → zone(93,34) → posX=93*32=2976, posY=34*32=1088
  {
    id: 'memory-rag',
    name: "Squidward's House",
    description: 'Study RAG pipelines, vector databases, embeddings, and context management.',
    icon: '🧠',
    positionX: 2976,
    positionY: 1088,
    width: 448,
    height: 448,
  },
];

export const LOCATION_IDS = MAP_LOCATIONS.map((l) => l.id);
