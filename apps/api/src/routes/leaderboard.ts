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
  totalAvatars: number;
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
  const avatarRows = await db
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

  if (avatarRows.length === 0) {
    return { entries: [], totalAvatars: 0, generatedAt: new Date().toISOString() };
  }

  const earnedRows = await db
    .select({
      avatarId: clawTokenTransactions.avatarId,
      total: sql<number>`coalesce(sum(${clawTokenTransactions.amount}), 0)`.as('total'),
    })
    .from(clawTokenTransactions)
    .where(gt(clawTokenTransactions.amount, 0))
    .groupBy(clawTokenTransactions.avatarId);

  const earnedByAvatar = new Map<string, number>(
    earnedRows.map((r) => [r.avatarId, Number(r.total) || 0])
  );

  const soldRows = await db
    .select({
      avatarId: bazaarTransactions.sellerId,
      total: sql<number>`count(*)`.as('total'),
    })
    .from(bazaarTransactions)
    .groupBy(bazaarTransactions.sellerId);

  const soldByAvatar = new Map<string, number>(
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

  const authoredByAvatar = new Map<string, number>(
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

  const questByAvatar = new Map<string, number>(
    questRows.map((r) => [r.avatarId, Number(r.total) || 0])
  );

  const bountyRows = await db
    .select({
      avatarId: bountyReputation.avatarId,
      totalCompleted: bountyReputation.totalCompleted,
    })
    .from(bountyReputation);

  const bountyByAvatar = new Map<string, number>(
    bountyRows.map((r) => [r.avatarId, r.totalCompleted || 0])
  );

  const partialEntries = avatarRows.map((avatar) => {
    const body = {
      avatarId: avatar.id,
      avatarName: avatar.name,
      species: avatar.species,
      color: avatar.color ?? null,
      archetype: avatar.archetype ?? null,
      gold: avatar.clawTokens || 0,
      earned: earnedByAvatar.get(avatar.id) || 0,
      skillsSold: soldByAvatar.get(avatar.id) || 0,
      skillsAuthored: authoredByAvatar.get(avatar.id) || 0,
      questsCompleted: questByAvatar.get(avatar.id) || 0,
      bountiesCompleted: bountyByAvatar.get(avatar.id) || 0,
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
    totalAvatars: avatarRows.length,
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
  /**
   * Phase 1 (Q3 plan §2.5) — subject classification for the Phase-2
   * filter chips. `agent` = bound to an OpenClaw bot via openclaw_bots;
   * `avatar` = avatar-only contribution (Player tier). Frontend filter on this
   * field; backward-compatible because old clients can ignore it.
   */
  subjectType: 'agent' | 'avatar';
}

interface AgentLeaderboardSnapshot {
  window: AgentLeaderboardWindow;
  generatedAt: string;
  agents: AgentLeaderboardEntry[];
  totalRanked: number;
}

// Scoring rubric — keep in sync with the CLAUDE.md Brand Identity weights
// line + ARCHITECTURE.md §Observability "Free Agent Leaderboard" table.
//
// Q3 plan §2.4 rebalance (2026-04-28):
//   - Teacher chat moved 5 → 10 (load-bearing learning event).
//   - Collaboration moved 25 → 40 (load-bearing brand axis).
//   - Building visit dropped 10 → 3 (one-shot, easy to script).
//   - Skill fetch dropped 3 → 1 (a curl is not engagement).
const AGENT_SCORE_WEIGHTS = {
  buildingVisit: 3,     // Q3 plan §2.4 — was 10
  teacherChat: 10,      // Q3 plan §2.4 — was 5; THE learning event
  collaboration: 40,    // Q3 plan §2.4 — was 25; load-bearing brand axis
  skillFetch: 1,        // Q3 plan §2.4 — was 3
  session: 1,
  identityIssued: 5,    // Phase 5.1 onboarding, one-time per agent
} as const;

/**
 * Q3 plan §2.4 — placement-tier weights for `activity.match.placed`.
 * Lowered so a single match win (12) ≈ 1.2 teacher chats (10), not 6×.
 * Brand Identity says learning > arcade; weights enforce it.
 *
 * Bots filtered at SQL level via `payload->>'subjectType' != 'bot'`
 * (chunk #10 carve-out). Bot rows DO emit telemetry but get zero credit.
 */
const ACTIVITY_PLACEMENT_WEIGHTS = {
  1: 12,    // Q3 plan §2.4 — was 30
  2: 6,     // Q3 plan §2.4 — was 15
  3: 3,     // Q3 plan §2.4 — was 8
  default: 1, // Q3 plan §2.4 — was 2
} as const;

/**
 * Q3 plan §2.4 — per-(subject, day) caps to prevent farming. Applied as
 * `LEAST(daily_count, cap)` per event_type inside the daily aggregation
 * CTE. Capped counts then sum across days and multiply by weights.
 *
 * `activity` cap is on the TOTAL placements per day (sum of all tiers);
 * the per-tier weighting is preserved by scaling `(wins*12 + silver*6 +
 * bronze*3 + other*1)` by `LEAST(total, 10) / total`.
 *
 * Sessions and identity.issued are inherently rare — no cap.
 */
const DAILY_CAPS = {
  buildingVisit: 10,    // 10 buildings exist; visiting each once is the natural max
  teacherChat: 50,      // ~1/min sustained; well above real engagement
  collaboration: 50,    // mirrors chat
  skillFetch: 11,       // 11 SKILL.md files exist; one fetch each
  activity: 10,         // ~3-min races × 10 = 30min, reasonable ceiling
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

/**
 * Single-agent leaderboard lookup — REUSES the exact public-board snapshot
 * (`buildAgentSnapshot` CTE + scoring + per-(subject,day) caps) and its 60s
 * window cache, so a per-agent stats surface (e.g. the Hatcher partner
 * dashboard at `GET /api/partner/hatcher/agents/:id/stats`) shows the SAME
 * score + rank the agent sees on the public `/leaderboard`. No re-derivation
 * of the rubric: we build/reuse the cached ranked set and find the agent's row.
 *
 * `agentId` is the leaderboard subject id for an agent row — the text
 * `openclaw_bots.agent_id` (for Hatcher agents that is the namespaced
 * `hatcher:<rawId>`). Returns the entry (true rank within the full unified
 * board + breakdown + score) or `null` when the agent has no scored events in
 * the window (or ranks beyond the snapshot's 500-row cap — the same horizon
 * the public board itself uses). Callers treat `null` as "score 0, unranked".
 *
 * Window defaults to `'all'` so a dashboard reflects lifetime contribution.
 */
export async function getAgentLeaderboardEntry(
  agentId: string,
  window: AgentLeaderboardWindow = 'all',
): Promise<{ score: number; rank: number; breakdown: AgentScoreBreakdown } | null> {
  let snapshot = getAgentCache(window);
  if (!snapshot) {
    snapshot = await buildAgentSnapshot(window, 500);
    setAgentCache(window, snapshot);
  }
  // Match on the agent subject only — avatar rows carry a synthetic
  // `avatar:<uuid>` agentId and a `subjectType:'avatar'`, so an exact agentId
  // match against an `agent` row can never collide with a player avatar.
  const entry = snapshot.agents.find(
    (e) => e.subjectType === 'agent' && e.agentId === agentId,
  );
  if (!entry) return null;
  return { score: entry.score, rank: entry.rank, breakdown: entry.breakdown };
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
 * Aggregate events into a ranked subject snapshot.
 *
 * Q3 plan §2.4 + §2.5 rewrite (2026-04-28):
 *
 *   1. Per-(subject, day) capping via inner CTE — `LEAST(daily_count, cap)`
 *      so multi-day farming doesn't break the leaderboard. Capped counts
 *      sum across days, then multiply by weights.
 *
 *   2. Avatar-keyed UNION — Players (avatar + no agent) rank alongside Trainers
 *      (avatar + agent). Same scoring rubric, separate `subjectType` tag for
 *      the Phase 2 filter chips. Disjoint event sets so no double-counting:
 *      agent path takes events with agent_id IS NOT NULL; avatar path takes
 *      events with agent_id IS NULL AND avatar_id IS NOT NULL.
 *
 *   3. Activity per-tier scoring with daily total cap — preserves the
 *      "1st > 2nd > 3rd > other" weighting while honoring the 10/day total
 *      cap by scaling all tiers proportionally:
 *        scaled_score = (wins*12 + silver*6 + bronze*3 + other*1)
 *                     × LEAST(daily_total, 10) / daily_total
 *
 * Postgres plans this as two index-supported scans (agent_id partial,
 * avatar_id partial) feeding hash aggregates, then a UNION. Index coverage:
 * `idx_events_type_ts`, `idx_events_agent_ts`, `idx_events_avatar_ts`.
 *
 * Joining avatar / openclaw_bots / wallets happens in memory via batched
 * `inArray` round trips, never a cartesian.
 */
async function buildAgentSnapshot(
  window: AgentLeaderboardWindow,
  limit: number,
): Promise<AgentLeaderboardSnapshot> {
  const interval = windowToInterval(window);

  const W = AGENT_SCORE_WEIGHTS;
  const A = ACTIVITY_PLACEMENT_WEIGHTS;
  const C = DAILY_CAPS;

  // Use `sql.raw` for the interval because drizzle's bound-parameter path
  // doesn't support interval literals directly, and we've whitelisted the
  // `interval` string in `windowToInterval` above.
  const aggRows = await db.execute<{
    subject_id: string;
    subject_type: 'agent' | 'avatar';
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
    WITH
    -- Distinct session counts (kept outside the daily CTE so cross-day
    -- session distinctness is preserved — losing it inside daily aggregation
    -- would over-count agents that span midnight on the same connect).
    agent_sessions AS (
      SELECT
        agent_id,
        COUNT(DISTINCT session_id)::int AS sessions
      FROM events
      WHERE event_type = 'agent.connected'
        AND agent_id IS NOT NULL
        AND ts > now() - ${sql.raw(`interval '${interval}'`)}
      GROUP BY agent_id
    ),
    avatar_sessions AS (
      SELECT
        avatar_id,
        COUNT(DISTINCT session_id)::int AS sessions
      FROM events
      WHERE event_type = 'agent.connected'
        AND agent_id IS NULL
        AND avatar_id IS NOT NULL
        AND ts > now() - ${sql.raw(`interval '${interval}'`)}
      GROUP BY avatar_id
    ),
    -- Per-(agent, day) capped counts. LEAST applies the cap inside one row
    -- per (agent, day); SUM in the next CTE adds capped values across days.
    agent_daily AS (
      SELECT
        agent_id,
        date_trunc('day', ts) AS day,
        LEAST(COUNT(*) FILTER (WHERE event_type = 'building.visited'), ${C.buildingVisit})::int AS visits_c,
        LEAST(COUNT(*) FILTER (WHERE event_type = 'agent.chat.turn'), ${C.teacherChat})::int AS chats_c,
        LEAST(COUNT(*) FILTER (WHERE event_type = 'agent.collaboration.turn'), ${C.collaboration})::int AS collabs_c,
        -- Partner-import carve-out (Hatcher Phase C — 2026-06-01): a partner
        -- re-embedding our SKILL.md daily via a partner key tags its fetches
        -- payload.via='partner-import'. Exclude them so a partner can't farm
        -- skill_md.fetched rank or trip the 11/day cap. Organic fetches (no
        -- via, or via != 'partner-import') still count.
        LEAST(COUNT(*) FILTER (
          WHERE event_type = 'skill_md.fetched'
            AND coalesce(payload->>'via','') <> 'partner-import'
        ), ${C.skillFetch})::int AS skills_c,
        MAX(CASE WHEN event_type = 'identity.issued' THEN 1 ELSE 0 END)::int AS onboarded,
        COUNT(*) FILTER (
          WHERE event_type = 'activity.match.placed'
            AND payload->>'placement' = '1'
            AND coalesce(payload->>'subjectType','') <> 'bot'
        )::int AS act_wins,
        COUNT(*) FILTER (
          WHERE event_type = 'activity.match.placed'
            AND payload->>'placement' = '2'
            AND coalesce(payload->>'subjectType','') <> 'bot'
        )::int AS act_silver,
        COUNT(*) FILTER (
          WHERE event_type = 'activity.match.placed'
            AND payload->>'placement' = '3'
            AND coalesce(payload->>'subjectType','') <> 'bot'
        )::int AS act_bronze,
        COUNT(*) FILTER (
          WHERE event_type = 'activity.match.placed'
            AND payload->>'placement' IS NOT NULL
            AND payload->>'placement' NOT IN ('1','2','3')
            AND coalesce(payload->>'subjectType','') <> 'bot'
        )::int AS act_other,
        -- act_total MUST equal the sum of the four numerator buckets so the
        -- proportional cap factor (LEAST(act_total, cap) / act_total) doesn't
        -- deflate honest scoring. The IS NOT NULL clause excludes malformed
        -- rows that would otherwise inflate the denominator without
        -- contributing to any numerator. Audit finding 2026-04-28.
        COUNT(*) FILTER (
          WHERE event_type = 'activity.match.placed'
            AND payload->>'placement' IS NOT NULL
            AND coalesce(payload->>'subjectType','') <> 'bot'
        )::int AS act_total
      FROM events
      WHERE agent_id IS NOT NULL
        AND ts > now() - ${sql.raw(`interval '${interval}'`)}
      GROUP BY agent_id, date_trunc('day', ts)
    ),
    avatar_daily AS (
      SELECT
        avatar_id,
        date_trunc('day', ts) AS day,
        LEAST(COUNT(*) FILTER (WHERE event_type = 'building.visited'), ${C.buildingVisit})::int AS visits_c,
        LEAST(COUNT(*) FILTER (WHERE event_type = 'agent.chat.turn'), ${C.teacherChat})::int AS chats_c,
        LEAST(COUNT(*) FILTER (WHERE event_type = 'agent.collaboration.turn'), ${C.collaboration})::int AS collabs_c,
        -- Partner-import carve-out (Hatcher Phase C) — same as agent_daily.
        LEAST(COUNT(*) FILTER (
          WHERE event_type = 'skill_md.fetched'
            AND coalesce(payload->>'via','') <> 'partner-import'
        ), ${C.skillFetch})::int AS skills_c,
        MAX(CASE WHEN event_type = 'identity.issued' THEN 1 ELSE 0 END)::int AS onboarded,
        COUNT(*) FILTER (
          WHERE event_type = 'activity.match.placed'
            AND payload->>'placement' = '1'
            AND coalesce(payload->>'subjectType','') <> 'bot'
        )::int AS act_wins,
        COUNT(*) FILTER (
          WHERE event_type = 'activity.match.placed'
            AND payload->>'placement' = '2'
            AND coalesce(payload->>'subjectType','') <> 'bot'
        )::int AS act_silver,
        COUNT(*) FILTER (
          WHERE event_type = 'activity.match.placed'
            AND payload->>'placement' = '3'
            AND coalesce(payload->>'subjectType','') <> 'bot'
        )::int AS act_bronze,
        COUNT(*) FILTER (
          WHERE event_type = 'activity.match.placed'
            AND payload->>'placement' IS NOT NULL
            AND payload->>'placement' NOT IN ('1','2','3')
            AND coalesce(payload->>'subjectType','') <> 'bot'
        )::int AS act_other,
        -- See agent_daily comment — NULL-placement rows excluded from both
        -- numerator and denominator so the proportional cap stays honest.
        COUNT(*) FILTER (
          WHERE event_type = 'activity.match.placed'
            AND payload->>'placement' IS NOT NULL
            AND coalesce(payload->>'subjectType','') <> 'bot'
        )::int AS act_total
      FROM events
      WHERE agent_id IS NULL
        AND avatar_id IS NOT NULL
        AND ts > now() - ${sql.raw(`interval '${interval}'`)}
      GROUP BY avatar_id, date_trunc('day', ts)
    ),
    -- Subject-level aggregation: sum capped daily counts, compute score.
    -- The activity sub-expression scales tier weights by the daily-cap
    -- factor so total credited matches never exceed C.activity per day
    -- while preserving the 1st > 2nd > 3rd > other gradient.
    agent_scores AS (
      SELECT
        ad.agent_id::text AS subject_id,
        'agent'::text AS subject_type,
        SUM(ad.visits_c)::int AS building_visits,
        SUM(ad.chats_c)::int AS teacher_chats,
        SUM(ad.collabs_c)::int AS collaborations,
        SUM(ad.skills_c)::int AS skill_fetches,
        COALESCE(MAX(s.sessions), 0)::int AS sessions,
        MAX(ad.onboarded)::int AS onboarded,
        SUM(ad.act_wins)::int AS activity_wins,
        SUM(ad.act_silver)::int AS activity_silver,
        SUM(ad.act_bronze)::int AS activity_bronze,
        SUM(ad.act_other)::int AS activity_other,
        (
          SUM(ad.visits_c) * ${W.buildingVisit}
          + SUM(ad.chats_c) * ${W.teacherChat}
          + SUM(ad.collabs_c) * ${W.collaboration}
          + SUM(ad.skills_c) * ${W.skillFetch}
          + COALESCE(MAX(s.sessions), 0) * ${W.session}
          + MAX(ad.onboarded) * ${W.identityIssued}
          + ROUND(SUM(
              CASE WHEN ad.act_total = 0 THEN 0
                   ELSE (ad.act_wins * ${A[1]} + ad.act_silver * ${A[2]} + ad.act_bronze * ${A[3]} + ad.act_other * ${A.default})
                        * LEAST(ad.act_total, ${C.activity})::float / ad.act_total
              END
            ))::int
        )::int AS score
      FROM agent_daily ad
      LEFT JOIN agent_sessions s ON s.agent_id = ad.agent_id
      GROUP BY ad.agent_id
    ),
    avatar_scores AS (
      SELECT
        pd.avatar_id::text AS subject_id,
        'avatar'::text AS subject_type,
        SUM(pd.visits_c)::int AS building_visits,
        SUM(pd.chats_c)::int AS teacher_chats,
        SUM(pd.collabs_c)::int AS collaborations,
        SUM(pd.skills_c)::int AS skill_fetches,
        COALESCE(MAX(s.sessions), 0)::int AS sessions,
        MAX(pd.onboarded)::int AS onboarded,
        SUM(pd.act_wins)::int AS activity_wins,
        SUM(pd.act_silver)::int AS activity_silver,
        SUM(pd.act_bronze)::int AS activity_bronze,
        SUM(pd.act_other)::int AS activity_other,
        (
          SUM(pd.visits_c) * ${W.buildingVisit}
          + SUM(pd.chats_c) * ${W.teacherChat}
          + SUM(pd.collabs_c) * ${W.collaboration}
          + SUM(pd.skills_c) * ${W.skillFetch}
          + COALESCE(MAX(s.sessions), 0) * ${W.session}
          + MAX(pd.onboarded) * ${W.identityIssued}
          + ROUND(SUM(
              CASE WHEN pd.act_total = 0 THEN 0
                   ELSE (pd.act_wins * ${A[1]} + pd.act_silver * ${A[2]} + pd.act_bronze * ${A[3]} + pd.act_other * ${A.default})
                        * LEAST(pd.act_total, ${C.activity})::float / pd.act_total
              END
            ))::int
        )::int AS score
      FROM avatar_daily pd
      LEFT JOIN avatar_sessions s ON s.avatar_id = pd.avatar_id
      GROUP BY pd.avatar_id
    )
    SELECT * FROM (
      SELECT * FROM agent_scores
      UNION ALL
      SELECT * FROM avatar_scores
    ) combined
    WHERE score > 0
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

  // Split rows by subject_type so we hit the right metadata table for each.
  // Agent rows → openclaw_bots → avatars-for-user. Avatar rows → avatars directly.
  const agentRows = aggRows.filter((r) => r.subject_type === 'agent');
  const avatarRows = aggRows.filter((r) => r.subject_type === 'avatar');

  // Agent path: openclaw_bots → optional bound avatar via userId.
  const agentSubjectIds = agentRows.map((r) => r.subject_id);
  const botRows = agentSubjectIds.length > 0
    ? await db
        .select({
          agentId: openclawBots.agentId,
          name: openclawBots.name,
          userId: openclawBots.userId,
          walletAddress: openclawBots.walletAddress,
        })
        .from(openclawBots)
        .where(inArray(openclawBots.agentId, agentSubjectIds))
    : [];

  const botByAgentId = new Map(botRows.map((b) => [b.agentId, b]));

  const userIds = botRows
    .map((b) => b.userId)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  const avatarByUserId = new Map<
    string,
    { id: string; name: string; walletAddress: string | null }
  >();
  if (userIds.length > 0) {
    const avatarsForBots = await db
      .select({
        id: avatars.id,
        name: avatars.name,
        userId: avatars.userId,
        walletAddress: avatars.walletAddress,
      })
      .from(avatars)
      .where(and(inArray(avatars.userId, userIds), eq(avatars.isActive, true)));

    for (const p of avatarsForBots) {
      avatarByUserId.set(p.userId, {
        id: p.id,
        name: p.name,
        walletAddress: p.walletAddress ?? null,
      });
    }
  }

  // Avatar path (Q3 plan §2.5 — Player tier groundwork): subject_id IS the avatar.id
  // since avatar rows come from events with no agent_id. One direct avatars lookup.
  const avatarSubjectIds = avatarRows.map((r) => r.subject_id);
  const avatarById = new Map<
    string,
    { id: string; name: string; walletAddress: string | null }
  >();
  if (avatarSubjectIds.length > 0) {
    const directAvatars = await db
      .select({
        id: avatars.id,
        name: avatars.name,
        walletAddress: avatars.walletAddress,
      })
      .from(avatars)
      .where(and(inArray(avatars.id, avatarSubjectIds), eq(avatars.isActive, true)));

    for (const p of directAvatars) {
      avatarById.set(p.id, {
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
    const isAgent = r.subject_type === 'agent';
    const bot = isAgent ? botByAgentId.get(r.subject_id) : undefined;
    const boundAvatar = bot?.userId ? avatarByUserId.get(bot.userId) : undefined;
    const directAvatar = isAgent ? undefined : avatarById.get(r.subject_id);
    const avatar = boundAvatar ?? directAvatar;

    return {
      rank: idx + 1,
      // For agent rows: the openclaw bot's text agent_id. For avatar rows: a
      // synthetic `avatar:<uuid>` so client-side keys stay unique across the
      // unified board without colliding with real bot agent_ids.
      agentId: isAgent ? r.subject_id : `avatar:${r.subject_id}`,
      avatarId: avatar?.id ?? (isAgent ? null : r.subject_id),
      avatarName: avatar?.name ?? bot?.name ?? null,
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
      subjectType: r.subject_type,
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

/**
 * Reef Race Phase 4 — separate rate limiter for the public daily-best-lap
 * surface. S5 FIX: NOT shared with `/agents` so a multi-tab browser
 * loading both leaderboards doesn't blow a single bucket. Same 60/min/IP
 * budget — independent ceiling.
 */
const dailyBestLapLimiter = createRateLimiter({
  maxPerWindow: 60,
  windowMs: 60_000,
});

// Phase 2 plan §3.3 — subject filter chips. The cached snapshot is built
// once per window with both 'agent' + 'avatar' rows; this whitelist gates the
// per-request filter so we don't have to re-query the DB per chip click.
type SubjectFilter = 'all' | 'players' | 'trainers';
const VALID_SUBJECTS: SubjectFilter[] = ['all', 'players', 'trainers'];

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

  const rawSubject = (c.req.query('subject') || 'all').toLowerCase();
  const subject: SubjectFilter = VALID_SUBJECTS.includes(
    rawSubject as SubjectFilter,
  )
    ? (rawSubject as SubjectFilter)
    : 'all';

  // Cache is keyed on `window` only — we always build the full ranked set and
  // slice `limit` from it, so a second caller asking for a smaller page gets
  // a cache hit. This is safe because the top-N set is a strict prefix.
  // Subject filter applies AFTER the cache lookup so chip clicks don't blow
  // the cache; we just re-rank the filtered subset on each request.
  //
  // Snapshot cap bumped 100 → 500 (audit-fix 2026-04-29 W1) so the Players /
  // Trainers filter chips show a meaningful subset even when one cohort
  // dominates the global top-100. Memory cost: ~500 × 1KB = 500KB per
  // window × 4 windows = 2MB total — negligible. Trade-off documented:
  // entries beyond rank 500 in the unified board still don't appear under
  // any filter; if/when active subjects exceed 500 in any window, bump again.
  let snapshot = getAgentCache(window);
  if (!snapshot) {
    try {
      snapshot = await buildAgentSnapshot(window, 500);
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

  // Subject filter — Phase 2 plan §3.3. Re-rank the filtered subset so the
  // top entry always shows rank=1 within the active filter. totalRanked is
  // updated to reflect the filtered count so the UI's "n agents ranked"
  // label stays accurate.
  let filteredAgents = snapshot.agents;
  if (subject !== 'all') {
    const targetType: 'agent' | 'avatar' = subject === 'trainers' ? 'agent' : 'avatar';
    filteredAgents = snapshot.agents
      .filter((entry) => entry.subjectType === targetType)
      .map((entry, idx) => ({ ...entry, rank: idx + 1 }));
  }

  const payload: AgentLeaderboardSnapshot = {
    window: snapshot.window,
    generatedAt: snapshot.generatedAt,
    agents: filteredAgents.slice(0, limit),
    totalRanked: subject === 'all' ? snapshot.totalRanked : filteredAgents.length,
  };

  // Short client-side cache so React-Query polling + multiple tab instances
  // don't all hit the origin within the 60s server TTL.
  c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  return c.json(payload);
});

// ---- Reef Race "Lobster of the Day" (Phase 4, public) --------------------
//
// `GET /api/leaderboard/reef-race/daily-best-lap` — top-100 fastest single
// laps in the last 24 hours. Public, no auth, mirrors the brand priority
// #3 budget (60 req/min/IP) on a SEPARATE bucket from `/agents` (S5 fix).
// Cache: 60s in-memory in `reef-race-daily-best-service.ts`, invalidated
// on every successful PB upsert (C2 fix) so any new PB is visible in the
// next round-trip after the writing match's reward pipeline finishes.

leaderboardRoutes.get('/reef-race/daily-best-lap', async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!dailyBestLapLimiter.check(ip)) {
    return c.json(
      { error: 'rate_limited', message: 'Too many requests. Try again shortly.' },
      429,
    );
  }

  // Lazy import to keep the leaderboard route module tree small at boot.
  const { getDailyBestLapSnapshot } = await import(
    '../services/activity/reef-race-daily-best-service'
  );

  const rawLimit = parseInt(c.req.query('limit') || '100', 10);
  const limit = Math.min(
    100,
    Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100),
  );

  let snapshot: Awaited<ReturnType<typeof getDailyBestLapSnapshot>>;
  try {
    snapshot = await getDailyBestLapSnapshot(limit);
  } catch (err) {
    console.error('[leaderboard/reef-race/daily-best-lap] failed:', err);
    snapshot = {
      generatedAt: new Date().toISOString(),
      windowStart: new Date(Date.now() - 24 * 3600_000).toISOString(),
      totalEntries: 0,
      entries: [],
    };
  }

  c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  return c.json(snapshot);
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

  let meAvatar: LeaderboardEntry | null = null;
  if (wantMe) {
    const user = c.get('user');
    if (user) {
      const [myAvatar] = await db
        .select({ id: avatars.id })
        .from(avatars)
        .where(and(eq(avatars.userId, user.id), eq(avatars.isActive, true)))
        .limit(1);

      if (myAvatar) {
        meAvatar = sorted.find((e) => e.avatarId === myAvatar.id) ?? null;
      }
    }
  }

  return c.json({
    entries: page,
    sort,
    limit,
    offset,
    totalAvatars: snapshot.totalAvatars,
    rankedCount: sorted.length,
    generatedAt: snapshot.generatedAt,
    me: meAvatar,
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
    totalAvatars: snapshot.totalAvatars,
    rankedAvatars: snapshot.entries.length,
    totalGold,
    totalEarned,
    totalSkillsSold,
    totalSkillsAuthored,
    totalQuestsCompleted,
    totalBountiesCompleted,
    generatedAt: snapshot.generatedAt,
  });
});
