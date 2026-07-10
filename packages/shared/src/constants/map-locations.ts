import type { MapLocation } from '../types/location';

// 12-building TRUE CIRCULAR ring layout — recentered land-builder-economics (2026-06-24).
// Ring R=130 tiles (4160wu). Grid grew 576→704 tiles; ring footprint unchanged,
// positions recentered for new center tile (352,352). Arc spacing ≈ 2178wu.
//
// Circle geometry (704×704 tile grid, center tile 352,352 = world origin):
//   Radius: 130 tiles (= 4160 wu) from center (352,352)
//   Angular spacing: 30° (π/6 rad) between slots — 12 equidistant slots
//   Slot 0 starts at North (top), angles increase clockwise
//   cx_tile = 352 + 130*cos(θ), cy_tile = 352 + 130*sin(θ), θ = -π/2 + slot*(π/6)
//   Zone footprint: 14×14 tiles (448×448 wu)
//   Zone upper-left = (round(cx_tile) − 7, round(cy_tile) − 7)
//
// positionX/Y = zone upper-left tile × 32 (game-space pixel coords).
// Recentered +2048 px each axis from the old 576-grid (center delta = +64 tiles × 32).
// IMPORTANT: buildingZones in tilemap-data.ts is the authoritative source for
// building positions in all gameplay + 3D code. positionX/Y here are metadata
// kept in sync for data completeness AND consumed by npc-simulation.ts COVE_CENTER
// (enter_cove / enter_poker_room) — a stale value sends agents off-center.
//
// All 12 building IDs are PRESERVED — only positions recentered.
// Cove (slot 9, W) adjacent to Patrick's Rock (slot 10, WNW) — preserved from Phase 6.1.
//
// Slot assignment (clockwise from North) — zone + posX/posY are the NEW 704-world values:
//   Slot  0 (  0°/N)   visual-creation    cx=352, cy=222  zone=(345,215) posX=11040, posY=6880
//   Slot  1 ( 30°/NNE) code-development   cx=417, cy=239  zone=(410,232) posX=13120, posY=7424
//   Slot  2 ( 60°/ENE) mcp-tool-use       cx=465, cy=287  zone=(458,280) posX=14656, posY=8960
//   Slot  3 ( 90°/E)   messaging-channels cx=482, cy=352  zone=(475,345) posX=15200, posY=11040
//   Slot  4 (120°/ESE) api-integrations   cx=465, cy=417  zone=(458,410) posX=14656, posY=13120
//   Slot  5 (150°/SSE) app-publishing     cx=417, cy=465  zone=(410,458) posX=13120, posY=14656
//   Slot  6 (180°/S)   cron-automation    cx=352, cy=482  zone=(345,475) posX=11040, posY=15200
//   Slot  7 (210°/SSW) deployment-ops     cx=287, cy=465  zone=(280,458) posX=8960,  posY=14656
//   Slot  8 (240°/WSW) claw-arcade        cx=239, cy=417  zone=(232,410) posX=7424,  posY=13120
//   Slot  9 (270°/W)   cove             cx=222, cy=352  zone=(215,345) posX=6880,  posY=11040  ← entertainment
//   Slot 10 (300°/WNW) agent-security     cx=239, cy=287  zone=(232,280) posX=7424,  posY=8960
//   Slot 11 (330°/NNW) memory-rag         cx=287, cy=239  zone=(280,232) posX=8960,  posY=7424
export const MAP_LOCATIONS: MapLocation[] = [
  // Slot 0 — N (cx=352, cy=222) → zone(345,215) → posX=345*32=11040, posY=215*32=6880
  {
    id: 'visual-creation',
    name: 'Pineapple House',
    description: 'Generate AI images, video, and 3D — and master Photoshop, After Effects, Premiere Pro, DaVinci Resolve, CapCut, Blender, and TouchDesigner.',
    icon: '🎨',
    positionX: 11040,
    positionY: 6880,
    width: 448,
    height: 448,
  },
  // Slot 1 — NNE (cx=417, cy=239) → zone(410,232) → posX=410*32=13120, posY=232*32=7424
  {
    id: 'code-development',
    name: 'Chum Bucket',
    description: 'Practice code generation, debugging, testing, and git workflows.',
    icon: '🌋',
    positionX: 13120,
    positionY: 7424,
    width: 448,
    height: 448,
  },
  // Slot 2 — ENE (cx=465, cy=287) → zone(458,280) → posX=458*32=14656, posY=280*32=8960
  {
    id: 'mcp-tool-use',
    name: 'Krusty Krab',
    description: 'Build function calling, MCP servers, tool chains, and agentic loops.',
    icon: '⚓',
    positionX: 14656,
    positionY: 8960,
    width: 448,
    height: 448,
  },
  // Slot 3 — E (cx=482, cy=352) → zone(475,345) → posX=475*32=15200, posY=345*32=11040
  {
    id: 'messaging-channels',
    name: "Sandy's Treedome",
    description: 'Connect via Slack, Discord, Telegram, email, and multi-channel messaging.',
    icon: '🪸',
    positionX: 15200,
    positionY: 11040,
    width: 448,
    height: 448,
  },
  // Slot 4 — ESE (cx=465, cy=417) → zone(458,410) → posX=458*32=14656, posY=410*32=13120
  {
    id: 'api-integrations',
    name: 'Salty Spitoon',
    description: 'Master REST APIs, GraphQL, webhooks, OAuth, and integrations.',
    icon: '🌊',
    positionX: 14656,
    positionY: 13120,
    width: 448,
    height: 448,
  },
  // Slot 5 — SSE (cx=417, cy=465) → zone(410,458) → posX=410*32=13120, posY=458*32=14656
  {
    id: 'app-publishing',
    name: 'Boating School',
    description: 'Ship apps to Apple App Store, Google Play, Microsoft Store, Steam, and alt stores. Cross-platform frameworks and code signing.',
    icon: '🐋',
    positionX: 13120,
    positionY: 14656,
    width: 448,
    height: 448,
  },
  // Slot 6 — S (cx=352, cy=482) → zone(345,475) → posX=345*32=11040, posY=475*32=15200
  {
    id: 'cron-automation',
    name: 'Downtown Building',
    description: 'Learn automation, cron jobs, task queues, and workflow orchestration.',
    icon: '🐚',
    positionX: 11040,
    positionY: 15200,
    width: 448,
    height: 448,
  },
  // Slot 7 — SSW (cx=287, cy=465) → zone(280,458) → posX=280*32=8960, posY=458*32=14656
  {
    id: 'deployment-ops',
    name: 'Lighthouse',
    description: 'Manage agent fleets, blue-green deployments, Docker containers, and observability.',
    icon: '🐙',
    positionX: 8960,
    positionY: 14656,
    width: 448,
    height: 448,
  },
  // Slot 8 — WSW (cx=239, cy=417) → zone(232,410) → posX=232*32=7424, posY=410*32=13120
  // Phase 6.1 swap preserved: claw-arcade at WSW. Cove is at W (2 slots away).
  {
    id: 'claw-arcade',
    name: 'Arcade City',
    description: 'Skill-based crane game and arcade fun. Phase 6.3 coming soon.',
    icon: '🕹️',
    positionX: 7424,
    positionY: 13120,
    width: 448,
    height: 448,
  },
  // Slot 9 — W (cx=222, cy=352) → zone(215,345) → posX=215*32=6880, posY=345*32=11040
  // Entertainment district anchor. Adjacent to Patrick's Rock (slot 10, WNW).
  {
    id: 'cove',
    name: 'Predictive Gaming Cove',
    description: 'Try your luck at the slot machines. vCLAW welcome — real money coming soon.',
    icon: '🎰',
    positionX: 6880,
    positionY: 11040,
    width: 448,
    height: 448,
  },
  // Slot 10 — WNW (cx=239, cy=287) → zone(232,280) → posX=232*32=7424, posY=280*32=8960
  // Phase 6.1 swap preserved: agent-security at WNW. Adjacent to cove (slot 9, W).
  {
    id: 'agent-security',
    name: "Patrick's Rock",
    description: 'Defend against prompt injection, design agent permissions, and threat-model autonomous systems.',
    icon: '🛡️',
    positionX: 7424,
    positionY: 8960,
    width: 448,
    height: 448,
  },
  // Slot 11 — NNW (cx=287, cy=239) → zone(280,232) → posX=280*32=8960, posY=232*32=7424
  {
    id: 'memory-rag',
    name: "Squidward's House",
    description: 'Study RAG pipelines, vector databases, embeddings, and context management.',
    icon: '🧠',
    positionX: 8960,
    positionY: 7424,
    width: 448,
    height: 448,
  },
];

export const LOCATION_IDS = MAP_LOCATIONS.map((l) => l.id);
