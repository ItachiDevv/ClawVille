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
// Phase 6.1 (2026-05-18): world is 7680×7680 px (was 5120×5120).
// Town center pixel = 3840, 3840 (was 2560, 2560).
const TILE = 32;

function center(tileX: number, tileY: number, tileW: number, tileH: number) {
  return {
    homeX: (tileX + tileW / 2) * TILE,
    homeY: (tileY + tileH / 2) * TILE,
  };
}

// Building zone tile coords from tilemap-data.ts (10 OpenClaw integrations)
// Phase 6.1 (2026-05-18): 240×240 grid, R=100 tiles from center (120,120), 30° spacing.
// cx = round(120 + 100*cos(θ)), zone x = cx - 7  (14-tile width)
// Matches buildingZones in tilemap-data.ts — keep in sync when ring changes.
export const BUILDING_TILE_ZONES: Record<string, { x: number; y: number; w: number; h: number }> = {
  // Slot 0  θ=-π/2        cx=120, cy=20   zone=(113,13)
  'visual-creation':     { x: 113, y:  13, w: 14, h: 14 },
  // Slot 11 θ=4π/3        cx=70,  cy=33   zone=(63,26)
  'memory-rag':          { x:  63, y:  26, w: 14, h: 14 },
  // Slot 4  θ=π/6         cx=207, cy=170  zone=(200,163)
  'api-integrations':    { x: 200, y: 163, w: 14, h: 14 },
  // Slot 6  θ=π/2         cx=120, cy=220  zone=(113,213)
  'cron-automation':     { x: 113, y: 213, w: 14, h: 14 },
  // Slot 5  θ=π/3         cx=170, cy=207  zone=(163,200)
  'app-publishing':      { x: 163, y: 200, w: 14, h: 14 },
  // Slot 7  θ=2π/3        cx=70,  cy=207  zone=(63,200)
  'deployment-ops':      { x:  63, y: 200, w: 14, h: 14 },
  // Slot 2  θ=-π/6        cx=207, cy=70   zone=(200,63)
  'mcp-tool-use':        { x: 200, y:  63, w: 14, h: 14 },
  // Slot 1  θ=-π/3        cx=170, cy=33   zone=(163,26)
  'code-development':    { x: 163, y:  26, w: 14, h: 14 },
  // Slot 3  θ=0           cx=220, cy=120  zone=(213,113)
  'messaging-channels':  { x: 213, y: 113, w: 14, h: 14 },
  // Slot 8  θ=5π/6        cx=33,  cy=170  zone=(26,163)
  'agent-security':      { x:  26, y: 163, w: 14, h: 14 },
};

/** Map of building ID to {homeX, homeY} for NPC definitions */
const NPC_HOME_POSITIONS: Record<string, { homeX: number; homeY: number }> = Object.fromEntries(
  Object.entries(BUILDING_TILE_ZONES).map(([id, z]) => [id, center(z.x, z.y, z.w, z.h)])
);

/** Map of building ID to center pixel coordinates */
export const NPC_BUILDING_CENTERS: Record<string, { x: number; y: number }> = Object.fromEntries(
  Object.entries(NPC_HOME_POSITIONS).map(([id, p]) => [id, { x: p.homeX, y: p.homeY }])
);

