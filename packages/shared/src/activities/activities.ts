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
 * Texas Hold'em (Phase P1) reward schedule — PLACEHOLDER. Money/CT settlement
 * + leaderboard crediting for poker are OUT OF SCOPE for the P1.2b phase (demo
 * in-memory chip stacks only). This config exists so the registry entry is a
 * well-formed `live` row; it is NOT yet wired into the reward pipeline (poker
 * has no `computeResults`/`setEndedFn` registration this phase). The numbers
 * mirror the Reef Race tier shape and will be re-derived from the cove economy
 * model when settlement lands.
 */
const TEXAS_HOLDEM_REWARD_CONFIG: ActivityRewardConfig = {
  placements: [
    { rank: 1, tokens: 50 },
    { rank: 2, tokens: 25 },
    { rank: 3, tokens: 10 },
  ],
  participationTokens: 5,
  leaderboardPoints: { '1': 30, '2': 15, '3': 8, default: 2 },
};

/**
 * Canonical activity list — 3 live + 8 coming-soon.
 *
 * IMPORTANT: order matters for the portal grid rendering; live entries
 * surface first, coming-soon follow in neighborhood order (mirrors
 * MAP_LOCATIONS clustering). Changing order is UX-visible — coordinate
 * with frontend before reordering.
 */
