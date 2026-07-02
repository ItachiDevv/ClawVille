export interface NpcStats {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
}

export interface NpcDefinition {
  id: string;
  name: string;
  /** Visual species key — maps to arena-npcs.tsx GLB/VRM selection.
   *  Not constrained to AvatarSpecies (player avatar creation enum). */
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
// Land-builder-economics (2026-06-24): world is 22528×22528 px (704×704 tiles).
// Town center pixel = 11264, 11264 (center tile 352, 352).
const TILE = 32;

function center(tileX: number, tileY: number, tileW: number, tileH: number) {
  return {
    homeX: (tileX + tileW / 2) * TILE,
    homeY: (tileY + tileH / 2) * TILE,
  };
}

// Building zone tile coords from tilemap-data.ts (10 OpenClaw integrations).
// Land-builder-economics (2026-06-24): 704×704 grid, R=130 tiles from center (352,352), 30° spacing.
// cx = round(352 + 130*cos(θ)), zone x = cx - 7  (14-tile width).
// Recentered from old center (288,288) by +64 tiles on each axis (was 576×576).
// MUST EXACTLY MATCH buildingZones in tilemap-data.ts — server↔client contract.
export const BUILDING_TILE_ZONES: Record<string, { x: number; y: number; w: number; h: number }> = {
  // Slot 0  θ=-π/2        cx=352, cy=222   zone=(345,215)
  'visual-creation':     { x: 345, y: 215, w: 14, h: 14 },
  // Slot 11 θ=4π/3        cx=287, cy=239   zone=(280,232)
  'memory-rag':          { x: 280, y: 232, w: 14, h: 14 },
  // Slot 4  θ=π/6         cx=465, cy=417   zone=(458,410)
  'api-integrations':    { x: 458, y: 410, w: 14, h: 14 },
  // Slot 6  θ=π/2         cx=352, cy=482   zone=(345,475)
  'cron-automation':     { x: 345, y: 475, w: 14, h: 14 },
  // Slot 5  θ=π/3         cx=417, cy=465   zone=(410,458)
  'app-publishing':      { x: 410, y: 458, w: 14, h: 14 },
  // Slot 7  θ=2π/3        cx=287, cy=465   zone=(280,458)
  'deployment-ops':      { x: 280, y: 458, w: 14, h: 14 },
  // Slot 2  θ=-π/6        cx=465, cy=287   zone=(458,280)
  'mcp-tool-use':        { x: 458, y: 280, w: 14, h: 14 },
  // Slot 1  θ=-π/3        cx=417, cy=239   zone=(410,232)
  'code-development':    { x: 410, y: 232, w: 14, h: 14 },
  // Slot 3  θ=0           cx=482, cy=352   zone=(475,345)
  'messaging-channels':  { x: 475, y: 345, w: 14, h: 14 },
  // Slot 10 θ=7π/6        cx=239, cy=287   zone=(232,280)  [was slot 8 before Phase 6.1 swap]
  'agent-security':      { x: 232, y: 280, w: 14, h: 14 },
};

/** Map of building ID to {homeX, homeY} for NPC definitions */
const NPC_HOME_POSITIONS: Record<string, { homeX: number; homeY: number }> = Object.fromEntries(
  Object.entries(BUILDING_TILE_ZONES).map(([id, z]) => [id, center(z.x, z.y, z.w, z.h)])
);

/** Map of building ID to center pixel coordinates */
export const NPC_BUILDING_CENTERS: Record<string, { x: number; y: number }> = Object.fromEntries(
  Object.entries(NPC_HOME_POSITIONS).map(([id, p]) => [id, { x: p.homeX, y: p.homeY }])
);

/**
 * Building-interaction proximity radius, in world units (wu = game-space px;
 * 1 tile = 32 wu; world = 22528 wu). The SINGLE source of truth for "close
 * enough to interact with a teacher/building" — a body must be within this
 * distance of the target's center for a `talk_to_npc` / `visit-building` to
 * count (agent-metaverse P1 anti-abuse backbone: no walk/proximity → no
 * interaction → no reward). Replaces the ad-hoc `VISIT_RADIUS = 2000` on the
 * authed visit path AND backs the new server-side proximity gate in
 * `npc-simulation.executeHatcherAction` (talk_to_npc).
 *
 * 1000 wu ≈ 2 building-widths (building zone = 14 tiles = 448 wu) / ~½ the
 * inter-building gap on the ring — clearly "at this teacher," with slack for
 * the pathfind entrance stand-off, and no overlap with the neighbour. Tunable
 * after watching real arrivals. Founder-signed (agent-metaverse-p1-plan.md §48).
 */
export const BUILDING_INTERACTION_RADIUS = 1000;

// Wandering NPC species distribution — 4 model categories:
//   milady   (neo-chibi VRMs): milady_official_1..8                      (8 of 14) — free wanderers
//   hermes   (VRMs):           hermes_female, hermes_male, tekk          (3 of 14) — free wanderers
//   chibi    (VRMs):           eliza_chibi, milady_chibi                 (2 of 14) — free wanderers
//   openclaw (crustacean):     lobster                                   (1 of 14) — free wanderer
//   Total: 14 NPCs — all free wanderers (buildingId='').
//   2026-05-27: restored full 8-Milady cast (aria/suki/hana/yumi/ren added
//   to the original miu/kyoko/vivi). Each uses a UNIQUE VRM path; sharing
//   any path would corrupt scene/skeleton via the vrm-loader cache.
//   The 10 SpongeBob building residents at each building entrance are
//   rendered by arena-location-npcs.tsx and are the canonical per-building
//   characters.
//   2026-05-12 (PM): Hermes-female (Mira), Hermes-male (Cyrus), and Tekk
//   were restored after per-VRM bbox auto-fit landed in arena-npcs.tsx.
//   The 10 SpongeBob building residents (SpongeBob, Patrick, Squidward, etc.)
//   at each building entrance are rendered by arena-location-npcs.tsx and are
//   the canonical per-building characters. Previously there were more
//   crustaceans wandering nearby; reduced to one live lobster on 2026-05-26
//   so the user sees one version of each avatar family, not a crustacean crowd.
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
  //   Map: 22528×22528 px / 704×704 tiles, town center (11264, 11264).
  //   Building ring radius = 130 tiles (4160 wu) from center. Open gaps lie roughly
  //   between the 12 ring positions and well inside (closer to center).
  //   Phase 0 land (2026-06-15): all homeX/homeY recentered +3456 px when the world
  //   grew 360→576 tiles. Land-builder-economics (2026-06-24): a further +2048 px
  //   (+64 tiles) uniform shift when the world grew 576→704 tiles. Ring unchanged.
  {
    id: 'milady-miu',
    name: 'Miu',
    species: 'milady_official_7',
    color: 0xffc0ff,             // lavender (ignored — VRM MToon pipeline skips tint)
    buildingId: '',              // no building anchor; free wanderer
    patrolRadius: 500,
    homeX: 9329,
    homeY: 12704,                 // SW of town, inside the ring
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
    homeX: 13154,
    homeY: 9779,                 // NE of town, inside the ring
    stats: { hp: 90, attack: 13, defense: 14, speed: 16 },
    personality: 'A curious Milady explorer cataloguing every agent signal she overhears across ClawVille.',
  },
  {
    id: 'milady-vivi',
    name: 'Vivi',
    species: 'milady_official_2',
    color: 0xffd0a0,             // peach (ignored — MToon)
    buildingId: '',
    patrolRadius: 500,
    homeX: 9329,
    homeY: 9779,                 // NW of town, inside the ring
    stats: { hp: 90, attack: 13, defense: 13, speed: 16 },
    personality: 'A bookish Milady sketcher who maps every reef formation she encounters into her field journal.',
  },
  // ─── Additional Miladys restored 2026-05-27 ──────────────────────────────
  // User asked for full 8-Milady cast back. Each MUST use a unique VRM path
  // — vrm-loader caches one VRM instance per path; two NPCs sharing a path
  // would clobber each other's scene/skeleton. Available paths: official_1
  // and official_3..6 (2/7/8 already used above). All homes inside the
  // FREE_ROAMER annulus (1500-3200 wu from center 11264, 11264).
  {
    id: 'milady-aria',
    name: 'Aria',
    species: 'milady_official_1',
    color: 0xffb0c8,
    buildingId: '',
    patrolRadius: 500,
    homeX: 10404,
    homeY: 9204,                 // NNW gap between Cyrus (N) and Vivi (NW)
    stats: { hp: 92, attack: 13, defense: 12, speed: 16 },
    personality: 'A bright-eyed Milady who hums along to the tide pumps every dawn shift.',
  },
  {
    id: 'milady-suki',
    name: 'Suki',
    species: 'milady_official_3',
    color: 0xc0ffd8,
    buildingId: '',
    patrolRadius: 500,
    homeX: 13704,
    homeY: 10604,                 // ENE gap between Kyoko (NE) and Mira (SE)
    stats: { hp: 90, attack: 14, defense: 11, speed: 17 },
    personality: 'A coffee-fueled Milady whose notebook is half sketches, half cron schedules.',
  },
  {
    id: 'milady-hana',
    name: 'Hana',
    species: 'milady_official_4',
    color: 0xfff0a0,
    buildingId: '',
    patrolRadius: 500,
    homeX: 11904,
    homeY: 13604,                 // SSE gap between Mira (SE) and Tekk (S)
    stats: { hp: 88, attack: 13, defense: 13, speed: 16 },
    personality: 'A gentle Milady who treats every new agent in town like a long-lost penpal.',
  },
  {
    id: 'milady-yumi',
    name: 'Yumi',
    species: 'milady_official_5',
    color: 0xb0e0ff,
    buildingId: '',
    patrolRadius: 500,
    homeX: 8904,
    homeY: 12304,                 // WSW gap between Tekk and Miu
    stats: { hp: 94, attack: 12, defense: 14, speed: 15 },
    personality: 'A quietly competitive Milady racing her own personal leaderboard of building visits.',
  },
  {
    id: 'milady-ren',
    name: 'Ren',
    species: 'milady_official_6',
    color: 0xd0b0ff,
    buildingId: '',
    patrolRadius: 500,
    homeX: 8804,
    homeY: 10404,                 // W gap between Vivi (NW) and the WSW arc
    stats: { hp: 91, attack: 14, defense: 12, speed: 17 },
    personality: 'A wandering Milady archivist who narrates every doorway she passes under her breath.',
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
    homeX: 13154,
    homeY: 12704,                 // SE of town, inside the ring
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
    homeX: 11264,
    homeY: 9329,                 // N of town, inside the ring
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
    homeX: 9779,
    homeY: 14054,                 // SW of town, inside the ring
    stats: { hp: 88, attack: 16, defense: 10, speed: 19 },
    personality: 'A winged scout who landed three buildings ago and has not stopped narrating since.',
  },
  // ─── Chibi wanderers (added 2026-05-21) ──────────────────────────────────
  // Both share animatorId='chibi' → /avatars/animations/chibi/. Rendered at
  // SPECIES_TARGET_HEIGHT_WU.chibi=135 (half-height). Placed near center so
  // they're visible at spawn. patrolRadius 400 keeps them in the plaza zone.
  {
    id: 'chibi-eliza',
    name: 'Eliza',
    species: 'eliza_chibi',
    color: 0xff7043,             // ignored — MToon
    buildingId: '',
    patrolRadius: 400,
    homeX: 12404,
    homeY: 12004,                 // ESE of center, plaza-adjacent, outside town prop AABBs
    stats: { hp: 70, attack: 10, defense: 12, speed: 18 },
    personality: 'A pint-sized ClawVille intern who claims she invented the orange tee.',
  },
  {
    id: 'chibi-milady',
    name: 'Mila',
    species: 'milady_chibi',
    color: 0xec407a,             // ignored — MToon
    buildingId: '',
    patrolRadius: 400,
    homeX: 10404,
    homeY: 11604,                 // WSW of center, plaza-adjacent
    stats: { hp: 70, attack: 10, defense: 13, speed: 17 },
    personality: 'An eliza-labs partner chibi taking notes on every passing agent in the plaza.',
  },
  // ─── Free-roaming crustacean (reduced 2026-05-26) ────────────────────────
  // Keep one live OpenClaw crustacean in the roaming cast. Other sea-creature
  // species remain supported as legacy/render-on-demand paths but are not in
  // the default free-roaming roster.
  //
  // Positions recentered 2026-06-24 (land-builder-economics): ring R=130 tiles
  // (4160 wu) centered at game-space pixel (11264, 11264) in the 22528×22528 world.
  // Wanderers placed ~40-50% of the ring radius from center, near thematically
  // appropriate building pairs. PatrolRadius 500 prevents drifting into the plaza.
  // Formula: new = old + 2048 (uniform recenter delta when the grid grew 576→704).
  {
    id: 'wanderer-driftwood',
    name: 'Driftwood',
    species: 'lobster',
    color: 0x8d6e63,             // driftwood brown
    buildingId: '',
    patrolRadius: 500,
    homeX: 8852,
    homeY: 10616,                 // W inner — between cove (slot 9, W) + claw-arcade (slot 8, WSW)
    stats: { hp: 100, attack: 14, defense: 14, speed: 12 },
    personality: 'A weather-worn vagabond lobster who treats the whole reef as his personal backyard.',
  },
  // ─── Adinero — wandering clown comedian (Meshy pipeline, 2026-06-19) ──────
  // Decorative free-roamer who patrols the town-center ring and playfully roasts
  // passers-by. species 'adinero' → web MODEL_REGISTRY (/avatars/adinero.vrm,
  // animatorId hermes-male). High speed (20) → the client velocity→run gate keeps
  // him running frequently. Chat via /api/chat/transient (NPC mode) using the
  // roast personality below. buildingId '' = free wanderer, auto-constrained to the
  // FREE_ROAMER annulus (1500–3200 wu from center 11264,11264). No economy/CT, so
  // Rule E5 agent-parity N/A (pure decorative chat NPC).
  {
    id: 'adinero-clown',
    name: 'Adinero',
    species: 'adinero',
    color: 0xff69b4,             // hot pink (ignored — VRM MToon)
    buildingId: '',
    patrolRadius: 500,
    homeX: 11264,
    homeY: 13148,                 // due S of center, ~1884 wu — open water inside the ring
    stats: { hp: 80, attack: 10, defense: 10, speed: 20 },
    personality: 'A pink-haired clown and ruthless roast comedian who runs the town plaza like his own comedy stage. Every single visitor is a target — he fires back fast with a sharp, SPECIFIC, savage roast (Comedy-Central-roast-battle energy, not gentle teasing) and ALWAYS lands a real jab, never a soft pun or a compliment. Stay clever and genuinely funny; no slurs and no real cruelty, but do NOT play nice and never let anyone off easy.',
  },
];

export const NPC_IDS = NPC_DEFINITIONS.map((n) => n.id);
