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
   *  Not constrained to AvatarSpecies (player avatar creation enum); wandering NPCs use
   *  sea-creature GLBs only: lobster, crayfish, sweet_crab, hermitcrab,
   *  jellyfish, octopus, seahorse. VRM Milady avatars (milady_official_1..8) are
   *  player-avatar-only and do not appear as wandering NPCs. */
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
  'visual-creation':     { x:  73, y:   5, w: 14, h: 14 },
  // Ring i=1  θ=-3π/10      center=(120, 25)
  'memory-rag':          { x: 113, y:  18, w: 14, h: 14 },
  // Ring i=2  θ=-π/10       center=(145, 59)
  'api-integrations':    { x: 138, y:  52, w: 14, h: 14 },
  // Ring i=3  θ=+π/10       center=(145,101)
  'cron-automation':     { x: 138, y:  94, w: 14, h: 14 },
  // Ring i=4  θ=+3π/10      center=(120,135)
  'app-publishing':      { x: 113, y: 128, w: 14, h: 14 },
  // Ring i=5  θ=+π/2        center=(80, 148)
  'deployment-ops':      { x:  73, y: 141, w: 14, h: 14 },
  // Ring i=6  θ=+7π/10      center=(40, 135)
  'mcp-tool-use':        { x:  33, y: 128, w: 14, h: 14 },
  // Ring i=7  θ=+9π/10      center=(15,  101)
  'code-development':    { x:   8, y:  94, w: 14, h: 14 },
  // Ring i=8  θ=+11π/10     center=(15,  59)
  'messaging-channels':  { x:   8, y:  52, w: 14, h: 14 },
  // Ring i=9  θ=+13π/10     center=(40,  25)
  'agent-security':      { x:  33, y:  18, w: 14, h: 14 },
};

/** Map of building ID to {homeX, homeY} for NPC definitions */
const NPC_HOME_POSITIONS: Record<string, { homeX: number; homeY: number }> = Object.fromEntries(
  Object.entries(BUILDING_TILE_ZONES).map(([id, z]) => [id, center(z.x, z.y, z.w, z.h)])
);

/** Map of building ID to center pixel coordinates */
export const NPC_BUILDING_CENTERS: Record<string, { x: number; y: number }> = Object.fromEntries(
  Object.entries(NPC_HOME_POSITIONS).map(([id, p]) => [id, { x: p.homeX, y: p.homeY }])
);

