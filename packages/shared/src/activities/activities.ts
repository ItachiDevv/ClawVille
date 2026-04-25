/**
 * Q2 Activity Portals — client-side activity registry.
 *
 * Canonical, type-safe catalog of the 10 minigame slots. Two are `live`
 * at Q2 launch (Bumper Shells, Reef Race); the other 8 are `coming-soon`
 * stubs so the BuildingPortalModal can render a "Coming Soon" chip for
 * every non-activity building and preserve the narrative that every
 * building eventually has an activity.
 *
 * This is mirrored by the server's `activities` table row per entry
 * (seeded via `scripts/seed-activities.ts`). The server is authoritative
 * at runtime; this constant is used by the client for:
 *   - Zero-roundtrip type safety on known activity ids
 *   - "Coming Soon" placeholder rendering without a fetch
 *   - Branching check in `enterBuilding()` — `ACTIVITY_REGISTRY.some(a =>
 *     a.buildingId === locationId && a.status === 'live')`
 *
 * Kept in sync rules:
 *   - Building ids MUST match `SHOP_BUILDINGS` entries in
 *     `packages/shared/src/constants/building-types.ts`.
 *   - Per-placement token values mirror the LOCKED schedule from the
 *     Q2 plan (Bumper 45/30/20/10/5 + 5 floor; Reef +5 per tier + 10 PB).
 *   - When a `coming-soon` entry graduates to `live`, update here AND
 *     seed the server row (both enabled=true AND `status: 'live'`).
 */

/**
 * Per-placement token award tier.
 */
export interface ActivityRewardPlacement {
  rank: number;
  tokens: number;
}

/**
 * Per-activity reward configuration. Mirrors the server
 * `activities.reward_config` JSONB shape — keep in sync.
 */
export interface ActivityRewardConfig {
  /** Per-placement token tiers. Ranks not listed fall through to the
   *  participation floor (`participationTokens`). */
  placements?: ActivityRewardPlacement[];
  /** Floor tokens awarded to every participant, regardless of placement */
  participationTokens?: number;
  /** One-time bonus for the first completed match of a day (UTC) */
  firstPlayOfDayBonusTokens?: number;
  /** Reef Race — bonus for setting a new personal best lap/finish */
  personalBestBonusTokens?: number;
  /**
   * Reef Race Phase 4 — bonus for completing a "perfect race" — i.e.
   * `bestStreakThisMatch` reaches `TOTAL_CHECKPOINTS_PER_RACE` (= 36 =
   * 12 cps × 3 laps with every hairpin clean). Defaults to 0 when not
   * configured. C3-fix consumers read `bestStreakThisMatch` from the
   * `SimResultRow.reefRace` block embedded at `computeResults()` time —
   * never from a live state accessor that could race sim teardown.
   */
  perfectStreakBonusTokens?: number;
  /** Focus-aligned bonus pct applied to total tokens (e.g. 25 = +25%) */
  focusBonusPct?: number;
  /**
   * Leaderboard points per placement — keyed by rank string ("1","2","3")
   * with a `default` fallback. Fed into the free-agent leaderboard's
   * `activityPlacement` weight tier (see CLAUDE.md Priority #3).
   */
  leaderboardPoints?: Record<string, number>;
}

export interface ActivityDefinition {
  /** Stable activity id — matches `activities.id` on the server */
  id: string;
  /** Host building id — matches a SHOP_BUILDINGS entry */
  buildingId: string;
  /** Display title (e.g. 'Bumper Shells') */
  title: string;
  /** One-liner shown on the portal modal and lobby card */
  tagline: string;
  minPlayers: number;
  maxPlayers: number;
  /** Matchmaker floor before forced start at extended timeout */
  queueMinPlayers: number;
  /** Round length in seconds (Bumper = 90; Reef lap-based, target ~110) */
  roundSeconds: number;
  /** WebP thumbnail path under /public. Omit when art hasn't shipped —
   *  the UI's ActivityThumbnail gradient fallback covers it. Setting a
   *  string that 404s is worse (browser stack-trace + console spam). */
  thumbnailUrl?: string;
  /** Plain-English skill the activity rehearses (portal flavor copy) */
  openclawSkill: string;
  /** Other building ids whose focus category aligns — drives focus bonus */
  skillBuildingMatches: string[];
  /** 'live' = queueable today; 'coming-soon' = render stub with chip */
  status: 'live' | 'coming-soon';
  /** Payout schedule — null for coming-soon stubs */
  rewardConfig?: ActivityRewardConfig;
}

/**
 * LOCKED Bumper Shells reward schedule (plan §"Game design — Bumper
 * Shells → Rewards (LOCKED)"):
 *   1st=45, 2nd=30, 3rd=20, 4th–6th=10, 7th–8th=5, participation=5,
 *   first-play-of-day +15, focus +25%, leaderboard {1:30,2:15,3:8,def:2}.
 */
