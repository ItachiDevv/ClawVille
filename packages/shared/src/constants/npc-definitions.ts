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
   *  Not constrained to PetSpecies (player pet creation enum); wandering NPCs use
   *  sea-creature GLBs only: lobster, crayfish, sweet_crab, hermitcrab,
   *  jellyfish, octopus, seahorse. VRM Milady avatars (milady_official_1..8) are
   *  player-pet-only and do not appear as wandering NPCs. */
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
// 160×160 grid, circular ring layout — radius 68 tiles from center (80,80),
// 10 buildings at 36° spacing starting at top-center (θ=-π/2), clockwise.
// center_x = round(80 + 68*cos(θ)), zone x = center_x - 7  (14-tile width)
export const BUILDING_TILE_ZONES: Record<string, { x: number; y: number; w: number; h: number }> = {
  // Ring i=0  θ=-π/2        center=(80, 12)
  'canvas-studio':     { x:  73, y:   5, w: 14, h: 14 },
  // Ring i=1  θ=-3π/10      center=(120, 25)
  'memory-vault':      { x: 113, y:  18, w: 14, h: 14 },
  // Ring i=2  θ=-π/10       center=(145, 59)
  'webhook-gateway':   { x: 138, y:  52, w: 14, h: 14 },
  // Ring i=3  θ=+π/10       center=(145,101)
  'cron-hub':          { x: 138, y:  94, w: 14, h: 14 },
  // Ring i=4  θ=+3π/10      center=(120,135)
  'voice-tower':       { x: 113, y: 128, w: 14, h: 14 },
  // Ring i=5  θ=+π/2        center=(80, 148)
  'config-citadel':    { x:  73, y: 141, w: 14, h: 14 },
  // Ring i=6  θ=+7π/10      center=(40, 135)
  'tool-workshop':     { x:  33, y: 128, w: 14, h: 14 },
  // Ring i=7  θ=+9π/10      center=(15,  101)
  'skill-forge':       { x:   8, y:  94, w: 14, h: 14 },
  // Ring i=8  θ=+11π/10     center=(15,  59)
  'channel-bridge':    { x:   8, y:  52, w: 14, h: 14 },
  // Ring i=9  θ=+13π/10     center=(40,  25)
  'security-fortress': { x:  33, y:  18, w: 14, h: 14 },
};

/** Map of building ID to {homeX, homeY} for NPC definitions */
const NPC_HOME_POSITIONS: Record<string, { homeX: number; homeY: number }> = Object.fromEntries(
  Object.entries(BUILDING_TILE_ZONES).map(([id, z]) => [id, center(z.x, z.y, z.w, z.h)])
);

/** Map of building ID to center pixel coordinates */
export const NPC_BUILDING_CENTERS: Record<string, { x: number; y: number }> = Object.fromEntries(
  Object.entries(NPC_HOME_POSITIONS).map(([id, p]) => [id, { x: p.homeX, y: p.homeY }])
);

