/**
 * Leaderboard routes — two surfaces on the same mount:
 *
 *   1. `GET /api/leaderboard`        — legacy composite board (avatars only,
 *       economy-weighted, auth'd, consumed by `leaderboard-modal.tsx`).
 *       Kept intact so the in-game modal still works during the Priority #3
 *       brand pivot transition period.
 *
 *   2. `GET /api/leaderboard/agents` — **Priority #3 public free agent
 *       leaderboard** (2026-04-21). Public, no auth, event-weighted. Ranks
 *       agents by their *contribution* to ClawVille — no buying/selling.
 *       Reads exclusively from the `events` table.
 *
 * The existing economy route is untouched below; the new public route is
 * appended at the bottom along with its dedicated 60s cache, rate limiter,
 * scoring rubric, and openclaw_bots / wallets join.
 *
 * See `CLAUDE.md` §Priority #3 and `ARCHITECTURE.md` §Observability
 * (subsection "Free Agent Leaderboard") for the full rubric.
 *
 * ---------------------------------------------------------------------------
 * Legacy composite board — unchanged from Priority #3 pre-pivot code.
 * ---------------------------------------------------------------------------
 *
 * Aggregates live from existing sources of truth:
 *
 *   - avatars.clawTokens ................ liquid balance ("gold" tab)
 *   - claw_token_transactions ........ lifetime earnings ("earned" tab)
 *   - bazaar_transactions ........... skill sales volume ("skills-sold" tab)
 *   - quest_rewards ................. quest completions ("quests" tab)
 *   - bounty_reputation.totalCompleted   bounty completions ("bounties" tab)
 *   - published_skills .............. total skills authored ("authored" tab)
 *
 * A lightweight 30-second in-memory cache keeps the public browse path cheap
 * even if it ends up getting hit by every avatar on every page load. No
 * leaderboard table means no backfill, no migration, and no "stale entry"
 * class of bugs — rankings recompute on every cache miss.
 */

import { Hono } from 'hono';
import { eq, sql, and, gt, inArray } from 'drizzle-orm';
import {
  db,
  avatars,
  clawTokenTransactions,
  bazaarTransactions,
  publishedSkills,
  questRewards,
  bountyReputation,
  openclawBots,
} from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import type { AppContext } from '../types';

// ---------------------------------------------------------------------------
// Types — legacy composite
// ---------------------------------------------------------------------------

type SortMode =
  | 'composite'
  | 'gold'
  | 'earned'
  | 'skills-sold'
  | 'skills-authored'
  | 'quests'
  | 'bounties';

interface LeaderboardEntry {
  rank: number;
  avatarId: string;
  avatarName: string;
  species: string;
  color: string | number | null;
  archetype: string | null;
  // Metrics (all always populated so the UI can show the same row across tabs)
  gold: number;
  earned: number;
  skillsSold: number;
  skillsAuthored: number;
  questsCompleted: number;
  bountiesCompleted: number;
  compositeScore: number;
}

interface LeaderboardSnapshot {
  entries: LeaderboardEntry[];
  totalPets: number;
  generatedAt: string;
}

const VALID_SORTS: SortMode[] = [
  'composite',
  'gold',
  'earned',
  'skills-sold',
  'skills-authored',
  'quests',
  'bounties',
];

// ---------------------------------------------------------------------------
// Composite score weights — tuned so that a high-activity avatar across every
// metric beats one who only sits on a gold pile. Keep the numbers small and
// integer-friendly so the score is easy to reason about.
// ---------------------------------------------------------------------------
const COMPOSITE_WEIGHTS = {
  gold: 1,            // 1 pt per ClawToken held
  earned: 1,          // 1 pt per ClawToken ever earned (tracks activity, not hoarding)
  skillsSold: 500,    // skilled sellers get big credit
  skillsAuthored: 250, // publishing even without sales counts
  questsCompleted: 300,
  bountiesCompleted: 400,
};