const BUMPER_SHELLS_REWARD_CONFIG: ActivityRewardConfig = {
  placements: [
    { rank: 1, tokens: 45 },
    { rank: 2, tokens: 30 },
    { rank: 3, tokens: 20 },
    { rank: 4, tokens: 10 },
    { rank: 5, tokens: 10 },
    { rank: 6, tokens: 10 },
    { rank: 7, tokens: 5 },
    { rank: 8, tokens: 5 },
  ],
  participationTokens: 5,
  firstPlayOfDayBonusTokens: 15,
  focusBonusPct: 25,
  leaderboardPoints: { '1': 30, '2': 15, '3': 8, default: 2 },
};

/**
 * LOCKED Reef Race reward schedule (plan §"Game design — Reef Race →
 * Rewards (LOCKED)"): +5/tier over Bumper, +10 PB.
 *   1st=50, 2nd=35, 3rd=25, 4th–6th=15, 7th–8th=10, participation=10,
 *   PB +10, first-play-of-day +15, focus +25%,
 *   leaderboard {1:30,2:15,3:8,def:2}.
 */
const REEF_RACE_REWARD_CONFIG: ActivityRewardConfig = {
  placements: [
    { rank: 1, tokens: 50 },
    { rank: 2, tokens: 35 },
    { rank: 3, tokens: 25 },
    { rank: 4, tokens: 15 },
    { rank: 5, tokens: 15 },
    { rank: 6, tokens: 15 },
    { rank: 7, tokens: 10 },
    { rank: 8, tokens: 10 },
  ],
  participationTokens: 10,
  firstPlayOfDayBonusTokens: 15,
  personalBestBonusTokens: 10,
  // Phase 4 — perfect race (36/36 clean checkpoint crosses). Sits on top
  // of placement + first-play + PB + focus bonuses; sums into the same
  // `tokens_awarded` total surfaced on the match-end modal.
  perfectStreakBonusTokens: 25,
  focusBonusPct: 25,
  leaderboardPoints: { '1': 30, '2': 15, '3': 8, default: 2 },
};

/**
 * Canonical activity list — 2 live + 8 coming-soon.
 *
 * IMPORTANT: order matters for the portal grid rendering; live entries
 * surface first, coming-soon follow in neighborhood order (mirrors
 * MAP_LOCATIONS clustering). Changing order is UX-visible — coordinate
 * with frontend before reordering.
 */
