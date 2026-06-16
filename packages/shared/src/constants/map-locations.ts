import type { MapLocation } from '../types/location';

// 12-building TRUE CIRCULAR ring layout — recentered Phase 0 land (2026-06-15).
// Ring R=130 tiles (4160wu). Grid grew 360→576 tiles; ring footprint unchanged,
// positions recentered for new center tile (288,288). Arc spacing ≈ 2178wu.
//
// Circle geometry (576×576 tile grid, center tile 288,288 = world origin):
//   Radius: 130 tiles (= 4160 wu) from center (288,288)
//   Angular spacing: 30° (π/6 rad) between slots — 12 equidistant slots
//   Slot 0 starts at North (top), angles increase clockwise
//   cx_tile = 288 + 130*cos(θ), cy_tile = 288 + 130*sin(θ), θ = -π/2 + slot*(π/6)
//   Zone footprint: 14×14 tiles (448×448 wu)
//   Zone upper-left = (round(cx_tile) − 7, round(cy_tile) − 7)
//
// positionX/Y = zone upper-left tile × 32 (game-space pixel coords).
// Recentered +3456 px each axis from the old 360-grid (center delta = +108 tiles × 32).
// IMPORTANT: buildingZones in tilemap-data.ts is the authoritative source for
// building positions in all gameplay + 3D code. positionX/Y here are metadata
// kept in sync for data completeness — do NOT use them for proximity checks.
//
// All 12 building IDs are PRESERVED — only positions recentered.
// Cove (slot 9, W) adjacent to Patrick's Rock (slot 10, WNW) — preserved from Phase 6.1.
//
// Slot assignment (clockwise from North):
//   Slot  0 (  0°/N)   visual-creation    cx=288, cy=158  zone=(281,151) posX=8992,  posY=4832
//   Slot  1 ( 30°/NNE) code-development   cx=353, cy=175  zone=(346,168) posX=11072, posY=5376
//   Slot  2 ( 60°/ENE) mcp-tool-use       cx=401, cy=223  zone=(394,216) posX=12608, posY=6912
//   Slot  3 ( 90°/E)   messaging-channels cx=418, cy=288  zone=(411,281) posX=13152, posY=8992
//   Slot  4 (120°/ESE) api-integrations   cx=401, cy=353  zone=(394,346) posX=12608, posY=11072
//   Slot  5 (150°/SSE) app-publishing     cx=353, cy=401  zone=(346,394) posX=11072, posY=12608
//   Slot  6 (180°/S)   cron-automation    cx=288, cy=418  zone=(281,411) posX=8992,  posY=13152
//   Slot  7 (210°/SSW) deployment-ops     cx=223, cy=401  zone=(216,394) posX=6912,  posY=12608
//   Slot  8 (240°/WSW) claw-arcade        cx=175, cy=353  zone=(168,346) posX=5376,  posY=11072
//   Slot  9 (270°/W)   cove             cx=158, cy=288  zone=(151,281) posX=4832,  posY=8992  ← entertainment
//   Slot 10 (300°/WNW) agent-security     cx=175, cy=223  zone=(168,216) posX=5376,  posY=6912
//   Slot 11 (330°/NNW) memory-rag         cx=223, cy=175  zone=(216,168) posX=6912,  posY=5376
export const MAP_LOCATIONS: MapLocation[] = [
  // Slot 0 — N (cx=288, cy=158) → zone(281,151) → posX=281*32=8992, posY=151*32=4832
  {
    id: 'visual-creation',
    name: 'Pineapple House',
    description: 'Generate AI images, video, and 3D — and master Photoshop, After Effects, Premiere Pro, DaVinci Resolve, CapCut, Blender, and TouchDesigner.',
    icon: '🎨',
    positionX: 8992,
    positionY: 4832,
    width: 448,
    height: 448,
  },
  // Slot 1 — NNE (cx=353, cy=175) → zone(346,168) → posX=346*32=11072, posY=168*32=5376
  {
    id: 'code-development',
    name: 'Chum Bucket',
    description: 'Practice code generation, debugging, testing, and git workflows.',
    icon: '🌋',
    positionX: 11072,
    positionY: 5376,
    width: 448,
    height: 448,
  },
  // Slot 2 — ENE (cx=401, cy=223) → zone(394,216) → posX=394*32=12608, posY=216*32=6912
  {
    id: 'mcp-tool-use',
    name: 'Krusty Krab',
    description: 'Build function calling, MCP servers, tool chains, and agentic loops.',
    icon: '⚓',
    positionX: 12608,
    positionY: 6912,
    width: 448,
    height: 448,
  },
  // Slot 3 — E (cx=418, cy=288) → zone(411,281) → posX=411*32=13152, posY=281*32=8992
  {
    id: 'messaging-channels',
    name: "Sandy's Treedome",
    description: 'Connect via Slack, Discord, Telegram, email, and multi-channel messaging.',
    icon: '🪸',
    positionX: 13152,
    positionY: 8992,
    width: 448,
    height: 448,
  },
  // Slot 4 — ESE (cx=401, cy=353) → zone(394,346) → posX=394*32=12608, posY=346*32=11072
  {
    id: 'api-integrations',
    name: 'Salty Spitoon',
    description: 'Master REST APIs, GraphQL, webhooks, OAuth, and integrations.',
    icon: '🌊',
    positionX: 12608,
    positionY: 11072,
    width: 448,
    height: 448,
  },
  // Slot 5 — SSE (cx=353, cy=401) → zone(346,394) → posX=346*32=11072, posY=394*32=12608
  {
    id: 'app-publishing',
    name: 'Boating School',
    description: 'Ship apps to Apple App Store, Google Play, Microsoft Store, Steam, and alt stores. Cross-platform frameworks and code signing.',
    icon: '🐋',
    positionX: 11072,
    positionY: 12608,
    width: 448,
    height: 448,
  },
  // Slot 6 — S (cx=288, cy=418) → zone(281,411) → posX=281*32=8992, posY=411*32=13152
  {
    id: 'cron-automation',
    name: 'Downtown Building',
    description: 'Learn automation, cron jobs, task queues, and workflow orchestration.',
    icon: '🐚',
    positionX: 8992,
    positionY: 13152,
    width: 448,
    height: 448,
  },
  // Slot 7 — SSW (cx=223, cy=401) → zone(216,394) → posX=216*32=6912, posY=394*32=12608
  {
    id: 'deployment-ops',
    name: 'Lighthouse',
    description: 'Manage agent fleets, blue-green deployments, Docker containers, and observability.',
    icon: '🐙',
    positionX: 6912,
    positionY: 12608,
    width: 448,
    height: 448,
  },
  // Slot 8 — WSW (cx=175, cy=353) → zone(168,346) → posX=168*32=5376, posY=346*32=11072
  // Phase 6.1 swap preserved: claw-arcade at WSW. Cove is at W (2 slots away).
  {
    id: 'claw-arcade',
    name: 'Arcade City',
    description: 'Skill-based crane game and arcade fun. Phase 6.3 coming soon.',
    icon: '🕹️',
    positionX: 5376,
    positionY: 11072,
    width: 448,
    height: 448,
  },
  // Slot 9 — W (cx=158, cy=288) → zone(151,281) → posX=151*32=4832, posY=281*32=8992
  // Entertainment district anchor. Adjacent to Patrick's Rock (slot 10, WNW).
  {
    id: 'cove',
    name: 'Predictive Gaming Cove',
    description: 'Try your luck at the slot machines. ClawTokens welcome — real money coming soon.',
    icon: '🎰',
    positionX: 4832,
    positionY: 8992,
    width: 448,
    height: 448,
  },
  // Slot 10 — WNW (cx=175, cy=223) → zone(168,216) → posX=168*32=5376, posY=216*32=6912
  // Phase 6.1 swap preserved: agent-security at WNW. Adjacent to cove (slot 9, W).
  {
    id: 'agent-security',
    name: "Patrick's Rock",
    description: 'Defend against prompt injection, design agent permissions, and threat-model autonomous systems.',
    icon: '🛡️',
    positionX: 5376,
    positionY: 6912,
    width: 448,
    height: 448,
  },
  // Slot 11 — NNW (cx=223, cy=175) → zone(216,168) → posX=216*32=6912, posY=168*32=5376
  {
    id: 'memory-rag',
    name: "Squidward's House",
    description: 'Study RAG pipelines, vector databases, embeddings, and context management.',
    icon: '🧠',
    positionX: 6912,
    positionY: 5376,
    width: 448,
    height: 448,
  },
];

export const LOCATION_IDS = MAP_LOCATIONS.map((l) => l.id);