// Wandering NPC species distribution — 3 model categories:
//   milady   (neo-chibi VRMs): milady_official_2/7/8                    (3 of 8) — free wanderers
//   hermes   (humanoid VRMs):  hermes_female (Mira), hermes_male (Tekk) (2 of 8) — free wanderers
//   openclaw (crustaceans):    lobster, sweet_crab, hermitcrab          (3 of 8) — free wanderers
//   Total: 8 NPCs — all free wanderers (buildingId='').
//   2026-05-12: replaced Ash (milady_official_4) with Mira (hermes_female)
//   and Maple (milady_official_3) with Tekk (hermes_male) so the new
//   Hermes-female / Tekk rigs ship as wandering brand ambassadors alongside
//   the Milady wanderers. The retired Milady VRM paths (official_3, _4) stay
//   in MODEL_REGISTRY for player-avatar picker use.
//   The 10 SpongeBob building residents (SpongeBob, Patrick, Squidward, etc.)
//   at each building entrance are rendered by arena-location-npcs.tsx and are
//   the canonical per-building characters. Previously there was ALSO one
//   crustacean per building (Pebbles/Crusty/Inky/Speck/Hazel/Whisk/Bubbles/
//   Tide/Boulder/Coral) wandering nearby — removed 2026-04-24 because they
//   were redundant with the SpongeBob residents: the user should see one
//   character per building, not two.
//   Each Milady NPC MUST use a unique VRM path due to the module-level
//   single-instance-per-path cache in vrm-loader.ts.
export const NPC_DEFINITIONS: NpcDefinition[] = [
  // ─── Milady brand wanderers (VRM avatars) — added 2026-04-21 ──────────────
  // No building attachment (buildingId: '') — these roam as brand ambassadors
  // for the Milady × ClawVille integration. They participate in the full
  // server NPC sim: wandering, NPC-to-NPC conversations, chat bubbles.
  // Use milady_official_7 / _8 specifically to avoid VRM module-cache collision
  // with the most common player-avatar picks (official_1 is category default,
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
  //   - Miu  at (1400, 3000) ≈ tile (43, 93) — between code-development(15,101) and
  //     mcp-tool-use(40,135) on the SW arc, inside the ring radius. Walkable.
  //   - Kyoko at (3700, 2000) ≈ tile (115, 62) — between memory-rag(120,25)
  //     and api-integrations(145,59) on the NE arc, inside the ring. Walkable.
  {
    id: 'milady-miu',
    name: 'Miu',
    species: 'milady_official_7',
    color: 0xffc0ff,             // lavender (ignored — VRM MToon pipeline skips tint)
    buildingId: '',              // no building anchor; free wanderer
    patrolRadius: 500,
    homeX: 1700,
    homeY: 3200,                 // SW of town, inside the 500-1700wu ring
    stats: { hp: 95, attack: 14, defense: 12, speed: 15 },
    personality: 'A soft-spoken Milady wanderer with a fascination for the neon-tide rhythms of the reef.',
  },
  {
    id: 'milady-kyoko',
    name: 'Kyoko',
    species: 'milady_official_8',
    color: 0xc0e8ff,             // sky-blue (ignored — VRM MToon)
    buildingId: '',
    patrolRadius: 500,
    homeX: 3400,
    homeY: 1900,                 // NE of town, inside the ring
    stats: { hp: 90, attack: 13, defense: 14, speed: 16 },
    personality: 'A curious Milady explorer cataloguing every agent signal she overhears across ClawVille.',
  },
  // ─── Additional Milady wanderer (added 2026-04-22) ───────────────────────
  // Uses VRM path official_2 — official_1 is the picker default and
  // official_5/6 are most-frequently-picked, keeping NPC paths off the
  // common player-avatar picks to avoid VRM module-cache scene-sharing.
  {
    id: 'milady-vivi',
    name: 'Vivi',
    species: 'milady_official_2',
    color: 0xffd0a0,             // peach (ignored — MToon)
    buildingId: '',
    patrolRadius: 500,
    homeX: 1700,
    homeY: 1900,                 // NW of town, inside the ring
    stats: { hp: 90, attack: 13, defense: 13, speed: 16 },
    personality: 'A bookish Milady sketcher who maps every reef formation she encounters into her field journal.',
  },
  // ─── Hermes wanderers (added 2026-05-12) ─────────────────────────────────
  // Replaces former Maple (milady_official_3) and Ash (milady_official_4)
  // slots. Both VRMs are Mixamo-rigged at human scale (~1.6m) with their own
  // per-character animation bakes under /avatars/animations/{hermes-female,
  // tekk-male}/*.glb. arena-npcs.tsx passes characterId='hermes-female' /
  // 'hermes-male' to VRMCharacterAnimator so those overrides apply — without
  // it the generic Mixamo clips deform their bones (feet meshing, hands
  // clipping hips). Spawn coords kept identical to the Maple/Ash slots so
  // the world layout is unchanged.
  {
    id: 'hermes-mira',
    name: 'Mira',
    species: 'hermes_female',
    color: 0xffb0d0,             // pink (ignored — MToon)
    buildingId: '',
    patrolRadius: 500,
    homeX: 3400,
    homeY: 3200,                 // SE of town, inside the ring (former Maple slot)
    stats: { hp: 95, attack: 12, defense: 14, speed: 15 },
    personality: 'A poised Hermes wanderer who reads the reef like a manuscript and offers gentle notes on every story she overhears.',
  },
  {
    id: 'hermes-tekk',
    name: 'Tekk',
    species: 'hermes_male',
    color: 0xd0c0ff,             // pale violet (ignored — MToon)
    buildingId: '',
    patrolRadius: 500,
    homeX: 2560,
    homeY: 1700,                 // N of town, inside the ring (former Ash slot)
    stats: { hp: 92, attack: 14, defense: 12, speed: 17 },
    personality: 'A winged Hermes scout who insists every passing current carries a message someone forgot to deliver.',
  },
  // ─── Additional free-roaming crustaceans (added 2026-04-22) ──────────────
  // Sea-creature GLBs scale + clone per-instance, so multiple NPCs can share
  // the same species path without cache collision (unlike VRMs).
  {
    id: 'wanderer-driftwood',
    name: 'Driftwood',
    species: 'lobster',
    color: 0x8d6e63,             // driftwood brown
    buildingId: '',
    patrolRadius: 700,
    homeX: 1500,
    homeY: 2400,                 // W inner — between messaging-channels + code-development
    stats: { hp: 100, attack: 14, defense: 14, speed: 12 },
    personality: 'A weather-worn vagabond lobster who treats the whole reef as his personal backyard.',
  },
  {
    id: 'wanderer-marlin',
    name: 'Marlin',
    species: 'sweet_crab',
    color: 0x00acc1,             // teal
    buildingId: '',
    patrolRadius: 700,
    homeX: 3700,
    homeY: 2700,                 // E inner — between api-integrations + cron-automation
    stats: { hp: 85, attack: 17, defense: 11, speed: 19 },
    personality: 'A speedy crab courier who claims to know every tide pool shortcut on the map.',
  },
  {
    id: 'wanderer-riptide',
    name: 'Riptide',
    species: 'hermitcrab',
    color: 0xa1887f,             // sand
    buildingId: '',
    patrolRadius: 700,
    homeX: 2600,
    homeY: 3500,                 // S inner — between app-publishing + deployment-ops
    stats: { hp: 110, attack: 13, defense: 17, speed: 11 },
    personality: 'A philosophical hermit crab who borrows shells from every building he visits and returns each one.',
  },
];

export const NPC_IDS = NPC_DEFINITIONS.map((n) => n.id);