// Wandering NPC species distribution — 3 model categories rendered as visually distinct characters:
//   openclaw (crustaceans): lobster, crayfish, sweet_crab, hermitcrab  (4 of 12)
//   other    (sea creatures): jellyfish, octopus, seahorse               (3 of 12)
//   milady   (neo-chibi VRMs): milady_official_7, milady_official_8      (2 of 12) — added 2026-04-21
//
// Wandering-NPC names DELIBERATELY DO NOT MATCH the 10 building characters
// (SpongeBob, Patrick, Squidward, etc.) defined in arena-location-npcs.tsx
// LOCATION_NPCS. The building characters are the canonical "characters" with
// proper SpongeBob GLB models at each building entrance. The wandering NPCs
// here are SEPARATE ambient ocean denizens with distinct nautical names —
// before 2026-04-21 they shared the SpongeBob names which produced two
// "Squidward" labels on screen (one octopus wanderer + one squidward.glb at
// the memory-vault entrance). Renamed to avoid the visible name collision.
// Building anchor (buildingId / homeX / homeY) is preserved so each wanderer
// still has a hangout spot; their patrol radius keeps them in that area.
export const NPC_DEFINITIONS: NpcDefinition[] = [
  {
    id: 'cron-hub',
    name: 'Pebbles',
    species: 'hermitcrab',       // openclaw — hermit crab shell, slow/methodical vibe
    color: 0x795548,             // warm brown
    buildingId: 'cron-hub',
    patrolRadius: 400,
    ...NPC_HOME_POSITIONS['cron-hub'],
    stats: { hp: 100, attack: 12, defense: 14, speed: 10 },
    personality: 'A precise, tide-counting hermit crab who speaks in rhythmic cadences timed to the ocean currents.',
  },
  {
    id: 'webhook-gateway',
    name: 'Crusty',
    species: 'sweet_crab',       // openclaw — crab, lightning-fast signal relayer
    color: 0xff6600,             // vivid orange-red
    buildingId: 'webhook-gateway',
    patrolRadius: 400,
    ...NPC_HOME_POSITIONS['webhook-gateway'],
    stats: { hp: 90, attack: 16, defense: 10, speed: 18 },
    personality: 'A lightning-fast spiny crab who relays signals through the currents and never drops a message.',
  },
  {
    id: 'memory-vault',
    name: 'Inky',
    species: 'octopus',
    color: 0x4caf50,             // teal-green
    buildingId: 'memory-vault',
    patrolRadius: 500,
    ...NPC_HOME_POSITIONS['memory-vault'],
    stats: { hp: 120, attack: 8, defense: 20, speed: 6 },
    personality: 'A patient ancient octopus who remembers every tide and speaks in careful, measured clicks.',
  },
  {
    id: 'skill-forge',
    name: 'Speck',
    species: "hermitcrab",       // tiny fierce fighter
    color: 0xf44336,             // fiery red
    buildingId: 'skill-forge',
    patrolRadius: 400,
    ...NPC_HOME_POSITIONS['skill-forge'],
    stats: { hp: 110, attack: 22, defense: 14, speed: 12 },
    personality: 'A fierce abyssal hermit who forges skills in volcanic vents and tests every creation in combat.',
  },
  {
    id: 'channel-bridge',
    name: 'Hazel',
    species: "lobster",
    color: 0x2196f3,             // bright blue
    buildingId: 'channel-bridge',
    patrolRadius: 400,
    ...NPC_HOME_POSITIONS['channel-bridge'],
    stats: { hp: 100, attack: 18, defense: 12, speed: 16 },
    personality: 'A dazzling mantis lobster who connects reef networks and speaks every current language fluently.',
  },
  {
    id: 'tool-workshop',
    name: 'Whisk',
    species: "sweet_crab",
    color: 0x9c27b0,             // deep purple
    buildingId: 'tool-workshop',
    patrolRadius: 380,
    ...NPC_HOME_POSITIONS['tool-workshop'],
    stats: { hp: 85, attack: 14, defense: 10, speed: 17 },
    personality: 'A nimble reef crab inventor who tinkers with salvaged tools and gadgets on the ocean floor.',
  },
  {
    id: 'canvas-studio',
    name: 'Bubbles',
    species: 'jellyfish',
    color: 0xe91e63,             // hot pink
    buildingId: 'canvas-studio',
    patrolRadius: 400,
    ...NPC_HOME_POSITIONS['canvas-studio'],
    stats: { hp: 80, attack: 10, defense: 8, speed: 20 },
    personality: 'A playful bubble jellyfish who paints with bioluminescent ink and sees art in every coral formation.',
  },
  {
    id: 'voice-tower',
    name: 'Tide',
    species: 'seahorse',
    color: 0x607d8b,             // cool blue-grey
    buildingId: 'voice-tower',
    patrolRadius: 380,
    ...NPC_HOME_POSITIONS['voice-tower'],
    stats: { hp: 95, attack: 15, defense: 13, speed: 14 },
    personality: 'A powerful seahorse herald whose clicks echo across the deep and who can mimic any ocean sound.',
  },
  {
    id: 'security-fortress',
    name: 'Boulder',
    species: 'crayfish',         // bulky crayfish, defensive build
    color: 0x00bcd4,             // vivid cyan
    buildingId: 'security-fortress',
    patrolRadius: 380,
    ...NPC_HOME_POSITIONS['security-fortress'],
    stats: { hp: 130, attack: 20, defense: 22, speed: 8 },
    personality: 'A vigilant abyssal crayfish guard who trusts no one and demands proper reef credentials.',
  },
  {
    id: 'config-citadel',
    name: 'Coral',
    species: 'lobster',
    color: 0xff2020,             // bright red
    buildingId: 'config-citadel',
    patrolRadius: 400,
    ...NPC_HOME_POSITIONS['config-citadel'],
    stats: { hp: 100, attack: 12, defense: 16, speed: 11 },
    personality: 'A methodical lobster architect who organizes every shell into perfect configuration hierarchies.',
  },
  // ─── Milady brand wanderers (VRM avatars) — added 2026-04-21 ──────────────
  // No building attachment (buildingId: '') — these roam as brand ambassadors
  // for the Milady × ClawVille integration. They participate in the full
  // server NPC sim: wandering, NPC-to-NPC conversations, chat bubbles.
  // Use milady_official_7 / _8 specifically to avoid VRM module-cache collision
  // with the most common player-pet picks (official_1 is category default,
  // official_5 is a popular choice). See vrm-loader.ts — single-instance-per-path.
  // Spawn positions chosen to be CLEAR of every building's pathfinding-blocked
  // zone (BUILDING_TILE_ZONES + BUILDING_EXCLUSION_PAD = 9 tiles). A* findPath()
  // returns an empty path when the start tile is blocked, which deadlocks the
  // wander planner — the NPC plans behavior, the path is empty, no movement,
  // next planning tick same result. Both Milady spawns sit in the wide
  // open-water gaps between buildings on the ring.
  //
  //   Map: 5120×5120 px / 160×160 tiles, town center (2560, 2560).
  //   Building ring radius ≈ 68 tiles from center. Open gaps lie roughly
  //   between the 10 ring positions and well inside (closer to center).
  //   - Miu  at (1400, 3000) ≈ tile (43, 93) — between skill-forge(15,101) and
  //     tool-workshop(40,135) on the SW arc, inside the ring radius. Walkable.
  //   - Kyoko at (3700, 2000) ≈ tile (115, 62) — between memory-vault(120,25)
  //     and webhook-gateway(145,59) on the NE arc, inside the ring. Walkable.
  {
    id: 'milady-miu',
    name: 'Miu',
    species: 'milady_official_7',
    color: 0xffc0ff,             // lavender (ignored — VRM MToon pipeline skips tint)
    buildingId: '',              // no building anchor; free wanderer
    patrolRadius: 600,
    homeX: 1400,
    homeY: 3000,                 // SW arc, inside ring, clear of all blocked zones
    stats: { hp: 95, attack: 14, defense: 12, speed: 15 },
    personality: 'A soft-spoken Milady wanderer with a fascination for the neon-tide rhythms of the reef.',
  },
  {
    id: 'milady-kyoko',
    name: 'Kyoko',
    species: 'milady_official_8',
    color: 0xc0e8ff,             // sky-blue (ignored — VRM MToon)
    buildingId: '',
    patrolRadius: 600,
    homeX: 3700,
    homeY: 2000,                 // NE arc, inside ring, clear of all blocked zones
    stats: { hp: 90, attack: 13, defense: 14, speed: 16 },
    personality: 'A curious Milady explorer cataloguing every agent signal she overhears across ClawVille.',
  },
];

export const NPC_IDS = NPC_DEFINITIONS.map((n) => n.id);
