export interface NpcStats {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
}

export interface NpcDefinition {
  id: string;
  name: string;
  /** Visual species key — maps to SPECIES_MODEL in arena-npcs.tsx for GLB selection.
   *  Not constrained to PetSpecies (player pet creation enum); NPCs use the broader
   *  set: lobster, crayfish, sweet_crab, hermitcrab, chihiro, priestess, chibi_goku,
   *  jellyfish, octopus, seahorse (plus legacy lobster). */
  species: string;
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
// 160×160 grid, circular ring layout — radius 56 tiles from center (80,80),
// 10 buildings at 36° spacing starting at top-center (θ=-π/2), clockwise.
// center_x = round(80 + 56*cos(θ)), zone x = center_x - 7  (14-tile width)
export const BUILDING_TILE_ZONES: Record<string, { x: number; y: number; w: number; h: number }> = {
  // Ring i=0  θ=-π/2        center=(80, 24)
  'canvas-studio':     { x:  73, y:  17, w: 14, h: 14 },
  // Ring i=1  θ=-3π/10      center=(113, 35)
  'memory-vault':      { x: 106, y:  28, w: 14, h: 14 },
  // Ring i=2  θ=-π/10       center=(133, 63)
  'webhook-gateway':   { x: 126, y:  56, w: 14, h: 14 },
  // Ring i=3  θ=+π/10       center=(133, 97)
  'cron-hub':          { x: 126, y:  90, w: 14, h: 14 },
  // Ring i=4  θ=+3π/10      center=(113,125)
  'voice-tower':       { x: 106, y: 118, w: 14, h: 14 },
  // Ring i=5  θ=+π/2        center=(80, 136)
  'config-citadel':    { x:  73, y: 129, w: 14, h: 14 },
  // Ring i=6  θ=+7π/10      center=(47, 125)
  'tool-workshop':     { x:  40, y: 118, w: 14, h: 14 },
  // Ring i=7  θ=+9π/10      center=(27,  97)
  'skill-forge':       { x:  20, y:  90, w: 14, h: 14 },
  // Ring i=8  θ=+11π/10     center=(27,  63)
  'channel-bridge':    { x:  20, y:  56, w: 14, h: 14 },
  // Ring i=9  θ=+13π/10     center=(47,  35)
  'security-fortress': { x:  40, y:  28, w: 14, h: 14 },
};

/** Map of building ID to {homeX, homeY} for NPC definitions */
const NPC_HOME_POSITIONS: Record<string, { homeX: number; homeY: number }> = Object.fromEntries(
  Object.entries(BUILDING_TILE_ZONES).map(([id, z]) => [id, center(z.x, z.y, z.w, z.h)])
);

/** Map of building ID to center pixel coordinates */
export const NPC_BUILDING_CENTERS: Record<string, { x: number; y: number }> = Object.fromEntries(
  Object.entries(NPC_HOME_POSITIONS).map(([id, p]) => [id, { x: p.homeX, y: p.homeY }])
);

// Wandering NPC species distribution — 3 agent categories rendered as visually distinct characters:
//   openclaw (crustaceans): lobster, crayfish, sweet_crab, hermitcrab  (4 of 10)
//   hermes   (anime humanoids): chihiro, priestess, chibi_goku          (3 of 10)
//   other    (sea creatures): jellyfish, octopus, seahorse               (3 of 10)
// Names kept as SpongeBob cast to preserve personality/lore alignment with LOCATION_NPCS.
export const NPC_DEFINITIONS: NpcDefinition[] = [
  {
    id: 'cron-hub',
    name: 'Gary',
    species: 'hermitcrab',       // openclaw — hermit crab shell matches Gary's slow/methodical vibe
    color: 0x795548,             // warm brown
    buildingId: 'cron-hub',
    patrolRadius: 400,
    ...NPC_HOME_POSITIONS['cron-hub'],
    stats: { hp: 100, attack: 12, defense: 14, speed: 10 },
    personality: 'A precise, tide-counting hermit lobster who speaks in rhythmic cadences timed to the ocean currents.',
  },
  {
    id: 'webhook-gateway',
    name: 'Mr. Krabs',
    species: 'sweet_crab',       // openclaw — crab fits Mr. Krabs perfectly
    color: 0xff6600,             // vivid orange-red
    buildingId: 'webhook-gateway',
    patrolRadius: 400,
    ...NPC_HOME_POSITIONS['webhook-gateway'],
    stats: { hp: 90, attack: 16, defense: 10, speed: 18 },
    personality: 'A lightning-fast spiny lobster who relays signals through the currents and never drops a message.',
  },
  {
    id: 'memory-vault',
    name: 'Squidward',
    species: 'octopus',          // other — octopus is the canonical Squidward animal
    color: 0x4caf50,             // teal-green
    buildingId: 'memory-vault',
    patrolRadius: 500,
    ...NPC_HOME_POSITIONS['memory-vault'],
    stats: { hp: 120, attack: 8, defense: 20, speed: 6 },
    personality: 'A patient, ancient iron lobster who remembers every tide and speaks in careful, measured clicks.',
  },
  {
    id: 'skill-forge',
    name: 'Plankton',
    species: 'chibi_goku',       // hermes — tiny fierce fighter matches Plankton's energy
    color: 0xf44336,             // fiery red
    buildingId: 'skill-forge',
    patrolRadius: 400,
    ...NPC_HOME_POSITIONS['skill-forge'],
    stats: { hp: 110, attack: 22, defense: 14, speed: 12 },
    personality: 'A fierce abyssal lobster who forges skills in volcanic vents and tests every creation in combat.',
  },
  {
    id: 'channel-bridge',
    name: 'Sandy',
    species: 'chihiro',          // hermes — adventurous anime girl suits Sandy's explorer personality
    color: 0x2196f3,             // bright blue
    buildingId: 'channel-bridge',
    patrolRadius: 400,
    ...NPC_HOME_POSITIONS['channel-bridge'],
    stats: { hp: 100, attack: 18, defense: 12, speed: 16 },
    personality: 'A dazzling mantis lobster who connects reef networks and speaks every current language fluently.',
  },
  {
    id: 'tool-workshop',
    name: 'Karen',
    species: 'priestess',        // hermes — calm, knowledgeable priestess matches Karen's AI-oracle role
    color: 0x9c27b0,             // deep purple
    buildingId: 'tool-workshop',
    patrolRadius: 380,
    ...NPC_HOME_POSITIONS['tool-workshop'],
    stats: { hp: 85, attack: 14, defense: 10, speed: 17 },
    personality: 'A nimble reef lobster inventor who tinkers with salvaged tools and gadgets on the ocean floor.',
  },
  {
    id: 'canvas-studio',
    name: 'SpongeBob',
    species: 'jellyfish',        // other — jellyfish are SpongeBob's iconic companions
    color: 0xe91e63,             // hot pink
    buildingId: 'canvas-studio',
    patrolRadius: 400,
    ...NPC_HOME_POSITIONS['canvas-studio'],
    stats: { hp: 80, attack: 10, defense: 8, speed: 20 },
    personality: 'A playful bubble lobster who paints with bioluminescent ink and sees art in every coral formation.',
  },
  {
    id: 'voice-tower',
    name: 'Mrs. Puff',
    species: 'seahorse',         // other — seahorse graceful floating suits Mrs. Puff's puffer aesthetic
    color: 0x607d8b,             // cool blue-grey
    buildingId: 'voice-tower',
    patrolRadius: 380,
    ...NPC_HOME_POSITIONS['voice-tower'],
    stats: { hp: 95, attack: 15, defense: 13, speed: 14 },
    personality: 'A powerful crusher lobster whose clicks echo across the deep and who can mimic any ocean sound.',
  },
  {
    id: 'security-fortress',
    name: 'Patrick',
    species: 'crayfish',         // openclaw — bulky crayfish fits Patrick's imposing defensive build
    color: 0x00bcd4,             // vivid cyan
    buildingId: 'security-fortress',
    patrolRadius: 380,
    ...NPC_HOME_POSITIONS['security-fortress'],
    stats: { hp: 130, attack: 20, defense: 22, speed: 8 },
    personality: 'A vigilant abyssal lobster guard who trusts no one and demands proper reef credentials.',
  },
  {
    id: 'config-citadel',
    name: 'Larry',
    species: 'lobster',          // openclaw — Larry the Lobster, canonical lobster species
    color: 0xff2020,             // bright red (Larry is canonically red in SpongeBob)
    buildingId: 'config-citadel',
    patrolRadius: 400,
    ...NPC_HOME_POSITIONS['config-citadel'],
    stats: { hp: 100, attack: 12, defense: 16, speed: 11 },
    personality: 'A methodical hermit lobster architect who organizes every shell into perfect configuration hierarchies.',
  },
];

export const NPC_IDS = NPC_DEFINITIONS.map((n) => n.id);
