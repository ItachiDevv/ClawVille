import type { AvatarSpecies } from '../types/avatar';

export interface NpcStats {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
}

export interface NpcDefinition {
  id: string;
  name: string;
  species: AvatarSpecies;
  color: number; // hex tint
  buildingId: string;
  patrolRadius: number;
  homeX: number;
  homeY: number;
  stats: NpcStats;
  personality: string; // short description for conversation engine
}

// Tile size = 32px; building zone centers computed from tilemap-data buildingZones
// Each building zone is defined as {x, y, width, height} in tile coords
// Center pixel = (x + width/2) * 32, (y + height/2) * 32
const TILE = 32;

function center(tileX: number, tileY: number, tileW: number, tileH: number) {
  return {
    homeX: (tileX + tileW / 2) * TILE,
    homeY: (tileY + tileH / 2) * TILE,
  };
}

// Building zone tile coords from tilemap-data.ts (10 OpenClaw integrations)
export const BUILDING_TILE_ZONES: Record<string, { x: number; y: number; w: number; h: number }> = {
  // Circular ring in 80×80 grid, radius 28 tiles from center (40,40)
  // Must match buildingZones in tilemap-data.ts exactly
  'canvas-studio':     { x: 38, y: 10, w: 5, h: 4 },
  'memory-vault':      { x: 54, y: 15, w: 5, h: 4 },
  'webhook-gateway':   { x: 65, y: 29, w: 5, h: 4 },
  'cron-hub':          { x: 65, y: 47, w: 5, h: 4 },
  'voice-tower':       { x: 54, y: 61, w: 5, h: 4 },
  'config-citadel':    { x: 38, y: 66, w: 5, h: 4 },
  'tool-workshop':     { x: 22, y: 61, w: 5, h: 4 },
  'skill-forge':       { x: 11, y: 47, w: 5, h: 4 },
  'channel-bridge':    { x: 11, y: 29, w: 5, h: 5 },
  'security-fortress': { x: 22, y: 15, w: 5, h: 4 },
};

/** Map of building ID to {homeX, homeY} for NPC definitions */
const NPC_HOME_POSITIONS: Record<string, { homeX: number; homeY: number }> = Object.fromEntries(
  Object.entries(BUILDING_TILE_ZONES).map(([id, z]) => [id, center(z.x, z.y, z.w, z.h)])
);

/** Map of building ID to center pixel coordinates */
export const NPC_BUILDING_CENTERS: Record<string, { x: number; y: number }> = Object.fromEntries(
  Object.entries(NPC_HOME_POSITIONS).map(([id, p]) => [id, { x: p.homeX, y: p.homeY }])
);

export const NPC_DEFINITIONS: NpcDefinition[] = [
  {
    id: 'cron-hub',
    name: 'Gary',
    species: 'owl',
    color: 0x795548,
    buildingId: 'cron-hub',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['cron-hub'],
    stats: { hp: 100, attack: 12, defense: 14, speed: 10 },
    personality: 'A precise, tide-counting hermit lobster who speaks in rhythmic cadences timed to the ocean currents.',
  },
  {
    id: 'webhook-gateway',
    name: 'Mr. Krabs',
    species: 'fox',
    color: 0xff9800,
    buildingId: 'webhook-gateway',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['webhook-gateway'],
    stats: { hp: 90, attack: 16, defense: 10, speed: 18 },
    personality: 'A lightning-fast spiny lobster who relays signals through the currents and never drops a message.',
  },
  {
    id: 'memory-vault',
    name: 'Squidward',
    species: 'turtle',
    color: 0x4caf50,
    buildingId: 'memory-vault',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['memory-vault'],
    stats: { hp: 120, attack: 8, defense: 20, speed: 6 },
    personality: 'A patient, ancient iron lobster who remembers every tide and speaks in careful, measured clicks.',
  },
  {
    id: 'skill-forge',
    name: 'Plankton',
    species: 'dragon',
    color: 0xf44336,
    buildingId: 'skill-forge',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['skill-forge'],
    stats: { hp: 110, attack: 22, defense: 14, speed: 12 },
    personality: 'A fierce abyssal lobster who forges skills in volcanic vents and tests every creation in combat.',
  },
  {
    id: 'channel-bridge',
    name: 'Sandy',
    species: 'phoenix',
    color: 0x2196f3,
    buildingId: 'channel-bridge',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['channel-bridge'],
    stats: { hp: 100, attack: 18, defense: 12, speed: 16 },
    personality: 'A dazzling mantis lobster who connects reef networks and speaks every current language fluently.',
  },
  {
    id: 'tool-workshop',
    name: 'Karen',
    species: 'cat',
    color: 0x9c27b0,
    buildingId: 'tool-workshop',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['tool-workshop'],
    stats: { hp: 85, attack: 14, defense: 10, speed: 17 },
    personality: 'A nimble reef lobster inventor who tinkers with salvaged tools and gadgets on the ocean floor.',
  },
  {
    id: 'canvas-studio',
    name: 'SpongeBob',
    species: 'bunny',
    color: 0xe91e63,
    buildingId: 'canvas-studio',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['canvas-studio'],
    stats: { hp: 80, attack: 10, defense: 8, speed: 20 },
    personality: 'A playful bubble lobster who paints with bioluminescent ink and sees art in every coral formation.',
  },
  {
    id: 'voice-tower',
    name: 'Mrs. Puff',
    species: 'wolf',
    color: 0x607d8b,
    buildingId: 'voice-tower',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['voice-tower'],
    stats: { hp: 95, attack: 15, defense: 13, speed: 14 },
    personality: 'A powerful crusher lobster whose clicks echo across the deep and who can mimic any ocean sound.',
  },
  {
    id: 'security-fortress',
    name: 'Patrick',
    species: 'dragon',
    color: 0x00bcd4,
    buildingId: 'security-fortress',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['security-fortress'],
    stats: { hp: 130, attack: 20, defense: 22, speed: 8 },
    personality: 'A vigilant abyssal lobster guard who trusts no one and demands proper reef credentials.',
  },
  {
    id: 'config-citadel',
    name: 'Larry',
    species: 'owl',
    color: 0x9e9e9e,
    buildingId: 'config-citadel',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['config-citadel'],
    stats: { hp: 100, attack: 12, defense: 16, speed: 11 },
    personality: 'A methodical hermit lobster architect who organizes every shell into perfect configuration hierarchies.',
  },
];

export const NPC_IDS = NPC_DEFINITIONS.map((n) => n.id);