function computeComposite(e: Omit<LeaderboardEntry, 'rank' | 'compositeScore'>): number {
  return (
    e.gold * COMPOSITE_WEIGHTS.gold +
    e.earned * COMPOSITE_WEIGHTS.earned +
    e.skillsSold * COMPOSITE_WEIGHTS.skillsSold +
    e.skillsAuthored * COMPOSITE_WEIGHTS.skillsAuthored +
    e.questsCompleted * COMPOSITE_WEIGHTS.questsCompleted +
    e.bountiesCompleted * COMPOSITE_WEIGHTS.bountiesCompleted
  );
}

// ---------------------------------------------------------------------------
// In-memory cache (legacy composite) — 30s TTL keyed only on cap.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;
const DEFAULT_CAP = 500;

interface CacheEntry {
  snapshot: LeaderboardSnapshot;
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();

function getCache(cap: number): LeaderboardSnapshot | null {
  const hit = cache.get(cap);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(cap);
    return null;
  }
  return hit.snapshot;
}

function setCache(cap: number, snapshot: LeaderboardSnapshot) {
  cache.set(cap, { snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Aggregation (legacy composite) — one pass per metric, then join by avatarId.
// ---------------------------------------------------------------------------

async function buildSnapshot(cap: number): Promise<LeaderboardSnapshot> {
  const petRows = await db
    .select({
      id: avatars.id,
      name: avatars.name,
      species: avatars.species,
      color: avatars.color,
      archetype: avatars.archetype,
      clawTokens: avatars.clawTokens,
    })
    .from(avatars)
    .where(eq(avatars.isActive, true));

  if (petRows.length === 0) {
    return { entries: [], totalPets: 0, generatedAt: new Date().toISOString() };
  }

  const earnedRows = await db
    .select({
      avatarId: clawTokenTransactions.avatarId,
      total: sql<number>`coalesce(sum(${clawTokenTransactions.amount}), 0)`.as('total'),
    })
    .from(clawTokenTransactions)
    .where(gt(clawTokenTransactions.amount, 0))
    .groupBy(clawTokenTransactions.avatarId);

  const earnedByPet = new Map<string, number>(
    earnedRows.map((r) => [r.avatarId, Number(r.total) || 0])
  );

  const soldRows = await db
    .select({
      avatarId: bazaarTransactions.sellerId,
      total: sql<number>`count(*)`.as('total'),
    })
    .from(bazaarTransactions)
    .groupBy(bazaarTransactions.sellerId);

  const soldByPet = new Map<string, number>(
    soldRows.map((r) => [r.avatarId, Number(r.total) || 0])
  );

  const authoredRows = await db
    .select({
      avatarId: publishedSkills.authorAvatarId,
      total: sql<number>`count(*)`.as('total'),
    })
    .from(publishedSkills)
    .where(sql`${publishedSkills.authorAvatarId} is not null`)
    .groupBy(publishedSkills.authorAvatarId);

  const authoredByPet = new Map<string, number>(
    authoredRows
      .filter((r): r is { avatarId: string; total: number } => r.avatarId !== null)
      .map((r) => [r.avatarId, Number(r.total) || 0])
  );

  const questRows = await db
    .select({
      avatarId: questRewards.avatarId,
      total: sql<number>`count(*)`.as('total'),
    })
    .from(questRewards)
    .groupBy(questRewards.avatarId);

  const questByPet = new Map<string, number>(
    questRows.map((r) => [r.avatarId, Number(r.total) || 0])
  );

  const bountyRows = await db
    .select({
      avatarId: bountyReputation.avatarId,
      totalCompleted: bountyReputation.totalCompleted,
    })
    .from(bountyReputation);

  const bountyByPet = new Map<string, number>(
    bountyRows.map((r) => [r.avatarId, r.totalCompleted || 0])
  );

  const partialEntries = petRows.map((avatar) => {
    const body = {
      avatarId: avatar.id,
      avatarName: avatar.name,
      species: avatar.species,
      color: avatar.color ?? null,
      archetype: avatar.archetype ?? null,
      gold: avatar.clawTokens || 0,
      earned: earnedByPet.get(avatar.id) || 0,
      skillsSold: soldByPet.get(avatar.id) || 0,
      skillsAuthored: authoredByPet.get(avatar.id) || 0,
      questsCompleted: questByPet.get(avatar.id) || 0,
      bountiesCompleted: bountyByPet.get(avatar.id) || 0,
    };
    return { ...body, compositeScore: computeComposite(body) };
  });

  partialEntries.sort((a, b) => b.compositeScore - a.compositeScore);

  const capped = partialEntries.slice(0, cap);
  const ranked: LeaderboardEntry[] = capped.map((entry, idx) => ({
    rank: idx + 1,
    ...entry,
  }));

  return {
    entries: ranked,
    totalPets: petRows.length,
    generatedAt: new Date().toISOString(),
  };
}

function sortBy(entries: LeaderboardEntry[], mode: SortMode): LeaderboardEntry[] {
  const sorted = [...entries];
  switch (mode) {
    case 'gold':
      sorted.sort((a, b) => b.gold - a.gold);
      break;
    case 'earned':
      sorted.sort((a, b) => b.earned - a.earned);
      break;
    case 'skills-sold':
      sorted.sort((a, b) => b.skillsSold - a.skillsSold);
      break;
    case 'skills-authored':
      sorted.sort((a, b) => b.skillsAuthored - a.skillsAuthored);
      break;
    case 'quests':
      sorted.sort((a, b) => b.questsCompleted - a.questsCompleted);
      break;
    case 'bounties':
      sorted.sort((a, b) => b.bountiesCompleted - a.bountiesCompleted);
      break;
    case 'composite':
    default:
      sorted.sort((a, b) => b.compositeScore - a.compositeScore);
  }
  return sorted.map((entry, idx) => ({ ...entry, rank: idx + 1 }));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const leaderboardRoutes = new Hono<AppContext>();

// ---- Public free agent leaderboard (Priority #3) --------------------------
//
// Mounted FIRST so its dedicated rate limiter runs before the shared
// sessionMiddleware below. The `/agents` path is explicitly public — no
// auth cookie required — so people can link a rank card anywhere (Twitter,
// Milady, docs) without forcing a login round-trip.

type AgentLeaderboardWindow = '24h' | '7d' | '30d' | 'all';
const VALID_WINDOWS: AgentLeaderboardWindow[] = ['24h', '7d', '30d', 'all'];

interface AgentScoreBreakdown {
  building_visits: number;
  teacher_chats: number;
  collaborations: number;
  skill_fetches: number;
  sessions: number;
  // Q2 chunk #7 — per-placement activity match counts. Driven by
  // `activity.match.placed` events; bots filtered out at SQL level so
  // these only reflect human + user-agent contributions.
  activity_wins: number;
  activity_silver: number;
  activity_bronze: number;
  activity_other: number;
}

interface AgentLeaderboardEntry {
  rank: number;
  agentId: string;
  avatarId: string | null;
  avatarName: string | null;
  walletAddress: string | null;
  score: number;
  breakdown: AgentScoreBreakdown;
}

interface AgentLeaderboardSnapshot {
  window: AgentLeaderboardWindow;
  generatedAt: string;
  agents: AgentLeaderboardEntry[];
  totalRanked: number;
}

// Scoring rubric — keep in sync with the ARCHITECTURE.md §Observability
// "Free Agent Leaderboard" table.
const AGENT_SCORE_WEIGHTS = {
  buildingVisit: 10,    // drives world exploration
  teacherChat: 5,       // MiladyAI teacher-chat — the core learning loop
  collaboration: 25,    // agent↔agent — explicit Priority #3 signal
  skillFetch: 3,        // knowledge fetched
  session: 1,           // cheap participation bonus
  identityIssued: 5,    // Phase 5.1 onboarding bonus, capped via MAX below
} as const;

/**
 * Q2 Activity Portals — placement-tier weights for `activity.match.placed`
 * events (chunk #7). Below collab (25) intentionally — winning matches
 * < contributing knowledge transfer; a 1st-place match (30) > a single
 * teacher chat (5). See backend §6.3 + Brand Identity §1.
 *
 * Bots are filtered at SQL level via `payload->>'subjectType' != 'bot'`
 * — bot rows DO emit `activity.match.placed` for telemetry, but their
 * agentId is null + subjectType='bot' so a non-bot filter excludes them
 * from leaderboard credit. Per chunk #10 carve-out.
 */
const ACTIVITY_PLACEMENT_WEIGHTS = {
  1: 30,
  2: 15,
  3: 8,
  default: 2,
} as const;

const AGENT_CACHE_TTL_MS = 60_000;

interface AgentCacheEntry {
  snapshot: AgentLeaderboardSnapshot;
  expiresAt: number;
}

const agentCache = new Map<AgentLeaderboardWindow, AgentCacheEntry>();

function getAgentCache(window: AgentLeaderboardWindow): AgentLeaderboardSnapshot | null {
  const hit = agentCache.get(window);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    agentCache.delete(window);
    return null;
  }
  return hit.snapshot;
}

function setAgentCache(window: AgentLeaderboardWindow, snapshot: AgentLeaderboardSnapshot) {
  agentCache.set(window, { snapshot, expiresAt: Date.now() + AGENT_CACHE_TTL_MS });
}

function windowToInterval(window: AgentLeaderboardWindow): string {
  // Whitelisted — no user input reaches the SQL string beyond this switch.
  switch (window) {
    case '24h': return '24 hours';
    case '7d':  return '7 days';
    case '30d': return '30 days';
    case 'all': return '100 years'; // effectively "no cutoff" without branching the SQL
  }
}

/**
 * Aggregate events into a ranked agent snapshot.
 *
 * Single `GROUP BY agent_id` pass with filtered aggregates — each metric
 * reuses the one table scan. PostgreSQL plans this as a hash aggregate over
 * the already-covering `idx_events_type_ts` + `idx_events_agent_ts` indexes.
 * Joining avatar / openclaw_bots / wallets happens in memory via two batched
 * `inArray` round trips, never a cartesian.
 */
async function buildAgentSnapshot(
  window: AgentLeaderboardWindow,
  limit: number,
): Promise<AgentLeaderboardSnapshot> {
  const interval = windowToInterval(window);

  const W = AGENT_SCORE_WEIGHTS;

  // Use `sql.raw` for the interval because drizzle's bound-parameter path
  // doesn't support interval literals directly, and we've whitelisted the
  // `interval` string above.
  const A = ACTIVITY_PLACEMENT_WEIGHTS;
  const aggRows = await db.execute<{
    agent_id: string;
    building_visits: number;
    teacher_chats: number;
    collaborations: number;
    skill_fetches: number;
    sessions: number;
    onboarded: number;
    activity_wins: number;
    activity_silver: number;
    activity_bronze: number;
    activity_other: number;
    score: number;
  }>(sql`
    SELECT
      agent_id,
      COUNT(*) FILTER (WHERE event_type = 'building.visited')::int          AS building_visits,
      COUNT(*) FILTER (WHERE event_type = 'agent.chat.turn')::int           AS teacher_chats,
      COUNT(*) FILTER (WHERE event_type = 'agent.collaboration.turn')::int  AS collaborations,
      COUNT(*) FILTER (WHERE event_type = 'skill_md.fetched')::int          AS skill_fetches,
      COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'agent.connected')::int AS sessions,
      MAX(CASE WHEN event_type = 'identity.issued' THEN 1 ELSE 0 END)::int  AS onboarded,
      -- Q2 chunk #7 — per-placement counts for activity.match.placed.
      -- Bots are excluded via the subjectType filter so the agent
      -- leaderboard only credits human-bound or user-agent participants.
      COUNT(*) FILTER (
        WHERE event_type = 'activity.match.placed'
          AND payload->>'placement' = '1'
          AND coalesce(payload->>'subjectType','') <> 'bot'
      )::int AS activity_wins,
      COUNT(*) FILTER (
        WHERE event_type = 'activity.match.placed'
          AND payload->>'placement' = '2'
          AND coalesce(payload->>'subjectType','') <> 'bot'
      )::int AS activity_silver,
      COUNT(*) FILTER (
        WHERE event_type = 'activity.match.placed'
          AND payload->>'placement' = '3'
          AND coalesce(payload->>'subjectType','') <> 'bot'
      )::int AS activity_bronze,
      COUNT(*) FILTER (
        WHERE event_type = 'activity.match.placed'
          AND payload->>'placement' NOT IN ('1','2','3')
          AND coalesce(payload->>'subjectType','') <> 'bot'
      )::int AS activity_other,
      (
        COUNT(*) FILTER (WHERE event_type = 'building.visited')          * ${W.buildingVisit}
        + COUNT(*) FILTER (WHERE event_type = 'agent.chat.turn')         * ${W.teacherChat}
        + COUNT(*) FILTER (WHERE event_type = 'agent.collaboration.turn')* ${W.collaboration}
        + COUNT(*) FILTER (WHERE event_type = 'skill_md.fetched')        * ${W.skillFetch}
        + COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'agent.connected') * ${W.session}
        + MAX(CASE WHEN event_type = 'identity.issued' THEN ${W.identityIssued} ELSE 0 END)
        + COUNT(*) FILTER (
            WHERE event_type = 'activity.match.placed'
              AND payload->>'placement' = '1'
              AND coalesce(payload->>'subjectType','') <> 'bot'
          ) * ${A[1]}
        + COUNT(*) FILTER (
            WHERE event_type = 'activity.match.placed'
              AND payload->>'placement' = '2'
              AND coalesce(payload->>'subjectType','') <> 'bot'
          ) * ${A[2]}
        + COUNT(*) FILTER (
            WHERE event_type = 'activity.match.placed'
              AND payload->>'placement' = '3'
              AND coalesce(payload->>'subjectType','') <> 'bot'
          ) * ${A[3]}
        + COUNT(*) FILTER (
            WHERE event_type = 'activity.match.placed'
              AND payload->>'placement' NOT IN ('1','2','3')
              AND coalesce(payload->>'subjectType','') <> 'bot'
          ) * ${A.default}
      )::int AS score
    FROM events
    WHERE agent_id IS NOT NULL
      AND ts > now() - ${sql.raw(`interval '${interval}'`)}
    GROUP BY agent_id
    HAVING (
      COUNT(*) FILTER (WHERE event_type = 'building.visited')          * ${W.buildingVisit}
      + COUNT(*) FILTER (WHERE event_type = 'agent.chat.turn')         * ${W.teacherChat}
      + COUNT(*) FILTER (WHERE event_type = 'agent.collaboration.turn')* ${W.collaboration}
      + COUNT(*) FILTER (WHERE event_type = 'skill_md.fetched')        * ${W.skillFetch}
      + COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'agent.connected') * ${W.session}
      + MAX(CASE WHEN event_type = 'identity.issued' THEN ${W.identityIssued} ELSE 0 END)
      + COUNT(*) FILTER (
          WHERE event_type = 'activity.match.placed'
            AND coalesce(payload->>'subjectType','') <> 'bot'
        ) * ${A.default}
    ) > 0
    ORDER BY score DESC
  `);

  if (aggRows.length === 0) {
    return {
      window,
      generatedAt: new Date().toISOString(),
      agents: [],
      totalRanked: 0,
    };
  }

  // Batch-fetch openclaw_bots metadata (agentId is the text identifier used
  // throughout events; ties to openclaw_bots.agent_id — not .id).
  const agentIds = aggRows.map((r) => r.agent_id);
  const botRows = await db
    .select({
      agentId: openclawBots.agentId,
      name: openclawBots.name,
      userId: openclawBots.userId,
      walletAddress: openclawBots.walletAddress,
    })
    .from(openclawBots)
    .where(inArray(openclawBots.agentId, agentIds));

  const botByAgentId = new Map(botRows.map((b) => [b.agentId, b]));

  // Secondary join: avatars for this user — we want the avatar name + id when the
  // agent is bound to a human account, otherwise we fall back to the openclaw
  // bot's own `name` field.
  const userIds = botRows
    .map((b) => b.userId)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  const petByUserId = new Map<
    string,
    { id: string; name: string; walletAddress: string | null }
  >();
  if (userIds.length > 0) {
    const petRows = await db
      .select({
        id: avatars.id,
        name: avatars.name,
        userId: avatars.userId,
        walletAddress: avatars.walletAddress,
      })
      .from(avatars)
      .where(and(inArray(avatars.userId, userIds), eq(avatars.isActive, true)));

    for (const p of petRows) {
      petByUserId.set(p.userId, {
        id: p.id,
        name: p.name,
        walletAddress: p.walletAddress ?? null,
      });
    }
  }

  // Shape + rank (cap `limit` AFTER shaping so totalRanked reflects the full
  // qualifying set, not just the paginated slice).
  const totalRanked = aggRows.length;
  const entries: AgentLeaderboardEntry[] = aggRows.slice(0, limit).map((r, idx) => {
    const bot = botByAgentId.get(r.agent_id);
    const avatar = bot?.userId ? petByUserId.get(bot.userId) : undefined;
    return {
      rank: idx + 1,
      agentId: r.agent_id,
      avatarId: avatar?.id ?? null,
      // Prefer the avatar name (human-facing) over the raw openclaw bot name.
      avatarName: avatar?.name ?? bot?.name ?? null,
      // Wallet — avatar wallet for bound agents, bot wallet otherwise.
      walletAddress: avatar?.walletAddress ?? bot?.walletAddress ?? null,
      score: Number(r.score) || 0,
      breakdown: {
        building_visits: Number(r.building_visits) || 0,
        teacher_chats: Number(r.teacher_chats) || 0,
        collaborations: Number(r.collaborations) || 0,
        skill_fetches: Number(r.skill_fetches) || 0,
        sessions: Number(r.sessions) || 0,
        activity_wins: Number(r.activity_wins) || 0,
        activity_silver: Number(r.activity_silver) || 0,
        activity_bronze: Number(r.activity_bronze) || 0,
        activity_other: Number(r.activity_other) || 0,
      },
    };
  });

  return {
    window,
    generatedAt: new Date().toISOString(),
    agents: entries,
    totalRanked,
  };
}

const agentLeaderboardLimiter = createRateLimiter({
  maxPerWindow: 60,
  windowMs: 60_000,
});

leaderboardRoutes.get('/agents', async (c) => {
  // Rate limit first — public endpoint, cheap to trigger.
  const ip = getClientIp(c.req.raw.headers);
  if (!agentLeaderboardLimiter.check(ip)) {
    return c.json(
      { error: 'rate_limited', message: 'Too many requests. Try again shortly.' },
      429,
    );
  }

  const rawLimit = parseInt(c.req.query('limit') || '100', 10);
  const limit = Math.min(
    100,
    Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100),
  );

  const rawWindow = (c.req.query('window') || '7d').toLowerCase();
  const window: AgentLeaderboardWindow = VALID_WINDOWS.includes(
    rawWindow as AgentLeaderboardWindow,
  )
    ? (rawWindow as AgentLeaderboardWindow)
    : '7d';

  // Cache is keyed on `window` only — we always build the full ranked set and
  // slice `limit` from it, so a second caller asking for a smaller page gets
  // a cache hit. This is safe because the top-N set is a strict prefix.
  let snapshot = getAgentCache(window);
  if (!snapshot) {
    try {
      snapshot = await buildAgentSnapshot(window, 100);
      setAgentCache(window, snapshot);
    } catch (err) {
      // Empty-DB deployment or transient DB error — return an empty board
      // instead of 500. The UI renders the empty state correctly and a
      // background retry will pick up once data exists.
      console.error('[leaderboard/agents] buildAgentSnapshot failed:', err);
      snapshot = {
        window,
        generatedAt: new Date().toISOString(),
        agents: [],
        totalRanked: 0,
      };
    }
  }

  const payload: AgentLeaderboardSnapshot = {
    window: snapshot.window,
    generatedAt: snapshot.generatedAt,
    agents: snapshot.agents.slice(0, limit),
    totalRanked: snapshot.totalRanked,
  };

  // Short client-side cache so React-Query polling + multiple tab instances
  // don't all hit the origin within the 60s server TTL.
  c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  return c.json(payload);
});

// ---- Legacy economy board (auth-gated) ------------------------------------
//
// Everything below here retains the pre-pivot contract consumed by
// `leaderboard-modal.tsx`. `sessionMiddleware` is attached per-route (not via
// `router.use('/', ...)`) because Hono treats a `/` path in `use()` as a
// prefix that matches every nested path — including `/agents` — which would
// silently re-gate the public endpoint. Passing the middleware as a route
// argument scopes it to exactly this handler.

/**
 * GET /api/leaderboard
 *
 * Query params:
 *   sort    — composite | gold | earned | skills-sold | skills-authored | quests | bounties
 *   limit   — 1..100, default 50
 *   offset  — 0.., default 0
 *   me      — truthy to also include the current user's avatar row, even if
 *             it's outside the cap (so a mid-pack avatar can still see where
 *             they stand without paging through the whole board).
 */
leaderboardRoutes.get('/', sessionMiddleware, async (c) => {
  const rawSort = (c.req.query('sort') || 'composite').toLowerCase();
  const sort = (VALID_SORTS.includes(rawSort as SortMode) ? rawSort : 'composite') as SortMode;

  const limit = Math.min(
    100,
    Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50)
  );
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);
  const wantMe = c.req.query('me') != null && c.req.query('me') !== 'false';

  let snapshot = getCache(DEFAULT_CAP);
  if (!snapshot) {
    snapshot = await buildSnapshot(DEFAULT_CAP);
    setCache(DEFAULT_CAP, snapshot);
  }

  const sorted = sortBy(snapshot.entries, sort);
  const page = sorted.slice(offset, offset + limit);

  let mePet: LeaderboardEntry | null = null;
  if (wantMe) {
    const user = c.get('user');
    if (user) {
      const [myAvatar] = await db
        .select({ id: avatars.id })
        .from(avatars)
        .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)))
        .limit(1);

      if (myAvatar) {
        mePet = sorted.find((e) => e.avatarId === myAvatar.id) ?? null;
      }
    }
  }

  return c.json({
    entries: page,
    sort,
    limit,
    offset,
    totalPets: snapshot.totalPets,
    rankedCount: sorted.length,
    generatedAt: snapshot.generatedAt,
    me: mePet,
  });
});