export const ACTIVITY_REGISTRY: readonly ActivityDefinition[] = [
  // ─── Live at Q2 launch ────────────────────────────────────────────────────
  {
    id: 'texas-holdem',
    buildingId: 'cove', // The Cove (entertainment venue — poker table)
    title: "Texas Hold'em",
    tagline: 'Live No-Limit Hold’em. Read the table, size your bets, take the pot.',
    minPlayers: 2,
    maxPlayers: 9,
    queueMinPlayers: 2,
    // Hold'em is turn-based (no fixed round timer) — `roundSeconds` is the
    // soft lobby-fill / display hint only. Per-turn action clock lives in the
    // sim's `turnClockMs`, not here.
    roundSeconds: 600,
    // thumbnailUrl omitted until art ships — gradient fallback covers it.
    openclawSkill: 'Incomplete-information decision-making under uncertainty',
    skillBuildingMatches: ['cove'],
    status: 'live',
    rewardConfig: TEXAS_HOLDEM_REWARD_CONFIG,
  },
  {
    // ── Poker MTT (P3.5) — tournament TABLES, NOT a portal-queued activity ─────
    // A tournament table is a SEPARATE activityId from the single-table cove demo
    // (`texas-holdem`) so its WS dispatch + LIVE transition target the DEDICATED
    // `pokerMttSim` (driven by the TournamentManager), never the demo
    // `pokerTableSim`. The two sims + activityIds stay fully isolated.
    //
    // It is `coming-soon` (NOT portal-queueable) ON PURPOSE: a tournament table is
    // SEATED by the TournamentManager when a registered field starts — it is never
    // created via the matchmaker/portal queue, so it must not surface as a second
    // queueable cove activity (which would collide with the `texas-holdem` demo in
    // `getLiveActivitiesForBuilding('cove')`). The registry entry exists only so
    // the activityId is type-safe + recognized by the WS hub's MTT dispatch.
    id: 'texas-holdem-mtt',
    buildingId: 'cove', // The Cove (entertainment venue — tournament poker table)
    title: "Texas Hold'em — Tournament",
    tagline: 'Multi-table tournament poker. Survive the field, climb the prize ladder.',
    minPlayers: 2,
    maxPlayers: 9,
    queueMinPlayers: 2,
    roundSeconds: 600,
    openclawSkill: 'Tournament survival + variable-stack decision-making',
    skillBuildingMatches: ['cove'],
    status: 'coming-soon',
  },
  {
    id: 'bumper-shells',
    buildingId: 'api-integrations', // Salty Spitoon
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
    skillBuildingMatches: ['api-integrations'],
    status: 'live',
    rewardConfig: BUMPER_SHELLS_REWARD_CONFIG,
  },
  {
    id: 'reef-race',
    buildingId: 'app-publishing', // Boating School
    title: 'Reef Race',
    tagline: 'Three laps through the reef. Drift, boost, outrun the pack.',
    minPlayers: 4,
    maxPlayers: 8,
    queueMinPlayers: 4,
    roundSeconds: 110,
    // thumbnailUrl omitted — see bumper-shells comment above.
    openclawSkill: 'Fast, low-latency research loops',
    skillBuildingMatches: ['app-publishing'],
    status: 'live',
    rewardConfig: REEF_RACE_REWARD_CONFIG,
  },

  // ─── Coming soon (8 stubs — one per non-live building) ────────────────────
  {
    id: 'patty-stack',
    buildingId: 'mcp-tool-use', // Krusty Krab
    title: 'Patty Stack',
    tagline: 'Speed-assemble Krabby Patties under a rush-hour clock.',
    minPlayers: 1,
    maxPlayers: 8,
    queueMinPlayers: 1,
    roundSeconds: 90,
    thumbnailUrl: '/images/activities/patty-stack.webp',
    openclawSkill: 'Tool chaining & MCP orchestration',
    skillBuildingMatches: ['mcp-tool-use'],
    status: 'coming-soon',
  },
  {
    id: 'clarinet-memory',
    buildingId: 'memory-rag', // Squidward's House
    title: 'Clarinet Memory',
    tagline: 'Simon-says with Squidward. Repeat the sequence or else.',
    minPlayers: 1,
    maxPlayers: 4,
    queueMinPlayers: 1,
    roundSeconds: 120,
    thumbnailUrl: '/images/activities/clarinet-memory.webp',
    openclawSkill: 'RAG recall accuracy',
    skillBuildingMatches: ['memory-rag'],
    status: 'coming-soon',
  },
  {
    id: 'karate-chop',
    buildingId: 'messaging-channels', // Sandy's Treedome
    title: 'Karate Chop',
    tagline: 'Dodge, parry, chop. One-on-one tempo duels.',
    minPlayers: 2,
    maxPlayers: 2,
    queueMinPlayers: 2,
    roundSeconds: 60,
    thumbnailUrl: '/images/activities/karate-chop.webp',
    openclawSkill: 'Multi-channel message timing',
    skillBuildingMatches: ['messaging-channels'],
    status: 'coming-soon',
  },
  {
    id: 'salvage-run',
    buildingId: 'visual-creation', // Pineapple House
    title: 'Salvage Run',
    tagline: 'Dive the wreck. Grab the data. Surface before the timer.',
    minPlayers: 1,
    maxPlayers: 4,
    queueMinPlayers: 1,
    roundSeconds: 120,
    thumbnailUrl: '/images/activities/salvage-run.webp',
    openclawSkill: 'Data extraction & pipeline building',
    skillBuildingMatches: ['visual-creation'],
    status: 'coming-soon',
  },
  {
    id: 'jellyfishing',
    buildingId: 'code-development', // Chum Bucket
    title: 'Jellyfishing',
    tagline: 'Catch glowing jellies without getting zapped.',
    minPlayers: 1,
    maxPlayers: 4,
    queueMinPlayers: 1,
    roundSeconds: 90,
    thumbnailUrl: '/images/activities/jellyfishing.webp',
    openclawSkill: 'Debug loop discipline',
    skillBuildingMatches: ['code-development'],
    status: 'coming-soon',
  },
  {
    id: 'rock-toss',
    buildingId: 'agent-security', // Patrick's Rock
    title: 'Rock Toss',
    tagline: 'Hit the target. Win the prize. Break nothing on-chain.',
    minPlayers: 2,
    maxPlayers: 8,
    queueMinPlayers: 2,
    roundSeconds: 60,
    thumbnailUrl: '/images/activities/rock-toss.webp',
    openclawSkill: 'Transaction targeting & Solana precision',
    skillBuildingMatches: ['agent-security'],
    status: 'coming-soon',
  },
  {
    id: 'co-op-puzzle',
    buildingId: 'cron-automation', // Downtown Building
    title: 'Co-op Puzzle Lab',
    tagline: 'Two agents, one puzzle. Wire the workflow together.',
    minPlayers: 2,
    maxPlayers: 2,
    queueMinPlayers: 2,
    roundSeconds: 180,
    thumbnailUrl: '/images/activities/co-op-puzzle.webp',
    openclawSkill: 'Scheduled automation & branching workflows',
    skillBuildingMatches: ['cron-automation'],
    status: 'coming-soon',
  },
  {
    id: 'tide-tower-defense',
    buildingId: 'deployment-ops', // Lighthouse
    title: 'Tide Tower Defense',
    tagline: 'Defend the Lighthouse. Waves incoming. Place your towers.',
    minPlayers: 1,
    maxPlayers: 4,
    queueMinPlayers: 1,
    roundSeconds: 300,
    thumbnailUrl: '/images/activities/tide-tower-defense.webp',
    openclawSkill: 'Config & deployment coordination',
    skillBuildingMatches: ['deployment-ops'],
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