// Wandering NPC species distribution — 2 model categories:
//   milady   (neo-chibi VRMs): milady_official_2/3/4/7/8                (5 of 8) — free wanderers
//   openclaw (crustaceans):    lobster, sweet_crab, hermitcrab          (3 of 8) — free wanderers
//   Total: 8 NPCs — all free wanderers (buildingId='').
//   The 10 SpongeBob building residents at each building entrance are
//   rendered by arena-location-npcs.tsx and are the canonical per-building
//   characters.
//   2026-05-12 (PM): Hermes-female (Mira) and Hermes-male (Tekk) were swapped
//   in earlier today, then reverted same day — the Hermes VRMs render
//   massively oversized at the shared VRM_NPC_SCALE=112 and overshadow the
//   rest of the cast. Scaffold for Hermes wanderers (MODEL_REGISTRY entries,
//   preloads, characterId switch in VRMNpcMesh) stays in place; the roster
//   reverts to the original 5 Milady picks until a per-species VRM scale
//   override lands in arena-npcs.tsx.
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
  //   Map: 7680×7680 px / 240×240 tiles, town center (3840, 3840).
  //   Building ring radius = 100 tiles (3200 wu) from center. Open gaps lie roughly
  //   between the 12 ring positions and well inside (closer to center).
  //   Phase 6.1 (2026-05-18): all homeX/homeY scaled ×1.5 from original 5120-world coords.
  {
    id: 'milady-miu',
    name: 'Miu',
    species: 'milady_official_7',
    color: 0xffc0ff,             // lavender (ignored — VRM MToon pipeline skips tint)
    buildingId: '',              // no building anchor; free wanderer
    patrolRadius: 500,
    homeX: 2550,
    homeY: 4800,                 // SW of town, inside the ring
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
    homeX: 5100,
    homeY: 2850,                 // NE of town, inside the ring
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
    homeX: 2550,
    homeY: 2850,                 // NW of town, inside the ring
    stats: { hp: 90, attack: 13, defense: 13, speed: 16 },
    personality: 'A bookish Milady sketcher who maps every reef formation she encounters into her field journal.',
  },
  // ─── Hermes wanderers (re-restored 2026-05-12 after per-VRM auto-fit) ────
  // 3 of the 5 Milady wanderer slots replaced with Mira (hermes_female),
  // Cyrus (hermes_male — the Paul-Atreides-style cape MaleHermes), and Tekk
  // (the winged operator at /avatars/tekk.vrm). Previous swap failed because
  // VRM_NPC_SCALE=112 sized cm-authored Hermes VRMs as ~21,000wu giants. Now
  // arena-npcs.tsx VRMNpcMesh computes a per-VRM render scale from the bbox
  // at scale=1, so all VRM families land at VRM_NPC_TARGET_HEIGHT_WU regardless
  // of source unit system.
  {
    id: 'hermes-mira',
    name: 'Mira',
    species: 'hermes_female',
    color: 0xb088ff,             // ignored — MToon
    buildingId: '',
    patrolRadius: 500,
    homeX: 5100,
    homeY: 4800,                 // SE of town, inside the ring
    stats: { hp: 95, attack: 12, defense: 14, speed: 15 },
    personality: 'A wide-eyed Hermes scholar mapping every glyph on every building she passes.',
  },
  {
    id: 'hermes-cyrus',
    name: 'Cyrus',
    species: 'hermes_male',
    color: 0x4b6cb7,             // ignored — MToon
    buildingId: '',
    patrolRadius: 500,
    homeX: 3840,
    homeY: 2550,                 // N of town, inside the ring
    stats: { hp: 92, attack: 14, defense: 12, speed: 17 },
    personality: 'A composed Hermes operator who treats every door in town like a problem worth solving.',
  },
  {
    id: 'hermes-tekk',
    name: 'Tekk',
    species: 'tekk',
    color: 0x30c060,             // ignored — MToon
    buildingId: '',
    patrolRadius: 500,
    homeX: 2850,
    homeY: 5700,                 // SW of town, inside the ring
    stats: { hp: 88, attack: 16, defense: 10, speed: 19 },
    personality: 'A winged scout who landed three buildings ago and has not stopped narrating since.',
  },
  // ─── Additional free-roaming crustaceans (added 2026-04-22) ──────────────
  // Sea-creature GLBs scale + clone per-instance, so multiple NPCs can share
  // the same species path without cache collision (unlike VRMs).
  //
  // Positions updated 2026-05-18 (Phase 6.1): ring is now R=100 tiles (3200 wu)
  // centered at game-space pixel (3840, 3840) in the 7680×7680 world.
  // Wanderers placed ~40-50% of the ring radius from center, near thematically
  // appropriate building pairs. PatrolRadius 500 prevents drifting into the plaza.
  {
    id: 'wanderer-driftwood',
    name: 'Driftwood',
    species: 'lobster',
    color: 0x8d6e63,             // driftwood brown
    buildingId: '',
    patrolRadius: 500,
    homeX: 2232,
    homeY: 3408,                 // W inner — between casino (slot 9, W) + claw-arcade (slot 10, WNW) — entertainment district
    stats: { hp: 100, attack: 14, defense: 14, speed: 12 },
    personality: 'A weather-worn vagabond lobster who treats the whole reef as his personal backyard.',
  },
  {
    id: 'wanderer-marlin',
    name: 'Marlin',
    species: 'sweet_crab',
    color: 0x00acc1,             // teal
    buildingId: '',
    patrolRadius: 500,
    homeX: 5100,
    homeY: 4200,                 // E inner — between messaging-channels (slot 3, E) + api-integrations (slot 4, ESE)
    stats: { hp: 85, attack: 17, defense: 11, speed: 19 },
    personality: 'A speedy crab courier who claims to know every tide pool shortcut on the map.',
  },
  {
    id: 'wanderer-riptide',
    name: 'Riptide',
    species: 'hermitcrab',
    color: 0xa1887f,             // sand
    buildingId: '',
    patrolRadius: 500,
    homeX: 2850,
    homeY: 4800,                 // SW inner — between deployment-ops (slot 7, SSW) + agent-security (slot 8, WSW)
    stats: { hp: 110, attack: 13, defense: 17, speed: 11 },
    personality: 'A philosophical hermit crab who borrows shells from every building he visits and returns each one.',
  },
];

export const NPC_IDS = NPC_DEFINITIONS.map((n) => n.id);