/**
 * GET /api/leaderboard/stats
 *
 * Aggregate stats for the header banner — total avatars, total gold in
 * circulation, total skills ever sold, total quests completed.
 */
leaderboardRoutes.get('/stats', sessionMiddleware, async (c) => {
  let snapshot = getCache(DEFAULT_CAP);
  if (!snapshot) {
    snapshot = await buildSnapshot(DEFAULT_CAP);
    setCache(DEFAULT_CAP, snapshot);
  }

  const totalGold = snapshot.entries.reduce((sum, e) => sum + e.gold, 0);
  const totalEarned = snapshot.entries.reduce((sum, e) => sum + e.earned, 0);
  const totalSkillsSold = snapshot.entries.reduce((sum, e) => sum + e.skillsSold, 0);
  const totalSkillsAuthored = snapshot.entries.reduce(
    (sum, e) => sum + e.skillsAuthored,
    0
  );
  const totalQuestsCompleted = snapshot.entries.reduce(
    (sum, e) => sum + e.questsCompleted,
    0
  );
  const totalBountiesCompleted = snapshot.entries.reduce(
    (sum, e) => sum + e.bountiesCompleted,
    0
  );

  return c.json({
    totalPets: snapshot.totalPets,
    rankedPets: snapshot.entries.length,
    totalGold,
    totalEarned,
    totalSkillsSold,
    totalSkillsAuthored,
    totalQuestsCompleted,
    totalBountiesCompleted,
    generatedAt: snapshot.generatedAt,
  });
});
