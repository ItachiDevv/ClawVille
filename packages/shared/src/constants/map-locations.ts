import type { MapLocation } from '../types/location';

// 12-building TRUE CIRCULAR ring layout — Phase 6.2.1 (2026-05-18).
// Ring tuned R=160→130 tiles (5120→4160wu — R=160 was too spaced out from player spawn).
// Grid stays at 360×360 tiles. Arc spacing ≈ 2178wu (was 2680wu at R=160).
//
// Circle geometry (360×360 tile grid, center tile 180,180 = world origin):
//   Radius: 130 tiles (= 4160 wu) from center (180,180)
//   Angular spacing: 30° (π/6 rad) between slots — 12 equidistant slots
//   Slot 0 starts at North (top), angles increase clockwise
//   cx_tile = 180 + 130*cos(θ), cy_tile = 180 + 130*sin(θ), θ = -π/2 + slot*(π/6)
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
//   Slot  0 (  0°/N)   visual-creation    cx=180, cy=50   zone=(173,43)  posX=5536,  posY=1376
//   Slot  1 ( 30°/NNE) code-development   cx=245, cy=67   zone=(238,60)  posX=7616,  posY=1920
//   Slot  2 ( 60°/ENE) mcp-tool-use       cx=293, cy=115  zone=(286,108) posX=9152,  posY=3456
//   Slot  3 ( 90°/E)   messaging-channels cx=310, cy=180  zone=(303,173) posX=9696,  posY=5536
//   Slot  4 (120°/ESE) api-integrations   cx=293, cy=245  zone=(286,238) posX=9152,  posY=7616
//   Slot  5 (150°/SSE) app-publishing     cx=245, cy=293  zone=(238,286) posX=7616,  posY=9152
//   Slot  6 (180°/S)   cron-automation    cx=180, cy=310  zone=(173,303) posX=5536,  posY=9696
//   Slot  7 (210°/SSW) deployment-ops     cx=115, cy=293  zone=(108,286) posX=3456,  posY=9152
//   Slot  8 (240°/WSW) claw-arcade        cx=67,  cy=245  zone=(60,238)  posX=1920,  posY=7616
//   Slot  9 (270°/W)   casino             cx=50,  cy=180  zone=(43,173)  posX=1376,  posY=5536  ← entertainment
//   Slot 10 (300°/WNW) agent-security     cx=67,  cy=115  zone=(60,108)  posX=1920,  posY=3456
//   Slot 11 (330°/NNW) memory-rag         cx=115, cy=67   zone=(108,60)  posX=3456,  posY=1920
export const MAP_LOCATIONS: MapLocation[] = [
  // Slot 0 — N (cx=180, cy=50) → zone(173,43) → posX=173*32=5536, posY=43*32=1376
  {
    id: 'visual-creation',
    name: 'Pineapple House',
    description: 'Generate AI images, video, and 3D — and master Photoshop, After Effects, Premiere Pro, DaVinci Resolve, CapCut, Blender, and TouchDesigner.',
    icon: '🎨',
    positionX: 5536,
    positionY: 1376,
    width: 448,
    height: 448,
  },
  // Slot 1 — NNE (cx=245, cy=67) → zone(238,60) → posX=238*32=7616, posY=60*32=1920
  {
    id: 'code-development',
    name: 'Chum Bucket',
    description: 'Practice code generation, debugging, testing, and git workflows.',
    icon: '🌋',
    positionX: 7616,
    positionY: 1920,
    width: 448,
    height: 448,
  },
  // Slot 2 — ENE (cx=293, cy=115) → zone(286,108) → posX=286*32=9152, posY=108*32=3456
  {
    id: 'mcp-tool-use',
    name: 'Krusty Krab',
    description: 'Build function calling, MCP servers, tool chains, and agentic loops.',
    icon: '⚓',
    positionX: 9152,
    positionY: 3456,
    width: 448,
    height: 448,
  },
  // Slot 3 — E (cx=310, cy=180) → zone(303,173) → posX=303*32=9696, posY=173*32=5536
  {
    id: 'messaging-channels',
    name: "Sandy's Treedome",
    description: 'Connect via Slack, Discord, Telegram, email, and multi-channel messaging.',
    icon: '🪸',
    positionX: 9696,
    positionY: 5536,
    width: 448,
    height: 448,
  },
  // Slot 4 — ESE (cx=293, cy=245) → zone(286,238) → posX=286*32=9152, posY=238*32=7616
  {
    id: 'api-integrations',
    name: 'Salty Spitoon',
    description: 'Master REST APIs, GraphQL, webhooks, OAuth, and integrations.',
    icon: '🌊',
    positionX: 9152,
    positionY: 7616,
    width: 448,
    height: 448,
  },
  // Slot 5 — SSE (cx=245, cy=293) → zone(238,286) → posX=238*32=7616, posY=286*32=9152
  {
    id: 'app-publishing',
    name: 'Boating School',
    description: 'Ship apps to Apple App Store, Google Play, Microsoft Store, Steam, and alt stores. Cross-platform frameworks and code signing.',
    icon: '🐋',
    positionX: 7616,
    positionY: 9152,
    width: 448,
    height: 448,
  },
  // Slot 6 — S (cx=180, cy=310) → zone(173,303) → posX=173*32=5536, posY=303*32=9696
  {
    id: 'cron-automation',
    name: 'Downtown Building',
    description: 'Learn automation, cron jobs, task queues, and workflow orchestration.',
    icon: '🐚',
    positionX: 5536,
    positionY: 9696,
    width: 448,
    height: 448,
  },
  // Slot 7 — SSW (cx=115, cy=293) → zone(108,286) → posX=108*32=3456, posY=286*32=9152
  {
    id: 'deployment-ops',
    name: 'Lighthouse',
    description: 'Manage agent fleets, blue-green deployments, Docker containers, and observability.',
    icon: '🐙',
    positionX: 3456,
    positionY: 9152,
    width: 448,
    height: 448,
  },
  // Slot 8 — WSW (cx=67, cy=245) → zone(60,238) → posX=60*32=1920, posY=238*32=7616
  // Phase 6.1 swap preserved: claw-arcade at WSW. Casino is at W (2 slots away).
  {
    id: 'claw-arcade',
    name: 'Arcade City',
    description: 'Skill-based crane game and arcade fun. Phase 6.3 coming soon.',
    icon: '🕹️',
    positionX: 1920,
    positionY: 7616,
    width: 448,
    height: 448,
  },
  // Slot 9 — W (cx=50, cy=180) → zone(43,173) → posX=43*32=1376, posY=173*32=5536
  // Entertainment district anchor. Adjacent to Patrick's Rock (slot 10, WNW).
  {
    id: 'casino',
    name: 'Predictive Gaming Cove',
    description: 'Try your luck at the slot machines. ClawTokens welcome — real money coming soon.',
    icon: '🎰',
    positionX: 1376,
    positionY: 5536,
    width: 448,
    height: 448,
  },
  // Slot 10 — WNW (cx=67, cy=115) → zone(60,108) → posX=60*32=1920, posY=108*32=3456
  // Phase 6.1 swap preserved: agent-security at WNW. Adjacent to casino (slot 9, W).
  {
    id: 'agent-security',
    name: "Patrick's Rock",
    description: 'Defend against prompt injection, design agent permissions, and threat-model autonomous systems.',
    icon: '🛡️',
    positionX: 1920,
    positionY: 3456,
    width: 448,
    height: 448,
  },
  // Slot 11 — NNW (cx=115, cy=67) → zone(108,60) → posX=108*32=3456, posY=60*32=1920
  {
    id: 'memory-rag',
    name: "Squidward's House",
    description: 'Study RAG pipelines, vector databases, embeddings, and context management.',
    icon: '🧠',
    positionX: 3456,
    positionY: 1920,
    width: 448,
    height: 448,
  },
];

export const LOCATION_IDS = MAP_LOCATIONS.map((l) => l.id);