export const ACTIVITY_REGISTRY: readonly ActivityDefinition[] = [
  // ─── Live at Q2 launch ────────────────────────────────────────────────────
  {
    id: 'bumper-shells',
    buildingId: 'webhook-gateway', // Salty Spitoon
    title: 'Bumper Shells',
    tagline: 'Ram opponents off the edge. Last shell standing wins.',
    minPlayers: 4,
    maxPlayers: 8,
    queueMinPlayers: 4,
    roundSeconds: 90,
    // thumbnailUrl omitted until art ships — ActivityThumbnail's gradient
    // fallback already reads as intentional, and a missing file 404s
    // every lobby open + spams the console with the Image error stack.
    openclawSkill: 'Request handling under load',
    skillBuildingMatches: ['webhook-gateway'],
    status: 'live',
    rewardConfig: BUMPER_SHELLS_REWARD_CONFIG,
  },
  {
    id: 'reef-race',
    buildingId: 'voice-tower', // Boating School
    title: 'Reef Race',
    tagline: 'Three laps through the reef. Drift, boost, outrun the pack.',
    minPlayers: 4,
    maxPlayers: 8,
    queueMinPlayers: 4,
    roundSeconds: 110,
    // thumbnailUrl omitted — see bumper-shells comment above.
    openclawSkill: 'Fast, low-latency research loops',
    skillBuildingMatches: ['voice-tower'],
    status: 'live',
    rewardConfig: REEF_RACE_REWARD_CONFIG,
  },

  // ─── Coming soon (8 stubs — one per non-live building) ────────────────────
  {
    id: 'patty-stack',
    buildingId: 'tool-workshop', // Krusty Krab
    title: 'Patty Stack',
    tagline: 'Speed-assemble Krabby Patties under a rush-hour clock.',
    minPlayers: 1,
    maxPlayers: 8,
    queueMinPlayers: 1,
    roundSeconds: 90,
    thumbnailUrl: '/images/activities/patty-stack.webp',
    openclawSkill: 'Tool chaining & MCP orchestration',
    skillBuildingMatches: ['tool-workshop'],
    status: 'coming-soon',
  },
  {
    id: 'clarinet-memory',
    buildingId: 'memory-vault', // Squidward's House
    title: 'Clarinet Memory',
    tagline: 'Simon-says with Squidward. Repeat the sequence or else.',
    minPlayers: 1,
    maxPlayers: 4,
    queueMinPlayers: 1,
    roundSeconds: 120,
    thumbnailUrl: '/images/activities/clarinet-memory.webp',
    openclawSkill: 'RAG recall accuracy',
    skillBuildingMatches: ['memory-vault'],
    status: 'coming-soon',
  },
  {
    id: 'karate-chop',
    buildingId: 'channel-bridge', // Sandy's Treedome
    title: 'Karate Chop',
    tagline: 'Dodge, parry, chop. One-on-one tempo duels.',
    minPlayers: 2,
    maxPlayers: 2,
    queueMinPlayers: 2,
    roundSeconds: 60,
    thumbnailUrl: '/images/activities/karate-chop.webp',
    openclawSkill: 'Multi-channel message timing',
    skillBuildingMatches: ['channel-bridge'],
    status: 'coming-soon',
  },
  {
    id: 'salvage-run',
    buildingId: 'canvas-studio', // Pineapple House
    title: 'Salvage Run',
    tagline: 'Dive the wreck. Grab the data. Surface before the timer.',
    minPlayers: 1,
    maxPlayers: 4,
    queueMinPlayers: 1,
    roundSeconds: 120,
    thumbnailUrl: '/images/activities/salvage-run.webp',
    openclawSkill: 'Data extraction & pipeline building',
    skillBuildingMatches: ['canvas-studio'],
    status: 'coming-soon',
  },
  {
    id: 'jellyfishing',
    buildingId: 'skill-forge', // Chum Bucket
    title: 'Jellyfishing',
    tagline: 'Catch glowing jellies without getting zapped.',
    minPlayers: 1,
    maxPlayers: 4,
    queueMinPlayers: 1,
    roundSeconds: 90,
    thumbnailUrl: '/images/activities/jellyfishing.webp',
    openclawSkill: 'Debug loop discipline',
    skillBuildingMatches: ['skill-forge'],
    status: 'coming-soon',
  },
  {
    id: 'rock-toss',
    buildingId: 'security-fortress', // Patrick's Rock
    title: 'Rock Toss',
    tagline: 'Hit the target. Win the prize. Break nothing on-chain.',
    minPlayers: 2,
    maxPlayers: 8,
    queueMinPlayers: 2,
    roundSeconds: 60,
    thumbnailUrl: '/images/activities/rock-toss.webp',
    openclawSkill: 'Transaction targeting & Solana precision',
    skillBuildingMatches: ['security-fortress'],
    status: 'coming-soon',
  },
  {
    id: 'co-op-puzzle',
    buildingId: 'cron-hub', // Downtown Building
    title: 'Co-op Puzzle Lab',
    tagline: 'Two agents, one puzzle. Wire the workflow together.',
    minPlayers: 2,
    maxPlayers: 2,
    queueMinPlayers: 2,
    roundSeconds: 180,
    thumbnailUrl: '/images/activities/co-op-puzzle.webp',
    openclawSkill: 'Scheduled automation & branching workflows',
    skillBuildingMatches: ['cron-hub'],
    status: 'coming-soon',
  },
  {
    id: 'tide-tower-defense',
    buildingId: 'config-citadel', // Lighthouse
    title: 'Tide Tower Defense',
    tagline: 'Defend the Lighthouse. Waves incoming. Place your towers.',
    minPlayers: 1,
    maxPlayers: 4,
    queueMinPlayers: 1,
    roundSeconds: 300,
    thumbnailUrl: '/images/activities/tide-tower-defense.webp',
    openclawSkill: 'Config & deployment coordination',
    skillBuildingMatches: ['config-citadel'],
    status: 'coming-soon',
  },
] as const;

/** Activity ids derived from the registry — handy for Zod enums */
export const ACTIVITY_IDS = ACTIVITY_REGISTRY.map((a) => a.id);

export type ActivityId = (typeof ACTIVITY_REGISTRY)[number]['id'];

/**
 * Is this activity playable right now? Use in branching code paths
 * (portal modal, queue entry) that should short-circuit on stubs.
 */
export function isActivityLive(activityId: string): boolean {
  return ACTIVITY_REGISTRY.some(
    (a) => a.id === activityId && a.status === 'live',
  );
}

/** Lookup helper — returns undefined for unknown ids. */
export function getActivityDefinition(
  activityId: string,
): ActivityDefinition | undefined {
  return ACTIVITY_REGISTRY.find((a) => a.id === activityId);
}

/** All live activities hosted by a given building (usually 0 or 1). */
export function getLiveActivitiesForBuilding(
  buildingId: string,
): ActivityDefinition[] {
  return ACTIVITY_REGISTRY.filter(
    (a) => a.buildingId === buildingId && a.status === 'live',
  );
}
